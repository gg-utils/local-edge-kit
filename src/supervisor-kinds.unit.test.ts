/**
 * @fileoverview Verifies the catalog kinds (`run`, `external`, `check`) and the read-only status
 * fields: kind resolution and its named errors, per-kind validation, `up` and `down` skipping
 * `external` and `check` entries, external pid and log files that are only read (through the
 * safe-read helper), and the new `status` columns and `--json` fields. Every host effect is a
 * stub: nothing is spawned, signalled or fetched, and no address is contacted.
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor-kinds.unit.test.ts
 *
 * @see src/supervisor.ts - Kind resolution, validation, inspection and status fields.
 * @see src/supervisor-cli.ts - The `status`, `health` and `logs` commands.
 * @documentation reviewed=2026-11-13 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalEdgeCore_createExposureBackend } from "@gg-utils/local-edge-core/exposure";

import { LocalEdgeKit_createExtraAppsFileSource } from "./extra-apps.js";
import { LocalEdgeKit_boundedCommandLine } from "./safe-message.js";
import { type LocalEdgeKit_SupervisorConfig, LocalEdgeKit_buildExposureManifest, LocalEdgeKit_runSupervisorCli } from "./supervisor-cli.js";
import { fakeHost } from "./supervisor-fake-host.unit.test.js";
import {
  type LocalEdgeKit_SupervisedApp,
  LocalEdgeKit_createSupervisorHost,
  LocalEdgeKit_inspectSupervisedApp,
  LocalEdgeKit_resolveAppKind,
  LocalEdgeKit_supervisedAppStatusFields,
  LocalEdgeKit_supervisorDown,
  LocalEdgeKit_supervisorUp,
  LocalEdgeKit_validateSupervisedApps,
} from "./supervisor.js";

const out = { write: () => undefined };
const PS_START = "Thu Nov 12 03:47:37 2026";

function capture() {
  let text = "";
  return { writer: { write: (m: string) => (text += m) }, text: () => text };
}

/** A backend whose runner answers from memory: no `tailscale` is ever run. */
const createBackend = (name: string) =>
  LocalEdgeCore_createExposureBackend(name, {
    runner: (_command: string, args: readonly string[]) =>
      args[0] === "status" && args[1] === undefined
        ? { status: 0, stdout: JSON.stringify({ Self: { DNSName: "node-a.example.test." } }), stderr: "" }
        : { status: 0, stdout: JSON.stringify({ TCP: {}, Web: {} }), stderr: "" },
  });

const runApp: LocalEdgeKit_SupervisedApp = {
  id: "web",
  enabled: true,
  cwd: "/w/web",
  command: "pnpm",
  localPort: 3210,
  healthPath: "/",
  pidFile: ".local/web.pid",
  logFile: ".local/web.log",
};
const checkApp: LocalEdgeKit_SupervisedApp = { id: "lint", kind: "check", enabled: true, cwd: "/w/web", command: "pnpm", args: ["lint"] };
const externalApp: LocalEdgeKit_SupervisedApp = {
  id: "lane",
  kind: "external",
  enabled: true,
  localPort: 3100,
  healthPath: "/",
  pidFile: "/srv/lane/lane.pid",
  logFile: "/srv/lane/lane.log",
};

async function statusJson(config: LocalEdgeKit_SupervisorConfig, host = fakeHost()) {
  const stdout = capture();
  const code = await LocalEdgeKit_runSupervisorCli({ args: ["status", "--json"], config, host, createBackend, stdout: stdout.writer, stderr: capture().writer });
  type Row = Record<string, unknown> & { id: string; edge: unknown };
  return { code, rows: (JSON.parse(stdout.text()) as { apps: Row[] }).apps };
}

const configOf = (...apps: LocalEdgeKit_SupervisedApp[]): LocalEdgeKit_SupervisorConfig => ({ exposure: { protectedPorts: [443] }, apps });

void test("kind resolves as kind ?? (external ? external : run)", () => {
  assert.equal(LocalEdgeKit_resolveAppKind({ ...runApp }), "run");
  assert.equal(LocalEdgeKit_resolveAppKind({ ...runApp, external: true }), "external");
  assert.equal(LocalEdgeKit_resolveAppKind({ ...runApp, external: false }), "run");
  assert.equal(LocalEdgeKit_resolveAppKind({ ...runApp, kind: "check" }), "check");
  assert.equal(LocalEdgeKit_resolveAppKind({ ...runApp, kind: "external", external: true }), "external");
  assert.equal(LocalEdgeKit_resolveAppKind({ ...runApp, kind: "check", external: false }), "check");
});

