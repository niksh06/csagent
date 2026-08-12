import { redact } from "./redact.js";
import { StartupError } from "./host.js";

export interface FormattedSdkError {
  message: string;
  errorKind: string;
  /** When true, TUI stays interactive (e.g. re-login and retry). */
  recoverable: boolean;
  /** When true, chatEngine may dispose agent, create fresh handle, and retry turn once. */
  rotatable: boolean;
}

type ConnectDetail = {
  error?: string;
  details?: { title?: string; detail?: string; isRetryable?: boolean };
};

function parseConnectDetails(e: unknown): ConnectDetail | null {
  if (e == null || typeof e !== "object") return null;
  const details = (e as { details?: unknown[] }).details;
  if (!Array.isArray(details) || details.length === 0) return null;
  for (const item of details) {
    if (item == null || typeof item !== "object") continue;
    const debug = (item as { debug?: ConnectDetail }).debug;
    if (debug && typeof debug === "object") return debug;
  }
  return null;
}

function isAuthError(e: unknown, detail: ConnectDetail | null): boolean {
  if (detail?.error === "ERROR_NOT_LOGGED_IN") return true;
  const code = (e as { code?: number }).code;
  return code === 16; // Code.Unauthenticated
}

/** Normalize Cursor SDK / ConnectRPC failures for CLI and TUI. */
export function formatSdkError(e: unknown): FormattedSdkError {
  if (e instanceof StartupError) {
    return { message: redact(e.message), errorKind: "startup", recoverable: false, rotatable: false };
  }

  const detail = parseConnectDetails(e);
  const auth = isAuthError(e, detail);
  const raw = e instanceof Error ? e.message : String(e);

  // Codex CLI subprocess death. The SDK error carries only the first stderr
  // line ("Reading prompt from stdin..."), so the real cause (usage limit,
  // expired `codex login`) is invisible here — say what the likely causes are
  // and how to move instead of echoing the stub. Non-rotatable: the token pool
  // is Claude-side and cannot help a Codex subprocess.
  if (/Codex Exec exited with code \d+/i.test(raw)) {
    return {
      message: redact(
        `${raw.split("\n")[0]} — частые причины: исчерпан лимит ChatGPT Codex (chatgpt.com/codex/settings/usage) или протухшая сессия codex login. Обойти сейчас: /engine claude`
      ),
      errorKind: "sdk",
      recoverable: false,
      rotatable: false,
    };
  }

  // Transient capacity/permission errors — account/subscription bursts return
  // `403 Request not allowed`, plus 429/529/503/overloaded. Rotating the session
  // NEVER helps (the fresh agent hits the same upstream state) and just sheds
  // context + spawns a session. Mark non-rotatable + recoverable so chat retries
  // in place instead. (I-127)
  //
  // Checked FIRST, against the combined raw+structured text: a 529 can arrive as
  // a plain message OR a structured SDK error. The structured branch below would
  // otherwise classify it `sdk`/rotatable, so an overload burst (which a
  // subagent-heavy turn is the first to trip) cascades into rotation+failure that
  // the user sees as "tools/subagents are down" instead of a transient retry.
  const overloadText = [raw, detail?.details?.detail, detail?.details?.title, detail?.error]
    .filter(Boolean)
    .join(" ");
  if (!auth && isOverloadErrorText(overloadText)) {
    const body = detail?.details?.detail || detail?.details?.title || raw;
    return {
      message: redact(`Upstream busy — ${body}. Transient; retry shortly.`),
      errorKind: "overload",
      recoverable: true,
      rotatable: false,
    };
  }

  if (detail?.details?.detail || detail?.details?.title) {
    const title = detail.details.title ?? "SDK error";
    const body = detail.details.detail ?? "";
    const message = auth
      ? `Authentication failed — ${body || "log in to Cursor and refresh CURSOR_API_KEY"}`
      : body ? `${title}: ${body}` : title;
    return {
      message: redact(message),
      errorKind: auth ? "auth" : detail.error ?? "sdk",
      recoverable: auth || detail.details.isRetryable === true,
      rotatable: !auth,
    };
  }

  // Claude Agent SDK (claude-agent engine) surfaces failures as plain messages
  // from its bundled binary — no typed exceptions reach us, so auth failures are
  // classified heuristically. Marking them auth (recoverable, non-rotatable) stops
  // chat from rotating+retrying uselessly and gives the user a fix hint.
  if (!auth && isAuthErrorText(raw)) {
    return {
      message: redact(
        `Authentication failed — ${raw}. Set ANTHROPIC_API_KEY (auth=api-key), or run \`claude login\` / \`claude setup-token\` (auth=account).`
      ),
      errorKind: "auth",
      recoverable: true,
      rotatable: false,
    };
  }

  const message = redact(raw || "SDK request failed");
  return {
    message: auth ? `Authentication failed — ${message}` : message,
    errorKind: auth ? "auth" : "sdk",
    recoverable: auth,
    rotatable: !auth,
  };
}

