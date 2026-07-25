/**
 * Connect an SDK agent to a stored session (live resume or transcript replay).
 * Shared by `irida resume` and TUI session picker.
 */
import {
  createSession,
  disposeAgent,
  resumeSession,
  StartupError,
  type AgentLike,
  type McpServers,
  type SdkCreateLike,
  type SdkResumeLike,
} from "./host.js";
import type { AgentConfig } from "./config.js";
import type { IStore, SessionRecord } from "./store.js";
import { redact } from "./redact.js";

export type ConnectMode = "resumed" | "replayed";

export interface ConnectResult {
  agent: AgentLike;
  mode: ConnectMode;
  /** Prepended to the first user turn when mode is replayed. */
  replayPrefix: string;
  liveResumeError: string;
}

export interface ConnectAgentOptions {
  /** Last chance to validate replay-only first-turn context before creating a fresh SDK agent. */
  beforeReplayCreate?: (context: { liveResumeError: string }) => Promise<void>;
}

export async function replayPreamble(
  store: IStore,
  sessionId: string,
  maxRuns = 10,
  maxChars = 24_000
): Promise<string> {
  const runs = (await store.listRuns(sessionId)).slice(-maxRuns);
  if (runs.length === 0) return "";
  let turns = runs
    .map((r) => `User: ${r.prompt_preview}\nAssistant: ${r.result_preview || "(no stored output)"}`)
    .join("\n\n");
  if (turns.length > maxChars) {
    turns = turns.slice(turns.length - maxChars);
    turns = "…(transcript truncated)\n\n" + turns;
  }
  return `Earlier in this session (transcript, may be truncated):\n\n${turns}\n\n`;
}

export async function connectAgentForSession(
  sdk: SdkResumeLike & SdkCreateLike,
  store: IStore,
  session: SessionRecord,
  cfg: AgentConfig,
  apiKey: string,
  mcpServers: McpServers,
  opts: ConnectAgentOptions = {}
): Promise<ConnectResult> {
  const cwd = session.cwd || cfg.cwd;
  let liveResumeError = "";

  if (session.sdk_agent_id) {
    try {
      const agent = await resumeSession(sdk, session.sdk_agent_id, apiKey, mcpServers, cfg.model, cwd);
      return { agent, mode: "resumed", replayPrefix: "", liveResumeError: "" };
    } catch (e) {
      liveResumeError = e instanceof StartupError ? e.message : String(e);
    }
  } else {
    liveResumeError = "no stored SDK agent id";
  }

  const redactedLiveResumeError = redact(liveResumeError);
  await opts.beforeReplayCreate?.({ liveResumeError: redactedLiveResumeError });

  const agent = await createSession(sdk, {
    apiKey,
    model: cfg.model,
    cwd,
    mcpServers,
  });
  try {
    return {
      agent,
      mode: "replayed",
      replayPrefix: await replayPreamble(store, session.id),
      liveResumeError: redactedLiveResumeError,
    };
  } catch (e) {
    await disposeAgent(agent);
    throw e;
  }
}