void test("kind and a conflicting external is the named error local-edge-kit-kind-conflict, and an unknown kind is named too", () => {
  for (const app of [
    { ...runApp, kind: "run" as const, external: true },
    { ...runApp, kind: "check" as const, external: true },
    { ...runApp, kind: "external" as const, external: false },
  ]) {
    assert.throws(() => LocalEdgeKit_resolveAppKind(app), { code: "local-edge-kit-kind-conflict", message: /^local-edge-kit-kind-conflict: web: /u });
    assert.match(LocalEdgeKit_validateSupervisedApps([app])[0] ?? "", /^local-edge-kit-kind-conflict: web: /u);
  }
  const unknown = { ...runApp, kind: "ECHOMARK7 token=x" } as unknown as LocalEdgeKit_SupervisedApp;
  assert.throws(() => LocalEdgeKit_resolveAppKind(unknown), { code: "local-edge-kit-kind-unknown" });
  const problems = LocalEdgeKit_validateSupervisedApps([unknown]).join("\n");
  assert.match(problems, /local-edge-kit-kind-unknown/u);
  assert.ok(!problems.includes("ECHOMARK7"), problems);
});

void test("a check entry needs cwd and command but no port or health path; the other kinds still need a port", () => {
  assert.deepEqual(LocalEdgeKit_validateSupervisedApps([checkApp, { ...checkApp, id: "types" }]), []);
  assert.match(LocalEdgeKit_validateSupervisedApps([{ ...checkApp, command: undefined }]).join("\n"), /lint: check apps need cwd and command/u);
  assert.match(LocalEdgeKit_validateSupervisedApps([{ ...checkApp, cwd: undefined }]).join("\n"), /lint: check apps need cwd and command/u);
  assert.deepEqual(LocalEdgeKit_validateSupervisedApps([{ ...checkApp, enabled: false, command: undefined }]), []);
  assert.match(LocalEdgeKit_validateSupervisedApps([{ ...runApp, localPort: undefined }]).join("\n"), /web: run apps need localPort/u);
  assert.match(LocalEdgeKit_validateSupervisedApps([{ ...externalApp, localPort: undefined }]).join("\n"), /lane: external apps need localPort/u);
  assert.match(LocalEdgeKit_validateSupervisedApps([{ ...runApp, healthPath: undefined }]).join("\n"), /web: healthPath must start with \//u);
  assert.match(LocalEdgeKit_validateSupervisedApps([runApp, { ...runApp, id: "b" }]).join("\n"), /b: local port 3210 is also used by web/u);
});

void test("up and down skip check and external entries: nothing is spawned, read for a signal or signalled", async () => {
  const host = fakeHost({
    files: { "/srv/lane/lane.pid": "700\n" },
    processes: [{ pid: 700, group: 700, start: PS_START, command: "lane --serve" }],
  });
  const apps = [checkApp, externalApp];
  const up = await LocalEdgeKit_supervisorUp({ apps, requestedIds: ["lint", "lane"], host, out });
  assert.deepEqual(up.map((r) => [r.appId, r.ok, r.action]), [["lint", true, "skipped"], ["lane", true, "skipped"]]);
  assert.match(up[0]?.message ?? "", /check: not run by up/u);
  const down = LocalEdgeKit_supervisorDown({ apps, requestedIds: ["lint", "lane"], host, out });
  assert.deepEqual(down.map((r) => [r.appId, r.ok, r.action]), [["lane", true, "skipped"], ["lint", true, "skipped"]]);
  assert.match(down.find((r) => r.appId === "lint")?.message ?? "", /check: not run by down/u);
  assert.equal(host.spawned.length, 0);
  assert.equal(host.signals.length, 0);
  assert.equal(host.lockAttempts.length, 0);
  assert.equal(host.processes.get(700)?.alive, true);
});

void test("status lists a check entry as check with health not run, in the table and in --json, and exits 0", async () => {
  const config = configOf(runApp, checkApp);
  const table = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["status"], config, host: fakeHost(), createBackend, stdout: table.writer, stderr: capture().writer }), 0);
  assert.match(table.text(), /lint\s+check\s+-\s+-\s+not run\s/u);
  const { code, rows } = await statusJson(config);
  assert.equal(code, 0);
  const row = rows.find((r) => r.id === "lint");
  assert.equal(row?.state, "check");
  assert.equal(row?.kind, "check");
  assert.equal(row?.localPort, null);
  assert.equal(row?.healthy, null);
  assert.equal(row?.healthStatus, "not run");
  assert.equal(rows.find((r) => r.id === "web")?.healthStatus, null);
});

