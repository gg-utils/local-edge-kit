/**
 * @fileoverview Verifies helper-dashboard server primitives for `local-edge-kit` helper surfaces.
 *
 * This file owns regression coverage for subdomain URL construction, artifact JSON responses with
 * optional CORS, ENOENT-to-503 mapping, and an in-process HTTP server that serves `/api/status` and
 * transformed dashboard HTML.
 * Flow: configure fixtures -> exercise exports -> assert URLs, bodies, headers, and request completion records.
 *
 * @testing Node test runner: cd packages/local-edge-kit && node ../../node_modules/tsx/dist/cli.mjs --test src/helper-dashboard-server.unit.test.ts
 *
 * @see packages/local-edge-kit/src/helper-dashboard-server.ts - Runtime module whose URL builder, artifact reader, and HTTP server behavior are asserted by these unit tests and in-process `fetch` checks.
 * @see consumer local-edge adapter - Local-edge adapter that wires the same helper-dashboard URL builder and server starter contracts exercised here for the platform-status surface.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  LocalEdgeKit_buildHelperDashboardSubdomainUrl,
  LocalEdgeKit_readHelperDashboardArtifactResponse,
  LocalEdgeKit_startHelperDashboardServer,
  type LocalEdgeKit_HelperDashboardRequestRecord,
} from "./helper-dashboard-server.js";

const endpoint = {
  artifactPath: "/virtual/health.json",
  malformedHint: "Malformed",
  malformedResponseError: "Artifact unreadable",
  missingHint: "Missing",
  missingResponseError: "Artifact not found",
  pathname: "/api/health-data",
  warningMessage: (message: string) => `[surface] read failed: ${message}`,
};

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

void test("LocalEdgeKit_buildHelperDashboardSubdomainUrl omits default HTTPS port", () => {
  assert.equal(
    LocalEdgeKit_buildHelperDashboardSubdomainUrl({
      developerSlug: "dev",
      httpsPort: 443,
      method: "nginx-docker",
      realmSlug: "main",
      rootZone: "local.test",
      surfaceId: "status",
    }),
    "https://status.main.nginx-docker.dev.local.test/",
  );
});

void test("LocalEdgeKit_buildHelperDashboardSubdomainUrl includes non-default HTTPS port", () => {
  assert.equal(
    LocalEdgeKit_buildHelperDashboardSubdomainUrl({
      developerSlug: "dev",
      httpsPort: 444,
      method: "nginx-docker",
      realmSlug: "main",
      rootZone: "local.test",
      surfaceId: "status",
    }),
    "https://status.main.nginx-docker.dev.local.test:444/",
  );
});

void test("LocalEdgeKit_readHelperDashboardArtifactResponse returns JSON with optional CORS", () => {
  const response = LocalEdgeKit_readHelperDashboardArtifactResponse({
    endpoint,
    origin: "https://example.test",
    readText: () => JSON.stringify({ ok: true }),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, {
    "Access-Control-Allow-Origin": "https://example.test",
    "Content-Type": "application/json",
  });
  assert.equal(response.body, JSON.stringify({ ok: true }));
  assert.equal(response.warningLine, undefined);
});

void test("LocalEdgeKit_readHelperDashboardArtifactResponse distinguishes missing artifacts", () => {
  const error = new Error("missing");
  Object.defineProperty(error, "code", { value: "ENOENT" });
  const response = LocalEdgeKit_readHelperDashboardArtifactResponse({
    endpoint,
    origin: undefined,
    readText: () => {
      throw error;
    },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(
    response.body,
    JSON.stringify({ error: "Artifact not found", hint: "Missing" }),
  );
  assert.equal(response.warningLine, undefined);
});

void test("LocalEdgeKit_startHelperDashboardServer serves status and transformed HTML", async (t) => {
  const completionRecords: LocalEdgeKit_HelperDashboardRequestRecord[] = [];
  const stdoutLines: string[] = [];
  let nowMs = 100;

  const server = LocalEdgeKit_startHelperDashboardServer({
    autoOpen: false,
    bindHost: "127.0.0.1",
    htmlPath: "/virtual/index.html",
    htmlTransform: (html) => html.replace("__BOOTSTRAP__", "configured"),
    onRequestComplete: (record) => {
      completionRecords.push(record);
    },
    openCommand: "open",
    operations: {
      nowMs: () => {
        nowMs += 10;
        return nowMs;
      },
      readText: () => "<h1>__BOOTSTRAP__</h1>",
    },
    port: 0,
    startupLines: ["ready"],
    stdout: (line) => {
      stdoutLines.push(line);
    },
    subdomainUrl: "https://status.realm.method.dev.local.test/",
    surfaceId: "status",
  });
  t.after(() => {
    server.close();
  });

  await once(server, "listening");
  const address = server.address();
  assert.ok(isAddressInfo(address));
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  const statusResponse = await fetch(`${baseUrl}/api/status`);
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), { status: "ok" });

  const htmlResponse = await fetch(`${baseUrl}/dashboard`);
  assert.equal(htmlResponse.status, 200);
  assert.equal(await htmlResponse.text(), "<h1>configured</h1>");

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  assert.deepEqual(stdoutLines, ["ready"]);
  assert.equal(completionRecords.length, 2);
  assert.deepEqual(
    completionRecords.map((record) => record.path),
    ["/api/status", "/dashboard"],
  );
  assert.deepEqual(
    completionRecords.map((record) => record.surfaceId),
    ["status", "status"],
  );
});

const guardedDashboardOptions = {
  artifactEndpoint: endpoint,
  autoOpen: false,
  htmlPath: "/virtual/index.html",
  htmlTransform: (html: string): string => html,
  openCommand: "open",
  port: 0,
  startupLines: [],
  subdomainUrl: "https://status.realm.method.dev.local.test/",
  surfaceId: "status",
};

void test("LocalEdgeKit_startHelperDashboardServer binds loopback when no bind host is given", async (t) => {
  const server = LocalEdgeKit_startHelperDashboardServer({
    ...guardedDashboardOptions,
    operations: { readText: () => "<h1>dashboard</h1>" },
  });
  t.after(() => {
    server.close();
  });

  await once(server, "listening");
  const address = server.address();
  assert.ok(isAddressInfo(address));
  assert.equal(address.address, "127.0.0.1");
});

void test("LocalEdgeKit_startHelperDashboardServer rejects foreign Host and Origin headers", async (t) => {
  const server = LocalEdgeKit_startHelperDashboardServer({
    ...guardedDashboardOptions,
    operations: { readText: () => JSON.stringify({ secret: "artifact" }) },
  });
  t.after(() => {
    server.close();
  });

  await once(server, "listening");
  const address = server.address();
  assert.ok(isAddressInfo(address));
  const port = address.port;
  const ownHost = `127.0.0.1:${String(port)}`;

  for (const path of ["/api/status", "/api/health-data", "/dashboard"]) {
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
    assert.ok(!foreignOrigin.body.includes("artifact"));
  }

  const loopback = await requestWithHeaders({
    headers: {
      Host: `localhost:${String(port)}`,
      Origin: `http://localhost:${String(port)}`,
    },
    path: "/api/health-data",
    port,
  });
  assert.equal(loopback.status, 200);
  assert.equal(loopback.body, JSON.stringify({ secret: "artifact" }));

  const throughEdgeRouter = await requestWithHeaders({
    headers: {
      Host: "status.realm.method.dev.local.test",
      Origin: "https://status.realm.method.dev.local.test",
    },
    path: "/api/status",
    port,
  });
  assert.equal(throughEdgeRouter.status, 200);
});

void test("LocalEdgeKit_startHelperDashboardServer binds a non-loopback host only when asked", async (t) => {
  const recorded: { host: string | undefined } = { host: undefined };
  const server = LocalEdgeKit_startHelperDashboardServer({
    ...guardedDashboardOptions,
    allowedHosts: ["edge.example.test:8443"],
    bindHost: "192.0.2.10",
    operations: {
      createServer: createHostRecordingServer(recorded),
      readText: () => "<h1>dashboard</h1>",
    },
  });
  t.after(() => {
    server.close();
  });

  await once(server, "listening");
  assert.equal(recorded.host, "192.0.2.10");
  const address = server.address();
  assert.ok(isAddressInfo(address));
  const port = address.port;

  const statuses: (number | undefined)[] = [];
  for (const host of [
    `192.0.2.10:${String(port)}`,
    "edge.example.test:8443",
    `192.0.2.11:${String(port)}`,
    `attacker.example:${String(port)}`,
  ]) {
    const response = await requestWithHeaders({
      headers: { Host: host },
      path: "/api/status",
      port,
    });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses, [200, 200, 403, 403]);
});
