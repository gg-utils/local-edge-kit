/**
 * @fileoverview Reusable local-edge command runtime helpers for config adapters.
 *
 * Provides product-neutral root/env resolution, env-file stack loading, git branch discovery,
 * TypeScript script execution, shell command execution, and method validation. Repositories keep
 * project-specific source-file discovery, supported method lists, and script directories in their
 * adapters or config files.
 *
 * @example
 * ```typescript
 * const root = LocalEdgeKit_commandRuntimeResolveProjectRoot({
 *   defaultProjectRoot: process.cwd(),
 *   env: process.env,
 * });
 * ```
 *
 * @testing Package: `npm run local-edge-kit:test`.
 * @see packages/local-edge-kit/src/runtime-config.ts - Config-driven runtime resolution helpers.
 * @documentation reviewed=2026-05-20 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
export type LocalEdgeKit_CommandRuntimeOptions = {
    defaultProjectRoot: string;
    env?: NodeJS.ProcessEnv | undefined;
    projectRoot?: string | null | undefined;
    projectRootEnvName?: string;
};
export type LocalEdgeKit_CommandRuntimeLoadEnvFileStackOptions = {
    env?: NodeJS.ProcessEnv | undefined;
    logPrefix: string;
    sourceFiles: readonly string[];
};
export type LocalEdgeKit_CommandRuntimeScriptOptions = {
    args?: readonly string[] | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    scriptDirectory: string;
    scriptFileName: string;
};
export type LocalEdgeKit_CommandRuntimeCommandOptions = {
    args: readonly string[];
    command: string;
    env?: NodeJS.ProcessEnv | undefined;
};
/** Resolves the effective project root, respecting a caller value and env override. */
export declare function LocalEdgeKit_commandRuntimeResolveProjectRoot(options: LocalEdgeKit_CommandRuntimeOptions): string;
/** Returns the default `.env.local-edge` path for a resolved project root. */
export declare function LocalEdgeKit_commandRuntimeDefaultEnvFile(options: {
    defaultProjectRoot: string;
    env?: NodeJS.ProcessEnv | undefined;
    projectRoot?: string | null | undefined;
    projectRootEnvName?: string;
}): string;
/** Normalizes a string env value to a boolean, treating 1/true/yes as true. */
export declare function LocalEdgeKit_commandRuntimeIsTruthy(value: string | undefined): boolean;
/** Returns true when the configured strict-start value should cause hard failures. */
export declare function LocalEdgeKit_commandRuntimeShouldFailHard(options: {
    env?: NodeJS.ProcessEnv | undefined;
    strictStartEnvName?: string;
}): boolean;
/** Loads and stages an ordered env-file stack into the provided env object. */
export declare function LocalEdgeKit_commandRuntimeLoadEnvFileStack(options: LocalEdgeKit_CommandRuntimeLoadEnvFileStackOptions): string[];
/** Returns the current branch name or `detached-<short-sha>` for a detached HEAD. */
export declare function LocalEdgeKit_commandRuntimeGitCurrentBranchOrDetached(repoPath: string): string;
/** Returns the common branch across named child repos, `mixed`, or the root branch fallback. */
export declare function LocalEdgeKit_commandRuntimeRootWorkspaceSubmoduleBranch(options: {
    rootPath: string;
    submoduleNames: readonly string[];
}): string;
/** Resolves a script filename relative to a configured local-edge script directory. */
export declare function LocalEdgeKit_commandRuntimeResolveScriptPath(options: {
    scriptDirectory: string;
    scriptFileName: string;
}): string;
/** Runs a tsx script and returns the exit status. */
export declare function LocalEdgeKit_commandRuntimeRunTsxScriptStatus(options: LocalEdgeKit_CommandRuntimeScriptOptions): number;
/** Runs a tsx script and throws if the exit status is non-zero. */
export declare function LocalEdgeKit_commandRuntimeRunTsxScriptOrThrow(options: LocalEdgeKit_CommandRuntimeScriptOptions): void;
/** Runs a tsx script with inherited stdio and exits the process with success. */
export declare function LocalEdgeKit_commandRuntimeExecTsxScript(options: LocalEdgeKit_CommandRuntimeScriptOptions): never;
/** Captures and returns stdout from a tsx script run. */
export declare function LocalEdgeKit_commandRuntimeReadTsxScriptStdout(options: LocalEdgeKit_CommandRuntimeScriptOptions): string;
/** Runs an arbitrary command with inherited stdio and exits the process with success. */
export declare function LocalEdgeKit_commandRuntimeExecCommand(options: LocalEdgeKit_CommandRuntimeCommandOptions): never;
/** Runs an arbitrary command and throws if the exit status is non-zero. */
export declare function LocalEdgeKit_commandRuntimeRunCommandOrThrow(options: LocalEdgeKit_CommandRuntimeCommandOptions): void;
/** Validates a method argument against a consumer-supplied supported-method list. */
export declare function LocalEdgeKit_commandRuntimeValidateRequestedMethod(options: {
    allowAll: boolean;
    commandLabel: string;
    method: string;
    supportedMethods: readonly string[];
}): string;
