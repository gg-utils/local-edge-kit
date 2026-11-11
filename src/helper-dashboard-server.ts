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
 *   bindHost: "0.0.0.0",
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
 * @testing Node test runner: cd packages/local-edge-kit && node ../../node_modules/tsx/dist/cli.mjs --test src/helper-dashboard-server.unit.test.ts
 *
 * @see consumer local-edge adapter - consumer adapter that binds realm ports, healthcheck JSON artifacts, and HTML bootstrap by calling the URL builder and server starter exported from this module.
 * @see consumer local-edge adapter - Logs-web helper surface that reuses LocalEdgeKit_buildHelperDashboardSubdomainUrl for the same local-edge HTTPS subdomain pattern as other dashboards.
 * @see packages/local-edge-kit/src/helper-dashboard-server.unit.test.ts - Node test runner coverage for subdomain URLs, artifact JSON serialization, and HTTP handling for `/api/status` plus transformed index HTML.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

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
  readonly createServer: (
    listener: (req: IncomingMessage, res: ServerResponse) => void,
  ) => Server;
  readonly execFile: (
    command: string,
    args: readonly string[],
    callback: (error: Error | null) => void,
  ) => void;
  readonly nowMs: () => number;
  readonly readText: (filePath: string) => string;
  readonly setTimer: (listener: () => void, ms: number) => void;
};

/** Options for starting a helper-dashboard server. */
export type LocalEdgeKit_StartHelperDashboardServerOptions = {
  readonly artifactEndpoint?: LocalEdgeKit_HelperDashboardArtifactEndpoint;
  readonly autoOpen: boolean;
  readonly bindHost: string;
  readonly htmlPath: string;
  readonly htmlTransform: (html: string) => string;
  readonly onRequestComplete?: (
    record: LocalEdgeKit_HelperDashboardRequestRecord,
  ) => void;
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

const LocalEdgeKit_defaultHelperDashboardOperations =
  (): LocalEdgeKit_HelperDashboardServerOperations => ({
    createServer,
    execFile: (command, args, callback): void => {
      nodeExecFile(command, [...args], callback);
    },
    nowMs: (): number => performance.now(),
    readText: (filePath): string => fs.readFileSync(filePath, "utf-8"),
    setTimer: (listener, ms): void => {
      setTimeout(listener, ms);
    },
  });

function LocalEdgeKit_resolveHelperDashboardOperations(
  operations: Partial<LocalEdgeKit_HelperDashboardServerOperations> | undefined,
): LocalEdgeKit_HelperDashboardServerOperations {
  const defaults = LocalEdgeKit_defaultHelperDashboardOperations();
  return {
    createServer: operations?.createServer ?? defaults.createServer,
    execFile: operations?.execFile ?? defaults.execFile,
    nowMs: operations?.nowMs ?? defaults.nowMs,
    readText: operations?.readText ?? defaults.readText,
    setTimer: operations?.setTimer ?? defaults.setTimer,
  };
}

function LocalEdgeKit_errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = error.code;
  return typeof code === "string" ? code : null;
}

function LocalEdgeKit_errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds a realm-scoped HTTPS URL for a helper dashboard surface. */
export function LocalEdgeKit_buildHelperDashboardSubdomainUrl(
  options: LocalEdgeKit_BuildHelperDashboardSubdomainUrlOptions,
): string {
  const hostname = [
    options.surfaceId,
    options.realmSlug,
    options.method,
    options.developerSlug,
    options.rootZone,
  ].join(".");
  if (options.httpsPort === 443) {
    return `https://${hostname}/`;
  }
  return `https://${hostname}:${String(options.httpsPort)}/`;
}

