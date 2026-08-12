/**
 * irida gateway slash commands (I-22) — Telegram/webhook, no LLM.
 * Branded irida catalog; not Hermes COMMAND_REGISTRY.
 */
import { gatherDoctorChecks, doctorAllOk } from "./doctorChecks.js";
import { gatherGatewayStatus } from "./gatewayStatus.js";
import { loadGatewayConfig, type GatewayConfig } from "./gatewayConfig.js";
import { loadGatewayPeers, peerKey } from "./gatewayPeers.js";
import { tryApprovePairing } from "./gatewayPairing.js";
import { backgroundPauseState, setBackgroundPaused } from "./backgroundPause.js";
import { createMemoryStore } from "./memoryStore.js";
import { loadConfig, resolveEngineAuth, resolveEngineModel } from "./config.js";
import {
  clearChatModel,
  getChatModel,
  modelConflict,
  setChatModel,
  suggestedModels,
} from "./gatewayModelStore.js";
import { loadRunMetrics, formatRunMetrics, loadSessionUsage, formatSessionUsage } from "./runMetrics.js";
import { runLogEnabled } from "./runLog.js";
import { loadProposals } from "./evolutionCycle.js";
import { loadSkillLedger, rollbackAgentSkill } from "./skillApply.js";
import { getChatMode, setChatMode, clearChatMode } from "./gatewayModeStore.js";
import { clearChatEngine, getChatEngine, parseEngineArg, setChatEngine } from "./gatewayEngineStore.js";
import {
  resolveApiKey,
  resolveAnthropicKey,
  resolveOpenAiKey,
  codexAccountAvailable,
} from "./credentials.js";
import { clearPendingQuestion } from "./gatewayPendingQuestionStore.js";
import { listFollowups, clearFollowup, getFollowup } from "./gatewayFollowupStore.js";
import { parseModeArg, TURN_MODES } from "./preTurn.js";
import { createStore } from "./store.js";
import { readPetStateSnapshot } from "./petRuntime.js";
import { petMoodEmoji, petTerminalLabel } from "./petTerminal.js";
import { levelForXp } from "./petState.js";
import { searchSessions } from "./sessionSearch.js";
import { listSkills } from "./skills.js";
import {
  addUserCronJob,
  approveCronSchedule,
  listCronJobsText,
  listPendingCronSchedulesText,
  parseScheduleAddArgs,
  removeUserCronJob,
  scheduleSlashHelpText,
} from "./cronScheduleOps.js";
import { runDelegate } from "./delegateRun.js";
import { undoLastAction } from "./undoAction.js";
import type { ChatSession } from "./chatEngine.js";

import {
  gatewaySlashCommands,
  gatewaySlashHelpLines,
  slashRegistryHasCommand,
  telegramBotCommandsFromRegistry,
} from "./slashRegistry.js";

export type GatewaySlashCommand = ReturnType<typeof gatewaySlashCommands>[number];

/** irida commands available in messaging gateways (from unified registry). */
export const GATEWAY_SLASH_COMMANDS = gatewaySlashCommands();

/** Telegram Bot API menu entries (setMyCommands) — same catalog as /help. */
export function gatewayTelegramBotCommands(): Array<{ command: string; description: string }> {
  return telegramBotCommandsFromRegistry();
}

export function gatewaySlashHelpText(): string {
  const lines = gatewaySlashHelpLines();
  return [
    "**irida** — команды бота:",
    "",
    ...lines,
    "",
    "**После digest:** `топ-50`, `только InfoSec`, `только AI`, `only devops` → углубление по теме.",
    "",
    "**Cron из чата:** попроси агента запланировать → `/schedule approve <код>` · fallback: `/schedule help`",
    "",
    "Свободный текст → агент (движок SDK: /engine).",
  ].join("\n");
}

export function parseGatewaySlash(text: string): { cmd: string; arg: string } | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const [raw, ...rest] = t.slice(1).split(/\s+/);
  if (!raw) return { cmd: "help", arg: "" };
  // Telegram groups append @BotUsername to slash commands.
  const cmd = (raw.split("@")[0] ?? raw).toLowerCase();
  return { cmd, arg: rest.join(" ").trim() };
}

