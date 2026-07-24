/**
 * Telegram Bot API adapter (long polling, no extra deps) — issue 037 follow-up.
 */
import { type GatewayConfig, isChatAllowed } from "./gatewayConfig.js";
import { resolveTelegramBotToken, validateTelegramBotTokenFormat } from "./credentials.js";
import {
  formatTelegramHtml,
  telegramHtmlDiffers,
  type TelegramMessageFormat,
} from "./telegramFormat.js";
import { drainOutbox, enqueueOutbox, resolveOutboxDeliveryFormat, sendOutboxParkAck } from "./gatewayOutbox.js";
import { GatewaySessionRouter, GatewayRouterError } from "./gatewayRouter.js";
import { tryRegisterPairing } from "./gatewayPairing.js";
import { gatewayTelegramBotCommands, isGatewaySlashCommand } from "./gatewaySlash.js";
import type { ActivityDetail } from "./host.js";
import { emitServiceLog, type ServiceLogSink } from "./serviceLog.js";
import { loadTelegramPollOffset, saveTelegramPollOffset } from "./gatewayTelegramOffset.js";
import { addInflight, loadInflight, removeInflight } from "./gatewayInflight.js";

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type?: string };
  /** Present in private/group messages; absent for channel_post and anon admins. */
  from?: { id: number; is_bot?: boolean };
  /** Channel/anon-admin identity when `from` is absent. */
  sender_chat?: { id: number };
  text?: string;
}

export type TelegramChatKind = "private" | "group" | "channel";

/** Classify a chat by Telegram's `chat.type`, falling back to the id sign. */
export function classifyTelegramChat(msg: TelegramMessage): TelegramChatKind {
  const t = msg.chat.type;
  if (t === "private") return "private";
  if (t === "group" || t === "supergroup") return "group";
  if (t === "channel") return "channel";
  // `chat.type` absent (legacy/synthetic) — positive id is a private chat,
  // negative is a group/channel. Treat unknown negatives as group (stricter).
  return msg.chat.id >= 0 ? "private" : "group";
}

/**
 * Authorize the *sender* once the *chat* has passed the allowlist. The chat
 * allowlist proves "this conversation is permitted"; this proves "this actor is
 * permitted to act within it". Private chats are 1:1 so the chat is the actor.
 */
export function authorizeTelegramSender(
  cfg: GatewayConfig,
  msg: TelegramMessage
): { ok: boolean; reason?: string } {
  const kind = classifyTelegramChat(msg);
  if (kind === "private") return { ok: true };
  if (kind === "channel") {
    return cfg.telegramAllowChannelPosts
      ? { ok: true }
      : { ok: false, reason: "channel posts disabled (set telegram.allowChannelPosts)" };
  }
  // group / supergroup — require an explicitly allowlisted human sender.
  const senderId = msg.from && !msg.from.is_bot ? String(msg.from.id) : undefined;
  if (senderId && cfg.telegramAllowedSenderIds.includes(senderId)) return { ok: true };
  return {
    ok: false,
    reason: senderId
      ? `group sender ${senderId} not in telegram.allowedSenderIds`
      : "group message without an identifiable sender",
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

export type TelegramFetch = (url: string, init?: RequestInit) => Promise<Response>;

const TYPING_REFRESH_MS = 4000;
const TOOL_PREVIEW_MAX = 80;

export function telegramBotToken(cfg: GatewayConfig, dir: string = process.cwd()): string {
  const envName = cfg.telegramTokenEnv.trim() || "TELEGRAM_BOT_TOKEN";
  return resolveTelegramBotToken(dir, envName).value;
}

export async function telegramApiGet<T>(
  token: string,
  method: string,
  params: Record<string, string | number>,
  fetchFn: TelegramFetch = fetch,
  fetchTimeoutMs?: number
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const url = `https://api.telegram.org/bot${token}/${method}?${qs}`;
  const init: RequestInit = { method: "GET" };
  if (fetchTimeoutMs != null && fetchTimeoutMs > 0) {
    init.signal = AbortSignal.timeout(fetchTimeoutMs);
  }
  const res = await fetchFn(url, init);
  const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!body.ok) throw new Error(body.description ?? `telegram ${method} failed`);
  return body.result as T;
}

export async function telegramApiPost<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  fetchFn: TelegramFetch = fetch
): Promise<T> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!body.ok) throw new Error(body.description ?? `telegram ${method} failed`);
  return body.result as T;
}

/** Telegram getUpdates `timeout` param (seconds). Short poll (0) avoids VPN/proxy long-hold hangs. */
export function resolveTelegramGetUpdatesTimeoutSec(_pollIntervalMs: number): number {
  return 0;
}

/** Global Bot API filter — must include message/group traffic (not channel_post only). */
export const TELEGRAM_GATEWAY_ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "callback_query",
] as const;

/** Required for gateway inbound (private + group messages). */
export const TELEGRAM_INBOUND_MESSAGE_UPDATE = "message";

