/**
 * @fileoverview Configurable local-edge logs CLI runner.
 *
 * Core owns logs argv parsing, selector conversion, path layout, and stable operator-line
 * formatting. This kit layer owns filesystem discovery, history/list command dispatch, and tail
 * process lifecycle through injectable operations so repository scripts can remain tiny adapters.
 *
 * @example
 * ```typescript
 * await LocalEdgeKit_runLogsCli({ argv: ["history", "--scope", "run"], projectRoot: process.cwd() });
 * ```
 *
 * @testing Package: `npm run local-edge-kit:test`.
 * @see packages/local-edge-core/src/logs.ts - Product-neutral logs parser and selector helpers.
 * @documentation reviewed=2026-05-20 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logTail_listMatchingFilesByMtimeDesc } from "@gg-utils/platform-logs-core/discover-log-files";
import { logTail_spawnTail } from "@gg-utils/platform-logs-core/tail-process";

import {
  LocalEdgeCore_buildLogsFollowSelectorArgs,
  LocalEdgeCore_buildLogsHistoryTailArgs,
  LocalEdgeCore_buildLogsPathLayout,
  LocalEdgeCore_formatLogsErrorLine,
  LocalEdgeCore_formatLogsInfoLine,
  LocalEdgeCore_normalizeLogsArgv,
  LocalEdgeCore_parseLogsCli,
  LocalEdgeCore_parseLogsEnvNumber,
  LocalEdgeCore_parseLogsEnvPositiveInt,
  LocalEdgeCore_renderLogsUsage,
  LocalEdgeCore_resolveLogsScopeFiles,
  LocalEdgeCore_validateParsedLogsCli,
  type LocalEdgeCore_ParsedLogsCli,
} from "@gg-utils/local-edge-core";

/** Minimal child-process surface needed by the logs tail runner. */
export type LocalEdgeKit_LogsTailChild = {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): void;
  on(eventName: "exit", listener: () => void): void;
};

/** Result of a blocking history-tail command. */
export type LocalEdgeKit_LogsHistoryTailResult = {
  readonly error?: unknown;
  readonly status: number | null;
};

