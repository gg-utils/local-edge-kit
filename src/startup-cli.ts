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

import { spawnSync, type StdioOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  LOCAL_EDGE_STARTUP_EXIT_CODES,
  LocalEdgeStartupCli_buildImplSpawnPlan,
  LocalEdgeStartupCli_renderUsage,
  LocalEdgeStartupCli_resolveImplBaseName,
  LocalEdgeStartupCliParseError,
  LocalEdgeStartupCli_parseCommand,
  type LocalEdge_StartupCli_Parsed,
} from "@gg-utils/local-edge-core";

import type {
  LocalEdgeKit_Config,
  LocalEdgeKit_StartupConfig,
} from "./config.js";
import { LocalEdgeKit_resolveProjectRoot } from "./env.js";

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
  env?: NodeJS.ProcessEnv;
  operations?: LocalEdgeKit_StartupCliOperations;
  output?: LocalEdgeKit_StartupCliOutput;
};

function LocalEdgeKit_defaultStartupCliOutput(): LocalEdgeKit_StartupCliOutput {
  return {
    error(message) {
      console.error(message);
    },
    log(message) {
      console.log(message);
    },
  };
}

function LocalEdgeKit_defaultStartupCliOperations(): LocalEdgeKit_StartupCliOperations {
  return {
    pathExists(filePath) {
      return fs.existsSync(filePath);
    },
    spawn(request) {
      const result = spawnSync(request.command, [...request.args], {
        env: request.env,
        stdio: request.stdio,
      });
      if (result.error) {
        throw result.error;
      }
      return result.status;
    },
  };
}

function LocalEdgeKit_getStartupConfig(
  config: LocalEdgeKit_Config,
): LocalEdgeKit_StartupConfig {
  if (config.startup === undefined) {
    throw new Error(
      "[local-edge:startup-cli] local-edge.config.ts is missing startup config.",
    );
  }
  return config.startup;
}

function LocalEdgeKit_startupImplementationDirectory(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
}): string {
  const startupConfig = LocalEdgeKit_getStartupConfig(options.config);
  if (path.isAbsolute(startupConfig.implementationDirectory)) {
    return startupConfig.implementationDirectory;
  }

  return path.join(
    LocalEdgeKit_resolveProjectRoot({
      config: options.config,
      env: options.env,
    }),
    startupConfig.implementationDirectory,
  );
}

/** Resolves a startup implementation file path from config and a historical implementation name. */
export function LocalEdgeKit_resolveStartupImplPath(options: {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv;
  implBaseName: string;
}): string {
  return path.join(
    LocalEdgeKit_startupImplementationDirectory({
      config: options.config,
      env: options.env ?? process.env,
    }),
    options.implBaseName,
  );
}

function LocalEdgeKit_startupImplBaseName(options: {
  config: LocalEdgeKit_Config;
  parsed: LocalEdge_StartupCli_Parsed;
}): string {
  return (
    LocalEdgeKit_getStartupConfig(options.config).implBaseNames?.[
      options.parsed.command
    ] ?? LocalEdgeStartupCli_resolveImplBaseName(options.parsed.command)
  );
}

/** Spawns one parsed startup command implementation using config-owned implementation paths. */
export function LocalEdgeKit_spawnStartupImpl(options: {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv;
  implBaseName?: string;
  operations?: LocalEdgeKit_StartupCliOperations;
  output?: LocalEdgeKit_StartupCliOutput;
  parsed: LocalEdge_StartupCli_Parsed;
}): number | null {
  const env = options.env ?? process.env;
  const operations =
    options.operations ?? LocalEdgeKit_defaultStartupCliOperations();
  const output = options.output ?? LocalEdgeKit_defaultStartupCliOutput();
  const implBaseName =
    options.implBaseName ??
    LocalEdgeKit_startupImplBaseName({
      config: options.config,
      parsed: options.parsed,
    });
  const implPath = LocalEdgeKit_resolveStartupImplPath({
    config: options.config,
    env,
    implBaseName,
  });

  if (!operations.pathExists(implPath)) {
    throw new Error(`Missing impl script: ${implPath}`);
  }

  const extraArgs =
    options.parsed.command === "launch-runtime"
      ? options.parsed.forwardedArgs
      : undefined;
  const spawnPlan = LocalEdgeStartupCli_buildImplSpawnPlan({
    extraArgs,
    implBaseName,
    implPath,
    parsed: options.parsed,
    env,
  });

  if (spawnPlan.deprecationWarningLine !== null) {
    output.error(spawnPlan.deprecationWarningLine);
  }

  return operations.spawn({
    args: spawnPlan.spawnArgv,
    command: spawnPlan.spawnCommand,
    env: spawnPlan.env,
    stdio: "inherit",
  });
}

function LocalEdgeKit_printStartupUsage(options: {
  config: LocalEdgeKit_Config;
  output: LocalEdgeKit_StartupCliOutput;
}): void {
  options.output.log(
    LocalEdgeStartupCli_renderUsage({
      invocation: LocalEdgeKit_getStartupConfig(options.config).invocation,
    }),
  );
}

/** Runs the reusable startup dispatcher and returns a process-style exit code. */
export function LocalEdgeKit_runStartupCliCommand(
  options: LocalEdgeKit_RunStartupCliCommandOptions,
): number {
  const output = options.output ?? LocalEdgeKit_defaultStartupCliOutput();
  const args = [...options.args];

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    LocalEdgeKit_printStartupUsage({ config: options.config, output });
    return args.length === 0
      ? LOCAL_EDGE_STARTUP_EXIT_CODES.usageError
      : LOCAL_EDGE_STARTUP_EXIT_CODES.success;
  }

  if (args[0] !== "run") {
    output.error(
      `[local-edge:startup-cli] Expected 'run <command>', got: ${args[0] ?? ""}`,
    );
    LocalEdgeKit_printStartupUsage({ config: options.config, output });
    return LOCAL_EDGE_STARTUP_EXIT_CODES.usageError;
  }

  const command = args[1];
  if (command === undefined || command.length === 0) {
    output.error("[local-edge:startup-cli] Missing <command> after 'run'.");
    LocalEdgeKit_printStartupUsage({ config: options.config, output });
    return LOCAL_EDGE_STARTUP_EXIT_CODES.usageError;
  }

  let forwarded = args.slice(2);
  if (forwarded[0] === "--") {
    forwarded = forwarded.slice(1);
  }

  try {
    const parsed = LocalEdgeStartupCli_parseCommand(command, forwarded);
    return (
      LocalEdgeKit_spawnStartupImpl({
        config: options.config,
        env: options.env,
        operations: options.operations,
        output,
        parsed,
      }) ?? LOCAL_EDGE_STARTUP_EXIT_CODES.failure
    );
  } catch (error: unknown) {
    if (error instanceof LocalEdgeStartupCliParseError) {
      output.error(error.message);
      return error.exitCode;
    }
    throw error;
  }
}
