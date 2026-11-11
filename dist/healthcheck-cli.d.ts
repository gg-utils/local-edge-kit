/**
 * @fileoverview Config-driven healthcheck CLI runner for local-edge kit adapters.
 *
 * The runner owns reusable healthcheck orchestration: env/config resolution, minimal registry
 * reading, HTTPS probe scheduling, artifact writes, watch cadence, and strict exit semantics.
 * Consumers keep their surface catalog, status paths, upstream-port keys, and optional checkout
 * presence rules in their project config.
 *
 * @testing Node test: npm run test --prefix packages/local-edge-kit
 * @testing CLI: npm run local:edge:healthcheck -- --method nginx-docker --no-strict
 *
 * @see packages/local-edge-kit/src/cli.ts - Kit CLI dispatcher that routes the healthcheck argv family into LocalEdgeKit_runHealthcheckCommand imported from this module.
 * @see scripts/local-edge/healthcheck.ts - Root adapter entrypoint that binds local-edge.config.ts and forwards argv into the exported LocalEdgeKit_runHealthcheckCommand surface.
 * @see packages/local-edge-kit/src/config.ts - defineLocalEdgeConfig contract for surfaces, healthcheck artifact paths, and env key names consumed while resolving probe targets and strictness.
 * @see packages/local-edge-kit/src/runtime-config.ts - Runtime method and realm facts loader consulted before registry reads and HTTPS probes are scheduled against each surface.
 * @see packages/local-edge-kit/src/healthcheck-cli.unit.test.ts - Node-test harness that exercises registry parsing, probe rollups, artifact writes, and strict exit semantics without a live router.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { type LocalEdgeCore_HealthFailureDomain } from "@gg-utils/local-edge-core";
import type { LocalEdgeKit_Config } from "./config.js";
/** Minimal output sink used by tests and CLI adapters. */
export type LocalEdgeKit_HealthcheckOutput = {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
};
/** Runtime realm facts required by the generic healthcheck runner. */
export type LocalEdgeKit_HealthcheckRealmRecord = {
    readonly realmSlug: string;
    readonly status: string;
    readonly method: string;
    readonly developerSlug: string;
    readonly rootZone: string;
    readonly projectRoot: string;
    readonly ports: Readonly<Record<string, number>>;
    readonly realmRoot: string | null;
};
/** Outcome from probing one realm surface through the local HTTPS listener. */
export type LocalEdgeKit_HealthcheckProbeResult = {
    readonly realmSlug: string;
    readonly method: string;
    readonly surface: string;
    readonly hostname: string;
    readonly port: number;
    readonly upstreamPort: number | null;
    readonly path: string;
    readonly url: string;
    readonly responseTimeMs: number | null;
    readonly healthy: boolean;
    readonly statusCode: number | null;
    readonly error: string | null;
    readonly failureDomain: LocalEdgeCore_HealthFailureDomain;
};
/** Serialized health snapshot for one monitor iteration. */
export type LocalEdgeKit_HealthcheckResult = {
    readonly runAt: string;
    readonly cycle: number;
    readonly mode: "oneshot" | "watch";
    readonly elapsedSinceStartMs: number;
    readonly firstHealthyAfterMs: number | null;
    readonly healthStabilizedAfterMs: number | null;
    readonly method: string;
    readonly realms: readonly string[];
    readonly strict: boolean;
    readonly watch: boolean;
    readonly intervalMs: number;
    readonly steadyIntervalMs: number;
    readonly untilHealthy: boolean;
    readonly maxWaitMs: number | null;
    readonly probes: readonly LocalEdgeKit_HealthcheckProbeResult[];
    readonly healthyProbeCount: number;
    readonly failedProbeCount: number;
    readonly applicationFailedProbeCount: number;
    readonly routerFailedProbeCount: number;
};
/** Probe function override used by unit tests; production uses HTTPS. */
export type LocalEdgeKit_HealthcheckProbeFunction = (options: {
    readonly realmSlug: string;
    readonly method: string;
    readonly surface: string;
    readonly hostname: string;
    readonly targetHost: string;
    readonly port: number;
    readonly upstreamPort: number | null;
    readonly path: string;
    readonly url: string;
    readonly timeoutMs: number;
}) => Promise<LocalEdgeKit_HealthcheckProbeResult>;
/** Options for invoking the generic healthcheck command. */
export type LocalEdgeKit_RunHealthcheckCommandOptions = {
    readonly args: readonly string[];
    readonly config: LocalEdgeKit_Config;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly output?: LocalEdgeKit_HealthcheckOutput;
    readonly probeSurface?: LocalEdgeKit_HealthcheckProbeFunction;
};
/** Runs the generic healthcheck command and returns a process-style exit code. */
export declare function LocalEdgeKit_runHealthcheckCommand(options: LocalEdgeKit_RunHealthcheckCommandOptions): Promise<number>;
