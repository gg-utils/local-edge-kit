/**
 * @fileoverview Reusable local-edge logs-web HTTP and websocket server primitives.
 *
 * Project adapters provide source-label taxonomy, HTML paths, URLs, request logging, and websocket
 * host bindings. The kit owns local-edge log-file discovery, ANSI stripping, line classification,
 * websocket subscription/filter/search/pause handling, tail process lifecycle, HTTP health/static
 * responses, startup banners, and shutdown cleanup.
 *
 * The server binds 127.0.0.1 unless `bindHost` is given. Every HTTP request and websocket upgrade
 * must carry a Host header that names this server (a loopback name or the bind host on the
 * listening port, or an `allowedHosts` entry) and, when it has an Origin header, the origin of that
 * same host; anything else gets a 403 and no websocket connection.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/logs-web-server.unit.test.ts
 *
 * @see consumer local-edge adapter - consumer adapter that imports LocalEdgeKit_startLogsWebServer and binds source-label taxonomy, HTML paths, websocket host wiring, and request logging for the logs-web UI.
 * @see consumer local-edge adapter - Realm-scoped port and HTML path resolver consumed by that adapter before the kit-owned server handle listens.
 * @see packages/local-edge-kit/src/logs-web-server.unit.test.ts - Node test module that exercises static index delivery, /health JSON, and websocket subscribe, tail, filter, search, pause, and resume paths owned here.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";

import {
  LocalEdgeKit_checkLocalRequest,
  LocalEdgeKit_localRequestRejectionBody,
  LocalEdgeKit_resolveBindHost,
} from "./local-request-guard.js";

/** Local-edge log scope selectable by logs-web clients. */
export type LocalEdgeKit_LogsWebScope =
  | "run"
  | "nginx-docker"
  | "healthcheck"
  | "all";

/** Stable source-label definition used to group lines into websocket counts and filters. */
export type LocalEdgeKit_LogsWebSourceDefinition = {
  readonly color: string;
  readonly label: string;
  readonly prefixes: readonly string[];
};

/** Single websocket log row after ANSI stripping and source classification. */
export type LocalEdgeKit_LogsWebLogLine = {
  readonly message: string;
  readonly source: string;
  readonly ts: string;
};

/** Request completion record emitted after logs-web HTTP responses finish. */
export type LocalEdgeKit_LogsWebRequestRecord = {
  readonly durationMs: number;
  readonly host: string | undefined;
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly statusCode: number;
  readonly statusText: string;
  readonly surfaceId: string;
};

/** Minimal websocket peer surface consumed by the package-owned protocol handler. */
export type LocalEdgeKit_LogsWebSocket = {
  readonly openState: number;
  readonly readyState: number;
  onClose: (listener: () => void) => void;
  onMessage: (listener: (data: { toString: () => string }) => void) => void;
  send: (message: string) => void;
};

/** Minimal websocket server wrapper supplied by the project adapter. */
export type LocalEdgeKit_LogsWebSocketServer = {
  close: () => void;
  onConnection: (listener: (ws: LocalEdgeKit_LogsWebSocket) => void) => void;
};

