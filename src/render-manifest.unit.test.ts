/**
 * @fileoverview Verifies config-driven assembly of the local-edge render manifest from typed
 * `defineLocalEdgeConfig` fixtures.
 *
 * This file owns regression coverage for `LocalEdgeKit_buildManifestFromConfig`, including
 * surface-to-route-group wiring and default versus explicit surface availability.
 * Flow: build config -> call manifest builder -> assert normalized manifest matches expected shape.
 *
 * @example
 * ```typescript
 * test("maps surfaces through render route groups", () => {
 *   assert.deepEqual(
 *     LocalEdgeKit_buildManifestFromConfig({ config, packageName: "example-package" }),
 *     expectedManifest,
 *   );
 * });
 * ```
 *
 * @testing Node.js node:test via tsx: npm run test --prefix packages/local-edge-kit
 *
 * @see packages/local-edge-kit/src/render-manifest.ts - Manifest builder under test that maps render config, upstreams, and surfaces into the normalized manifest asserted here.
 * @see packages/local-edge-kit/src/config.ts - `defineLocalEdgeConfig` and render/surface config types used to build the deterministic fixtures exercised by this suite.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import { defineLocalEdgeConfig } from "./config.js";
import { LocalEdgeKit_buildManifestFromConfig } from "./render-manifest.js";

void test("LocalEdgeKit_buildManifestFromConfig maps surfaces through render route groups", () => {
  const config = defineLocalEdgeConfig({
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
          composeProjectNamePrefix: "local-edge-router",
        },
      ],
    },
    render: {
      upstreams: [
        { id: "web-upstream", host: "127.0.0.1", port: 3000, protocol: "http" },
        { id: "api-upstream", host: "127.0.0.1", port: 4000, protocol: "http" },
      ],
      routeGroups: [
        {
          id: "web-group",
          surfaceHeader: "web",
          hostnameSurfaceIds: ["web", "locale"],
          upstreamId: "web-upstream",
          upstreamPortKey: "web",
          variableSuffix: "web",
          websocketSafe: true,
        },
        {
          id: "api-group",
          surfaceHeader: "api",
          hostnameSurfaceIds: ["api"],
          upstreamId: "api-upstream",
          upstreamPortKey: "api",
          variableSuffix: "api",
          websocketSafe: false,
        },
      ],
      routerIngress: {
        healthPath: "/router-health",
        healthBody: "ok\\n",
      },
      nginxHttp: {
        generatedBy: "example-renderer",
        mimeTypesPath: "/etc/nginx/mime.types",
        workerProcesses: 1,
        workerConnections: 1024,
        keepaliveTimeoutSeconds: 65,
        serverNamesHashBucketSize: 128,
        variablesHashBucketSize: 128,
        variablesHashMaxSize: 2048,
        clientBodyTimeoutSeconds: 60,
        clientMaxBodySize: "5m",
        proxyConnectTimeoutSeconds: 30,
        proxyReadTimeoutSeconds: 60,
        proxySendTimeoutSeconds: 60,
        sendTimeoutSeconds: 60,
        timeoutCommentLines: [],
        dockerResolver: null,
      },
      nginxDocker: {
        certPath: "/cert.pem",
        keyPath: "/key.pem",
        configTargetPath: "/etc/nginx/nginx.conf",
        serviceName: "edge-router",
        image: "nginx:stable",
        restartPolicy: "unless-stopped",
        defaultUpstreamHost: "host.docker.internal",
        labels: ["local-edge=true"],
      },
    },
    surfaces: [
      {
        id: "web",
        appPath: "/",
        statusPath: "/status",
      },
      {
        id: "locale",
        appPath: "/",
        statusPath: "/status",
      },
      {
        id: "api",
        appPath: "/api",
        statusPath: "/api/status",
        render: {
          availability: {
            state: "local-edge-surface-availability-optional",
            expectedAbsentStatuses: [404],
          },
        },
      },
    ],
  });

  assert.deepEqual(
    LocalEdgeKit_buildManifestFromConfig({
      config,
      packageName: "example-package",
    }),
    {
      schemaVersion: 1,
      packageName: "example-package",
      methods: ["nginx-docker"],
      upstreams: [
        { id: "web-upstream", host: "127.0.0.1", port: 3000, protocol: "http" },
        { id: "api-upstream", host: "127.0.0.1", port: 4000, protocol: "http" },
      ],
      surfaces: [
        {
          id: "web",
          hostLabel: "web",
          upstreamId: "web-upstream",
          routeGroupId: "web-group",
          appPath: "/",
          statusPath: "/status",
          availability: { state: "local-edge-surface-availability-required" },
        },
        {
          id: "locale",
          hostLabel: "locale",
          upstreamId: "web-upstream",
          routeGroupId: "web-group",
          appPath: "/",
          statusPath: "/status",
          availability: { state: "local-edge-surface-availability-required" },
        },
        {
          id: "api",
          hostLabel: "api",
          upstreamId: "api-upstream",
          routeGroupId: "api-group",
          appPath: "/api",
          statusPath: "/api/status",
          availability: {
            state: "local-edge-surface-availability-optional",
            expectedAbsentStatuses: [404],
          },
        },
      ],
    },
  );
});
