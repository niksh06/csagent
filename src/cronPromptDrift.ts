/**
 * Detect drift between runtime cron promptFile and canonical deploy/prompts (I-4).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { loadCronJobs, type CronJob } from "./cronJobs.js";
import { resolveCronPromptFilePath } from "./cronPrompt.js";
import { iridaRoot } from "./env.js";

function fileHash12(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
}

function canonicalDeployPromptPath(job: CronJob, configDir: string): string | null {
  const rel = job.promptFile?.trim();
  if (!rel) return null;
  const name = basename(rel);
  const candidates = [
    rel.startsWith("deploy/prompts/") ? rel : `deploy/prompts/${name}`,
  ];
  const roots = [
    iridaRoot(),
    configDir,
    resolve(configDir, ".."),
  ].filter(Boolean) as string[];

  for (const root of roots) {
    for (const candidate of candidates) {
      const p = isAbsolute(candidate) ? candidate : resolve(root, candidate);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export interface CronPromptDriftResult {
  ok: boolean;
  warnings: string[];
}

/** Non-fatal warnings; empty when cron file missing or all prompts aligned. */
export function gatherCronPromptDrift(configDir: string): CronPromptDriftResult {
  const warnings: string[] = [];
  let jobs: CronJob[];
  try {
    jobs = loadCronJobs(configDir);
  } catch {
    return { ok: true, warnings: [] };
  }

  for (const job of jobs) {
    // Builtin and script jobs run without a prompt — nothing to drift.
    if (job.builtin || job.script) continue;
    if (job.topicDelegates) {
      const topic = job.topicPromptFile?.trim();
      const synth = job.synthesizePromptFile?.trim();
      if (!topic || !synth) {
        warnings.push(`job '${job.id}': topicDelegates requires topicPromptFile and synthesizePromptFile`);
      }
      continue;
    }
    if (!job.promptFile?.trim()) {
      const len = job.prompt?.length ?? 0;
      if (len > 400 || job.id.includes("digest")) {
        warnings.push(
          `job '${job.id}': inline prompt (${len} chars) — prefer promptFile under deploy/prompts/`
        );
      }
      continue;
    }
    try {
      const runtimePath = resolveCronPromptFilePath(job, configDir);
      if (!existsSync(runtimePath)) {
        warnings.push(`job '${job.id}': promptFile not found (${runtimePath})`);
        continue;
      }
      const canonical = canonicalDeployPromptPath(job, configDir);
      if (canonical && resolve(runtimePath) !== resolve(canonical)) {
        const rHash = fileHash12(runtimePath);
        const cHash = fileHash12(canonical);
        if (rHash !== cHash) {
          warnings.push(
            `job '${job.id}': prompt drift runtime=${rHash} deploy=${cHash} — sync deploy/prompts or run setup-home`
          );
        }
      }
    } catch (e) {
      warnings.push(`job '${job.id}': ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { ok: warnings.length === 0, warnings };
}
