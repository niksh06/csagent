import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeCronJob } from "../src/cronEngine.js";
import { loadCronJobs, saveCronJobs, type CronJob } from "../src/cronJobs.js";
import {
  buildDaySliceData,
  buildTparserDaySlice,
  daySliceFilename,
  daySliceTopCount,
  DAY_SLICE_CAPTION_MAX,
  DAY_SLICE_TOP_MAX,
  fetchTparserWindow,
  formatDaySliceCaption,
  formatDaySliceMarkdown,
  parseTparserPost,
  plural,
  readTparserToken,
  TPARSER_MAX_PAGES,
  TPARSER_PAGE_LIMIT,
  TparserDaySliceError,
  tparserPostLink,
  type TparserPost,
} from "../src/tparserDaySlice.js";

const TZ = "UTC";
const WINDOW_END = new Date("2026-07-27T12:00:00Z");
const WINDOW_START = new Date("2026-07-26T12:00:00Z");

function rawPost(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel_id: -1001639833661,
    post_id: 10878,
    channel_name: "GitHub Community",
    date: "2026-07-27 09:45:13+00:00",
    summary: "Представлен инструмент LiveAvatar для генерации видео.",
    message: "LiveAvatar — совместная разработка алгоритма и системы.",
    category: "AI",
    priority: 0.708,
    urls: "https://github.com/x/y|https://t.me/github",
    post_type: "tool",
    ...over,
  };
}

function post(over: Partial<TparserPost> = {}): TparserPost {
  return {
    channelId: -1001639833661,
    postId: 1,
    channelName: "Chan",
    date: new Date("2026-07-27T09:00:00Z"),
    summary: "Сводка поста.",
    message: "Тело поста.",
    category: "AI",
    priority: 0.5,
    urls: [],
    unanalysed: false,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("parseTparserPost normalizes the API row shape", () => {
  const p = parseTparserPost(rawPost());
  assert.ok(p);
  assert.equal(p.channelId, -1001639833661);
  assert.equal(p.category, "AI");
  assert.equal(p.priority, 0.708);
  // `2026-07-27 09:45:13+00:00` is not ISO until the space becomes a T.
  assert.equal(p.date.toISOString(), "2026-07-27T09:45:13.000Z");
  assert.deepEqual(p.urls, ["https://github.com/x/y", "https://t.me/github"]);
  assert.equal(p.unanalysed, false);
});

test("parseTparserPost flags a post with no summary as unanalysed", () => {
  const p = parseTparserPost(rawPost({ summary: "", message: "", urls: "", category: "" }));
  assert.ok(p);
  assert.equal(p.unanalysed, true);
  assert.equal(p.category, "Без категории");
});

test("parseTparserPost rejects a row without a usable date", () => {
  assert.equal(parseTparserPost(rawPost({ date: "not-a-date" })), null);
  assert.equal(parseTparserPost(null), null);
});

test("tparserPostLink strips the -100 channel prefix", () => {
  assert.equal(tparserPostLink(-1001639833661, 10878), "https://t.me/c/1639833661/10878");
});

test("fetchTparserWindow pages until a short page and filters the window", async () => {
  const urls: string[] = [];
  let auth = "";
  const page = (offset: number, count: number) =>
    Array.from({ length: count }, (_, i) =>
      rawPost({ post_id: offset + i, date: "2026-07-27 09:00:00+00:00" })
    );
  const fetchFn = async (url: string, init?: RequestInit) => {
    urls.push(url);
    auth = String((init?.headers as Record<string, string>).Authorization);
    const offset = Number(new URL(url).searchParams.get("offset"));
    if (offset === 0) return jsonResponse({ posts: page(0, TPARSER_PAGE_LIMIT) });
    // Second page is short → pagination stops, and carries one out-of-window row.
    return jsonResponse({
      posts: [
        ...page(TPARSER_PAGE_LIMIT, 3),
        rawPost({ post_id: 9999, date: "2026-07-20 09:00:00+00:00" }),
      ],
    });
  };

  const out = await fetchTparserWindow({
    baseUrl: "http://tparser.test",
    token: "s3cret",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    fetchFn,
  });

  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]!).searchParams.get("offset"), String(TPARSER_PAGE_LIMIT));
  assert.equal(auth, "Bearer s3cret");
  // The token travels in the header only — never in the query string.
  assert.ok(!urls.some((u) => u.includes("s3cret")));
  assert.equal(out.fetched, TPARSER_PAGE_LIMIT + 4);
  assert.equal(out.posts.length, TPARSER_PAGE_LIMIT + 3, "out-of-window row dropped");
  assert.equal(out.truncated, false);
});

