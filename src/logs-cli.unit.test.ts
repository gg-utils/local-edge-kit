/**
 * @fileoverview Verifies the package-owned local-edge logs CLI runner for run log discovery,
 * scoped history replay, and static-scope tail following.
 *
 * This file owns regression coverage for injectable filesystem operations, history tail argv
 * shaping, and tail subprocess wiring without spawning real user processes.
 * Flow: inject operations -> await LocalEdgeKit_runLogsCli -> assert exit codes, log lines, and spawn args.
 *
 * @testing Node unit: cd packages/local-edge-kit && npm run test
 *
 * @see packages/local-edge-kit/src/logs-cli.ts - Logs CLI runner under test that defines LocalEdgeKit_runLogsCli plus injectable operations for discovery, history tail, and follow-mode tail.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - Repository file-overview standard that governs the verification and cross-reference metadata in this test module header.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalEdgeKit_runLogsCli,
  type LocalEdgeKit_LogsTailChild,
} from "./logs-cli.js";

class LocalEdgeKit_TestTailChild implements LocalEdgeKit_LogsTailChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private exitListener: (() => void) | null = null;

  kill(): void {
    this.exitCode = 0;
    this.exitListener?.();
  }

  on(eventName: "exit", listener: () => void): void {
    assert.equal(eventName, "exit");
    this.exitListener = listener;
  }

  emitExit(): void {
    this.exitCode = 0;
    this.exitListener?.();
  }
}

void test("LocalEdgeKit_runLogsCli lists run logs through injected discovery", async () => {
  const lines: string[] = [];
  const exitCode = await LocalEdgeKit_runLogsCli({
    argv: ["list-runs"],
    operations: {
      listMatchingFilesByMtimeDesc: () => [
        "/repo/logs/local-edge/runs/local-edge-2.log",
      ],
      makeDirectory: () => undefined,
    },
    output: {
      log: (line) => {
        lines.push(line);
      },
    },
    projectRoot: "/repo",
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(lines, ["1. /repo/logs/local-edge/runs/local-edge-2.log"]);
});

void test("LocalEdgeKit_runLogsCli prints history with package-owned tail args", async () => {
  const lines: string[] = [];
  const historyArgs: string[][] = [];
  const exitCode = await LocalEdgeKit_runLogsCli({
    argv: ["history", "--scope", "run", "--run-index", "2", "--lines", "5"],
    operations: {
      fileIsRegular: () => true,
      listMatchingFilesByMtimeDesc: () => [
        "/repo/logs/local-edge/runs/local-edge-2.log",
        "/repo/logs/local-edge/runs/local-edge-1.log",
      ],
      makeDirectory: () => undefined,
      runHistoryTail: (args) => {
        historyArgs.push([...args]);
        return { status: 0 };
      },
    },
    output: {
      log: (line) => {
        lines.push(line);
      },
    },
    projectRoot: "/repo",
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(lines, [
    "[local-edge:logs] history file=/repo/logs/local-edge/runs/local-edge-1.log",
  ]);
  assert.deepEqual(historyArgs, [
    ["-n", "5", "/repo/logs/local-edge/runs/local-edge-1.log"],
  ]);
});

void test("LocalEdgeKit_runLogsCli follows static scopes with injected tail process", async () => {
  const lines: string[] = [];
  const tailArgs: string[][] = [];
  const child = new LocalEdgeKit_TestTailChild();
  const promise = LocalEdgeKit_runLogsCli({
    argv: ["tail", "--scope", "healthcheck", "--lines", "10"],
    operations: {
      fileIsRegular: (filePath) => filePath.endsWith("healthcheck.log"),
      listMatchingFilesByMtimeDesc: () => [],
      makeDirectory: () => undefined,
      onProcessExit: () => undefined,
      spawnTail: (args) => {
        tailArgs.push([...args]);
        return child;
      },
      stopTail: () => undefined,
    },
    output: {
      log: (line) => {
        lines.push(line);
      },
    },
    projectRoot: "/repo",
  });

  child.emitExit();
  const exitCode = await promise;

  assert.equal(exitCode, 0);
  assert.deepEqual(lines, ["[local-edge:logs] following scope=healthcheck"]);
  assert.deepEqual(tailArgs, [
    ["-n", "10", "-F", "/repo/logs/local-edge/healthcheck.log"],
  ]);
});
