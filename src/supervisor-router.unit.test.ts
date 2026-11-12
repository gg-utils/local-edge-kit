/**
 * @fileoverview Verifies the router lifecycle for the hostnames backend through the supervisor
 * CLI with a fake host: candidate check, write and start, adopt only a verified nginx, SIGHUP
 * reload and SIGQUIT stop with an identity check, activation confirmed by the marker hash (a
 * received but rejected SIGHUP restores the old bytes), exact `-c` matching of a hand-started
 * master, and reloading a config that was written but never activated.
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
import { LocalEdgeKit_nginxMasterConfigArg, LocalEdgeKit_routerDown, LocalEdgeKit_routerUp } from "./supervisor-router.js";

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

/** The marker hash in a rendered config, or null when it has none. */
function markerOf(text: string | undefined): string | null {
  return /return 200 "([0-9a-f]{64})"/.exec(text ?? "")?.[1] ?? null;
}

/**
 * nginx fake: `-c conf` starts a master, writes its pid and loads the file; `-t` succeeds.
 * Signals: SIGHUP reloads the file on disk unless `rejectReload` is set (then the master keeps
 * its old config, as nginx does when the new one fails), SIGQUIT stops the master. The marker
 * socket answers with the hash of the loaded config.
 */
function nginxHost(seed: Parameters<typeof fakeHost>[0] & { rejectReload?: boolean; loaded?: string | null } = {}) {
  const nginx = { loaded: seed.loaded ?? null };
  const host = fakeHost({
    ...seed,
    fetchUnixSocket: (socketPath, urlPath) =>
      seed.fetchUnixSocket
        ? seed.fetchUnixSocket(socketPath, urlPath)
        : socketPath === "/st/nginx/confirm.sock" && urlPath === "/local-edge-config"
          ? nginx.loaded
          : null,
    onCommand: (h, command, args) => {
      const seeded = seed.onCommand?.(h, command, args);
      if (seeded !== undefined) {
        return seeded;
      }
      if (command === "tailscale") {
        return { status: 0, stdout: JSON.stringify({ TCP: { "8460": { TCPForward: "127.0.0.1:8460" } } }), stderr: "" };
      }
      if (command === "nginx" && args.length === 2 && args[0] === "-c") {
        h.processes.set(500, { ...nginxMaster(), alive: true });
        h.files.set("/st/nginx/nginx.pid", "500\n");
        nginx.loaded = markerOf(h.files.get(args[1] ?? ""));
      }
      return undefined;
    },
  });
  const kill = host.kill.bind(host);
  host.kill = (pid, signal) => {
    kill(pid, signal);
    if (pid === 500 && signal === "SIGHUP" && seed.rejectReload !== true) {
      nginx.loaded = markerOf(host.files.get("/st/nginx/nginx.conf"));
    }
  };
  return host;
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
  assert.deepEqual(host.commands.filter((c) => c[0] === "nginx"), [["nginx", "-t", "-q", "-c", "/st/nginx/nginx.conf"]]);
});

void test("a failed start removes a config that did not exist before", async () => {
  const host = nginxHost({
    files: { ...certFiles },
    onCommand: (_h, command, args) => (command === "nginx" && args[0] === "-c" ? { status: 1, stdout: "", stderr: "bind failed" } : undefined),
  });
  const stdout = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: stdout.writer, stderr: capture().writer }), 1);
  assert.match(stdout.text(), /bind failed; the config it created was removed/);
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

const routerState = (host: ReturnType<typeof nginxHost>) =>
  JSON.parse(host.files.get("/st/router.state.json") ?? "null") as { pid: number; activeConfigSha256: string | null } | null;

void test("a SIGHUP that nginx receives but rejects is not adopted: old bytes are restored and nothing is recorded active", async () => {
  const oldConfig = "old";
  const host = nginxHost({
    files: { ...certFiles, "/st/nginx/nginx.conf": oldConfig, "/st/nginx/nginx.pid": "500" },
    processes: [nginxMaster()],
    rejectReload: true,
  });
  const first = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: first.writer, stderr: capture().writer }), 1);
  assert.match(first.text(), /reload not activated: nginx did not confirm the new config.*previous config restored/);
  assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGHUP" }]);
  assert.equal(host.files.get("/st/nginx/nginx.conf"), oldConfig);
  assert.equal(routerState(host)?.activeConfigSha256 ?? null, null);
  // The candidate was checked with nginx -t before the signal.
  assert.deepEqual(host.commands.filter((c) => c[0] === "nginx").map((c) => c.slice(0, 3).join(" ")), ["nginx -t -q"]);
  // The next run does not adopt: it signals again.
  const second = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: second.writer, stderr: capture().writer }), 1);
  assert.equal(host.signals.length, 2);
});

