/**
 * `irida gateway run` — long-running messaging bridge (issue 037).
 */
import { resolve } from "node:path";
import { iridaHome } from "./env.js";
import { loadConfig } from "./config.js";
import { warmCredentialsCache } from "./credentials.js";
import { EXIT, type ExitCode } from "./exit.js";
import {
  GatewayConfigError,
  gatewayWebhookSecret,
  loadGatewayConfig,
  type GatewayConfig,
} from "./gatewayConfig.js";
import { GatewaySessionRouter } from "./gatewayRouter.js";
import { startWebhookServer, type WebhookServer } from "./gatewayWebhook.js";
import { startTelegramPoller, type TelegramPoller } from "./gatewayTelegram.js";
import { gatherGatewayStatus, gatherGatewayStoreStatusLines, gatherTelegramGatewayStatusLines } from "./gatewayStatus.js";
import { installGatewayProcessGuards } from "./gatewayProcessGuards.js";
import { emitServiceLog } from "./serviceLog.js";
import { warmGatewayAllowlistCache, resolveAllowedChatIds } from "./gatewayAllowlist.js";
import type { SdkCreateLike, SdkResumeLike } from "./host.js";

/** PG-allowlist cache refresh cadence (H-12) — revocation lag ceiling. */
export const ALLOWLIST_REWARM_MS = 5 * 60 * 1000;

export interface GatewayRunOptions {
  dir?: string;
  adapter?: string;
  port?: number;
  sdk?: SdkCreateLike & SdkResumeLike;
}

export interface GatewayRunHandle {
  cfg: GatewayConfig;
  router: GatewaySessionRouter;
  webhook?: WebhookServer;
  telegram?: TelegramPoller;
  close(): Promise<void>;
}

function applyCliOverrides(cfg: GatewayConfig, opts: GatewayRunOptions): GatewayConfig {
  const next = { ...cfg };
  if (opts.adapter === "webhook" || opts.adapter === "telegram") next.adapter = opts.adapter;
  if (typeof opts.port === "number" && opts.port >= 0) next.port = opts.port;
  return next;
}

export async function startGateway(opts: GatewayRunOptions = {}): Promise<GatewayRunHandle> {
  const dir = opts.dir ?? iridaHome() ?? process.cwd();
  await warmCredentialsCache(dir);
  await warmGatewayAllowlistCache(dir);
  // Engine selection is per peer; openChatSession performs the matching
  // Cursor/Anthropic/account credential check when that peer opens a session.

  let cfg = loadGatewayConfig(dir);
  cfg = applyCliOverrides(cfg, opts);
  cfg = { ...cfg, allowedChatIds: resolveAllowedChatIds(cfg, dir) };

  if (cfg.allowedChatIds.length === 0) {
    throw new GatewayConfigError("allowedChatIds is empty — configure peers in gateway.json or postgres allowlist");
  }

  const router = new GatewaySessionRouter({
    dir,
    adapter: cfg.adapter,
    skills: cfg.skills,
    yesIUnderstand: cfg.yesIUnderstand,
    sdk: opts.sdk,
  });

  // Re-warm the PG allowlist cache periodically (H-12): revoking a peer in
  // Postgres must take effect without a gateway restart. isChatAllowed reads
  // the live cache on every inbound, so a refreshed cache = live revocation.
  const allowlistRewarm = setInterval(() => {
    void warmGatewayAllowlistCache(dir).catch(() => {});
  }, ALLOWLIST_REWARM_MS);
  allowlistRewarm.unref();

  if (cfg.adapter === "telegram") {
    const telegram = startTelegramPoller({ cfg, router, dir });
    // I-147: a configured webhook secret opts the Telegram gateway into ALSO
    // serving the local HTTP hook (Wisp desktop chat peer). Same router, same
    // allowlist; the side-listener failing (port busy, …) must not take the
    // Telegram loop down.
    let webhook: WebhookServer | undefined;
    try {
      webhook = await maybeStartSideWebhook(cfg, router, dir);
    } catch (e) {
      emitServiceLog(
        `[gateway] webhook side-listener failed — continuing telegram-only: ${e instanceof Error ? e.message : String(e)}`,
        "error"
      );
    }
    let closePromise: Promise<void> | undefined;
    return {
      cfg,
      router,
      telegram,
      webhook,
      close: () => {
        if (!closePromise) {
          clearInterval(allowlistRewarm);
          // Stop accepting work first, then cancel/close sessions immediately:
          // both ingress drains may be waiting on those active turns.
          const telegramStop = telegram.stop();
          const webhookStop = webhook?.close().catch(() => {}) ?? Promise.resolve();
          const sessionsClose = router.closeAll();
          closePromise = (async () => {
            const [telegramResult, , sessionsResult] = await Promise.allSettled([
              telegramStop,
              webhookStop,
              sessionsClose,
            ]);
            if (sessionsResult.status === "rejected") throw sessionsResult.reason;
            if (telegramResult.status === "rejected") throw telegramResult.reason;
          })();
        }
        return closePromise;
      },
    };
  }

  const webhook = await listenWebhook(cfg, router, dir);
  let closePromise: Promise<void> | undefined;

  return {
    cfg,
    router,
    webhook,
    close: () => {
      if (!closePromise) {
        clearInterval(allowlistRewarm);
        const ingressClose = webhook.close();
        const sessionsClose = router.closeAll();
        closePromise = (async () => {
          const [ingressResult, sessionsResult] = await Promise.allSettled([
            ingressClose,
            sessionsClose,
          ]);
          // Preserve the former try/finally priority when both fail.
          if (sessionsResult.status === "rejected") throw sessionsResult.reason;
          if (ingressResult.status === "rejected") throw ingressResult.reason;
        })();
      }
      return closePromise;
    },
  };
}

