/**
 * @fileoverview Verifies the package-owned doctor-core CLI adapter that dispatches doctor commands
 * with injectable filesystem and stdio hooks.
 *
 * This file owns regression coverage for `LocalEdgeKit_runDoctorCoreCli` exit codes, stderr usage
 * messaging, and stdout summary lines when registry JSON and workspace paths are virtualized.
 * Flow: build argv + injected I/O -> run adapter -> assert exit code and captured stdout/stderr.
 *
 * @testing Node test (tsx): cd packages/local-edge-kit && node ../../node_modules/tsx/dist/cli.mjs --test src/doctor-core-cli.unit.test.ts
 *
 * @see packages/local-edge-kit/src/doctor-core-cli.ts - Kit adapter under test that wires argv parsing, filesystem reads, and doctor-core helpers into explicit stdout/stderr writers.
 * @see packages/local-edge-core/src/doctor.ts - Product-neutral doctor helpers and argv contracts exercised indirectly through the adapter assertions here.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LocalEdgeKit_runDoctorCoreCli } from "./doctor-core-cli.js";

void test("LocalEdgeKit_runDoctorCoreCli prints registry summaries through injected I/O", () => {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const exitCode = LocalEdgeKit_runDoctorCoreCli({
    argv: ["print-registry-line", "--path", "/virtual/registry.json"],
    readText(filePath) {
      assert.equal(filePath, "/virtual/registry.json");
      return JSON.stringify({
        schemaVersion: 1,
        realms: {
          active: { status: "active" },
          stale: { status: "stale" },
        },
      });
    },
    stderr(line) {
      stderrLines.push(line);
    },
    stdout(line) {
      stdoutLines.push(line);
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(stderrLines, []);
  assert.deepEqual(stdoutLines, [
    "[local-edge:doctor] Registry schema=1 realms=2 active=1 inactive=0 stale=1",
  ]);
});

void test("LocalEdgeKit_runDoctorCoreCli returns usage errors without throwing", () => {
  const stderrLines: string[] = [];
  const exitCode = LocalEdgeKit_runDoctorCoreCli({
    argv: ["unknown-command"],
    stderr(line) {
      stderrLines.push(line);
    },
    stdout(line) {
      throw new Error(line);
    },
  });

  assert.equal(exitCode, 2);
  assert.match(stderrLines[0] ?? "", /^\[local-edge:doctor\]/);
});

void test("LocalEdgeKit_runDoctorCoreCli verifies workspaces through injected file I/O", () => {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const exitCode = LocalEdgeKit_runDoctorCoreCli({
    argv: [
      "verify-root-workspace",
      "--registry",
      "/virtual/registry.json",
      "--workspace",
      "/workspace",
      "--realm",
      "main",
    ],
    pathExists(filePath) {
      assert.equal(filePath, "/virtual/registry.json");
      return true;
    },
    readText(filePath) {
      assert.equal(filePath, "/virtual/registry.json");
      return JSON.stringify({
        schemaVersion: 1,
        realms: {
          main: {
            workspacePath: "/workspace",
            realmSlug: "main",
            status: "active",
          },
        },
      });
    },
    stderr(line) {
      stderrLines.push(line);
    },
    stdout(line) {
      stdoutLines.push(line);
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(stderrLines, []);
  assert.deepEqual(stdoutLines, [
    "[local-edge:doctor] Root-workspace realm registration confirmed for realm=main.",
  ]);
});

void test("LocalEdgeKit_runDoctorCoreCli reports missing registries before reading", () => {
  const stderrLines: string[] = [];
  const exitCode = LocalEdgeKit_runDoctorCoreCli({
    argv: [
      "verify-root-workspace",
      "--registry",
      "/virtual/missing.json",
      "--workspace",
      "/workspace",
      "--realm",
      "main",
    ],
    pathExists(filePath) {
      assert.equal(filePath, "/virtual/missing.json");
      return false;
    },
    readText(filePath) {
      throw new Error(`Unexpected read for ${filePath}`);
    },
    stderr(line) {
      stderrLines.push(line);
    },
    stdout(line) {
      throw new Error(line);
    },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(stderrLines, [
    "[local-edge:doctor] ERROR: Local session is active but registry is missing: /virtual/missing.json",
  ]);
});
