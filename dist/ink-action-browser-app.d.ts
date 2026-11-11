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
import { type ReactNode } from "react";
import { type LocalEdgeKit_InkActionInput, type LocalEdgeKit_InkCategoryInput, type LocalEdgeKit_InkRunDoneStatus } from "./ink-action-browser-model.js";
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
    readonly onDone: (result: LocalEdgeKit_InkActionBrowserRunDoneSnapshot) => void;
    readonly onLine: (line: LocalEdgeKit_InkActionBrowserOutputLine) => void;
};
/** Cancellable run task returned by project-owned Ink spawn adapters. */
export type LocalEdgeKit_InkActionBrowserRunTask = {
    readonly cancel: () => void;
};
/** Action shape consumed by the reusable Ink action browser. */
export type LocalEdgeKit_InkActionBrowserAction<ActionId extends string> = LocalEdgeKit_InkActionInput<ActionId> & {
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
export type LocalEdgeKit_InkActionBrowserFormPhase = "init" | "logs" | "pool" | "realm" | "reconcile";
/** Form-screen config rendered by the package-owned Ink action browser. */
export type LocalEdgeKit_InkActionBrowserFormScreen<Model> = {
    readonly fields: readonly LocalEdgeKit_InkActionBrowserTextField<Model>[];
    readonly phase: LocalEdgeKit_InkActionBrowserFormPhase;
    readonly quickToggles?: readonly LocalEdgeKit_InkActionBrowserQuickToggle<Model>[];
    readonly title: string;
};
/** Props for the reusable Ink action browser app. */
export type LocalEdgeKit_InkActionBrowserAppProps<ActionId extends string, CategoryId extends string, Model, Request> = {
    readonly actionsForCategory: (categoryId: CategoryId) => readonly LocalEdgeKit_InkActionBrowserAction<ActionId>[];
    readonly appName: string;
    readonly buildSpawnRequest: (actionId: ActionId, model: Model) => Request;
    readonly categories: readonly LocalEdgeKit_InkCategoryInput<CategoryId>[];
    readonly defaultModel: () => Model;
    readonly description: string;
    readonly formScreens: readonly LocalEdgeKit_InkActionBrowserFormScreen<Model>[];
    readonly formatSpawnPreview: (request: Request) => string;
    readonly getActionById: (actionId: ActionId) => LocalEdgeKit_InkActionBrowserAction<ActionId> | null;
    readonly projectRoot: string;
    readonly readMethodAll: (model: Model) => boolean;
    readonly runSpawnRequest: (projectRoot: string, request: Request, handlers: LocalEdgeKit_InkActionBrowserRunHandlers) => LocalEdgeKit_InkActionBrowserRunTask;
    readonly toggleMethodAll: (model: Model) => Model;
};
/** Reusable Ink root flow for config-driven local-edge action browsers. */
export declare function LocalEdgeKitInkActionBrowserApp<ActionId extends string, CategoryId extends string, Model, Request>({ actionsForCategory, appName, buildSpawnRequest, categories, defaultModel, description, formScreens, formatSpawnPreview, projectRoot, readMethodAll, runSpawnRequest, toggleMethodAll, }: LocalEdgeKit_InkActionBrowserAppProps<ActionId, CategoryId, Model, Request>): ReactNode;