/** True when a turn error is a backing-store/connection outage, not a logic error. */
export function isStoreUnavailableError(message: string): boolean {
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|connection terminated|connect\b.*:\d+|the database system is (starting up|shutting down)|too many clients/i.test(
    message
  );
}

/**
 * A resumed session's cumulative transcript has outgrown what the model
 * accepts. Rotation-with-replay does not help here (the fresh agent still
 * resumes the same oversized underlying conversation) — the only real fix is
 * `/new`, which drops the persisted session id entirely (gatewayRouter's
 * resetPeer). Surfacing this distinctly turns an infinite, unexplained
 * "Something went wrong" loop into one actionable message.
 */
export function isContextOverflowError(message: string): boolean {
  return /\bprompt is too long\b/i.test(message);
}

/** Why an inbound turn failed — adapters branch on this, never on raw messages. */
export type GatewayFailureKind =
  | "busy"
  | "message-too-long"
  | "chat-not-allowed"
  | "store-unavailable"
  | "context-overflow"
  | "internal";

/**
 * Map a thrown turn error to a stable failure kind. The router carries a typed
 * `code` (busy/blocked); store outages are recognized from the driver message
 * at this single boundary; everything else is an internal error.
 */
export function classifyGatewayFailure(e: unknown): GatewayFailureKind {
  if (e instanceof GatewayRouterError && e.code === "busy") return "busy";
  const message = e instanceof Error ? e.message : String(e);
  if (message === "chat not allowed") return "chat-not-allowed";
  if (isStoreUnavailableError(message)) return "store-unavailable";
  if (isContextOverflowError(message)) return "context-overflow";
  return "internal";
}

export interface TelegramAllowedUpdatesAssessment {
  ok: boolean;
  detail: string;
  allowedUpdates: string[];
}

/** Probe Bot API global allowed_updates (I-83). */
export async function assessTelegramAllowedUpdates(
  token: string,
  fetchFn: TelegramFetch = fetch
): Promise<TelegramAllowedUpdatesAssessment> {
  try {
    const info = await telegramApiGet<{ allowed_updates?: string[] }>(
      token,
      "getWebhookInfo",
      {},
      fetchFn,
      15_000
    );
    const allowed = info.allowed_updates ?? [];
    if (allowed.includes(TELEGRAM_INBOUND_MESSAGE_UPDATE)) {
      return {
        ok: true,
        detail: allowed.join(", ") || "(default)",
        allowedUpdates: allowed,
      };
    }
    return {
      ok: false,
      detail: allowed.length
        ? `missing message (got: ${allowed.join(", ")})`
        : "missing message (empty allowed_updates)",
      allowedUpdates: allowed,
    };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      allowedUpdates: [],
    };
  }
}

/** Text-bearing message on any polled inbound update type. */
export function telegramInboundMessage(update: TelegramUpdate): TelegramMessage | undefined {
  return (
    update.message ??
    update.edited_message ??
    update.channel_post ??
    update.edited_channel_post
  );
}

/** Chat id for per-chat turn serialization; undefined when update has no inbound message. */
export function telegramUpdateChatId(update: TelegramUpdate): string | undefined {
  const msg = telegramInboundMessage(update);
  return msg ? String(msg.chat.id) : undefined;
}

/** Label update type for poll logging (I-87). */
export function describeTelegramUpdateType(update: TelegramUpdate): string {
  if (update.message) return "message";
  if (update.edited_message) return "edited_message";
  if (update.channel_post) return "channel_post";
  if (update.edited_channel_post) return "edited_channel_post";
  return "other";
}

export function summarizeTelegramUpdateTypes(updates: TelegramUpdate[]): string {
  const counts = new Map<string, number>();
  for (const u of updates) {
    const t = describeTelegramUpdateType(u);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, v]) => `${k}:${v}`).join(",");
}

export async function telegramGetUpdates(
  token: string,
  offset: number,
  timeoutSec: number,
  fetchFn: TelegramFetch = fetch,
  allowedUpdates: readonly string[] = TELEGRAM_GATEWAY_ALLOWED_UPDATES
): Promise<TelegramUpdate[]> {
  // Short poll should return quickly; generous slack for slow proxies.
  const fetchTimeoutMs = timeoutSec <= 0 ? 15_000 : (timeoutSec + 15) * 1000;
  return telegramApiGet(
    token,
    "getUpdates",
    {
      offset,
      timeout: timeoutSec,
      allowed_updates: JSON.stringify([...allowedUpdates]),
    },
    fetchFn,
    fetchTimeoutMs
  );
}

/** Telegram Bot API `sendMessage` text limit. */
export const TELEGRAM_MESSAGE_MAX = 4096;

/** Bot API 10.1+ `sendRichMessage` markdown limit (32768 UTF-8 chars). */
export const TELEGRAM_RICH_MESSAGE_MAX = 32_000;

/** Reserve for multipart header `[999/999]\n`. */
const TELEGRAM_PART_HEADER_SLACK = 20;