/** Host operations used by the logs-web server. */
export type LocalEdgeKit_LogsWebServerOperations = {
  readonly clearInterval: (timer: ReturnType<typeof setInterval>) => void;
  readonly createServer: (
    listener: (req: IncomingMessage, res: ServerResponse) => void,
  ) => Server;
  readonly fileExists: (filePath: string) => boolean;
  readonly nowMs: () => number;
  readonly nowTimestamp: () => string;
  readonly readDir: (directory: string) => string[];
  readonly readText: (filePath: string) => string;
  readonly realpath: (filePath: string) => string;
  readonly setInterval: (
    listener: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  readonly spawnTail: (args: readonly string[]) => ChildProcess;
};

/** Options for starting the logs-web server. */
export type LocalEdgeKit_StartLogsWebServerOptions = {
  /**
   * Extra `host` or `host:port` values accepted in the Host header, for a server reached through
   * a reverse proxy under another name.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Address to listen on. Defaults to 127.0.0.1. Give another address, such as `0.0.0.0`, only
   * when the server must be reachable from outside this machine (for example from a container).
   */
  readonly bindHost?: string;
  readonly createWebSocketServer: (
    server: Server,
  ) => LocalEdgeKit_LogsWebSocketServer;
  readonly defaultScope: LocalEdgeKit_LogsWebScope;
  readonly htmlPath: string;
  readonly logDirectory: string;
  readonly onRequestComplete?: (
    record: LocalEdgeKit_LogsWebRequestRecord,
  ) => void;
  readonly operations?: Partial<LocalEdgeKit_LogsWebServerOperations>;
  readonly port: number;
  readonly sourceDefinitions: readonly LocalEdgeKit_LogsWebSourceDefinition[];
  readonly startupLines: readonly string[];
  readonly stderr?: (line: string) => void;
  readonly stdout?: (line: string) => void;
  readonly surfaceId: string;
};

/** Handle returned to adapters so process-signal shutdown stays adapter-owned. */
export type LocalEdgeKit_LogsWebServerHandle = {
  readonly close: () => void;
  readonly getClientCount: () => number;
  readonly server: Server;
  readonly webSocketServer: LocalEdgeKit_LogsWebSocketServer;
};

type LocalEdgeKit_LogsWebSourceCountRow = {
  readonly color: string;
  readonly count: number;
  readonly name: string;
};

type LocalEdgeKit_LogsWebClientMessage =
  | { readonly scope: LocalEdgeKit_LogsWebScope; readonly type: "subscribe" }
  | { readonly sources: readonly string[]; readonly type: "filter" }
  | { readonly query: string; readonly type: "search" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "ping" };

type LocalEdgeKit_LogsWebServerMessage =
  | {
      readonly lines: readonly LocalEdgeKit_LogsWebLogLine[];
      readonly type: "lines";
    }
  | {
      readonly sources: readonly LocalEdgeKit_LogsWebSourceCountRow[];
      readonly type: "sources";
    }
  | {
      readonly lineCount: number;
      readonly scope: LocalEdgeKit_LogsWebScope;
      readonly tailing: boolean;
      readonly type: "status";
    }
  | {
      readonly matches: readonly LocalEdgeKit_LogsWebLogLine[];
      readonly total: number;
      readonly type: "searchResults";
    }
  | { readonly type: "pong" };

type LocalEdgeKit_LogsWebClientState = {
  lineCount: number;
  scope: LocalEdgeKit_LogsWebScope;
  sourceCounts: Map<string, number>;
  sourceFilter: Set<string> | null;
  tailInterval: ReturnType<typeof setInterval> | null;
  tailing: boolean;
  tailProcess: ChildProcess | null;
  ws: LocalEdgeKit_LogsWebSocket;
};

const LOCAL_EDGE_KIT_LOGS_WEB_SCOPES: readonly LocalEdgeKit_LogsWebScope[] = [
  "run",
  "nginx-docker",
  "healthcheck",
  "all",
];

const LOCAL_EDGE_KIT_LOGS_WEB_ANSI_RE = /\x1b\[[0-9;]*m/g;

const LocalEdgeKit_defaultLogsWebServerOperations =
  (): LocalEdgeKit_LogsWebServerOperations => ({
    clearInterval: (timer): void => {
      clearInterval(timer);
    },
    createServer,
    fileExists: (filePath): boolean => fs.existsSync(filePath),
    nowMs: (): number => performance.now(),
    nowTimestamp: (): string => new Date().toISOString().slice(11, 23),
    readDir: (directory): string[] => fs.readdirSync(directory),
    readText: (filePath): string => fs.readFileSync(filePath, "utf8"),
    realpath: (filePath): string => fs.realpathSync(filePath),
    setInterval: (listener, ms): ReturnType<typeof setInterval> =>
      setInterval(listener, ms),
    spawnTail: (args): ChildProcess =>
      spawn("tail", [...args], { stdio: ["ignore", "pipe", "pipe"] }),
  });

function LocalEdgeKit_resolveLogsWebServerOperations(
  operations: Partial<LocalEdgeKit_LogsWebServerOperations> | undefined,
): LocalEdgeKit_LogsWebServerOperations {
  const defaults = LocalEdgeKit_defaultLogsWebServerOperations();
  return {
    clearInterval: operations?.clearInterval ?? defaults.clearInterval,
    createServer: operations?.createServer ?? defaults.createServer,
    fileExists: operations?.fileExists ?? defaults.fileExists,
    nowMs: operations?.nowMs ?? defaults.nowMs,
    nowTimestamp: operations?.nowTimestamp ?? defaults.nowTimestamp,
    readDir: operations?.readDir ?? defaults.readDir,
    readText: operations?.readText ?? defaults.readText,
    realpath: operations?.realpath ?? defaults.realpath,
    setInterval: operations?.setInterval ?? defaults.setInterval,
    spawnTail: operations?.spawnTail ?? defaults.spawnTail,
  };
}

function LocalEdgeKit_errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function LocalEdgeKit_isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function LocalEdgeKit_isLogsWebScope(
  value: unknown,
): value is LocalEdgeKit_LogsWebScope {
  return (
    typeof value === "string" &&
    LOCAL_EDGE_KIT_LOGS_WEB_SCOPES.some((scope) => scope === value)
  );
}

function LocalEdgeKit_parseLogsWebClientMessage(
  raw: string,
): LocalEdgeKit_LogsWebClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!LocalEdgeKit_isRecord(parsed) || typeof parsed.type !== "string") {
    return null;
  }

  switch (parsed.type) {
    case "subscribe":
      return LocalEdgeKit_isLogsWebScope(parsed.scope)
        ? { scope: parsed.scope, type: "subscribe" }
        : null;
    case "filter":
      return Array.isArray(parsed.sources)
        ? {
            sources: parsed.sources.filter(
              (source): source is string => typeof source === "string",
            ),
            type: "filter",
          }
        : { sources: [], type: "filter" };
    case "search":
      return typeof parsed.query === "string"
        ? { query: parsed.query, type: "search" }
        : null;
    case "pause":
    case "resume":
    case "ping":
      return { type: parsed.type };
    default:
      return null;
  }
}

