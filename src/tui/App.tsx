import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { openChatSession, type ChatSession } from "../chatEngine.js";
import { SESSION_CHANNEL } from "../sessionChannel.js";
import { formatSdkError } from "../sdkErrors.js";
import { bannerFor, COMPACT_BANNER_COLS, theme } from "./theme.js";
import { Composer } from "./components/Composer.js";
import { ConfirmDialog } from "./components/ConfirmDialog.js";
import { MessageList } from "./components/MessageList.js";
import { StatusBar } from "./components/StatusBar.js";
import { HelpPanel } from "./components/HelpPanel.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { ThinkingBar } from "./components/ThinkingBar.js";
import { ActivityBar } from "./components/ActivityBar.js";
import { ToolCallBanner } from "./components/ToolCallBanner.js";
import { SlashSuggest } from "./components/SlashSuggest.js";
import { DoctorPanel } from "./components/DoctorPanel.js";
import { SkillsPanel } from "./components/SkillsPanel.js";
import { MemoryPanel } from "./components/MemoryPanel.js";
import { PetCorner } from "./components/PetCorner.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { McpPanel } from "./components/McpPanel.js";
import { ToolsPanel } from "./components/ToolsPanel.js";
import { listPickerModelsFallback, listPickerModelsFromSdk, type ModelListSource } from "./models.js";
import { formatTranscriptMarkdown, resolveExportPath, writeTranscriptExport, ExportPathError } from "./exportTranscript.js";
import { listMcpEntries } from "./mcpView.js";
import { lastAssistantText, osc52Copy } from "./clipboard.js";
import { runDelegate } from "../delegateRun.js";
import { undoLastAction } from "../undoAction.js";
import { parseSlash } from "./slash.js";
import { commonSlashPrefix, filterSlashSuggestions } from "./slashCatalog.js";
import {
  estimateVisibleLines,
  maxScrollOffset,
  messagesToRowsCached,
  nextSearchCursor,
  runsToMessages,
  scrollOffsetForRow,
  scrollPositionLabel,
  searchTranscriptRows,
  shouldVirtualizeTranscript,
  useNativeTrackpadScroll,
  viewportRows,
  type MessageRowCache,
} from "./transcript.js";
import { overlayCloseScrollState } from "./overlayLifecycle.js";
import { listStoredSessions, loadSessionRuns, renameStoredSession } from "./loadSessions.js";
import {
  applyContextRefCompletion,
  commonPathPrefix,
  completeContextRef,
  parseContextRefPrefix,
} from "./pathComplete.js";
import { useAltScreen, useTerminalSize } from "./terminal.js";
import { decideClaudeAuth } from "./engineAuth.js";
import type { ActivityDetail } from "../host.js";
import type { ActivityEntry, ChatMessage, ConfirmState, Overlay, SessionMeta, TurnStats } from "./types.js";
import type { SessionRecord } from "../store.js";
import { resolveAgentLogger } from "../agentLog.js";
import { resolve as resolvePath } from "node:path";
import { loadConfig } from "../config.js";
import { parseEngineArg } from "../gatewayEngineStore.js";
import {
  resolveApiKey,
  resolveAnthropicKey,
  resolveOpenAiKey,
  claudeAccountAvailable,
  codexAccountAvailable,
} from "../credentials.js";
import { indexOfLastAssistant, indexOfStreamingAssistant } from "./streamingTarget.js";
import {
  formatToolProgressLine,
  isStreamToolProgressPlaceholder,
  shouldInjectToolProgressIntoStream,
} from "./toolProgress.js";
import { classifyPetActivity, deriveTuiPetState, type PetActivityKind } from "../petTerminal.js";
import { levelForXp, type PetState } from "../petState.js";
import { readPetStateSnapshot } from "../petRuntime.js";

let msgSeq = 0;
function nextId(prefix: string): string {
  return `${prefix}-${++msgSeq}`;
}

let actSeq = 0;
function pushActivity(
  setter: React.Dispatch<React.SetStateAction<ActivityEntry[]>>,
  entry: Omit<ActivityEntry, "id" | "at">
) {
  setter((prev) => {
    if (entry.callId && entry.phase === "result") {
      const idx = prev.findIndex((x) => x.callId === entry.callId && x.phase === "call");
      if (idx >= 0) {
        const next = [...prev];
        const cur = next[idx]!;
        const finishedAt = new Date().toISOString();
        const durationMs =
          entry.durationMs ??
          (cur.at ? Math.max(0, Date.parse(finishedAt) - Date.parse(cur.at)) : undefined);
        next[idx] = {
          ...cur,
          ...entry,
          id: cur.id,
          at: cur.at,
          finishedAt,
          durationMs,
          label: entry.label || cur.label,
          command: entry.command || cur.command,
          status: entry.status ?? "completed",
          phase: "call",
        };
        return next;
      }
    }
    return [
      ...prev.slice(-99),
      {
        id: `act-${++actSeq}`,
        at: new Date().toISOString(),
        ...entry,
      },
    ];
  });
}

export interface TuiOptions {
  dir?: string;
  skills?: string[];
  yesIUnderstand?: boolean;
  /** Override engine.provider (--engine). */
  engine?: string;
  /** Override engine.auth (--auth). */
  auth?: string;
}

