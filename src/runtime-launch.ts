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

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  createWriteStream,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  LocalEdgeCore_formatHttpsUrl,
  LocalEdgeCore_isTruthy,
  LocalEdgeCore_normalizeMachineRootDir,
} from "@gg-utils/local-edge-core";

import type {
  LocalEdgeKit_Config,
  LocalEdgeKit_RuntimeLaunchProcessCommandEnvExportConfig,
  LocalEdgeKit_SurfaceConfig,
} from "./config.js";
import {
  LocalEdgeKit_getRuntimeMethod,
  LocalEdgeKit_resolveRuntimeConfig,
  type LocalEdgeKit_RuntimeConfig,
} from "./runtime-config.js";

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
  env?: NodeJS.ProcessEnv;
  method?: string;
  projectRoot?: string | null;
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
export type LocalEdgeKit_RuntimeLaunchWorkspaceRegistrationPhaseResult =
  LocalEdgeKit_RuntimeLaunchPhaseResult & {
    registeredRealmSlug: string | null;
  };

/** Result returned by background-helper startup phases. */
export type LocalEdgeKit_RuntimeLaunchPidPhaseResult =
  LocalEdgeKit_RuntimeLaunchPhaseResult & {
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

const LOCAL_EDGE_KIT_RUNTIME_LAUNCH_DEFAULT_PACKAGE_ENV_FILE_NAMES: readonly string[] =
  [".env", ".env.local", ".env.development", ".env.development.local"];

/** POSIX shell-safe single-quote escaping for runtime command previews. */
export function LocalEdgeKit_shellQuoteSingle(value: string): string {
  if (value === "") {
    return "''";
  }
  const escapedSingleQuote = `'\"'\"''`;
  return `'${value.replace(/'/g, escapedSingleQuote)}'`;
}

/** Checks whether a runtime-launch subprocess command is available on `PATH`. */
export function LocalEdgeKit_checkRuntimeLaunchCommandAvailable(options: {
  name: string;
}): boolean {
  const result = spawnSync(
    "bash",
    ["-c", `command -v ${LocalEdgeKit_shellQuoteSingle(options.name)}`],
    {
      stdio: "ignore",
    },
  );
  return result.status === 0;
}

/** Prints the tail of a runtime-launch diagnostic log to the parent stderr/stdout streams. */
export function LocalEdgeKit_tailRuntimeLaunchLogToStderr(options: {
  lines: number;
  logPath: string;
}): void {
  spawnSync("tail", ["-n", String(options.lines), options.logPath], {
    stdio: "inherit",
  });
}

/** Converts Node child-process exit metadata into shell-compatible exit codes. */
export function LocalEdgeKit_runtimeLaunchExitCodeFromChildProcessEvent(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (typeof code === "number") {
    return code;
  }
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 1;
}

/** Parses a captured child PID string, returning null for empty or invalid values. */
export function LocalEdgeKit_parseRuntimeLaunchChildPid(
  pidStr: string,
): number | null {
  if (pidStr.length === 0) {
    return null;
  }
  const pid = Number.parseInt(pidStr, 10);
  return Number.isFinite(pid) ? pid : null;
}

/** Best-effort SIGTERM teardown for background runtime-launch helper PIDs. */
export function LocalEdgeKit_tryTerminateRuntimeLaunchChildPid(options: {
  label: string;
  logLine?: (line: string) => void;
  pidStr: string;
}): boolean {
  const pid = LocalEdgeKit_parseRuntimeLaunchChildPid(options.pidStr);
  if (pid === null) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  const logLine = options.logLine ?? console.log;
  logLine(`[local] Stopping ${options.label} (pid=${options.pidStr})...`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  spawnSync("bash", ["-c", `wait ${String(pid)} 2>/dev/null || true`], {
    stdio: "ignore",
  });
  return true;
}

/** Runs one planned runtime-launch command synchronously. */
export function LocalEdgeKit_runRuntimeLaunchCommandSync(options: {
  command: LocalEdgeKit_RuntimeLaunchCommandPlan;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: "ignore" | "inherit";
}): LocalEdgeKit_RuntimeLaunchCommandResult {
  const result = spawnSync(options.command.command, [...options.command.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio,
  });
  return {
    signal: result.signal,
    status: result.status,
    succeeded: result.status === 0,
  };
}

/** Runs a planned command with stdout/stderr appended to a runtime-launch log file. */
export function LocalEdgeKit_runRuntimeLaunchLoggedCommandSync(options: {
  command: LocalEdgeKit_RuntimeLaunchCommandPlan;
  cwd: string;
  env: NodeJS.ProcessEnv;
  failureLogLine: string;
  logFile: string;
  tailLines: number;
}): LocalEdgeKit_RuntimeLaunchCommandResult {
  mkdirSync(path.dirname(options.logFile), { recursive: true });
  const fd = openSync(options.logFile, "a");
  try {
    const result = spawnSync(
      options.command.command,
      [...options.command.args],
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", fd, fd],
      },
    );
    const commandResult = {
      signal: result.signal,
      status: result.status,
      succeeded: result.status === 0,
    };
    if (!commandResult.succeeded) {
      console.error(options.failureLogLine);
      LocalEdgeKit_tailRuntimeLaunchLogToStderr({
        lines: options.tailLines,
        logPath: options.logFile,
      });
    }
    return commandResult;
  } finally {
    closeSync(fd);
  }
}

/** Spawns a runtime-launch helper and tees stdout/stderr to a persistent log file. */
export function LocalEdgeKit_spawnRuntimeLaunchCommandWithTee(options: {
  command: LocalEdgeKit_RuntimeLaunchCommandPlan;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
}): ChildProcess {
  mkdirSync(path.dirname(options.logFile), { recursive: true });
  writeFileSync(options.logFile, "", { flag: "a" });
  const logStream = createWriteStream(options.logFile, { flags: "a" });
  const child = spawn(options.command.command, [...options.command.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    logStream.write(chunk);
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logStream.write(chunk);
    process.stderr.write(chunk);
  });
  child.on("exit", () => {
    logStream.end();
  });
  child.on("error", () => {
    logStream.end();
  });
  return child;
}

/** Starts an optional detached runtime-launch helper without keeping the launcher open. */
export function LocalEdgeKit_spawnRuntimeLaunchDetachedCommand(options: {
  command: LocalEdgeKit_RuntimeLaunchCommandPlan;
  cwd: string;
  env: NodeJS.ProcessEnv;
  envOverrides?: Readonly<Record<string, string>>;
}): void {
  spawn(options.command.command, [...options.command.args], {
    cwd: options.cwd,
    detached: true,
    env: { ...options.env, ...(options.envOverrides ?? {}) },
    stdio: "ignore",
  }).unref();
}

/** Spawns `npx concurrently` and resolves to a normalized runtime-launch exit code. */
export async function LocalEdgeKit_waitForRuntimeLaunchConcurrentlyExit(options: {
  concurrentArgs: readonly string[];
  env: NodeJS.ProcessEnv;
  projectRoot: string;
}): Promise<number> {
  const concurrentlyProc = spawn(
    "npx",
    ["concurrently", ...options.concurrentArgs],
    {
      cwd: options.projectRoot,
      env: options.env,
      shell: false,
      stdio: "inherit",
    },
  );
  const [code, signal] = await once(concurrentlyProc, "exit");
  const exitCode = typeof code === "number" ? code : null;
  const exitSignal =
    signal === "SIGINT" || signal === "SIGTERM" ? signal : null;
  return LocalEdgeKit_runtimeLaunchExitCodeFromChildProcessEvent(
    exitCode,
    exitSignal,
  );
}

/** Runs the optional delegation phase and returns the child exit code when it delegated. */
export function LocalEdgeKit_runRuntimeLaunchDelegationPhase(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  logLine?: (line: string) => void;
  pathExists: (filePath: string) => boolean;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPhaseResult {
  const delegationPlan = LocalEdgeKit_buildRuntimeLaunchDelegationPlan({
    config: options.config,
    env: options.env,
    pathExists: options.pathExists,
    projectRoot: options.projectRoot,
  });
  if (delegationPlan.command === null) {
    return {
      exitCode: null,
    };
  }
  LocalEdgeKit_logRuntimeLaunchLine(
    options.logLine,
    delegationPlan.startLogLine,
  );
  const result = LocalEdgeKit_runRuntimeLaunchCommandSync({
    command: delegationPlan.command,
    cwd: options.projectRoot,
    env: options.env,
    stdio: "inherit",
  });
  return {
    exitCode: result.status ?? 1,
  };
}

/** Runs workspace registration and reports the realm slug registered for cleanup. */
export function LocalEdgeKit_runRuntimeLaunchWorkspaceRegistrationPhase(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  logLine?: (line: string) => void;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchWorkspaceRegistrationPhaseResult {
  const registrationPlan =
    LocalEdgeKit_buildRuntimeLaunchWorkspaceRegistrationPlan({
      config: options.config,
      env: options.env,
      projectRoot: options.projectRoot,
    });
  if (
    registrationPlan.command === null ||
    registrationPlan.logFile === null ||
    registrationPlan.failureLogLine === null
  ) {
    return {
      exitCode: null,
      registeredRealmSlug: null,
    };
  }

  LocalEdgeKit_logRuntimeLaunchLine(
    options.logLine,
    registrationPlan.startLogLine,
  );
  const result = LocalEdgeKit_runRuntimeLaunchLoggedCommandSync({
    command: registrationPlan.command,
    cwd: options.projectRoot,
    env: { ...options.env, ...registrationPlan.envOverrides },
    failureLogLine: registrationPlan.failureLogLine,
    logFile: registrationPlan.logFile,
    tailLines: 80,
  });
  return {
    exitCode: result.succeeded ? null : 1,
    registeredRealmSlug: result.succeeded ? registrationPlan.realmSlug : null,
  };
}

/** Runs shared render-artifact generation and returns a process-style exit request on failure. */
export function LocalEdgeKit_runRuntimeLaunchRenderArtifactsPhase(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPhaseResult {
  const renderPlan = LocalEdgeKit_buildRuntimeLaunchRenderArtifactsPlan({
    config: options.config,
    env: options.env,
    projectRoot: options.projectRoot,
  });
  if (
    renderPlan.command === null ||
    renderPlan.logFile === null ||
    renderPlan.failureLogLine === null
  ) {
    return {
      exitCode: null,
    };
  }
  const result = LocalEdgeKit_runRuntimeLaunchLoggedCommandSync({
    command: renderPlan.command,
    cwd: options.projectRoot,
    env: options.env,
    failureLogLine: renderPlan.failureLogLine,
    logFile: renderPlan.logFile,
    tailLines: 80,
  });
  return {
    exitCode: result.succeeded ? null : 1,
  };
}

/** Runs infrastructure ensure command planning and execution for runtime launch. */
export function LocalEdgeKit_runRuntimeLaunchEnsureInfrastructurePhase(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  logLine?: (line: string) => void;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPhaseResult {
  const ensurePlan = LocalEdgeKit_buildRuntimeLaunchEnsureInfrastructurePlan({
    config: options.config,
    env: options.env,
    projectRoot: options.projectRoot,
  });
  for (const logLine of ensurePlan.logLines) {
    LocalEdgeKit_logRuntimeLaunchLine(options.logLine, logLine);
  }
  if (ensurePlan.command === null) {
    return {
      exitCode: null,
    };
  }
  const result = LocalEdgeKit_runRuntimeLaunchCommandSync({
    command: ensurePlan.command,
    cwd: options.projectRoot,
    env: options.env,
    stdio: "inherit",
  });
  return {
    exitCode: result.succeeded ? null : (result.status ?? 1),
  };
}

/** Runs optional runtime status/DNS audit and returns strict-mode failure exit codes. */
export function LocalEdgeKit_runRuntimeLaunchRuntimeAuditPhase(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  fallbackMethod: string;
  logLine?: (line: string) => void;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPhaseResult {
  const auditPlan = LocalEdgeKit_buildRuntimeLaunchRuntimeAuditPlan({
    config: options.config,
    env: options.env,
    fallbackMethod: options.fallbackMethod,
    projectRoot: options.projectRoot,
  });
  for (const logLine of auditPlan.logLines) {
    LocalEdgeKit_logRuntimeLaunchLine(options.logLine, logLine);
  }
  if (
    !auditPlan.enabled ||
    auditPlan.statusCommand === null ||
    auditPlan.dnsAuditCommand === null
  ) {
    return {
      exitCode: null,
    };
  }

  const statusResult = LocalEdgeKit_runRuntimeLaunchCommandSync({
    command: auditPlan.statusCommand,
    cwd: options.projectRoot,
    env: options.env,
    stdio: "inherit",
  });
  const dnsResult = LocalEdgeKit_runRuntimeLaunchCommandSync({
    command: auditPlan.dnsAuditCommand,
    cwd: options.projectRoot,
    env: options.env,
    stdio: "inherit",
  });
  if (!auditPlan.strict) {
    return {
      exitCode: null,
    };
  }
  if (!statusResult.succeeded) {
    return {
      exitCode: statusResult.status ?? 1,
    };
  }
  if (!dnsResult.succeeded) {
    return {
      exitCode: dnsResult.status ?? 1,
    };
  }
  return {
    exitCode: null,
  };
}

/** Prints the startup URL report and returns exit code 1 when config errors are present. */
export function LocalEdgeKit_runRuntimeLaunchStartupReportPhase(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  errorLine?: (line: string) => void;
  logLine?: (line: string) => void;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPhaseResult {
  const startupReportPlan = LocalEdgeKit_buildRuntimeLaunchStartupReportPlan({
    config: options.config,
    env: options.env,
    projectRoot: options.projectRoot,
  });
  if (startupReportPlan.errorLogLines.length > 0) {
    for (const errorLogLine of startupReportPlan.errorLogLines) {
      LocalEdgeKit_logRuntimeLaunchLine(
        options.errorLine ?? console.error,
        errorLogLine,
      );
    }
    return {
      exitCode: 1,
    };
  }
  for (const logLine of startupReportPlan.logLines) {
    LocalEdgeKit_logRuntimeLaunchLine(options.logLine, logLine);
  }
  return {
    exitCode: null,
  };
}

/** Starts the optional background health monitor and returns its child PID string. */
export function LocalEdgeKit_startRuntimeLaunchBackgroundHealthPhase(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  fallbackMethod: string;
  fallbackRealm: string;
  logDir: string;
  logLine?: (line: string) => void;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPidPhaseResult {
  const healthPlan = LocalEdgeKit_buildRuntimeLaunchBackgroundHealthPlan({
    config: options.config,
    env: options.env,
    fallbackMethod: options.fallbackMethod,
    fallbackRealm: options.fallbackRealm,
    logDir: options.logDir,
    projectRoot: options.projectRoot,
  });
  for (const logLine of healthPlan.logLines) {
    LocalEdgeKit_logRuntimeLaunchLine(options.logLine, logLine);
  }
  if (
    !healthPlan.enabled ||
    healthPlan.command === null ||
    healthPlan.logFile === null
  ) {
    return {
      exitCode: null,
      pid: "",
    };
  }
  if (
    !LocalEdgeKit_checkRuntimeLaunchCommandAvailable({
      name: healthPlan.command.command,
    })
  ) {
    console.error(
      `[local] ERROR: Required command is not available: ${healthPlan.command.command}`,
    );
    return {
      exitCode: 1,
      pid: "",
    };
  }
  const child = LocalEdgeKit_spawnRuntimeLaunchCommandWithTee({
    command: healthPlan.command,
    cwd: options.projectRoot,
    env: options.env,
    logFile: healthPlan.logFile,
  });
  const pid = String(child.pid ?? "");
  LocalEdgeKit_logRuntimeLaunchLine(
    options.logLine,
    `[local] Background local-edge health monitor started (pid=${pid}).`,
  );
  return {
    exitCode: null,
    pid,
  };
}

/** Starts the optional active-realm env watcher and returns its child PID string. */
export function LocalEdgeKit_startRuntimeLaunchActiveEnvWatcherPhase(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  logDir: string;
  logLine?: (line: string) => void;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchPidPhaseResult {
  const watcherPlan = LocalEdgeKit_buildRuntimeLaunchActiveEnvWatcherPlan({
    config: options.config,
    env: options.env,
    logDir: options.logDir,
    projectRoot: options.projectRoot,
  });
  for (const logLine of watcherPlan.logLines) {
    LocalEdgeKit_logRuntimeLaunchLine(options.logLine, logLine);
  }
  if (
    !watcherPlan.enabled ||
    watcherPlan.command === null ||
    watcherPlan.logFile === null
  ) {
    return {
      exitCode: null,
      pid: "",
    };
  }
  const child = LocalEdgeKit_spawnRuntimeLaunchCommandWithTee({
    command: watcherPlan.command,
    cwd: options.projectRoot,
    env: {
      ...options.env,
      ...watcherPlan.envOverrides,
    },
    logFile: watcherPlan.logFile,
  });
  const pid = String(child.pid ?? "");
  LocalEdgeKit_logRuntimeLaunchLine(
    options.logLine,
    `[local] Active local-edge source watcher started (pid=${pid}).`,
  );
  return {
    exitCode: null,
    pid,
  };
}

/** Applies the configured process env host override in place. */
export function LocalEdgeKit_applyRuntimeLaunchHostOverridePhase(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  logLine?: (line: string) => void;
}): void {
  const hostOverridePlan = LocalEdgeKit_buildRuntimeLaunchHostOverridePlan({
    config: options.config,
    env: options.env,
  });
  if (hostOverridePlan.envName === null || hostOverridePlan.value === null) {
    return;
  }
  const priorValue = options.env[hostOverridePlan.envName] ?? "";
  if (
    priorValue !== hostOverridePlan.value &&
    hostOverridePlan.logLine !== null
  ) {
    LocalEdgeKit_logRuntimeLaunchLine(
      options.logLine,
      hostOverridePlan.logLine,
    );
  }
  options.env[hostOverridePlan.envName] = hostOverridePlan.value;
}

/** Runs dependency preflight and returns its configured exit code. */
export function LocalEdgeKit_runRuntimeLaunchDependencyCheckPhase(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  filesystem: LocalEdgeKit_RuntimeLaunchFilesystem;
  logLine?: (line: string) => void;
  repoRoot: string;
}): LocalEdgeKit_RuntimeLaunchPhaseResult {
  const report = LocalEdgeKit_buildRuntimeLaunchDependencyCheckReport({
    config: options.config,
    env: options.env,
    filesystem: options.filesystem,
    repoRoot: options.repoRoot,
  });
  for (const logLine of report.logLines) {
    LocalEdgeKit_logRuntimeLaunchLine(options.logLine, logLine);
  }
  return {
    exitCode: report.exitCode === 0 ? null : report.exitCode,
  };
}

/** Runs idempotent runtime-launch cleanup helpers for background PIDs and realm state. */
export function LocalEdgeKit_runRuntimeLaunchCleanupPhase(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  healthPid: string;
  logLine?: (line: string) => void;
  pathExists: (filePath: string) => boolean;
  projectRoot: string;
  registeredRealmSlug: string | null;
  watcherPid: string;
}): void {
  LocalEdgeKit_tryTerminateRuntimeLaunchChildPid({
    label: "background local-edge health monitor",
    logLine: options.logLine,
    pidStr: options.healthPid,
  });
  LocalEdgeKit_tryTerminateRuntimeLaunchChildPid({
    label: "active local-edge source watcher",
    logLine: options.logLine,
    pidStr: options.watcherPid,
  });

  const platformCleanupPlan = LocalEdgeKit_buildRuntimeLaunchCleanupPlan({
    config: options.config,
    pathExists: options.pathExists,
    projectRoot: options.projectRoot,
    realmSlug: null,
  });
  if (platformCleanupPlan.platformStopCommand !== null) {
    LocalEdgeKit_logRuntimeLaunchLine(
      options.logLine,
      "[local] Stopping platform app services for this checkout...",
    );
    const projectRootEnvName =
      options.config.env?.projectRootEnvName ?? "LOCAL_EDGE_PROJECT_ROOT";
    LocalEdgeKit_runRuntimeLaunchCommandSync({
      command: platformCleanupPlan.platformStopCommand,
      cwd: options.projectRoot,
      env: {
        ...options.env,
        [projectRootEnvName]: options.projectRoot,
      },
      stdio: "ignore",
    });
  }

  const realmCleanupPlan = LocalEdgeKit_buildRuntimeLaunchCleanupPlan({
    config: options.config,
    projectRoot: options.projectRoot,
    realmSlug: options.registeredRealmSlug,
  });
  if (realmCleanupPlan.realmInactiveCommand !== null) {
    LocalEdgeKit_runRuntimeLaunchCommandSync({
      command: realmCleanupPlan.realmInactiveCommand,
      cwd: options.projectRoot,
      env: options.env,
      stdio: "ignore",
    });
  }
}

/** Builds dev overlays, optional helpers, and `concurrently` argv before launching app processes. */
export async function LocalEdgeKit_runRuntimeLaunchPlatformWithOverlaysPhase(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  errorLine?: (line: string) => void;
  generatedEnvDir: string;
  logLine?: (line: string) => void;
  machineRoot: string;
  method: string;
  pathExists: (filePath: string) => boolean;
  projectRoot: string;
}): Promise<number> {
  LocalEdgeKit_logRuntimeLaunchLine(
    options.logLine,
    "[local:section] Platform Apps: Start Development Services",
  );
  LocalEdgeKit_logRuntimeLaunchLine(
    options.logLine,
    "[local] Starting platform development services with local-edge env overlays...",
  );
  if (!LocalEdgeKit_checkRuntimeLaunchCommandAvailable({ name: "npx" })) {
    LocalEdgeKit_logRuntimeLaunchLine(
      options.errorLine ?? console.error,
      "[local] ERROR: Required command is not available: npx",
    );
    return 1;
  }

  const splitUpstreamPortsPlan =
    LocalEdgeKit_buildRuntimeLaunchSplitUpstreamPortsPlan({
      config: options.config,
      env: options.env,
    });
  const overlayPlan = LocalEdgeKit_buildRuntimeLaunchDevOverlayPlan({
    config: options.config,
    env: options.env,
    generatedEnvDir: options.generatedEnvDir,
    machineRoot: options.machineRoot,
    pathExists: options.pathExists,
    projectRoot: options.projectRoot,
    splitModeEnabled: splitUpstreamPortsPlan.splitModeEnabled,
  });
  if (overlayPlan.missingRequiredLogLines.length > 0) {
    for (const logLine of overlayPlan.missingRequiredLogLines) {
      LocalEdgeKit_logRuntimeLaunchLine(
        options.errorLine ?? console.error,
        logLine,
      );
    }
    return 1;
  }
  for (const logLine of overlayPlan.overlayLogLines) {
    LocalEdgeKit_logRuntimeLaunchLine(options.logLine, logLine);
  }

  const openOnStartPlan = LocalEdgeKit_buildRuntimeLaunchOpenOnStartPlan({
    config: options.config,
    env: options.env,
    overlayPlan,
    projectRoot: options.projectRoot,
  });
  if (
    openOnStartPlan.enabled &&
    openOnStartPlan.command !== null &&
    openOnStartPlan.requiredCommand !== null
  ) {
    if (
      !LocalEdgeKit_checkRuntimeLaunchCommandAvailable({
        name: openOnStartPlan.requiredCommand,
      })
    ) {
      LocalEdgeKit_logRuntimeLaunchLine(
        options.errorLine ?? console.error,
        openOnStartPlan.missingCommandWarning,
      );
    } else {
      LocalEdgeKit_logRuntimeLaunchLine(
        options.logLine,
        openOnStartPlan.startLogLine,
      );
      LocalEdgeKit_spawnRuntimeLaunchDetachedCommand({
        command: openOnStartPlan.command,
        cwd: options.projectRoot,
        env: options.env,
        envOverrides: openOnStartPlan.envOverrides,
      });
    }
  }

  const processCommandPlan = LocalEdgeKit_buildRuntimeLaunchProcessCommandsPlan(
    {
      config: options.config,
      env: {
        ...options.env,
        ...splitUpstreamPortsPlan.envOverrides,
      },
      method: options.method,
      overlayPlan,
      projectRoot: options.projectRoot,
    },
  );
  if (processCommandPlan.errorLogLines.length > 0) {
    for (const logLine of processCommandPlan.errorLogLines) {
      LocalEdgeKit_logRuntimeLaunchLine(
        options.errorLine ?? console.error,
        logLine,
      );
    }
    return 1;
  }

  const concurrentlyPlan = LocalEdgeKit_buildRuntimeLaunchConcurrentlyArgsPlan({
    config: options.config,
    pathExists: options.pathExists,
    processCommands: processCommandPlan.processCommands,
    projectRoot: options.projectRoot,
    splitModeEnabled: splitUpstreamPortsPlan.splitModeEnabled,
  });
  for (const skippedProcess of concurrentlyPlan.skippedProcesses) {
    for (const logLine of skippedProcess.logLines) {
      LocalEdgeKit_logRuntimeLaunchLine(options.logLine, logLine);
    }
  }
  if (concurrentlyPlan.missingCommandProcessIds.length > 0) {
    LocalEdgeKit_logRuntimeLaunchLine(
      options.errorLine ?? console.error,
      `[local] ERROR: Missing runtime command builders for configured process ids: ${concurrentlyPlan.missingCommandProcessIds.join(", ")}`,
    );
    return 1;
  }

  return LocalEdgeKit_waitForRuntimeLaunchConcurrentlyExit({
    concurrentArgs: [...concurrentlyPlan.concurrentArgs],
    env: options.env,
    projectRoot: options.projectRoot,
  });
}

/** Sends SIGINT to configured checkout-scoped app processes during runtime-launch shutdown. */
export function LocalEdgeKit_runRuntimeLaunchSigintStopPhase(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
}): void {
  const sigintStopPlan = LocalEdgeKit_buildRuntimeLaunchSigintStopPlan({
    config: options.config,
    projectRoot: options.projectRoot,
  });
  if (sigintStopPlan.command === null) {
    return;
  }
  LocalEdgeKit_runRuntimeLaunchCommandSync({
    command: sigintStopPlan.command,
    cwd: options.projectRoot,
    env: options.env,
    stdio: "inherit",
  });
}

/** Runs the full runtime-launch pipeline around project-provided config and env loading. */
export async function LocalEdgeKit_runRuntimeLaunchPipeline(options: {
  argv: readonly string[];
  config: LocalEdgeKit_Config;
  defaultProjectRoot: string;
  env: NodeJS.ProcessEnv;
  filesystem: LocalEdgeKit_RuntimeLaunchFilesystem;
  loadEnvFile: (envFile: string) => void;
}): Promise<number> {
  const forwardedArgs = options.argv.slice(2);
  if (forwardedArgs.length > 0) {
    console.log(
      `[local] launch-runtime: forwarded args present (${forwardedArgs.join(" ")}) — reserved for future CLI flags.`,
    );
  }

  const projectRootEnvName =
    options.config.env?.projectRootEnvName ?? "LOCAL_EDGE_PROJECT_ROOT";
  const projectRoot = path.resolve(
    options.env[projectRootEnvName] ?? options.defaultProjectRoot,
  );
  process.chdir(projectRoot);

  let registeredRealmSlug = "";
  let cleanupRan = false;
  let healthPid = "";
  let watcherPid = "";

  let environmentPlan = LocalEdgeKit_buildRuntimeLaunchEnvironmentPlan({
    config: options.config,
    env: options.env,
    pathExists: options.filesystem.exists,
    projectRoot,
  });
  let localEdgeLogDir = environmentPlan.logDir;
  let machineRoot = environmentPlan.machineRoot;
  let generatedEnvDir = environmentPlan.generatedEnvDir;

  function refreshEnvironmentPlanFromEnv(): void {
    environmentPlan = LocalEdgeKit_buildRuntimeLaunchEnvironmentPlan({
      config: options.config,
      env: options.env,
      pathExists: options.filesystem.exists,
      projectRoot,
    });
    localEdgeLogDir = environmentPlan.logDir;
    machineRoot = environmentPlan.machineRoot;
    generatedEnvDir = environmentPlan.generatedEnvDir;
  }

  function loadEnvFile(): void {
    refreshEnvironmentPlanFromEnv();
    if (environmentPlan.shouldLoadEnvFile) {
      const loadedEnvFile = environmentPlan.envFile;
      options.loadEnvFile(loadedEnvFile);
      refreshEnvironmentPlanFromEnv();
      if (environmentPlan.envFileLoadLogEnabled) {
        console.log(`[local] Loaded local-edge env file: ${loadedEnvFile}`);
      }
    }
  }

  function cleanup(): void {
    if (cleanupRan) {
      return;
    }
    cleanupRan = true;
    LocalEdgeKit_runRuntimeLaunchCleanupPhase({
      config: options.config,
      env: options.env,
      healthPid,
      pathExists: options.filesystem.exists,
      projectRoot,
      registeredRealmSlug:
        registeredRealmSlug.length > 0 ? registeredRealmSlug : null,
      watcherPid,
    });
  }

  loadEnvFile();

  const delegationResult = LocalEdgeKit_runRuntimeLaunchDelegationPhase({
    config: options.config,
    env: options.env,
    pathExists: options.filesystem.exists,
    projectRoot,
  });
  if (delegationResult.exitCode !== null) {
    return delegationResult.exitCode;
  }

  console.log("[local:section] Local Edge: Register Root Workspace");
  const registrationResult =
    LocalEdgeKit_runRuntimeLaunchWorkspaceRegistrationPhase({
      config: options.config,
      env: options.env,
      projectRoot,
    });
  if (registrationResult.exitCode !== null) {
    return registrationResult.exitCode;
  }
  if (registrationResult.registeredRealmSlug !== null) {
    registeredRealmSlug = registrationResult.registeredRealmSlug;
  }

  console.log("[local:section] Local Edge: Render Shared Artifacts");
  const renderResult = LocalEdgeKit_runRuntimeLaunchRenderArtifactsPhase({
    config: options.config,
    env: options.env,
    projectRoot,
  });
  if (renderResult.exitCode !== null) {
    return renderResult.exitCode;
  }

  const ensureResult = LocalEdgeKit_runRuntimeLaunchEnsureInfrastructurePhase({
    config: options.config,
    env: options.env,
    projectRoot,
  });
  if (ensureResult.exitCode !== null) {
    return ensureResult.exitCode;
  }

  const runtimeAuditResult = LocalEdgeKit_runRuntimeLaunchRuntimeAuditPhase({
    config: options.config,
    env: options.env,
    fallbackMethod: LocalEdgeKit_runtimeLaunchPrimaryMethod({
      config: options.config,
      env: options.env,
    }),
    projectRoot,
  });
  if (runtimeAuditResult.exitCode !== null) {
    return runtimeAuditResult.exitCode;
  }

  const startupReportResult = LocalEdgeKit_runRuntimeLaunchStartupReportPhase({
    config: options.config,
    env: options.env,
    projectRoot,
  });
  if (startupReportResult.exitCode !== null) {
    return startupReportResult.exitCode;
  }

  const backgroundHealthResult =
    LocalEdgeKit_startRuntimeLaunchBackgroundHealthPhase({
      config: options.config,
      env: options.env,
      fallbackMethod: LocalEdgeKit_runtimeLaunchPrimaryMethod({
        config: options.config,
        env: options.env,
      }),
      fallbackRealm: LocalEdgeKit_runtimeLaunchRealmSlug({
        config: options.config,
        env: options.env,
      }),
      logDir: localEdgeLogDir,
      projectRoot,
    });
  if (backgroundHealthResult.exitCode !== null) {
    return backgroundHealthResult.exitCode;
  }
  healthPid = backgroundHealthResult.pid;

  const activeEnvWatcherResult =
    LocalEdgeKit_startRuntimeLaunchActiveEnvWatcherPhase({
      config: options.config,
      env: options.env,
      logDir: localEdgeLogDir,
      projectRoot,
    });
  watcherPid = activeEnvWatcherResult.pid;

  LocalEdgeKit_applyRuntimeLaunchHostOverridePhase({
    config: options.config,
    env: options.env,
  });

  const dependencyCheckResult =
    LocalEdgeKit_runRuntimeLaunchDependencyCheckPhase({
      config: options.config,
      env: options.env,
      filesystem: options.filesystem,
      repoRoot: projectRoot,
    });
  if (dependencyCheckResult.exitCode !== null) {
    return dependencyCheckResult.exitCode;
  }

  process.on("exit", () => {
    cleanup();
  });
  process.on("SIGINT", () => {
    LocalEdgeKit_runRuntimeLaunchSigintStopPhase({
      config: options.config,
      env: options.env,
      projectRoot,
    });
    cleanup();
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  refreshEnvironmentPlanFromEnv();
  const exitCode = await LocalEdgeKit_runRuntimeLaunchPlatformWithOverlaysPhase(
    {
      config: options.config,
      env: options.env,
      generatedEnvDir,
      machineRoot,
      method: LocalEdgeKit_runtimeLaunchPrimaryMethod({
        config: options.config,
        env: options.env,
      }),
      pathExists: options.filesystem.exists,
      projectRoot,
    },
  );
  cleanup();
  return exitCode;
}

function LocalEdgeKit_logRuntimeLaunchLine(
  logLine: ((line: string) => void) | undefined,
  line: string | null,
): void {
  if (line === null) {
    return;
  }
  const writeLogLine = logLine ?? console.log;
  writeLogLine(line);
}

/** Builds an `npm run dev --prefix <folder>` command with shell-escaped env assignments. */
export function LocalEdgeKit_buildRuntimeLaunchNpmDevShellCommand(options: {
  envExports: Readonly<Record<string, string>>;
  prefixFolder: string;
}): string {
  const envPairs = Object.entries(options.envExports).map(
    ([key, value]) => `${key}=${LocalEdgeKit_shellQuoteSingle(value)}`,
  );
  return `env ${envPairs.join(" ")} npm run dev --prefix ${LocalEdgeKit_shellQuoteSingle(options.prefixFolder)}`;
}

/** Resolves the active realm-specific overlay path, falling back to generated env output. */
export function LocalEdgeKit_resolveRuntimeLaunchOverlayPath(options: {
  appName: string;
  env: NodeJS.ProcessEnv;
  generatedEnvDir: string;
  machineRoot: string;
  pathExists: (filePath: string) => boolean;
}): string {
  const realmSlug = options.env.LOCAL_EDGE_ENV_SLUG ?? "main";
  const realmOverlay = path.join(
    options.machineRoot,
    "realms",
    realmSlug,
    "env",
    `${options.appName}.env`,
  );
  if (options.pathExists(realmOverlay)) {
    return realmOverlay;
  }
  return path.join(options.generatedEnvDir, `${options.appName}.env`);
}

/** Builds the ordered colon-delimited env-file list consumed by package dev processes. */
export function LocalEdgeKit_buildRuntimeLaunchPackageEnvFileList(options: {
  config: LocalEdgeKit_Config;
  overlayFile: string;
  packageRoot: string;
}): string {
  const packageEnvFileNames =
    options.config.runtimeLaunch?.packageEnvFileNames ??
    LOCAL_EDGE_KIT_RUNTIME_LAUNCH_DEFAULT_PACKAGE_ENV_FILE_NAMES;
  return [
    options.overlayFile,
    ...packageEnvFileNames.map((fileName) =>
      path.join(options.packageRoot, fileName),
    ),
  ]
    .filter((segment) => segment.length > 0)
    .join(":");
}

/** Parses dependency and devDependency names from a package manifest. */
export function LocalEdgeKit_readRuntimeLaunchPackageDependencyNames(
  packageJsonText: string,
): string[] {
  const parsed: unknown = JSON.parse(packageJsonText);
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const names = new Set<string>();
  for (const section of ["dependencies", "devDependencies"]) {
    const dependencies = Object.entries(parsed).find(
      ([key]) => key === section,
    )?.[1];
    if (typeof dependencies !== "object" || dependencies === null) {
      continue;
    }
    for (const key of Object.keys(dependencies)) {
      names.add(key);
    }
  }
  return [...names];
}

/** Finds package dependencies missing from both package-local and root `node_modules`. */
export function LocalEdgeKit_findMissingRuntimeLaunchNpmDeps(options: {
  config: LocalEdgeKit_Config;
  filesystem: LocalEdgeKit_RuntimeLaunchFilesystem;
  packageRoot: string;
  repoRoot: string;
}): string[] {
  const packageJsonPath = path.join(options.packageRoot, "package.json");
  if (!options.filesystem.exists(packageJsonPath)) {
    return [];
  }
  const dependencyNames = LocalEdgeKit_readRuntimeLaunchPackageDependencyNames(
    options.filesystem.readText(packageJsonPath),
  );
  const internalDependencyNamePrefixes =
    options.config.runtimeLaunch?.internalDependencyNamePrefixes ?? [];
  const rootNodeModules = path.join(options.repoRoot, "node_modules");
  const packageNodeModules = path.join(options.packageRoot, "node_modules");
  const missing: string[] = [];

  for (const dependencyName of dependencyNames) {
    if (
      internalDependencyNamePrefixes.some((prefix) =>
        dependencyName.startsWith(prefix),
      )
    ) {
      continue;
    }

    if (
      !options.filesystem.exists(
        path.join(packageNodeModules, dependencyName),
      ) &&
      !options.filesystem.exists(path.join(rootNodeModules, dependencyName))
    ) {
      missing.push(dependencyName);
    }
  }

  return missing;
}

/** Builds direct upstream URL rows from configured surfaces and their upstream port env/defaults. */
export function LocalEdgeKit_buildRuntimeLaunchDirectUpstreamUrls(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  host: string;
}): LocalEdgeKit_RuntimeLaunchDirectUpstreamUrlPlan {
  const rows: LocalEdgeKit_RuntimeLaunchDirectUpstreamUrl[] = [];
  const missingSurfaceIds: string[] = [];
  const missingPortSurfaceIds: string[] = [];
  const directUpstreamUrls =
    options.config.runtimeLaunch?.directUpstreamUrls ?? [];

  for (const directUpstreamUrl of directUpstreamUrls) {
    const surface = options.config.surfaces.find(
      (candidate) => candidate.id === directUpstreamUrl.surfaceId,
    );
    if (surface === undefined) {
      missingSurfaceIds.push(directUpstreamUrl.surfaceId);
      continue;
    }
    const upstreamPortEnvName = surface.healthcheck?.upstreamPortEnvName;
    const defaultUpstreamPort = surface.healthcheck?.defaultUpstreamPort;
    const upstreamPort =
      upstreamPortEnvName === undefined
        ? undefined
        : (options.env[upstreamPortEnvName] ??
          String(defaultUpstreamPort ?? ""));
    if (upstreamPort === undefined || upstreamPort.length === 0) {
      missingPortSurfaceIds.push(directUpstreamUrl.surfaceId);
      continue;
    }
    const requestPath = directUpstreamUrl.requestPath.startsWith("/")
      ? directUpstreamUrl.requestPath
      : `/${directUpstreamUrl.requestPath}`;
    rows.push({
      label: directUpstreamUrl.label,
      url: `http://${options.host}:${upstreamPort}${requestPath}`,
    });
  }

  return {
    missingPortSurfaceIds,
    missingSurfaceIds,
    rows,
  };
}

/** Resolves env overlay paths, package env-file lists, and required-overlay diagnostics. */
export function LocalEdgeKit_buildRuntimeLaunchDevOverlayPlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  generatedEnvDir: string;
  machineRoot: string;
  pathExists: (filePath: string) => boolean;
  projectRoot: string;
  splitModeEnabled: boolean;
}): LocalEdgeKit_RuntimeLaunchDevOverlayPlan {
  const entries: LocalEdgeKit_RuntimeLaunchDevOverlayEntry[] = [];
  const devOverlays = options.config.runtimeLaunch?.devOverlays ?? [];
  for (const devOverlay of devOverlays) {
    const overlayFile = LocalEdgeKit_resolveRuntimeLaunchOverlayPath({
      appName: devOverlay.appName,
      env: options.env,
      generatedEnvDir: options.generatedEnvDir,
      machineRoot: options.machineRoot,
      pathExists: options.pathExists,
    });
    const packageRoot = path.join(
      options.projectRoot,
      devOverlay.packageRelativePath,
    );
    const required = options.splitModeEnabled
      ? devOverlay.requiredWhenSplitModeEnabled
      : devOverlay.requiredWhenSplitModeDisabled;
    entries.push({
      appName: devOverlay.appName,
      envFileList: LocalEdgeKit_buildRuntimeLaunchPackageEnvFileList({
        config: options.config,
        overlayFile,
        packageRoot,
      }),
      exists: options.pathExists(overlayFile),
      id: devOverlay.id,
      logLabel: devOverlay.logLabel,
      overlayFile,
      packageRoot,
      required,
    });
  }

  const overlayLogEntries = entries.filter((entry) => entry.required);
  const maxLabelLength = Math.max(
    0,
    ...overlayLogEntries.map((entry) => entry.logLabel.length),
  );
  return {
    entries,
    missingRequiredLogLines: entries
      .filter((entry) => entry.required && !entry.exists)
      .map(
        (entry) =>
          `[local] ERROR: Missing generated local-edge env overlay for ${entry.appName}: ${entry.overlayFile}`,
      ),
    overlayLogLines: [
      "[local] Launching platform services with per-app local-edge env overlays:",
      ...overlayLogEntries.map(
        (entry) =>
          `[local] ${entry.logLabel.padEnd(maxLabelLength)} ${entry.overlayFile}`,
      ),
    ],
  };
}

/** Returns one overlay plan entry by id or throws when config and adapter ids drift. */
export function LocalEdgeKit_requireRuntimeLaunchDevOverlayEntry(options: {
  id: string;
  plan: LocalEdgeKit_RuntimeLaunchDevOverlayPlan;
}): LocalEdgeKit_RuntimeLaunchDevOverlayEntry {
  const entry = options.plan.entries.find(
    (candidate) => candidate.id === options.id,
  );
  if (entry === undefined) {
    throw new Error(
      `[local-edge:runtime-launch] Missing dev overlay plan entry '${options.id}'.`,
    );
  }
  return entry;
}

/** Builds runtime-launch process commands from config, overlays, surfaces, and env. */
export function LocalEdgeKit_buildRuntimeLaunchProcessCommandsPlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  method: string;
  overlayPlan: LocalEdgeKit_RuntimeLaunchDevOverlayPlan;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchProcessCommandsPlan {
  const processCommands: Record<string, string> = {};
  const errorLogLines: string[] = [];
  const runtimeConfig = LocalEdgeKit_resolveRuntimeConfig({
    config: options.config,
    env: {
      ...options.env,
      [options.config.env?.primaryMethodEnvName ?? "LOCAL_EDGE_PRIMARY_METHOD"]:
        options.method,
    },
    projectRoot: options.projectRoot,
  });

  for (const commandConfig of options.config.runtimeLaunch?.processCommands ??
    []) {
    const envExportResolution =
      LocalEdgeKit_resolveRuntimeLaunchProcessEnvExports({
        commandId: commandConfig.id,
        config: options.config,
        env: options.env,
        envExports: commandConfig.envExports ?? [],
        method: options.method,
        overlayPlan: options.overlayPlan,
        runtimeConfig,
      });
    errorLogLines.push(...envExportResolution.errorLogLines);
    if (envExportResolution.errorLogLines.length > 0) {
      continue;
    }

    if (
      commandConfig.kind ===
      "local-edge-runtime-launch-process-command-kind-npm-dev"
    ) {
      processCommands[commandConfig.id] =
        LocalEdgeKit_buildRuntimeLaunchNpmDevShellCommand({
          prefixFolder: commandConfig.packageRelativePath,
          envExports: envExportResolution.envExports,
        });
      continue;
    }

    const envPairs = Object.entries(envExportResolution.envExports).map(
      ([key, value]) => `${key}=${LocalEdgeKit_shellQuoteSingle(value)}`,
    );
    processCommands[commandConfig.id] =
      envPairs.length === 0
        ? commandConfig.command
        : `env ${envPairs.join(" ")} ${commandConfig.command}`;
  }

  return {
    errorLogLines,
    processCommands,
  };
}

/** Plans an optional detached open-on-start helper without executing it. */
export function LocalEdgeKit_buildRuntimeLaunchOpenOnStartPlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  overlayPlan: LocalEdgeKit_RuntimeLaunchDevOverlayPlan;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchOpenOnStartPlan {
  const openOnStart = options.config.runtimeLaunch?.openOnStart;
  if (openOnStart === undefined) {
    return {
      command: null,
      enabled: false,
      envOverrides: {},
      missingCommandWarning: null,
      requiredCommand: null,
      startLogLine: null,
    };
  }

  const enabledValue = options.env[openOnStart.enabledEnvName] ?? "false";
  if (!LocalEdgeCore_isTruthy(enabledValue)) {
    return {
      command: null,
      enabled: false,
      envOverrides: {},
      missingCommandWarning: null,
      requiredCommand: null,
      startLogLine: null,
    };
  }

  const overlayEntry = options.overlayPlan.entries.find(
    (entry) => entry.id === openOnStart.overlayId,
  );
  const envOverrides =
    overlayEntry === undefined
      ? {}
      : {
          [openOnStart.envFileEnvName]: overlayEntry.envFileList,
        };

  return {
    command: {
      command: openOnStart.scriptRunner.command,
      args: [
        ...openOnStart.scriptRunner.runnerArgs,
        LocalEdgeKit_resolveRuntimeLaunchProjectPath({
          projectRoot: options.projectRoot,
          pathValue: openOnStart.scriptPath,
        }),
        openOnStart.projectRootArg,
        options.projectRoot,
      ],
    },
    enabled: true,
    envOverrides,
    missingCommandWarning: openOnStart.missingCommandWarning,
    requiredCommand: openOnStart.requiredCommand,
    startLogLine: openOnStart.startLogLine,
  };
}

/** Plans cleanup subprocesses without executing them. */
export function LocalEdgeKit_buildRuntimeLaunchCleanupPlan(options: {
  config: LocalEdgeKit_Config;
  pathExists?: (filePath: string) => boolean;
  projectRoot: string;
  realmSlug: string | null;
}): LocalEdgeKit_RuntimeLaunchCleanupPlan {
  const cleanup = options.config.runtimeLaunch?.cleanup;
  if (cleanup === undefined) {
    return {
      platformStopCommand: null,
      realmInactiveCommand: null,
    };
  }

  const platformStopScriptPath = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: cleanup.platformStopScriptPath,
  });
  const realmInactiveScriptPath = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: cleanup.realmInactiveScriptPath,
  });
  const platformStopCommand =
    options.pathExists !== undefined &&
    !options.pathExists(platformStopScriptPath)
      ? null
      : {
          command: cleanup.scriptRunner.command,
          args: [...cleanup.scriptRunner.runnerArgs, platformStopScriptPath],
        };

  return {
    platformStopCommand,
    realmInactiveCommand:
      options.realmSlug === null || options.realmSlug.length === 0
        ? null
        : {
            command: cleanup.scriptRunner.command,
            args: [
              ...cleanup.scriptRunner.runnerArgs,
              realmInactiveScriptPath,
              options.realmSlug,
            ],
          },
  };
}

