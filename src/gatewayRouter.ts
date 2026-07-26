/**
 * Maps (adapter, chatId) → stable sess_ and reuses open ChatSession handles.
 */
import { openChatSession, type ChatSession, type TurnHooks } from "./chatEngine.js";
import type { SdkCreateLike, SdkResumeLike } from "./host.js";
import {
  loadGatewayPeers,
  saveGatewayPeers,
  peerKey,
  type GatewayPeersFile,
} from "./gatewayPeers.js";
import type { SessionChannel } from "./sessionChannel.js";
import { buildDigestFollowupTurn, parseDigestFollowup } from "./gatewayDigestFollowup.js";
import { loadLastDigestContext } from "./digestQa.js";
import { handleGatewaySlash, isGatewaySlashCommand } from "./gatewaySlash.js";
import { getChatMode, applyChatModePrefix } from "./gatewayModeStore.js";
import { getChatEngine } from "./gatewayEngineStore.js";
import { getPendingQuestion, clearPendingQuestion } from "./gatewayPendingQuestionStore.js";
import { loadGatewayConfig, type GatewayConfig } from "./gatewayConfig.js";
import { defaultServiceLogSink } from "./serviceLog.js";

export { GATEWAY_PEERS_FILE, loadGatewayPeers, saveGatewayPeers, peerKey } from "./gatewayPeers.js";
export type { GatewayPeersFile } from "./gatewayPeers.js";

/** Why a router turn failed — lets adapters branch without matching messages. */
export type GatewayRouterErrorCode = "busy" | "blocked" | "turn-error";

export class GatewayRouterError extends Error {
  readonly code: GatewayRouterErrorCode;
  constructor(message: string, code: GatewayRouterErrorCode = "turn-error") {
    super(message);
    this.name = "GatewayRouterError";
    this.code = code;
  }
}

export interface GatewayRouterOptions {
  dir: string;
  adapter: string;
  skills?: string[];
  yesIUnderstand?: boolean;
  sdk?: SdkCreateLike & SdkResumeLike;
  onLog?: (line: string, level?: import("./serviceLog.js").ServiceLogLevel) => void;
  /** Maximum shutdown wait for sessions that have not finished opening. */
  openingCloseGraceMs?: number;
}

const OPENING_CLOSE_GRACE_MS = 1_000;

/** Shown once, on the reply of the turn during which the context was compacted. */
const COMPACT_NOTICE =
  "🧠 _Контекст переполнился — сжал историю и записал handoff. Детали прошлых ходов теперь в пересказе, не дословно._";

/**
 * Names the degraded layer rather than saying "something broke": "автопамять" and
 * "профиль" fail in ways the user can actually judge, and knowing WHICH one is
 * missing is the difference between "он тупит" and "у него нет памяти прямо сейчас".
 */
export function degradedNoticeText(label: string): string {
  const what =
    label.includes("autoRag") ? "автопамять (семантический поиск)"
    : label.includes("session-start memory") ? "стартовая память сессии"
    : label.includes("preTurn") ? "профиль и режим"
    : label.includes("cogit") ? "журнал убеждений"
    : label;
  return `⚠️ _Отвечал без части памяти: ${what} сейчас недоступна._`;
}

export class GatewaySessionRouter {
  private readonly dir: string;
  private readonly adapter: string;
  private readonly skills: string[];
  private readonly yesIUnderstand: boolean;
  private readonly sdk?: SdkCreateLike & SdkResumeLike;
  private readonly onLog: (line: string) => void;
  /** Pending "I just compacted" notices, keyed by peer; consumed by the next reply. */
  private readonly compactNotice = new Map<string, string>();
  /** Pending "a store degraded during this turn" notices, keyed by peer. */
  private readonly degradedNotice = new Map<string, string>();
  private readonly openingCloseGraceMs: number;
  private peers: GatewayPeersFile;
  private active = new Map<string, ChatSession>();
  private opening = new Map<string, Promise<ChatSession>>();
  private busy = new Set<string>();
  private cancelEpoch = new Map<string, number>();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(opts: GatewayRouterOptions) {
    this.dir = opts.dir;
    this.adapter = opts.adapter;
    this.skills = opts.skills ?? [];
    this.yesIUnderstand = opts.yesIUnderstand ?? false;
    this.sdk = opts.sdk;
    this.onLog = opts.onLog ?? defaultServiceLogSink;
    this.openingCloseGraceMs = Math.max(0, opts.openingCloseGraceMs ?? OPENING_CLOSE_GRACE_MS);
    this.peers = loadGatewayPeers(opts.dir);
  }