/** Removes ANSI SGR markup so downstream prefix matching stays stable across terminals. */
export function LocalEdgeKit_stripLogsWebAnsi(text: string): string {
  return text.replace(LOCAL_EDGE_KIT_LOGS_WEB_ANSI_RE, "");
}

/** Maps a raw line onto the stable label set before the websocket feed publishes counts. */
export function LocalEdgeKit_classifyLogsWebSource(options: {
  readonly line: string;
  readonly sourceDefinitions: readonly LocalEdgeKit_LogsWebSourceDefinition[];
}): string {
  for (const source of options.sourceDefinitions) {
    for (const prefix of source.prefixes) {
      if (options.line.includes(prefix)) {
        return source.label;
      }
    }
  }
  return "OTHER";
}

/** Builds a labeled log line snapshot from raw tail/search text. */
export function LocalEdgeKit_parseLogsWebLine(options: {
  readonly nowTimestamp: () => string;
  readonly raw: string;
  readonly sourceDefinitions: readonly LocalEdgeKit_LogsWebSourceDefinition[];
}): LocalEdgeKit_LogsWebLogLine {
  const cleaned = LocalEdgeKit_stripLogsWebAnsi(options.raw);
  return {
    message: cleaned,
    source: LocalEdgeKit_classifyLogsWebSource({
      line: cleaned,
      sourceDefinitions: options.sourceDefinitions,
    }),
    ts: options.nowTimestamp(),
  };
}

/** Builds source-count rows including the synthetic OTHER bucket. */
export function LocalEdgeKit_buildLogsWebSourceCountRows(options: {
  readonly otherColor: string;
  readonly sourceCounts: ReadonlyMap<string, number>;
  readonly sourceDefinitions: readonly LocalEdgeKit_LogsWebSourceDefinition[];
}): LocalEdgeKit_LogsWebSourceCountRow[] {
  const sources = options.sourceDefinitions.map((source) => ({
    color: source.color,
    count: options.sourceCounts.get(source.label) ?? 0,
    name: source.label,
  }));
  sources.push({
    color: options.otherColor,
    count: options.sourceCounts.get("OTHER") ?? 0,
    name: "OTHER",
  });
  return sources;
}

