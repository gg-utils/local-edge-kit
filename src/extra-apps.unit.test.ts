/**
 * @fileoverview Verifies per-machine extra apps: the careful file read (missing file, symlink and
 * outside-root refusal), JSON validation, conversion to route-only apps with proxy overrides, and
 * the merge that refuses duplicate ids and hostnames across sources.
 *
 * @testing Node test runner (tsx): npm run test -- src/extra-apps.unit.test.ts
 *
 * @see src/extra-apps.ts - Module under test.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { LocalEdgeCore_ExposureHostnamesConfig } from "@gg-utils/local-edge-core/exposure";

import {
  type LocalEdgeKit_ExtraAppsSource,
  LocalEdgeKit_createExtraAppsFileSource,
  LocalEdgeKit_mergeExtraApps,
  LocalEdgeKit_parseExtraAppsJson,
  LocalEdgeKit_readFileSafe,
} from "./extra-apps.js";

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), "kit-extra-apps-"));
}

const hostnames: LocalEdgeCore_ExposureHostnamesConfig = {
  projectMachineLabel: "proj-m1",
  rootZone: "example.test",
  realm: "main",
  extraWildcardTemplates: ["*.m1.{rootZone}"],
  routerHost: "127.0.0.1",
  routerPort: 8460,
  tls: { mode: "provided", certPath: "/st/tls/wildcard.crt", keyPath: "/st/tls/wildcard.key" },
  nginx: {
    confPath: "/st/nginx/nginx.conf",
    pidPath: "/st/nginx/nginx.pid",
    errorLogPath: "/st/logs/nginx-error.log",
    accessLogPath: "/st/logs/nginx-access.log",
    tempDir: "/st/nginx/tmp",
  },
};

const playJson = JSON.stringify({
  apps: [
    {
      id: "play",
      host: "play.m1.example.test",
      upstream: "127.0.0.1:5174",
      upstreamHost: "127.0.0.1:5174",
      buffering: false,
      readTimeout: "3600s",
      locations: [{ path: "/api", upstream: "127.0.0.1:33114", buffering: false, readTimeout: "3600s" }],
    },
    { id: "search", host: "search.m1.example.test", upstream: "127.0.0.1:8765" },
  ],
});

void test("file source: missing file is empty, real file loads, symlinks and outside paths are refused", () => {
  const root = scratch();
  const file = path.join(root, "apps.json");
  assert.deepEqual(LocalEdgeKit_createExtraAppsFileSource({ filePath: file }).load(), []);
  assert.deepEqual(LocalEdgeKit_createExtraAppsFileSource({ filePath: path.join(root, "nope", "apps.json"), root }).load(), []);
  writeFileSync(file, playJson, { mode: 0o600 });
  const apps = LocalEdgeKit_createExtraAppsFileSource({ filePath: file }).load();
  assert.deepEqual(apps.map((app) => app.id), ["play", "search"]);

  const link = path.join(root, "link.json");
  symlinkSync(file, link);
  assert.throws(() => LocalEdgeKit_readFileSafe(link, { root }), /local-edge-kit-safe-read-symlink/);

  const elsewhere = scratch();
  writeFileSync(path.join(elsewhere, "apps.json"), playJson);
  mkdirSync(path.join(root, "sub"));
  symlinkSync(elsewhere, path.join(root, "sub", "out"));
  assert.throws(
    () => LocalEdgeKit_readFileSafe(path.join(root, "sub", "out", "apps.json"), { root }),
    /local-edge-kit-safe-read-outside-root/,
  );
  assert.throws(() => LocalEdgeKit_readFileSafe(path.join(elsewhere, "apps.json"), { root }), /outside-root/);
});

void test("parse: shape problems are listed together with the source name", () => {
  assert.throws(() => LocalEdgeKit_parseExtraAppsJson("{", "src.json"), /src\.json: not JSON/);
  assert.throws(() => LocalEdgeKit_parseExtraAppsJson("[]", "src.json"), /expected an object with an "apps" array/);
  const bad = JSON.stringify({
    apps: [
      { id: "Bad Id", host: "x.m1.example.test", upstream: "127.0.0.1:1" },
      { id: "far", host: "far.m1.example.test", upstream: "10.0.0.1:80" },
      { id: "loc", host: "loc.m1.example.test", upstream: "127.0.0.1:2", buffering: "no", locations: [{ path: "/a", upstream: "x" }] },
    ],
  });
  assert.throws(
    () => LocalEdgeKit_parseExtraAppsJson(bad, "src.json"),
    (error: Error) =>
      /apps\[0\]: id must be/.test(error.message) &&
      /far: upstream must be 127\.0\.0\.1:<port>/.test(error.message) &&
      /loc: buffering must be true or false/.test(error.message) &&
      /loc: locations\[0\]: upstream must be/.test(error.message),
  );
});

void test("merge: extra apps become route-only apps with their source and proxy overrides", () => {
  const source: LocalEdgeKit_ExtraAppsSource = { name: "machine", load: () => LocalEdgeKit_parseExtraAppsJson(playJson, "machine") };
  const merged = LocalEdgeKit_mergeExtraApps({
    apps: [{ id: "web", enabled: true, localPort: 3210, healthPath: "/", cwd: "/w", command: "x", pidFile: "p", logFile: "l" }],
    sources: [source],
    hostnames,
  });
  assert.deepEqual(merged.map((app) => [app.id, app.source]), [["web", "project"], ["play", "machine"], ["search", "machine"]]);
  const play = merged.find((app) => app.id === "play");
  assert.equal(play?.external, true);
  assert.equal(play?.localPort, 5174);
  assert.equal(play?.host, "play.m1.example.test");
  assert.deepEqual(play?.proxy, { upstreamHost: "127.0.0.1:5174", buffering: false, readTimeout: "3600s" });
  assert.deepEqual(play?.locations, [{ path: "/api", localPort: 33114, upstreamPath: "", buffering: false, readTimeout: "3600s" }]);
  assert.deepEqual(merged.find((app) => app.id === "search")?.proxy, {});
});

void test("merge: duplicate hostnames and ids across sources are refused by name", () => {
  const source = (name: string, json: string): LocalEdgeKit_ExtraAppsSource => ({ name, load: () => LocalEdgeKit_parseExtraAppsJson(json, name) });
  assert.throws(
    () =>
      LocalEdgeKit_mergeExtraApps({
        apps: [{ id: "web-rebuild", enabled: true, external: true, localPort: 3210, healthPath: "/" }],
        sources: [source("machine", JSON.stringify({ apps: [{ id: "other", host: "web-rebuild.proj-m1.example.test", upstream: "127.0.0.1:9" }] }))],
        hostnames,
      }),
    /duplicate hostname web-rebuild\.proj-m1\.example\.test: web-rebuild \(project\) and other \(machine\)/,
  );
  assert.throws(
    () =>
      LocalEdgeKit_mergeExtraApps({
        apps: [],
        sources: [source("a", playJson), source("b", JSON.stringify({ apps: [{ id: "play", host: "p2.m1.example.test", upstream: "127.0.0.1:9" }] }))],
        hostnames,
      }),
    /duplicate app id play: a and b/,
  );
});
