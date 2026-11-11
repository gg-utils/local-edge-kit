/**
 * @fileoverview Node test coverage for helper-server port precedence and non-canonical realm
 * collision guards in `@gg-utils/local-edge-kit`.
 *
 * This file owns regression tests for `LocalEdgeKit_resolveHelperServerPort`: CLI flags win over
 * active env-file values, active env files win over process env, and non-canonical realms cannot
 * bind the canonical default port.
 * Flow: inject argv/env/operations -> assert resolved `{ port, source }` or expected throw.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/helper-server-config.unit.test.ts
 *
 * @see packages/local-edge-kit/src/helper-server-config.ts - Resolver module under test that defines the precedence chain, env parsing, and non-canonical default-port refusal asserted here.
 * @see consumer local-edge adapter - consumer adapter that forwards logs-web port flags and env keys into this resolver before the helper binds.
 * @see consumer local-edge adapter - consumer adapter that wires platform-status helper inputs through the same resolver contract exercised here.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LocalEdgeKit_resolveHelperServerPort } from "./helper-server-config.js";

const baseOptions = {
  activeEnvFilePaths: ["/virtual/.env.local-edge"],
  argv: [],
  canonicalRealmSlug: "main",
  defaultPort: 9011,
  env: {},
  portEnvName: "LOCAL_EDGE_HELPER_PORT",
  portFlags: ["--port"],
  realmSlugEnvName: "LOCAL_EDGE_ENV_SLUG",
  serviceLabel: "helper-web",
};

void test("LocalEdgeKit_resolveHelperServerPort prefers CLI flags", () => {
  assert.deepEqual(
    LocalEdgeKit_resolveHelperServerPort({
      ...baseOptions,
      argv: ["--port=19011"],
      operations: {
        exists: () => true,
        readText: () =>
          "LOCAL_EDGE_ENV_SLUG=other\nLOCAL_EDGE_HELPER_PORT=19012\n",
      },
    }),
    { port: 19011, source: "cli" },
  );
});

void test("LocalEdgeKit_resolveHelperServerPort reads active env files before process env", () => {
  assert.deepEqual(
    LocalEdgeKit_resolveHelperServerPort({
      ...baseOptions,
      env: { LOCAL_EDGE_HELPER_PORT: "19013" },
      operations: {
        exists: () => true,
        readText: () =>
          "LOCAL_EDGE_ENV_SLUG=main\nLOCAL_EDGE_HELPER_PORT='19012'\n",
      },
    }),
    { port: 19012, source: "active-env" },
  );
});

void test("LocalEdgeKit_resolveHelperServerPort rejects non-canonical default collisions", () => {
  assert.throws(
    () =>
      LocalEdgeKit_resolveHelperServerPort({
        ...baseOptions,
        env: { LOCAL_EDGE_ENV_SLUG: "preview" },
        operations: {
          exists: () => true,
          readText: () => "LOCAL_EDGE_HELPER_PORT=9011\n",
        },
      }),
    /Refusing to bind non-canonical realm 'preview'/,
  );
});
