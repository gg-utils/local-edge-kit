/**
 * @fileoverview Verifies the catalog kinds (`run`, `external`, `check`) and the read-only status
 * fields: kind resolution and its named errors, per-kind validation, `up` and `down` skipping
 * `external` and `check` entries, external pid and log files that are only read (through the
 * safe-read helper: world-writable folder, FIFO, directory, symlinked parent, the 8 MiB log cap,
 * and no process-environment lookup for an observed pid), and the new `status` columns and
 * `--json` fields. Every host effect is a stub: nothing is spawned, signalled or fetched, and no
 * address is contacted. The real-host tests use private temporary folders only.
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor-kinds.unit.test.ts
 *
 * @see src/supervisor.ts - Kind resolution, validation, inspection and status fields.
 * @see src/supervisor-cli.ts - The `status`, `health` and `logs` commands.
 * @documentation reviewed=2026-11-13 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  LocalEdgeKit_isLoopbackProbePath,
  LocalEdgeKit_loopbackProbeUrl,
  LocalEdgeKit_probeSupervisedAppHealth,
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

/** Probe paths that are not plain loopback paths. Each carries a marker so an echo in a message is found. */
const BAD_PROBE_PATHS: readonly string[] = [
  "@PATHMARK1.example/x", // user-info form: starts without `/`
  "PATHMARK2.example/x", // no leading slash
  "http://PATHMARK3.example/x", // a scheme
  "https:PATHMARK4", // a scheme without slashes
  "//PATHMARK5.example/x", // protocol-relative host
  "//PATHMARK18.example:3100/x", // another host on the app's own port
  "/@PATHMARK6.example/x", // `@` after the slash
  "/x/PATHMARK7@example/y",
  "/\\PATHMARK8.example", // backslash right after the slash
  "/a\\PATHMARK9",
  "\\PATHMARK10.example\\x", // starts with a backslash
  "/a\tPATHMARK11", // tab
  "/a\nPATHMARK12", // newline
  "/a\rPATHMARK13", // carriage return
  "/a\u0000PATHMARK14", // NUL
  "/a\u001bPATHMARK15", // escape
  "/a\u007fPATHMARK16", // DEL
  "/a\u0085PATHMARK17", // C1 control
  "",
];

/** Probe paths that stay valid, including query text and punctuation. */
const GOOD_PROBE_PATHS: readonly string[] = ["/", "/healthz", "/api/v1/ready", "/health?full=1", "/a:b", "/a/./b", "/a%2Fb", "/health#top"];