/** Plans root-workspace realm registration without executing the command. */
export function LocalEdgeKit_buildRuntimeLaunchWorkspaceRegistrationPlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchWorkspaceRegistrationPlan {
  const registration = options.config.runtimeLaunch?.workspaceRegistration;
  const realmSlug = LocalEdgeKit_runtimeLaunchRealmSlug({
    config: options.config,
    env: options.env,
  });
  if (registration === undefined) {
    return {
      command: null,
      envOverrides: {},
      failureLogLine: null,
      logFile: null,
      realmSlug,
      startLogLine: null,
    };
  }

  const logFile = LocalEdgeKit_runtimeLaunchLogFile({
    config: options.config,
    fileName: registration.logFileName,
    projectRoot: options.projectRoot,
  });
  const registerScriptPath = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: registration.registerScriptPath,
  });
  const envFileEnvName =
    options.config.env?.envFileEnvName ?? "LOCAL_EDGE_ENV_FILE";
  const projectRootEnvName =
    options.config.env?.projectRootEnvName ?? "LOCAL_EDGE_PROJECT_ROOT";
  const rootEnvFileEnvName =
    options.config.env?.rootEnvFileEnvName ?? "LOCAL_EDGE_ROOT_ENV_FILE";

  return {
    command: {
      command: registration.scriptRunner.command,
      args: [...registration.scriptRunner.runnerArgs, registerScriptPath],
    },
    envOverrides: {
      [projectRootEnvName]: options.projectRoot,
      [envFileEnvName]:
        options.env[envFileEnvName] ??
        path.join(options.projectRoot, registration.defaultEnvFileRelativePath),
      [rootEnvFileEnvName]:
        options.env[rootEnvFileEnvName] ?? registration.defaultRootEnvFileValue,
    },
    failureLogLine: `[local] ERROR: Root workspace realm registration failed. See ${logFile}.`,
    logFile,
    realmSlug,
    startLogLine: `[local] Registering root workspace realm '${realmSlug}' for ${options.projectRoot}...`,
  };
}

