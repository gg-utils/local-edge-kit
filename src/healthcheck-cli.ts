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

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";

import {
  LocalEdgeCore_buildHealthcheckRequestPath,
  LocalEdgeCore_buildHostnameFromParts,
  LocalEdgeCore_classifyHealthcheckErrorDomain,
  LocalEdgeCore_computeHealthFingerprint,
  LocalEdgeCore_computeHealthProbeRollups,
  LocalEdgeCore_formatHttpsUrl,
  LocalEdgeCore_healthProbeKey,
  LocalEdgeCore_isHealthyHttpStatusCode,
  LocalEdgeCore_parseHealthcheckRuntimeOptions,
  LocalEdgeCore_parseRequiredPositiveInt,
  LocalEdgeCore_resolveRealmArtifactPaths,
  LocalEdgeCore_shouldFailStrictHealthWatch,
  LocalEdgeCore_shouldLogHealthSummary,
  LocalEdgeCore_tickHealthFingerprintStability,
  type LocalEdgeCore_HealthFailureDomain,
} from "@gg-utils/local-edge-core";

import type {
  LocalEdgeKit_Config,
  LocalEdgeKit_SurfaceConfig,
} from "./config.js";
import { LocalEdgeKit_loadActiveEnvFileStack } from "./env.js";
import {
  LocalEdgeKit_getRuntimeMethod,
  LocalEdgeKit_resolveRuntimeConfig,
  type LocalEdgeKit_RuntimeConfig,
} from "./runtime-config.js";

const LOCAL_EDGE_KIT_HEALTHCHECK_DEFAULT_INTERVAL_MS = 5000;
const LOCAL_EDGE_KIT_HEALTHCHECK_DEFAULT_STEADY_INTERVAL_MS = 15000;
const LOCAL_EDGE_KIT_HEALTHCHECK_DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const LOCAL_EDGE_KIT_HEALTHCHECK_STABILIZATION_CYCLES = 3;
const LOCAL_EDGE_KIT_HEALTHCHECK_HEARTBEAT_CYCLE_INTERVAL = 60;

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
  readonly env?: NodeJS.ProcessEnv;
  readonly output?: LocalEdgeKit_HealthcheckOutput;
  readonly probeSurface?: LocalEdgeKit_HealthcheckProbeFunction;
};

let localEdgeKitMkcertCaCache: Buffer | null | undefined;

function LocalEdgeKit_defaultOutput(): LocalEdgeKit_HealthcheckOutput {
  return {
    log(message) {
      console.log(message);
    },
    warn(message) {
      console.warn(message);
    },
    error(message) {
      console.error(message);
    },
  };
}

function LocalEdgeKit_healthcheckCommandLabel(
  config: LocalEdgeKit_Config,
): string {
  return `${config.cli?.commandName ?? "local-edge"}:healthcheck`;
}

function LocalEdgeKit_healthcheckStrictStartEnvName(
  config: LocalEdgeKit_Config,
): string {
  return config.healthcheck?.strictStartEnvName ?? "LOCAL_EDGE_STRICT_START";
}

function LocalEdgeKit_healthcheckLogVerbosityEnvName(
  config: LocalEdgeKit_Config,
): string {
  return (
    config.healthcheck?.logVerbosityEnvName ??
    "LOCAL_EDGE_HEALTHCHECK_LOG_VERBOSITY"
  );
}

function LocalEdgeKit_healthcheckCompatibilityFallbackEnvName(
  config: LocalEdgeKit_Config,
): string {
  return (
    config.healthcheck?.compatibilityFallbackEnvName ??
    "LOCAL_EDGE_ALLOW_COMPATIBILITY_FALLBACK"
  );
}

