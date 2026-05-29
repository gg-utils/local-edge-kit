/**
 * @fileoverview Reusable Ink action-browser app for config-driven local-edge CLIs.
 *
 * Flow: injected categories/actions -> optional configured form screen -> preview -> streamed run
 * output -> result summary. Consumers provide project labels, form fields, spawn adapters, and action
 * catalog lookups while this package owns the Ink route machine and rendering shell.
 *
 * @testing Package: `npm run local-edge-kit:type-check`.
 * @see packages/local-edge-kit/src/ink-action-browser-model.ts - Row, tone, and status helpers.
 * @documentation reviewed=2026-05-21 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Box, Text, useApp, useInput, type Key } from "ink";

import {
  LocalEdgeKit_buildInkActionRows,
  LocalEdgeKit_buildInkCategoryRows,
  LocalEdgeKit_formatInkActionBrowserHeaderSummary,
  LocalEdgeKit_formatInkRunDoneStatusHeadline,
  LocalEdgeKit_getInkRiskTone,
  LocalEdgeKit_getInkSelectedItem,
  LocalEdgeKit_rotateInkSelectionIndex,
  type LocalEdgeKit_InkActionInput,
  type LocalEdgeKit_InkCategoryInput,
  type LocalEdgeKit_InkRunDoneStatus,
} from "./ink-action-browser-model.js";
import type { LocalEdgeKit_OpenTuiActionSpecial } from "./opentui-action-browser-model.js";

/** Output line rendered in the reusable Ink run/result screens. */
export type LocalEdgeKit_InkActionBrowserOutputLine = {
  readonly source: string;
  readonly text: string;
};

/** Final run snapshot shown by the reusable Ink result screen. */
export type LocalEdgeKit_InkActionBrowserRunDoneSnapshot = {
  readonly exitCode: number | null;
  readonly status: LocalEdgeKit_InkRunDoneStatus;
};

/** Spawn output and completion handlers passed to project-owned process adapters. */
export type LocalEdgeKit_InkActionBrowserRunHandlers = {
  readonly onDone: (
    result: LocalEdgeKit_InkActionBrowserRunDoneSnapshot,
  ) => void;
  readonly onLine: (line: LocalEdgeKit_InkActionBrowserOutputLine) => void;
};

/** Cancellable run task returned by project-owned Ink spawn adapters. */
export type LocalEdgeKit_InkActionBrowserRunTask = {
  readonly cancel: () => void;
};

/** Action shape consumed by the reusable Ink action browser. */
export type LocalEdgeKit_InkActionBrowserAction<ActionId extends string> =
  LocalEdgeKit_InkActionInput<ActionId> & {
    readonly description: string;
    readonly requiresTypedConfirmation: boolean;
    readonly special: LocalEdgeKit_OpenTuiActionSpecial;
    readonly supportsMethodAll: boolean;
  };

/** A configured text input field for a package-rendered Ink form screen. */
export type LocalEdgeKit_InkActionBrowserTextField<Model> = {
  readonly acceptInput?: (input: string) => boolean;
  readonly id: string;
  readonly label: string;
  readonly readValue: (model: Model) => string;
  readonly writeValue: (model: Model, value: string) => Model;
};

/** A configured quick-toggle shown above text fields on a package-rendered Ink form screen. */
export type LocalEdgeKit_InkActionBrowserQuickToggle<Model> = {
  readonly keyLabel: string;
  readonly label: string;
  readonly readLabel: (model: Model) => string;
  readonly toggle: (model: Model) => Model;
};

/** Form phases that may be satisfied by project-provided field configuration. */
export type LocalEdgeKit_InkActionBrowserFormPhase =
  | "init"
  | "logs"
  | "pool"
  | "realm"
  | "reconcile";

/** Form-screen config rendered by the package-owned Ink action browser. */
export type LocalEdgeKit_InkActionBrowserFormScreen<Model> = {
  readonly fields: readonly LocalEdgeKit_InkActionBrowserTextField<Model>[];
  readonly phase: LocalEdgeKit_InkActionBrowserFormPhase;
  readonly quickToggles?: readonly LocalEdgeKit_InkActionBrowserQuickToggle<Model>[];
  readonly title: string;
};

/** Internal route screen union for the reusable Ink action browser. */
type LocalEdgeKit_InkActionBrowserFlow =
  | "actions"
  | "home"
  | "init"
  | "logs"
  | "pool"
  | "realm"
  | "reconcile"
  | "result"
  | "review"
  | "run";

