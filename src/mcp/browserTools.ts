/**
 * irida-browser MCP tool handlers (shared by stdio server and tests).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  captureSnapshot,
  clickRef,
  closeBrowser,
  ensureBrowser,
  loadSession,
  navigate,
  pressKey,
  saveSession,
  typeRef,
} from "../browser/manager.js";
import type { BrowserMcpContext } from "./browserContext.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Reject navigation targets that turn the browser into a local-file reader or
 * an SSRF primitive. Only http/https is allowed; cloud-metadata link-local is
 * blocked. Page/RSS content can steer the agent, so this must gate every nav.
 */
export function validateNavigateUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `invalid url: ${raw}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `blocked scheme '${parsed.protocol}' (only http/https allowed)` };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // Cloud-metadata / link-local — never a legitimate navigation target.
  if (host === "169.254.169.254" || host.startsWith("169.254.") || host === "metadata.google.internal") {
    return { ok: false, reason: `blocked link-local/metadata host: ${host}` };
  }
  return { ok: true, url: parsed.toString() };
}

function formatSnapshot(snap: Awaited<ReturnType<typeof captureSnapshot>>): string {
  const lines = [
    `url: ${snap.url}`,
    `title: ${snap.title}`,
    "",
    "elements:",
    ...snap.elements.map(
      (e) =>
        `[ref=${e.ref}] <${e.tag} role=${e.role}> name="${e.name}" value="${e.value}"`
    ),
    "",
    "text:",
    snap.text,
  ];
  return lines.join("\n");
}

export function registerBrowserMcpTools(server: McpServer, ctx: BrowserMcpContext): void {
  server.registerTool(
    "browser_navigate",
    {
      description: "Navigate the stealth browser to a URL.",
      inputSchema: {
        url: z.string().describe("Absolute URL"),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
          .optional()
          .describe("Navigation wait condition (default domcontentloaded)"),
      },
    },
    async ({ url, waitUntil }) => {
      const check = validateNavigateUrl(url);
      if (!check.ok) return textResult(`navigation blocked: ${check.reason}`);
      const page = await ensureBrowser({
        browserRoot: ctx.browserRoot,
        profile: ctx.profile,
        headless: ctx.headless,
        userAgent: ctx.userAgent,
        chromePath: ctx.chromePath,
      });
      await navigate(page, check.url, waitUntil ?? "domcontentloaded");
      const snap = await captureSnapshot(page);
      return textResult(`navigated\n\n${formatSnapshot(snap)}`);
    }
  );

  server.registerTool(
    "browser_snapshot",
    {
      description: "Capture current page URL, text excerpt, and interactive element refs.",
      inputSchema: {},
    },
    async () => {
      const page = await ensureBrowser({
        browserRoot: ctx.browserRoot,
        profile: ctx.profile,
        headless: ctx.headless,
        userAgent: ctx.userAgent,
        chromePath: ctx.chromePath,
      });
      const snap = await captureSnapshot(page);
      return textResult(formatSnapshot(snap));
    }
  );

  server.registerTool(
    "browser_click",
    {
      description: "Click an element by ref from the latest browser_snapshot.",
      inputSchema: {
        ref: z.number().int().min(1).describe("Element ref from snapshot"),
      },
    },
    async ({ ref }) => {
      const page = await ensureBrowser({
        browserRoot: ctx.browserRoot,
        profile: ctx.profile,
        headless: ctx.headless,
        userAgent: ctx.userAgent,
        chromePath: ctx.chromePath,
      });
      await clickRef(page, ref);
      const snap = await captureSnapshot(page);
      return textResult(`clicked ref=${ref}\n\n${formatSnapshot(snap)}`);
    }
  );

  server.registerTool(
    "browser_type",
    {
      description: "Type text into an input/textarea by ref from browser_snapshot.",
      inputSchema: {
        ref: z.number().int().min(1),
        text: z.string(),
        clear: z.boolean().optional().describe("Clear field before typing"),
      },
    },
    async ({ ref, text, clear }) => {
      const page = await ensureBrowser({
        browserRoot: ctx.browserRoot,
        profile: ctx.profile,
        headless: ctx.headless,
        userAgent: ctx.userAgent,
        chromePath: ctx.chromePath,
      });
      await typeRef(page, ref, text, clear ?? false);
      return textResult(`typed into ref=${ref}`);
    }
  );

  server.registerTool(
    "browser_press_key",
    {
      description: "Press a keyboard key in the browser (Enter, Tab, Escape, etc.).",
      inputSchema: {
        key: z.string().describe("Key name, e.g. Enter"),
      },
    },
    async ({ key }) => {
      const page = await ensureBrowser({
        browserRoot: ctx.browserRoot,
        profile: ctx.profile,
        headless: ctx.headless,
        userAgent: ctx.userAgent,
        chromePath: ctx.chromePath,
      });
      await pressKey(page, key);
      return textResult(`pressed ${key}`);
    }
  );

  server.registerTool(
    "browser_save_session",
    {
      description: "Save cookies for a named profile under ~/.csagent/.agent/browser/profiles/.",
      inputSchema: {
        profile: z.string().optional().describe("Profile name (default: active profile)"),
      },
    },
    async ({ profile }) => {
      const page = await ensureBrowser({
        browserRoot: ctx.browserRoot,
        profile: ctx.profile,
        headless: ctx.headless,
        userAgent: ctx.userAgent,
        chromePath: ctx.chromePath,
      });
      const name = profile?.trim() || ctx.profile;
      const path = await saveSession(page, ctx.browserRoot, name);
      return textResult(`saved session: ${path}`);
    }
  );

  server.registerTool(
    "browser_load_session",
    {
      description: "Load cookies from a named profile into the active browser.",
      inputSchema: {
        profile: z.string().optional().describe("Profile name (default: active profile)"),
      },
    },
    async ({ profile }) => {
      const page = await ensureBrowser({
        browserRoot: ctx.browserRoot,
        profile: ctx.profile,
        headless: ctx.headless,
        userAgent: ctx.userAgent,
        chromePath: ctx.chromePath,
      });
      const name = profile?.trim() || ctx.profile;
      const ok = await loadSession(page, ctx.browserRoot, name);
      if (!ok) return textResult(`no saved session for profile: ${name}`);
      const snap = await captureSnapshot(page);
      return textResult(`loaded session: ${name}\n\n${formatSnapshot(snap)}`);
    }
  );

  server.registerTool(
    "browser_close",
    {
      description: "Close the stealth browser process.",
      inputSchema: {},
    },
    async () => {
      await closeBrowser();
      return textResult("browser closed");
    }
  );
}
