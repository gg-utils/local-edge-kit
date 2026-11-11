/**
 * @fileoverview Regression tests for `LocalEdgeKit_runHealthcheckCommand` covering compatibility
 * fallback realm probing, optional-surface skip logging, aggregate healthcheck artifacts, and
 * registry-backed per-realm `health.json` writes without live HTTPS servers.
 *
 * This file owns Node test coverage that builds ephemeral project roots, wires
 * `defineLocalEdgeConfig` fixtures, injects a stubbed `LocalEdgeKit_HealthcheckProbeFunction`, and
 * asserts exit codes, probed URLs, log lines, and JSON payloads under configured artifact paths.
 * Flow: temp dirs + env/registry fixtures -> stubbed probes -> assert URLs, logs, and artifact fields.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/healthcheck-cli.unit.test.ts
 *
 * @see packages/local-edge-kit/src/healthcheck-cli.ts - Healthcheck command runner whose probe scheduling, artifact writes, and realm selection behavior is exercised here via injectable doubles.
 * @see packages/local-edge-kit/src/config.ts - `defineLocalEdgeConfig` fixture builder supplying healthcheck, env, identity, router, and surface slices used by these tests.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview contract governing this header shape and verification tags.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defineLocalEdgeConfig } from "./config.js";
import {
  LocalEdgeKit_runHealthcheckCommand,
  type LocalEdgeKit_HealthcheckProbeFunction,
} from "./healthcheck-cli.js";

function createTestConfig() {
  return defineLocalEdgeConfig({
    cli: {
      commandName: "local-edge",
      logPrefix: "local-edge",
    },
    env: {
      projectRootEnvName: "LOCAL_EDGE_PROJECT_ROOT",
      generatedDirEnvName: "LOCAL_EDGE_GENERATED_DIR",
      methodsEnvName: "LOCAL_EDGE_METHODS",
      primaryMethodEnvName: "LOCAL_EDGE_PRIMARY_METHOD",
      developerSlugEnvName: "LOCAL_EDGE_DEVELOPER_SLUG",
      realmSlugEnvName: "LOCAL_EDGE_ENV_SLUG",
      rootZoneEnvName: "LOCAL_EDGE_ROOT_ZONE",
    },
    identity: {
      defaultDeveloperSlug: "dev",
      defaultRealmSlug: "main",
      defaultRootZone: "local.test",
    },
    router: {
      primaryMethod: "nginx-docker",
      singleMethodMode: true,
      methods: [
        {
          kind: "nginx-docker",
          method: "nginx-docker",
          serviceName: "router",
          defaultListenHost: "127.0.0.1",
          defaultListenPort: 9443,
          composeProjectNamePrefix: "router",
          includeRealmSlugInDefaultComposeProjectName: false,
        },
      ],
    },
    healthcheck: {
      aggregateArtifactPath: "logs/local-edge/artifacts/healthcheck-last-run.json",
      compatibilityFallbackEnvName: "LOCAL_EDGE_ALLOW_COMPATIBILITY_FALLBACK",
    },
    surfaces: [
      {
        id: "app",
        appPath: "/",
        statusPath: "/status",
        healthcheck: {
          upstreamPortKey: "app",
          upstreamPortEnvName: "LOCAL_EDGE_APP_PORT",
          defaultUpstreamPort: 3000,
        },
      },
      {
        id: "optional-tool",
        appPath: "/",
        statusPath: "/health",
        healthcheck: {
          upstreamPortKey: "optionalTool",
          defaultUpstreamPort: 3001,
          expectedAbsentProjectRelativePath: "optional-tool/package.json",
        },
      },
    ],
  });
}

async function createTempRoot(): Promise<{
  generatedDir: string;
  projectRoot: string;
}> {
  const projectRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "local-edge-kit-healthcheck-"),
  );
  const generatedDir = path.join(projectRoot, ".tmp", "local-edge");
  await fs.mkdir(generatedDir, { recursive: true });
  return { generatedDir, projectRoot };
}

void test("LocalEdgeKit_runHealthcheckCommand probes compatibility fallback realms", async () => {
  const { generatedDir, projectRoot } = await createTempRoot();
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const probedUrls: string[] = [];
  const probeSurface: LocalEdgeKit_HealthcheckProbeFunction = async (probe) => {
 await Promise.resolve();
    probedUrls.push(probe.url);
    return {
      realmSlug: probe.realmSlug,
      method: probe.method,
      surface: probe.surface,
      hostname: probe.hostname,
      port: probe.port,
      upstreamPort: probe.upstreamPort,
      path: probe.path,
      url: probe.url,
      responseTimeMs: 3,
      healthy: true,
      statusCode: 200,
      error: null,
      failureDomain: "none",
    };
  };

  const exitCode = await LocalEdgeKit_runHealthcheckCommand({
    args: ["--no-strict"],
    config: createTestConfig(),
    env: {
      LOCAL_EDGE_ALLOW_COMPATIBILITY_FALLBACK: "1",
      LOCAL_EDGE_DEVELOPER_SLUG: "tester",
      LOCAL_EDGE_ENV_FILE: path.join(projectRoot, ".env.local-edge"),
      LOCAL_EDGE_ENV_SLUG: "main",
      LOCAL_EDGE_GENERATED_DIR: generatedDir,
      LOCAL_EDGE_PROJECT_ROOT: projectRoot,
      USER: "tester",
    },
    output: {
      log(message) {
        logs.push(message);
      },
      warn(message) {
        warnings.push(message);
      },
      error(message) {
        errors.push(message);
      },
    },
    probeSurface,
  });

  assert.equal(exitCode, 0);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
  assert.deepEqual(probedUrls, [
    "https://app.main.nginx-docker.tester.local.test:9443/status?le_probe=1&le_surface=app&le_method=nginx-docker",
  ]);
  assert.ok(
    logs.some((line) => line.includes("SKIPPED surface=optional-tool")),
  );

  const aggregateArtifact: unknown = JSON.parse(
    await fs.readFile(
      path.join(
        projectRoot,
        "logs",
        "local-edge",
        "artifacts",
        "healthcheck-last-run.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual((aggregateArtifact as { failedProbeCount: unknown }).failedProbeCount, 0);
  assert.equal((aggregateArtifact as { probes: { upstreamPort: number }[] }).probes[0]?.upstreamPort, 3000);
});

void test("LocalEdgeKit_runHealthcheckCommand reads registry realms and writes per-realm artifacts", async () => {
  const { generatedDir, projectRoot } = await createTempRoot();
  const realmRoot = path.join(generatedDir, "realms", "alpha");
  await fs.mkdir(path.join(generatedDir, "registry"), { recursive: true });
  await fs.writeFile(
    path.join(generatedDir, "registry", "realms.json"),
    JSON.stringify(
      {
        realms: {
          alpha: {
            realmSlug: "alpha",
            status: "active",
            primaryMethod: "nginx-docker",
            developerSlug: "tester",
            rootZone: "local.test",
            workspacePath: projectRoot,
            ports: {
              app: 4100,
              optionalTool: 4101,
            },
            paths: {
              realmRoot,
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const exitCode = await LocalEdgeKit_runHealthcheckCommand({
    args: ["--no-strict", "--realm", "alpha"],
    config: createTestConfig(),
    env: {
      LOCAL_EDGE_DEVELOPER_SLUG: "tester",
      LOCAL_EDGE_ENV_FILE: path.join(projectRoot, ".env.local-edge"),
      LOCAL_EDGE_ENV_SLUG: "main",
      LOCAL_EDGE_GENERATED_DIR: generatedDir,
      LOCAL_EDGE_PROJECT_ROOT: projectRoot,
      USER: "tester",
    },
    output: {
      log() {},
      warn() {},
      error(message) {
        throw new Error(message);
      },
    },
    async probeSurface(probe) {
 await Promise.resolve();
      return {
        realmSlug: probe.realmSlug,
        method: probe.method,
        surface: probe.surface,
        hostname: probe.hostname,
        port: probe.port,
        upstreamPort: probe.upstreamPort,
        path: probe.path,
        url: probe.url,
        responseTimeMs: 2,
        healthy: true,
        statusCode: 204,
        error: null,
        failureDomain: "none",
      };
    },
  });

  assert.equal(exitCode, 0);
  const realmArtifact: unknown = JSON.parse(
    await fs.readFile(path.join(realmRoot, "health.json"), "utf8"),
  );
  assert.deepEqual((realmArtifact as { realmSlug: unknown }).realmSlug, "alpha");
  assert.equal((realmArtifact as { probes: { upstreamPort: number }[] }).probes[0]?.upstreamPort, 4100);
});
