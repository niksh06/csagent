/**
 * Claude Agent SDK engine adapter (Irida / I-100).
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` behind the same interfaces the Cursor
 * SDK satisfies (SdkLike for one-shot `run`; SdkCreateLike + SdkResumeLike +
 * AgentLike for interactive `chat`/`resume`), so all surfaces share one path.
 * The Agent SDK is a full agent runtime (its own loop, tools, MCP) — selecting
 * it is the second engine, not a completion fallback.
 *
 * Auth (two modes, per engine.auth):
 *  - "api-key": Anthropic API key via env ANTHROPIC_API_KEY.
 *  - "account": Claude subscription via env CLAUDE_CODE_OAUTH_TOKEN (from
 *    `claude setup-token`), or — when no token is supplied — an existing
 *    `claude login` session the bundled binary reads from the OS keychain /
 *    ~/.claude/.credentials.json.
 * `engineAuthEnv` gives each SDK query an isolated credential environment.
 *
 * Session identity: the Agent SDK's `session_id` is our `agentId`. We persist it
 * across turns (closure) and pass it as `resume` on the next `query()`.
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
import { resolve as resolvePath, sep } from "node:path";
import { parseStreamUsage } from "../host.js";
import type { EngineAuth } from "../config.js";
import { DEFAULT_CLAUDE_AGENT_MODEL } from "../config.js";
import { destructiveReason } from "../safety.js";

export type ClaudeAgentSdk = SdkLike & SdkCreateLike & SdkResumeLike;

/** Resolved tool-permission policy handed to the engine (I-94). */
export interface EngineToolPolicy {
  /** Deny destructive tool inputs at runtime via `canUseTool`. */
  denyDestructive: boolean;
  /** I-117: rewrite borderline inputs to a safer form instead of allowing as-is (opt-in). */
  sanitizeInput?: boolean;
  /**
   * I-157: when set, file-mutation tools (Write/Edit/MultiEdit/NotebookEdit) are
   * DENIED unless their target path resolves inside one of these roots. Enables
   * path-scoped write envelopes (e.g. the ouroboros yellow tier: an isolated
   * worktree + the agent's own projects dir). Read tools are unaffected.
   */
  allowWriteRoots?: string[];
  /**
   * I-158: reasoning effort for every query of this engine instance
   * (low|medium|high|xhigh|max). Omitted → SDK default.
   */
  effort?: string;
}

type ToolDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; rewrites?: string[] }
  | { behavior: "deny"; message: string };

/**
 * Curated, reversible shell-command hardenings (I-117). Each rule is conservative
 * — it only fires on an unambiguous shape and never changes a command into
 * something surprising in a destructive direction. Returns the (possibly)
 * rewritten command + a human-readable note per rewrite for logging. Pure.
 *
 * NOTE: under the agent's non-interactive Bash, `rm -i` reads EOF → declines, so
 * the rm rule effectively makes a bare `rm` a no-op-unless-forced. That is the
 * intended conservative posture for a surface that opted into sanitization.
 */
