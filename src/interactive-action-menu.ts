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

/** A selectable list option for classic interactive prompts. */
export type LocalEdgeKit_InteractiveListOption<Value extends string = string> =
  {
    readonly description: string;
    readonly value: Value;
  };

/** Minimal interactive session surface required by the package-owned menu runner. */
export type LocalEdgeKit_InteractiveSession = {
  readonly chooseFromList: <Value extends string>(options: {
    readonly items: ReadonlyArray<LocalEdgeKit_InteractiveListOption<Value>>;
    readonly promptSubtitle: string;
    readonly promptTitle: string;
  }) => Promise<Value>;
  readonly clearScreen: () => void;
  readonly printError: (message: string) => void;
  readonly printHeader: (title: string, subtitle: string) => void;
  readonly printMenuItem: (
    key: string,
    title: string,
    description: string,
  ) => void;
  readonly printNote: (message: string) => void;
  readonly printPanelTitle: (title: string, subtitle: string) => void;
  readonly printSectionBreak: () => void;
  readonly printSuccess: (message: string) => void;
  readonly printWarning: (message: string) => void;
  readonly promptReadLine: (prompt: string) => Promise<string>;
  readonly promptRequired: (prompt: string) => Promise<string>;
  readonly promptYesNo: (
    prompt: string,
    defaultAnswer: "n" | "y",
  ) => Promise<boolean>;
  readonly writeLine: (line: string) => void;
};

/** Command details emitted by the package-owned menu runner into a consumer runner. */
export type LocalEdgeKit_InteractiveRunScriptRequest = {
  readonly args?: readonly string[];
  readonly scriptName: string;
};

/** Result from a consumer log-scope resolver. */
export type LocalEdgeKit_InteractiveResolvedLogCommand = {
  readonly note?: string;
  readonly scriptName: string;
};

/** Action variants supported by the reusable menu dispatcher. */
export type LocalEdgeKit_InteractiveMenuAction<
  LogMode extends string = string,
> =
  | {
      readonly kind: "exit";
    }
  | {
      readonly args?: readonly string[];
      readonly kind: "run-script";
      readonly scriptName: string;
      readonly warning?: string;
    }
  | {
      readonly allScriptName: string;
      readonly kind: "method-aware";
      readonly scriptName: string;
    }
  | {
      readonly argName: string;
      readonly kind: "required-arg-run-script";
      readonly prompt: string;
      readonly scriptName: string;
    }
  | {
      readonly kind: "log-scope";
      readonly mode: LogMode;
      readonly promptTitle: string;
    };

/** One numbered menu row rendered inside a section. */
export type LocalEdgeKit_InteractiveMenuItem<LogMode extends string = string> =
  {
    readonly action: LocalEdgeKit_InteractiveMenuAction<LogMode>;
    readonly description: string;
    readonly key: string;
    readonly title: string;
  };

/** A titled group of related menu rows. */
export type LocalEdgeKit_InteractiveMenuSection<
  LogMode extends string = string,
> = {
  readonly items: readonly LocalEdgeKit_InteractiveMenuItem<LogMode>[];
  readonly subtitle: string;
  readonly title: string;
};

/** Full config consumed by the package-owned interactive menu runner. */
export type LocalEdgeKit_InteractiveActionMenuConfig<
  LogMode extends string = string,
  LogScope extends string = string,
> = {
  readonly choicePrompt: string;
  readonly exitAliases: readonly string[];
  readonly exitMessage: string;
  readonly headerSubtitle: string;
  readonly headerTitle: string;
  readonly logScopeItems: ReadonlyArray<
    LocalEdgeKit_InteractiveListOption<LogScope>
  >;
  readonly methodAllPrompt: string;
  readonly pausePrompt: string;
  readonly runForAllDefaultAnswer: "n" | "y";
  readonly sections: readonly LocalEdgeKit_InteractiveMenuSection<LogMode>[];
};

/** Dependencies injected by root adapters around the reusable menu control flow. */
export type LocalEdgeKit_InteractiveActionMenuDependencies<
  LogMode extends string = string,
  LogScope extends string = string,
> = {
  readonly resolveLogCommand: (options: {
    readonly mode: LogMode;
    readonly scope: LogScope;
  }) => LocalEdgeKit_InteractiveResolvedLogCommand;
  readonly runScript: (
    session: LocalEdgeKit_InteractiveSession,
    request: LocalEdgeKit_InteractiveRunScriptRequest,
  ) => Promise<void>;
  readonly session: LocalEdgeKit_InteractiveSession;
};

/** Prints all configured sections into the supplied interactive session. */
export function LocalEdgeKit_printInteractiveActionMenu<
  LogMode extends string,
>(options: {
  readonly config: LocalEdgeKit_InteractiveActionMenuConfig<LogMode, string>;
  readonly session: LocalEdgeKit_InteractiveSession;
}): void {
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
function findInteractiveMenuItem<LogMode extends string>(options: {
  readonly choice: string;
  readonly sections: readonly LocalEdgeKit_InteractiveMenuSection<LogMode>[];
}): LocalEdgeKit_InteractiveMenuItem<LogMode> | null {
  for (const section of options.sections) {
    const item = section.items.find(
      (candidate) => candidate.key === options.choice,
    );
    if (item !== undefined) {
      return item;
    }
  }
  return null;
}

/** Dispatches one configured menu action and returns loop control. */
export async function LocalEdgeKit_handleInteractiveActionMenuSelection<
  LogMode extends string,
  LogScope extends string,
>(options: {
  readonly choice: string;
  readonly config: LocalEdgeKit_InteractiveActionMenuConfig<LogMode, LogScope>;
  readonly dependencies: LocalEdgeKit_InteractiveActionMenuDependencies<
    LogMode,
    LogScope
  >;
}): Promise<"continue" | "exit"> {
  const { choice, config, dependencies } = options;
  const { session } = dependencies;

  if (config.exitAliases.includes(choice)) {
    session.printSuccess(config.exitMessage);
    return "exit";
  }

  const item = findInteractiveMenuItem({ choice, sections: config.sections });
  if (item === null) {
    session.printError(`Invalid choice: ${choice}`);
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
    const shouldRunForAllMethods = await session.promptYesNo(
      config.methodAllPrompt,
      config.runForAllDefaultAnswer,
    );
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
export async function LocalEdgeKit_runInteractiveActionMenu<
  LogMode extends string,
  LogScope extends string,
>(options: {
  readonly config: LocalEdgeKit_InteractiveActionMenuConfig<LogMode, LogScope>;
  readonly dependencies: LocalEdgeKit_InteractiveActionMenuDependencies<
    LogMode,
    LogScope
  >;
}): Promise<void> {
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
