import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  codexEnv,
  codexSandboxOptions,
  createCodexEventMapper,
  createCodexSdk,
  ensureCodexHome,
  mapCodexUsage,
  toCodexEffort,
  toCodexMcpServers,
} from "../src/engines/codexSdk.js";
import {
  createSession,
  eventText,
  eventThinkingText,
  eventActivityDetail,
  parseStreamUsage,
  runOneShot,
  resumeSession,
  sendAgentTurn,
} from "../src/host.js";
import {
  DEFAULT_CODEX_MODEL,
  normalizeEngineProvider,
  resolveEngineAuth,
} from "../src/config.js";
import { consumeRunStream } from "../src/sdkErrors.js";

// I-144: the codex engine adapter. Everything below is the CLI's real JSONL
// event vocabulary (`codex exec`), captured from a live run on 2026-07-31.

type Ev = Record<string, unknown>;

interface ClientCalls {
  options: Array<Record<string, unknown>>;
  started: Array<Record<string, unknown> | undefined>;
  resumed: Array<{ id: string; options?: Record<string, unknown> }>;
  inputs: string[];
  signals: Array<AbortSignal | undefined>;
}

function fakeClientFactory(events: Ev[]): {
  createClient: (options: Record<string, unknown>) => Promise<unknown>;
  calls: ClientCalls;
} {
  const calls: ClientCalls = { options: [], started: [], resumed: [], inputs: [], signals: [] };
  const makeThread = () => ({
    id: null as string | null,
    async runStreamed(input: string, turnOptions?: { signal?: AbortSignal }) {
      calls.inputs.push(input);
      calls.signals.push(turnOptions?.signal);
      return {
        events: (async function* () {
          for (const e of events) yield e;
        })(),
      };
    },
  });
  return {
    createClient: async (options: Record<string, unknown>) => {
      calls.options.push(options);
      return {
        startThread(o?: Record<string, unknown>) {
          calls.started.push(o);
          return makeThread();
        },
        resumeThread(id: string, o?: Record<string, unknown>) {
          calls.resumed.push({ id, options: o });
          return makeThread();
        },
      };
    },
    calls,
  };
}

const OK_TURN: Ev[] = [
  { type: "thread.started", thread_id: "th_live_1" },
  { type: "turn.started" },
  {
    type: "item.started",
    item: { id: "it1", type: "command_execution", command: "ls -la", aggregated_output: "", status: "in_progress" },
  },
  {
    type: "item.completed",
    item: {
      id: "it1",
      type: "command_execution",
      command: "ls -la",
      aggregated_output: "total 8\n",
      exit_code: 0,
      status: "completed",
    },
  },
  { type: "item.completed", item: { id: "it2", type: "reasoning", text: "thinking about it" } },
  { type: "item.completed", item: { id: "it3", type: "agent_message", text: "done." } },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 17_505,
      cached_input_tokens: 11_008,
      cache_write_input_tokens: 0,
      output_tokens: 11,
      reasoning_output_tokens: 0,
    },
  },
];

// ── usage ────────────────────────────────────────────────────────────────────

test("usage subtracts cached tokens from the input total", () => {
  // Codex reports input_tokens INCLUSIVE of cached; our cost model adds the two
  // at different rates, so passing the raw number through bills cache twice.
  const u = mapCodexUsage({
    input_tokens: 17_505,
    cached_input_tokens: 11_008,
    output_tokens: 11,
    cache_write_input_tokens: 0,
  });
  assert.equal(u?.inputTokens, 6_497);
  assert.equal(u?.cacheReadTokens, 11_008);
  assert.equal(u?.outputTokens, 11);
  assert.equal((u?.inputTokens ?? 0) + (u?.cacheReadTokens ?? 0), 17_505);
});

test("usage tolerates a missing/empty payload", () => {
  assert.equal(mapCodexUsage(undefined), null);
  assert.equal(mapCodexUsage({}), null);
  // Never negative, even if a future CLI reports cached > input.
  assert.equal(mapCodexUsage({ input_tokens: 5, cached_input_tokens: 9 })?.inputTokens, 0);
});

// ── event mapping ────────────────────────────────────────────────────────────

test("agent_message becomes assistant text the host can read", () => {
  const map = createCodexEventMapper();
  const out = map({ type: "item.completed", item: { id: "a", type: "agent_message", text: "hi" } });
  assert.equal(out.length, 1);
  assert.equal(eventText(out[0]), "hi");
});

test("several agent messages in one turn stay separated", () => {
  // Live run 2026-07-31 glued "…verbatim." onto "IRIDA-CODEX-LIVE": consumers
  // append text events verbatim, so the separator has to come from the mapper.
  const map = createCodexEventMapper();
  const first = map({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "I'll run it." } });
  const second = map({ type: "item.completed", item: { id: "m2", type: "agent_message", text: "OUTPUT" } });
  assert.equal(eventText(first[0]) + eventText(second[0]), "I'll run it.\n\nOUTPUT");
});

