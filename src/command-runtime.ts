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

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  LocalEdgeCore_isTruthy,
  LocalEdgeCore_validateRequestedMethod,
} from "@gg-utils/local-edge-core";
import { LocalEdgeKit_messageWord } from "./safe-message.js";

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
export function LocalEdgeKit_commandRuntimeResolveProjectRoot(
  options: LocalEdgeKit_CommandRuntimeOptions,
): string {
  const env = options.env ?? process.env;
  const envName = options.projectRootEnvName ?? "LOCAL_EDGE_PROJECT_ROOT";
  return path.resolve(
    options.projectRoot ?? env[envName] ?? options.defaultProjectRoot,
  );
}

/** Returns the default `.env.local-edge` path for a resolved project root. */
export function LocalEdgeKit_commandRuntimeDefaultEnvFile(options: {
  defaultProjectRoot: string;
  env?: NodeJS.ProcessEnv | undefined;
  projectRoot?: string | null | undefined;
  projectRootEnvName?: string;
}): string {
  return path.join(
    LocalEdgeKit_commandRuntimeResolveProjectRoot(options),
    ".env.local-edge",
  );
}

/** Normalizes a string env value to a boolean, treating 1/true/yes as true. */
export function LocalEdgeKit_commandRuntimeIsTruthy(
  value: string | undefined,
): boolean {
  return LocalEdgeCore_isTruthy(value);
}

/** Returns true when the configured strict-start value should cause hard failures. */
export function LocalEdgeKit_commandRuntimeShouldFailHard(options: {
  env?: NodeJS.ProcessEnv | undefined;
  strictStartEnvName?: string;
}): boolean {
  const env = options.env ?? process.env;
  return LocalEdgeKit_commandRuntimeIsTruthy(
    env[options.strictStartEnvName ?? "LOCAL_EDGE_STRICT_START"],
  );
}

