import type { ComponentType } from "react";
import type { LocalEdgeKit_OpenTuiInputProps } from "./opentui-jsx.js";
// OpenTUI supplies a terminal input host with string change events.
const OpenTuiInput = "input" as unknown as ComponentType<LocalEdgeKit_OpenTuiInputProps>;
/**
 * @fileoverview Reusable OpenTUI action-browser app for config-driven local-edge CLIs.
 *
 * Flow: injected categories and actions -> optional configured form screen -> preview -> streamed
 * run output -> result summary. Consumers provide project labels, form fields, spawn adapters, and
 * action catalog lookups while this package owns the terminal route machine and rendering shell.
 *
 * @testing Package: `npm run local-edge-kit:type-check`.
 * @see packages/local-edge-kit/src/opentui-action-browser-model.ts - Option and phase helpers.
 * @documentation reviewed=2026-05-21 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  LocalEdgeKit_buildOpenTuiActionOptions,
  LocalEdgeKit_buildOpenTuiCategoryOptions,
  LocalEdgeKit_buildOpenTuiContinueOptions,
  LocalEdgeKit_buildOpenTuiPreviewOptions,
  LocalEdgeKit_buildOpenTuiResultOptions,
  LocalEdgeKit_resolveOpenTuiPhaseForActionSpecial,
  LocalEdgeKit_shouldRunOpenTuiPreviewAction,
  type LocalEdgeKit_OpenTuiActionBrowserPhase,
  type LocalEdgeKit_OpenTuiActionInput,
  type LocalEdgeKit_OpenTuiActionSpecial,
  type LocalEdgeKit_OpenTuiCategoryInput,
} from "./opentui-action-browser-model.js";

/** Spawn output handlers used by package-owned OpenTUI run screens. */
export type LocalEdgeKit_OpenTuiActionBrowserRunHandlers = {
  readonly onStderrChunk: (chunk: string) => void;
  readonly onStdoutChunk: (chunk: string) => void;
};

/** Cancellable run task returned by project-owned spawn adapters. */
export type LocalEdgeKit_OpenTuiActionBrowserRunTask = {
  readonly cancel: () => void;
  readonly promise: Promise<{ readonly status: number }>;
};

/** Action shape consumed by the reusable OpenTUI action browser. */
export type LocalEdgeKit_OpenTuiActionBrowserAction<ActionId extends string> =
  LocalEdgeKit_OpenTuiActionInput<ActionId> & {
    readonly requiresTypedConfirmation: boolean;
    readonly special: LocalEdgeKit_OpenTuiActionSpecial;
    readonly supportsMethodAll: boolean;
  };

/** Configured text field for a package-rendered OpenTUI form screen. */
export type LocalEdgeKit_OpenTuiActionBrowserTextField<Model> = {
  readonly label: string;
  readonly readValue: (model: Model) => string;
  readonly writeValue: (model: Model, value: string) => Model;
};

/** Phases that may be satisfied by project-provided form field configuration. */
export type LocalEdgeKit_OpenTuiActionBrowserFormPhase = Exclude<
  LocalEdgeKit_OpenTuiActionBrowserPhase,
  "actions" | "category" | "preview" | "result" | "run"
>;

/** Form-screen config rendered by the package-owned OpenTUI action browser. */
export type LocalEdgeKit_OpenTuiActionBrowserFormScreen<Model> = {
  readonly fields: readonly LocalEdgeKit_OpenTuiActionBrowserTextField<Model>[];
  readonly phase: LocalEdgeKit_OpenTuiActionBrowserFormPhase;
  readonly title: string;
};

/** Props for the reusable OpenTUI action browser app. */
export type LocalEdgeKit_OpenTuiActionBrowserAppProps<
  ActionId extends string,
  CategoryId extends string,
  Model,
  Request,
> = {
  readonly actionsForCategory: (
    categoryId: CategoryId,
  ) => readonly LocalEdgeKit_OpenTuiActionBrowserAction<ActionId>[];
  readonly appName: string;
  readonly buildSpawnRequest: (actionId: ActionId, model: Model) => Request;
  readonly categories: readonly LocalEdgeKit_OpenTuiCategoryInput<CategoryId>[];
  readonly defaultModel: () => Model;
  readonly formScreens: readonly LocalEdgeKit_OpenTuiActionBrowserFormScreen<Model>[];
  readonly formatSpawnPreview: (request: Request) => string;
  readonly getActionById: (
    actionId: ActionId,
  ) => LocalEdgeKit_OpenTuiActionBrowserAction<ActionId> | null;
  readonly isActionId: (value: string) => value is ActionId;
  readonly projectRoot: string;
  readonly readMethodAll: (model: Model) => boolean;
  readonly requestQuit: () => void;
  readonly runSpawnRequest: (
    projectRoot: string,
    request: Request,
    handlers: LocalEdgeKit_OpenTuiActionBrowserRunHandlers,
  ) => LocalEdgeKit_OpenTuiActionBrowserRunTask;
  readonly subtitleLines: readonly string[];
  readonly toggleMethodAll: (model: Model) => Model;
};