/** Plans shared local-edge artifact rendering without executing the command. */
export function LocalEdgeKit_buildRuntimeLaunchRenderArtifactsPlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchRenderArtifactsPlan {
  const renderArtifacts = options.config.runtimeLaunch?.renderArtifacts;
  if (renderArtifacts === undefined) {
    return {
      command: null,
      failureLogLine: null,
      logFile: null,
    };
  }

  const logFile = LocalEdgeKit_runtimeLaunchLogFile({
    config: options.config,
    fileName: renderArtifacts.logFileName,
    projectRoot: options.projectRoot,
  });
  const method = LocalEdgeKit_runtimeLaunchPrimaryMethod({
    config: options.config,
    env: options.env,
  });
  const renderScriptPath = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: renderArtifacts.renderScriptPath,
  });

  return {
    command: {
      command: renderArtifacts.scriptRunner.command,
      args: [
        ...renderArtifacts.scriptRunner.runnerArgs,
        renderScriptPath,
        "--method",
        method,
      ],
    },
    failureLogLine: `[local] ERROR: Shared render failed. See ${logFile}.`,
    logFile,
  };
}

/** Plans the infrastructure ensure command without executing it. */
export function LocalEdgeKit_buildRuntimeLaunchEnsureInfrastructurePlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchEnsureInfrastructurePlan {
  const ensureInfrastructure =
    options.config.runtimeLaunch?.ensureInfrastructure;
  const logLines = [
    "[local:section] Local Edge: Ensure Infrastructure",
    "[local] Ensuring local edge services are running...",
  ];
  if (ensureInfrastructure === undefined) {
    return {
      command: null,
      logLines,
    };
  }

  const startupCliScriptPath = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: ensureInfrastructure.startupCliScriptPath,
  });
  return {
    command: {
      command: ensureInfrastructure.scriptRunner.command,
      args: [
        ...ensureInfrastructure.scriptRunner.runnerArgs,
        startupCliScriptPath,
        "run",
        ensureInfrastructure.commandName,
        "--",
        ensureInfrastructure.methodArgName,
        LocalEdgeKit_runtimeLaunchPrimaryMethod({
          config: options.config,
          env: options.env,
        }),
        ensureInfrastructure.realmArgName,
        LocalEdgeKit_runtimeLaunchRealmSlug({
          config: options.config,
          env: options.env,
        }),
      ],
    },
    logLines,
  };
}

