/**
 * Codex engine adapter (Irida / I-144).
 *
 * Wraps `@openai/codex-sdk` behind the same interfaces the Cursor and Claude
 * Agent SDKs satisfy (SdkLike for one-shot `run`; SdkCreateLike + SdkResumeLike
 * + AgentLike for interactive `chat`/`resume`), so all surfaces share one path.
 * Codex is a full agent runtime — its own loop, shell/file tools, MCP — so this
 * is a third engine, not a completion fallback.
 *
 * Auth (two modes, per engine.auth):
 *  - "account" (default): the ChatGPT subscription session the Codex CLI keeps
 *    in ~/.codex/auth.json. No API key and no per-token billing.
 *  - "api-key": OPENAI_API_KEY, handed to the CLI as CODEX_API_KEY.
 *
 * Session identity: the Codex thread id is our `agentId`. `resumeThread()`
 * restores real server-side context, so a resumed Irida session keeps the
 * model's own history instead of replaying a transcript stub.
 */
import type {
  SdkLike,
  SdkPromptResult,
  SdkCreateLike,
  SdkResumeLike,
  AgentLike,
  RunLike,
  McpServers,
  AgentSendOptions,
  StreamUsage,
} from "../host.js";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { iridaHome } from "../env.js";
import type { EngineAuth } from "../config.js";
import { DEFAULT_CODEX_MODEL } from "../config.js";
import type { EngineToolPolicy } from "./claudeAgentSdk.js";

export type CodexSdk = SdkLike & SdkCreateLike & SdkResumeLike;

/** One `codex exec` JSONL event. Read structurally — unknown shapes are no-ops. */
type CodexEvent = Record<string, unknown>;

interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(
    input: string,
    turnOptions?: { signal?: AbortSignal }
  ): Promise<{ events: AsyncIterable<CodexEvent> }>;
}

interface CodexClientLike {
  startThread(options?: Record<string, unknown>): CodexThreadLike;
  resumeThread(id: string, options?: Record<string, unknown>): CodexThreadLike;
}

interface CodexClientOptions {
  apiKey?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
  codexPathOverride?: string;
}

// ── Operator-environment isolation ───────────────────────────────────────────

/**
 * Home directory the Codex CLI reads for THIS agent's config, MCP servers and
 * thread history.
 *
 * The CLI's default (`~/.codex`) is the operator's personal one, and it is not
 * overridable per-run: `--config mcp_servers={}` does NOT clear an inherited
 * table (measured 2026-07-31 — all 9 of the operator's servers survived the
 * override, including a browser-control `node_repl` and `computer-use`). The
 * only isolation the CLI honors is CODEX_HOME.
 *
 * This is the same failure the claude-agent adapter fixed with
 * `settingSources: ["project"]`: what an Irida agent gets must be Irida's
 * decision, declared in `mcpServers`, not a side effect of whose machine it
 * runs on. Irida's home holds no config.toml at all — CLI defaults plus the
 * per-thread options below — and keeps its own `sessions/`, so Irida threads
 * never mix with the operator's interactive Codex history.
 */
export function iridaCodexHome(): string {
  const base = iridaHome() ?? resolvePath(homedir(), ".irida");
  return resolvePath(base, "codex-home");
}

/** The operator's real Codex credential — the one `codex login` refreshes. */
export function operatorCodexAuthPath(): string {
  return resolvePath(homedir(), ".codex", "auth.json");
}

/**
 * Point Irida's isolated CODEX_HOME at the operator's credential by symlink,
 * repairing the link if it is missing or stale.
 *
 * A symlink rather than a copy on purpose: the ChatGPT session refreshes on a
 * rotating refresh token, so two independent copies would each rotate and
 * eventually log the other out. One file, one refresher.
 *
 * Best-effort: a failure here is not fatal (an api-key run needs no session,
 * and account mode fails later with the CLI's own "not logged in", which the
 * auth classifier already recognizes).
 */
