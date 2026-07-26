/**
 * Optional cron completion notifications (webhook or direct Telegram).
 */
import { resolveTelegramBotToken } from "./credentials.js";
import { telegramSendLongMessage, telegramSendMessage, type TelegramFetch } from "./gatewayTelegram.js";
import { enqueueOutbox, sendOutboxParkAck } from "./gatewayOutbox.js";
import type { CronJob } from "./cronJobs.js";
import {
  evaluateDigestQa,
  formatDigestQaAlert,
  saveDigestOutput,
  saveDigestQaResult,
  type DigestQaReport,
} from "./digestQa.js";
import { formatCronPostMortem, type CronExecuteResult } from "./cronRunRecord.js";

const httpFetch: TelegramFetch = (url, init) => globalThis.fetch(url, init);

export interface CronJobNotifyWebhook {
  mode: "webhook";
  chatId: string;
  webhookUrl: string;
  secretEnv: string;
}

export interface CronJobNotifyTelegram {
  mode: "telegram";
  chatId: string;
  tokenEnv: string;
}

export type CronJobNotifyTarget = CronJobNotifyWebhook | CronJobNotifyTelegram;

/** @deprecated use CronJobNotifyWebhook fields via resolveJobNotifyTarget */
export interface CronJobNotifyConfig {
  chatId: string;
  webhookUrl: string;
  secretEnv: string;
}

export interface CronNotifyPayload {
  jobId: string;
  ok: boolean;
  message: string;
  at: string;
}

export type CronNotifyHook = (payload: CronNotifyPayload) => void | Promise<void>;

export { TELEGRAM_MESSAGE_MAX, splitTelegramMessages } from "./gatewayTelegram.js";

let customHook: CronNotifyHook | null = null;

/** Tests or gateway may register an in-process hook. */
export function setCronNotifyHook(hook: CronNotifyHook | null): void {
  customHook = hook;
}

export function getCronNotifyHook(): CronNotifyHook | null {
  return customHook;
}

function resolveEnv(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function resolveJobNotifyTarget(job: CronJob): CronJobNotifyTarget | null {
  const n = job.notify;
  if (!n || typeof n !== "object") return null;
  const chatId = typeof n.chatId === "string" ? n.chatId.trim() : "";
  if (!chatId) return null;
  if (n.telegram === true) {
    const tokenEnv =
      (typeof n.tokenEnv === "string" ? n.tokenEnv.trim() : "") || "TELEGRAM_BOT_TOKEN";
    return { mode: "telegram", chatId, tokenEnv };
  }
  const webhookUrl =
    (typeof n.webhookUrl === "string" ? n.webhookUrl.trim() : "") ||
    resolveEnv("CRON_NOTIFY_WEBHOOK_URL");
  if (!webhookUrl) return null;
  const secretEnv =
    (typeof n.secretEnv === "string" ? n.secretEnv.trim() : "") || "GATEWAY_WEBHOOK_SECRET";
  return { mode: "webhook", chatId, webhookUrl, secretEnv };
}

/** @deprecated use resolveJobNotifyTarget */
export function resolveJobNotify(job: CronJob): CronJobNotifyConfig | null {
  const t = resolveJobNotifyTarget(job);
  if (!t || t.mode !== "webhook") return null;
  return { chatId: t.chatId, webhookUrl: t.webhookUrl, secretEnv: t.secretEnv };
}

/** Send digest QA alert to job notify target (telegram or webhook). */
export async function sendDigestQaAlertMessage(
  job: CronJob,
  report: DigestQaReport,
  dir: string,
  target: CronJobNotifyTarget,
  opts: { morning?: boolean } = {}
): Promise<void> {
  if (report.ok) return;
  const alert = formatDigestQaAlert(report, opts);
  try {
    if (target.mode === "telegram") {
      const token = resolveTelegramBotToken(dir, target.tokenEnv).value;
      if (!token) {
        console.error(`[cron] digest QA alert: ${target.tokenEnv} unset job=${job.id}`);
        return;
      }
      await telegramSendLongMessage(token, target.chatId, alert);
      return;
    }
    const secret = resolveEnv(target.secretEnv);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) headers["X-Gateway-Secret"] = secret;
    const res = await httpFetch(target.webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ chatId: target.chatId, text: alert }),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  } catch (e) {
    console.error(
      `[cron] digest QA alert failed job=${job.id}: ${e instanceof Error ? e.message : String(e)}`
    );
    // I-136: the alert channel exists FOR failures — park it like the notify
    // path does (I-31) instead of dropping; the gateway outbox drain delivers
    // it and self-monitor already watches the outbox.
    if (target.mode === "telegram") {
      try {
        enqueueOutbox(dir, { chatId: target.chatId, text: alert, format: "plain" });
        console.error(`[cron] digest QA alert parked in outbox job=${job.id}`);
      } catch {
        /* best-effort */
      }
    }
  }
}