void test("a check entry is never exposed: the exposure manifest leaves it out", () => {
  // Even a check entry that names a port is not routed.
  const withPort = { ...checkApp, id: "lint-port", localPort: 9999 };
  const ids = LocalEdgeKit_buildExposureManifest(configOf(runApp, checkApp, withPort, externalApp)).apps.map((app) => app.id);
  assert.deepEqual(ids, ["web", "lane"]);
});

void test("health lists a check entry as not run and does not fail on it", async () => {
  const stdout = capture();
  const code = await LocalEdgeKit_runSupervisorCli({ args: ["health", "lint"], config: configOf(checkApp), host: fakeHost(), createBackend, stdout: stdout.writer, stderr: capture().writer });
  assert.equal(code, 0);
  assert.match(stdout.text(), /lint\s+not run/u);
  const json = capture();
  await LocalEdgeKit_runSupervisorCli({ args: ["health", "lint", "--json"], config: configOf(checkApp), host: fakeHost(), createBackend, stdout: json.writer, stderr: capture().writer });
  assert.deepEqual(JSON.parse(json.text()), [{ appId: "lint", healthy: null, checks: [], status: "not run" }]);
});

void test("extra-apps file entries keep arriving as external entries and show kind external", async () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "kit-kinds-")));
  chmodSync(dir, 0o700);
  const file = path.join(dir, "apps.json");
  writeFileSync(file, JSON.stringify({ apps: [{ id: "play", host: "play.example.test", upstream: "127.0.0.1:5174" }] }), { mode: 0o600 });
  const config: LocalEdgeKit_SupervisorConfig = { ...configOf(runApp), extraApps: [LocalEdgeKit_createExtraAppsFileSource({ filePath: file })] };
  const stdout = capture();
  const stderr = capture();
  const code = await LocalEdgeKit_runSupervisorCli({ args: ["status", "--json"], config, host: fakeHost(), createBackend, stdout: stdout.writer, stderr: stderr.writer });
  assert.equal(code, 0, stderr.text());
  const play = (JSON.parse(stdout.text()) as { apps: Record<string, unknown>[] }).apps.find((r) => r.id === "play");
  assert.equal(play?.kind, "external");
  assert.equal(play?.state, "external");
  assert.notEqual(play?.source, "project");
});

void test("external pid and log files must be absolute paths", () => {
  assert.deepEqual(LocalEdgeKit_validateSupervisedApps([externalApp]), []);
  assert.match(LocalEdgeKit_validateSupervisedApps([{ ...externalApp, pidFile: "lane.pid" }]).join("\n"), /lane: external pidFile must be an absolute path/u);
  assert.match(LocalEdgeKit_validateSupervisedApps([{ ...externalApp, logFile: "../lane.log" }]).join("\n"), /lane: external logFile must be an absolute path/u);
  assert.match(LocalEdgeKit_validateSupervisedApps([{ ...externalApp, command: "x" }]).join("\n"), /route only/u);
  // A run entry keeps its own rule: relative to cwd, enforced by the writers; validation does not add absolute paths for it.
  assert.deepEqual(LocalEdgeKit_validateSupervisedApps([runApp]), []);
});

void test("an external pid file is read through the safe read, shows the observed pid and is never written or signalled", async () => {
  const host = fakeHost({
    files: { "/srv/lane/lane.pid": "700\n" },
    processes: [{ pid: 700, group: 690, start: PS_START, command: "lane --serve" }],
  });
  const before = new Map(host.files);
  const inspection = LocalEdgeKit_inspectSupervisedApp(externalApp, host);
  assert.equal(inspection.state, "external");
  assert.equal(inspection.pid, 700);
  assert.equal(inspection.processGroup, 690);
  assert.equal(inspection.observed?.command, "lane --serve");
  assert.match(inspection.note, /pid 700 observed from the pid file; never signalled/u);
  assert.deepEqual(host.externalReads, ["/srv/lane/lane.pid"]);
  await LocalEdgeKit_supervisorUp({ apps: [externalApp], requestedIds: ["lane"], host, out });
  LocalEdgeKit_supervisorDown({ apps: [externalApp], requestedIds: ["lane"], host, out });
  assert.deepEqual(host.signals, []);
  assert.equal(host.spawned.length, 0);
  assert.deepEqual(host.files, before);
  assert.equal(host.processes.get(700)?.alive, true);
});