void test("healthPath and readyPath each refuse a path that is not a plain loopback path, with a named error that never repeats the value", () => {
  for (const field of ["healthPath", "readyPath"] as const) {
    for (const bad of BAD_PROBE_PATHS) {
      if (field === "readyPath" && bad === "") {
        continue; // an empty readyPath counts as not set, as the probe treats it
      }
      const problems = LocalEdgeKit_validateSupervisedApps([{ ...runApp, [field]: bad }]);
      const text = problems.join("\n");
      assert.equal(problems.length, 1, `${field} ${JSON.stringify(bad)}: ${text}`);
      assert.match(text, new RegExp(`^(local-edge-kit-probe-path-invalid: web: ${field} must be a plain path on loopback|web: ${field} must start with /)`, "u"), `${field} ${JSON.stringify(bad)}`);
      assert.ok(!/PATHMARK/u.test(text), `${field} ${JSON.stringify(bad)} was repeated: ${text}`);
    }
    for (const good of GOOD_PROBE_PATHS) {
      assert.deepEqual(LocalEdgeKit_validateSupervisedApps([{ ...runApp, [field]: good }]), [], `${field} ${good}`);
    }
  }
  // A path that starts with `/` but has the wrong shape gets the named error; one without `/` keeps the old message.
  assert.match(LocalEdgeKit_validateSupervisedApps([{ ...runApp, readyPath: "//PATHMARK5.example/x" }])[0] ?? "", /^local-edge-kit-probe-path-invalid: web: readyPath /u);
  assert.match(LocalEdgeKit_validateSupervisedApps([{ ...runApp, readyPath: "@PATHMARK1.example/x" }])[0] ?? "", /^web: readyPath must start with \//u);
  assert.match(LocalEdgeKit_validateSupervisedApps([{ ...runApp, healthPath: "/@PATHMARK6.example/x" }])[0] ?? "", /^local-edge-kit-probe-path-invalid: web: healthPath /u);
});

void test("an unset or empty readyPath is accepted, and a bad one is refused on an external entry and a disabled entry too", () => {
  assert.deepEqual(LocalEdgeKit_validateSupervisedApps([{ ...runApp, readyPath: undefined }, { ...externalApp, readyPath: "" }]), []);
  assert.equal(LocalEdgeKit_validateSupervisedApps([{ ...externalApp, readyPath: "@PATHMARK1.example/x" }]).length, 1);
  assert.equal(LocalEdgeKit_validateSupervisedApps([{ ...runApp, enabled: false, readyPath: "//PATHMARK5.example/x" }]).length, 1);
});

void test("the path shape check: one leading slash and no at sign, backslash or control character", () => {
  for (const good of GOOD_PROBE_PATHS) {
    assert.equal(LocalEdgeKit_isLoopbackProbePath(good), true, good);
  }
  for (const bad of BAD_PROBE_PATHS) {
    assert.equal(LocalEdgeKit_isLoopbackProbePath(bad), false, JSON.stringify(bad));
  }
});

void test("the probe URL is built with the URL parser and refused unless the host is exactly 127.0.0.1 and the port is the app's", () => {
  assert.equal(LocalEdgeKit_loopbackProbeUrl(3100, "/"), "http://127.0.0.1:3100/");
  assert.equal(LocalEdgeKit_loopbackProbeUrl(3100, "/healthz?full=1"), "http://127.0.0.1:3100/healthz?full=1");
  assert.equal(LocalEdgeKit_loopbackProbeUrl(80, "/x"), "http://127.0.0.1/x", "port 80 is the scheme default");
  for (const off of [
    "http://PATHMARK3.example/x", // an absolute URL replaces the base
    "https://127.0.0.1:3100/x", // another scheme
    "//PATHMARK5.example/x", // protocol-relative
    "//127.0.0.1:9999/x", // the loopback host but another port
    "//127.0.0.2:3100/x", // another loopback address
    "//localhost:3100/x", // another name for it
    "//PATHMARK18.example:3100/x", // another host with the app's own port
    "//user@127.0.0.1:3100/x", // user-info
    "//user:pass@127.0.0.1:3100/x",
    "\\\\PATHMARK8.example\\x", // backslashes are slashes for http
    "http:\\\\PATHMARK8.example\\x",
    "HTTP://PATHMARK3.example/x",
    "http://[::1]:3100/x",
  ]) {
    assert.equal(LocalEdgeKit_loopbackProbeUrl(3100, off), null, JSON.stringify(off));
  }
  // A relative form that has no host to change stays under the loopback origin.
  assert.equal(LocalEdgeKit_loopbackProbeUrl(3100, "@PATHMARK1.example/x"), "http://127.0.0.1:3100/@PATHMARK1.example/x");
});

void test("the probe never fetches off loopback: a bad healthPath or readyPath is refused without a request and counts as failed", async () => {
  for (const field of ["healthPath", "readyPath"] as const) {
    for (const bad of BAD_PROBE_PATHS) {
      const urls: string[] = [];
      const host = fakeHost({ healthy: (url) => (urls.push(url), 200) });
      const app = { ...externalApp, healthPath: "/", readyPath: undefined, [field]: bad } as LocalEdgeKit_SupervisedApp;
      const result = await LocalEdgeKit_probeSupervisedAppHealth(app, host);
      for (const url of urls) {
        const parsed = new URL(url);
        assert.equal(`${parsed.protocol}//${parsed.username}${parsed.password}${parsed.hostname}:${parsed.port}`, "http://127.0.0.1:3100", `${field} ${JSON.stringify(bad)} fetched ${url}`);
      }
      // The fake host answers 200 to everything it is asked, so a null status is a refusal: its path is not repeated.
      for (const check of result.checks.filter((item) => item.status === null)) {
        assert.ok(!check.path.includes("PATHMARK"), `${field} ${JSON.stringify(bad)} was repeated: ${JSON.stringify(result)}`);
      }
    }
  }
  const urls: string[] = [];
  const host = fakeHost({ healthy: (url) => (urls.push(url), 200) });
  const refused = await LocalEdgeKit_probeSupervisedAppHealth({ ...externalApp, readyPath: "//PATHMARK5.example/x" }, host);
  assert.deepEqual(urls, ["http://127.0.0.1:3100/"], "only the health path was fetched");
  assert.equal(refused.healthy, false);
  assert.deepEqual(refused.checks, [{ path: "/", status: 200, ok: true }, { path: "<21 characters>", status: null, ok: false }]);
  const hostRefused = await LocalEdgeKit_probeSupervisedAppHealth({ ...externalApp, healthPath: "http://PATHMARK3.example/x" }, host);
  assert.equal(hostRefused.healthy, false);
  assert.equal(urls.length, 1, "no further request");
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

/** A fresh private folder under the real temp folder, removed by the caller's `finally`. */
function privateDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  chmodSync(dir, 0o700);
  return dir;
}

/** The real host's safe external read on a stub host, so a status or logs run reads real temp files. */
function hostReadingRealFiles() {
  const real = LocalEdgeKit_createSupervisorHost();
  return Object.assign(fakeHost(), { readExternalText: (filePath: string, options?: { maxBytes?: number | undefined }) => real.readExternalText(filePath, options) });
}

void test("the real host refuses an external file in a world-writable folder, even with the sticky bit", () => {
  const dir = privateDir("kit-ext-ww-");
  try {
    const host = LocalEdgeKit_createSupervisorHost();
    const file = path.join(dir, "lane.pid");
    writeFileSync(file, "700\n", { mode: 0o600 });
    assert.equal(host.readExternalText(file), "700\n");
    for (const mode of [0o777, 0o1777, 0o770]) {
      chmodSync(dir, mode);
      assert.throws(() => host.readExternalText(file), { code: "local-edge-kit-safe-read-unsafe-mode" }, `folder mode ${mode.toString(8)}`);
    }
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("the real host refuses an external pid path that is a FIFO or a directory, without blocking", { skip: process.platform === "win32" }, () => {
  const dir = privateDir("kit-ext-kind-");
  try {
    const host = LocalEdgeKit_createSupervisorHost();
    const fifo = path.join(dir, "fifo.pid");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    assert.throws(() => host.readExternalText(fifo), { code: "local-edge-kit-safe-read-not-file" });
    const folder = path.join(dir, "folder.pid");
    mkdirSync(folder, { mode: 0o700 });
    assert.throws(() => host.readExternalText(folder), { code: "local-edge-kit-safe-read-not-file" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("the real host refuses an external file below a symlinked parent folder, at any level of the path", () => {
  const dir = privateDir("kit-ext-link-");
  try {
    const host = LocalEdgeKit_createSupervisorHost();
    const real = path.join(dir, "real");
    mkdirSync(path.join(real, "sub"), { recursive: true, mode: 0o700 });
    chmodSync(real, 0o700);
    chmodSync(path.join(real, "sub"), 0o700);
    writeFileSync(path.join(real, "lane.pid"), "700\n", { mode: 0o600 });
    writeFileSync(path.join(real, "sub", "lane.pid"), "701\n", { mode: 0o600 });
    assert.equal(host.readExternalText(path.join(real, "lane.pid")), "700\n");
    assert.equal(host.readExternalText(path.join(real, "sub", "lane.pid")), "701\n");
    const link = path.join(dir, "link");
    symlinkSync(real, link);
    const refused = { code: "local-edge-kit-safe-read-symlinked-parent" };
    assert.throws(() => host.readExternalText(path.join(link, "lane.pid")), refused, "the parent folder is a symlink");
    assert.throws(() => host.readExternalText(path.join(link, "sub", "lane.pid")), refused, "a folder above the parent is a symlink");
    const top = path.join(dir, "top");
    symlinkSync(dir, top);
    assert.throws(() => host.readExternalText(path.join(top, "real", "sub", "lane.pid")), refused, "a folder far above the parent is a symlink");
    assert.throws(() => host.readExternalText(path.join(link, "missing", "lane.pid")), refused, "a symlink is refused before a missing folder is noticed");
    assert.equal(host.readExternalText(path.join(real, "missing", "lane.pid")), null, "a missing folder on a real path is not found");
    // Status shows the refusal code and no pid, and never the path.
    const app: LocalEdgeKit_SupervisedApp = { ...externalApp, pidFile: path.join(link, "lane.pid") };
    const inspection = LocalEdgeKit_inspectSupervisedApp(app, hostReadingRealFiles());
    assert.equal(inspection.pid, null);
    assert.match(inspection.note, /pid file not read \(local-edge-kit-safe-read-symlinked-parent\)/u);
    assert.ok(!inspection.note.includes(dir), inspection.note);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("logs reads an external log of exactly 8 MiB and refuses one byte more", async () => {
  const dir = privateDir("kit-ext-cap-");
  try {
    const cap = 8 * 1024 * 1024;
    const logFile = path.join(dir, "lane.log");
    const app: LocalEdgeKit_SupervisedApp = { ...externalApp, logFile };
    const run = async () => {
      const stdout = capture();
      const stderr = capture();
      const code = await LocalEdgeKit_runSupervisorCli({ args: ["logs", "lane", "-n", "1"], config: configOf(app), host: hostReadingRealFiles(), stdout: stdout.writer, stderr: stderr.writer });
      return { code, stdout: stdout.text(), stderr: stderr.text() };
    };
    writeFileSync(logFile, Buffer.alloc(cap, "abcd\n"), { mode: 0o600 });
    const atCap = await run();
    assert.equal(atCap.code, 0, atCap.stderr);
    assert.ok(atCap.stdout.length > 0);
    writeFileSync(logFile, Buffer.alloc(cap + 1, "abcd\n"), { mode: 0o600 });
    const over = await run();
    assert.equal(over.code, 2);
    assert.match(over.stderr, /local-edge-kit-safe-read-too-large/u);
    assert.equal(over.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("an observed external pid is read without its process environment: no launch id is asked for", () => {
  const external = fakeHost({
    files: { "/srv/lane/lane.pid": "700\n" },
    processes: [{ pid: 700, group: 690, start: PS_START, command: "lane --serve", launchId: "a".repeat(32) }],
  });
  const seen = LocalEdgeKit_inspectSupervisedApp(externalApp, external);
  assert.deepEqual(external.identityReads, [{ pid: 700, readLaunchId: false }]);
  assert.equal(seen.observed?.command, "lane --serve");
  // Control: a run entry's pid keeps the launch-id check, which does read the environment.
  const run = fakeHost({
    files: { "/w/web/.local/web.pid": "300\n" },
    processes: [{ pid: 300, group: 300, port: 3210, start: PS_START, command: "node web.js" }],
  });
  LocalEdgeKit_inspectSupervisedApp(runApp, run);
  assert.deepEqual(run.identityReads, [{ pid: 300, readLaunchId: true }]);
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

/**
 * The `since` of an external entry whose pid file names a process with the given start text.
 *
 * @param start - The start time text as the process list would print it.
 * @returns The ISO UTC time the status row shows, or null when the text is not accepted.
 */
function sinceOfStart(start: string): string | null {
  const host = fakeHost({ processes: [{ pid: 703, group: 703, start, command: "lane" }], files: { "/srv/d.pid": "703\n" } });
  const app = { ...externalApp, pidFile: "/srv/d.pid" };
  return LocalEdgeKit_supervisedAppStatusFields(app, LocalEdgeKit_inspectSupervisedApp(app, host), host).since;
}

void test("since accepts a single-digit day as ps pads it (two spaces), with one space, and a two-digit day", () => {
  assert.equal(sinceOfStart("Fri Nov  6 08:01:02 2026"), new Date(2026, 10, 6, 8, 1, 2).toISOString());
  assert.equal(sinceOfStart("Fri Nov 6 08:01:02 2026"), new Date(2026, 10, 6, 8, 1, 2).toISOString());
  assert.equal(sinceOfStart("Sun Nov  1 00:00:00 2026"), new Date(2026, 10, 1, 0, 0, 0).toISOString());
  assert.equal(sinceOfStart("Thu Nov 12 03:47:37 2026"), new Date(2026, 10, 12, 3, 47, 37).toISOString());
  assert.equal(sinceOfStart("Mon Nov 30 23:59:59 2026"), new Date(2026, 10, 30, 23, 59, 59).toISOString());
});

void test("since accepts a zero-padded day on purpose (ps never prints it, but it is an unambiguous day)", () => {
  assert.equal(sinceOfStart("Sun Nov 01 00:00:00 2026"), new Date(2026, 10, 1, 0, 0, 0).toISOString());
  assert.equal(sinceOfStart("Fri Nov 06 08:01:02 2026"), new Date(2026, 10, 6, 8, 1, 2).toISOString());
  assert.equal(sinceOfStart("Fri Nov 00 08:01:02 2026"), null, "day 00 is still not a date");
  assert.equal(sinceOfStart("Fri Nov  06 08:01:02 2026"), null, "two spaces before a two-digit day stays refused");
});

void test("since stays strict: wrong spacing, a day of three digits or none, a missing part or an impossible date is null", () => {
  for (const start of [
    "Thu Nov  12 03:47:37 2026", // two spaces before a two-digit day
    "Fri Nov   6 08:01:02 2026", // three spaces
    "Fri Nov 123 08:01:02 2026",
    "Fri Nov  0 08:01:02 2026", // day 0 is not a date
    "Fri Nov  32 08:01:02 2026",
    "Fri Feb 30 08:01:02 2026",
    "Fri Nov  6 08:01 2026",
    "Fri Nov   08:01:02 2026",
    "Fri Nov  6 08:01:02 26",
    " Fri Nov  6 08:01:02 2026",
    "Fri Nov  6 08:01:02 2026 ",
    "",
  ]) {
    assert.equal(sinceOfStart(start), null, JSON.stringify(start));
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

void test("commandLine drops bidirectional and other format characters, one class at a time", () => {
  const classes: Record<string, string[]> = {
    "C0 controls": ["\u0000", "\u0007", "\u001b", "\u001f"],
    "DEL and C1 controls": ["\u007f", "\u0085", "\u009f"],
    "bidi embeddings and overrides U+202A-U+202E": ["‪", "‫", "‬", "‭", "‮"],
    "bidi isolates U+2066-U+2069": ["⁦", "⁧", "⁨", "⁩"],
    "line and paragraph separators U+2028, U+2029": [" ", " "],
    "zero-width and direction marks U+200B-U+200F": ["​", "‌", "‍", "‎", "‏"],
    "byte order mark U+FEFF": ["﻿"],
    "other Cf: soft hyphen, Arabic letter mark, word joiner, tag character": ["­", "؜", "⁠", "\u{e0041}"],
  };
  for (const [name, characters] of Object.entries(classes)) {
    for (const character of characters) {
      const code = character.codePointAt(0)?.toString(16);
      assert.equal(LocalEdgeKit_boundedCommandLine(`node a${character}b`), "node ab", `${name}: U+${code ?? "?"} must be removed`);
    }
  }
  // The classic spoof: a right-to-left override reorders what the terminal shows.
  assert.equal(LocalEdgeKit_boundedCommandLine("run ‮gpj.exe"), "run gpj.exe");
  // Ordinary text, including non-ASCII letters, is kept.
  assert.equal(LocalEdgeKit_boundedCommandLine("node café 日本語 😀"), "node café 日本語 😀");
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

void test("status probes an external entry with a port and a health path like a run entry: healthy shows ok, in the table and in --json", async () => {
  const urls: string[] = [];
  const host = fakeHost({ healthy: (url) => (urls.push(url), 204) });
  const table = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["status"], config: configOf(externalApp), host, createBackend, stdout: table.writer, stderr: capture().writer }), 0);
  assert.match(table.text(), /lane\s+external\s+-\s+127\.0\.0\.1:3100\s+ok\s/u);
  const { rows } = await statusJson(configOf(externalApp), host);
  assert.equal(rows[0]?.healthy, true);
  assert.equal(rows[0]?.healthStatus, "ok");
  assert.deepEqual(rows[0]?.health, [{ path: "/", status: 204, ok: true }]);
  assert.deepEqual([...new Set(urls)], ["http://127.0.0.1:3100/"]);
  assert.equal(host.spawned.length, 0);
  assert.equal(host.signals.length, 0);
});

void test("status shows an unhealthy external entry as fail, in the table and in --json, and its exit code stays 0", async () => {
  const host = fakeHost({ healthy: () => 503 });
  const table = capture();
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["status"], config: configOf(externalApp), host, createBackend, stdout: table.writer, stderr: capture().writer }), 0);
  assert.match(table.text(), /lane\s+external\s+-\s+127\.0\.0\.1:3100\s+fail\s/u);
  const { code, rows } = await statusJson(configOf(externalApp), host);
  assert.equal(code, 0);
  assert.equal(rows[0]?.healthy, false);
  assert.equal(rows[0]?.healthStatus, "fail");
  assert.deepEqual(rows[0]?.health, [{ path: "/", status: 503, ok: false }]);
  const silent = fakeHost({ healthy: () => null });
  assert.equal((await statusJson(configOf(externalApp), silent)).rows[0]?.healthStatus, "fail");
});

void test("a run entry that is unhealthy still makes status exit 1, next to an external row", async () => {
  const host = fakeHost({
    files: { "/w/web/.local/web.pid": `300\n${JSON.stringify({ uid: 501, startedAt: PS_START, command: "node web.js" })}\n` },
    processes: [{ pid: 300, group: 300, port: 3210, start: PS_START, command: "node web.js" }],
    healthy: () => 503,
  });
  assert.equal(await LocalEdgeKit_runSupervisorCli({ args: ["status"], config: configOf(runApp, externalApp), host, createBackend, stdout: capture().writer, stderr: capture().writer }), 1);
});

void test("status does not probe a disabled external entry or a check entry; an external entry without a health path is refused as invalid config", async () => {
  const urls: string[] = [];
  const host = fakeHost({ healthy: (url) => (urls.push(url), 200) });
  const disabled = { ...externalApp, id: "off", enabled: false };
  const { rows } = await statusJson(configOf(disabled, checkApp), host);
  assert.equal(rows.find((r) => r.id === "off")?.state, "disabled");
  assert.equal(rows.find((r) => r.id === "off")?.healthStatus, null);
  assert.equal(rows.find((r) => r.id === "lint")?.healthStatus, "not run");
  const table = capture();
  await LocalEdgeKit_runSupervisorCli({ args: ["status"], config: configOf(disabled, checkApp), host, createBackend, stdout: table.writer, stderr: capture().writer });
  assert.match(table.text(), /off\s+disabled\s+-\s+127\.0\.0\.1:3100\s+-\s/u);
  assert.match(table.text(), /lint\s+check\s+-\s+-\s+not run\s/u);
  const bare = { ...externalApp, id: "bare", healthPath: undefined };
  const stderr = capture();
  const code = await LocalEdgeKit_runSupervisorCli({ args: ["status"], config: configOf(bare), host, createBackend, stdout: capture().writer, stderr: stderr.writer });
  assert.equal(code, 2);
  assert.match(stderr.text(), /bare: healthPath must start with \//u);
  assert.deepEqual(urls, []);
});
