/**
 * @fileoverview Verifies the router lifecycle for the hostnames backend through the supervisor
 * CLI with a fake host: candidate check, write and start, adopt only a verified nginx, SIGHUP
 * reload and SIGQUIT stop with an identity check, restoring the previous config when activation
 * fails, reloading a config that was written but never activated, and merging extra-app sources.
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor-router.unit.test.ts
 *
 * @see src/supervisor-router.ts - Module under test.
 * @see src/supervisor-cli.ts - Dispatches `up`, `down` and `status` to the router.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LocalEdgeCore_createExposureBackend } from "@gg-utils/local-edge-core/exposure";

import { type LocalEdgeKit_SupervisorConfig, LocalEdgeKit_buildExposureManifest, LocalEdgeKit_runSupervisorCli } from "./supervisor-cli.js";
import { fakeHost, fakeIdentity, fakePidFile } from "./supervisor-fake-host.unit.test.js";
import { LocalEdgeKit_routerDown } from "./supervisor-router.js";

const HOST = "node-a.example.test";

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
  addresses: { ipv4: "192.0.2.9" },
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

const NGINX_MASTER = "nginx: master process nginx -c /st/nginx/nginx.conf";

/** A live nginx master as the fake host reports it. */
function nginxMaster(pid = 500) {
  return { pid, group: pid, port: 8460, command: NGINX_MASTER };
}

/**
 * nginx fake: `-c conf` starts a master and writes its pid; `-t` succeeds. Signals: SIGHUP is a
 * reload (no state change), SIGQUIT stops the master.
 */
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
        host.processes.set(500, { ...nginxMaster(), alive: true });
        host.files.set("/st/nginx/nginx.pid", "500\n");
      }
      return undefined;
    },
  });
}

/** Renders the config `up` would write, using a throwaway host. */
async function renderedConfig(): Promise<string> {
  const host = nginxHost({ files: { ...certFiles } });
  await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: capture().writer, stderr: capture().writer });
  return host.files.get("/st/nginx/nginx.conf") ?? "";
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
  const host = nginxHost({ files: { ...certFiles, "/w/auth/p": fakePidFile(10) }, processes: [{ pid: 10, group: 10, port: 4300 }] });
  const stdout = capture();
  const stderr = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up"], config: hostConfig, host, stdout: stdout.writer, stderr: stderr.writer }), 0);
  assert.match(stdout.text(), /preview\s+skipped\s+external: route only/);
  assert.match(stdout.text(), /router\s+started\s+nginx pid 500/);
  assert.deepEqual(host.commands.map((c) => c.slice(0, 3).join(" ")), ["nginx -t -q", "nginx -c /st/nginx/nginx.conf"]);
  assert.match(host.files.get("/st/nginx/nginx.conf") ?? "", /server_name preview\.proj-m1\.example\.test;/);
  assert.match(host.files.get("/st/nginx/nginx.conf") ?? "", /location \/api\/v1 \{/);
  assert.ok(![...host.files.keys()].some((file) => file.includes("candidate")));
  assert.match(host.files.get("/st/router.state.json") ?? "", /"pid":500/);
  const again = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: again.writer, stderr: stderr.writer }), 0);
  assert.match(again.text(), /router\s+adopted\s+nginx pid 500 adopted; config current and active/);
  assert.equal(host.commands.length, 2);
  assert.equal(host.signals.length, 0);
  assert.equal(host.spawned.length, 0);
});

void test("up with a changed config sends SIGHUP to the verified nginx and never restarts it", async () => {
  const host = nginxHost({
    files: { ...certFiles, "/w/auth/p": fakePidFile(10), "/st/nginx/nginx.conf": "old", "/st/nginx/nginx.pid": "500" },
    processes: [{ pid: 10, group: 10, port: 4300 }, nginxMaster()],
  });
  const stdout = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: stdout.writer, stderr: capture().writer }), 0);
  assert.match(stdout.text(), /router\s+adopted\s+nginx pid 500 reloaded/);
  assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGHUP" }]);
  assert.ok(!host.commands.some((c) => c[0] === "nginx" && c.length === 3 && c[1] === "-c"));
});

void test("a failed reload restores the previous config, and the next run reloads instead of reporting current", async () => {
  const host = nginxHost({
    files: { ...certFiles, "/st/nginx/nginx.conf": "old", "/st/nginx/nginx.pid": "500" },
    processes: [nginxMaster()],
  });
  const failing = { ...host };
  failing.kill = (pid, signal) => {
    if (signal === "SIGHUP") {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    }
    host.kill(pid, signal);
  };
  const first = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host: failing, stdout: first.writer, stderr: capture().writer }), 1);
  assert.match(first.text(), /reload failed.*previous config restored/);
  assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
  const second = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: second.writer, stderr: capture().writer }), 0);
  assert.match(second.text(), /reloaded with the new config/);
  assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGHUP" }]);
});

