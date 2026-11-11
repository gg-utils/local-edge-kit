/**
 * @fileoverview Owns config-driven runtime-launch planning and execution helpers for local-edge kit
 * consumers: URL matrices, overlays, `concurrently` argv, subprocess helpers, and the full launch
 * pipeline entrypoint.
 *
 * The kit resolves startup URL matrix entries, direct upstream rows, dev overlays, helper commands,
 * dependency reports, `concurrently` argv, and reusable subprocess execution helpers from
 * consumer-authored config without knowing the consumer's app names, paths, or root zone. Runtime
 * launchers can use these helpers to print and execute operator-facing plans without hardcoding
 * surface route tables, process catalogs, or child-process boilerplate.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/runtime-launch.unit.test.ts
 * @testing CLI: npm run test --prefix packages/local-edge-kit
 *
 * @see packages/local-edge-kit/src/config.ts - Declares `runtimeLaunch`, surface tables, and env names this module reads when building plans, argv, and subprocess command lines.
 * @see packages/local-edge-kit/src/runtime-config.ts - Resolves per-method runtime routing inputs (listen ports, realm, developer slug, root zone) consumed for surface hosts and env exports.
 * @see consumer local-edge adapter - Root-repo launcher script that wires argv, filesystem hooks, and env loading into `LocalEdgeKit_runRuntimeLaunchPipeline`.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - Authority for file-overview tag order, root-relative `@see` paths, and `@documentation` metadata enforced on this header.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { type ChildProcess } from "node:child_process";
import type { LocalEdgeKit_Config } from "./config.js";
import { type LocalEdgeKit_RuntimeConfig } from "./runtime-config.js";
/** One app/status URL pair for a runtime-launch startup matrix. */
export type LocalEdgeKit_RuntimeLaunchSurfaceUrl = {
    appPath: string;
    appUrl: string;
    host: string;
    method: string;
    statusPath: string;
    statusUrl: string;
    surfaceId: string;
};
/** Options for resolving runtime-launch startup URL matrix rows from config/env. */
export type LocalEdgeKit_BuildRuntimeLaunchSurfaceUrlsOptions = {
    commandLabel?: string;
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    method?: string;
    projectRoot?: string | null | undefined;
};
/** Dependencies read from a package manifest for runtime-launch install checks. */
export type LocalEdgeKit_RuntimeLaunchPackageDependencies = {
    dependencyNames: readonly string[];
};
/** File-system hooks used by runtime-launch helpers to stay testable and side-effect explicit. */
export type LocalEdgeKit_RuntimeLaunchFilesystem = {
    exists: (filePath: string) => boolean;
    readText: (filePath: string) => string;
};
/** Optional process skipped from a config-driven runtime-launch concurrently plan. */
export type LocalEdgeKit_RuntimeLaunchSkippedProcess = {
    id: string;
    logLines: readonly string[];
};
/** Config-driven `concurrently` arguments and diagnostics for a runtime launch. */
export type LocalEdgeKit_RuntimeLaunchConcurrentlyArgsPlan = {
    concurrentArgs: readonly string[];
    missingCommandProcessIds: readonly string[];
    skippedProcesses: readonly LocalEdgeKit_RuntimeLaunchSkippedProcess[];
};
/** One direct localhost/upstream URL row printed by runtime launch. */
export type LocalEdgeKit_RuntimeLaunchDirectUpstreamUrl = {
    label: string;
    url: string;
};
/** Direct upstream URL rows plus configuration errors for runtime launch. */
export type LocalEdgeKit_RuntimeLaunchDirectUpstreamUrlPlan = {
    missingPortSurfaceIds: readonly string[];
    missingSurfaceIds: readonly string[];
    rows: readonly LocalEdgeKit_RuntimeLaunchDirectUpstreamUrl[];
};
/** One resolved generated env overlay consumed by runtime-launch dev processes. */
export type LocalEdgeKit_RuntimeLaunchDevOverlayEntry = {
    appName: string;
    envFileList: string;
    exists: boolean;
    id: string;
    logLabel: string;
    overlayFile: string;
    packageRoot: string;
    required: boolean;
};
/** Resolved generated env overlay plan and adapter log diagnostics. */
export type LocalEdgeKit_RuntimeLaunchDevOverlayPlan = {
    entries: readonly LocalEdgeKit_RuntimeLaunchDevOverlayEntry[];
    missingRequiredLogLines: readonly string[];
    overlayLogLines: readonly string[];
};
/** Resolved runtime-launch process command catalog passed into `concurrently` planning. */
export type LocalEdgeKit_RuntimeLaunchProcessCommandsPlan = {
    errorLogLines: readonly string[];
    processCommands: Readonly<Record<string, string>>;
};
/** Optional detached open-on-start helper plan for runtime launch. */
export type LocalEdgeKit_RuntimeLaunchOpenOnStartPlan = {
    command: LocalEdgeKit_RuntimeLaunchCommandPlan | null;
    enabled: boolean;
    envOverrides: Readonly<Record<string, string>>;
    missingCommandWarning: string | null;
    requiredCommand: string | null;
    startLogLine: string | null;
};
/** Cleanup subprocesses adapters should run when runtime launch exits. */
export type LocalEdgeKit_RuntimeLaunchCleanupPlan = {
    platformStopCommand: LocalEdgeKit_RuntimeLaunchCommandPlan | null;
    realmInactiveCommand: LocalEdgeKit_RuntimeLaunchCommandPlan | null;
};
/** Subprocess command plan returned to runtime-launch adapters for execution. */
export type LocalEdgeKit_RuntimeLaunchCommandPlan = {
    args: readonly string[];
    command: string;
};
/** Normalized synchronous command outcome for runtime-launch execution helpers. */
export type LocalEdgeKit_RuntimeLaunchCommandResult = {
    signal: NodeJS.Signals | null;
    status: number | null;
    succeeded: boolean;
};
/** Result returned by synchronous runtime-launch phase executors. */
export type LocalEdgeKit_RuntimeLaunchPhaseResult = {
    exitCode: number | null;
};
/** Result returned by workspace registration phase execution. */
export type LocalEdgeKit_RuntimeLaunchWorkspaceRegistrationPhaseResult = LocalEdgeKit_RuntimeLaunchPhaseResult & {
    registeredRealmSlug: string | null;
};
/** Result returned by background-helper startup phases. */
export type LocalEdgeKit_RuntimeLaunchPidPhaseResult = LocalEdgeKit_RuntimeLaunchPhaseResult & {
    pid: string;
};
/** Workspace registration command/log/env plan for runtime launch. */
export type LocalEdgeKit_RuntimeLaunchWorkspaceRegistrationPlan = {
    command: LocalEdgeKit_RuntimeLaunchCommandPlan | null;
    envOverrides: Readonly<Record<string, string>>;
    failureLogLine: string | null;
    logFile: string | null;
    realmSlug: string;
    startLogLine: string | null;
};
/** Shared artifact render command/log plan for runtime launch. */
export type LocalEdgeKit_RuntimeLaunchRenderArtifactsPlan = {
    command: LocalEdgeKit_RuntimeLaunchCommandPlan | null;
    failureLogLine: string | null;
    logFile: string | null;
};
/** Infrastructure ensure command plan for runtime launch. */
export type LocalEdgeKit_RuntimeLaunchEnsureInfrastructurePlan = {
    command: LocalEdgeKit_RuntimeLaunchCommandPlan | null;
    logLines: readonly string[];
};
/** SIGINT runtime-stop shell command plan for runtime launch. */
export type LocalEdgeKit_RuntimeLaunchSigintStopPlan = {
    command: LocalEdgeKit_RuntimeLaunchCommandPlan | null;
};
/** Resolved runtime-launch env file and generated-path plan. */
export type LocalEdgeKit_RuntimeLaunchEnvironmentPlan = {
    envFile: string;
    envFileLoadLogEnabled: boolean;
    envFileLoadedLogLine: string | null;
    generatedEnvDir: string;
    logDir: string;
    machineRoot: string;
    shouldLoadEnvFile: boolean;
};
/** Resolved split-mode and paired upstream port env overrides. */
export type LocalEdgeKit_RuntimeLaunchSplitUpstreamPortsPlan = {
    envOverrides: Readonly<Record<string, string>>;
    primaryPort: number | null;
    secondaryPort: number | null;
    splitModeEnabled: boolean;
};
/** Runtime-launch process env override plan. */
export type LocalEdgeKit_RuntimeLaunchHostOverridePlan = {
    envName: string | null;
    logLine: string | null;
    value: string | null;
};
/** Runtime-launch handoff/delegation command plan. */
export type LocalEdgeKit_RuntimeLaunchDelegationPlan = {
    command: LocalEdgeKit_RuntimeLaunchCommandPlan | null;
    startLogLine: string | null;
};
/** Rendered startup URL report lines and config errors. */
export type LocalEdgeKit_RuntimeLaunchStartupReportPlan = {
    errorLogLines: readonly string[];
    logLines: readonly string[];
};
/** Runtime audit plan returned to adapters without executing subprocesses. */
export type LocalEdgeKit_RuntimeLaunchRuntimeAuditPlan = {
    dnsAuditCommand: LocalEdgeKit_RuntimeLaunchCommandPlan | null;
    enabled: boolean;
    logLines: readonly string[];
    method: string;
    statusCommand: LocalEdgeKit_RuntimeLaunchCommandPlan | null;
    strict: boolean;
    warningLines: readonly string[];
};
/** Background health monitor plan returned to adapters without starting the monitor. */
export type LocalEdgeKit_RuntimeLaunchBackgroundHealthPlan = {
    command: LocalEdgeKit_RuntimeLaunchCommandPlan | null;
    enabled: boolean;
    logFile: string | null;
    logLines: readonly string[];
    method: string;
    strict: boolean;
    warningLines: readonly string[];
};
/** Active env watcher plan returned to adapters without starting the watcher. */
export type LocalEdgeKit_RuntimeLaunchActiveEnvWatcherPlan = {
    command: LocalEdgeKit_RuntimeLaunchCommandPlan | null;
    enabled: boolean;
    envOverrides: Readonly<Record<string, string>>;
    logFile: string | null;
    logLines: readonly string[];
};
/** One dependency-check failure detected before runtime launch. */
export type LocalEdgeKit_RuntimeLaunchDependencyCheckFailure = {
    id: string;
    missingDependencyNames: readonly string[];
    packageRelativePath: string;
    packageRoot: string;
};
/** Rendered dependency-check outcome for adapter logging and exit-code handling. */
export type LocalEdgeKit_RuntimeLaunchDependencyCheckReport = {
    exitCode: number;
    failures: readonly LocalEdgeKit_RuntimeLaunchDependencyCheckFailure[];
    logLines: readonly string[];
    skipped: boolean;
};
/** POSIX shell-safe single-quote escaping for runtime command previews. */
export declare function LocalEdgeKit_shellQuoteSingle(value: string): string;
/** Checks whether a runtime-launch subprocess command is available on `PATH`. */
export declare function LocalEdgeKit_checkRuntimeLaunchCommandAvailable(options: {
    name: string;
}): boolean;
/** Prints the tail of a runtime-launch diagnostic log to the parent stderr/stdout streams. */
export declare function LocalEdgeKit_tailRuntimeLaunchLogToStderr(options: {
    lines: number;
    logPath: string;
}): void;
/** Converts Node child-process exit metadata into shell-compatible exit codes. */
export declare function LocalEdgeKit_runtimeLaunchExitCodeFromChildProcessEvent(code: number | null, signal: NodeJS.Signals | null): number;
/** Parses a captured child PID string, returning null for empty or invalid values. */
export declare function LocalEdgeKit_parseRuntimeLaunchChildPid(pidStr: string): number | null;
/** Best-effort SIGTERM teardown for background runtime-launch helper PIDs. */
export declare function LocalEdgeKit_tryTerminateRuntimeLaunchChildPid(options: {
    label: string;
    logLine?: ((line: string) => void) | undefined;
    pidStr: string;
}): boolean;
/** Runs one planned runtime-launch command synchronously. */
export declare function LocalEdgeKit_runRuntimeLaunchCommandSync(options: {
    command: LocalEdgeKit_RuntimeLaunchCommandPlan;
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "ignore" | "inherit";
}): LocalEdgeKit_RuntimeLaunchCommandResult;
/** Runs a planned command with stdout/stderr appended to a runtime-launch log file. */
export declare function LocalEdgeKit_runRuntimeLaunchLoggedCommandSync(options: {
    command: LocalEdgeKit_RuntimeLaunchCommandPlan;
    cwd: string;
    env: NodeJS.ProcessEnv;
    failureLogLine: string;
    logFile: string;
    tailLines: number;
}): LocalEdgeKit_RuntimeLaunchCommandResult;
/** Spawns a runtime-launch helper and tees stdout/stderr to a persistent log file. */
export declare function LocalEdgeKit_spawnRuntimeLaunchCommandWithTee(options: {
    command: LocalEdgeKit_RuntimeLaunchCommandPlan;
    cwd: string;
    env: NodeJS.ProcessEnv;
    logFile: string;
}): ChildProcess;
/** Starts an optional detached runtime-launch helper without keeping the launcher open. */
export declare function LocalEdgeKit_spawnRuntimeLaunchDetachedCommand(options: {
    command: LocalEdgeKit_RuntimeLaunchCommandPlan;
    cwd: string;
    env: NodeJS.ProcessEnv;
    envOverrides?: Readonly<Record<string, string>>;
}): void;
/** Spawns `npx concurrently` and resolves to a normalized runtime-launch exit code. */
export declare function LocalEdgeKit_waitForRuntimeLaunchConcurrentlyExit(options: {
    concurrentArgs: readonly string[];
    env: NodeJS.ProcessEnv;
    projectRoot: string;
}): Promise<number>;
/** Runs the optional delegation phase and returns the child exit code when it delegated. */
export declare function LocalEdgeKit_runRuntimeLaunchDelegationPhase(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    logLine?: ((line: string) => void) | undefined;
    pathExists: (filePath: string) => boolean;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPhaseResult;
/** Runs workspace registration and reports the realm slug registered for cleanup. */
export declare function LocalEdgeKit_runRuntimeLaunchWorkspaceRegistrationPhase(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    logLine?: ((line: string) => void) | undefined;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchWorkspaceRegistrationPhaseResult;
/** Runs shared render-artifact generation and returns a process-style exit request on failure. */
export declare function LocalEdgeKit_runRuntimeLaunchRenderArtifactsPhase(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPhaseResult;
/** Runs infrastructure ensure command planning and execution for runtime launch. */
export declare function LocalEdgeKit_runRuntimeLaunchEnsureInfrastructurePhase(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    logLine?: ((line: string) => void) | undefined;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPhaseResult;
/** Runs optional runtime status/DNS audit and returns strict-mode failure exit codes. */
export declare function LocalEdgeKit_runRuntimeLaunchRuntimeAuditPhase(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    fallbackMethod: string;
    logLine?: ((line: string) => void) | undefined;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPhaseResult;
/** Prints the startup URL report and returns exit code 1 when config errors are present. */
export declare function LocalEdgeKit_runRuntimeLaunchStartupReportPhase(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    errorLine?: (line: string) => void;
    logLine?: ((line: string) => void) | undefined;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPhaseResult;
/** Starts the optional background health monitor and returns its child PID string. */
export declare function LocalEdgeKit_startRuntimeLaunchBackgroundHealthPhase(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    fallbackMethod: string;
    fallbackRealm: string;
    logDir: string;
    logLine?: ((line: string) => void) | undefined;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPidPhaseResult;
/** Starts the optional active-realm env watcher and returns its child PID string. */
export declare function LocalEdgeKit_startRuntimeLaunchActiveEnvWatcherPhase(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    logDir: string;
    logLine?: ((line: string) => void) | undefined;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPidPhaseResult;
/** Applies the configured process env host override in place. */
export declare function LocalEdgeKit_applyRuntimeLaunchHostOverridePhase(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    logLine?: ((line: string) => void) | undefined;
}): void;
/** Runs dependency preflight and returns its configured exit code. */
export declare function LocalEdgeKit_runRuntimeLaunchDependencyCheckPhase(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    filesystem: LocalEdgeKit_RuntimeLaunchFilesystem;
    logLine?: ((line: string) => void) | undefined;
    repoRoot: string;
}): LocalEdgeKit_RuntimeLaunchPhaseResult;
/** Runs idempotent runtime-launch cleanup helpers for background PIDs and realm state. */
export declare function LocalEdgeKit_runRuntimeLaunchCleanupPhase(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    healthPid: string;
    logLine?: ((line: string) => void) | undefined;
    pathExists: (filePath: string) => boolean;
    projectRoot: string;
    registeredRealmSlug: string | null;
    watcherPid: string;
}): void;
/** Builds dev overlays, optional helpers, and `concurrently` argv before launching app processes. */
export declare function LocalEdgeKit_runRuntimeLaunchPlatformWithOverlaysPhase(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    errorLine?: (line: string) => void;
    generatedEnvDir: string;
    logLine?: ((line: string) => void) | undefined;
    machineRoot: string;
    method: string;
    pathExists: (filePath: string) => boolean;
    projectRoot: string;
}): Promise<number>;
/** Sends SIGINT to configured checkout-scoped app processes during runtime-launch shutdown. */
export declare function LocalEdgeKit_runRuntimeLaunchSigintStopPhase(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    projectRoot: string;
}): void;
/** Runs the full runtime-launch pipeline around project-provided config and env loading. */
export declare function LocalEdgeKit_runRuntimeLaunchPipeline(options: {
    argv: readonly string[];
    config: LocalEdgeKit_Config;
    defaultProjectRoot: string;
    env: NodeJS.ProcessEnv;
    filesystem: LocalEdgeKit_RuntimeLaunchFilesystem;
    loadEnvFile: (envFile: string) => void;
}): Promise<number>;
/** Builds an `npm run dev --prefix <folder>` command with shell-escaped env assignments. */
export declare function LocalEdgeKit_buildRuntimeLaunchNpmDevShellCommand(options: {
    envExports: Readonly<Record<string, string>>;
    prefixFolder: string;
}): string;
/** Resolves the active realm-specific overlay path, falling back to generated env output. */
export declare function LocalEdgeKit_resolveRuntimeLaunchOverlayPath(options: {
    appName: string;
    env: NodeJS.ProcessEnv;
    generatedEnvDir: string;
    machineRoot: string;
    pathExists: (filePath: string) => boolean;
}): string;
/** Builds the ordered colon-delimited env-file list consumed by package dev processes. */
export declare function LocalEdgeKit_buildRuntimeLaunchPackageEnvFileList(options: {
    config: LocalEdgeKit_Config;
    overlayFile: string;
    packageRoot: string;
}): string;
/** Parses dependency and devDependency names from a package manifest. */
export declare function LocalEdgeKit_readRuntimeLaunchPackageDependencyNames(packageJsonText: string): string[];
/** Finds package dependencies missing from both package-local and root `node_modules`. */
export declare function LocalEdgeKit_findMissingRuntimeLaunchNpmDeps(options: {
    config: LocalEdgeKit_Config;
    filesystem: LocalEdgeKit_RuntimeLaunchFilesystem;
    packageRoot: string;
    repoRoot: string;
}): string[];
/** Builds direct upstream URL rows from configured surfaces and their upstream port env/defaults. */
export declare function LocalEdgeKit_buildRuntimeLaunchDirectUpstreamUrls(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    host: string;
}): LocalEdgeKit_RuntimeLaunchDirectUpstreamUrlPlan;
/** Resolves env overlay paths, package env-file lists, and required-overlay diagnostics. */
export declare function LocalEdgeKit_buildRuntimeLaunchDevOverlayPlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    generatedEnvDir: string;
    machineRoot: string;
    pathExists: (filePath: string) => boolean;
    projectRoot: string;
    splitModeEnabled: boolean;
}): LocalEdgeKit_RuntimeLaunchDevOverlayPlan;
/** Returns one overlay plan entry by id or throws when config and adapter ids drift. */
export declare function LocalEdgeKit_requireRuntimeLaunchDevOverlayEntry(options: {
    id: string;
    plan: LocalEdgeKit_RuntimeLaunchDevOverlayPlan;
}): LocalEdgeKit_RuntimeLaunchDevOverlayEntry;
/** Builds runtime-launch process commands from config, overlays, surfaces, and env. */
export declare function LocalEdgeKit_buildRuntimeLaunchProcessCommandsPlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    method: string;
    overlayPlan: LocalEdgeKit_RuntimeLaunchDevOverlayPlan;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchProcessCommandsPlan;
