/**
 * @fileoverview Config-driven startup dispatcher for local-edge kit adapters.
 *
 * The kit owns reusable `run <command> -- <args>` dispatch: usage rendering, package-core argv
 * parsing, implementation filename resolution, startup env projection, and child spawn planning.
 * Consumers still choose the implementation directory and the command bodies through config.
 *
 * @testing Jest unit: cd packages/local-edge-kit && npm run test -- src/startup-cli.unit.test.ts
 * @testing Jest unit: cd packages/local-edge-kit && npm run test
 *
 * @see packages/local-edge-kit/src/config.ts - Declares startup invocation, implementation directory, and per-command impl basename overrides this dispatcher reads before spawning.
 * @see packages/local-edge-kit/src/env.ts - Resolves the repo project root used when startup config supplies a relative implementation directory path.
 * @see packages/local-edge-core/src/startup-cli.ts - Owns argv parsing, usage rendering, spawn argv planning, and exit-code constants imported by this kit orchestration layer.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - Defines the audited file-overview tag order and metadata enforced on this module header.
 *
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { type StdioOptions } from "node:child_process";
import { type LocalEdge_StartupCli_Parsed } from "@gg-utils/local-edge-core";
import type { LocalEdgeKit_Config } from "./config.js";
/** Minimal output sink used by tests and CLI adapters. */
export type LocalEdgeKit_StartupCliOutput = {
    error(message: string): void;
    log(message: string): void;
};
/** Spawn request emitted after package-core startup planning. */
export type LocalEdgeKit_StartupCliSpawnRequest = {
    args: readonly string[];
    command: "npx" | "bash";
    env: NodeJS.ProcessEnv;
    stdio: StdioOptions;
};
/** Host operations owned by adapters in production and injected by tests. */
export type LocalEdgeKit_StartupCliOperations = {
    pathExists(filePath: string): boolean;
    spawn(request: LocalEdgeKit_StartupCliSpawnRequest): number | null;
};
/** Options for invoking the reusable startup dispatcher. */
export type LocalEdgeKit_RunStartupCliCommandOptions = {
    args: readonly string[];
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    operations?: LocalEdgeKit_StartupCliOperations | undefined;
    output?: LocalEdgeKit_StartupCliOutput;
};
/** Resolves a startup implementation file path from config and a historical implementation name. */
export declare function LocalEdgeKit_resolveStartupImplPath(options: {
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    implBaseName: string;
}): string;
/** Spawns one parsed startup command implementation using config-owned implementation paths. */
export declare function LocalEdgeKit_spawnStartupImpl(options: {
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    implBaseName?: string;
    operations?: LocalEdgeKit_StartupCliOperations | undefined;
    output?: LocalEdgeKit_StartupCliOutput;
    parsed: LocalEdge_StartupCli_Parsed;
}): number | null;
/** Runs the reusable startup dispatcher and returns a process-style exit code. */
export declare function LocalEdgeKit_runStartupCliCommand(options: LocalEdgeKit_RunStartupCliCommandOptions): number;
