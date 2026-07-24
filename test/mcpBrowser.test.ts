import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { assertSafeProfileName, profileCookiesPath, saveCookies } from "../src/browser/session.js";
import { validateNavigateUrl } from "../src/mcp/browserTools.js";
import { BROWSER_MCP_NAME, resolveMcpServers } from "../src/mcpServers.js";
import { resolveBrowserMcpContext } from "../src/mcp/browserContext.js";
import { gatherDoctorChecks } from "../src/doctorChecks.js";

test("resolveMcpServers adds irida-browser when browser.mcp true", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "browser-mcp-"));
  writeFileSync(join(dir, "agent.config.json"), JSON.stringify({ browser: { mcp: true } }));
  const cfg = loadConfig(dir);
  const merged = resolveMcpServers(cfg, dir);
  assert.ok(BROWSER_MCP_NAME in merged);
  const entry = merged[BROWSER_MCP_NAME] as { command?: string; env?: Record<string, string> };
  assert.ok(entry.command);
  assert.equal(entry.env?.CSAGENT_BROWSER_PROFILE, "default");
  assert.equal(entry.env?.CSAGENT_BROWSER_HEADLESS, "true");
});

test("resolveMcpServers omits irida-browser by default", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "browser-off-"));
  const cfg = loadConfig(dir);
  assert.equal(BROWSER_MCP_NAME in resolveMcpServers(cfg, dir), false);
});

test("resolveBrowserMcpContext uses CSAGENT_HOME browser root", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "browser-ctx-"));
  const home = mkdtempSync(resolve(tmpdir(), "browser-home-"));
  const prevHome = process.env.CSAGENT_HOME;
  process.env.CSAGENT_HOME = home;
  try {
    const ctx = resolveBrowserMcpContext(dir);
    assert.equal(ctx.browserRoot, resolve(home, ".agent/browser"));
    assert.equal(ctx.headless, true);
  } finally {
    if (prevHome === undefined) delete process.env.CSAGENT_HOME;
    else process.env.CSAGENT_HOME = prevHome;
  }
});

test("saveCookies writes profile cookies file", async () => {
  const browserRoot = mkdtempSync(resolve(tmpdir(), "browser-sess-"));
  const fakePage = {
    cookies: async () => [{ name: "sid", value: "abc", domain: "example.com" }],
  };
  const path = await saveCookies(fakePage as never, browserRoot, "github");
  assert.equal(path, profileCookiesPath(browserRoot, "github"));
  const raw = JSON.parse(readFileSync(path, "utf8")) as Array<{ name: string }>;
  assert.equal(raw[0]?.name, "sid");
});

test("doctor reports browser profile when browser.mcp enabled", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "browser-doc-"));
  mkdirSync(join(dir, ".agent"), { recursive: true });
  writeFileSync(join(dir, "agent.config.json"), JSON.stringify({ browser: { mcp: true } }));
  const checks = gatherDoctorChecks(dir);
  const browserCheck = checks.find((c) => c.name === "browser profile");
  assert.ok(browserCheck);
  assert.equal(browserCheck.ok, true);
  assert.match(browserCheck.detail, /browser/);
});

test("validateNavigateUrl allows http/https, blocks file/scheme/metadata", () => {
  assert.equal(validateNavigateUrl("https://example.com/x").ok, true);
  assert.equal(validateNavigateUrl("http://example.com").ok, true);
  assert.equal(validateNavigateUrl("file:///etc/passwd").ok, false);
  assert.equal(validateNavigateUrl("javascript:alert(1)").ok, false);
  assert.equal(validateNavigateUrl("ftp://example.com").ok, false);
  assert.equal(validateNavigateUrl("not a url").ok, false);
  assert.equal(validateNavigateUrl("http://169.254.169.254/latest/meta-data").ok, false);
  assert.equal(validateNavigateUrl("http://metadata.google.internal/").ok, false);
});

test("assertSafeProfileName rejects path traversal in profile names", () => {
  assert.equal(assertSafeProfileName("default"), "default");
  assert.equal(assertSafeProfileName("work-1.2_x"), "work-1.2_x");
  assert.throws(() => assertSafeProfileName("../../etc"));
  assert.throws(() => assertSafeProfileName("a/b"));
  assert.throws(() => assertSafeProfileName(".."));
  assert.throws(() => assertSafeProfileName(""));
});
