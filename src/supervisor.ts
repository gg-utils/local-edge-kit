/**
 * @fileoverview Generic app supervisor: start, stop, adopt, status, health and logs for a set of
 * loopback apps described by a project-owned config, each with a pid file and a log file.
 *
 * The supervisor never assumes it started a process. When it starts one it records the pid with
 * the process's identity (owner uid, start time, command line and a launch id it put in the
 * process environment; see `process-identity.ts`). An
 * app counts as running only when its pid file names a live process whose identity still
 * matches and the app's loopback port is held by that process's tree, so a run started by
 * another supervisor invocation is adopted instead of started twice, and a recycled pid is never
 * adopted. A pid file without a recorded identity is `unverified`: never adopted, never
 * signalled. A port held by anything else is reported as busy and never killed. Stop signals the
 * app's process group (SIGTERM, then SIGKILL after a timeout) through the core runtime-stop
 * helper, checking the identity again immediately before every signal.
 *
 * Concurrency: inspection, start and pid file publication (and inspection plus stop) run under
 * a per-app lock file (`<pidFile>.lock`, published complete by temp file + `link`). A lock
 * whose owner process is gone is taken over under a guard that removes only that exact stale
 * lock (see `LocalEdgeKit_acquireSupervisorLock`); a live owner makes the other supervisor fail
 * with a clear message.
 *
 * Kinds: every entry has a resolved kind, `kind ?? (external ? "external" : "run")`. `run` entries
 * are started, adopted and stopped as described above. `external` entries are route only: never
 * started, stopped or signalled; they may name an absolute `pidFile` and `logFile` anywhere, which
 * are only read (through `LocalEdgeKit_readFileSafe`) and never written or signalled. `check`
 * entries (a `cwd` and a command, no port) are listed in status and skipped by `up` and `down` in
 * this release.
 *
 * Files: pid and lock files of `run` entries are written inside the app's `cwd` through
 * `safe-write.ts` (no symlinks followed, atomic replace, 0600 files, 0700 folders); the log is
 * opened for append the same way. A pid or log path of a `run` entry outside `cwd` is refused.
 * Env checks read names only: values are never returned or printed. Launch env values go to the
 * started process only; output lists their names.
 * Flow: config -> validate + dependency order -> lock -> inspect (pid file + identity + port)
 * -> start/stop -> publish pid file -> unlock -> health.
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor.unit.test.ts
 *
 * @see src/supervisor-cli.ts - Command dispatcher that wires this module to an exposure backend.
 * @see src/runtime-launch.ts - Log tail helper reused for `logs`.
 * @documentation reviewed=2026-11-13 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { LocalEdgeCore_isHealthyHttpStatusCode } from "@gg-utils/local-edge-core/healthcheck";
import {
  LocalEdgeCore_runtimeStopParsePidLines,
  LocalEdgeCore_runtimeStopTerminatePidList,
} from "@gg-utils/local-edge-core/runtime-stop";

import {
  LOCAL_EDGE_KIT_LAUNCH_ID_ENV,
  type LocalEdgeKit_ProcessIdentity,
  LocalEdgeKit_formatPidFile,
  LocalEdgeKit_newLaunchId,
  LocalEdgeKit_parsePidFile,
  LocalEdgeKit_readProcessIdentity,
  LocalEdgeKit_verifyProcessIdentity,
} from "./process-identity.js";
import { LocalEdgeKit_boundedCommandLine, LocalEdgeKit_messageWord } from "./safe-message.js";
import {
  LocalEdgeKit_createFileExclusive,
  LocalEdgeKit_ensureSafeDir,
  LocalEdgeKit_openAppendSafe,
  LocalEdgeKit_readFileSafe,
  LocalEdgeKit_writeFileAtomic,
} from "./safe-write.js";

/**
 * What a catalog entry is.
 * - `run`: the supervisor starts, adopts and stops it (needs `cwd`, `command`, `pidFile`, `logFile`
 *   and `localPort`).
 * - `external`: route only; its process is never started, stopped or signalled. It may name an
 *   absolute `pidFile` and `logFile` that are only read.
 * - `check`: a command run from a `cwd` that has no port. `up` and `down` skip it in this release.
 */
export type LocalEdgeKit_SupervisedAppKind = "run" | "external" | "check";

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
   * What this entry is: `run`, `external` or `check`. When absent it is `external` if the older
   * `external` flag is true and `run` otherwise. Setting both `kind` and a conflicting `external`
   * is the named error `local-edge-kit-kind-conflict`.
   */
  kind?: LocalEdgeKit_SupervisedAppKind | undefined;
  /**
   * Route only: the supervisor never starts, stops, adopts or signals this app's process. It is
   * listed, probed for health and exposed, nothing more. Replaced by `kind: "external"`; still
   * accepted.
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
  /** Loopback port. Required for `run` and `external` entries; optional for `check` entries. */
  localPort?: number | undefined;
  /** Edge port for port-based exposure backends. */
  edgePort?: number | undefined;
  /** Host label for name-based backends. Defaults to `id`. */
  edgeName?: string | undefined;
  /**
   * Extra path routes for name-based backends (`path` -> `127.0.0.1:<localPort><upstreamPath>`),
   * each with optional proxy overrides.
   */
  locations?: readonly LocalEdgeKit_SupervisedAppLocation[] | undefined;
  /** Hostname pattern for this app only (name-based backends), for a host under another label. */
  hostnameTemplate?: string | undefined;
  /** Exact host for name-based backends; wins over every pattern. */
  host?: string | undefined;
  /** Proxy overrides for the `/` location (name-based backends). */
  proxy?: LocalEdgeKit_SupervisedAppProxy | undefined;
  /** Where the app was declared, shown by `status`. Default `project`. */
  source?: string | undefined;
  /**
   * HTTP path that must answer 2xx/3xx for the app to count as healthy. Required except for
   * `check` entries. A plain path on loopback: one leading `/`, then no `//` prefix, `@`,
   * backslash or control character (see `LocalEdgeKit_isLoopbackProbePath`).
   */
  healthPath?: string | undefined;
  /**
   * Optional second HTTP path that must answer before the app counts as ready. Same shape rule
   * as `healthPath`. An empty string counts as not set.
   */
  readyPath?: string | undefined;
  /** Optional text that must appear in the log after start before the app counts as ready. */
  readyLogLine?: string | undefined;
  /**
   * Pid file. Required for enabled `run` entries, inside `cwd`. An `external` entry may name one
   * anywhere as an absolute path; it is only read, never written, and its pid is never signalled.
   */
  pidFile?: string | undefined;
  /**
   * Log file. `run` entries: the process appends to it, inside `cwd`. `external` entries: an
   * absolute path anywhere, only read (by `logs`).
   */
  logFile?: string | undefined;
  dependsOn?: readonly string[] | undefined;
  startTimeoutMs?: number | undefined;
  stopTimeoutMs?: number | undefined;
};

/** Proxy overrides for one routed location. */
export type LocalEdgeKit_SupervisedAppProxy = {
  /** `Host` header sent upstream instead of the client's. */
  upstreamHost?: string | undefined;
  /** `false` turns response buffering off. */
  buffering?: boolean | undefined;
  /** nginx `proxy_read_timeout`, for example `3600s`. */
  readTimeout?: string | undefined;
};

