/**
 * @fileoverview Reusable local-edge UI action-catalog types and lookup helpers.
 *
 * Project adapters own the actual category rows, action ids, labels, npm script names, and risk
 * choices. This module owns the generic action-card contract and catalog lookup/filter predicates
 * used by Ink, OpenTUI, and classic local-edge action-browser launchers.
 *
 * @testing Node test runner: cd packages/local-edge-kit && npm run test -- src/ui-action-catalog.unit.test.ts
 *
 * @see packages/local-edge-kit/src/ui-action-catalog.unit.test.ts - Node test runner regression coverage for lookup-by-id, per-category filtering, and the action-id type guard exported from this catalog module.
 * @see packages/local-edge-kit/src/index.ts - Package barrel that re-exports this module for `@gg-utils/local-edge-kit` and `@gg-utils/local-edge-kit/ui-action-catalog` consumers wiring project catalogs into terminal UIs.
 * @see local-edge-ui.config.ts - Root local-edge UI adapter that imports these action-card and category contracts to type rows rendered by Ink and OpenTUI action browsers.
 * @see consumer local-edge adapter - consumer interactive UI types that compose `@gg-utils/local-edge-kit/ui-action-catalog` contracts alongside project-specific action metadata.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

/** Risk classification used by action-browser UIs to gate irreversible actions. */
export type LocalEdgeKit_UiActionRisk =
  | "destructive"
  | "mutating"
  | "read-only";

/** Generic category row rendered by local-edge action browsers. */
export type LocalEdgeKit_UiCategory<CategoryId extends string> = {
  readonly id: CategoryId;
  readonly label: string;
};

/** Generic action-card descriptor rendered by local-edge action browsers. */
export type LocalEdgeKit_UiActionCard<
  ActionId extends string,
  CategoryId extends string,
  Special extends string,
> = {
  readonly categoryId: CategoryId;
  readonly description: string;
  readonly id: ActionId;
  readonly label: string;
  readonly requiresTypedConfirmation: boolean;
  readonly risk: LocalEdgeKit_UiActionRisk;
  readonly special: Special;
  readonly supportsMethodAll: boolean;
};

/** Returns the action card for a given action id, or `null` if it is not present. */
export function LocalEdgeKit_getUiActionById<
  ActionId extends string,
  CategoryId extends string,
  Special extends string,
>(options: {
  readonly actions: readonly LocalEdgeKit_UiActionCard<
    ActionId,
    CategoryId,
    Special
  >[];
  readonly id: ActionId;
}): LocalEdgeKit_UiActionCard<ActionId, CategoryId, Special> | null {
  return options.actions.find((action) => action.id === options.id) ?? null;
}

/** Returns all action cards belonging to a category. */
export function LocalEdgeKit_getUiActionsForCategory<
  ActionId extends string,
  CategoryId extends string,
  Special extends string,
>(options: {
  readonly actions: readonly LocalEdgeKit_UiActionCard<
    ActionId,
    CategoryId,
    Special
  >[];
  readonly categoryId: CategoryId;
}): LocalEdgeKit_UiActionCard<ActionId, CategoryId, Special>[] {
  return options.actions.filter(
    (action) => action.categoryId === options.categoryId,
  );
}

/** Builds a project-specific action-id guard from an explicit action catalog. */
export function LocalEdgeKit_isUiActionId<
  ActionId extends string,
  CategoryId extends string,
  Special extends string,
>(options: {
  readonly actions: readonly LocalEdgeKit_UiActionCard<
    ActionId,
    CategoryId,
    Special
  >[];
  readonly value: string;
}): options is {
  readonly actions: readonly LocalEdgeKit_UiActionCard<
    ActionId,
    CategoryId,
    Special
  >[];
  readonly value: ActionId;
} {
  return options.actions.some((action) => action.id === options.value);
}
