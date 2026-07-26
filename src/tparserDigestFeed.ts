/**
 * TParser digest feed — deterministic selection of what the daily digest covers.
 *
 * Division of labour: code decides WHAT is in the digest, the agent decides HOW
 * it reads. The model is bad at ranking 872 rows and good at writing a verdict;
 * asking it to do both is why coverage sat at 4.6% and why the counters in the
 * header could not be trusted.
 *
 * Selection is per topic and rank-based, never a global priority threshold —
 * TParser calibrates `priority` inside each category, measured over 5 full days
 * (4361 posts):
 *
 *   rubric        median  p90   max    posts/day
 *   AI            0.68    0.74  0.88   245
 *   AI Security   0.81    0.84  0.96    71
 *   InfoSec       0.79    0.85  0.97    66
 *   Programming   0.61    0.67  0.79    71   <- can never reach 0.80
 *   DevSecOps     0.80    0.84  0.92    22
 *
 * A global ">= 0.80 is important" cut deletes Programming entirely while taking
 * 58% of AI Security. The score is also clumped, not continuous: 306 AI posts
 * share exactly 0.683 and 296 share 0.708, so moving a threshold by 0.01 can
 * swing the result by 300 posts. Ranks are stable where thresholds are not.
 *
 * `urgency` and `post_type=alert` are carried as a separate must-include axis:
 * urgency has a median of 0.20 across the corpus (priority's is 0.68), so it
 * actually discriminates, and `alert` lands almost entirely in AISec + InfoSec.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { iridaTparserToken, iridaTparserUrl } from "./env.js";
import { scanThreatPatterns, PROMPT_THREAT_PATTERNS } from "./promptThreatScan.js";
import {
  TPARSE_DAILY_TOPICS,
  TPARSER_CATEGORY_TO_TOPIC,
  type TparserTopic,
} from "./tparserTopics.js";

export const TPARSER_DEFAULT_BASE_URL = "http://127.0.0.1:8002";

/** Window (hours) the feed covers, ending at run time. */
export const TPARSER_FEED_WINDOW_HOURS = 24;

/** `by-date-range` page size (the endpoint's own maximum). */
export const TPARSER_PAGE_LIMIT = 200;

/**
 * Pagination backstop. A day is ~870 posts; 20 pages is 4000. Hitting it means
 * something upstream changed, and the feed says so instead of quietly shipping
 * a partial day as a complete one.
 */
export const TPARSER_MAX_PAGES = 20;

export const TPARSER_FETCH_TIMEOUT_MS = 30_000;

/**
 * Per-topic quota: this share of the topic, never fewer than the floor, never
 * more than the cap. Measured on 5 days → 117 posts/day (13% of the raw flow,
 * 17% of the posts that have any text at all), ~16 KB of digest.
 */
export const DIGEST_TOPIC_SHARE = 0.15;
export const DIGEST_TOPIC_FLOOR = 10;
export const DIGEST_TOPIC_CAP = 45;

/** Must-include regardless of rank (alert type is included unconditionally). */
export const DIGEST_URGENCY_MIN = 0.7;

/** Per-post text budget inside the feed. */
export const FEED_TEXT_MAX = 320;

export type TparserFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface TparserPost {
  channelId: number;
  postId: number;
  channelName: string;
  /** Post timestamp (UTC from the API). */
  date: Date;
  summary: string;
  message: string;
  category: string;
  priority: number;
  urgency: number;
  postType: string;
  urls: string[];
  /**
   * No summary AND no message. Measured over 7 days: 995 of 996 posts with
   * `analysis_status != completed` are exactly this — media without a caption,
   * no urls, no tags. The share does not decay with age (17% of six-day-old
   * posts, 12% of today's), so it is not an analysis backlog: there is simply
   * nothing to analyse. Counted, never selected — they cannot be summarised.
   */
  empty: boolean;
}

export interface FeedTopicBucket {
  topic: TparserTopic;
  /** Everything in the window for this topic, rank-ordered. */
  all: TparserPost[];
  /** What the digest covers. */
  selected: TparserPost[];
  /** Selected because of alert/urgency rather than rank. */
  urgent: TparserPost[];
}

export interface FeedStats {
  total: number;
  empty: number;
  offTopic: number;
  onTopic: number;
  selected: number;
  urgent: number;
  channels: number;
  /** Posts whose text tripped an injection pattern and was redacted. */
  redacted: number;
  /** Pagination hit TPARSER_MAX_PAGES — the window is incomplete. */
  truncated: boolean;
  /** Selected as a share of everything that arrived. */
  coveragePct: number;
  /** Selected as a share of posts that have any text at all. */
  coverageReadablePct: number;
}

