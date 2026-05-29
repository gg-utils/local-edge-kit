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

import type { LocalEdgeCore_Manifest, LocalEdgeCore_SurfaceAvailability } from "@gg-utils/local-edge-core";

import type {
  LocalEdgeKit_Config,
  LocalEdgeKit_RenderConfig,
  LocalEdgeKit_RenderRouteGroupConfig,
  LocalEdgeKit_SurfaceConfig,
} from "./config.js";

/** Options for building a product-neutral manifest from a consumer config. */
export type LocalEdgeKit_BuildRenderManifestOptions = {
  config: LocalEdgeKit_Config;
  packageName: string;
  schemaVersion?: 1;
};

function LocalEdgeKit_requiredSurfaceAvailability(): LocalEdgeCore_SurfaceAvailability {
  return { state: "local-edge-surface-availability-required" };
}

/** Returns the render section or throws a config-focused error. */
export function LocalEdgeKit_getRenderConfig(
  config: LocalEdgeKit_Config,
): LocalEdgeKit_RenderConfig {
  if (config.render === undefined) {
    throw new Error("[local-edge:render] local-edge.config.ts is missing render config.");
  }

  return config.render;
}

function LocalEdgeKit_routeGroupForSurface(options: {
  renderConfig: LocalEdgeKit_RenderConfig;
  surface: LocalEdgeKit_SurfaceConfig;
}): LocalEdgeKit_RenderRouteGroupConfig {
  const routeGroup = options.renderConfig.routeGroups.find((candidate) =>
    candidate.hostnameSurfaceIds.includes(options.surface.id),
  );

  if (routeGroup === undefined) {
    throw new Error(
      `[local-edge:render] Surface '${options.surface.id}' is missing from render.routeGroups.`,
    );
  }

  return routeGroup;
}

/** Builds the neutral local-edge manifest from config-authored surfaces and render defaults. */
export function LocalEdgeKit_buildManifestFromConfig(
  options: LocalEdgeKit_BuildRenderManifestOptions,
): LocalEdgeCore_Manifest {
  const renderConfig = LocalEdgeKit_getRenderConfig(options.config);

  return {
    schemaVersion: options.schemaVersion ?? 1,
    packageName: options.packageName,
    methods: options.config.router.methods.map((methodConfig) => methodConfig.method),
    upstreams: renderConfig.upstreams,
    surfaces: options.config.surfaces.map((surface) => {
      const routeGroup = LocalEdgeKit_routeGroupForSurface({
        renderConfig,
        surface,
      });

      return {
        id: surface.id,
        hostLabel: surface.id,
        upstreamId: routeGroup.upstreamId,
        routeGroupId: routeGroup.id,
        appPath: surface.appPath,
        statusPath: surface.statusPath,
        availability: surface.render?.availability ?? LocalEdgeKit_requiredSurfaceAvailability(),
      };
    }),
  };
}
