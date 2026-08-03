/**
 * Unified slash command catalog (Wave C2).
 * Single source for TUI autocomplete/help, gateway routing, and Telegram setMyCommands.
 * Handlers stay in tui/slash.ts and gatewaySlash.ts — this module is metadata only.
 */
export type SlashSurface = "tui" | "gateway";

export interface SlashRegistryEntry {
  cmd: string;
  /** TUI / default description (English). */
  desc: string;
  /** Gateway / Telegram description (optional override). */
  descGateway?: string;
  args?: string;
  surfaces: SlashSurface[];
  /** Include in Telegram Bot API menu when gateway surface (default true). */
  telegramMenu?: boolean;
}

export const SLASH_REGISTRY: SlashRegistryEntry[] = [
  { cmd: "help", desc: "Show commands and hotkeys", descGateway: "Список команд irida", surfaces: ["tui", "gateway"] },
  { cmd: "clear", desc: "Clear transcript", surfaces: ["tui"] },
  { cmd: "sessions", desc: "Pick a stored session", descGateway: "Последние сессии (этот чат)", surfaces: ["tui", "gateway"] },
  { cmd: "resume", desc: "Switch session by id", descGateway: "Возобновить фоновые задачи (cron)", args: "<id>", surfaces: ["tui", "gateway"] },
  { cmd: "pause", desc: "Pause autonomous cron", descGateway: "Поставить фоновые задачи на паузу", surfaces: ["gateway"] },
  { cmd: "new", desc: "Start a fresh chat session", descGateway: "Новая сессия (сброс контекста)", surfaces: ["tui", "gateway"] },
  { cmd: "skills", desc: "List local skills", descGateway: "Skills из gateway.json", surfaces: ["tui", "gateway"] },
  { cmd: "memory", desc: "List durable memories", descGateway: "Поиск в памяти", args: "<запрос>", surfaces: ["tui", "gateway"] },
  { cmd: "doctor", desc: "Environment checks", descGateway: "Краткая проверка окружения", surfaces: ["tui", "gateway"] },
  { cmd: "tools", desc: "Tool / MCP activity log", surfaces: ["tui"] },
  { cmd: "mcp", desc: "Show MCP server config", surfaces: ["tui"] },
  { cmd: "copy", desc: "Copy last reply (OSC52)", surfaces: ["tui"] },
  { cmd: "find", desc: "Search transcript (repeat = older match)", args: "<text>", surfaces: ["tui"] },
  { cmd: "export", desc: "Export transcript markdown", args: "[path]", surfaces: ["tui"] },
  { cmd: "rename", desc: "Rename current session", args: "<title>", surfaces: ["tui"] },
  { cmd: "delegate", desc: "Isolated subagent run (summary only)", descGateway: "Изолированный subagent (summary → сессия)", args: "<prompt>", surfaces: ["tui", "gateway"] },
  { cmd: "exit", desc: "Quit TUI", surfaces: ["tui"] },
  { cmd: "status", desc: "Gateway and launchd status", descGateway: "Статус gateway и launchd", surfaces: ["gateway"] },
  { cmd: "usage", desc: "Token + cost usage", descGateway: "Расход токенов и $ (24ч + сессия)", surfaces: ["gateway"] },
  { cmd: "proposals", desc: "Evolution queue + auto-applied skills (rollback <skill>)", descGateway: "Очередь эволюции + авто-скиллы (rollback <skill>)", surfaces: ["gateway"] },
  { cmd: "vesper", desc: "Ouroboros ward: status / message to his inbox", descGateway: "Веспер: статус / письмо ему в inbox", args: "[текст]", surfaces: ["gateway"] },
  { cmd: "fable", desc: "Interactive Fable session: status / message to its inbox", descGateway: "Fable: статус / письмо в лоток сессии", args: "[текст]", surfaces: ["gateway"] },
  { cmd: "approve", desc: "Approve pairing code", descGateway: "Подтвердить pairing-код", args: "<код>", surfaces: ["gateway"] },
  { cmd: "schedule", desc: "Cron schedule ops", descGateway: "Cron: list/add/approve", args: "[subcommand]", surfaces: ["gateway"] },
  { cmd: "undo", desc: "Undo last reversible mutation", descGateway: "Отменить последнее действие", surfaces: ["tui", "gateway"] },
  { cmd: "mode", desc: "Sticky turn mode (advice/do/debug/sync)", descGateway: "Режим ответа: advice/do/debug/sync (или off)", args: "[advice|do|debug|sync|off]", surfaces: ["gateway"] },
  { cmd: "cancel", desc: "Abandon pending question / a follow-up by id", descGateway: "Отменить вопрос агента или отложенную задачу (/cancel <fu_id>)", args: "[fu_id]", surfaces: ["gateway"] },
  { cmd: "stop", desc: "Discard current turn + clear queue", descGateway: "Прервать: отбросить текущий ответ и очистить очередь", surfaces: ["gateway"] },
  { cmd: "followups", desc: "List scheduled deferred follow-ups", descGateway: "Отложенные задачи агента (defer_followup)", surfaces: ["gateway"] },
  { cmd: "engine", desc: "Pick SDK engine (new session)", descGateway: "Движок SDK: cursor | claude | codex (sticky, новая сессия)", args: "[cursor|claude|codex|off]", surfaces: ["tui", "gateway"] },
];