void test("a reload counts as activated only once the marker answers the new hash", async () => {
  const rendered = await renderedConfig();
  const host = nginxHost({ files: { ...certFiles, "/st/nginx/nginx.conf": "old", "/st/nginx/nginx.pid": "500" }, processes: [nginxMaster()] });
  const stdout = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: stdout.writer, stderr: capture().writer }), 0);
  assert.match(stdout.text(), /reloaded with the new config/);
  assert.equal(host.files.get("/st/nginx/nginx.conf"), rendered);
  assert.match(rendered, /listen unix:\/st\/nginx\/confirm\.sock;.*location = \/local-edge-config/);
  assert.equal(typeof routerState(host)?.activeConfigSha256, "string");
  const again = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: again.writer, stderr: capture().writer }), 0);
  assert.match(again.text(), /config current and active/);
  assert.equal(host.signals.length, 1);
});

void test("a started nginx whose marker never answers is not recorded as active", () => {
  const host = nginxHost({ files: { ...certFiles }, fetchUnixSocket: () => "f".repeat(64) });
  const result = LocalEdgeKit_routerUp({ manifest: LocalEdgeKit_buildExposureManifest(hostConfig), router: { stateRoot: "/st", confirm: { timeoutMs: 1000 } }, host, out: capture().writer });
  assert.equal(result.ok, false);
  assert.match(result.message, /started but not activated.*marker gave hash ffffffffffff/);
  assert.equal(routerState(host)?.activeConfigSha256, null);
});

void test("the nginx -c value is parsed exactly", () => {
  assert.equal(LocalEdgeKit_nginxMasterConfigArg("nginx: master process nginx -c /st/nginx/nginx.conf"), "/st/nginx/nginx.conf");
  assert.equal(LocalEdgeKit_nginxMasterConfigArg("nginx: master process /usr/sbin/nginx -g daemon off; -c/st/nginx/nginx.conf"), "/st/nginx/nginx.conf");
  assert.equal(LocalEdgeKit_nginxMasterConfigArg("nginx: master process nginx -c /a.conf -c /b.conf"), null);
  assert.equal(LocalEdgeKit_nginxMasterConfigArg("nginx: master process nginx"), null);
  assert.equal(LocalEdgeKit_nginxMasterConfigArg("nginx: worker process"), null);
  assert.equal(LocalEdgeKit_nginxMasterConfigArg("sh -c nginx: master process nginx -c /st/nginx/nginx.conf"), null);
});

void test("a master for a longer, prefix or suffix config name never gets SIGQUIT or SIGHUP", async () => {
  const manifest = LocalEdgeKit_buildExposureManifest(hostConfig);
  for (const other of ["/st/nginx/nginx.conf.evil", "/st/nginx/nginx.co", "/x/st/nginx/nginx.conf", "/st/nginx/nginx.conf/x"]) {
    const command = `nginx: master process nginx -c ${other}`;
    // With no recorded state, and with a recorded identity that is stale (another start time).
    for (const state of [null, JSON.stringify({ pid: 500, identity: fakeIdentity(500, { command: NGINX_MASTER, startedAt: "earlier" }), activeConfigSha256: null })]) {
      const host = nginxHost({
        files: { ...certFiles, "/st/nginx/nginx.conf": "old", "/st/nginx/nginx.pid": "500", ...(state === null ? {} : { "/st/router.state.json": state }) },
        processes: [{ ...nginxMaster(), command }],
      });
      assert.equal(LocalEdgeKit_routerDown({ manifest, router: { stateRoot: "/st" }, host }).ok, false, other);
      const up = capture();
      assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["up", "router"], config: hostConfig, host, stdout: up.writer, stderr: capture().writer }), 1, other);
      assert.match(up.text(), /not an nginx master for this config/);
      assert.deepEqual(host.signals, [], other);
      assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
    }
  }
});

