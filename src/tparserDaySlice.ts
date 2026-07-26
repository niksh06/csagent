/**
 * TParser "day slice" — the whole day rendered deterministically from the API,
 * with no model in the loop.
 *
 * The agent digest is a top-N selection by construction: ~40 items out of ~550
 * posts, i.e. 7% of the day. Prompt tuning cannot fix that — 550 posts do not
 * fit a Telegram message, and a model asked to read them all would burn an hour
 * and still drop most. This module does the other half of the job: every post
 * in the window, bucketed and linked, delivered as a file. Coverage is 100% by
 * construction precisely because nothing here decides what is interesting.
 *
 * No secrets are logged: the API token is read from TParser's own `.env` and
 * only ever travels in an Authorization header.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { iridaTparserToken, iridaTparserUrl } from "./env.js";
import {
  TPARSE_DAILY_TOPICS,
  TPARSER_CATEGORY_TO_TOPIC,
  topicShortTitle,
  type TparserTopic,
} from "./tparserTopics.js";

export const TPARSER_DEFAULT_BASE_URL = "http://127.0.0.1:8002";

/** Daily window (hours) the slice covers, ending at run time. */
export const TPARSER_DAY_SLICE_WINDOW_HOURS = 24;

/** `by-date-range` page size (the endpoint's own maximum). */
export const TPARSER_PAGE_LIMIT = 200;

/**
 * Pagination backstop. A day is ~550 posts; 20 pages is 4000. Hitting it means
 * something upstream changed, and the render says so instead of silently
 * shipping a partial day as if it were complete.
 */
export const TPARSER_MAX_PAGES = 20;

export const TPARSER_FETCH_TIMEOUT_MS = 30_000;

/**
 * Head of each topic, as a RANK cut rather than an absolute priority.
 *
 * A fixed threshold does not work here: TParser calibrates priority per
 * category, so on a real day ≥0.80 selected 26 of 42 AISec posts and 0 of 57
 * Programming ones — the section was either the whole topic or empty. Taking
 * the top fifth of each bucket gives every topic a readable head.
 */
export const DAY_SLICE_TOP_SHARE = 0.2;
export const DAY_SLICE_TOP_MIN = 3;
export const DAY_SLICE_TOP_MAX = 25;
/** Below this a bucket is short enough to read whole — no split. */
export const DAY_SLICE_SPLIT_MIN = 8;

/** Per-post text budget in the file (summary is ~200 chars at the median). */
export const DAY_SLICE_TEXT_MAX = 260;

/** Telegram caption limit for sendDocument. */
export const DAY_SLICE_CAPTION_MAX = 1024;

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
  urls: string[];
  /** True when TParser has not analysed the post yet (no summary). */
  unanalysed: boolean;
}

export interface DaySliceTopicBucket {
  topic: TparserTopic;
  posts: TparserPost[];
}

export interface DaySliceOffTopicBucket {
  category: string;
  posts: TparserPost[];
}

export interface DaySliceStats {
  posts: number;
  onTopic: number;
  offTopic: number;
  channels: number;
  unanalysed: number;
  /** Pagination hit TPARSER_MAX_PAGES — the window is incomplete. */
  truncated: boolean;
}

export interface DaySliceData {
  windowStart: Date;
  windowEnd: Date;
  topics: DaySliceTopicBucket[];
  offTopic: DaySliceOffTopicBucket[];
  /**
   * Posts TParser has not analysed yet. Kept out of the category buckets on
   * purpose: an unanalysed post carries the DEFAULT category "General News" and
   * the default priority 0.3152 (all 64 of them on the measured day), so filing
   * it as low-priority off-topic news would report a verdict nobody made.
   */
  unanalysed: TparserPost[];
  stats: DaySliceStats;
}

export class TparserDaySliceError extends Error {}

/**
 * Read TParser's `API_AUTH_TOKEN` from its own `.env`. The value is returned to
 * the caller for the Authorization header and never logged or embedded in a
 * command line (the digest prompt used to paste it into shell commands, which
 * is how it ended up in transcripts).
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
    urls,
    unanalysed: summary === "",
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
      throw new TparserDaySliceError(
        `TParser API unreachable at ${opts.baseUrl}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (!res.ok) {
      throw new TparserDaySliceError(`TParser API responded ${res.status} for by-date-range`);
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

/**
 * Importance first, newest first on ties.
 *
 * Deliberately NOT deduplicated. Measured on a real day (552 posts): exact-text
 * folding collapses nothing — each channel gets its own LLM-written summary, so
 * the texts differ — and token-set near-dup at Jaccard 0.45 merges 2% while
 * still missing the obvious clusters: seven channels covering one new law share
 * about a quarter of their vocabulary, not half. Reaching those needs
 * embeddings, and a threshold low enough to catch them starts merging unrelated
 * posts. So the slice reports every post and does not pretend otherwise.
 */
export function sortDaySlicePosts(posts: TparserPost[]): TparserPost[] {
  return [...posts].sort(
    (a, b) => b.priority - a.priority || b.date.getTime() - a.date.getTime()
  );
}

