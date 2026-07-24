---
name: browser-ops
description: Use irida-browser MCP for live web pages; snapshot before acting; persist login sessions
tags: [browser, csagent, web]
---

Browser is **on-demand** via `irida-browser` MCP (`browser.mcp: true` in config). Do not describe pages you have not opened with tools.

## When to use

Use browser tools when the user asks to open a URL, check a live page, fill a form, verify UI, or complete a web login — not when a static answer or `memory_*` / repo tools suffice.

## Standard loop

1. `browser_navigate` → open the URL.
2. `browser_snapshot` → read url, title, text, and **refs** for interactive elements.
3. Act by ref: `browser_click`, `browser_type`, `browser_press_key` (e.g. Enter).
4. After each action that may change the page → `browser_snapshot` again before the next click/type.
5. When done → `browser_close`.

Never click or type without a fresh snapshot; refs are valid only for the page state that produced them.

## Login and sessions

For sites that need authentication or captcha:

1. Ensure `browser.headless` is `false` in config (headed window for manual steps if needed).
2. `browser_navigate` to the sign-in URL; guide the user through manual login if automation fails.
3. After successful login → `browser_save_session` with a profile name (e.g. `github`, `qwen`).
4. Next time → `browser_load_session` with that profile, then `browser_navigate`.

Cookies and Chromium profile live under `~/.irida/.agent/browser/` when `IRIDA_HOME` is set.

## Do not

- Guess page content, selectors, or element refs without `browser_snapshot`.
- Use shell/curl instead of browser when the task needs JS-rendered UI or an authenticated session.
- Leave the browser open after the task — call `browser_close`.
- Retry failed clicks blindly; snapshot again and pick the correct ref.