void test("a master naming the same file through a symlink is adopted after resolving both sides", () => {
  const host = nginxHost({
    files: { "/st/nginx/nginx.pid": "500" },
    processes: [{ ...nginxMaster(), command: "nginx: master process nginx -c /link/nginx.conf" }],
    realPaths: { "/link/nginx.conf": "/st/nginx/nginx.conf" },
  });
  const result = LocalEdgeKit_routerDown({ manifest: LocalEdgeKit_buildExposureManifest(hostConfig), router: { stateRoot: "/st" }, host });
  assert.equal(result.ok, true);
  assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGQUIT" }]);
});

for (const marker of [
  { name: "times out", answer: () => null, seen: /marker gave no answer/ },
  { name: "answers another hash", answer: () => "f".repeat(64), seen: /marker gave hash ffffffffffff/ },
]) {
  for (const before of [
    { name: "an existing config", files: { "/st/nginx/nginx.conf": "old" }, expected: "old", note: /previous config restored/ },
    { name: "no config yet", files: {}, expected: undefined, note: /the config it created was removed/ },
  ]) {
    void test(`a started nginx whose marker ${marker.name} is stopped and ${before.name} is put back`, () => {
      const host = nginxHost({ files: { ...certFiles, ...before.files }, fetchUnixSocket: marker.answer });
      const result = LocalEdgeKit_routerUp({
        manifest: LocalEdgeKit_buildExposureManifest(hostConfig),
        router: { stateRoot: "/st", confirm: { timeoutMs: 1000 } },
        host,
        out: capture().writer,
      });
      assert.equal(result.ok, false);
      assert.match(result.message, /started but not activated/);
      assert.match(result.message, marker.seen);
      assert.match(result.message, before.note);
      assert.match(result.message, /nginx pid 500 it started was stopped/);
      assert.equal(host.files.get("/st/nginx/nginx.conf"), before.expected);
      assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGQUIT" }]);
      assert.equal(host.processes.get(500)?.alive, false);
      assert.equal(routerState(host)?.activeConfigSha256, null);
    });
  }
}

/** Runs `routerUp` on `host` with a short confirm wait. */
function routerUp(host: ReturnType<typeof nginxHost>, confirmMs = 1000) {
  return LocalEdgeKit_routerUp({
    manifest: LocalEdgeKit_buildExposureManifest(hostConfig),
    router: { stateRoot: "/st", confirm: { timeoutMs: confirmMs }, stopTimeoutMs: 3000 },
    host,
    out: capture().writer,
  });
}

const STATE_FILE = "/st/router.state.json";

void test("rollback is best-effort: a state file that cannot be removed still records not-active, puts the old bytes back and returns the failure", () => {
  for (const before of [{ files: { "/st/nginx/nginx.conf": "old" }, expected: "old" }, { files: {}, expected: undefined }]) {
    const host = nginxHost({ files: { ...certFiles, ...before.files }, fetchUnixSocket: () => null });
    const removeFile = host.removeFile.bind(host);
    host.removeFile = (filePath) => {
      if (filePath === STATE_FILE) {
        throw new Error("EACCES: state removal");
      }
      removeFile(filePath);
    };
    const result = routerUp(host);
    assert.equal(result.ok, false);
    assert.equal(result.action, "failed");
    assert.match(result.message, /started but not activated/);
    assert.match(result.message, /removing the router state file also failed: EACCES: state removal/);
    assert.deepEqual(result.errors, ["removing the router state file also failed: EACCES: state removal"]);
    assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGQUIT" }]);
    assert.equal(host.processes.get(500)?.alive, false);
    assert.equal(routerState(host)?.activeConfigSha256, null);
    assert.equal(routerState(host)?.pid, 500);
    assert.equal(host.files.get("/st/nginx/nginx.conf"), before.expected);
  }
});