/** Plans the SIGINT runtime-stop shell command without executing it. */
export function LocalEdgeKit_buildRuntimeLaunchSigintStopPlan(options: {
  config: LocalEdgeKit_Config;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchSigintStopPlan {
  const sigintStop = options.config.runtimeLaunch?.sigintStop;
  if (sigintStop === undefined) {
    return {
      command: null,
    };
  }

  const runtimeStopLibPath = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: sigintStop.runtimeStopLibPath,
  });
  const quotedPatterns = sigintStop.collectProcessPatterns
    .map((pattern) => LocalEdgeKit_shellQuoteSingle(pattern))
    .join(" ");
  const script = [
    "set -euo pipefail",
    `source ${LocalEdgeKit_shellQuoteSingle(runtimeStopLibPath)}`,
    "while IFS= read -r sigint_pid; do",
    '  [[ -z "$sigint_pid" ]] && continue',
    `  printf '%s %s\\n' ${LocalEdgeKit_shellQuoteSingle(sigintStop.logLinePrefix)} "$sigint_pid" >&2`,
    '  kill -INT "$sigint_pid" >/dev/null 2>&1 || true',
    `done < <(runtime_stop_collect_checkout_scoped_pids ${LocalEdgeKit_shellQuoteSingle(options.projectRoot)} ${quotedPatterns} 2>/dev/null || true)`,
    `printf '%s\\n' ${LocalEdgeKit_shellQuoteSingle(sigintStop.completionLogLine)} >&2`,
  ].join("\n");

  return {
    command: {
      command: "bash",
      args: ["-c", script],
    },
  };
}

