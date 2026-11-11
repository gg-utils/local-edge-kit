/**
 * @fileoverview Config-driven helper-server port resolution for local-edge dashboard surfaces.
 *
 * Helper servers such as logs/status dashboards all need the same precedence chain: CLI flags,
 * active realm env overlays, process env, then a canonical-realm default. This package module owns
 * that reusable parsing and collision prevention while adapters provide service names, env keys,
 * defaults, and project-specific remediation wording.
 *
 * @example
 * ```typescript
 * import { LocalEdgeKit_resolveHelperServerPort } from "@gg-utils/local-edge-kit/helper-server-config";
 *
 * const resolved = LocalEdgeKit_resolveHelperServerPort({
 *   activeEnvFilePaths: ["/workspace/.env.local-edge"],
 *   argv: ["--logs-web-port", "9020"],
 *   canonicalRealmSlug: "main",
 *   defaultPort: 9011,
 *   env: { LOCAL_EDGE_ENV_SLUG: "main" },
 *   portEnvName: "LOCAL_EDGE_LOGS_WEB_UPSTREAM_PORT",
 *   portFlags: ["--logs-web-port"],
 *   realmSlugEnvName: "LOCAL_EDGE_ENV_SLUG",
 *   serviceLabel: "logs-web",
 * });
 * ```
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/helper-server-config.unit.test.ts
 *
 * @see consumer local-edge adapter - consumer adapter that forwards logs-web env keys, CLI flags, and remediation copy into this resolver before the logs helper binds.
 * @see consumer local-edge adapter - consumer adapter that wires platform-status helper-server names and realm stack inputs into this resolver the same way.
 * @see packages/local-edge-kit/src/helper-server-config.unit.test.ts - Node test module that locks precedence order and non-canonical default-port collision errors for the contract owned here.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
/** Layer that supplied a helper-server bind port. */
export type LocalEdgeKit_HelperServerPortSource = "cli" | "active-env" | "process-env" | "default";
/** Successful helper-server port resolution. */
export type LocalEdgeKit_HelperServerResolvedPort = {
    readonly port: number;
    readonly source: LocalEdgeKit_HelperServerPortSource;
};
/** Optional host filesystem operations for env-file reads. */
export type LocalEdgeKit_HelperServerConfigOperations = {
    readonly exists: (filePath: string) => boolean;
    readonly readText: (filePath: string) => string;
};
/** Config and inputs for helper-server port resolution. */
export type LocalEdgeKit_ResolveHelperServerPortOptions = {
    readonly activeEnvFilePaths: readonly string[];
    readonly argv: readonly string[];
    readonly canonicalRealmSlug: string;
    readonly defaultPort: number;
    readonly env: Record<string, string | undefined>;
    readonly operations?: Partial<LocalEdgeKit_HelperServerConfigOperations> | undefined;
    readonly portEnvName: string;
    readonly portFlags: readonly string[];
    readonly realmSlugEnvName: string;
    readonly serviceLabel: string;
    readonly defaultPortCollisionMessage?: (options: {
        port: number;
        portEnvName: string;
        realmSlug: string;
        serviceLabel: string;
    }) => string;
    readonly missingNonCanonicalPortMessage?: (options: {
        portEnvName: string;
        realmSlug: string;
        serviceLabel: string;
    }) => string;
};
/** Parses and validates a decimal TCP port. */
export declare function LocalEdgeKit_parseHelperServerPort(options: {
    readonly label: string;
    readonly rawValue: string;
    readonly serviceLabel: string;
}): number;
/** Removes matching single or double quotes around dotenv values. */
export declare function LocalEdgeKit_stripHelperServerEnvValue(rawValue: string): string;
/** Reads the last dotenv-style assignment for `key` from `envFilePath`. */
export declare function LocalEdgeKit_readHelperServerEnvFileValue(options: {
    readonly envFilePath: string | null;
    readonly key: string;
    readonly operations?: Partial<LocalEdgeKit_HelperServerConfigOperations> | undefined;
}): string | null;
/** Returns the most specific active env file path from a general-to-specific stack. */
export declare function LocalEdgeKit_activeHelperServerEnvFilePath(activeEnvFilePaths: readonly string[]): string | null;
/** Resolves a helper-server bind port from CLI args, active env files, process env, or default. */
export declare function LocalEdgeKit_resolveHelperServerPort(options: LocalEdgeKit_ResolveHelperServerPortOptions): LocalEdgeKit_HelperServerResolvedPort;
