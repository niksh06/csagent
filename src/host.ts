/**
 * AgentHost (one-shot slice): thin wrapper over the Cursor SDK so commands and
 * tests share one execution path. The SDK dependency is injectable so tests run
 * without network or a real API key.
 *
 * Failure model (ADR-0001):
 *   - thrown error      -> StartupError (auth/config/network; nothing executed)
 *   - status === error  -> executed run that failed mid-flight
 *   - status finished   -> success
 */
export interface SdkPromptResult {
  status: string;
  result?: string;
  id?: string;
  agentId?: string;
  /** Token usage for cost/metrics (I-116); best-effort, engine-dependent. */
  usage?: StreamUsage;
}

export type McpServers = Record<string, unknown>;

export interface SdkLike {
  prompt(
    message: string,
    opts: {
      apiKey: string;
      model: { id: string };
      local: { cwd: string };
      mcpServers?: McpServers;
      /** Tool names blocked for this run (e.g. read-only proposer in I-98). */
      disallowedTools?: string[];
    }
  ): Promise<SdkPromptResult>;
}

export interface OneShotResult {
  status: string;
  text: string;
  runId: string | null;
  agentId: string | null;
  /** Token usage for cost/metrics (I-116); best-effort, engine-dependent. */
  usage?: StreamUsage;
}

export class StartupError extends Error {}

// ── Interactive session shapes (issue 009) ───────────────────────────────
export interface RunLike {
  stream?(): AsyncIterable<unknown>;
  /** Request cancellation of an in-flight run when the engine supports it. */
  cancel?: () => Promise<void> | void;
  /** `error` carries the failure detail when status === "error" (read via pickRunErrorDetail). */
  wait(): Promise<{ status: string; id?: string; error?: string }>;
}

export interface AgentSendOptions {
  model?: { id: string };
  /** SDK InteractionUpdate callback — turn-ended carries token usage (not in run.stream()). */
  onDelta?: (args: { update: unknown }) => void | Promise<void>;
}

export interface AgentLike {
  agentId?: string;
  send(message: string, options?: AgentSendOptions): Promise<RunLike> | RunLike;
  close?(): Promise<void> | void;
  [Symbol.asyncDispose]?(): Promise<void>;
}

export interface SdkCreateLike {
  create(opts: {
    apiKey: string;
    model: { id: string };
    local: { cwd: string };
    mcpServers?: McpServers;
  }): Promise<AgentLike> | AgentLike;
}

/** Extract assistant text from a streamed SDK event (best-effort, shape-tolerant). */
export function eventText(ev: unknown): string {
  const e = ev as { type?: string; message?: { content?: unknown }; text?: string };
  const t = e?.type ?? "";
  if (t === "tool_call" || t === "toolCall" || t === "tool_result" || t === "thinking" || t === "status") {
    return "";
  }
  if (e?.type === "assistant" && Array.isArray(e.message?.content)) {
    return (e.message.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  }
  if (e?.type === "text" && typeof e.text === "string") return e.text;
  return "";
}

/** Extract thinking/reasoning text from stream events (best-effort). */
export function eventThinkingText(ev: unknown): string {
  const e = ev as {
    type?: string;
    text?: string;
    delta?: string;
    thinking?: string;
    message?: { content?: unknown };
  };
  if (e?.type === "thinking") {
    if (typeof e.text === "string") return e.text;
    if (typeof e.thinking === "string") return e.thinking;
  }
  if (e?.type === "thinking_delta") {
    if (typeof e.delta === "string") return e.delta;
    if (typeof e.text === "string") return e.text;
  }
  if (e?.type === "assistant" && Array.isArray(e.message?.content)) {
    // Anthropic thinking blocks carry the text in `thinking`, not `text` —
    // matching only `text` dropped the claude-agent thinking stream (H-10).
    return (e.message.content as Array<{ type?: string; text?: string; thinking?: string }>)
      .filter((b) => b.type === "thinking" && (typeof b.text === "string" || typeof b.thinking === "string"))
      .map((b) => (b.text ?? b.thinking) as string)
      .join("");
  }
  return "";
}

export interface ActivityDetail {
  label: string;
  kind: "tool" | "mcp" | "other";
  toolName?: string;
  command?: string;
  status?: "running" | "completed" | "error";
  phase?: "call" | "result";
  callId?: string;
  detail?: string;
  exitCode?: number;
  durationMs?: number;
  stdoutPreview?: string;
}

export interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Tokens served from cache (cheap, ~0.1× input). */
  cacheReadTokens?: number;
  /** Tokens written to the cache this turn (1.25× input for the 5m TTL). */
  cacheCreationTokens?: number;
}

