/**
 * @fileoverview Regression tests for local-edge Ink action-browser view-model helpers.
 *
 * This file owns Node test coverage for header summaries, cyclic selection rotation, out-of-range
 * selection handling, risk-tone mapping, run-done status headlines, and category/action row
 * builders from `ink-action-browser-model`. Flow: fixture inputs -> pure helper calls -> assert strings and row objects.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/ink-action-browser-model.unit.test.ts
 *
 * @see packages/local-edge-kit/src/ink-action-browser-model.ts - Pure view-model helpers under test for Ink action-browser labels, selection, risk taxonomy, and row-shape contracts asserted here.
 * @see packages/local-edge-kit/src/ink-action-browser-app.tsx - Ink React action-browser UI that consumes the header, row, and status formatting behavior verified by these tests during interactive runs.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview contract governing this header shape and verification tags.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalEdgeKit_buildInkActionRows,
  LocalEdgeKit_buildInkCategoryRows,
  LocalEdgeKit_formatInkActionBrowserHeaderSummary,
  LocalEdgeKit_formatInkRunDoneStatusHeadline,
  LocalEdgeKit_getInkRiskTone,
  LocalEdgeKit_getInkSelectedItem,
  LocalEdgeKit_rotateInkSelectionIndex,
} from "./ink-action-browser-model.js";

test("local-edge Ink action browser model formats headers and selections", () => {
  assert.equal(
    LocalEdgeKit_formatInkActionBrowserHeaderSummary({ projectRoot: "/repo" }),
    "Project: /repo | ↑/↓ Navigate | Enter Select | Esc Back | Q Quit",
  );
  assert.equal(
    LocalEdgeKit_getInkSelectedItem({ items: ["a", "b"], selectedIndex: 1 }),
    "b",
  );
  assert.equal(
    LocalEdgeKit_getInkSelectedItem({ items: ["a", "b"], selectedIndex: 4 }),
    null,
  );
});

test("local-edge Ink action browser model rotates selection indexes", () => {
  assert.equal(
    LocalEdgeKit_rotateInkSelectionIndex({
      currentIndex: 0,
      direction: "up",
      itemCount: 3,
    }),
    2,
  );
  assert.equal(
    LocalEdgeKit_rotateInkSelectionIndex({
      currentIndex: 2,
      direction: "down",
      itemCount: 3,
    }),
    0,
  );
  assert.equal(
    LocalEdgeKit_rotateInkSelectionIndex({
      currentIndex: 4,
      direction: "down",
      itemCount: 0,
    }),
    0,
  );
});

test("local-edge Ink action browser model maps risk and run status labels", () => {
  assert.equal(LocalEdgeKit_getInkRiskTone("read-only"), "info");
  assert.equal(LocalEdgeKit_getInkRiskTone("mutating"), "warning");
  assert.equal(LocalEdgeKit_getInkRiskTone("destructive"), "error");
  assert.equal(
    LocalEdgeKit_formatInkRunDoneStatusHeadline("succeeded"),
    "✓ Success",
  );
  assert.equal(
    LocalEdgeKit_formatInkRunDoneStatusHeadline("failed"),
    "✗ Failed",
  );
  assert.equal(
    LocalEdgeKit_formatInkRunDoneStatusHeadline("cancelled"),
    "⊘ Cancelled",
  );
});

test("local-edge Ink action browser model builds category and action rows", () => {
  assert.deepEqual(
    LocalEdgeKit_buildInkCategoryRows({
      categories: [
        { id: "first", label: "First" },
        { id: "second", label: "Second" },
      ],
      selectedIndex: 1,
    }),
    [
      { id: "first", label: "First", marker: "  ", selected: false },
      { id: "second", label: "Second", marker: "> ", selected: true },
    ],
  );

  assert.deepEqual(
    LocalEdgeKit_buildInkActionRows({
      actions: [
        { id: "status", label: "Status", risk: "read-only" },
        { id: "stop", label: "Stop", risk: "mutating" },
      ],
      selectedIndex: 0,
    }),
    [
      {
        id: "status",
        label: "Status",
        marker: "> ",
        risk: "read-only",
        riskLabel: "(read-only)",
        selected: true,
      },
      {
        id: "stop",
        label: "Stop",
        marker: "  ",
        risk: "mutating",
        riskLabel: "(mutating)",
        selected: false,
      },
    ],
  );
});
