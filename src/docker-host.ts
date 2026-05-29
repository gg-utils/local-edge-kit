/**
 * @fileoverview Product-neutral Docker host-execution helpers for local-edge kit adapters.
 *
 * Handles daemon readiness, nginx-docker container lifecycle, mount inspection, runtime mount
 * alignment, and method start/stop command execution above the agnostic `@gg-utils/local-edge-core`
 * planning primitives. Consumers import this module when they want the default Node host I/O
 * implementation instead of injecting their own Docker command runner.
 *
 * @example
 * ```typescript
 * import { LocalEdgeDocker_daemonReady, LocalEdgeDocker_nginxContainerRunning } from "@gg-utils/local-edge-kit/docker-host";
 *
 * if (LocalEdgeDocker_daemonReady()) { ... }
 * ```
 *
 * @testing Package: `npm run local-edge-kit:type-check`; root compatibility: `NODE_OPTIONS='--experimental-vm-modules' npx jest --config jest.config.ts scripts/local-edge --runInBand`.
 * @see packages/local-edge-core/src/docker-lifecycle.ts - Generic Docker command planning primitives.
 * @documentation reviewed=2026-05-20 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { existsSync, openSync } from "node:fs";
import { spawnSync, type StdioOptions } from "node:child_process";
import {
  LocalEdgeCore_buildBashCommandPlan,
  LocalEdgeCore_buildMethodLogFilePath,
  LocalEdgeCore_buildNohupBashCommandPlan,
  LocalEdgeCore_dockerLifecycleContainerId,
  LocalEdgeCore_dockerLifecycleContainerRunning,
  LocalEdgeCore_dockerLifecycleDaemonReady,
  LocalEdgeCore_dockerLifecycleMountSourceForDestination,
  LocalEdgeCore_dockerLifecycleReloadNginxContainer,
  LocalEdgeCore_nginxDockerRuntimeMatchesArtifacts,
  LocalEdgeCore_parseDockerWaitPolicy,
  LocalEdgeCore_resolveDockerDesktopAppPath,
  LocalEdgeCore_resolveNginxDockerConfigPath,
  LocalEdgeCore_resolveTlsCertPath,
  LocalEdgeCore_resolveTlsKeyPath,
  LocalEdgeCore_isMacos,
  LocalEdgeCore_isPortListening,
  LocalEdgeCore_isTruthy,
  LocalEdgeCore_resolveCommandPath,
  LocalEdgeCore_waitForRuntimeReady,
  type LocalEdgeCore_DockerLifecycleCommandInvocation,
  type LocalEdgeCore_DockerLifecycleCommandResult,
} from "@gg-utils/local-edge-core";

import type { LocalEdgeKit_Config } from "./config.js";
import type {
  LocalEdgeKit_EnsureRunningRouterProbe,
  LocalEdgeKit_EnsureRunningRuntimeHooks,
} from "./lifecycle-plans.js";
import {
  LocalEdgeKit_getRuntimeMethod,
  LocalEdgeKit_resolveRuntimeConfig,
} from "./runtime-config.js";

export type LocalEdgeKit_DockerHostValidationResult =
  | { ok: true }
  | { ok: false; message: string };

type LocalEdgeKit_DockerHostMethodFacts =
  | {
      configPath: string;
      expectedCertPath: string;
      expectedKeyPath: string;
      expectedNginxConfPath: string;
      kind: "nginx-docker";
      listenHost: string;
      listenPort: number;
      projectName: string;
    }
  | {
      kind: "unsupported";
    };

const DOCKER_WAIT_POLL_MS = 2000;

function LocalEdgeKit_dockerHostResolveMethodFacts(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  method: string;
  projectRoot?: string | null;
}): LocalEdgeKit_DockerHostMethodFacts {
  if (options.method !== "nginx-docker") {
    return { kind: "unsupported" };
  }

  const runtimeConfig = LocalEdgeKit_resolveRuntimeConfig({
    config: options.config,
    env: options.env,
    projectRoot: options.projectRoot,
  });
  const runtimeMethod = LocalEdgeKit_getRuntimeMethod({
    commandLabel: "local-edge:docker-host",
    runtimeConfig,
    method: options.method,
  });
  if (runtimeMethod.kind !== "nginx-docker") {
    return { kind: "unsupported" };
  }

  return {
    configPath: runtimeMethod.composePath,
    expectedCertPath: LocalEdgeCore_resolveTlsCertPath({
      generatedDir: runtimeConfig.generatedDir,
      rawCertPath: options.env.LOCAL_EDGE_TLS_CERT_PATH,
    }),
    expectedKeyPath: LocalEdgeCore_resolveTlsKeyPath({
      generatedDir: runtimeConfig.generatedDir,
      rawKeyPath: options.env.LOCAL_EDGE_TLS_KEY_PATH,
    }),
    expectedNginxConfPath: LocalEdgeCore_resolveNginxDockerConfigPath({
      generatedDir: runtimeConfig.generatedDir,
      rawNginxConfigPath: options.env.LOCAL_EDGE_NGINX_DOCKER_NGINX_CONFIG_PATH,
    }),
    kind: "nginx-docker",
    listenHost: runtimeMethod.listenHost,
    listenPort: runtimeMethod.listenPort,
    projectName: runtimeMethod.composeProjectName,
  };
}

/**
 * Resolves the `docker` CLI path for synchronous compose/exec probes in this module.
 *
 * @remarks
 * Callers treat a null result as "docker unavailable" and skip Docker I/O.
 */