/** Finds the configured form screen for the active special phase. */
function findOpenTuiActionBrowserFormScreen<Model>(options: {
  readonly formScreens: readonly LocalEdgeKit_OpenTuiActionBrowserFormScreen<Model>[];
  readonly phase: LocalEdgeKit_OpenTuiActionBrowserPhase;
}): LocalEdgeKit_OpenTuiActionBrowserFormScreen<Model> | null {
  return (
    options.formScreens.find((screen) => screen.phase === options.phase) ?? null
  );
}

/** Renders one configured package-owned form screen. */
function LocalEdgeKitOpenTuiActionBrowserForm<Model>({
  model,
  screen,
  setModel,
  setPhase,
  requestQuit,
}: {
  readonly model: Model;
  readonly requestQuit: () => void;
  readonly screen: LocalEdgeKit_OpenTuiActionBrowserFormScreen<Model>;
  readonly setModel: React.Dispatch<React.SetStateAction<Model>>;
  readonly setPhase: React.Dispatch<
    React.SetStateAction<LocalEdgeKit_OpenTuiActionBrowserPhase>
  >;
}): ReactNode {
  return (
    <>
      <text>{screen.title}</text>
      <scrollbox style={{ flexGrow: 1 }}>
        <box style={{ flexDirection: "column", gap: 1 }}>
          {screen.fields.map((field) => (
            <box key={field.label} style={{ flexDirection: "column" }}>
              <text>{field.label}</text>
              <OpenTuiInput
                value={field.readValue(model)}
                onChange={(value) => {
                  setModel((currentModel) =>
                    field.writeValue(currentModel, value),
                  );
                }}
              />
            </box>
          ))}
        </box>
      </scrollbox>
      <tab-select
        options={LocalEdgeKit_buildOpenTuiContinueOptions({
          continueDescription: "Continue",
          continueName: "Preview",
          continueValue: "next",
        })}
        showDescription={true}
        onSelect={(_index, option) => {
          const value = option?.value;
          if (value === "back") {
            setPhase("actions");
            return;
          }
          if (value === "quit") {
            requestQuit();
            return;
          }
          if (value === "next") {
            setPhase("preview");
          }
        }}
      />
    </>
  );
}

/** Reusable OpenTUI root flow for config-driven local-edge action browsers. */
export function LocalEdgeKitOpenTuiActionBrowserApp<
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
  formScreens,
  formatSpawnPreview,
  getActionById,
  isActionId,
  projectRoot,
  readMethodAll,
  requestQuit,
  runSpawnRequest,
  subtitleLines,
  toggleMethodAll,
}: LocalEdgeKit_OpenTuiActionBrowserAppProps<
  ActionId,
  CategoryId,
  Model,
  Request
