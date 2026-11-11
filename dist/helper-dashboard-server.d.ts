/**
 * @fileoverview Reusable helper-dashboard HTTP server primitives for local-edge surfaces.
 *
 * Dashboard adapters provide project-specific HTML transforms, artifact messages, request logging,
 * URLs, and labels. The kit owns the common `/api/status`, optional JSON artifact endpoint, static
 * HTML serving, request-finish timing, listen binding, and optional browser auto-open behavior.
 *
 * @example
 * ```typescript
 * import {
 *   LocalEdgeKit_buildHelperDashboardSubdomainUrl,
 *   LocalEdgeKit_startHelperDashboardServer,
 * } from "@gg-utils/local-edge-kit/helper-dashboard-server";
 *
 * const subdomainUrl = LocalEdgeKit_buildHelperDashboardSubdomainUrl({
 *   developerSlug: "alice",
 *   httpsPort: 443,
 *   method: "nginx-docker",
 *   realmSlug: "main",
 *   rootZone: "example.test",
 *   surfaceId: "platform-status",
 * });
 *
 * LocalEdgeKit_startHelperDashboardServer({
 *   autoOpen: false,
 *   htmlPath: "/abs/path/to/index.html",
 *   htmlTransform: (html) => html,
 *   openCommand: "open",
 *   port: 9100,
 *   startupLines: ["helper dashboard listening on port 9100"],
 *   subdomainUrl,
 *   surfaceId: "platform-status",
 * });
 * ```
 *
 * The server binds 127.0.0.1 unless `bindHost` is given. Every request must carry a Host header
 * that names this server (a loopback name or the bind host on the listening port, the host of
 * `subdomainUrl`, or an `allowedHosts` entry) and, when it has an Origin header, the origin of that
 * same host; anything else gets a 403.
 *
 * @testing Node test runner: cd packages/local-edge-kit && node ../../node_modules/tsx/dist/cli.mjs --test src/helper-dashboard-server.unit.test.ts
 *
 * @see consumer local-edge adapter - consumer adapter that binds realm ports, healthcheck JSON artifacts, and HTML bootstrap by calling the URL builder and server starter exported from this module.
 * @see consumer local-edge adapter - Logs-web helper surface that reuses LocalEdgeKit_buildHelperDashboardSubdomainUrl for the same local-edge HTTPS subdomain pattern as other dashboards.
 * @see packages/local-edge-kit/src/helper-dashboard-server.unit.test.ts - Node test runner coverage for subdomain URLs, artifact JSON serialization, and HTTP handling for `/api/status` plus transformed index HTML.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
/** Request completion record emitted after a helper-dashboard response finishes. */
export type LocalEdgeKit_HelperDashboardRequestRecord = {
    readonly durationMs: number;
    readonly host: string | undefined;
    readonly method: string | undefined;
    readonly path: string | undefined;
    readonly statusCode: number;
    readonly statusText: string;
    readonly surfaceId: string;
};
/** Endpoint configuration for JSON artifact-backed dashboard data. */
export type LocalEdgeKit_HelperDashboardArtifactEndpoint = {
    readonly artifactPath: string;
    readonly malformedHint: string;
    readonly malformedResponseError: string;
    readonly missingHint: string;
    readonly missingResponseError: string;
    readonly pathname: string;
    readonly warningMessage: (message: string) => string;
};
/** Host operations used by the helper-dashboard server. */
export type LocalEdgeKit_HelperDashboardServerOperations = {
    readonly createServer: (listener: (req: IncomingMessage, res: ServerResponse) => void) => Server;
    readonly execFile: (command: string, args: readonly string[], callback: (error: Error | null) => void) => void;
    readonly nowMs: () => number;
    readonly readText: (filePath: string) => string;
    readonly setTimer: (listener: () => void, ms: number) => void;
};
/** Options for starting a helper-dashboard server. */
export type LocalEdgeKit_StartHelperDashboardServerOptions = {
    /**
     * Extra `host` or `host:port` values accepted in the Host header, for a server reached through
     * a reverse proxy under another name. The host of `subdomainUrl` is always accepted.
     */
    readonly allowedHosts?: readonly string[];
    readonly artifactEndpoint?: LocalEdgeKit_HelperDashboardArtifactEndpoint;
    readonly autoOpen: boolean;
    /**
     * Address to listen on. Defaults to 127.0.0.1. Give another address, such as `0.0.0.0`, only
     * when the server must be reachable from outside this machine (for example from a container).
     */
    readonly bindHost?: string;
    readonly htmlPath: string;
    readonly htmlTransform: (html: string) => string;
    readonly onRequestComplete?: (record: LocalEdgeKit_HelperDashboardRequestRecord) => void;
    readonly openCommand: string;
    readonly operations?: Partial<LocalEdgeKit_HelperDashboardServerOperations>;
    readonly port: number;
    readonly startupLines: readonly string[];
    readonly stderr?: (line: string) => void;
    readonly stdout?: (line: string) => void;
    readonly subdomainUrl: string;
    readonly surfaceId: string;
};
/** Options for building a realm-scoped helper-dashboard URL. */
export type LocalEdgeKit_BuildHelperDashboardSubdomainUrlOptions = {
    readonly developerSlug: string;
    readonly httpsPort: number;
    readonly method: string;
    readonly realmSlug: string;
    readonly rootZone: string;
    readonly surfaceId: string;
};
type LocalEdgeKit_HelperDashboardJsonResponse = {
    readonly body: string;
    readonly headers: Record<string, string>;
    readonly statusCode: number;
    readonly warningLine?: string | undefined;
};
/** Builds a realm-scoped HTTPS URL for a helper dashboard surface. */
export declare function LocalEdgeKit_buildHelperDashboardSubdomainUrl(options: LocalEdgeKit_BuildHelperDashboardSubdomainUrlOptions): string;
/** Reads and serializes the configured JSON artifact endpoint response. */
export declare function LocalEdgeKit_readHelperDashboardArtifactResponse(options: {
    readonly endpoint: LocalEdgeKit_HelperDashboardArtifactEndpoint;
    readonly origin: string | undefined;
    readonly readText: (filePath: string) => string;
}): LocalEdgeKit_HelperDashboardJsonResponse;
/** Starts the helper-dashboard HTTP server and returns the created Node server. */
export declare function LocalEdgeKit_startHelperDashboardServer(options: LocalEdgeKit_StartHelperDashboardServerOptions): Server;
export {};