/** Plans runtime-launch env file loading and generated/log paths without loading files. */
export function LocalEdgeKit_buildRuntimeLaunchEnvironmentPlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  pathExists: (filePath: string) => boolean;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchEnvironmentPlan {
  const environment = options.config.runtimeLaunch?.environment;
  const envFileEnvName =
    options.config.env?.envFileEnvName ?? "LOCAL_EDGE_ENV_FILE";
  const generatedDirEnvName =
    options.config.env?.generatedDirEnvName ?? "LOCAL_EDGE_GENERATED_DIR";
  const envFile = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue:
      options.env[envFileEnvName] ??
      environment?.defaultEnvFileRelativePath ??
      ".env.local-edge",
  });
  const machineRoot = LocalEdgeCore_normalizeMachineRootDir(
    LocalEdgeKit_resolveRuntimeLaunchProjectPath({
      projectRoot: options.projectRoot,
      pathValue:
        options.env[generatedDirEnvName] ??
        environment?.generatedDirRelativePath ??
        ".tmp/local-edge",
    }),
  );
  const generatedEnvDir = path.join(
    machineRoot,
    environment?.generatedEnvSubdir ?? "generated/env",
  );
  const logDir = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: options.config.lifecycle?.logDir ?? "logs/local-edge",
  });
  const shouldLoadEnvFile = options.pathExists(envFile);
  const logEnvLoadsEnvName =
    environment?.logEnvLoadsEnvName ?? "LOCAL_EDGE_LOG_ENV_LOADS";

  return {
    envFile,
    envFileLoadLogEnabled: LocalEdgeCore_isTruthy(
      options.env[logEnvLoadsEnvName] ?? "",
    ),
    envFileLoadedLogLine:
      shouldLoadEnvFile &&
      LocalEdgeCore_isTruthy(options.env[logEnvLoadsEnvName] ?? "")
        ? `[local] Loaded local-edge env file: ${envFile}`
        : null,
    generatedEnvDir,
    logDir,
    machineRoot,
    shouldLoadEnvFile,
  };
}

