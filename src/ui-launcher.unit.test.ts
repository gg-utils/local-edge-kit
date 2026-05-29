/**
 * @fileoverview Unit coverage for shared local-edge UI launcher argv parsing and help formatting helpers.
 *
 * This file owns regression coverage for `--project-root`, `--print-command`/`--print-plan`, `--json-plan`,
 * action-id validation via a project-supplied type guard, and `LocalEdgeKit_formatUiLaunchHelpText` output.
 * Flow: build argv + cwd fixtures -> call parse/format helpers -> assert parsed fields, throws, and help substrings.
 *
 * @testing Node test (tsx): cd packages/local-edge-kit && npm run test -- src/ui-launcher.unit.test.ts
 *
 * @see packages/local-edge-kit/src/ui-launcher.ts - Shared argv and help helpers under test whose print-mode aliases, project-root resolution, and formatted help examples are asserted here.
 * @see consumer local-edge adapter - Root Ink launch adapter that forwards argv into `LocalEdgeKit_parseUiLaunchArgv` and `LocalEdgeKit_formatUiLaunchHelpText` before the action browser boots.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview contract governing this header shape and verification tags.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalEdgeKit_formatUiLaunchHelpText,
  LocalEdgeKit_parseUiLaunchArgv,
} from "./ui-launcher.js";

/** Narrow fixture action ids used by the parse tests in this file. */
function isDemoActionId(value: string): value is "status" | "urls" {
  return value === "status" || value === "urls";
}

test("LocalEdgeKit_parseUiLaunchArgv parses print modes and project root", () => {
  assert.deepEqual(
    LocalEdgeKit_parseUiLaunchArgv({
      argv: ["--project-root", "/repo", "--print-command", "status"],
      cwd: "/cwd",
      errorPrefix: "[local-edge:test]",
      isActionId: isDemoActionId,
    }),
    {
      helpRequested: false,
      printCommandActionId: "status",
      printCommandMode: "line",
      projectRoot: "/repo",
    },
  );
});

test("LocalEdgeKit_parseUiLaunchArgv rejects unknown action ids", () => {
  assert.throws(
    () =>
      LocalEdgeKit_parseUiLaunchArgv({
        argv: ["--json-plan", "missing"],
        cwd: "/cwd",
        errorPrefix: "[local-edge:test]",
        isActionId: isDemoActionId,
      }),
    /Unknown action id/u,
  );
});

test("LocalEdgeKit_parseUiLaunchArgv accepts OpenTUI print-plan alias", () => {
  assert.deepEqual(
    LocalEdgeKit_parseUiLaunchArgv({
      argv: ["--print-plan", "urls"],
      cwd: "/cwd",
      errorPrefix: "[local-edge:test]",
      isActionId: isDemoActionId,
    }),
    {
      helpRequested: false,
      printCommandActionId: "urls",
      printCommandMode: "line",
      projectRoot: "/cwd",
    },
  );
});

test("LocalEdgeKit_formatUiLaunchHelpText includes examples", () => {
  const helpText = LocalEdgeKit_formatUiLaunchHelpText({
    examples: ["npm run local:edge:cli:test -- --print-command status"],
    invocation: "npm run local:edge:cli:test",
    title: "Interactive console for local-edge commands",
  });
  assert.match(helpText, /--json-plan/u);
  assert.match(helpText, /print-command status/u);
});