void test("rollback is best-effort: a failing restore is reported with its error, the stop and the not-active state still happened", () => {
  const host = nginxHost({ files: { ...certFiles, "/st/nginx/nginx.conf": "old" }, fetchUnixSocket: () => null });
  const writeText = host.writeText.bind(host);
  let confWrites = 0;
  host.writeText = (filePath, text, options) => {
    if (filePath === "/st/nginx/nginx.conf" && ++confWrites === 2) {
      throw new Error("ENOSPC: restore");
    }
    writeText(filePath, text, options);
  };
  const result = routerUp(host);
  assert.equal(result.ok, false);
  assert.equal(result.action, "failed");
  assert.match(result.message, /nginx pid 500 it started was stopped/);
  assert.match(result.message, /restoring the previous config also failed: ENOSPC: restore/);
  assert.deepEqual(result.errors, ["restoring the previous config also failed: ENOSPC: restore"]);
  assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGQUIT" }]);
  assert.equal(routerState(host)?.activeConfigSha256, null);
});

void test("rollback is best-effort: a throw while stopping does not skip the not-active state or the restore", () => {
  const host = nginxHost({ files: { ...certFiles, "/st/nginx/nginx.conf": "old" }, fetchUnixSocket: () => null });
  host.processIdentity = ((inner) => (pid: number) => {
    if (pid === 500 && host.signals.length > 0) {
      throw new Error("ps broke");
    }
    return inner(pid);
  })(host.processIdentity.bind(host));
  const result = routerUp(host);
  assert.equal(result.ok, false);
  assert.match(result.message, /stopping the nginx it started failed: ps broke/);
  assert.deepEqual(result.errors, ["stopping the nginx it started failed: ps broke"]);
  assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
  assert.equal(routerState(host)?.activeConfigSha256, null);
});

void test("a reload or start that nginx confirmed but whose state cannot be written says nginx keeps running the confirmed config and the next run reloads it", () => {
  for (const start of [true, false]) {
    const host = nginxHost({
      files: { ...certFiles, ...(start ? {} : { "/st/nginx/nginx.conf": "old", "/st/nginx/nginx.pid": "500" }) },
      ...(start ? {} : { processes: [nginxMaster()] }),
    });
    const writeText = host.writeText.bind(host);
    let failState = true;
    host.writeText = (filePath, text, options) => {
      if (failState && filePath === STATE_FILE) {
        throw new Error("EROFS: state write");
      }
      writeText(filePath, text, options);
    };
    const result = routerUp(host);
    assert.equal(result.ok, false);
    assert.equal(result.action, "failed");
    assert.match(result.message, new RegExp(`nginx ${start ? "started" : "reloaded"} but its state could not be recorded: EROFS: state write`));
    assert.match(result.message, /nginx pid 500 is still running and the confirmed new config stays active and in place \(nothing was rolled back\)/);
    assert.match(result.message, /the next run will reload it again and record the state/);
    assert.deepEqual(result.errors, ["EROFS: state write"]);
    assert.ok(!host.signals.some((s) => s.signal === "SIGQUIT"));
    assert.equal(host.processes.get(500)?.alive, true);
    assert.notEqual(host.files.get("/st/nginx/nginx.conf"), "old");
    assert.equal(host.files.has(STATE_FILE), false);
    // The message is true: with writes working again, the next run reloads and records the state.
    failState = false;
    const next = routerUp(host);
    assert.equal(next.ok, true);
    assert.match(next.message, /reloaded with the new config/);
    assert.equal(typeof routerState(host)?.activeConfigSha256, "string");
  }
});