/** Host operations used by the package-owned logs CLI runner. */
export type LocalEdgeKit_LogsCliOperations = {
  exit: (exitCode: number) => void;
  fileIsRegular: (filePath: string) => boolean;
  listMatchingFilesByMtimeDesc: (options: {
    basenamePattern: string;
    directory: string;
  }) => string[];
  makeDirectory: (directory: string) => void;
  nowSeconds: () => number;
  onProcessExit: (
    eventName: "exit" | "SIGINT" | "SIGTERM",
    listener: () => void,
  ) => void;
  readSymlink: (filePath: string) => string | undefined;
  resolvePath: (fromDirectory: string, targetPath: string) => string;
  runHistoryTail: (
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => LocalEdgeKit_LogsHistoryTailResult;
  setTimer: (listener: () => void, ms: number) => void;
  sleepMs: (ms: number) => Promise<void>;
  spawnTail: (
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => LocalEdgeKit_LogsTailChild;
  stopTail: (child: LocalEdgeKit_LogsTailChild | null) => void;
  tailIsRunning: (child: LocalEdgeKit_LogsTailChild | null) => boolean;
};

/** Output writers used by the logs CLI runner. */
export type LocalEdgeKit_LogsCliOutput = {
  error: (line: string) => void;
  log: (line: string) => void;
};

/** Options for running the logs CLI. */
export type LocalEdgeKit_RunLogsCliOptions = {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  operations?: Partial<LocalEdgeKit_LogsCliOperations>;
  output?: Partial<LocalEdgeKit_LogsCliOutput>;
  projectRoot: string;
};

function LocalEdgeKit_logsFileIsRegular(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function LocalEdgeKit_defaultLogsCliOperations(): LocalEdgeKit_LogsCliOperations {
  return {
    exit: (exitCode): void => {
      process.exit(exitCode);
    },
    fileIsRegular: LocalEdgeKit_logsFileIsRegular,
    listMatchingFilesByMtimeDesc: (options): string[] =>
      logTail_listMatchingFilesByMtimeDesc({
        basenamePattern: options.basenamePattern,
        directory: options.directory,
      }),
    makeDirectory: (directory): void => {
      fs.mkdirSync(directory, { recursive: true });
    },
    nowSeconds: (): number => Math.floor(Date.now() / 1000),
    onProcessExit: (eventName, listener): void => {
      process.on(eventName, listener);
    },
    readSymlink: (filePath): string | undefined => {
      try {
        if (!fs.lstatSync(filePath).isSymbolicLink()) {
          return undefined;
        }
        return fs.readlinkSync(filePath);
      } catch {
        return undefined;
      }
    },
    resolvePath: (fromDirectory, targetPath): string =>
      path.isAbsolute(targetPath)
        ? targetPath
        : path.join(fromDirectory, targetPath),
    runHistoryTail: (args, env): LocalEdgeKit_LogsHistoryTailResult => {
      const result = spawnSync("tail", [...args], { env, stdio: "inherit" });
      return { error: result.error, status: result.status };
    },
    setTimer: (listener, ms): void => {
      setTimeout(listener, ms);
    },
    sleepMs: (ms): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    spawnTail: (args, env): LocalEdgeKit_LogsTailChild => {
      const child = logTail_spawnTail([...args], env);
      return child;
    },
    stopTail: (child): void => {
      if (
        child === null ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        ) {
          return;
        }
        throw error;
      }
    },
    tailIsRunning: (child): boolean =>
      child !== null && child.exitCode === null && child.signalCode === null,
  };
}

function LocalEdgeKit_resolveLogsCliOperations(
  operations: Partial<LocalEdgeKit_LogsCliOperations> | undefined,
): LocalEdgeKit_LogsCliOperations {
  const defaults = LocalEdgeKit_defaultLogsCliOperations();
  return {
    exit: operations?.exit ?? defaults.exit,
    fileIsRegular: operations?.fileIsRegular ?? defaults.fileIsRegular,
    listMatchingFilesByMtimeDesc:
      operations?.listMatchingFilesByMtimeDesc ??
      defaults.listMatchingFilesByMtimeDesc,
    makeDirectory: operations?.makeDirectory ?? defaults.makeDirectory,
    nowSeconds: operations?.nowSeconds ?? defaults.nowSeconds,
    onProcessExit: operations?.onProcessExit ?? defaults.onProcessExit,
    readSymlink: operations?.readSymlink ?? defaults.readSymlink,
    resolvePath: operations?.resolvePath ?? defaults.resolvePath,
    runHistoryTail: operations?.runHistoryTail ?? defaults.runHistoryTail,
    setTimer: operations?.setTimer ?? defaults.setTimer,
    sleepMs: operations?.sleepMs ?? defaults.sleepMs,
    spawnTail: operations?.spawnTail ?? defaults.spawnTail,
    stopTail: operations?.stopTail ?? defaults.stopTail,
    tailIsRunning: operations?.tailIsRunning ?? defaults.tailIsRunning,
  };
}

function LocalEdgeKit_resolveLogsCliOutput(
  output: Partial<LocalEdgeKit_LogsCliOutput> | undefined,
): LocalEdgeKit_LogsCliOutput {
  return {
    error: output?.error ?? ((line): void => console.error(line)),
    log: output?.log ?? ((line): void => console.log(line)),
  };
}

function LocalEdgeKit_logsInfo(options: {
  message: string;
  output: LocalEdgeKit_LogsCliOutput;
}): void {
  options.output.log(LocalEdgeCore_formatLogsInfoLine(options.message));
}

function LocalEdgeKit_logsError(options: {
  message: string;
  output: LocalEdgeKit_LogsCliOutput;
}): void {
  options.output.error(LocalEdgeCore_formatLogsErrorLine(options.message));
}

function LocalEdgeKit_parseLogsCliOrExit(options: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  operations: LocalEdgeKit_LogsCliOperations;
  output: LocalEdgeKit_LogsCliOutput;
}): LocalEdgeCore_ParsedLogsCli | number {
  const defaultLines = String(
    LocalEdgeCore_parseLogsEnvPositiveInt(
      options.env.LOCAL_EDGE_TAIL_DEFAULT_LINES,
      1000,
    ),
  );
  const defaultCharsPerToken = String(
    LocalEdgeCore_parseLogsEnvNumber(
      options.env.LOCAL_EDGE_TAIL_CHARS_PER_TOKEN,
      4,
    ),
  );
  const result = LocalEdgeCore_parseLogsCli({
    argv: options.argv,
    defaultLines,
    defaultCharsPerToken,
  });

  if (result.ok) {
    return result.parsed;
  }

  if (result.message !== undefined) {
    LocalEdgeKit_logsError({ message: result.message, output: options.output });
  }
  if (result.includeUsage) {
    options.output.log(LocalEdgeCore_renderLogsUsage());
    if (result.kind === "error") {
      options.output.error("");
    }
  }
  return result.exitCode;
}

function LocalEdgeKit_resolveLatestRunLog(options: {
  operations: LocalEdgeKit_LogsCliOperations;
  runLogDir: string;
  runLogLatestLink: string;
  runLogPattern: string;
}): string | undefined {
  const sorted = options.operations.listMatchingFilesByMtimeDesc({
    basenamePattern: options.runLogPattern,
    directory: options.runLogDir,
  });
  const first = sorted[0];
  if (first !== undefined && options.operations.fileIsRegular(first)) {
    return first;
  }

  const target = options.operations.readSymlink(options.runLogLatestLink);
  if (target === undefined) {
    return undefined;
  }

  const resolved = options.operations.resolvePath(
    path.dirname(options.runLogLatestLink),
    target,
  );
  return options.operations.fileIsRegular(resolved) ? resolved : undefined;
}

function LocalEdgeKit_resolveRunLogByIndex(options: {
  indexOneBased: number;
  operations: LocalEdgeKit_LogsCliOperations;
  runLogDir: string;
  runLogPattern: string;
}): string | undefined {
  const sorted = options.operations.listMatchingFilesByMtimeDesc({
    basenamePattern: options.runLogPattern,
    directory: options.runLogDir,
  });
  const index = options.indexOneBased - 1;
  if (index < 0 || index >= sorted.length) {
    return undefined;
  }
  return sorted[index];
}

function LocalEdgeKit_resolveLogsScopeFiles(options: {
  parsed: LocalEdgeCore_ParsedLogsCli;
  pathLayout: ReturnType<typeof LocalEdgeCore_buildLogsPathLayout>;
  operations: LocalEdgeKit_LogsCliOperations;
}): string[] {
  return LocalEdgeCore_resolveLogsScopeFiles({
    parsed: options.parsed,
    pathLayout: options.pathLayout,
    fileExists: options.operations.fileIsRegular,
    resolveLatestRunLog: () =>
      LocalEdgeKit_resolveLatestRunLog({
        operations: options.operations,
        runLogDir: options.pathLayout.runLogDir,
        runLogLatestLink: options.pathLayout.runLogLatestLink,
        runLogPattern: options.pathLayout.runLogPattern,
      }),
    resolveRunLogByIndex: (indexOneBased) =>
      LocalEdgeKit_resolveRunLogByIndex({
        indexOneBased,
        operations: options.operations,
        runLogDir: options.pathLayout.runLogDir,
        runLogPattern: options.pathLayout.runLogPattern,
      }),
  });
}

function LocalEdgeKit_printRunLogs(options: {
  operations: LocalEdgeKit_LogsCliOperations;
  output: LocalEdgeKit_LogsCliOutput;
  runLogDir: string;
  runLogPattern: string;
}): void {
  const list = options.operations.listMatchingFilesByMtimeDesc({
    basenamePattern: options.runLogPattern,
    directory: options.runLogDir,
  });

  let index = 1;
  for (const runFile of list) {
    options.output.log(`${String(index)}. ${runFile}`);
    index += 1;
  }
  if (index === 1) {
    LocalEdgeKit_logsInfo({
      message: `No run logs found in ${options.runLogDir}.`,
      output: options.output,
    });
  }
}

function LocalEdgeKit_registerLogsCleanup(options: {
  cleanup: () => void;
  operations: LocalEdgeKit_LogsCliOperations;
}): void {
  options.operations.onProcessExit("exit", options.cleanup);
  options.operations.onProcessExit("SIGINT", () => {
    options.cleanup();
    options.operations.exit(130);
  });
  options.operations.onProcessExit("SIGTERM", () => {
    options.cleanup();
    options.operations.exit(143);
  });
}

async function LocalEdgeKit_tailRunScope(options: {
  env: NodeJS.ProcessEnv;
  operations: LocalEdgeKit_LogsCliOperations;
  output: LocalEdgeKit_LogsCliOutput;
  parsed: LocalEdgeCore_ParsedLogsCli;
  runLogDir: string;
  runLogLatestLink: string;
  runLogPattern: string;
}): Promise<number> {
  if (options.parsed.timeoutSeconds !== "") {
    LocalEdgeKit_logsInfo({
      message: `timeout enabled: ${options.parsed.timeoutSeconds}s`,
      output: options.output,
    });
  }
  LocalEdgeKit_logsInfo({
    message: `watching scope=run in ${options.runLogDir}`,
    output: options.output,
  });

  const pollSeconds = LocalEdgeCore_parseLogsEnvNumber(
    options.env.LOCAL_EDGE_TAIL_POLL_SECONDS,
    1,
  );
  const pollMs = Math.max(0, pollSeconds * 1000);
  const startTsSec = options.operations.nowSeconds();

  let tailChild: LocalEdgeKit_LogsTailChild | null = null;
  let currentFile = "";
  let firstFile = true;
  const followArgs = LocalEdgeCore_buildLogsFollowSelectorArgs(options.parsed);

  const cleanup = (): void => {
    options.operations.stopTail(tailChild);
    tailChild = null;
  };
  LocalEdgeKit_registerLogsCleanup({ cleanup, operations: options.operations });

  while (true) {
    if (options.parsed.timeoutSeconds !== "") {
      const now = options.operations.nowSeconds();
      if (
        now - startTsSec >=
        Number.parseInt(options.parsed.timeoutSeconds, 10)
      ) {
        LocalEdgeKit_logsInfo({
          message: `timeout reached (${options.parsed.timeoutSeconds}s).`,
          output: options.output,
        });
        cleanup();
        return 0;
      }
    }

    const latest = LocalEdgeKit_resolveLatestRunLog({
      operations: options.operations,
      runLogDir: options.runLogDir,
      runLogLatestLink: options.runLogLatestLink,
      runLogPattern: options.runLogPattern,
    });
    if (latest !== undefined && latest !== currentFile) {
      cleanup();
      currentFile = latest;
      if (firstFile) {
        LocalEdgeKit_logsInfo({
          message: `following ${currentFile} (startup selector)`,
          output: options.output,
        });
        tailChild = options.operations.spawnTail(
          [...followArgs, "-f", currentFile],
          options.env,
        );
        firstFile = false;
      } else {
        LocalEdgeKit_logsInfo({
          message: `following ${currentFile} (new run file, full output)`,
          output: options.output,
        });
        tailChild = options.operations.spawnTail(
          ["-n", "+1", "-f", currentFile],
          options.env,
        );
      }
    }

    if (tailChild !== null && !options.operations.tailIsRunning(tailChild)) {
      tailChild = null;
      currentFile = "";
    }

    await options.operations.sleepMs(pollMs);
  }
}

function LocalEdgeKit_tailOtherScope(options: {
  env: NodeJS.ProcessEnv;
  operations: LocalEdgeKit_LogsCliOperations;
  output: LocalEdgeKit_LogsCliOutput;
  parsed: LocalEdgeCore_ParsedLogsCli;
  scopeFiles: readonly string[];
}): Promise<number> {
  LocalEdgeKit_logsInfo({
    message: `following scope=${options.parsed.scope}`,
    output: options.output,
  });
  const followArgs = LocalEdgeCore_buildLogsFollowSelectorArgs(options.parsed);

  let tailChild: LocalEdgeKit_LogsTailChild | null = null;
  const cleanup = (): void => {
    options.operations.stopTail(tailChild);
    tailChild = null;
  };
  LocalEdgeKit_registerLogsCleanup({ cleanup, operations: options.operations });

  const tailArgs =
    options.scopeFiles.length > 1
      ? ["-v", ...followArgs, "-F", ...options.scopeFiles]
      : [...followArgs, "-F", options.scopeFiles[0] ?? ""];

  tailChild = options.operations.spawnTail(tailArgs, options.env);

  if (options.parsed.timeoutSeconds !== "") {
    const ms = Number.parseInt(options.parsed.timeoutSeconds, 10) * 1000;
    options.operations.setTimer(() => {
      options.operations.stopTail(tailChild);
    }, ms);
  }

  return new Promise((resolve) => {
    tailChild?.on("exit", () => {
      resolve(0);
    });
  });
}

/** Parses argv, prepares log directories, and dispatches logs CLI modes. */
export async function LocalEdgeKit_runLogsCli(
  options: LocalEdgeKit_RunLogsCliOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const operations = LocalEdgeKit_resolveLogsCliOperations(options.operations);
  const output = LocalEdgeKit_resolveLogsCliOutput(options.output);
  const pathLayout = LocalEdgeCore_buildLogsPathLayout(options.projectRoot);
  const argv = LocalEdgeCore_normalizeLogsArgv(options.argv);
  const parsedOrExitCode = LocalEdgeKit_parseLogsCliOrExit({
    argv,
    env,
    operations,
    output,
  });
  if (typeof parsedOrExitCode === "number") {
    return parsedOrExitCode;
  }
  const parsed = parsedOrExitCode;

  const validationError = LocalEdgeCore_validateParsedLogsCli(parsed);
  if (validationError !== null) {
    LocalEdgeKit_logsError({ message: validationError, output });
    return 1;
  }

  operations.makeDirectory(pathLayout.localEdgeLogDir);
  operations.makeDirectory(pathLayout.runLogDir);

  if (parsed.command === "list-runs") {
    LocalEdgeKit_printRunLogs({
      operations,
      output,
      runLogDir: pathLayout.runLogDir,
      runLogPattern: pathLayout.runLogPattern,
    });
    return 0;
  }

  if (parsed.command === "history") {
    const scopeFiles = LocalEdgeKit_resolveLogsScopeFiles({
      operations,
      parsed,
      pathLayout,
    });
    if (scopeFiles.length === 0) {
      LocalEdgeKit_logsError({
        message: `No log files found for scope '${parsed.scope}'.`,
        output,
      });
      return 1;
    }
    for (const filePath of scopeFiles) {
      LocalEdgeKit_logsInfo({ message: `history file=${filePath}`, output });
      const result = operations.runHistoryTail(
        LocalEdgeCore_buildLogsHistoryTailArgs(parsed, filePath),
        env,
      );
      if (result.error !== undefined) {
        throw result.error;
      }
      if (result.status !== 0 && result.status !== null) {
        return result.status;
      }
    }
    return 0;
  }

  if (parsed.scope === "run") {
    return LocalEdgeKit_tailRunScope({
      env,
      operations,
      output,
      parsed,
      runLogDir: pathLayout.runLogDir,
      runLogLatestLink: pathLayout.runLogLatestLink,
      runLogPattern: pathLayout.runLogPattern,
    });
  }

  const scopeFiles = LocalEdgeKit_resolveLogsScopeFiles({
    operations,
    parsed,
    pathLayout,
  });
  if (scopeFiles.length === 0) {
    LocalEdgeKit_logsError({
      message: `No log files found for scope '${parsed.scope}'.`,
      output,
    });
    return 1;
  }

  return LocalEdgeKit_tailOtherScope({
    env,
    operations,
    output,
    parsed,
    scopeFiles,
  });
}