/** One extra path route of an app. An empty `upstreamPath` passes the request URI through. */
export type LocalEdgeKit_SupervisedAppLocation = LocalEdgeKit_SupervisedAppProxy & {
  path: string;
  localPort: number;
  upstreamPath?: string | undefined;
};

/** Observed process state of one app. */
export type LocalEdgeKit_SupervisedAppState =
  | "running"
  | "starting"
  | "port-busy"
  | "stale-pid"
  | "unverified"
  | "stopped"
  | "disabled"
  | "external"
  | "check";

/** Inspection result for one app. */
export type LocalEdgeKit_SupervisedAppInspection = {
  appId: string;
  state: LocalEdgeKit_SupervisedAppState;
  /** Pid from the pid file. For `running`/`starting` it is verified to be the recorded process. */
  pid: number | null;
  processGroup: number | null;
  listenerPids: readonly number[];
  /** The recorded identity, set only when it matched the live process. */
  identity: LocalEdgeKit_ProcessIdentity | null;
  /**
   * The live identity (command line and start time) of `pid`, read from the process list, when
   * the process is alive and is the recorded one, is an unverified pid, or is an external entry's
   * observed pid. Null otherwise. For an external entry's pid it is read without the process
   * environment (no launch id). Its `command` and `startedAt` are what status shows.
   */
  observed: LocalEdgeKit_ProcessIdentity | null;
  /** Times the runner restarted the app. Always 0 in this release; the runner sets it later. */
  restarts: number;
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
  /**
   * Reads a file that may live anywhere (an external entry's pid or log file) through
   * `LocalEdgeKit_readFileSafe`: no symlink in the file or in any folder of its path (a symlinked
   * parent is `local-edge-kit-safe-read-symlinked-parent`), owned by you and not writable by
   * group or others, in such a folder, size-bounded. Returns null when the file does not exist and throws the
   * helper's named error otherwise. Never writes.
   */
  readExternalText(filePath: string, options?: { maxBytes?: number | undefined }): string | null;
  /** Replaces a file atomically inside `root`; refuses symlinks and paths that resolve outside. */
  writeText(filePath: string, text: string, options: { root: string; mode?: number | undefined }): void;
  /** Creates a file inside `root` only when none exists. Returns false when it already exists. */
  createExclusive(filePath: string, text: string, options: { root: string }): boolean;
  /** Creates a folder (0700) inside `root` without following symlinks. */
  ensureDir(dirPath: string, options: { root: string }): void;
  /** Runs a short command to completion. Never through a shell. */
  runCommand(command: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string };
  /** Canonical path with symlinks resolved, or null when it does not exist. */
  realPath(filePath: string): string | null;
  /**
   * GETs `urlPath` over the HTTP unix socket `socketPath` and returns the body of a 200 answer,
   * or null on any error, other status or timeout.
   */
  fetchUnixSocketText(socketPath: string, urlPath: string, timeoutMs: number): string | null;
  removeFile(filePath: string): void;
  fileSize(filePath: string): number;
  pidIsAlive(pid: number): boolean;
  /**
   * Owner uid, start time and command line of a live process, or null when it is gone.
   * `readLaunchId: false` skips the process environment (used for pids the supervisor did not
   * start); the default reads it for the launch id.
   */
  processIdentity(pid: number, options?: { readLaunchId?: boolean | undefined }): LocalEdgeKit_ProcessIdentity | null;
  /** The supervisor's own pid (lock owner). */
  ownPid(): number;
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
    /** Random id passed to the process as `LOCAL_EDGE_KIT_LAUNCH_ID` and recorded with its pid. */
    launchId?: string | undefined;
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
  /** Router only: every failed rollback or cleanup step on this result, in order. Absent when none failed. */
  errors?: readonly string[];
};

const LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_START_TIMEOUT_MS = 60_000;
const LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_STOP_TIMEOUT_MS = 10_000;
const LOCAL_EDGE_KIT_SUPERVISOR_POLL_MS = 500;
/** After a stop, how long a leader that is still exiting may stay listed before it counts as a survivor. */
const LOCAL_EDGE_KIT_SUPERVISOR_EXIT_SETTLE_MS = 1000;
const LOCAL_EDGE_KIT_SUPERVISOR_EXIT_SETTLE_STEP_MS = 50;

/** Child script for `fetchUnixSocketText`: one GET over a unix socket, body on stdout, exit 0 on 200. */
const LOCAL_EDGE_KIT_UNIX_SOCKET_FETCH_SCRIPT = [
  'const http = require("node:http");',
  "const [socketPath, urlPath, ms] = process.argv.slice(1);",
  "const req = http.get({ socketPath, path: urlPath, timeout: Number(ms) }, (res) => {",
  '  let body = ""; res.setEncoding("utf8");',
  '  res.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });',
  '  res.on("end", () => { process.stdout.write(body); process.exit(res.statusCode === 200 ? 0 : 1); });',
  "});",
  'req.on("timeout", () => req.destroy());',
  'req.on("error", () => process.exit(1));',
].join("\n");

function LocalEdgeKit_runCapture(command: string, args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  return { status: result.status, stdout: result.stdout ?? "" };
}