export function slashEntriesForSurface(surface: SlashSurface): SlashRegistryEntry[] {
  return SLASH_REGISTRY.filter((e) => e.surfaces.includes(surface));
}

export function slashRegistryHasCommand(cmd: string, surface: SlashSurface): boolean {
  const c = cmd.toLowerCase();
  if (surface === "gateway" && c === "mem") return slashRegistryHasCommand("memory", surface);
  return slashEntriesForSurface(surface).some((e) => e.cmd === c);
}

export function formatSlashUsage(entry: SlashRegistryEntry, surface: SlashSurface): string {
  const args = entry.args ?? "";
  return args ? `/${entry.cmd} ${args}` : `/${entry.cmd}`;
}

export function slashDescForSurface(entry: SlashRegistryEntry, surface: SlashSurface): string {
  if (surface === "gateway" && entry.descGateway) return entry.descGateway;
  return entry.desc;
}

/** TUI autocomplete rows. */
export interface TuiSlashCommandDef {
  cmd: string;
  desc: string;
  args?: string;
}

export function tuiSlashCommands(): TuiSlashCommandDef[] {
  return slashEntriesForSurface("tui").map((e) => ({
    cmd: e.cmd,
    desc: e.desc,
    args: e.args,
  }));
}

/** Gateway catalog row (legacy shape). */
export interface GatewaySlashCommandDef {
  cmd: string;
  desc: string;
  args?: string;
  telegram?: boolean;
}

export function gatewaySlashCommands(): GatewaySlashCommandDef[] {
  return slashEntriesForSurface("gateway").map((e) => ({
    cmd: e.cmd,
    desc: slashDescForSurface(e, "gateway"),
    args: e.args,
    telegram: e.telegramMenu !== false,
  }));
}

export function telegramBotCommandsFromRegistry(): Array<{ command: string; description: string }> {
  return slashEntriesForSurface("gateway")
    .filter((e) => e.telegramMenu !== false)
    .map((e) => {
      const desc = e.args
        ? `${slashDescForSurface(e, "gateway")} ${e.args}`
        : slashDescForSurface(e, "gateway");
      return {
        command: e.cmd.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32),
        description: desc.slice(0, 256),
      };
    });
}

/** Match slash command prefixes for TUI autocomplete (first token only). */
export function filterSlashSuggestions(input: string, commands: TuiSlashCommandDef[]): string[] {
  const t = input.trimStart();
  if (!t.startsWith("/")) return [];
  const body = t.slice(1);
  if (body.includes(" ")) return [];
  const partial = body.toLowerCase();
  return commands
    .filter((c) => c.cmd.startsWith(partial))
    .map((c) => (c.args ? `/${c.cmd} ` : `/${c.cmd}`));
}

export function commonSlashPrefix(suggestions: string[]): string {
  if (suggestions.length === 0) return "";
  if (suggestions.length === 1) return suggestions[0]!;
  let prefix = suggestions[0]!;
  for (const s of suggestions.slice(1)) {
    while (!s.startsWith(prefix) && prefix.length > 1) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

export function tuiSlashHelpLines(): string[] {
  const rows = tuiSlashCommands().map((c) => {
    const usage = c.args ? `/${c.cmd} ${c.args}` : `/${c.cmd}`;
    return `${usage.padEnd(18)} — ${c.desc}`;
  });
  return [
    ...rows,
    "",
    "session tabs: 1-5 · Tab/Shift+Tab · ←→ (empty input) · Ctrl+[ ]",
    "trackpad scroll · @memory: · /rename · Ctrl+T · @file:<Tab> · Ctrl+O scroll",
    "CSAGENT_LOG=1 → diagnostics in .agent/tui.log (rotation, runs); CSAGENT_AGENT_IDLE_MS=0 disables idle refresh",
  ];
}

export function gatewaySlashHelpLines(): string[] {
  return gatewaySlashCommands()
    .filter((c) => c.telegram !== false)
    .map((c) => {
      const usage = c.args ? `/${c.cmd} ${c.args}` : `/${c.cmd}`;
      return `${usage} — ${c.desc}`;
    });
}