/** Extract token usage from SDK stream events or InteractionUpdate (best-effort). */
export function parseStreamUsage(ev: unknown): StreamUsage | null {
  if (ev == null || typeof ev !== "object") return null;
  const e = ev as Record<string, unknown>;
  if (e.type === "sdk_message" && isRecord(e.message)) {
    const inner = parseStreamUsage(e.message);
    if (inner) return inner;
  }
  const t = String(e.type ?? "");
  if (t === "turn-ended" && isRecord(e.usage)) {
    return extractUsage(e.usage as Record<string, unknown>);
  }
  if (t === "usage" || t === "token_usage" || t === "tokens") {
    return extractUsage(e);
  }
  if (t === "assistant" && isRecord(e.message)) {
    const msg = e.message as Record<string, unknown>;
    if (isRecord(msg.usage)) return extractUsage(msg.usage as Record<string, unknown>);
  }
  if (isRecord(e.usage)) return extractUsage(e.usage as Record<string, unknown>);
  return null;
}

function extractUsage(o: Record<string, unknown>): StreamUsage | null {
  const input =
    num(o.input_tokens) ?? num(o.inputTokens) ?? num(o.prompt_tokens) ?? num(o.promptTokens);
  const output =
    num(o.output_tokens) ?? num(o.outputTokens) ?? num(o.completion_tokens) ?? num(o.completionTokens);
  const total = num(o.total_tokens) ?? num(o.totalTokens);
  const cacheRead = num(o.cache_read_input_tokens) ?? num(o.cacheReadInputTokens);
  const cacheCreation = num(o.cache_creation_input_tokens) ?? num(o.cacheCreationInputTokens);
  if (input == null && output == null && total == null && cacheRead == null && cacheCreation == null) {
    return null;
  }
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
  };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export { parseToolStreamEvent, eventActivity, eventActivityDetail } from "./toolFormat.js";

export async function createSession(
  sdk: SdkCreateLike,
  args: { apiKey: string; model: string; cwd: string; mcpServers?: McpServers }
): Promise<AgentLike> {
  try {
    return await sdk.create({
      apiKey: args.apiKey,
      model: { id: args.model },
      local: { cwd: args.cwd },
      ...(args.mcpServers && Object.keys(args.mcpServers).length ? { mcpServers: args.mcpServers } : {}),
    });
  } catch (e) {
    throw new StartupError((e as Error)?.message ?? String(e));
  }
}

export interface SdkResumeLike {
  resume(
    agentId: string,
    opts: { apiKey: string; model?: { id: string }; mcpServers?: McpServers; cwd?: string }
  ): Promise<AgentLike> | AgentLike;
}

export async function resumeSession(
  sdk: SdkResumeLike,
  agentId: string,
  apiKey: string,
  mcpServers?: McpServers,
  model?: string,
  cwd?: string
): Promise<AgentLike> {
  try {
    return await sdk.resume(agentId, {
      apiKey,
      ...(model?.trim() ? { model: { id: model.trim() } } : {}),
      ...(mcpServers && Object.keys(mcpServers).length ? { mcpServers } : {}),
      // H-10: tools of a resumed session must run where the session ran, not
      // wherever the resuming process happens to sit.
      ...(cwd?.trim() ? { cwd: cwd.trim() } : {}),
    });
  } catch (e) {
    throw new StartupError((e as Error)?.message ?? String(e));
  }
}

export interface SendAgentTurnOptions {
  onDelta?: AgentSendOptions["onDelta"];
}

/** Local SDK agents need model on each send after live resume. */
export async function sendAgentTurn(
  agent: AgentLike,
  message: string,
  model: string,
  opts?: SendAgentTurnOptions
): Promise<RunLike> {
  const sendOpts: AgentSendOptions = { model: { id: model.trim() } };
  if (opts?.onDelta) sendOpts.onDelta = opts.onDelta;
  const run = agent.send(message, sendOpts);
  return run instanceof Promise ? run : Promise.resolve(run);
}

export async function disposeAgent(agent: AgentLike): Promise<void> {
  try {
    if (typeof agent[Symbol.asyncDispose] === "function") {
      await agent[Symbol.asyncDispose]!();
    } else if (typeof agent.close === "function") {
      await agent.close();
    }
  } catch {
    // disposal best-effort
  }
}

export async function runOneShot(
  sdk: SdkLike,
  args: {
    prompt: string;
    apiKey: string;
    model: string;
    cwd: string;
    mcpServers?: McpServers;
    disallowedTools?: string[];
  }
): Promise<OneShotResult> {
  let res: SdkPromptResult;
  try {
    res = await sdk.prompt(args.prompt, {
      apiKey: args.apiKey,
      model: { id: args.model },
      local: { cwd: args.cwd },
      ...(args.mcpServers && Object.keys(args.mcpServers).length ? { mcpServers: args.mcpServers } : {}),
      ...(args.disallowedTools?.length ? { disallowedTools: args.disallowedTools } : {}),
    });
  } catch (e) {
    throw new StartupError((e as Error)?.message ?? String(e));
  }
  return {
    status: String(res.status),
    text: String(res.result ?? ""),
    runId: res.id ?? null,
    agentId: res.agentId ?? null,
    usage: res.usage,
  };
}