void test("a config written but never activated is reloaded even though the disk matches the render", async () => {
  const rendered = await renderedConfig();
  const host = nginxHost({
    files: { ...certFiles, "/st/nginx/nginx.conf": rendered, "/st/nginx/nginx.pid": "500" },
    processes: [nginxMaster()],
  });
  const stdout = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: stdout.writer, stderr: capture().writer }), 0);
  assert.match(stdout.text(), /reloaded/);
  assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGHUP" }]);
  assert.ok(!host.commands.some((c) => c[1] === "-t"));
});

void test("a failed start removes a config that did not exist before", async () => {
  const host = nginxHost({
    files: { ...certFiles },
    onCommand: (_h, command, args) => (command === "nginx" && args[0] === "-c" ? { status: 1, stdout: "", stderr: "bind failed" } : undefined),
  });
  const stdout = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: stdout.writer, stderr: capture().writer }), 1);
  assert.match(stdout.text(), /bind failed; previous config restored/);
  assert.equal(host.files.has("/st/nginx/nginx.conf"), false);
});

void test("a pid file naming an unrelated live process is never reloaded, quit or replaced", async () => {
  const seed = () =>
    nginxHost({
      files: { ...certFiles, "/st/nginx/nginx.conf": "old", "/st/nginx/nginx.pid": "500" },
      processes: [{ pid: 500, group: 500, command: "/usr/sbin/sshd -D" }],
    });
  const up = seed();
  const out1 = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host: up, stdout: out1.writer, stderr: capture().writer }), 1);
  assert.match(out1.text(), /not the recorded router.*nginx not touched/);
  assert.equal(up.files.get("/st/nginx/nginx.conf"), "old");
  assert.deepEqual(up.signals, []);
  assert.deepEqual(up.commands, []);
  const down = seed();
  const out2 = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["down", "router"], config: hostConfig, host: down, stdout: out2.writer, stderr: capture().writer }), 1);
  assert.match(out2.text(), /not stopping/);
  assert.deepEqual(down.signals, []);
  const recycled = nginxHost({
    files: { "/st/nginx/nginx.pid": "500", "/st/router.state.json": JSON.stringify({ pid: 500, identity: fakeIdentity(500, { command: NGINX_MASTER }), activeConfigSha256: null }) },
    processes: [{ ...nginxMaster(), command: "nginx: master process nginx -c /elsewhere.conf", start: "later" }],
  });
  assert.equal(LocalEdgeKit_routerDown({ manifest: LocalEdgeKit_buildExposureManifest(hostConfig), router: { stateRoot: "/st" }, host: recycled }).ok, false);
  assert.deepEqual(recycled.signals, []);
});

void test("the router identity is read again right before the signal: a pid recycled after the check gets no SIGQUIT", () => {
  const host = nginxHost({ files: { "/st/nginx/nginx.pid": "500" }, processes: [nginxMaster()] });
  const racing = { ...host };
  let reads = 0;
  racing.processIdentity = (pid) => {
    const identity = host.processIdentity(pid);
    if (pid === 500 && identity !== null && ++reads > 1) {
      return { ...identity, startedAt: "recycled" };
    }
    return identity;
  };
  const result = LocalEdgeKit_routerDown({ manifest: LocalEdgeKit_buildExposureManifest(hostConfig), router: { stateRoot: "/st" }, host: racing });
  assert.equal(result.ok, false);
  assert.match(result.message, /SIGQUIT not sent/);
  assert.deepEqual(host.signals, []);
});

void test("a failing nginx -t leaves the live config alone; no certificate means nginx is not touched", async () => {
  const bad = fakeHost({
    files: { ...certFiles, "/st/nginx/nginx.conf": "old", "/st/nginx/nginx.pid": "500" },
    processes: [nginxMaster()],
    onCommand: (_host, _command, args) => (args[0] === "-t" ? { status: 1, stdout: "", stderr: "emerg: bad" } : undefined),
  });
  const stdout = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host: bad, stdout: stdout.writer, stderr: capture().writer }), 1);
  assert.match(stdout.text(), /failed the check, nothing replaced/);
  assert.equal(bad.files.get("/st/nginx/nginx.conf"), "old");
  assert.deepEqual(bad.signals, []);
  const noCert = nginxHost();
  const out2 = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host: noCert, stdout: out2.writer, stderr: capture().writer }), 1);
  assert.match(out2.text(), /certificate or key missing/);
  assert.equal(noCert.commands.length, 0);
});

