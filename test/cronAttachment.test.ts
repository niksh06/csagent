/**
 * Cron jobs that deliver a FILE rather than a message (I-173): the TParser day
 * slice is ~250 KB, i.e. ~60 Telegram messages if it ever fell back to text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sendCronJobNotify } from "../src/cronNotify.js";
import { telegramSendDocument, TELEGRAM_CAPTION_MAX } from "../src/gatewayTelegram.js";
import { loadOutbox } from "../src/gatewayOutbox.js";
import type { CronJob } from "../src/cronJobs.js";
import type { CronExecuteResult } from "../src/cronRunRecord.js";

const JOB_ID = "tparser-day-slice";
const BODY = "# срез дня\n\n- пост\n";

function notifyDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "cron-attach-"));
  mkdirSync(join(dir, ".agent"), { recursive: true });
  writeFileSync(
    join(dir, "agent.config.json"),
    JSON.stringify({ stateDir: ".agent", cwd: dir }),
    "utf8"
  );
  return dir;
}

function attachJob(over: Partial<CronJob> = {}): CronJob {
  return {
    id: JOB_ID,
    cron: "59 23 * * *",
    notify: { chatId: "123456789", telegram: true, tokenEnv: "TELEGRAM_BOT_TOKEN" },
    ...over,
  };
}

function attachResult(over: Partial<CronExecuteResult> = {}): CronExecuteResult {
  return {
    ok: true,
    exitCode: 0,
    message: "tparser-day-slice: 552 post(s)",
    durationMs: 1200,
    attachment: {
      filename: "tparser-day-2026-07-27.md",
      content: BODY,
      caption: "📄 полный срез дня",
      contentType: "text/markdown; charset=utf-8",
    },
    ...over,
  };
}

async function withTelegramToken<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prev;
  }
}

test("telegramSendDocument uploads multipart with filename and caption", async () => {
  let seenUrl = "";
  let form: FormData | null = null;
  await telegramSendDocument(
    "tok",
    "42",
    { filename: "day.md", content: "содержимое", caption: "подпись" },
    async (url, init) => {
      seenUrl = url;
      form = init?.body as FormData;
      // Setting Content-Type by hand would break the multipart boundary.
      assert.equal((init?.headers as Record<string, string> | undefined)?.["Content-Type"], undefined);
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }
  );
  assert.match(seenUrl, /\/bottok\/sendDocument$/);
  assert.ok(form);
  assert.equal(form!.get("chat_id"), "42");
  assert.equal(form!.get("caption"), "подпись");
  const file = form!.get("document") as File;
  assert.equal(file.name, "day.md");
  assert.equal(await file.text(), "содержимое");
});

test("telegramSendDocument clips an over-long caption instead of failing the upload", async () => {
  let caption = "";
  await telegramSendDocument(
    "tok",
    "42",
    { filename: "day.md", content: "x", caption: "п".repeat(TELEGRAM_CAPTION_MAX + 500) },
    async (_url, init) => {
      caption = String((init?.body as FormData).get("caption"));
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }
  );
  assert.equal(caption.length, TELEGRAM_CAPTION_MAX);
});

test("telegramSendDocument surfaces an API-level rejection", async () => {
  await assert.rejects(
    () =>
      telegramSendDocument("tok", "42", { filename: "d.md", content: "x" }, async () =>
        new Response(JSON.stringify({ ok: false, description: "file too big" }))
      ),
    /file too big/
  );
});

test("attachment-only notify sends the file and no filler message", async () => {
  const dir = notifyDir();
  const calls: string[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };
  try {
    await withTelegramToken(() => sendCronJobNotify(attachJob(), attachResult(), new Date(), dir));
  } finally {
    globalThis.fetch = prevFetch;
  }
  assert.deepEqual(
    calls.map((u) => u.split("/").pop()),
    ["sendDocument"],
    "the caption already says everything — no '[cron:...] OK' message next to it"
  );
  const saved = resolve(dir, ".agent", `cron.attach.${JOB_ID}.tparser-day-2026-07-27.md`);
  assert.ok(existsSync(saved), "attachment is persisted before delivery is attempted");
  assert.equal(readFileSync(saved, "utf8"), BODY);
});

test("notify still sends output text alongside the attachment when a job has both", async () => {
  const dir = notifyDir();
  const calls: string[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url).split("/").pop()!);
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };
  try {
    await withTelegramToken(() =>
      sendCronJobNotify(attachJob(), attachResult({ output: "краткая сводка" }), new Date(), dir)
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
  assert.deepEqual(calls, ["sendRichMessage", "sendDocument"]);
});

test("a failed upload parks a pointer to the on-disk file instead of losing it", async () => {
  const dir = notifyDir();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/sendDocument")) throw new Error("network blip");
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };
  try {
    await withTelegramToken(() => sendCronJobNotify(attachJob(), attachResult(), new Date(), dir));
  } finally {
    globalThis.fetch = prevFetch;
  }
  const saved = resolve(dir, ".agent", `cron.attach.${JOB_ID}.tparser-day-2026-07-27.md`);
  assert.equal(readFileSync(saved, "utf8"), BODY, "the file survives the failed send");
  const parked = loadOutbox(dir).entries;
  assert.equal(parked.length, 1);
  assert.match(parked[0]!.text, /tparser-day-2026-07-27\.md не ушёл/);
  assert.ok(parked[0]!.text.includes(saved), "the parked notice says where the file is");
});

test("webhook notify names the file and its path — it cannot upload one", async () => {
  const dir = notifyDir();
  let payload: Record<string, unknown> = {};
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ ok: true }));
  };
  try {
    await sendCronJobNotify(
      attachJob({ notify: { chatId: "1", webhookUrl: "http://127.0.0.1:1/hook" } }),
      attachResult(),
      new Date(),
      dir
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
  const text = String(payload.text);
  assert.match(text, /полный срез дня/);
  assert.match(text, /cron\.attach\.tparser-day-slice\.tparser-day-2026-07-27\.md/);
});