  isBusy(chatId: string): boolean {
    return this.busy.has(peerKey(this.adapter, chatId));
  }

  /** Cancel/latch only existing inbound work; /stop must never create a session. */
  async cancelActive(chatId: string): Promise<boolean> {
    const key = peerKey(this.adapter, chatId);
    const inFlight = this.busy.has(key) || this.opening.has(key);
    if (inFlight) this.cancelEpoch.set(key, (this.cancelEpoch.get(key) ?? 0) + 1);
    const session = this.active.get(key);
    const cancelled = session ? await session.cancelActiveTurn() : false;
    // Before a session exists the epoch latch guarantees no SDK send. Once an
    // active session owns the turn, report only real engine cancellation.
    return cancelled || (!session && inFlight);
  }

  /** Drop cached SDK session for a peer; next inbound creates a fresh sess_. */
  async resetPeer(chatId: string): Promise<string | null> {
    const key = peerKey(this.adapter, chatId);
    const previousSessionId = this.peers.peers[key] ?? null;
    const cached = this.active.get(key);
    if (cached) {
      await cached.close();
      this.active.delete(key);
    }
    delete this.peers.peers[key];
    saveGatewayPeers(this.dir, this.peers);
    return previousSessionId;
  }

  async getOrCreateSession(chatId: string): Promise<ChatSession> {
    const key = peerKey(this.adapter, chatId);
    if (this.closing) throw new GatewayRouterError("gateway router is closing");
    const cached = this.active.get(key);
    if (cached) return cached;
    const pending = this.opening.get(key);
    if (pending) return pending;

    const opening = this.openSession(key, chatId);
    this.opening.set(key, opening);
    try {
      return await opening;
    } finally {
      if (this.opening.get(key) === opening) this.opening.delete(key);
    }
  }

  private async openSession(key: string, chatId: string): Promise<ChatSession> {
    const resumeId = this.peers.peers[key];
    // Sticky per-chat engine (I-143) overrides agent.config.json's provider.
    const chatEngine = getChatEngine(this.dir, this.adapter, chatId);
    const opened = await openChatSession({
      dir: this.dir,
      sdk: this.sdk,
      resumeSessionId: resumeId,
      skills: this.skills,
      yesIUnderstand: this.yesIUnderstand,
      interactive: false,
      channel: this.adapter as SessionChannel,
      gatewayPeer: { adapter: this.adapter, chatId },
      engine: chatEngine,
      onLog: this.onLog,
      onStoreDegraded: (label) => {
        // Store layers fail soft so a turn survives an outage (I-137) — which also
        // means the outage is invisible. Degrading silently is fine; degrading
        // *unannounced* is what makes a forgetful companion indistinguishable from a
        // broken one.
        //
        // Scope, measured rather than assumed: this covers layers that THROW
        // (memory store, preTurn, cogit brief). It does NOT cover a dead embedder —
        // `searchNotesHybrid` falls back to FTS and returns normally
        // (memoryStore.ts:533), so autoRag quietly serves worse results with no
        // signal at all. Catching that needs the store to report "semantic
        // unavailable"; tracked in I-172.
        this.onLog(`[gateway] store degraded chat=${chatId} label=${label}`);
        this.degradedNotice.set(key, label);
      },
      onSessionCompacted: (info) => {
        this.onLog(
          `[gateway] session compacted chat=${chatId} reason=${info.reason} handoff=${info.handoffNote ?? "-"}`
        );
        this.compactNotice.set(key, COMPACT_NOTICE);
      },
    });
    if (!opened.ok) {
      throw new GatewayRouterError(opened.message);
    }
    if (this.closing) {
      await opened.session.close();
      throw new GatewayRouterError("gateway router is closing");
    }

    const previousSessionId = this.peers.peers[key];
    try {
      this.peers.peers[key] = opened.session.sessionId;
      saveGatewayPeers(this.dir, this.peers);
      this.active.set(key, opened.session);
      return opened.session;
    } catch (e) {
      if (previousSessionId === undefined) delete this.peers.peers[key];
      else this.peers.peers[key] = previousSessionId;
      await opened.session.close().catch(() => {});
      throw e;
    }
  }

