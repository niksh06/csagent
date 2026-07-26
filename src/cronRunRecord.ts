/**
 * Cron run outcomes for post-mortem Telegram + /status (personal ops).
 */
import type { ExitCode } from "./exit.js";
import { saveCronContextArtifact } from "./cronContextArtifact.js";
import { mutateCronState, type CronJobLastResult } from "./cronJobs.js";

export interface CronTopicSummary {
  topicId: string;
  title: string;
  ok: boolean;
  summary: string;
}

export interface CronExecuteResult {
  ok: boolean;
  exitCode: ExitCode;
  message: string;
  /** Full agent output for notify (digest). */
  output?: string;
  durationMs?: number;
  topicSummaries?: CronTopicSummary[];
  /** Suppress notify delivery (script jobs with empty stdout = healthy-quiet). */
  silent?: boolean;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

export function formatCronPostMortem(
  jobId: string,
  exec: CronExecuteResult,
  at: Date = new Date()
): string {
  const status = exec.ok ? "OK" : "FAILED";
  const lines = [
    `📊 [cron:${jobId}] post-mortem`,
    `status: ${status}`,
    `duration: ${formatDurationMs(exec.durationMs ?? 0)}`,
  ];
  if (exec.topicSummaries?.length) {
    const ok = exec.topicSummaries.filter((t) => t.ok).length;
    const total = exec.topicSummaries.length;
    const ids = exec.topicSummaries
      .map((t) => (t.ok ? t.topicId : `${t.topicId}✗`))
      .join(", ");
    lines.push(`topics: ${ok}/${total} (${ids})`);
  }
  if (!exec.ok) {
    lines.push(`error: ${exec.message.slice(0, 300)}`);
  }
  lines.push(`at: ${at.toISOString()}`);
  return lines.join("\n");
}

export function buildCronJobLastResult(
  exec: CronExecuteResult,
  at: Date = new Date()
): CronJobLastResult {
  const topics = exec.topicSummaries;
  const result: CronJobLastResult = {
    at: at.toISOString(),
    ok: exec.ok,
    durationMs: exec.durationMs ?? 0,
    message: exec.message.slice(0, 500),
  };
  if (topics?.length) {
    result.topicOk = topics.filter((t) => t.ok).length;
    result.topicTotal = topics.length;
    result.topics = topics.map((t) => ({ id: t.topicId, title: t.title, ok: t.ok }));
  }
  return result;
}

export function saveCronJobResult(
  dir: string,
  jobId: string,
  exec: CronExecuteResult,
  at: Date = new Date()
): void {
  mutateCronState(dir, (s) => {
    s.lastResult = { ...s.lastResult, [jobId]: buildCronJobLastResult(exec, at) };
  });
  saveCronContextArtifact(dir, jobId, exec, at);
}

export function formatCronLastResultSummary(jobId: string, r: CronJobLastResult): string {
  const status = r.ok ? "OK" : "FAIL";
  let detail = `${status} · ${formatDurationMs(r.durationMs)} · ${r.at.slice(0, 16).replace("T", " ")}`;
  if (r.topicTotal != null && r.topicOk != null) {
    detail += ` · topics ${r.topicOk}/${r.topicTotal}`;
  }
  if (r.qaOk === false) detail += ` · QA FAIL`;
  else if (r.qaOk === true) detail += ` · QA ok`;
  return detail;
}
