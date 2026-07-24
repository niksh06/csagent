import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startTelegramPoller, type TelegramUpdate } from "../src/gatewayTelegram.js";
import { addInflight, loadInflight, removeInflight, INFLIGHT_MAX_ENTRIES } from "../src/gatewayInflight.js";
import { loadTelegramPollOffset } from "../src/gatewayTelegramOffset.js";
import { writeExampleGatewayConfig } from "./helpers/gatewayConfig.js";
import { GatewaySessionRouter } from "../src/gatewayRouter.js";
import type { RunLike, SdkLike, SdkCreateLike, SdkResumeLike, AgentLike } from "../src/host.js";

// I-138 (audit H-3): the poll loop used to `await` each chat's turn inline —
// one slow turn blocked getUpdates, every other chat, outbox drain, and the
// offset. These tests pin the new contract: non-blocking per-chat queues, an
// in-flight journal preserving at-least-once, and /stop.

function tmp(): string {
  return mkdtempSync(resolve(tmpdir(), "tg-conc-"));
}

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prevKey = process.env.CURSOR_API_KEY;
  const prevTok = process.env.TELEGRAM_BOT_TOKEN;
  process.env.CURSOR_API_KEY = "test-key";
  process.env.TELEGRAM_BOT_TOKEN = "1234567890:TESTTOKENTESTTOKENTESTTOKENTESTTOKE";
  try {
    return await fn();
  } finally {
    if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prevKey;
    if (prevTok === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevTok;
  }
}

/** SDK whose runs hang while the user message contains "slow" until released. */
function gatedSdk(state: { gate: Promise<void>; sends: string[] }): SdkLike & SdkCreateLike & SdkResumeLike {
  const agent = (): AgentLike => ({
    agentId: "tg-agent",
    send: async (m: string): Promise<RunLike> => {
      state.sends.push(m);
      const slow = m.includes("slow-marker");
      return {
        stream: async function* () {
          if (slow) await state.gate;
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: slow ? "slow-reply" : "fast-reply" }] },
          };
        },
        wait: async () => ({ status: "finished", id: "r" }),
      };
    },
  });
  return {
    prompt: async () => ({ status: "finished", result: "x", id: "r", agentId: "a" }),
    create: async () => agent(),
    resume: async () => agent(),
  };
}

interface SentMessage {
  chatId: string;
  text: string;
}

/** Capture text from sendMessage / sendRichMessage bodies; getUpdates feeds batches. */
function telegramFetchStub(batches: TelegramUpdate[][], sent: SentMessage[]) {
  let poll = 0;
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("getUpdates")) {
      const batch = batches[poll] ?? [];
      poll++;
      return new Response(JSON.stringify({ ok: true, result: batch }));
    }
    if (url.includes("sendMessage") || url.includes("sendRichMessage")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const rm = body.rich_message as { markdown?: unknown } | undefined;
      const text = typeof body.text === "string" ? body.text : String(rm?.markdown ?? "");
      sent.push({ chatId: String(body.chat_id), text });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };
}