/** Loads and stages an ordered env-file stack into the provided env object. */
export function LocalEdgeKit_commandRuntimeLoadEnvFileStack(
  options: LocalEdgeKit_CommandRuntimeLoadEnvFileStackOptions,
): string[] {
  const env = options.env ?? process.env;
  const existingSourceFiles = options.sourceFiles.filter((sourceFile) =>
    fs.existsSync(sourceFile),
  );

  if (existingSourceFiles.length === 0) {
    return [];
  }

  const sourcedEnvironment = execFileSync(
    "bash",
    [
      "-lc",
      'set -a; for env_file in "$@"; do if [[ -n "$env_file" && -f "$env_file" ]]; then source "$env_file"; fi; done; env -0',
      "local-edge-env-loader",
      ...existingSourceFiles,
    ],
    {
      env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const environmentEntries = sourcedEnvironment.toString("utf8").split("\0");
  for (const environmentEntry of environmentEntries) {
    if (!environmentEntry) {
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

  if (LocalEdgeKit_commandRuntimeIsTruthy(env.LOCAL_EDGE_LOG_ENV_LOADS)) {
    for (const sourceFile of existingSourceFiles) {
      console.log(
        `[${options.logPrefix}] Loaded active env layer file: ${sourceFile}`,
      );
    }
  }

  return existingSourceFiles;
}

/** Returns the current branch name or `detached-<short-sha>` for a detached HEAD. */
export function LocalEdgeKit_commandRuntimeGitCurrentBranchOrDetached(
  repoPath: string,
): string {
  try {
    const branchName = execFileSync(
      "git",
      ["-C", repoPath, "branch", "--show-current"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();

    if (branchName.length > 0) {
      return branchName;
    }
  } catch (error: unknown) {
    console.debug("Failed to get current git branch:", error);
  }

  try {
    const shortSha = execFileSync(
      "git",
      ["-C", repoPath, "rev-parse", "--short", "HEAD"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();

    if (shortSha.length > 0) {
      return `detached-${shortSha}`;
    }
  } catch (error: unknown) {
    console.debug("Failed to get detached HEAD short SHA:", error);
    return "unknown";
  }

  return "unknown";
}

/** Returns the common branch across named child repos, `mixed`, or the root branch fallback. */
export function LocalEdgeKit_commandRuntimeRootWorkspaceSubmoduleBranch(options: {
  rootPath: string;
  submoduleNames: readonly string[];
}): string {
  const uniqueBranches = new Set<string>();

  for (const submoduleName of options.submoduleNames) {
    const submodulePath = path.join(options.rootPath, submoduleName);
    const dotGitPath = path.join(submodulePath, ".git");
    if (!fs.existsSync(dotGitPath)) {
      continue;
    }

    const branchName =
      LocalEdgeKit_commandRuntimeGitCurrentBranchOrDetached(submodulePath);
    if (branchName.length === 0) {
      continue;
    }

    uniqueBranches.add(branchName);
  }

  if (uniqueBranches.size === 0) {
    return LocalEdgeKit_commandRuntimeGitCurrentBranchOrDetached(
      options.rootPath,
    );
  }

  if (uniqueBranches.size > 1) {
    return "mixed";
  }

  return Array.from(uniqueBranches)[0] ?? "unknown";
}

/** Resolves a script filename relative to a configured local-edge script directory. */
export function LocalEdgeKit_commandRuntimeResolveScriptPath(options: {
  scriptDirectory: string;
  scriptFileName: string;
}): string {
  return path.resolve(options.scriptDirectory, options.scriptFileName);
}

/** Runs a tsx script and returns the exit status. */
export function LocalEdgeKit_commandRuntimeRunTsxScriptStatus(
  options: LocalEdgeKit_CommandRuntimeScriptOptions,
): number {
  const result = spawnSync(
    "npx",
    [
      "tsx",
      LocalEdgeKit_commandRuntimeResolveScriptPath(options),
      ...(options.args ?? []),
    ],
    {
      env: options.env ?? process.env,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

/** Runs a tsx script and throws if the exit status is non-zero. */
export function LocalEdgeKit_commandRuntimeRunTsxScriptOrThrow(
  options: LocalEdgeKit_CommandRuntimeScriptOptions,
): void {
  const exitStatus = LocalEdgeKit_commandRuntimeRunTsxScriptStatus(options);
  if (exitStatus !== 0) {
    throw new Error(
      `TypeScript command '${options.scriptFileName}' failed with exit status ${String(exitStatus)}.`,
    );
  }
}

/** Runs a tsx script with inherited stdio and exits the process with success. */
export function LocalEdgeKit_commandRuntimeExecTsxScript(
  options: LocalEdgeKit_CommandRuntimeScriptOptions,
): never {
  execFileSync(
    "npx",
    [
      "tsx",
      LocalEdgeKit_commandRuntimeResolveScriptPath(options),
      ...(options.args ?? []),
    ],
    {
      env: options.env ?? process.env,
      stdio: "inherit",
    },
  );
  process.exit(0);
}

/** Captures and returns stdout from a tsx script run. */
export function LocalEdgeKit_commandRuntimeReadTsxScriptStdout(
  options: LocalEdgeKit_CommandRuntimeScriptOptions,
): string {
  return execFileSync(
    "npx",
    [
      "tsx",
      LocalEdgeKit_commandRuntimeResolveScriptPath(options),
      ...(options.args ?? []),
    ],
    {
      encoding: "utf8",
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "inherit"],
    },
  ).trim();
}

/** Runs an arbitrary command with inherited stdio and exits the process with success. */
export function LocalEdgeKit_commandRuntimeExecCommand(
  options: LocalEdgeKit_CommandRuntimeCommandOptions,
): never {
  execFileSync(options.command, [...options.args], {
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  process.exit(0);
}

/** Runs an arbitrary command and throws if the exit status is non-zero. */
export function LocalEdgeKit_commandRuntimeRunCommandOrThrow(
  options: LocalEdgeKit_CommandRuntimeCommandOptions,
): void {
  const result = spawnSync(options.command, [...options.args], {
    env: options.env ?? process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `Command '${options.command}' failed with exit status ${String(result.status ?? 1)}.`,
    );
  }
}

/** Validates a method argument against a consumer-supplied supported-method list. */
export function LocalEdgeKit_commandRuntimeValidateRequestedMethod(options: {
  allowAll: boolean;
  commandLabel: string;
  method: string;
  supportedMethods: readonly string[];
}): string {
  const result = LocalEdgeCore_validateRequestedMethod({
    allowAll: options.allowAll,
    commandLabel: options.commandLabel,
    method: options.method,
    supportedMethods: options.supportedMethods,
  });

  if (typeof result === "string") {
    return result;
  }

  throw new Error(
    `[${options.commandLabel}] Unsupported --method '${LocalEdgeKit_messageWord(options.method)}'.`,
  );
}