/** Locates filesystem paths backing the websocket tail for a local-edge logs scope. */
export function LocalEdgeKit_discoverLogsWebFiles(options: {
  readonly logDirectory: string;
  readonly operations?: Partial<
    Pick<
      LocalEdgeKit_LogsWebServerOperations,
      "fileExists" | "readDir" | "realpath"
    >
  >;
  readonly scope: LocalEdgeKit_LogsWebScope;
}): string[] {
  const defaultOperations = LocalEdgeKit_defaultLogsWebServerOperations();
  const fileExists =
    options.operations?.fileExists ?? defaultOperations.fileExists;
  const readDir = options.operations?.readDir ?? defaultOperations.readDir;
  const realpath = options.operations?.realpath ?? defaultOperations.realpath;
  const files: string[] = [];

  if (options.scope === "run" || options.scope === "all") {
    const latestPath = path.join(options.logDirectory, "runs", "latest.log");
    if (fileExists(latestPath)) {
      files.push(realpath(latestPath));
    } else {
      const runsDir = path.join(options.logDirectory, "runs");
      if (fileExists(runsDir)) {
        const entries = readDir(runsDir)
          .filter(
            (entry) =>
              entry.startsWith("local-edge-") && entry.endsWith(".log"),
          )
          .sort()
          .reverse();
        const firstEntry = entries[0];
        if (firstEntry !== undefined) {
          files.push(path.join(runsDir, firstEntry));
        }
      }
    }
  }

  if (options.scope === "nginx-docker" || options.scope === "all") {
    const nginxLog = path.join(options.logDirectory, "nginx-docker.log");
    if (fileExists(nginxLog)) {
      files.push(nginxLog);
    }
  }

  if (options.scope === "healthcheck" || options.scope === "all") {
    const healthcheckLog = path.join(options.logDirectory, "healthcheck.log");
    if (fileExists(healthcheckLog)) {
      files.push(healthcheckLog);
    }
  }

  return files;
}

function LocalEdgeKit_sendLogsWebMessage(
  ws: LocalEdgeKit_LogsWebSocket,
  message: LocalEdgeKit_LogsWebServerMessage,
): void {
  if (ws.readyState === ws.openState) {
    ws.send(JSON.stringify(message));
  }
}

function LocalEdgeKit_broadcastLogsWebSourceCounts(options: {
  readonly client: LocalEdgeKit_LogsWebClientState;
  readonly sourceDefinitions: readonly LocalEdgeKit_LogsWebSourceDefinition[];
}): void {
  LocalEdgeKit_sendLogsWebMessage(options.client.ws, {
    sources: LocalEdgeKit_buildLogsWebSourceCountRows({
      otherColor: "#64748b",
      sourceCounts: options.client.sourceCounts,
      sourceDefinitions: options.sourceDefinitions,
    }),
    type: "sources",
  });
}

function LocalEdgeKit_clearLogsWebTailInterval(options: {
  readonly client: LocalEdgeKit_LogsWebClientState;
  readonly operations: LocalEdgeKit_LogsWebServerOperations;
}): void {
  if (options.client.tailInterval !== null) {
    options.operations.clearInterval(options.client.tailInterval);
    options.client.tailInterval = null;
  }
}

function LocalEdgeKit_stopLogsWebTail(options: {
  readonly client: LocalEdgeKit_LogsWebClientState;
  readonly operations: LocalEdgeKit_LogsWebServerOperations;
}): void {
  if (options.client.tailProcess !== null) {
    options.client.tailProcess.kill("SIGTERM");
    options.client.tailProcess = null;
  }
  LocalEdgeKit_clearLogsWebTailInterval(options);
}