export type { TelegramMessageFormat };

export function resolveTelegramSendFormat(
  opts: { format?: TelegramMessageFormat; html?: boolean } = {}
): TelegramMessageFormat {
  if (opts.format) return opts.format;
  if (opts.html === true) return "rich";
  if (opts.html === false) return "plain";
  return "plain";
}

export function splitTelegramMessages(text: string, maxLen = TELEGRAM_MESSAGE_MAX): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxLen) return [trimmed];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function formatMultipartBodies(text: string, maxLen: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const rough = splitTelegramMessages(trimmed, maxLen);
  if (rough.length === 1) return rough;
  const bodyMax = maxLen - TELEGRAM_PART_HEADER_SLACK;
  const parts = splitTelegramMessages(trimmed, bodyMax);
  return parts.map((p, i) => `[${i + 1}/${parts.length}]\n${p}`);
}

/** Split long text; prefix `[i/N]` when there is more than one part (each body ≤ limit). */
export function formatTelegramMultipartBodies(text: string): string[] {
  return formatMultipartBodies(text, TELEGRAM_MESSAGE_MAX);
}

/** Split for `sendRichMessage` (larger limit than classic sendMessage). */
export function formatTelegramRichMultipartBodies(text: string): string[] {
  return formatMultipartBodies(text, TELEGRAM_RICH_MESSAGE_MAX);
}

export async function telegramSendMessage(
  token: string,
  chatId: string,
  text: string,
  fetchFn: TelegramFetch = fetch
): Promise<void> {
  await telegramApiPost(token, "sendMessage", { chat_id: chatId, text }, fetchFn);
}

/** Send with HTML formatting; fall back to plain text when the API rejects parse (I-37). */
async function telegramSendMessageHtmlSingle(
  token: string,
  chatId: string,
  text: string,
  fetchFn: TelegramFetch = fetch
): Promise<void> {
  const html = formatTelegramHtml(text);
  if (!telegramHtmlDiffers(text, html)) {
    await telegramSendMessage(token, chatId, text, fetchFn);
    return;
  }
  try {
    await telegramApiPost(
      token,
      "sendMessage",
      { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true },
      fetchFn
    );
  } catch {
    // Unbalanced tags after multipart split etc. — content over formatting.
    await telegramSendMessage(token, chatId, text, fetchFn);
  }
}

export async function telegramSendMessageHtml(
  token: string,
  chatId: string,
  text: string,
  fetchFn: TelegramFetch = fetch
): Promise<void> {
  const maxSingle = TELEGRAM_MESSAGE_MAX - TELEGRAM_PART_HEADER_SLACK;
  if (text.length > maxSingle) {
    for (const part of formatTelegramMultipartBodies(text)) {
      await telegramSendMessageHtmlSingle(token, chatId, part, fetchFn);
    }
    return;
  }
  await telegramSendMessageHtmlSingle(token, chatId, text, fetchFn);
}

/** Bot API 10.1+ native markdown via `sendRichMessage`. */
export async function telegramSendMessageRich(
  token: string,
  chatId: string,
  text: string,
  fetchFn: TelegramFetch = fetch
): Promise<void> {
  await telegramApiPost(
    token,
    "sendRichMessage",
    { chat_id: chatId, rich_message: { markdown: text } },
    fetchFn
  );
}

/**
 * Rich markdown → HTML sendMessage → plain text.
 * Rich is preferred for agent output (headings, lists, blockquotes without MarkdownV2 escaping).
 */
export async function telegramSendFormattedMessage(
  token: string,
  chatId: string,
  text: string,
  fetchFn: TelegramFetch = fetch,
  format: TelegramMessageFormat = "rich"
): Promise<void> {
  if (format === "plain") {
    await telegramSendMessage(token, chatId, text, fetchFn);
    return;
  }
  if (format === "rich") {
    try {
      await telegramSendMessageRich(token, chatId, text, fetchFn);
      return;
    } catch {
      /* old Bot API or unsupported markup — fall through to HTML */
    }
  }
  await telegramSendMessageHtml(token, chatId, text, fetchFn);
}

/** Rich send with cascade to 4096 multipart HTML/plain when rich or HTML fails. */
async function telegramSendRichWithFallback(
  token: string,
  chatId: string,
  text: string,
  fetchFn: TelegramFetch = fetch
): Promise<number> {
  try {
    await telegramSendMessageRich(token, chatId, text, fetchFn);
    return 1;
  } catch {
    /* fall through to classic sendMessage limits */
  }
  const parts = formatTelegramMultipartBodies(text);
  for (const part of parts) {
    try {
      await telegramSendMessageHtmlSingle(token, chatId, part, fetchFn);
    } catch {
      await telegramSendMessage(token, chatId, part, fetchFn);
    }
  }
  return parts.length;
}

