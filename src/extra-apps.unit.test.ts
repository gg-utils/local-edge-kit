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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { LocalEdgeCore_ExposureHostnamesConfig } from "@gg-utils/local-edge-core/exposure";

import {
  type LocalEdgeKit_ExtraAppsSource,
  LocalEdgeKit_createExtraAppsFileSource,
  LocalEdgeKit_jsonErrorPosition,
  LocalEdgeKit_jsonFirstErrorOffset,
  LocalEdgeKit_mergeExtraApps,
  LocalEdgeKit_parseExtraAppsJson,
  LOCAL_EDGE_KIT_RESERVED_APP_IDS,
} from "./extra-apps.js";
import { LocalEdgeKit_readFileSafe } from "./safe-write.js";

function scratch(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "kit-extra-apps-")));
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
    /local-edge-kit-safe-read-symlink: refusing to read below symlinked folder/,
  );
  assert.throws(() => LocalEdgeKit_readFileSafe(path.join(elsewhere, "apps.json"), { root }), /outside-root/);
  mkdirSync(path.join(root, "dir.json"));
  assert.throws(() => LocalEdgeKit_readFileSafe(path.join(root, "dir.json"), { root }), /local-edge-kit-safe-read-not-file/);
  assert.equal(LocalEdgeKit_readFileSafe(path.join(root, "missing", "deeper", "apps.json"), { root }), null);
});

