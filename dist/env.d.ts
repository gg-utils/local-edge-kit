/**
 * @fileoverview Resolves local-edge project roots and loads the ordered `.env.local-edge` stack
 * (optional root env first) into a mutable environment map for kit CLIs and adapters.
 *
 * Flow: resolve `projectRoot` -> collect `[rootEnvFile, envFile]` with dedupe -> bash `source` each existing file -> merge `env -0` pairs into `env`.
 * Consumers supply `LocalEdgeKit_Config` (from `local-edge.config.ts`) so env key names and CLI log prefixes stay consistent with the rest of the kit.
 *
 * @testing Jest unit: npm run test --prefix packages/local-edge-kit
 *
 * @see packages/local-edge-kit/src/config.ts - Defines `LocalEdgeKit_Config.env` key names and defaults this module reads when resolving roots, paths, and optional `LOCAL_EDGE_LOG_ENV_LOADS` diagnostics.
 * @see local-edge.config.ts - Root orchestration config passed into kit commands and forwarded here as `config` so env resolution matches the active local-edge realm.
 * @see packages/local-edge-kit/src/healthcheck-cli.ts - Imports `LocalEdgeKit_loadActiveEnvFileStack` to hydrate process env before probing services, illustrating the high-stakes runtime merge path owned here.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import type { LocalEdgeKit_Config } from "./config.js";
/** Options for resolving an effective project root. */
export type LocalEdgeKit_ResolveProjectRootOptions = {
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    projectRoot?: string | null | undefined;
};
/** Options for collecting env source files. */
export type LocalEdgeKit_CollectActiveEnvSourceFilesOptions = {
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    envFilePath?: string | null | undefined;
    projectRoot?: string | null | undefined;
    rootEnvFilePath?: string | null | undefined;
};
/** Options for loading env files into an environment object. */
export type LocalEdgeKit_LoadActiveEnvFileStackOptions = LocalEdgeKit_CollectActiveEnvSourceFilesOptions & {
    logPrefix?: string | undefined;
};
/** Resolves the effective project root, respecting explicit options before env before cwd. */
export declare function LocalEdgeKit_resolveProjectRoot(options: LocalEdgeKit_ResolveProjectRootOptions): string;
/** Returns the default `.env.local-edge` path for the effective project root. */
export declare function LocalEdgeKit_defaultEnvFile(options: {
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    projectRoot?: string | null | undefined;
}): string;
/** Collects the ordered env stack: optional root env first, then active local-edge env. */
export declare function LocalEdgeKit_collectActiveEnvSourceFiles(options: LocalEdgeKit_CollectActiveEnvSourceFilesOptions): string[];
/** Loads existing active env stack files through bash sourcing and merges results into `env`. */
export declare function LocalEdgeKit_loadActiveEnvFileStack(options: LocalEdgeKit_LoadActiveEnvFileStackOptions): string[];
