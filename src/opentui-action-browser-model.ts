/**
 * @fileoverview Product-neutral option and phase helpers for local-edge OpenTUI action browsers.
 *
 * Script adapters keep React/OpenTUI rendering, project action catalogs, and subprocess side
 * effects. This module owns reusable tab-select option assembly, action-special phase resolution,
 * and confirmation gating for action-browser style terminal UIs.
 *
 * @testing CLI: npm run local-edge-kit:test -- src/opentui-action-browser-model.unit.test.ts
 *
 * @see packages/local-edge-kit/src/ink-action-browser-model.ts - Ink action-browser model that owns the `LocalEdgeKit_InkActionRisk` taxonomy embedded into OpenTUI action-picker option rows here.
 * @see packages/local-edge-kit/src/opentui-action-browser-app.tsx - OpenTUI JSX action browser that wires these option builders and phase helpers into tab-select flows and transitions.
 * @see packages/local-edge-kit/src/opentui-action-browser-model.unit.test.ts - Node `node:test` suite that locks option ordering, phase routing for action specials, and typed confirmation gating for this module.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import type { LocalEdgeKit_InkActionRisk } from "./ink-action-browser-model.js";

/** OpenTUI route phases used by action-browser style local-edge UIs. */
export type LocalEdgeKit_OpenTuiActionBrowserPhase =
  | "actions"
  | "category"
  | "init"
  | "logs"
  | "pool"
  | "preview"
  | "realm"
  | "reconcile"
  | "result"
  | "run";

/** Stable option row shape consumed by OpenTUI `tab-select`. */
export type LocalEdgeKit_OpenTuiSelectOption = {
  readonly description: string;
  readonly name: string;
  readonly value: string;
};

/** Minimal category shape needed for OpenTUI category menus. */
export type LocalEdgeKit_OpenTuiCategoryInput<CategoryId extends string> = {
  readonly id: CategoryId;
  readonly label: string;
};

/** Minimal action shape needed for OpenTUI action menus. */
export type LocalEdgeKit_OpenTuiActionInput<ActionId extends string> = {
  readonly description: string;
  readonly id: ActionId;
  readonly label: string;
  readonly risk: LocalEdgeKit_InkActionRisk;
};

/** Known action special markers that route to form phases before preview. */
export type LocalEdgeKit_OpenTuiActionSpecial =
  | "init"
  | "logs"
  | "none"
  | "realm-pool-next"
  | "realm-register"
  | "reconcile";

/** Builds shared footer options for quitting or returning up the action browser. */
export function LocalEdgeKit_buildOpenTuiNavOptions(options: {
  readonly includeBack: boolean;
}): LocalEdgeKit_OpenTuiSelectOption[] {
  const rows: LocalEdgeKit_OpenTuiSelectOption[] = [];
  if (options.includeBack) {
    rows.push({ description: "Back", name: "Back", value: "back" });
  }
  rows.push({ description: "Quit (SIGINT)", name: "Quit", value: "quit" });
  return rows;
}

/** Builds category-picker options from a project-provided category catalog. */
export function LocalEdgeKit_buildOpenTuiCategoryOptions<
  CategoryId extends string,
>(options: {
  readonly categories: readonly LocalEdgeKit_OpenTuiCategoryInput<CategoryId>[];
}): LocalEdgeKit_OpenTuiSelectOption[] {
  return [
    ...options.categories.map((category, index) => ({
      description: category.id,
      name: category.label,
      value: String(index),
    })),
    ...LocalEdgeKit_buildOpenTuiNavOptions({ includeBack: false }),
  ];
}

/** Builds action-picker options from a project-provided action catalog. */
export function LocalEdgeKit_buildOpenTuiActionOptions<
  ActionId extends string,
>(options: {
  readonly actions: readonly LocalEdgeKit_OpenTuiActionInput<ActionId>[];
}): LocalEdgeKit_OpenTuiSelectOption[] {
  return [
    ...options.actions.map((action) => ({
      description: `${action.risk} — ${action.description}`,
      name: action.label,
      value: action.id,
    })),
    ...LocalEdgeKit_buildOpenTuiNavOptions({ includeBack: true }),
  ];
}

/** Builds a generic continue/back/quit option set for pre-preview form phases. */
export function LocalEdgeKit_buildOpenTuiContinueOptions(options: {
  readonly continueDescription: string;
  readonly continueName: string;
  readonly continueValue: string;
}): LocalEdgeKit_OpenTuiSelectOption[] {
  return [
    {
      description: options.continueDescription,
      name: options.continueName,
      value: options.continueValue,
    },
    ...LocalEdgeKit_buildOpenTuiNavOptions({ includeBack: true }),
  ];
}

/** Builds preview-screen run/back/quit options. */
export function LocalEdgeKit_buildOpenTuiPreviewOptions(): LocalEdgeKit_OpenTuiSelectOption[] {
  return [
    { description: "Execute", name: "Run", value: "run" },
    { description: "Action list", name: "Back", value: "back" },
    ...LocalEdgeKit_buildOpenTuiNavOptions({ includeBack: false }),
  ];
}

/** Builds result-screen menu options. */
export function LocalEdgeKit_buildOpenTuiResultOptions(): LocalEdgeKit_OpenTuiSelectOption[] {
  return [{ description: "Categories", name: "Menu", value: "menu" }];
}

/** Resolves the next phase after an action selection. */
export function LocalEdgeKit_resolveOpenTuiPhaseForActionSpecial(options: {
  readonly special: LocalEdgeKit_OpenTuiActionSpecial | null | undefined;
}): LocalEdgeKit_OpenTuiActionBrowserPhase {
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
  return "preview";
}

/** Applies typed-confirmation policy for preview run actions. */
export function LocalEdgeKit_shouldRunOpenTuiPreviewAction(options: {
  readonly confirmationInput: string;
  readonly requiresTypedConfirmation: boolean;
}): boolean {
  if (!options.requiresTypedConfirmation) {
    return true;
  }
  return options.confirmationInput.trim().toUpperCase() === "YES";
}