test("a started agent_message does not duplicate the answer", () => {
  const map = createCodexEventMapper();
  assert.deepEqual(map({ type: "item.started", item: { id: "a", type: "agent_message", text: "hi" } }), []);
});

test("reasoning becomes thinking, not assistant text", () => {
  const map = createCodexEventMapper();
  const out = map({ type: "item.completed", item: { id: "r", type: "reasoning", text: "hmm" } });
  assert.equal(eventThinkingText(out[0]), "hmm");
  assert.equal(eventText(out[0]), "");
});

test("a command execution maps to one call and one result", () => {
  const map = createCodexEventMapper();
  const started = map({
    type: "item.started",
    item: { id: "c1", type: "command_execution", command: "ls -la", status: "in_progress" },
  });
  const done = map({
    type: "item.completed",
    item: {
      id: "c1",
      type: "command_execution",
      command: "ls -la",
      aggregated_output: "total 8",
      exit_code: 0,
      status: "completed",
    },
  });
  assert.equal(started.length, 1);
  assert.equal(done.length, 1);
  const call = eventActivityDetail(started[0]);
  const result = eventActivityDetail(done[0]);
  assert.equal(call?.phase, "call");
  assert.equal(call?.command, "ls -la");
  assert.equal(result?.phase, "result");
  assert.equal(result?.exitCode, 0);
  assert.match(result?.stdoutPreview ?? "", /total 8/);
});

test("a completion with no start still counts as a tool call", () => {
  // The live probe never emitted item.started — every item arrived terminal.
  // Without synthesizing the call the turn would report zero tools used.
  const map = createCodexEventMapper();
  const out = map({
    type: "item.completed",
    item: { id: "solo", type: "command_execution", command: "pwd", exit_code: 0, status: "completed" },
  });
  assert.equal(out.length, 2);
  assert.equal(eventActivityDetail(out[0])?.phase, "call");
  assert.equal(eventActivityDetail(out[1])?.phase, "result");
});

test("a failed command surfaces as an error result", () => {
  const map = createCodexEventMapper();
  const out = map({
    type: "item.completed",
    item: { id: "c", type: "command_execution", command: "false", exit_code: 1, status: "completed" },
  });
  assert.equal(eventActivityDetail(out.at(-1))?.status, "error");
  assert.equal(eventActivityDetail(out.at(-1))?.exitCode, 1);
});

test("file changes and mcp calls are labeled readably", () => {
  const map = createCodexEventMapper();
  const patch = map({
    type: "item.completed",
    item: {
      id: "p",
      type: "file_change",
      changes: [
        { path: "src/a.ts", kind: "update" },
        { path: "src/b.ts", kind: "add" },
      ],
      status: "completed",
    },
  });
  assert.match(eventActivityDetail(patch.at(-1))?.command ?? "", /update src\/a\.ts, add src\/b\.ts/);

  const mcp = createCodexEventMapper()({
    type: "item.completed",
    item: {
      id: "m",
      type: "mcp_tool_call",
      server: "irida-memory",
      tool: "memory_search",
      arguments: { query: "codex" },
      status: "completed",
    },
  });
  const detail = eventActivityDetail(mcp.at(-1));
  assert.equal(detail?.toolName, "mcp__irida-memory__memory_search");
  assert.equal(detail?.kind, "mcp");
});

test("a non-fatal error item shows up as activity, not as the answer", () => {
  const map = createCodexEventMapper();
  const out = map({ type: "item.completed", item: { id: "e", type: "error", message: "sandbox denied" } });
  assert.equal(eventText(out[0]), "");
  assert.match(eventActivityDetail(out[0])?.command ?? "", /sandbox denied/);
});

test("todo lists and unknown items produce no activity noise", () => {
  const map = createCodexEventMapper();
  assert.deepEqual(
    map({ type: "item.completed", item: { id: "t", type: "todo_list", items: [{ text: "x", completed: false }] } }),
    []
  );
  assert.deepEqual(map({ type: "item.completed", item: { id: "u", type: "future_thing" } }), []);
  assert.deepEqual(map({ type: "some.unknown.event" }), []);
});

test("turn usage reaches the host usage parser", () => {
  const map = createCodexEventMapper();
  const out = map({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } });
  const parsed = parseStreamUsage(out[0]);
  assert.equal(parsed?.inputTokens, 60);
  assert.equal(parsed?.cacheReadTokens, 40);
  assert.equal(parsed?.outputTokens, 7);
});

// ── options mapping ──────────────────────────────────────────────────────────