void test("parse: shape problems are listed together with the source name", () => {
  assert.throws(() => LocalEdgeKit_parseExtraAppsJson("{", "src.json"), /src\.json: not valid JSON \(line 1, column 2\)/);
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

const MARKER = "TOPSECRETMARKER";

void test("file source: a file others can write is refused with the path and the rule, never the content", () => {
  const root = scratch();
  const file = path.join(root, "apps.json");
  writeFileSync(file, playJson, { mode: 0o600 });
  for (const mode of [0o666, 0o620, 0o602]) {
    chmodSync(file, mode);
    assert.throws(
      () => LocalEdgeKit_createExtraAppsFileSource({ filePath: file }).load(),
      (error: Error) =>
        error.message.startsWith("local-edge-kit-safe-read-unsafe-mode:") &&
        error.message.includes(file) &&
        error.message.includes("0600") &&
        !error.message.includes("play.m1"),
    );
  }
  chmodSync(file, 0o600);
  assert.equal(LocalEdgeKit_createExtraAppsFileSource({ filePath: file }).load().length, 2);
  chmodSync(root, 0o777);
  assert.throws(() => LocalEdgeKit_createExtraAppsFileSource({ filePath: file }).load(), /local-edge-kit-safe-read-unsafe-mode: folder /);
});

void test("parse: a syntax error gives a fixed message and the position, never file content", () => {
  for (const text of [`${MARKER}`, `{"apps": [ ${MARKER} ]}`, `{\n  "apps" ${MARKER}`, `{"${MARKER}": }`]) {
    assert.throws(
      () => LocalEdgeKit_parseExtraAppsJson(text, "src.json"),
      (error: Error) =>
        /^local-edge-kit-extra-apps-invalid: src\.json: not valid JSON \((line \d+, column \d+|position not reported)\)$/.test(error.message) &&
        !error.message.includes("TOPSECRET"),
    );
  }
});

void test("parse: the position is computed here, so a multi-line file gets line and column on every engine", () => {
  // Offsets are hand-counted: the first character that is not allowed is on line 3, column 5.
  const text = `{\n  "apps": [\n    ${MARKER}\n  ]\n}`;
  assert.throws(
    () => LocalEdgeKit_parseExtraAppsJson(text, "src.json"),
    (error: Error) =>
      error.message === "local-edge-kit-extra-apps-invalid: src.json: not valid JSON (line 3, column 5)" && !error.message.includes(MARKER),
  );
  assert.throws(
    () => LocalEdgeKit_parseExtraAppsJson('{\r\n  "apps": [],\r\n}', "src.json"),
    /not valid JSON \(line 3, column 1\)$/,
  );
});

void test("json position: the first offending offset comes from our own scan, whatever the engine says", () => {
  const cases: [string, number | null][] = [
    ["", 0],
    ["{", 1],
    ['{"a": 1,}', 8],
    ['{"a" 1}', 5],
    ['{"a":}', 5],
    ["[1,]", 3],
    ["[1 2]", 3],
    ["tru", 3],
    ["trux", 3],
    ["nul1", 3],
    ['{"a": 01}', 7],
    ["1.", 2],
    ["-", 1],
    ['"abc', 4],
    ['"a\nb"', 2],
    ['"\\x"', 2],
    ['"\\u12G4"', 5],
    ['{"a":1} x', 8],
    ["[1]]", 3],
    ["\ufeff{}", 0],
    ["{}", null],
    ["  [1, -2.5e+3, 0, \"a\\u00e9\\n\", true, false, null, {\"k\": []}]\n", null],
  ];
  for (const [text, expected] of cases) {
    assert.equal(LocalEdgeKit_jsonFirstErrorOffset(text), expected, JSON.stringify(text));
    let valid = true;
    try {
      JSON.parse(text);
    } catch {
      valid = false;
    }
    assert.equal(expected === null, valid, `scan and JSON.parse agree on validity: ${JSON.stringify(text)}`);
  }
  // Deep nesting is scanned without recursion: no stack overflow, and the end of input is the failure.
  assert.equal(LocalEdgeKit_jsonFirstErrorOffset("[".repeat(200_000)), 200_000);
});

void test("json position: engine offset when it is inside the text, our scan otherwise, never the engine's words", () => {
  const text = '{\n  "a" 1\n}';
  // The engine gave offset 3 (the second character of line 2): used as it is, and its words are not repeated.
  const fromEngine = LocalEdgeKit_jsonErrorPosition(text, new Error(`${MARKER} at position 3`));
  assert.equal(fromEngine, "line 2, column 2");
  // No offset in the message, or one past the end: our scan finds the `1` where a colon belongs
  // (offset 8, the seventh character of line 2).
  assert.equal(LocalEdgeKit_jsonErrorPosition(text, new Error(`${MARKER} with no position`)), "line 2, column 7");
  assert.equal(LocalEdgeKit_jsonErrorPosition(text, new Error("at position 9999")), "line 2, column 7");
  assert.equal(LocalEdgeKit_jsonErrorPosition(text, "not an error object"), "line 2, column 7");
  // Text the scan finds valid: nothing to report.
  assert.equal(LocalEdgeKit_jsonErrorPosition("{}", new Error("weird")), "position not reported");
});

void test("parse: unknown keys are refused at the top level, the app level and the location level", () => {
  const app = { id: "play", host: "play.m1.example.test", upstream: "127.0.0.1:5174" };
  assert.throws(
    () => LocalEdgeKit_parseExtraAppsJson(JSON.stringify({ apps: [{ ...app, upstreamhost: "127.0.0.1:5174" }] }), "src.json"),
    /play: unknown key "upstreamhost"/,
  );
  assert.throws(
    () => LocalEdgeKit_parseExtraAppsJson(JSON.stringify({ apps: [{ ...app, command: "rm -rf x" }] }), "src.json"),
    /play: unknown key "command"/,
  );
  assert.throws(
    () => LocalEdgeKit_parseExtraAppsJson(JSON.stringify({ apps: [{ ...app, locations: [{ path: "/a", upstream: "127.0.0.1:2", upstreampath: "/x" }] }] }), "src.json"),
    /play: locations\[0\]: unknown key "upstreampath"/,
  );
  assert.throws(() => LocalEdgeKit_parseExtraAppsJson(JSON.stringify({ apps: [], appz: [] }), "src.json"), /top level: unknown key "appz"/);
  // A key that is not a short plain token is not echoed; its number in the object is given instead.
  const odd = `{"apps":[{"id":"play","host":"play.m1.example.test","upstream":"127.0.0.1:5174","${MARKER} with spaces; and more":1}]}`;
  assert.throws(
    () => LocalEdgeKit_parseExtraAppsJson(odd, "src.json"),
    (error: Error) => /play: unknown key \(key number 4 in the object\)/.test(error.message) && !error.message.includes("TOPSECRET"),
  );
  // Every known key still passes.
  assert.equal(LocalEdgeKit_parseExtraAppsJson(playJson, "src.json").length, 2);
});

void test("merge: hosts compare after lowercasing and dropping a trailing dot, and the error names both sources", () => {
  const source = (name: string, json: string): LocalEdgeKit_ExtraAppsSource => ({ name, load: () => LocalEdgeKit_parseExtraAppsJson(json, name) });
  const one = (id: string, host: string) => JSON.stringify({ apps: [{ id, host, upstream: "127.0.0.1:9" }] });
  assert.throws(
    () =>
      LocalEdgeKit_mergeExtraApps({
        apps: [],
        sources: [source("a", one("first", "a.example.test")), source("b", one("second", "A.Example.test."))],
        hostnames,
      }),
    /duplicate hostname a\.example\.test: first \(a\) and second \(b\)/,
  );
  assert.throws(
    () =>
      LocalEdgeKit_mergeExtraApps({
        apps: [{ id: "web", enabled: true, external: true, localPort: 3210, healthPath: "/", host: "Web.Proj.Example.test." }],
        sources: [source("machine", one("other", "web.proj.example.test"))],
        hostnames,
      }),
    /duplicate hostname web\.proj\.example\.test: web \(project\) and other \(machine\)/,
  );
  assert.throws(
    () =>
      LocalEdgeKit_mergeExtraApps({
        apps: [{ id: "Play", enabled: true, external: true, localPort: 3210, healthPath: "/", host: "p1.example.test" }],
        sources: [source("b", one("play", "p2.example.test"))],
        hostnames,
      }),
    /duplicate app id play: project and b/,
  );
});

void test("merge: the id router is reserved for the supervisor and refused with a named error", () => {
  const source: LocalEdgeKit_ExtraAppsSource = {
    name: "machine",
    load: () => LocalEdgeKit_parseExtraAppsJson(JSON.stringify({ apps: [{ id: "router", host: "r.m1.example.test", upstream: "127.0.0.1:9" }] }), "machine"),
  };
  assert.throws(
    () => LocalEdgeKit_mergeExtraApps({ apps: [], sources: [source], hostnames }),
    /^Error: local-edge-kit-extra-apps-reserved-id: machine: app id router is reserved/,
  );
  assert.deepEqual(LOCAL_EDGE_KIT_RESERVED_APP_IDS, ["router"]);
});

void test("merge: the reserved id is checked after normalising case and trailing dots (ROUTER., Router.., router)", () => {
  for (const id of ["router", "Router", "ROUTER", "ROUTER.", "router..", "Router.."]) {
    const source: LocalEdgeKit_ExtraAppsSource = {
      name: "custom",
      load: () => [{ id, host: "r.m1.example.test", upstream: "127.0.0.1:9" }],
    };
    assert.throws(
      () => LocalEdgeKit_mergeExtraApps({ apps: [], sources: [source], hostnames }),
      (error: Error) => error.message.startsWith("local-edge-kit-extra-apps-reserved-id: custom: app id ") && error.message.includes("is reserved"),
      id,
    );
  }
  // Near misses stay allowed, and a trailing dot also collides with its plain twin as a duplicate id.
  const ok: LocalEdgeKit_ExtraAppsSource = { name: "custom", load: () => [{ id: "routers", host: "r.m1.example.test", upstream: "127.0.0.1:9" }] };
  assert.equal(LocalEdgeKit_mergeExtraApps({ apps: [], sources: [ok], hostnames }).length, 1);
  const twins: LocalEdgeKit_ExtraAppsSource = {
    name: "custom",
    load: () => [
      { id: "play", host: "a.m1.example.test", upstream: "127.0.0.1:9" },
      { id: "PLAY.", host: "b.m1.example.test", upstream: "127.0.0.1:9" },
    ],
  };
  assert.throws(() => LocalEdgeKit_mergeExtraApps({ apps: [], sources: [twins], hostnames }), /local-edge-kit-extra-apps-conflict: duplicate app id PLAY\./);
});

void test("merge: a reserved id from a custom source is named only when it is short and plain", () => {
  const source = (id: string): LocalEdgeKit_ExtraAppsSource => ({
    name: "custom",
    load: () => [{ id, host: "r.m1.example.test", upstream: "127.0.0.1:9" }],
  });
  assert.throws(() => LocalEdgeKit_mergeExtraApps({ apps: [], sources: [source("ROUTER...")], hostnames }), /app id ROUTER\.\.\. is reserved/);
  const long = `router${".".repeat(60)}`;
  assert.throws(
    () => LocalEdgeKit_mergeExtraApps({ apps: [], sources: [source(long)], hostnames }),
    (error: Error) => error.message.includes("app id <66 characters> is reserved") && !error.message.includes(long),
  );
});

void test("README: the extra-apps section says exactly what the code checks (write access and owner, not read access)", () => {
  const readme = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
  assert.ok(!/checked like a secret/.test(readme), "the README must not say the file is checked like a secret");
  assert.ok(readme.includes("not writable by group or others"), "the README should state the write rule");
  assert.ok(readme.includes("`0640`, `0644` and `0400` all pass"), "the README should say read-only group/other modes pass");
  assert.ok(readme.includes("everything above `root` are trusted"), "the README should say what is not checked");
  assert.ok(!/#v0\.5\.0/.test(readme), "install examples point at the current tag");
});

void test("parse: ids are 1 to 63 lowercase letters, digits and dashes and hosts have the shape of a host name, never echoed", () => {
  const app = (id: string, host: string): string => JSON.stringify({ apps: [{ id, host, upstream: "127.0.0.1:9" }] });
  const refusal = (json: string): string => {
    try {
      LocalEdgeKit_parseExtraAppsJson(json, "src.json");
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail("expected a throw");
  };
  assert.equal(LocalEdgeKit_parseExtraAppsJson(app("a".repeat(63), "a.b-c.example.test"), "src.json")[0]?.id.length, 63);
  assert.equal(LocalEdgeKit_parseExtraAppsJson(app("play", "Play.Example.test."), "src.json").length, 1);
  assert.match(refusal(app("a".repeat(64), "p.example.test")), /apps\[0\]: id must be 1 to 63 lowercase letters, digits and dashes/);
  for (const host of [`${MARKER} x.example.test`, `a.example.test/${MARKER}`, `${MARKER}\n.example.test`, "a..example.test", "-a.example.test", "a".repeat(64) + ".example.test", `${"a.".repeat(130)}test`]) {
    const message = refusal(app("play", host));
    assert.match(message, /^local-edge-kit-extra-apps-invalid: src\.json: play: host must be a host name of letters, digits, dots and dashes/, host);
    assert.ok(!message.includes(MARKER), message);
  }
  // The long id is not echoed either: the problem is numbered by its place in the file.
  assert.ok(!refusal(app("a".repeat(64), "p.example.test")).includes("a".repeat(64)));
});

void test("merge: ids and hosts in conflict messages go through the word helper, so a custom source cannot push long or odd text into them", () => {
  const custom = (name: string, id: string, host: string): LocalEdgeKit_ExtraAppsSource => ({
    name,
    load: () => [{ id, host, upstream: "127.0.0.1:9" }],
  });
  const odd = `${MARKER} id with spaces`;
  assert.throws(
    () =>
      LocalEdgeKit_mergeExtraApps({
        apps: [],
        sources: [custom("a", odd, "a.example.test"), custom("b", odd, "b.example.test")],
        hostnames,
      }),
    (error: Error) => /duplicate app id <\d+ characters>: a and b/.test(error.message) && !error.message.includes(MARKER),
  );
  const longHost = `${"h".repeat(60)}.example.test`;
  assert.throws(
    () =>
      LocalEdgeKit_mergeExtraApps({
        apps: [],
        sources: [custom("a", "one", longHost), custom("b", "two", longHost)],
        hostnames,
      }),
    (error: Error) => /duplicate hostname <\d+ characters>: one \(a\) and two \(b\)/.test(error.message) && !error.message.includes("h".repeat(60)),
  );
});