function LocalEdgeKit_startLogsWebTail(options: {
  readonly client: LocalEdgeKit_LogsWebClientState;
  readonly logDirectory: string;
  readonly operations: LocalEdgeKit_LogsWebServerOperations;
  readonly sourceDefinitions: readonly LocalEdgeKit_LogsWebSourceDefinition[];
}): void {
  LocalEdgeKit_stopLogsWebTail({
    client: options.client,
    operations: options.operations,
  });

  const files = LocalEdgeKit_discoverLogsWebFiles({
    logDirectory: options.logDirectory,
    operations: options.operations,
    scope: options.client.scope,
  });
  if (files.length === 0) {
    LocalEdgeKit_sendLogsWebMessage(options.client.ws, {
      lines: [
        {
          message: `No log files found for scope '${options.client.scope}'.`,
          source: "SYSTEM",
          ts: options.operations.nowTimestamp(),
        },
      ],
      type: "lines",
    });
    return;
  }

  const tail = options.operations.spawnTail(["-n", "500", "-F", ...files]);
  options.client.tailProcess = tail;

  let buffer = "";
  const batchInterval = options.operations.setInterval(() => {
    if (buffer.length === 0) {
      return;
    }
    const rawLines = buffer.split("\n");
    buffer = rawLines.pop() ?? "";
    const parsed = rawLines
      .filter((line) => line.trim().length > 0)
      .map((line) =>
        LocalEdgeKit_parseLogsWebLine({
          nowTimestamp: options.operations.nowTimestamp,
          raw: line,
          sourceDefinitions: options.sourceDefinitions,
        }),
      );

    for (const line of parsed) {
      options.client.sourceCounts.set(
        line.source,
        (options.client.sourceCounts.get(line.source) ?? 0) + 1,
      );
      options.client.lineCount += 1;
    }

    const sourceFilter = options.client.sourceFilter;
    const filtered =
      sourceFilter === null
        ? parsed
        : parsed.filter((line) => sourceFilter.has(line.source));

    if (filtered.length > 0 && options.client.tailing) {
      LocalEdgeKit_sendLogsWebMessage(options.client.ws, {
        lines: filtered,
        type: "lines",
      });
    }

    LocalEdgeKit_broadcastLogsWebSourceCounts({
      client: options.client,
      sourceDefinitions: options.sourceDefinitions,
    });
    LocalEdgeKit_sendLogsWebMessage(options.client.ws, {
      lineCount: options.client.lineCount,
      scope: options.client.scope,
      tailing: options.client.tailing,
      type: "status",
    });
  }, 100);
  options.client.tailInterval = batchInterval;

  tail.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
  });

  tail.stderr?.on("data", (chunk: Buffer) => {
    const message = chunk.toString().trim();
    if (message.length > 0 && !message.includes("file truncated")) {
      LocalEdgeKit_sendLogsWebMessage(options.client.ws, {
        lines: [
          {
            message: `[tail stderr] ${message}`,
            source: "SYSTEM",
            ts: options.operations.nowTimestamp(),
          },
        ],
        type: "lines",
      });
    }
  });

  tail.on("close", () => {
    LocalEdgeKit_clearLogsWebTailInterval({
      client: options.client,
      operations: options.operations,
    });
    options.client.tailProcess = null;
  });
}

