/**
 * @fileoverview Generic app supervisor: start, stop, adopt, status, health and logs for a set of
 * loopback apps described by a project-owned config, each with a pid file and a log file.
 *
 * The supervisor never assumes it started a process. An app counts as running when its pid file
 * names a live process and the app's loopback port is held by a process in the same process
 * group, so processes started by someone else are adopted instead of started twice. A port held
 * by anything else is reported as busy and never killed. Stop signals the app's process group
 * (SIGTERM, then SIGKILL after a timeout) through the core runtime-stop helper.
 * Env checks read names only: values are never returned or printed. Launch env values go to the
 * started process only; output lists their names. External apps are route only: never started,
 * stopped or signalled. Pid files are written atomically and log files opened without following
 * symlinks, both inside the app's cwd.
 * Flow: config -> validate + dependency order -> inspect (pid file + port) -> start/stop/health.
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor.unit.test.ts
 *
 * @see src/supervisor-cli.ts - Command dispatcher that wires this module to an exposure backend.
 * @see src/runtime-launch.ts - Log tail helper reused for `logs`.
 * @documentation reviewed=2026-11-11 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { LocalEdgeCore_isHealthyHttpStatusCode } from "@gg-utils/local-edge-core/healthcheck";
import {
  LocalEdgeCore_runtimeStopParsePidLines,
  LocalEdgeCore_runtimeStopTerminatePidList,
} from "@gg-utils/local-edge-core/runtime-stop";

import { LocalEdgeKit_openAppendSafe, LocalEdgeKit_prepareSafeTarget, LocalEdgeKit_writeFileAtomic } from "./safe-write.js";

/** One supervised app. Paths may be relative to `cwd`. */
export type LocalEdgeKit_SupervisedApp = {
  id: string;
  enabled: boolean;
  /** Why a disabled app is disabled (shown in status). */
  disabledReason?: string | undefined;
  description?: string | undefined;
  /** Working directory. Required for enabled apps. */
  cwd?: string | undefined;
  /** Executable. Required for enabled apps. Spawned without a shell. */
  command?: string | undefined;
  args?: readonly string[] | undefined;
  /**
   * Route only: the supervisor never starts, stops, adopts or signals this app's process. It is
   * listed, probed for health and exposed, nothing more.
   */
  external?: boolean | undefined;
  /** Env file whose variable NAMES are checked before start. */
  envFile?: string | undefined;
  requiredEnvNames?: readonly string[] | undefined;
  /**
   * Values passed to the process at start, over the supervisor's own env. A function is called
   * only when the app is actually started. Names count as present for `requiredEnvNames`. Only
   * the names are ever printed.
   */
  launchEnv?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>) | undefined;
  localPort: number;
  /** Edge port for port-based exposure backends. */
  edgePort?: number | undefined;
  /** Host label for name-based backends. Defaults to `id`. */
  edgeName?: string | undefined;
  /** Extra path routes for name-based backends (`path` -> `127.0.0.1:<localPort><upstreamPath>`). */
  locations?: readonly { path: string; localPort: number; upstreamPath?: string | undefined }[] | undefined;
  /** Hostname pattern for this app only (name-based backends), for a host under another label. */
  hostnameTemplate?: string | undefined;
  /** HTTP path that must answer 2xx/3xx for the app to count as healthy. */
  healthPath: string;
  /** Optional second HTTP path that must answer before the app counts as ready. */
  readyPath?: string | undefined;
  /** Optional text that must appear in the log after start before the app counts as ready. */
  readyLogLine?: string | undefined;
  /** Pid file. Required for enabled apps the supervisor runs. */
  pidFile?: string | undefined;
  /** Log file the process appends to. Required for enabled apps the supervisor runs. */
  logFile?: string | undefined;
  dependsOn?: readonly string[] | undefined;
  startTimeoutMs?: number | undefined;
  stopTimeoutMs?: number | undefined;
};