for (const scenario of [
  {
    name: "nginx exits non-zero",
    seed: { onCommand: (_h: unknown, command: string, args: readonly string[]) => (command === "nginx" && args[0] === "-c" ? { status: 1, stdout: "", stderr: "bind failed" } : undefined) },
    note: /bind failed/,
  },
  {
    name: "the pid file names no live process",
    seed: {
      onCommand: (h: ReturnType<typeof fakeHost>, command: string, args: readonly string[]) => {
        if (command === "nginx" && args[0] === "-c") {
          h.files.set("/st/nginx/nginx.pid", "777\n");
          return { status: 0, stdout: "", stderr: "" };
        }
        return undefined;
      },
    },
    note: /pid file names no live process/,
  },
  {
    name: "the pid is not our master",
    seed: {
      processes: [{ pid: 600, group: 600, command: "nginx: master process nginx -c /other.conf" }],
      onCommand: (h: ReturnType<typeof fakeHost>, command: string, args: readonly string[]) => {
        if (command === "nginx" && args[0] === "-c") {
          h.files.set("/st/nginx/nginx.pid", "600\n");
          return { status: 0, stdout: "", stderr: "" };
        }
        return undefined;
      },
    },
    note: /pid 600 is not an nginx master for this config; not recorded or signalled/,
  },
]) {
  void test(`other start failures stop nothing: ${scenario.name}, so the previous config is restored and no signal is sent`, () => {
    const host = nginxHost({ files: { ...certFiles, "/st/nginx/nginx.conf": "old" }, ...scenario.seed });
    const result = routerUp(host);
    assert.equal(result.ok, false);
    assert.match(result.message, scenario.note);
    assert.match(result.message, /previous config restored/);
    assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
    assert.deepEqual(host.signals, []);
    assert.equal(host.files.has(STATE_FILE), false);
    assert.equal(host.processes.get(600)?.alive ?? true, true);
  });
}

void test("a master that ignores SIGQUIT is reported as still running after the bounded wait, and the config is still restored", () => {
  const host = nginxHost({ files: { ...certFiles, "/st/nginx/nginx.conf": "old" }, fetchUnixSocket: () => null });
  const kill = host.kill.bind(host);
  host.kill = (pid, signal) => {
    if (signal === "SIGQUIT") {
      host.signals.push({ pid, signal });
      return;
    }
    kill(pid, signal);
  };
  const started = host.now();
  const result = routerUp(host);
  assert.equal(result.ok, false);
  assert.match(result.message, /stopping the nginx it started failed: nginx still running after quit/);
  assert.match(result.message, /previous config restored/);
  assert.deepEqual(result.errors, ["stopping the nginx it started failed: nginx still running after quit"]);
  assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGQUIT" }]);
  assert.equal(host.processes.get(500)?.alive, true);
  assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
  assert.equal(routerState(host)?.activeConfigSha256, null);
  // Bounded: the stop wait (3000 ms) plus the confirm wait (1000 ms), no escalation.
  assert.ok(host.now() - started <= 3000 + 1000 + 600);
});

void test("the identity is checked again during rollback: a pid whose identity changed gets no SIGQUIT, and the config is still restored", () => {
  const host = nginxHost({ files: { ...certFiles, "/st/nginx/nginx.conf": "old" }, fetchUnixSocket: () => null });
  const identity = host.processIdentity.bind(host);
  let swapped = false;
  const fetch = host.fetchUnixSocketText.bind(host);
  host.fetchUnixSocketText = (socketPath, urlPath, timeoutMs) => {
    swapped = true;
    return fetch(socketPath, urlPath, timeoutMs);
  };
  host.processIdentity = (pid) => {
    const current = identity(pid);
    return swapped && pid === 500 && current !== null ? { ...current, startedAt: "recycled" } : current;
  };
  const result = routerUp(host);
  assert.equal(result.ok, false);
  assert.match(result.message, /stopping the nginx it started failed: SIGQUIT not sent/);
  assert.match(result.message, /previous config restored/);
  assert.deepEqual(host.signals, []);
  assert.equal(host.processes.get(500)?.alive, true);
  assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
});

const SOCKET_FILE = "/st/nginx/confirm.sock";
const BEFORE_CONFIGS = [
  { name: "an existing config", files: { "/st/nginx/nginx.conf": "old" }, expected: "old", note: /previous config restored/ },
  { name: "no config yet", files: {}, expected: undefined, note: /the config it created was removed/ },
];

