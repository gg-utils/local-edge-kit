/**
 * @fileoverview Builds the product-neutral `LocalEdgeCore_Manifest` from kit `LocalEdgeKit_Config`
 * render surfaces, upstreams, and router methods for local-edge core consumers.
 *
 * Repositories author route groups, upstream defaults, and per-surface paths in caller-owned
 * `local-edge.config.ts` (via `defineLocalEdgeConfig`). This module validates render config
 * presence, resolves each surface to a render route group, and maps optional surface render
 * availability without embedding consumer app names beyond the caller-supplied `packageName`.
 * Flow: config -> `LocalEdgeKit_getRenderConfig` -> per-surface route group lookup -> neutral manifest record.
 *
 * @example
 * ```typescript
 * import { LocalEdgeKit_buildManifestFromConfig } from "@gg-utils/local-edge-kit";
 * import type { LocalEdgeKit_Config } from "@gg-utils/local-edge-kit/config";
 *
 * export function materializeRenderManifest(config: LocalEdgeKit_Config, packageName: string) {
 *   return LocalEdgeKit_buildManifestFromConfig({ config, packageName });
 * }
 * ```
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/render-manifest.unit.test.ts
 *
 * @see packages/local-edge-kit/src/config.ts - `LocalEdgeKit_Config` authoring contract, including render upstreams and route-group `hostnameSurfaceIds`, consumed when mapping each configured surface into manifest output.
 * @see packages/local-edge-core/src/manifest.ts - Canonical `LocalEdgeCore_Manifest` surface/upstream record this module materializes for core route planning and nginx/runtime adapters.
 * @see packages/local-edge-kit/src/render-manifest.unit.test.ts - Node test coverage that exercises happy-path mapping, missing-render errors, and missing route-group membership for configured surfaces.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import type { LocalEdgeCore_Manifest } from "@gg-utils/local-edge-core";
import type { LocalEdgeKit_Config, LocalEdgeKit_RenderConfig } from "./config.js";
/** Options for building a product-neutral manifest from a consumer config. */
export type LocalEdgeKit_BuildRenderManifestOptions = {
    config: LocalEdgeKit_Config;
    packageName: string;
    schemaVersion?: 1;
};
/** Returns the render section or throws a config-focused error. */
export declare function LocalEdgeKit_getRenderConfig(config: LocalEdgeKit_Config): LocalEdgeKit_RenderConfig;
/** Builds the neutral local-edge manifest from config-authored surfaces and render defaults. */
export declare function LocalEdgeKit_buildManifestFromConfig(options: LocalEdgeKit_BuildRenderManifestOptions): LocalEdgeCore_Manifest;