void test("a run entry never reads its pid file through the external read, even when the path is absolute and outside cwd", () => {
  const outside = { ...runApp, pidFile: "/elsewhere/web.pid" };
  const host = fakeHost({ files: { "/elsewhere/web.pid": "700\n" }, processes: [{ pid: 700, group: 700 }] });
  const inspection = LocalEdgeKit_inspectSupervisedApp(outside, host);
  assert.equal(inspection.state, "unverified");
  assert.deepEqual(host.externalReads, []);
});

void test("an external pid file the safe read refuses, or that names a dead pid, shows a bounded note and no pid", () => {
  const refused = fakeHost({
    readExternal: () => {
      throw Object.assign(new Error("local-edge-kit-safe-read-unsafe-mode: /srv/lane/lane.pid is writable by group or others (mode 666); use 0600"), {
        code: "local-edge-kit-safe-read-unsafe-mode",
      });
    },
  });
  const one = LocalEdgeKit_inspectSupervisedApp(externalApp, refused);
  assert.equal(one.pid, null);
  assert.match(one.note, /pid file not read \(local-edge-kit-safe-read-unsafe-mode\)/u);
  assert.ok(!one.note.includes("/srv/lane"), one.note);
  const dead = LocalEdgeKit_inspectSupervisedApp(externalApp, fakeHost({ files: { "/srv/lane/lane.pid": "900\n" } }));
  assert.equal(dead.pid, null);
  assert.match(dead.note, /pid file names pid 900, which is not running/u);
  assert.match(LocalEdgeKit_inspectSupervisedApp(externalApp, fakeHost()).note, /pid file not found/u);
  assert.match(LocalEdgeKit_inspectSupervisedApp(externalApp, fakeHost({ files: { "/srv/lane/lane.pid": "oops\n" } })).note, /pid file holds no pid/u);
  const relative = fakeHost({ files: { "lane.pid": "700\n" }, processes: [{ pid: 700, group: 700 }] });
  const rel = LocalEdgeKit_inspectSupervisedApp({ ...externalApp, pidFile: "lane.pid" }, relative);
  assert.equal(rel.pid, null);
  assert.deepEqual(relative.externalReads, []);
});

void test("the real host reads an external file only through the safe read: private files read, missing is null, a symlink and a group-writable file are refused", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "kit-external-")));
  chmodSync(dir, 0o700);
  const host = LocalEdgeKit_createSupervisorHost();
  const pidFile = path.join(dir, "lane.pid");
  writeFileSync(pidFile, "700\n", { mode: 0o600 });
  assert.equal(host.readExternalText(pidFile), "700\n");
  assert.equal(host.readExternalText(path.join(dir, "missing.pid")), null);
  const link = path.join(dir, "link.pid");
  symlinkSync(pidFile, link);
  assert.throws(() => host.readExternalText(link), { code: "local-edge-kit-safe-read-symlink" });
  const open = path.join(dir, "open.pid");
  writeFileSync(open, "700\n", { mode: 0o666 });
  chmodSync(open, 0o666);
  assert.throws(() => host.readExternalText(open), { code: "local-edge-kit-safe-read-unsafe-mode" });
  const big = path.join(dir, "big.log");
  writeFileSync(big, "x".repeat(2048), { mode: 0o600 });
  assert.throws(() => host.readExternalText(big, { maxBytes: 1024 }), { code: "local-edge-kit-safe-read-too-large" });
  assert.equal(readFileSync(pidFile, "utf8"), "700\n");
});

