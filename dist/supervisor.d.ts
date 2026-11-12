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
 * Files: pid and lock files are written inside the app's `cwd` through `safe-write.ts`
 * (no symlinks followed, atomic replace, 0600 files, 0700 folders); the log is opened for
 * append the same way. A pid or log path outside `cwd` is refused.
 * Env checks read names only: values are never returned or printed.
 * Flow: config -> validate + dependency order -> lock -> inspect (pid file + identity + port)
 * -> start/stop -> publish pid file -> unlock -> health.
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor.unit.test.ts
 *
 * @see src/supervisor-cli.ts - Command dispatcher that wires this module to an exposure backend.
 * @see src/runtime-launch.ts - Log tail helper reused for `logs`.
 * @documentation reviewed=2026-11-11 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { type LocalEdgeKit_ProcessIdentity } from "./process-identity.js";
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
    /** Env file whose variable NAMES are checked before start. */
    envFile?: string | undefined;
    requiredEnvNames?: readonly string[] | undefined;
    localPort: number;
    /** Edge port for port-based exposure backends. */
    edgePort?: number | undefined;
    /** HTTP path that must answer 2xx/3xx for the app to count as healthy. */
    healthPath: string;
    /** Optional second HTTP path that must answer before the app counts as ready. */
    readyPath?: string | undefined;
    /** Optional text that must appear in the log after start before the app counts as ready. */
    readyLogLine?: string | undefined;
    pidFile: string;
    logFile: string;
    dependsOn?: readonly string[] | undefined;
    startTimeoutMs?: number | undefined;
    stopTimeoutMs?: number | undefined;
};
/** Observed process state of one app. */
export type LocalEdgeKit_SupervisedAppState = "running" | "starting" | "port-busy" | "stale-pid" | "unverified" | "stopped" | "disabled";
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
    note: string;
};
/** Health probe result. */
export type LocalEdgeKit_SupervisedAppHealth = {
    appId: string;
    healthy: boolean;
    checks: readonly {
        path: string;
        status: number | null;
        ok: boolean;
    }[];
};
/** Host effects the supervisor needs; tests inject fakes for all of them. */
export type LocalEdgeKit_SupervisorHost = {
    readText(filePath: string): string | null;
    /** Replaces a file atomically inside `root`; refuses symlinks and paths that resolve outside. */
    writeText(filePath: string, text: string, options: {
        root: string;
        mode?: number | undefined;
    }): void;
    /** Creates a file inside `root` only when none exists. Returns false when it already exists. */
    createExclusive(filePath: string, text: string, options: {
        root: string;
    }): boolean;
    removeFile(filePath: string): void;
    fileSize(filePath: string): number;
    pidIsAlive(pid: number): boolean;
    /** Owner uid, start time and command line of a live process, or null when it is gone. */
    processIdentity(pid: number): LocalEdgeKit_ProcessIdentity | null;
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
        /** Random id passed to the process as `LOCAL_EDGE_KIT_LAUNCH_ID` and recorded with its pid. */
        launchId?: string | undefined;
    }): number;
    sleep(ms: number): Promise<void>;
    sleepSync(ms: number): void;
    now(): number;
};
/** Writer used for progress lines. */
export type LocalEdgeKit_SupervisorWriter = {
    write(message: string): unknown;
};
/** Result of `up` or `down` for one app. */
export type LocalEdgeKit_SupervisorStepResult = {
    appId: string;
    ok: boolean;
    action: "started" | "adopted" | "stopped" | "already-stopped" | "skipped" | "failed";
    message: string;
};
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
export declare function LocalEdgeKit_createSupervisorHost(): LocalEdgeKit_SupervisorHost;
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
export declare function LocalEdgeKit_resolveAppPath(app: LocalEdgeKit_SupervisedApp, filePath: string): string;
/**
 * Validates supervisor apps: unique ids, required fields on enabled apps, unique local ports,
 * known dependencies, enabled apps depending only on enabled apps, and no cycles.
 *
 * @param apps - All configured apps.
 * @returns One line per problem; an empty list means valid. Never throws.
 * @example
 * ```typescript
 * LocalEdgeKit_validateSupervisedApps(config.apps); // [] or ["web: depends on unknown app \"db\""]
 * ```
 */
