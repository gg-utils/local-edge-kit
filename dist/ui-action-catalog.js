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
/** Returns the action card for a given action id, or `null` if it is not present. */
export function LocalEdgeKit_getUiActionById(options) {
    return options.actions.find((action) => action.id === options.id) ?? null;
}
/** Returns all action cards belonging to a category. */
export function LocalEdgeKit_getUiActionsForCategory(options) {
    return options.actions.filter((action) => action.categoryId === options.categoryId);
}
/** Builds a project-specific action-id guard from an explicit action catalog. */
export function LocalEdgeKit_isUiActionId(options) {
    return options.actions.some((action) => action.id === options.value);
}
