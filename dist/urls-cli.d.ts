/**
 * @fileoverview Owns the shared `urls` subcommand runner that prints router URL-matrix rows for local-edge kit adapters.
 *
 * This module loads the active env stack, resolves runtime routing config, parses `--method` selectors from argv, and emits formatted matrix lines for the primary method, every configured method, or one explicit method.
 * Flow: env stack -> runtime config -> argv parse -> URL-matrix line builder -> stdout.
 *
 * @testing Jest unit: cd packages/local-edge-kit && npm run test -- src/cli.unit.test.ts
 * @testing CLI: npm run local:edge:urls
 *
 * @see packages/local-edge-kit/src/cli.ts - Kit CLI that dispatches the `urls` subcommand into LocalEdgeKit_runUrlsCommand with the active argv slice.
 * @see packages/local-edge-kit/src/url-matrix.ts - Matrix line builder consumed after runtime resolution and method selection to format operator-facing URL rows.
 * @see packages/local-edge-core/src/url-matrix.ts - Core URL-matrix CLI argv parser and shared primitives this runner calls after resolving supported methods from kit runtime config.
 * @see scripts/local-edge/urls.ts - Root compatibility script that forwards argv through the repo local-edge.config adapter into LocalEdgeKit_runUrlsCommand for stable npm script entrypoints.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import type { LocalEdgeKit_Config } from "./config.js";
/**
 * Options bundle for LocalEdgeKit_runUrlsCommand wiring argv, kit config, and optional process env overrides.
 */
export type LocalEdgeKit_RunUrlsCommandOptions = {
    args: readonly string[];
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
};
/**
 * Runs the `urls` subcommand and returns a process-style exit code suitable for process.exit.
 *
 * @remarks
 * I/O: reads env files via LocalEdgeKit_loadActiveEnvFileStack, resolves runtime routing, writes usage or matrix lines to stdout.
 */
export declare function LocalEdgeKit_runUrlsCommand(options: LocalEdgeKit_RunUrlsCommandOptions): number;
