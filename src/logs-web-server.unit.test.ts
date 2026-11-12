/**
 * @fileoverview Node test coverage for reusable logs-web server primitives in `@gg-utils/local-edge-kit`.
 *
 * This file owns regression tests for ANSI stripping, source classification, parsed log rows,
 * per-source count rows, log-file discovery across scopes, and the HTTP static/health surface on
 * `LocalEdgeKit_startLogsWebServer` with injected filesystem and websocket operations.
 * Flow: call helpers with fixtures or virtual paths -> assert normalized rows, discovery order, or
 * HTTP responses and request-completion records.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/logs-web-server.unit.test.ts
 *
 * @see packages/local-edge-kit/src/logs-web-server.ts - Kit module under test that owns log discovery, line parsing, source labeling, and the HTTP/websocket server lifecycle exercised here.
 * @see consumer local-edge adapter - consumer adapter that imports the kit surface to run the operator-facing logs-web dashboard against real log directories.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalEdgeKit_buildLogsWebSourceCountRows,
  LocalEdgeKit_classifyLogsWebSource,
  LocalEdgeKit_discoverLogsWebFiles,
  LocalEdgeKit_parseLogsWebLine,
  LocalEdgeKit_startLogsWebServer,
  LocalEdgeKit_stripLogsWebAnsi,
  type LocalEdgeKit_LogsWebRequestRecord,
  type LocalEdgeKit_LogsWebSourceDefinition,
} from "./logs-web-server.js";

const sourceDefinitions: readonly LocalEdgeKit_LogsWebSourceDefinition[] = [
  { color: "#60a5fa", label: "API", prefixes: ["API "] },
  { color: "#94a3b8", label: "SYSTEM", prefixes: ["[system]"] },
];

function isAddressInfo(
  value: AddressInfo | string | null,
): value is AddressInfo {
  return typeof value === "object" && value !== null && "port" in value;
}

/** Sends one GET to the loopback port with the given Host and Origin headers. */
function requestWithHeaders(options: {
  readonly headers: Record<string, string>;
  readonly path: string;
  readonly port: number;
}): Promise<{ readonly body: string; readonly status: number | undefined }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        headers: options.headers,
        host: "127.0.0.1",
        path: options.path,
        port: options.port,
        setHost: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ body, status: res.statusCode });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Creates a real server whose `listen` records the requested host but binds loopback, so a test
 * can prove which address the kit asked for without opening a port on other interfaces.
 */
function createHostRecordingServer(recorded: {
  host: string | undefined;
}): (listener: (req: IncomingMessage, res: ServerResponse) => void) => Server {
  return (listener) => {
    const server = createServer(listener);
    const listen = server.listen.bind(server);
    Object.defineProperty(server, "listen", {
      value: (port: number, host: string, callback: () => void): Server => {
        recorded.host = host;
        return listen(port, "127.0.0.1", callback);
      },
    });
    return server;
  };
}

/** Sends a websocket upgrade request over a raw socket and returns everything the server wrote. */
function requestUpgrade(options: {
  readonly headers: Record<string, string>;
  readonly port: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(options.port, "127.0.0.1");
    let received = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      resolve(received);
    });
    const headerLines = Object.entries({
      Connection: "Upgrade",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
      Upgrade: "websocket",
      ...options.headers,
    }).map(([name, value]) => `${name}: ${value}`);
    socket.write(`GET / HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`);
  });
}

void test("LocalEdgeKit_stripLogsWebAnsi removes color escape sequences", () => {
  assert.equal(
    LocalEdgeKit_stripLogsWebAnsi("\u001b[31mAPI ready\u001b[0m"),
    "API ready",
  );
});

void test("LocalEdgeKit_classifyLogsWebSource maps configured prefixes", () => {
  assert.equal(
    LocalEdgeKit_classifyLogsWebSource({
      line: "2026 API ready",
      sourceDefinitions,
    }),
    "API",
  );
  assert.equal(
    LocalEdgeKit_classifyLogsWebSource({
      line: "unmatched",
      sourceDefinitions,
    }),
    "OTHER",
  );
});

