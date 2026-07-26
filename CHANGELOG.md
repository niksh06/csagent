# Changelog

All notable changes to **csagent** are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

- **Memory audit backlog (Wave F)** — `Reports/analysis/memory-audit-improvements-2026-06-16.md`; issues I-69…I-82 (P0–P2 hygiene/retrieval/eval)

### Security

- **Claude write envelopes now use the query workspace** — relative Write/Edit/Notebook paths are resolved from the Agent SDK query `cwd`, not the Irida process directory, closing both false denials and a fail-open when the allowed root happened to contain the launcher cwd. The headless `AskUserQuestion` steer is now enabled only when the gateway's `csagent-ask` MCP server is actually attached, so runs without that tool never point at a missing `ask_user` and otherwise retain their existing gating/bypass decision.
- **Claude auth isolation for parallel turns** — Agent SDK credentials now travel in each query's subprocess `env` instead of temporarily mutating global `process.env`. Concurrent gateway chats can no longer overwrite or restore one another's Anthropic API/OAuth credentials; API-key, account-token, and local `claude login` modes retain their existing precedence.
- **Tool-deny gate ON for autonomous surfaces (I-94/N5)** — `engine.toolPolicy.bySurface` now enables `denyDestructive` for `telegram` / `webhook` / `cron` (interactive `tui`/`cli` stay off — a human is present). The forked autonomous agents (gateway chat, cron digest/distill/consolidate/evolution) route tool calls through `canUseTool`, which allows normal work but blocks the destructive denylist (`rm -rf`, drop table, force-push, mkfs, fork-bomb) — defense-in-depth against prompt-injection from fetched web/file content. The earlier `canUseTool` ZodError (allow branch needed `updatedInput`) was fixed, so the gate runs clean; verified live (gated cron agent completed, normal read tools allowed). Shipped as the default in `agent.config.json`; a no-op on the cursor engine (which lacks tool hooks).

### Security

- **Irida agents no longer inherit the operator's personal `~/.claude`** — the Claude engine never set `settingSources`, and the SDK's documented default for the omitted option is "load every filesystem setting the CLI would". So every autonomous run — Telegram chat, cron, delegate — silently picked up the dev machine's MCP servers, `PreToolUse`/`SessionStart` hooks, and Bash permission allow-list. Measured on the live Telegram session: **14 MCP servers attached where Irida declares 5**, four of the inherited ones (`chrome-devtools`, `playwright`, `codegraph`, `context7`) reporting `failed` on *every* turn and burning the full 60s `MCP_TIMEOUT` first; `cbm` and `codebase-memory-mcp` are the same binary and were both being spawned. Net effect: a median of **65s per turn with no tools available at all**, and 15% of turns finishing before any tool arrived — which the agent itself described as its tools "flickering" all day. Now pinned to `['project']`: user scope is dropped, project scope stays so `CLAUDE.md` still loads for agents working inside the repo. External servers an Irida agent should have are declared in its own `mcpServers` config (prod: `cogit`, `engram`, `cbm`), so the toolset is Irida's decision rather than a side effect of whose machine it runs on. Verified end-to-end: 6 servers attached, zero leakage from `~/.claude`.

### Changed

- **Embedder model is baked into the image instead of mounted from the host (I-172)** — `irida-embedder` ran `HF_HUB_OFFLINE=1` on top of a **read-only** bind mount of `~/.cache/huggingface`, a combination that cannot self-heal: with the host cache empty the service can neither start nor download what it needs. An OrbStack restart on 2026-07-26 surfaced it — the cache had been cleared (this machine runs low on disk and gets cleaned by hand), the model had survived only in the running container's memory, and semantic memory search was down until the cache was rebuilt manually. Since autoRag now injects memory on every chat turn, that is a load-bearing service failing silently. The Dockerfile now downloads the weights at build time (`ARG EMBED_MODEL`, `HF_HOME=/opt/hf`, offline flags set only *after* the download) and the compose bind mount is gone — leaving it would have shadowed the baked model with the very directory that gets cleaned. Verified with `~/.cache/huggingface` entirely absent: container healthy, `/embed` returns a 768-dim vector, autoRag hits again. The host cache is still required by `engram` and `aleph-aleph-embedder-1`, so it must not be deleted.
- **`csagent-browser` MCP renamed to `irida-browser`** — continues the csagent→Irida rebrand; the constant, the stdio server's advertised name, and the `browser-ops` skill all move together.

### Added

