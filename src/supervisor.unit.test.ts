/**
 * @fileoverview Verifies the supervisor with a fake host: dependency order, env name checks,
 * adopt-by-pid-file-plus-port, refusal on a foreign port holder, start with health wait, and
 * process-group stop. No process is spawned or signalled.
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor.unit.test.ts
 *
 * @see src/supervisor.ts - Module under test.
 * @documentation reviewed=2026-11-11 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import { fakeHost, fakePidFile } from "./supervisor-fake-host.unit.test.js";
import {
  type LocalEdgeKit_SupervisedApp,
  LocalEdgeKit_inspectSupervisedApp,
  LocalEdgeKit_missingEnvNames,
  LocalEdgeKit_orderSupervisedApps,
  LocalEdgeKit_supervisorDown,
  LocalEdgeKit_supervisorUp,
  LocalEdgeKit_validateSupervisedApps,
} from "./supervisor.js";

const out = { write: () => true };

function apps(): LocalEdgeKit_SupervisedApp[] {
  return [
    {
      id: "web",
      enabled: true,
      cwd: "/w/web",
      command: "pnpm",
      args: ["dev"],
      localPort: 3210,
      healthPath: "/api/menu",
      pidFile: ".local/edge.pid",
      logFile: ".local/edge.log",
      dependsOn: ["auth"],
    },
    {
      id: "auth",
      enabled: true,
      cwd: "/w/auth",
      command: "pnpm",
      args: ["start"],
      envFile: ".env.local",
      requiredEnvNames: ["AUTH_SECRET", "DATABASE_URL"],
      localPort: 4300,
      healthPath: "/health",
      readyPath: "/.well-known/openid-configuration",
      pidFile: ".local/edge.pid",
      logFile: ".local/edge.log",
    },
    { id: "later", enabled: false, disabledReason: "placeholder", localPort: 3300, healthPath: "/", pidFile: "p", logFile: "l" },
  ];
}

void test("orders dependencies first and detects cycles and unknown deps", () => {
  assert.deepEqual(LocalEdgeKit_orderSupervisedApps(apps(), ["web"]).map((a) => a.id), ["auth", "web"]);
  const cyclic = apps().map((a) => (a.id === "auth" ? { ...a, dependsOn: ["web"] } : a));
  assert.throws(() => LocalEdgeKit_orderSupervisedApps(cyclic, ["web"]), /cycle/);
  const problems = LocalEdgeKit_validateSupervisedApps([
    ...apps(),
    { id: "x", enabled: true, localPort: 3210, healthPath: "health", pidFile: "p", logFile: "l", dependsOn: ["later", "nope"] },
  ]);
  assert.equal(problems.length, 5);
});

void test("env check returns missing names only and treats empty values as missing", () => {
  const missing = LocalEdgeKit_missingEnvNames({
    envText: "# c\nexport AUTH_SECRET='s3cr3t-value'\nDATABASE_URL=\nOTHER=1\n",
    requiredNames: ["AUTH_SECRET", "DATABASE_URL", "ABSENT"],
  });
  assert.deepEqual(missing, ["DATABASE_URL", "ABSENT"]);
  assert.ok(!JSON.stringify(missing).includes("s3cr3t"));
});

void test("inspect adopts a pid-file process whose group holds the port", () => {
  const host = fakeHost({
    files: { "/w/auth/.local/edge.pid": fakePidFile(35291) },
    processes: [{ pid: 35291, group: 35255 }, { pid: 35345, group: 35255, port: 4300 }],
  });
  const auth = apps()[1];
  assert.ok(auth);
  assert.equal(LocalEdgeKit_inspectSupervisedApp(auth, host).state, "running");
});

void test("inspect adopts a listener in a child process group by ancestry, and down signals both groups", () => {
  const host = fakeHost({
    files: { "/w/web/.local/edge.pid": fakePidFile(41844) },
    processes: [
      { pid: 41844, group: 41844 },
      { pid: 41856, group: 41844, parent: 41844 },
      { pid: 41863, group: 41863, parent: 41856 },
      { pid: 41887, group: 41863, parent: 41863 },
      { pid: 41941, group: 41863, parent: 41887, port: 3210 },
    ],
  });
  const web = apps()[0];
  assert.ok(web);
  assert.equal(LocalEdgeKit_inspectSupervisedApp(web, host).state, "running");
  const results = LocalEdgeKit_supervisorDown({ apps: [{ ...web, dependsOn: [] }], requestedIds: ["web"], host, out });
  assert.equal(results[0]?.action, "stopped");
  assert.deepEqual(host.signals, [{ pid: -41844, signal: "SIGTERM" }, { pid: -41863, signal: "SIGTERM" }]);
});

void test("inspect reports stale pid, stopped, port-busy and starting", () => {
  const auth = apps()[1];
  assert.ok(auth);
  assert.equal(LocalEdgeKit_inspectSupervisedApp(auth, fakeHost({ files: { "/w/auth/.local/edge.pid": fakePidFile(1234) } })).state, "stale-pid");
  assert.equal(LocalEdgeKit_inspectSupervisedApp(auth, fakeHost()).state, "stopped");
  assert.equal(
    LocalEdgeKit_inspectSupervisedApp(auth, fakeHost({ processes: [{ pid: 77, group: 77, port: 4300 }] })).state,
    "port-busy",
  );
  assert.equal(
    LocalEdgeKit_inspectSupervisedApp(
      auth,
      fakeHost({ files: { "/w/auth/.local/edge.pid": fakePidFile(5) }, processes: [{ pid: 5, group: 5 }, { pid: 77, group: 77, port: 4300 }] }),
    ).state,
    "port-busy",
  );
  assert.equal(
    LocalEdgeKit_inspectSupervisedApp(auth, fakeHost({ files: { "/w/auth/.local/edge.pid": fakePidFile(5) }, processes: [{ pid: 5, group: 5 }] })).state,
    "starting",
  );
});

void test("up adopts a running dependency and starts the dependant, waiting for health", async () => {
  const host = fakeHost({
    files: { "/w/auth/.local/edge.pid": fakePidFile(35291), "/w/web/.local/edge.log": "old\n" },
    processes: [{ pid: 35291, group: 35255, port: 4300 }],
    onSpawn: (h, pid) => {
      const proc = h.processes.get(pid);
      if (proc) proc.port = 3210;
    },
  });
  const results = await LocalEdgeKit_supervisorUp({ apps: apps(), requestedIds: ["web"], host, out });
  assert.deepEqual(results.map((r) => [r.appId, r.action]), [["auth", "adopted"], ["web", "started"]]);
  assert.equal(host.spawned.length, 1);
  assert.deepEqual(host.spawned[0]?.args, ["dev"]);
  assert.equal(host.files.get("/w/web/.local/edge.pid"), fakePidFile(9001, { launchId: host.spawned[0]?.launchId }));
  assert.equal(host.signals.length, 0);
});

void test("up refuses a foreign port holder and never signals it", async () => {
  const host = fakeHost({ processes: [{ pid: 77, group: 77, port: 4300 }] });
  const results = await LocalEdgeKit_supervisorUp({ apps: apps(), requestedIds: ["web"], host, out });
  assert.deepEqual(results.map((r) => r.action), ["failed", "skipped"]);
  assert.match(results[0]?.message ?? "", /refusing to start/);
  assert.equal(host.spawned.length, 0);
  assert.equal(host.signals.length, 0);
});

void test("up fails before spawning when env names are missing, without printing values", async () => {
  const host = fakeHost({ files: { "/w/auth/.env.local": "AUTH_SECRET=hidden-value\n" } });
  const results = await LocalEdgeKit_supervisorUp({ apps: apps(), requestedIds: ["auth"], host, out });
  assert.equal(results[0]?.ok, false);
  assert.match(results[0]?.message ?? "", /DATABASE_URL/);
  assert.ok(!(results[0]?.message ?? "").includes("hidden-value"));
  assert.equal(host.spawned.length, 0);
});

void test("up waits for the ready log line written after start and times out without it", async () => {
  const withLine = apps().map((a) => (a.id === "web" ? { ...a, dependsOn: [], readyLogLine: "Ready in" } : a));
  const host = fakeHost({
    files: { "/w/web/.local/edge.log": "Ready in 1ms (old run)\n" },
    onSpawn: (h, pid) => {
      const proc = h.processes.get(pid);
      if (proc) proc.port = 3210;
    },
  });
  const timedOut = await LocalEdgeKit_supervisorUp({
    apps: withLine.map((a) => ({ ...a, startTimeoutMs: 1000 })),
    requestedIds: ["web"],
    host,
    out,
  });
  assert.equal(timedOut[0]?.action, "failed");
  assert.match(timedOut[0]?.message ?? "", /ready log line not seen/);
});

void test("up reports a process that exits before it is ready", async () => {
  const host = fakeHost({
    healthy: () => null,
    onSpawn: (h, pid) => {
      const proc = h.processes.get(pid);
      if (proc) proc.alive = false;
    },
  });
  const results = await LocalEdgeKit_supervisorUp({
    apps: apps().map((a) => ({ ...a, requiredEnvNames: [] })),
    requestedIds: ["auth"],
    host,
    out,
  });
  assert.match(results[0]?.message ?? "", /exited/);
});

void test("down signals the process group, dependants first, and removes the pid file", () => {
  const host = fakeHost({
    files: { "/w/auth/.local/edge.pid": fakePidFile(35291), "/w/web/.local/edge.pid": fakePidFile(34489) },
    processes: [
      { pid: 35291, group: 35255 },
      { pid: 35345, group: 35255, port: 4300 },
      { pid: 34489, group: 34400, port: 3210 },
    ],
  });
  const results = LocalEdgeKit_supervisorDown({ apps: apps(), requestedIds: ["auth", "web"], host, out });
  assert.deepEqual(results.map((r) => [r.appId, r.action]), [["web", "stopped"], ["auth", "stopped"]]);
  assert.deepEqual(host.signals, [{ pid: -34400, signal: "SIGTERM" }, { pid: -35255, signal: "SIGTERM" }]);
  assert.equal(host.files.has("/w/auth/.local/edge.pid"), false);
});

void test("down never signals a foreign port holder and signals only the pid when it shares our group", () => {
  const foreign = fakeHost({ processes: [{ pid: 77, group: 77, port: 4300 }] });
  const auth = apps().filter((a) => a.id === "auth");
  assert.equal(LocalEdgeKit_supervisorDown({ apps: auth, requestedIds: ["auth"], host: foreign, out })[0]?.ok, false);
  assert.equal(foreign.signals.length, 0);
  const sameGroup = fakeHost({
    ownGroup: 500,
    files: { "/w/auth/.local/edge.pid": fakePidFile(501) },
    processes: [{ pid: 501, group: 500, port: 4300 }],
  });
  LocalEdgeKit_supervisorDown({ apps: auth, requestedIds: ["auth"], host: sameGroup, out });
  assert.deepEqual(sameGroup.signals, [{ pid: 501, signal: "SIGTERM" }]);
});

void test("down escalates to SIGKILL when TERM is ignored", () => {
  const host = fakeHost({ files: { "/w/auth/.local/edge.pid": fakePidFile(600) }, processes: [{ pid: 600, group: 600, port: 4300 }] });
  const realKill = (pid: number, signal: NodeJS.Signals | 0) => host.kill(pid, signal);
  const patched = { ...host };
  patched.kill = (pid, signal) => {
    if (signal === "SIGTERM") {
      host.signals.push({ pid, signal });
      return;
    }
    realKill(pid, signal);
  };
  const auth = apps().filter((a) => a.id === "auth").map((a) => ({ ...a, stopTimeoutMs: 1000 }));
  const results = LocalEdgeKit_supervisorDown({ apps: auth, requestedIds: ["auth"], host: patched, out });
  assert.equal(results[0]?.action, "stopped");
  assert.deepEqual(host.signals.map((s) => s.signal), ["SIGTERM", "SIGKILL"]);
});

void test("launch env goes to the started process, counts for required names and prints names only", async () => {
  const host = fakeHost({ onSpawn: (h, pid) => h.processes.set(pid, { pid, group: pid, port: 4300, alive: true }) });
  const out: string[] = [];
  const app = {
    id: "api",
    enabled: true,
    cwd: "/w/api",
    command: "node",
    localPort: 4300,
    healthPath: "/health",
    pidFile: "p",
    logFile: "l",
    requiredEnvNames: ["API_ISSUER"],
    launchEnv: () => ({ API_ISSUER: "https://secret-looking-value.example.test" }),
  };
  const results = await LocalEdgeKit_supervisorUp({ apps: [app], requestedIds: ["api"], host, out: { write: (m: string) => out.push(m) } });
  assert.equal(results[0]?.action, "started");
  assert.deepEqual(host.spawned[0]?.env, { API_ISSUER: "https://secret-looking-value.example.test" });
  assert.ok(out.join("").includes("launch env: API_ISSUER"));
  assert.ok(!out.join("").includes("secret-looking-value"));
  const failing = await LocalEdgeKit_supervisorUp({
    apps: [{ ...app, launchEnv: () => { throw new Error("plan command failed"); } }],
    requestedIds: ["api"],
    host: fakeHost(),
    out: { write: () => undefined },
  });
  assert.match(failing[0]?.message ?? "", /launch env unavailable: plan command failed/);
});

void test("external apps are listed and probed but never started, stopped or signalled", async () => {
  const host = fakeHost({ processes: [{ pid: 31, group: 31, port: 3100 }] });
  const app = { id: "lane", enabled: true, external: true, localPort: 3100, healthPath: "/" };
  assert.deepEqual(LocalEdgeKit_validateSupervisedApps([app]), []);
  assert.equal(LocalEdgeKit_inspectSupervisedApp(app, host).state, "external");
  const up = await LocalEdgeKit_supervisorUp({ apps: [app], requestedIds: ["lane"], host, out: { write: () => undefined } });
  assert.equal(up[0]?.action, "skipped");
  const down = LocalEdgeKit_supervisorDown({ apps: [app], requestedIds: ["lane"], host, out: { write: () => undefined } });
  assert.equal(down[0]?.action, "skipped");
  assert.equal(host.spawned.length, 0);
  assert.equal(host.signals.length, 0);
  assert.match(LocalEdgeKit_validateSupervisedApps([{ ...app, command: "x" }])[0] ?? "", /route only/);
});

void test("a recycled pid holding the port is never adopted or signalled", async () => {
  const seed = () =>
    fakeHost({
      files: { "/w/auth/.local/edge.pid": fakePidFile(77) },
      processes: [{ pid: 77, group: 77, port: 4300, start: "a later start" }],
    });
  const auth = apps().filter((a) => a.id === "auth");
  const inspected = LocalEdgeKit_inspectSupervisedApp(auth[0] ?? apps()[1]!, seed());
  assert.equal(inspected.state, "port-busy");
  assert.match(inspected.note, /stale/);
  const down = seed();
  assert.equal(LocalEdgeKit_supervisorDown({ apps: auth, requestedIds: ["auth"], host: down, out })[0]?.ok, false);
  assert.deepEqual(down.signals, []);
  const up = seed();
  const started = await LocalEdgeKit_supervisorUp({ apps: auth.map((a) => ({ ...a, requiredEnvNames: [] })), requestedIds: ["auth"], host: up, out });
  assert.equal(started[0]?.action, "failed");
  assert.deepEqual(up.signals, []);
  assert.equal(up.spawned.length, 0);
});

void test("a recycled pid without a listener is stale, not starting, and down only removes the pid file", () => {
  const host = fakeHost({
    files: { "/w/auth/.local/edge.pid": fakePidFile(78) },
    processes: [{ pid: 78, group: 78, command: "some other program" }],
  });
  const auth = apps().filter((a) => a.id === "auth");
  assert.equal(LocalEdgeKit_inspectSupervisedApp(auth[0]!, host).state, "stale-pid");
  const results = LocalEdgeKit_supervisorDown({ apps: auth, requestedIds: ["auth"], host, out });
  assert.equal(results[0]?.action, "already-stopped");
  assert.deepEqual(host.signals, []);
  assert.equal(host.files.has("/w/auth/.local/edge.pid"), false);
});

void test("a pid file without a recorded identity is unverified: never adopted, started over or signalled", async () => {
  const seed = () =>
    fakeHost({ files: { "/w/auth/.local/edge.pid": "35291\n" }, processes: [{ pid: 35291, group: 35291, port: 4300 }] });
  const auth = apps().filter((a) => a.id === "auth").map((a) => ({ ...a, requiredEnvNames: [] }));
  assert.equal(LocalEdgeKit_inspectSupervisedApp(auth[0]!, seed()).state, "unverified");
  const up = seed();
  const started = await LocalEdgeKit_supervisorUp({ apps: auth, requestedIds: ["auth"], host: up, out });
  assert.equal(started[0]?.action, "failed");
  assert.equal(up.spawned.length, 0);
  const down = seed();
  assert.equal(LocalEdgeKit_supervisorDown({ apps: auth, requestedIds: ["auth"], host: down, out })[0]?.ok, false);
  assert.deepEqual(down.signals, []);
  assert.equal(down.files.has("/w/auth/.local/edge.pid"), true);
});

void test("identity is checked again before every signal: a pid recycled during the stop gets no SIGKILL", () => {
  const host = fakeHost({ files: { "/w/auth/.local/edge.pid": fakePidFile(600) }, processes: [{ pid: 600, group: 600, port: 4300 }] });
  const patched = { ...host };
  patched.kill = (pid, signal) => {
    if (signal === "SIGTERM") {
      host.signals.push({ pid, signal });
      const proc = host.processes.get(600);
      if (proc) proc.start = "recycled after exit";
      return;
    }
    host.kill(pid, signal);
  };
  const auth = apps().filter((a) => a.id === "auth").map((a) => ({ ...a, stopTimeoutMs: 1000 }));
  LocalEdgeKit_supervisorDown({ apps: auth, requestedIds: ["auth"], host: patched, out });
  assert.deepEqual(host.signals.map((s) => s.signal), ["SIGTERM"]);
});

void test("a live supervisor's lock makes up and down refuse; a dead owner's lock is taken over and released", async () => {
  const lockFile = "/w/auth/.local/edge.pid.lock";
  const auth = apps().filter((a) => a.id === "auth").map((a) => ({ ...a, requiredEnvNames: [] }));
  const held = fakeHost({
    files: { [lockFile]: fakePidFile(4242) },
    processes: [{ pid: 4242, group: 4242 }],
    onSpawn: (h, pid) => {
      const proc = h.processes.get(pid);
      if (proc) proc.port = 4300;
    },
  });
  const refused = await LocalEdgeKit_supervisorUp({ apps: auth, requestedIds: ["auth"], host: held, out });
  assert.equal(refused[0]?.action, "failed");
  assert.match(refused[0]?.message ?? "", /another supervisor \(pid 4242\)/);
  assert.equal(held.spawned.length, 0);
  assert.equal(LocalEdgeKit_supervisorDown({ apps: auth, requestedIds: ["auth"], host: held, out })[0]?.ok, false);

  const proc = held.processes.get(4242);
  if (proc) proc.alive = false;
  const started = await LocalEdgeKit_supervisorUp({ apps: auth, requestedIds: ["auth"], host: held, out });
  assert.equal(started[0]?.action, "started");
  assert.equal(held.spawned.length, 1);
  assert.equal(held.files.has(lockFile), false);
});

void test("a start records the identity with the pid and refreshes a title the process changed while starting", async () => {
  const host = fakeHost({
    onSpawn: (h, pid) => {
      const proc = h.processes.get(pid);
      if (proc) proc.port = 4300;
    },
    healthy: () => {
      const proc = host.processes.get(9001);
      if (proc) proc.command = "renamed-by-itself";
      return 200;
    },
  });
  const auth = apps().filter((a) => a.id === "auth").map((a) => ({ ...a, requiredEnvNames: [] }));
  await LocalEdgeKit_supervisorUp({ apps: auth, requestedIds: ["auth"], host, out });
  const launchId = host.spawned[0]?.launchId;
  assert.match(launchId ?? "", /^[0-9a-f]{32}$/);
  assert.equal(host.files.get("/w/auth/.local/edge.pid"), fakePidFile(9001, { command: "renamed-by-itself", launchId }));
  assert.equal(LocalEdgeKit_supervisorDown({ apps: auth, requestedIds: ["auth"], host, out })[0]?.action, "stopped");
});

void test("a pid reused in the same second by the same user and command line is not adopted or signalled", async () => {
  const host = fakeHost({
    onSpawn: (h, pid) => {
      const proc = h.processes.get(pid);
      if (proc) proc.port = 4300;
    },
  });
  const auth = apps().filter((a) => a.id === "auth").map((a) => ({ ...a, requiredEnvNames: [] }));
  await LocalEdgeKit_supervisorUp({ apps: auth, requestedIds: ["auth"], host, out });
  const proc = host.processes.get(9001);
  assert.ok(proc);
  assert.equal(LocalEdgeKit_inspectSupervisedApp(auth[0] as LocalEdgeKit_SupervisedApp, host).state, "running");
  // The started process exits; another one gets the same pid within the same second, with the
  // same uid, start time display and command line, but without our launch id.
  proc.launchId = null;
  assert.notEqual(LocalEdgeKit_inspectSupervisedApp(auth[0] as LocalEdgeKit_SupervisedApp, host).state, "running");
  LocalEdgeKit_supervisorDown({ apps: auth, requestedIds: ["auth"], host, out });
  assert.deepEqual(host.signals, []);
  // Where the environment cannot be read, the check falls back to uid, start time and command.
  delete proc.launchId;
  assert.equal(LocalEdgeKit_inspectSupervisedApp(auth[0] as LocalEdgeKit_SupervisedApp, host).state, "running");
});