test("mcp servers map to the CLI config table", () => {
  const out = toCodexMcpServers({
    stdioSrv: { command: "node", args: ["srv.js"], env: { A: "1" } },
    httpSrv: { url: "https://example.test/mcp" },
    junk: { nothing: true },
  });
  assert.deepEqual(out?.stdioSrv, { command: "node", args: ["srv.js"], env: { A: "1" } });
  assert.deepEqual(out?.httpSrv, { url: "https://example.test/mcp" });
  assert.equal(out?.junk, undefined);
  assert.equal(toCodexMcpServers(undefined), undefined);
  assert.equal(toCodexMcpServers({}), undefined);
});

test("effort maps onto the codex scale, capping max at xhigh", () => {
  assert.equal(toCodexEffort("max"), "xhigh");
  assert.equal(toCodexEffort("high"), "high");
  assert.equal(toCodexEffort("MEDIUM"), "medium");
  assert.equal(toCodexEffort(undefined), undefined);
  assert.equal(toCodexEffort("turbo"), undefined);
});

test("the sandbox floor is workspace-write with approvals off", () => {
  const base = codexSandboxOptions();
  assert.equal(base.sandboxMode, "workspace-write");
  // Nothing can answer an approval prompt on a headless surface.
  assert.equal(base.approvalPolicy, "never");
  assert.equal(base.networkAccessEnabled, true);
  assert.equal(base.additionalDirectories, undefined);

  const scoped = codexSandboxOptions({ denyDestructive: true, allowWriteRoots: ["/tmp/wt", "  "] });
  assert.deepEqual(scoped.additionalDirectories, ["/tmp/wt"]);
});

