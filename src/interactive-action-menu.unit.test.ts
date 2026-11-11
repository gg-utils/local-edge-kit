/**
 * @fileoverview Verifies the reusable interactive action-menu runner for menu rendering, choice
 * dispatch, method-all branching, required-argument prompts, and log-scope script resolution.
 *
 * This file owns Node test coverage for `LocalEdgeKit_printInteractiveActionMenu` and
 * `LocalEdgeKit_handleInteractiveActionMenuSelection` using injectable fake session doubles and a
 * stubbed `runScript` sink.
 * Flow: build config + fake session -> assert printed menu lines and captured `runScript` requests for representative actions and exit.
 *
 * @testing Node test runner: cd packages/local-edge-kit && node ../../node_modules/tsx/dist/cli.mjs --test src/interactive-action-menu.unit.test.ts
 *
 * @see packages/local-edge-kit/src/interactive-action-menu.ts - Menu runner, session contract, and dispatcher behavior under test whose print and selection paths are asserted here.
 * @see consumer local-edge adapter - Interactive local-edge CLI adapter that wires a real session, `runScript`, and `resolveLogCommand` into the same menu runner exercised by these fakes.
 * @see packages/local-edge-kit/src/index.ts - Package barrel that re-exports the interactive action-menu module for `@gg-utils/local-edge-kit/interactive-action-menu` consumers covered by this regression surface.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LocalEdgeKit_handleInteractiveActionMenuSelection,
  LocalEdgeKit_printInteractiveActionMenu,
  type LocalEdgeKit_InteractiveActionMenuConfig,
  type LocalEdgeKit_InteractiveRunScriptRequest,
  type LocalEdgeKit_InteractiveSession,
} from "./interactive-action-menu.js";

type TestLogMode = "recent" | "tail";
type TestLogScope = "all" | "run";

type FakeSessionState = {
  readonly chosenScopes: TestLogScope[];
  readonly lines: string[];
  readonly requiredAnswers: string[];
  readonly yesNoAnswers: boolean[];
};

function createFakeSession(
  state: FakeSessionState,
): LocalEdgeKit_InteractiveSession {
  return {
    chooseFromList: async (options) => {
      await Promise.resolve();
           const requestedValue = state.chosenScopes.shift();
      if (requestedValue === undefined) {
        throw new Error("missing fake scope");
      }
      const selectedOption = options.items.find(
        (item) => item.value === requestedValue,
      );
      if (selectedOption === undefined) {
        throw new Error("fake scope was not present in options");
      }
      return selectedOption.value;
    },
    clearScreen: () => state.lines.push("clear"),
    printError: (message) => state.lines.push(`error:${message}`),
    printHeader: (title, subtitle) =>
      state.lines.push(`header:${title}:${subtitle}`),
    printMenuItem: (key, title) => state.lines.push(`item:${key}:${title}`),
    printNote: (message) => state.lines.push(`note:${message}`),
    printPanelTitle: (title) => state.lines.push(`panel:${title}`),
    printSectionBreak: () => state.lines.push("break"),
    printSuccess: (message) => state.lines.push(`success:${message}`),
    printWarning: (message) => state.lines.push(`warning:${message}`),
    promptReadLine: () => Promise.resolve(""),
    promptRequired: async () => {
      await Promise.resolve();
           const value = state.requiredAnswers.shift();
      if (value === undefined) {
        throw new Error("missing fake required answer");
      }
      return value;
    },
    promptYesNo: async () => {
      await Promise.resolve();
           const value = state.yesNoAnswers.shift();
      if (value === undefined) {
        throw new Error("missing fake yes/no answer");
      }
      return value;
    },
    writeLine: (line) => state.lines.push(`line:${line}`),
  };
}

function createConfig(): LocalEdgeKit_InteractiveActionMenuConfig<
  TestLogMode,
  TestLogScope
> {
  return {
    choicePrompt: "choice",
    exitAliases: ["q"],
    exitMessage: "bye",
    headerSubtitle: "MENU",
    headerTitle: "EDGE",
    logScopeItems: [
      { description: "Run", value: "run" },
      { description: "All", value: "all" },
    ],
    methodAllPrompt: "all?",
    pausePrompt: "pause",
    runForAllDefaultAnswer: "n",
    sections: [
      {
        title: "Main",
        subtitle: "Primary",
        items: [
          {
            key: "1",
            title: "Status",
            description: "Status",
            action: {
              kind: "method-aware",
              scriptName: "edge:status",
              allScriptName: "edge:status:all",
            },
          },
          {
            key: "2",
            title: "Pool",
            description: "Pool",
            action: {
              kind: "required-arg-run-script",
              scriptName: "edge:pool:next",
              prompt: "stack",
              argName: "--stack",
            },
          },
          {
            key: "3",
            title: "Logs",
            description: "Logs",
            action: { kind: "log-scope", mode: "recent", promptTitle: "scope" },
          },
        ],
      },
    ],
  };
}

void test("LocalEdgeKit_printInteractiveActionMenu renders configured sections", () => {
  const state: FakeSessionState = {
    chosenScopes: [],
    lines: [],
    requiredAnswers: [],
    yesNoAnswers: [],
  };
  LocalEdgeKit_printInteractiveActionMenu({
    config: createConfig(),
    session: createFakeSession(state),
  });

  assert.deepEqual(state.lines.slice(0, 5), [
    "clear",
    "header:EDGE:MENU",
    "panel:Main",
    "item:1:Status",
    "item:2:Pool",
  ]);
});

void test("LocalEdgeKit_handleInteractiveActionMenuSelection dispatches configured actions", async () => {
  const state: FakeSessionState = {
    chosenScopes: ["all"],
    lines: [],
    requiredAnswers: ["demo"],
    yesNoAnswers: [true],
  };
  const requests: LocalEdgeKit_InteractiveRunScriptRequest[] = [];
  const config = createConfig();
  const session = createFakeSession(state);
  const dependencies = {
    session,
    resolveLogCommand: (options: {
      mode: TestLogMode;
      scope: TestLogScope;
    }) => ({
      note: `mode:${options.mode}`,
      scriptName: `logs:${options.scope}`,
    }),
    runScript: async (
      _session: LocalEdgeKit_InteractiveSession,
      request: LocalEdgeKit_InteractiveRunScriptRequest,
    ) => {
      await Promise.resolve();
      requests.push(request);
    },
  };

  assert.equal(
    await LocalEdgeKit_handleInteractiveActionMenuSelection({
      choice: "1",
      config,
      dependencies,
    }),
    "continue",
  );
  assert.equal(
    await LocalEdgeKit_handleInteractiveActionMenuSelection({
      choice: "2",
      config,
      dependencies,
    }),
    "continue",
  );
  assert.equal(
    await LocalEdgeKit_handleInteractiveActionMenuSelection({
      choice: "3",
      config,
      dependencies,
    }),
    "continue",
  );
  assert.equal(
    await LocalEdgeKit_handleInteractiveActionMenuSelection({
      choice: "q",
      config,
      dependencies,
    }),
    "exit",
  );

  assert.deepEqual(requests, [
    { scriptName: "edge:status:all" },
    { args: ["--stack", "demo"], scriptName: "edge:pool:next" },
    { scriptName: "logs:all" },
  ]);
  assert.ok(state.lines.includes("note:mode:recent"));
  assert.ok(state.lines.includes("success:bye"));
});
