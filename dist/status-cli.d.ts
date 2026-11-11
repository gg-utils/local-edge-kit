/**
 * @fileoverview Generic status CLI runner for local-edge kit adapters.
 *
 * This file owns kit-layer orchestration for the status subcommand: load env stack and runtime
 * config, probe each configured nginx-docker compose service plus TCP listen state, assemble a
 * structured status report via core helpers, print JSON or text, and map health outcomes to exit
 * codes without embedding repository-specific labels or paths.
 *
 * @testing Jest unit: cd packages/local-edge-kit && npm run test
 *
 * @see packages/local-edge-kit/src/cli.ts - Kit CLI router that dispatches the status subcommand by calling LocalEdgeKit_runStatusCommand with parsed argv and loaded kit config.
 * @see packages/local-edge-core/src/status.ts - Core status helpers for argv parsing, report assembly, and text or JSON rendering consumed after kit-side probes finish.
 * @see packages/local-edge-kit/src/runtime-config.ts - Resolves supported nginx-docker methods, listen addresses, and compose coordinates used before per-method probes run.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import type { LocalEdgeKit_Config } from "./config.js";
/** Options for invoking the generic status command. */
export type LocalEdgeKit_RunStatusCommandOptions = {
    args: readonly string[];
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
};
/** Runs the generic status command and returns a process-style exit code. */
export declare function LocalEdgeKit_runStatusCommand(options: LocalEdgeKit_RunStatusCommandOptions): Promise<number>;