async function listenWebhook(
  cfg: GatewayConfig,
  router: GatewaySessionRouter,
  dir: string
): Promise<WebhookServer> {
  const webhook = startWebhookServer(cfg, router, dir);
  await new Promise<void>((resolve, reject) => {
    webhook.server.once("error", reject);
    webhook.server.listen(cfg.port, cfg.host, () => resolve());
  });
  emitServiceLog(`[gateway] webhook listening http://${cfg.host}:${cfg.port}${cfg.webhookPath}`, "info");
  return webhook;
}

/**
 * Start the webhook listener NEXT TO another adapter when a secret is
 * configured (deny-by-default: no secret → no HTTP surface). Exported for
 * tests — callers treat a thrown listen error as non-fatal.
 */
export async function maybeStartSideWebhook(
  cfg: GatewayConfig,
  router: GatewaySessionRouter,
  dir: string
): Promise<WebhookServer | undefined> {
  if (!gatewayWebhookSecret(cfg)) return undefined;
  return listenWebhook(cfg, router, dir);
}

export async function cmdGatewayRun(opts: GatewayRunOptions = {}): Promise<ExitCode> {
  installGatewayProcessGuards();
  let handle: GatewayRunHandle | undefined;
  try {
    handle = await startGateway(opts);
  } catch (e) {
    console.error("gateway: " + (e instanceof GatewayConfigError ? e.message : String(e)));
    return EXIT.config;
  }

  const shutdown = async (signal: string) => {
    emitServiceLog(`[gateway] ${signal} — shutting down`, "info");
    try {
      await handle!.close();
    } finally {
      process.exit(EXIT.ok);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return new Promise(() => {
    /* block until signal */
  });
}

export async function cmdGatewayStatus(opts: GatewayRunOptions = {}): Promise<ExitCode> {
  const dir = opts.dir ?? iridaHome() ?? process.cwd();
  await warmCredentialsCache(dir);
  await warmGatewayAllowlistCache(dir);
  const rows = [
    ...gatherGatewayStatus(dir),
    ...(await gatherGatewayStoreStatusLines()),
    ...(await gatherTelegramGatewayStatusLines(dir)),
  ];
  let ok = true;
  for (const r of rows) {
    const mark = r.ok ? "ok" : "FAIL";
    if (!r.ok) ok = false;
    console.log(`${mark.padEnd(5)} ${r.name.padEnd(18)} ${r.detail}`);
  }
  return ok ? EXIT.ok : EXIT.config;
}

export async function cmdGateway(argv: string[], opts: GatewayRunOptions = {}): Promise<ExitCode> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "status":
      return await cmdGatewayStatus(opts);
    case "run": {
      let adapter: string | undefined;
      let port: number | undefined;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--adapter" && i + 1 < rest.length) adapter = rest[++i];
        else if (rest[i] === "--port" && i + 1 < rest.length) port = Number(rest[++i]);
      }
      return cmdGatewayRun({ ...opts, adapter, port });
    }
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(`Usage:
  irida gateway status          launchd + log probe (no server start)
  irida gateway run [--adapter webhook|telegram] [--port 18789]

Config: .agent/gateway.json
Webhook secret: env GATEWAY_WEBHOOK_SECRET
Telegram token: irida auth telegram login --stdin (or env TELEGRAM_BOT_TOKEN)

Example gateway.json (webhook):
{
  "version": 1,
  "adapter": "webhook",
  "listen": { "host": "127.0.0.1", "port": 18789 },
  "webhook": { "path": "/hook", "secretEnv": "GATEWAY_WEBHOOK_SECRET" },
  "allowedChatIds": ["u1"],
  "maxMessageLength": 8000
}

Example gateway.json (telegram):
{
  "version": 1,
  "adapter": "telegram",
  "telegram": { "tokenEnv": "TELEGRAM_BOT_TOKEN", "pollIntervalMs": 1500 },
  "allowedChatIds": ["123456789"],
  "maxMessageLength": 8000
}

Group/channel auth: a negative chat id is a group/supergroup/channel where
the chat allowlist alone does not identify the actor. For a GROUP, also set
telegram.allowedSenderIds: ["<your user id>"] — other members are ignored.
For a CHANNEL, set telegram.allowChannelPosts: true (admins-only; no per-user
sender). Private 1:1 chats need neither.

Webhook request:
  POST /hook
  Header: X-Gateway-Secret: <secret>
  Body: { "chatId": "u1", "text": "hello" }
`);
      return EXIT.ok;
    default:
      console.error(`gateway: unknown subcommand '${sub}'\n\nRun: irida gateway help`);
      return EXIT.usage;
  }
}