export interface DigestFeed {
  windowStart: Date;
  windowEnd: Date;
  topics: FeedTopicBucket[];
  /** Off-topic categories with counts only — not selected from. */
  offTopic: Array<{ category: string; count: number }>;
  stats: FeedStats;
}

export class TparserFeedError extends Error {}

/**
 * Read TParser's `API_AUTH_TOKEN` from its own `.env`. Returned for the
 * Authorization header and never logged or put on a command line — the digest
 * prompt used to paste it into shell commands, which is how it reached
 * transcripts in cleartext.
 */
export function readTparserToken(cwd: string): string {
  const fromEnv = iridaTparserToken();
  if (fromEnv) return fromEnv;
  const path = resolve(cwd, ".env");
  if (!existsSync(path)) return "";
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*API_AUTH_TOKEN\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    return m[1]!.trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

export function tparserBaseUrl(): string {
  return (iridaTparserUrl() ?? TPARSER_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** API dates come as `2026-07-26 21:45:13+00:00` — not ISO until the space goes. */
export function parseTparserDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const d = new Date(raw.trim().replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseTparserPost(raw: unknown): TparserPost | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const date = parseTparserDate(o.date);
  if (!date) return null;
  const summary = typeof o.summary === "string" ? o.summary.trim() : "";
  const message = typeof o.message === "string" ? o.message.trim() : "";
  const urls =
    typeof o.urls === "string"
      ? o.urls
          .split("|")
          .map((u) => u.trim())
          .filter((u) => /^https?:\/\//i.test(u))
      : [];
  return {
    channelId: parseNumber(o.channel_id),
    postId: parseNumber(o.post_id),
    channelName: (typeof o.channel_name === "string" ? o.channel_name.trim() : "") || "?",
    date,
    summary,
    message,
    category: (typeof o.category === "string" ? o.category.trim() : "") || "Без категории",
    priority: parseNumber(o.priority),
    urgency: parseNumber(o.urgency),
    postType: (typeof o.post_type === "string" ? o.post_type.trim() : "") || "news",
    urls,
    empty: summary === "" && message === "",
  };
}

export interface FetchTparserWindowOptions {
  baseUrl: string;
  token: string;
  windowStart: Date;
  windowEnd: Date;
  fetchFn?: TparserFetch;
}

export interface FetchTparserWindowResult {
  posts: TparserPost[];
  /** Rows returned by the API before the window filter (pagination sanity). */
  fetched: number;
  truncated: boolean;
}

/**
 * Page `by-date-range` over the window.
 *
 * `recent-live` is deliberately not used: its `after_rowid` is a forward
 * live-tail cursor (`WHERE seq > ?` with `ORDER BY rowid DESC`), so paging
 * backwards with it returns the same page forever — 101 requests once produced
 * 5050 rows containing 100 distinct posts.
 */
export async function fetchTparserWindow(
  opts: FetchTparserWindowOptions
): Promise<FetchTparserWindowResult> {
  const fetchFn = opts.fetchFn ?? ((u, i) => globalThis.fetch(u, i));
  // date_to is exclusive-ish server-side; +1 day covers the UTC boundary.
  const dateTo = new Date(opts.windowEnd.getTime() + 24 * 3_600_000);
  const posts: TparserPost[] = [];
  const seen = new Set<string>();
  let fetched = 0;
  let truncated = false;

  for (let page = 0; page < TPARSER_MAX_PAGES; page++) {
    const url =
      `${opts.baseUrl}/api/posts/by-date-range` +
      `?date_from=${utcDateKey(opts.windowStart)}&date_to=${utcDateKey(dateTo)}` +
      `&limit=${TPARSER_PAGE_LIMIT}&offset=${page * TPARSER_PAGE_LIMIT}`;
    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: { Authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout(TPARSER_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      throw new TparserFeedError(
        `TParser API unreachable at ${opts.baseUrl}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (!res.ok) {
      throw new TparserFeedError(`TParser API responded ${res.status} for by-date-range`);
    }
    const body = (await res.json()) as { posts?: unknown };
    const rows = Array.isArray(body.posts) ? body.posts : [];
    fetched += rows.length;
    for (const row of rows) {
      const post = parseTparserPost(row);
      if (!post) continue;
      if (post.date < opts.windowStart || post.date > opts.windowEnd) continue;
      const key = `${post.channelId}/${post.postId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      posts.push(post);
    }
    if (rows.length < TPARSER_PAGE_LIMIT) return { posts, fetched, truncated };
    truncated = page === TPARSER_MAX_PAGES - 1;
  }
  return { posts, fetched, truncated };
}

/** Alert or high urgency — always in the digest, whatever its rank. */
export function isUrgentPost(post: TparserPost): boolean {
  return post.postType === "alert" || post.urgency >= DIGEST_URGENCY_MIN;
}

/** How many posts this topic contributes by rank (before the urgent union). */
export function topicQuota(total: number): number {
  if (total <= 0) return 0;
  const share = Math.round(total * DIGEST_TOPIC_SHARE);
  return Math.min(DIGEST_TOPIC_CAP, Math.max(DIGEST_TOPIC_FLOOR, share), total);
}

function byRank(a: TparserPost, b: TparserPost): number {
  return b.priority - a.priority || b.urgency - a.urgency || b.date.getTime() - a.date.getTime();
}

export function buildDigestFeed(
  posts: TparserPost[],
  windowStart: Date,
  windowEnd: Date,
  truncated = false
): DigestFeed {
  const readable = posts.filter((p) => !p.empty);
  const byTopic = new Map<string, TparserPost[]>();
  const offCounts = new Map<string, number>();
  for (const post of readable) {
    const topicId = TPARSER_CATEGORY_TO_TOPIC[post.category];
    if (!topicId) {
      offCounts.set(post.category, (offCounts.get(post.category) ?? 0) + 1);
      continue;
    }
    const bucket = byTopic.get(topicId);
    if (bucket) bucket.push(post);
    else byTopic.set(topicId, [post]);
  }

  const topics: FeedTopicBucket[] = TPARSE_DAILY_TOPICS.map((topic) => {
    const all = [...(byTopic.get(topic.id) ?? [])].sort(byRank);
    const chosen = new Set(all.slice(0, topicQuota(all.length)));
    const urgent: TparserPost[] = [];
    for (const p of all) {
      if (!isUrgentPost(p)) continue;
      if (!chosen.has(p)) urgent.push(p);
      chosen.add(p);
    }
    return { topic, all, selected: all.filter((p) => chosen.has(p)), urgent };
  });

  const selected = topics.reduce((n, t) => n + t.selected.length, 0);
  const onTopic = topics.reduce((n, t) => n + t.all.length, 0);
  const offTopic = [...offCounts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  const readableCount = readable.length;
  return {
    windowStart,
    windowEnd,
    topics,
    offTopic,
    stats: {
      total: posts.length,
      empty: posts.length - readableCount,
      offTopic: readableCount - onTopic,
      onTopic,
      selected,
      urgent: topics.reduce((n, t) => n + t.selected.filter(isUrgentPost).length, 0),
      channels: new Set(posts.map((p) => p.channelName)).size,
      redacted: 0,
      truncated,
      coveragePct: posts.length ? Math.round((1000 * selected) / posts.length) / 10 : 0,
      coverageReadablePct: readableCount ? Math.round((1000 * selected) / readableCount) / 10 : 0,
    },
  };
}

export function tparserPostLink(channelId: number, postId: number): string {
  const short = String(channelId).replace(/^-100/, "").replace(/^-/, "");
  return `https://t.me/c/${short}/${postId}`;
}

function externalUrl(post: TparserPost): string | null {
  for (const u of post.urls) {
    if (/^https?:\/\/t\.me\//i.test(u)) continue;
    return u;
  }
  return null;
}

export function clipFeedText(text: string, max = FEED_TEXT_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Neutralise injection patterns in ONE post's text.
 *
 * The assembled cron prompt is scanned by `scanPromptText`, and a hit aborts
 * the whole job. That guard is right for the prompt file, but the feed carries
 * ~117 Telegram posts of untrusted text — including a daily stream of AISec
 * news *about* prompt injection. One unlucky quote would silently cancel the
 * entire nightly digest. Measured 0 hits in 5554 posts over 7 days, so this is
 * a latent trigger rather than a live one; redacting the field turns a total
 * outage into one visibly trimmed line.
 */
export function redactFeedText(text: string): { text: string; redacted: boolean } {
  if (!scanThreatPatterns(text).length) return { text, redacted: false };
  let out = text;
  for (const re of PROMPT_THREAT_PATTERNS) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    out = out.replace(new RegExp(re.source, flags), "[вырезано]");
  }
  return { text: out, redacted: true };
}

export interface FeedFormatOptions {
  /** IANA zone for displayed times; defaults to the host zone. */
  timeZone?: string;
}

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function formatClock(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(d);
}

function formatStamp(d: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  }).format(d);
  return `${date} ${formatClock(d, timeZone)}`;
}

/**
 * Render the feed for the agent.
 *
 * Every count the digest header must print is computed here and labelled, so
 * the model copies numbers instead of deriving them — the one job it reliably
 * got wrong.
 */
export function formatDigestFeed(feed: DigestFeed, opts: FeedFormatOptions = {}): string {
  const tz = opts.timeZone ?? hostTimeZone();
  const s = feed.stats;
  let redacted = 0;
  const lines: string[] = [
    `TPARSER FEED · окно ${formatStamp(feed.windowStart, tz)} → ${formatStamp(feed.windowEnd, tz)} (${tz})`,
    "",
    "СЧЁТЧИКИ ДЛЯ ШАПКИ ДАЙДЖЕСТА — копировать как есть, не пересчитывать:",
    `  total=${s.total}  selected=${s.selected}  coverage=${s.coveragePct}%  urgent=${s.urgent}`,
    `  offtopic=${s.offTopic}  media_no_text=${s.empty}  channels=${s.channels}`,
    "",
    `Отбор: топ-${Math.round(DIGEST_TOPIC_SHARE * 100)}% каждой темы по priority ` +
      `(не меньше ${DIGEST_TOPIC_FLOOR}, не больше ${DIGEST_TOPIC_CAP}), плюс ВСЕ alert и urgency≥${DIGEST_URGENCY_MIN}.`,
    "Порог по priority не используется: он несравним между темами (у Programming потолок 0.79,",
    "у AI Security медиана 0.81). Сопоставим только ранг внутри темы.",
  ];
  if (s.truncated) {
    lines.push(
      `ВНИМАНИЕ: пагинация упёрлась в ${TPARSER_MAX_PAGES} страниц — окно НЕПОЛНОЕ, скажи об этом в шапке.`
    );
  }
  if (feed.offTopic.length) {
    lines.push(
      "",
      `Вне тем (не отбирались): ${feed.offTopic.map((o) => `${o.category} ${o.count}`).join(" · ")}`
    );
  }
  lines.push(
    "",
    "Формат строки: [ID] p=priority u=urgency t=тип · время · канал · ссылка на пост · внешний источник.",
    "«!» в начале — alert или высокая срочность: такой пост обязан попасть в дайджест.",
    "Ссылки копировать посимвольно, не сочинять."
  );

  for (const bucket of feed.topics) {
    lines.push(
      "",
      `## ${bucket.topic.title} — отобрано ${bucket.selected.length} из ${bucket.all.length}`,
      ""
    );
    if (!bucket.selected.length) {
      lines.push("(нет постов за окно)");
      continue;
    }
    bucket.selected.forEach((post, i) => {
      const id = `${bucket.topic.id.toUpperCase()}-${String(i + 1).padStart(2, "0")}`;
      const flag = isUrgentPost(post) ? "!" : " ";
      const src = externalUrl(post);
      const body = redactFeedText(clipFeedText(post.summary || post.message));
      if (body.redacted) redacted += 1;
      lines.push(
        `${flag}[${id}] p=${post.priority.toFixed(2)} u=${post.urgency.toFixed(2)} t=${post.postType} · ` +
          `${formatClock(post.date, tz)} · ${post.channelName} · ` +
          `${tparserPostLink(post.channelId, post.postId)}${src ? ` · ${src}` : ""}`,
        `    ${body.text}`
      );
    });
  }

  feed.stats.redacted = redacted;
  if (redacted) {
    lines.push(
      "",
      `Примечание: у ${redacted} пост(ов) часть текста вырезана как совпавшая с injection-паттерном.`
    );
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export interface BuildDigestFeedOptions {
  /** Working dir holding TParser's `.env` (the job's cwd). */
  cwd: string;
  windowHours?: number;
  now?: Date;
  fetchFn?: TparserFetch;
  timeZone?: string;
  baseUrl?: string;
  token?: string;
}

export interface TparserDigestFeedResult {
  text: string;
  feed: DigestFeed;
}

export async function buildTparserDigestFeed(
  opts: BuildDigestFeedOptions
): Promise<TparserDigestFeedResult> {
  const token = opts.token ?? readTparserToken(opts.cwd);
  if (!token) {
    throw new TparserFeedError(
      `API_AUTH_TOKEN not found in ${resolve(opts.cwd, ".env")} (or IRIDA_TPARSER_TOKEN)`
    );
  }
  const windowEnd = opts.now ?? new Date();
  const hours = opts.windowHours ?? TPARSER_FEED_WINDOW_HOURS;
  const windowStart = new Date(windowEnd.getTime() - hours * 3_600_000);
  const fetched = await fetchTparserWindow({
    baseUrl: opts.baseUrl ?? tparserBaseUrl(),
    token,
    windowStart,
    windowEnd,
    fetchFn: opts.fetchFn,
  });
  const feed = buildDigestFeed(fetched.posts, windowStart, windowEnd, fetched.truncated);
  const text = formatDigestFeed(feed, opts.timeZone ? { timeZone: opts.timeZone } : {});
  return { text, feed };
}