- **Cogit belief brief on arrival** — the semantic half of the "briefing on arrival" the agent asked for: top-K current facts per project, shell-out to the cogit CLI, injected as a preTurn block before its first token. First turn only, and again right after a `/compact` — the two moments it wakes up — because unlike autoRag this slice does not depend on the user's message, so per-turn injection would be a pure context tax on a session that already overflows. The git half (homebase `arrive`) stays on-demand: the chat surface's cwd is `~/.irida`, which is not a repo, so an ambient `arrive` there would only ever report `not-a-repo`. Journal text is rendered with homebase's untrusted-data discipline (per-field clip, fenced block, explicit "not instructions" disclaimer, `scanPromptText` withhold) — it is agent-written and some of it summarises fetched web pages. Any journal failure degrades to no block, never a failed turn. Config: `memory.cogitBrief` (disabled unless `projects` is set); measured 2.5 KB in 640ms across three projects on the live journal.
- **Context overflow is now handoff + compact, not silent amnesia** — a chat session that outgrows the context window used to fall into the generic rotatable-error path: fresh SDK agent, last 4 run previews replayed, everything else dropped without a word to anyone (observed 8 times on the long-running Telegram session between 2026-07-08 and 07-23). `Prompt is too long` is now classified on its own (`isContextOverflowErrorText`) and handled before rotation — a durable handoff note is written from the run store with **no model call** (the one moment it is needed is the moment the context is too big to ask the model for anything), then `/compact` goes to the SDK verbatim so the session and the model's own summary survive, then the original turn is retried on the same agent. The note lands in the searchable `session-handoff` wing, so autoRag surfaces it on later turns. Once per turn; a failed compact degrades to the old rotation rather than a hard error. New `onSessionCompacted` callback lets a UI say so out loud.
- **autoRag/session-start memory no longer drop everything behind one fat note** — the injection loop `break`-ed on the first note over `maxChars`, so a single oversized top hit silently returned zero memory blocks with nothing in the prompt to indicate it (`src/autoRag.ts`, plus three sites in `sessionStartMemoryBlocks`). Oversized notes are now skipped, not fatal, and the autoRag log line reports `skipped=N`.
- **`deploy/sync-to-prod.sh` — durable prod deploy** — replaces the piecemeal `cp src/*` that left the prod copy drifting (missing `docs/`, `Reports/`, `issues/`, stale `test/` → repeated "prod missing X" audit findings, and indirectly the cron.jobs.json clobber). An **additive** `rsync` of the whole repo (code + docs + tests + specs) into `$IRIDA_ROOT`, dry-run by default (`--apply` to sync). Excludes prod-owned content the repo never has — `.agent/` runtime, `agent.config.json` (engine + toolPolicy), `node_modules`, `Reports/` the agent authors — so a deploy can't clobber them. First run brought the prod tree fully in sync (docs/Reports/issues/tests) with the engine config + 15 cron jobs + agent-written reports left intact.

### Fixed

- **Claude Agent SDK result parity** — real SDK error results now preserve `errors[]` for overload/auth classification, keep result `uuid` separate from session `session_id`, and forward stream updates through the shared `onDelta` hook. Consequently 529-style one-shot failures retry, interactive overloads retry in place without shedding server context, and persisted run IDs identify turns instead of duplicating the agent ID.
- **SDK-agent lifecycle ownership is hardened end-to-end** — chat sessions now serialize operations, reject queued work once closing starts, cancel an active Claude Query before waiting for the turn, and dispose the final agent/store exactly once. Claude runs use one shared stream pump, so `wait()` completes without a prior stream drain; cancellation tries `interrupt()` and force-closes after a bounded grace period, including when a stream consumer exits early. Telegram `/stop` now latches across session opening, retry backoff, and rotation, preventing a later paid attempt instead of only discarding its reply; gateway shutdown starts active cancellation without waiting for unrelated session opens. Gateway session opens remain deduplicated and drained; failed peer-state persistence closes the just-opened session instead of orphaning it, and ingress shutdown starts before session teardown. SQLite session/memory stores now release their shared database reference idempotently, diagnostic sink failures cannot abort startup, and pet callback wiring no longer mutates caller-owned options.
- **Rotation retries only clean turns** — non-overload SDK/run errors no longer rotate and resend after assistant output or tool activity has already occurred, preventing duplicate visible output, billing, or tool side effects. Clean early failures still receive the existing single rotation retry.
- **Resume now uses the shared chat lifecycle** — `irida resume` delegates live resume, transcript replay, prompt composition, safety, retries/rotation, streaming, and persistence to `ChatSession` instead of maintaining a second SDK loop. Reopened sessions preserve title/cwd/runtime/channel, channel-specific Claude tool policy is resolved from the stored session before SDK startup, context-reference failures keep `EX_USAGE`, and partial error output remains newline-terminated. Raw destructive requests, destructive content attached through `@file`/`@dir`/`@memory`, and invalid explicit references are rejected before `sdk.resume/create`, leaving the stored session untouched. When live resume falls back to replay, replay-only first-turn enrichment (skills/profile/memory/hooks/AutoRAG) is composed and gated before the fresh SDK agent is created, then reused for the first send so hooks run once; successful live resume still skips those replay-only injections. If transcript loading fails after fallback creation, the fresh SDK agent is now disposed before the original error is returned.
- **Engine-neutral gateway startup** — gateway transport no longer requires a Cursor API key before any peer session exists. Each peer's sticky engine now reaches the existing provider-aware check in `openChatSession`, so Claude account/API-key gateways can run without an unrelated Cursor credential and `/engine` remains available for recovery.
- **Cron-state clobber guard hardened (I-38)** — on 2026-06-22 a test run against the live prod home overwrote `~/.irida/.agent/cron.jobs.json` with a test fixture (`{id:"x"}`), wiping the autonomous job definitions; the I-38 guard didn't fire. Root causes fixed: (1) the guard compared only against `resolve(iridaHome(), ".agent")`, so a write to `~/.irida/.agent` slipped through when `iridaHome()` resolved elsewhere — it now refuses a write under the env-resolved home **or** the literal `~/.irida` / `~/.csagent` (via `homedir()`); (2) `isTestRun()` missed the `node:test` worker context (`npx tsx --test` set `npm_lifecycle_event=npx`, no `--test` in the worker argv) — now also keys off `NODE_TEST_CONTEXT`, which removed the long-standing test flakiness; (3) `saveCronState` is now guarded too, not just `saveCronJobs`. Jobs restored from backup (15 jobs).