/** Resolves split-mode and paired upstream port env overrides from config/env. */
export function LocalEdgeKit_buildRuntimeLaunchSplitUpstreamPortsPlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
}): LocalEdgeKit_RuntimeLaunchSplitUpstreamPortsPlan {
  const splitUpstreamPorts = options.config.runtimeLaunch?.splitUpstreamPorts;
  if (splitUpstreamPorts === undefined) {
    return {
      envOverrides: {},
      primaryPort: null,
      secondaryPort: null,
      splitModeEnabled: false,
    };
  }

  const rawSplitMode = options.env[splitUpstreamPorts.splitModeEnvName];
  const splitModeEnabled =
    rawSplitMode === undefined
      ? splitUpstreamPorts.defaultSplitModeEnabled
      : LocalEdgeCore_isTruthy(rawSplitMode);
  const primaryRaw = [
    options.env[splitUpstreamPorts.primaryEnvName],
    ...splitUpstreamPorts.primaryFallbackEnvNames.map(
      (envName) => options.env[envName],
    ),
    String(splitUpstreamPorts.primaryDefaultPort),
  ].find((candidate) => candidate !== undefined && candidate.length > 0);
  const primaryPort = Number.parseInt(
    primaryRaw ?? String(splitUpstreamPorts.primaryDefaultPort),
    10,
  );
  const secondaryRaw = options.env[splitUpstreamPorts.secondaryEnvName];
  const secondaryPort =
    secondaryRaw !== undefined && secondaryRaw.length > 0
      ? Number.parseInt(secondaryRaw, 10)
      : splitModeEnabled
        ? primaryPort + splitUpstreamPorts.secondaryOffsetFromPrimary
        : primaryPort;

  return {
    envOverrides: {
      [splitUpstreamPorts.primaryEnvName]: String(primaryPort),
      [splitUpstreamPorts.secondaryEnvName]: String(secondaryPort),
    },
    primaryPort,
    secondaryPort,
    splitModeEnabled,
  };
}

/** Plans one runtime process env override without mutating process.env. */
export function LocalEdgeKit_buildRuntimeLaunchHostOverridePlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
}): LocalEdgeKit_RuntimeLaunchHostOverridePlan {
  const hostOverride = options.config.runtimeLaunch?.hostOverride;
  if (hostOverride === undefined) {
    return {
      envName: null,
      logLine: null,
      value: null,
    };
  }

  const priorValue = options.env[hostOverride.targetEnvName] ?? "";
  const value = options.env[hostOverride.envName] ?? hostOverride.defaultValue;

  return {
    envName: hostOverride.targetEnvName,
    logLine: `[local] Overriding ${hostOverride.targetEnvName} for ${hostOverride.logLabel}: '${priorValue || "<unset>"}' -> '${value}'.`,
    value,
  };
}

/** Plans an alternate runtime-launch delegation command without executing it. */
export function LocalEdgeKit_buildRuntimeLaunchDelegationPlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  pathExists: (filePath: string) => boolean;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchDelegationPlan {
  const delegation = options.config.runtimeLaunch?.delegation;
  if (delegation === undefined) {
    return {
      command: null,
      startLogLine: null,
    };
  }

  const guardFilePath = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: delegation.guardFilePath,
  });
  if (!options.pathExists(guardFilePath)) {
    return {
      command: null,
      startLogLine: null,
    };
  }

  if (LocalEdgeCore_isTruthy(options.env[delegation.bypassEnvName] ?? "")) {
    return {
      command: null,
      startLogLine: null,
    };
  }

  const commandScriptPath = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: delegation.commandScriptPath,
  });

  return {
    command: {
      command: delegation.scriptRunner.command,
      args: [
        ...delegation.scriptRunner.runnerArgs,
        commandScriptPath,
        delegation.projectRootArgName,
        options.projectRoot,
      ],
    },
    startLogLine: delegation.startLogLine,
  };
}

/** Builds the startup URL report without writing to stdout/stderr. */
export function LocalEdgeKit_buildRuntimeLaunchStartupReportPlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchStartupReportPlan {
  const startupReport = options.config.runtimeLaunch?.startupReport;
  const primaryMethod = LocalEdgeKit_runtimeLaunchPrimaryMethod({
    config: options.config,
    env: options.env,
  });
  const splitUpstreamPortsPlan =
    LocalEdgeKit_buildRuntimeLaunchSplitUpstreamPortsPlan({
      config: options.config,
      env: options.env,
    });
  const directUpstreamUrls = LocalEdgeKit_buildRuntimeLaunchDirectUpstreamUrls({
    config: options.config,
    env: {
      ...options.env,
      ...splitUpstreamPortsPlan.envOverrides,
    },
    host: startupReport?.directHost ?? "localhost",
  });
  const errorLogLines = [
    ...(directUpstreamUrls.missingSurfaceIds.length > 0
      ? [
          `[local] ERROR: Runtime-launch direct URL config references missing surface ids: ${directUpstreamUrls.missingSurfaceIds.join(", ")}`,
        ]
      : []),
    ...(directUpstreamUrls.missingPortSurfaceIds.length > 0
      ? [
          `[local] ERROR: Runtime-launch direct URL surfaces are missing upstream port config: ${directUpstreamUrls.missingPortSurfaceIds.join(", ")}`,
        ]
      : []),
  ];
  if (errorLogLines.length > 0) {
    return {
      errorLogLines,
      logLines: [],
    };
  }

  const primaryMethodEnvName =
    startupReport?.primaryMethodEnvName ??
    options.config.env?.primaryMethodEnvName ??
    "LOCAL_EDGE_PRIMARY_METHOD";
  const directLabelPadWidth = startupReport?.directLabelPadWidth ?? 14;
  const surfaceUrls = LocalEdgeKit_buildRuntimeLaunchSurfaceUrls({
    commandLabel: startupReport?.commandLabel ?? "local-edge:runtime-launch",
    config: options.config,
    env: {
      ...options.env,
      [primaryMethodEnvName]: primaryMethod,
    },
    method: primaryMethod,
    projectRoot: options.projectRoot,
  });

  return {
    errorLogLines: [],
    logLines: [
      startupReport?.sectionLogLine ?? "[local:section] Local Edge: URL Matrix",
      startupReport?.directSectionLogLine ??
        "[local] Test URLs (direct upstream):",
      ...directUpstreamUrls.rows.map(
        (row) => `[local] ${row.label.padEnd(directLabelPadWidth)} ${row.url}`,
      ),
      `[local] ${startupReport?.splitModeLogLabel ?? "Split mode"}: ${options.config.runtimeLaunch?.splitUpstreamPorts?.splitModeEnvName ?? "LOCAL_EDGE_SPLIT_MODE"}=${String(splitUpstreamPortsPlan.splitModeEnabled)}`,
      startupReport?.edgeSectionLogLine ??
        "[local] Test URLs (edge hostnames):",
      `[local] ${startupReport?.topologySelectorLogLabel ?? "Topology selector"}: ${primaryMethodEnvName}=${primaryMethod}`,
      `[local] ${startupReport?.scopeLogPrefix ?? "URL matrix scope"}: methods=${primaryMethod}`,
      ...surfaceUrls.flatMap((surfaceUrl) => [
        `[local] ${surfaceUrl.method} app    ${surfaceUrl.surfaceId} ${surfaceUrl.appUrl}`,
        `[local] ${surfaceUrl.method} status ${surfaceUrl.surfaceId} ${surfaceUrl.statusUrl}`,
      ]),
    ],
  };
}

function LocalEdgeKit_resolveRuntimeLaunchProcessEnvExports(options: {
  commandId: string;
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  envExports: readonly LocalEdgeKit_RuntimeLaunchProcessCommandEnvExportConfig[];
  method: string;
  overlayPlan: LocalEdgeKit_RuntimeLaunchDevOverlayPlan;
  runtimeConfig: LocalEdgeKit_RuntimeConfig;
}): {
  envExports: Record<string, string>;
  errorLogLines: readonly string[];
} {
  const envExports: Record<string, string> = {};
  const errorLogLines: string[] = [];

  for (const envExport of options.envExports) {
    if (
      envExport.source === "local-edge-runtime-launch-env-export-source-literal"
    ) {
      envExports[envExport.name] = envExport.value;
      continue;
    }

    if (
      envExport.source ===
      "local-edge-runtime-launch-env-export-source-overlay-env-files"
    ) {
      const overlay = options.overlayPlan.entries.find(
        (entry) => entry.id === envExport.overlayId,
      );
      if (overlay === undefined) {
        errorLogLines.push(
          `[local-edge:runtime-launch] Process '${options.commandId}' references missing dev overlay '${envExport.overlayId}'.`,
        );
        continue;
      }
      envExports[envExport.name] = overlay.envFileList;
      continue;
    }

    const surface = options.config.surfaces.find(
      (candidate) => candidate.id === envExport.surfaceId,
    );
    if (surface === undefined) {
      errorLogLines.push(
        `[local-edge:runtime-launch] Process '${options.commandId}' references missing surface '${envExport.surfaceId}'.`,
      );
      continue;
    }

    if (
      envExport.source ===
      "local-edge-runtime-launch-env-export-source-surface-host"
    ) {
      envExports[envExport.name] = LocalEdgeKit_buildRuntimeLaunchSurfaceHost({
        method: options.method,
        runtimeConfig: options.runtimeConfig,
        surfaceId: surface.id,
      });
      continue;
    }

    const upstreamPortEnvName = surface.healthcheck?.upstreamPortEnvName;
    const defaultUpstreamPort = surface.healthcheck?.defaultUpstreamPort;
    const upstreamPort =
      upstreamPortEnvName === undefined
        ? undefined
        : (options.env[upstreamPortEnvName] ??
          String(defaultUpstreamPort ?? ""));
    if (upstreamPort === undefined || upstreamPort.length === 0) {
      errorLogLines.push(
        `[local-edge:runtime-launch] Process '${options.commandId}' cannot resolve upstream port for surface '${surface.id}'.`,
      );
      continue;
    }
    envExports[envExport.name] = upstreamPort;
  }

  return {
    envExports,
    errorLogLines,
  };
}

