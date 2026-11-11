/**
 * @fileoverview Resolves consumer config plus env into runtime facts for local-edge kit commands.
 *
 * Resolution happens after the env stack is loaded. The returned structure gives command runners a
 * method allowlist, selected router defaults, URL-matrix identity, and Docker Compose coordinates
 * without reading repository-specific files.
 *
 * @testing Jest unit: npm run test --prefix packages/local-edge-kit -- src/url-matrix.unit.test.ts
 *
 * @see packages/local-edge-kit/src/config.ts - Declares router methods, surfaces, and env key names read while assembling the runtime snapshot.
 * @see packages/local-edge-kit/src/env.ts - Resolves the workspace project root anchoring generated-dir and compose path outputs here.
 * @see packages/local-edge-core/src/method-config.ts - Slug, method allowlist, and nginx-docker primitives composed into the resolved method records returned upstream.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import type { LocalEdgeKit_Config, LocalEdgeKit_SurfaceConfig } from "./config.js";
/** Runtime nginx-docker method facts after env/config resolution. */
export type LocalEdgeKit_RuntimeNginxDockerMethod = {
    kind: "nginx-docker";
    method: string;
    listenHost: string;
    listenPort: number;
    composePath: string;
    composeProjectName: string;
    serviceName: string;
};
/** Runtime method union resolved by the kit. */
export type LocalEdgeKit_RuntimeMethod = LocalEdgeKit_RuntimeNginxDockerMethod;
/** Fully resolved runtime config consumed by status and URL-matrix commands. */
export type LocalEdgeKit_RuntimeConfig = {
    configuredMethods: readonly string[];
    developerSlug: string;
    generatedDir: string;
    methods: readonly LocalEdgeKit_RuntimeMethod[];
    primaryMethod: string;
    projectRoot: string;
    realmSlug: string;
    rootZone: string;
    surfaces: readonly LocalEdgeKit_SurfaceConfig[];
    supportedMethods: readonly string[];
};
/** Options for resolving runtime config. */
export type LocalEdgeKit_ResolveRuntimeConfigOptions = {
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    projectRoot?: string | null | undefined;
};
/** Resolves the generic local-edge runtime config from consumer config and environment. */
export declare function LocalEdgeKit_resolveRuntimeConfig(options: LocalEdgeKit_ResolveRuntimeConfigOptions): LocalEdgeKit_RuntimeConfig;
/** Returns a runtime method by name or throws with a command-scoped error. */
export declare function LocalEdgeKit_getRuntimeMethod(options: {
    commandLabel: string;
    runtimeConfig: LocalEdgeKit_RuntimeConfig;
    method: string;
}): LocalEdgeKit_RuntimeMethod;