export function sanitizeCommand(cmd: string): { command: string; rewrites: string[] } {
  let out = cmd;
  const rewrites: string[] = [];
  // 1. bare `rm <path>` with NO flags → add -i (interactive). Anchored to COMMAND
  //    position (start, or after a `; && || | ( newline` separator) so an `rm`
  //    inside a quoted string or as an argument (e.g. `git commit -m "rm x"`,
  //    `grep rm f`) is NOT touched; global so every rm in a compound is hardened.
  //    Flagged forms (`rm -rf`/`-r`/`-f`) are left untouched / denied upstream.
  const afterRm = out.replace(/(^|[\n;&|(]\s*)rm\s+(?=[^-\s])/g, "$1rm -i ");
  if (afterRm !== out) {
    out = afterRm;
    rewrites.push("rm → rm -i (interactive; non-interactive shell ⇒ declines)");
  }
  // 2. strip --no-verify (re-enable git hooks).
  if (/--no-verify\b/.test(out)) {
    out = out.replace(/\s*--no-verify\b/g, "");
    rewrites.push("stripped --no-verify (git hooks re-enabled)");
  }
  // NOTE: `git push --force` is NOT rewritten here — it stays hard-DENIED by the
  // safety denylist (stronger than a rewrite, and the deny gate runs first / even
  // when sanitize is off). The safe `--force-with-lease` is allowed directly
  // (the denylist lookahead was widened in I-117 so it no longer blocks it).
  return { command: out, rewrites };
}

/**
 * Vet a single tool call's input for a destructive shell pattern (I-94). Scans
 * every string field (the Bash `command`, an Edit path, …) with the shared
 * `safety.ts` denylist. Pure + exported for unit tests; the SDK `canUseTool`
 * callback is a thin async wrapper over this.
 *
 * The allow branch MUST echo the tool input back as `updatedInput`: the Agent
 * SDK validates the PermissionResult with a Zod schema that requires
 * `updatedInput` to be a record for `behavior: "allow"` (the TS type marks it
 * optional, but the runtime rejects `undefined` — every approval-gated tool
 * (Write/Edit/curl/WebFetch/non-preapproved Bash) fails with a union ZodError
 * otherwise, which silently breaks the whole gated agent).
 */
export function evaluateToolInput(
  input: Record<string, unknown>,
  opts?: { sanitize?: boolean }
): ToolDecision {
  for (const v of Object.values(input)) {
    if (typeof v !== "string") continue;
    const hit = destructiveReason(v);
    if (hit) {
      return { behavior: "deny", message: `irida tool-policy: blocked destructive tool input (${hit})` };
    }
  }
  // I-117: not destructive — optionally rewrite a borderline shell command to a
  // safer form (the Bash `command` field) instead of allowing it verbatim.
  if (opts?.sanitize && typeof input.command === "string") {
    const { command, rewrites } = sanitizeCommand(input.command);
    if (rewrites.length) {
      // Defense-in-depth: never hand back a rewritten command that itself trips
      // the denylist (current rules can't, but this keeps future rules honest).
      const hit = destructiveReason(command);
      if (hit) {
        return { behavior: "deny", message: `irida tool-policy: blocked destructive tool input (${hit})` };
      }
      return { behavior: "allow", updatedInput: { ...input, command }, rewrites };
    }
  }
  return { behavior: "allow", updatedInput: input };
}

/**
 * Steer message for the built-in interactive ask tool (I-125). In a headless
 * gateway run there is no UI to render AskUserQuestion, so the SDK auto-resolves
 * it — the agent gets an empty answer and silently proceeds on a guess (the
 * user's "the question expired and it kept going" symptom). We deny it and point
 * the agent at the durable `ask_user` MCP tool, which parks the turn instead.
 */
export const ASK_USER_STEER_MESSAGE =
  "BLOCKED: AskUserQuestion does not work on this surface. Do NOT tell the user you can't ask a " +
  "question, and do NOT guess. Instead, immediately call the `ask_user` tool with your question — " +
  "it delivers the question to the user and pauses the turn until they reply.";

/**
 * I-125: intercept the built-in interactive question tool by name. Returns a
 * deny decision steering to `ask_user`, or null for any other tool (which then
 * flows through the normal destructive-input gate). Pure + exported for tests.
 */
export function interceptInteractiveAsk(toolName: string): ToolDecision | null {
  if (toolName === "AskUserQuestion") {
    return { behavior: "deny", message: ASK_USER_STEER_MESSAGE };
  }
  return null;
}

/** Path field per file-mutation tool the write-roots gate covers (I-157). */
const WRITE_TOOL_PATH_FIELD: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** Is `p` equal to or inside `root`? Both must already be absolute-resolved. */
function isInsideRoot(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * I-157: vet a file-mutation tool call against the allowed write roots. Returns
 * a human-readable violation, or null when the call is fine (non-mutation tool,
 * or path inside a root). Fail-closed: a mutation tool whose path is missing or
 * non-string is a violation — an unverifiable write is not allowed through.
 * Pure + exported for unit tests.
 */
export function writeRootsViolation(
  toolName: string,
  input: Record<string, unknown>,
  roots: string[],
  cwd: string = process.cwd()
): string | null {
  const field = WRITE_TOOL_PATH_FIELD[toolName];
  if (!field) return null; // not a path-gated mutation tool
  const raw = input[field];
  if (typeof raw !== "string" || !raw.trim()) {
    return `${toolName} without a verifiable ${field} is not allowed under a write-roots policy`;
  }
  const target = resolvePath(cwd, raw.trim());
  for (const root of roots) {
    if (isInsideRoot(target, resolvePath(cwd, root))) return null;
  }
  return `${toolName} target ${target} is outside the allowed write roots (${roots.join(", ")})`;
}

/**
 * Build the complete subprocess environment for one Agent SDK query. Passing
 * credentials through query options avoids mutating process.env while parallel
 * gateway turns are streaming. `secret` may be empty in account mode → inherit
 * an existing OAuth token or rely on the `claude login` session.
 */
export function engineAuthEnv(authMode: EngineAuth, secret: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (authMode === "account") {
    // API key would take precedence over account auth — clear it for this call.
    delete env.ANTHROPIC_API_KEY;
    if (secret) env.CLAUDE_CODE_OAUTH_TOKEN = secret;
    // empty secret → leave any inherited token / fall back to `claude login`.
  } else {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    if (secret) env.ANTHROPIC_API_KEY = secret;
  }
  return env;
}

/** Map irida MCP entries ({command}|{url}) to Agent SDK McpServerConfig. */
export function toAgentMcpServers(mcp?: McpServers): Record<string, unknown> | undefined {
  if (!mcp) return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(mcp)) {
    const o = v as { command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown };
    if (typeof o?.command === "string" && o.command.trim()) {
      out[name] = {
        type: "stdio",
        command: o.command,
        ...(Array.isArray(o.args) ? { args: o.args } : {}),
        ...(o.env && typeof o.env === "object" ? { env: o.env } : {}),
      };
    } else if (typeof o?.url === "string" && o.url.trim()) {
      out[name] = { type: "http", url: o.url, ...(o.headers && typeof o.headers === "object" ? { headers: o.headers } : {}) };
    }
    // Entries matching neither shape are dropped (logged by the caller's MCP validation).
  }
  return Object.keys(out).length ? out : undefined;
}

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: Record<string, unknown>
) => Promise<ToolDecision>;