/** Send text as one or more Telegram messages (same chunking as cron digest). */
export async function telegramSendLongMessage(
  token: string,
  chatId: string,
  text: string,
  fetchFn: TelegramFetch = fetch,
  opts: { html?: boolean; format?: TelegramMessageFormat } = {}
): Promise<number> {
  const format = resolveTelegramSendFormat(opts);
  if (format === "plain") {
    const bodies = formatTelegramMultipartBodies(text);
    for (const body of bodies) await telegramSendMessage(token, chatId, body, fetchFn);
    return bodies.length;
  }
  if (format === "html") {
    const bodies = formatTelegramMultipartBodies(text);
    for (const body of bodies) await telegramSendMessageHtml(token, chatId, body, fetchFn);
    return bodies.length;
  }
  const richBodies = formatTelegramRichMultipartBodies(text);
  let sent = 0;
  for (const body of richBodies) {
    sent += await telegramSendRichWithFallback(token, chatId, body, fetchFn);
  }
  return sent;
}

export async function telegramSendChatAction(
  token: string,
  chatId: string,
  action: "typing" | "cancel" = "typing",
  fetchFn: TelegramFetch = fetch
): Promise<void> {
  await telegramApiPost(token, "sendChatAction", { chat_id: chatId, action }, fetchFn);
}

export interface TelegramTypingLoop {
  stop(): void;
}

