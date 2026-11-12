/**
 * @fileoverview One-command supervisor CLI: `status`, `up`, `down`, `health`, `logs`, `plan`,
 * `expose` and `unexpose` over a project-owned supervisor config and an exposure backend.
 *
 * The project passes its config; this module owns parsing, dispatch and output. The exposure
 * backend comes from `@gg-utils/local-edge-core/exposure` and is picked by `--backend=<name>` or
 * the config default. `expose`/`unexpose` are dry runs unless `--apply` is given.
 * Flow: argv -> command -> supervisor/backend calls -> table or JSON on stdout -> exit code.
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor-cli.unit.test.ts
 *
 * @see src/supervisor.ts - Process inspection, start, stop and health.
 * @documentation reviewed=2026-11-11 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { type LocalEdgeCore_ExposureBackend, type LocalEdgeCore_ExposureHostnamesConfig, type LocalEdgeCore_ExposureManifest } from "@gg-utils/local-edge-core/exposure";
import { type LocalEdgeKit_ExtraAppsSource } from "./extra-apps.js";
import { type LocalEdgeKit_SupervisorRouterConfig } from "./supervisor-router.js";
import { type LocalEdgeKit_SupervisedApp, type LocalEdgeKit_SupervisorHost, type LocalEdgeKit_SupervisorWriter } from "./supervisor.js";
/** Project-owned supervisor config. */
export type LocalEdgeKit_SupervisorConfig = {
    /** Command name shown in usage. */
    commandName?: string | undefined;
    apps: readonly LocalEdgeKit_SupervisedApp[];
    /**
     * Per-machine route-only apps merged with `apps` before every command, for example
     * `LocalEdgeKit_createExtraAppsFileSource({ filePath })`. Duplicate ids or hosts are refused.
     */
    extraApps?: readonly LocalEdgeKit_ExtraAppsSource[] | undefined;
    exposure: {
        /**
         * Backend used when `--backend` is not given: `ports` (default, tailnet HTTPS port per app)
         * or `hostnames` (plan-only SNI hosts). Any registered core backend name also works.
         */
        backend?: "ports" | "hostnames" | (string & {}) | undefined;
        /** Settings for the `hostnames` backend. */
        hostnames?: LocalEdgeCore_ExposureHostnamesConfig | undefined;
        /**
         * Router lifecycle for the `hostnames` backend. When set, `up` writes the rendered nginx
         * config and starts or reloads nginx, `down` stops it, and `status` shows it.
         */
        router?: LocalEdgeKit_SupervisorRouterConfig | undefined;
        /** Edge ports that are never mapped, changed or turned off. */
        protectedPorts: readonly number[];
        hostname?: string | undefined;
        rootZone?: string | undefined;
    };
};
/** Options for `LocalEdgeKit_runSupervisorCli`. */
export type LocalEdgeKit_RunSupervisorCliOptions = {
    args: readonly string[];
    config: LocalEdgeKit_SupervisorConfig;
    host?: LocalEdgeKit_SupervisorHost | undefined;
    createBackend?: ((name: string) => LocalEdgeCore_ExposureBackend) | undefined;
    stdout?: LocalEdgeKit_SupervisorWriter | undefined;
    stderr?: LocalEdgeKit_SupervisorWriter | undefined;
    /** Runs `tail -F` for `logs --follow`. Injected in tests. */
    followLog?: ((logFile: string, lines: number) => Promise<number>) | undefined;
};
/**
 * Merges the config's extra-app sources into its apps; a config without sources is returned as is.
 *
 * @param config - Supervisor config, possibly with `extraApps` sources.
 * @returns The config with source apps appended to `apps`.
 * @throws When a source is unreadable or an app clashes with an existing id or host.
 * @example
 * ```typescript
 * LocalEdgeKit_resolveSupervisorConfig(config).apps.map((app) => app.id);
 * ```
 */
export declare function LocalEdgeKit_resolveSupervisorConfig(config: LocalEdgeKit_SupervisorConfig): LocalEdgeKit_SupervisorConfig;
/**
 * Builds the backend-neutral exposure manifest from supervisor apps.
 *
 * @param config - Supervisor config.
 * @returns The manifest the core exposure backends plan from.
 * @example
 * ```typescript
 * LocalEdgeKit_buildExposureManifest(config).apps.map((app) => app.id);
 * ```
 */
export declare function LocalEdgeKit_buildExposureManifest(config: LocalEdgeKit_SupervisorConfig): LocalEdgeCore_ExposureManifest;
/**
 * Renders rows as a padded text table.
 *
 * @param header - Column titles.
 * @param rows - Cells; missing cells render empty.
 * @returns Text with one line per row and a trailing newline.
 * @example
 * ```typescript
 * LocalEdgeKit_renderTable(["APP", "STATE"], [["web", "running"]]);
 * ```
 */
export declare function LocalEdgeKit_renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string;
/**
 * Runs the supervisor CLI.
 *
 * @param options - Argv after the program name, config, and optional injected host, backend
 * factory, writers and log follower.
 * @returns A process exit code: 0 ok, 1 a step failed or an app is unhealthy, 2 usage or config
 * error (including any thrown error, whose message is printed).
 * @example
 * ```typescript
 * process.exitCode = await LocalEdgeKit_runSupervisorCli({ args: process.argv.slice(2), config });
 * ```
 */
export declare function LocalEdgeKit_runSupervisorCli(options: LocalEdgeKit_RunSupervisorCliOptions): Promise<number>;
