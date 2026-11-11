/**
 * @fileoverview Verifies `LocalEdgeKit_runStartupCliCommand` usage output, spawn planning against
 * stubbed filesystem and process operations, and parse failures that must not spawn children.
 *
 * This file owns regression coverage for the startup dispatcher contract: `--help` exit 0,
 * `run start` forwarding to the configured implementation script with resolved method env, and
 * unknown forwarded flags surfacing as usage errors without touching `spawn`.
 * Flow: build kit config -> invoke dispatcher with stubbed operations -> assert logs, errors, exit
 * codes, and captured spawn requests.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/startup-cli.unit.test.ts
 *
 * @see packages/local-edge-kit/src/startup-cli.ts - Startup dispatcher implementation under test for argv parsing, implementation resolution, startup env projection, and `spawnSync` orchestration consumed by these assertions.
 * @see packages/local-edge-kit/src/config.ts - `defineLocalEdgeConfig` surface used to build deterministic startup fixtures that drive the dispatcher scenarios exercised here.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import { defineLocalEdgeConfig } from "./config.js";
import {
  LocalEdgeKit_runStartupCliCommand,
  type LocalEdgeKit_StartupCliOperations,
  type LocalEdgeKit_StartupCliSpawnRequest,
} from "./startup-cli.js";

function createStartupConfig() {
  return defineLocalEdgeConfig({
    cli: {
      commandName: "example-local-edge",
      logPrefix: "example-local-edge",
    },
    env: {
      projectRootEnvName: "LOCAL_EDGE_PROJECT_ROOT",
    },
    identity: {
      defaultDeveloperSlug: "dev",
      defaultRealmSlug: "main",
      defaultRootZone: "example.test",
    },
    router: {
      primaryMethod: "nginx-docker",
      methods: [
        {
          kind: "nginx-docker",
          method: "nginx-docker",
          serviceName: "edge-router",
          defaultListenHost: "127.0.0.1",
          defaultListenPort: 443,
          composeProjectNamePrefix: "edge-router",
        },
      ],
    },
    startup: {
      invocation: "example-local-edge-startup",
      implementationDirectory: "scripts/local-edge",
    },
    surfaces: [],
  });
}

void test("LocalEdgeKit_runStartupCliCommand renders configured usage", () => {
  const logs: string[] = [];
  const exitCode = LocalEdgeKit_runStartupCliCommand({
    args: ["--help"],
    config: createStartupConfig(),
    env: {
      LOCAL_EDGE_PROJECT_ROOT: "/tmp/example-project",
    },
    output: {
      error(message) {
        throw new Error(String(message));
      },
      log(message) {
        logs.push(message);
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.match(
    logs[0] ?? "",
    /^Usage: example-local-edge-startup run <command>/,
  );
});

void test("LocalEdgeKit_runStartupCliCommand plans and spawns configured impls", () => {
  const spawnRequests: LocalEdgeKit_StartupCliSpawnRequest[] = [];
  const operations: LocalEdgeKit_StartupCliOperations = {
    pathExists(filePath) {
      assert.equal(
        filePath,
        "/tmp/example-project/scripts/local-edge/start-impl.ts",
      );
      return true;
    },
    spawn(request) {
      spawnRequests.push(request);
      return 7;
    },
  };

  const exitCode = LocalEdgeKit_runStartupCliCommand({
    args: ["run", "start", "--", "--method", "nginx-docker"],
    config: createStartupConfig(),
    env: {
      LOCAL_EDGE_PRIMARY_METHOD: "nginx-docker",
      LOCAL_EDGE_PROJECT_ROOT: "/tmp/example-project",
    },
    operations,
    output: {
      error(message) {
        throw new Error(String(message));
      },
      log(message) {
        throw new Error(String(message));
      },
    },
  });

  assert.equal(exitCode, 7);
  assert.equal(spawnRequests.length, 1);
  assert.deepEqual(spawnRequests[0]?.args, [
    "tsx",
    "/tmp/example-project/scripts/local-edge/start-impl.ts",
  ]);
  assert.equal(spawnRequests[0]?.command, "npx");
  assert.equal(
    spawnRequests[0]?.env.LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD,
    "nginx-docker",
  );
});

void test("LocalEdgeKit_runStartupCliCommand returns usage errors without spawning", () => {
  const errors: string[] = [];
  const exitCode = LocalEdgeKit_runStartupCliCommand({
    args: ["run", "start", "--", "--unknown"],
    config: createStartupConfig(),
    env: {
      LOCAL_EDGE_PROJECT_ROOT: "/tmp/example-project",
    },
    operations: {
      pathExists() {
        throw new Error("pathExists should not run");
      },
      spawn() {
        throw new Error("spawn should not run");
      },
    },
    output: {
      error(message) {
        errors.push(message);
      },
      log(message) {
        throw new Error(String(message));
      },
    },
  });

  assert.equal(exitCode, 2);
  assert.deepEqual(errors, ["[local-edge:start] Unknown option: --unknown"]);
});