function LocalEdgeKit_isTruthy(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function LocalEdgeKit_isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function LocalEdgeKit_stringFromRecord(options: {
  readonly record: Record<string, unknown>;
  readonly key: string;
  readonly fallback?: string;
}): string {
  const value = options.record[options.key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return options.fallback ?? "";
}

function LocalEdgeKit_numberMapFromRecord(
  value: unknown,
): Record<string, number> {
  const ports: Record<string, number> = {};
  if (!LocalEdgeKit_isRecord(value)) {
    return ports;
  }

  for (const [key, portValue] of Object.entries(value)) {
    if (typeof portValue === "number" && Number.isFinite(portValue)) {
      ports[key] = portValue;
    }
  }

  return ports;
}

function LocalEdgeKit_projectPathFromRecord(options: {
  readonly record: Record<string, unknown>;
  readonly runtimeConfig: LocalEdgeKit_RuntimeConfig;
}): string {
  const workspacePath = LocalEdgeKit_stringFromRecord({
    record: options.record,
    key: "workspacePath",
  });
  return workspacePath.length > 0 ? workspacePath : options.runtimeConfig.projectRoot;
}

function LocalEdgeKit_realmRootFromRecord(
  record: Record<string, unknown>,
): string | null {
  const paths = record["paths"];
  if (!LocalEdgeKit_isRecord(paths)) {
    return null;
  }
  const realmRoot = paths["realmRoot"];
  return typeof realmRoot === "string" && realmRoot.length > 0 ? realmRoot : null;
}

function LocalEdgeKit_readRegistryRealmRecord(options: {
  readonly realmSlug: string;
  readonly value: unknown;
  readonly runtimeConfig: LocalEdgeKit_RuntimeConfig;
}): LocalEdgeKit_HealthcheckRealmRecord {
  if (!LocalEdgeKit_isRecord(options.value)) {
    throw new Error(
      `[local-edge:healthcheck] Registry realm '${options.realmSlug}' must be an object.`,
    );
  }

  const realmSlug = LocalEdgeKit_stringFromRecord({
    record: options.value,
    key: "realmSlug",
    fallback: options.realmSlug,
  });
  if (realmSlug !== options.realmSlug) {
    throw new Error(
      `[local-edge:healthcheck] Registry realm key '${options.realmSlug}' does not match realmSlug '${realmSlug}'.`,
    );
  }

  return {
    realmSlug,
    status: LocalEdgeKit_stringFromRecord({
      record: options.value,
      key: "status",
      fallback: "inactive",
    }),
    method: LocalEdgeKit_stringFromRecord({
      record: options.value,
      key: "primaryMethod",
      fallback: LocalEdgeKit_stringFromRecord({
        record: options.value,
        key: "method",
        fallback: options.runtimeConfig.primaryMethod,
      }),
    }),
    developerSlug: LocalEdgeKit_stringFromRecord({
      record: options.value,
      key: "developerSlug",
      fallback: options.runtimeConfig.developerSlug,
    }),
    rootZone: LocalEdgeKit_stringFromRecord({
      record: options.value,
      key: "rootZone",
      fallback: options.runtimeConfig.rootZone,
    }),
    projectRoot: LocalEdgeKit_projectPathFromRecord({
      record: options.value,
      runtimeConfig: options.runtimeConfig,
    }),
    ports: LocalEdgeKit_numberMapFromRecord(options.value["ports"]),
    realmRoot: LocalEdgeKit_realmRootFromRecord(options.value),
  };
}

async function LocalEdgeKit_readRegistryRealms(
  runtimeConfig: LocalEdgeKit_RuntimeConfig,
): Promise<LocalEdgeKit_HealthcheckRealmRecord[]> {
  const registryPath = path.join(
    runtimeConfig.generatedDir,
    "registry",
    "realms.json",
  );

  try {
    const rawRegistry = await fs.readFile(registryPath, "utf8");
    const registry = JSON.parse(rawRegistry);
    if (!LocalEdgeKit_isRecord(registry)) {
      throw new Error("[local-edge:healthcheck] Registry file must be an object.");
    }
    const realms = registry["realms"];
    if (!LocalEdgeKit_isRecord(realms)) {
      throw new Error(
        "[local-edge:healthcheck] Registry file is missing a realms object.",
      );
    }
    return Object.entries(realms).map(([realmSlug, value]) =>
      LocalEdgeKit_readRegistryRealmRecord({
        realmSlug,
        value,
        runtimeConfig,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return [];
    }
    throw error;
  }
}

function LocalEdgeKit_healthcheckSurfaces(
  config: LocalEdgeKit_Config,
): readonly LocalEdgeKit_SurfaceConfig[] {
  return config.surfaces.filter(
    (surface) => surface.healthcheck?.include !== false,
  );
}

function LocalEdgeKit_surfaceUpstreamPortKey(
  surface: LocalEdgeKit_SurfaceConfig,
): string {
  return surface.healthcheck?.upstreamPortKey ?? surface.id;
}

function LocalEdgeKit_surfaceStatusPath(
  surface: LocalEdgeKit_SurfaceConfig,
): string {
  return surface.healthcheck?.statusPath ?? surface.statusPath;
}

function LocalEdgeKit_resolveSurfaceFallbackPort(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly surface: LocalEdgeKit_SurfaceConfig;
}): number | null {
  const envName = options.surface.healthcheck?.upstreamPortEnvName;
  const rawPort = envName === undefined ? undefined : options.env[envName];
  if (
    envName !== undefined &&
    rawPort !== undefined &&
    rawPort.trim().length > 0
  ) {
    return LocalEdgeCore_parseRequiredPositiveInt({
      rawValue: rawPort,
      envName,
    });
  }
  return options.surface.healthcheck?.defaultUpstreamPort ?? null;
}

function LocalEdgeKit_buildCompatibilityRealmRecord(options: {
  readonly config: LocalEdgeKit_Config;
  readonly env: NodeJS.ProcessEnv;
  readonly runtimeConfig: LocalEdgeKit_RuntimeConfig;
}): LocalEdgeKit_HealthcheckRealmRecord {
  const ports: Record<string, number> = {};
  for (const surface of LocalEdgeKit_healthcheckSurfaces(options.config)) {
    const fallbackPort = LocalEdgeKit_resolveSurfaceFallbackPort({
      env: options.env,
      surface,
    });
    if (fallbackPort !== null) {
      ports[LocalEdgeKit_surfaceUpstreamPortKey(surface)] = fallbackPort;
    }
  }

  const realmPaths = LocalEdgeCore_resolveRealmArtifactPaths({
    realmsDir: path.join(options.runtimeConfig.generatedDir, "realms"),
    realmSlug: options.runtimeConfig.realmSlug,
  });

  return {
    realmSlug: options.runtimeConfig.realmSlug,
    status: "active",
    method: options.runtimeConfig.primaryMethod,
    developerSlug: options.runtimeConfig.developerSlug,
    rootZone: options.runtimeConfig.rootZone,
    projectRoot: options.runtimeConfig.projectRoot,
    ports,
    realmRoot: realmPaths.realmRootDir,
  };
}

async function LocalEdgeKit_collectProbeRealms(options: {
  readonly config: LocalEdgeKit_Config;
  readonly env: NodeJS.ProcessEnv;
  readonly runtimeConfig: LocalEdgeKit_RuntimeConfig;
}): Promise<LocalEdgeKit_HealthcheckRealmRecord[]> {
  const registryRealms = await LocalEdgeKit_readRegistryRealms(options.runtimeConfig);
  if (registryRealms.length > 0) {
    return registryRealms;
  }
  const fallbackEnvName = LocalEdgeKit_healthcheckCompatibilityFallbackEnvName(
    options.config,
  );
  if (!LocalEdgeKit_isTruthy(options.env[fallbackEnvName])) {
    return [];
  }
  return [LocalEdgeKit_buildCompatibilityRealmRecord(options)];
}

function LocalEdgeKit_isSurfaceExpectedAbsent(options: {
  readonly projectRoot: string;
  readonly surface: LocalEdgeKit_SurfaceConfig;
}): boolean {
  const relativePath = options.surface.healthcheck?.expectedAbsentProjectRelativePath;
  if (relativePath === undefined || relativePath.trim().length === 0) {
    return false;
  }
  return !existsSync(path.join(options.projectRoot, relativePath));
}

function LocalEdgeKit_loadMkcertCa(): Buffer | null {
  if (localEdgeKitMkcertCaCache !== undefined) {
    return localEdgeKitMkcertCaCache;
  }

  const caRootResult = spawnSync("mkcert", ["-CAROOT"], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });

  if (caRootResult.status !== 0 || caRootResult.stdout === null) {
    localEdgeKitMkcertCaCache = null;
    return null;
  }

  const caRoot = caRootResult.stdout.toString("utf-8").trim();
  if (caRoot.length === 0) {
    localEdgeKitMkcertCaCache = null;
    return null;
  }

  const rootCaPem = path.join(caRoot, "rootCA.pem");
  try {
    localEdgeKitMkcertCaCache = readFileSync(rootCaPem);
    return localEdgeKitMkcertCaCache;
  } catch {
    localEdgeKitMkcertCaCache = null;
    return null;
  }
}

async function LocalEdgeKit_defaultProbeSurface(options: {
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
}): Promise<LocalEdgeKit_HealthcheckProbeResult> {
  const requestStartedAt = Date.now();
  const requestOptions: https.RequestOptions = {
    host: options.targetHost,
    port: options.port,
    path: options.path,
    method: "GET",
    servername: options.hostname,
    headers: {
      Host: options.hostname,
      "User-Agent": "local-edge-healthcheck",
    },
  };

  const mkcertCa = LocalEdgeKit_loadMkcertCa();
  if (mkcertCa !== null) {
    requestOptions.ca = mkcertCa;
  }

  return await new Promise((resolve) => {
    const request = https.request(requestOptions, (response) => {
      const statusCode = response.statusCode ?? null;
      const responseTimeMs = Date.now() - requestStartedAt;
      response.resume();
      const healthy = LocalEdgeCore_isHealthyHttpStatusCode(statusCode);
      resolve({
        realmSlug: options.realmSlug,
        method: options.method,
        surface: options.surface,
        hostname: options.hostname,
        port: options.port,
        upstreamPort: options.upstreamPort,
        path: options.path,
        url: options.url,
        responseTimeMs,
        healthy,
        statusCode,
        error: null,
        failureDomain: healthy ? "none" : "application",
      });
    });

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error("timeout"));
    });

    request.on("error", (error) => {
      resolve({
        realmSlug: options.realmSlug,
        method: options.method,
        surface: options.surface,
        hostname: options.hostname,
        port: options.port,
        upstreamPort: options.upstreamPort,
        path: options.path,
        url: options.url,
        responseTimeMs: null,
        healthy: false,
        statusCode: null,
        error: error.message,
        failureDomain: LocalEdgeCore_classifyHealthcheckErrorDomain(
          error.message,
        ),
      });
    });

    request.end();
  });
}

