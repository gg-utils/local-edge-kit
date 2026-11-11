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
import path from "node:path";
/** Parses local-edge UI launcher argv with a project-supplied action-id guard. */
export function LocalEdgeKit_parseUiLaunchArgv(options) {
    let helpRequested = false;
    let printCommandMode = "none";
    let printCommandActionId = null;
    let projectRoot = options.cwd;
    for (let index = 0; index < options.argv.length; index += 1) {
        const arg = options.argv[index];
        const next = options.argv[index + 1];
        switch (arg) {
            case "--help":
            case "-h":
                helpRequested = true;
                break;
            case "--project-root":
                if (!next) {
                    throw new Error(`${options.errorPrefix} --project-root requires a path.`);
                }
                projectRoot = path.resolve(next);
                index += 1;
                break;
            case "--print-command":
            case "--print-plan":
            case "--json-plan": {
                if (!next) {
                    throw new Error(`${options.errorPrefix} ${arg} requires an action id.`);
                }
                if (!options.isActionId(next)) {
                    throw new Error(`${options.errorPrefix} Unknown action id: ${next}`);
                }
                printCommandMode = arg === "--json-plan" ? "json" : "line";
                printCommandActionId = next;
                index += 1;
                break;
            }
            default:
                throw new Error(`${options.errorPrefix} Unknown option: ${arg}`);
        }
    }
    return {
        helpRequested,
        printCommandActionId,
        printCommandMode,
        projectRoot,
    };
}
/** Formats stable local-edge UI launcher help text for a project-owned command surface. */
export function LocalEdgeKit_formatUiLaunchHelpText(options) {
    return `Usage: ${options.invocation} -- [options]

${options.title}. Canonical automation remains npm run local:edge:* and direct script paths.

Options:
  --project-root <path>   Repo root (default: cwd)
  --print-command <id>    Print resolved spawn line for action id and exit (no TTY required)
  --print-plan <id>       Alias for --print-command
  --json-plan <id>        Print JSON spawn plan for action id and exit (no TTY required)
  --help                  Show this help

Examples:
${options.examples.map((example) => `  ${example}`).join("\n")}
`;
}