/** Props for the reusable Ink action browser app. */
export type LocalEdgeKit_InkActionBrowserAppProps<
  ActionId extends string,
  CategoryId extends string,
  Model,
  Request,
> = {
  readonly actionsForCategory: (
    categoryId: CategoryId,
  ) => readonly LocalEdgeKit_InkActionBrowserAction<ActionId>[];
  readonly appName: string;
  readonly buildSpawnRequest: (actionId: ActionId, model: Model) => Request;
  readonly categories: readonly LocalEdgeKit_InkCategoryInput<CategoryId>[];
  readonly defaultModel: () => Model;
  readonly description: string;
  readonly formScreens: readonly LocalEdgeKit_InkActionBrowserFormScreen<Model>[];
  readonly formatSpawnPreview: (request: Request) => string;
  readonly getActionById: (
    actionId: ActionId,
  ) => LocalEdgeKit_InkActionBrowserAction<ActionId> | null;
  readonly projectRoot: string;
  readonly readMethodAll: (model: Model) => boolean;
  readonly runSpawnRequest: (
    projectRoot: string,
    request: Request,
    handlers: LocalEdgeKit_InkActionBrowserRunHandlers,
  ) => LocalEdgeKit_InkActionBrowserRunTask;
  readonly toggleMethodAll: (model: Model) => Model;
};

/** Finds the configured form screen for the active special phase. */
function findInkActionBrowserFormScreen<Model>(options: {
  readonly formScreens: readonly LocalEdgeKit_InkActionBrowserFormScreen<Model>[];
  readonly phase: LocalEdgeKit_InkActionBrowserFlow;
}): LocalEdgeKit_InkActionBrowserFormScreen<Model> | null {
  return (
    options.formScreens.find((screen) => screen.phase === options.phase) ?? null
  );
}

/** Resolves the Ink flow that should follow action selection. */
function resolveInkActionBrowserFlowForSpecial(options: {
  readonly special: LocalEdgeKit_OpenTuiActionSpecial | null | undefined;
}): LocalEdgeKit_InkActionBrowserFlow {
  if (options.special === "init") {
    return "init";
  }
  if (options.special === "realm-register") {
    return "realm";
  }
  if (options.special === "reconcile") {
    return "reconcile";
  }
  if (options.special === "realm-pool-next") {
    return "pool";
  }
  if (options.special === "logs") {
    return "logs";
  }
  return "review";
}

/** Renders a simple command preview block without importing project shared UI helpers. */
function InkActionBrowserCommandPreview({
  commandLine,
}: {
  readonly commandLine: string;
}): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>Command</Text>
      <Text wrap="wrap">{commandLine}</Text>
    </Box>
  );
}

/** Renders recent captured output lines with stderr highlighted. */
function InkActionBrowserCapturedOutput({
  lines,
  maxLines,
  title,
}: {
  readonly lines: readonly LocalEdgeKit_InkActionBrowserOutputLine[];
  readonly maxLines: number;
  readonly title: string;
}): ReactNode {
  const recentLines =
    lines.length <= maxLines ? lines : lines.slice(lines.length - maxLines);

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {recentLines.map((line, index) => (
        <Text
          key={`${line.source}-${String(index)}`}
          color={line.source === "stderr" ? "red" : "white"}
        >
          {line.text}
        </Text>
      ))}
    </Box>
  );
}

/** Renders keyboard hints. */
function InkActionBrowserLegend({
  lines,
}: {
  readonly lines: readonly string[];
}): ReactNode {
  return (
    <Box marginTop={1} flexDirection="column" gap={0}>
      {lines.map((line, index) => (
        <Text key={String(index)} color="gray">
          {line}
        </Text>
      ))}
    </Box>
  );
}

/** Renders the reusable configured form body. */
function InkActionBrowserConfiguredForm<Model>({
  activeFieldBuffer,
  activeFieldIndex,
  model,
  screen,
}: {
  readonly activeFieldBuffer: string;
  readonly activeFieldIndex: number;
  readonly model: Model;
  readonly screen: LocalEdgeKit_InkActionBrowserFormScreen<Model>;
}): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>{screen.title}</Text>
      {screen.quickToggles?.map((toggle) => (
        <Text key={toggle.keyLabel}>
          {toggle.keyLabel}: {toggle.label} ({toggle.readLabel(model)})
        </Text>
      )) ?? null}
      {screen.fields.map((field, index) => (
        <Text
          key={field.id}
          color={index === activeFieldIndex ? "cyan" : undefined}
        >
          {index === activeFieldIndex ? "> " : "  "}
          {field.label}:{" "}
          {index === activeFieldIndex
            ? activeFieldBuffer
            : field.readValue(model)}
        </Text>
      ))}
      <InkActionBrowserLegend
        lines={["Type to edit · Enter/Tab next · Esc back"]}
      />
    </Box>
  );
}

