/**
 * @fileoverview Regression tests for `LocalEdgeKit_runDnsAuditCommand` covering split-DNS audit
 * success and strict mismatch failure without live resolver or container I/O.
 *
 * This file owns Node test coverage that builds ephemeral project roots, macOS-style resolver
 * stubs, generated `realms.json`, and injectable `LocalEdgeKit_DnsAuditOperations` doubles so the
 * audit runner’s exit codes, log lines, and artifact summary stay deterministic.
 * Flow: temp dirs + resolver/registry fixtures -> stubbed DNS resolutions -> assert exit, logs, and artifact text.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/dns-audit-cli.unit.test.ts
 *
 * @see packages/local-edge-kit/src/dns-audit-cli.ts - DNS audit command runner and `LocalEdgeKit_DnsAuditOperations` contract under test; owns orchestration asserted here.
 * @see packages/local-edge-kit/src/config.ts - `defineLocalEdgeConfig` fixture builder supplying dns-audit, env, identity, router, and surface slices used by these tests.
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
  LocalEdgeKit_runDnsAuditCommand,
  type LocalEdgeKit_DnsAuditOperations,
} from "./dns-audit-cli.js";

function createTestConfig(options: { resolverDir: string }) {
  return defineLocalEdgeConfig({
    cli: {
      commandName: "local-edge",
      logPrefix: "local-edge",
    },
    dnsAudit: {
      artifactPath: "logs/local-edge/artifacts/dns-audit-last-run.txt",
      directProbeUtilityName: "dig",
      listenAddressEnvName: "LOCAL_EDGE_SPLIT_DNS_LISTEN_ADDRESS",
      methodIpEnvNames: {
        "nginx-docker": "LOCAL_EDGE_SPLIT_DNS_NGINX_DOCKER_IP",
      },
      portEnvName: "LOCAL_EDGE_SPLIT_DNS_PORT",
      resolverDir: options.resolverDir,
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
    surfaces: [
      {
        id: "app",
        appPath: "/",
        statusPath: "/status",
        dnsAudit: {
          include: true,
        },
      },
      {
        id: "not-audited",
        appPath: "/",
        statusPath: "/health",
      },
    ],
  });
}

async function createTempRoot(): Promise<{
  generatedDir: string;
  projectRoot: string;
  resolverDir: string;
}> {
  const projectRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "local-edge-kit-dns-audit-"),
  );
  const generatedDir = path.join(projectRoot, ".tmp", "local-edge");
  const resolverDir = path.join(projectRoot, "resolver");
  await fs.mkdir(path.join(generatedDir, "registry"), { recursive: true });
  await fs.mkdir(resolverDir, { recursive: true });
  return { generatedDir, projectRoot, resolverDir };
}

async function writeRegistry(options: {
  generatedDir: string;
  projectRoot: string;
}): Promise<void> {
  await fs.writeFile(
    path.join(options.generatedDir, "registry", "realms.json"),
    JSON.stringify(
      {
        realms: {
          main: {
            realmSlug: "main",
            status: "active",
            primaryMethod: "nginx-docker",
            developerSlug: "tester",
            rootZone: "local.test",
            workspacePath: options.projectRoot,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

test("LocalEdgeKit_runDnsAuditCommand validates resolver, listener, and realm targets", async () => {
  const { generatedDir, projectRoot, resolverDir } = await createTempRoot();
  await fs.writeFile(
    path.join(resolverDir, "local.test"),
    "nameserver 127.0.0.1\nport 53535\ntimeout 1\n",
    "utf8",
  );
  await writeRegistry({ generatedDir, projectRoot });

  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const operations: LocalEdgeKit_DnsAuditOperations = {
    async readTextFile(filePath) {
      return await fs.readFile(filePath, "utf8");
    },
    async isDnsListenerAvailable() {
      return true;
    },
    async isDirectProbeUtilityAvailable() {
      return true;
    },
    async resolveSystemHost(hostname) {
      assert.equal(hostname, "app.main.nginx-docker.tester.local.test");
      return "127.0.0.1";
    },
    async resolveDirectHost(options) {
      assert.equal(options.hostname, "app.main.nginx-docker.tester.local.test");
      return "127.0.0.1";
    },
  };

  const exitCode = await LocalEdgeKit_runDnsAuditCommand({
    args: [],
    config: createTestConfig({ resolverDir }),
    env: {
      LOCAL_EDGE_DEVELOPER_SLUG: "tester",
      LOCAL_EDGE_ENV_FILE: path.join(projectRoot, ".env.local-edge"),
      LOCAL_EDGE_ENV_SLUG: "main",
      LOCAL_EDGE_GENERATED_DIR: generatedDir,
      LOCAL_EDGE_PROJECT_ROOT: projectRoot,
      LOCAL_EDGE_ROOT_ZONE: "local.test",
      LOCAL_EDGE_SPLIT_DNS_NGINX_DOCKER_IP: "127.0.0.1",
      USER: "tester",
    },
    operations,
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
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(warnings, []);
  assert.deepEqual(errors, []);
  assert.ok(logs.includes("[local-edge:dns-audit] OK resolver.file.exists"));
  assert.ok(logs.includes("[local-edge:dns-audit] OK system.main.app"));
  assert.ok(logs.includes("[local-edge:dns-audit] OK direct.main.app"));

  const artifact = await fs.readFile(
    path.join(
      projectRoot,
      "logs",
      "local-edge",
      "artifacts",
      "dns-audit-last-run.txt",
    ),
    "utf8",
  );
  assert.match(artifact, /checksFailed=0/);
  assert.match(artifact, /method=nginx-docker/);
});

test("LocalEdgeKit_runDnsAuditCommand returns strict failure for DNS mismatches", async () => {
  const { generatedDir, projectRoot, resolverDir } = await createTempRoot();
  await fs.writeFile(
    path.join(resolverDir, "local.test"),
    "nameserver 127.0.0.1\nport 53535\n",
    "utf8",
  );
  await writeRegistry({ generatedDir, projectRoot });

  const exitCode = await LocalEdgeKit_runDnsAuditCommand({
    args: ["--strict", "--skip-direct-probe"],
    config: createTestConfig({ resolverDir }),
    env: {
      LOCAL_EDGE_DEVELOPER_SLUG: "tester",
      LOCAL_EDGE_ENV_FILE: path.join(projectRoot, ".env.local-edge"),
      LOCAL_EDGE_ENV_SLUG: "main",
      LOCAL_EDGE_GENERATED_DIR: generatedDir,
      LOCAL_EDGE_PROJECT_ROOT: projectRoot,
      LOCAL_EDGE_ROOT_ZONE: "local.test",
      LOCAL_EDGE_SPLIT_DNS_NGINX_DOCKER_IP: "127.0.0.1",
      USER: "tester",
    },
    operations: {
      async readTextFile(filePath) {
        return await fs.readFile(filePath, "utf8");
      },
      async isDnsListenerAvailable() {
        return true;
      },
      async isDirectProbeUtilityAvailable() {
        return true;
      },
      async resolveSystemHost() {
        return "127.0.0.2";
      },
      async resolveDirectHost() {
        return "127.0.0.2";
      },
    },
    output: {
      log() {},
      warn() {},
      error() {},
    },
  });

  assert.equal(exitCode, 1);
});