export function ensureCodexHome(
  home: string = iridaCodexHome(),
  authTarget: string = operatorCodexAuthPath()
): { home: string; linked: boolean } {
  try {
    mkdirSync(home, { recursive: true });
    const link = resolvePath(home, "auth.json");
    let current: string | null = null;
    try {
      const st = lstatSync(link);
      current = st.isSymbolicLink() ? readlinkSync(link) : "";
    } catch {
      current = null; // absent
    }
    if (current === authTarget) return { home, linked: true };
    // A plain file here means an earlier refresh replaced the link; drop it
    // rather than let a frozen copy of the credential drift.
    if (current !== null) unlinkSync(link);
    symlinkSync(authTarget, link);
    return { home, linked: true };
  } catch {
    return { home, linked: false };
  }
}

// ── Pure mappers (unit-tested) ───────────────────────────────────────────────

/** Raw `turn.completed` usage payload. */
export interface CodexUsageRaw {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/**
 * Codex reports `input_tokens` INCLUSIVE of `cached_input_tokens` (OpenAI's
 * convention), while our cost model bills the two at different rates and sums
 * them. Subtract, or every cached token is charged twice — once at full price
 * and again at the cache rate. Reasoning tokens are already part of
 * `output_tokens`, so they are not added either.
 */
export function mapCodexUsage(raw: CodexUsageRaw | null | undefined): StreamUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const input = num(raw.input_tokens);
  const cached = num(raw.cached_input_tokens);
  const output = num(raw.output_tokens);
  const cacheWrite = num(raw.cache_write_input_tokens);
  if (input == null && output == null && cached == null && cacheWrite == null) return null;
  const uncached = input == null ? undefined : Math.max(0, input - (cached ?? 0));
  return {
    ...(uncached !== undefined ? { inputTokens: uncached } : {}),
    ...(output != null ? { outputTokens: output } : {}),
    ...(cached != null ? { cacheReadTokens: cached } : {}),
    ...(cacheWrite != null ? { cacheCreationTokens: cacheWrite } : {}),
  };
}

/** StreamUsage → the snake-cased shape `parseStreamUsage` reads off the stream. */
export function usageStreamEvent(u: StreamUsage): Record<string, unknown> {
  return {
    type: "usage",
    ...(u.inputTokens !== undefined ? { input_tokens: u.inputTokens } : {}),
    ...(u.outputTokens !== undefined ? { output_tokens: u.outputTokens } : {}),
    ...(u.cacheReadTokens !== undefined ? { cache_read_input_tokens: u.cacheReadTokens } : {}),
    ...(u.cacheCreationTokens !== undefined
      ? { cache_creation_input_tokens: u.cacheCreationTokens }
      : {}),
  };
}

/** Codex item type → the tool name our activity formatter renders. */
const TOOL_ITEM_NAME: Record<string, string> = {
  command_execution: "shell",
  file_change: "apply_patch",
  web_search: "web_search",
};

function toolName(item: Record<string, unknown>): string | null {
  const t = String(item.type ?? "");
  if (t === "mcp_tool_call") {
    return `mcp__${String(item.server ?? "?")}__${String(item.tool ?? "?")}`;
  }
  return TOOL_ITEM_NAME[t] ?? null;
}

/** Tool arguments shaped so `formatToolInvocation` renders a readable line. */
function toolArgs(item: Record<string, unknown>): Record<string, unknown> {
  const t = String(item.type ?? "");
  if (t === "command_execution") return { command: String(item.command ?? "") };
  if (t === "web_search") return { query: String(item.query ?? "") };
  if (t === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const summary = changes
      .map((c) => {
        const r = isRecord(c) ? c : {};
        return `${String(r.kind ?? "update")} ${String(r.path ?? "?")}`;
      })
      .join(", ");
    return { command: `apply_patch ${summary || "(no changes reported)"}` };
  }
  if (t === "mcp_tool_call") {
    return isRecord(item.arguments) ? item.arguments : { input: item.arguments };
  }
  return {};
}

