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
export type LocalEdgeKit_SupervisedAppState = "running" | "starting" | "port-busy" | "stale-pid" | "stopped" | "disabled" | "external";
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
    /** Creates a folder (0700) inside `root`, refusing one that resolves outside. */
    ensureDir(dirPath: string, options: {
        root: string;
    }): void;
    /** Runs a short command to completion. Never through a shell. */
    runCommand(command: string, args: readonly string[]): {
        status: number | null;
        stdout: string;
        stderr: string;
    };
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
/** Real host effects. Spawned apps get their own process group and append to their log file. */
export declare function LocalEdgeKit_createSupervisorHost(): LocalEdgeKit_SupervisorHost;
/** Resolves an app path against its cwd. */
export declare function LocalEdgeKit_resolveAppPath(app: LocalEdgeKit_SupervisedApp, filePath: string): string;
/**
 * Validates supervisor apps: unique ids, required fields on enabled apps, known dependencies,
 * enabled apps depending only on enabled apps, and no cycles. Returns problems; empty is valid.
 */
export declare function LocalEdgeKit_validateSupervisedApps(apps: readonly LocalEdgeKit_SupervisedApp[]): string[];
/**
 * Returns the requested apps plus their dependencies, dependencies first.
 *
 * @throws When an id is unknown or the dependency graph has a cycle.
 */
export declare function LocalEdgeKit_orderSupervisedApps(apps: readonly LocalEdgeKit_SupervisedApp[], requestedIds: readonly string[]): LocalEdgeKit_SupervisedApp[];
/**
 * Lists which required env names are absent or empty in an env file. Only names are returned;
 * values are read to test emptiness and then dropped.
 */
export declare function LocalEdgeKit_missingEnvNames(options: {
    envText: string | null;
    requiredNames: readonly string[];
}): string[];
/**
 * True when `listener` belongs to the process tree started by `pid`: it is `pid`, shares its
 * process group, or has `pid` among its ancestors. Dev servers often move their server into a
 * child process group, so the group check alone is not enough.
 */
export declare function LocalEdgeKit_listenerBelongsTo(options: {
    listener: number;
    pid: number;
    processGroup: number | null;
    host: LocalEdgeKit_SupervisorHost;
}): boolean;
/** Reads a pid file and returns a positive integer pid, or null. */
export declare function LocalEdgeKit_readPidFile(host: LocalEdgeKit_SupervisorHost, filePath: string): number | null;
/** Inspects one app by pid file plus port check. Read-only. */
export declare function LocalEdgeKit_inspectSupervisedApp(app: LocalEdgeKit_SupervisedApp, host: LocalEdgeKit_SupervisorHost): LocalEdgeKit_SupervisedAppInspection;
/** Probes an app's health path (and ready path, when set) on loopback. */
export declare function LocalEdgeKit_probeSupervisedAppHealth(app: LocalEdgeKit_SupervisedApp, host: LocalEdgeKit_SupervisorHost, timeoutMs?: number): Promise<LocalEdgeKit_SupervisedAppHealth>;
/** Waits until the app is healthy (and its ready log line appeared after `logOffset`). */
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
/**
 * Starts the requested apps and their dependencies in order, adopting any that already run.
 * Stops at the first failure; later apps are reported as skipped.
 */
export declare function LocalEdgeKit_supervisorUp(options: {
    apps: readonly LocalEdgeKit_SupervisedApp[];
    requestedIds: readonly string[];
    host: LocalEdgeKit_SupervisorHost;
    out: LocalEdgeKit_SupervisorWriter;
}): Promise<LocalEdgeKit_SupervisorStepResult[]>;
/**
 * Stops the requested apps, dependants first. Only processes named by the app's pid file are
 * signalled; a foreign listener on the port is never touched.
 */
export declare function LocalEdgeKit_supervisorDown(options: {
    apps: readonly LocalEdgeKit_SupervisedApp[];
    requestedIds: readonly string[];
    host: LocalEdgeKit_SupervisorHost;
    out: LocalEdgeKit_SupervisorWriter;
}): LocalEdgeKit_SupervisorStepResult[];
/**
 * Sends SIGTERM to the process group of `pid` (and of each `extraPids` entry, such as an owned
 * listener in a child group), waits up to `timeoutMs`, then SIGKILL.
 *
 * @remarks
 * A process that shares the supervisor's own process group is signalled by pid only, so the
 * supervisor never signals its own group.
 */
export declare function LocalEdgeKit_terminateProcessGroup(options: {
    pid: number;
    extraPids?: readonly number[] | undefined;
    host: LocalEdgeKit_SupervisorHost;
    timeoutMs: number;
    out: LocalEdgeKit_SupervisorWriter;
}): void;
