/**
 * @fileoverview Regression tests for local-edge OpenTUI action-browser option and phase helpers.
 *
 * This file owns Node test coverage for tab-select row builders (navigation, categories, actions,
 * preview, result), action-special phase resolution, and typed preview confirmation gating from
 * `opentui-action-browser-model`. Flow: fixture inputs -> pure helper calls -> assert option rows and booleans.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/opentui-action-browser-model.unit.test.ts
 *
 * @see packages/local-edge-kit/src/opentui-action-browser-model.ts - Pure OpenTUI option assembly, phase mapping, and preview-run gating contracts asserted here.
 * @see packages/local-edge-kit/src/opentui-action-browser-app.tsx - OpenTUI action-browser UI that consumes these row builders and phase helpers during interactive runs.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview contract governing this header shape and verification tags.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalEdgeKit_buildOpenTuiActionOptions,
  LocalEdgeKit_buildOpenTuiCategoryOptions,
  LocalEdgeKit_buildOpenTuiContinueOptions,
  LocalEdgeKit_buildOpenTuiNavOptions,
  LocalEdgeKit_buildOpenTuiPreviewOptions,
  LocalEdgeKit_buildOpenTuiResultOptions,
  LocalEdgeKit_resolveOpenTuiPhaseForActionSpecial,
  LocalEdgeKit_shouldRunOpenTuiPreviewAction,
} from "./opentui-action-browser-model.js";

test("OpenTUI action browser model builds navigation rows", () => {
  assert.deepEqual(LocalEdgeKit_buildOpenTuiNavOptions({ includeBack: true }), [
    { description: "Back", name: "Back", value: "back" },
    { description: "Quit (SIGINT)", name: "Quit", value: "quit" },
  ]);
  assert.deepEqual(
    LocalEdgeKit_buildOpenTuiContinueOptions({
      continueDescription: "Continue",
      continueName: "Preview",
      continueValue: "next",
    }),
    [
      { description: "Continue", name: "Preview", value: "next" },
      { description: "Back", name: "Back", value: "back" },
      { description: "Quit (SIGINT)", name: "Quit", value: "quit" },
    ],
  );
});

test("OpenTUI action browser model builds category and action options", () => {
  assert.deepEqual(
    LocalEdgeKit_buildOpenTuiCategoryOptions({
      categories: [
        { id: "bootstrap", label: "Bootstrap" },
        { id: "diagnostics", label: "Diagnostics" },
      ],
    }),
    [
      { description: "bootstrap", name: "Bootstrap", value: "0" },
      { description: "diagnostics", name: "Diagnostics", value: "1" },
      { description: "Quit (SIGINT)", name: "Quit", value: "quit" },
    ],
  );

  assert.deepEqual(
    LocalEdgeKit_buildOpenTuiActionOptions({
      actions: [
        {
          description: "Show status",
          id: "status",
          label: "Status",
          risk: "read-only",
        },
      ],
    }),
    [
      {
        description: "read-only — Show status",
        name: "Status",
        value: "status",
      },
      { description: "Back", name: "Back", value: "back" },
      { description: "Quit (SIGINT)", name: "Quit", value: "quit" },
    ],
  );
});

test("OpenTUI action browser model builds preview/result rows", () => {
  assert.deepEqual(LocalEdgeKit_buildOpenTuiPreviewOptions(), [
    { description: "Execute", name: "Run", value: "run" },
    { description: "Action list", name: "Back", value: "back" },
    { description: "Quit (SIGINT)", name: "Quit", value: "quit" },
  ]);
  assert.deepEqual(LocalEdgeKit_buildOpenTuiResultOptions(), [
    { description: "Categories", name: "Menu", value: "menu" },
  ]);
});

test("OpenTUI action browser model resolves action phases and confirmation policy", () => {
  assert.equal(
    LocalEdgeKit_resolveOpenTuiPhaseForActionSpecial({ special: "init" }),
    "init",
  );
  assert.equal(
    LocalEdgeKit_resolveOpenTuiPhaseForActionSpecial({
      special: "realm-register",
    }),
    "realm",
  );
  assert.equal(
    LocalEdgeKit_resolveOpenTuiPhaseForActionSpecial({ special: "reconcile" }),
    "reconcile",
  );
  assert.equal(
    LocalEdgeKit_resolveOpenTuiPhaseForActionSpecial({
      special: "realm-pool-next",
    }),
    "pool",
  );
  assert.equal(
    LocalEdgeKit_resolveOpenTuiPhaseForActionSpecial({ special: "logs" }),
    "logs",
  );
  assert.equal(
    LocalEdgeKit_resolveOpenTuiPhaseForActionSpecial({ special: "none" }),
    "preview",
  );
  assert.equal(
    LocalEdgeKit_shouldRunOpenTuiPreviewAction({
      confirmationInput: " yes ",
      requiresTypedConfirmation: true,
    }),
    true,
  );
  assert.equal(
    LocalEdgeKit_shouldRunOpenTuiPreviewAction({
      confirmationInput: "no",
      requiresTypedConfirmation: true,
    }),
    false,
  );
  assert.equal(
    LocalEdgeKit_shouldRunOpenTuiPreviewAction({
      confirmationInput: "",
      requiresTypedConfirmation: false,
    }),
    true,
  );
});
