/**
 * @fileoverview Verifies URL-matrix line rendering and related runtime-config validation for the
 * local-edge kit from typed `defineLocalEdgeConfig` fixtures.
 *
 * This file owns regression coverage for `LocalEdgeKit_buildUrlMatrixLines` (surface inclusion,
 * HTTPS hostnames, bind annotations) plus `LocalEdgeKit_resolveRuntimeConfig` rejection of
 * unsupported `LOCAL_EDGE_METHODS` values.
 * Flow: build config -> resolve runtime from env -> assert matrix lines or thrown resolver errors.
 *
 * @testing Node.js node:test via tsx: npm run test --prefix packages/local-edge-kit
 *
 * @see packages/local-edge-kit/src/url-matrix.ts - URL-matrix line builder under test whose labeled HTTPS URLs, status paths, and `includeInUrlMatrix` filtering are asserted here.
 * @see packages/local-edge-kit/src/runtime-config.ts - Runtime resolver that normalizes env-derived developer/realm slugs and method selection consumed by the matrix scenarios and the unsupported-method negative test.
 * @see packages/local-edge-kit/src/config.ts - `defineLocalEdgeConfig` and router/surface shapes used to build deterministic nginx-docker fixtures driving these assertions.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import { defineLocalEdgeConfig } from "./config.js";
import { LocalEdgeKit_resolveRuntimeConfig } from "./runtime-config.js";
import { LocalEdgeKit_buildUrlMatrixLines } from "./url-matrix.js";

void test("LocalEdgeKit_buildUrlMatrixLines renders configured surfaces and paths", () => {
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
          defaultListenPort: 8443,
          composeProjectNamePrefix: "local-edge-nginx-docker",
        },
      ],
    },
    surfaces: [
      {
        id: "web",
        appPath: "/",
        statusPath: "/status",
      },
      {
        id: "admin",
        appPath: "/admin",
        statusPath: "/admin/status",
      },
      {
        id: "internal",
        appPath: "/internal",
        statusPath: "/internal/status",
        includeInUrlMatrix: false,
      },
    ],
  });
  const runtimeConfig = LocalEdgeKit_resolveRuntimeConfig({
    config,
    env: {
      LOCAL_EDGE_DEVELOPER_SLUG: "alice",
      LOCAL_EDGE_ENV_SLUG: "preview",
      LOCAL_EDGE_GENERATED_DIR: "/tmp/example-local-edge",
    },
    projectRoot: "/tmp/example-project",
  });

  assert.deepEqual(
    LocalEdgeKit_buildUrlMatrixLines({
      method: "nginx-docker",
      runtimeConfig,
    }),
    [
      "[local-edge:nginx-docker] URL matrix (background-ready, bind=127.0.0.1:8443):",
      "[local-edge:nginx-docker] app=web https://web.preview.nginx-docker.alice.example.test:8443/",
      "[local-edge:nginx-docker] status=web https://web.preview.nginx-docker.alice.example.test:8443/status",
      "[local-edge:nginx-docker] app=admin https://admin.preview.nginx-docker.alice.example.test:8443/admin",
      "[local-edge:nginx-docker] status=admin https://admin.preview.nginx-docker.alice.example.test:8443/admin/status",
    ],
  );
});

void test("LocalEdgeKit_resolveRuntimeConfig rejects unsupported configured methods", () => {
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
          composeProjectNamePrefix: "local-edge-nginx-docker",
        },
      ],
    },
    surfaces: [],
  });

  assert.throws(
    () =>
      LocalEdgeKit_resolveRuntimeConfig({
        config,
        env: {
          LOCAL_EDGE_METHODS: "unknown-method",
        },
        projectRoot: "/tmp/example-project",
      }),
    /Unsupported LOCAL_EDGE_METHODS value\(s\): unknown-method\./,
  );
});
