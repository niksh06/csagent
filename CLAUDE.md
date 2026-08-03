# CLAUDE.md

Guidance for working in this repository.

## What this is

**Irida** (ранее «Cursor agent» / CSAgent) — local-first персональный агент:
**один интерфейс, три движка**. Пользователь выбирает рантайм через `engine.provider`
в `agent.config.json` (или флагом `--engine`):

- **`cursor`** (по умолчанию) — родной agent-runtime Cursor SDK;
- **`claude-agent`** — Anthropic Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`),
  с двумя режимами auth (`engine.auth`): `api-key` (`ANTHROPIC_API_KEY`) или
  `account` (`CLAUDE_CODE_OAUTH_TOKEN` / сессия `claude login`);
- **`codex`** — OpenAI Codex (`@openai/codex-sdk`), алиасы `openai`/`gpt`/`oai`;
  auth по умолчанию `account` (сессия `codex login`), опционально `api-key`
  (`OPENAI_API_KEY`). CLI запускается под изолированным `CODEX_HOME`, чтобы личный
  `~/.codex/config.toml` оператора не протекал в прогоны агента.

Это **сознательно расширяет** исходный принцип «без второго loop»: движков теперь три,
равноправно выбираемых. Hermes-inspired UX (sessions, skills, MCP, safety). TypeScript/Node.
См. [RENAME_TO_IRIDA.md](RENAME_TO_IRIDA.md), issue I-100 и I-144.

## Stack

Node · TypeScript (сборка в `dist/`) · Cursor SDK + Claude Agent SDK + Codex SDK · MCP-серверы ·
gateway · launchd/cron для фоновых задач. Состояние агента живёт в `~/.irida/`
(legacy `~/.csagent/` ещё читается — переходный shim).

## Commands

CLI-бинарь — `irida` (deprecated-алиас `csagent` пока работает).

```bash
npm run build       # компиляция TS → dist/
npm run dev         # дев-режим
npm start           # запуск агента
npm run typecheck   # tsc --noEmit
npm test            # тесты
npm run eval        # прогон eval-набора
npm run smoke       # smoke-проверка
npm run doctor      # диагностика окружения/конфига
npm run tui         # терминальный UI
npm run chat        # интерактивный чат
npm run sessions    # список/управление сессиями
npm run skills      # управление скиллами
```

(Полный список — в `package.json` → `scripts`.)

## Environment (интеграционные тесты)

Новый префикс — `IRIDA_*`; legacy `CSAGENT_*` ещё читается через `dualEnv()` (`src/env.ts`).

```bash
export IRIDA_TEST_PG_URL="postgres://test:test@127.0.0.1:5499/test"
export IRIDA_DATABASE_URL="postgres://test:test@127.0.0.1:5499/test"
export IRIDA_SECRETS_KEY="integration-test-secrets-key-32chars-long"   # ТЕСТОВЫЙ ключ, не prod
```

`IRIDA_HOME` (legacy `CSAGENT_HOME`) переопределяет домашнюю директорию агента
(по умолчанию `~/.irida`).

## Layout

```
src/        исходники агента (env, gateway, mcpServers, doctorChecks, cronJobs, engines/, …)
test/ eval/ тесты и оценочные наборы
skills/     скиллы агента
deploy/     gateway-keep.json и деплой-артефакты
scripts/    вспомогательные скрипты (irida.mjs — лаунчер)
issues/ docs/ Reports/   спеки, документация, отчёты
repos/      рабочие копии для прогонов
```

## Conventions

- Доступ к домашней директории — через хелпер `iridaHome()` (`src/env.ts`), не хардкодить `~/.irida`.
- Чтение env — только через `src/env.ts` (`dualEnv()`): `IRIDA_*` с fallback на legacy `CSAGENT_*`.
  Прямые `process.env.*` вне `env.ts`/`pg/pool.ts` — не добавлять.
- Логи и состояние — под `~/.irida/` (`*.log`, `runs.jsonl`).
- Секреты в env-переменных `IRIDA_*` (legacy `CSAGENT_*`); тестовые значения — только локально.
- Движок выбирается в `agent.config.json` (`engine.provider`/`engine.auth`) или флагами `--engine`/`--auth`.
