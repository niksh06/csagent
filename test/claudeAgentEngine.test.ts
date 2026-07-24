import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createClaudeAgentSdk,
  engineAuthEnv,
  toAgentMcpServers,
} from "../src/engines/claudeAgentSdk.js";
import { createSession, resumeSession, runOneShot, sendAgentTurn } from "../src/host.js";
import { loadConfig } from "../src/config.js";
import { createStore } from "../src/store.js";
import { cmdResume } from "../src/resume.js";
import { EXIT } from "../src/exit.js";

/** Snapshot + restore the two auth env vars around each case. */
function withCleanAuthEnv(fn: () => void): void {
  const prevApi = process.env.ANTHROPIC_API_KEY;
  const prevOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    fn();
  } finally {
    if (prevApi === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevApi;
    if (prevOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOauth;
  }
}

async function* messageStream(
  messages: Array<Record<string, unknown>>
): AsyncIterable<Record<string, unknown>> {
  for (const message of messages) yield message;
}

function controlledQuery(opts?: {
  interruptFails?: boolean;
  interruptNeverSettles?: boolean;
  interruptLeavesOpen?: boolean;
  yieldBeforeWait?: boolean;
}) {
  let release!: () => void;
  let markStarted!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const calls = { interrupt: 0, close: 0 };
  const query = {
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Record<string, unknown>> {
      if (opts?.yieldBeforeWait) yield { type: "assistant", text: "first" };
      markStarted();
      await released;
    },
    async interrupt(): Promise<void> {
      calls.interrupt++;
      if (opts?.interruptFails) throw new Error("interrupt failed");
      if (opts?.interruptNeverSettles) return new Promise<void>(() => {});
      if (opts?.interruptLeavesOpen) return;
      release();
    },
    close(): void {
      calls.close++;
      release();
    },
  };
  return { query, started, calls };
}

type CapturedQuery = {
  message: string;
  options: {
    model: string;
    cwd: string;
    permissionMode: string;
    env?: NodeJS.ProcessEnv;
    canUseTool?: (
      toolName: string,
      input: Record<string, unknown>,
      options: Record<string, unknown>
    ) => Promise<unknown>;
    mcpServers?: Record<string, unknown>;
    resume?: string;
    disallowedTools?: string[];
  };
};

test("engineAuthEnv api-key: sets ANTHROPIC_API_KEY, clears OAuth token", () => {
  withCleanAuthEnv(() => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale-oauth";
    const env = engineAuthEnv("api-key", "sk-ant-xyz");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-xyz");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.PATH, process.env.PATH); // SDK env replaces, rather than merges with, process.env.
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "stale-oauth");
  });
});

test("engineAuthEnv account: sets OAuth token, clears API key", () => {
  withCleanAuthEnv(() => {
    process.env.ANTHROPIC_API_KEY = "stale-api-key";
    const env = engineAuthEnv("account", "oauth-tok");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-tok");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.ANTHROPIC_API_KEY, "stale-api-key");
    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });
});

test("engineAuthEnv account empty: clears API key, keeps inherited login token", () => {
  withCleanAuthEnv(() => {
    process.env.ANTHROPIC_API_KEY = "stale-api-key";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "login-session-token";
    const env = engineAuthEnv("account", "");
    // API key cleared so it can't override account auth...
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    // ...and the inherited `claude login` token is left intact.
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "login-session-token");
    assert.equal(process.env.ANTHROPIC_API_KEY, "stale-api-key");
    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "login-session-token");
  });
});

test("engineAuthEnv builds independent credential snapshots for overlapping turns", () => {
  withCleanAuthEnv(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const first = engineAuthEnv("api-key", "first-key");
    const second = engineAuthEnv("api-key", "second-key");

    assert.equal(first.ANTHROPIC_API_KEY, "first-key");
    assert.equal(second.ANTHROPIC_API_KEY, "second-key");
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });
});

test("toAgentMcpServers: maps stdio + http, drops malformed, empty → undefined", () => {
  const out = toAgentMcpServers({
    mem: { command: "node", args: ["x.js"], env: { A: "1" } },
    web: { url: "https://mcp.example/sse", headers: { X: "1" } },
    bad: { nope: true },
  }) as Record<string, unknown>;
  assert.deepEqual(out.mem, { type: "stdio", command: "node", args: ["x.js"], env: { A: "1" } });
  assert.deepEqual(out.web, { type: "http", url: "https://mcp.example/sse", headers: { X: "1" } });
  assert.equal("bad" in out, false);
  assert.equal(toAgentMcpServers(undefined), undefined);
  assert.equal(toAgentMcpServers({}), undefined);
});

