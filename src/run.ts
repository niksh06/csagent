/**
 * `irida run "<prompt>"` — one-shot local task via Cursor SDK (issue 008).
 * Non-interactive: destructive prompts are denied (safety, issue 006).
 * Persists run + session metadata to SQLite (issue 007). Maps to exit codes.
 */
import {
  loadConfig,
  ConfigError,
  applyEngineOverride,
  resolveDenyDestructive,
  resolveSanitizeInput,
  DEFAULT_CLAUDE_AGENT_MODEL,
  type EngineProvider,
  type EngineAuth,
} from "./config.js";
import { runOneShot, StartupError, type SdkLike } from "./host.js";
import { createStore } from "./store.js";
import { SESSION_CHANNEL } from "./sessionChannel.js";
import { safetyGate } from "./safety.js";
import { loadSkills, SkillError } from "./skills.js";
import { resolveMcpServers } from "./mcpServers.js";
import { composePrompt, ContextRefError, MemoryError } from "./composePrompt.js";
import { sessionStartMemoryBlocks } from "./memory.js";
import { autoRagMemoryBlocks } from "./autoRag.js";
import { buildPreTurnBlocks } from "./preTurn.js";
import { redact } from "./redact.js";
import { newId, preview, resultPreview, nowIso, sleep } from "./util.js";
import { formatSdkError, isAuthErrorText, isOverloadErrorText, OVERLOAD_RETRY_DELAYS_MS } from "./sdkErrors.js";
import { EXIT, type ExitCode } from "./exit.js";
import {
  API_KEY_HELP,
  ANTHROPIC_API_KEY_HELP,
  resolveApiKey,
  resolveAnthropicKey,
  resolveClaudeOAuthToken,
  markClaudeOAuthTokenInvalid,
} from "./credentials.js";
import { formatErrorDetail } from "./runErrorDetail.js";
import { buildRunLogMeta } from "./runContext.js";
import type { SessionChannel } from "./sessionChannel.js";

export interface RunOptions {
  sdk?: SdkLike;
  dir?: string;
  /** Agent working directory (defaults to config cwd). */
  cwd?: string;
  skills?: string[];
  yesIUnderstand?: boolean;
  /** Override agent.config.json model (e.g. distill subagents). */
  model?: string;
  /** Skip preTurn, autoRag, session memory, skills — task text only. */
  barePrompt?: boolean;
  /** With barePrompt: still attach MCP tools (e.g. memory) so the task can write (I-113). */
  attachMcp?: boolean;
  /** Tool names blocked for this run (e.g. read-only evolution proposer in I-98). */
  disallowedTools?: string[];
  /**
   * I-157: path-scoped write envelope — file-mutation tools may only touch
   * paths inside these roots (claude-agent engine only; enforced by canUseTool).
   */
  allowWriteRoots?: string[];
  /** I-158: reasoning effort (low|medium|high|xhigh|max; claude-agent only). */
  effort?: string;
  /** Write session/run to store (default true). */
  persistRun?: boolean;
  /** Suppress stdout/stderr progress logs. */
  quiet?: boolean;
  /** Run log channel override (default `run`; cron passes `cron`). */
  channel?: SessionChannel;
  /** Cron job id for run log when invoked from cron (I-68). */
  cronJob?: string;
  /** Override engine.provider for this invocation (--engine). */
  engine?: string;
  /** Override engine.auth for this invocation (--auth). */
  auth?: string;
  /** Overload retry backoff override (tests only; default OVERLOAD_RETRY_DELAYS_MS). */
  overloadRetryDelaysMs?: number[];
}

export interface RunResult {
  exitCode: ExitCode;
  /** Assistant text on success; empty on early failure. */
  text: string;
}