function LocalEdgeKit_searchLogsWeb(options: {
  readonly client: LocalEdgeKit_LogsWebClientState;
  readonly logDirectory: string;
  readonly operations: LocalEdgeKit_LogsWebServerOperations;
  readonly sourceDefinitions: readonly LocalEdgeKit_LogsWebSourceDefinition[];
  readonly stderr: (line: string) => void;
  readonly surfaceId: string;
  readonly query: string;
}): void {
  const files = LocalEdgeKit_discoverLogsWebFiles({
    logDirectory: options.logDirectory,
    operations: options.operations,
    scope: options.client.scope,
  });
  if (files.length === 0) {
    LocalEdgeKit_sendLogsWebMessage(options.client.ws, {
      matches: [],
      total: 0,
      type: "searchResults",
    });
    return;
  }

  let regex: RegExp;
  try {
    regex = new RegExp(options.query, "i");
  } catch (error: unknown) {
    options.stderr(
      `[${options.surfaceId}] Invalid search regex '${options.query}': ${LocalEdgeKit_errorMessage(error)}`,
    );
    LocalEdgeKit_sendLogsWebMessage(options.client.ws, {
      matches: [],
      total: 0,
      type: "searchResults",
    });
    return;
  }

  const matches: LocalEdgeKit_LogsWebLogLine[] = [];
  for (const file of files) {
    try {
      const lines = options.operations.readText(file).split("\n");
      const startIndex = Math.max(0, lines.length - 10000);
      if (startIndex > 0) {
        options.stderr(
          `[${options.surfaceId}] Log search truncated: showing last 10000 of ${String(lines.length)} lines in ${file}`,
        );
      }
      for (let index = startIndex; index < lines.length; index += 1) {
        const line = lines[index];
        if (
          line !== undefined &&
          line.trim().length > 0 &&
          regex.test(LocalEdgeKit_stripLogsWebAnsi(line))
        ) {
          matches.push(
            LocalEdgeKit_parseLogsWebLine({
              nowTimestamp: options.operations.nowTimestamp,
              raw: line,
              sourceDefinitions: options.sourceDefinitions,
            }),
          );
          if (matches.length >= 200) {
            break;
          }
        }
      }
    } catch (error: unknown) {
      options.stderr(
        `[${options.surfaceId}] Could not read log file ${file}: ${LocalEdgeKit_errorMessage(error)}`,
      );
    }
    if (matches.length >= 200) {
      break;
    }
  }

  LocalEdgeKit_sendLogsWebMessage(options.client.ws, {
    matches,
    total: matches.length,
    type: "searchResults",
  });
}

function LocalEdgeKit_handleLogsWebHttpRequest(options: {
  readonly bindHost: string;
  readonly clientCount: () => number;
  readonly operations: LocalEdgeKit_LogsWebServerOperations;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly serverOptions: LocalEdgeKit_StartLogsWebServerOptions;
}): void {
  const guard = LocalEdgeKit_checkLocalRequest({
    allowedHosts: options.serverOptions.allowedHosts,
    bindHost: options.bindHost,
    hostHeader: options.req.headers.host,
    localPort: options.req.socket.localPort,
    originHeader: options.req.headers.origin,
  });
  if (!guard.allowed) {
    options.res.writeHead(403, { "Content-Type": "text/plain" });
    options.res.end(LocalEdgeKit_localRequestRejectionBody(guard.reason));
    return;
  }

  const reqPathname = new URL(options.req.url ?? "/", "http://localhost")
    .pathname;
  if (reqPathname === "/" || reqPathname === "/index.html") {
    try {
      options.res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
      });
      options.res.end(
        options.operations.readText(options.serverOptions.htmlPath),
      );
    } catch {
      options.res.writeHead(500, { "Content-Type": "text/plain" });
      options.res.end("Failed to load index.html");
    }
    return;
  }

  if (reqPathname === "/health") {
    options.res.writeHead(200, { "Content-Type": "application/json" });
    options.res.end(
      JSON.stringify({ status: "ok", clients: options.clientCount() }),
    );
    return;
  }

  options.res.writeHead(404, { "Content-Type": "text/plain" });
  options.res.end("Not found");
}

