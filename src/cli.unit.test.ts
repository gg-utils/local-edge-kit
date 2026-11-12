/**
 * @fileoverview Regression tests for `LocalEdgeKit_runCli` help output and unknown-command handling in
 * the reusable local-edge kit.
 *
 * Runtime command behavior is smoke-tested through repository adapters; this module keeps the
 * dispatcher contract host-state-free by covering help and unknown-command paths only.
 * Flow: stub console -> invoke dispatcher -> assert exit code and captured stdout/stderr strings.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/cli.unit.test.ts
 *
 * @see packages/local-edge-kit/src/cli.ts - Kit CLI dispatcher under test; owns argv parsing, usage text, and command routing asserted here.
 * @see packages/local-edge-kit/src/config.ts - defineLocalEdgeConfig-backed fixture builder supplying deterministic LocalEdgeKit_Config without live host/router I/O.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview contract governing this header shape and verification tags.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LocalEdgeKit_runCli } from "./cli.js";
import { defineLocalEdgeConfig, type LocalEdgeKit_Config } from "./config.js";

function createTestConfig(): LocalEdgeKit_Config {
  return defineLocalEdgeConfig({
    cli: {
      commandName: "example-local-edge",
      logPrefix: "example-local-edge",
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
          composeProjectNamePrefix: "local-edge-nginx-docker",
        },
      ],
    },
    surfaces: [
      {
        id: "web",
        appPath: "/",
        statusPath: "/status",
      },
    ],
  });
}

void test("LocalEdgeKit_runCli renders help without dispatching", async () => {
  const originalLog = console.log;
  const output: string[] = [];
  console.log = (message?: unknown): void => {
    output.push(typeof message === "string" ? message : "");
  };

  try {
    const exitCode = await LocalEdgeKit_runCli({
      args: ["--help"],
      config: createTestConfig(),
      env: {},
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(output, [
      "Usage: example-local-edge <dns-audit|healthcheck|status|urls> [args]",
    ]);
  } finally {
    console.log = originalLog;
  }
});

void test("LocalEdgeKit_runCli rejects unknown commands", async () => {
  const originalError = console.error;
  const output: string[] = [];
  console.error = (message?: unknown): void => {
    output.push(typeof message === "string" ? message : "");
  };

  try {
    const exitCode = await LocalEdgeKit_runCli({
      args: ["missing-command"],
      config: createTestConfig(),
      env: {},
    });

    assert.equal(exitCode, 2);
    assert.deepEqual(output, ["[local-edge-kit:error] Unknown command: missing-command"]);
  } finally {
    console.error = originalError;
  }
});

void test("no echo: an unknown command is repeated only when it is a short plain word", async () => {
  const originalError = console.error;
  const output: string[] = [];
  console.error = (message?: unknown): void => {
    output.push(typeof message === "string" ? message : "");
  };
  try {
    for (const command of ["missing-command", "ECHOMARK7 token=x"]) {
      assert.equal(await LocalEdgeKit_runCli({ args: [command], config: createTestConfig(), env: {} }), 2);
    }
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(output, ["[local-edge-kit:error] Unknown command: missing-command", "[local-edge-kit:error] Unknown command: <17 characters>"]);
});