void test("LocalEdgeKit_parseLogsWebLine strips ANSI and stamps classified rows", () => {
  assert.deepEqual(
    LocalEdgeKit_parseLogsWebLine({
      nowTimestamp: () => "12:34:56.789",
      raw: "\u001b[32m[system] boot\u001b[0m",
      sourceDefinitions,
    }),
    {
      message: "[system] boot",
      source: "SYSTEM",
      ts: "12:34:56.789",
    },
  );
});

void test("LocalEdgeKit_buildLogsWebSourceCountRows includes configured and OTHER rows", () => {
  const sourceCounts = new Map([
    ["API", 2],
    ["OTHER", 1],
  ]);

  assert.deepEqual(
    LocalEdgeKit_buildLogsWebSourceCountRows({
      otherColor: "#64748b",
      sourceCounts,
      sourceDefinitions,
    }),
    [
      { color: "#60a5fa", count: 2, name: "API" },
      { color: "#94a3b8", count: 0, name: "SYSTEM" },
      { color: "#64748b", count: 1, name: "OTHER" },
    ],
  );
});

void test("LocalEdgeKit_discoverLogsWebFiles resolves run, router, and healthcheck logs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-web-server-"));
  try {
    const logDirectory = path.join(tempDir, "logs", "local-edge");
    const runsDirectory = path.join(logDirectory, "runs");
    fs.mkdirSync(runsDirectory, { recursive: true });
    const runLog = path.join(runsDirectory, "local-edge-20260520.log");
    const latestLink = path.join(runsDirectory, "latest.log");
    const nginxLog = path.join(logDirectory, "nginx-docker.log");
    const healthcheckLog = path.join(logDirectory, "healthcheck.log");
    fs.writeFileSync(runLog, "run\n", "utf8");
    fs.writeFileSync(nginxLog, "nginx\n", "utf8");
    fs.writeFileSync(healthcheckLog, "health\n", "utf8");
    fs.symlinkSync(path.basename(runLog), latestLink);
    const resolvedRunLog = fs.realpathSync(runLog);

    assert.deepEqual(
      LocalEdgeKit_discoverLogsWebFiles({ logDirectory, scope: "run" }),
      [resolvedRunLog],
    );
    assert.deepEqual(
      LocalEdgeKit_discoverLogsWebFiles({ logDirectory, scope: "all" }),
      [resolvedRunLog, nginxLog, healthcheckLog],
    );
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

void test("LocalEdgeKit_startLogsWebServer serves static HTML and health", async (t) => {
  const completionRecords: LocalEdgeKit_LogsWebRequestRecord[] = [];
  const stdoutLines: string[] = [];
  let closeCount = 0;

  const handle = LocalEdgeKit_startLogsWebServer({
    bindHost: "127.0.0.1",
    createWebSocketServer: () => ({
      close: () => {
        closeCount += 1;
      },
      onConnection: () => {},
    }),
    defaultScope: "run",
    htmlPath: "/virtual/index.html",
    logDirectory: "/virtual/logs/local-edge",
    onRequestComplete: (record) => {
      completionRecords.push(record);
    },
    operations: {
      readText: () => "<h1>logs</h1>",
    },
    port: 0,
    sourceDefinitions,
    startupLines: ["ready"],
    stdout: (line) => {
      stdoutLines.push(line);
    },
    surfaceId: "logs-web",
  });
  t.after(() => {
    handle.close();
  });

  await once(handle.server, "listening");
  const address = handle.server.address();
  assert.ok(isAddressInfo(address));
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  const htmlResponse = await fetch(`${baseUrl}/`);
  assert.equal(htmlResponse.status, 200);
  assert.equal(await htmlResponse.text(), "<h1>logs</h1>");

  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: "ok", clients: 0 });

  const missingResponse = await fetch(`${baseUrl}/missing`);
  assert.equal(missingResponse.status, 404);
  assert.equal(await missingResponse.text(), "Not found");

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  assert.deepEqual(stdoutLines, ["ready"]);
  assert.equal(handle.getClientCount(), 0);
  assert.deepEqual(
    completionRecords.map((record) => record.path),
    ["/", "/health", "/missing"],
  );

  handle.close();
  assert.equal(closeCount, 1);
});

