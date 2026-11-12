/**
 * @fileoverview Reusable classic interactive action-menu runner for local-edge CLIs.
 *
 * The kit owns menu rendering, choice dispatch, method-all prompts, required-argument prompts, log
 * scope selection, and loop control. Consumers inject their project menu config, root npm runner,
 * TTY/session implementation, and log command resolver.
 *
 * @testing Jest unit: npm run test --prefix packages/local-edge-kit
 *
 * @see packages/local-edge-kit/src/interactive-action-menu.unit.test.ts - Jest regression coverage for print, dispatch, and loop behavior owned by this menu runner.
 * @see packages/local-edge-kit/src/index.ts - Package barrel that re-exports this module for `@gg-utils/local-edge-kit/interactive-action-menu` consumers.
 * @see consumer local-edge adapter - Interactive CLI adapter that wires session, `runScript`, and `resolveLogCommand` into `LocalEdgeKit_runInteractiveActionMenu`.
 * @see local-edge-interactive.config.ts - Root menu config typing the sections and log-scope options this runner consumes for local-edge interactive flows.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { LocalEdgeKit_messageWord } from "./safe-message.js";
/** Prints all configured sections into the supplied interactive session. */
export function LocalEdgeKit_printInteractiveActionMenu(options) {
    const { config, session } = options;
    session.clearScreen();
    session.printHeader(config.headerTitle, config.headerSubtitle);
    for (const section of config.sections) {
        session.printPanelTitle(section.title, section.subtitle);
        for (const item of section.items) {
            session.printMenuItem(item.key, item.title, item.description);
        }
    }
}
/** Flattens configured menu rows for choice lookup. */
function findInteractiveMenuItem(options) {
    for (const section of options.sections) {
        const item = section.items.find((candidate) => candidate.key === options.choice);
        if (item !== undefined) {
            return item;
        }
    }
    return null;
}
/** Dispatches one configured menu action and returns loop control. */
export async function LocalEdgeKit_handleInteractiveActionMenuSelection(options) {
    const { choice, config, dependencies } = options;
    const { session } = dependencies;
    if (config.exitAliases.includes(choice)) {
        session.printSuccess(config.exitMessage);
        return "exit";
    }
    const item = findInteractiveMenuItem({ choice, sections: config.sections });
    if (item === null) {
        session.printError(`Invalid choice: ${LocalEdgeKit_messageWord(choice)}`);
        return "continue";
    }
    const action = item.action;
    if (action.kind === "exit") {
        session.printSuccess(config.exitMessage);
        return "exit";
    }
    if (action.kind === "run-script") {
        if (action.warning !== undefined) {
            session.printWarning(action.warning);
        }
        await dependencies.runScript(session, {
            args: action.args,
            scriptName: action.scriptName,
        });
        return "continue";
    }
    if (action.kind === "method-aware") {
        const shouldRunForAllMethods = await session.promptYesNo(config.methodAllPrompt, config.runForAllDefaultAnswer);
        await dependencies.runScript(session, {
            scriptName: shouldRunForAllMethods
                ? action.allScriptName
                : action.scriptName,
        });
        return "continue";
    }
    if (action.kind === "required-arg-run-script") {
        const value = await session.promptRequired(action.prompt);
        await dependencies.runScript(session, {
            args: [action.argName, value],
            scriptName: action.scriptName,
        });
        return "continue";
    }
    const scope = await session.chooseFromList({
        items: config.logScopeItems,
        promptSubtitle: "Select scope",
        promptTitle: action.promptTitle,
    });
    const resolvedCommand = dependencies.resolveLogCommand({
        mode: action.mode,
        scope,
    });
    if (resolvedCommand.note !== undefined) {
        session.printNote(resolvedCommand.note);
    }
    await dependencies.runScript(session, {
        scriptName: resolvedCommand.scriptName,
    });
    return "continue";
}
/** Runs the configured classic action menu loop until the user exits. */
export async function LocalEdgeKit_runInteractiveActionMenu(options) {
    const { config, dependencies } = options;
    const { session } = dependencies;
    for (;;) {
        LocalEdgeKit_printInteractiveActionMenu({ config, session });
        session.writeLine("");
        const choice = await session.promptReadLine(config.choicePrompt);
        session.writeLine("");
        const outcome = await LocalEdgeKit_handleInteractiveActionMenuSelection({
            choice,
            config,
            dependencies,
        });
        if (outcome === "exit") {
            return;
        }
        session.writeLine("");
        await session.promptReadLine(config.pausePrompt);
    }
}