void test("status with hostnames shows the adopted router and the Serve TCP port as exposed", async () => {
  const host = nginxHost({
    files: { "/w/auth/p": fakePidFile(10), "/st/nginx/nginx.pid": "500" },
    processes: [{ pid: 10, group: 10, port: 4300 }, nginxMaster(), { pid: 31, group: 31, port: 3100 }],
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

void test("down with hostnames sends SIGQUIT to the verified nginx and never signals external apps", async () => {
  const host = nginxHost({
    files: { "/st/nginx/nginx.pid": "500" },
    processes: [nginxMaster(), { pid: 31, group: 31, port: 3100 }],
  });
  const stdout = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["down"], config: hostConfig, host, stdout: stdout.writer, stderr: capture().writer }), 0);
  assert.match(stdout.text(), /router\s+stopped/);
  assert.match(stdout.text(), /preview\s+skipped\s+external/);
  assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGQUIT" }]);
});

void test("an app's own hostname pattern reaches the router config", async () => {
  const dashConfig: LocalEdgeKit_SupervisorConfig = {
    ...hostConfig,
    exposure: { ...hostConfig.exposure, hostnames: { ...hostnames, extraWildcardTemplates: ["*.m1.{rootZone}"] } },
    apps: [
      ...hostConfig.apps,
      { id: "dash", enabled: true, external: true, localPort: 3081, healthPath: "/", hostnameTemplate: "{label}.m1.{rootZone}" },
    ],
  };
  const host = nginxHost({ files: { ...certFiles, "/w/auth/p": fakePidFile(10) }, processes: [{ pid: 10, group: 10, port: 4300 }] });
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: dashConfig, host, stdout: capture().writer, stderr: capture().writer }), 0);
  assert.match(host.files.get("/st/nginx/nginx.conf") ?? "", /server_name dash\.m1\.example\.test;/);
});

void test("extra-app sources merge into the router config and status shows each source", async () => {
  const machineConfig: LocalEdgeKit_SupervisorConfig = {
    ...hostConfig,
    exposure: { ...hostConfig.exposure, hostnames: { ...hostnames, extraWildcardTemplates: ["*.m1.{rootZone}"] } },
    extraApps: [
      {
        name: "machine.json",
        load: () => [
          {
            id: "play",
            host: "play.m1.example.test",
            upstream: "127.0.0.1:5174",
            upstreamHost: "127.0.0.1:5174",
            buffering: false,
            readTimeout: "3600s",
            locations: [{ path: "/events", upstream: "127.0.0.1:33114", buffering: false, readTimeout: "3600s" }],
          },
        ],
      },
    ],
  };
  const host = nginxHost({ files: { ...certFiles, "/w/auth/p": fakePidFile(10) }, processes: [{ pid: 10, group: 10, port: 4300 }] });
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: machineConfig, host, stdout: capture().writer, stderr: capture().writer }), 0);
  const conf = host.files.get("/st/nginx/nginx.conf") ?? "";
  assert.match(conf, /server_name play\.m1\.example\.test;\n {4}location \/ \{\n {6}proxy_pass http:\/\/127\.0\.0\.1:5174;\n {6}proxy_http_version 1\.1;\n {6}proxy_set_header Host 127\.0\.0\.1:5174;/);
  assert.match(conf, /location \/events \{\n {6}proxy_pass http:\/\/127\.0\.0\.1:33114;[^}]*proxy_buffering off;\n {6}proxy_read_timeout 3600s;/);
  assert.match(conf, /server_name preview\.proj-m1\.example\.test;/);

  const status = capture();
  await LocalEdgeKit_runSupervisorCli({ args: ["status"], config: machineConfig, host, stdout: status.writer, stderr: capture().writer });
  assert.match(status.text(), /EDGE-STATE\s+SOURCE\s+NOTE/);
  assert.match(status.text(), /play\s+external\s.*\smachine\.json\s+route only/);
  assert.match(status.text(), /preview\s+external\s.*\sproject\s+route only/);

  const clash: LocalEdgeKit_SupervisorConfig = {
    ...machineConfig,
    extraApps: [{ name: "machine.json", load: () => [{ id: "dupe", host: "preview.proj-m1.example.test", upstream: "127.0.0.1:9" }] }],
  };
  const err = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["status"], config: clash, host, stdout: capture().writer, stderr: err.writer }), 2);
  assert.match(err.text(), /duplicate hostname preview\.proj-m1\.example\.test: preview \(project\) and dupe \(machine\.json\)/);
});
