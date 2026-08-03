/**
 * Shared interactive chat session for readline CLI and Ink TUI.
 * Agent.create + send per turn, streaming, SQLite persistence, safety gate.
 */
import {
  loadConfig,
  ConfigError,
  applyEngineOverride,
  resolveDenyDestructive,
  resolveSanitizeInput,
  resolveEngineAuth,
  resolveEngineModel,
  type AgentConfig,
  type EngineProvider,
  type EngineAuth,
} from "./config.js";
import {
  createSession,
  disposeAgent,
  eventText,
  eventActivityDetail,
  eventThinkingText,
  parseStreamUsage,
  sendAgentTurn,
  StartupError,
  type AgentLike,
  type RunLike,
  type SdkCreateLike,
  type SdkResumeLike,
  type StreamUsage,
} from "./host.js";
import { createStore, type IStore, type SessionRecord } from "./store.js";
import {
  sessionAllowedForChannel,
  sessionChannelConflictMessage,
  type SessionChannel,
} from "./sessionChannel.js";
import { loadGatewayPeers } from "./gatewayPeers.js";
import { safetyGate, type Confirmer } from "./safety.js";
import { loadSkills, scanSkillThreat, SkillError, type Skill } from "./skills.js";
import { runPreTurnHook, runPostTurnHook } from "./turnHooks.js";
import { composePrompt, ContextRefError, MemoryError } from "./composePrompt.js";
import { sessionStartMemoryBlocks } from "./memory.js";
import { autoRagMemoryBlocks } from "./autoRag.js";
import { buildPreTurnBlocks } from "./preTurn.js";
import { PetRuntimeTracker } from "./petRuntime.js";
import { connectAgentForSession, replayPreamble, type ConnectMode } from "./sessionConnect.js";
import { resolveMcpServers } from "./mcpServers.js";
import { redact } from "./redact.js";
import { newId, preview, resultPreview, nowIso, sleep } from "./util.js";
import { EXIT, type ExitCode } from "./exit.js";
import type { ActivityDetail } from "./host.js";
import {
  consumeRunStream,
  formatSdkError,
  isAgentRotatableError,
  isAuthErrorText,
  isContextOverflowErrorText,
  isOverloadErrorText,
  OVERLOAD_RETRY_DELAYS_MS,
} from "./sdkErrors.js";
import { createMemoryStore } from "./memoryStore.js";
import { writeSessionHandoff } from "./sessionHandoff.js";
import { cogitBriefBlocks } from "./cogitBrief.js";
import {
  API_KEY_HELP,
  ANTHROPIC_API_KEY_HELP,
  OPENAI_API_KEY_HELP,
  resolveApiKey,
  resolveAnthropicKey,
  resolveOpenAiKey,
  resolveClaudeOAuthToken,
  markClaudeOAuthTokenInvalid,
} from "./credentials.js";
import { formatRunErrorMessage, pickRunErrorDetail } from "./runErrors.js";
import { formatErrorDetail } from "./runErrorDetail.js";
import { agentLogVerbose, resolveAgentLogger } from "./agentLog.js";
import { isAgentIdle, resolveAgentIdleMs } from "./agentIdle.js";
import { buildRunLogMeta } from "./runContext.js";

type ChatSdk = SdkCreateLike & SdkResumeLike;

export interface AgentRotatedInfo {
  previousAgentId: string | null;
  newAgentId: string | null;
  replayTurns: number;
  /** Why rotation happened (SDK run_error, stale handle, …). */
  reason?: string;
}

export interface ChatSessionOptions {
  sdk?: ChatSdk;
  dir?: string;
  /** Agent working directory (defaults to config cwd). */
  cwd?: string;
  skills?: string[];
  yesIUnderstand?: boolean;
  confirm?: Confirmer;
  interactive?: boolean;
  /** Override config model for this session. */
  model?: string;
  /** Override engine.provider for this session (--engine). */
  engine?: string;
  /** Override engine.auth for this session (--auth). */
  auth?: string;
  /** Continue an existing stored session (live resume or transcript replay). */
  resumeSessionId?: string;
  /** Validate this first-turn message and explicit refs before opening an SDK session. */
  preflightMessage?: string;
  /** Owning channel (telegram, tui, cli, …) — isolates gateway from TUI. */
  channel?: SessionChannel;
  /** Cron job id when channel=cron (I-68 run log). */
  cronJob?: string;
  /** Gateway peer for cron_propose MCP (Telegram chatId). */
  gatewayPeer?: { adapter: string; chatId: string };
  onLog?: (line: string) => void;
  onAssistantDelta?: (delta: string) => void;
  onThinkingDelta?: (chunk: string) => void;
  onActivity?: (entry: ActivityDetail) => void;
  /** Fired before resending a turn after agent rotation (idle refresh or run_error). */
  onTurnRetry?: (reason?: string) => void;
  /** Fired when a store/memory operation degraded (persistSoft/soft) — UI pet turns worried (I-148). */
  onStoreDegraded?: (label: string) => void;
  /** Fired when rotation starts — UI can show a pending state (I-13). */
  onAgentRotating?: (info: { reason: string }) => void;
  /** Fired when SDK agent is replaced inside the same irida session. */
  onAgentRotated?: (info: AgentRotatedInfo) => void;
  /**
   * Fired after a context-overflow was resolved by handoff + `/compact` (the
   * session survives, unlike rotation). Surfaces so the UI can tell the user their
   * companion just shed history rather than letting it happen invisibly.
   */
  onSessionCompacted?: (info: {
    sessionId: string;
    reason: string;
    handoffNote?: string;
  }) => void;
  /** Overload retry backoff schedule override (tests only; default OVERLOAD_RETRY_DELAYS_MS). */
  overloadRetryDelaysMs?: number[];
  /** Session store override (tests only; default createStore(dir)). */
  store?: IStore;
}

export type TurnOutcome =
  | { kind: "ok"; status: string; assistantText: string; stats: TurnStats }
  | { kind: "blocked"; reason: string }
  | {
      kind: "error";
      message: string;
      fatal: boolean;
      /** One-shot CLI mapping for input/context failures; engine failures default to EX_SOFTWARE. */
      exitCode?: ExitCode;
      partialAssistantText?: string;
      /** The SDK run itself failed (status=error), vs. a pre/post-run logic error. */
      runFailed?: boolean;
    };