export function buildDaySliceData(
  posts: TparserPost[],
  windowStart: Date,
  windowEnd: Date,
  truncated = false
): DaySliceData {
  const onTopic = new Map<string, TparserPost[]>();
  const offTopic = new Map<string, TparserPost[]>();
  const unanalysed: TparserPost[] = [];
  for (const post of posts) {
    if (post.unanalysed) {
      unanalysed.push(post);
      continue;
    }
    const topicId = TPARSER_CATEGORY_TO_TOPIC[post.category];
    const target = topicId ? onTopic : offTopic;
    const key = topicId ?? post.category;
    const bucket = target.get(key);
    if (bucket) bucket.push(post);
    else target.set(key, [post]);
  }

  const topics: DaySliceTopicBucket[] = TPARSE_DAILY_TOPICS.map((topic) => ({
    topic,
    posts: sortDaySlicePosts(onTopic.get(topic.id) ?? []),
  }));
  const off: DaySliceOffTopicBucket[] = [...offTopic.entries()]
    .map(([category, list]) => ({ category, posts: sortDaySlicePosts(list) }))
    .sort((a, b) => b.posts.length - a.posts.length || a.category.localeCompare(b.category));

  const onTopicCount = topics.reduce((n, t) => n + t.posts.length, 0);
  const offTopicCount = off.reduce((n, t) => n + t.posts.length, 0);
  return {
    windowStart,
    windowEnd,
    topics,
    offTopic: off,
    unanalysed: [...unanalysed].sort((a, b) => b.date.getTime() - a.date.getTime()),
    stats: {
      posts: posts.length,
      onTopic: onTopicCount,
      offTopic: offTopicCount,
      channels: new Set(posts.map((p) => p.channelName)).size,
      unanalysed: unanalysed.length,
      truncated,
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

export function clipDaySliceText(text: string, max = DAY_SLICE_TEXT_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface DaySliceFormatOptions {
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

/** Russian count agreement — this file is read every morning; "552 постов" grates. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function postsWord(n: number): string {
  return `${n} ${plural(n, "пост", "поста", "постов")}`;
}

function postLine(post: TparserPost, timeZone: string): string {
  const text = clipDaySliceText(post.summary || post.message) || "(без текста)";
  const src = externalUrl(post);
  const links = [tparserPostLink(post.channelId, post.postId), src].filter(Boolean).join(" · ");
  return `- \`${post.priority.toFixed(2)}\` ${formatClock(post.date, timeZone)} · **${post.channelName}** — ${text} — ${links}`;
}

/** How many posts head this bucket (0 = bucket is short enough to not split). */
export function daySliceTopCount(total: number): number {
  if (total < DAY_SLICE_SPLIT_MIN) return 0;
  const share = Math.round(total * DAY_SLICE_TOP_SHARE);
  return Math.min(DAY_SLICE_TOP_MAX, Math.max(DAY_SLICE_TOP_MIN, share));
}

function postSection(posts: TparserPost[], timeZone: string): string[] {
  const topN = daySliceTopCount(posts.length);
  if (!topN) return [...posts.map((p) => postLine(p, timeZone)), ""];
  const head = posts.slice(0, topN);
  const rest = posts.slice(topN);
  const cut = head[head.length - 1]!.priority.toFixed(2);
  const lines = [
    `### Топ · ${head.length} из ${posts.length} (приоритет ≥ ${cut})`,
    "",
    ...head.map((p) => postLine(p, timeZone)),
    "",
  ];
  if (rest.length) {
    lines.push(`### Остальное · ${rest.length}`, "", ...rest.map((p) => postLine(p, timeZone)), "");
  }
  return lines;
}

/** Full day as Markdown — every post in the window, nothing dropped. */
export function formatDaySliceMarkdown(
  data: DaySliceData,
  opts: DaySliceFormatOptions = {}
): string {
  const tz = opts.timeZone ?? hostTimeZone();
  const s = data.stats;
  const lines: string[] = [
    `# TParser · срез дня · ${formatStamp(data.windowEnd, tz).slice(0, 10)}`,
    "",
    `**Окно:** ${formatStamp(data.windowStart, tz)} → ${formatStamp(data.windowEnd, tz)} (${tz})`,
    `**Всего:** ${postsWord(s.posts)} · по темам: ${s.onTopic} · вне тем: ${s.offTopic} · каналов: ${s.channels}`,
    "",
    "Полный срез окна: здесь **каждый** пост, отбора нет. Сортировка внутри разделов —",
    "по приоритету TParser, время рядом с каналом.",
  ];
  if (s.unanalysed) {
    lines.push(
      `⏳ ${postsWord(s.unanalysed)} TParser ещё не разобрал — вынесены в отдельный раздел внизу.`
    );
  }
  if (s.truncated) {
    lines.push(
      `⚠️ Пагинация упёрлась в ${TPARSER_MAX_PAGES} страниц — окно НЕПОЛНОЕ, часть дня не попала в файл.`
    );
  }
  lines.push("", "| Тема | Постов | В топе |", "| --- | ---: | ---: |");
  for (const bucket of data.topics) {
    lines.push(
      `| ${bucket.topic.title} | ${bucket.posts.length} | ${daySliceTopCount(bucket.posts.length) || "—"} |`
    );
  }
  for (const bucket of data.offTopic) {
    lines.push(
      `| _${bucket.category}_ (вне тем) | ${bucket.posts.length} | ${daySliceTopCount(bucket.posts.length) || "—"} |`
    );
  }

  for (const bucket of data.topics) {
    lines.push("", "---", "", `## ${bucket.topic.title} · ${bucket.posts.length}`, "");
    if (!bucket.posts.length) {
      lines.push("Нет постов за окно.", "");
      continue;
    }
    lines.push(...postSection(bucket.posts, tz));
  }

  for (const bucket of data.offTopic) {
    lines.push("", "---", "", `## ${bucket.category} · ${bucket.posts.length} · вне тем`, "");
    // Kept whole on purpose: about a third of the day lands outside the five
    // working topics, and dropping it silently would be a lie about coverage.
    lines.push("> Категория TParser за пределами пяти рабочих тем.", "");
    lines.push(...postSection(bucket.posts, tz));
  }

  if (data.unanalysed.length) {
    lines.push("", "---", "", `## ⏳ Не разобрано · ${data.unanalysed.length}`, "");
    lines.push(
      "TParser их принял, но ещё не проанализировал: тема и приоритет не проставлены.",
      "Ссылки рабочие. Если раздел растёт день ото дня — встал анализ, а не поток.",
      ""
    );
    for (const post of data.unanalysed) {
      const text = clipDaySliceText(post.message);
      const body = text ? ` — ${text}` : "";
      lines.push(
        `- ${formatClock(post.date, tz)} · **${post.channelName}**${body} — ${tparserPostLink(post.channelId, post.postId)}`
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Telegram caption for the document (hard-capped at the Bot API limit). */
export function formatDaySliceCaption(
  data: DaySliceData,
  opts: DaySliceFormatOptions = {}
): string {
  const tz = opts.timeZone ?? hostTimeZone();
  const s = data.stats;
  const perTopic = data.topics
    .map((b) => `${topicShortTitle(b.topic)} ${b.posts.length}`)
    .join(" · ");
  const lines = [
    `📄 TParser · полный срез дня · ${formatStamp(data.windowEnd, tz).slice(0, 10)}`,
    `${postsWord(s.posts)} из ${s.channels} ${plural(s.channels, "канала", "каналов", "каналов")} · охват окна 100%`,
    `По темам ${s.onTopic}: ${perTopic}`,
    `Вне тем: ${s.offTopic}${s.unanalysed ? ` · не разобрано: ${s.unanalysed}` : ""}`,
  ];
  if (s.truncated) lines.push("⚠️ окно неполное — пагинация упёрлась в лимит");
  const text = lines.join("\n");
  return text.length <= DAY_SLICE_CAPTION_MAX ? text : `${text.slice(0, DAY_SLICE_CAPTION_MAX - 1)}…`;
}

export function daySliceFilename(windowEnd: Date, timeZone?: string): string {
  const tz = timeZone ?? hostTimeZone();
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: tz,
  }).format(windowEnd);
  return `tparser-day-${parts}.md`;
}

export interface BuildDaySliceOptions {
  /** Working dir holding TParser's `.env` (the job's cwd). */
  cwd: string;
  windowHours?: number;
  now?: Date;
  fetchFn?: TparserFetch;
  timeZone?: string;
  baseUrl?: string;
  token?: string;
}

export interface TparserDaySlice {
  markdown: string;
  caption: string;
  filename: string;
  data: DaySliceData;
}

export async function buildTparserDaySlice(
  opts: BuildDaySliceOptions
): Promise<TparserDaySlice> {
  const token = opts.token ?? readTparserToken(opts.cwd);
  if (!token) {
    throw new TparserDaySliceError(
      `API_AUTH_TOKEN not found in ${resolve(opts.cwd, ".env")} (or IRIDA_TPARSER_TOKEN)`
    );
  }
  const windowEnd = opts.now ?? new Date();
  const hours = opts.windowHours ?? TPARSER_DAY_SLICE_WINDOW_HOURS;
  const windowStart = new Date(windowEnd.getTime() - hours * 3_600_000);
  const fetched = await fetchTparserWindow({
    baseUrl: opts.baseUrl ?? tparserBaseUrl(),
    token,
    windowStart,
    windowEnd,
    fetchFn: opts.fetchFn,
  });
  const data = buildDaySliceData(fetched.posts, windowStart, windowEnd, fetched.truncated);
  const fmt: DaySliceFormatOptions = opts.timeZone ? { timeZone: opts.timeZone } : {};
  return {
    markdown: formatDaySliceMarkdown(data, fmt),
    caption: formatDaySliceCaption(data, fmt),
    filename: daySliceFilename(windowEnd, opts.timeZone),
    data,
  };
}