test("Claude adapter satisfies the host create/send/resume contract offline", async () => {
  const calls: CapturedQuery[] = [];
  let runNumber = 0;
  const sdk = createClaudeAgentSdk(
    {
      authMode: "api-key",
      toolPolicy: { denyDestructive: true, sanitizeInput: true },
    },
    {
      startQuery: async (message, options) => {
        const captured = { message, options } as CapturedQuery;
        calls.push(captured);
        const sessionId = captured.options.resume ?? "sess-created";
        const runId = `run-${++runNumber}`;
        return messageStream([
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "ok" }] },
            session_id: sessionId,
          },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "ok",
            uuid: runId,
            session_id: sessionId,
            usage: { input_tokens: 3, output_tokens: 2 },
          },
        ]);
      },
    }
  );
  const mcpServers = { memory: { command: "node", args: ["memory-server.js"] } };

  const created = await createSession(sdk, {
    apiKey: "create-key",
    model: "create-model",
    cwd: "/workspace/create",
    mcpServers,
  });
  const updates: unknown[] = [];
  const firstRun = await sendAgentTurn(created, "hello", "turn-model", {
    onDelta: ({ update }) => updates.push(update),
  });
  const streamed: unknown[] = [];
  for await (const event of firstRun.stream!()) streamed.push(event);
  assert.deepEqual(await firstRun.wait(), { status: "finished", id: "run-1" });
  assert.equal(created.agentId, "sess-created");
  assert.equal(streamed.length, 2);
  assert.ok(updates.some((event) => (event as { type?: string }).type === "result"));

  const first = calls[0]!;
  assert.equal(first.message, "hello");
  assert.equal(first.options.model, "turn-model");
  assert.equal(first.options.cwd, "/workspace/create");
  assert.equal(first.options.env?.ANTHROPIC_API_KEY, "create-key");
  assert.equal(first.options.permissionMode, "default");
  assert.deepEqual(first.options.mcpServers, {
    memory: { type: "stdio", command: "node", args: ["memory-server.js"] },
  });
  const sanitized = (await first.options.canUseTool?.(
    "Bash",
    { command: "git commit --no-verify -m x" },
    {}
  )) as { behavior?: string; updatedInput?: { command?: string } };
  assert.equal(sanitized.behavior, "allow");
  assert.equal(sanitized.updatedInput?.command, "git commit -m x");

  const secondRun = await sendAgentTurn(created, "again", "turn-model");
  for await (const _event of secondRun.stream!()) {
    // drain
  }
  assert.deepEqual(await secondRun.wait(), { status: "finished", id: "run-2" });
  assert.equal(calls[1]!.options.resume, "sess-created");

  const resumed = await resumeSession(
    sdk,
    "sess-existing",
    "resume-key",
    mcpServers,
    "resume-model",
    "/workspace/resumed"
  );
  const resumedRun = await sendAgentTurn(resumed, "continue", "override-model");
  for await (const _event of resumedRun.stream!()) {
    // drain
  }
  assert.deepEqual(await resumedRun.wait(), { status: "finished", id: "run-3" });
  assert.equal(calls[2]!.options.resume, "sess-existing");
  assert.equal(calls[2]!.options.model, "override-model");
  assert.equal(calls[2]!.options.cwd, "/workspace/resumed");
  assert.equal(calls[2]!.options.env?.ANTHROPIC_API_KEY, "resume-key");
});

test("Claude RunLike wait drains the query before stream consumption", async () => {
  const sdk = createClaudeAgentSdk(undefined, {
    startQuery: async () =>
      messageStream([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "buffered" }] },
          session_id: "sess-wait",
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "buffered",
          uuid: "run-wait",
          session_id: "sess-wait",
        },
      ]),
  });
  const agent = await createSession(sdk, {
    apiKey: "key",
    model: "claude-test",
    cwd: "/workspace",
  });
  const run = await sendAgentTurn(agent, "hello", "claude-test");
  const wait = run.wait();
  const completedWithoutStream = await Promise.race([
    wait.then(() => true),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);

  const streamed: unknown[] = [];
  for await (const event of run.stream!()) streamed.push(event);
  assert.equal(completedWithoutStream, true);
  assert.deepEqual(await wait, { status: "finished", id: "run-wait" });
  assert.equal(agent.agentId, "sess-wait");
  assert.equal(streamed.length, 2);
});

