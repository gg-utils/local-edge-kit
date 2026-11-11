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
import { type ChildProcess } from "node:child_process";
import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
/** Local-edge log scope selectable by logs-web clients. */
export type LocalEdgeKit_LogsWebScope = "run" | "nginx-docker" | "healthcheck" | "all";
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
    onMessage: (listener: (data: {
        toString: () => string;
    }) => void) => void;
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
    readonly createServer: (listener: (req: IncomingMessage, res: ServerResponse) => void) => Server;
    readonly fileExists: (filePath: string) => boolean;
    readonly nowMs: () => number;
    readonly nowTimestamp: () => string;
    readonly readDir: (directory: string) => string[];
    readonly readText: (filePath: string) => string;
    readonly realpath: (filePath: string) => string;
    readonly setInterval: (listener: () => void, ms: number) => ReturnType<typeof setInterval>;
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
    readonly createWebSocketServer: (server: Server) => LocalEdgeKit_LogsWebSocketServer;
    readonly defaultScope: LocalEdgeKit_LogsWebScope;
    readonly htmlPath: string;
    readonly logDirectory: string;
    readonly onRequestComplete?: (record: LocalEdgeKit_LogsWebRequestRecord) => void;
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
/** Removes ANSI SGR markup so downstream prefix matching stays stable across terminals. */
export declare function LocalEdgeKit_stripLogsWebAnsi(text: string): string;
/** Maps a raw line onto the stable label set before the websocket feed publishes counts. */
export declare function LocalEdgeKit_classifyLogsWebSource(options: {
    readonly line: string;
    readonly sourceDefinitions: readonly LocalEdgeKit_LogsWebSourceDefinition[];
}): string;
/** Builds a labeled log line snapshot from raw tail/search text. */
export declare function LocalEdgeKit_parseLogsWebLine(options: {
    readonly nowTimestamp: () => string;
    readonly raw: string;
    readonly sourceDefinitions: readonly LocalEdgeKit_LogsWebSourceDefinition[];
}): LocalEdgeKit_LogsWebLogLine;
/** Builds source-count rows including the synthetic OTHER bucket. */
export declare function LocalEdgeKit_buildLogsWebSourceCountRows(options: {
    readonly otherColor: string;
    readonly sourceCounts: ReadonlyMap<string, number>;
    readonly sourceDefinitions: readonly LocalEdgeKit_LogsWebSourceDefinition[];
}): LocalEdgeKit_LogsWebSourceCountRow[];
/** Locates filesystem paths backing the websocket tail for a local-edge logs scope. */
export declare function LocalEdgeKit_discoverLogsWebFiles(options: {
    readonly logDirectory: string;
    readonly operations?: Partial<Pick<LocalEdgeKit_LogsWebServerOperations, "fileExists" | "readDir" | "realpath">>;
    readonly scope: LocalEdgeKit_LogsWebScope;
}): string[];
/** Starts the logs-web HTTP/websocket server and returns a closeable handle. */
export declare function LocalEdgeKit_startLogsWebServer(options: LocalEdgeKit_StartLogsWebServerOptions): LocalEdgeKit_LogsWebServerHandle;
export {};
