import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openChatSession } from "../src/chatEngine.js";
import { createStore, type IStore } from "../src/store.js";
import type { AgentLike, RunLike, SdkCreateLike } from "../src/host.js";

// I-137 (audit 2026-07-02 H-2): a down Postgres must DEGRADE a turn, never
// fail it, and never re-execute an already-completed turn (double billing).
// Postmortem 2026-06-18: PG down -> long-poll alive but every turn failed.

function withKey(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "test-key";
  return fn().finally(() => {
    if (prev === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prev;
  });
}

function okRun(text: string): RunLike {
  return {
    stream: async function* () {
      yield { type: "text", text };
    },
    wait: async () => ({ status: "finished", id: "r-ok" }),
  };
}

/** Real sqlite store with selected methods overridden to fail like a dead PG. */
function storeFailingOn(dir: string, methods: Array<"recordRun" | "upsertSession">): IStore {
  const real = createStore(dir, ".agent");
  const broken = Object.create(real) as IStore;
  for (const m of methods) {
    (broken as unknown as Record<string, unknown>)[m] = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5435 (simulated PG outage)");
    };
  }
  return broken;
}

describe("store resilience in sendTurn (I-137)", () => {
  it("recordRun failure does not fail the turn and does not re-execute it", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "resil-record-"));
      let sendCount = 0;
      const sdk: SdkCreateLike = {
        create: async () => ({
          agentId: "agent-1",
          send: async () => {
            sendCount++;
            return okRun("answered");
          },
        }),
      };
      const opened = await openChatSession({
        sdk,
        dir,
        interactive: false,
        store: storeFailingOn(dir, ["recordRun"]),
      });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;
      const out = await opened.session.sendTurn("hello");
      assert.equal(out.kind, "ok");
      if (out.kind === "ok") assert.equal(out.assistantText, "answered");
      assert.equal(sendCount, 1); // the completed turn must NOT be re-sent (double billing)
      await opened.session.close();
    });
  });

  it("upsertSession failure does not fail the turn", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "resil-upsert-"));
      let sendCount = 0;
      const sdk: SdkCreateLike = {
        create: async () => ({
          agentId: "agent-1",
          send: async () => {
            sendCount++;
            return okRun("answered");
          },
        }),
      };
      const opened = await openChatSession({
        sdk,
        dir,
        interactive: false,
        store: storeFailingOn(dir, ["recordRun", "upsertSession"]),
      });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;
      const out = await opened.session.sendTurn("hello");
      assert.equal(out.kind, "ok");
      assert.equal(sendCount, 1);
      await opened.session.close();
    });
  });

  it("store failure during SDK-error handling still returns a structured error path", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "resil-error-"));
      let sendCount = 0;
      const sdk: SdkCreateLike = {
        create: async () => {
          const agent: AgentLike = {
            agentId: "agent-1",
            send: async () => {
              sendCount++;
              if (sendCount === 1) throw Object.assign(new Error("agent handle stale"), { code: 13 });
              return okRun("recovered");
            },
          };
          return agent;
        },
      };
      const opened = await openChatSession({
        sdk,
        dir,
        interactive: false,
        store: storeFailingOn(dir, ["recordRun", "upsertSession"]),
      });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;
      // Rotation recovery must still work even when the store is down.
      const out = await opened.session.sendTurn("hello");
      assert.equal(out.kind, "ok");
      if (out.kind === "ok") assert.equal(out.assistantText, "recovered");
      await opened.session.close();
    });
  });
});

