/**
 * @fileoverview Verifies Docker-host ensure-running hook wiring for nginx-docker router methods without
 * invoking Docker or host filesystem I/O.
 *
 * This file owns regression coverage for `LocalEdgeKit_createDockerHostEnsureRunningHooks` startup-path
 * delegation, including injected router probes and graceful handling of unsupported methods.
 * Flow: build kit config -> create hooks with stubbed routerHostProbe -> assert ensureMethodReadyForStartup,
 * methodRuntimeMatchesCurrentArtifacts, reloadRunningMethod, and routerHostProbe outcomes.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/docker-host.unit.test.ts
 *
 * @see packages/local-edge-kit/src/docker-host.ts - Factory under test that wires nginx-docker ensure-running hooks and delegates router probes to injectable callbacks while skipping live Docker lifecycle I/O in this suite.
 * @see packages/local-edge-kit/src/config.ts - defineLocalEdgeConfig-backed fixture builder supplying deterministic LocalEdgeKit_Config with nginx-docker router facts for hook construction.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview contract governing this header shape and verification tags.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import { defineLocalEdgeConfig } from "./config.js";
import { LocalEdgeKit_createDockerHostEnsureRunningHooks } from "./docker-host.js";

function createDockerHostConfig() {
  return defineLocalEdgeConfig({
    identity: {
      defaultDeveloperSlug: "dev",
      defaultRealmSlug: "main",
      defaultRootZone: "example.test",
    },
    router: {
      primaryMethod: "nginx-docker",
      methods: [
        {
          kind: "nginx-docker",
          method: "nginx-docker",
          serviceName: "edge-router",
          defaultListenHost: "127.0.0.1",
          defaultListenPort: 443,
          composeProjectNamePrefix: "edge-router",
        },
      ],
    },
    surfaces: [],
  });
}

void test("LocalEdgeKit_createDockerHostEnsureRunningHooks delegates router probes and ignores unsupported methods", () => {
  const hooks = LocalEdgeKit_createDockerHostEnsureRunningHooks({
    config: createDockerHostConfig(),
    projectRoot: "/tmp/example-project",
    routerHostProbe({ routerProbe }) {
      assert.equal(routerProbe.url, "https://web.example.test/health");
      return true;
    },
  });

  assert.deepEqual(
    hooks.ensureMethodReadyForStartup({
      env: {},
      method: "not-configured",
    }),
    { ok: true },
  );
  assert.equal(
    hooks.methodRuntimeMatchesCurrentArtifacts({
      env: {},
      method: "not-configured",
    }),
    true,
  );
  assert.equal(
    hooks.reloadRunningMethod({ env: {}, method: "not-configured" }),
    true,
  );
  assert.equal(
    hooks.routerHostProbe({
      routerProbe: {
        connectTimeoutSeconds: 3,
        maxTimeSeconds: 6,
        url: "https://web.example.test/health",
      },
    }),
    true,
  );
});