type QueryOptions = {
  model: string;
  cwd: string;
  permissionMode: string;
  env?: NodeJS.ProcessEnv;
  canUseTool?: CanUseTool;
  mcpServers?: Record<string, unknown>;
  resume?: string;
  disallowedTools?: string[];
  /** I-158: reasoning effort for the run (SDK: low|medium|high|xhigh|max). */
  effort?: string;
};

/**
 * Permission options for a `query()` call (I-94). Gate OFF → keep the prior
 * `bypassPermissions` (no behavior change). Gate ON (denyDestructive,
 * allowWriteRoots, or gateway ask steer) → `default` mode so the SDK routes tool
 * calls through `canUseTool`: ask steer, write-roots containment (fail-closed),
 * then the destructive-input gate. The callback survives `resume`.
 */
function permissionOptions(
  denyDestructive: boolean,
  sanitizeInput = false,
  allowWriteRoots?: string[],
  cwd: string = process.cwd(),
  steerInteractiveAsk = false
): Pick<QueryOptions, "permissionMode" | "canUseTool"> {
  const roots = allowWriteRoots?.filter((r) => typeof r === "string" && r.trim()) ?? [];
  if (!denyDestructive && !roots.length && !steerInteractiveAsk) {
    return { permissionMode: "bypassPermissions" };
  }
  return {
    permissionMode: "default",
    canUseTool: async (toolName, input) => {
      // I-125: deny the headless-broken interactive ask, steer to `ask_user`.
      const steer = steerInteractiveAsk ? interceptInteractiveAsk(toolName) : null;
      if (steer) {
        console.error(`[tool-policy] deny ${toolName}: steer to ask_user (I-125)`);
        return steer;
      }
      // I-157: path-scoped write envelope.
      if (roots.length) {
        const violation = writeRootsViolation(toolName, input, roots, cwd);
        if (violation) {
          console.error(`[tool-policy] deny ${toolName}: ${violation}`);
          return { behavior: "deny", message: `irida tool-policy: ${violation}` };
        }
      }
      if (!denyDestructive) return { behavior: "allow", updatedInput: input };
      const decision = evaluateToolInput(input, { sanitize: sanitizeInput });
      // Both land in stderr → gateway.error.log for the autonomous surfaces.
      if (decision.behavior === "deny") {
        console.error(`[tool-policy] deny ${toolName}: ${decision.message}`);
      } else if (decision.rewrites?.length) {
        console.error(`[tool-policy] rewrote ${toolName}: ${decision.rewrites.join("; ")}`);
      }
      return decision;
    },
  };
}

type ClaudeQuery = AsyncIterable<Record<string, unknown>> & {
  interrupt?(): Promise<void>;
  close?(): void;
};

const CLAUDE_CANCEL_GRACE_MS = 1_000;