function LocalEdgeDocker_commandPath(): string | null {
  return LocalEdgeCore_resolveCommandPath("docker");
}

/**
 * Runs one Docker command invocation planned by `@gg-utils/local-edge-core`.
 *
 * @remarks
 * The adapter keeps binary resolution, subprocess stdio, and timeout execution outside the package.
 */
function LocalEdgeDocker_runDockerCommand(
  invocation: LocalEdgeCore_DockerLifecycleCommandInvocation,
): LocalEdgeCore_DockerLifecycleCommandResult {
  const dockerCommand = LocalEdgeDocker_commandPath();
  if (dockerCommand === null) {
    return { status: 1, stdout: null };
  }

  const stdio: StdioOptions =
    invocation.mode === "pipe-stdout"
      ? ["ignore", "pipe", "ignore"]
      : ["ignore", "ignore", "ignore"];
  const result = spawnSync(dockerCommand, [...invocation.args], {
    stdio,
    timeout: invocation.timeoutMs,
  });

  return {
    status: result.status,
    stdout:
      result.stdout === null || result.stdout === undefined
        ? null
        : result.stdout.toString("utf-8"),
  };
}

/**
 * Returns true when `docker info` succeeds (matches `local_edge_docker_daemon_ready`).
 */
export function LocalEdgeDocker_daemonReady(): boolean {
  return LocalEdgeCore_dockerLifecycleDaemonReady({
    runDockerCommand: LocalEdgeDocker_runDockerCommand,
  });
}

/**
 * Returns the Docker Desktop `.app` path if installed, or null (matches `local_edge_docker_desktop_app_path`).
 */
export function LocalEdgeDocker_desktopAppPath(): string | null {
  return LocalEdgeCore_resolveDockerDesktopAppPath({
    homeDir: process.env.HOME ?? "",
    pathExists: existsSync,
  });
}

/**
 * Attempts to launch Docker Desktop on macOS (matches `local_edge_try_start_docker_desktop`).
 */
export function LocalEdgeDocker_tryStartDesktop(env: NodeJS.ProcessEnv): void {
  if (!LocalEdgeCore_isMacos()) {
    return;
  }
  if (!LocalEdgeCore_isTruthy(env.LOCAL_EDGE_DOCKER_AUTO_LAUNCH ?? "true")) {
    return;
  }
  const appPath = LocalEdgeDocker_desktopAppPath();
  if (appPath === null) {
    return;
  }
  spawnSync("open", ["-a", "Docker"], {
    stdio: "ignore",
    timeout: 10_000,
  });
}

/**
 * Waits up to `LOCAL_EDGE_DOCKER_WAIT_TIMEOUT_SECONDS` (default 120s) for `docker info`
 * to succeed, optionally launching Docker Desktop. Matches `local_edge_ensure_docker_ready_for_startup`.
 */