for (const before of BEFORE_CONFIGS) {
  void test(`a throw while clearing the old marker socket is rolled back, not thrown: ${before.name}`, () => {
    const host = nginxHost({ files: { ...certFiles, ...before.files } });
    const removeFile = host.removeFile.bind(host);
    host.removeFile = (filePath) => {
      if (filePath === SOCKET_FILE) {
        throw new Error("EISDIR: socket path is a directory");
      }
      removeFile(filePath);
    };
    const result = routerUp(host);
    assert.equal(result.ok, false);
    assert.equal(result.action, "failed");
    assert.match(result.message, /activation was interrupted/);
    assert.match(result.message, before.note);
    assert.deepEqual(result.errors, ["a host call failed: EISDIR: socket path is a directory"]);
    assert.equal(host.files.get("/st/nginx/nginx.conf"), before.expected);
    assert.ok(!host.commands.some((c) => c[0] === "nginx" && c[1] === "-c"), "nginx was never started");
    assert.deepEqual(host.signals, []);
    assert.equal(host.files.has(STATE_FILE), false);
  });
}

void test("a throw while polling the marker after a start stops the nginx it started, records it as not active and restores the config", () => {
  const host = nginxHost({ files: { ...certFiles, "/st/nginx/nginx.conf": "old" } });
  host.fetchUnixSocketText = () => {
    throw new Error("EMFILE: marker poll");
  };
  const result = routerUp(host);
  assert.equal(result.ok, false);
  assert.match(result.message, /activation was interrupted/);
  assert.match(result.message, /nginx pid 500 it started was stopped/);
  assert.match(result.message, /previous config restored/);
  assert.deepEqual(result.errors, ["a host call failed: EMFILE: marker poll"]);
  assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGQUIT" }]);
  assert.equal(host.processes.get(500)?.alive, false);
  assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
  assert.equal(routerState(host)?.activeConfigSha256, null);
});

void test("a throw while polling the marker after a SIGHUP restores the old bytes and records not active, with no SIGQUIT", () => {
  const host = nginxHost({
    files: { ...certFiles, "/st/nginx/nginx.conf": "old", "/st/nginx/nginx.pid": "500" },
    processes: [nginxMaster()],
  });
  host.fetchUnixSocketText = () => {
    throw new Error("EMFILE: marker poll");
  };
  const result = routerUp(host);
  assert.equal(result.ok, false);
  assert.match(result.message, /activation was interrupted/);
  assert.match(result.message, /not recorded as active/);
  assert.match(result.message, /previous config restored/);
  assert.deepEqual(result.errors, ["a host call failed: EMFILE: marker poll"]);
  assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGHUP" }]);
  assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
  assert.equal(routerState(host)?.activeConfigSha256, null);
});

void test("a throw while reading the new nginx's identity restores the config and returns the failure", () => {
  const host = nginxHost({ files: { ...certFiles, "/st/nginx/nginx.conf": "old" } });
  const identity = host.processIdentity.bind(host);
  host.processIdentity = (pid) => {
    if (pid === 500) {
      throw new Error("ps broke");
    }
    return identity(pid);
  };
  const result = routerUp(host);
  assert.equal(result.ok, false);
  assert.equal(result.errors?.[0], "a host call failed: ps broke");
  assert.match(result.message, /previous config restored/);
  assert.match(result.message, /may still be running \(pid 500\)/);
  assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
});

