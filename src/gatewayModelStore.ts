/**
 * Per-chat sticky model (I-174). A chat picks its model via the `/model` slash;
 * the choice survives gateway restarts and applies from the next message on.
 * Stored in `<stateDir>/gateway.models.json`, keyed by peerKey, modeled on
 * gatewayModeStore / gatewayEngineStore.
 *
 * Deliberately per-chat and NOT a config edit: `engine.model` in
 * agent.config.json is global, so writing it from Telegram would silently
 * change what the nightly cron digest runs on (and what it costs). A chat's
 * model is the chat's business.
 *
 * Unlike `/engine`, switching model does not need a new session — every engine
 * takes the model per turn — so the peer keeps its conversation.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type EngineProvider } from "./config.js";
import { writeFileAtomic } from "./util.js";
import { peerKey } from "./gatewayPeers.js";
import { iridaCodexHome } from "./engines/codexSdk.js";

export const GATEWAY_MODELS_FILE = "gateway.models.json";

export interface GatewayModelsFile {
  version: number;
  /** peerKey (adapter:chatId) → model id */
  models: Record<string, string>;
}

function modelsPath(dir: string): string {
  return resolve(dir, loadConfig(dir).stateDir, GATEWAY_MODELS_FILE);
}

export function loadGatewayModels(dir: string): GatewayModelsFile {
  const p = modelsPath(dir);
  if (!existsSync(p)) return { version: 1, models: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    const raw = parsed.models && typeof parsed.models === "object" ? parsed.models : {};
    const models: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && v.trim()) models[k] = v.trim();
    }
    return { version: 1, models };
  } catch {
    return { version: 1, models: {} };
  }
}

export function saveGatewayModels(dir: string, data: GatewayModelsFile): void {
  const p = modelsPath(dir);
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileAtomic(p, JSON.stringify({ version: 1, models: data.models }, null, 2) + "\n");
}

export function getChatModel(dir: string, adapter: string, chatId: string): string | undefined {
  return loadGatewayModels(dir).models[peerKey(adapter, chatId)];
}

export function setChatModel(dir: string, adapter: string, chatId: string, model: string): void {
  const file = loadGatewayModels(dir);
  file.models[peerKey(adapter, chatId)] = model.trim();
  saveGatewayModels(dir, file);
}

/** Clear a chat's sticky model. Returns true if one was set. */
export function clearChatModel(dir: string, adapter: string, chatId: string): boolean {
  const file = loadGatewayModels(dir);
  const key = peerKey(adapter, chatId);
  if (!(key in file.models)) return false;
  delete file.models[key];
  saveGatewayModels(dir, file);
  return true;
}

/**
 * Which engine a model id obviously belongs to, or null when the family is not
 * recognizable. Prefix-based on purpose: an allowlist of exact ids would go
 * stale every time a provider ships a model, and the failure it must prevent is
 * coarser than that — a model from the WRONG family.
 */
export function modelEngineFamily(model: string): EngineProvider | null {
  const m = model.trim().toLowerCase();
  if (!m) return null;
  if (m.startsWith("claude-")) return "claude-agent";
  if (m.startsWith("gpt-") || m.startsWith("codex-") || /^o[1-9]/.test(m)) return "codex";
  if (m.startsWith("composer") || m.startsWith("cursor")) return "cursor";
  return null;
}

/**
 * Reject a model that clearly belongs to a DIFFERENT engine; allow anything
 * whose family is unknown (a new id must not be locked out by our prefix list).
 *
 * This is the check that keeps `/model` from becoming a foot-gun: a cross-family
 * id is accepted by nothing and fails EVERY subsequent message — measured on the
 * live Codex CLI, which answers a Claude id with
 * `400 … not supported when using Codex with a ChatGPT account`.
 */
export function modelConflict(provider: EngineProvider, model: string): string | null {
  const family = modelEngineFamily(model);
  if (!family || family === provider) return null;
  return `модель «${model.trim()}» — от движка ${family}, а сейчас активен ${provider}`;
}

/** Verified model ids per engine, for the `/model` hint. Never a validator. */
const STATIC_SUGGESTIONS: Record<EngineProvider, string[]> = {
  "claude-agent": ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  codex: [],
  cursor: ["composer-2.5"],
};

/**
 * Model ids to offer for an engine. For codex the Codex CLI keeps a per-account
 * cache in its home, which is the honest list (it reflects THIS subscription);
 * anything else falls back to the static hint. Best-effort — a missing or
 * unreadable cache just yields fewer suggestions, never an error.
 */
export function suggestedModels(provider: EngineProvider): string[] {
  if (provider !== "codex") return STATIC_SUGGESTIONS[provider];
  try {
    const cachePath = resolve(iridaCodexHome(), "models_cache.json");
    if (!existsSync(cachePath)) return [];
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return [];
    return parsed.models
      .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>) : {}))
      // `visibility: "hide"` marks internals the user is not meant to pick
      // (e.g. codex-auto-review, the approval-review model) — offering them
      // would be offering a model that is not a chat model at all.
      .filter((m) => m.visibility !== "hide" && typeof m.slug === "string" && m.slug.trim())
      .map((m) => (m.slug as string).trim());
  } catch {
    return [];
  }
}