void test("status --json carries kind, processGroup, commandLine, cwd, envFile, envFilePresent, since and restarts for every kind", async () => {
  const run: LocalEdgeKit_SupervisedApp = { ...runApp, envFile: ".env.local" };
  const host = fakeHost({
    files: {
      "/w/web/.local/web.pid": `300\n${JSON.stringify({ uid: 501, startedAt: PS_START, command: "node web.js --port 3210" })}\n`,
      "/srv/lane/lane.pid": "700\n",
    },
    processes: [
      { pid: 300, group: 300, port: 3210, start: PS_START, command: "node web.js --port 3210" },
      { pid: 700, group: 690, start: PS_START, command: "lane --serve" },
    ],
    absentPaths: ["/w/web/.env.local"],
  });
  const { rows } = await statusJson(configOf(run, externalApp, checkApp), host);
  const since = new Date(2026, 10, 12, 3, 47, 37).toISOString();
  const web = rows.find((r) => r.id === "web");
  assert.equal(web?.kind, "run");
  assert.equal(web?.state, "running");
  assert.equal(web?.processGroup, 300);
  assert.equal(web?.commandLine, "node web.js --port 3210");
  assert.equal(web?.cwd, "/w/web");
  assert.equal(web?.envFile, ".env.local");
  assert.equal(web?.envFilePresent, false);
  assert.equal(web?.since, since);
  assert.equal(web?.restarts, 0);
  const lane = rows.find((r) => r.id === "lane");
  assert.deepEqual(
    [lane?.kind, lane?.state, lane?.pid, lane?.processGroup, lane?.commandLine, lane?.cwd, lane?.envFile, lane?.envFilePresent, lane?.since, lane?.restarts],
    ["external", "external", 700, 690, "lane --serve", null, null, false, since, 0],
  );
  const lint = rows.find((r) => r.id === "lint");
  assert.deepEqual(
    [lint?.kind, lint?.pid, lint?.processGroup, lint?.commandLine, lint?.cwd, lint?.envFile, lint?.envFilePresent, lint?.since, lint?.restarts],
    ["check", null, null, null, "/w/web", null, false, null, 0],
  );
});

void test("the env file is reported by path and presence only: its text is never read or printed", async () => {
  const reads: string[] = [];
  const run: LocalEdgeKit_SupervisedApp = { ...runApp, envFile: ".env.local" };
  const host = fakeHost({ files: { "/w/web/.env.local": "DATABASE_URL=ENVVALUE9\n" }, onRead: (file) => reads.push(file) });
  const stdout = capture();
  await LocalEdgeKit_runSupervisorCli({ args: ["status", "--json"], config: configOf(run), host, createBackend, stdout: stdout.writer, stderr: capture().writer });
  const row = (JSON.parse(stdout.text()) as { apps: Record<string, unknown>[] }).apps[0];
  assert.equal(row?.envFile, ".env.local");
  assert.equal(row?.envFilePresent, true);
  assert.ok(!stdout.text().includes("ENVVALUE9"));
  assert.ok(!reads.includes("/w/web/.env.local"), reads.join(","));
});

void test("since comes from the observed start time and is null when the time is not a date", () => {
  const host = fakeHost({ processes: [{ pid: 700, group: 700, start: PS_START, command: "lane" }, { pid: 701, group: 701 }], files: { "/srv/a.pid": "700\n", "/srv/b.pid": "701\n" } });
  const a = { ...externalApp, pidFile: "/srv/a.pid" };
  const b = { ...externalApp, pidFile: "/srv/b.pid" };
  assert.equal(LocalEdgeKit_supervisedAppStatusFields(a, LocalEdgeKit_inspectSupervisedApp(a, host), host).since, new Date(2026, 10, 12, 3, 47, 37).toISOString());
  assert.equal(LocalEdgeKit_supervisedAppStatusFields(b, LocalEdgeKit_inspectSupervisedApp(b, host), host).since, null);
  for (const start of ["Thu Feb 31 03:47:37 2026", "Thu Nov 12 03:47:37", "start-701", "Thu Foo 12 03:47:37 2026"]) {
    const odd = fakeHost({ processes: [{ pid: 702, group: 702, start, command: "lane" }], files: { "/srv/c.pid": "702\n" } });
    const c = { ...externalApp, pidFile: "/srv/c.pid" };
    assert.equal(LocalEdgeKit_supervisedAppStatusFields(c, LocalEdgeKit_inspectSupervisedApp(c, odd), odd).since, null, start);
  }
});

