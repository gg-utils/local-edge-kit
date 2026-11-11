/**
 * @fileoverview URL-matrix helpers that combine kit runtime config with core formatting.
 *
 * This file owns mapping `LocalEdgeKit_RuntimeConfig` surfaces and resolved per-method bind facts
 * into the string rows returned for CLI and diagnostics; deterministic HTTPS line text is delegated
 * to `@gg-utils/local-edge-core`.
 *
 * @testing Jest unit: npm run test --prefix packages/local-edge-kit -- src/url-matrix.unit.test.ts
 *
 * @see packages/local-edge-core/src/url-matrix.ts - Core `LocalEdgeCore_buildUrlMatrixLines` implementation that turns resolved host, port, realm, and surface paths into printable HTTPS matrix lines consumed from here.
 * @see packages/local-edge-kit/src/runtime-config.ts - Runtime resolver that supplies per-method listen host, port, and normalized surfaces used before delegating to core matrix rendering.
 * @see packages/local-edge-kit/src/urls-cli.ts - URLs CLI command that calls `LocalEdgeKit_buildUrlMatrixLines` to print matrix output for operators across primary, all, or single methods.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { type LocalEdgeKit_RuntimeConfig } from "./runtime-config.js";
/** Options for building URL-matrix lines for one method. */
export type LocalEdgeKit_BuildUrlMatrixLinesOptions = {
    commandLabel?: string;
    method: string;
    runtimeConfig: LocalEdgeKit_RuntimeConfig;
};
/** Builds local-edge URL-matrix lines for one configured method. */
export declare function LocalEdgeKit_buildUrlMatrixLines(options: LocalEdgeKit_BuildUrlMatrixLinesOptions): string[];
