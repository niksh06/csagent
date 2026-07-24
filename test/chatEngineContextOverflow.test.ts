import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openChatSession } from "../src/chatEngine.js";
import { createMemoryStore } from "../src/memoryStore.js";
import { createStore } from "../src/store.js";
import { isContextOverflowErrorText } from "../src/sdkErrors.js";
import {
  formatSessionHandoffBody,
  sessionHandoffNoteName,
  writeSessionHandoff,
  SESSION_HANDOFF_WING,
} from "../src/sessionHandoff.js";
import type { AgentLike, RunLike, SdkCreateLike } from "../src/host.js";

// A long-lived chat session that outgrows the context window used to be "fixed" by
// rotation: fresh SDK agent, last 4 run previews replayed, everything else dropped
// without telling anyone. These cover the replacement — write a durable handoff,
// `/compact` the SAME session, retry the original turn.

function withKey(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "test-key";
  return fn().finally(() => {
    if (prev === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prev;
  });
}

function tmp(prefix: string): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

function okRun(text: string): RunLike {
  return {
    stream: async function* () {
      yield { type: "text", text };
    },
    wait: async () => ({ status: "finished", id: "r-ok" }),
  };
}

const OVERFLOW = "Claude Code returned an error result: Prompt is too long";

describe("isContextOverflowErrorText", () => {
  it("matches the real SDK overflow text", () => {
    assert.equal(isContextOverflowErrorText(OVERFLOW), true);
    assert.equal(isContextOverflowErrorText("Prompt is too long"), true);
  });

  it("does not swallow overload or auth failures", () => {
    // Misclassifying either would send them down the compact path, which cannot fix them.
    assert.equal(isContextOverflowErrorText("529 overloaded_error"), false);
    assert.equal(isContextOverflowErrorText("401 invalid api key"), false);
    assert.equal(isContextOverflowErrorText("Your organization has disabled"), false);
    assert.equal(isContextOverflowErrorText(""), false);
    assert.equal(isContextOverflowErrorText(undefined), false);
  });
});

describe("session handoff note", () => {
  it("keeps the NEWEST turns when the budget runs out", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({
      prompt: `question ${i}`,
      result: `answer ${i} ${"z".repeat(200)}`,
    }));
    const body = formatSessionHandoffBody({
      sessionId: "sess_x",
      reason: "context overflow",
      atIso: "2026-07-25T00:00:00.000Z",
      turns,
      maxChars: 1200,
    });
    assert.match(body, /question 9/, "the latest turn must survive truncation");
    assert.ok(!body.includes("question 0"), "the oldest turn is the one to drop");
    assert.match(body, /earlier turn\(s\) omitted for size/);
  });

  it("round-trips through the memory store into a searchable wing", async () => {
    const dir = tmp("handoff-");
    const store = createStore(dir, ".agent");
    await store.upsertSession({
      id: "sess_h",
      title: "t",
      cwd: dir,
      runtime: "local",
      sdk_agent_id: "a1",
      channel: "telegram",
    });
    await store.recordRun({
      id: "run_1",
      session_id: "sess_h",
      sdk_agent_id: "a1",
      sdk_run_id: "s1",
      prompt_preview: "как дела с памятью",
      result_preview: "пользуюсь, но recall на моей инициативе",
      status: "finished",
      error_kind: null,
      error_detail: null,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      cwd: dir,
      runtime: "local",
      model: "m",
    });

    const memory = createMemoryStore(dir, ".agent");
    const name = await writeSessionHandoff(store, memory, "sess_h", {
      reason: "context overflow",
      channel: "telegram",
    });
    assert.equal(name, sessionHandoffNoteName("sess_h"));

    const note = await memory.getNote(name!);
    assert.ok(note, "handoff note must be persisted");
    assert.equal(note!.wing, SESSION_HANDOFF_WING);
    assert.match(note!.body, /recall на моей инициативе/);
    assert.match(note!.body, /context overflow/);
    await memory.close();
    await store.close();
  });

  it("returns undefined for a session with no recorded runs", async () => {
    const dir = tmp("handoff-empty-");
    const store = createStore(dir, ".agent");
    const memory = createMemoryStore(dir, ".agent");
    const name = await writeSessionHandoff(store, memory, "sess_none", { reason: "x" });
    assert.equal(name, undefined);
    await memory.close();
    await store.close();
  });
});