/** True when sendTurn may rotate SDK agent and retry once (never for auth). */
export function isAgentRotatableError(e: unknown): boolean {
  return formatSdkError(e).rotatable;
}

/**
 * Transient capacity error text — 529/429/503, `403 Request not allowed`
 * (account bursts), overloaded/rate-limit variants. Single source for BOTH
 * delivery shapes: thrown exceptions (formatSdkError above) and run-RESULT
 * errors — the claude-agent engine surfaces upstream failures as `is_error`
 * result messages, so they reach chatEngine's `status:"error"` branch, never
 * the catch. Both paths must retry in place and never rotate (I-127/I-135).
 */
export function isOverloadErrorText(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\b(403 request not allowed|429|503|529)\b|overloaded|rate.?limit|too many requests|service unavailable/i.test(
    text
  );
}

/**
 * Auth-classified error text — same heuristic formatSdkError uses for thrown
 * exceptions, exported so the run-RESULT error path (chatEngine.ts, `is_error`
 * result messages never reach the catch) can recognize the same failures and
 * attempt a Claude OAuth token pool rotation (I-169) before giving up.
 *
 * `organization has disabled|ask your admin` added from a real I-169 pool
 * test (2026-07-18): an account-level org policy block ("Your organization
 * has disabled Claude subscription access for Claude Code") doesn't contain
 * any of "authentication/unauthorized/oauth/expired/..." at all — a token
 * pool exists precisely to fail over past exactly this kind of per-account
 * restriction, so it needs its own classification, not just literal
 * credential corruption/expiry.
 */
export function isAuthErrorText(text: string | null | undefined): boolean {
  if (!text) return false;
  return /invalid api key|authentication|unauthorized|\bnot logged in\b|oauth|\/login|expired|credit balance|organization has disabled|ask your admin/i.test(
    text
  );
}

/**
 * Context-window overflow — the session grew past what the model accepts.
 *
 * Distinct from overload (capacity, retry fixes it) and auth (credential, rotation
 * fixes it): nothing about the upstream is wrong, the CONVERSATION is too big. The
 * only cures are shedding history (`/compact`) or starting over. Classified
 * separately so the wedge can be handled with handoff+compact instead of falling
 * into the generic rotatable-error path, which silently swaps in a fresh agent and
 * replays only the last 4 turns — an unannounced amnesia for a long chat session.
 */
export function isContextOverflowErrorText(text: string | null | undefined): boolean {
  if (!text) return false;
  return /prompt is too long|input length and .{0,40}exceed context limit|context (window|length) (limit )?exceeded|exceeds the (maximum )?context/i.test(
    text
  );
}

/**
 * Bounded backoff for transient `overload` (529/429/503) retries (I-133): 5s, 15s.
 * Capacity errors are not fixed by rotating the session (I-127) — they just need
 * the upstream a moment to recover, so sendTurn retries the SAME turn in place.
 */
export const OVERLOAD_RETRY_DELAYS_MS = [5_000, 15_000];

/** Consume SDK run stream; swallow iterator cleanup rejections. */
export async function consumeRunStream(
  run: { stream?(): AsyncIterable<unknown> },
  onEvent: (ev: unknown) => void
): Promise<void> {
  if (typeof run.stream !== "function") return;
  const iter = run.stream()[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await iter.next();
      if (step.done) break;
      onEvent(step.value);
    }
  } finally {
    try {
      await iter.return?.();
    } catch {
      // Connect end-stream races can reject iterator.return(); already handled via next().
    }
  }
}