describe("session resource ownership", () => {
  it("close is idempotent and does not steal another SQLite owner's reference", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "session-close-"));
      const sessionStore = createStore(dir, ".agent");
      const observerStore = createStore(dir, ".agent");
      let disposeCalls = 0;
      let sendCalls = 0;
      const sdk: SdkCreateLike = {
        create: async () => ({
          agentId: "agent-close",
          send: async () => {
            sendCalls++;
            return okRun("unused");
          },
          [Symbol.asyncDispose]: async () => {
            disposeCalls++;
          },
        }),
      };
      try {
        const opened = await openChatSession({ sdk, dir, interactive: false, store: sessionStore });
        assert.equal(opened.ok, true);
        if (!opened.ok) return;

        await Promise.all([opened.session.close(), opened.session.close()]);
        assert.equal(disposeCalls, 1);
        assert.ok(await observerStore.getSession(opened.session.sessionId));
        const lateTurn = await opened.session.sendTurn("too late");
        assert.equal(lateTurn.kind, "error");
        assert.equal(sendCalls, 0);
      } finally {
        await sessionStore.close();
        await observerStore.close();
      }
    });
  });

  it("cancelActiveTurn interrupts one cancellable run without rotating the agent", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "session-cancel-"));
      let createCalls = 0;
      let cancelCalls = 0;
      let markStreamStarted!: () => void;
      const streamStarted = new Promise<void>((resolveStarted) => {
        markStreamStarted = resolveStarted;
      });
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolveStream) => {
        releaseStream = resolveStream;
      });
      const sdk: SdkCreateLike = {
        create: async () => {
          createCalls++;
          return {
            agentId: "agent-cancellable",
            send: async () => ({
              cancel: async () => {
                cancelCalls++;
                releaseStream();
              },
              stream: async function* () {
                markStreamStarted();
                await streamGate;
              },
              wait: async () => ({ status: "finished", id: "run-cancelled" }),
            }),
          };
        },
      };
      const opened = await openChatSession({ sdk, dir, interactive: false });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;

      const turn = opened.session.sendTurn("cancel me");
      await streamStarted;
      const requests = await Promise.all([
        opened.session.cancelActiveTurn(),
        opened.session.cancelActiveTurn(),
      ]);
      const out = await turn;

      assert.deepEqual(requests, [true, true]);
      assert.equal(cancelCalls, 1);
      assert.equal(createCalls, 1);
      assert.equal(out.kind, "error");
      if (out.kind === "error") assert.equal(out.message, "turn cancelled");
      await opened.session.close();
    });
  });

  it("cancelActiveTurn leaves a non-cancellable Cursor-style run unchanged", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "session-no-cancel-"));
      let markStreamStarted!: () => void;
      const streamStarted = new Promise<void>((resolveStarted) => {
        markStreamStarted = resolveStarted;
      });
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolveStream) => {
        releaseStream = resolveStream;
      });
      const sdk: SdkCreateLike = {
        create: async () => ({
          agentId: "agent-cursor-style",
          send: async () => ({
            stream: async function* () {
              markStreamStarted();
              await streamGate;
              yield { type: "text", text: "completed" };
            },
            wait: async () => ({ status: "finished", id: "run-completed" }),
          }),
        }),
      };
      const opened = await openChatSession({ sdk, dir, interactive: false });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;

      const turn = opened.session.sendTurn("keep going");
      await streamStarted;
      assert.equal(await opened.session.cancelActiveTurn(), false);
      releaseStream();
      const out = await turn;

      assert.equal(out.kind, "ok");
      if (out.kind === "ok") assert.equal(out.assistantText, "completed");
      await opened.session.close();
    });
  });

  it("close requests active-run cancellation before waiting for the turn", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "session-close-cancel-"));
      let cancelCalls = 0;
      let disposeCalls = 0;
      let markStreamStarted!: () => void;
      const streamStarted = new Promise<void>((resolveStarted) => {
        markStreamStarted = resolveStarted;
      });
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolveStream) => {
        releaseStream = resolveStream;
      });
      const sdk: SdkCreateLike = {
        create: async () => ({
          agentId: "agent-close-cancel",
          send: async () => ({
            cancel: async () => {
              cancelCalls++;
              releaseStream();
            },
            stream: async function* () {
              markStreamStarted();
              await streamGate;
            },
            wait: async () => ({ status: "finished", id: "run-close-cancel" }),
          }),
          [Symbol.asyncDispose]: async () => {
            disposeCalls++;
          },
        }),
      };
      const opened = await openChatSession({ sdk, dir, interactive: false });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;

      const turn = opened.session.sendTurn("close now");
      await streamStarted;
      await Promise.all([opened.session.close(), opened.session.close()]);
      const out = await turn;

      assert.equal(out.kind, "error");
      assert.equal(cancelCalls, 1);
      assert.equal(disposeCalls, 1);
    });
  });

  it("close rejects a second accepted turn instead of starting it after cancellation", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "session-close-queued-"));
      let sendCalls = 0;
      let cancelCalls = 0;
      let markStreamStarted!: () => void;
      const streamStarted = new Promise<void>((resolveStarted) => {
        markStreamStarted = resolveStarted;
      });
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolveStream) => {
        releaseStream = resolveStream;
      });
      const sdk: SdkCreateLike = {
        create: async () => ({
          agentId: "agent-close-queued",
          send: async () => {
            sendCalls++;
            if (sendCalls > 1) return okRun("must not run");
            return {
              cancel: async () => {
                cancelCalls++;
                releaseStream();
              },
              stream: async function* () {
                markStreamStarted();
                await streamGate;
              },
              wait: async () => ({ status: "finished", id: "run-first" }),
            };
          },
        }),
      };
      const opened = await openChatSession({ sdk, dir, interactive: false });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;

      const first = opened.session.sendTurn("first");
      const second = opened.session.sendTurn("second");
      await streamStarted;
      const closing = opened.session.close();
      const [firstOut, secondOut] = await Promise.all([first, second]);
      await closing;

      assert.equal(firstOut.kind, "error");
      assert.equal(secondOut.kind, "error");
      assert.equal(sendCalls, 1);
      assert.equal(cancelCalls, 1);
    });
  });

  it("Claude cancellation during overload backoff prevents the paid retry", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "session-cancel-backoff-"));
    writeFileSync(
      join(dir, "agent.config.json"),
      JSON.stringify({ engine: { provider: "claude-agent", auth: "account" } })
    );
    let sendCalls = 0;
    let markRetryScheduled!: () => void;
    const retryScheduled = new Promise<void>((resolveRetry) => {
      markRetryScheduled = resolveRetry;
    });
    const sdk: SdkCreateLike = {
      create: async () => ({
        agentId: "agent-claude-backoff",
        send: async () => {
          sendCalls++;
          return {
            stream: async function* () {},
            wait: async () => ({
              status: "error",
              id: `run-${sendCalls}`,
              error: "API Error: 529 overloaded",
            }),
          };
        },
      }),
    };
    const opened = await openChatSession({
      sdk,
      dir,
      interactive: false,
      overloadRetryDelaysMs: [25],
      onTurnRetry: () => markRetryScheduled(),
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const turn = opened.session.sendTurn("try once");
    await retryScheduled;
    assert.equal(await opened.session.cancelActiveTurn(), true);
    const out = await turn;
    const observer = createStore(dir, ".agent");
    try {
      assert.equal(out.kind, "error");
      if (out.kind === "error") assert.equal(out.message, "turn cancelled");
      assert.equal(sendCalls, 1);
      assert.equal((await observer.getSession(opened.session.sessionId))?.last_status, "cancelled");
    } finally {
      await observer.close();
      await opened.session.close();
    }
  });

  it("close waits for an in-flight rotation and disposes every created agent", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "session-rotate-close-"));
      const created: string[] = [];
      const disposed: string[] = [];
      let markFirstSendStarted!: () => void;
      const firstSendStarted = new Promise<void>((resolveStarted) => {
        markFirstSendStarted = resolveStarted;
      });
      let rejectFirstSend!: (reason: unknown) => void;
      const firstSendGate = new Promise<void>((_resolve, reject) => {
        rejectFirstSend = reject;
      });
      const sdk: SdkCreateLike = {
        create: async () => {
          const id = `agent-${created.length + 1}`;
          created.push(id);
          return {
            agentId: id,
            send:
              id === "agent-1"
                ? async () => {
                    markFirstSendStarted();
                    await firstSendGate;
                    return okRun("unreachable");
                  }
                : async () => okRun("recovered"),
            [Symbol.asyncDispose]: async () => {
              disposed.push(id);
            },
          };
        },
      };
      const opened = await openChatSession({ sdk, dir, interactive: false });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;

      const turn = opened.session.sendTurn("hello");
      await firstSendStarted;
      const closing = opened.session.close();
      rejectFirstSend(Object.assign(new Error("agent handle stale"), { code: 13 }));
      const [out] = await Promise.all([turn, closing]);

      assert.equal(out.kind, "ok");
      assert.deepEqual([...disposed].sort(), [...created].sort());
    });
  });

  it("does not dispose a broken agent again when replacement creation fails", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "session-failed-rotation-close-"));
      let createCalls = 0;
      let disposeCalls = 0;
      const sdk: SdkCreateLike = {
        create: async () => {
          createCalls++;
          if (createCalls === 2) throw new Error("replacement create failed");
          return {
            agentId: "agent-broken",
            send: async () => {
              throw Object.assign(new Error("agent handle stale"), { code: 13 });
            },
            [Symbol.asyncDispose]: async () => {
              disposeCalls++;
            },
          };
        },
      };
      const opened = await openChatSession({ sdk, dir, interactive: false });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;

      const out = await opened.session.sendTurn("hello");
      assert.equal(out.kind, "error");
      await opened.session.close();

      assert.equal(createCalls, 2);
      assert.equal(disposeCalls, 1);
    });
  });

  it("serializes concurrent turns before they can race the shared agent handle", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "session-concurrent-"));
      const events: string[] = [];
      let releaseFirstSend!: () => void;
      const firstSendGate = new Promise<void>((resolveFirst) => {
        releaseFirstSend = resolveFirst;
      });
      let markFirstSendStarted!: () => void;
      const firstSendStarted = new Promise<void>((resolveStarted) => {
        markFirstSendStarted = resolveStarted;
      });
      let sendCount = 0;
      const sdk: SdkCreateLike = {
        create: async () => ({
          agentId: "agent-serialized",
          send: async () => {
            const n = ++sendCount;
            events.push(`start-${n}`);
            if (n === 1) {
              markFirstSendStarted();
              await firstSendGate;
            }
            events.push(`end-${n}`);
            return okRun(`answer-${n}`);
          },
        }),
      };
      const opened = await openChatSession({ sdk, dir, interactive: false });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;

      const first = opened.session.sendTurn("first");
      const second = opened.session.sendTurn("second");
      await firstSendStarted;
      await new Promise<void>((resolveImmediate) => {
        setImmediate(() => {
          events.push("release");
          releaseFirstSend();
          resolveImmediate();
        });
      });
      await Promise.all([first, second]);
      await opened.session.close();

      assert.deepEqual(events, ["start-1", "release", "end-1", "start-2", "end-2"]);
    });
  });
});

