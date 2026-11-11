/**
 * @fileoverview Product-neutral view-model helpers for local-edge Ink action browsers.
 *
 * Script adapters keep React/Ink rendering, project action catalogs, and subprocess side effects.
 * This module owns reusable row selection, risk tone, run-status headline, and header summary
 * formatting used by action-browser style local-edge terminal UIs.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/ink-action-browser-model.unit.test.ts
 *
 * @see packages/local-edge-kit/src/ink-action-browser-app.tsx - Ink React action-browser UI that wires category and action row models, risk tone, and run-status headlines produced by helpers in this module.
 * @see packages/local-edge-kit/src/opentui-action-browser-model.ts - OpenTUI action-browser adapter that reuses the shared action-risk taxonomy types exported here.
 * @see packages/local-edge-kit/src/index.ts - Package barrel that re-exports this module alongside other local-edge-kit Ink and CLI surfaces.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
/** Risk levels exposed by local-edge action catalogs. */
export type LocalEdgeKit_InkActionRisk = "destructive" | "mutating" | "read-only";
/** Ink status tone names used by the action browser review header. */
export type LocalEdgeKit_InkRiskTone = "error" | "info" | "warning";
/** Terminal run states shown by action browser result screens. */
export type LocalEdgeKit_InkRunDoneStatus = "cancelled" | "failed" | "succeeded";
/** Direction used by cyclic selection helpers. */
export type LocalEdgeKit_InkSelectionDirection = "down" | "up";
/** Minimal category shape needed to build action browser category rows. */
export type LocalEdgeKit_InkCategoryInput<CategoryId extends string> = {
    readonly id: CategoryId;
    readonly label: string;
};
/** Minimal action shape needed to build action browser action rows. */
export type LocalEdgeKit_InkActionInput<ActionId extends string> = {
    readonly id: ActionId;
    readonly label: string;
    readonly risk: LocalEdgeKit_InkActionRisk;
};
/** Row model for an Ink category picker. */
export type LocalEdgeKit_InkCategoryRow<CategoryId extends string> = {
    readonly id: CategoryId;
    readonly label: string;
    readonly marker: "> " | "  ";
    readonly selected: boolean;
};
/** Row model for an Ink action picker. */
export type LocalEdgeKit_InkActionRow<ActionId extends string> = {
    readonly id: ActionId;
    readonly label: string;
    readonly marker: "> " | "  ";
    readonly risk: LocalEdgeKit_InkActionRisk;
    readonly riskLabel: string;
    readonly selected: boolean;
};
/** Formats the top summary line for a project-scoped action browser. */
export declare function LocalEdgeKit_formatInkActionBrowserHeaderSummary(options: {
    readonly projectRoot: string;
}): string;
/** Returns the selected item, or `null` when the list/index state is incomplete. */
export declare function LocalEdgeKit_getInkSelectedItem<Item>(options: {
    readonly items: readonly Item[];
    readonly selectedIndex: number;
}): Item | null;
/** Rotates a list selection through available items without leaking UI framework state. */
export declare function LocalEdgeKit_rotateInkSelectionIndex(options: {
    readonly currentIndex: number;
    readonly direction: LocalEdgeKit_InkSelectionDirection;
    readonly itemCount: number;
}): number;
/** Chooses a review-header tone for an action risk level. */
export declare function LocalEdgeKit_getInkRiskTone(risk: LocalEdgeKit_InkActionRisk): LocalEdgeKit_InkRiskTone;
/** Maps a completed run state to the concise result-screen headline. */
export declare function LocalEdgeKit_formatInkRunDoneStatusHeadline(status: LocalEdgeKit_InkRunDoneStatus): string;
/** Builds reusable category picker row models from a project-provided catalog. */
export declare function LocalEdgeKit_buildInkCategoryRows<CategoryId extends string>(options: {
    readonly categories: readonly LocalEdgeKit_InkCategoryInput<CategoryId>[];
    readonly selectedIndex: number;
}): LocalEdgeKit_InkCategoryRow<CategoryId>[];
/** Builds reusable action picker row models from a project-provided catalog. */
export declare function LocalEdgeKit_buildInkActionRows<ActionId extends string>(options: {
    readonly actions: readonly LocalEdgeKit_InkActionInput<ActionId>[];
    readonly selectedIndex: number;
}): LocalEdgeKit_InkActionRow<ActionId>[];
