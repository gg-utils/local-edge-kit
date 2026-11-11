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
/** Formats the top summary line for a project-scoped action browser. */
export function LocalEdgeKit_formatInkActionBrowserHeaderSummary(options) {
    return `Project: ${options.projectRoot} | ↑/↓ Navigate | Enter Select | Esc Back | Q Quit`;
}
/** Returns the selected item, or `null` when the list/index state is incomplete. */
export function LocalEdgeKit_getInkSelectedItem(options) {
    return options.items[options.selectedIndex] ?? null;
}
/** Rotates a list selection through available items without leaking UI framework state. */
export function LocalEdgeKit_rotateInkSelectionIndex(options) {
    if (options.itemCount <= 0) {
        return 0;
    }
    if (options.direction === "up") {
        return options.currentIndex > 0
            ? options.currentIndex - 1
            : options.itemCount - 1;
    }
    return options.currentIndex < options.itemCount - 1
        ? options.currentIndex + 1
        : 0;
}
/** Chooses a review-header tone for an action risk level. */
export function LocalEdgeKit_getInkRiskTone(risk) {
    if (risk === "destructive") {
        return "error";
    }
    if (risk === "mutating") {
        return "warning";
    }
    return "info";
}
/** Maps a completed run state to the concise result-screen headline. */
export function LocalEdgeKit_formatInkRunDoneStatusHeadline(status) {
    if (status === "succeeded") {
        return "✓ Success";
    }
    if (status === "failed") {
        return "✗ Failed";
    }
    return "⊘ Cancelled";
}
/** Builds reusable category picker row models from a project-provided catalog. */
export function LocalEdgeKit_buildInkCategoryRows(options) {
    return options.categories.map((category, index) => {
        const selected = index === options.selectedIndex;
        return {
            id: category.id,
            label: category.label,
            marker: selected ? "> " : "  ",
            selected,
        };
    });
}
/** Builds reusable action picker row models from a project-provided catalog. */
export function LocalEdgeKit_buildInkActionRows(options) {
    return options.actions.map((action, index) => {
        const selected = index === options.selectedIndex;
        return {
            id: action.id,
            label: action.label,
            marker: selected ? "> " : "  ",
            risk: action.risk,
            riskLabel: `(${action.risk})`,
            selected,
        };
    });
}