describe("memory injection resilience in sendTurn (I-137)", () => {
  it("autoRag against a dead Postgres degrades the turn instead of failing it", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "resil-autorag-"));
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, "agent.config.json"),
        JSON.stringify({
          stateDir: ".agent",
          cwd: dir,
          memory: { autoRag: { enabled: true, limit: 2 } },
        }),
        "utf8"
      );
      // Create the session store while env is clean (sqlite) so the test
      // isolates the MEMORY path — only autoRag sees the dead PG below.
      const healthyStore = createStore(dir, ".agent");
      const prevUrl = process.env.IRIDA_DATABASE_URL;
      const prevKey = process.env.IRIDA_SECRETS_KEY;
      // Port 1 refuses immediately — a fast, deterministic "PG is down".
      process.env.IRIDA_DATABASE_URL = "postgresql://x:x@127.0.0.1:1/na";
      process.env.IRIDA_SECRETS_KEY = "resilience-test-secrets-key-32chars";
      let sendCount = 0;
      const sdk: SdkCreateLike = {
        create: async () => ({
          agentId: "agent-1",
          send: async () => {
            sendCount++;
            return okRun("answered without memory");
          },
        }),
      };
      try {
        const opened = await openChatSession({
          sdk,
          dir,
          interactive: false,
          store: healthyStore,
        });
        assert.equal(opened.ok, true);
        if (!opened.ok) return;
        const out = await opened.session.sendTurn("hello");
        assert.equal(out.kind, "ok");
        if (out.kind === "ok") assert.equal(out.assistantText, "answered without memory");
        assert.equal(sendCount, 1);
        await opened.session.close();
      } finally {
        if (prevUrl === undefined) delete process.env.IRIDA_DATABASE_URL;
        else process.env.IRIDA_DATABASE_URL = prevUrl;
        if (prevKey === undefined) delete process.env.IRIDA_SECRETS_KEY;
        else process.env.IRIDA_SECRETS_KEY = prevKey;
      }
    });
  });
});
