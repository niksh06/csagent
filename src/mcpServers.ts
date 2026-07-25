/**
 * Merge user MCP servers with built-in csagent-memory and irida-browser.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { iridaHome, iridaRoot } from "./env.js";
import { DEFAULT_BROWSER_PROFILE } from "./browser/defaults.js";
import type { AgentConfig } from "./config.js";
import { resolveBrowserRoot } from "./mcp/browserContext.js";
import type { McpServers } from "./host.js";
import { pgUrl } from "./pg/pool.js";

export const MEMORY_MCP_NAME = "csagent-memory";
export const BROWSER_MCP_NAME = "irida-browser";
export const CRON_MCP_NAME = "csagent-cron";
export const ASK_MCP_NAME = "csagent-ask";
export const HOMEBASE_MCP_NAME = "csagent-homebase";

export interface McpResolveContext {
  gatewayChatId?: string;
  gatewayAdapter?: string;
}

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));

function memoryServerEntry(projectDir: string): { command: string; args: string[] } {
  const roots = [
    iridaRoot(),
    projectDir,
    join(CODE_ROOT, ".."),
  ].filter(Boolean) as string[];

  for (const root of roots) {
    const dist = join(root, "dist/mcp/memoryServer.js");
    if (existsSync(dist)) {
      return { command: process.execPath, args: [dist] };
    }
    const src = join(root, "src/mcp/memoryServer.ts");
    const tsx = join(root, "node_modules/.bin/tsx");
    if (existsSync(src) && existsSync(tsx)) {
      return { command: tsx, args: [src] };
    }
  }

  const fallback = join(CODE_ROOT, "mcp/memoryServer.js");
  return { command: process.execPath, args: [fallback] };
}

function browserServerEntry(projectDir: string): { command: string; args: string[] } {
  const roots = [
    iridaRoot(),
    projectDir,
    join(CODE_ROOT, ".."),
  ].filter(Boolean) as string[];

  for (const root of roots) {
    const dist = join(root, "dist/mcp/browserServer.js");
    if (existsSync(dist)) {
      return { command: process.execPath, args: [dist] };
    }
    const src = join(root, "src/mcp/browserServer.ts");
    const tsx = join(root, "node_modules/.bin/tsx");
    if (existsSync(src) && existsSync(tsx)) {
      return { command: tsx, args: [src] };
    }
  }

  const fallback = join(CODE_ROOT, "mcp/browserServer.js");
  return { command: process.execPath, args: [fallback] };
}

export function memoryMcpEnabled(cfg: AgentConfig): boolean {
  return cfg.memory?.mcp !== false;
}

function homebaseServerEntry(projectDir: string): { command: string; args: string[] } {
  const roots = [
    iridaRoot(),
    projectDir,
    join(CODE_ROOT, ".."),
  ].filter(Boolean) as string[];

  for (const root of roots) {
    const dist = join(root, "dist/mcp/homebaseServer.js");
    if (existsSync(dist)) {
      return { command: process.execPath, args: [dist] };
    }
    const src = join(root, "src/mcp/homebaseServer.ts");
    const tsx = join(root, "node_modules/.bin/tsx");
    if (existsSync(src) && existsSync(tsx)) {
      return { command: tsx, args: [src] };
    }
  }

  const fallback = join(CODE_ROOT, "mcp/homebaseServer.js");
  return { command: process.execPath, args: [fallback] };
}

export function homebaseMcpEnabled(cfg: AgentConfig): boolean {
  return cfg.homebase?.mcp !== false;
}

export function browserMcpEnabled(cfg: AgentConfig): boolean {
  return cfg.browser?.mcp === true;
}

function cronServerEntry(projectDir: string): { command: string; args: string[] } {
  const roots = [
    iridaRoot(),
    projectDir,
    join(CODE_ROOT, ".."),
  ].filter(Boolean) as string[];

  for (const root of roots) {
    const dist = join(root, "dist/mcp/cronServer.js");
    if (existsSync(dist)) {
      return { command: process.execPath, args: [dist] };
    }
    const src = join(root, "src/mcp/cronServer.ts");
    const tsx = join(root, "node_modules/.bin/tsx");
    if (existsSync(src) && existsSync(tsx)) {
      return { command: tsx, args: [src] };
    }
  }

  const fallback = join(CODE_ROOT, "mcp/cronServer.js");
  return { command: process.execPath, args: [fallback] };
}

export function cronMcpEnabled(cfg: AgentConfig, ctx: McpResolveContext = {}): boolean {
  return Boolean(ctx.gatewayChatId?.trim());
}

function askServerEntry(projectDir: string): { command: string; args: string[] } {
  const roots = [
    iridaRoot(),
    projectDir,
    join(CODE_ROOT, ".."),
  ].filter(Boolean) as string[];

  for (const root of roots) {
    const dist = join(root, "dist/mcp/askServer.js");
    if (existsSync(dist)) {
      return { command: process.execPath, args: [dist] };
    }
    const src = join(root, "src/mcp/askServer.ts");
    const tsx = join(root, "node_modules/.bin/tsx");
    if (existsSync(src) && existsSync(tsx)) {
      return { command: tsx, args: [src] };
    }
  }

  const fallback = join(CODE_ROOT, "mcp/askServer.js");
  return { command: process.execPath, args: [fallback] };
}

/** ask_user (I-125) is gateway-chat only — same gate as cron. */
export function askMcpEnabled(cfg: AgentConfig, ctx: McpResolveContext = {}): boolean {
  return Boolean(ctx.gatewayChatId?.trim());
}

