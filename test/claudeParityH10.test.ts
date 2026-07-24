import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eventThinkingText, type AgentLike, type RunLike, type SdkCreateLike, type SdkLike } from "../src/host.js";
import { openChatSession } from "../src/chatEngine.js";
import { runPrompt } from "../src/run.js";
import { runDelegate } from "../src/delegateRun.js";
import { createClaudeAgentSdk } from "../src/engines/claudeAgentSdk.js";

// H-10: claude-agent parity — thinking extraction, idle-rotation skip,
// one-shot overload retry, delegate without a hard CURSOR gate.

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe("thinking extraction (H-10)", () => {
  it("assistant thinking blocks carry text in `thinking` (Anthropic shape)", () => {
    const anthropicShaped = {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "let me think" }, { type: "text", text: "answer" }] },
    };
    assert.equal(eventThinkingText(anthropicShaped), "let me think");
    // Legacy `text` field still honored.
    const legacy = { type: "assistant", message: { content: [{ type: "thinking", text: "old shape" }] } };
    assert.equal(eventThinkingText(legacy), "old shape");
  });
});

function okRun(text: string): RunLike {
  return {
    stream: async function* () {
      yield { type: "text", text };
    },
    wait: async () => ({ status: "finished", id: "r" }),
  };
}

async function* claudeMessages(
  messages: Array<Record<string, unknown>>
): AsyncIterable<Record<string, unknown>> {
  for (const message of messages) yield message;
}

describe("idle rotation (H-10)", () => {
  it("claude-agent skips the idle fresh+replay; cursor still rotates", async () => {
    for (const provider of ["claude-agent", "cursor"] as const) {
      await withEnv(
        {
          IRIDA_AGENT_IDLE_MS: "1",
          CURSOR_API_KEY: "k",
          ANTHROPIC_API_KEY: "sk-ant-test-key-long-enough-000000000000",
        },
        async () => {
          const dir = mkdtempSync(resolve(tmpdir(), `idle-${provider}-`));
          writeFileSync(
            join(dir, "agent.config.json"),
            JSON.stringify({ stateDir: ".agent", engine: { provider } }),
            "utf8"
          );
          let created = 0;
          const sdk: SdkCreateLike = {
            create: async () => {
              created++;
              return { agentId: `agent-${created}`, send: async () => okRun("hi") } satisfies AgentLike;
            },
          };
          const opened = await openChatSession({ sdk, dir, interactive: false });
          assert.equal(opened.ok, true, provider);
          if (!opened.ok) return;
          await opened.session.sendTurn("one");
          await new Promise((r) => setTimeout(r, 10)); // exceed the 1ms idle TTL
          await opened.session.sendTurn("two");
          if (provider === "claude-agent") {
            // The strong invariant: NO rotation ever, however slow the runner.
            assert.equal(created, 1, "claude-agent must NOT rotate on idle (session resumes per turn)");
          } else {
            // Timing-robust: with a 1ms TTL a slow CI runner can trigger the
            // idle refresh before turn one too — assert "rotated at least
            // once", not an exact count (CI flaked on 3 !== 2).
            assert.ok(created >= 2, `cursor must refresh the idle handle (created=${created})`);
          }
          await opened.session.close();
        }
      );
    }
  });
});

