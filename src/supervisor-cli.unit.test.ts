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

const hostnames = {
  projectMachineLabel: "proj-m1",
  rootZone: "example.test",
  realm: "main",
  routerHost: "127.0.0.1",
  routerPort: 8460,
  tls: { mode: "provided" as const, certPath: "/st/tls/wildcard.crt", keyPath: "/st/tls/wildcard.key" },
  nginx: {
    confPath: "/st/nginx/nginx.conf",
    pidPath: "/st/nginx/nginx.pid",
    errorLogPath: "/st/logs/nginx-error.log",
    accessLogPath: "/st/logs/nginx-access.log",
    tempDir: "/st/nginx/tmp",
  },
  addresses: { ipv4: "100.64.0.9" },
};

const hostConfig: LocalEdgeKit_SupervisorConfig = {
  ...config,
  exposure: { ...config.exposure, backend: "hostnames", hostnames, router: { stateRoot: "/st" } },
  apps: [
    ...config.apps,
    { id: "preview", enabled: true, external: true, localPort: 3100, healthPath: "/", locations: [{ path: "/api/v1", localPort: 8000 }] },
  ],
};

const certFiles = { "/st/tls/wildcard.crt": "CERT", "/st/tls/wildcard.key": "KEY" };

/** nginx fake: `-c conf` starts a master and writes its pid; reload and -t succeed. */
function nginxHost(seed: Parameters<typeof fakeHost>[0] = {}) {
  return fakeHost({
    ...seed,
    onCommand: (host, command, args) => {
      const seeded = seed.onCommand?.(host, command, args);
      if (seeded !== undefined) {
        return seeded;
      }
      if (command === "tailscale") {
        return { status: 0, stdout: JSON.stringify({ TCP: { "8460": { TCPForward: "127.0.0.1:8460" } } }), stderr: "" };
      }
      if (command === "nginx" && args.length === 2 && args[0] === "-c") {
        host.processes.set(500, { pid: 500, group: 500, port: 8460, alive: true });
        host.files.set("/st/nginx/nginx.pid", "500\n");
      }
      return undefined;
    },
  });
}

void test("config backend hostnames plans SNI hosts and expose --apply refuses", async () => {
  const stdout = capture();
  const backend = backendFactory({});
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["plan"], config: hostConfig, host: fakeHost(), createBackend: backend.create, stdout: stdout.writer }), 0);
  assert.match(stdout.text(), /auth\.proj-m1\.example\.test:8460/);
  assert.match(stdout.text(), /tailscale serve --bg --tcp=8460 tcp:\/\/127\.0\.0\.1:8460/);
  const out2 = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["expose", "--apply"], config: hostConfig, host: fakeHost(), createBackend: backend.create, stdout: out2.writer }), 1);
  assert.match(out2.text(), /plan-only/);
  assert.ok(!backend.calls.some((call) => call.includes("--tcp")));
  const out3 = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["plan", "--backend=ports"], config: hostConfig, host: fakeHost(), createBackend: backend.create, stdout: out3.writer }), 0);
  assert.match(out3.text(), /backend: tailscale-serve-ports/);
});

void test("up with hostnames checks a candidate, writes the config and starts nginx; a rerun adopts it", async () => {
  const host = nginxHost({ files: { ...certFiles, "/w/auth/p": "10" }, processes: [{ pid: 10, group: 10, port: 4300 }] });
  const stdout = capture();
  const stderr = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up"], config: hostConfig, host, stdout: stdout.writer, stderr: stderr.writer }), 0);
  assert.match(stdout.text(), /preview\s+skipped\s+external: route only/);
  assert.match(stdout.text(), /router\s+started\s+nginx pid 500/);
  assert.deepEqual(host.commands.map((c) => c.slice(0, 3).join(" ")), ["nginx -t -q", "nginx -c /st/nginx/nginx.conf"]);
  assert.match(host.files.get("/st/nginx/nginx.conf") ?? "", /server_name preview\.proj-m1\.example\.test;/);
  assert.match(host.files.get("/st/nginx/nginx.conf") ?? "", /location \/api\/v1 \{/);
  assert.ok(![...host.files.keys()].some((file) => file.includes("candidate")));
  const again = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: again.writer, stderr: stderr.writer }), 0);
  assert.match(again.text(), /router\s+adopted\s+nginx pid 500 adopted; config current/);
  assert.equal(host.commands.length, 2);
  assert.equal(host.spawned.length, 0);
});

