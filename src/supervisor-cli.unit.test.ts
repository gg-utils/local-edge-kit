/**
 * @fileoverview Verifies the supervisor CLI dispatch with a fake host and a fake exposure backend
 * runner: status table and JSON, plan, dry-run expose, and the protected-port refusal path.
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor-cli.unit.test.ts
 *
 * @see src/supervisor-cli.ts - Module under test.
 * @documentation reviewed=2026-11-11 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LocalEdgeCore_createExposureBackend } from "@gg-utils/local-edge-core/exposure";

import { type LocalEdgeKit_SupervisorConfig, LocalEdgeKit_runSupervisorCli } from "./supervisor-cli.js";
import { fakeHost } from "./supervisor-fake-host.unit.test.js";

const HOST = "node-a.example.ts.net";

function backendFactory(mapped: Record<string, string>) {
  const calls: string[] = [];
  const runner = (_command: string, args: readonly string[]) => {
    calls.push(args.join(" "));
    if (args[1] === "status") {
      const web: Record<string, unknown> = {};
      const tcp: Record<string, unknown> = {};
      for (const [port, target] of Object.entries(mapped)) {
        web[`${HOST}:${port}`] = { Handlers: { "/": { Proxy: target } } };
        tcp[port] = { HTTPS: true };
      }
      return { status: 0, stdout: JSON.stringify({ TCP: tcp, Web: web }), stderr: "" };
    }
    if (args[0] === "status") {
      return { status: 0, stdout: JSON.stringify({ Self: { DNSName: `${HOST}.` } }), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, create: (name: string) => LocalEdgeCore_createExposureBackend(name, { runner }) };
}

const config: LocalEdgeKit_SupervisorConfig = {
  commandName: "edge",
  exposure: { protectedPorts: [443, 8445] },
  apps: [
    { id: "auth", enabled: true, cwd: "/w/auth", command: "pnpm", args: ["start"], localPort: 4300, edgePort: 8451, healthPath: "/health", pidFile: "p", logFile: "l" },
    { id: "later", enabled: false, localPort: 3300, healthPath: "/", pidFile: "p", logFile: "l" },
  ],
};

function capture() {
  let text = "";
  return { writer: { write: (m: string) => (text += m) }, text: () => text };
}

void test("status prints a table with process, health and edge state", async () => {
  const stdout = capture();
  const backend = backendFactory({ "8451": "http://127.0.0.1:4300" });
  const host = fakeHost({ files: { "/w/auth/p": "10" }, processes: [{ pid: 10, group: 10, port: 4300 }] });
  const code = await LocalEdgeKit_runSupervisorCli({ args: ["status"], config, host, createBackend: backend.create, stdout: stdout.writer });
  assert.equal(code, 0);
  assert.match(stdout.text(), /auth\s+running\s+10\s+127\.0\.0\.1:4300\s+ok\s+https:\/\/node-a\.example\.ts\.net:8451\s+exposed/);
  assert.match(stdout.text(), /later\s+disabled/);
});

void test("status --json returns machine-readable rows", async () => {
  const stdout = capture();
  const backend = backendFactory({});
  const code = await LocalEdgeKit_runSupervisorCli({ args: ["status", "--json"], config, host: fakeHost(), createBackend: backend.create, stdout: stdout.writer });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout.text()) as { apps: { id: string; state: string; edge: { state: string } }[] };
  assert.equal(parsed.apps[0]?.state, "stopped");
  assert.equal(parsed.apps[0]?.edge.state, "missing");
});

void test("expose is a dry run without --apply and a no-op when already mapped", async () => {
  const dry = backendFactory({});
  const stdout = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["expose"], config, host: fakeHost(), createBackend: dry.create, stdout: stdout.writer }), 0);
  assert.match(stdout.text(), /dry run/);
  assert.ok(!dry.calls.some((c) => c.startsWith("serve --bg")));
  const mapped = backendFactory({ "8451": "http://127.0.0.1:4300" });
  const out2 = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["expose", "--apply"], config, host: fakeHost(), createBackend: mapped.create, stdout: out2.writer }), 0);
  assert.match(out2.text(), /nothing to do/);
});

void test("expose --apply refuses a protected port and runs nothing", async () => {
  const backend = backendFactory({});
  const stdout = capture();
  const bad: LocalEdgeKit_SupervisorConfig = {
    ...config,
    apps: [{ id: "bad", enabled: true, cwd: "/w", command: "x", localPort: 1234, edgePort: 8445, healthPath: "/", pidFile: "p", logFile: "l" }],
  };
  const code = await LocalEdgeKit_runSupervisorCli({ args: ["expose", "--apply"], config: bad, host: fakeHost(), createBackend: backend.create, stdout: stdout.writer });
  assert.equal(code, 1);
  assert.match(stdout.text(), /refuse\s+bad.*protected/);
  assert.ok(!backend.calls.some((c) => c.startsWith("serve --bg") || c.endsWith("off")));
});

void test("plan --backend selects a plan-only backend; unknown commands and apps fail with 2", async () => {
  const stdout = capture();
  const stderr = capture();
  const backend = backendFactory({});
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["plan", "--backend=tailscale-services"], config, host: fakeHost(), createBackend: backend.create, stdout: stdout.writer }), 0);
  assert.match(stdout.text(), /svc:auth/);
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["nope"], config, host: fakeHost(), stdout: stdout.writer, stderr: stderr.writer }), 2);
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["health", "ghost"], config, host: fakeHost(), stdout: stdout.writer, stderr: stderr.writer }), 2);
});

void test("logs --follow hands the resolved log file to the follower", async () => {
  let seen = "";
  const code = await LocalEdgeKit_runSupervisorCli({
    args: ["logs", "auth", "-n", "5", "-f"],
    config,
    host: fakeHost(),
    followLog: (file, lines) => {
      seen = `${file}:${String(lines)}`;
      return Promise.resolve(0);
    },
  });
  assert.equal(code, 0);
  assert.equal(seen, "/w/auth/l:5");
});