/** Reads and serializes the configured JSON artifact endpoint response. */
export function LocalEdgeKit_readHelperDashboardArtifactResponse(options: {
  readonly endpoint: LocalEdgeKit_HelperDashboardArtifactEndpoint;
  readonly origin: string | undefined;
  readonly readText: (filePath: string) => string;
}): LocalEdgeKit_HelperDashboardJsonResponse {
  try {
    const raw = options.readText(options.endpoint.artifactPath);
    const data: unknown = JSON.parse(raw);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (options.origin !== undefined) {
      headers["Access-Control-Allow-Origin"] = options.origin;
    }
    return {
      body: JSON.stringify(data),
      headers,
      statusCode: 200,
    };
  } catch (error: unknown) {
    const isMissing = LocalEdgeKit_errorCode(error) === "ENOENT";
    const body = {
      error: isMissing
        ? options.endpoint.missingResponseError
        : options.endpoint.malformedResponseError,
      hint: isMissing
        ? options.endpoint.missingHint
        : options.endpoint.malformedHint,
    };
    return {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      statusCode: 503,
      warningLine: isMissing
        ? undefined
        : options.endpoint.warningMessage(LocalEdgeKit_errorMessage(error)),
    };
  }
}

function LocalEdgeKit_writeJsonResponse(options: {
  readonly body: string;
  readonly headers?: Record<string, string>;
  readonly res: ServerResponse;
  readonly statusCode: number;
}): void {
  options.res.writeHead(options.statusCode, {
    "Content-Type": "application/json",
    ...options.headers,
  });
  options.res.end(options.body);
}

function LocalEdgeKit_handleHelperDashboardRequest(options: {
  readonly operations: LocalEdgeKit_HelperDashboardServerOperations;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly serverOptions: LocalEdgeKit_StartHelperDashboardServerOptions;
  readonly stderr: (line: string) => void;
}): void {
  const url = new URL(
    options.req.url ?? "/",
    `http://localhost:${String(options.serverOptions.port)}`,
  );

  if (url.pathname === "/api/status") {
    LocalEdgeKit_writeJsonResponse({
      body: JSON.stringify({ status: "ok" }),
      res: options.res,
      statusCode: 200,
    });
    return;
  }

  const artifactEndpoint = options.serverOptions.artifactEndpoint;
  if (
    artifactEndpoint !== undefined &&
    url.pathname === artifactEndpoint.pathname
  ) {
    const response = LocalEdgeKit_readHelperDashboardArtifactResponse({
      endpoint: artifactEndpoint,
      origin: options.req.headers.origin,
      readText: options.operations.readText,
    });
    if (response.warningLine !== undefined) {
      options.stderr(response.warningLine);
    }
    LocalEdgeKit_writeJsonResponse({
      body: response.body,
      headers: response.headers,
      res: options.res,
      statusCode: response.statusCode,
    });
    return;
  }

  try {
    const html = options.serverOptions.htmlTransform(
      options.operations.readText(options.serverOptions.htmlPath),
    );
    options.res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    options.res.end(html);
  } catch (error: unknown) {
    options.stderr(
      `[${options.serverOptions.surfaceId}] Failed to serve index.html: ${LocalEdgeKit_errorMessage(error)}`,
    );
    options.res.writeHead(500, { "Content-Type": "text/plain" });
    options.res.end("Failed to load index.html");
  }
}

/** Starts the helper-dashboard HTTP server and returns the created Node server. */
export function LocalEdgeKit_startHelperDashboardServer(
  options: LocalEdgeKit_StartHelperDashboardServerOptions,
): Server {
  const operations = LocalEdgeKit_resolveHelperDashboardOperations(
    options.operations,
  );
  const stdout = options.stdout ?? ((line): void => console.log(line));
  const stderr = options.stderr ?? ((line): void => console.warn(line));

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

    LocalEdgeKit_handleHelperDashboardRequest({
      operations,
      req,
      res,
      serverOptions: options,
      stderr,
    });
  });

  server.listen(options.port, options.bindHost, () => {
    for (const line of options.startupLines) {
      stdout(line);
    }

    if (options.autoOpen) {
      operations.setTimer(() => {
        operations.execFile(
          options.openCommand,
          [options.subdomainUrl],
          (error) => {
            if (error !== null) {
              stdout(`  (Could not auto-open browser: ${error.message})`);
            }
          },
        );
      }, 2000);
    }
  });

  return server;
}