/** Terminal payload shaped for `parseToolResult` (exit code + stdout preview). */
function toolResult(item: Record<string, unknown>): Record<string, unknown> {
  const t = String(item.type ?? "");
  if (t === "command_execution") {
    const exit = num(item.exit_code);
    return {
      exit_code: exit ?? (item.status === "failed" ? 1 : 0),
      ...(typeof item.aggregated_output === "string" ? { stdout: item.aggregated_output } : {}),
    };
  }
  if (t === "mcp_tool_call") {
    const err = isRecord(item.error) ? String(item.error.message ?? "") : "";
    return { exit_code: err ? 1 : 0, ...(err ? { output: err } : {}) };
  }
  return { exit_code: item.status === "failed" ? 1 : 0 };
}

function toolStatus(item: Record<string, unknown>): "completed" | "error" {
  const s = String(item.status ?? "");
  if (s === "failed") return "error";
  if (String(item.type) === "command_execution") {
    const exit = num(item.exit_code);
    if (exit != null && exit !== 0) return "error";
  }
  if (String(item.type) === "mcp_tool_call" && isRecord(item.error)) return "error";
  return "completed";
}

/**
 * Translate one Codex `ThreadEvent` into zero or more host stream events
 * (`text` / `thinking` / `tool_call` / `usage`), the vocabulary `eventText`,
 * `eventThinkingText`, `parseToolStreamEvent` and `parseStreamUsage` already
 * speak.
 *
 * Stateful by necessity: a tool has to be seen once as a `call` (that is what
 * the turn's tool counter and the UI spinner key off) and once as a `result`,
 * but Codex does not guarantee an `item.started` — a fast command can surface
 * only as `item.completed` (observed on the live probe, where every item
 * arrived already terminal). Tracking the ids we have announced lets a
 * completion synthesize the missing call instead of the turn reporting zero
 * tools, without double-counting when `item.started` did arrive.
 */
export function createCodexEventMapper(): (ev: CodexEvent) => Record<string, unknown>[] {
  const announced = new Set<string>();
  let sawAgentMessage = false;
  return (ev: CodexEvent): Record<string, unknown>[] => {
    if (!isRecord(ev)) return [];
    const type = String(ev.type ?? "");

    if (type === "turn.completed") {
      const usage = mapCodexUsage(ev.usage as CodexUsageRaw | undefined);
      return usage ? [usageStreamEvent(usage)] : [];
    }

    if (type !== "item.started" && type !== "item.completed") return [];
    const item = isRecord(ev.item) ? ev.item : null;
    if (!item) return [];
    const itemType = String(item.type ?? "");
    const done = type === "item.completed";

    if (itemType === "agent_message") {
      // Only on completion: Codex emits whole items, so a start-phase copy
      // would duplicate the answer in the transcript.
      if (!done || typeof item.text !== "string" || !item.text) return [];
      // A turn can carry several whole messages ("I'll run the command." then
      // the result). Consumers append deltas verbatim, so without a separator
      // they glue into one run-on line — seen on the first live run.
      const text = sawAgentMessage ? `\n\n${item.text}` : item.text;
      sawAgentMessage = true;
      return [{ type: "text", text }];
    }
    if (itemType === "reasoning") {
      return done && typeof item.text === "string" && item.text
        ? [{ type: "thinking", text: item.text }]
        : [];
    }
    if (itemType === "error") {
      // Non-fatal item-level error: surface it as activity so it is visible,
      // without polluting the assistant's text.
      return [
        {
          type: "tool_call",
          name: "codex_error",
          args: { command: String(item.message ?? "codex error") },
          status: "error",
          result: { exit_code: 1, output: String(item.message ?? "") },
        },
      ];
    }

    const name = toolName(item);
    if (!name) return []; // todo_list and anything unknown: no activity line
    const callId = typeof item.id === "string" ? item.id : undefined;
    const args = toolArgs(item);
    const out: Record<string, unknown>[] = [];

    if (!done) {
      if (callId) announced.add(callId);
      out.push({ type: "tool_call", name, args, status: "running", ...(callId ? { call_id: callId } : {}) });
      return out;
    }

    if (!callId || !announced.has(callId)) {
      out.push({ type: "tool_call", name, args, status: "running", ...(callId ? { call_id: callId } : {}) });
      if (callId) announced.add(callId);
    }
    out.push({
      type: "tool_call",
      name,
      args,
      status: toolStatus(item),
      ...(callId ? { call_id: callId } : {}),
      result: toolResult(item),
    });
    return out;
  };
}