test("fetchTparserWindow drops repeated ids and reports truncation at the page cap", async () => {
  const fetchFn = async () =>
    jsonResponse({
      posts: Array.from({ length: TPARSER_PAGE_LIMIT }, () =>
        rawPost({ post_id: 7, date: "2026-07-27 09:00:00+00:00" })
      ),
    });
  const out = await fetchTparserWindow({
    baseUrl: "http://tparser.test",
    token: "t",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    fetchFn,
  });
  assert.equal(out.posts.length, 1, "same channel/post id counted once");
  assert.equal(out.fetched, TPARSER_PAGE_LIMIT * TPARSER_MAX_PAGES);
  assert.equal(out.truncated, true, "hitting the page cap must be visible");
});

test("fetchTparserWindow turns a non-200 into a typed error", async () => {
  await assert.rejects(
    () =>
      fetchTparserWindow({
        baseUrl: "http://tparser.test",
        token: "t",
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        fetchFn: async () => jsonResponse({ detail: "nope" }, 401),
      }),
    (e: unknown) => e instanceof TparserDaySliceError && /responded 401/.test((e as Error).message)
  );
});

test("buildDaySliceData buckets by category and isolates unanalysed posts", () => {
  const posts = [
    post({ postId: 1, category: "AI" }),
    post({ postId: 2, category: "AI Security", priority: 0.9 }),
    post({ postId: 3, category: "General News" }),
    post({ postId: 4, category: "Weather" }),
    post({ postId: 5, category: "General News", summary: "", unanalysed: true }),
  ];
  const data = buildDaySliceData(posts, WINDOW_START, WINDOW_END);

  const byId = new Map(data.topics.map((b) => [b.topic.id, b.posts.length]));
  assert.equal(byId.get("ai-ml"), 1);
  assert.equal(byId.get("aisec-mlsec"), 1);
  assert.equal(byId.get("infosec"), 0, "empty topics survive as empty buckets");
  assert.deepEqual(
    data.offTopic.map((b) => b.category).sort(),
    ["General News", "Weather"],
    "unmapped categories are off-topic, not dropped"
  );
  // The unanalysed post carries a DEFAULT category — it must not be counted as
  // an off-topic verdict TParser never made.
  assert.equal(data.unanalysed.length, 1);
  assert.equal(data.offTopic.find((b) => b.category === "General News")!.posts.length, 1);
  assert.equal(data.stats.posts, 5);
  assert.equal(data.stats.onTopic + data.stats.offTopic + data.stats.unanalysed, 5);
});

test("daySliceTopCount is a rank cut with floor, cap and a no-split floor", () => {
  assert.equal(daySliceTopCount(0), 0);
  assert.equal(daySliceTopCount(7), 0, "short bucket reads whole");
  assert.equal(daySliceTopCount(10), 3, "floor keeps a head visible");
  assert.equal(daySliceTopCount(60), 12);
  assert.equal(daySliceTopCount(1000), DAY_SLICE_TOP_MAX, "capped");
});

