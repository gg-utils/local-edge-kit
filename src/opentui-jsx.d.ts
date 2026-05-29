/**
 * @fileoverview Augments React JSX intrinsic elements with OpenTUI terminal widget tags (`box`,
 * `scrollbox`, `text`, `input`, `tab-select`) and their prop contracts for `@gg-utils/local-edge-kit` OpenTUI screens.
 *
 * This file owns ambient JSX augmentation on the global namespace plus `react` and
 * `react/jsx-runtime` so TypeScript accepts OpenTUI markup in package TSX without pulling in consumer
 * launcher scripts; runtime tag behavior still comes from the OpenTUI host wired at launch.
 * Flow: OpenTUI TSX -> intrinsic tag names -> narrowed props for layout, scrolling, text, inputs, and tabbed selects.
 *
 * @example
 * ```typescript
 * import type { ReactElement } from "react";
 *
 * export function LocalEdgeKit_OpenTuiSampleRoot(): ReactElement {
 *   return (
 *     <box style={{ flexDirection: "column", gap: 1 }}>
 *       <text>Local edge</text>
 *       <tab-select
 *         options={[{ name: "Resume", value: "resume", description: "Continue the last task" }]}
 *         onSelect={() => {}}
 *       />
 *     </box>
 *   );
 * }
 * ```
 *
 * @testing CLI: cd packages/local-edge-kit && npm run type-check
 *
 * @see packages/local-edge-kit/src/opentui-action-browser-app.tsx - OpenTUI action-browser app whose TSX consumes these intrinsic elements for menus, scroll regions, text, inputs, and tabbed selects.
 * @see packages/local-edge-kit/src/opentui-action-browser-model.ts - Wizard select option model (`LocalEdgeKit_OpenTuiSelectOption`) referenced by `tab-select` props augmented here.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - Repository file-overview standard this declaration header follows for audits and agent orientation.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import type { Key, ReactNode } from "react";
import type { LocalEdgeKit_OpenTuiSelectOption } from "./opentui-action-browser-model.js";

type LocalEdgeKit_OpenTuiFlexDirection = "column" | "row";

type LocalEdgeKit_OpenTuiStyle = {
  readonly flexDirection?: LocalEdgeKit_OpenTuiFlexDirection;
  readonly flexGrow?: number;
  readonly gap?: number;
  readonly maxHeight?: number;
  readonly padding?: number;
  readonly fg?: string;
};

type LocalEdgeKit_OpenTuiContainerProps = {
  readonly children?: ReactNode;
  readonly key?: Key;
  readonly style?: LocalEdgeKit_OpenTuiStyle;
};

type LocalEdgeKit_OpenTuiTextProps = {
  readonly children?: ReactNode;
  readonly color?: string;
  readonly key?: Key;
  readonly style?: LocalEdgeKit_OpenTuiStyle;
};

type LocalEdgeKit_OpenTuiInputProps = {
  readonly key?: Key;
  readonly onChange?: (value: string) => void;
  readonly value: string;
};

type LocalEdgeKit_OpenTuiSelectProps = {
  readonly key?: Key;
  readonly onSelect?: (
    index: number,
    option: LocalEdgeKit_OpenTuiSelectOption | undefined,
  ) => void;
  readonly options: readonly LocalEdgeKit_OpenTuiSelectOption[];
  readonly showDescription?: boolean;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      box: LocalEdgeKit_OpenTuiContainerProps;
      input: LocalEdgeKit_OpenTuiInputProps;
      scrollbox: LocalEdgeKit_OpenTuiContainerProps;
      text: LocalEdgeKit_OpenTuiTextProps;
      "tab-select": LocalEdgeKit_OpenTuiSelectProps;
    }
  }
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      box: LocalEdgeKit_OpenTuiContainerProps;
      input: LocalEdgeKit_OpenTuiInputProps;
      scrollbox: LocalEdgeKit_OpenTuiContainerProps;
      text: LocalEdgeKit_OpenTuiTextProps;
      "tab-select": LocalEdgeKit_OpenTuiSelectProps;
    }
  }
}

declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      box: LocalEdgeKit_OpenTuiContainerProps;
      input: LocalEdgeKit_OpenTuiInputProps;
      scrollbox: LocalEdgeKit_OpenTuiContainerProps;
      text: LocalEdgeKit_OpenTuiTextProps;
      "tab-select": LocalEdgeKit_OpenTuiSelectProps;
    }
  }
}

export {};
