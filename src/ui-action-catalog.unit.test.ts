/**
 * @fileoverview Node test coverage for local-edge UI action catalog lookup and type-guard helpers.
 *
 * This file owns regression assertions for `LocalEdgeKit_getUiActionById`, `LocalEdgeKit_getUiActionsForCategory`, and `LocalEdgeKit_isUiActionId` over a small typed `LocalEdgeKit_UiActionCard` fixture list. Flow: build fixture actions -> call catalog helpers -> assert lookup labels, category filtering, and id membership.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/ui-action-catalog.unit.test.ts
 *
 * @see packages/local-edge-kit/src/ui-action-catalog.ts - Generic action-card contract and lookup helpers whose id resolution, category scoping, and id-guard behavior are asserted here.
 * @see packages/local-edge-kit/src/index.ts - Package public surface that re-exports the catalog module so downstream packages can import the helpers verified here without deep-linking implementation files.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview contract governing this header shape and verification tags.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalEdgeKit_getUiActionById,
  LocalEdgeKit_getUiActionsForCategory,
  LocalEdgeKit_isUiActionId,
  type LocalEdgeKit_UiActionCard,
} from "./ui-action-catalog.js";

type ActionId = "status" | "stop";
type CategoryId = "diagnostics" | "maintenance";
type Special = "none";

const ACTIONS: readonly LocalEdgeKit_UiActionCard<
  ActionId,
  CategoryId,
  Special
>[] = [
  {
    categoryId: "diagnostics",
    description: "Print status",
    id: "status",
    label: "Status",
    requiresTypedConfirmation: false,
    risk: "read-only",
    special: "none",
    supportsMethodAll: true,
  },
  {
    categoryId: "maintenance",
    description: "Stop services",
    id: "stop",
    label: "Stop",
    requiresTypedConfirmation: true,
    risk: "destructive",
    special: "none",
    supportsMethodAll: false,
  },
];

void test("local-edge UI action catalog helpers resolve ids and categories", () => {
  assert.equal(
    LocalEdgeKit_getUiActionById({ actions: ACTIONS, id: "status" })?.label,
    "Status",
  );
  assert.deepEqual(
    LocalEdgeKit_getUiActionsForCategory({
      actions: ACTIONS,
      categoryId: "maintenance",
    }).map((action) => action.id),
    ["stop"],
  );
  assert.equal(
    LocalEdgeKit_isUiActionId({ actions: ACTIONS, value: "status" }),
    true,
  );
  assert.equal(
    LocalEdgeKit_isUiActionId({ actions: ACTIONS, value: "missing" }),
    false,
  );
});