const localEdgeKit_announcedSkippedSurfaceIds = new Set<string>();

async function LocalEdgeKit_probeTargets(options: {
  readonly config: LocalEdgeKit_Config;
  readonly env: NodeJS.ProcessEnv;
  readonly includeInactive: boolean;
  readonly output: LocalEdgeKit_HealthcheckOutput;
  readonly probeSurface: LocalEdgeKit_HealthcheckProbeFunction;
  readonly requestedMethod: string;
  readonly requestedRealmSlug: string | null;
  readonly runtimeConfig: LocalEdgeKit_RuntimeConfig;
  readonly timeoutMs: number;
}): Promise<LocalEdgeKit_HealthcheckProbeResult[]> {
  const runtimeMethod = LocalEdgeKit_getRuntimeMethod({
    commandLabel: LocalEdgeKit_healthcheckCommandLabel(options.config),
    runtimeConfig: options.runtimeConfig,
    method: options.requestedMethod,
  });
  const realms = (await LocalEdgeKit_collectProbeRealms({
    config: options.config,
    env: options.env,
    runtimeConfig: options.runtimeConfig,
  })).filter(
    (realm) =>
      realm.method === options.requestedMethod &&
      (options.includeInactive ||
        options.requestedRealmSlug !== null ||
        realm.status === "active") &&
      (options.requestedRealmSlug === null ||
        realm.realmSlug === options.requestedRealmSlug),
  );

  const probeTasks: Array<Promise<LocalEdgeKit_HealthcheckProbeResult>> = [];
  const skippedSurfaceIds = new Set<string>();
  const commandLabel = LocalEdgeKit_healthcheckCommandLabel(options.config);

  for (const realm of realms) {
    for (const surface of LocalEdgeKit_healthcheckSurfaces(options.config)) {
      if (
        LocalEdgeKit_isSurfaceExpectedAbsent({
          surface,
          projectRoot: realm.projectRoot,
        })
      ) {
        skippedSurfaceIds.add(surface.id);
        continue;
      }

      const requestPath = LocalEdgeCore_buildHealthcheckRequestPath({
        statusPath: LocalEdgeKit_surfaceStatusPath(surface),
        surface: surface.id,
        method: realm.method,
        commandLabel,
      });
      const hostname = LocalEdgeCore_buildHostnameFromParts({
        surface: surface.id,
        realmSlug: realm.realmSlug,
        method: realm.method,
        developerSlug: realm.developerSlug,
        rootZone: realm.rootZone,
      });
      const upstreamPortKey = LocalEdgeKit_surfaceUpstreamPortKey(surface);
      const upstreamPort = realm.ports[upstreamPortKey] ?? null;
      const url = LocalEdgeCore_formatHttpsUrl({
        host: hostname,
        port: runtimeMethod.listenPort,
        requestPath,
      });
      probeTasks.push(
        options.probeSurface({
          realmSlug: realm.realmSlug,
          method: realm.method,
          surface: surface.id,
          hostname,
          targetHost: runtimeMethod.listenHost,
          port: runtimeMethod.listenPort,
          upstreamPort,
          path: requestPath,
          url,
          timeoutMs: options.timeoutMs,
        }),
      );
    }
  }

  for (const surfaceId of skippedSurfaceIds) {
    if (localEdgeKit_announcedSkippedSurfaceIds.has(surfaceId)) {
      continue;
    }
    options.output.log(
      `[local-edge:healthcheck] SKIPPED surface=${surfaceId} reason=expected-absent (optional checkout missing on disk)`,
    );
    localEdgeKit_announcedSkippedSurfaceIds.add(surfaceId);
  }

  if (probeTasks.length === 0) {
    options.output.warn(
      "[local-edge:healthcheck] WARNING: No registered realms matched the requested method.",
    );
  }

  return await Promise.all(probeTasks);
}

