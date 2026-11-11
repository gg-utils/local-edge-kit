/**
 * @fileoverview Reusable local-edge UI launcher parsing helpers.
 *
 * Project adapters own action catalogs and print-plan rendering. This package module owns the
 * shared `--project-root`, `--print-command`/`--print-plan`, `--json-plan`, and help-mode parsing
 * used by local-edge Ink/OpenTUI launchers without knowing any project-specific action ids.
 *
 * @testing Node test (tsx): cd packages/local-edge-kit && npm run test -- src/ui-launcher.unit.test.ts
 *
 * @see packages/local-edge-kit/src/ui-launcher.unit.test.ts - Node `node:test` module asserting argv parsing, print-mode aliases, resolved `projectRoot`, and formatted help for the exports defined here.
 * @see packages/local-edge-kit/src/index.ts - Package barrel re-exporting `./ui-launcher.js` so `@gg-utils/local-edge-kit` and `./ui-launcher` subpath imports resolve the shared argv and help helpers from one entry surface.
 * @see consumer local-edge adapter - Root Ink launch adapter that forwards argv into `LocalEdgeKit_parseUiLaunchArgv` and `LocalEdgeKit_formatUiLaunchHelpText` before the action browser boots.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
/** Parsed result from a local-edge UI launcher argv slice. */
export type LocalEdgeKit_UiLaunchParseResult<ActionId extends string> = {
    helpRequested: boolean;
    printCommandMode: "none" | "line" | "json";
    printCommandActionId: ActionId | null;
    projectRoot: string;
};
/** Parses local-edge UI launcher argv with a project-supplied action-id guard. */
export declare function LocalEdgeKit_parseUiLaunchArgv<ActionId extends string>(options: {
    argv: readonly string[];
    cwd: string;
    errorPrefix: string;
    isActionId: (value: string) => value is ActionId;
}): LocalEdgeKit_UiLaunchParseResult<ActionId>;
/** Formats stable local-edge UI launcher help text for a project-owned command surface. */
export declare function LocalEdgeKit_formatUiLaunchHelpText(options: {
    examples: readonly string[];
    invocation: string;
    title: string;
}): string;