void test("up with a changed config reloads the running nginx and never restarts it", async () => {
  const host = nginxHost({
    files: { ...certFiles, "/w/auth/p": "10", "/st/nginx/nginx.conf": "old", "/st/nginx/nginx.pid": "500" },
    processes: [{ pid: 10, group: 10, port: 4300 }, { pid: 500, group: 500, port: 8460 }],
  });
  const stdout = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: stdout.writer, stderr: capture().writer }), 0);
  assert.match(stdout.text(), /router\s+adopted\s+nginx pid 500 reloaded/);
  assert.deepEqual(host.commands.at(-1), ["nginx", "-c", "/st/nginx/nginx.conf", "-s", "reload"]);
  assert.equal(host.signals.length, 0);
});

void test("a failing nginx -t leaves the live config alone; no certificate means nginx is not touched", async () => {
  const bad = fakeHost({
    files: { ...certFiles, "/st/nginx/nginx.conf": "old", "/st/nginx/nginx.pid": "500" },
    processes: [{ pid: 500, group: 500, port: 8460 }],
    onCommand: (_host, _command, args) => (args[0] === "-t" ? { status: 1, stdout: "", stderr: "emerg: bad" } : undefined),
  });
  const stdout = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host: bad, stdout: stdout.writer, stderr: capture().writer }), 1);
  assert.match(stdout.text(), /failed the check, nothing replaced/);
  assert.equal(bad.files.get("/st/nginx/nginx.conf"), "old");
  const noCert = nginxHost();
  const out2 = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host: noCert, stdout: out2.writer, stderr: capture().writer }), 1);
  assert.match(out2.text(), /certificate or key missing/);
  assert.equal(noCert.commands.length, 0);
});

void test("status with hostnames shows the adopted router and the Serve TCP port as exposed", async () => {
  const host = nginxHost({
    files: { "/w/auth/p": "10", "/st/nginx/nginx.pid": "500" },
    processes: [{ pid: 10, group: 10, port: 4300 }, { pid: 500, group: 500, port: 8460 }, { pid: 31, group: 31, port: 3100 }],
  });
  const stdout = capture();
  await LocalEdgeKit_runSupervisorCli({
    args: ["status"],
    config: hostConfig,
    host,
    createBackend: (name) =>
      LocalEdgeCore_createExposureBackend(name, { runner: (cmd, args) => host.runCommand(cmd, args) }),
    stdout: stdout.writer,
  });
  assert.match(stdout.text(), /router\s+running\s+500\s+127\.0\.0\.1:8460\s+-\s+serve :8460\s+exposed/);
  assert.match(stdout.text(), /preview\s+external\s+-\s+127\.0\.0\.1:3100/);
  assert.match(stdout.text(), /auth\s+running.*https:\/\/auth\.proj-m1\.example\.test:8460\s+exposed/);
});

void test("down with hostnames quits nginx and never signals external apps", async () => {
  const host = nginxHost({
    files: { "/st/nginx/nginx.pid": "500" },
    processes: [{ pid: 500, group: 500, port: 8460 }, { pid: 31, group: 31, port: 3100 }],
    onCommand: (h, command, args) => {
      if (command === "nginx" && args.includes("quit")) {
        const p = h.processes.get(500);
        if (p) p.alive = false;
      }
      return undefined;
    },
  });
  const stdout = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["down"], config: hostConfig, host, stdout: stdout.writer, stderr: capture().writer }), 0);
  assert.match(stdout.text(), /router\s+stopped/);
  assert.match(stdout.text(), /preview\s+skipped\s+external/);
  assert.ok(!host.signals.some((s) => Math.abs(s.pid) === 31));
});