async function resolveSdk(
  provider: EngineProvider,
  authMode: EngineAuth,
  denyDestructive: boolean,
  injected?: SdkLike,
  sanitizeInput = false,
  allowWriteRoots?: string[],
  effort?: string
): Promise<SdkLike> {
  if (injected) return injected;
  if (provider === "claude-agent") {
    const { createClaudeAgentSdk } = await import("./engines/claudeAgentSdk.js");
    return createClaudeAgentSdk({ authMode, toolPolicy: { denyDestructive, sanitizeInput, allowWriteRoots, effort } });
  }
  const mod = await import("@cursor/sdk");
  return mod.Agent as unknown as SdkLike;
}

export async function runPrompt(prompt: string, opts: RunOptions = {}): Promise<RunResult> {
  const dir = opts.dir ?? process.cwd();

  const quiet = opts.quiet === true;

  if (!prompt || !prompt.trim()) {
    if (!quiet) console.error('run: a prompt is required, e.g. irida run "summarize this repo"');
    return { exitCode: EXIT.usage, text: "" };
  }
  let cfg;
  try {
    cfg = loadConfig(dir);
    cfg = applyEngineOverride(cfg, opts.engine, opts.auth);
  } catch (e) {
    if (!quiet) console.error("run: " + (e instanceof ConfigError ? e.message : String(e)));
    return { exitCode: EXIT.config, text: "" };
  }

  const provider = cfg.engine.provider;
  const authMode: EngineAuth = provider === "claude-agent" ? (cfg.engine.auth ?? "api-key") : "api-key";

  let apiKey = "";
  if (provider === "cursor") {
    apiKey = resolveApiKey(dir).key;
    if (!apiKey) {
      if (!quiet) console.error(`run: ${API_KEY_HELP}`);
      // Programmatic callers (delegate) surface `text` — not just the exit code.
      return { exitCode: EXIT.config, text: API_KEY_HELP };
    }
  } else if (authMode === "account") {
    // Account mode: an empty token is fine — the Agent SDK falls back to an existing
    // `claude login` session (~/.claude/.credentials.json). Don't hard-fail here.
    apiKey = resolveClaudeOAuthToken(dir).key;
  } else {
    apiKey = resolveAnthropicKey(dir).key;
    if (!apiKey) {
      if (!quiet) console.error(`run: ${ANTHROPIC_API_KEY_HELP}`);
      return { exitCode: EXIT.config, text: ANTHROPIC_API_KEY_HELP };
    }
  }

  const agentCwd = opts.cwd ?? cfg.cwd;
  const effectiveModel =
    opts.model?.trim() ||
    (provider === "claude-agent" ? (cfg.engine.model ?? DEFAULT_CLAUDE_AGENT_MODEL) : cfg.model);
  if (cfg.runtime === "cloud" && !cfg.safety.allowCloud) {
    if (!quiet) console.error("run: cloud runtime requires safety.allowCloud=true (MVP is local-first)");
    return { exitCode: EXIT.config, text: "" };
  }

  let finalPrompt: string;
  let mcpServers: ReturnType<typeof resolveMcpServers>;
  try {
    if (opts.barePrompt) {
      finalPrompt = `# Task\n\n${prompt.trim()}`;
      // bare = skip prompt assembly (preTurn/autoRag/skills/session-memory), NOT tools.
      // Opt back into MCP tools when the task needs them (e.g. memory-distill writes).
      mcpServers = opts.attachMcp ? resolveMcpServers(cfg, dir) : {};
    } else {
      const skills = opts.skills?.length ? loadSkills(dir, cfg.skillsPath, opts.skills) : [];
      const { taskText, blocks: preTurnBlocks } = await buildPreTurnBlocks({
        dir,
        cfg,
        rawMessage: prompt,
        includeProfile: true,
        // A one-shot run IS the first (and only) turn of its session.
        isFirstTurn: true,
      });
      const sessionMemoryBlocks = await sessionStartMemoryBlocks(dir, cfg);
      const autoRagBlocks = await autoRagMemoryBlocks(dir, taskText, cfg);
      mcpServers = resolveMcpServers(cfg, dir);
      finalPrompt = await composePrompt({
        userPrompt: taskText,
        cwd: agentCwd,
        dir,
        skills,
        sessionMemoryBlocks,
        preTurnBlocks,
        autoRagBlocks,
      });
    }
  } catch (e) {
    if (e instanceof ContextRefError || e instanceof MemoryError || e instanceof SkillError) {
      if (!quiet) console.error("run: " + e.message);
      return { exitCode: EXIT.usage, text: "" };
    }
    throw e;
  }

  // Gate the composed prompt: destructive content smuggled via @file/@memory
  // refs must hit the same denylist as the raw message.
  const gate = await safetyGate({ prompt: finalPrompt, interactive: false, override: opts.yesIUnderstand });
  if (!gate.allowed) {
    if (!quiet) console.error(`run: blocked — ${gate.reason}. Use 'irida chat' or --yes-i-understand.`);
    return { exitCode: EXIT.noperm, text: "" };
  }

  const persistRun = opts.persistRun !== false;
  const store = persistRun ? createStore(dir, cfg.stateDir) : null;
  const sessionId = newId("sess");
  const runId = newId("run");
  const startedAt = nowIso();
  const runChannel = opts.channel ?? SESSION_CHANNEL.run;
  const runLogMeta = buildRunLogMeta({
    channel: runChannel,
    cronJob: opts.cronJob,
    cwd: agentCwd,
  });

  try {
    const denyDestructive = resolveDenyDestructive(cfg.engine, runChannel);
    const sanitizeInput = resolveSanitizeInput(cfg.engine);
    const sdk = await resolveSdk(provider, authMode, denyDestructive, opts.sdk, sanitizeInput, opts.allowWriteRoots, opts.effort).catch((e) => {
      const pkg = provider === "claude-agent" ? "@anthropic-ai/claude-agent-sdk" : "@cursor/sdk";
      throw new StartupError(`cannot load ${pkg}: ` + (e as Error).message);
    });
    // One-shot overload retry (H-10, parity with I-133 in chat): a transient
    // 529/429/503 must not fail a cron/delegate run that a 5s wait would save.
    const overloadDelays = opts.overloadRetryDelaysMs ?? OVERLOAD_RETRY_DELAYS_MS;
    // Auth-failure pool rotation (I-169 parity): runPrompt is the one-shot path
    // used by cron/delegate callers — chatEngine.ts's tryRotateOnAuthFailure only
    // covers interactive chat sessions, so a cron job on an org-blocked account
    // token fails outright (exit 70) instead of failing over to the next pool
    // entry, same as an interactive turn would. One rotation attempt per run;
    // sdk.prompt() takes apiKey per-call (see engines/claudeAgentSdk.ts), so
    // retrying with a revised apiKey needs no session/sdk recreation.
    let rotated = false;
    const tryRotateOnAuthFailure = async (): Promise<boolean> => {
      if (provider !== "claude-agent" || authMode !== "account" || !apiKey || rotated) return false;
      const invalidated = await markClaudeOAuthTokenInvalid(apiKey, dir);
      if (!invalidated) return false;
      const revised = resolveClaudeOAuthToken(dir).key;
      if (!revised || revised === apiKey) return false;
      if (!quiet) console.error("run: claude oauth token invalidated (auth error) — rotating to next pool entry");
      apiKey = revised;
      rotated = true;
      return true;
    };

    let r!: Awaited<ReturnType<typeof runOneShot>>;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await runOneShot(sdk, {
          prompt: finalPrompt,
          apiKey,
          model: effectiveModel,
          cwd: agentCwd,
          mcpServers,
          disallowedTools: opts.disallowedTools,
        });
      } catch (e) {
        if (e instanceof StartupError && isAuthErrorText(e.message) && (await tryRotateOnAuthFailure())) {
          continue;
        }
        if (attempt < overloadDelays.length && formatSdkError(e).errorKind === "overload") {
          if (!quiet) console.error(`run: overload retry attempt=${attempt + 1} delayMs=${overloadDelays[attempt]}`);
          await sleep(overloadDelays[attempt]!);
          continue;
        }
        throw e;
      }
      if (r.status === "error" && isAuthErrorText(r.text) && (await tryRotateOnAuthFailure())) {
        continue;
      }
      if (r.status === "error" && attempt < overloadDelays.length && isOverloadErrorText(r.text)) {
        if (!quiet) console.error(`run: overload retry attempt=${attempt + 1} delayMs=${overloadDelays[attempt]}`);
        await sleep(overloadDelays[attempt]!);
        continue;
      }
      break;
    }
    if (!quiet) console.error(`[run] agentId=${r.agentId ?? "-"} runId=${r.runId ?? "-"} status=${r.status}`);
    const failed = r.status === "error";
    if (!persistRun || !store) {
      if (failed) {
        if (!quiet) console.error("run: executed run failed (status=error)");
        return { exitCode: EXIT.software, text: r.text ?? "" };
      }
      return { exitCode: EXIT.ok, text: redact(r.text) };
    }
    await store.upsertSession({
      id: sessionId,
      title: preview(prompt, 60),
      cwd: agentCwd,
      runtime: cfg.runtime,
      sdk_agent_id: r.agentId,
      last_status: r.status,
      channel: runChannel,
      engine: provider,
    });
    await store.recordRun({
      id: runId,
      session_id: sessionId,
      sdk_agent_id: r.agentId,
      sdk_run_id: r.runId,
      prompt_preview: preview(prompt),
      result_preview: resultPreview(r.text),
      status: r.status,
      error_kind: failed ? "run_error" : null,
      error_detail: failed ? formatErrorDetail([r.text]) : null,
      started_at: startedAt,
      finished_at: nowIso(),
      cwd: agentCwd,
      runtime: cfg.runtime,
      model: effectiveModel,
      input_tokens: r.usage?.inputTokens ?? null,
      output_tokens: r.usage?.outputTokens ?? null,
      cache_read_tokens: r.usage?.cacheReadTokens ?? null,
      cache_creation_tokens: r.usage?.cacheCreationTokens ?? null,
      ...runLogMeta,
    });
    if (failed) {
      if (!quiet) console.error("run: executed run failed (status=error)");
      return { exitCode: EXIT.software, text: r.text ?? "" };
    }
    const text = redact(r.text);
    if (!quiet) console.log(text);
    return { exitCode: EXIT.ok, text };
  } catch (e) {
    if (e instanceof StartupError) {
      if (!quiet) console.error("run: startup failed: " + redact(e.message));
      if (!persistRun || !store) {
        return { exitCode: EXIT.software, text: "" };
      }
      await store.upsertSession({
        id: sessionId,
        title: preview(prompt, 60),
        cwd: agentCwd,
        runtime: cfg.runtime,
        sdk_agent_id: null,
        last_status: "startup_error",
        channel: runChannel,
        engine: provider,
      });
      await store.recordRun({
        id: runId,
        session_id: sessionId,
        sdk_agent_id: null,
        sdk_run_id: null,
        prompt_preview: preview(prompt),
        result_preview: "",
        status: "startup_error",
        error_kind: "startup",
        error_detail: formatErrorDetail([e.message]),
        started_at: startedAt,
        finished_at: nowIso(),
        cwd: agentCwd,
        runtime: cfg.runtime,
        model: effectiveModel,
        ...runLogMeta,
      });
      return { exitCode: EXIT.software, text: "" };
    }
    throw e;
  } finally {
    if (store) await store.close();
  }
}

export async function cmdRun(prompt: string, opts: RunOptions = {}): Promise<ExitCode> {
  const { exitCode } = await runPrompt(prompt, opts);
  return exitCode;
}
