/**
 * @fileoverview Public configuration contract for repositories using the local-edge kit.
 *
 * The kit consumes explicit project config and keeps all repository-specific identity, root zones,
 * surfaces, and router labels in the caller-owned `local-edge.config.ts`. This package only defines
 * reusable schema shape and returns config values unchanged for type-safe authoring.
 *
 * @testing Jest unit: cd packages/local-edge-kit && npm run test
 *
 * @see packages/local-edge-kit/src/cli.ts - Kit CLI entry that accepts `LocalEdgeKit_Config` for usage text, env defaults, and argv delegation into local-edge commands.
 * @see local-edge.config.ts - Root consumer-authored `defineLocalEdgeConfig` object that satisfies the contract exported from this module.
 * @see docs/LOCAL-EDGE.md - Runbook describing how caller-owned configs, generated artifacts, and kit CLIs fit together for local development.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
/** Returns the provided config unchanged while giving config files a stable authoring helper. */
export function defineLocalEdgeConfig(config) {
    return config;
}