export declare function LocalEdgeKit_validateSupervisedApps(apps: readonly LocalEdgeKit_SupervisedApp[]): string[];
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
export declare function LocalEdgeKit_orderSupervisedApps(apps: readonly LocalEdgeKit_SupervisedApp[], requestedIds: readonly string[]): LocalEdgeKit_SupervisedApp[];
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
export declare function LocalEdgeKit_missingEnvNames(options: {
    envText: string | null;
    requiredNames: readonly string[];
}): string[];
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
export declare function LocalEdgeKit_listenerBelongsTo(options: {
    listener: number;
    pid: number;
    processGroup: number | null;
    host: LocalEdgeKit_SupervisorHost;
}): boolean;
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
export declare function LocalEdgeKit_readPidFile(host: LocalEdgeKit_SupervisorHost, filePath: string): number | null;
/**
 * Inspects one app by pid file, recorded identity and port check. Read-only: never writes or
 * signals.
 *
 * @param app - The app.
 * @param host - Supervisor host.
 * @returns `running`/`starting` only for a live process whose identity matches the recorded one;
 * `unverified` for a live pid without a recorded identity; `stale-pid` for a dead or recycled
 * pid; `port-busy` when the port is held by a process that is not ours.
 * @example
 * ```typescript
 * LocalEdgeKit_inspectSupervisedApp(app, host).state; // "running"
 * ```
 */
export declare function LocalEdgeKit_inspectSupervisedApp(app: LocalEdgeKit_SupervisedApp, host: LocalEdgeKit_SupervisorHost): LocalEdgeKit_SupervisedAppInspection;
/**
 * Probes an app's health path (and ready path, when set) on `127.0.0.1`.
 *
 * @param app - The app.
 * @param host - Supervisor host (HTTP through `host.httpStatus`).
 * @param timeoutMs - Per-request timeout. Default 3000.
 * @returns Per-path status; healthy when every path answers 2xx/3xx. Never throws.
 * @example
 * ```typescript
 * (await LocalEdgeKit_probeSupervisedAppHealth(app, host)).healthy;
 * ```
 */
export declare function LocalEdgeKit_probeSupervisedAppHealth(app: LocalEdgeKit_SupervisedApp, host: LocalEdgeKit_SupervisorHost, timeoutMs?: number): Promise<LocalEdgeKit_SupervisedAppHealth>;
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
export declare function LocalEdgeKit_waitForSupervisedAppReady(options: {
    app: LocalEdgeKit_SupervisedApp;
    host: LocalEdgeKit_SupervisorHost;
    logOffset: number;
    timeoutMs: number;
    pid?: number | undefined;
}): Promise<{
    ready: boolean;
    message: string;
}>;
/** Held per-app lock; `release` removes the lock file when this supervisor still owns it. */
export type LocalEdgeKit_SupervisorLock = {
    release(): void;
};
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
 *    guard `<guard>.takeover-<k>` (at most four levels deep).
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
export declare function LocalEdgeKit_acquireSupervisorLock(app: LocalEdgeKit_SupervisedApp, host: LocalEdgeKit_SupervisorHost): {
    lock: LocalEdgeKit_SupervisorLock;
} | {
    error: string;
};
/**
 * Starts the requested apps and their dependencies in order, adopting any that already run
 * (pid file process with a matching identity). Stops at the first failure; later apps are
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
export declare function LocalEdgeKit_supervisorUp(options: {
    apps: readonly LocalEdgeKit_SupervisedApp[];
    requestedIds: readonly string[];
    host: LocalEdgeKit_SupervisorHost;
    out: LocalEdgeKit_SupervisorWriter;
}): Promise<LocalEdgeKit_SupervisorStepResult[]>;
/**
 * Stops the requested apps, dependants first. Only a pid file process whose recorded identity
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
export declare function LocalEdgeKit_supervisorDown(options: {
    apps: readonly LocalEdgeKit_SupervisedApp[];
    requestedIds: readonly string[];
    host: LocalEdgeKit_SupervisorHost;
    out: LocalEdgeKit_SupervisorWriter;
}): LocalEdgeKit_SupervisorStepResult[];
/** One process to stop, with the identity it must still have when each signal is sent. */
export type LocalEdgeKit_SignalTarget = {
    pid: number;
    identity: LocalEdgeKit_ProcessIdentity;
};
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
export declare function LocalEdgeKit_terminateProcessGroup(options: {
    targets: readonly LocalEdgeKit_SignalTarget[];
    host: LocalEdgeKit_SupervisorHost;
    timeoutMs: number;
    out: LocalEdgeKit_SupervisorWriter;
}): void;