export function LocalEdgeDocker_ensureReadyForStartup(
  env: NodeJS.ProcessEnv,
): LocalEdgeKit_DockerHostValidationResult {
  if (LocalEdgeDocker_daemonReady()) {
    return { ok: true };
  }

  LocalEdgeDocker_tryStartDesktop(env);

  const { timeoutSeconds, intervalMs } = LocalEdgeCore_parseDockerWaitPolicy({
    timeoutSecondsRaw: env.LOCAL_EDGE_DOCKER_WAIT_TIMEOUT_SECONDS,
    intervalSecondsRaw: env.LOCAL_EDGE_DOCKER_WAIT_INTERVAL_SECONDS,
  });

  if (
    LocalEdgeCore_waitForRuntimeReady({
      timeoutSeconds,
      nowMs: Date.now,
      isRunning: LocalEdgeDocker_daemonReady,
      sleep: () => {
        spawnSync("sleep", [String(intervalMs / 1000)], {
          stdio: "ignore",
          timeout: intervalMs + 1000,
        });
      },
    })
  ) {
    return { ok: true };
  }

  return {
    ok: false,
    message: `Docker daemon did not become ready within ${String(timeoutSeconds)}s.`,
  };
}

/**
 * Returns true when the nginx-docker container is running (matches
 * `local_edge_nginx_docker_container_running`).
 */
export function LocalEdgeDocker_nginxContainerRunning(options: {
  projectName: string;
  configPath: string;
}): boolean {
  return LocalEdgeCore_dockerLifecycleContainerRunning({
    projectName: options.projectName,
    composePath: options.configPath,
    runDockerCommand: LocalEdgeDocker_runDockerCommand,
  });
}

/**
 * Returns the container ID for the nginx-docker compose project, or null
 * (matches `local_edge_nginx_docker_container_id`).
 */
export function LocalEdgeDocker_nginxContainerId(options: {
  projectName: string;
  configPath: string;
}): string | null {
  return LocalEdgeCore_dockerLifecycleContainerId({
    projectName: options.projectName,
    composePath: options.configPath,
    runDockerCommand: LocalEdgeDocker_runDockerCommand,
  });
}

/**
 * Reloads nginx inside the running container and returns `true` on success
 * (matches `local_edge_nginx_docker_reload_current_container`).
 */
export function LocalEdgeDocker_nginxReloadContainer(options: {
  projectName: string;
  configPath: string;
}): boolean {
  return LocalEdgeCore_dockerLifecycleReloadNginxContainer({
    projectName: options.projectName,
    composePath: options.configPath,
    runDockerCommand: LocalEdgeDocker_runDockerCommand,
  });
}

/**
 * Returns the host mount source path for a given container mount destination
 * (matches `local_edge_docker_mount_source_for_destination`).
 */
export function LocalEdgeDocker_mountSourceForDestination(options: {
  containerId: string;
  destPath: string;
}): string {
  return LocalEdgeCore_dockerLifecycleMountSourceForDestination({
    containerId: options.containerId,
    destinationPath: options.destPath,
    runDockerCommand: LocalEdgeDocker_runDockerCommand,
  });
}

/**
 * Returns true when the running container mounts match the expected artifact paths
 * (matches `local_edge_nginx_docker_runtime_matches_current_artifacts`).
 */
export function LocalEdgeDocker_runtimeMatchesArtifacts(options: {
  containerId: string;
  expectedConfigPath: string;
  expectedNginxConfPath: string;
  expectedCertPath: string;
  expectedKeyPath: string;
}): boolean {
  return LocalEdgeCore_nginxDockerRuntimeMatchesArtifacts({
    containerId: options.containerId,
    expectedNginxConfPath: options.expectedNginxConfPath,
    expectedCertPath: options.expectedCertPath,
    expectedKeyPath: options.expectedKeyPath,
    resolveMountSource: (mountOptions) =>
      LocalEdgeDocker_mountSourceForDestination({
        containerId: mountOptions.containerId,
        destPath: mountOptions.destinationPath,
      }),
  });
}

/**
 * Returns true when the method runtime (container + port) is running
 * (matches `local_edge_method_runtime_is_running`).
 */
export function LocalEdgeDocker_methodIsRunning(options: {
  method: string;
  projectName: string;
  configPath: string;
  port: number;
  host: string;
}): boolean {
  if (options.method === "nginx-docker") {
    return (
      LocalEdgeDocker_nginxContainerRunning({
        projectName: options.projectName,
        configPath: options.configPath,
      }) &&
      LocalEdgeCore_isPortListening({
        port: options.port,
        host: options.host,
      })
    );
  }
  return false;
}