async function sendDigestQaFollowUp(
  job: CronJob,
  exec: CronExecuteResult,
  at: Date,
  dir: string,
  target: CronJobNotifyTarget
): Promise<void> {
  if ((!job.topicDelegates && !job.recordDigest) || !exec.ok) return;
  const report = evaluateDigestQa(dir, job.id, at);
  saveDigestQaResult(dir, job.id, report);
  if (report.ok) {
    console.error(`[cron] digest QA pass job=${job.id}`);
    return;
  }
  console.error(`[cron] digest QA FAIL job=${job.id} — sending alert`);
  await sendDigestQaAlertMessage(job, report, dir, target);
}

function formatNotifyText(payload: CronNotifyPayload, exec: CronExecuteResult): string {
  if (exec.output?.trim()) return exec.output.trim();
  const status = payload.ok ? "OK" : "FAILED";
  return `[cron:${payload.jobId}] ${status}\n${payload.message.slice(0, 2000)}`;
}

interface TelegramNotifyPart {
  text: string;
  format: "rich" | "html" | "plain";
}

/** Park unsent Telegram parts for gateway outbox drain (I-31). */
function parkTelegramNotifyParts(
  dir: string,
  chatId: string,
  parts: TelegramNotifyPart[],
  fromIndex: number
): number {
  let parked = 0;
  for (let i = fromIndex; i < parts.length; i++) {
    const p = parts[i]!;
    try {
      enqueueOutbox(dir, { chatId, text: p.text, format: p.format });
      parked++;
    } catch {
      /* best-effort */
    }
  }
  return parked;
}

export async function sendCronJobNotify(
  job: CronJob,
  exec: CronExecuteResult,
  at: Date = new Date(),
  dir: string = process.cwd()
): Promise<void> {
  // Healthy-quiet script jobs (empty stdout) deliver nothing.
  if (exec.silent) return;
  const payload: CronNotifyPayload = {
    jobId: job.id,
    ok: exec.ok,
    message: exec.message,
    at: at.toISOString(),
  };
  if (customHook) {
    await customHook(payload);
    return;
  }
  const target = resolveJobNotifyTarget(job);
  if (!target) return;
  const text = formatNotifyText(payload, exec);
  if ((job.topicDelegates || job.recordDigest) && exec.output?.trim()) {
    saveDigestOutput(dir, job.id, exec.output);
  }
  const postMortem = job.topicDelegates || job.recordDigest ? formatCronPostMortem(job.id, exec, at) : "";
  try {
    if (target.mode === "telegram") {
      const token = resolveTelegramBotToken(dir, target.tokenEnv).value;
      if (!token) {
        console.error(`[cron] notify telegram: ${target.tokenEnv} unset job=${job.id}`);
        return;
      }
      const parts: TelegramNotifyPart[] = [];
      if (text) parts.push({ text, format: "rich" });
      if (postMortem) parts.push({ text: postMortem, format: "plain" });
      let nextIndex = 0;
      try {
        for (; nextIndex < parts.length; nextIndex++) {
          const p = parts[nextIndex]!;
          await telegramSendLongMessage(token, target.chatId, p.text, httpFetch, { format: p.format });
        }
        await sendDigestQaFollowUp(job, exec, at, dir, target);
      } catch (e) {
        console.error(
          `[cron] notify failed job=${job.id}: ${e instanceof Error ? e.message : String(e)}`
        );
        const parked = parkTelegramNotifyParts(dir, target.chatId, parts, nextIndex);
        if (parked > 0) {
          console.error(`[cron] notify parked in outbox job=${job.id} parts=${parked}`);
          await sendOutboxParkAck(
            (ack) => telegramSendMessage(token, target.chatId, ack, httpFetch),
            (line) => console.error(line)
          );
        }
      }
      return;
    }
    const secret = resolveEnv(target.secretEnv);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) headers["X-Gateway-Secret"] = secret;
    const webhookText = postMortem ? `${text}\n\n---\n\n${postMortem}` : text;
    const res = await httpFetch(target.webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ chatId: target.chatId, text: webhookText }),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
    await sendDigestQaFollowUp(job, exec, at, dir, target);
  } catch (e) {
    console.error(
      `[cron] notify failed job=${job.id}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