/**
 * Irida MCP entries ({command}|{url}) → the CLI's `mcp_servers` config table.
 * The SDK flattens this object into `--config` dotted paths, so it reaches the
 * CLI as if it had been declared in config.toml — which is how Irida's servers
 * get attached to a home that deliberately declares none of its own.
 */
export function toCodexMcpServers(mcp?: McpServers): Record<string, unknown> | undefined {
  if (!mcp) return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(mcp)) {
    const o = v as { command?: unknown; args?: unknown; env?: unknown; url?: unknown };
    if (typeof o?.command === "string" && o.command.trim()) {
      out[name] = {
        command: o.command,
        ...(Array.isArray(o.args) ? { args: o.args } : {}),
        ...(o.env && typeof o.env === "object" ? { env: o.env } : {}),
      };
    } else if (typeof o?.url === "string" && o.url.trim()) {
      out[name] = { url: o.url };
    }
    // Entries matching neither shape are dropped (the caller's MCP validation logs them).
  }
  return Object.keys(out).length ? out : undefined;
}

/** Our effort scale (I-158) → the CLI's `model_reasoning_effort`. */
export function toCodexEffort(effort?: string): string | undefined {
  const e = (effort ?? "").trim().toLowerCase();
  if (!e) return undefined;
  if (e === "max") return "xhigh"; // codex tops out at xhigh
  if (["minimal", "low", "medium", "high", "xhigh"].includes(e)) return e;
  return undefined;
}

/**
 * Tool policy → Codex sandbox.
 *
 * Codex has no per-call approval callback, so `denyDestructive`'s input regex
 * (I-94/I-117) has no equivalent here — containment is enforced by the OS-level
 * sandbox instead, which is the stronger guarantee of the two. `workspace-write`
 * is the floor for every surface, deliberately stricter than the claude-agent
 * default (`bypassPermissions`): a new engine starts contained. `allowWriteRoots`
 * (I-157) widens it to exactly those roots and nothing else.
 */
