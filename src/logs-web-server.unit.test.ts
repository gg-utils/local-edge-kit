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
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
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

test("LocalEdgeKit_stripLogsWebAnsi removes color escape sequences", () => {
  assert.equal(
    LocalEdgeKit_stripLogsWebAnsi("\u001b[31mAPI ready\u001b[0m"),
    "API ready",
  );
});

test("LocalEdgeKit_classifyLogsWebSource maps configured prefixes", () => {
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

test("LocalEdgeKit_parseLogsWebLine strips ANSI and stamps classified rows", () => {
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

test("LocalEdgeKit_buildLogsWebSourceCountRows includes configured and OTHER rows", () => {
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

test("LocalEdgeKit_discoverLogsWebFiles resolves run, router, and healthcheck logs", () => {
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

test("LocalEdgeKit_startLogsWebServer serves static HTML and health", async (t) => {
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