async function startQuery(message: string, options: QueryOptions): Promise<ClaudeQuery> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  return query({ prompt: message, options } as Parameters<typeof query>[0]) as ClaudeQuery;
}

/** Normalize success/error text across the Agent SDK result variants. */
function claudeResultText(message: Record<string, unknown>): string {
  if (typeof message.result === "string" && message.result.trim()) return message.result;
  if (!Array.isArray(message.errors)) return "";
  return message.errors
    .filter((error): error is string => typeof error === "string" && Boolean(error.trim()))
    .join(": ");
}

/** Drain an Agent SDK message stream into the SdkLike one-shot result shape. */
async function collectOneShot(q: AsyncIterable<Record<string, unknown>>): Promise<SdkPromptResult> {
  let resultText = "";
  let runId: string | undefined;
  let sessionId: string | undefined;
  let isError = false;
  let usage: StreamUsage | undefined;
  for await (const m of q) {
    if (typeof m.session_id === "string") sessionId = m.session_id;
    const u = parseStreamUsage(m);
    if (u) usage = { ...usage, ...u };
    if (m.type === "result") {
      isError = Boolean(m.is_error);
      resultText = claudeResultText(m);
      if (typeof m.uuid === "string") runId = m.uuid;
    }
  }
  return {
    status: isError ? "error" : "finished",
    result: resultText,
    id: runId,
    agentId: sessionId,
    ...(usage ? { usage } : {}),
  };
}