/**
 * Polls until the method runtime is running or `timeoutSeconds` elapses.
 * Matches `local_edge_wait_for_method_runtime`.
 */
export function LocalEdgeDocker_waitForRuntime(options: {
  method: string;
  projectName: string;
  configPath: string;
  port: number;
  host: string;
  timeoutSeconds: number;
}): boolean {
  return LocalEdgeCore_waitForRuntimeReady({
    timeoutSeconds: options.timeoutSeconds,
    nowMs: Date.now,
    isRunning: () => LocalEdgeDocker_methodIsRunning(options),
    sleep: () => {
      spawnSync("sleep", ["1"], {
        stdio: "ignore",
        timeout: DOCKER_WAIT_POLL_MS,
      });
    },
  });
}

/**
 * Runs a start command via `nohup bash -lc` in the background (matches `local_edge_run_start_command`).
 */
export function LocalEdgeDocker_runStartCommand(options: {
  command: string;
  logDir: string;
  method: string;
}): void {
  const logFile = LocalEdgeCore_buildMethodLogFilePath({
    logDir: options.logDir,
    method: options.method,
  });
  const commandPlan = LocalEdgeCore_buildNohupBashCommandPlan(options.command);
  spawnSync(commandPlan.command, [...commandPlan.args], {
    stdio: ["ignore", openSync(logFile, "a"), openSync(logFile, "a")],
    timeout: 30_000,
  });
}

/**
 * Runs a stop command via `bash -lc` (matches `local_edge_run_stop_command`).
 */
export function LocalEdgeDocker_runStopCommand(options: {
  command: string;
  logDir: string;
  method: string;
}): void {
  const logFile = LocalEdgeCore_buildMethodLogFilePath({
    logDir: options.logDir,
    method: options.method,
  });
  const commandPlan = LocalEdgeCore_buildBashCommandPlan(options.command);
  spawnSync(commandPlan.command, [...commandPlan.args], {
    stdio: ["ignore", openSync(logFile, "a"), openSync(logFile, "a")],
    timeout: 30_000,
  });
}

/** Creates default Docker-backed ensure-running hooks for lifecycle adapters. */
export function LocalEdgeKit_createDockerHostEnsureRunningHooks(options: {
  config: LocalEdgeKit_Config;
  projectRoot?: string | null;
  routerHostProbe: (options: {
    routerProbe: LocalEdgeKit_EnsureRunningRouterProbe;
  }) => boolean;
}): LocalEdgeKit_EnsureRunningRuntimeHooks {
  return {
    ensureMethodReadyForStartup({ env, method }) {
      if (method !== "nginx-docker") {
        return { ok: true };
      }
      return LocalEdgeDocker_ensureReadyForStartup(env);
    },
    methodRuntimeMatchesCurrentArtifacts({ env, method }) {
      const methodFacts = LocalEdgeKit_dockerHostResolveMethodFacts({
        config: options.config,
        env,
        method,
        projectRoot: options.projectRoot,
      });
      if (methodFacts.kind !== "nginx-docker") {
        return true;
      }

      const containerId = LocalEdgeDocker_nginxContainerId({
        projectName: methodFacts.projectName,
        configPath: methodFacts.configPath,
      });
      if (containerId === null) {
        return false;
      }

      return LocalEdgeDocker_runtimeMatchesArtifacts({
        containerId,
        expectedConfigPath: methodFacts.configPath,
        expectedNginxConfPath: methodFacts.expectedNginxConfPath,
        expectedCertPath: methodFacts.expectedCertPath,
        expectedKeyPath: methodFacts.expectedKeyPath,
      });
    },
    reloadRunningMethod({ env, method }) {
      const methodFacts = LocalEdgeKit_dockerHostResolveMethodFacts({
        config: options.config,
        env,
        method,
        projectRoot: options.projectRoot,
      });
      if (methodFacts.kind !== "nginx-docker") {
        return true;
      }

      return LocalEdgeDocker_nginxReloadContainer({
        projectName: methodFacts.projectName,
        configPath: methodFacts.configPath,
      });
    },
    routerHostProbe({ routerProbe }) {
      return options.routerHostProbe({ routerProbe });
    },
  };
}