function msgUpdate(updateId: number, chatId: number, text: string): TelegramUpdate {
  return { update_id: updateId, message: { message_id: updateId, chat: { id: chatId, type: "private" }, text } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("slow turn in one chat does not block another chat or the offset", async () => {
  await withEnv(async () => {
    const dir = tmp();
    const cfg = writeExampleGatewayConfig(dir, {
      adapter: "telegram",
      allowedChatIds: ["1", "2"],
      telegramPollIntervalMs: 500,
    });
    let release: () => void = () => {};
    const state = { gate: new Promise<void>((r) => (release = r)), sends: [] as string[] };
    const router = new GatewaySessionRouter({ dir, adapter: "telegram", sdk: gatedSdk(state) });
    const sent: SentMessage[] = [];
    const fetchFn = telegramFetchStub(
      [[msgUpdate(7, 1, "please slow-marker"), msgUpdate(8, 2, "fast question")]],
      sent
    );
    const poller = startTelegramPoller({ cfg, router, fetchFn, pollIntervalMs: 20, dir });
    await sleep(300);
    // Chat 2 answered while chat 1 still hangs; offset acked past BOTH updates.
    assert.ok(
      sent.some((s) => s.chatId === "2" && s.text.includes("fast-reply")),
      `chat 2 reply must not wait for chat 1; sent=${JSON.stringify(sent)}`
    );
    assert.ok(!sent.some((s) => s.text.includes("slow-reply")));
    assert.equal(loadTelegramPollOffset(dir), 9);
    // The hung update survives in the journal (crash would replay it).
    assert.deepEqual(loadInflight(dir).map((e) => e.updateId), [7]);
    release();
    await sleep(150);
    await poller.stop();
    await router.closeAll();
    assert.ok(sent.some((s) => s.chatId === "1" && s.text.includes("slow-reply")));
    assert.equal(loadInflight(dir).length, 0);
  });
});

test("inflight journal: add/remove/load and the cap", () => {
  const dir = tmp();
  addInflight(dir, { updateId: 2, chatId: "9", update: { update_id: 2 }, at: "2026-07-02T00:00:00Z" });
  addInflight(dir, { updateId: 1, chatId: "9", update: { update_id: 1 }, at: "2026-07-02T00:00:01Z" });
  assert.deepEqual(
    loadInflight(dir)
      .map((e) => e.updateId)
      .sort((a, b) => a - b),
    [1, 2]
  );
  removeInflight(dir, 2);
  assert.deepEqual(loadInflight(dir).map((e) => e.updateId), [1]);
  removeInflight(dir, 999); // unknown id is a no-op
  assert.equal(loadInflight(dir).length, 1);
  for (let i = 10; i < 10 + INFLIGHT_MAX_ENTRIES + 20; i++) {
    addInflight(dir, { updateId: i, chatId: "9", update: { update_id: i }, at: "2026-07-02T00:00:02Z" });
  }
  const entries = loadInflight(dir);
  assert.equal(entries.length, INFLIGHT_MAX_ENTRIES);
  // Oldest entries dropped first.
  assert.ok(!entries.some((e) => e.updateId === 1));
});

test("startup replays journaled updates that never finished", async () => {
  await withEnv(async () => {
    const dir = tmp();
    const cfg = writeExampleGatewayConfig(dir, {
      adapter: "telegram",
      allowedChatIds: ["99"],
      telegramPollIntervalMs: 500,
    });
    // Simulate a crash: a journaled update whose turn never completed.
    const u = msgUpdate(5, 99, "replay me");
    addInflight(dir, { updateId: 5, chatId: "99", update: u, at: "2026-07-02T00:00:00Z" });
    const state = { gate: Promise.resolve(), sends: [] as string[] };
    const router = new GatewaySessionRouter({ dir, adapter: "telegram", sdk: gatedSdk(state) });
    const sent: SentMessage[] = [];
    const fetchFn = telegramFetchStub([], sent); // getUpdates always empty
    const poller = startTelegramPoller({ cfg, router, fetchFn, pollIntervalMs: 20, dir });
    await sleep(250);
    await poller.stop();
    await router.closeAll();
    assert.ok(sent.some((s) => s.chatId === "99" && s.text.includes("fast-reply")));
    assert.equal(loadInflight(dir).length, 0);
  });
});

test("/stop bypasses the queue: cancels the active turn, clears pending, suppresses its reply", async () => {
  await withEnv(async () => {
    const dir = tmp();
    const cfg = writeExampleGatewayConfig(dir, {
      adapter: "telegram",
      allowedChatIds: ["1"],
      telegramPollIntervalMs: 500,
    });
    let release: () => void = () => {};
    const state = { gate: new Promise<void>((r) => (release = r)), sends: [] as string[] };
    const router = new GatewaySessionRouter({ dir, adapter: "telegram", sdk: gatedSdk(state) });
    let cancelCalls = 0;
    router.cancelActive = async (chatId) => {
      assert.equal(chatId, "1");
      cancelCalls++;
      release();
      return true;
    };
    const sent: SentMessage[] = [];
    const fetchFn = telegramFetchStub(
      [
        [msgUpdate(7, 1, "please slow-marker"), msgUpdate(8, 1, "queued question")],
        [msgUpdate(9, 1, "/stop")],
      ],
      sent
    );
    const poller = startTelegramPoller({ cfg, router, fetchFn, pollIntervalMs: 20, dir });
    await sleep(300);
    try {
      assert.equal(cancelCalls, 1);
      assert.ok(
        sent.some((s) => s.chatId === "1" && /текущий запрос остановлен/i.test(s.text)),
        `expected /stop ack; sent=${JSON.stringify(sent)}`
      );
    } finally {
      release();
      await sleep(150);
      await poller.stop();
      await router.closeAll();
    }
    // The hung turn's reply was suppressed; the queued update never ran.
    assert.ok(!sent.some((s) => s.text.includes("slow-reply")));
    assert.equal(state.sends.length, 1); // only the slow turn ever reached the SDK
    assert.equal(loadInflight(dir).length, 0);
  });
});

test("per-chat queue cap: overflow is dropped with a notice", async () => {
  await withEnv(async () => {
    const dir = tmp();
    const cfg = writeExampleGatewayConfig(dir, {
      adapter: "telegram",
      allowedChatIds: ["1"],
      telegramPollIntervalMs: 500,
    });
    let release: () => void = () => {};
    const state = { gate: new Promise<void>((r) => (release = r)), sends: [] as string[] };
    const router = new GatewaySessionRouter({ dir, adapter: "telegram", sdk: gatedSdk(state) });
    const sent: SentMessage[] = [];
    const batch = [msgUpdate(7, 1, "please slow-marker")];
    for (let i = 0; i < 7; i++) batch.push(msgUpdate(8 + i, 1, `queued ${i}`));
    const fetchFn = telegramFetchStub([batch], sent);
    const poller = startTelegramPoller({ cfg, router, fetchFn, pollIntervalMs: 20, dir });
    await sleep(250);
    assert.ok(
      sent.some((s) => s.chatId === "1" && /переполнена|очередь/i.test(s.text)),
      `expected overflow notice; sent=${JSON.stringify(sent.map((s) => s.text.slice(0, 40)))}`
    );
    release();
    await sleep(400);
    await poller.stop();
    await router.closeAll();
    // 1 slow + 5 queued (cap) reached the SDK; 2 overflow updates never did.
    assert.equal(state.sends.length, 6);
    assert.equal(loadInflight(dir).length, 0);
  });
});