/** Keep Telegram "typing…" alive for long agent turns (expires after ~5s). */
export function startTelegramTypingLoop(
  token: string,
  chatId: string,
  fetchFn: TelegramFetch = fetch
): TelegramTypingLoop {
  let stopped = false;
  const ping = () => {
    if (stopped) return;
    void telegramSendChatAction(token, chatId, "typing", fetchFn).catch(() => {});
  };
  ping();
  const timer = setInterval(ping, TYPING_REFRESH_MS);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function toolEmoji(toolName: string, kind: ActivityDetail["kind"]): string {
  if (kind === "mcp") return "🔌";
  const n = toolName.toLowerCase();
  if (n.includes("shell") || n === "run_terminal_cmd") return "💻";
  if (n.includes("read")) return "📖";
  if (n.includes("write") || n.includes("edit")) return "✏️";
  if (n.includes("grep") || n.includes("glob") || n.includes("search")) return "🔍";
  return "⚙️";
}

/** Hermes-style one-liner for a tool call. */
export function formatTelegramToolProgressLine(activity: ActivityDetail): string {
  const toolName = activity.toolName?.trim() || activity.label?.trim() || "tool";
  const emoji = toolEmoji(toolName, activity.kind);
  const preview = (activity.command ?? "").trim().slice(0, TOOL_PREVIEW_MAX);
  if (preview) return `${emoji} ${toolName}: ${preview}`;
  return `${emoji} ${toolName}…`;
}

export interface TelegramToolProgressState {
  lastToolName: string | null;
  seenCallIds: Set<string>;
}

export function shouldEmitTelegramToolProgress(
  cfg: GatewayConfig,
  activity: ActivityDetail,
  state: TelegramToolProgressState
): boolean {
  if (!cfg.telegramShowToolProgress) return false;
  if (activity.phase !== "call") return false;
  if (activity.callId) {
    if (state.seenCallIds.has(activity.callId)) return false;
    state.seenCallIds.add(activity.callId);
  }
  if (cfg.telegramToolProgressMode === "new" && activity.toolName === state.lastToolName) {
    return false;
  }
  state.lastToolName = activity.toolName ?? null;
  return true;
}

export interface ProcessTelegramUpdateResult {
  handled: boolean;
  chatId?: string;
  reply?: string;
  /** Human/log detail for the failure (never matched against — see errorKind). */
  error?: string;
  /** Typed failure classification driving the user-facing reply. */
  errorKind?: GatewayFailureKind;
  /** Silently dropped (no chat reply) — e.g. unauthorized group sender. Logged only. */
  ignored?: string;
}

export interface ProcessTelegramUpdateOptions {
  token: string;
  fetchFn?: TelegramFetch;
  dir?: string;
  /** Min ms between progress edits (tests set 0). */
  progressEditMinMs?: number;
}

/** Telegram tolerates ~1 edit/sec per chat; stay under it. */
export const TELEGRAM_PROGRESS_EDIT_MIN_MS = 1500;

/** Handle one Telegram update through the gateway router. */
export async function processTelegramUpdate(
  cfg: GatewayConfig,
  router: GatewaySessionRouter,
  update: TelegramUpdate,
  opts: ProcessTelegramUpdateOptions
): Promise<ProcessTelegramUpdateResult> {
  // Edits of already-processed messages must not re-fire the agent (H-12): a
  // typo fix on an old message would silently re-run a whole turn. The poll
  // loop still advances the offset past these updates.
  if (update.edited_message || update.edited_channel_post) {
    return { handled: false };
  }
  const msg = telegramInboundMessage(update);
  if (!msg?.text?.trim()) return { handled: false };
  const chatId = String(msg.chat.id);
  const dir = opts.dir ?? process.cwd();
  if (!isChatAllowed(cfg, chatId, dir)) {
    const pairing = tryRegisterPairing(dir, "telegram", chatId);
    return { handled: true, chatId, reply: pairing.message };
  }
  // Chat is allowlisted — now authorize the actor. In groups/channels the chat
  // id alone does not identify who is speaking (I-107). Drop silently to avoid
  // reply-spam when the bot sees every group message.
  const senderPolicy = authorizeTelegramSender(cfg, msg);
  if (!senderPolicy.ok) {
    return { handled: true, chatId, ignored: senderPolicy.reason };
  }
  const text = msg.text.trim();
  if (text.length > cfg.maxMessageLength) {
    return { handled: true, chatId, error: "message too long", errorKind: "message-too-long" };
  }
  if (router.isBusy(chatId)) {
    return { handled: true, chatId, error: "busy", errorKind: "busy" };
  }

  const token = opts.token;
  const fetchFn = opts.fetchFn ?? fetch;
  const quickCommand = text === "/new" || isGatewaySlashCommand(text);
  const typing =
    cfg.telegramShowTyping && !quickCommand
      ? startTelegramTypingLoop(token, chatId, fetchFn)
      : null;
  const toolState: TelegramToolProgressState = { lastToolName: null, seenCallIds: new Set() };

  // One self-updating progress message per turn (I-37): first tool call sends
  // it, later calls edit it (rate-limited). Serial chain keeps send-before-edit.
  const editMinMs = opts.progressEditMinMs ?? TELEGRAM_PROGRESS_EDIT_MIN_MS;
  let progressMessageId: number | null = null;
  let lastEditAt = 0;
  let pendingLine: string | null = null;
  let progressChain: Promise<void> = Promise.resolve();

  const pushProgress = (line: string): void => {
    pendingLine = line;
    progressChain = progressChain.then(async () => {
      const next = pendingLine;
      if (next == null) return;
      try {
        if (progressMessageId == null) {
          pendingLine = null;
          const sent = await telegramApiPost<{ message_id?: number }>(
            token,
            "sendMessage",
            { chat_id: chatId, text: next },
            fetchFn
          );
          progressMessageId = sent?.message_id ?? null;
          lastEditAt = Date.now();
          if (cfg.telegramShowTyping) {
            await telegramSendChatAction(token, chatId, "typing", fetchFn);
          }
          return;
        }
        if (Date.now() - lastEditAt < editMinMs) return; // keep pendingLine for a later call
        pendingLine = null;
        await telegramApiPost(
          token,
          "editMessageText",
          { chat_id: chatId, message_id: progressMessageId, text: next },
          fetchFn
        );
        lastEditAt = Date.now();
      } catch {
        /* non-fatal UX */
      }
    });
  };

  const flushProgress = async (): Promise<void> => {
    await progressChain;
    // Final state: make sure the last tool line landed even if rate-limited.
    if (pendingLine != null && progressMessageId != null) {
      const line = pendingLine;
      pendingLine = null;
      try {
        await telegramApiPost(
          token,
          "editMessageText",
          { chat_id: chatId, message_id: progressMessageId, text: line },
          fetchFn
        );
      } catch {
        /* non-fatal UX */
      }
    }
  };

  try {
    const { reply } = await router.handleInbound(chatId, text, {
      onActivity: (activity) => {
        if (!shouldEmitTelegramToolProgress(cfg, activity, toolState)) return;
        pushProgress(formatTelegramToolProgressLine(activity));
      },
    });
    await flushProgress();
    return { handled: true, chatId, reply };
  } catch (e) {
    await flushProgress();
    return {
      handled: true,
      chatId,
      error: e instanceof Error ? e.message : String(e),
      errorKind: classifyGatewayFailure(e),
    };
  } finally {
    typing?.stop();
  }
}

export interface TelegramPoller {
  stop(): Promise<void>;
}

export interface TelegramPollerOptions {
  cfg: GatewayConfig;
  router: GatewaySessionRouter;
  dir?: string;
  fetchFn?: TelegramFetch;
  pollIntervalMs?: number;
  onLog?: ServiceLogSink;
}

/** Backoff for poll failures; honors Telegram `retry after N` seconds on 429. */
/** Scopes Hermes used to register — overwrite stale menu in each. */
const TELEGRAM_COMMAND_SCOPES = [
  { type: "default" },
  { type: "all_private_chats" },
  { type: "all_group_chats" },
] as const;

/** Push irida slash catalog to Telegram «/» menu (replaces Hermes leftovers). */
export async function syncTelegramBotCommands(
  token: string,
  fetchFn: TelegramFetch = fetch
): Promise<number> {
  const commands = gatewayTelegramBotCommands();
  for (const scope of TELEGRAM_COMMAND_SCOPES) {
    await telegramApiPost(token, "setMyCommands", { commands, scope }, fetchFn);
  }
  return commands.length;
}

export function telegramPollRetryDelayMs(
  message: string,
  consecutiveErrors: number,
  pollMs: number,
  maxBackoffMs: number
): number {
  const m = message.match(/retry after (\d+)/i);
  if (m) {
    const sec = parseInt(m[1]!, 10);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(sec * 1000, maxBackoffMs);
    }
  }
  return Math.min(pollMs * 2 ** Math.max(0, consecutiveErrors - 1), maxBackoffMs);
}