/** Plans runtime status and DNS audit subprocesses from config/env without executing them. */
export function LocalEdgeKit_buildRuntimeLaunchRuntimeAuditPlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  fallbackMethod: string;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchRuntimeAuditPlan {
  const runtimeAudit = options.config.runtimeLaunch?.runtimeAudit;
  const sectionLogLine = "[local:section] Local Edge: Runtime Audit";
  if (runtimeAudit === undefined) {
    return {
      dnsAuditCommand: null,
      enabled: false,
      logLines: [sectionLogLine],
      method: options.fallbackMethod,
      statusCommand: null,
      strict: false,
      warningLines: [],
    };
  }

  const enabledValue =
    options.env[runtimeAudit.enabledEnvName] ??
    String(runtimeAudit.defaultEnabled);
  if (!LocalEdgeCore_isTruthy(enabledValue)) {
    return {
      dnsAuditCommand: null,
      enabled: false,
      logLines: [
        sectionLogLine,
        `[local] Skipping runtime local-edge audit (${runtimeAudit.enabledEnvName}=${enabledValue}).`,
      ],
      method: options.fallbackMethod,
      statusCommand: null,
      strict: runtimeAudit.defaultStrict,
      warningLines: [],
    };
  }

  const methodResolution = LocalEdgeKit_resolveRuntimeLaunchMethod({
    envName: runtimeAudit.methodEnvName,
    fallbackMethod: options.fallbackMethod,
    rawMethod: options.env[runtimeAudit.methodEnvName],
    supportedMethods: options.config.router.methods.map(
      (methodConfig) => methodConfig.method,
    ),
  });
  const strictValue =
    options.env[runtimeAudit.strictEnvName] ??
    String(runtimeAudit.defaultStrict);
  const strict = LocalEdgeCore_isTruthy(strictValue);
  const runnerArgs = runtimeAudit.scriptRunner.runnerArgs;
  const statusScriptPath = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: runtimeAudit.statusScriptPath,
  });
  const dnsAuditScriptPath = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: runtimeAudit.dnsAuditScriptPath,
  });

  return {
    dnsAuditCommand: {
      command: runtimeAudit.scriptRunner.command,
      args: [
        ...runnerArgs,
        dnsAuditScriptPath,
        "--method",
        methodResolution.method,
        strict ? "--strict" : "--no-strict",
      ],
    },
    enabled: true,
    logLines: [
      sectionLogLine,
      ...methodResolution.warningLines,
      "[local] Running runtime local-edge audit (domains=config-render/setup skipped, dns+edge enforced)...",
    ],
    method: methodResolution.method,
    statusCommand: {
      command: runtimeAudit.scriptRunner.command,
      args: [
        ...runnerArgs,
        statusScriptPath,
        "--method",
        methodResolution.method,
        "--require-running",
      ],
    },
    strict,
    warningLines: methodResolution.warningLines,
  };
}

/** Plans the runtime-launch background health monitor without starting it. */
export function LocalEdgeKit_buildRuntimeLaunchBackgroundHealthPlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  fallbackMethod: string;
  fallbackRealm: string;
  logDir: string;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchBackgroundHealthPlan {
  const backgroundHealth = options.config.runtimeLaunch?.backgroundHealth;
  const sectionLogLine =
    "[local:section] Local Edge: Background Health Monitor";
  if (backgroundHealth === undefined) {
    return {
      command: null,
      enabled: false,
      logFile: null,
      logLines: [sectionLogLine],
      method: options.fallbackMethod,
      strict: false,
      warningLines: [],
    };
  }

  const enabledValue =
    options.env[backgroundHealth.enabledEnvName] ??
    String(backgroundHealth.defaultEnabled);
  if (!LocalEdgeCore_isTruthy(enabledValue)) {
    return {
      command: null,
      enabled: false,
      logFile: null,
      logLines: [
        `[local] Skipping background local-edge health monitor (${backgroundHealth.enabledEnvName}=${enabledValue}).`,
      ],
      method: options.fallbackMethod,
      strict: backgroundHealth.defaultStrict,
      warningLines: [],
    };
  }

  const primaryMethodEnvName =
    options.config.env?.primaryMethodEnvName ?? "LOCAL_EDGE_PRIMARY_METHOD";
  const methodResolution = LocalEdgeKit_resolveRuntimeLaunchMethod({
    envName: backgroundHealth.methodEnvName,
    fallbackMethod: options.fallbackMethod,
    rawMethod:
      options.env[backgroundHealth.methodEnvName] ??
      options.env[primaryMethodEnvName],
    supportedMethods: options.config.router.methods.map(
      (methodConfig) => methodConfig.method,
    ),
  });
  const realmEnvName =
    options.config.env?.realmSlugEnvName ?? "LOCAL_EDGE_ENV_SLUG";
  const realm =
    options.env[backgroundHealth.realmEnvName] ??
    options.env[realmEnvName] ??
    options.fallbackRealm;
  const intervalMs =
    options.env[backgroundHealth.intervalMsEnvName] ??
    backgroundHealth.defaultIntervalMs;
  const steadyIntervalMs =
    options.env[backgroundHealth.steadyIntervalMsEnvName] ??
    backgroundHealth.defaultSteadyIntervalMs;
  const timeoutMs =
    options.env[backgroundHealth.timeoutMsEnvName] ??
    backgroundHealth.defaultTimeoutMs;
  const maxWaitMs =
    options.env[backgroundHealth.maxWaitMsEnvName] ??
    backgroundHealth.defaultMaxWaitMs;
  const strictValue =
    options.env[backgroundHealth.strictEnvName] ??
    String(backgroundHealth.defaultStrict);
  const strict = LocalEdgeCore_isTruthy(strictValue);
  const logFile = path.join(options.logDir, backgroundHealth.logFileName);
  const scriptPath = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: backgroundHealth.healthcheckScriptPath,
  });
  const args = [
    ...backgroundHealth.scriptRunner.runnerArgs,
    scriptPath,
    "--method",
    methodResolution.method,
    "--realm",
    realm,
    "--watch",
    "--interval-ms",
    intervalMs,
    "--steady-interval-ms",
    steadyIntervalMs,
    "--timeout-ms",
    timeoutMs,
  ];
  if (strict) {
    args.push("--strict");
  }
  if (maxWaitMs.length > 0) {
    args.push("--max-wait-ms", maxWaitMs);
  }

  return {
    command: {
      args,
      command: backgroundHealth.scriptRunner.command,
    },
    enabled: true,
    logFile,
    logLines: [
      sectionLogLine,
      ...methodResolution.warningLines,
      "[local] Starting background local-edge health monitor for status routes...",
      `[local] Health monitor args: ${args.join(" ")}`,
      `[local] Health monitor log: ${logFile}`,
    ],
    method: methodResolution.method,
    strict,
    warningLines: methodResolution.warningLines,
  };
}

/** Plans the active realm env watcher without starting it. */
export function LocalEdgeKit_buildRuntimeLaunchActiveEnvWatcherPlan(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  logDir: string;
  projectRoot: string;
}): LocalEdgeKit_RuntimeLaunchActiveEnvWatcherPlan {
  const activeEnvWatcher = options.config.runtimeLaunch?.activeEnvWatcher;
  if (activeEnvWatcher === undefined) {
    return {
      command: null,
      enabled: false,
      envOverrides: {},
      logFile: null,
      logLines: [],
    };
  }

  const enabledValue =
    options.env[activeEnvWatcher.enabledEnvName] ??
    String(activeEnvWatcher.defaultEnabled);
  if (!LocalEdgeCore_isTruthy(enabledValue)) {
    return {
      command: null,
      enabled: false,
      envOverrides: {},
      logFile: null,
      logLines: [
        `[local] Skipping active local-edge source watcher (${activeEnvWatcher.enabledEnvName}=${enabledValue}).`,
      ],
    };
  }

  const projectRootEnvName =
    options.config.env?.projectRootEnvName ?? "LOCAL_EDGE_PROJECT_ROOT";
  const envFileEnvName =
    options.config.env?.envFileEnvName ?? "LOCAL_EDGE_ENV_FILE";
  const rootEnvFileEnvName =
    options.config.env?.rootEnvFileEnvName ?? "LOCAL_EDGE_ROOT_ENV_FILE";
  const logFile = path.join(options.logDir, activeEnvWatcher.logFileName);
  const scriptPath = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: activeEnvWatcher.watcherScriptPath,
  });

  return {
    command: {
      command: activeEnvWatcher.scriptRunner.command,
      args: [...activeEnvWatcher.scriptRunner.runnerArgs, scriptPath],
    },
    enabled: true,
    envOverrides: {
      [projectRootEnvName]: options.projectRoot,
      [envFileEnvName]:
        options.env[envFileEnvName] ??
        path.join(
          options.projectRoot,
          activeEnvWatcher.defaultEnvFileRelativePath,
        ),
      [rootEnvFileEnvName]:
        options.env[rootEnvFileEnvName] ??
        activeEnvWatcher.defaultRootEnvFileValue,
    },
    logFile,
    logLines: [
      "[local:section] Local Edge: Source Env Watcher",
      "[local] Starting active local-edge source watcher...",
      `[local] Source watcher log: ${logFile}`,
    ],
  };
}

function LocalEdgeKit_resolveRuntimeLaunchMethod(options: {
  envName: string;
  fallbackMethod: string;
  rawMethod: string | undefined;
  supportedMethods: readonly string[];
}): {
  method: string;
  warningLines: readonly string[];
} {
  const warningLines: string[] = [];
  let method = options.rawMethod ?? options.fallbackMethod;
  if (method === "all") {
    warningLines.push(
      `[local] WARNING: ${options.envName}=all is deprecated in single-method mode. Using '${options.fallbackMethod}'.`,
    );
    method = options.fallbackMethod;
  }
  if (!options.supportedMethods.includes(method)) {
    warningLines.push(
      `[local] WARNING: Unsupported ${options.envName}='${method}'. Using '${options.fallbackMethod}'.`,
    );
    return {
      method: options.fallbackMethod,
      warningLines,
    };
  }
  return {
    method,
    warningLines,
  };
}