describe("one-shot overload retry (H-10)", () => {
  it("runPrompt retries a 529-style failure and succeeds", async () => {
    await withEnv({ CURSOR_API_KEY: "k" }, async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "oneshot-"));
      writeFileSync(join(dir, "agent.config.json"), JSON.stringify({ stateDir: ".agent" }), "utf8");
      let calls = 0;
      const sdk: SdkLike = {
        prompt: async () => {
          calls++;
          if (calls === 1) return { status: "error", result: "overloaded_error: 529", id: "r1" };
          return { status: "finished", result: "recovered", id: "r2" };
        },
      };
      const out = await runPrompt("ping", {
        sdk,
        dir,
        persistRun: false,
        quiet: true,
        barePrompt: true,
        overloadRetryDelaysMs: [0],
      });
      assert.equal(calls, 2);
      assert.equal(out.exitCode, 0);
      assert.match(out.text, /recovered/);
    });
  });

  it("non-overload failure is NOT retried", async () => {
    await withEnv({ CURSOR_API_KEY: "k" }, async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "oneshot-no-"));
      writeFileSync(join(dir, "agent.config.json"), JSON.stringify({ stateDir: ".agent" }), "utf8");
      let calls = 0;
      const sdk: SdkLike = {
        prompt: async () => {
          calls++;
          return { status: "error", result: "boring logic error", id: "r1" };
        },
      };
      const out = await runPrompt("ping", {
        sdk,
        dir,
        persistRun: false,
        quiet: true,
        barePrompt: true,
        overloadRetryDelaysMs: [0, 0],
      });
      assert.equal(calls, 1);
      assert.notEqual(out.exitCode, 0);
    });
  });

  it("retries a real Claude SDKResultError shape whose detail lives in errors[]", async () => {
    await withEnv(
      {
        CURSOR_API_KEY: undefined,
        ANTHROPIC_API_KEY: "sk-ant-test-key-long-enough-000000000000",
      },
      async () => {
        const dir = mkdtempSync(resolve(tmpdir(), "oneshot-claude-result-"));
        writeFileSync(
          join(dir, "agent.config.json"),
          JSON.stringify({ stateDir: ".agent", engine: { provider: "claude-agent" } }),
          "utf8"
        );
        let calls = 0;
        const sdk = createClaudeAgentSdk(undefined, {
          startQuery: async () => {
            calls++;
            if (calls === 1) {
              return claudeMessages([
                {
                  type: "result",
                  subtype: "error_during_execution",
                  is_error: true,
                  errors: ["API Error: 529 overloaded"],
                  uuid: "run-1",
                  session_id: "sess-claude",
                },
              ]);
            }
            return claudeMessages([
              {
                type: "result",
                subtype: "success",
                is_error: false,
                result: "recovered",
                uuid: "run-2",
                session_id: "sess-claude",
              },
            ]);
          },
        });

        const out = await runPrompt("ping", {
          sdk,
          dir,
          persistRun: false,
          quiet: true,
          barePrompt: true,
          overloadRetryDelaysMs: [0],
        });

        assert.equal(calls, 2);
        assert.equal(out.exitCode, 0);
        assert.equal(out.text, "recovered");
      }
    );
  });
});

describe("interactive Claude result contract (H-10)", () => {
  it("keeps errors[] detail so chat retries an overload result in place", async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: "sk-ant-test-key-long-enough-000000000000" },
      async () => {
        const dir = mkdtempSync(resolve(tmpdir(), "chat-claude-result-"));
        writeFileSync(
          join(dir, "agent.config.json"),
          JSON.stringify({ stateDir: ".agent", engine: { provider: "claude-agent" } }),
          "utf8"
        );
        const resumes: Array<string | undefined> = [];
        const sdk = createClaudeAgentSdk(undefined, {
          startQuery: async (_message, options) => {
            resumes.push(options.resume);
            if (resumes.length === 1) {
              return claudeMessages([
                {
                  type: "result",
                  subtype: "error_during_execution",
                  is_error: true,
                  errors: ["API Error: 529 overloaded"],
                  uuid: "run-chat-1",
                  session_id: "sess-chat-claude",
                },
              ]);
            }
            return claudeMessages([
              {
                type: "assistant",
                message: { content: [{ type: "text", text: "recovered" }] },
                session_id: "sess-chat-claude",
              },
              {
                type: "result",
                subtype: "success",
                is_error: false,
                result: "recovered",
                uuid: "run-chat-2",
                session_id: "sess-chat-claude",
              },
            ]);
          },
        });
        const opened = await openChatSession({
          sdk,
          dir,
          interactive: false,
          overloadRetryDelaysMs: [0],
        });
        assert.equal(opened.ok, true);
        if (!opened.ok) return;
        try {
          const out = await opened.session.sendTurn("hello");
          assert.equal(out.kind, "ok");
          if (out.kind === "ok") assert.equal(out.assistantText, "recovered");
          assert.deepEqual(resumes, [undefined, "sess-chat-claude"]);
        } finally {
          await opened.session.close();
        }
      }
    );
  });
});

describe("delegate key gate (H-10)", () => {
  it("missing key surfaces the provider-correct help, not a hard CURSOR gate", async () => {
    await withEnv(
      { CURSOR_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined },
      async () => {
        const dir = mkdtempSync(resolve(tmpdir(), "delegate-"));
        writeFileSync(
          join(dir, "agent.config.json"),
          JSON.stringify({ stateDir: ".agent", engine: { provider: "claude-agent", auth: "api-key" } }),
          "utf8"
        );
        const out = await runDelegate({ dir, prompt: "hi" });
        assert.equal(out.ok, false);
        assert.match(out.summary, /ANTHROPIC_API_KEY/); // provider-aware, not CURSOR_API_KEY
      }
    );
  });
});