/** Starts the logs-web HTTP/websocket server and returns a closeable handle. */
export function LocalEdgeKit_startLogsWebServer(
  options: LocalEdgeKit_StartLogsWebServerOptions,
): LocalEdgeKit_LogsWebServerHandle {
  const operations = LocalEdgeKit_resolveLogsWebServerOperations(
    options.operations,
  );
  const stdout = options.stdout ?? ((line): void => console.log(line));
  const stderr = options.stderr ?? ((line): void => console.warn(line));
  const clients = new Set<LocalEdgeKit_LogsWebClientState>();
  const bindHost = LocalEdgeKit_resolveBindHost(options.bindHost);

  const server = operations.createServer((req, res) => {
    const requestStartTime = operations.nowMs();
    res.on("finish", () => {
      options.onRequestComplete?.({
        durationMs: operations.nowMs() - requestStartTime,
        host: req.headers.host,
        method: req.method,
        path: req.url,
        statusCode: res.statusCode,
        statusText: res.statusMessage,
        surfaceId: options.surfaceId,
      });
    });

    LocalEdgeKit_handleLogsWebHttpRequest({
      bindHost,
      clientCount: () => clients.size,
      operations,
      req,
      res,
      serverOptions: options,
    });
  });
  const webSocketServer = options.createWebSocketServer(server);
  // Websocket upgrades never reach the HTTP listener above, and browsers do not apply the
  // same-origin policy to them, so they get the same check here. The listener is put in front of
  // the adapter's own upgrade listener so a rejected socket is closed before the adapter sees it.
  server.prependListener(
    "upgrade",
    (req: IncomingMessage, socket: Duplex): void => {
      const guard = LocalEdgeKit_checkLocalRequest({
        allowedHosts: options.allowedHosts,
        bindHost,
        hostHeader: req.headers.host,
        localPort: req.socket.localPort,
        originHeader: req.headers.origin,
      });
      if (guard.allowed) {
        return;
      }
      const body = LocalEdgeKit_localRequestRejectionBody(guard.reason);
      // The adapter may still try to write its own refusal to this socket; that late write must
      // not surface as an unhandled socket error.
      socket.on("error", () => {});
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`,
        () => {
          socket.destroy();
        },
      );
      // The adapter's listener still runs for this event. Without the handshake key no websocket
      // implementation can accept the connection on the socket closed above.
      delete req.headers["sec-websocket-key"];
      delete req.headers.upgrade;
    },
  );

  webSocketServer.onConnection((ws) => {
    const client: LocalEdgeKit_LogsWebClientState = {
      lineCount: 0,
      scope: options.defaultScope,
      sourceCounts: new Map(),
      sourceFilter: null,
      tailInterval: null,
      tailing: true,
      tailProcess: null,
      ws,
    };
    clients.add(client);
    LocalEdgeKit_startLogsWebTail({
      client,
      logDirectory: options.logDirectory,
      operations,
      sourceDefinitions: options.sourceDefinitions,
    });

    ws.onMessage((data) => {
      const message = LocalEdgeKit_parseLogsWebClientMessage(data.toString());
      if (message === null) {
        stderr(`[${options.surfaceId}] Could not parse websocket message`);
        return;
      }

      switch (message.type) {
        case "subscribe":
          client.scope = message.scope;
          client.lineCount = 0;
          client.sourceCounts.clear();
          LocalEdgeKit_startLogsWebTail({
            client,
            logDirectory: options.logDirectory,
            operations,
            sourceDefinitions: options.sourceDefinitions,
          });
          break;
        case "filter":
          client.sourceFilter =
            message.sources.length > 0 ? new Set(message.sources) : null;
          break;
        case "search":
          if (message.query.trim().length > 0) {
            LocalEdgeKit_searchLogsWeb({
              client,
              logDirectory: options.logDirectory,
              operations,
              query: message.query.trim(),
              sourceDefinitions: options.sourceDefinitions,
              stderr,
              surfaceId: options.surfaceId,
            });
          }
          break;
        case "pause":
          client.tailing = false;
          LocalEdgeKit_sendLogsWebMessage(client.ws, {
            lineCount: client.lineCount,
            scope: client.scope,
            tailing: false,
            type: "status",
          });
          break;
        case "resume":
          client.tailing = true;
          LocalEdgeKit_sendLogsWebMessage(client.ws, {
            lineCount: client.lineCount,
            scope: client.scope,
            tailing: true,
            type: "status",
          });
          break;
        case "ping":
          LocalEdgeKit_sendLogsWebMessage(ws, { type: "pong" });
          break;
      }
    });

    ws.onClose(() => {
      LocalEdgeKit_stopLogsWebTail({ client, operations });
      clients.delete(client);
    });
  });

  server.listen(options.port, bindHost, () => {
    for (const line of options.startupLines) {
      stdout(line);
    }
  });

  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const client of clients) {
      LocalEdgeKit_stopLogsWebTail({ client, operations });
    }
    clients.clear();
    webSocketServer.close();
    server.close();
  };

  return {
    close,
    getClientCount: (): number => clients.size,
    server,
    webSocketServer,
  };
}