const guardedLogsWebOptions = {
  defaultScope: "run" as const,
  htmlPath: "/virtual/index.html",
  logDirectory: "/virtual/logs/local-edge",
  port: 0,
  sourceDefinitions,
  startupLines: [],
  surfaceId: "logs-web",
};

const inertWebSocketServer = {
  close: (): void => {},
  onConnection: (): void => {},
};

void test("LocalEdgeKit_startLogsWebServer binds loopback when no bind host is given", async (t) => {
  const handle = LocalEdgeKit_startLogsWebServer({
    ...guardedLogsWebOptions,
    createWebSocketServer: () => inertWebSocketServer,
  });
  t.after(() => {
    handle.close();
  });

  await once(handle.server, "listening");
  const address = handle.server.address();
  assert.ok(isAddressInfo(address));
  assert.equal(address.address, "127.0.0.1");
});

void test("LocalEdgeKit_startLogsWebServer rejects foreign Host and Origin headers", async (t) => {
  const handle = LocalEdgeKit_startLogsWebServer({
    ...guardedLogsWebOptions,
    createWebSocketServer: () => inertWebSocketServer,
    operations: { readText: () => "<h1>logs</h1>" },
  });
  t.after(() => {
    handle.close();
  });

  await once(handle.server, "listening");
  const address = handle.server.address();
  assert.ok(isAddressInfo(address));
  const port = address.port;
  const ownHost = `127.0.0.1:${String(port)}`;

  for (const path of ["/", "/health"]) {
    const foreignHost = await requestWithHeaders({
      headers: { Host: `attacker.example:${String(port)}` },
      path,
      port,
    });
    assert.equal(foreignHost.status, 403, path);
    assert.equal(foreignHost.body, "Forbidden: Host header is not allowed");

    const foreignOrigin = await requestWithHeaders({
      headers: { Host: ownHost, Origin: "https://attacker.example" },
      path,
      port,
    });
    assert.equal(foreignOrigin.status, 403, path);
    assert.equal(foreignOrigin.body, "Forbidden: cross-origin request");
  }

  const loopback = await requestWithHeaders({
    headers: {
      Host: `localhost:${String(port)}`,
      Origin: `http://localhost:${String(port)}`,
    },
    path: "/",
    port,
  });
  assert.equal(loopback.status, 200);
  assert.equal(loopback.body, "<h1>logs</h1>");
});

void test("LocalEdgeKit_startLogsWebServer refuses foreign websocket upgrades before the adapter", async (t) => {
  const adapterUpgrades: (string | undefined)[] = [];
  const handle = LocalEdgeKit_startLogsWebServer({
    ...guardedLogsWebOptions,
    createWebSocketServer: (server) => {
      // Stands in for a websocket library: it accepts any upgrade that still carries a key.
      server.on("upgrade", (req, socket) => {
        const key = req.headers["sec-websocket-key"];
        adapterUpgrades.push(key);
        if (key !== undefined) {
          socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
        }
      });
      return inertWebSocketServer;
    },
  });
  t.after(() => {
    handle.close();
  });

  await once(handle.server, "listening");
  const address = handle.server.address();
  assert.ok(isAddressInfo(address));
  const port = address.port;
  const ownHost = `127.0.0.1:${String(port)}`;

  const foreignOrigin = await requestUpgrade({
    headers: { Host: ownHost, Origin: "https://attacker.example" },
    port,
  });
  assert.ok(foreignOrigin.startsWith("HTTP/1.1 403 Forbidden\r\n"));
  assert.ok(foreignOrigin.endsWith("Forbidden: cross-origin request"));

  const foreignHost = await requestUpgrade({
    headers: { Host: `attacker.example:${String(port)}` },
    port,
  });
  assert.ok(foreignHost.startsWith("HTTP/1.1 403 Forbidden\r\n"));
  assert.ok(foreignHost.endsWith("Forbidden: Host header is not allowed"));
  assert.deepEqual(adapterUpgrades, [undefined, undefined]);

  const sameOrigin = await requestUpgrade({
    headers: { Host: ownHost, Origin: `http://${ownHost}` },
    port,
  });
  assert.ok(sameOrigin.startsWith("HTTP/1.1 101 Switching Protocols\r\n"));
  assert.equal(adapterUpgrades.length, 3);
  assert.notEqual(adapterUpgrades[2], undefined);
});