function LocalEdgeKit_runtimeLaunchPrimaryMethod(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
}): string {
  const primaryMethodEnvName =
    options.config.env?.primaryMethodEnvName ?? "LOCAL_EDGE_PRIMARY_METHOD";
  return (
    options.env[primaryMethodEnvName] ?? options.config.router.primaryMethod
  );
}

function LocalEdgeKit_runtimeLaunchRealmSlug(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
}): string {
  const realmSlugEnvName =
    options.config.env?.realmSlugEnvName ?? "LOCAL_EDGE_ENV_SLUG";
  return (
    options.env[realmSlugEnvName] ?? options.config.identity.defaultRealmSlug
  );
}

function LocalEdgeKit_runtimeLaunchLogFile(options: {
  config: LocalEdgeKit_Config;
  fileName: string;
  projectRoot: string;
}): string {
  const logDir = LocalEdgeKit_resolveRuntimeLaunchProjectPath({
    projectRoot: options.projectRoot,
    pathValue: options.config.lifecycle?.logDir ?? "logs/local-edge",
  });
  return path.join(logDir, options.fileName);
}

function LocalEdgeKit_resolveRuntimeLaunchProjectPath(options: {
  pathValue: string;
  projectRoot: string;
}): string {
  if (path.isAbsolute(options.pathValue)) {
    return options.pathValue;
  }
  return path.join(options.projectRoot, options.pathValue);
}

/** Builds a dependency-check report for configured runtime-launch packages. */
export function LocalEdgeKit_buildRuntimeLaunchDependencyCheckReport(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  filesystem: LocalEdgeKit_RuntimeLaunchFilesystem;
  repoRoot: string;
}): LocalEdgeKit_RuntimeLaunchDependencyCheckReport {
  const dependencyCheck = options.config.runtimeLaunch?.dependencyCheck;
  if (dependencyCheck === undefined) {
    return {
      exitCode: 0,
      failures: [],
      logLines: [],
      skipped: false,
    };
  }

  const skipValue = options.env[dependencyCheck.skipEnvName] ?? "false";
  if (LocalEdgeCore_isTruthy(skipValue)) {
    return {
      exitCode: 0,
      failures: [],
      logLines: [
        `[local] Skipping dependency check (${dependencyCheck.skipEnvName}=${skipValue}).`,
      ],
      skipped: true,
    };
  }

  const failures: LocalEdgeKit_RuntimeLaunchDependencyCheckFailure[] = [];
  for (const packageConfig of dependencyCheck.packages) {
    const packageRoot = path.join(
      options.repoRoot,
      packageConfig.packageRelativePath,
    );
    const missingDependencyNames = LocalEdgeKit_findMissingRuntimeLaunchNpmDeps(
      {
        config: options.config,
        filesystem: options.filesystem,
        packageRoot,
        repoRoot: options.repoRoot,
      },
    );
    if (missingDependencyNames.length > 0) {
      failures.push({
        id: packageConfig.id,
        missingDependencyNames,
        packageRelativePath: packageConfig.packageRelativePath,
        packageRoot,
      });
    }
  }

  const logLines = LocalEdgeKit_buildRuntimeLaunchDependencyCheckLogLines({
    failures,
    installAllCommand: dependencyCheck.installAllCommand,
    skipCommand: dependencyCheck.skipCommand,
  });
  return {
    exitCode: failures.length > 0 ? 1 : 0,
    failures,
    logLines,
    skipped: false,
  };
}

function LocalEdgeKit_buildRuntimeLaunchDependencyCheckLogLines(options: {
  failures: readonly LocalEdgeKit_RuntimeLaunchDependencyCheckFailure[];
  installAllCommand: string | undefined;
  skipCommand: string | undefined;
}): string[] {
  const logLines = [
    "[local:section] Local Edge: Package Dependencies",
    "[local] Checking npm dependencies for all packages...",
  ];
  for (const failure of options.failures) {
    logLines.push(
      "",
      `[local] ❌ DEPENDENCY CHECK FAILED: ${failure.packageRelativePath}`,
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "Missing packages:",
    );
    for (const dependencyName of failure.missingDependencyNames) {
      logLines.push(`  - ${dependencyName}`);
    }
    logLines.push(
      "",
      "📦 INSTALL COMMAND:",
      `   cd ${failure.packageRoot} && npm install`,
      "",
      "💡 TIPS:",
      "   - If you recently pulled changes, run: npm install",
      "   - For a clean install: rm -rf node_modules && npm install",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
    );
  }

  if (options.failures.length === 0) {
    logLines.push("[local] ✅ All package dependencies are installed.");
    return logLines;
  }

  logLines.push(
    "",
    "[local] ❌ DEPENDENCY CHECK FAILED",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "Packages with missing dependencies:",
  );
  for (const failure of options.failures) {
    logLines.push(`  - ${failure.packageRelativePath}`);
  }
  if (options.installAllCommand !== undefined) {
    logLines.push(
      "",
      "🚀 TO INSTALL ALL DEPENDENCIES:",
      `   ${options.installAllCommand}`,
    );
  }
  logLines.push("", "   Or install individually:");
  for (const failure of options.failures) {
    logLines.push(`   cd ${failure.packageRoot} && npm install`);
  }
  logLines.push(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
  );
  if (options.skipCommand !== undefined) {
    logLines.push("To skip this check, run with:", `   ${options.skipCommand}`);
  }
  return logLines;
}

/** Builds config-ordered `concurrently` args for the active runtime split mode. */
export function LocalEdgeKit_buildRuntimeLaunchConcurrentlyArgsPlan(options: {
  config: LocalEdgeKit_Config;
  pathExists: (filePath: string) => boolean;
  processCommands: Readonly<Record<string, string>>;
  projectRoot: string;
  splitModeEnabled: boolean;
}): LocalEdgeKit_RuntimeLaunchConcurrentlyArgsPlan {
  const names: string[] = [];
  const colors: string[] = [];
  const commands: string[] = [];
  const missingCommandProcessIds: string[] = [];
  const skippedProcesses: LocalEdgeKit_RuntimeLaunchSkippedProcess[] = [];
  const processConfigs =
    options.config.runtimeLaunch?.concurrentlyProcesses ?? [];

  for (const processConfig of processConfigs) {
    const includeProcess = options.splitModeEnabled
      ? processConfig.includeWhenSplitModeEnabled
      : processConfig.includeWhenSplitModeDisabled;
    if (!includeProcess) {
      continue;
    }

    const optionalPath =
      processConfig.optionalProjectRelativePath === undefined
        ? undefined
        : path.join(
            options.projectRoot,
            processConfig.optionalProjectRelativePath,
          );
    if (optionalPath !== undefined && !options.pathExists(optionalPath)) {
      skippedProcesses.push({
        id: processConfig.id,
        logLines: processConfig.optionalAbsentLogLines ?? [],
      });
      continue;
    }

    const command = options.processCommands[processConfig.id];
    if (command === undefined) {
      missingCommandProcessIds.push(processConfig.id);
      continue;
    }

    names.push(processConfig.name);
    colors.push(processConfig.color);
    commands.push(command);
  }

  return {
    concurrentArgs: [
      "--names",
      names.join(","),
      "--prefix",
      "{name}",
      "--prefix-colors",
      colors.join(","),
      ...commands,
    ],
    missingCommandProcessIds,
    skippedProcesses,
  };
}

function LocalEdgeKit_runtimeLaunchSurfaceIds(options: {
  config: LocalEdgeKit_Config;
  runtimeConfig: LocalEdgeKit_RuntimeConfig;
}): readonly string[] {
  const configured = options.config.runtimeLaunch?.startupUrlSurfaceIds;
  if (configured !== undefined) {
    return configured;
  }
  return options.runtimeConfig.surfaces
    .filter((surface) => surface.includeInUrlMatrix !== false)
    .map((surface) => surface.id);
}

function LocalEdgeKit_findRuntimeLaunchSurface(options: {
  runtimeConfig: LocalEdgeKit_RuntimeConfig;
  surfaceId: string;
}): LocalEdgeKit_SurfaceConfig {
  const surface = options.runtimeConfig.surfaces.find(
    (candidate) => candidate.id === options.surfaceId,
  );
  if (surface !== undefined) {
    return surface;
  }
  throw new Error(
    `[local-edge:runtime-launch] Surface '${options.surfaceId}' is not present in config.surfaces.`,
  );
}

/** Builds the canonical local-edge host for one configured runtime surface. */
export function LocalEdgeKit_buildRuntimeLaunchSurfaceHost(options: {
  method: string;
  runtimeConfig: LocalEdgeKit_RuntimeConfig;
  surfaceId: string;
}): string {
  return [
    options.surfaceId,
    options.runtimeConfig.realmSlug,
    options.method,
    options.runtimeConfig.developerSlug,
    options.runtimeConfig.rootZone,
  ].join(".");
}

/** Resolves app/status URL rows for the configured startup URL surface set. */
export function LocalEdgeKit_buildRuntimeLaunchSurfaceUrls(
  options: LocalEdgeKit_BuildRuntimeLaunchSurfaceUrlsOptions,
): LocalEdgeKit_RuntimeLaunchSurfaceUrl[] {
  const commandLabel = options.commandLabel ?? "local-edge:runtime-launch";
  const runtimeConfig = LocalEdgeKit_resolveRuntimeConfig({
    config: options.config,
    env: options.env,
    projectRoot: options.projectRoot,
  });
  const methodName = options.method ?? runtimeConfig.primaryMethod;
  const method = LocalEdgeKit_getRuntimeMethod({
    commandLabel,
    runtimeConfig,
    method: methodName,
  });
  const surfaceIds = LocalEdgeKit_runtimeLaunchSurfaceIds({
    config: options.config,
    runtimeConfig,
  });

  return surfaceIds.map((surfaceId) => {
    const surface = LocalEdgeKit_findRuntimeLaunchSurface({
      runtimeConfig,
      surfaceId,
    });
    const host = LocalEdgeKit_buildRuntimeLaunchSurfaceHost({
      runtimeConfig,
      method: method.method,
      surfaceId,
    });
    return {
      appPath: surface.appPath,
      appUrl: LocalEdgeCore_formatHttpsUrl({
        host,
        port: method.listenPort,
        requestPath: surface.appPath,
      }),
      host,
      method: method.method,
      statusPath: surface.statusPath,
      statusUrl: LocalEdgeCore_formatHttpsUrl({
        host,
        port: method.listenPort,
        requestPath: surface.statusPath,
      }),
      surfaceId,
    };
  });
}
