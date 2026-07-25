import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaudeAgentSdk } from "../src/engines/claudeAgentSdk.js";

// Irida-spawned agents must not inherit the operator's personal ~/.claude.
//
// With settingSources omitted the SDK loads every filesystem setting the CLI
// would, so the live Telegram agent was running with the dev machine's MCP
// servers (14 attached where Irida declares 5, four failing to start on every
// turn), the dev machine's PreToolUse/SessionStart hooks, and the dev machine's
// Bash permission allow-list. Measured 2026-07-25: median 65s per turn before
// any tool was usable; 15% of turns ended before tools arrived at all.
//
// 'project' rather than [] is the point of these tests: user scope must go,
// project scope must stay so CLAUDE.md still loads for agents working inside
// the repo.

type Captured = { message: string; options: Record<string, unknown> };

function messageStream(messages: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> & {
  interrupt?(): Promise<void>;
  close?(): void;
} {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    },
  };
}

const RESULT = [
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    uuid: "run-1",
    session_id: "sess-1",
  },
];

function sdkCapturing(calls: Captured[]) {
  return createClaudeAgentSdk(
    { authMode: "api-key", toolPolicy: { denyDestructive: false, sanitizeInput: false } },
    {
      startQuery: async (message, options) => {
        calls.push({ message, options: options as unknown as Record<string, unknown> });
        return messageStream(RESULT);
      },
    }
  );
}

test("interactive turns pin settingSources to project scope only", async () => {
  const calls: Captured[] = [];
  const sdk = sdkCapturing(calls);
  const agent = await sdk.create({
    model: { id: "claude-opus-4-8" },
    local: { cwd: "/tmp" },
    apiKey: "sk-ant-test",
    mcpServers: {},
  } as Parameters<typeof sdk.create>[0]);

  const run = await agent.send("hi");
  await run.wait();

  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0]!.options.settingSources,
    ["project"],
    "user scope must be excluded — that is where the operator's MCP servers and hooks live"
  );
});

test("one-shot runs (cron, delegate) pin settingSources the same way", async () => {
  const calls: Captured[] = [];
  const sdk = sdkCapturing(calls);

  await sdk.prompt("hi", {
    model: { id: "claude-opus-4-8" },
    local: { cwd: "/tmp" },
    apiKey: "sk-ant-test",
    mcpServers: {},
  } as Parameters<typeof sdk.prompt>[1]);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.options.settingSources, ["project"]);
});

test("settingSources never widens to user scope, and is never left unset", async () => {
  const calls: Captured[] = [];
  const sdk = sdkCapturing(calls);
  const agent = await sdk.create({
    model: { id: "claude-opus-4-8" },
    local: { cwd: "/tmp" },
    apiKey: "sk-ant-test",
    mcpServers: { "csagent-memory": { command: "x", args: [] } },
  } as Parameters<typeof sdk.create>[0]);
  await (await agent.send("one")).wait();
  await (await agent.send("two")).wait();

  for (const c of calls) {
    const s = c.options.settingSources as string[] | undefined;
    assert.ok(Array.isArray(s), "omitted settingSources means the SDK loads everything — never allow that");
    assert.ok(!s.includes("user"), "user scope is the operator's personal config");
    assert.ok(!s.includes("local"), "local scope is likewise not Irida's to inherit");
  }
});
