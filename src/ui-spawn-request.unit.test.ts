/**
 * @fileoverview Regression tests for local-edge UI spawn-request helpers and the config-driven
 * `LocalEdgeKit_buildUiSpawnRequest` planner.
 *
 * This file owns assertions for npm vs bash spawn shapes, method-all and logs argv helpers, init and
 * pool-next flag serialization, reconcile bash args, custom-register bridging, and validation errors
 * when required resolve options are absent.
 * Flow: fixture actions/config -> `LocalEdgeKit_buildUiSpawnRequest` / small arg builders -> assert
 * request objects and thrown messages.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/ui-spawn-request.unit.test.ts
 *
 * @see packages/local-edge-kit/src/ui-spawn-request.ts - Spawn planner and argv builders under test; defines the descriptor config and resolve-option contract asserted here.
 * @see packages/local-edge-kit/src/index.ts - Package export surface that re-exports the planner helpers covered by this regression module.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview contract governing this header shape and verification tags.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalEdgeKit_buildUiLogsLineArgs,
  LocalEdgeKit_buildUiMethodAllArgs,
  LocalEdgeKit_buildUiSpawnRequest,
  LocalEdgeKit_createDefaultUiResolveOptions,
  type LocalEdgeKit_UiResolveOptions,
  type LocalEdgeKit_UiSpawnActionInput,
  type LocalEdgeKit_UiSpawnRequestConfig,
} from "./ui-spawn-request.js";

type ActionId =
  | "custom-register"
  | "init"
  | "logs"
  | "pool-next"
  | "reconcile"
  | "status";

type RegisterOptions = { readonly value: string };
type ResolveOptions = LocalEdgeKit_UiResolveOptions<RegisterOptions>;

const ACTIONS: Record<ActionId, LocalEdgeKit_UiSpawnActionInput<ActionId>> = {
  "custom-register": { id: "custom-register", supportsMethodAll: false },
  init: { id: "init", supportsMethodAll: false },
  logs: { id: "logs", supportsMethodAll: false },
  "pool-next": { id: "pool-next", supportsMethodAll: false },
  reconcile: { id: "reconcile", supportsMethodAll: false },
  status: { id: "status", supportsMethodAll: true },
};

const CONFIG: LocalEdgeKit_UiSpawnRequestConfig<ActionId, ResolveOptions> = {
  actionDescriptors: {
    "custom-register": { kind: "custom" },
    init: { kind: "init-npm", npmScript: "edge:init" },
    logs: { kind: "logs-npm", npmScript: "edge:logs" },
    "pool-next": { kind: "pool-next-npm", npmScript: "edge:pool:next" },
    reconcile: {
      defaultMethod: "router-a",
      kind: "reconcile-bash",
      scriptPathFromRepoRoot: "./scripts/reconcile.sh",
    },
    status: { kind: "method-all-npm", npmScript: "edge:status" },
  },
  buildCustomRequest: ({ actionId, resolveOptions }) => {
    if (actionId !== "custom-register" || !resolveOptions.realmRegister) {
      return null;
    }
    return {
      args: ["--value", resolveOptions.realmRegister.value],
      kind: "npm",
      npmScript: "edge:register",
    };
  },
  getActionById: (actionId) => ACTIONS[actionId] ?? null,
};

const DEFAULT_OPTIONS = LocalEdgeKit_createDefaultUiResolveOptions({
  createRegisterOptions: () => ({ value: "demo" }),
  defaultLogsLines: "1000",
  defaultReconcileMethod: "router-a",
});

void test("local-edge UI spawn helpers build method-all and logs args", () => {
  assert.deepEqual(
    LocalEdgeKit_buildUiMethodAllArgs({
      methodAll: true,
      supportsMethodAll: true,
    }),
    ["--method", "all"],
  );
  assert.deepEqual(LocalEdgeKit_buildUiLogsLineArgs(" 42 "), ["--lines", "42"]);
  assert.deepEqual(LocalEdgeKit_buildUiLogsLineArgs("latest"), []);
});

void test("local-edge UI spawn planner handles common descriptor families", () => {
  assert.deepEqual(
    LocalEdgeKit_buildUiSpawnRequest({
      actionId: "status",
      config: CONFIG,
      resolveOptions: { ...DEFAULT_OPTIONS, methodAll: true },
    }),
    { args: ["--method", "all"], kind: "npm", npmScript: "edge:status" },
  );
  assert.deepEqual(
    LocalEdgeKit_buildUiSpawnRequest({
      actionId: "init",
      config: CONFIG,
      resolveOptions: {
        ...DEFAULT_OPTIONS,
        init: {
          bootstrap: true,
          developerSlug: "dev-a",
          dryRun: true,
          noChecks: true,
        },
      },
    }),
    {
      args: [
        "--dry-run",
        "--no-checks",
        "--bootstrap",
        "--developer-slug",
        "dev-a",
      ],
      kind: "npm",
      npmScript: "edge:init",
    },
  );
  assert.deepEqual(
    LocalEdgeKit_buildUiSpawnRequest({
      actionId: "pool-next",
      config: CONFIG,
      resolveOptions: {
        ...DEFAULT_OPTIONS,
        poolNextRealm: "realm-a",
        poolNextStackName: "stack-a",
      },
    }),
    {
      args: ["--stack-name", "stack-a", "--realm", "realm-a"],
      kind: "npm",
      npmScript: "edge:pool:next",
    },
  );
  assert.deepEqual(
    LocalEdgeKit_buildUiSpawnRequest({
      actionId: "reconcile",
      config: CONFIG,
      resolveOptions: {
        ...DEFAULT_OPTIONS,
        reconcile: {
          method: "",
          realm: "realm-a",
          recreateIfRunning: true,
        },
      },
    }),
    {
      args: [
        "--method",
        "router-a",
        "--realm",
        "realm-a",
        "--recreate-if-running",
      ],
      kind: "bash",
      scriptPathFromRepoRoot: "./scripts/reconcile.sh",
    },
  );
  assert.deepEqual(
    LocalEdgeKit_buildUiSpawnRequest({
      actionId: "logs",
      config: CONFIG,
      resolveOptions: { ...DEFAULT_OPTIONS, logsLines: "5" },
    }),
    { args: ["--lines", "5"], kind: "npm", npmScript: "edge:logs" },
  );
  assert.deepEqual(
    LocalEdgeKit_buildUiSpawnRequest({
      actionId: "custom-register",
      config: CONFIG,
      resolveOptions: DEFAULT_OPTIONS,
    }),
    {
      args: ["--value", "demo"],
      kind: "npm",
      npmScript: "edge:register",
    },
  );
});

void test("local-edge UI spawn planner rejects missing pool-next stack", () => {
  assert.throws(
    () =>
      LocalEdgeKit_buildUiSpawnRequest({
        actionId: "pool-next",
        config: CONFIG,
        resolveOptions: DEFAULT_OPTIONS,
      }),
    /stack name/,
  );
});