function LocalEdgeKit_healthcheckAggregateArtifactPath(options: {
  readonly config: LocalEdgeKit_Config;
  readonly runtimeConfig: LocalEdgeKit_RuntimeConfig;
}): string {
  const configuredPath = options.config.healthcheck?.aggregateArtifactPath;
  if (configuredPath === undefined || configuredPath.trim().length === 0) {
    return path.join(
      options.runtimeConfig.projectRoot,
      "logs",
      "local-edge",
      "artifacts",
      "healthcheck-last-run.json",
    );
  }
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(options.runtimeConfig.projectRoot, configuredPath);
}

function LocalEdgeKit_healthcheckRealmArtifactPath(options: {
  readonly realmRoot: string | null;
  readonly realmSlug: string;
  readonly runtimeConfig: LocalEdgeKit_RuntimeConfig;
}): string {
  if (options.realmRoot !== null) {
    return path.join(options.realmRoot, "health.json");
  }
  return LocalEdgeCore_resolveRealmArtifactPaths({
    realmsDir: path.join(options.runtimeConfig.generatedDir, "realms"),
    realmSlug: options.realmSlug,
  }).healthPath;
}

async function LocalEdgeKit_writeArtifact(options: {
  readonly config: LocalEdgeKit_Config;
  readonly env: NodeJS.ProcessEnv;
  readonly result: LocalEdgeKit_HealthcheckResult;
  readonly runtimeConfig: LocalEdgeKit_RuntimeConfig;
}): Promise<string> {
  const artifactPath = LocalEdgeKit_healthcheckAggregateArtifactPath({
    config: options.config,
    runtimeConfig: options.runtimeConfig,
  });
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, JSON.stringify(options.result, null, 2), "utf8");

  const realmsBySlug = new Map<string, LocalEdgeKit_HealthcheckRealmRecord>();
  for (const realm of await LocalEdgeKit_collectProbeRealms({
    config: options.config,
    env: options.env,
    runtimeConfig: options.runtimeConfig,
  })) {
    realmsBySlug.set(realm.realmSlug, realm);
  }

  const probesByRealm = new Map<string, LocalEdgeKit_HealthcheckProbeResult[]>();
  for (const probe of options.result.probes) {
    const currentRealmProbes = probesByRealm.get(probe.realmSlug) ?? [];
    currentRealmProbes.push(probe);
    probesByRealm.set(probe.realmSlug, currentRealmProbes);
  }

  for (const [realmSlug, realmProbes] of probesByRealm.entries()) {
    const realm = realmsBySlug.get(realmSlug) ?? null;
    const healthPath = LocalEdgeKit_healthcheckRealmArtifactPath({
      realmRoot: realm?.realmRoot ?? null,
      realmSlug,
      runtimeConfig: options.runtimeConfig,
    });
    await fs.mkdir(path.dirname(healthPath), { recursive: true });
    await fs.writeFile(
      healthPath,
      JSON.stringify(
        {
          runAt: options.result.runAt,
          cycle: options.result.cycle,
          realmSlug,
          method: options.result.method,
          healthyProbeCount: realmProbes.filter((probe) => probe.healthy)
            .length,
          failedProbeCount: realmProbes.filter((probe) => !probe.healthy)
            .length,
          probes: realmProbes,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  return artifactPath;
}

function LocalEdgeKit_logProbe(options: {
  readonly output: LocalEdgeKit_HealthcheckOutput;
  readonly probe: LocalEdgeKit_HealthcheckProbeResult;
}): void {
  const probe = options.probe;
  if (probe.healthy) {
    options.output.log(
      `[local-edge:healthcheck] OK domain=application realm=${probe.realmSlug} method=${probe.method} surface=${probe.surface} url=${probe.url} status=${probe.statusCode} latencyMs=${probe.responseTimeMs}`,
    );
    return;
  }
  options.output.warn(
    `[local-edge:healthcheck] WARNING domain=${probe.failureDomain} realm=${probe.realmSlug} method=${probe.method} surface=${probe.surface} url=${probe.url} status=${probe.statusCode} error=${probe.error}`,
  );
}

function LocalEdgeKit_logSummary(options: {
  readonly output: LocalEdgeKit_HealthcheckOutput;
  readonly result: LocalEdgeKit_HealthcheckResult;
}): void {
  const result = options.result;
  const healthyLabel = `${result.healthyProbeCount}/${result.probes.length}`;
  const firstHealthyLabel =
    result.firstHealthyAfterMs === null
      ? "n/a"
      : `${result.firstHealthyAfterMs}ms`;
  const stabilizedLabel =
    result.healthStabilizedAfterMs === null
      ? "n/a"
      : `${result.healthStabilizedAfterMs}ms`;
  const cadence =
    result.firstHealthyAfterMs !== null || result.healthStabilizedAfterMs !== null
      ? "steady"
      : "bootstrap";
  options.output.log(
    `[local-edge:healthcheck] cycle=${result.cycle} mode=${result.mode} realms=${result.realms.join(",")} healthy=${healthyLabel} failed=${result.failedProbeCount} appFailed=${result.applicationFailedProbeCount} routerFailed=${result.routerFailedProbeCount} elapsedMs=${result.elapsedSinceStartMs} firstHealthyAfter=${firstHealthyLabel} stabilizedAfter=${stabilizedLabel} cadence=${cadence}`,
  );
}

function LocalEdgeKit_maybeFinalizeHealthStabilization(options: {
  readonly consecutiveStableCycles: number;
  readonly elapsedSinceStartMs: number;
  readonly failedProbeCount: number;
  readonly healthStabilizedAfterMs: number | null;
  readonly healthyProbeCount: number;
  readonly intervalMs: number;
  readonly output: LocalEdgeKit_HealthcheckOutput;
  readonly steadyIntervalMs: number;
  readonly watch: boolean;
}): number | null {
  if (
    options.healthStabilizedAfterMs !== null ||
    options.consecutiveStableCycles <
      LOCAL_EDGE_KIT_HEALTHCHECK_STABILIZATION_CYCLES
  ) {
    return options.healthStabilizedAfterMs;
  }
  const stabilizedAfterMs = options.elapsedSinceStartMs;
  if (options.failedProbeCount === 0) {
    options.output.log(
      `[local-edge:healthcheck] Health stabilized (all healthy) after ${stabilizedAfterMs}ms since monitor start.`,
    );
  } else {
    options.output.log(
      `[local-edge:healthcheck] Health stabilized after ${stabilizedAfterMs}ms since monitor start (${options.healthyProbeCount} healthy, ${options.failedProbeCount} persistently unhealthy).`,
    );
  }
  if (options.watch && options.steadyIntervalMs !== options.intervalMs) {
    options.output.log(
      `[local-edge:healthcheck] Switching to steady-state cadence intervalMs=${options.steadyIntervalMs}.`,
    );
  }
  return stabilizedAfterMs;
}

function LocalEdgeKit_logProbeTransitionsForCycle(options: {
  readonly output: LocalEdgeKit_HealthcheckOutput;
  readonly probes: readonly LocalEdgeKit_HealthcheckProbeResult[];
  readonly previousProbeHealthByKey: Map<string, boolean>;
}): void {
  for (const probe of options.probes) {
    const probeKey = LocalEdgeCore_healthProbeKey(probe);
    const previousHealth = options.previousProbeHealthByKey.get(probeKey);
    const healthChanged =
      previousHealth === undefined || previousHealth !== probe.healthy;
    if (healthChanged || !probe.healthy) {
      LocalEdgeKit_logProbe({ output: options.output, probe });
    }
    options.previousProbeHealthByKey.set(probeKey, probe.healthy);
  }
}

async function LocalEdgeKit_delay(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function LocalEdgeKit_awaitWatchCadenceOrExit(options: {
  readonly elapsedSinceStartMs: number;
  readonly failedProbeCount: number;
  readonly firstHealthyAfterMs: number | null;
  readonly healthStabilizedAfterMs: number | null;
  readonly intervalMs: number;
  readonly maxWaitMs: number | null;
  readonly output: LocalEdgeKit_HealthcheckOutput;
  readonly steadyIntervalMs: number;
  readonly untilHealthy: boolean;
  readonly watch: boolean;
}): Promise<boolean> {
  if (!options.watch) {
    return false;
  }
  if (options.untilHealthy && options.failedProbeCount === 0) {
    options.output.log(
      "[local-edge:healthcheck] --until-healthy satisfied. Exiting watch loop.",
    );
    return false;
  }
  if (
    options.maxWaitMs !== null &&
    options.elapsedSinceStartMs >= options.maxWaitMs
  ) {
    options.output.warn(
      `[local-edge:healthcheck] Reached --max-wait-ms=${options.maxWaitMs} without a clean exit condition.`,
    );
    return false;
  }
  const hasReachedSteadyState =
    options.firstHealthyAfterMs !== null ||
    options.healthStabilizedAfterMs !== null;
  const nextDelayMs = hasReachedSteadyState
    ? options.steadyIntervalMs
    : options.intervalMs;
  await LocalEdgeKit_delay(nextDelayMs);
  return true;
}

async function LocalEdgeKit_runHealthcheckCommandOrThrow(
  options: LocalEdgeKit_RunHealthcheckCommandOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const output = options.output ?? LocalEdgeKit_defaultOutput();
  const probeSurface = options.probeSurface ?? LocalEdgeKit_defaultProbeSurface;
  LocalEdgeKit_loadActiveEnvFileStack({
    config: options.config,
    env,
    logPrefix: options.config.cli?.logPrefix,
  });
  const runtimeConfig = LocalEdgeKit_resolveRuntimeConfig({
    config: options.config,
    env,
  });
  const commandLabel = LocalEdgeKit_healthcheckCommandLabel(options.config);
  const parsed = LocalEdgeCore_parseHealthcheckRuntimeOptions({
    args: options.args,
    defaultMethod: runtimeConfig.primaryMethod,
    supportedMethods: runtimeConfig.supportedMethods,
    strictStartValue:
      env[LocalEdgeKit_healthcheckStrictStartEnvName(options.config)],
    healthcheckLogVerbosityValue:
      env[LocalEdgeKit_healthcheckLogVerbosityEnvName(options.config)],
    commandLabel,
    defaultIntervalMs: LOCAL_EDGE_KIT_HEALTHCHECK_DEFAULT_INTERVAL_MS,
    defaultSteadyIntervalMs:
      LOCAL_EDGE_KIT_HEALTHCHECK_DEFAULT_STEADY_INTERVAL_MS,
    defaultTimeoutMs: LOCAL_EDGE_KIT_HEALTHCHECK_DEFAULT_REQUEST_TIMEOUT_MS,
  });

  for (const warning of parsed.warnings) {
    output.warn(warning);
  }

  const healthcheckOptions = parsed.options;
  LocalEdgeKit_getRuntimeMethod({
    commandLabel,
    runtimeConfig,
    method: healthcheckOptions.requestedMethod,
  });

  const startedAtMs = Date.now();
  const mode = healthcheckOptions.watch ? "watch" : "oneshot";

  output.log(
    `[local-edge:healthcheck] Starting mode=${mode} method=${healthcheckOptions.requestedMethod} realm=${healthcheckOptions.requestedRealmSlug ?? "all"} includeInactive=${healthcheckOptions.includeInactive} strict=${healthcheckOptions.strict} intervalMs=${healthcheckOptions.intervalMs} steadyIntervalMs=${healthcheckOptions.steadyIntervalMs} timeoutMs=${healthcheckOptions.timeoutMs}`,
  );
  output.log(
    `[local-edge:healthcheck] Log verbosity: ${healthcheckOptions.logVerbosity} (set via ${healthcheckOptions.logVerbositySource})`,
  );

  let firstHealthyAfterMs: number | null = null;
  let healthStabilizedAfterMs: number | null = null;
  let cycle = 0;
  let lastResult: LocalEdgeKit_HealthcheckResult | null = null;
  const previousProbeHealthByKey = new Map<string, boolean>();
  let previousSummaryKey: string | null = null;
  let cyclesSinceLastFullLog = 0;
  let previousHealthFingerprint: string | null = null;
  let consecutiveStableCycles = 0;

  while (true) {
    cycle += 1;
    const probes = await LocalEdgeKit_probeTargets({
      config: options.config,
      env,
      includeInactive: healthcheckOptions.includeInactive,
      output,
      probeSurface,
      requestedMethod: healthcheckOptions.requestedMethod,
      requestedRealmSlug: healthcheckOptions.requestedRealmSlug,
      runtimeConfig,
      timeoutMs: healthcheckOptions.timeoutMs,
    });
    const {
      failedProbeCount,
      applicationFailedProbeCount,
      routerFailedProbeCount,
      healthyProbeCount,
    } = LocalEdgeCore_computeHealthProbeRollups(probes);
    const elapsedSinceStartMs = Date.now() - startedAtMs;

    if (failedProbeCount === 0 && firstHealthyAfterMs === null) {
      firstHealthyAfterMs = elapsedSinceStartMs;
      output.log(
        `[local-edge:healthcheck] All surfaces healthy after ${firstHealthyAfterMs}ms since monitor start.`,
      );
    }

    const currentHealthFingerprint = LocalEdgeCore_computeHealthFingerprint(probes);
    const stabilizationTick = LocalEdgeCore_tickHealthFingerprintStability({
      currentHealthFingerprint,
      previousHealthFingerprint,
      consecutiveStableCycles,
    });
    consecutiveStableCycles = stabilizationTick.consecutiveStableCycles;
    previousHealthFingerprint = stabilizationTick.previousHealthFingerprint;
    healthStabilizedAfterMs = LocalEdgeKit_maybeFinalizeHealthStabilization({
      consecutiveStableCycles,
      elapsedSinceStartMs,
      failedProbeCount,
      healthStabilizedAfterMs,
      healthyProbeCount,
      intervalMs: healthcheckOptions.intervalMs,
      output,
      steadyIntervalMs: healthcheckOptions.steadyIntervalMs,
      watch: healthcheckOptions.watch,
    });

    const result: LocalEdgeKit_HealthcheckResult = {
      runAt: new Date().toISOString(),
      cycle,
      mode,
      elapsedSinceStartMs,
      firstHealthyAfterMs,
      healthStabilizedAfterMs,
      method: healthcheckOptions.requestedMethod,
      realms: Array.from(new Set(probes.map((probe) => probe.realmSlug))).sort(),
      strict: healthcheckOptions.strict,
      watch: healthcheckOptions.watch,
      intervalMs: healthcheckOptions.intervalMs,
      steadyIntervalMs: healthcheckOptions.steadyIntervalMs,
      untilHealthy: healthcheckOptions.untilHealthy,
      maxWaitMs: healthcheckOptions.maxWaitMs,
      probes,
      healthyProbeCount,
      failedProbeCount,
      applicationFailedProbeCount,
      routerFailedProbeCount,
    };
    lastResult = result;

    const artifactPath = await LocalEdgeKit_writeArtifact({
      config: options.config,
      env,
      result,
      runtimeConfig,
    });

    const isFirstCycle = cycle === 1;
    const currentSummaryKey = `${healthyProbeCount}/${failedProbeCount}/${applicationFailedProbeCount}/${routerFailedProbeCount}`;
    const summaryChanged = currentSummaryKey !== previousSummaryKey;
    const isHeartbeat =
      cyclesSinceLastFullLog >=
      LOCAL_EDGE_KIT_HEALTHCHECK_HEARTBEAT_CYCLE_INTERVAL;
    const hasAnyUnhealthy = failedProbeCount > 0;
    const isVerbose = healthcheckOptions.logVerbosity === "all";
    const shouldLogSummary = LocalEdgeCore_shouldLogHealthSummary({
      hasAnyUnhealthy,
      isFirstCycle,
      isHeartbeat,
      isVerbose,
      summaryChanged,
      watch: healthcheckOptions.watch,
    });

    if (shouldLogSummary) {
      LocalEdgeKit_logSummary({ output, result });
      output.log(`[local-edge:healthcheck] Wrote artifact ${artifactPath}`);
      cyclesSinceLastFullLog = 0;
    } else {
      cyclesSinceLastFullLog += 1;
    }

    LocalEdgeKit_logProbeTransitionsForCycle({
      output,
      probes,
      previousProbeHealthByKey,
    });

    previousSummaryKey = currentSummaryKey;

    const shouldContinueWatch = await LocalEdgeKit_awaitWatchCadenceOrExit({
      elapsedSinceStartMs,
      failedProbeCount,
      firstHealthyAfterMs,
      healthStabilizedAfterMs,
      intervalMs: healthcheckOptions.intervalMs,
      maxWaitMs: healthcheckOptions.maxWaitMs,
      output,
      steadyIntervalMs: healthcheckOptions.steadyIntervalMs,
      untilHealthy: healthcheckOptions.untilHealthy,
      watch: healthcheckOptions.watch,
    });
    if (!shouldContinueWatch) {
      break;
    }
  }

  if (lastResult === null) {
    throw new Error("[local-edge:healthcheck] No probe cycle was executed.");
  }

  if (
    !healthcheckOptions.watch &&
    healthcheckOptions.strict &&
    lastResult.failedProbeCount > 0
  ) {
    throw new Error(
      `[local-edge:healthcheck] Strict mode failed because ${lastResult.applicationFailedProbeCount} application probe(s) were unhealthy.`,
    );
  }

  if (LocalEdgeCore_shouldFailStrictHealthWatch(lastResult)) {
    throw new Error(
      `[local-edge:healthcheck] Strict watch failed: application probes did not become healthy within ${healthcheckOptions.maxWaitMs}ms.`,
    );
  }

  return 0;
}

/** Runs the generic healthcheck command and returns a process-style exit code. */
export async function LocalEdgeKit_runHealthcheckCommand(
  options: LocalEdgeKit_RunHealthcheckCommandOptions,
): Promise<number> {
  const output = options.output ?? LocalEdgeKit_defaultOutput();
  try {
    return await LocalEdgeKit_runHealthcheckCommandOrThrow(options);
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