- **Deploy scripts resolved the retired `~/.csagent` home** — the re-revision audit (`Reports/analysis/2026-06-22-audit-rerevision-tests-security.md`) found `csagent-watchdog.sh` defaulting `HOME_DIR` to `~/.csagent`; the same drift was in `digest-qa.sh` / `prod-check.sh` (`HOME_DIR` **and** `ROOT`) and `bootstrap-agent-config.sh`. Since the launchd plists pass `IRIDA_HOME`/`IRIDA_ROOT` (not `CSAGENT_*`), the morning QA/health scripts were silently pointing at the retired prod. All now read `${IRIDA_HOME:-${CSAGENT_HOME:-…/.irida}}` / `${IRIDA_ROOT:-…/irida}`. Verified: `prod-check.sh` resolves cwd `~/.irida/irida`, exit 0. Also fixed the `~/.irida/csagent` (no-slash) layout mentions the first rename pass missed in `deploy/README.md`.

### Changed

- **Docs: finish the csagent→irida rename** — fixed the doc-rot the introspection audit (`Reports/analysis/2026-06-22-audit-docs-vs-code.md`) surfaced: the architecture blurb in README/AGENTS/REFERENCE now describes the real **two engines** (Cursor SDK default / Anthropic Claude Agent SDK via `engine.provider`) instead of the stale "single runtime, no second loop"; install/ops paths corrected (`~/.irida/csagent/…` → `~/.irida/irida/…`, `cd csagent` → `cd irida`); Postgres backup creds aligned to the actual `csagent` user/db; README title `# csagent` → `# Irida`; repo/name line + skills list (4→10) + test count made accurate; `scripts/irida.mjs` made executable. Legitimate `csagent` references (the `csagent-run.sh` script, retired `~/.csagent` prod, `CSAGENT_*` env fallback) left intact.
- **Wisp working — parity with idle (TUI delight)** — the `working` state grew from a flat 4-frame spin to an 8-frame "concentrating" loop with the same crafted depth as idle's watching: the eye rotates ◐◓◑◒, snaps to a focused ◉ mid-loop as the energy tail peaks (ϟ→↯→≋→≋≋→≋≋→≋→↯→ϟ), with an orbiting aura sparkle — a spin-up → focus-lock → wind-down arc. The focus-beat narrative is pinned by a test. (The top row still swaps for the active tool's thought glyph; eye + tail always show.) Same 5-row × 8-display-column invariant.
- **Slash palette — readable (TUI)** — typing `/` now shows an aligned command palette: a `▸` marks the primary suggestion, the prefix you've typed is bolded in accent, command names line up in a column, and arguments/descriptions are dimmed — instead of a flat run-on list. `src/tui/components/SlashSuggest.tsx`.
- **Wisp greeting card (TUI delight)** — the booting / empty / post-`/clear` transcript now greets you with the colored Wisp mascot beside its name and the live status (e.g. `Connecting to Claude Agent SDK…`) instead of a flat one-liner — and the connecting message is finally engine-aware (was hardcoded "Cursor SDK"). If the agent can't start, Wisp frowns and the error stays red and prominent. The colored glyph renderer is now shared (`src/tui/components/wispGlyph.tsx`) between the corner mascot and the greeting.
- **Status line — live cost (TUI)** — the run line now shows the last turn's estimated cost (`~$0.1350`) next to the token count, priced from the turn's model via the I-116 table (omitted for unpriced models like cursor composer). On the account/subscription engine it's tagged `sub` (the $ is metered-equivalent, not billed), matching the gateway `/usage` treatment. Estimate counts input+output only (no per-turn cache field yet), so the `~` flags it as an undercount vs `/usage` totals. `src/tui/components/StatusBar.tsx`.
- **Tool-activity strip — alive (TUI delight)** — the activity line's static `◌`/`⚙` lead is now the same braille orbit as the thinking line (driven by the shared `petClock`), and the active tool is tagged with Wisp's icon vocabulary (⌕ search · ✎ edit · ▤ read · ›_ shell · ⇄ mcp) — so at a glance you see *which kind* of tool is running, e.g. `⠹ ⌕ Grep · grep "foo" src/`. The braille spinner + sparkle wave moved to a shared `src/tui/spinner.ts` and the tool icons are exposed via `petActivityGlyph`, so the mascot, the thinking line, and the activity strip now pulse in one visual language.
- **Thinking indicator — alive (TUI delight)** — the static `💭 thinking` line is now animated: a smooth braille orbit (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) spins while the agent reasons, with a live elapsed-seconds counter and a sparkle that drifts back and forth (`✦ · ·` ↔ `· · ✦`) — sharing Wisp's visual language so the mascot and the thinking line read as one creature. Driven by the same `petClock` tick (400ms while busy). Removed the 2-cell `💭` emoji; spinner/wave are pure, tested helpers. `src/tui/components/ThinkingBar.tsx`.
- **Wisp mascot — alive (TUI delight)** — the in-terminal companion gained richer multi-frame animations so it feels alive: when idle its eye now **tracks a sparkle drifting left→right** (◐ follows it left, ◉ centre, ◑ right), then it blinks, does a curious wide-eye "?" peek, and settles — a 9-frame "watching" behavior, not a loop — while the energy tail swishes. It spins a full eye rotation (◐◓◑◒) with crackling energy when working, bursts confetti then settles when happy, sheds a tear that wells up and falls when sad, and breathes with rising zZz asleep. Same 5-row × 8-column corner invariant (no jitter). Fixed a pre-existing display-width bug where the 2-cell `⚡` made the working frames 9 columns wide (→ 1-cell `ϟ`/`↯`); the width test now measures real display columns (`string-width`), not code points, and the eye-tracking choreography is pinned by a test. `npm run pet` shows it off.

### Added

