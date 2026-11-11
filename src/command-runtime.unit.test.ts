/**
 * @fileoverview Node test regression coverage for `local-edge-kit` command-runtime helpers used by
 * local-edge CLIs when resolving project roots, loading layered env files, validating methods, and
 * resolving script paths.
 *
 * This file owns assertions against the pure helpers exported from `command-runtime.ts`, including
 * filesystem-backed env stack merges in a temporary directory.
 * Flow: arrange env or temp files -> call helper -> assert resolved paths, flags, and merged env.
 *
 * @testing Node test (tsx via npm): npm run test --prefix packages/local-edge-kit
 *
 * @see packages/local-edge-kit/src/command-runtime.ts - Command-runtime helper module whose project-root resolution, env stack loading, method validation, and script-path behavior is exercised by these tests.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview contract defining the audited @testing, @see, and @documentation header shape used here.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalEdgeKit_commandRuntimeDefaultEnvFile,
  LocalEdgeKit_commandRuntimeIsTruthy,
  LocalEdgeKit_commandRuntimeLoadEnvFileStack,
  LocalEdgeKit_commandRuntimeResolveProjectRoot,
  LocalEdgeKit_commandRuntimeResolveScriptPath,
  LocalEdgeKit_commandRuntimeShouldFailHard,
  LocalEdgeKit_commandRuntimeValidateRequestedMethod,
} from "./command-runtime.js";

void test("LocalEdgeKit command runtime resolves roots, defaults, and truthy values", () => {
  assert.equal(
    LocalEdgeKit_commandRuntimeResolveProjectRoot({
      defaultProjectRoot: "/repo/default",
      env: { LOCAL_EDGE_PROJECT_ROOT: "/repo/env" },
    }),
    "/repo/env",
  );
  assert.equal(
    LocalEdgeKit_commandRuntimeDefaultEnvFile({
      defaultProjectRoot: "/repo/default",
      projectRoot: "/repo/explicit",
    }),
    "/repo/explicit/.env.local-edge",
  );
  assert.equal(LocalEdgeKit_commandRuntimeIsTruthy("yes"), true);
  assert.equal(
    LocalEdgeKit_commandRuntimeShouldFailHard({
      env: { LOCAL_EDGE_STRICT_START: "1" },
    }),
    true,
  );
});

void test("LocalEdgeKit command runtime loads ordered env file stacks", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-edge-kit-env-"));
  const firstFile = path.join(tmpDir, "first.env");
  const secondFile = path.join(tmpDir, "second.env");
  fs.writeFileSync(firstFile, "EXAMPLE_KEY=first\nSHARED_KEY=first\n");
  fs.writeFileSync(secondFile, "SHARED_KEY=second\n");
  const env: NodeJS.ProcessEnv = {};

  assert.deepEqual(
    LocalEdgeKit_commandRuntimeLoadEnvFileStack({
      env,
      logPrefix: "local-edge:test",
      sourceFiles: [firstFile, secondFile, path.join(tmpDir, "missing.env")],
    }),
    [firstFile, secondFile],
  );
  assert.equal(env.EXAMPLE_KEY, "first");
  assert.equal(env.SHARED_KEY, "second");
});

void test("LocalEdgeKit command runtime validates methods and script paths", () => {
  assert.equal(
    LocalEdgeKit_commandRuntimeValidateRequestedMethod({
      allowAll: true,
      commandLabel: "local-edge:test",
      method: "all",
      supportedMethods: ["nginx-docker"],
    }),
    "all",
  );
  assert.equal(
    LocalEdgeKit_commandRuntimeValidateRequestedMethod({
      allowAll: false,
      commandLabel: "local-edge:test",
      method: "nginx-docker",
      supportedMethods: ["nginx-docker"],
    }),
    "nginx-docker",
  );
  assert.equal(
    LocalEdgeKit_commandRuntimeResolveScriptPath({
      scriptDirectory: "/repo/scripts/local-edge",
      scriptFileName: "status.ts",
    }),
    "/repo/scripts/local-edge/status.ts",
  );
});