void test("LocalEdgeKit_startLogsWebServer binds a non-loopback host only when asked", async (t) => {
  const recorded: { host: string | undefined } = { host: undefined };
  const handle = LocalEdgeKit_startLogsWebServer({
    ...guardedLogsWebOptions,
    allowedHosts: ["logs.dev.example.test"],
    bindHost: "0.0.0.0",
    createWebSocketServer: () => inertWebSocketServer,
    operations: { createServer: createHostRecordingServer(recorded) },
  });
  t.after(() => {
    handle.close();
  });

  await once(handle.server, "listening");
  assert.equal(recorded.host, "0.0.0.0");
  const address = handle.server.address();
  assert.ok(isAddressInfo(address));
  const port = address.port;

  const statuses: (number | undefined)[] = [];
  for (const host of [
    "logs.dev.example.test",
    `127.0.0.1:${String(port)}`,
    `0.0.0.0:${String(port)}`,
    `attacker.example:${String(port)}`,
  ]) {
    const response = await requestWithHeaders({
      headers: { Host: host },
      path: "/health",
      port,
    });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses, [200, 200, 403, 403]);
});

void test("no echo: an invalid search pattern is logged as fixed text and a length, never the pattern or the engine message", async (t) => {
  type Listener = (data: { toString: () => string }) => void;
  const listeners: Listener[] = [];
  const stderrLines: string[] = [];
  const sent: string[] = [];
  const fakeTail = Object.assign(new EventEmitter(), {
    kill: () => true,
    stderr: new EventEmitter(),
    stdout: new EventEmitter(),
  });
  const handle = LocalEdgeKit_startLogsWebServer({
    ...guardedLogsWebOptions,
    bindHost: "127.0.0.1",
    createWebSocketServer: () => ({
      close: () => {},
      onConnection: (listener) => {
        listener({
          onClose: () => {},
          onMessage: (messageListener) => {
            listeners.push(messageListener);
          },
          openState: 1,
          readyState: 1,
          send: (message) => {
            sent.push(message);
          },
        });
      },
    }),
    operations: {
      clearInterval: () => {},
      fileExists: () => true,
      realpath: (filePath) => filePath,
      setInterval: () => setTimeout(() => {}, 0),
      spawnTail: () => fakeTail as unknown as ChildProcess,
    },
    stderr: (line) => {
      stderrLines.push(line);
    },
  });
  t.after(() => {
    handle.close();
  });
  await once(handle.server, "listening");
  const listener = listeners[0];
  assert.ok(listener !== undefined);

  const search = (query: string): string => {
    stderrLines.length = 0;
    listener({ toString: () => JSON.stringify({ query, type: "search" }) });
    return stderrLines.join("\n");
  };

  // A short invalid pattern: fixed text and the length only.
  const shortLine = search("(ECHOMARK1");
  assert.equal(shortLine, "[logs-web] Invalid search pattern (10 characters)");

  // A long pattern with a line break and a terminal escape: still one fixed line.
  const longPattern = `(ECHOMARK2\n\u001b[31m${"a".repeat(5000)}`;
  const longLine = search(longPattern);
  assert.equal(longLine, `[logs-web] Invalid search pattern (${String(longPattern.length)} characters)`);
  assert.equal(longLine.includes("\n"), false);
  assert.equal(longLine.includes("\u001b"), false);
  assert.equal(longLine.includes("Unterminated"), false);
  assert.equal(longLine.includes("Invalid regular expression"), false);

  // The client still gets the empty result and no text.
  const last = sent[sent.length - 1];
  assert.ok(last !== undefined);
  assert.deepEqual(JSON.parse(last), { matches: [], total: 0, type: "searchResults" });
});