/** MCP servers passed to Cursor SDK (includes built-ins unless disabled). */
export function resolveMcpServers(
  cfg: AgentConfig,
  projectDir: string,
  ctx: McpResolveContext = {}
): McpServers {
  const merged: McpServers = { ...cfg.mcpServers };
  const stateDir = resolve(projectDir, cfg.stateDir);
  // Env forwarded to child MCP servers when set.
  const dbUrl = pgUrl();
  const home = iridaHome();
  const withDbUrl = dbUrl ? { CSAGENT_DATABASE_URL: dbUrl } : {};
  const withHome = home ? { CSAGENT_HOME: home } : {};

  if (memoryMcpEnabled(cfg) && !(MEMORY_MCP_NAME in merged)) {
    const { command, args } = memoryServerEntry(projectDir);
    merged[MEMORY_MCP_NAME] = {
      command,
      args,
      env: {
        CSAGENT_MEMORY_DIR: resolve(projectDir),
        CSAGENT_STATE_DIR: stateDir,
        ...withHome,
        ...withDbUrl,
      },
    };
  }

  if (homebaseMcpEnabled(cfg) && !(HOMEBASE_MCP_NAME in merged)) {
    const { command, args } = homebaseServerEntry(projectDir);
    merged[HOMEBASE_MCP_NAME] = {
      command,
      args,
      env: {
        CSAGENT_MEMORY_DIR: resolve(projectDir),
        CSAGENT_STATE_DIR: stateDir,
        ...withHome,
      },
    };
  }

  if (browserMcpEnabled(cfg) && !(BROWSER_MCP_NAME in merged)) {
    const { command, args } = browserServerEntry(projectDir);
    const profile = cfg.browser?.profile?.trim() || DEFAULT_BROWSER_PROFILE;
    merged[BROWSER_MCP_NAME] = {
      command,
      args,
      env: {
        CSAGENT_MEMORY_DIR: resolve(projectDir),
        CSAGENT_BROWSER_ROOT: resolveBrowserRoot(projectDir),
        CSAGENT_BROWSER_PROFILE: profile,
        CSAGENT_BROWSER_HEADLESS: cfg.browser?.headless === false ? "false" : "true",
        ...(cfg.browser?.chromePath ? { CSAGENT_CHROME_PATH: cfg.browser.chromePath } : {}),
        ...withHome,
      },
    };
  }

  if (cronMcpEnabled(cfg, ctx) && !(CRON_MCP_NAME in merged)) {
    const { command, args } = cronServerEntry(projectDir);
    merged[CRON_MCP_NAME] = {
      command,
      args,
      env: {
        CSAGENT_MEMORY_DIR: resolve(projectDir),
        CSAGENT_STATE_DIR: stateDir,
        CSAGENT_GATEWAY_CHAT_ID: ctx.gatewayChatId!.trim(),
        CSAGENT_GATEWAY_ADAPTER: ctx.gatewayAdapter?.trim() || "telegram",
        ...withHome,
        ...withDbUrl,
      },
    };
  }

  if (askMcpEnabled(cfg, ctx) && !(ASK_MCP_NAME in merged)) {
    const { command, args } = askServerEntry(projectDir);
    merged[ASK_MCP_NAME] = {
      command,
      args,
      env: {
        CSAGENT_MEMORY_DIR: resolve(projectDir),
        CSAGENT_STATE_DIR: stateDir,
        CSAGENT_GATEWAY_CHAT_ID: ctx.gatewayChatId!.trim(),
        CSAGENT_GATEWAY_ADAPTER: ctx.gatewayAdapter?.trim() || "telegram",
        ...withHome,
        ...withDbUrl,
      },
    };
  }

  return merged;
}