/** Plans an optional detached open-on-start helper without executing it. */
export declare function LocalEdgeKit_buildRuntimeLaunchOpenOnStartPlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    overlayPlan: LocalEdgeKit_RuntimeLaunchDevOverlayPlan;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchOpenOnStartPlan;
/** Plans cleanup subprocesses without executing them. */
export declare function LocalEdgeKit_buildRuntimeLaunchCleanupPlan(options: {
    config: LocalEdgeKit_Config;
    pathExists?: (filePath: string) => boolean;
    projectRoot: string;
    realmSlug: string | null;
}): LocalEdgeKit_RuntimeLaunchCleanupPlan;
/** Plans root-workspace realm registration without executing the command. */
export declare function LocalEdgeKit_buildRuntimeLaunchWorkspaceRegistrationPlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchWorkspaceRegistrationPlan;
/** Plans shared local-edge artifact rendering without executing the command. */
export declare function LocalEdgeKit_buildRuntimeLaunchRenderArtifactsPlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchRenderArtifactsPlan;
/** Plans the infrastructure ensure command without executing it. */
export declare function LocalEdgeKit_buildRuntimeLaunchEnsureInfrastructurePlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchEnsureInfrastructurePlan;
/** Plans the SIGINT runtime-stop shell command without executing it. */
export declare function LocalEdgeKit_buildRuntimeLaunchSigintStopPlan(options: {
    config: LocalEdgeKit_Config;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchSigintStopPlan;
/** Plans runtime-launch env file loading and generated/log paths without loading files. */
export declare function LocalEdgeKit_buildRuntimeLaunchEnvironmentPlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    pathExists: (filePath: string) => boolean;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchEnvironmentPlan;
/** Resolves split-mode and paired upstream port env overrides from config/env. */
export declare function LocalEdgeKit_buildRuntimeLaunchSplitUpstreamPortsPlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
}): LocalEdgeKit_RuntimeLaunchSplitUpstreamPortsPlan;
/** Plans one runtime process env override without mutating process.env. */
export declare function LocalEdgeKit_buildRuntimeLaunchHostOverridePlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
}): LocalEdgeKit_RuntimeLaunchHostOverridePlan;
/** Plans an alternate runtime-launch delegation command without executing it. */
export declare function LocalEdgeKit_buildRuntimeLaunchDelegationPlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    pathExists: (filePath: string) => boolean;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchDelegationPlan;
/** Builds the startup URL report without writing to stdout/stderr. */
export declare function LocalEdgeKit_buildRuntimeLaunchStartupReportPlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchStartupReportPlan;
/** Plans runtime status and DNS audit subprocesses from config/env without executing them. */
export declare function LocalEdgeKit_buildRuntimeLaunchRuntimeAuditPlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    fallbackMethod: string;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchRuntimeAuditPlan;
/** Plans the runtime-launch background health monitor without starting it. */
export declare function LocalEdgeKit_buildRuntimeLaunchBackgroundHealthPlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    fallbackMethod: string;
    fallbackRealm: string;
    logDir: string;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchBackgroundHealthPlan;