- **Evolution proposer — duplicate suppression (I-98)** — the proposer kept re-proposing the same idea (3 pending "startup-failure triage" near-dupes). Now the proposer prompt lists the pending queue and is told to reply "NO PROPOSAL" on overlap (semantic dedup via the model), backed by a high-precision code guard (`isDuplicateProposal`) that drops a parsed proposal only on strong title overlap (near-identical or concept-contained) — deliberately conservative so it never silently drops a distinct improvement; looser cases are left to the prompt + the human reviewer.
- **Managed evolution loop — safe v1 (I-98)** — new `evolution-cycle` cron builtin closing the loop signal→reflect→fitness→gate→report WITHOUT autonomous apply. Signals = recent `runs.jsonl` error kinds + lesson-eval gaps + the eval battery as a READ-ONLY fitness baseline (the eval graph is never mutated — Goodhart guard). A forked **read-only** proposer (`disallowedTools` blocks Write/Edit/Bash + all memory-write tools; gated to the claude-agent engine since the cursor SDK can't enforce it) emits at most one proposal as text, which lands in `evolution.proposals.json` as `pending`; a human reviews + applies via the new `/proposals` gateway slash. `backgroundPause`-aware; spends zero LLM budget when there's no signal. L0 auto-apply already lives in memory-distill (I-113) + memory-consolidate (I-114); L1 skill auto-apply is intentionally deferred. New `RunOptions.disallowedTools` threaded through the engine. Audit subagent caught that the read-only guard was unenforced on the cursor engine and that `memory_fact_invalidate` was unblocked — both fixed. Verified live on prod: proposed a startup-failure triage note to the queue without touching memory.
- **Memory consolidation / "dream" (I-114)** — new `memory-consolidate` cron builtin: a forked agent periodically (growth-threshold or weekly cadence) merges near-duplicate auto-distilled notes (`agent-distilled` wing from I-113) into one and archives the superseded originals into `agent-distilled-archive` (excluded from search; reversible, not deleted — there is no delete MCP tool). Scoped to the agent-created wing only; `backgroundPause`-aware; advisory-locked against overlap; reports the active-note delta. Audit subagent found that "archive" leaked through the `.md` file mirror and the `onStart:["*"]`/`@memory:*` injection paths (which list all wings) — both fixed: `memory_save` to an archive wing now drops the file mirror, and `*` injection filters archive wings.

### Added

- **Automatic memory distillation (I-113)** — new `memory-distill` cron builtin: a forked agent reads recent completed gateway/cron sessions and writes only DURABLE knowledge (decisions, corrections, ops lessons → `agent-distilled` wing; preferences/seen-items → facts) — the automatic version of the manual `/memory-update`. Distinct from `session-ingest` (raw episodic dump) and `cursor-distill` (Cursor IDE). State-file cursor for idempotency (re-distill only when a session changes), per-pass agent-run cap, `backgroundPause`-aware, skips trivial/test sessions, and runs with `persistRun:false` so it never distills itself. New `RunOptions.attachMcp` lets a `barePrompt` run keep the memory tools. `src/memoryDistill.ts` + tests; reviewed by an audit subagent (caught + fixed a blocker where bare prompts stripped MCP, plus cursor-durability and cost-cap fixes).

### Added

- **Memory staleness annotation (I-115)** — recalled/injected memory reflects what was true when written; the model otherwise treats it as current. Notes older than `memory.stalenessDays` (default 7, 0 disables) now get a one-line caution to re-verify code-coupled details (file/function/flag/path) before relying on them. Applied across every recall path: `@memory` injection, session-start injection, AutoRAG silent pre-turn injection, and the `memory_get` MCP tool (full caution); `memory_search` hits get a compact `⚠Nd` marker. Annotation only — never blocks recall. `src/memoryStaleness.ts` + tests.

### Added

- **Cost / usage tracking (I-116)** — per-run token usage now carries cache read/write (priced ~0.1× / 1.25× input), captured on both the interactive and one-shot/cron paths (the latter recorded no usage before). New `src/pricing.ts` (per-MTok rates for the claude-agent models from the `claude-api` skill, `RATES_AS_OF` stamped) estimates USD per run by its own model — unknown models (cursor composer, future models) price to `null` (tokens-only). `gateway status` / `/status` 24h rollup gains `· cache r/w …` and `· $X.XX est`; a new gateway `/usage` slash adds the current session's cumulative usage (aggregated by `session_id` in `runs.jsonl`, so it survives resume). On the account engine the figure is tagged `subscription (no metered charge)` since the $ is the metered-equivalent, not a bill.

### Added

- **Autonomous self-monitor (I-121)** — `claude-session-prune`-style cron builtin `self-monitor` that asserts the autonomous surfaces are alive and **alerts robustly** when not. Two new detectors — cron freshness for any job flagged `critical` (generalizes the digest freshness check; new `critical`/`maxAgeHours` job fields) and an engine **auth/403 streak** from `runs.jsonl` (surfaces the claude-agent account rate-cap that previously only hit `error.log`) — plus reuse of the existing gateway probes (store/poll/outbox). Delivery rides the normal cron notify path (**direct Telegram + outbox park**, never an agent turn, so the alert can't be taken down by the engine it reports on). Anti-spam via `self-monitor.state.json`: alert on change or every 6h while red; **daily heartbeat** so silence means confirmed-healthy. Detection + alert only (no remediation). `src/selfMonitor.ts` + tests.

### Changed

- **TParser daily digest → single agent** — the digest ran 5 topic delegates + a synthesizer (6 SDK runs), which on the claude-agent **account** engine tripped a subscription rate cap (`403 Request not allowed`, 4/5 topics then fail) and spawned 6 orphan SDK session transcripts per run. Replaced with one agent that fetches once, buckets the five topics, and emits the digest in a single run (`deploy/prompts/tparser-daily-single.prompt.txt`). New `recordDigest` cron-job flag saves the snapshot + runs digest-QA on the single-prompt path (morning freshness check keeps working, topic coverage derived from the body when per-topic stats are absent).

### Added

- **`claude-session-prune` cron builtin** — age-based sweep of stale Claude Agent SDK session transcripts under `~/.claude/projects/*/*.jsonl` (default >14 days). Safe: an active resumable session (gateway, appended every turn) keeps a fresh mtime and survives; one-shot cron/delegate orphans age out. `src/claudeSessionPrune.ts` + tests.

### Security

- **Tool execution guardrails on claude-agent (I-94)** — runtime tool-deny gate: the Agent SDK `canUseTool` callback vets the tool inputs the agent chooses (e.g. a `Bash` command) against the shared `safety.ts` denylist, denying destructive shapes (`rm -rf`, `drop table`, force-push, `mkfs`, fork bomb). Replaces the hardcoded `bypassPermissions` **only when enabled**. Config `engine.toolPolicy` is **off by default** and per-surface (`bySurface` by `channel`) so gateway/cron can be strict while TUI stays relaxed; `gateway status` surfaces the state. OS sandbox (I-95) deferred to a later layer. The cursor-engine equivalent stays blocked by `@cursor/sdk` (no programmatic hooks).

### Fixed

- **TUI thinking leak** — pre-turn `thinking…: waiting for model` no longer injects into the assistant bubble (ActivityBar only); streaming deltas strip stale tool-progress placeholders
- **Gateway skills resolution** — `listSkills` / `loadSkill` fall back to `IRIDA_ROOT/skills` when `IRIDA_HOME/skills` is missing (launchd layout: home state + repo checkout)
- **Doctor skills clarity** — `skills root` check with absolute path; gateway/threat scan details cite resolved directory; removed redundant `IRIDA_ROOT skills` check; `irida skills list` prints skills root
- **Gateway Telegram inbound silent (I-84)** — `TELEGRAM_GATEWAY_ALLOWED_UPDATES` on every `getUpdates` (Bot API global filter had been narrowed to `channel_post` only); short poll (`timeout=0`); persisted poll offset; ack after handle; parse `/cmd@BotUsername` in groups
- **Gateway test config isolation** — `writeExampleGatewayConfig` writes under test `dir/.agent` only (no IRIDA_HOME bleed)
- **Telegram allowed_updates health (I-83)** — `doctor` + `gateway status` probe `getWebhookInfo`; poll batch logs update types (I-87)
- **Memory retrieval router (I-74)** — routing table in `memory-ops`; MCP `memory_search` defaults `hybrid: true` when `memory.embeddings.enabled`
- **Hybrid memory search (I-72)** — Postgres `searchNotesHybrid` RRF merge of FTS + vector; CLI `--hybrid`; config `memory.search.hybridWeights`; FTS fallback when embedder down
- **MCP wing filters (I-75)** — `memory_search` / CLI `--wing` allow-list overrides default exclude for targeted ops retrieval
- **Memory search golden eval (I-78)** — `eval/cases/memory-search-smoke` fixture queries; `npm run eval`
- **kb-ops skill** — file KB at `$IRIDA_HOME/knowledge-space` (git pull); tech reference off Postgres; removed `happyin-kb-weekly` cron example
- **Memory governance doc** — `docs/MEMORY-GOVERNANCE.md`: files vs Postgres vs embeddings, OKF tier policy, LLM wiki + Obsidian CLI, periodic review checklist
- **Run log metadata (I-68)** — `logs/runs.jsonl` fields `channel`, `cron_job`, `is_test`; cron/chat/run paths populate them; session-ingest skips test temp cwd; doctor warns on null tokens; gateway status prod-only metrics
- **Memory retrieval model doc (I-67)** — REFERENCE «When memory is retrieved» (preTurn / onStart / autoRag / MCP layers); `memory-ops` skill; prod `csagent-index` wings + archive search
- **Cursor lesson distill (I-65)** — wing `cursor-lesson`; `memory distill-cursor` queue; backfill + delta baseline; cron jobs; HITL proposals only
- **Cursor lesson map-reduce orchestrator (I-65b)** — `memory distill-cursor --run [--backfill] [--parallel N]`; chunk split + merge; subagents pinned to `composer-2.5-fast`; `--dry-run`
- **Cursor mine `--all` + daily cron** — `memory mine-cursor --all` scans every IDE transcript; skips unchanged files by stored mtime/hash; re-imports when jsonl mtime advances; cron builtin `cursor-mine` (example job `cursor-mine-daily` at `15 0 * * *`); strips NUL bytes for Postgres UTF-8
- **Memory search exclude archive** (I-62) — default FTS/semantic skip wings `cursor-ide` and `secure`; MCP `includeArchive`; CLI `--include-archive`; embed/reindex skip `cursor-ide`
- **OKF memory format** — YAML frontmatter ([Open Knowledge Format v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)) for cursor-lesson playbooks; `memory okf audit|migrate-lessons|backfill-lineage|repair-titles|strip-legacy-meta|promote|export-review|export-bundle|purge-*`; `export-bundle` prunes stale markdown orphans; canonical gateway playbook `lesson.gateway-idle-rotation`; distill queue upsert + optional facts
- **Gateway skills** — `deploy/gateway.json.example` adds `kb-ops` + `tool-economy` alongside `memory-ops`
- **tool-economy skill** — token/tool routing playbook in `skills/tool-economy.md`

### Added

- **Gateway allowlist in Postgres (I-96)** — when `IRIDA_DATABASE_URL` + `IRIDA_SECRETS_KEY`: chat IDs stored encrypted in `gateway_allowed_chats` (pgcrypto); auto-migrate from `gateway.json` on gateway start; SQLite path unchanged (`allowedChatIds` in file)
- **cursor-lesson paired eval (I-79)** — `eval/cases/cursor-lesson-paired`; `irida memory lesson-eval validate|list|sheet|record|summary`; facts `cursor_lesson_eval`
- **Reddit digest cron (I-77)** — `reddit-rss-fetch` script + `reddit-digest-daily` SDK job; `reddit-digest-YYYY-MM-DD` wing `reddit`; fact `reddit_digest last_run`
- **Archive purge CLI (I-80)** — `irida memory purge-archive` TTL 180d dry-run; `--require-lesson` gated delete
- **gateway-ops skill (I-85)** — Telegram Bot API guardrails; inbound silent / `allowed_updates` playbook
- **Gateway post-deploy smoke (I-88)** — `deploy/gateway-smoke.sh` (allowed_updates + launchd + poll log); wired into `prod-check.sh`
- **Desktop pet (I-97)** — **Wisp** mascot in `irida tui` (hand-drawn Unicode, multi-color); `irida pet status` for optional snapshot

### Changed

- **Wisp pet polish (I-97)** — all states now animate (idle blink, sleep breathing/zZz, sad teardrop, happy sparkle-pop) on uniform 5-line frames (no vertical jump); single-eye image enforced across every state; `working` reflects the active tool in the label and a top "thought" glyph (reading `▤` / writing `✎` / searching `⌕` / running `›_` / connecting `⇄`) while the tail keeps its ⚡/≋ energy pulse; `npm run pet` (`scripts/pet-preview.mts`) to eyeball frames standalone
- **Packaging (I-32)** — `npm run pack:check`; README test count; OPS develop checklist
- **Episodic search exclude (I-73)** — wing `episodic` omitted from default FTS/semantic; CLI `--include-episodic`; MCP `includeEpisodic`
- **TParser digest dedup** — stop writing `seen_post` memory facts (~15–20k/week); window-only dedup in prompts; removed cron `memoryFactsSubject` preamble; `irida memory fact purge-seen-post` to drop legacy rows
- **cursor-ide ingest cap (D2)** — truncate archive body at 200 KB; full jsonl on disk; `memory audit` labels curated vs archive
- **Embeddings backfill** — enable `memory.embeddings` + `memory reindex-embeddings` for episodic/lesson wings (not archive); `setup-home.sh` no longer overwrites prod `agent.config.json`

### Fixed

- **Run log tokens (I-33)** — capture usage from SDK `onDelta` `turn-ended` updates (not emitted on `run.stream()`); `runs.jsonl` input/output tokens populated for gateway/cron chat turns
- **Cursor-ide archive hash** — `withHashComment` stores hash inside HTML comment; `resolveArchiveContentHash` handles malformed legacy headers
- **Cursor mine skip logic** — `noteNeedsUpdate` compares embedded header hash (not hash of body including comment); fix `withHashComment` mtime regex so hash is actually written
- **OKF legacy HTML meta** — `strip-legacy-meta` removes stale `<!-- irida cursor-lesson … -->` when YAML frontmatter is source of truth

## [0.2.0] - 2026-06-13

### Fixed (audit 2026-06-10)

- **Telegram long replies** — rich `sendRichMessage` failure now cascades to 4096 multipart HTML/plain; outbox auto-downgrades to plain after `message is too long` (post-mortem 2026-06-13)
- **Outbox observability** (I-50) — `gateway status` / `/status` row `outbox`: pending count, oldest age, next retry; FAIL when oldest > 5 min
- **Outbox user ack** (I-51) — plain «Ответ готов, доставляю частями…» when reply parks to outbox (gateway + cron notify)
- **preTurn profile** — excerpt only on first composed turn per session; flag consumed before safety gate (blocked first turns no longer re-inject)
- **Doctor morning-alert** — await async handler in CLI so launchd receives real exit code (not a Promise)
- **Gateway live resume** — skip skills/`onStart` reinjection when SDK agent resumes live (gateway restart no longer sends ~10 KB preamble on first turn; transcript replay unchanged)
- **Digest QA length** — max body check raised to 12k chars (real digests ~8–9k were false morning FAIL)
- **setup-home** — skip `.agent` migrate when prod state already exists (I-38 follow-up)
- **Prod cron guard** (I-38) — `saveCronJobs` validates before write, timestamped `.bak` on overwrite, test-run block on `IRIDA_HOME/.agent`; `gateway status` FAIL on invalid jobs; doctor suggests restore from latest backup; morning launchd `ai.csagent.prod-check-morning` (08:05) + `doctor morning-alert` → Telegram on cron health FAIL

### Added

- **Turn context preTurn** (I-52) — `memory.preTurn`: `ADVICE:`/`DO:`/`DEBUG:`/`SYNC:` prefix parsing, optional profile excerpt from a named note; profile skipped on live SDK resume; ordering profile+mode → autoRag → task
- **`memory_fact_invalidate` MCP** (I-53) — invalidate by `fact_id` or subject/predicate/object scope; `queryFacts` object filter
- **Introspection profile patches** (I-54) — skill + cron prompt require User/Agent profile patch proposal sections when communication friction; template `deploy/prompts/introspection-weekly.template.md`
- **autoRag conservative pilot** (I-55) — `deploy/agent.config.example.json` reference config; `IRIDA_LOG=1` one-line `autoRag hits=N chars=M notes=…`; doctor warns on `meta` wing; pilot runbook in `deploy/PERSONAL-OPS.md` (prod stays `enabled: false` until sign-off)
- **Digest length policy** (I-60) — synthesizer prompt targets ≤3500 chars + TL;DR first; `cron qa` WARN tier for 3501–12000 (FAIL unchanged at >12k)
- **Cron context artifacts** (I-40, Wave C1a) — successful runs with output write `.agent/cron.context/{jobId}.json` (redacted, 256 KiB cap); foundation for `contextFrom` (I-41)
- **Cron contextFrom pipeline** (I-41, I-42) — job field `contextFrom` + `{{context_from}}` in prompts; tick topological order; skip downstream when upstream fails; example `pipeline-source` / `pipeline-synth` in `deploy/cron.jobs.example.json`
- **Action transcript + `/undo`** (I-44, I-45) — append-only `.agent/action.transcript.jsonl` for reversible memory delete and cron user-remove; `/undo` in TUI + Telegram
- **Skill threat scan** (I-46) — shared `promptThreatScan` patterns on skill load; doctor row `skills threat scan`
- **Turn hooks** (I-47) — optional `hooks.preTurn` / `hooks.postTurn` script config; preTurn exit 2 denies turn; stdout appended (4 KiB cap)
- **Eval battery** (I-49) — `eval/manifest.json` + `irida eval run`; verify scripts without live SDK in CI
- **Shared SQLite handle** (R2-6) — session + memory stores ref-count one `DatabaseSync` per `state.sqlite` (replaces dual-handle WAL workaround)
- **Cursor IDE transcript mining** (P3-3 / R4-4) — `irida memory mine-cursor` ingests `~/.cursor/projects/*/agent-transcripts/*.jsonl` into wing `cursor-ide`
- **Cron:** double-fire race (slot claimed before run), atomic state/jobs writes, vixie `*/N` anchor for dom/month, DOM-or-DOW semantics, oldest-missed-slot catch-up, per-job `graceMinutes` (daily digest after sleep), cross-process tick lock, webhook notify HTTP status check
- **Chat engine:** dead agent handle after failed rotation (+ next-turn recovery), idle refresh no longer consumes error-retry budget or re-fires, failed attempts recorded, partial output surfaced on exception, replay prefix no longer duplicated
- **Telegram gateway:** per-chat queues (one slow turn no longer blocks other chats), reply delivery retry, drain on stop before closing sessions, generic error text to chat (details in log), `uncaughtException` exits for launchd restart
- **Store/memory:** `store migrate` copies memory notes+facts (was sessions/runs only) and is idempotent, redaction on list previews and silo align, `markPostSeen` dedup, `importHappyinKb` idempotent facts, WAL+busy_timeout on shared sqlite, file-first note mirror
- **Gateway auth:** webhook honors `pairing.approved` (same model as Telegram); safety gate now checks composed prompt (`@file`/`@memory` content)

### Added

- **Unified slash registry** (Wave C2) — `src/slashRegistry.ts` is the single catalog for TUI `/help`, gateway routing, and Telegram `setMyCommands`; `slashCatalog.ts` and `gatewaySlash.ts` derive from it
- **Session ingest → episodic memory** (P3-2, Wave B) — recent sessions upserted as FTS-searchable notes in wing `episodic` (`ep.<sessionId>`); idempotent on `session.updated_at`; `irida memory ingest-sessions`, cron builtin `session-ingest`
- **Auto-RAG** (Wave B) — optional `memory.autoRag` in `agent.config.json`: silent top-k `memory_search` before each turn (FTS or semantic); injected under "Relevant memory (retrieved for this message)"
- **Introspection weekly cron** (Wave B1) — skill `introspection-ops` + example job reading `runs.jsonl` and episodic notes → proposal note only (no auto-merge)
- **Secret corruption protection** (postmortem 2026-06-12) — overwrite history for `credential_secrets` (`auth history` / `auth restore <id>`), read-path self-heal (valid file beats corrupt PG value, with re-save hint), gateway fail-fast on malformed bot token; migration `009_credentials_history.sql`
- **Skill `profile-ops`** — loads `user-profile.niksh` / `agent-profile.composer` from csagent-memory (profiles were notes, the skill file never existed)
- **Cron wake-gate** (`gateScript`, borrowed from hermes-evolution) — cheap pre-script can skip the SDK run entirely (`{"wakeAgent": false}`): no tokens when there is nothing to do; fail-open on gate errors
- **Cron script jobs** (`script`) — deterministic shell tasks with zero SDK: stdout → Telegram notify, empty stdout → silent; example watchdog `deploy/scripts/csagent-watchdog.sh`
- **Cron `catchUp: "skip"`** — stale slots dropped instead of caught up (late briefings)
- **Doctor remediation** — failed checks print `↳ fix:` copy-paste commands (CLI + TUI)
- **Semantic memory search** (I-36) — local Ollama embeddings (`nomic-embed-text`, 768d) + pgvector hnsw: `memory search --semantic`, `memory reindex-embeddings`, MCP `memory_search semantic:true` (FTS fallback); embed-on-save fail-soft; secure notes never embedded; migration `008_memory_vector.sql`
- **Docs split** (I-32) — README is now a 110-line pitch+quickstart; install/ops → `OPS.md`, full reference → `REFERENCE.md`; npm tarball ships both + `deploy/` + `skills/`
- **Secure memory notes** (I-20) — `--wing secure` (Postgres): body pgcrypto-encrypted at rest, decrypt only via `memory show`/`memory_get`, masked in list/search, no `.md` mirror; sqlite refuses; migration `007_memory_secure.sql`
- **Telegram outbound queue** (I-31) — failed deliveries (replies, cron digest) park in `gateway.outbox.json`; poll loop drains with backoff 30s→1h, caps 20 attempts / 48h / 100 entries
- **Run metrics** (I-33) — `gateway status` / Telegram `/status` row `runs 24h`: count, error rate, p50/p95 duration, token totals (aggregated from `runs.jsonl`, no DB migration)
- **TUI `/find <text>`** (R3-4) — transcript search, reverse-i-search UX: first hit = newest match, repeat `/find` walks older, wraps; case-insensitive
- **Structured run log** (I-19) — every recorded run appends to `<stateDir>/logs/runs.jsonl` (id, status, duration, model, tokens; no previews); rotation at 5MB; `IRIDA_RUN_LOG=0` disables
- **Telegram HTML formatting** (I-37) — replies and digest render `**bold**`, `` `code` ``, fences, links via HTML parse_mode; plain-text fallback on parse errors
- **Telegram tool progress via editMessage** (I-37) — one self-updating message per turn instead of message-per-tool (rate-limited 1.5s)
- **Pairing rate-limit** (I-35) — pending codes: cap 20, 24h TTL, code reuse per chat
- **pgcrypto spec** (I-20) — `issues/I-20-pgcrypto-notes-facts.md`, Option A (`secure` wing), awaits sign-off
- **Roadmap + issue tracker:** `docs/ROADMAP.md` (R1–R4), issues I-31…I-37 (outbound queue, packaging, metrics, retention, pairing rate-limit, pgvector, telegram markdown)
- Per-job **`graceMinutes`** in cron jobs — catch missed slots after machine sleep (daily digest)
- Cron builtin **`session-export`** (I-12) — daily transcripts to `Reports/sessions/YYYY-MM-DD/`
- **`tui.log`** (I-17) — `IRIDA_LOG=1` diagnostics from TUI go to `<stateDir>/tui.log`, not stdout
- TUI **rotate pending state** (I-13) — `onAgentRotating` hook shows "reinitializing agent…" during rotation
- Cron digest **post-mortem** in Telegram (`status`, `duration`, `topics N/M`) after topic-delegate jobs
- `cron.state.json` `lastResult` — surfaced in `/status` and `gateway status`
- `deploy/PERSONAL-OPS.md` and `deploy/backup-personal.sh` for personal prod runbook
- **`irida cron qa`** + `deploy/DIGEST-QA.md` — automated digest QA checklist
- Telegram **QA alert** after topic-delegate digest when run OK but QA FAIL (`qaOk` in `/status`)
- **Morning digest QA** launchd (08:00) + `cron qa --morning --alert`
- **H2:** digest follow-up aliases aligned with 5 topics; last digest snippet in follow-up turns; `/help` hints
- launchd **`ai.csagent.backup-weekly`** — Sunday 05:00 backup via `backup-personal.sh`
- **Cron from chat:** MCP `cron_propose` + `/schedule approve` (path 2); slash `/schedule add|list|remove|…` (path 1 fallback)
- Skill **`cron-ops`**, MCP server **`csagent-cron`** (gateway with `allowedChatIds` only)
- User cron jobs: `user-*` prefix, max 10, protected system job ids
- **`irida memory audit`** — notes/facts/silo checks; optional `--links` URL probe; saves `.agent/memory-audit.last.json`

## [0.1.1] - 2026-05-29

### Fixed

- **Postgres TUI:** shared connection pool with refcount — no more `Called end on pool more than once` when switching sessions
- **TUI tab bar:** stable slot order across switches; `Tab` / `←→` / `1`–`5` use visible tabs, not DB sort order
- **bootSession:** serialized session switches to avoid races

### Added

- `deploy/prod-check.sh` — personal prod pass (`doctor`, `gateway status`, `cron list`, launchd)

## [0.1.0] - 2026-05-29

### Added

- Local-first personal agent on Cursor TypeScript SDK (CLI, Ink TUI, cron, gateway)
- Built-in MCP servers: `csagent-memory`, `csagent-browser` (stealth Chromium)
- Skills: `memory-ops`, `browser-ops`, `obsidian-ops`
- Telegram / webhook gateway with slash catalog, pairing, digest follow-ups
- Cron jobs with prompt guard, topic delegates (5 + synthesizer) for daily digests
- TUI session tab bar: switch with `1`–`5`, `Tab` / `Shift+Tab`, `←`/`→` (empty input), `Ctrl+[` / `Ctrl+]`
- TUI `/delegate` with inject into parent session; Telegram `/delegate <prompt>` with session inject
- Postgres store option, `store migrate`, encrypted credentials (pgcrypto)
- Session search, memory facts, `import-md`, silo alignment in doctor
- **265** automated tests

### Notes

- CLI command: **`irida`** (npm package name remains `cursor-agent` — see README naming collision)
- Requires Node.js ≥ 20 and a Cursor API key
- Cloud runtime (`runtime: cloud`) is gated but not implemented yet (issue 016)

[0.2.0]: https://github.com/niksh06/irida/releases/tag/v0.2.0
[0.1.1]: https://github.com/niksh06/irida/releases/tag/v0.1.1
[0.1.0]: https://github.com/niksh06/irida/releases/tag/v0.1.0