describe("context overflow in sendTurn", () => {
  it("writes a handoff, compacts, and retries on the SAME agent instead of rotating", async () => {
    await withKey(async () => {
      const dir = tmp("overflow-compact-");
      const sent: string[] = [];
      let created = 0;
      const sdk: SdkCreateLike = {
        create: async () => {
          created++;
          const agent: AgentLike = {
            agentId: `agent-${created}`,
            send: async (message: string) => {
              sent.push(message);
              // Only the very first user turn overflows; /compact and the retry succeed.
              if (sent.length === 1) throw new Error(OVERFLOW);
              return okRun("answered after compact");
            },
          };
          return agent;
        },
      };

      const compacts: { sessionId: string; handoffNote?: string }[] = [];
      const rotations: unknown[] = [];
      const opened = await openChatSession({
        sdk,
        dir,
        interactive: false,
        onSessionCompacted: (info) => compacts.push(info),
        onAgentRotated: (info) => rotations.push(info),
      });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;

      const out = await opened.session.sendTurn("что там с памятью");
      assert.equal(out.kind, "ok");
      if (out.kind === "ok") assert.equal(out.assistantText, "answered after compact");

      // 1) the overflowing turn, 2) a bare /compact, 3) the retry
      assert.equal(sent.length, 3);
      assert.equal(sent[1], "/compact", "/compact must reach the SDK verbatim");
      assert.match(sent[2]!, /что там с памятью/);

      assert.equal(created, 1, "the SDK session must survive — no rotation");
      assert.equal(rotations.length, 0);
      assert.equal(compacts.length, 1);
      assert.equal(compacts[0]!.handoffNote, sessionHandoffNoteName(opened.session.sessionId));

      const memory = createMemoryStore(dir, ".agent");
      const note = await memory.getNote(compacts[0]!.handoffNote!);
      assert.ok(note, "the handoff note must exist after the compact");
      await memory.close();
      await opened.session.close();
    });
  });

  it("falls back to rotation when the compact itself fails", async () => {
    await withKey(async () => {
      const dir = tmp("overflow-compact-fail-");
      const sent: string[] = [];
      let created = 0;
      const sdk: SdkCreateLike = {
        create: async () => {
          created++;
          const agentId = `agent-${created}`;
          return {
            agentId,
            send: async (message: string) => {
              sent.push(message);
              if (message === "/compact") throw new Error("compaction unavailable");
              // The first agent is wedged; a rotated one answers.
              if (agentId === "agent-1") throw new Error(OVERFLOW);
              return okRun("answered after rotation");
            },
          } as AgentLike;
        },
      };

      const opened = await openChatSession({ sdk, dir, interactive: false });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;

      const out = await opened.session.sendTurn("hello");
      assert.equal(out.kind, "ok", "a failed compact must degrade to rotation, not a hard error");
      assert.ok(sent.includes("/compact"));
      assert.equal(created, 2, "rotation is the fallback");
      await opened.session.close();
    });
  });

  it("compacts at most once per turn", async () => {
    await withKey(async () => {
      const dir = tmp("overflow-once-");
      const sent: string[] = [];
      const sdk: SdkCreateLike = {
        create: async () =>
          ({
            agentId: "agent-1",
            send: async (message: string) => {
              sent.push(message);
              // Still overflowing after the compact — must not loop.
              if (message !== "/compact") throw new Error(OVERFLOW);
              return okRun("compacted");
            },
          }) as AgentLike,
      };

      const opened = await openChatSession({ sdk, dir, interactive: false });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;

      const out = await opened.session.sendTurn("hello");
      assert.equal(out.kind, "error");
      assert.equal(
        sent.filter((m) => m === "/compact").length,
        1,
        "exactly one compact attempt per turn"
      );
      await opened.session.close();
    });
  });
});

test("overload errors still retry in place rather than compacting", async () => {
  await withKey(async () => {
    const dir = tmp("overflow-not-overload-");
    const sent: string[] = [];
    const sdk: SdkCreateLike = {
      create: async () =>
        ({
          agentId: "agent-1",
          send: async (message: string) => {
            sent.push(message);
            if (sent.length === 1) throw new Error("529 overloaded_error");
            return okRun("recovered");
          },
        }) as AgentLike,
    };

    const opened = await openChatSession({
      sdk,
      dir,
      interactive: false,
      overloadRetryDelaysMs: [1],
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const out = await opened.session.sendTurn("hello");
    assert.equal(out.kind, "ok");
    assert.ok(!sent.includes("/compact"), "capacity errors must not trigger compaction");
    await opened.session.close();
  });
});