/** Commits the active configured form field and advances or returns to review. */
function advanceInkActionBrowserFormField<Model>(options: {
  readonly activeFieldBuffer: string;
  readonly activeFieldIndex: number;
  readonly screen: LocalEdgeKit_InkActionBrowserFormScreen<Model>;
  readonly setActiveFieldBuffer: Dispatch<SetStateAction<string>>;
  readonly setActiveFieldIndex: Dispatch<SetStateAction<number>>;
  readonly setFlow: Dispatch<SetStateAction<LocalEdgeKit_InkActionBrowserFlow>>;
  readonly setModel: Dispatch<SetStateAction<Model>>;
}): void {
  const field = options.screen.fields[options.activeFieldIndex];
  if (field === undefined) {
    options.setFlow("review");
    return;
  }

  let nextModelValue: Model | null = null;
  options.setModel((currentModel) => {
    const nextModel = field.writeValue(currentModel, options.activeFieldBuffer);
    nextModelValue = nextModel;
    return nextModel;
  });

  if (options.activeFieldIndex >= options.screen.fields.length - 1) {
    options.setFlow("review");
    return;
  }

  const nextIndex = options.activeFieldIndex + 1;
  options.setActiveFieldIndex(nextIndex);
  const nextField = options.screen.fields[nextIndex];
  if (nextField !== undefined && nextModelValue !== null) {
    options.setActiveFieldBuffer(nextField.readValue(nextModelValue));
    return;
  }
  options.setActiveFieldBuffer("");
}

/** Handles keyboard input for configured form screens. */
function handleInkActionBrowserFormInput<Model>(options: {
  readonly activeFieldBuffer: string;
  readonly activeFieldIndex: number;
  readonly input: string;
  readonly key: Key;
  readonly screen: LocalEdgeKit_InkActionBrowserFormScreen<Model>;
  readonly setActiveFieldBuffer: Dispatch<SetStateAction<string>>;
  readonly setActiveFieldIndex: Dispatch<SetStateAction<number>>;
  readonly setFlow: Dispatch<SetStateAction<LocalEdgeKit_InkActionBrowserFlow>>;
  readonly setModel: Dispatch<SetStateAction<Model>>;
}): void {
  if (options.key.escape) {
    options.setFlow("actions");
    return;
  }

  const quickToggle = options.screen.quickToggles?.find(
    (toggle) => toggle.keyLabel.toLowerCase() === options.input.toLowerCase(),
  );
  if (quickToggle !== undefined) {
    options.setModel((currentModel) => quickToggle.toggle(currentModel));
    return;
  }

  if (options.key.return || options.input === "\t") {
    advanceInkActionBrowserFormField(options);
    return;
  }

  if (options.key.backspace || options.key.delete) {
    options.setActiveFieldBuffer((buffer) => buffer.slice(0, -1));
    return;
  }

  const field = options.screen.fields[options.activeFieldIndex];
  if (
    field !== undefined &&
    options.input.length === 1 &&
    (field.acceptInput === undefined || field.acceptInput(options.input))
  ) {
    options.setActiveFieldBuffer((buffer) => buffer + options.input);
  }
}

/** Reusable Ink root flow for config-driven local-edge action browsers. */
export function LocalEdgeKitInkActionBrowserApp<
  ActionId extends string,
  CategoryId extends string,
  Model,
  Request,