test("formatDaySliceMarkdown lists every post exactly once", () => {
  const posts = [
    ...Array.from({ length: 12 }, (_, i) =>
      post({ postId: 100 + i, category: "AI", priority: 0.9 - i * 0.01 })
    ),
    post({ postId: 200, category: "InfoSec", priority: 0.7 }),
    post({ postId: 300, category: "General Tech", priority: 0.4 }),
    post({ postId: 400, category: "General News", summary: "", message: "", unanalysed: true }),
  ];
  const data = buildDaySliceData(posts, WINDOW_START, WINDOW_END);
  const md = formatDaySliceMarkdown(data, { timeZone: TZ });

  for (const p of posts) {
    const link = tparserPostLink(p.channelId, p.postId);
    const hits = md.split(link).length - 1;
    assert.equal(hits, 1, `post ${p.postId} must appear exactly once (got ${hits})`);
  }
  assert.match(md, /\*\*Всего:\*\* 15 постов · по темам: 13 · вне тем: 1/);
  assert.match(md, /## ⏳ Не разобрано · 1/);
  assert.match(md, /### Топ · 3 из 12/);
  assert.ok(!md.includes("Пагинация упёрлась"), "no truncation warning on a complete window");
});

test("formatDaySliceMarkdown shouts when the window is incomplete", () => {
  const data = buildDaySliceData([post()], WINDOW_START, WINDOW_END, true);
  assert.match(formatDaySliceMarkdown(data, { timeZone: TZ }), /окно НЕПОЛНОЕ/);
});

test("formatDaySliceMarkdown keeps multi-line summaries on one list line", () => {
  const data = buildDaySliceData(
    [post({ summary: "Первая строка.\nВторая строка.\n\nТретья." })],
    WINDOW_START,
    WINDOW_END
  );
  const md = formatDaySliceMarkdown(data, { timeZone: TZ });
  const line = md.split("\n").find((l) => l.startsWith("- `"))!;
  assert.match(line, /Первая строка\. Вторая строка\. Третья\./);
});

test("formatDaySliceCaption stays inside the Telegram limit", () => {
  const posts = Array.from({ length: 400 }, (_, i) =>
    post({ postId: i, category: i % 2 ? "AI" : "InfoSec" })
  );
  const caption = formatDaySliceCaption(
    buildDaySliceData(posts, WINDOW_START, WINDOW_END),
    { timeZone: TZ }
  );
  assert.ok(caption.length <= DAY_SLICE_CAPTION_MAX, `${caption.length} chars`);
  assert.match(caption, /400 постов/);
  assert.match(caption, /охват окна 100%/);
});

test("plural agrees with Russian counts", () => {
  const p = (n: number) => `${n} ${plural(n, "пост", "поста", "постов")}`;
  assert.equal(p(1), "1 пост");
  assert.equal(p(2), "2 поста");
  assert.equal(p(5), "5 постов");
  assert.equal(p(11), "11 постов");
  assert.equal(p(21), "21 пост");
  assert.equal(p(552), "552 поста");
});

test("daySliceFilename is date-stamped and shell-safe", () => {
  assert.equal(daySliceFilename(WINDOW_END, TZ), "tparser-day-2026-07-27.md");
});

test("readTparserToken reads TParser's own .env and strips quotes", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "tparser-env-"));
  writeFileSync(resolve(dir, ".env"), 'OTHER=1\nAPI_AUTH_TOKEN="abc-123"\nMORE=2\n', "utf8");
  assert.equal(readTparserToken(dir), "abc-123");
  assert.equal(readTparserToken(mkdtempSync(resolve(tmpdir(), "tparser-noenv-"))), "");
});

test("buildTparserDaySlice fails loudly when no token is available", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "tparser-notok-"));
  await assert.rejects(
    () => buildTparserDaySlice({ cwd: dir, fetchFn: async () => jsonResponse({ posts: [] }) }),
    (e: unknown) => e instanceof TparserDaySliceError && /API_AUTH_TOKEN/.test((e as Error).message)
  );
});

test("buildTparserDaySlice renders markdown, caption and filename end to end", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "tparser-e2e-"));
  writeFileSync(resolve(dir, ".env"), "API_AUTH_TOKEN=tok\n", "utf8");
  const slice = await buildTparserDaySlice({
    cwd: dir,
    now: WINDOW_END,
    timeZone: TZ,
    baseUrl: "http://tparser.test",
    fetchFn: async () =>
      jsonResponse({
        posts: [
          rawPost({ post_id: 1, date: "2026-07-27 09:00:00+00:00" }),
          rawPost({ post_id: 2, date: "2026-07-27 10:00:00+00:00", category: "InfoSec" }),
          // Outside the 24h window — must not reach the file.
          rawPost({ post_id: 3, date: "2026-07-01 10:00:00+00:00" }),
        ],
      }),
  });
  assert.equal(slice.filename, "tparser-day-2026-07-27.md");
  assert.equal(slice.data.stats.posts, 2);
  assert.match(slice.markdown, /# TParser · срез дня · 27\.07\.2026/);
  assert.ok(slice.markdown.includes("https://t.me/c/1639833661/1"));
  assert.ok(!slice.markdown.includes("https://t.me/c/1639833661/3"));
  assert.match(slice.caption, /2 поста/);
});