/**
 * Real host effects: `ps`/`lsof` for inspection, `process.kill` for signals, `safe-write.ts` for
 * every file write. Spawned apps get their own process group and append to their log file.
 *
 * @returns A host for `LocalEdgeKit_supervisorUp`/`Down` and the CLI.
 * @example
 * ```typescript
 * const host = LocalEdgeKit_createSupervisorHost();
 * LocalEdgeKit_inspectSupervisedApp(app, host);
 * ```
 */
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
    readExternalText: (filePath, options) =>
      LocalEdgeKit_readFileSafe(filePath, { root: path.dirname(filePath), refuseSymlinkedParents: true, ...(options?.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) }),
    writeText: (filePath, text, options) => LocalEdgeKit_writeFileAtomic(filePath, text, options),
    createExclusive: (filePath, text, options) => LocalEdgeKit_createFileExclusive(filePath, text, options),
    ensureDir: (dirPath, options) => {
      LocalEdgeKit_ensureSafeDir(dirPath, options);
    },
    runCommand: (command, args) => {
      const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    realPath: (filePath) => {
      try {
        return realpathSync(filePath);
      } catch {
        return null;
      }
    },
    fetchUnixSocketText: (socketPath, urlPath, timeoutMs) => {
      const result = spawnSync(process.execPath, ["-e", LOCAL_EDGE_KIT_UNIX_SOCKET_FETCH_SCRIPT, socketPath, urlPath, String(timeoutMs)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: timeoutMs + 2000,
      });
      return result.status === 0 ? (result.stdout ?? "") : null;
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
    processIdentity: (pid, options) => LocalEdgeKit_readProcessIdentity(pid, options),
    ownPid: () => process.pid,
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
          env: {
            ...process.env,
            ...options.env,
            ...(options.launchId === undefined ? {} : { [LOCAL_EDGE_KIT_LAUNCH_ID_ENV]: options.launchId }),
          },
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

/**
 * Resolves an app path against its cwd (or the process cwd when the app has none).
 *
 * @param app - The app.
 * @param filePath - Path from the app config, relative or absolute.
 * @returns An absolute path. It is not checked for containment; writers check that.
 * @example
 * ```typescript
 * LocalEdgeKit_resolveAppPath({ ...app, cwd: "/w/web" }, ".local/edge.pid"); // "/w/web/.local/edge.pid"
 * ```
 */
export function LocalEdgeKit_resolveAppPath(app: LocalEdgeKit_SupervisedApp, filePath: string): string {
  return path.resolve(app.cwd ?? process.cwd(), filePath);
}

const LOCAL_EDGE_KIT_APP_KINDS: readonly string[] = ["run", "external", "check"];

/**
 * Resolves what an entry is: `kind` when set, otherwise `external` when the older `external` flag
 * is true, otherwise `run`.
 *
 * @param app - The app.
 * @returns The resolved kind.
 * @throws Error `local-edge-kit-kind-conflict` when `kind` and `external` disagree (`kind` is not
 * `external` but `external` is true, or `kind` is `external` and `external` is false), and
 * `local-edge-kit-kind-unknown` when `kind` is not one of `run`, `external` and `check`. Neither
 * message repeats more of the value than `LocalEdgeKit_messageWord` allows.
 * @example
 * ```typescript
 * LocalEdgeKit_resolveAppKind({ ...app, external: true }); // "external"
 * ```
 */
export function LocalEdgeKit_resolveAppKind(app: LocalEdgeKit_SupervisedApp): LocalEdgeKit_SupervisedAppKind {
  if (app.kind === undefined) {
    return app.external === true ? "external" : "run";
  }
  if (!LOCAL_EDGE_KIT_APP_KINDS.includes(app.kind)) {
    throw Object.assign(
      new Error(`local-edge-kit-kind-unknown: ${app.id}: kind "${LocalEdgeKit_messageWord(String(app.kind))}" is not run, external or check`),
      { code: "local-edge-kit-kind-unknown" },
    );
  }
  if (app.external !== undefined && app.external !== (app.kind === "external")) {
    throw Object.assign(
      new Error(`local-edge-kit-kind-conflict: ${app.id}: kind "${app.kind}" conflicts with external: ${String(app.external)}; set only kind`),
      { code: "local-edge-kit-kind-conflict" },
    );
  }
  return app.kind;
}

/**
 * Whether a probe path is a plain path that can only mean a path on the loopback port: it starts
 * with exactly one `/` (so no scheme and no `//` host form) and has no `@`, backslash or control
 * character (the URL parser would read `@host` as a host and a backslash as `/`, and strips tabs
 * and newlines). Query and fragment text is allowed.
 *
 * @param value - The configured `healthPath` or `readyPath`.
 * @returns True when the path has that shape.
 * @example
 * ```typescript
 * LocalEdgeKit_isLoopbackProbePath("/healthz?full=1"); // true
 * LocalEdgeKit_isLoopbackProbePath("@host.example/x"); // false
 * ```
 */
export function LocalEdgeKit_isLoopbackProbePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !/[@\\\p{Cc}]/u.test(value);
}

/**
 * Builds the probe URL of one path on `127.0.0.1:<port>` with the URL parser and checks the
 * result: the host must be exactly `127.0.0.1`, the port must be the app's port, the scheme must
 * be `http:` and there must be no user-info. Never throws.
 *
 * @param port - The app's local port.
 * @param probePath - The configured path.
 * @returns The URL text, or null when the path would leave `127.0.0.1:<port>` or is not a URL.
 * @example
 * ```typescript
 * LocalEdgeKit_loopbackProbeUrl(3100, "/healthz"); // "http://127.0.0.1:3100/healthz"
 * LocalEdgeKit_loopbackProbeUrl(3100, "@host.example/x"); // null
 * ```
 */
export function LocalEdgeKit_loopbackProbeUrl(port: number, probePath: string): string | null {
  try {
    const base = new URL(`http://127.0.0.1:${String(port)}`);
    const url = new URL(probePath, base);
    const same =
      url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === base.port && url.username === "" && url.password === "";
    return same ? url.href : null;
  } catch {
    return null;
  }
}

/** Named error line for a probe path that is not a plain loopback path; never repeats the value. */
function LocalEdgeKit_probePathProblem(appId: string, field: "healthPath" | "readyPath"): string {
  return `local-edge-kit-probe-path-invalid: ${LocalEdgeKit_messageWord(appId)}: ${field} must be a plain path on loopback (one leading /, no // prefix, @, backslash, scheme or control character)`;
}

/**
 * Validates supervisor apps: unique ids, a known and consistent kind, required fields per kind,
 * unique local ports, known dependencies, enabled apps depending only on enabled apps, and no
 * cycles. `run` entries (enabled) need `cwd`, `command`, `pidFile` and `logFile`; `external`
 * entries may not set `command` and may name `pidFile` and `logFile` only as absolute paths;
 * `check` entries (enabled) need `cwd` and `command`, and are the only kind without a port or
 * health path. `healthPath` and a set `readyPath` must be plain loopback paths
 * (`LocalEdgeKit_isLoopbackProbePath`); the error never repeats the value.
 *
 * @param apps - All configured apps.
 * @returns One line per problem; an empty list means valid. Never throws.
 * @example
 * ```typescript
 * LocalEdgeKit_validateSupervisedApps(config.apps); // [] or ["web: depends on unknown app \"db\""]
 * ```
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
    let kind: LocalEdgeKit_SupervisedAppKind;
    try {
      kind = LocalEdgeKit_resolveAppKind(app);
    } catch (error) {
      problems.push((error as Error).message);
      continue;
    }
    if (kind !== "check") {
      if (app.healthPath === undefined || !app.healthPath.startsWith("/")) {
        problems.push(`${app.id}: healthPath must start with /`);
      } else if (!LocalEdgeKit_isLoopbackProbePath(app.healthPath)) {
        problems.push(LocalEdgeKit_probePathProblem(app.id, "healthPath"));
      }
      if (app.readyPath !== undefined && app.readyPath !== "") {
        if (!app.readyPath.startsWith("/")) {
          problems.push(`${app.id}: readyPath must start with /`);
        } else if (!LocalEdgeKit_isLoopbackProbePath(app.readyPath)) {
          problems.push(LocalEdgeKit_probePathProblem(app.id, "readyPath"));
        }
      }
      if (app.localPort === undefined) {
        problems.push(`${app.id}: ${kind} apps need localPort`);
      }
    }
    if (!app.enabled) {
      continue;
    }
    if (kind === "external") {
      if (app.command !== undefined) {
        problems.push(`${app.id}: external apps are route only and may not set command`);
      }
      for (const [field, value] of [["pidFile", app.pidFile], ["logFile", app.logFile]] as const) {
        if (value !== undefined && !path.isAbsolute(value)) {
          problems.push(`${app.id}: external ${field} must be an absolute path (it is only read)`);
        }
      }
    } else if (kind === "check") {
      if (!app.cwd || !app.command) {
        problems.push(`${app.id}: check apps need cwd and command`);
      }
    } else if (!app.cwd || !app.command || !app.pidFile || !app.logFile) {
      problems.push(`${app.id}: enabled apps need cwd, command, pidFile and logFile`);
    }
    if (app.localPort !== undefined && kind !== "check") {
      const other = ports.get(app.localPort);
      if (other !== undefined) {
        problems.push(`${app.id}: local port ${String(app.localPort)} is also used by ${other}`);
      }
      ports.set(app.localPort, app.id);
    }
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
 * @param apps - All configured apps.
 * @param requestedIds - Ids to start.
 * @returns Apps in start order, each once.
 * @throws When an id is unknown or the dependency graph has a cycle.
 * @example
 * ```typescript
 * LocalEdgeKit_orderSupervisedApps(apps, ["web"]).map((app) => app.id); // ["auth", "web"]
 * ```
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
 *
 * @param options - Env file text (null when there is no file) and the required names.
 * @returns Missing or empty names, in the order given.
 * @example
 * ```typescript
 * LocalEdgeKit_missingEnvNames({ envText: "A=1\nB=\n", requiredNames: ["A", "B"] }); // ["B"]
 * ```
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
 * process group, or has `pid` among its ancestors (up to 32 levels). Dev servers often move
 * their server into a child process group, so the group check alone is not enough. Callers must
 * have verified `pid`'s identity first; this only relates the listener to it.
 *
 * @param options - Listener pid, verified pid, its process group and the host.
 * @returns Whether the listener is part of that process tree.
 * @example
 * ```typescript
 * LocalEdgeKit_listenerBelongsTo({ listener: 41941, pid: 41844, processGroup: 41844, host });
 * ```
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

/**
 * Reads a pid file and returns its pid.
 *
 * @param host - Supervisor host.
 * @param filePath - Absolute pid file path.
 * @returns A positive integer pid, or null when the file is absent or malformed.
 * @example
 * ```typescript
 * LocalEdgeKit_readPidFile(host, "/w/app/.local/app.pid"); // 4242
 * ```
 */
export function LocalEdgeKit_readPidFile(host: LocalEdgeKit_SupervisorHost, filePath: string): number | null {
  return LocalEdgeKit_parsePidFile(host.readText(filePath)).pid;
}

/** What an external entry's pid file shows, read through the safe-read helper. */
type LocalEdgeKit_ExternalObservation = {
  pid: number | null;
  observed: LocalEdgeKit_ProcessIdentity | null;
  processGroup: number | null;
  note: string;
};

/**
 * Reads an external entry's pid file (read-only, through the host's safe read) and looks the pid
 * up in the process list. Never signals and never writes. The pid was not started by the
 * supervisor, so its identity is uid, start time and command line only: the lookup passes
 * `readLaunchId: false`, and the process environment is not read.
 *
 * @param app - The external app.
 * @param host - Supervisor host (`readExternalText`, `processIdentity`, `processGroupOf`).
 * @returns The pid, the live identity and process group (null when none), and a note naming
 * what was found or the refusal code, never a path or file content.
 */
function LocalEdgeKit_observeExternalPid(app: LocalEdgeKit_SupervisedApp, host: LocalEdgeKit_SupervisorHost): LocalEdgeKit_ExternalObservation {
  const none = { pid: null, observed: null, processGroup: null };
  if (!app.pidFile) {
    return { ...none, note: "" };
  }
  if (!path.isAbsolute(app.pidFile)) {
    return { ...none, note: "pid file not read: external pid files must be absolute paths" };
  }
  let text: string | null;
  try {
    text = host.readExternalText(app.pidFile);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { ...none, note: `pid file not read (${typeof code === "string" && code.startsWith("local-edge-kit-") ? code : "unreadable"})` };
  }
  if (text === null) {
    return { ...none, note: "pid file not found" };
  }
  const { pid } = LocalEdgeKit_parsePidFile(text);
  if (pid === null) {
    return { ...none, note: "pid file holds no pid" };
  }
  const observed = host.processIdentity(pid, { readLaunchId: false });
  if (observed === null) {
    return { ...none, note: `pid file names pid ${String(pid)}, which is not running` };
  }
  return { pid, observed, processGroup: host.processGroupOf(pid), note: `pid ${String(pid)} observed from the pid file; never signalled` };
}

/**
 * Inspects one app by pid file, recorded identity and port check. Read-only: never writes or
 * signals. An `external` entry with a `pidFile` shows the pid observed there (read through the
 * safe-read helper) and the live process's command line and start time, and is never signalled;
 * a `check` entry has no process and no port and is reported as `check`.
 *
 * @param app - The app.
 * @param host - Supervisor host.
 * @returns `running`/`starting` only for a live process whose identity matches the recorded one;
 * `unverified` for a live pid without a recorded identity; `stale-pid` for a dead or recycled
 * pid; `port-busy` when the port is held by a process that is not ours; `external` and `check`
 * for those kinds.
 * @throws The named kind errors of `LocalEdgeKit_resolveAppKind`.
 * @example
 * ```typescript
 * LocalEdgeKit_inspectSupervisedApp(app, host).state; // "running"
 * ```
 */
export function LocalEdgeKit_inspectSupervisedApp(
  app: LocalEdgeKit_SupervisedApp,
  host: LocalEdgeKit_SupervisorHost,
): LocalEdgeKit_SupervisedAppInspection {
  const kind = LocalEdgeKit_resolveAppKind(app);
  const listenerPids = app.localPort === undefined ? [] : host.listenerPids(app.localPort);
  const base = { appId: app.id, listenerPids, identity: null, observed: null, restarts: 0 };
  if (!app.enabled) {
    const busy = listenerPids.length > 0 ? `; port ${String(app.localPort)} is in use` : "";
    return { ...base, state: "disabled", pid: null, processGroup: null, note: `${app.disabledReason ?? "disabled"}${busy}` };
  }
  if (kind === "check") {
    return { ...base, state: "check", pid: null, processGroup: null, note: "check; not run by up, down or status in this release" };
  }
  if (kind === "external") {
    const listening = listenerPids.length > 0;
    const seen = LocalEdgeKit_observeExternalPid(app, host);
    const route = `route only; port ${listening ? "listening" : "not listening"}`;
    return {
      ...base,
      state: "external",
      pid: seen.pid,
      processGroup: seen.processGroup,
      observed: seen.observed,
      note: seen.note === "" ? route : `${route}; ${seen.note}`,
    };
  }
  const parsed = LocalEdgeKit_parsePidFile(app.pidFile ? host.readText(LocalEdgeKit_resolveAppPath(app, app.pidFile)) : null);
  const { pid } = parsed;
  const current = pid === null ? null : host.processIdentity(pid);
  const check = pid === null ? null : LocalEdgeKit_verifyProcessIdentity({ pid, recorded: parsed.identity, current });
  if (pid !== null && check?.ok === true) {
    const processGroup = host.processGroupOf(pid);
    const verified = { ...base, pid, processGroup, identity: parsed.identity, observed: current };
    if (listenerPids.length === 0) {
      return { ...verified, state: "starting", note: "process alive, port not listening yet" };
    }
    const owned = listenerPids.some((listener) => LocalEdgeKit_listenerBelongsTo({ listener, pid, processGroup, host }));
    if (owned) {
      return { ...verified, state: "running", note: "pid file process holds the port" };
    }
    return { ...verified, state: "port-busy", note: `port held by another process (${listenerPids.join(",")})` };
  }
  const failure = check !== null && !check.ok ? check : null;
  if (pid !== null && (failure?.reason === "unrecorded" || (current === null && host.pidIsAlive(pid)))) {
    const why = failure?.reason === "unrecorded" ? failure.message : `pid ${String(pid)} is alive but its identity cannot be read`;
    return { ...base, state: "unverified", pid, processGroup: null, observed: failure?.reason === "unrecorded" ? current : null, note: `${why}; not adopted or signalled, stop it yourself and remove the pid file` };
  }
  const stale = failure?.message ?? "";
  if (listenerPids.length > 0) {
    const prefix = pid === null ? "no pid file process" : `pid file is stale (${stale})`;
    return { ...base, state: "port-busy", pid, processGroup: null, note: `${prefix}; port held by ${listenerPids.join(",")}` };
  }
  if (pid !== null) {
    return { ...base, state: "stale-pid", pid, processGroup: null, note: `pid file is stale: ${stale}` };
  }
  return { ...base, state: "stopped", pid: null, processGroup: null, note: "not running" };
}

const LOCAL_EDGE_KIT_PS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Converts a start time as `ps -o lstart=` prints it in the C locale (`Thu Nov 12 03:47:37 2026`,
 * local time) to an ISO UTC time. A single-digit day is accepted as `ps` pads it (`Fri Nov  6 08:01:02 2026`,
 * two spaces), with one space, or zero-padded (`Sun Nov 01 00:00:00 2026`: `ps` never prints it, but it
 * is an unambiguous day and is accepted on purpose). Strict otherwise: anything that is not exactly that shape, or not a real
 * date, gives null (a lenient parser would read `start-701` as the year 701).
 *
 * @param startedAt - The start time as the process list printed it.
 * @returns The ISO UTC time, or null when the text is not exactly that shape or not a real date.
 */
function LocalEdgeKit_isoFromPsStartTime(startedAt: string): string | null {
  const match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{2}| ?\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(startedAt);
  const month = LOCAL_EDGE_KIT_PS_MONTHS.indexOf(match?.[1] ?? "");
  if (match === null || month < 0) {
    return null;
  }
  const [day, hour, minute, second, year] = [match[2], match[3], match[4], match[5], match[6]].map(Number) as [number, number, number, number, number];
  const date = new Date(year, month, day, hour, minute, second);
  const real = date.getFullYear() === year && date.getMonth() === month && date.getDate() === day && date.getHours() === hour;
  return real && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/** Status fields every catalog entry shows, whatever its kind. */
export type LocalEdgeKit_SupervisedAppStatusFields = {
  /** The resolved kind. */
  kind: LocalEdgeKit_SupervisedAppKind;
  /** Process group of the observed pid, or null. */
  processGroup: number | null;
  /** Command line of the observed pid (control characters removed, at most 200 characters), or null. */
  commandLine: string | null;
  /** The working directory as configured, or null. */
  cwd: string | null;
  /** The env file path as configured (never its content), or null. */
  envFile: string | null;
  /** Whether the env file exists. Checked without reading it. */
  envFilePresent: boolean;
  /** ISO time the observed process started, or null. */
  since: string | null;
  /** Restarts counted by the runner. Always 0 in this release. */
  restarts: number;
};

/**
 * Builds the status fields of one entry from its inspection. Read-only: the env file is checked
 * for existence only (it is not opened), and this function reads no process environment. No
 * environment value of any process is ever part of the fields.
 *
 * @param app - The app.
 * @param inspection - Its inspection (`pid`, `processGroup`, `observed` and `restarts` are used).
 * @param host - Supervisor host (`realPath` for the env file check).
 * @returns The fields shown by `status` and `status --json`.
 * @throws The named kind errors of `LocalEdgeKit_resolveAppKind`.
 * @example
 * ```typescript
 * LocalEdgeKit_supervisedAppStatusFields(app, LocalEdgeKit_inspectSupervisedApp(app, host), host).since;
 * ```
 */
export function LocalEdgeKit_supervisedAppStatusFields(
  app: LocalEdgeKit_SupervisedApp,
  inspection: LocalEdgeKit_SupervisedAppInspection,
  host: LocalEdgeKit_SupervisorHost,
): LocalEdgeKit_SupervisedAppStatusFields {
  return {
    kind: LocalEdgeKit_resolveAppKind(app),
    processGroup: inspection.processGroup,
    commandLine: inspection.observed === null ? null : LocalEdgeKit_boundedCommandLine(inspection.observed.command),
    cwd: app.cwd ?? null,
    envFile: app.envFile ?? null,
    envFilePresent: app.envFile !== undefined && host.realPath(LocalEdgeKit_resolveAppPath(app, app.envFile)) !== null,
    since: inspection.observed === null ? null : LocalEdgeKit_isoFromPsStartTime(inspection.observed.startedAt),
    restarts: inspection.restarts,
  };
}

/**
 * Probes an app's health path (and ready path, when set) on `127.0.0.1`. The URL is built with the
 * URL parser and refused unless its host is exactly `127.0.0.1` and its port is the app's port; a
 * refused path is not fetched and counts as failed (`status` null, `path` shown without its value).
 *
 * @param app - The app.
 * @param host - Supervisor host (HTTP through `host.httpStatus`).
 * @param timeoutMs - Per-request timeout. Default 3000.
 * @returns Per-path status; healthy when every path answers 2xx/3xx. An app with no port or no
 * health path (a `check` entry) cannot be probed: it is `healthy: false` with no checks. Never throws.
 * @example
 * ```typescript
 * (await LocalEdgeKit_probeSupervisedAppHealth(app, host)).healthy;
 * ```
 */
export async function LocalEdgeKit_probeSupervisedAppHealth(
  app: LocalEdgeKit_SupervisedApp,
  host: LocalEdgeKit_SupervisorHost,
  timeoutMs = 3000,
): Promise<LocalEdgeKit_SupervisedAppHealth> {
  if (app.localPort === undefined || app.healthPath === undefined) {
    return { appId: app.id, healthy: false, checks: [] };
  }
  const port = app.localPort;
  const paths = [app.healthPath, ...(app.readyPath ? [app.readyPath] : [])];
  const checks = await Promise.all(
    paths.map(async (probePath) => {
      const url = LocalEdgeKit_loopbackProbeUrl(port, probePath);
      if (url === null) {
        // Refused, not fetched: the path would leave 127.0.0.1:<port>. The value is not repeated.
        return { path: LocalEdgeKit_messageWord(probePath), status: null, ok: false };
      }
      const status = await host.httpStatus(url, timeoutMs);
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

/**
 * Waits until the app is healthy and, when `readyLogLine` is set, that line appeared in the log
 * after `logOffset`. Polls every 500 ms.
 *
 * @param options - App, host, log offset, timeout and the pid that must stay alive meanwhile.
 * @returns `ready: false` with a reason when the pid exits or the timeout passes.
 * @example
 * ```typescript
 * await LocalEdgeKit_waitForSupervisedAppReady({ app, host, logOffset: 0, timeoutMs: 60_000, pid });
 * ```
 */
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

/** Held per-app lock; `release` removes the lock file when this supervisor still owns it. */
export type LocalEdgeKit_SupervisorLock = { release(): void };

/** Lock and guard file text: pid, identity JSON (empty when unreadable) and a random token. */
function LocalEdgeKit_formatLockFile(pid: number, identity: LocalEdgeKit_ProcessIdentity | null, token: string): string {
  return `${String(pid)}\n${identity === null ? "" : JSON.stringify(identity)}\n${token}\n`;
}

/** Parses lock or guard text; `token` is null for an empty, partial or older lock. */
function LocalEdgeKit_parseLockFile(text: string): { pid: number | null; identity: LocalEdgeKit_ProcessIdentity | null; token: string | null } {
  const token = text.split("\n")[2]?.trim() ?? "";
  return { ...LocalEdgeKit_parsePidFile(text), token: /^[0-9a-f]{32}$/.test(token) ? token : null };
}

/** True only when the holder's process is provably gone: dead, or its identity changed. */
function LocalEdgeKit_lockHolderGone(
  host: LocalEdgeKit_SupervisorHost,
  holder: { pid: number; identity: LocalEdgeKit_ProcessIdentity | null },
): boolean {
  const current = host.processIdentity(holder.pid);
  if (current === null) {
    return !host.pidIsAlive(holder.pid);
  }
  const check = LocalEdgeKit_verifyProcessIdentity({ pid: holder.pid, recorded: holder.identity, current });
  return !check.ok && check.reason !== "unrecorded";
}

const LOCAL_EDGE_KIT_LOCK_MAX_GUARD_DEPTH = 4;

/** Guard key for one exact lock content: its SHA-256, shortened. */
function LocalEdgeKit_lockContentKey(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

/**
 * Removes the stale file at `filePath` only if it is still exactly `seenText`, under the
 * takeover guard `<filePath>.takeover-<key of seenText>`.
 *
 * @returns `"retry"` when the caller should try to publish again, or an error message.
 */
function LocalEdgeKit_removeStaleUnderGuard(options: {
  filePath: string;
  seenText: string;
  root: string;
  host: LocalEdgeKit_SupervisorHost;
  ownText: (token: string) => string;
  depth: number;
}): "retry" | { error: string } {
  const { filePath, host, root } = options;
  const guardFile = `${filePath}.takeover-${LocalEdgeKit_lockContentKey(options.seenText)}`;
  const guardToken = randomBytes(16).toString("hex");
  if (!host.createExclusive(guardFile, options.ownText(guardToken), { root })) {
    const guardText = host.readText(guardFile);
    if (guardText === null) {
      return "retry";
    }
    const guard = LocalEdgeKit_parseLockFile(guardText);
    if (guard.pid === null || guard.identity === null) {
      return { error: `takeover guard ${guardFile} is empty or unreadable; if no supervisor runs, remove it` };
    }
    if (!LocalEdgeKit_lockHolderGone(host, { pid: guard.pid, identity: guard.identity })) {
      return { error: `another supervisor (pid ${String(guard.pid)}) is taking over ${filePath}` };
    }
    if (options.depth >= LOCAL_EDGE_KIT_LOCK_MAX_GUARD_DEPTH) {
      return { error: `too many abandoned takeover guards beside ${filePath}; remove them by hand` };
    }
    const nested = LocalEdgeKit_removeStaleUnderGuard({
      ...options,
      filePath: guardFile,
      seenText: guardText,
      depth: options.depth + 1,
    });
    return nested === "retry" ? "retry" : nested;
  }
  try {
    if (host.readText(filePath) === options.seenText) {
      host.removeFile(filePath);
    }
  } finally {
    const guardNow = host.readText(guardFile);
    if (guardNow !== null && LocalEdgeKit_parseLockFile(guardNow).token === guardToken) {
      host.removeFile(guardFile);
    }
  }
  return "retry";
}

/**
 * Takes the per-app supervisor lock `<pidFile>.lock` inside the app's `cwd`. The lock file holds
 * the owner's pid, identity and a random 128-bit token. A lock whose owner is gone (or is a
 * recycled pid) is taken over; a live owner, or an owner without a readable identity, keeps it.
 *
 * Why at most one owner:
 * 1. Publication is atomic. `host.createExclusive` writes the complete text to a unique temp
 *    file and `link()`s it to the lock path, which fails with EEXIST when a lock exists. A lock
 *    is therefore never visible empty or half-written, and no two creations both succeed.
 * 2. A lock file is removed only by its owner's `release` (which re-reads it and removes it
 *    only when it holds the owner's token) or by a takeover. An owner cannot lose its lock while
 *    it is alive, because a takeover needs the holder to be provably gone.
 * 3. A takeover of the stale lock S first creates the guard `<lock>.takeover-<k>`, where `k`
 *    is the SHA-256 of S's bytes, the same exclusive way, then re-reads the lock and removes it
 *    only when its bytes are still exactly S. While the guard is held, S cannot be replaced: its
 *    owner is dead, only the guard holder may remove it, and nothing can be published over an
 *    existing file. So the removal removes S and never a successor. A contender that judged S
 *    stale too, but gets the guard only after S was removed, finds other bytes and removes
 *    nothing. Every lock carries a random token (an older version's lock carries the identity
 *    of a process that is now gone), so no later lock has S's bytes.
 * 4. A guard whose holder died is itself stale and is taken over by the same rule, under the
 *    guard `<guard>.takeover-<k>`. Two bounds apply, and the second is the tighter one:
 *    a) One takeover call follows a chain of abandoned guards at most four deep
 *       (`LOCAL_EDGE_KIT_LOCK_MAX_GUARD_DEPTH`); an abandoned fifth guard is refused with an
 *       error that says to remove them by hand, and nothing is removed.
 *    b) The acquire loop below makes at most three attempts, and each attempt removes only one
 *       file (the deepest abandoned guard, or else the stale lock) before it retries; the last
 *       attempt must publish the lock. So one call takes the lock when at most one guard is
 *       abandoned. With two to four abandoned guards the call returns `could not take` after
 *       clearing three files, and calling again continues from there.
 * 5. A lock without a pid and a complete identity (empty or partial) is never removed
 *    automatically: an older version, which wrote after an exclusive open, could still be
 *    writing it. The caller gets an error that says to remove it by
 *    hand once no supervisor runs.
 *
 * @param app - The app; `pidFile` and `cwd` locate the lock.
 * @param host - Supervisor host.
 * @returns `{ lock }` on success, or `{ error }` naming the holder.
 * @example
 * ```typescript
 * const taken = LocalEdgeKit_acquireSupervisorLock(app, host);
 * if ("lock" in taken) try { ... } finally { taken.lock.release(); }
 * ```
 */
export function LocalEdgeKit_acquireSupervisorLock(
  app: LocalEdgeKit_SupervisedApp,
  host: LocalEdgeKit_SupervisorHost,
): { lock: LocalEdgeKit_SupervisorLock } | { error: string } {
  const root = app.cwd ?? process.cwd();
  if (!app.pidFile) {
    return { error: `${app.id} has no pid file to lock` };
  }
  const lockFile = `${LocalEdgeKit_resolveAppPath(app, app.pidFile)}.lock`;
  const ownPid = host.ownPid();
  const ownIdentity = host.processIdentity(ownPid);
  const ownText = (token: string): string => LocalEdgeKit_formatLockFile(ownPid, ownIdentity, token);
  const token = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (host.createExclusive(lockFile, ownText(token), { root })) {
      return {
        lock: {
          release: () => {
            const now = host.readText(lockFile);
            if (now !== null && LocalEdgeKit_parseLockFile(now).token === token) {
              host.removeFile(lockFile);
            }
          },
        },
      };
    }
    const seenText = host.readText(lockFile);
    if (seenText === null) {
      continue;
    }
    const holder = LocalEdgeKit_parseLockFile(seenText);
    if (holder.pid === null || holder.identity === null) {
      return {
        error: `${lockFile} is empty or unreadable (a supervisor may still be writing it); if no supervisor runs, remove it`,
      };
    }
    if (!LocalEdgeKit_lockHolderGone(host, { pid: holder.pid, identity: holder.identity })) {
      return { error: `another supervisor (pid ${String(holder.pid)}) holds ${lockFile}` };
    }
    const removed = LocalEdgeKit_removeStaleUnderGuard({
      filePath: lockFile,
      seenText,
      root,
      host,
      ownText,
      depth: 0,
    });
    if (removed !== "retry") {
      return removed;
    }
  }
  return { error: `could not take ${lockFile}` };
}

/**
 * Starts the requested apps and their dependencies in order, adopting any that already run
 * (pid file process with a matching identity). `external` and `check` entries are skipped
 * (`check` entries run on demand in a later release). Stops at the first failure; later apps are
 * reported as skipped. Inspection, spawn and pid file publication run under the app's lock.
 *
 * @param options - Apps, requested ids, host and progress writer.
 * @returns One result per app in start order.
 * @throws When a requested id is unknown or dependencies form a cycle.
 * @example
 * ```typescript
 * const results = await LocalEdgeKit_supervisorUp({ apps, requestedIds: ["web"], host, out: process.stderr });
 * ```
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
    const kind = LocalEdgeKit_resolveAppKind(app);
    if (kind === "check") {
      results.push({ appId: app.id, ok: true, action: "skipped", message: "check: not run by up in this release" });
      continue;
    }
    if (kind === "external") {
      results.push({ appId: app.id, ok: true, action: "skipped", message: "external: route only, never started" });
      continue;
    }
    const timeoutMs = app.startTimeoutMs ?? LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_START_TIMEOUT_MS;
    const step = LocalEdgeKit_startUnderLock(app, host, out);
    if ("result" in step) {
      results.push(step.result);
      failed ||= !step.result.ok;
      continue;
    }
    const ready = await LocalEdgeKit_waitForSupervisedAppReady({ app, host, logOffset: step.logOffset, timeoutMs, pid: step.pid });
    if (ready.ready && step.action === "started") {
      LocalEdgeKit_refreshRecordedIdentity(app, host, step.pid, step.identity);
    }
    results.push({ appId: app.id, ok: ready.ready, action: ready.ready ? step.action : "failed", message: ready.message });
    failed ||= !ready.ready;
  }
  return results;
}

type LocalEdgeKit_StartStep =
  | { result: LocalEdgeKit_SupervisorStepResult }
  | { action: "started" | "adopted"; pid: number; logOffset: number; identity: LocalEdgeKit_ProcessIdentity | null };

/** Lock, inspect, then adopt or spawn and publish the pid file; unlock before the health wait. */
function LocalEdgeKit_startUnderLock(
  app: LocalEdgeKit_SupervisedApp,
  host: LocalEdgeKit_SupervisorHost,
  out: LocalEdgeKit_SupervisorWriter,
): LocalEdgeKit_StartStep {
  const fail = (message: string): LocalEdgeKit_StartStep => ({ result: { appId: app.id, ok: false, action: "failed", message } });
  const taken = LocalEdgeKit_acquireSupervisorLock(app, host);
  if ("error" in taken) {
    return fail(`not starting: ${taken.error}`);
  }
  try {
    const inspection = LocalEdgeKit_inspectSupervisedApp(app, host);
    if ((inspection.state === "running" || inspection.state === "starting") && inspection.pid !== null) {
      out.write(`[${app.id}] adopting pid ${String(inspection.pid)} (${inspection.state})\n`);
      return { action: "adopted", pid: inspection.pid, logOffset: 0, identity: inspection.identity };
    }
    if (inspection.state === "port-busy" || inspection.state === "unverified") {
      return fail(`refusing to start: ${inspection.note}`);
    }
    let launchEnv: Readonly<Record<string, string>>;
    try {
      launchEnv = typeof app.launchEnv === "function" ? app.launchEnv() : (app.launchEnv ?? {});
    } catch (error) {
      return fail(`launch env unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const launchNames = Object.keys(launchEnv);
    const missing = LocalEdgeKit_missingEnvNames({
      envText: app.envFile ? host.readText(LocalEdgeKit_resolveAppPath(app, app.envFile)) : null,
      requiredNames: (app.requiredEnvNames ?? []).filter((name) => !launchNames.includes(name)),
    });
    if (missing.length > 0) {
      return fail(`env file lacks: ${missing.join(", ")}`);
    }
    const root = app.cwd ?? process.cwd();
    const logFile = LocalEdgeKit_resolveAppPath(app, app.logFile ?? "");
    const logOffset = host.fileSize(logFile);
    if (launchNames.length > 0) {
      out.write(`[${app.id}] launch env: ${launchNames.join(", ")}\n`);
    }
    const launchId = LocalEdgeKit_newLaunchId();
    const pid = host.spawnDetached({ cwd: root, command: app.command ?? "", args: app.args ?? [], logFile, logRoot: root, env: launchEnv, launchId });
    const read = host.processIdentity(pid);
    const identity = read === null ? null : { ...read, launchId };
    host.writeText(LocalEdgeKit_resolveAppPath(app, app.pidFile ?? ""), LocalEdgeKit_formatPidFile(pid, identity), { root });
    out.write(`[${app.id}] started pid ${String(pid)}, waiting for health\n`);
    return { action: "started", pid, logOffset, identity };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    taken.lock.release();
  }
}

/**
 * After a successful start, records the command line again when the same process (same uid and
 * start time) changed its title while starting, so a later stop still recognises it.
 */
function LocalEdgeKit_refreshRecordedIdentity(
  app: LocalEdgeKit_SupervisedApp,
  host: LocalEdgeKit_SupervisorHost,
  pid: number,
  recorded: LocalEdgeKit_ProcessIdentity | null,
): void {
  const current = host.processIdentity(pid);
  if (
    recorded === null ||
    current === null ||
    current.uid !== recorded.uid ||
    current.startedAt !== recorded.startedAt ||
    current.command === recorded.command ||
    (typeof recorded.launchId === "string" && current.launchId !== undefined && current.launchId !== recorded.launchId)
  ) {
    return;
  }
  if (!app.pidFile) {
    return;
  }
  const pidFile = LocalEdgeKit_resolveAppPath(app, app.pidFile);
  if (LocalEdgeKit_parsePidFile(host.readText(pidFile)).pid === pid) {
    const refreshed = { uid: current.uid, startedAt: current.startedAt, command: current.command, ...(typeof recorded.launchId === "string" ? { launchId: recorded.launchId } : {}) };
    host.writeText(pidFile, LocalEdgeKit_formatPidFile(pid, refreshed), { root: app.cwd ?? process.cwd() });
  }
}

/**
 * Stops the requested apps, dependants first. `external` and `check` entries are skipped, and an
 * external entry's pid file is never read for a signal. Only a pid file process whose recorded identity
 * matches is signalled, and the identity is checked again before every signal; a foreign
 * listener, a recycled pid and an unverified pid are never touched. Runs under the app's lock.
 *
 * @param options - Apps, requested ids, host and progress writer.
 * @returns One result per requested app in stop order.
 * @throws When a requested id is unknown or dependencies form a cycle.
 * @example
 * ```typescript
 * LocalEdgeKit_supervisorDown({ apps, requestedIds: ["web"], host, out: process.stderr });
 * ```
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
    const kind = LocalEdgeKit_resolveAppKind(app);
    if (kind === "check") {
      return { appId: app.id, ok: true, action: "skipped", message: "check: not run by down in this release; nothing to stop" };
    }
    if (kind === "external" || !app.pidFile) {
      return { appId: app.id, ok: true, action: "skipped", message: "external: route only, never signalled" };
    }
    const taken = LocalEdgeKit_acquireSupervisorLock(app, host);
    if ("error" in taken) {
      return { appId: app.id, ok: false, action: "failed", message: `not stopping: ${taken.error}` };
    }
    try {
      return LocalEdgeKit_stopLocked(app, host, options.out);
    } catch (error) {
      return { appId: app.id, ok: false, action: "failed", message: error instanceof Error ? error.message : String(error) };
    } finally {
      taken.lock.release();
    }
  });
}

function LocalEdgeKit_stopLocked(
  app: LocalEdgeKit_SupervisedApp,
  host: LocalEdgeKit_SupervisorHost,
  out: LocalEdgeKit_SupervisorWriter,
): LocalEdgeKit_SupervisorStepResult {
  const inspection = LocalEdgeKit_inspectSupervisedApp(app, host);
  const pidFile = LocalEdgeKit_resolveAppPath(app, app.pidFile ?? "");
  if (inspection.state === "stopped") {
    return { appId: app.id, ok: true, action: "already-stopped", message: "not running" };
  }
  if (inspection.state === "stale-pid") {
    host.removeFile(pidFile);
    return { appId: app.id, ok: true, action: "already-stopped", message: `removed stale pid file (${inspection.note})` };
  }
  const { pid, identity } = inspection;
  if (pid === null || identity === null) {
    return { appId: app.id, ok: false, action: "failed", message: `not stopping: ${inspection.note}` };
  }
  const targets: LocalEdgeKit_SignalTarget[] = [{ pid, identity }];
  for (const listener of inspection.listenerPids) {
    if (listener === pid || !LocalEdgeKit_listenerBelongsTo({ listener, pid, processGroup: inspection.processGroup, host })) {
      continue;
    }
    const listenerIdentity = host.processIdentity(listener);
    if (listenerIdentity !== null) {
      targets.push({ pid: listener, identity: listenerIdentity });
    }
  }
  LocalEdgeKit_terminateProcessGroup({
    targets,
    host,
    timeoutMs: app.stopTimeoutMs ?? LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_STOP_TIMEOUT_MS,
    out,
  });
  /**
   * Whether the recorded pid is still the process this pid file named.
   * @returns True while the same uid, start time and command are listed for the pid.
   * @example
   * const stillOurs = isOurs();
   */
  const isOurs = (): boolean => LocalEdgeKit_verifyProcessIdentity({ pid, recorded: identity, current: host.processIdentity(pid) }).ok;
  // A leader that has just exited can stay listed for a moment; look again, bounded, before calling it a survivor.
  const settleDeadline = host.now() + LOCAL_EDGE_KIT_SUPERVISOR_EXIT_SETTLE_MS;
  let stillOurs = isOurs();
  while (stillOurs && host.now() < settleDeadline) {
    host.sleepSync(LOCAL_EDGE_KIT_SUPERVISOR_EXIT_SETTLE_STEP_MS);
    stillOurs = isOurs();
  }
  if (!stillOurs) {
    host.removeFile(pidFile);
  }
  return {
    appId: app.id,
    ok: !stillOurs,
    action: stillOurs ? "failed" : "stopped",
    message: stillOurs ? "process survived SIGKILL" : `stopped pid ${String(pid)}`,
  };
}

/** One process to stop, with the identity it must still have when each signal is sent. */
export type LocalEdgeKit_SignalTarget = { pid: number; identity: LocalEdgeKit_ProcessIdentity };

/**
 * Sends SIGTERM to the process group of each target (such as the pid file process and an owned
 * listener in a child group), waits up to `timeoutMs`, then SIGKILL. Immediately before every
 * signal, including the liveness probes, the target's identity is read again; a target that is
 * gone, recycled or has left its group is treated as exited and is not signalled again.
 *
 * @param options - Targets with recorded identities, host, timeout and progress writer.
 * @remarks
 * A target that shares the supervisor's own process group is signalled by pid only, so the
 * supervisor never signals its own group. A group is signalled only while its recorded member
 * is still in it.
 * @example
 * ```typescript
 * LocalEdgeKit_terminateProcessGroup({ targets: [{ pid, identity }], host, timeoutMs: 10_000, out: process.stderr });
 * ```
 */
export function LocalEdgeKit_terminateProcessGroup(options: {
  targets: readonly LocalEdgeKit_SignalTarget[];
  host: LocalEdgeKit_SupervisorHost;
  timeoutMs: number;
  out: LocalEdgeKit_SupervisorWriter;
}): void {
  const { host } = options;
  const ownGroup = host.ownProcessGroup();
  const guards = new Map<number, () => boolean>();
  for (const target of options.targets) {
    const group = host.processGroupOf(target.pid);
    const signalPid = group !== null && group > 1 && group !== ownGroup ? -group : target.pid;
    guards.set(signalPid, () => {
      const current = host.processIdentity(target.pid);
      const same = LocalEdgeKit_verifyProcessIdentity({ pid: target.pid, recorded: target.identity, current }).ok;
      return same && (signalPid > 0 || host.processGroupOf(target.pid) === -signalPid);
    });
  }
  const guardedKill = (pid: number, signal: NodeJS.Signals | 0): void => {
    if (guards.get(pid)?.() !== true) {
      throw Object.assign(new Error(`pid ${String(pid)} is no longer the recorded process`), { code: "ESRCH" });
    }
    host.kill(pid, signal);
  };
  const probe = (pid: number): boolean => {
    try {
      guardedKill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  LocalEdgeCore_runtimeStopTerminatePidList({
    pids: [...guards.keys()],
    kill: (pid, signal) => guardedKill(pid, signal ?? "SIGTERM"),
    pidIsAlive: probe,
    stderr: options.out,
    waitForPidsExit: ({ pids }) => {
      const deadline = host.now() + options.timeoutMs;
      for (;;) {
        if (!pids.some(probe)) {
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