/** Plans the active realm env watcher without starting it. */
export declare function LocalEdgeKit_buildRuntimeLaunchActiveEnvWatcherPlan(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    logDir: string;
    projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchActiveEnvWatcherPlan;
/** Builds a dependency-check report for configured runtime-launch packages. */
export declare function LocalEdgeKit_buildRuntimeLaunchDependencyCheckReport(options: {
    config: LocalEdgeKit_Config;
    env: NodeJS.ProcessEnv;
    filesystem: LocalEdgeKit_RuntimeLaunchFilesystem;
    repoRoot: string;
}): LocalEdgeKit_RuntimeLaunchDependencyCheckReport;
/** Builds config-ordered `concurrently` args for the active runtime split mode. */
export declare function LocalEdgeKit_buildRuntimeLaunchConcurrentlyArgsPlan(options: {
    config: LocalEdgeKit_Config;
    pathExists: (filePath: string) => boolean;
    processCommands: Readonly<Record<string, string>>;
    projectRoot: string;
    splitModeEnabled: boolean;
}): LocalEdgeKit_RuntimeLaunchConcurrentlyArgsPlan;
/** Builds the canonical local-edge host for one configured runtime surface. */
export declare function LocalEdgeKit_buildRuntimeLaunchSurfaceHost(options: {
    method: string;
    runtimeConfig: LocalEdgeKit_RuntimeConfig;
    surfaceId: string;
}): string;
/** Resolves app/status URL rows for the configured startup URL surface set. */
export declare function LocalEdgeKit_buildRuntimeLaunchSurfaceUrls(options: LocalEdgeKit_BuildRuntimeLaunchSurfaceUrlsOptions): LocalEdgeKit_RuntimeLaunchSurfaceUrl[];