test("account mode strips API keys from the subprocess environment", () => {
  const prevOpenAi = process.env.OPENAI_API_KEY;
  const prevCodex = process.env.CODEX_API_KEY;
  try {
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    process.env.CODEX_API_KEY = "sk-should-not-leak";
    const env = codexEnv("account", "/tmp/home");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
    assert.equal(env.CODEX_HOME, "/tmp/home");
    // api-key mode leaves the environment alone apart from the home.
    assert.equal(codexEnv("api-key", "/tmp/home").OPENAI_API_KEY, "sk-should-not-leak");
  } finally {
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAi;
    if (prevCodex === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = prevCodex;
  }
});

test("the isolated home links to the operator credential and repairs a stale copy", () => {
  const root = mkdtempSync(resolve(tmpdir(), "codex-home-"));
  const authTarget = resolve(root, "real-auth.json");
  writeFileSync(authTarget, "{}\n");
  const home = resolve(root, "codex-home");

  assert.equal(ensureCodexHome(home, authTarget).linked, true);
  assert.equal(readlinkSync(resolve(home, "auth.json")), authTarget);

  // A token refresh that replaced the link with a plain file must not leave a
  // frozen copy behind — two copies would rotate independently and log each
  // other out. (An in-place rewrite goes THROUGH the link and is fine; only an
  // atomic write+rename replaces it, which is what this simulates.)
  unlinkSync(resolve(home, "auth.json"));
  writeFileSync(resolve(home, "auth.json"), "{\"stale\":true}\n");
  assert.equal(lstatSync(resolve(home, "auth.json")).isSymbolicLink(), false);
  assert.equal(ensureCodexHome(home, authTarget).linked, true);
  assert.equal(readlinkSync(resolve(home, "auth.json")), authTarget);
});

// ── engine through the host contract ─────────────────────────────────────────

test("a full turn streams text, tools and usage, and adopts the thread id", async () => {
  const { createClient, calls } = fakeClientFactory(OK_TURN);
  const sdk = createCodexSdk({ authMode: "account" }, { createClient, home: "/tmp/irida-codex-test" });
  const agent = await createSession(sdk, { apiKey: "", model: "gpt-test", cwd: "/tmp" });
  const run = await sendAgentTurn(agent, "hello", "gpt-test");

  let text = "";
  let thinking = "";
  let tools = 0;
  let usage: ReturnType<typeof parseStreamUsage> = null;
  await consumeRunStream(run, (ev) => {
    text += eventText(ev);
    thinking += eventThinkingText(ev);
    const a = eventActivityDetail(ev);
    if (a?.phase === "call") tools++;
    const u = parseStreamUsage(ev);
    if (u) usage = u;
  });
  const res = await run.wait();

  assert.equal(text, "done.");
  assert.equal(thinking, "thinking about it");
  assert.equal(tools, 1);
  assert.equal(usage!.inputTokens, 6_497);
  assert.equal(res.status, "finished");
  assert.equal(agent.agentId, "th_live_1");
  assert.equal(calls.inputs[0], "hello");
  // The thread carries Irida's own options, not the operator's config.toml.
  assert.equal(calls.started[0]?.model, "gpt-test");
  assert.equal(calls.started[0]?.skipGitRepoCheck, true);
  assert.equal((calls.options[0]?.env as Record<string, string>).CODEX_HOME, "/tmp/irida-codex-test");
});

test("a second turn resumes the thread instead of starting a new one", async () => {
  const { createClient, calls } = fakeClientFactory(OK_TURN);
  const sdk = createCodexSdk({ authMode: "account" }, { createClient, home: "/tmp/irida-codex-test" });
  const agent = await createSession(sdk, { apiKey: "", model: "gpt-test", cwd: "/tmp" });
  await (await sendAgentTurn(agent, "first", "gpt-test")).wait();
  await (await sendAgentTurn(agent, "second", "gpt-test")).wait();

  assert.equal(calls.started.length, 1);
  assert.deepEqual(calls.resumed.map((r) => r.id), ["th_live_1"]);
});

test("resume() reconnects a stored thread in the session's cwd", async () => {
  const { createClient, calls } = fakeClientFactory(OK_TURN);
  const sdk = createCodexSdk({ authMode: "account" }, { createClient, home: "/tmp/irida-codex-test" });
  const agent = await resumeSession(sdk, "th_stored", "", undefined, "gpt-test", "/tmp/session-cwd");
  await (await sendAgentTurn(agent, "continue", "gpt-test")).wait();

  assert.equal(calls.started.length, 0);
  assert.equal(calls.resumed[0]?.id, "th_stored");
  assert.equal(calls.resumed[0]?.options?.workingDirectory, "/tmp/session-cwd");
});

test("a failed turn reports status error with the CLI's detail", async () => {
  const { createClient } = fakeClientFactory([
    { type: "thread.started", thread_id: "th_err" },
    { type: "turn.failed", error: { message: "429 rate limit exceeded" } },
  ]);
  const sdk = createCodexSdk({ authMode: "account" }, { createClient, home: "/tmp/irida-codex-test" });
  const agent = await createSession(sdk, { apiKey: "", model: "gpt-test", cwd: "/tmp" });
  const run = await sendAgentTurn(agent, "hi", "gpt-test");
  await consumeRunStream(run, () => {});
  const res = await run.wait();

  assert.equal(res.status, "error");
  assert.match(res.error ?? "", /429 rate limit/);
});

test("one-shot run returns the final text with usage", async () => {
  const { createClient, calls } = fakeClientFactory(OK_TURN);
  const sdk = createCodexSdk({ authMode: "account" }, { createClient, home: "/tmp/irida-codex-test" });
  const out = await runOneShot(sdk, {
    prompt: "summarize",
    apiKey: "",
    model: "gpt-test",
    cwd: "/tmp",
    mcpServers: { srv: { command: "node", args: ["s.js"] } },
  });

  assert.equal(out.status, "finished");
  assert.equal(out.text, "done.");
  assert.equal(out.agentId, "th_live_1");
  assert.equal(out.usage?.inputTokens, 6_497);
  // Irida's MCP servers reach the CLI as config overrides.
  const cfg = calls.options[0]?.config as { mcp_servers?: Record<string, unknown> };
  assert.deepEqual(cfg.mcp_servers?.srv, { command: "node", args: ["s.js"] });
});

test("cancelling a turn aborts the CLI run", async () => {
  const { createClient, calls } = fakeClientFactory(OK_TURN);
  const sdk = createCodexSdk({ authMode: "account" }, { createClient, home: "/tmp/irida-codex-test" });
  const agent = await createSession(sdk, { apiKey: "", model: "gpt-test", cwd: "/tmp" });
  const run = await sendAgentTurn(agent, "hi", "gpt-test");
  await run.cancel?.();
  assert.equal(calls.signals[0]?.aborted, true);
});

// ── config surface ───────────────────────────────────────────────────────────

test("openai/gpt aliases resolve to the codex provider", () => {
  for (const alias of ["codex", "openai", "OpenAI", "oai", "gpt"]) {
    assert.equal(normalizeEngineProvider(alias), "codex", alias);
  }
  assert.equal(normalizeEngineProvider("claude"), "claude-agent");
  assert.equal(normalizeEngineProvider("cursor"), "cursor");
  assert.equal(normalizeEngineProvider("gemini"), null);
});

test("codex defaults to account auth, claude-agent to api-key", () => {
  assert.equal(resolveEngineAuth({ provider: "codex" }), "account");
  assert.equal(resolveEngineAuth({ provider: "codex", auth: "api-key" }), "api-key");
  assert.equal(resolveEngineAuth({ provider: "claude-agent" }), "api-key");
  assert.equal(resolveEngineAuth({ provider: "cursor" }), "api-key");
});

test("the default codex model is Irida's own, not the operator's config", () => {
  assert.equal(typeof DEFAULT_CODEX_MODEL, "string");
  assert.ok(DEFAULT_CODEX_MODEL.length > 0);
});