void test("restarts is 0 from the inspection counter, and shows whatever the runner sets there", () => {
  const host = fakeHost();
  const inspection = LocalEdgeKit_inspectSupervisedApp(runApp, host);
  assert.equal(inspection.restarts, 0);
  assert.equal(LocalEdgeKit_supervisedAppStatusFields(runApp, inspection, host).restarts, 0);
  assert.equal(LocalEdgeKit_supervisedAppStatusFields(runApp, { ...inspection, restarts: 3 }, host).restarts, 3);
});

void test("commandLine is bounded: control characters removed and at most 200 characters", () => {
  assert.equal(LocalEdgeKit_boundedCommandLine("node\u001b[0m a\tb\nc\u0000\u007f\u009fd"), "node[0m abcd");
  const long = LocalEdgeKit_boundedCommandLine(`node ${"x".repeat(500)}`);
  assert.equal([...long].length, 200);
  assert.ok(long.endsWith("…"));
  assert.equal(LocalEdgeKit_boundedCommandLine("y".repeat(200)), "y".repeat(200));
  assert.equal([...LocalEdgeKit_boundedCommandLine("😀".repeat(300))].length, 200);
  const host = fakeHost({ files: { "/srv/lane/lane.pid": "700\n" }, processes: [{ pid: 700, group: 700, command: `lane \u001b[31m${"z".repeat(400)}\n` }] });
  const fields = LocalEdgeKit_supervisedAppStatusFields(externalApp, LocalEdgeKit_inspectSupervisedApp(externalApp, host), host);
  assert.equal(fields.commandLine?.length, 200);
  assert.ok(!/[\u0000-\u001f]/u.test(fields.commandLine ?? ""));
});

void test("the table shows the short fields; command line, cwd and env file are only in --json", async () => {
  const run: LocalEdgeKit_SupervisedApp = { ...runApp, envFile: ".env.local" };
  const host = fakeHost({
    files: { "/w/web/.local/web.pid": `300\n${JSON.stringify({ uid: 501, startedAt: PS_START, command: "node web.js --port 3210" })}\n` },
    processes: [{ pid: 300, group: 300, port: 3210, start: PS_START, command: "node web.js --port 3210" }],
  });
  const stdout = capture();
  await LocalEdgeKit_runSupervisorCli({ args: ["status"], config: configOf(run), host, createBackend, stdout: stdout.writer, stderr: capture().writer });
  const text = stdout.text();
  assert.match(text, /EDGE-STATE\s+KIND\s+PGID\s+SINCE\s+RESTARTS\s+SOURCE\s+NOTE/u);
  assert.match(text, new RegExp(`web\\s+running\\s+300\\s+127\\.0\\.0\\.1:3210\\s+.*\\srun\\s+300\\s+${new Date(2026, 10, 12, 3, 47, 37).toISOString().replace(/\./gu, "\\.")}\\s+0\\s+project`, "u"));
  for (const long of ["web.js", "/w/web", ".env.local", "commandLine", "envFile"]) {
    assert.ok(!text.includes(long), `${long} must stay out of the table:\n${text}`);
  }
});

void test("logs reads an external log through the safe read, shows the last lines, and does not follow", async () => {
  const host = fakeHost({ files: { "/srv/lane/lane.log": "one\ntwo\nthree\nfour\n" } });
  const stdout = capture();
  const code = await LocalEdgeKit_runSupervisorCli({ args: ["logs", "lane", "-n", "2"], config: configOf(externalApp), host, stdout: stdout.writer, stderr: capture().writer });
  assert.equal(code, 0);
  assert.equal(stdout.text(), "three\nfour\n");
  assert.deepEqual(host.externalReads, ["/srv/lane/lane.log"]);
  const stderr = capture();
  const follow = await LocalEdgeKit_runSupervisorCli({
    args: ["logs", "lane", "-f"],
    config: configOf(externalApp),
    host,
    followLog: () => Promise.reject(new Error("must not follow an external log")),
    stdout: capture().writer,
    stderr: stderr.writer,
  });
  assert.equal(follow, 2);
  assert.match(stderr.text(), /lane is external: its log is read, not followed/u);
  const missing = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["logs", "lane"], config: configOf(externalApp), host: fakeHost(), stdout: capture().writer, stderr: missing.writer }), 1);
  assert.match(missing.text(), /log file not found/u);
  const none = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["logs", "lane"], config: configOf({ ...externalApp, logFile: undefined }), host, stdout: capture().writer, stderr: none.writer }), 2);
  assert.match(none.text(), /has no log file/u);
});
