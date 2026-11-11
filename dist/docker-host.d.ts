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
import type { LocalEdgeKit_Config } from "./config.js";
import type { LocalEdgeKit_EnsureRunningRouterProbe, LocalEdgeKit_EnsureRunningRuntimeHooks } from "./lifecycle-plans.js";
export type LocalEdgeKit_DockerHostValidationResult = {
    ok: true;
} | {
    ok: false;
    message: string;
};
/**
 * Returns true when `docker info` succeeds (matches `local_edge_docker_daemon_ready`).
 */
export declare function LocalEdgeDocker_daemonReady(): boolean;
/**
 * Returns the Docker Desktop `.app` path if installed, or null (matches `local_edge_docker_desktop_app_path`).
 */
export declare function LocalEdgeDocker_desktopAppPath(): string | null;
/**
 * Attempts to launch Docker Desktop on macOS (matches `local_edge_try_start_docker_desktop`).
 */
export declare function LocalEdgeDocker_tryStartDesktop(env: NodeJS.ProcessEnv): void;
/**
 * Waits up to `LOCAL_EDGE_DOCKER_WAIT_TIMEOUT_SECONDS` (default 120s) for `docker info`
 * to succeed, optionally launching Docker Desktop. Matches `local_edge_ensure_docker_ready_for_startup`.
 */
export declare function LocalEdgeDocker_ensureReadyForStartup(env: NodeJS.ProcessEnv): LocalEdgeKit_DockerHostValidationResult;
/**
 * Returns true when the nginx-docker container is running (matches
 * `local_edge_nginx_docker_container_running`).
 */
export declare function LocalEdgeDocker_nginxContainerRunning(options: {
    projectName: string;
    configPath: string;
}): boolean;
/**
 * Returns the container ID for the nginx-docker compose project, or null
 * (matches `local_edge_nginx_docker_container_id`).
 */
export declare function LocalEdgeDocker_nginxContainerId(options: {
    projectName: string;
    configPath: string;
}): string | null;
/**
 * Reloads nginx inside the running container and returns `true` on success
 * (matches `local_edge_nginx_docker_reload_current_container`).
 */
export declare function LocalEdgeDocker_nginxReloadContainer(options: {
    projectName: string;
    configPath: string;
}): boolean;
/**
 * Returns the host mount source path for a given container mount destination
 * (matches `local_edge_docker_mount_source_for_destination`).
 */
export declare function LocalEdgeDocker_mountSourceForDestination(options: {
    containerId: string;
    destPath: string;
}): string;
/**
 * Returns true when the running container mounts match the expected artifact paths
 * (matches `local_edge_nginx_docker_runtime_matches_current_artifacts`).
 */
export declare function LocalEdgeDocker_runtimeMatchesArtifacts(options: {
    containerId: string;
    expectedConfigPath: string;
    expectedNginxConfPath: string;
    expectedCertPath: string;
    expectedKeyPath: string;
}): boolean;
/**
 * Returns true when the method runtime (container + port) is running
 * (matches `local_edge_method_runtime_is_running`).
 */
export declare function LocalEdgeDocker_methodIsRunning(options: {
    method: string;
    projectName: string;
    configPath: string;
    port: number;
    host: string;
}): boolean;
/**
 * Polls until the method runtime is running or `timeoutSeconds` elapses.
 * Matches `local_edge_wait_for_method_runtime`.
 */
export declare function LocalEdgeDocker_waitForRuntime(options: {
    method: string;
    projectName: string;
    configPath: string;
    port: number;
    host: string;
    timeoutSeconds: number;
}): boolean;
/**
 * Runs a start command via `nohup bash -lc` in the background (matches `local_edge_run_start_command`).
 */
export declare function LocalEdgeDocker_runStartCommand(options: {
    command: string;
    logDir: string;
    method: string;
}): void;
/**
 * Runs a stop command via `bash -lc` (matches `local_edge_run_stop_command`).
 */
export declare function LocalEdgeDocker_runStopCommand(options: {
    command: string;
    logDir: string;
    method: string;
}): void;
/** Creates default Docker-backed ensure-running hooks for lifecycle adapters. */
export declare function LocalEdgeKit_createDockerHostEnsureRunningHooks(options: {
    config: LocalEdgeKit_Config;
    projectRoot?: string | null | undefined;
    routerHostProbe: (options: {
        routerProbe: LocalEdgeKit_EnsureRunningRouterProbe;
    }) => boolean;
}): LocalEdgeKit_EnsureRunningRuntimeHooks;