/** Observed process state of one app. */
export type LocalEdgeKit_SupervisedAppState =
  | "running"
  | "starting"
  | "port-busy"
  | "stale-pid"
  | "stopped"
  | "disabled"
  | "external";

/** Inspection result for one app. */
export type LocalEdgeKit_SupervisedAppInspection = {
  appId: string;
  state: LocalEdgeKit_SupervisedAppState;
  pid: number | null;
  processGroup: number | null;
  listenerPids: readonly number[];
  note: string;
};

/** Health probe result. */
export type LocalEdgeKit_SupervisedAppHealth = {
  appId: string;
  healthy: boolean;
  checks: readonly { path: string; status: number | null; ok: boolean }[];
};

/** Host effects the supervisor needs; tests inject fakes for all of them. */
export type LocalEdgeKit_SupervisorHost = {
  readText(filePath: string): string | null;
  /** Replaces a file atomically inside `root`; refuses symlinks and paths that resolve outside. */
  writeText(filePath: string, text: string, options: { root: string; mode?: number | undefined }): void;
  /** Creates a folder (0700) inside `root`, refusing one that resolves outside. */
  ensureDir(dirPath: string, options: { root: string }): void;
  /** Runs a short command to completion. Never through a shell. */
  runCommand(command: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string };
  removeFile(filePath: string): void;
  fileSize(filePath: string): number;
  pidIsAlive(pid: number): boolean;
  processGroupOf(pid: number): number | null;
  /** Parent pid, or null when unknown. Used to tie a listener back to the pid-file process. */
  parentOf(pid: number): number | null;
  ownProcessGroup(): number | null;
  listenerPids(port: number): number[];
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  httpStatus(url: string, timeoutMs: number): Promise<number | null>;
  spawnDetached(options: {
    cwd: string;
    command: string;
    args: readonly string[];
    logFile: string;
    /** Folder the log file must stay inside. */
    logRoot: string;
    /** Values set over the supervisor's env for this process. */
    env?: Readonly<Record<string, string>> | undefined;
  }): number;
  sleep(ms: number): Promise<void>;
  sleepSync(ms: number): void;
  now(): number;
};

/** Writer used for progress lines. */
export type LocalEdgeKit_SupervisorWriter = { write(message: string): unknown };

/** Result of `up` or `down` for one app. */
export type LocalEdgeKit_SupervisorStepResult = {
  appId: string;
  ok: boolean;
  action: "started" | "adopted" | "stopped" | "already-stopped" | "skipped" | "failed";
  message: string;
};

const LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_START_TIMEOUT_MS = 60_000;
const LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_STOP_TIMEOUT_MS = 10_000;
const LOCAL_EDGE_KIT_SUPERVISOR_POLL_MS = 500;

function LocalEdgeKit_runCapture(command: string, args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  return { status: result.status, stdout: result.stdout ?? "" };
}

