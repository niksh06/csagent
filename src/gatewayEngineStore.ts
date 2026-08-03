/**
 * Per-chat SDK engine choice (I-143). A chat picks its engine via the /engine
 * slash; the choice is sticky (survives gateway restarts) and applies when the
 * peer's NEXT session opens — engines cannot be swapped inside a live SDK
 * session, so switching always goes through a session reset. Stored in
 * `<stateDir>/gateway.engines.json`, keyed by peerKey, modeled on
 * gatewayModeStore. The stored choice overrides agent.config.json's
 * engine.provider; `/engine off` returns to the config default.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, normalizeEngineProvider, type EngineProvider } from "./config.js";
import { writeFileAtomic } from "./util.js";
import { peerKey } from "./gatewayPeers.js";

export const GATEWAY_ENGINES_FILE = "gateway.engines.json";

export interface GatewayEnginesFile {
  version: number;
  /** peerKey (adapter:chatId) → engine provider */
  engines: Record<string, EngineProvider>;
}

/** Human-friendly aliases → provider id; null = not a valid engine name. */
export function parseEngineArg(arg: string): EngineProvider | null {
  return normalizeEngineProvider(arg);
}

function enginesPath(dir: string): string {
  return resolve(dir, loadConfig(dir).stateDir, GATEWAY_ENGINES_FILE);
}

export function loadGatewayEngines(dir: string): GatewayEnginesFile {
  const p = enginesPath(dir);
  if (!existsSync(p)) return { version: 1, engines: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    const raw = parsed.engines && typeof parsed.engines === "object" ? parsed.engines : {};
    const engines: Record<string, EngineProvider> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === "cursor" || v === "claude-agent" || v === "codex") engines[k] = v;
    }
    return { version: 1, engines };
  } catch {
    return { version: 1, engines: {} };
  }
}

function saveGatewayEngines(dir: string, data: GatewayEnginesFile): void {
  const p = enginesPath(dir);
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileAtomic(p, JSON.stringify({ version: 1, engines: data.engines }, null, 2) + "\n");
}

export function getChatEngine(dir: string, adapter: string, chatId: string): EngineProvider | undefined {
  return loadGatewayEngines(dir).engines[peerKey(adapter, chatId)];
}

export function setChatEngine(
  dir: string,
  adapter: string,
  chatId: string,
  engine: EngineProvider
): void {
  const file = loadGatewayEngines(dir);
  file.engines[peerKey(adapter, chatId)] = engine;
  saveGatewayEngines(dir, file);
}

/** Clear a chat's sticky engine. Returns true if one was set. */
export function clearChatEngine(dir: string, adapter: string, chatId: string): boolean {
  const file = loadGatewayEngines(dir);
  const key = peerKey(adapter, chatId);
  if (!(key in file.engines)) return false;
  delete file.engines[key];
  saveGatewayEngines(dir, file);
  return true;
}