test("Claude RunLike cancel interrupts the active query", async () => {
  const controlled = controlledQuery();
  const sdk = createClaudeAgentSdk(undefined, {
    startQuery: async () => controlled.query,
  });
  const agent = await createSession(sdk, {
    apiKey: "key",
    model: "claude-test",
    cwd: "/workspace",
  });
  const run = await sendAgentTurn(agent, "hello", "claude-test");

  assert.equal(typeof run.cancel, "function");
  if (!run.cancel) return;
  await controlled.started;
  await run.cancel();
  await run.wait();
  assert.equal(controlled.calls.interrupt, 1);
  assert.equal(controlled.calls.close, 0);
});

test("Claude RunLike cancel force-closes when interrupt fails", async () => {
  const controlled = controlledQuery({ interruptFails: true });
  const sdk = createClaudeAgentSdk(undefined, {
    startQuery: async () => controlled.query,
  });
  const agent = await createSession(sdk, {
    apiKey: "key",
    model: "claude-test",
    cwd: "/workspace",
  });
  const run = await sendAgentTurn(agent, "hello", "claude-test");

  assert.equal(typeof run.cancel, "function");
  if (!run.cancel) return;
  await controlled.started;
  await run.cancel();
  await run.wait();
  assert.equal(controlled.calls.interrupt, 1);
  assert.equal(controlled.calls.close, 1);
});

test("Claude RunLike cancel force-closes when interrupt never settles", async () => {
  const controlled = controlledQuery({ interruptNeverSettles: true });
  const sdk = createClaudeAgentSdk(undefined, {
    startQuery: async () => controlled.query,
    cancelGraceMs: 0,
  });
  const agent = await createSession(sdk, {
    apiKey: "key",
    model: "claude-test",
    cwd: "/workspace",
  });
  const run = await sendAgentTurn(agent, "hello", "claude-test");

  assert.equal(typeof run.cancel, "function");
  if (!run.cancel) return;
  await controlled.started;
  await run.cancel();
  await run.wait();
  assert.equal(controlled.calls.interrupt, 1);
  assert.equal(controlled.calls.close, 1);
});

test("Claude RunLike cancel force-closes when interrupt leaves the iterator open", async () => {
  const controlled = controlledQuery({ interruptLeavesOpen: true });
  const sdk = createClaudeAgentSdk(undefined, {
    startQuery: async () => controlled.query,
    cancelGraceMs: 0,
  });
  const agent = await createSession(sdk, {
    apiKey: "key",
    model: "claude-test",
    cwd: "/workspace",
  });
  const run = await sendAgentTurn(agent, "hello", "claude-test");

  assert.equal(typeof run.cancel, "function");
  if (!run.cancel) return;
  await controlled.started;
  await run.cancel();
  await run.wait();
  assert.equal(controlled.calls.interrupt, 1);
  assert.equal(controlled.calls.close, 1);
});

test("Claude RunLike cancels the eager pump when stream consumption stops early", async () => {
  const controlled = controlledQuery({ interruptLeavesOpen: true, yieldBeforeWait: true });
  const sdk = createClaudeAgentSdk(undefined, {
    startQuery: async () => controlled.query,
    cancelGraceMs: 0,
  });
  const agent = await createSession(sdk, {
    apiKey: "key",
    model: "claude-test",
    cwd: "/workspace",
  });
  const run = await sendAgentTurn(agent, "hello", "claude-test");

  for await (const _event of run.stream!()) break;
  await run.wait();
  assert.equal(controlled.calls.interrupt, 1);
  assert.equal(controlled.calls.close, 1);
});

test("Claude agent close force-closes active queries exactly once", async () => {
  const controlled = controlledQuery();
  const sdk = createClaudeAgentSdk(undefined, {
    startQuery: async () => controlled.query,
  });
  const agent = await createSession(sdk, {
    apiKey: "key",
    model: "claude-test",
    cwd: "/workspace",
  });
  const run = await sendAgentTurn(agent, "hello", "claude-test");

  assert.equal(typeof agent.close, "function");
  if (!agent.close) return;
  await controlled.started;
  const firstClose = agent.close();
  const secondClose = agent.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  await run.wait();
  assert.equal(controlled.calls.close, 1);
  assert.equal(controlled.calls.interrupt, 0);
});

