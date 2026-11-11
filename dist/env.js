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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
function LocalEdgeKit_projectRootEnvName(config) {
    return config.env?.projectRootEnvName ?? "LOCAL_EDGE_PROJECT_ROOT";
}
function LocalEdgeKit_envFileEnvName(config) {
    return config.env?.envFileEnvName ?? "LOCAL_EDGE_ENV_FILE";
}
function LocalEdgeKit_rootEnvFileEnvName(config) {
    return config.env?.rootEnvFileEnvName ?? "LOCAL_EDGE_ROOT_ENV_FILE";
}
function LocalEdgeKit_isTruthy(value) {
    return value === "1" || value === "true" || value === "yes";
}
/** Resolves the effective project root, respecting explicit options before env before cwd. */
export function LocalEdgeKit_resolveProjectRoot(options) {
    const env = options.env ?? process.env;
    return path.resolve(options.projectRoot ?? env[LocalEdgeKit_projectRootEnvName(options.config)] ?? process.cwd());
}
/** Returns the default `.env.local-edge` path for the effective project root. */
export function LocalEdgeKit_defaultEnvFile(options) {
    return path.join(LocalEdgeKit_resolveProjectRoot({
        config: options.config,
        env: options.env,
        projectRoot: options.projectRoot,
    }), ".env.local-edge");
}
/** Collects the ordered env stack: optional root env first, then active local-edge env. */
export function LocalEdgeKit_collectActiveEnvSourceFiles(options) {
    const env = options.env ?? process.env;
    const projectRoot = LocalEdgeKit_resolveProjectRoot({
        config: options.config,
        env,
        projectRoot: options.projectRoot,
    });
    const rootEnvFileEnvName = LocalEdgeKit_rootEnvFileEnvName(options.config);
    const envFileEnvName = LocalEdgeKit_envFileEnvName(options.config);
    const rootEnvFilePath = options.rootEnvFilePath ?? env[rootEnvFileEnvName] ?? null;
    const envFilePath = options.envFilePath ?? env[envFileEnvName] ?? path.join(projectRoot, ".env.local-edge");
    const seen = new Set();
    const sourceFiles = [];
    for (const sourceFile of [rootEnvFilePath, envFilePath]) {
        if (sourceFile === null || sourceFile.trim().length === 0) {
            continue;
        }
        const resolvedSourceFile = path.resolve(sourceFile);
        if (seen.has(resolvedSourceFile)) {
            continue;
        }
        seen.add(resolvedSourceFile);
        sourceFiles.push(resolvedSourceFile);
    }
    return sourceFiles;
}
/** Loads existing active env stack files through bash sourcing and merges results into `env`. */
export function LocalEdgeKit_loadActiveEnvFileStack(options) {
    const env = options.env ?? process.env;
    const sourceFiles = LocalEdgeKit_collectActiveEnvSourceFiles({
        config: options.config,
        env,
        envFilePath: options.envFilePath,
        projectRoot: options.projectRoot,
        rootEnvFilePath: options.rootEnvFilePath,
    });
    const existingSourceFiles = sourceFiles.filter((sourceFile) => fs.existsSync(sourceFile));
    if (existingSourceFiles.length === 0) {
        return [];
    }
    const sourcedEnvironment = execFileSync("bash", [
        "-lc",
        'set -a; for env_file in "$@"; do if [[ -n "$env_file" && -f "$env_file" ]]; then source "$env_file"; fi; done; env -0',
        "local-edge-env-loader",
        ...existingSourceFiles,
    ], {
        env,
        maxBuffer: 10 * 1024 * 1024,
    });
    for (const environmentEntry of sourcedEnvironment.toString("utf8").split("\0")) {
        if (environmentEntry.length === 0) {
            continue;
        }
        const separatorIndex = environmentEntry.indexOf("=");
        if (separatorIndex <= 0) {
            continue;
        }
        const key = environmentEntry.slice(0, separatorIndex);
        const value = environmentEntry.slice(separatorIndex + 1);
        env[key] = value;
    }
    if (LocalEdgeKit_isTruthy(env.LOCAL_EDGE_LOG_ENV_LOADS)) {
        const logPrefix = options.logPrefix ?? options.config.cli?.logPrefix ?? "local-edge";
        for (const sourceFile of existingSourceFiles) {
            console.log(`[${logPrefix}] Loaded active env layer file: ${sourceFile}`);
        }
    }
    return existingSourceFiles;
}