>({
  actionsForCategory,
  appName,
  buildSpawnRequest,
  categories,
  defaultModel,
  description,
  formScreens,
  formatSpawnPreview,
  getActionById,
  projectRoot,
  readMethodAll,
  runSpawnRequest,
  toggleMethodAll,
}: LocalEdgeKit_InkActionBrowserAppProps<
  ActionId,
  CategoryId,
  Model,
  Request
>): ReactNode {
  const { exit } = useApp();
  const [flow, setFlow] = useState<LocalEdgeKit_InkActionBrowserFlow>("home");
  const [categoryIndex, setCategoryIndex] = useState(0);
  const [actionIndex, setActionIndex] = useState(0);
  const [model, setModel] = useState<Model>(() => defaultModel());
  const [confirmBuffer, setConfirmBuffer] = useState("");
  const [activeFieldIndex, setActiveFieldIndex] = useState(0);
  const [activeFieldBuffer, setActiveFieldBuffer] = useState("");
  const [lines, setLines] = useState<LocalEdgeKit_InkActionBrowserOutputLine[]>(
    [],
  );
  const [runDone, setRunDone] =
    useState<LocalEdgeKit_InkActionBrowserRunDoneSnapshot | null>(null);
  const [cancelRun, setCancelRun] = useState<null | (() => void)>(null);

  const category =
    LocalEdgeKit_getInkSelectedItem({
      items: categories,
      selectedIndex: categoryIndex,
    }) ?? undefined;
  const actions = useMemo(() => {
    if (!category) {
      return [];
    }
    return actionsForCategory(category.id);
  }, [actionsForCategory, category]);
  const selectedAction = LocalEdgeKit_getInkSelectedItem({
    items: actions,
    selectedIndex: actionIndex,
  });
  const activeFormScreen = findInkActionBrowserFormScreen({
    formScreens,
    phase: flow,
  });

  const previewRequest = useMemo(() => {
    if (!selectedAction) {
      return null;
    }
    try {
      return buildSpawnRequest(selectedAction.id, model);
    } catch {
      return null;
    }
  }, [buildSpawnRequest, model, selectedAction]);

  const previewLine = previewRequest
    ? formatSpawnPreview(previewRequest)
    : "(fix form options — cannot build command)";

  const goHome = useCallback(() => {
    cancelRun?.();
    setCancelRun(null);
    setFlow("home");
    setRunDone(null);
    setLines([]);
    setConfirmBuffer("");
  }, [cancelRun]);

  const startRun = useCallback(
    (request: Request) => {
      setLines([]);
      setRunDone(null);
      setFlow("run");
      const task = runSpawnRequest(projectRoot, request, {
        onLine: (line) => {
          setLines((previous) => [...previous, line]);
        },
        onDone: (result) => {
          setRunDone(result);
          setFlow("result");
          setCancelRun(null);
        },
      });
      setCancelRun(() => task.cancel);
    },
    [projectRoot, runSpawnRequest],
  );

  useEffect(() => {
    return () => {
      cancelRun?.();
    };
  }, [cancelRun]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      return;
    }

    if (flow === "run" && key.escape) {
      cancelRun?.();
      setFlow("review");
      setCancelRun(null);
      return;
    }

    if (flow === "result") {
      if (input === "q" || key.return) {
        goHome();
      }
      return;
    }

    if (flow === "home") {
      if (key.upArrow) {
        setCategoryIndex((index) =>
          LocalEdgeKit_rotateInkSelectionIndex({
            currentIndex: index,
            direction: "up",
            itemCount: categories.length,
          }),
        );
        return;
      }
      if (key.downArrow) {
        setCategoryIndex((index) =>
          LocalEdgeKit_rotateInkSelectionIndex({
            currentIndex: index,
            direction: "down",
            itemCount: categories.length,
          }),
        );
        return;
      }
      if (key.return) {
        setActionIndex(0);
        setFlow("actions");
        return;
      }
      if (input === "q") {
        exit();
      }
      return;
    }

    if (flow === "actions") {
      if (key.escape || input === "b") {
        setFlow("home");
        return;
      }
      if (key.upArrow) {
        setActionIndex((index) =>
          LocalEdgeKit_rotateInkSelectionIndex({
            currentIndex: index,
            direction: "up",
            itemCount: actions.length,
          }),
        );
        return;
      }
      if (key.downArrow) {
        setActionIndex((index) =>
          LocalEdgeKit_rotateInkSelectionIndex({
            currentIndex: index,
            direction: "down",
            itemCount: actions.length,
          }),
        );
        return;
      }
      if (key.return && selectedAction) {
        const nextModel = defaultModel();
        const nextFlow = resolveInkActionBrowserFlowForSpecial({
          special: selectedAction.special,
        });
        const nextFormScreen = findInkActionBrowserFormScreen({
          formScreens,
          phase: nextFlow,
        });
        setModel(nextModel);
        setConfirmBuffer("");
        setActiveFieldIndex(0);
        setActiveFieldBuffer(
          nextFormScreen?.fields[0]?.readValue(nextModel) ?? "",
        );
        setFlow(nextFlow);
        return;
      }
      if (input === "q") {
        exit();
      }
      return;
    }

    if (activeFormScreen) {
      handleInkActionBrowserFormInput({
        activeFieldBuffer,
        activeFieldIndex,
        input,
        key,
        screen: activeFormScreen,
        setActiveFieldBuffer,
        setActiveFieldIndex,
        setFlow,
        setModel,
      });
      return;
    }

    if (flow === "review") {
      if (key.escape || input === "b") {
        setFlow("actions");
        return;
      }
      if (selectedAction?.supportsMethodAll && input === "m") {
        setModel((currentModel) => toggleMethodAll(currentModel));
        return;
      }
      if (key.return) {
        const request = previewRequest;
        if (!request) {
          return;
        }
        if (
          selectedAction?.requiresTypedConfirmation &&
          confirmBuffer.trim().toUpperCase() !== "YES"
        ) {
          return;
        }
        startRun(request);
        return;
      }
      if (selectedAction?.requiresTypedConfirmation) {
        if (key.backspace || key.delete) {
          setConfirmBuffer((buffer) => buffer.slice(0, -1));
        } else if (input.length === 1) {
          setConfirmBuffer((buffer) => buffer + input.toUpperCase());
        }
      }
      if (input === "q") {
        exit();
      }
    }
  });

  const categoryRows = LocalEdgeKit_buildInkCategoryRows({
    categories,
    selectedIndex: categoryIndex,
  });
  const actionRows = LocalEdgeKit_buildInkActionRows({
    actions,
    selectedIndex: actionIndex,
  });

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="green">
          {appName}
        </Text>
        <Text color="gray">{description}</Text>
        <Box>
          <Text>
            {LocalEdgeKit_formatInkActionBrowserHeaderSummary({ projectRoot })}
          </Text>
        </Box>
      </Box>

      {flow === "home" ? (
        <Box flexDirection="column">
          <Text bold>Categories</Text>
          {categoryRows.map((row) => (
            <Text key={row.id} color={row.selected ? "cyan" : undefined}>
              {row.marker}
              {row.label}
            </Text>
          ))}
          <InkActionBrowserLegend
            lines={["↑/↓: Browse  Enter: Open  Q: Quit"]}
          />
        </Box>
      ) : null}

      {flow === "actions" && category ? (
        <Box flexDirection="column">
          <Text bold>{category.label}</Text>
          {actionRows.map((row) => (
            <Text key={row.id} color={row.selected ? "cyan" : undefined}>
              {row.marker}
              {row.label} <Text color="gray">{row.riskLabel}</Text>
            </Text>
          ))}
          <InkActionBrowserLegend
            lines={["↑/↓: Browse  Enter: Choose  Esc: Back  Q: Quit"]}
          />
        </Box>
      ) : null}

      {activeFormScreen ? (
        <InkActionBrowserConfiguredForm
          activeFieldBuffer={activeFieldBuffer}
          activeFieldIndex={activeFieldIndex}
          model={model}
          screen={activeFormScreen}
        />
      ) : null}

      {flow === "review" && selectedAction ? (
        <Box flexDirection="column">
          <Text bold color={LocalEdgeKit_getInkRiskTone(selectedAction.risk)}>
            Review: {selectedAction.label}
          </Text>
          <Text color="gray">{selectedAction.description}</Text>
          {selectedAction.supportsMethodAll ? (
            <Text>All methods [m]: {String(readMethodAll(model))}</Text>
          ) : null}
          {selectedAction.requiresTypedConfirmation ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color="red">Type YES to confirm</Text>
              <Text>Confirmation: {confirmBuffer}</Text>
            </Box>
          ) : null}
          <Box marginTop={1}>
            <InkActionBrowserCommandPreview commandLine={previewLine} />
          </Box>
          <InkActionBrowserLegend
            lines={["Enter: Run  Esc: Back  M: Toggle All  Q: Quit"]}
          />
        </Box>
      ) : null}

      {flow === "run" ? (
        <Box flexDirection="column">
          <Text bold>Running... (Esc to cancel)</Text>
          <InkActionBrowserCapturedOutput
            title="Output"
            lines={lines}
            maxLines={16}
          />
        </Box>
      ) : null}

      {flow === "result" && runDone ? (
        <Box flexDirection="column">
          <Text bold>
            {LocalEdgeKit_formatInkRunDoneStatusHeadline(runDone.status)} (exit{" "}
            {String(runDone.exitCode)})
          </Text>
          <InkActionBrowserCapturedOutput
            title="Output"
            lines={lines}
            maxLines={20}
          />
          <Text>Enter or Q: Menu</Text>
        </Box>
      ) : null}
    </Box>
  );
}