void test("a progress writer that throws after the new config was written rolls the replacement back", () => {
  const host = nginxHost({ files: { ...certFiles, "/st/nginx/nginx.conf": "old" } });
  const result = LocalEdgeKit_routerUp({
    manifest: LocalEdgeKit_buildExposureManifest(hostConfig),
    router: { stateRoot: "/st", confirm: { timeoutMs: 1000 }, stopTimeoutMs: 3000 },
    host,
    out: {
      write: () => {
        throw new Error("EPIPE: progress");
      },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /writing the config failed/);
  assert.match(result.message, /previous config restored/);
  assert.deepEqual(result.errors, ["a host call failed: EPIPE: progress"]);
  assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
  assert.ok(!host.commands.some((c) => c[0] === "nginx" && c[1] === "-c"), "nginx was never started");
});

for (const before of BEFORE_CONFIGS) {
  void test(`a config write that throws after touching the file is rolled back: ${before.name}`, () => {
    const host = nginxHost({ files: { ...certFiles, ...before.files } });
    const writeText = host.writeText.bind(host);
    let torn = false;
    host.writeText = (filePath, text, options) => {
      if (filePath === "/st/nginx/nginx.conf" && !torn) {
        torn = true;
        writeText(filePath, "TORN", options);
        throw new Error("EIO: config write");
      }
      writeText(filePath, text, options);
    };
    const result = routerUp(host);
    assert.equal(result.ok, false);
    assert.equal(result.action, "failed");
    assert.match(result.message, /writing the config failed/);
    assert.match(result.message, before.note);
    assert.deepEqual(result.errors, ["a host call failed: EIO: config write"]);
    assert.equal(host.files.get("/st/nginx/nginx.conf"), before.expected);
    assert.ok(!host.commands.some((c) => c[0] === "nginx" && c[1] === "-c"), "nginx was never started");
    assert.deepEqual(host.signals, []);
    assert.equal(host.files.has(STATE_FILE), false);
  });
}

const PID_FILE = "/st/nginx/nginx.pid";

/** Makes `fn` throw on its first call after `nginx -c` ran (a transient failure) or on every call. */
function throwAfterStart<A extends unknown[], R>(host: ReturnType<typeof nginxHost>, fn: (...args: A) => R, always: boolean, when: (...args: A) => boolean) {
  let thrown = false;
  return (...args: A): R => {
    if (host.commands.some((c) => c[0] === "nginx" && c[1] === "-c") && when(...args) && (always || !thrown)) {
      thrown = true;
      throw new Error("ps broke");
    }
    return fn(...args);
  };
}

for (const call of ["identity read", "own identity read"] as const) {
  void test(`a transient throw between the nginx start and its identity check still stops the nginx it started and records not active: ${call}`, () => {
    const host = nginxHost({ files: { ...certFiles, "/st/nginx/nginx.conf": "old" } });
    if (call === "identity read") {
      host.processIdentity = throwAfterStart(host, host.processIdentity.bind(host), false, (pid) => pid === 500);
    } else {
      host.ownPid = throwAfterStart(host, host.ownPid.bind(host), false, () => true);
    }
    const result = routerUp(host);
    assert.equal(result.ok, false);
    assert.match(result.message, /activation was interrupted/);
    assert.match(result.message, /nginx pid 500 it started was stopped/);
    assert.match(result.message, /previous config restored/);
    assert.doesNotMatch(result.message, /may still be running/);
    assert.deepEqual(result.errors, ["a host call failed: ps broke"]);
    assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGQUIT" }]);
    assert.equal(host.processes.get(500)?.alive, false);
    assert.equal(routerState(host)?.pid, 500);
    assert.equal(routerState(host)?.activeConfigSha256, null);
    assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
  });
}

void test("a throw between the nginx start and its identity check never stops a pid that turns out not to be our nginx master", () => {
  const host = nginxHost({ files: { ...certFiles, "/st/nginx/nginx.conf": "old" } });
  host.ownPid = throwAfterStart(host, host.ownPid.bind(host), false, () => true);
  const identity = host.processIdentity.bind(host);
  host.processIdentity = (pid) => {
    const found = identity(pid);
    return pid === 500 && found !== null ? { ...found, command: "nginx: master process nginx -c /elsewhere/nginx.conf" } : found;
  };
  const result = routerUp(host);
  assert.equal(result.ok, false);
  assert.match(result.message, /may still be running \(pid 500\)/);
  assert.equal(result.errors?.[0], "a host call failed: ps broke");
  assert.equal(result.errors?.length, 2);
  assert.deepEqual(host.signals, []);
  assert.equal(host.processes.get(500)?.alive, true);
  assert.equal(host.files.has(STATE_FILE), false);
  assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
});

for (const call of ["identity read", "pid file read"] as const) {
  void test(`a throw between the nginx start and its identity check that cannot be resolved says a started nginx may still be running: ${call}`, () => {
    const host = nginxHost({ files: { ...certFiles, "/st/nginx/nginx.conf": "old" } });
    if (call === "identity read") {
      host.processIdentity = throwAfterStart(host, host.processIdentity.bind(host), true, (pid) => pid === 500);
    } else {
      host.readText = throwAfterStart(host, host.readText.bind(host), true, (filePath) => filePath === PID_FILE);
    }
    const result = routerUp(host);
    const pid = call === "identity read" ? "pid 500" : "its pid is unknown";
    assert.equal(result.ok, false);
    assert.equal(result.action, "failed");
    assert.match(result.message, /activation was interrupted/);
    assert.match(result.message, new RegExp(`an nginx started by this run may still be running \\(${pid}\\)`));
    assert.match(result.message, /Check \/st\/nginx\/nginx\.pid and the process list/);
    assert.match(result.message, /previous config restored/);
    assert.equal(result.errors?.length, 2);
    assert.equal(result.errors?.[0], "a host call failed: ps broke");
    assert.match(result.errors?.[1] ?? "", /^an nginx started by this run may still be running/);
    assert.deepEqual(host.signals, []);
    assert.equal(host.processes.get(500)?.alive, true);
    assert.equal(host.files.has(STATE_FILE), false);
    assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
  });
}

for (const path of [
  {
    name: "a started nginx",
    seed: { files: { ...certFiles, "/st/nginx/nginx.conf": "old" }, fetchUnixSocket: () => null },
    signals: [{ pid: 500, signal: "SIGQUIT" }],
  },
  {
    name: "a reload nginx rejected",
    seed: { files: { ...certFiles, "/st/nginx/nginx.conf": "old", "/st/nginx/nginx.pid": "500" }, processes: [nginxMaster()], rejectReload: true },
    signals: [{ pid: 500, signal: "SIGHUP" }],
  },
]) {
  void test(`rollback is best-effort: a not-active state write that fails is reported and does not skip the restore: ${path.name}`, () => {
    const host = nginxHost(path.seed);
    const writeText = host.writeText.bind(host);
    host.writeText = (filePath, text, options) => {
      if (filePath === STATE_FILE) {
        throw new Error("EROFS: not-active state");
      }
      writeText(filePath, text, options);
    };
    const result = routerUp(host);
    assert.equal(result.ok, false);
    assert.equal(result.action, "failed");
    assert.match(result.message, /recording it as not active failed: EROFS: not-active state/);
    assert.match(result.message, /previous config restored/);
    assert.deepEqual(result.errors, ["recording it as not active failed: EROFS: not-active state"]);
    assert.deepEqual(host.signals, path.signals);
    assert.equal(host.files.get("/st/nginx/nginx.conf"), "old");
  });
}

/** A running router the supervisor can stop. */
function runningRouter() {
  return nginxHost({ files: { "/st/nginx/nginx.pid": "500", [STATE_FILE]: "{}" }, processes: [nginxMaster()] });
}

function routerDown(host: ReturnType<typeof nginxHost>) {
  return LocalEdgeKit_routerDown({
    manifest: LocalEdgeKit_buildExposureManifest(hostConfig),
    router: { stateRoot: "/st", stopTimeoutMs: 3000 },
    host,
  });
}

void test("down reports ok with the error when only the state file cannot be removed", () => {
  const host = runningRouter();
  const removeFile = host.removeFile.bind(host);
  host.removeFile = (filePath) => {
    if (filePath === STATE_FILE) {
      throw new Error("EACCES: state removal");
    }
    removeFile(filePath);
  };
  const result = routerDown(host);
  assert.equal(result.ok, true);
  assert.equal(result.action, "stopped");
  assert.match(result.message, /nginx pid 500 quit/);
  assert.match(result.message, /removing the router state file failed: EACCES: state removal/);
  assert.deepEqual(result.errors, ["removing the router state file failed: EACCES: state removal"]);
  assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGQUIT" }]);
  assert.equal(host.processes.get(500)?.alive, false);
});

void test("down without any failure has no errors field", () => {
  const result = routerDown(runningRouter());
  assert.equal(result.ok, true);
  assert.equal(result.action, "stopped");
  assert.equal("errors" in result, false);
});

void test("down returns the failure instead of throwing when a host call throws while waiting for the quit", () => {
  const host = runningRouter();
  const identity = host.processIdentity.bind(host);
  host.processIdentity = (pid) => {
    if (pid === 500 && host.signals.length > 0) {
      throw new Error("ps broke");
    }
    return identity(pid);
  };
  const result = routerDown(host);
  assert.equal(result.ok, false);
  assert.equal(result.action, "failed");
  assert.deepEqual(result.errors, ["stopping the router failed: ps broke"]);
  assert.deepEqual(host.signals, [{ pid: 500, signal: "SIGQUIT" }]);
});
