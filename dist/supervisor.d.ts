/**
 * @fileoverview Generic app supervisor: start, stop, adopt, status, health and logs for a set of
 * loopback apps described by a project-owned config, each with a pid file and a log file.
 *
 * The supervisor never assumes it started a process. An app counts as running when its pid file
 * names a live process and the app's loopback port is held by a process in the same process
 * group, so processes started by someone else are adopted instead of started twice. A port held
 * by anything else is reported as busy and never killed. Stop signals the app's process group
 * (SIGTERM, then SIGKILL after a timeout) through the core runtime-stop helper.
 * Env checks read names only: values are never returned or printed.
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
export type LocalEdgeKit_SupervisedAppState = "running" | "starting" | "port-busy" | "stale-pid" | "stopped" | "disabled";
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
    writeText(filePath: string, text: string): void;
    removeFile(filePath: string): void;
    fileSize(filePath: string): number;
    pidIsAlive(pid: number): boolean;
    processGroupOf(pid: number): number | null;
    ownProcessGroup(): number | null;
    listenerPids(port: number): number[];
    kill(pid: number, signal: NodeJS.Signals | 0): void;
    httpStatus(url: string, timeoutMs: number): Promise<number | null>;
    spawnDetached(options: {
        cwd: string;
        command: string;
        args: readonly string[];
        logFile: string;
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
 * Sends SIGTERM to the process group of `pid`, waits up to `timeoutMs`, then SIGKILL.
 *
 * @remarks
 * When the pid shares the supervisor's own process group (it was not started detached), only the
 * pid itself is signalled so the supervisor never signals its own group.
 */
export declare function LocalEdgeKit_terminateProcessGroup(options: {
    pid: number;
    host: LocalEdgeKit_SupervisorHost;
    timeoutMs: number;
    out: LocalEdgeKit_SupervisorWriter;
}): void;