export function startTelegramPoller(opts: TelegramPollerOptions): TelegramPoller {
  const dir = opts.dir ?? process.cwd();
  const token = telegramBotToken(opts.cfg, dir);
  if (!token) throw new Error(`telegram bot token env ${opts.cfg.telegramTokenEnv} is unset`);
  // Fail fast on corrupt tokens (postmortem 2026-06-12): hundreds of poll
  // "Not Found" errors hide the real cause — refuse to start instead.
  const tokenFmt = validateTelegramBotTokenFormat(token);
  if (!tokenFmt.ok) {
    throw new Error(
      `telegram bot token is invalid (${tokenFmt.detail}) — re-save: irida auth telegram login --stdin (or auth history / auth restore)`
    );
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const logInfo = (s: string) => emitServiceLog(s, "info", opts.onLog);
  const logError = (s: string) => emitServiceLog(s, "error", opts.onLog);
  const pollMs = opts.pollIntervalMs ?? opts.cfg.telegramPollIntervalMs;
  let offset = loadTelegramPollOffset(opts.dir ?? process.cwd());
  let running = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveErrors = 0;
  const maxBackoffMs = 60_000;
  let lastHeartbeatLog = Date.now();
  const heartbeatMs = 15 * 60 * 1000;
  /**
   * Per-chat droppable queues (I-138): the poll loop only enqueues — one slow
   * turn blocks neither other chats, nor getUpdates, nor outbox drain. Order
   * is preserved within a chat; /stop clears queued items and bumps the epoch
   * so the in-flight turn's reply is suppressed on completion.
   */
  interface ChatQueue {
    items: Array<{ u: TelegramUpdate; updateId: number }>;
    running: boolean;
    epoch: number;
    pump: Promise<void>;
  }
  const chatQueues = new Map<string, ChatQueue>();
  const MAX_PENDING_PER_CHAT = 5;
  let pollTicks = 0;
  const pollAliveEvery = Math.max(20, Math.floor(60_000 / Math.max(pollMs, 500)));
  let inflightTick: Promise<void> = Promise.resolve();

  const SEND_RETRY_DELAY_MS = 1500;

  /** Agent turn already ran — retry once, then park in the outbox (I-31). */
  const deliverWithRetry = async (chatId: string, text: string, formatted: boolean): Promise<void> => {
    const format = formatted ? opts.cfg.telegramMessageFormat : "plain";
    const send = async () => {
      if (formatted) {
        await telegramSendLongMessage(token, chatId, text, fetchFn, { format });
      } else {
        await telegramSendMessage(token, chatId, text, fetchFn);
      }
    };
    try {
      await send();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError(`[gateway] telegram send failed chat=${chatId}: ${msg}; retrying once`);
      await new Promise((r) => setTimeout(r, SEND_RETRY_DELAY_MS));
      try {
        await send();
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        try {
          const entry = enqueueOutbox(dir, { chatId, text, format: formatted ? format : "plain" });
          logError(`[gateway] telegram send parked in outbox chat=${chatId} id=${entry.id}: ${msg2}`);
          await sendOutboxParkAck(
            (ack) => telegramSendMessage(token, chatId, ack, fetchFn),
            logInfo,
            entry.id
          );
        } catch (e3) {
          logError(
            `[gateway] telegram reply LOST chat=${chatId}: ${msg2}; outbox failed: ${e3 instanceof Error ? e3.message : String(e3)}; replyPreview=${text.slice(0, 200)}`
          );
        }
      }
    }
  };

  /** Deliver parked messages; called from the poll loop (cheap when empty). */
  const drainParked = async (): Promise<void> => {
    try {
      const result = await drainOutbox(
        dir,
        async (entry) => {
          const format = resolveOutboxDeliveryFormat(entry);
          if (format === "plain") {
            await telegramSendLongMessage(token, entry.chatId, entry.text, fetchFn, { format: "plain" });
          } else {
            await telegramSendLongMessage(token, entry.chatId, entry.text, fetchFn, { format });
          }
        },
        {
          onDrop: (entry) =>
            logError(
              `[gateway] outbox DROP chat=${entry.chatId} attempts=${entry.attempts} preview=${entry.text.slice(0, 120)}`
            ),
        }
      );
      if (result.sent > 0 || result.dropped > 0) {
        logInfo(
          `[gateway] outbox drained sent=${result.sent} failed=${result.failed} dropped=${result.dropped} remaining=${result.remaining}`
        );
      }
    } catch (e) {
      logError(`[gateway] outbox drain error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleUpdate = async (u: TelegramUpdate, suppressed?: () => boolean): Promise<void> => {
    const result = await processTelegramUpdate(opts.cfg, opts.router, u, {
      token,
      fetchFn,
      dir: opts.dir,
    });
    if (!result.handled || !result.chatId) return;
    if (suppressed?.()) {
      // /stop arrived while this turn ran — cancellation is best-effort across
      // engines, and the queue epoch guarantees no stale reply escapes either way.
      logInfo(`[gateway] reply suppressed by /stop chat=${result.chatId}`);
      return;
    }
    if (result.ignored) {
      logError(`[gateway] telegram chat=${result.chatId} ignored: ${result.ignored}`);
      return;
    }
    if (result.reply) {
      await deliverWithRetry(result.chatId, result.reply, true);
    } else if (result.error) {
      logError(`[gateway] telegram chat=${result.chatId} error: ${result.error}`);
      const kind = result.errorKind ?? "internal";
      if (kind === "busy") {
        await deliverWithRetry(result.chatId, "Still working on your previous message…", false);
      } else if (kind === "chat-not-allowed") {
        await deliverWithRetry(result.chatId, "This chat is not allowlisted.", false);
      } else if (kind === "message-too-long") {
        await deliverWithRetry(result.chatId, "Message too long — please shorten it.", false);
      } else if (kind === "store-unavailable") {
        // Postgres/store down (postmortem 2026-06-18) — tell the user their
        // message was not processed instead of failing silently/generically.
        await deliverWithRetry(
          result.chatId,
          "Store temporarily unavailable — your message wasn't processed. Try again shortly.",
          false
        );
      } else if (kind === "context-overflow") {
        // This session's transcript outgrew the model's limit — every message
        // will keep failing the same way until the session is reset. Say so
        // instead of the generic "check gateway logs" (which the user can't act on).
        await deliverWithRetry(
          result.chatId,
          "This session's context grew too large for the model. Send /new to start a fresh session — your old messages stay in history.",
          false
        );
      } else {
        // Internal error details stay in the service log, not in the chat.
        await deliverWithRetry(result.chatId, "Something went wrong — check gateway logs.", false);
      }
    }
  };

  const getQueue = (chatId: string): ChatQueue => {
    let q = chatQueues.get(chatId);
    if (!q) {
      q = { items: [], running: false, epoch: 0, pump: Promise.resolve() };
      chatQueues.set(chatId, q);
    }
    return q;
  };

  const pumpQueue = (chatId: string, q: ChatQueue): void => {
    if (q.running) return;
    q.running = true;
    q.pump = (async () => {
      for (;;) {
        if (!running) break; // shutdown: leave items journaled for restart replay
        const item = q.items.shift();
        if (!item) break;
        const epochAtStart = q.epoch;
        try {
          await handleUpdate(item.u, () => q.epoch !== epochAtStart);
        } catch (e) {
          logError(
            `[gateway] telegram update failed chat=${chatId}: ${e instanceof Error ? e.message : String(e)}`
          );
        } finally {
          try {
            removeInflight(dir, item.updateId);
          } catch {
            /* journal is best-effort */
          }
        }
      }
      q.running = false;
    })();
  };

  const enqueueUpdate = (chatId: string, u: TelegramUpdate, from: "poll" | "journal"): void => {
    const q = getQueue(chatId);
    if (q.items.length >= MAX_PENDING_PER_CHAT) {
      logError(`[gateway] chat queue full chat=${chatId} — dropping update ${u.update_id}`);
      if (from === "journal") {
        try {
          removeInflight(dir, u.update_id);
        } catch {
          /* best-effort */
        }
      }
      void deliverWithRetry(chatId, "Очередь сообщений переполнена — дождись ответа на предыдущие.", false);
      return;
    }
    if (from === "poll") {
      try {
        addInflight(dir, { updateId: u.update_id, chatId, update: u, at: new Date().toISOString() });
      } catch (e) {
        // Crash-recovery aid only — never block handling on the journal.
        logError(`[gateway] inflight journal write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    q.items.push({ u, updateId: u.update_id });
    pumpQueue(chatId, q);
  };

  /** /stop must bypass the queue — inside it, it would wait behind the very turn it stops. */
  const isStopCommand = (u: TelegramUpdate): boolean => {
    const text = (u.message?.text ?? "").trim().toLowerCase();
    return text === "/stop" || text.startsWith("/stop@");
  };

  const handleStopBypass = async (chatId: string, u: TelegramUpdate): Promise<void> => {
    const msg = u.message;
    const authorized =
      msg && isChatAllowed(opts.cfg, chatId, opts.dir) && authorizeTelegramSender(opts.cfg, msg).ok;
    if (!authorized) {
      // Unauthorized /stop takes the normal path (pairing / ignore rules).
      enqueueUpdate(chatId, u, "poll");
      return;
    }
    const q = chatQueues.get(chatId);
    const droppedItems = q ? q.items.splice(0) : [];
    for (const item of droppedItems) {
      try {
        removeInflight(dir, item.updateId);
      } catch {
        /* best-effort */
      }
    }
    const hadRunningTurn = Boolean(q?.running);
    if (q) q.epoch++;
    let cancelled = false;
    if (hadRunningTurn) {
      try {
        cancelled = await opts.router.cancelActive(chatId);
      } catch (e) {
        logError(`[gateway] /stop cancel failed chat=${chatId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    logInfo(
      `[gateway] /stop chat=${chatId} inflight=${hadRunningTurn} cancelled=${cancelled} droppedQueued=${droppedItems.length}`
    );
    const ack = cancelled
      ? `⏹ Ок: текущий запрос остановлен${droppedItems.length ? `, очередь очищена (${droppedItems.length})` : ""}.`
      : hadRunningTurn
        ? `⏹ Ок: текущий ответ будет отброшен${droppedItems.length ? `, очередь очищена (${droppedItems.length})` : ""}.`
        : droppedItems.length
          ? `⏹ Очередь очищена (${droppedItems.length}).`
          : "Нечего прерывать — сейчас ничего не выполняется.";
    await deliverWithRetry(chatId, ack, false);
  };

  const tick = async () => {
    if (!running) return;
    let nextDelayMs = pollMs;
    await drainParked();
    try {
      const pollTimeoutSec = resolveTelegramGetUpdatesTimeoutSec(pollMs);
      const updates = await telegramGetUpdates(token, offset, pollTimeoutSec, fetchFn);
      consecutiveErrors = 0;
      pollTicks++;
      if (updates.length > 0) {
        logInfo(
          `[gateway] telegram updates=${updates.length} offset=${offset} types=${summarizeTelegramUpdateTypes(updates)}`
        );
      } else if (pollTicks % pollAliveEvery === 0) {
        logInfo(`[gateway] telegram poll alive offset=${offset}`);
      }
      if (Date.now() - lastHeartbeatLog >= heartbeatMs) {
        logInfo(`[gateway] telegram poll ok (heartbeat offset=${offset})`);
        lastHeartbeatLog = Date.now();
      }
      for (const u of updates) {
        if (!running) break;
        const chatId = telegramUpdateChatId(u);
        if (!chatId) {
          // Service updates without a chat are rare — handle inline.
          await handleUpdate(u).catch((e) =>
            logError(
              `[gateway] telegram update failed id=${u.update_id}: ${e instanceof Error ? e.message : String(e)}`
            )
          );
        } else if (isStopCommand(u)) {
          await handleStopBypass(chatId, u);
        } else {
          // Journaled BEFORE the offset ack below (I-138): the old code kept
          // at-least-once by awaiting each turn serially; now the journal
          // carries that guarantee and startup replays unhandled entries.
          enqueueUpdate(chatId, u, "poll");
        }
        offset = Math.max(offset, u.update_id + 1);
        saveTelegramPollOffset(opts.dir ?? process.cwd(), offset);
      }
    } catch (e) {
      consecutiveErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      nextDelayMs = telegramPollRetryDelayMs(msg, consecutiveErrors, pollMs, maxBackoffMs);
      logError(`[gateway] telegram poll error (#${consecutiveErrors}): ${msg}; retry in ${nextDelayMs}ms`);
    }
    if (running) {
      timer = setTimeout(() => {
        inflightTick = tick();
      }, nextDelayMs);
    }
  };

  logInfo(`[gateway] telegram long-poll started (interval=${pollMs}ms, offset=${offset})`);
  // Crash recovery (I-138): updates journaled but never finished re-enter their
  // chat queues in id order.
  try {
    const survivors = loadInflight(dir).sort((a, b) => a.updateId - b.updateId);
    if (survivors.length > 0) {
      logInfo(`[gateway] replaying ${survivors.length} in-flight update(s) from journal`);
      for (const s of survivors) enqueueUpdate(s.chatId, s.update as TelegramUpdate, "journal");
    }
  } catch (e) {
    logError(`[gateway] inflight replay failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  void syncTelegramBotCommands(token, fetchFn)
    .then((n) => logInfo(`[gateway] telegram setMyCommands OK (${n} cmds, ${TELEGRAM_COMMAND_SCOPES.length} scopes)`))
    .catch((e) =>
      logError(`[gateway] telegram setMyCommands failed: ${e instanceof Error ? e.message : String(e)}`)
    );
  inflightTick = tick();

  return {
    stop: async () => {
      running = false;
      if (timer) clearTimeout(timer);
      // Drain: finish the in-flight poll and all per-chat turns before the
      // caller disposes router sessions.
      await inflightTick.catch(() => {});
      // Pumps stop between items (`running` gate); unfinished items stay in
      // the journal and replay on the next start.
      await Promise.allSettled([...chatQueues.values()].map((q) => q.pump));
    },
  };
}