  async handleInbound(
    chatId: string,
    text: string,
    hooks?: TurnHooks
  ): Promise<{ reply: string }> {
    const key = peerKey(this.adapter, chatId);
    if (this.busy.has(key)) {
      throw new GatewayRouterError("peer busy — previous turn still running", "busy");
    }
    const inboundCancelEpoch = this.cancelEpoch.get(key) ?? 0;
    const wasCancelled = () => (this.cancelEpoch.get(key) ?? 0) !== inboundCancelEpoch;
    this.busy.add(key);
    try {
      if (text.trim() === "/new") {
        const previousSessionId = await this.resetPeer(chatId);
        await this.getOrCreateSession(chatId);
        return {
          reply: previousSessionId
            ? `Новая сессия irida (было ${previousSessionId}). Контекст сброшен — можно писать заново.`
            : "Новая сессия irida. Контекст сброшен — можно писать заново.",
        };
      }
      if (isGatewaySlashCommand(text)) {
        let gwCfg;
        try {
          gwCfg = loadGatewayConfig(this.dir);
        } catch {
          gwCfg = { skills: this.skills } as GatewayConfig;
        }
        const slashReply = await handleGatewaySlash(text, {
          dir: this.dir,
          adapter: this.adapter,
          chatId,
          cfg: gwCfg,
          skills: this.skills,
          yesIUnderstand: this.yesIUnderstand,
          getSession: () => this.getOrCreateSession(chatId),
          resetSession: () => this.resetPeer(chatId),
        });
        if (slashReply) return { reply: slashReply };
      }
      const session = await this.getOrCreateSession(chatId);
      if (wasCancelled()) throw new GatewayRouterError("turn cancelled");
      const followup = parseDigestFollowup(text);
      let turnText = followup?.prompt ?? text;
      if (followup) {
        this.onLog(`[gateway] digest follow-up ${followup.label} chat=${chatId}`);
        turnText = buildDigestFollowupTurn(turnText, loadLastDigestContext(this.dir));
      }
      // Sticky per-chat mode (I-91): prepend the mode prefix unless the message
      // already carries an explicit one. parseTurnMode then applies it.
      turnText = applyChatModePrefix(turnText, getChatMode(this.dir, this.adapter, chatId));
      // I-125: this message answers any parked clarifying question — the answer
      // reaches the agent through the resumed session, so just drop the pending
      // entry (cleared BEFORE the turn so a fresh ask_user within it survives).
      const pending = getPendingQuestion(this.dir, this.adapter, chatId);
      if (pending) {
        clearPendingQuestion(this.dir, this.adapter, chatId);
        this.onLog(`[gateway] answering parked question chat=${chatId}`);
      }
      if (wasCancelled()) throw new GatewayRouterError("turn cancelled");
      const out = await session.sendTurn(turnText, hooks);
      // Say it out loud: the session just shed history mid-turn. Letting that
      // happen silently is exactly the complaint this whole line of work started
      // from — the user could not tell a forgetful companion from a reset one.
      const notices: string[] = [];
      const compacted = this.compactNotice.get(key);
      if (compacted) notices.push(compacted);
      const degraded = this.degradedNotice.get(key);
      if (degraded) notices.push(degradedNoticeText(degraded));
      this.compactNotice.delete(key);
      this.degradedNotice.delete(key);
      if (out.kind === "ok") {
        return {
          reply: notices.length ? `${notices.join("\n")}\n\n${out.assistantText}` : out.assistantText,
        };
      }
      if (out.kind === "blocked") throw new GatewayRouterError(out.reason, "blocked");
      const partial = out.partialAssistantText?.trim();
      throw new GatewayRouterError(partial ? `${out.message}\n\n${partial}` : out.message);
    } finally {
      this.busy.delete(key);
    }
  }

  closeAll(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = (async () => {
        // Start active cancellation immediately. A different peer's hung open
        // must not delay stopping an already-running Claude Query.
        const closing = [...this.active.values()].map((s) => s.close());
        this.active.clear();
        const openingDrain = Promise.allSettled([...this.opening.values()]);
        let openingTimer: ReturnType<typeof setTimeout> | undefined;
        const boundedOpeningDrain = Promise.race([
          openingDrain.then(() => undefined),
          new Promise<void>((resolve) => {
            openingTimer = setTimeout(resolve, this.openingCloseGraceMs);
          }),
        ]).finally(() => {
          if (openingTimer) clearTimeout(openingTimer);
        });
        const [, results] = await Promise.all([
          boundedOpeningDrain,
          Promise.allSettled(closing),
        ]);
        // A late open observes `closing` in openSession() and closes its own
        // newly-created session; keep its eventual rejection handled here.
        void openingDrain.catch(() => {});
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })();
    }
    return this.closePromise;
  }
}