export function codexSandboxOptions(policy?: EngineToolPolicy): {
  sandboxMode: string;
  approvalPolicy: string;
  networkAccessEnabled: boolean;
  additionalDirectories?: string[];
} {
  const roots = policy?.allowWriteRoots?.filter((r) => typeof r === "string" && r.trim()) ?? [];
  return {
    sandboxMode: "workspace-write",
    // Headless on every Irida surface: nothing can answer an approval prompt,
    // and an unanswered one would hang the turn until the run timed out.
    approvalPolicy: "never",
    // workspace-write disables network by default; Irida agents fetch and call APIs.
    networkAccessEnabled: true,
    ...(roots.length ? { additionalDirectories: roots } : {}),
  };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Engine ───────────────────────────────────────────────────────────────────

async function defaultCreateClient(options: CodexClientOptions): Promise<CodexClientLike> {
  const { Codex } = await import("@openai/codex-sdk");
  return new Codex(options as ConstructorParameters<typeof Codex>[0]) as unknown as CodexClientLike;
}

/**
 * Environment for the CLI subprocess. The SDK does NOT inherit process.env when
 * `env` is given, so the parent environment is passed through explicitly and
 * only the credential-relevant keys are overridden.
 */
export function codexEnv(authMode: EngineAuth, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.CODEX_HOME = home;
  if (authMode === "account") {
    // An API key would take precedence over the subscription session.
    delete env.CODEX_API_KEY;
    delete env.OPENAI_API_KEY;
  }
  return env;
}

export function createCodexSdk(
  opts?: { authMode?: EngineAuth; toolPolicy?: EngineToolPolicy },
  deps: { createClient?: (options: CodexClientOptions) => Promise<CodexClientLike>; home?: string } = {}
): CodexSdk {
  const authMode: EngineAuth = opts?.authMode ?? "account";
  const policy = opts?.toolPolicy;
  const createClient = deps.createClient ?? defaultCreateClient;
  const home = deps.home ?? iridaCodexHome();

  const reasoningEffort = toCodexEffort(policy?.effort);

  const threadOptions = (model: string, cwd: string): Record<string, unknown> => ({
    model,
    workingDirectory: cwd,
    // Cron and delegate runs happen in arbitrary directories, not only repos.
    skipGitRepoCheck: true,
    ...codexSandboxOptions(policy),
    ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
  });

  const clientOptions = (apiKey: string, mcpServers?: Record<string, unknown>): CodexClientOptions => {
    ensureCodexHome(home);
    return {
      ...(authMode === "api-key" && apiKey ? { apiKey } : {}),
      env: codexEnv(authMode, home),
      ...(mcpServers ? { config: { mcp_servers: mcpServers } } : {}),
      ...(process.env.IRIDA_CODEX_PATH ? { codexPathOverride: process.env.IRIDA_CODEX_PATH } : {}),
    };
  };

  /** Interactive agent handle: one Codex thread, resumed across turns. */
  function makeAgent(init: {
    model: string;
    cwd: string;
    apiKey: string;
    mcpServers?: Record<string, unknown>;
    threadId?: string;
  }): AgentLike {
    let threadId = init.threadId;
    let agentClosed = false;
    const activeAborts = new Set<AbortController>();

    const agent: AgentLike = {
      agentId: threadId,
      async send(message: string, sendOpts?: AgentSendOptions): Promise<RunLike> {
        if (agentClosed) throw new Error("agent is closed");
        const model = sendOpts?.model?.id?.trim() || init.model;
        const client = await createClient(clientOptions(init.apiKey, init.mcpServers));
        const thread = threadId
          ? client.resumeThread(threadId, threadOptions(model, init.cwd))
          : client.startThread(threadOptions(model, init.cwd));

        const abort = new AbortController();
        activeAborts.add(abort);
        const { events } = await thread.runStreamed(message, { signal: abort.signal });
        if (agentClosed) {
          abort.abort();
          throw new Error("agent is closed");
        }

        const mapEvent = createCodexEventMapper();
        const out: Record<string, unknown>[] = [];
        let status = "finished";
        let errorDetail: string | undefined;
        let completed = false;
        let pumpFailed = false;
        let pumpError: unknown;
        let streamClaimed = false;
        let resolveStream: (() => void) | undefined;
        let cancelPromise: Promise<void> | undefined;

        const wakeStream = () => {
          const resolve = resolveStream;
          resolveStream = undefined;
          resolve?.();
        };

        const pump = async () => {
          try {
            for await (const ev of events) {
              await sendOpts?.onDelta?.({ update: ev });
              const t = String((ev as CodexEvent)?.type ?? "");
              if (t === "thread.started" && typeof (ev as CodexEvent).thread_id === "string") {
                threadId = (ev as CodexEvent).thread_id as string;
                agent.agentId = threadId;
              }
              if (t === "turn.failed") {
                status = "error";
                const err = (ev as CodexEvent).error;
                errorDetail = isRecord(err) ? String(err.message ?? "turn failed") : "turn failed";
              }
              if (t === "error") {
                status = "error";
                errorDetail = String((ev as CodexEvent).message ?? "codex stream error");
              }
              for (const mapped of mapEvent(ev as CodexEvent)) out.push(mapped);
              wakeStream();
            }
          } catch (error) {
            pumpFailed = true;
            pumpError = error;
            throw error;
          } finally {
            completed = true;
            activeAborts.delete(abort);
            wakeStream();
          }
        };
        const pumpPromise = pump();
        // wait()/stream() surface this rejection; the eager pump must not create
        // an unhandled rejection before either consumer attaches.
        void pumpPromise.catch(() => {});

        const run: RunLike = {
          async *stream() {
            if (streamClaimed) throw new Error("run stream already consumed");
            streamClaimed = true;
            let index = 0;
            try {
              for (;;) {
                while (index < out.length) yield out[index++]!;
                if (completed) {
                  if (pumpFailed) throw pumpError;
                  return;
                }
                await new Promise<void>((resolve) => (resolveStream = resolve));
              }
            } finally {
              // A caller that stops reading must not orphan the eager pump.
              if (!completed) {
                try {
                  await run.cancel?.();
                } catch {
                  // Stream cleanup is best-effort; preserve the caller's error.
                }
              }
            }
          },
          cancel() {
            if (!cancelPromise) {
              cancelPromise = (async () => {
                if (completed) return;
                abort.abort();
                // The SDK kills the CLI child on abort; wait for the iterator to
                // unwind so the caller knows the run is really over.
                await pumpPromise.then(
                  () => undefined,
                  () => undefined
                );
              })();
            }
            return cancelPromise;
          },
          async wait() {
            await pumpPromise;
            const res: { status: string; id?: string; error?: string } = { status };
            if (threadId) res.id = threadId;
            if (errorDetail) res.error = errorDetail;
            return res;
          },
        };
        return run;
      },
      close() {
        agentClosed = true;
        for (const abort of activeAborts) abort.abort();
        activeAborts.clear();
      },
    };
    return agent;
  }

  return {
    async prompt(message, sdkOpts): Promise<SdkPromptResult> {
      const mcpServers = toCodexMcpServers(sdkOpts.mcpServers);
      const client = await createClient(clientOptions(sdkOpts.apiKey ?? "", mcpServers));
      const thread = client.startThread(threadOptions(sdkOpts.model.id, sdkOpts.local.cwd));
      const { events } = await thread.runStreamed(message);

      const mapEvent = createCodexEventMapper();
      let text = "";
      let usage: StreamUsage | undefined;
      let threadId: string | undefined;
      let isError = false;
      let errorText = "";
      for await (const ev of events) {
        const t = String(ev?.type ?? "");
        if (t === "thread.started" && typeof ev.thread_id === "string") threadId = ev.thread_id;
        if (t === "turn.failed") {
          isError = true;
          errorText = isRecord(ev.error) ? String(ev.error.message ?? "turn failed") : "turn failed";
        }
        if (t === "error") {
          isError = true;
          errorText = String(ev.message ?? "codex stream error");
        }
        for (const mapped of mapEvent(ev)) {
          if (mapped.type === "text" && typeof mapped.text === "string") text += mapped.text;
          if (mapped.type === "usage") {
            const u = mapCodexUsage(ev.usage as CodexUsageRaw | undefined);
            if (u) usage = { ...usage, ...u };
          }
        }
      }
      return {
        status: isError ? "error" : "finished",
        result: isError ? errorText || text : text,
        ...(threadId ? { id: threadId, agentId: threadId } : {}),
        ...(usage ? { usage } : {}),
      };
    },

    create(o) {
      return makeAgent({
        model: o.model.id,
        cwd: o.local.cwd,
        apiKey: o.apiKey,
        mcpServers: toCodexMcpServers(o.mcpServers),
      });
    },

    resume(agentId, o) {
      // Tools of a resumed session must run where the session ran (H-10);
      // process.cwd() is only the legacy fallback.
      return makeAgent({
        model: o.model?.id?.trim() || DEFAULT_CODEX_MODEL,
        cwd: o.cwd?.trim() || process.cwd(),
        apiKey: o.apiKey,
        mcpServers: toCodexMcpServers(o.mcpServers),
        threadId: agentId,
      });
    },
  };
}