export function isGatewaySlashCommand(text: string): boolean {
  const p = parseGatewaySlash(text);
  if (!p) return false;
  return slashRegistryHasCommand(p.cmd, "gateway");
}

export interface GatewaySlashContext {
  dir: string;
  adapter: string;
  chatId: string;
  cfg: GatewayConfig;
  skills: string[];
  /** Required for /delegate — inject summary into the peer session. */
  getSession?: () => Promise<ChatSession>;
  /** Drop the peer's cached session (I-143 /engine) — next message opens fresh. */
  resetSession?: () => Promise<string | null>;
  /**
   * Re-open the peer's session KEEPING its history (I-174 /model): the cached
   * SDK handle is closed but the stored session id survives, so the next message
   * resumes the same conversation under the new setting.
   */
  reopenSession?: () => Promise<void>;
  yesIUnderstand?: boolean;
}

export async function handleGatewaySlash(
  text: string,
  ctx: GatewaySlashContext
): Promise<string | null> {
  const p = parseGatewaySlash(text);
  if (!p) return null;
  const cmd = p.cmd === "mem" ? "memory" : p.cmd;

  switch (cmd) {
    case "help":
    case "start":
      return gatewaySlashHelpText();

    case "status": {
      const rows = gatherGatewayStatus(ctx.dir, { adapter: ctx.adapter, chatId: ctx.chatId });
      const lines = rows.map((r) => `${r.ok ? "OK" : "FAIL"} ${r.name}: ${r.detail}`);
      // Wisp mood first (I-149): the snapshot re-derives with a live clock, so
      // happy fades and sleep kicks in even between turns. No snapshot → no line.
      const pet = readPetStateSnapshot(ctx.dir);
      const wisp = pet
        ? [`${petMoodEmoji(pet.state)} ${petTerminalLabel(pet.state, pet.activity, levelForXp(pet.xp ?? 0))}`]
        : [];
      return ["irida gateway status", ...wisp, ...lines].join("\n");
    }

    case "doctor": {
      const checks = gatherDoctorChecks(ctx.dir);
      const lines = checks.map((c) => `${c.ok ? "OK" : "FAIL"} ${c.name}: ${c.detail}`);
      const all = doctorAllOk(checks);
      return [`irida doctor (${all ? "pass" : "fail"})`, ...lines].join("\n");
    }

    case "usage": {
      const cfg = loadConfig(ctx.dir);
      const m = loadRunMetrics(ctx.dir, cfg.stateDir, 24, { prodOnly: true });
      const lines = [
        `irida usage`,
        runLogEnabled()
          ? `24h: ${formatRunMetrics(m, 24, { prodOnly: true })}`
          : "24h: run log disabled (IRIDA_RUN_LOG=0) — no data",
      ];
      const sid = loadGatewayPeers(ctx.dir).peers[peerKey(ctx.adapter, ctx.chatId)];
      if (sid) lines.push(formatSessionUsage(loadSessionUsage(ctx.dir, cfg.stateDir, sid)));
      // Subscription auth (claude account / codex login) is not per-token billed:
      // the $ figure is what the same usage WOULD cost on the API.
      const account = cfg.engine.provider !== "cursor" && resolveEngineAuth(cfg.engine) === "account";
      if (account && m.costUsd != null) lines.push("(account/subscription — $ is metered-equivalent, not billed)");
      return lines.join("\n");
    }

    case "proposals": {
      const arg = p.arg.trim();
      // `proposals rollback <skill>` — human-owned undo of an auto-applied skill (I-98 L1).
      const rb = arg.match(/^rollback\s+(.+)$/i);
      if (rb) {
        const name = rb[1].trim();
        const res = rollbackAgentSkill(ctx.dir, loadConfig(ctx.dir).skillsPath, name);
        return res.ok ? `rolled back skill "${name}": ${res.reason}` : `rollback failed: ${res.reason}`;
      }

      const out: string[] = [];
      const pending = loadProposals(ctx.dir).proposals.filter((p) => p.status === "pending");
      if (pending.length) {
        out.push(
          `evolution proposals — ${pending.length} pending (review & apply manually):`,
          ...pending.map((p) => `• [${p.kind}] ${p.title}\n  ${p.detail.replace(/\s+/g, " ").slice(0, 220)}\n  (${p.id})`)
        );
      }
      // Auto-applied skills (I-98 L1) — what the loop changed on its own + how to undo.
      const applied = loadSkillLedger(ctx.dir).applied.slice(0, 8);
      if (applied.length) {
        if (out.length) out.push("");
        out.push("auto-applied skills (evolution L1):");
        for (const s of applied) {
          const score = s.evalScore != null ? ` fitness ${s.evalScore.toFixed(2)}` : "";
          const flag = s.status === "rolled-back" ? " [rolled-back]" : "";
          out.push(`• ${s.name}${score}${flag} — ${s.at.slice(0, 10)}`);
        }
        out.push("undo: /proposals rollback <skill>");
      }
      return out.length ? out.join("\n") : "evolution: no pending proposals or auto-applied skills";
    }

    case "mode": {
      const arg = p.arg.trim().toLowerCase();
      if (!arg) {
        const cur = getChatMode(ctx.dir, ctx.adapter, ctx.chatId);
        return cur
          ? `mode: **${cur}** (sticky). Change: /mode ${TURN_MODES.join("|")} · clear: /mode off`
          : `mode: none (per-message prefix or default). Set sticky: /mode ${TURN_MODES.join("|")}`;
      }
      if (arg === "off" || arg === "clear" || arg === "none") {
        const had = clearChatMode(ctx.dir, ctx.adapter, ctx.chatId);
        return had ? "mode cleared — back to per-message / default" : "mode was not set";
      }
      const mode = parseModeArg(arg);
      if (!mode) return `unknown mode «${arg}». Use: ${TURN_MODES.join(" | ")} (or off)`;
      setChatMode(ctx.dir, ctx.adapter, ctx.chatId, mode);
      return `mode → **${mode}** (sticky; applies to messages without an explicit ADVICE:/DO:/… prefix)`;
    }

    case "cancel": {
      const arg = p.arg.trim();
      // I-126: `/cancel <fu_id>` drops a scheduled deferred follow-up.
      if (/^fu_/i.test(arg)) {
        const fu = getFollowup(ctx.dir, arg);
        if (!fu || peerKey(fu.adapter, fu.chatId) !== peerKey(ctx.adapter, ctx.chatId)) {
          return `Нет отложенной задачи с id ${arg} в этом чате.`;
        }
        clearFollowup(ctx.dir, arg);
        return `Отменил отложенную задачу ${arg} («${fu.reason.slice(0, 80)}»).`;
      }
      // I-125: bare `/cancel` abandons a parked clarifying question (no session reset).
      const had = clearPendingQuestion(ctx.dir, ctx.adapter, ctx.chatId);
      return had
        ? "Снял ожидание ответа на вопрос агента. Пиши что угодно — продолжим с нового."
        : "Нет ожидающего вопроса от агента. (Для отложенной задачи: /cancel <fu_id>.)";
    }

    case "model": {
      // I-174: sticky per-chat model. Unlike /engine this keeps the session —
      // every engine takes the model per turn — so the chat's context survives.
      // Deliberately NOT a config edit: engine.model is global and would drag
      // cron and the TUI along with it.
      const cfg = loadConfig(ctx.dir);
      const engine = getChatEngine(ctx.dir, ctx.adapter, ctx.chatId) ?? cfg.engine.provider;
      // Resolve the config default THROUGH the active engine: a sticky engine
      // switch drops engine.model (it named the other engine's model).
      const cfgModel = resolveEngineModel(
        engine === cfg.engine.provider ? cfg : { ...cfg, engine: { ...cfg.engine, provider: engine, model: undefined } }
      );
      const arg = p.arg.trim();
      const sticky = getChatModel(ctx.dir, ctx.adapter, ctx.chatId);

      if (!arg) {
        const known = suggestedModels(engine);
        return [
          `model: **${sticky ?? cfgModel}**${sticky ? " (sticky для чата)" : " (из конфига)"} · движок ${engine}`,
          known.length ? `Доступные: ${known.join(", ")}` : `Задай id модели движка ${engine}.`,
          `Сменить: /model <id> · сброс к конфигу: /model off`,
        ].join("\n");
      }
      if (arg.toLowerCase() === "off" || arg.toLowerCase() === "clear" || arg.toLowerCase() === "none") {
        const had = clearChatModel(ctx.dir, ctx.adapter, ctx.chatId);
        if (!had) return `sticky-модель не была задана — работает конфиг (**${cfgModel}**, движок ${engine})`;
        await ctx.reopenSession?.();
        return `модель → **${cfgModel}** (из конфига, движок ${engine}). Контекст сохранён.`;
      }
      if (/\s/.test(arg)) return `в id модели не бывает пробелов — «${arg}»`;
      // A cross-family id is accepted by nothing and would fail every following
      // message until /model off, so refuse it here (same reasoning as the
      // /engine credential pre-checks).
      const conflict = modelConflict(engine, arg);
      if (conflict) {
        const known = suggestedModels(engine);
        return `не переключаю: ${conflict}${known.length ? `. Доступные: ${known.join(", ")}` : ""}`;
      }
      if (arg === (sticky ?? cfgModel)) return `модель уже **${arg}** — ничего не меняю.`;
      setChatModel(ctx.dir, ctx.adapter, ctx.chatId, arg);
      await ctx.reopenSession?.();
      return `модель → **${arg}** (sticky, движок ${engine}). Контекст сохранён.`;
    }

    case "engine": {
      // I-143: sticky per-chat SDK engine. Engines cannot swap inside a live
      // SDK session, so every change resets the peer session.
      const cfgDefault = loadConfig(ctx.dir).engine.provider;
      const arg = p.arg.trim().toLowerCase();
      if (!arg) {
        const sticky = getChatEngine(ctx.dir, ctx.adapter, ctx.chatId);
        const active = sticky ?? cfgDefault;
        return [
          `engine: **${active}**${sticky ? " (sticky для чата)" : " (из конфига)"}`,
          `Сменить: /engine cursor | claude | codex · сброс к конфигу: /engine off`,
          `Смена движка всегда открывает новую сессию.`,
        ].join("\n");
      }
      if (arg === "off" || arg === "clear" || arg === "none") {
        const had = clearChatEngine(ctx.dir, ctx.adapter, ctx.chatId);
        if (!had) return `sticky-движок не был задан — работает конфиг (**${cfgDefault}**)`;
        await ctx.resetSession?.();
        return `движок → **${cfgDefault}** (из конфига). Сессия сброшена.`;
      }
      const engine = parseEngineArg(arg);
      if (!engine) return `неизвестный движок «${arg}». Варианты: cursor | claude | codex (или off)`;
      const current = getChatEngine(ctx.dir, ctx.adapter, ctx.chatId) ?? cfgDefault;
      if (engine === current) {
        return `движок уже **${engine}** — ничего не меняю. (Сбросить сессию: /new)`;
      }
      // Deterministic credential pre-checks (user report «session failed»):
      // a doomed sticky choice would fail EVERY message until /engine off —
      // refuse the switch with a fix hint instead.
      if (engine === "cursor" && !resolveApiKey(ctx.dir).key) {
        return "не переключаю: CURSOR_API_KEY не найден — сначала irida auth login --stdin";
      }
      if (engine === "claude-agent") {
        const auth = loadConfig(ctx.dir).engine.auth ?? "api-key";
        if (auth === "api-key" && !resolveAnthropicKey(ctx.dir).key) {
          return "не переключаю: ANTHROPIC_API_KEY не найден (engine.auth=api-key) — задай ключ или поставь engine.auth=account (claude login)";
        }
      }
      if (engine === "codex") {
        const auth = resolveEngineAuth({ ...loadConfig(ctx.dir).engine, provider: "codex" });
        if (auth === "api-key" && !resolveOpenAiKey(ctx.dir).key) {
          return "не переключаю: OPENAI_API_KEY не найден (engine.auth=api-key) — задай ключ или поставь engine.auth=account (codex login)";
        }
        if (auth === "account" && !codexAccountAvailable()) {
          return "не переключаю: нет сессии codex — сначала выполни `codex login`";
        }
      }
      setChatEngine(ctx.dir, ctx.adapter, ctx.chatId, engine);
      await ctx.resetSession?.();
      return `движок → **${engine}** (sticky). Новая сессия — следующее сообщение пойдёт на нём.`;
    }

    case "stop": {
      // I-138: on Telegram the poller intercepts /stop BEFORE the queue (inside
      // it, it would wait behind the very turn it stops). Reaching this handler
      // means nothing was in flight for this chat.
      return "Нечего прерывать — сейчас ничего не выполняется.";
    }

    case "followups": {
      // I-126: list this chat's pending deferred follow-ups.
      const items = listFollowups(ctx.dir, ctx.adapter, ctx.chatId);
      if (items.length === 0) return "Нет отложенных задач. (Агент создаёт их сам через defer_followup.)";
      const now = Date.now();
      const lines = items
        .slice()
        .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
        .map((f) => {
          const mins = Math.round((Date.parse(f.dueAt) - now) / 60000);
          const when = mins <= 0 ? "вот-вот" : `через ~${mins} мин`;
          return `• ${f.id} (${when}): ${f.reason.replace(/\s+/g, " ").slice(0, 90)}`;
        });
      return ["Отложенные задачи:", ...lines, "", "Отменить: /cancel <id>"].join("\n");
    }

    case "memory": {
      const q = p.arg.trim();
      const memCfg = loadConfig(ctx.dir);
      const store = createMemoryStore(ctx.dir, memCfg.stateDir);
      try {
        if (!q || q.toLowerCase() === "list") {
          const notes = await store.listNotes();
          if (notes.length === 0) return "Память пуста.";
          const head = notes.slice(0, 15).map((n) => `• ${n.name} [${n.wing}] ${n.title}`);
          const tail = notes.length > 15 ? `\n…ещё ${notes.length - 15}` : "";
          return ["irida memory:", ...head].join("\n") + tail;
        }
        const hits = await store.searchNotes(q, 10);
        if (hits.length === 0) return `Нет совпадений по «${q}».`;
        return [
          `irida memory search: «${q}»`,
          ...hits.map(
            (n) =>
              `• ${n.name}: ${n.body.replace(/\s+/g, " ").trim().slice(0, 120)}`
          ),
        ].join("\n");
      } finally {
        await store.close();
      }
    }

    case "sessions": {
      const peers = loadGatewayPeers(ctx.dir);
      const key = peerKey(ctx.adapter, ctx.chatId);
      const sessionId = peers.peers[key];
      const memCfg = loadConfig(ctx.dir);
      const store = createStore(ctx.dir, memCfg.stateDir);
      try {
        const hits = await searchSessions(store, p.arg || "", {
          channel: ctx.adapter,
          limit: 10,
        });
        const lines = hits.map(
          (s) => `${s.id} [${s.last_status || "?"}] ${(s.title || "").slice(0, 60)}`
        );
        const cur = sessionId ? `\nТекущая: ${sessionId}` : "";
        if (lines.length === 0) return `Нет сессий.${cur}`;
        return [`irida sessions:`, ...lines, cur].join("\n");
      } finally {
        await store.close();
      }
    }

    case "skills": {
      const configured = ctx.skills.length ? ctx.skills : ctx.cfg.skills;
      if (configured.length) {
        return `irida skills (gateway): ${configured.join(", ")}`;
      }
      const cfg = loadConfig(ctx.dir);
      const all = listSkills(ctx.dir, cfg.skillsPath).slice(0, 12);
      if (all.length === 0) return "Нет skills в каталоге skills/.";
      return ["irida skills:", ...all.map((s) => `• ${s.name}: ${s.description.slice(0, 60)}`)].join(
        "\n"
      );
    }

    case "vesper": {
      // Owner→ward channel (I-158): bare = status, text = letter to his inbox.
      const { vesperStatus, vesperTell } = await import("./gatewayVesper.js");
      return p.arg ? vesperTell(p.arg) : vesperStatus();
    }

    case "fable": {
      // Owner→interactive-session channel (I-160): bare = status, text = to the
      // session's polling inbox; the session replies back into this Telegram.
      const { fableStatus, fableTell } = await import("./gatewayFable.js");
      return p.arg ? fableTell(p.arg) : fableStatus();
    }

    case "approve": {
      if (!p.arg) return "Использование: /approve <код>";
      const out = await tryApprovePairing(ctx.dir, ctx.chatId, p.arg);
      return out.message;
    }

    case "pause": {
      const reason = p.arg.trim() || `gateway chat ${ctx.chatId}`;
      setBackgroundPaused(ctx.dir, true, reason);
      return `⏸ Фоновые задачи на паузе — ${reason}. Cron не запускает задания (отвечаю только на твои сообщения). /resume чтобы снять.`;
    }

    case "resume": {
      setBackgroundPaused(ctx.dir, false);
      const st = backgroundPauseState(ctx.dir);
      if (st.paused && st.source === "env") {
        return "Флаг снят, но CSAGENT_PAUSE_BACKGROUND ещё установлен — фон остаётся на паузе.";
      }
      return "▶️ Фоновые задачи возобновлены — cron снова запускает задания по расписанию.";
    }

    case "delegate": {
      const prompt = p.arg.trim();
      if (!prompt) return "Использование: /delegate <prompt>";
      if (!ctx.getSession) return "delegate недоступен (нет сессии)";
      const session = await ctx.getSession();
      const out = await runDelegate({
        dir: ctx.dir,
        prompt,
        skills: ctx.skills.length ? ctx.skills : ctx.cfg.skills,
        yesIUnderstand: ctx.yesIUnderstand,
      });
      if (out.ok) {
        await session.injectContext(`[delegate] ${prompt}`, out.summary);
        return `[delegate]\n${out.summary}`;
      }
      return `Delegate failed: ${out.summary}`;
    }

    case "undo": {
      const out = await undoLastAction(ctx.dir);
      return out.message;
    }

    case "schedule": {
      const sub = (p.arg.split(/\s+/)[0] ?? "").toLowerCase();
      const rest = p.arg.slice(sub.length).trim();
      switch (sub) {
        case "":
        case "help":
          return scheduleSlashHelpText();
        case "list":
          return listCronJobsText(ctx.dir, "all");
        case "user":
          return listCronJobsText(ctx.dir, "user");
        case "pending":
          return listPendingCronSchedulesText(ctx.dir, ctx.chatId);
        case "add": {
          const draft = parseScheduleAddArgs(`add ${rest}`);
          if (!draft) {
            return "Использование: /schedule add `<cron>` `<id>` `<prompt…>`\nПример: /schedule add 0 9 * * 1 weekly-inbox Summarize tasks";
          }
          const out = addUserCronJob(ctx.dir, draft, {
            chatId: ctx.chatId,
            telegram: true,
          });
          return out.message;
        }
        case "remove": {
          if (!rest) return "Использование: /schedule remove `<id>`";
          return removeUserCronJob(ctx.dir, rest.split(/\s+/)[0]!).message;
        }
        case "approve": {
          if (!rest) return "Использование: /schedule approve `<код>`";
          return approveCronSchedule(ctx.dir, rest.split(/\s+/)[0]!, ctx.chatId).message;
        }
        default:
          return scheduleSlashHelpText();
      }
    }

    default:
      return null;
  }
}