test("Claude one-shot preserves SDKResultError detail and separates run/session ids", async () => {
  let captured: CapturedQuery | undefined;
  const sdk = createClaudeAgentSdk(undefined, {
    startQuery: async (message, options) => {
      captured = { message, options } as CapturedQuery;
      return messageStream([
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["API Error: 529 overloaded"],
          uuid: "run-error-1",
          session_id: "sess-error-1",
          usage: { input_tokens: 11, output_tokens: 0 },
        },
      ]);
    },
  });

  const out = await runOneShot(sdk, {
    prompt: "hello",
    apiKey: "key",
    model: "claude-test",
    cwd: "/workspace",
    mcpServers: { memory: { url: "https://mcp.example" } },
    disallowedTools: ["Bash"],
  });

  assert.equal(out.status, "error");
  assert.match(out.text, /529 overloaded/);
  assert.equal(out.runId, "run-error-1");
  assert.equal(out.agentId, "sess-error-1");
  assert.equal(out.usage?.inputTokens, 11);
  assert.deepEqual(captured?.options.disallowedTools, ["Bash"]);
  assert.deepEqual(captured?.options.mcpServers, {
    memory: { type: "http", url: "https://mcp.example" },
  });
  assert.equal(captured?.options.permissionMode, "bypassPermissions");
  assert.equal(captured?.options.canUseTool, undefined);
});

test("Claude intercepts AskUserQuestion when the gateway ask MCP is available", async () => {
  let captured: CapturedQuery | undefined;
  const sdk = createClaudeAgentSdk(undefined, {
    startQuery: async (message, options) => {
      captured = { message, options } as CapturedQuery;
      return messageStream([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          uuid: "run-policy-1",
          session_id: "sess-policy-1",
        },
      ]);
    },
  });

  await runOneShot(sdk, {
    prompt: "hello",
    apiKey: "key",
    model: "claude-test",
    cwd: "/workspace",
    mcpServers: { "csagent-ask": { command: "node", args: ["ask-server.js"] } },
  });

  assert.equal(captured?.options.permissionMode, "default");
  assert.ok(captured?.options.canUseTool);
  const denied = (await captured?.options.canUseTool?.("AskUserQuestion", {}, {})) as {
    behavior?: string;
    message?: string;
  };
  assert.equal(denied.behavior, "deny");
  assert.match(denied.message ?? "", /ask_user/);
  const allowed = (await captured?.options.canUseTool?.("Bash", { command: "pwd" }, {})) as {
    behavior?: string;
    updatedInput?: Record<string, unknown>;
  };
  assert.equal(allowed.behavior, "allow");
  assert.deepEqual(allowed.updatedInput, { command: "pwd" });
});

test("Claude write-roots policy resolves relative tool paths from the query cwd", async () => {
  let captured: CapturedQuery | undefined;
  const cwd = "/tmp/irida-query-workspace";
  const sdk = createClaudeAgentSdk(
    { toolPolicy: { denyDestructive: false, allowWriteRoots: [cwd] } },
    {
      startQuery: async (message, options) => {
        captured = { message, options } as CapturedQuery;
        return messageStream([
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "ok",
            uuid: "run-roots-1",
            session_id: "sess-roots-1",
          },
        ]);
      },
    }
  );

  await runOneShot(sdk, { prompt: "hello", apiKey: "key", model: "claude-test", cwd });

  const allowed = (await captured?.options.canUseTool?.("Write", { file_path: "src/new.ts" }, {})) as {
    behavior?: string;
  };
  assert.equal(allowed.behavior, "allow");
  const denied = (await captured?.options.canUseTool?.("Write", { file_path: "../escape.ts" }, {})) as {
    behavior?: string;
  };
  assert.equal(denied.behavior, "deny");
});

test("resume guard: blocks cross-engine resume (offline, before any SDK call)", async () => {
  const prevApi = process.env.ANTHROPIC_API_KEY;
  const prevOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const dir = mkdtempSync(resolve(tmpdir(), "engine-guard-"));
    // active engine = claude-agent (account), but the stored session is a cursor session
    writeFileSync(
      resolve(dir, "agent.config.json"),
      JSON.stringify({ engine: { provider: "claude-agent", auth: "account" } })
    );
    const cfg = loadConfig(dir);
    const store = createStore(dir, cfg.stateDir);
    await store.upsertSession({
      id: "sess_cursor",
      title: "t",
      cwd: dir,
      runtime: "local",
      sdk_agent_id: "cursor-agent-id",
      engine: "cursor",
    });
    await store.close();

    // No sdk injected: if the guard didn't fire first, this would try the network.
    const code = await cmdResume("sess_cursor", "continue", { dir });
    assert.equal(code, EXIT.usage);
  } finally {
    if (prevApi === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevApi;
    if (prevOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOauth;
  }
});
