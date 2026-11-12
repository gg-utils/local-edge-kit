/**
 * @fileoverview Curated public barrel for `@gg-utils/local-edge-kit` that re-exports CLI dispatchers,
 * runtime helpers, UI launchers, and shared contracts for repository-owned `local-edge.config.ts` adapters.
 *
 * This file owns only the package entrypoint surface; implementations live in sibling modules under
 * `packages/local-edge-kit/src/`. The package bridges project-owned config files and product-neutral
 * `@gg-utils/local-edge-core` primitives—keep repository-specific defaults, surface IDs, and command adapters
 * outside this package. Flow: consumers import from `@gg-utils/local-edge-kit` (or package subpaths) -> kit
 * modules -> `@gg-utils/local-edge-core` primitives.
 *
 * @example
 * ```typescript
 * import type { LocalEdgeKit_Config } from "@gg-utils/local-edge-kit";
 * import { LocalEdgeKit_runCli } from "@gg-utils/local-edge-kit";
 *
 * declare const localEdgeKitConfig: LocalEdgeKit_Config;
 * await LocalEdgeKit_runCli({ args: ["status"], config: localEdgeKitConfig });
 * ```
 *
 * @testing Jest unit: npm run test --prefix packages/local-edge-kit
 *
 * @see packages/local-edge-kit/src/cli.ts - Kit CLI dispatcher that defines LocalEdgeKit_runCli and related types re-exported through this barrel for adapter wiring.
 * @see scripts/local-edge/cli.ts - Root local-edge script that imports the kit CLI entrypoint from this package and supplies the platform-owned local-edge.config.ts adapter.
 * @see packages/local-edge-core/src/index.ts - Core primitives and contracts composed by kit modules before repository adapters call surfaces aggregated here.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

export * from "./cli.js";
export * from "./config.js";
export * from "./dns-audit-cli.js";
export * from "./env.js";
export * from "./healthcheck-cli.js";
export * from "./interactive-action-menu.js";
export * from "./ink-action-browser-app.js";
export * from "./ink-action-browser-model.js";
export * from "./opentui-action-browser-app.js";
export * from "./opentui-action-browser-model.js";
export * from "./lifecycle-plans.js";
export * from "./render-manifest.js";
export * from "./runtime-config.js";
export * from "./runtime-launch.js";
export * from "./status-cli.js";
export * from "./startup-cli.js";
export * from "./url-matrix.js";
export * from "./ui-launcher.js";
export * from "./ui-action-catalog.js";
export * from "./ui-spawn-request.js";
export * from "./urls-cli.js";
export * from "./supervisor.js";
export * from "./supervisor-cli.js";
export * from "./supervisor-router.js";
export * from "./safe-write.js";