export function App(props: TuiOptions) {
  const { exit } = useApp();
  // Reactive size (I-156): re-renders on terminal resize so cols/rows-derived
  // layout (wrap width, viewport height, tab-bar width) never drifts.
  const { cols, rows } = useTerminalSize();
  const dir = props.dir ?? process.cwd();
  const altScreen = useAltScreen();

  const sessionRef = useRef<ChatSession | null>(null);
  const bootGen = useRef(0);
  const bootChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const rowCacheRef = useRef<MessageRowCache>(new Map());
  const searchRef = useRef<{ query: string; cursor: number | null }>({ query: "", cursor: null });
  const agentLog = useMemo(() => {
    // stdout writes corrupt Ink rendering — TUI diagnostics go to <stateDir>/tui.log (I-17).
    let stateDir = ".agent";
    try {
      stateDir = loadConfig(dir).stateDir;
    } catch {
      /* boot surfaces config errors elsewhere */
    }
    return resolveAgentLogger({ component: "tui", logFile: resolvePath(dir, stateDir, "tui.log") });
  }, [dir]);

  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    let engineLabel = "the agent";
    try {
      const provider = props.engine ?? loadConfig(dir).engine?.provider ?? "cursor";
      engineLabel =
        provider === "claude-agent"
          ? "Claude Agent SDK"
          : provider === "codex"
          ? "Codex"
          : "Cursor SDK";
    } catch {
      /* default label */
    }
    return [{ id: nextId("sys"), role: "system", text: `Connecting to ${engineLabel}…` }];
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [exiting, setExiting] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [holdNativeScroll, setHoldNativeScroll] = useState(false);
  const [scrollMode, setScrollMode] = useState(false);
  const [scrollLineOffset, setScrollLineOffset] = useState(0);
  const [activity, setActivity] = useState<string | null>(null);
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([]);
  const [lastTurnStats, setLastTurnStats] = useState<TurnStats | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [petClock, setPetClock] = useState(0);
  const [petRetryAt, setPetRetryAt] = useState<number | null>(null);
  const [petStoreDegraded, setPetStoreDegraded] = useState(false);
  // Did THIS turn degrade the store? An ok turn only clears the worry when its
  // own persists were clean (I-150) — otherwise worried would never be visible.
  const petDegradeTurnRef = useRef(false);
  const [petLevel, setPetLevel] = useState(() => levelForXp(readPetStateSnapshot(props.dir ?? process.cwd())?.xp ?? 0));
  const [lastTurnOk, setLastTurnOk] = useState(false);
  const [lastTurnError, setLastTurnError] = useState(false);
  const lastPetEventAtRef = useRef(Date.now());
  const [, tick] = useState(0);
  const [pickerSessions, setPickerSessions] = useState<SessionRecord[]>([]);
  const [thinkingText, setThinkingText] = useState("");
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [modelOverride, setModelOverride] = useState<string | undefined>(undefined);
  // /engine override (I-143). A ref, not state: the switch handler reboots the
  // session immediately after setting it — setState would race the reboot.
  const engineOverrideRef = useRef<string | undefined>(undefined);
  // Auth mode chosen alongside an /engine claude switch (I-156). Mirrors the
  // engine override so a switch can reach account mode without editing config.
  const engineAuthRef = useRef<string | undefined>(undefined);
  const [modelPickerIndex, setModelPickerIndex] = useState(0);
  const [pickerModels, setPickerModels] = useState<string[]>(() => listPickerModelsFallback(dir));
  const [modelListSource, setModelListSource] = useState<ModelListSource>("fallback");
  const [modelListError, setModelListError] = useState<string | undefined>();
  const mcpView = useMemo(() => listMcpEntries(dir), [dir]);

  const refreshPickerModels = useCallback(async () => {
    const r = await listPickerModelsFromSdk(dir);
    setPickerModels(r.models);
    setModelListSource(r.source);
    setModelListError(r.error);
    return r;
  }, [dir]);

  useEffect(() => {
    void refreshPickerModels();
  }, [refreshPickerModels]);

  const slashSuggestions = useMemo(() => filterSlashSuggestions(input), [input]);

  const confirmRef = useRef<(reason: string) => Promise<boolean>>(async () => false);
  confirmRef.current = (reason) =>
    new Promise((resolve) => {
      setConfirm({ reason, resolve });
    });

  const noteActivity = useCallback((entry: ActivityDetail) => {
    lastPetEventAtRef.current = Date.now();
    setActivity(entry.toolName ?? entry.label);
    pushActivity(setActivityLog, {
      label: entry.label,
      kind: entry.kind,
      toolName: entry.toolName,
      command: entry.command,
      status: entry.status,
      phase: entry.phase,
      callId: entry.callId,
      detail: entry.detail,
      exitCode: entry.exitCode,
      durationMs: entry.durationMs,
      stdoutPreview: entry.stdoutPreview,
    });
    if (shouldInjectToolProgressIntoStream(entry)) {
      const line = formatToolProgressLine(entry);
      if (line) {
        setMessages((prev) => {
          const idx = indexOfStreamingAssistant(prev);
          if (idx < 0) return prev;
          const cur = prev[idx]!;
          if (cur.text.trim()) return prev;
          const next = [...prev];
          next[idx] = { ...cur, text: line };
          return next;
        });
      }
    }
  }, []);

  useEffect(() => {
    if (!busy || turnStartedAt == null) return;
    const id = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [busy, turnStartedAt]);

  const petState: PetState = useMemo(
    () =>
      deriveTuiPetState({
        busy,
        activityLog,
        lastTurnOk,
        lastTurnError,
        retryAtMs: petRetryAt ?? undefined,
        storeDegraded: petStoreDegraded,
        lastEventAtMs: lastPetEventAtRef.current,
        nowMs: Date.now(),
      }),
    [busy, activityLog, lastTurnOk, lastTurnError, petRetryAt, petStoreDegraded, petClock]
  );

  const petActivity: PetActivityKind | undefined = useMemo(() => {
    if (petState !== "working") return undefined;
    for (let i = activityLog.length - 1; i >= 0; i--) {
      const e = activityLog[i]!;
      if (e.phase === "call" && e.status === "running") {
        return classifyPetActivity(e.toolName, e.kind);
      }
    }
    return undefined;
  }, [petState, activityLog]);

  useEffect(() => {
    const ms = busy ? 400 : 1000;
    const id = setInterval(() => setPetClock((c) => c + 1), ms);
    return () => clearInterval(id);
  }, [busy]);

  const patchThinking = useCallback((chunk: string) => {
    setThinkingText((prev) => {
      if (!chunk) return prev;
      if (chunk.length >= prev.length && chunk.startsWith(prev)) return chunk;
      return prev + chunk;
    });
  }, []);

  const patchStreaming = useCallback((delta: string) => {
    if (!delta) return;
    setMessages((prev) => {
      const idx = indexOfStreamingAssistant(prev);
      if (idx < 0) return prev;
      const next = [...prev];
      const cur = next[idx]!;
      const base = isStreamToolProgressPlaceholder(cur.text) ? "" : cur.text;
      next[idx] = { ...cur, text: base + delta };
      return next;
    });
  }, []);

  const finishStreaming = useCallback(() => {
    setMessages((prev) => {
      const idx = indexOfStreamingAssistant(prev);
      if (idx < 0) return prev;
      const next = [...prev];
      const cur = next[idx]!;
      next[idx] = { ...cur, streaming: false };
      return next;
    });
  }, []);

  const pushMessage = useCallback((msg: Omit<ChatMessage, "id">) => {
    setMessages((prev) => [...prev, { ...msg, id: nextId(msg.role) }]);
  }, []);

  const resetTurnRetry = useCallback((reason?: string) => {
    const idle = reason?.startsWith("idle_ttl");
    setThinkingText(idle ? "Refreshing agent after idle…" : "Continuing after refresh…");
    // Overload retries hiccup the pet; idle-ttl rotation is routine, not a jolt.
    if (!idle) setPetRetryAt(Date.now());
  }, []);

  const bootSession = useCallback(
    async (resumeSessionId?: string) => {
      const job = bootChainRef.current.then(async () => {
      const gen = ++bootGen.current;
      await sessionRef.current?.close();
      sessionRef.current = null;

      const opened = await openChatSession({
        dir,
        skills: props.skills,
        yesIUnderstand: props.yesIUnderstand,
        engine: engineOverrideRef.current ?? props.engine,
        auth: engineAuthRef.current ?? props.auth,
        model: modelOverride,
        resumeSessionId,
        channel: SESSION_CHANNEL.tui,
        interactive: true,
        confirm: (reason) => confirmRef.current(reason),
        onAssistantDelta: (d) => patchStreaming(d),
        onThinkingDelta: (d) => patchThinking(d),
        onActivity: (entry) => noteActivity(entry),
        onTurnRetry: resetTurnRetry,
        onStoreDegraded: () => {
          petDegradeTurnRef.current = true;
          setPetStoreDegraded(true);
        },
        onAgentRotating: (info) => {
          const idle = (info.reason ?? "").startsWith("idle_ttl");
          noteActivity({
            label: idle ? "refreshing idle agent…" : "reinitializing agent…",
            kind: "other",
            command: info.reason,
            phase: "call",
          });
        },
        onAgentRotated: (info) => {
          const from = info.previousAgentId?.slice(0, 6) ?? "-";
          const to = info.newAgentId?.slice(0, 6) ?? "-";
          const replay =
            info.replayTurns > 0 ? `replay ${info.replayTurns} turns · ` : "";
          const idle = info.reason?.startsWith("idle_ttl");
          const why = idle
            ? " (session idle — proactive refresh)"
            : info.reason
              ? ` (${info.reason})`
              : "";
          pushMessage({
            role: "system",
            text: idle
              ? `· Session idle · refreshed agent · ${replay}agent ${from}… → ${to}…`
              : `· SDK agent reinitialized · ${replay}agent ${from}… → ${to}…${why}`,
          });
          noteActivity({
            label: idle ? "refreshing after idle" : "continuing after rotation",
            kind: "other",
            command: idle ? "Proactive agent refresh" : "SDK agent reinitialized",
            phase: "call",
          });
          setMeta((m) => (m ? { ...m, agentId: info.newAgentId } : m));
        },
        onLog: agentLog,
      });

      if (gen !== bootGen.current) {
        if (opened.ok) await opened.session.close();
        return opened.ok ? null : opened;
      }

      if (!opened.ok) {
        setFatal(opened.message);
        setMessages([{ id: nextId("err"), role: "error", text: opened.message }]);
        setMeta(null);
        return opened;
      }

      sessionRef.current = opened.session;
      const s = opened.session;
      setMeta({
        sessionId: s.sessionId,
        agentId: s.agentId,
        cwd: s.cfg.cwd,
        model: s.cfg.model,
        connectMode: s.connectMode,
      });
      setFatal(null);
      setScrollLineOffset(0);
      setScrollMode(false);
      rowCacheRef.current.clear();
      setActivityLog([]);
      setLastTurnStats(null);
      setTurnStartedAt(null);

      const history = resumeSessionId
        ? runsToMessages(await loadSessionRuns(dir, resumeSessionId))
        : [];
      const modeNote =
        s.connectMode === "resumed"
          ? "live resume"
          : s.connectMode === "replayed"
            ? "transcript replay"
            : "new session";
      setMessages([
        {
          id: nextId("sys"),
          role: "system",
          text: `${modeNote} · ${s.sessionId.slice(0, 10)}… · ${s.cfg.model}`,
        },
        ...history,
      ]);
      return opened;
      });
      bootChainRef.current = job.catch(() => {});
      return job;
    },
    [agentLog, dir, modelOverride, noteActivity, patchStreaming, patchThinking, props.skills, props.yesIUnderstand, pushMessage, resetTurnRetry]
  );

  useEffect(() => {
    void bootSession();
    return () => {
      bootGen.current++;
      void sessionRef.current?.close();
      sessionRef.current = null;
    };
  }, [bootSession]);

  // Chrome = every non-transcript row, computed from what is actually on screen
  // (I-156) instead of a fixed guess: banner box, optional tab bar, transcript
  // borders, live bars, composer + slash hint, status bar. Feeds the scroll
  // viewport height so paging/virtualization track the real layout.
  const chromeLines = useMemo(() => {
    const bannerLines = cols < COMPACT_BANNER_COLS ? 1 : 4; // compact 1 vs box 4
    const thinking = thinkingText ? (thinkingExpanded ? 6 : 1) : 0;
    const activity = busy || activityLog.length > 0 ? 1 : 0;
    const slash = slashSuggestions.length > 0 ? 1 : 0;
    const boxBorders = 2;
    const composer = 3;
    const statusBar = 3;
    return bannerLines + boxBorders + thinking + activity + slash + composer + statusBar;
  }, [cols, thinkingText, thinkingExpanded, busy, activityLog.length, slashSuggestions.length]);
  const visibleLines = useMemo(() => estimateVisibleLines(rows, chromeLines), [rows, chromeLines]);
  const allRows = useMemo(
    () => messagesToRowsCached(messages, cols, rowCacheRef.current),
    [messages, cols]
  );
  const maxScroll = useMemo(() => maxScrollOffset(allRows.length, visibleLines), [allRows.length, visibleLines]);
  const viewport = useMemo(
    () => viewportRows(allRows, visibleLines, scrollLineOffset),
    [allRows, visibleLines, scrollLineOffset]
  );
  const transcriptScrollable = shouldVirtualizeTranscript(allRows.length, visibleLines);
  const nativeTrackpadScroll = useNativeTrackpadScroll({
    altScreen,
    scrollLineOffset,
    scrollMode,
    overlay: overlay != null,
    holdNativeScroll,
  });
  const displayRows = nativeTrackpadScroll ? allRows : viewport.visible;
  const displayHiddenAbove = nativeTrackpadScroll ? 0 : viewport.hiddenAbove;
  const displayHiddenBelow = nativeTrackpadScroll ? 0 : viewport.hiddenBelow;
  const displayAtBottom = nativeTrackpadScroll ? true : viewport.atBottom;
  const scrollPosLabel = scrollPositionLabel(allRows.length, viewport.hiddenAbove, visibleLines);

  const scrollKeysActive =
    !overlay &&
    !confirm &&
    !exiting &&
    !nativeTrackpadScroll &&
    (scrollMode || transcriptScrollable) &&
    (scrollMode || input === "" || busy);

  const scrollUp = useCallback(
    (lines = 1) => {
      setHoldNativeScroll(false);
      setScrollLineOffset((o) => Math.min(maxScroll, o + lines));
    },
    [maxScroll]
  );
  const scrollDown = useCallback(
    (lines = 1) => {
      setHoldNativeScroll(false);
      setScrollLineOffset((o) => Math.max(0, o - lines));
    },
    []
  );
  const scrollToBottom = useCallback(() => {
    setScrollLineOffset(0);
    setScrollMode(false);
  }, []);

  const scrollToTop = useCallback(() => {
    setScrollLineOffset(maxScroll);
  }, [maxScroll]);

  const shutdown = useCallback(async () => {
    if (exiting) return;
    setExiting(true);
    await sessionRef.current?.close();
    sessionRef.current = null;
    exit();
  }, [exit, exiting]);

  const openOverlay = useCallback((kind: NonNullable<Overlay>) => {
    setOverlay(kind);
  }, []);

  const finishOverlay = useCallback(() => {
    setOverlay(null);
    setScrollLineOffset((o) => overlayCloseScrollState(o).scrollLineOffset);
    setScrollMode(false);
    setHoldNativeScroll(false);
  }, []);

  const openSessionsOverlay = useCallback(async () => {
    try {
      setInput("");
      setPickerSessions(await listStoredSessions(dir));
      openOverlay("sessions");
    } catch (e) {
      pushMessage({ role: "error", text: String(e) });
    }
  }, [dir, openOverlay, pushMessage]);

  const closeOverlay = finishOverlay;

  const switchToSession = useCallback(
    async (record: SessionRecord) => {
      finishOverlay();
      setBusy(true);
      const out = await bootSession(record.id);
      setBusy(false);
      if (out && !out.ok) {
        pushMessage({ role: "error", text: out.message });
      }
    },
    [bootSession, finishOverlay, pushMessage]
  );

  const applyModel = useCallback(
    async (model: string) => {
      finishOverlay();
      setModelOverride(model);
      setBusy(true);
      pushMessage({ role: "system", text: `Model → ${model} (restarting session)` });
      const out = await bootSession();
      setBusy(false);
      if (out && !out.ok) pushMessage({ role: "error", text: out.message });
    },
    [bootSession, finishOverlay, pushMessage]
  );

  useInput(
    (inputKey, key) => {
      if (key.ctrl && inputKey === "c") {
        void shutdown();
        return;
      }
      if (key.ctrl && inputKey === "o") {
        setHoldNativeScroll(false);
        setScrollMode((m) => !m);
        return;
      }
      if (key.ctrl && inputKey === "t" && !overlay && !confirm && !busy) {
        setThinkingExpanded((e) => !e);
        return;
      }
    },
    { isActive: !overlay && !confirm && !exiting }
  );

  useInput(
    (inputKey, key) => {
      if (overlay || confirm || exiting || scrollMode) return;

      if (key.tab && input.startsWith("/")) {
        const matches = filterSlashSuggestions(input);
        if (matches.length === 1) setInput(matches[0]!);
        else if (matches.length > 1) setInput(commonSlashPrefix(matches));
        return;
      }
      if (key.tab) {
        const ref = parseContextRefPrefix(input);
        if (ref) {
          const matches = completeContextRef(dir, ref.kind, ref.prefix);
          if (matches.length === 1) {
            setInput(applyContextRefCompletion(input, ref, matches[0]!));
          } else if (matches.length > 1) {
            setInput(applyContextRefCompletion(input, ref, commonPathPrefix(matches)));
          }
          return;
        }
      }
    },
    { isActive: !scrollMode && !overlay && !confirm && !exiting }
  );

  useInput(
    (inputKey, key) => {
      if (!scrollKeysActive) return;

      if (key.upArrow) scrollUp(1);
      else if (key.downArrow) scrollDown(1);
      else if (key.pageUp) scrollUp(visibleLines);
      else if (key.pageDown) scrollDown(visibleLines);
      else if (key.ctrl && inputKey === "u") scrollUp(3);
      else if (key.ctrl && inputKey === "d") scrollDown(3);
      else if (key.ctrl && inputKey === "e") scrollToBottom();
      else if (key.ctrl && inputKey === "g") scrollToTop();
      else if (scrollMode && (key.return || key.escape)) setScrollMode(false);
    },
    { isActive: scrollKeysActive }
  );

  const handleSubmit = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy || exiting || fatal || confirm || overlay) return;

    setInput("");

    const slash = parseSlash(text);
    if (slash) {
      switch (slash.type) {
        case "exit":
          pushMessage({ role: "system", text: "Goodbye." });
          await shutdown();
          return;
        case "clear":
          setMessages([{ id: nextId("sys"), role: "system", text: "Transcript cleared." }]);
          setScrollLineOffset(0);
          setScrollMode(false);
          return;
        case "help":
          openOverlay("help");
          return;
        case "sessions":
          openSessionsOverlay();
          return;
        case "skills":
          openOverlay("skills");
          return;
        case "memory":
          openOverlay("memory");
          return;
        case "doctor":
          openOverlay("doctor");
          return;
        case "tools":
          openOverlay("tools");
          return;
        case "model": {
          const r = await refreshPickerModels();
          const current = meta?.model ?? r.models[0] ?? "";
          setModelPickerIndex(Math.max(0, r.models.indexOf(current)));
          openOverlay("model");
          return;
        }
        case "mcp":
          openOverlay("mcp");
          return;
        case "copy": {
          const text = lastAssistantText(messages);
          if (!text) {
            pushMessage({ role: "error", text: "No assistant reply to copy" });
            return;
          }
          if (osc52Copy(text)) {
            pushMessage({ role: "system", text: `Copied ${text.length} chars to clipboard (OSC52)` });
          } else {
            pushMessage({ role: "error", text: "Clipboard copy failed (terminal may not support OSC52)" });
          }
          return;
        }
        case "find": {
          const query = slash.query ?? searchRef.current.query;
          if (!query) {
            pushMessage({ role: "error", text: "Usage: /find <text> (repeat /find for older matches)" });
            return;
          }
          const allRows = messagesToRowsCached(messages, cols, rowCacheRef.current);
          const matches = searchTranscriptRows(allRows, query);
          if (matches.length === 0) {
            searchRef.current = { query, cursor: null };
            pushMessage({ role: "system", text: `No matches for «${query}»` });
            return;
          }
          const isNewQuery = query !== searchRef.current.query;
          const cursor = nextSearchCursor(matches.length, isNewQuery ? null : searchRef.current.cursor);
          searchRef.current = { query, cursor };
          const offset = scrollOffsetForRow(matches[cursor]!, allRows.length, estimateVisibleLines(rows));
          setScrollMode(true);
          setScrollLineOffset(offset);
          pushMessage({
            role: "system",
            text: `Match ${cursor + 1}/${matches.length} for «${query}» — /find = older, Esc/q = exit scroll`,
          });
          return;
        }
        case "export": {
          if (!meta) {
            pushMessage({ role: "error", text: "No active session to export" });
            return;
          }
          try {
            const path = resolveExportPath(dir, meta.sessionId, slash.path);
            const md = formatTranscriptMarkdown(messages, meta);
            writeTranscriptExport(path, md);
            pushMessage({ role: "system", text: `Exported transcript → ${path}` });
          } catch (e) {
            const msg = e instanceof ExportPathError ? e.message : String(e);
            pushMessage({ role: "error", text: `Export failed: ${msg}` });
          }
          return;
        }
        case "rename": {
          if (!meta) {
            pushMessage({ role: "error", text: "No active session" });
            return;
          }
          if (await renameStoredSession(dir, meta.sessionId, slash.title)) {
            pushMessage({ role: "system", text: `Session renamed → ${slash.title}` });
          } else {
            pushMessage({ role: "error", text: "Rename failed" });
          }
          return;
        }
        case "new":
          setBusy(true);
          {
            const out = await bootSession();
            if (out && !out.ok) pushMessage({ role: "error", text: out.message });
          }
          setBusy(false);
          return;
        case "engine": {
          // I-143: engines cannot swap inside a live SDK session — switching
          // always reboots into a fresh session.
          const cfgProvider = (() => {
            try {
              return loadConfig(dir).engine?.provider ?? "cursor";
            } catch {
              return "cursor";
            }
          })();
          const current = engineOverrideRef.current ?? props.engine ?? cfgProvider;
          if (!slash.engine) {
            pushMessage({
              role: "system",
              text: `engine: ${current}${engineOverrideRef.current ? " (override)" : ""} · switch: /engine cursor | claude [account|api-key] | codex · reset: /engine off`,
            });
            return;
          }
          // Accept an optional auth hint: `/engine claude account|api-key`.
          const [engineTok, authTok] = slash.engine.trim().toLowerCase().split(/\s+/);
          const argNorm = engineTok ?? "";
          let nextOverride: string | undefined;
          let nextAuth: string | undefined;
          if (argNorm === "off" || argNorm === "clear" || argNorm === "none") {
            nextOverride = undefined;
          } else {
            const parsed = parseEngineArg(argNorm);
            if (!parsed) {
              pushMessage({
                role: "error",
                text: `unknown engine «${slash.engine}» — use cursor | claude | codex (or off)`,
              });
              return;
            }
            if (parsed === current && !authTok) {
              pushMessage({ role: "system", text: `engine already ${parsed}` });
              return;
            }
            // Deterministic credential pre-checks (user report «session failed»):
            // a doomed boot would land the TUI in the fatal state for nothing.
            if (parsed === "cursor" && !resolveApiKey(dir).key) {
              pushMessage({
                role: "error",
                text: "CURSOR_API_KEY is not set — run `irida auth login --stdin` first",
              });
              return;
            }
            if (parsed === "claude-agent") {
              const configAuth = (() => {
                try {
                  return loadConfig(dir).engine?.auth;
                } catch {
                  return undefined;
                }
              })();
              const decision = decideClaudeAuth({
                authHint: authTok,
                propsAuth: props.auth,
                configAuth,
                hasApiKey: Boolean(resolveAnthropicKey(dir).key),
                hasAccount: claudeAccountAvailable(dir),
              });
              if (!decision.ok) {
                pushMessage({ role: "error", text: decision.error });
                return;
              }
              if (decision.note) pushMessage({ role: "system", text: decision.note });
              nextAuth = decision.auth;
            }
            if (parsed === "codex") {
              // Account (a `codex login` session) is the codex default; an
              // api-key hint needs the key to actually be there.
              const configAuth = (() => {
                try {
                  return loadConfig(dir).engine?.auth;
                } catch {
                  return undefined;
                }
              })();
              const auth = authTok ?? props.auth ?? configAuth ?? "account";
              if (auth === "api-key" && !resolveOpenAiKey(dir).key) {
                pushMessage({
                  role: "error",
                  text: "OPENAI_API_KEY is not set — run `irida auth openai login --stdin`, or use `/engine codex account`",
                });
                return;
              }
              if (auth === "account" && !codexAccountAvailable()) {
                pushMessage({
                  role: "error",
                  text: "no codex session — run `codex login` first",
                });
                return;
              }
              nextAuth = auth;
            }
            nextOverride = parsed;
          }
          setBusy(true);
          {
            const prevOverride = engineOverrideRef.current;
            const prevAuth = engineAuthRef.current;
            engineOverrideRef.current = nextOverride;
            engineAuthRef.current = nextAuth;
            const next = nextOverride ?? props.engine ?? cfgProvider;
            const authNote = nextAuth ? ` (${nextAuth})` : "";
            pushMessage({ role: "system", text: `engine → ${next}${authNote} · opening a fresh session…` });
            const out = await bootSession();
            if (out && !out.ok) {
              // A failed switch must not brick the TUI in the fatal state —
              // roll the override back and reboot onto the working engine.
              engineOverrideRef.current = prevOverride;
              engineAuthRef.current = prevAuth;
              const back = await bootSession();
              pushMessage({
                role: "error",
                text: `switch to ${next} failed: ${out.message} — rolled back to ${prevOverride ?? props.engine ?? cfgProvider}`,
              });
              if (back && !back.ok) pushMessage({ role: "error", text: back.message });
            }
          }
          setBusy(false);
          return;
        }
        case "resume":
          setBusy(true);
          {
            const out = await bootSession(slash.sessionId);
            if (out && !out.ok) pushMessage({ role: "error", text: out.message });
          }
          setBusy(false);
          return;
        case "delegate":
          setBusy(true);
          pushMessage({ role: "system", text: "Delegate subagent running…" });
          {
            const out = await runDelegate({
              dir,
              prompt: slash.prompt,
              skills: props.skills,
              yesIUnderstand: props.yesIUnderstand,
            });
            const delegateText = out.ok ? out.summary : `Delegate failed: ${out.summary}`;
            const session = sessionRef.current;
            if (session && out.ok) {
              await session.injectContext(`[delegate] ${slash.prompt}`, delegateText);
            }
            pushMessage({
              role: out.ok ? "assistant" : "error",
              text: out.ok ? `[delegate]\n${delegateText}` : delegateText,
            });
          }
          setBusy(false);
          return;
        case "undo": {
          const out = await undoLastAction(dir);
          pushMessage({ role: out.ok ? "system" : "error", text: out.message });
          return;
        }
        case "unknown":
          pushMessage({ role: "error", text: `Unknown command: /${slash.command}` });
          return;
      }
    }

    if (text === "exit" || text === "quit" || text === ":q") {
      pushMessage({ role: "system", text: "Goodbye." });
      await shutdown();
      return;
    }

    const session = sessionRef.current;
    if (!session) return;

    setHoldNativeScroll(false);
    pushMessage({ role: "user", text });
    pushMessage({ role: "assistant", text: "", streaming: true });
    scrollToBottom();
    setScrollMode(false);
    setBusy(true);
    setTurnStartedAt(Date.now());
    lastPetEventAtRef.current = Date.now();
    petDegradeTurnRef.current = false;
    setLastTurnOk(false);
    setLastTurnError(false);
    setLastTurnStats(null);
    setThinkingText("");
    setThinkingExpanded(false);
    setActivity("thinking…");

    try {
      const out = await session.sendTurn(text);
      finishStreaming();

      if (out.kind === "ok") {
        setLastTurnStats(out.stats);
        setLastTurnOk(true);
        setLastTurnError(false);
        lastPetEventAtRef.current = Date.now();
        // A clean turn reassures the pet and banks XP (bridge wrote the snapshot).
        // "Clean" = this turn itself degraded nothing (I-150).
        if (!petDegradeTurnRef.current) setPetStoreDegraded(false);
        setPetRetryAt(null);
        setPetLevel(levelForXp(readPetStateSnapshot(dir)?.xp ?? 0));
        if (!out.assistantText.trim()) {
          setMessages((prev) => {
            const idx = indexOfLastAssistant(prev);
            if (idx < 0) return prev;
            const cur = prev[idx]!;
            if (cur.text.trim()) return prev;
            const next = [...prev];
            next[idx] = {
              ...cur,
              text: "Turn завершился без текста (только tools или сбой SDK). Смотри /tools или переформулируй вопрос.",
              streaming: false,
            };
            return next;
          });
        }
      }

      if (out.kind === "blocked") {
        setLastTurnOk(false);
        setLastTurnError(true);
        lastPetEventAtRef.current = Date.now();
        setMessages((prev) => {
          const next = prev.slice(0, -1);
          return [...next, { id: nextId("err"), role: "error", text: `Blocked: ${out.reason}` }];
        });
        return;
      }
      if (out.kind === "error") {
        setLastTurnOk(false);
        setLastTurnError(true);
        lastPetEventAtRef.current = Date.now();
        setMessages((prev) => {
          const idx = indexOfLastAssistant(prev);
          if (out.partialAssistantText && idx >= 0) {
            const next = [...prev];
            next[idx] = {
              ...next[idx]!,
              text: out.partialAssistantText,
              streaming: false,
            };
            return [...next, { id: nextId("err"), role: "error", text: out.message }];
          }
          const drop = indexOfStreamingAssistant(prev);
          if (drop >= 0) return [...prev.slice(0, drop), ...prev.slice(drop + 1), { id: nextId("err"), role: "error", text: out.message }];
          return [...prev, { id: nextId("err"), role: "error", text: out.message }];
        });
        if (out.fatal) setFatal(out.message);
      }
    } catch (e) {
      finishStreaming();
      setLastTurnOk(false);
      setLastTurnError(true);
      lastPetEventAtRef.current = Date.now();
      const formatted = formatSdkError(e);
      setMessages((prev) => {
        const next = prev.slice(0, -1);
        return [...next, { id: nextId("err"), role: "error", text: formatted.message }];
      });
      if (!formatted.recoverable) setFatal(formatted.message);
    } finally {
      setBusy(false);
      setTurnStartedAt(null);
      setActivity(null);
      setThinkingText("");
      setThinkingExpanded(false);
      setActivityLog((prev) => prev.filter((e) => e.kind === "tool" || e.kind === "mcp"));
    }
  };

  const composerDisabled = Boolean(
    busy || fatal || confirm || exiting || overlay || !meta || scrollMode
  );
  const scrollHint = scrollMode
    ? scrollPosLabel
      ? `scroll ${scrollPosLabel}`
      : `scroll +${scrollLineOffset}L`
    : scrollLineOffset > 0
      ? scrollPosLabel ?? `+${scrollLineOffset}L · Ctrl+E`
      : nativeTrackpadScroll && transcriptScrollable
        ? "trackpad scroll · Ctrl+O keys"
        : transcriptScrollable
          ? "↑↓ scroll · Ctrl+O"
          : null;

  const turnElapsedMs =
    busy && turnStartedAt != null ? Date.now() - turnStartedAt : undefined;
  const sessionToolCalls = activityLog.filter((e) => e.kind === "tool" || e.kind === "mcp").length;
  // Account/subscription engine → the StatusBar cost is metered-equivalent, not billed.
  const subscription = useMemo(() => {
    try {
      const cfg = loadConfig(dir);
      const provider = props.engine ?? cfg.engine?.provider;
      const auth = props.auth ?? cfg.engine?.auth;
      return provider === "claude-agent" && auth === "account";
    } catch {
      return false;
    }
  }, [dir, props.engine, props.auth]);

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Box flexDirection="column" flexGrow={1}>
          <Text color={theme.primary}>{bannerFor(cols).trimEnd()}</Text>
        </Box>
        <PetCorner state={petState} animTick={petClock} activity={petActivity} level={petLevel} />
      </Box>

      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderColor={theme.border}
        paddingY={0}
        minHeight={8}
      >
        {overlay ? (
          <>
            {overlay === "help" ? <HelpPanel onClose={closeOverlay} /> : null}
            {overlay === "sessions" ? (
              <SessionPicker
                sessions={pickerSessions}
                onSelect={(s) => void switchToSession(s)}
                onCancel={closeOverlay}
              />
            ) : null}
            {overlay === "skills" ? <SkillsPanel dir={dir} onClose={closeOverlay} /> : null}
            {overlay === "memory" ? <MemoryPanel dir={dir} onClose={closeOverlay} /> : null}
            {overlay === "doctor" ? <DoctorPanel dir={dir} onClose={closeOverlay} /> : null}
            {overlay === "tools" ? (
              <ToolsPanel entries={activityLog} onClose={closeOverlay} />
            ) : null}
            {overlay === "model" ? (
              <ModelPicker
                models={pickerModels}
                current={meta?.model ?? pickerModels[0] ?? ""}
                index={modelPickerIndex}
                source={modelListSource}
                sourceError={modelListError}
                onMove={(d) =>
                  setModelPickerIndex((i) => {
                    if (pickerModels.length === 0) return 0;
                    return (i + d + pickerModels.length) % pickerModels.length;
                  })
                }
                onSelect={(m) => void applyModel(m)}
                onCancel={closeOverlay}
              />
            ) : null}
            {overlay === "mcp" ? (
              <McpPanel entries={mcpView.entries} errors={mcpView.errors} onClose={closeOverlay} />
            ) : null}
          </>
        ) : (
          <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden">
            <MessageList
              rows={displayRows}
              width={cols}
              hiddenAbove={displayHiddenAbove}
              hiddenBelow={displayHiddenBelow}
              atBottom={displayAtBottom}
              scrollMode={scrollMode}
              nativeScroll={nativeTrackpadScroll}
              totalLines={allRows.length}
            />
            <ToolCallBanner entry={activityLog[activityLog.length - 1] ?? null} />
            <ThinkingBar text={thinkingText} expanded={thinkingExpanded} tick={petClock} elapsedMs={turnElapsedMs} />
            <ActivityBar
              label={activity}
              busy={busy}
              recent={activityLog}
              tick={petClock}
              bannerActive={activityLog[activityLog.length - 1]?.phase === "call"}
            />
          </Box>
        )}
        {confirm ? (
          <ConfirmDialog state={confirm} onDone={() => setConfirm(null)} />
        ) : null}
      </Box>

      <SlashSuggest input={input} suggestions={slashSuggestions} />

      <Composer
        value={input}
        onChange={(v) => {
          if (overlay) return;
          if (v && holdNativeScroll) setHoldNativeScroll(false);
          setInput(v);
        }}
        onSubmit={(v) => void handleSubmit(v)}
        disabled={composerDisabled}
        scrollMode={scrollMode}
        cwd={meta?.cwd ?? dir}
        placeholder={
          fatal
            ? "session failed"
            : overlay
              ? "Esc closes overlay"
              : busy
                ? "agent is thinking…"
                : scrollMode
                  ? "scroll mode · Enter compose"
                  : "Message… /help · Ctrl+J newline"
        }
      />

      <StatusBar
        meta={meta}
        busy={busy}
        error={fatal}
        scrollHint={scrollHint}
        lastTurn={lastTurnStats}
        turnElapsedMs={turnElapsedMs}
        mcpCount={mcpView.entries.length}
        sessionToolCalls={sessionToolCalls}
        cols={cols}
        subscription={subscription}
      />
    </Box>
  );
}