export function createClaudeAgentSdk(
  opts?: {
    authMode?: EngineAuth;
    toolPolicy?: EngineToolPolicy;
  },
  deps: { startQuery?: typeof startQuery; cancelGraceMs?: number } = {}
): ClaudeAgentSdk {
  const authMode: EngineAuth = opts?.authMode ?? "api-key";
  const denyDestructive = opts?.toolPolicy?.denyDestructive ?? false;
  const sanitizeInput = opts?.toolPolicy?.sanitizeInput ?? false;
  const allowWriteRoots = opts?.toolPolicy?.allowWriteRoots;
  const effort = opts?.toolPolicy?.effort;
  const runQuery = deps.startQuery ?? startQuery;
  const cancelGraceMs = deps.cancelGraceMs ?? CLAUDE_CANCEL_GRACE_MS;

  /** Interactive agent handle: one Agent SDK session, resumed per turn. */
  function makeAgent(init: {
    model: string;
    cwd: string;
    apiKey: string;
    mcpServers?: Record<string, unknown>;
    sessionId?: string;
  }): AgentLike {
    type ActiveQuery = { close(): void; done: Promise<void> };
    let sessionId = init.sessionId;
    let agentClosed = false;
    let agentClosePromise: Promise<void> | undefined;
    const activeQueries = new Set<ActiveQuery>();
    const agent: AgentLike = {
      agentId: sessionId,
      async send(message: string, sendOpts?: AgentSendOptions): Promise<RunLike> {
        if (agentClosed) throw new Error("agent is closed");
        const model = sendOpts?.model?.id?.trim() || init.model;
        const q = await runQuery(message, {
          model,
          cwd: init.cwd,
          env: engineAuthEnv(authMode, init.apiKey),
          ...permissionOptions(
            denyDestructive,
            sanitizeInput,
            allowWriteRoots,
            init.cwd,
            Boolean(init.mcpServers?.["csagent-ask"])
          ),
          ...(effort ? { effort } : {}),
          ...(init.mcpServers ? { mcpServers: init.mcpServers } : {}),
          ...(sessionId ? { resume: sessionId } : {}),
        });
        if (agentClosed) {
          try {
            q.close?.();
          } catch {
            // The owning agent is already closed; query cleanup is best-effort.
          }
          throw new Error("agent is closed");
        }

        let status = "finished";
        let runId: string | undefined;
        let sid = sessionId;
        let errorDetail: string | undefined;
        const events: Array<Record<string, unknown>> = [];
        let completed = false;
        let pumpFailed = false;
        let pumpError: unknown;
        let streamClaimed = false;
        let resolveStream: (() => void) | undefined;
        let queryClosed = false;
        let cancelPromise: Promise<void> | undefined;

        const wakeStream = () => {
          const resolve = resolveStream;
          resolveStream = undefined;
          resolve?.();
        };
        const closeQuery = () => {
          if (queryClosed) return;
          q.close?.();
          queryClosed = true;
        };
        const activeQuery: ActiveQuery = { close: closeQuery, done: Promise.resolve() };
        activeQueries.add(activeQuery);

        const pump = async () => {
          try {
            for await (const m of q) {
              await sendOpts?.onDelta?.({ update: m });
              if (typeof m.session_id === "string") {
                sid = m.session_id;
                agent.agentId = sid;
              }
              if (m.type === "result") {
                const isErr = Boolean(m.is_error);
                status = isErr ? "error" : "finished";
                if (typeof m.uuid === "string") runId = m.uuid;
                if (isErr) {
                  const subtype = typeof m.subtype === "string" ? m.subtype : "";
                  const txt = claudeResultText(m);
                  errorDetail = [subtype, txt].filter(Boolean).join(": ") || "agent run error";
                }
              }
              events.push(m);
              wakeStream();
            }
          } catch (error) {
            pumpFailed = true;
            pumpError = error;
            throw error;
          } finally {
            sessionId = sid; // persist for the next turn's resume
            completed = true;
            activeQueries.delete(activeQuery);
            wakeStream();
          }
        };
        const pumpPromise = pump();
        activeQuery.done = pumpPromise;
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
                while (index < events.length) yield events[index++]!;
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
                if (completed || queryClosed) return;
                if (typeof q.interrupt === "function") {
                  void Promise.resolve()
                    .then(() => q.interrupt!())
                    .catch(() => {
                      try {
                        closeQuery();
                      } catch {
                        // The bounded fallback below gets one more close attempt.
                      }
                    });

                  // Give a cooperative interrupt time to finish the iterator,
                  // but never let /stop or shutdown wait on it indefinitely.
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  await Promise.race([
                    pumpPromise.then(
                      () => undefined,
                      () => undefined
                    ),
                    new Promise<void>((resolve) => {
                      timer = setTimeout(resolve, Math.max(0, cancelGraceMs));
                    }),
                  ]);
                  if (timer) clearTimeout(timer);
                  if (!completed) closeQuery();
                  return;
                }
                closeQuery();
              })();
            }
            return cancelPromise;
          },
          async wait() {
            await pumpPromise;
            // `error` is read by pickRunErrorDetail() so chat surfaces a useful detail.
            const out: { status: string; id?: string; error?: string } = { status, id: runId };
            if (errorDetail) out.error = errorDetail;
            return out;
          },
        };
        return run;
      },
      close() {
        if (!agentClosePromise) {
          agentClosed = true;
          const queries = [...activeQueries];
          agentClosePromise = (async () => {
            for (const query of queries) {
              try {
                query.close();
              } catch {
                // Continue closing the remaining active queries.
              }
            }
            await Promise.allSettled(queries.map((query) => query.done));
          })();
        }
        return agentClosePromise;
      },
    };
    return agent;
  }

  return {
    async prompt(message, sdkOpts): Promise<SdkPromptResult> {
      const mcpServers = toAgentMcpServers(sdkOpts.mcpServers);
      const q = await runQuery(message, {
        model: sdkOpts.model.id,
        cwd: sdkOpts.local.cwd,
        env: engineAuthEnv(authMode, sdkOpts.apiKey ?? ""),
        ...permissionOptions(
          denyDestructive,
          sanitizeInput,
          allowWriteRoots,
          sdkOpts.local.cwd,
          Boolean(mcpServers?.["csagent-ask"])
        ),
        ...(effort ? { effort } : {}),
        ...(mcpServers ? { mcpServers } : {}),
        ...(sdkOpts.disallowedTools?.length ? { disallowedTools: sdkOpts.disallowedTools } : {}),
      });
      return collectOneShot(q);
    },

    create(o) {
      return makeAgent({
        model: o.model.id,
        cwd: o.local.cwd,
        apiKey: o.apiKey,
        mcpServers: toAgentMcpServers(o.mcpServers),
      });
    },

    resume(agentId, o) {
      // The Agent SDK re-establishes context from `resume`, but tools run in
      // this cwd — callers pass the session's stored cwd (H-10); process.cwd()
      // is only the legacy fallback.
      return makeAgent({
        model: o.model?.id?.trim() || DEFAULT_CLAUDE_AGENT_MODEL,
        cwd: o.cwd?.trim() || process.cwd(),
        apiKey: o.apiKey,
        mcpServers: toAgentMcpServers(o.mcpServers),
        sessionId: agentId,
      });
    },
  };
}
