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
    onProcessExit: (eventName: "exit" | "SIGINT" | "SIGTERM", listener: () => void) => void;
    readSymlink: (filePath: string) => string | undefined;
    resolvePath: (fromDirectory: string, targetPath: string) => string;
    runHistoryTail: (args: readonly string[], env: NodeJS.ProcessEnv) => LocalEdgeKit_LogsHistoryTailResult;
    setTimer: (listener: () => void, ms: number) => void;
    sleepMs: (ms: number) => Promise<void>;
    spawnTail: (args: readonly string[], env: NodeJS.ProcessEnv) => LocalEdgeKit_LogsTailChild;
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
    env?: NodeJS.ProcessEnv | undefined;
    operations?: Partial<LocalEdgeKit_LogsCliOperations>;
    output?: Partial<LocalEdgeKit_LogsCliOutput>;
    projectRoot: string;
};
/** Parses argv, prepares log directories, and dispatches logs CLI modes. */
export declare function LocalEdgeKit_runLogsCli(options: LocalEdgeKit_RunLogsCliOptions): Promise<number>;