// --- cron wiring -----------------------------------------------------------

function jobDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "tparser-job-"));
  mkdirSync(join(dir, ".agent"), { recursive: true });
  writeFileSync(
    join(dir, "agent.config.json"),
    JSON.stringify({ stateDir: ".agent", cwd: dir }),
    "utf8"
  );
  return dir;
}

const SLICE_JOB: CronJob = { id: "tparser-day-slice", cron: "59 23 * * *", builtin: "tparser-day-slice" };

async function withStubbedTparser<T>(
  posts: unknown[],
  fn: () => Promise<T>
): Promise<T> {
  const prevFetch = globalThis.fetch;
  const prevUrl = process.env.IRIDA_TPARSER_URL;
  const prevTok = process.env.IRIDA_TPARSER_TOKEN;
  process.env.IRIDA_TPARSER_URL = "http://tparser.test";
  process.env.IRIDA_TPARSER_TOKEN = "tok";
  globalThis.fetch = async () => jsonResponse({ posts });
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevUrl === undefined) delete process.env.IRIDA_TPARSER_URL;
    else process.env.IRIDA_TPARSER_URL = prevUrl;
    if (prevTok === undefined) delete process.env.IRIDA_TPARSER_TOKEN;
    else process.env.IRIDA_TPARSER_TOKEN = prevTok;
  }
}

test("cron.jobs.json accepts the tparser-day-slice builtin", () => {
  const dir = jobDir();
  saveCronJobs(dir, [SLICE_JOB]);
  assert.equal(loadCronJobs(dir)[0]!.builtin, "tparser-day-slice");
});

test("executeCronJob returns the day slice as an attachment, not as text", async () => {
  const dir = jobDir();
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const exec = await withStubbedTparser(
    [rawPost({ post_id: 1, date: `${now}+00:00` }), rawPost({ post_id: 2, date: `${now}+00:00` })],
    () => executeCronJob(SLICE_JOB, { dir, checkSafety: false })
  );
  assert.equal(exec.ok, true, exec.message);
  assert.equal(exec.output, undefined, "250 KB must never ride the text path");
  assert.match(exec.attachment!.filename, /^tparser-day-\d{4}-\d{2}-\d{2}\.md$/);
  assert.match(exec.attachment!.content, /# TParser · срез дня/);
  assert.match(exec.attachment!.caption!, /охват окна 100%/);
  assert.match(exec.message, /2 post\(s\)/);
});

test("executeCronJob fails loudly on an empty window — a day is never 0 posts", async () => {
  const dir = jobDir();
  const exec = await withStubbedTparser([], () =>
    executeCronJob(SLICE_JOB, { dir, checkSafety: false })
  );
  assert.equal(exec.ok, false);
  assert.match(exec.message, /0 posts in window/);
  assert.equal(exec.attachment, undefined);
});

test("executeCronJob reports an unreachable TParser instead of throwing", async () => {
  const dir = jobDir();
  const prevFetch = globalThis.fetch;
  const prevTok = process.env.IRIDA_TPARSER_TOKEN;
  process.env.IRIDA_TPARSER_TOKEN = "tok";
  globalThis.fetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8002");
  };
  try {
    const exec = await executeCronJob(SLICE_JOB, { dir, checkSafety: false });
    assert.equal(exec.ok, false);
    assert.match(exec.message, /tparser-day-slice failed: TParser API unreachable/);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevTok === undefined) delete process.env.IRIDA_TPARSER_TOKEN;
    else process.env.IRIDA_TPARSER_TOKEN = prevTok;
  }
});
