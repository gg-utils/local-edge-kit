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
import { type ReactNode } from "react";
import { type LocalEdgeKit_OpenTuiActionBrowserPhase, type LocalEdgeKit_OpenTuiActionInput, type LocalEdgeKit_OpenTuiActionSpecial, type LocalEdgeKit_OpenTuiCategoryInput } from "./opentui-action-browser-model.js";
/** Spawn output handlers used by package-owned OpenTUI run screens. */
export type LocalEdgeKit_OpenTuiActionBrowserRunHandlers = {
    readonly onStderrChunk: (chunk: string) => void;
    readonly onStdoutChunk: (chunk: string) => void;
};
/** Cancellable run task returned by project-owned spawn adapters. */
export type LocalEdgeKit_OpenTuiActionBrowserRunTask = {
    readonly cancel: () => void;
    readonly promise: Promise<{
        readonly status: number;
    }>;
};
/** Action shape consumed by the reusable OpenTUI action browser. */
export type LocalEdgeKit_OpenTuiActionBrowserAction<ActionId extends string> = LocalEdgeKit_OpenTuiActionInput<ActionId> & {
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
export type LocalEdgeKit_OpenTuiActionBrowserFormPhase = Exclude<LocalEdgeKit_OpenTuiActionBrowserPhase, "actions" | "category" | "preview" | "result" | "run">;
/** Form-screen config rendered by the package-owned OpenTUI action browser. */
export type LocalEdgeKit_OpenTuiActionBrowserFormScreen<Model> = {
    readonly fields: readonly LocalEdgeKit_OpenTuiActionBrowserTextField<Model>[];
    readonly phase: LocalEdgeKit_OpenTuiActionBrowserFormPhase;
    readonly title: string;
};
/** Props for the reusable OpenTUI action browser app. */
export type LocalEdgeKit_OpenTuiActionBrowserAppProps<ActionId extends string, CategoryId extends string, Model, Request> = {
    readonly actionsForCategory: (categoryId: CategoryId) => readonly LocalEdgeKit_OpenTuiActionBrowserAction<ActionId>[];
    readonly appName: string;
    readonly buildSpawnRequest: (actionId: ActionId, model: Model) => Request;
    readonly categories: readonly LocalEdgeKit_OpenTuiCategoryInput<CategoryId>[];
    readonly defaultModel: () => Model;
    readonly formScreens: readonly LocalEdgeKit_OpenTuiActionBrowserFormScreen<Model>[];
    readonly formatSpawnPreview: (request: Request) => string;
    readonly getActionById: (actionId: ActionId) => LocalEdgeKit_OpenTuiActionBrowserAction<ActionId> | null;
    readonly isActionId: (value: string) => value is ActionId;
    readonly projectRoot: string;
    readonly readMethodAll: (model: Model) => boolean;
    readonly requestQuit: () => void;
    readonly runSpawnRequest: (projectRoot: string, request: Request, handlers: LocalEdgeKit_OpenTuiActionBrowserRunHandlers) => LocalEdgeKit_OpenTuiActionBrowserRunTask;
    readonly subtitleLines: readonly string[];
    readonly toggleMethodAll: (model: Model) => Model;
};
/** Reusable OpenTUI root flow for config-driven local-edge action browsers. */
export declare function LocalEdgeKitOpenTuiActionBrowserApp<ActionId extends string, CategoryId extends string, Model, Request>({ actionsForCategory, appName, buildSpawnRequest, categories, defaultModel, formScreens, formatSpawnPreview, getActionById, isActionId, projectRoot, readMethodAll, requestQuit, runSpawnRequest, subtitleLines, toggleMethodAll, }: LocalEdgeKit_OpenTuiActionBrowserAppProps<ActionId, CategoryId, Model, Request>): ReactNode;
