#!/usr/bin/env node
/**
 * stdio MCP server: irida-browser stealth tools for Cursor SDK agents.
 */
import { loadIridaEnv } from "../loadEnv.js";
loadIridaEnv();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeBrowser } from "../browser/manager.js";
import { resolveBrowserMcpContext } from "./browserContext.js";
import { registerBrowserMcpTools } from "./browserTools.js";

async function main(): Promise<void> {
  const ctx = resolveBrowserMcpContext();
  const server = new McpServer(
    { name: "irida-browser", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  registerBrowserMcpTools(server, ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await closeBrowser().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