>): ReactNode {
  const cancelRef = useRef<null | (() => void)>(null);
  const [phase, setPhase] =
    useState<LocalEdgeKit_OpenTuiActionBrowserPhase>("category");
  const [categoryIndex, setCategoryIndex] = useState(0);
  const [actionId, setActionId] = useState<ActionId | null>(null);
  const [model, setModel] = useState<Model>(() => defaultModel());
  const [confirmYes, setConfirmYes] = useState("");
  const [runStdout, setRunStdout] = useState("");
  const [runStderr, setRunStderr] = useState("");
  const [runStatus, setRunStatus] = useState<number | null>(null);

  const category = categories[categoryIndex];
  const actionMeta = actionId ? getActionById(actionId) : null;
  const formScreen = findOpenTuiActionBrowserFormScreen({
    formScreens,
    phase,
  });

  const spawnRequest = useMemo(() => {
    if (!actionId) {
      return null;
    }
    try {
      return buildSpawnRequest(actionId, model);
    } catch {
      return null;
    }
  }, [actionId, buildSpawnRequest, model]);

  const previewText = spawnRequest
    ? formatSpawnPreview(spawnRequest)
    : "(invalid options)";

  useEffect(() => {
    return () => {
      cancelRef.current?.();
    };
  }, []);

  function resetRun(): void {
    setRunStdout("");
    setRunStderr("");
    setRunStatus(null);
  }

  function goCategory(): void {
    cancelRef.current?.();
    cancelRef.current = null;
    setPhase("category");
    setActionId(null);
    setConfirmYes("");
    resetRun();
  }

  async function executeRun(): Promise<void> {
    if (!spawnRequest) {
      return;
    }
    resetRun();
    setPhase("run");
    const task = runSpawnRequest(projectRoot, spawnRequest, {
      onStdoutChunk: (chunk) => {
        setRunStdout((previous) => previous + chunk);
      },
      onStderrChunk: (chunk) => {
        setRunStderr((previous) => previous + chunk);
      },
    });
    cancelRef.current = task.cancel;
    try {
      const result = await task.promise;
      setRunStatus(result.status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRunStderr((previous) => previous + message);
      setRunStatus(1);
    } finally {
      cancelRef.current = null;
      setPhase("result");
    }
  }

  const categoryOptions = LocalEdgeKit_buildOpenTuiCategoryOptions({
    categories,
  });

  const actionOptions = category
    ? LocalEdgeKit_buildOpenTuiActionOptions({
        actions: actionsForCategory(category.id),
      })
    : [];

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, gap: 1, padding: 1 }}>
      <text>
        {appName} — root: {projectRoot}
      </text>
      {subtitleLines.map((line) => (
        <text key={line}>{line}</text>
      ))}

      {phase === "category" ? (
        <>
          <text>Category</text>
          <tab-select
            options={categoryOptions}
            showDescription={true}
            onSelect={(_index, option) => {
              const value = option?.value;
              if (value === "quit") {
                requestQuit();
                return;
              }
              if (value && /^\d+$/.test(value)) {
                setCategoryIndex(Number.parseInt(value, 10));
                setPhase("actions");
                setActionId(null);
                setModel(defaultModel());
              }
            }}
          />
        </>
      ) : null}

      {phase === "actions" && category ? (
        <>
          <text>{category.label}</text>
          <tab-select
            options={actionOptions}
            showDescription={true}
            onSelect={(_index, option) => {
              const value = option?.value;
              if (value === "back") {
                goCategory();
                return;
              }
              if (value === "quit") {
                requestQuit();
                return;
              }
              if (value && isActionId(value)) {
                setActionId(value);
                setModel(defaultModel());
                setConfirmYes("");
                const meta = getActionById(value);
                setPhase(
                  LocalEdgeKit_resolveOpenTuiPhaseForActionSpecial({
                    special: meta?.special,
                  }),
                );
              }
            }}
          />
        </>
      ) : null}

      {formScreen ? (
        <LocalEdgeKitOpenTuiActionBrowserForm
          model={model}
          requestQuit={requestQuit}
          screen={formScreen}
          setModel={setModel}
          setPhase={setPhase}
        />
      ) : null}

      {phase === "preview" && actionMeta ? (
        <>
          <text>Preview — {actionMeta.label}</text>
          <text>{actionMeta.description}</text>
          <text>{previewText}</text>
          {actionMeta.supportsMethodAll ? (
            <tab-select
              options={[
                {
                  name: readMethodAll(model)
                    ? "method all: ON"
                    : "method all: OFF",
                  description: "Toggle --method all",
                  value: "toggleMethod",
                },
              ]}
              showDescription={true}
              onSelect={() => {
                setModel((currentModel) => toggleMethodAll(currentModel));
              }}
            />
          ) : null}
          {actionMeta.requiresTypedConfirmation ? (
            <>
              <text color="red">Type YES to confirm destructive action</text>
              <OpenTuiInput
                value={confirmYes}
                onChange={(value) => setConfirmYes(value)}
              />
            </>
          ) : null}
          <tab-select
            options={LocalEdgeKit_buildOpenTuiPreviewOptions()}
            showDescription={true}
            onSelect={(_index, option) => {
              const value = option?.value;
              if (value === "quit") {
                requestQuit();
                return;
              }
              if (value === "back") {
                setPhase("actions");
                return;
              }
              if (value === "run") {
                if (
                  !LocalEdgeKit_shouldRunOpenTuiPreviewAction({
                    confirmationInput: confirmYes,
                    requiresTypedConfirmation:
                      actionMeta.requiresTypedConfirmation,
                  })
                ) {
                  return;
                }
                void executeRun();
              }
            }}
          />
        </>
      ) : null}

      {phase === "run" ? (
        <>
          <text>Running…</text>
          <scrollbox style={{ flexGrow: 1 }}>
            <box style={{ flexDirection: "column" }}>
              <text>{runStdout}</text>
              <text>{runStderr}</text>
            </box>
          </scrollbox>
        </>
      ) : null}

      {phase === "result" ? (
        <>
          <text>Exit {String(runStatus)}</text>
          <scrollbox style={{ flexGrow: 1 }}>
            <box style={{ flexDirection: "column" }}>
              <text>{runStdout}</text>
              <text>{runStderr}</text>
            </box>
          </scrollbox>
          <tab-select
            options={LocalEdgeKit_buildOpenTuiResultOptions()}
            showDescription={true}
            onSelect={() => {
              goCategory();
            }}
          />
        </>
      ) : null}
    </box>
  );
}