export interface TurnStats {
  durationMs: number;
  toolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Per-turn hooks (gateway Telegram UX overrides session-level callbacks). */
export interface TurnHooks {
  onActivity?: (entry: ActivityDetail) => void;
  onAssistantDelta?: (delta: string) => void;
  onThinkingDelta?: (chunk: string) => void;
}

export interface ChatSession {
  sessionId: string;
  cfg: AgentConfig;
  agentId: string | null;
  connectMode: ConnectMode | "fresh";
  sendTurn(userMessage: string, hooks?: TurnHooks): Promise<TurnOutcome>;
  /** Request cancellation of the SDK run currently owned by this session. */
  cancelActiveTurn(): Promise<boolean>;
  /** Record delegate/subagent output into session transcript (replay on next turns). */
  injectContext(userLabel: string, assistantText: string): Promise<void>;
  close(): Promise<void>;
}

async function resolveSdk(
  provider: EngineProvider,
  authMode: EngineAuth,
  denyDestructive: boolean,
  injected?: ChatSdk,
  sanitizeInput = false
): Promise<ChatSdk> {
  if (injected) return injected;
  if (provider === "claude-agent") {
    const { createClaudeAgentSdk } = await import("./engines/claudeAgentSdk.js");
    return createClaudeAgentSdk({ authMode, toolPolicy: { denyDestructive, sanitizeInput } }) as unknown as ChatSdk;
  }
  if (provider === "codex") {
    const { createCodexSdk } = await import("./engines/codexSdk.js");
    return createCodexSdk({ authMode, toolPolicy: { denyDestructive, sanitizeInput } }) as unknown as ChatSdk;
  }
  const mod = await import("@cursor/sdk");
  return mod.Agent as unknown as ChatSdk;
}

/** npm package behind each engine, for a "cannot load" diagnostic. */
function enginePackage(provider: EngineProvider): string {
  if (provider === "claude-agent") return "@anthropic-ai/claude-agent-sdk";
  if (provider === "codex") return "@openai/codex-sdk";
  return "@cursor/sdk";
}

async function resolveSessionTitle(store: IStore, sessionId: string, userMsg: string): Promise<string> {
  const existing = await store.getSession(sessionId);
  const t = existing?.title?.trim() ?? "";
  if (t && t !== "chat session") return t;
  return preview(userMsg, 60);
}

export type OpenChatResult =
  | { ok: true; session: ChatSession }
  | { ok: false; code: ExitCode; message: string };

export async function openChatSession(opts: ChatSessionOptions = {}): Promise<OpenChatResult> {
  const dir = opts.dir ?? process.cwd();
  const interactive = opts.interactive ?? true;
  const log = resolveAgentLogger({ component: "chat", onLog: opts.onLog });
  let onTurnRetry = opts.onTurnRetry;
  let onStoreDegraded = opts.onStoreDegraded;

  let cfg: AgentConfig;
  try {
    cfg = loadConfig(dir);
    cfg = applyEngineOverride(cfg, opts.engine, opts.auth);
  } catch (e) {
    return {
      ok: false,
      code: EXIT.config,
      message: e instanceof ConfigError ? e.message : String(e),
    };
  }
  if (cfg.runtime === "cloud" && !cfg.safety.allowCloud) {
    return { ok: false, code: EXIT.config, message: "cloud runtime requires safety.allowCloud=true (MVP is local-first)" };
  }

  const provider = cfg.engine.provider;
  const authMode: EngineAuth = resolveEngineAuth(cfg.engine);

  let apiKey = "";
  if (provider === "cursor") {
    apiKey = resolveApiKey(dir).key;
    if (!apiKey) return { ok: false, code: EXIT.config, message: API_KEY_HELP };
  } else if (provider === "codex") {
    if (authMode === "api-key") {
      apiKey = resolveOpenAiKey(dir).key;
      if (!apiKey) return { ok: false, code: EXIT.config, message: OPENAI_API_KEY_HELP };
    }
    // Account mode carries no secret: the CLI reads the `codex login` session.
    // A missing session surfaces as an auth-classified run error, not here —
    // matching how claude-agent account mode tolerates an empty token.
  } else if (authMode === "account") {
    // Account mode tolerates an empty token (falls back to the `claude login` session).
    apiKey = resolveClaudeOAuthToken(dir).key;
  } else {
    apiKey = resolveAnthropicKey(dir).key;
    if (!apiKey) return { ok: false, code: EXIT.config, message: ANTHROPIC_API_KEY_HELP };
  }

  const activeModel = (opts.model ?? resolveEngineModel(cfg)).trim();
  if (!activeModel) {
    return { ok: false, code: EXIT.config, message: "model must be a non-empty string" };
  }
  cfg = { ...cfg, model: activeModel };

  const mcpServers = resolveMcpServers(cfg, dir, {
    gatewayChatId: opts.gatewayPeer?.chatId,
    gatewayAdapter: opts.gatewayPeer?.adapter,
  });

  let skills: Skill[] = [];
  if (opts.skills?.length) {
    try {
      skills = loadSkills(dir, cfg.skillsPath, opts.skills, {
        allowUnsafe: cfg.skillPolicy?.allowUnsafe,
      });
    } catch (e) {
      return {
        ok: false,
        code: EXIT.usage,
        message: e instanceof SkillError ? e.message : String(e),
      };
    }
  }

  const store = opts.store ?? createStore(dir, cfg.stateDir);
  const gatewayPeerIds = new Set(Object.values(loadGatewayPeers(dir).peers));

  // Resume metadata is part of the session identity. Load it before resolving
  // the engine adapter so channel-specific tool policy uses the stored surface.
  let existingSession: SessionRecord | undefined;
  if (opts.resumeSessionId) {
    existingSession = await store.getSession(opts.resumeSessionId);
    if (!existingSession) {
      await store.close();
      return { ok: false, code: EXIT.usage, message: `session '${opts.resumeSessionId}' not found` };
    }
    if (!sessionAllowedForChannel(existingSession, opts.channel, gatewayPeerIds)) {
      await store.close();
      return {
        ok: false,
        code: EXIT.usage,
        message: sessionChannelConflictMessage(existingSession),
      };
    }
    const sessionEngine = (existingSession.engine ?? "").trim() || "cursor";
    if (sessionEngine !== provider) {
      await store.close();
      return {
        ok: false,
        code: EXIT.usage,
        message: `session '${opts.resumeSessionId}' was created with engine '${sessionEngine}', but the active engine is '${provider}'. Set engine.provider to '${sessionEngine}' or start a new session.`,
      };
    }
  }

  const effectiveChannel = existingSession?.channel?.trim() || opts.channel;
  const preflightCwd = existingSession ? existingSession.cwd || cfg.cwd : opts.cwd || cfg.cwd;
  const preflightMessage = opts.preflightMessage;

  // The final prompt depends on whether live resume succeeds (live skips
  // first-turn injections; replay includes them), so preflight only the
  // user-controlled message and explicit @file/@dir/@memory refs here. The
  // fully composed prompt is gated again in sendTurn after connect mode is known.
  if (preflightMessage !== undefined) {
    try {
      const preflightPrompt = await composePrompt({
        userPrompt: preflightMessage.trim(),
        cwd: preflightCwd,
        dir,
      });
      const gate = await safetyGate({
        prompt: preflightPrompt,
        interactive,
        confirm: opts.confirm,
        override: opts.yesIUnderstand,
      });
      if (!gate.allowed) {
        await store.close();
        return { ok: false, code: EXIT.noperm, message: `blocked — ${gate.reason}` };
      }
    } catch (e) {
      await store.close();
      if (e instanceof ContextRefError || e instanceof MemoryError) {
        return { ok: false, code: EXIT.usage, message: e.message };
      }
      throw e;
    }
  }

  let sdk: ChatSdk;
  try {
    const denyDestructive = resolveDenyDestructive(cfg.engine, effectiveChannel);
    sdk = await resolveSdk(provider, authMode, denyDestructive, opts.sdk, resolveSanitizeInput(cfg.engine));
  } catch (e) {
    await store.close();
    return {
      ok: false,
      code: EXIT.software,
      message: `cannot load ${enginePackage(provider)}: ` + redact((e as Error).message),
    };
  }

  let agent: AgentLike;
  let sessionId: string;
  let connectMode: ConnectMode | "fresh" = "fresh";
  let replayPrefix = "";
  let sessionCwd = preflightCwd;
  let sessionChannel = opts.channel ?? "";
  let sessionTitle = "chat session";
  let sessionRuntime: string = cfg.runtime;
  const sessionCronJob = opts.cronJob?.trim() ?? "";
  let lastAgentTouchAt = Date.now();
  /** True when the previous agent was disposed but its replacement failed to start. */
  let agentBroken = false;
  const confirm: Confirmer = opts.confirm ?? (async () => false);

  type PreparedTurn = {
    msg: string;
    sendMsg: string;
    isFirstTurn: boolean;
    hookEnv: { prompt: string; sessionId: string; channel: string; cwd: string };
  };
  type RejectedTurnOutcome = Exclude<TurnOutcome, { kind: "ok" }>;
  type PrepareTurnResult =
    | { ok: true; turn: PreparedTurn }
    | { ok: false; outcome: RejectedTurnOutcome };

  class ReplayPreparationRejected extends Error {
    constructor(readonly outcome: RejectedTurnOutcome) {
      super(outcome.kind === "blocked" ? outcome.reason : outcome.message);
      this.name = "ReplayPreparationRejected";
    }
  }

  let stagedReplayTurn: PreparedTurn | undefined;

  /**
   * `/compact` must reach the Claude Agent SDK verbatim — its manual-compaction
   * trigger only recognizes an exact "/compact" prompt (see agent-sdk docs), and
   * composePrompt/preTurn/replay would otherwise prepend mode/profile/memory/skill
   * blocks that silently turn a context-reset request into a normal chat message
   * (I-161 follow-up: this is how a wedged over-long session gets un-wedged
   * WITHOUT losing history, unlike /new).
   */
  const isCompactCommand = (msg: string): boolean => /^\/compact\b/i.test(msg);

  // Memory/profile injections are enhancements: when their store is down
  // the turn must degrade (no memory blocks), not fail — postmortem
  // 2026-06-18 had PG down keep the poll alive while EVERY turn failed
  // (I-137). ContextRefError/MemoryError stay user-visible via the catch.
  const soft = async <T>(label: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ContextRefError || e instanceof MemoryError) throw e;
      log(
        `[chat] ${label} failed — continuing without it: ${e instanceof Error ? e.message : String(e)}`
      );
      onStoreDegraded?.(label);
      return fallback;
    }
  };

  const prepareTurn = async (
    userMessage: string,
    isFirstTurn: boolean,
    onComposed?: () => void
  ): Promise<PrepareTurnResult> => {
    const msg = userMessage.trim();
    if (!msg) {
      return {
        ok: false,
        outcome: { kind: "error", message: "empty message", fatal: false, exitCode: EXIT.usage },
      };
    }

    let sendMsg: string;
    const bypassComposition = isCompactCommand(msg);
    if (bypassComposition) {
      sendMsg = msg;
    } else {
      try {
        const { taskText, blocks: preTurnBlocks } = await soft(
          "preTurn blocks",
          { taskText: msg, blocks: [] as string[] },
          () =>
            buildPreTurnBlocks({
              dir,
              cfg,
              rawMessage: msg,
              includeProfile: isFirstTurn,
              isFirstTurn,
              channel: sessionChannel,
            })
        );
        const sessionMemoryBlocks = isFirstTurn
          ? await soft("session-start memory", [] as string[], () => sessionStartMemoryBlocks(dir, cfg))
          : [];
        const autoRagBlocks = await soft("autoRag memory", [] as string[], () =>
          autoRagMemoryBlocks(dir, taskText, cfg)
        );
        sendMsg = await composePrompt({
          userPrompt: taskText,
          cwd: sessionCwd,
          dir,
          skills: isFirstTurn ? skills : [],
          sessionMemoryBlocks,
          preTurnBlocks,
          autoRagBlocks,
        });
      } catch (e) {
        if (e instanceof ContextRefError || e instanceof MemoryError) {
          return {
            ok: false,
            outcome: { kind: "error", message: e.message, fatal: false, exitCode: EXIT.usage },
          };
        }
        throw e;
      }
    }

    // Preserve the existing once-per-session rule: a composed first turn is
    // consumed before hooks/gating, even when either one blocks it.
    onComposed?.();

    const hookEnv = {
      prompt: msg,
      sessionId,
      channel: sessionChannel,
      cwd: sessionCwd,
    };
    if (cfg.hooks?.preTurn) {
      const pre = runPreTurnHook(cfg.hooks.preTurn, hookEnv);
      if (!pre.allowed) {
        return { ok: false, outcome: { kind: "blocked", reason: pre.reason ?? "preTurn hook denied" } };
      }
      // Policy gate (allow/deny) still runs for /compact; the append is skipped
      // so the bare command reaches the SDK untouched (see isCompactCommand above).
      if (pre.appendStdout && !bypassComposition) {
        sendMsg = `${sendMsg}\n\n[hook:preTurn]\n${pre.appendStdout}`;
      }
    }

    const gate = await safetyGate({
      prompt: sendMsg,
      interactive,
      confirm,
      override: opts.yesIUnderstand,
    });
    if (!gate.allowed) {
      return { ok: false, outcome: { kind: "blocked", reason: gate.reason } };
    }

    return { ok: true, turn: { msg, sendMsg, isFirstTurn, hookEnv } };
  };

  if (existingSession) {
    const existing = existingSession;
    const resumedAt = Date.parse(existing.updated_at);
    if (Number.isFinite(resumedAt)) lastAgentTouchAt = resumedAt;
    sessionId = existing.id;
    sessionCwd = existing.cwd || cfg.cwd;
    sessionChannel = effectiveChannel || "";
    sessionTitle = existing.title || sessionTitle;
    sessionRuntime = existing.runtime || sessionRuntime;
    try {
      const beforeReplayCreate =
        preflightMessage === undefined
          ? undefined
          : async () => {
              const prepared = await prepareTurn(preflightMessage, true);
              if (!prepared.ok) throw new ReplayPreparationRejected(prepared.outcome);
              stagedReplayTurn = prepared.turn;
            };
      const connected = await connectAgentForSession(
        sdk,
        store,
        existing,
        cfg,
        apiKey,
        mcpServers,
        beforeReplayCreate ? { beforeReplayCreate } : undefined
      );
      agent = connected.agent;
      connectMode = connected.mode;
      replayPrefix = connected.replayPrefix;
      if (connected.mode === "replayed") {
        log(`[chat] resume replay session=${sessionId} (${connected.liveResumeError || "no agent id"})`);
      } else {
        log(`[chat] resume live session=${sessionId}`);
      }
    } catch (e) {
      await store.close();
      if (e instanceof ReplayPreparationRejected) {
        if (e.outcome.kind === "blocked") {
          return { ok: false, code: EXIT.noperm, message: `blocked — ${e.outcome.reason}` };
        }
        return {
          ok: false,
          code: e.outcome.exitCode ?? EXIT.software,
          message: e.outcome.message,
        };
      }
      const msg = e instanceof StartupError ? e.message : String(e);
      return { ok: false, code: EXIT.software, message: "resume failed: " + redact(msg) };
    }
  } else {
    sessionId = newId("sess");
    try {
      agent = await createSession(sdk, {
        apiKey,
        model: cfg.model,
        cwd: cfg.cwd,
        mcpServers,
      });
    } catch (e) {
      await store.close();
      const msg = e instanceof StartupError ? e.message : String(e);
      return { ok: false, code: EXIT.software, message: "startup failed: " + redact(msg) };
    }
    log(`[chat] agentId=${agent.agentId ?? "-"} session=${sessionId} cwd=${cfg.cwd}`);
  }

  // Registration is bookkeeping — a PG blip at open must not kill the session;
  // later turns re-upsert the same row anyway (I-137).
  try {
    await store.upsertSession({
      id: sessionId,
      title: sessionTitle,
      cwd: sessionCwd,
      runtime: sessionRuntime,
      sdk_agent_id: agent.agentId ?? null,
      last_status: connectMode === "fresh" ? "created" : "resumed",
      channel: sessionChannel,
      engine: provider,
    });
  } catch (e) {
    log(
      `[chat] session register failed — continuing: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // Live resume keeps SDK context — skip skills/onStart reinjection (gateway restart post-mortem 2026-06-13).
  let firstTurn = connectMode !== "resumed";

  const runLogMeta = () =>
    buildRunLogMeta({
      channel: sessionChannel,
      cronJob: sessionCronJob || undefined,
      cwd: sessionCwd,
    });

  let operationChain: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let queuedTurns = 0;
  let turnCancelEpoch = 0;
  let turnRunning = false;
  let turnCanCancel = false;
  let cancelRequested = false;
  let activeRun: RunLike | undefined;
  let cancelPromise: Promise<boolean> | undefined;

  const cancelAttachedRun = (run: RunLike): Promise<boolean> => {
    if (typeof run.cancel !== "function") return Promise.resolve(false);
    if (!cancelPromise) {
      cancelPromise = Promise.resolve()
        .then(() => run.cancel!())
        .then(
          () => true,
          (e) => {
            log(
              `[chat] active run cancellation failed: ${e instanceof Error ? e.message : String(e)}`
            );
            return false;
          }
        );
    }
    return cancelPromise;
  };

  const requestActiveTurnCancellation = async (): Promise<boolean> => {
    if (!turnRunning && queuedTurns === 0) return false;
    if (provider === "claude-agent") {
      // Latch the whole accepted turn, including pre-send setup, retry backoff,
      // and the short queue-to-execution window. A later attempt must not start
      // after /stop merely because no Query existed at that instant.
      turnCancelEpoch++;
      if (turnRunning) cancelRequested = true;
      if (activeRun && typeof activeRun.cancel === "function") {
        return cancelAttachedRun(activeRun);
      }
      return true;
    }
    // Cursor keeps its existing behavior unless a concrete run explicitly
    // exposes cancellation.
    if (!turnRunning || !turnCanCancel || typeof activeRun?.cancel !== "function") return false;
    cancelRequested = true;
    return cancelAttachedRun(activeRun);
  };

  const session: ChatSession = {
    sessionId,
    cfg,
    agentId: agent.agentId ?? null,
    connectMode,
    async sendTurn(userMessage: string, turnHooks?: TurnHooks): Promise<TurnOutcome> {
      const onActivity = turnHooks?.onActivity ?? opts.onActivity;
      const onAssistantDelta = turnHooks?.onAssistantDelta ?? opts.onAssistantDelta;
      const onThinkingDelta = turnHooks?.onThinkingDelta ?? opts.onThinkingDelta;
      let preparedTurn: PreparedTurn;
      if (stagedReplayTurn) {
        const msg = userMessage.trim();
        if (msg !== stagedReplayTurn.msg) {
          return {
            kind: "error",
            message: "message differs from the preflighted first turn",
            fatal: false,
            exitCode: EXIT.usage,
          };
        }
        preparedTurn = stagedReplayTurn;
        stagedReplayTurn = undefined;
        firstTurn = false;
      } else {
        const isFirstTurn = firstTurn;
        const prepared = await prepareTurn(userMessage, isFirstTurn, () => {
          firstTurn = false;
        });
        if (!prepared.ok) return prepared.outcome;
        preparedTurn = prepared.turn;
      }

      const { msg, hookEnv, isFirstTurn } = preparedTurn;
      let sendMsg = preparedTurn.sendMsg;

      // Composed prompt without any replay prefix — rotation regenerates its own.
      const coreSendMsg = sendMsg;
      if (isFirstTurn && replayPrefix && !isCompactCommand(msg)) {
        sendMsg = replayPrefix + "Continue. New request:\n\n" + sendMsg;
      }
      const baseSendMsg = sendMsg;

      let attemptSendMsg = sendMsg;
      let rotated = false;
      let overloadAttempts = 0;
      const overloadDelaysMs = opts.overloadRetryDelaysMs ?? OVERLOAD_RETRY_DELAYS_MS;
      // Persistence is bookkeeping: a store outage must not change the turn's
      // outcome — and above all must never push a COMPLETED turn into the
      // catch→rotation path, which would re-execute it (double billing;
      // audit 2026-07-02 H-2 / I-137).
      const persistSoft = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
        try {
          await fn();
        } catch (e) {
          log(
            `[chat] ${label} failed — turn outcome preserved: ${e instanceof Error ? e.message : String(e)}`
          );
          onStoreDegraded?.(label);
        }
      };
      const cancelledOutcome = (partialText = ""): TurnOutcome => ({
        kind: "error",
        message: "turn cancelled",
        fatal: false,
        partialAssistantText: partialText.trim() ? partialText : undefined,
      });
      const persistCancelledSession = () =>
        persistSoft("upsertSession (cancelled)", async () =>
          store.upsertSession({
            id: sessionId,
            title: await resolveSessionTitle(store, sessionId, msg),
            cwd: sessionCwd,
            runtime: sessionRuntime,
            sdk_agent_id: agent.agentId ?? null,
            last_status: "cancelled",
            channel: sessionChannel,
          })
        );

      log(
        `[chat] sendTurn session=${sessionId} agent=${agent.agentId ?? "-"} userChars=${msg.length} composedChars=${sendMsg.length} replayPrefixChars=${replayPrefix.length}`
      );

      /**
       * Replace the SDK agent. Does not consume the per-turn retry budget.
       *
       * `preserveOldOnFailure` (idle refresh): create the replacement BEFORE
       * disposing the current agent, so a transient createSession failure leaves
       * the live agent intact and the turn proceeds on it instead of being
       * stranded on a disposed handle (I-111). Error/recover rotations dispose
       * first — their old handle is already known-bad.
       */
      const rotateAgent = async (
        reason: string,
        rotateOpts: { preserveOldOnFailure?: boolean } = {}
      ): Promise<boolean> => {
        const previousAgentId = agent.agentId ?? null;
        const previousAgent = agent;
        const previousAgentWasBroken = agentBroken;
        log(`[chat] rotate start reason=${reason} oldAgent=${previousAgentId ?? "-"}`);
        opts.onAgentRotating?.({ reason });
        if (!rotateOpts.preserveOldOnFailure && !previousAgentWasBroken) {
          await disposeAgent(previousAgent);
        }
        let next: AgentLike;
        try {
          next = await createSession(sdk, {
            apiKey,
            model: cfg.model,
            cwd: sessionCwd,
            mcpServers: mcpServers,
          });
        } catch (e) {
          const m = e instanceof StartupError ? e.message : String(e);
          if (rotateOpts.preserveOldOnFailure) {
            // Old agent is still alive — keep it and let the turn run normally.
            log(`[chat] idle refresh failed, keeping current agent reason=${reason} ${redact(m)}`);
            return false;
          }
          // The old agent is already disposed; remember that so the next turn
          // retries createSession instead of sending into a dead handle.
          agentBroken = true;
          log(`[chat] rotate failed reason=${reason} ${redact(m)}`);
          return false;
        }
        if (rotateOpts.preserveOldOnFailure) await disposeAgent(previousAgent);
        agentBroken = false;
        agent = next;
        lastAgentTouchAt = Date.now();
        session.agentId = agent.agentId ?? null;
        // Replay is best-effort context restoration — with the store down,
        // rotate with an empty preamble instead of failing the turn (I-137).
        let replayRuns = 0;
        let prefix = "";
        try {
          replayRuns = Math.min(4, (await store.listRuns(sessionId)).length);
          prefix = await replayPreamble(store, sessionId, replayRuns, 12_000);
        } catch (e) {
          replayRuns = 0;
          prefix = "";
          log(
            `[chat] rotate replay unavailable — rotating without history: ${e instanceof Error ? e.message : String(e)}`
          );
        }
        log(
          `[chat] rotate done reason=${reason} old=${previousAgentId ?? "-"} new=${agent.agentId ?? "-"} replayRuns=${replayRuns} replayPrefixChars=${prefix.length} basePromptChars=${baseSendMsg.length}`
        );
        opts.onAgentRotated?.({
          previousAgentId,
          newAgentId: agent.agentId ?? null,
          replayTurns: replayRuns,
          reason,
        });
        await persistSoft("upsertSession (rotate)", async () =>
          store.upsertSession({
            id: sessionId,
            title: await resolveSessionTitle(store, sessionId, msg),
            cwd: sessionCwd,
            runtime: sessionRuntime,
            sdk_agent_id: agent.agentId ?? null,
            last_status: "agent_rotated",
            channel: sessionChannel,
          })
        );
        attemptSendMsg = prefix
          ? prefix + "Continue. New request:\n\n" + coreSendMsg
          : coreSendMsg;
        onTurnRetry?.(reason);
        return true;
      };

      /** Error-path rotation: at most one retry per turn. */
      const tryRotateAgent = async (reason: string): Promise<boolean> => {
        if (rotated) return false;
        rotated = true;
        return rotateAgent(reason);
      };

      /**
       * Context-window overflow: hand off, then compact — instead of rotating.
       *
       * Rotation "works" for an over-long session (the new agent accepts the turn)
       * but at a cost nobody is told about: the SDK session is discarded and only
       * the last 4 run previews are replayed, so a months-long chat silently
       * restarts as a 6 KB stub. `/compact` is the SDK's own manual-compaction
       * trigger — it sheds history while KEEPING the session and the model's
       * summary of it, which is what a long-running companion session actually
       * needs (see isCompactCommand above).
       *
       * Order matters. The handoff note is written FIRST, from the run store, with
       * no model call — it is the black box that survives even if the compact call
       * itself dies. Then `/compact` goes to the SDK verbatim (it must not be
       * wrapped in preTurn/memory blocks or the trigger stops matching). Then the
       * caller retries the ORIGINAL user message on the same agent.
       *
       * Returns false when compaction is unavailable or fails, so the caller falls
       * through to the existing rotation path — degraded, but never a hard error.
       * Shares no budget with rotation but is itself once-per-turn.
       */
      let compacted = false;
      const tryCompactOnContextOverflow = async (reason: string): Promise<boolean> => {
        if (compacted) return false;
        compacted = true;
        log(`[chat] context overflow — handoff + compact reason=${reason}`);

        let handoffNote: string | undefined;
        try {
          const memoryStore = createMemoryStore(dir, cfg.stateDir);
          try {
            handoffNote = await writeSessionHandoff(store, memoryStore, sessionId, {
              reason,
              channel: sessionChannel,
            });
          } finally {
            await memoryStore.close();
          }
          log(`[chat] handoff written note=${handoffNote ?? "-"}`);
        } catch (e) {
          // Non-fatal: losing the note is bad, losing the compact is worse.
          log(
            `[chat] handoff write failed — compacting anyway: ${e instanceof Error ? e.message : String(e)}`
          );
        }

        try {
          const compactRun = await sendAgentTurn(agent, "/compact", cfg.model, {});
          await consumeRunStream(compactRun, () => {});
          const res = await compactRun.wait();
          if (String(res.status) === "error") {
            log(`[chat] compact failed (run error) — falling back to rotation`);
            return false;
          }
        } catch (e) {
          log(
            `[chat] compact failed — falling back to rotation: ${e instanceof Error ? e.message : String(e)}`
          );
          return false;
        }

        log(`[chat] compact ok — retrying original turn on the same agent`);
        // A compact is the other moment the agent "wakes up": history just got
        // summarized away, so re-brief it exactly as on a first turn.
        const briefBlocks = await soft("cogit brief (post-compact)", [] as string[], () =>
          cogitBriefBlocks(cfg)
        );
        if (briefBlocks.length) log(`[chat] post-compact cogit brief chars=${briefBlocks.join("").length}`);
        // Retry the plain composed message: the pre-compact prompt may have carried
        // a replay prefix that the compacted session no longer needs.
        attemptSendMsg = briefBlocks.length
          ? `${briefBlocks.join("\n\n")}\n\n${coreSendMsg}`
          : coreSendMsg;
        onTurnRetry?.(reason);
        opts.onSessionCompacted?.({ sessionId, reason, handoffNote });
        return true;
      };

      /**
       * Claude OAuth token pool failover (I-169): an auth-classified failure
       * normally isn't rotatable (a fresh agent would hit the same bad
       * credential) — but with more than one account configured, marking the
       * current token invalid and re-resolving may hand back a different one.
       * Only meaningful for claude-agent/account mode; a no-op (false) for
       * cursor/api-key auth or when no alternate pool entry is available,
       * falling through to the normal (non-rotatable) auth failure message.
       * Shares tryRotateAgent's one-retry-per-turn budget — a turn gets at
       * most one rotation total, whether triggered by a token swap or a
       * regular SDK error.
       */
      const tryRotateOnAuthFailure = async (reason: string): Promise<boolean> => {
        if (provider !== "claude-agent" || authMode !== "account" || !apiKey) return false;
        const invalidated = await markClaudeOAuthTokenInvalid(apiKey, dir);
        if (!invalidated) return false;
        const revised = resolveClaudeOAuthToken(dir).key;
        if (!revised || revised === apiKey) return false;
        log(`[chat] claude oauth token invalidated (auth error) — rotating to next pool entry`);
        apiKey = revised;
        return tryRotateAgent(reason);
      };

      if (agentBroken) {
        if (!(await rotateAgent("recover_failed_rotation"))) {
          return {
            kind: "error",
            message: "agent unavailable (SDK session create failed); try again",
            fatal: false,
          };
        }
      } else if (isAgentIdle(lastAgentTouchAt)) {
        // Idle refresh exists for stale CURSOR handles. The claude-agent engine
        // reconnects by session id on every send (`resume: sessionId`), so a
        // fresh+replay rotation there only THREW AWAY server-side context
        // (H-10: 20-min idle lost everything past the 4-run replay window).
        if (cfg.engine.provider === "claude-agent") {
          log(`[chat] idle refresh skipped (claude-agent resumes per turn) agoMs=${Date.now() - lastAgentTouchAt}`);
        } else {
          log(
            `[chat] idle refresh due lastTouch=${lastAgentTouchAt} idleMs=${resolveAgentIdleMs()} agoMs=${Date.now() - lastAgentTouchAt}`
          );
          // Proactive, best-effort refresh: must not consume the error-retry budget
          // and must not strand the turn if the SDK is briefly unreachable (I-111) —
          // on failure the live agent is kept and the turn proceeds on it.
          await rotateAgent(`idle_ttl ${resolveAgentIdleMs()}ms`, { preserveOldOnFailure: true });
        }
      }

      for (;;) {
        if (cancelRequested) {
          await persistCancelledSession();
          return cancelledOutcome();
        }
        const runId = newId("run");
        const startedAt = nowIso();
        const turnStartMs = Date.now();
        let toolCalls = 0;
        let usage: StreamUsage = {};
        let turnText = "";
        let run: RunLike | undefined;
        const attempt = rotated ? 2 : 1;
        log(
          `[chat] run send attempt=${attempt} runId=${runId} promptChars=${attemptSendMsg.length} agent=${agent.agentId ?? "-"}`
        );
        turnCanCancel = true;
        cancelPromise = undefined;
        try {
          run = await sendAgentTurn(agent, attemptSendMsg, cfg.model, {
            onDelta: ({ update }) => {
              const u = parseStreamUsage(update);
              if (u) usage = { ...usage, ...u };
            },
          });
          activeRun = run;
          if (cancelRequested) await cancelAttachedRun(run);
          await consumeRunStream(run, (ev) => {
            const activity = eventActivityDetail(ev);
            if (activity) {
              if (activity.phase === "call") toolCalls++;
              if (agentLogVerbose() && activity.phase === "call") {
                const cmd = activity.command?.trim();
                log(
                  `[chat] tool call #${toolCalls} ${activity.toolName ?? activity.label}${cmd ? ` cmd=${preview(cmd, 120)}` : ""}`
                );
              }
              onActivity?.(activity);
            }
            const u = parseStreamUsage(ev);
            if (u) usage = { ...usage, ...u };
            const th = eventThinkingText(ev);
            if (th) onThinkingDelta?.(th);
            const t = eventText(ev);
            if (t) {
              turnText += t;
              onAssistantDelta?.(t);
            }
          });
          const res = await run.wait();
          turnCanCancel = false;
          if (activeRun === run) activeRun = undefined;
          const wasCancelled = cancelRequested;
          const lastStatus = wasCancelled ? "cancelled" : String(res.status);
          const stats: TurnStats = {
            durationMs: Date.now() - turnStartMs,
            toolCalls,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          };
          log(
            `[chat] run done sdkRun=${res.id ?? "-"} status=${lastStatus} tools=${toolCalls} assistantChars=${turnText.length} ${stats.durationMs}ms in=${usage.inputTokens ?? "-"} out=${usage.outputTokens ?? "-"}`
          );
          const runErrorDetail =
            wasCancelled
              ? "turn cancelled"
              : lastStatus === "error"
              ? formatErrorDetail([
                  pickRunErrorDetail(res),
                  `tools=${toolCalls}`,
                  `partialChars=${turnText.length}`,
                ])
              : null;
          await persistSoft("recordRun", () =>
            store.recordRun({
              id: runId,
              session_id: sessionId,
              sdk_agent_id: agent.agentId ?? null,
              sdk_run_id: res.id ?? null,
              prompt_preview: preview(msg),
              result_preview: resultPreview(turnText),
              status: lastStatus,
              error_kind: wasCancelled ? "cancelled" : lastStatus === "error" ? "run_error" : null,
              error_detail: runErrorDetail,
              started_at: startedAt,
              finished_at: nowIso(),
              cwd: sessionCwd,
              runtime: sessionRuntime,
              model: cfg.model,
              input_tokens: usage.inputTokens ?? null,
              output_tokens: usage.outputTokens ?? null,
              cache_read_tokens: usage.cacheReadTokens ?? null,
              cache_creation_tokens: usage.cacheCreationTokens ?? null,
              ...runLogMeta(),
            })
          );
          await persistSoft("upsertSession", async () =>
            store.upsertSession({
              id: sessionId,
              title: await resolveSessionTitle(store, sessionId, msg),
              cwd: sessionCwd,
              runtime: sessionRuntime,
              sdk_agent_id: agent.agentId ?? null,
              last_status: lastStatus,
              channel: sessionChannel,
            })
          );
          if (wasCancelled || cancelRequested) {
            if (!wasCancelled) await persistCancelledSession();
            log(`[chat] sendTurn cancelled assistantChars=${turnText.length}`);
            return cancelledOutcome(turnText);
          }
          if (lastStatus === "error") {
            const detail = pickRunErrorDetail(res);
            // claude-agent delivers upstream failures as `is_error` RESULT
            // messages, not thrown exceptions — so transient capacity errors
            // (529/429/503) land here, never in the catch below. Same policy as
            // the thrown path (I-133): bounded in-place retry while the turn is
            // still clean, and NEVER rotate — a fresh session hits the same
            // upstream state and only sheds context (I-127/I-135).
            if (isOverloadErrorText(detail)) {
              if (
                toolCalls === 0 &&
                turnText.length === 0 &&
                overloadAttempts < overloadDelaysMs.length
              ) {
                const delayMs = overloadDelaysMs[overloadAttempts];
                overloadAttempts++;
                log(
                  `[chat] sendTurn overload retry (run result) attempt=${overloadAttempts} delayMs=${delayMs}`
                );
                onTurnRetry?.(`run_error overload ${detail}`);
                await sleep(delayMs);
                continue;
              }
              const failed = formatRunErrorMessage({ res, toolCalls, turnText });
              log(`[chat] sendTurn failed (overload, no rotation) ${failed.message}`);
              return {
                kind: "error",
                message: `Upstream busy — ${detail}. Transient; retry shortly.`,
                fatal: false,
                partialAssistantText: failed.partialAssistantText,
                runFailed: true,
              };
            }
            const rotateReason = [
              "run_error",
              `status=${lastStatus}`,
              detail ? `detail=${detail}` : "",
              `tools=${toolCalls}`,
              `partialChars=${turnText.length}`,
            ]
              .filter(Boolean)
              .join(" ");
            // Replaying a dirty turn can duplicate visible output or tool side
            // effects. Rotate/retry only while the attempt is still clean.
            if (
              isAuthErrorText(detail) &&
              toolCalls === 0 &&
              turnText.length === 0 &&
              (await tryRotateOnAuthFailure(rotateReason))
            ) {
              continue;
            }
            // Overflow before rotation: compacting keeps the session, rotating throws it away.
            if (
              isContextOverflowErrorText(detail) &&
              toolCalls === 0 &&
              turnText.length === 0 &&
              (await tryCompactOnContextOverflow(rotateReason))
            ) {
              continue;
            }
            if (toolCalls === 0 && turnText.length === 0 && (await tryRotateAgent(rotateReason))) {
              continue;
            }
            const failed = formatRunErrorMessage({ res, toolCalls, turnText });
            log(`[chat] sendTurn failed (no retry) ${failed.message}`);
            return {
              kind: "error",
              message: failed.message,
              fatal: false,
              partialAssistantText: failed.partialAssistantText,
              runFailed: true,
            };
          }
          log(`[chat] sendTurn ok status=${lastStatus} assistantChars=${turnText.length}`);
          lastAgentTouchAt = Date.now();
          if (cfg.hooks?.postTurn) {
            runPostTurnHook(cfg.hooks.postTurn, hookEnv, log);
          }
          return { kind: "ok", status: lastStatus, assistantText: turnText, stats };
        } catch (e) {
          turnCanCancel = false;
          if (activeRun === run) activeRun = undefined;
          if (cancelRequested) {
            log(`[chat] sendTurn cancelled assistantChars=${turnText.length}`);
            await persistSoft("recordRun (cancel path)", () =>
              store.recordRun({
                id: runId,
                session_id: sessionId,
                sdk_agent_id: agent.agentId ?? null,
                sdk_run_id: null,
                prompt_preview: preview(msg),
                result_preview: resultPreview(turnText),
                status: "cancelled",
                error_kind: "cancelled",
                error_detail: "turn cancelled",
                started_at: startedAt,
                finished_at: nowIso(),
                cwd: sessionCwd,
                runtime: sessionRuntime,
                model: cfg.model,
                ...runLogMeta(),
              })
            );
            await persistSoft("upsertSession (cancel path)", async () =>
              store.upsertSession({
                id: sessionId,
                title: await resolveSessionTitle(store, sessionId, msg),
                cwd: sessionCwd,
                runtime: sessionRuntime,
                sdk_agent_id: agent.agentId ?? null,
                last_status: "cancelled",
                channel: sessionChannel,
              })
            );
            return cancelledOutcome(turnText);
          }
          const formatted = formatSdkError(e);
          const rotateReason = `exception kind=${formatted.errorKind} ${formatted.message}`;
          log(`[chat] sendTurn error kind=${formatted.errorKind} ${formatted.message}`);
          // Record the failed attempt before any retry so transcript/replay keeps it.
          await persistSoft("recordRun (error path)", () =>
            store.recordRun({
              id: runId,
              session_id: sessionId,
              sdk_agent_id: agent.agentId ?? null,
              sdk_run_id: null,
              prompt_preview: preview(msg),
              result_preview: resultPreview(turnText),
              status: "error",
              error_kind: formatted.errorKind,
              error_detail: formatErrorDetail([formatted.message]),
              started_at: startedAt,
              finished_at: nowIso(),
              cwd: sessionCwd,
              runtime: sessionRuntime,
              model: cfg.model,
              ...runLogMeta(),
            })
          );
          if (cancelRequested) {
            await persistCancelledSession();
            return cancelledOutcome(turnText);
          }
          // Transient capacity errors (529/429/503, I-127) aren't fixed by rotating
          // the session — retry the SAME turn in place after a short backoff (I-133).
          // Guarded to early failures only (no partial output/tool calls yet): once a
          // turn has produced output or run tools, a blind retry would redo billed
          // work, not just resume a clean attempt.
          if (
            formatted.errorKind === "overload" &&
            toolCalls === 0 &&
            turnText.length === 0 &&
            overloadAttempts < overloadDelaysMs.length
          ) {
            const delayMs = overloadDelaysMs[overloadAttempts];
            overloadAttempts++;
            log(`[chat] sendTurn overload retry attempt=${overloadAttempts} delayMs=${delayMs}`);
            onTurnRetry?.(rotateReason);
            await sleep(delayMs);
            continue;
          }

          if (
            formatted.errorKind === "auth" &&
            toolCalls === 0 &&
            turnText.length === 0 &&
            (await tryRotateOnAuthFailure(rotateReason))
          ) {
            continue;
          }

          // Overflow before rotation: compacting keeps the session, rotating throws it away.
          if (
            toolCalls === 0 &&
            turnText.length === 0 &&
            isContextOverflowErrorText(formatted.message) &&
            (await tryCompactOnContextOverflow(rotateReason))
          ) {
            continue;
          }

          if (
            toolCalls === 0 &&
            turnText.length === 0 &&
            isAgentRotatableError(e) &&
            (await tryRotateAgent(rotateReason))
          ) {
            continue;
          }

          await persistSoft("upsertSession (error path)", async () =>
            store.upsertSession({
              id: sessionId,
              title: await resolveSessionTitle(store, sessionId, msg),
              cwd: sessionCwd,
              runtime: sessionRuntime,
              sdk_agent_id: agent.agentId ?? null,
              last_status: "error",
              channel: sessionChannel,
            })
          );
          return {
            kind: "error",
            message: formatted.message,
            fatal: !formatted.recoverable,
            partialAssistantText: turnText.trim() ? turnText : undefined,
          };
        }
      }
    },
    cancelActiveTurn(): Promise<boolean> {
      return requestActiveTurnCancellation();
    },
    async injectContext(userLabel: string, assistantText: string): Promise<void> {
      const label = userLabel.trim();
      const body = assistantText.trim();
      if (!label || !body) return;
      const runId = newId("run");
      await store.recordRun({
        id: runId,
        session_id: sessionId,
        sdk_agent_id: agent.agentId ?? null,
        sdk_run_id: null,
        prompt_preview: preview(label),
        result_preview: resultPreview(body),
        status: "injected",
        error_kind: null,
        started_at: nowIso(),
        finished_at: nowIso(),
        cwd: sessionCwd,
        runtime: sessionRuntime,
        model: cfg.model,
        ...runLogMeta(),
      });
      lastAgentTouchAt = Date.now();
      log(`[chat] injectContext session=${sessionId} labelChars=${label.length} bodyChars=${body.length}`);
    },
    close(): Promise<void> {
      if (!closePromise) {
        closePromise = (async () => {
          const cancellation = requestActiveTurnCancellation();
          await Promise.all([cancellation, operationChain]);
          if (!agentBroken) await disposeAgent(agent);
          await store.close();
        })();
      }
      return closePromise;
    },
  };

  // Wisp bridge (I-146): every surface funnels through sendTurn, so wrapping it
  // here feeds .agent/pet-state.json for the desktop overlay from TUI, gateway,
  // cron and chat alike. Best-effort by design — pet writes must never break a
  // turn. Disable with `"pet": {"enabled": false}` in agent.config.json.
  if (cfg.pet?.enabled !== false) {
    const petTracker = new PetRuntimeTracker({ dir, theme: cfg.pet?.theme });
    const pet = (fn: () => void): void => {
      try {
        fn();
      } catch {
        /* snapshot write failure must not affect the turn */
      }
    };
    // Retry/degrade fire through local callbacks read by the turn loop. Keep
    // caller-owned options immutable while interposing the pet hooks (I-150).
    const prevRetry = onTurnRetry;
    onTurnRetry = (reason) => {
      if (!reason?.startsWith("idle_ttl")) pet(() => petTracker.noteRetry());
      prevRetry?.(reason);
    };
    const prevDegraded = onStoreDegraded;
    onStoreDegraded = (label) => {
      pet(() => petTracker.noteStoreDegraded());
      prevDegraded?.(label);
    };
    const coreSendTurn = session.sendTurn.bind(session);
    session.sendTurn = async (userMessage, turnHooks) => {
      if (!userMessage.trim()) return coreSendTurn(userMessage, turnHooks);
      pet(() => petTracker.beginTurn());
      const hooks: TurnHooks = {
        ...turnHooks,
        onActivity: (activity) => {
          pet(() => petTracker.onActivity(activity));
          (turnHooks?.onActivity ?? opts.onActivity)?.(activity);
        },
      };
      try {
        const out = await coreSendTurn(userMessage, hooks);
        // A safety-gate block is not a failure — no sad pet, just back to idle.
        if (out.kind === "blocked") pet(() => petTracker.touchIdle());
        else pet(() => petTracker.endTurn(out.kind === "ok"));
        return out;
      } catch (e) {
        pet(() => petTracker.endTurn(false));
        throw e;
      }
    };
  }

  // One owner, one operation at a time. Cancellation deliberately bypasses this
  // chain so /stop and shutdown can interrupt the current SDK run; persistence,
  // rotations and disposal remain serialized and single-owner.
  const runTurn = session.sendTurn.bind(session);
  session.sendTurn = (userMessage, turnHooks) => {
    if (closePromise) {
      return Promise.resolve({
        kind: "error",
        message: "session is closing or closed",
        fatal: true,
      });
    }
    const acceptedCancelEpoch = turnCancelEpoch;
    queuedTurns++;
    const operation: Promise<TurnOutcome> = operationChain.then(async (): Promise<TurnOutcome> => {
      queuedTurns--;
      if (closePromise) {
        return {
          kind: "error",
          message: "session is closing or closed",
          fatal: true,
        };
      }
      if (acceptedCancelEpoch !== turnCancelEpoch) {
        return { kind: "error", message: "turn cancelled", fatal: false };
      }
      turnRunning = true;
      turnCanCancel = false;
      cancelRequested = false;
      activeRun = undefined;
      cancelPromise = undefined;
      try {
        return await runTurn(userMessage, turnHooks);
      } finally {
        turnRunning = false;
        turnCanCancel = false;
        cancelRequested = false;
        activeRun = undefined;
        cancelPromise = undefined;
      }
    });
    operationChain = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  };
  const injectContext = session.injectContext.bind(session);
  session.injectContext = (userLabel, assistantText) => {
    if (closePromise) return Promise.reject(new Error("session is closing or closed"));
    const operation = operationChain.then(() => {
      if (closePromise) throw new Error("session is closing or closed");
      return injectContext(userLabel, assistantText);
    });
    operationChain = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  };

  return { ok: true, session };
}