/** Real host effects. Spawned apps get their own process group and append to their log file. */
export function LocalEdgeKit_createSupervisorHost(): LocalEdgeKit_SupervisorHost {
  const sleepSync = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  const processGroupOf = (pid: number): number | null => {
    const result = LocalEdgeKit_runCapture("ps", ["-o", "pgid=", "-p", String(pid)]);
    const value = Number(result.stdout.trim());
    return result.status === 0 && Number.isInteger(value) && value > 0 ? value : null;
  };
  return {
    readText: (filePath) => (existsSync(filePath) ? readFileSync(filePath, "utf8") : null),
    writeText: (filePath, text, options) => LocalEdgeKit_writeFileAtomic(filePath, text, options),
    ensureDir: (dirPath, options) => {
      LocalEdgeKit_prepareSafeTarget(path.join(dirPath, ".probe"), options);
    },
    runCommand: (command, args) => {
      const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    removeFile: (filePath) => rmSync(filePath, { force: true }),
    fileSize: (filePath) => (existsSync(filePath) ? statSync(filePath).size : 0),
    pidIsAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    processGroupOf,
    parentOf: (pid) => {
      const result = LocalEdgeKit_runCapture("ps", ["-o", "ppid=", "-p", String(pid)]);
      const value = Number(result.stdout.trim());
      return result.status === 0 && Number.isInteger(value) && value > 0 ? value : null;
    },
    ownProcessGroup: () => processGroupOf(process.pid),
    listenerPids: (port) => {
      const result = LocalEdgeKit_runCapture("lsof", [`-tiTCP:${String(port)}`, "-sTCP:LISTEN"]);
      return result.status === 0 ? LocalEdgeCore_runtimeStopParsePidLines(result.stdout) : [];
    },
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    httpStatus: async (url, timeoutMs) => {
      try {
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        await response.body?.cancel();
        return response.status;
      } catch {
        return null;
      }
    },
    spawnDetached: (options) => {
      const fd = LocalEdgeKit_openAppendSafe(options.logFile, { root: options.logRoot });
      try {
        const child = spawn(options.command, [...options.args], {
          cwd: options.cwd,
          detached: true,
          env: { ...process.env, ...options.env },
          stdio: ["ignore", fd, fd],
        });
        child.unref();
        if (child.pid === undefined) {
          throw new Error(`could not spawn ${options.command}`);
        }
        return child.pid;
      } finally {
        closeSync(fd);
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    sleepSync,
    now: () => Date.now(),
  };
}

/** Resolves an app path against its cwd. */
export function LocalEdgeKit_resolveAppPath(app: LocalEdgeKit_SupervisedApp, filePath: string): string {
  return path.resolve(app.cwd ?? process.cwd(), filePath);
}

/**
 * Validates supervisor apps: unique ids, required fields on enabled apps, known dependencies,
 * enabled apps depending only on enabled apps, and no cycles. Returns problems; empty is valid.
 */
export function LocalEdgeKit_validateSupervisedApps(apps: readonly LocalEdgeKit_SupervisedApp[]): string[] {
  const problems: string[] = [];
  const byId = new Map<string, LocalEdgeKit_SupervisedApp>();
  for (const app of apps) {
    if (byId.has(app.id)) {
      problems.push(`app id "${app.id}" is listed twice`);
    }
    byId.set(app.id, app);
  }
  const ports = new Map<number, string>();
  for (const app of apps) {
    if (!app.healthPath.startsWith("/")) {
      problems.push(`${app.id}: healthPath must start with /`);
    }
    if (!app.enabled) {
      continue;
    }
    if (app.external === true) {
      if (app.command !== undefined) {
        problems.push(`${app.id}: external apps are route only and may not set command`);
      }
    } else if (!app.cwd || !app.command || !app.pidFile || !app.logFile) {
      problems.push(`${app.id}: enabled apps need cwd, command, pidFile and logFile`);
    }
    const other = ports.get(app.localPort);
    if (other !== undefined) {
      problems.push(`${app.id}: local port ${String(app.localPort)} is also used by ${other}`);
    }
    ports.set(app.localPort, app.id);
    for (const dep of app.dependsOn ?? []) {
      const target = byId.get(dep);
      if (target === undefined) {
        problems.push(`${app.id}: depends on unknown app "${dep}"`);
      } else if (!target.enabled) {
        problems.push(`${app.id}: depends on disabled app "${dep}"`);
      }
    }
  }
  try {
    LocalEdgeKit_orderSupervisedApps(apps, apps.map((app) => app.id));
  } catch (error) {
    problems.push((error as Error).message);
  }
  return problems;
}

/**
 * Returns the requested apps plus their dependencies, dependencies first.
 *
 * @throws When an id is unknown or the dependency graph has a cycle.
 */
export function LocalEdgeKit_orderSupervisedApps(
  apps: readonly LocalEdgeKit_SupervisedApp[],
  requestedIds: readonly string[],
): LocalEdgeKit_SupervisedApp[] {
  const byId = new Map(apps.map((app) => [app.id, app]));
  const ordered: LocalEdgeKit_SupervisedApp[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string, trail: readonly string[]): void => {
    if (done.has(id)) {
      return;
    }
    const app = byId.get(id);
    if (app === undefined) {
      throw new Error(`unknown app "${id}"`);
    }
    if (visiting.has(id)) {
      throw new Error(`dependency cycle: ${[...trail, id].join(" -> ")}`);
    }
    visiting.add(id);
    for (const dep of app.dependsOn ?? []) {
      if (byId.has(dep)) {
        visit(dep, [...trail, id]);
      }
    }
    visiting.delete(id);
    done.add(id);
    ordered.push(app);
  };
  for (const id of requestedIds) {
    visit(id, []);
  }
  return ordered;
}

/**
 * Lists which required env names are absent or empty in an env file. Only names are returned;
 * values are read to test emptiness and then dropped.
 */
export function LocalEdgeKit_missingEnvNames(options: {
  envText: string | null;
  requiredNames: readonly string[];
}): string[] {
  if (options.requiredNames.length === 0) {
    return [];
  }
  const present = new Set<string>();
  for (const line of (options.envText ?? "").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1]) {
      continue;
    }
    const rawValue = (match[2] ?? "").trim();
    const unquoted = rawValue.replace(/^(['"])(.*)\1$/, "$2");
    if (unquoted.length > 0 && !unquoted.startsWith("#")) {
      present.add(match[1]);
    }
  }
  return options.requiredNames.filter((name) => !present.has(name));
}

/**
 * True when `listener` belongs to the process tree started by `pid`: it is `pid`, shares its
 * process group, or has `pid` among its ancestors. Dev servers often move their server into a
 * child process group, so the group check alone is not enough.
 */
export function LocalEdgeKit_listenerBelongsTo(options: {
  listener: number;
  pid: number;
  processGroup: number | null;
  host: LocalEdgeKit_SupervisorHost;
}): boolean {
  const { listener, pid, processGroup, host } = options;
  if (listener === pid || (processGroup !== null && host.processGroupOf(listener) === processGroup)) {
    return true;
  }
  let current: number | null = listener;
  for (let depth = 0; depth < 32 && current !== null && current > 1; depth += 1) {
    current = host.parentOf(current);
    if (current === pid) {
      return true;
    }
  }
  return false;
}

/** Reads a pid file and returns a positive integer pid, or null. */
export function LocalEdgeKit_readPidFile(host: LocalEdgeKit_SupervisorHost, filePath: string): number | null {
  const text = host.readText(filePath);
  if (text === null) {
    return null;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Inspects one app by pid file plus port check. Read-only. */
export function LocalEdgeKit_inspectSupervisedApp(
  app: LocalEdgeKit_SupervisedApp,
  host: LocalEdgeKit_SupervisorHost,
): LocalEdgeKit_SupervisedAppInspection {
  const listenerPids = host.listenerPids(app.localPort);
  const base = { appId: app.id, listenerPids };
  if (!app.enabled) {
    const busy = listenerPids.length > 0 ? `; port ${String(app.localPort)} is in use` : "";
    return { ...base, state: "disabled", pid: null, processGroup: null, note: `${app.disabledReason ?? "disabled"}${busy}` };
  }
  if (app.external === true) {
    const listening = listenerPids.length > 0;
    return {
      ...base,
      state: "external",
      pid: null,
      processGroup: null,
      note: `route only; port ${listening ? "listening" : "not listening"}`,
    };
  }
  const pid = app.pidFile ? LocalEdgeKit_readPidFile(host, LocalEdgeKit_resolveAppPath(app, app.pidFile)) : null;
  const alive = pid !== null && host.pidIsAlive(pid);
  const processGroup = alive ? host.processGroupOf(pid) : null;
  if (alive) {
    if (listenerPids.length === 0) {
      return { ...base, state: "starting", pid, processGroup, note: "process alive, port not listening yet" };
    }
    const owned = listenerPids.some((listener) =>
      LocalEdgeKit_listenerBelongsTo({ listener, pid, processGroup, host }),
    );
    if (owned) {
      return { ...base, state: "running", pid, processGroup, note: "pid file process holds the port" };
    }
    return { ...base, state: "port-busy", pid, processGroup, note: `port held by another process (${listenerPids.join(",")})` };
  }
  if (listenerPids.length > 0) {
    return { ...base, state: "port-busy", pid, processGroup: null, note: `no live pid file process; port held by ${listenerPids.join(",")}` };
  }
  if (pid !== null) {
    return { ...base, state: "stale-pid", pid, processGroup: null, note: "pid file names a dead process" };
  }
  return { ...base, state: "stopped", pid: null, processGroup: null, note: "not running" };
}

/** Probes an app's health path (and ready path, when set) on loopback. */
export async function LocalEdgeKit_probeSupervisedAppHealth(
  app: LocalEdgeKit_SupervisedApp,
  host: LocalEdgeKit_SupervisorHost,
  timeoutMs = 3000,
): Promise<LocalEdgeKit_SupervisedAppHealth> {
  const paths = [app.healthPath, ...(app.readyPath ? [app.readyPath] : [])];
  const checks = await Promise.all(
    paths.map(async (probePath) => {
      const status = await host.httpStatus(`http://127.0.0.1:${String(app.localPort)}${probePath}`, timeoutMs);
      return { path: probePath, status, ok: LocalEdgeCore_isHealthyHttpStatusCode(status) };
    }),
  );
  return { appId: app.id, healthy: checks.every((check) => check.ok), checks };
}

function LocalEdgeKit_logContainsSince(
  app: LocalEdgeKit_SupervisedApp,
  host: LocalEdgeKit_SupervisorHost,
  offset: number,
): boolean {
  if (!app.readyLogLine || !app.logFile) {
    return true;
  }
  const text = host.readText(LocalEdgeKit_resolveAppPath(app, app.logFile)) ?? "";
  return text.slice(offset).includes(app.readyLogLine);
}

/** Waits until the app is healthy (and its ready log line appeared after `logOffset`). */
export async function LocalEdgeKit_waitForSupervisedAppReady(options: {
  app: LocalEdgeKit_SupervisedApp;
  host: LocalEdgeKit_SupervisorHost;
  logOffset: number;
  timeoutMs: number;
  pid?: number | undefined;
}): Promise<{ ready: boolean; message: string }> {
  const { app, host } = options;
  const deadline = host.now() + options.timeoutMs;
  let last = "not probed";
  for (;;) {
    if (options.pid !== undefined && !host.pidIsAlive(options.pid)) {
      return { ready: false, message: "process exited before it became ready; see logs" };
    }
    const health = await LocalEdgeKit_probeSupervisedAppHealth(app, host);
    const logReady = LocalEdgeKit_logContainsSince(app, host, options.logOffset);
    if (health.healthy && logReady) {
      return { ready: true, message: "healthy" };
    }
    last = health.checks.map((check) => `${check.path}=${String(check.status ?? "no answer")}`).join(" ");
    if (!logReady) {
      last += " (ready log line not seen)";
    }
    if (host.now() >= deadline) {
      return { ready: false, message: `not ready after ${String(options.timeoutMs)} ms: ${last}` };
    }
    await host.sleep(LOCAL_EDGE_KIT_SUPERVISOR_POLL_MS);
  }
}

/**
 * Starts the requested apps and their dependencies in order, adopting any that already run.
 * Stops at the first failure; later apps are reported as skipped.
 */
export async function LocalEdgeKit_supervisorUp(options: {
  apps: readonly LocalEdgeKit_SupervisedApp[];
  requestedIds: readonly string[];
  host: LocalEdgeKit_SupervisorHost;
  out: LocalEdgeKit_SupervisorWriter;
}): Promise<LocalEdgeKit_SupervisorStepResult[]> {
  const { host, out } = options;
  const ordered = LocalEdgeKit_orderSupervisedApps(options.apps, options.requestedIds);
  const results: LocalEdgeKit_SupervisorStepResult[] = [];
  let failed = false;
  for (const app of ordered) {
    if (failed) {
      results.push({ appId: app.id, ok: false, action: "skipped", message: "an earlier app failed" });
      continue;
    }
    if (!app.enabled) {
      results.push({ appId: app.id, ok: true, action: "skipped", message: app.disabledReason ?? "disabled" });
      continue;
    }
    if (app.external === true) {
      results.push({ appId: app.id, ok: true, action: "skipped", message: "external: route only, never started" });
      continue;
    }
    const timeoutMs = app.startTimeoutMs ?? LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_START_TIMEOUT_MS;
    const inspection = LocalEdgeKit_inspectSupervisedApp(app, host);
    if (inspection.state === "running" || inspection.state === "starting") {
      out.write(`[${app.id}] adopting pid ${String(inspection.pid)} (${inspection.state})\n`);
      const ready = await LocalEdgeKit_waitForSupervisedAppReady({ app, host, logOffset: 0, timeoutMs, pid: inspection.pid ?? undefined });
      results.push({ appId: app.id, ok: ready.ready, action: ready.ready ? "adopted" : "failed", message: ready.message });
      failed ||= !ready.ready;
      continue;
    }
    if (inspection.state === "port-busy") {
      results.push({ appId: app.id, ok: false, action: "failed", message: `refusing to start: ${inspection.note}` });
      failed = true;
      continue;
    }
    let launchEnv: Readonly<Record<string, string>>;
    try {
      launchEnv = typeof app.launchEnv === "function" ? app.launchEnv() : (app.launchEnv ?? {});
    } catch (error) {
      results.push({
        appId: app.id,
        ok: false,
        action: "failed",
        message: `launch env unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
      failed = true;
      continue;
    }
    const launchNames = Object.keys(launchEnv);
    const missing = LocalEdgeKit_missingEnvNames({
      envText: app.envFile ? host.readText(LocalEdgeKit_resolveAppPath(app, app.envFile)) : null,
      requiredNames: (app.requiredEnvNames ?? []).filter((name) => !launchNames.includes(name)),
    });
    if (missing.length > 0) {
      results.push({ appId: app.id, ok: false, action: "failed", message: `env file lacks: ${missing.join(", ")}` });
      failed = true;
      continue;
    }
    const root = app.cwd ?? process.cwd();
    const logFile = LocalEdgeKit_resolveAppPath(app, app.logFile ?? "");
    const logOffset = host.fileSize(logFile);
    if (launchNames.length > 0) {
      out.write(`[${app.id}] launch env: ${launchNames.join(", ")}\n`);
    }
    const pid = host.spawnDetached({
      cwd: root,
      command: app.command ?? "",
      args: app.args ?? [],
      logFile,
      logRoot: root,
      env: launchEnv,
    });
    host.writeText(LocalEdgeKit_resolveAppPath(app, app.pidFile ?? ""), `${String(pid)}\n`, { root });
    out.write(`[${app.id}] started pid ${String(pid)}, waiting for health\n`);
    const ready = await LocalEdgeKit_waitForSupervisedAppReady({ app, host, logOffset, timeoutMs, pid });
    results.push({ appId: app.id, ok: ready.ready, action: ready.ready ? "started" : "failed", message: ready.message });
    failed ||= !ready.ready;
  }
  return results;
}

/**
 * Stops the requested apps, dependants first. Only processes named by the app's pid file are
 * signalled; a foreign listener on the port is never touched.
 */
export function LocalEdgeKit_supervisorDown(options: {
  apps: readonly LocalEdgeKit_SupervisedApp[];
  requestedIds: readonly string[];
  host: LocalEdgeKit_SupervisorHost;
  out: LocalEdgeKit_SupervisorWriter;
}): LocalEdgeKit_SupervisorStepResult[] {
  const { host } = options;
  const requested = new Set(options.requestedIds);
  const ordered = LocalEdgeKit_orderSupervisedApps(options.apps, options.requestedIds)
    .filter((app) => requested.has(app.id))
    .reverse();
  return ordered.map((app): LocalEdgeKit_SupervisorStepResult => {
    if (!app.enabled) {
      return { appId: app.id, ok: true, action: "skipped", message: app.disabledReason ?? "disabled" };
    }
    if (app.external === true || !app.pidFile) {
      return { appId: app.id, ok: true, action: "skipped", message: "external: route only, never signalled" };
    }
    const inspection = LocalEdgeKit_inspectSupervisedApp(app, host);
    const pidFile = LocalEdgeKit_resolveAppPath(app, app.pidFile);
    if (inspection.state === "stopped") {
      return { appId: app.id, ok: true, action: "already-stopped", message: "not running" };
    }
    if (inspection.state === "stale-pid") {
      host.removeFile(pidFile);
      return { appId: app.id, ok: true, action: "already-stopped", message: "removed stale pid file" };
    }
    if (inspection.pid === null || !host.pidIsAlive(inspection.pid)) {
      return { appId: app.id, ok: false, action: "failed", message: `not stopping: ${inspection.note}` };
    }
    const ownedListeners = inspection.listenerPids.filter((listener) =>
      LocalEdgeKit_listenerBelongsTo({ listener, pid: inspection.pid ?? 0, processGroup: inspection.processGroup, host }),
    );
    LocalEdgeKit_terminateProcessGroup({
      pid: inspection.pid,
      extraPids: ownedListeners,
      host,
      timeoutMs: app.stopTimeoutMs ?? LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_STOP_TIMEOUT_MS,
      out: options.out,
    });
    const stillAlive = host.pidIsAlive(inspection.pid);
    if (!stillAlive) {
      host.removeFile(pidFile);
    }
    return {
      appId: app.id,
      ok: !stillAlive,
      action: stillAlive ? "failed" : "stopped",
      message: stillAlive ? "process survived SIGKILL" : `stopped pid ${String(inspection.pid)}`,
    };
  });
}

/**
 * Sends SIGTERM to the process group of `pid` (and of each `extraPids` entry, such as an owned
 * listener in a child group), waits up to `timeoutMs`, then SIGKILL.
 *
 * @remarks
 * A process that shares the supervisor's own process group is signalled by pid only, so the
 * supervisor never signals its own group.
 */
export function LocalEdgeKit_terminateProcessGroup(options: {
  pid: number;
  extraPids?: readonly number[] | undefined;
  host: LocalEdgeKit_SupervisorHost;
  timeoutMs: number;
  out: LocalEdgeKit_SupervisorWriter;
}): void {
  const { host } = options;
  const ownGroup = host.ownProcessGroup();
  const targets = new Set<number>();
  for (const pid of [options.pid, ...(options.extraPids ?? [])]) {
    const group = host.processGroupOf(pid);
    targets.add(group !== null && group > 1 && group !== ownGroup ? -group : pid);
  }
  LocalEdgeCore_runtimeStopTerminatePidList({
    pids: [...targets],
    kill: (pid, signal) => host.kill(pid, signal ?? "SIGTERM"),
    pidIsAlive: (pid) => {
      try {
        host.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    stderr: options.out,
    waitForPidsExit: ({ pids }) => {
      const deadline = host.now() + options.timeoutMs;
      for (;;) {
        const alive = pids.some((pid) => {
          try {
            host.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
        if (!alive) {
          return true;
        }
        if (host.now() >= deadline) {
          return false;
        }
        host.sleepSync(200);
      }
    },
  });
}
