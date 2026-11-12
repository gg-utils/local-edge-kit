/**
 * @fileoverview Verifies `LocalEdgeKit_readFileSafe` against real temporary folders: files and
 * folders that group or others can write are refused (0666, 0620, 0602, 0777, 0770, sticky 1777),
 * a foreign owner is refused through an injected uid, 0600 in 0700 passes, a FIFO never blocks the
 * read (checked in a child process with a timeout), and the size cap holds both by `fstat` and
 * while reading.
 *
 * @testing Node test runner (tsx): npm run test -- src/safe-read.unit.test.ts
 *
 * @see src/safe-write.ts - Module under test.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LOCAL_EDGE_KIT_SAFE_READ_MAX_BYTES, LocalEdgeKit_readFileSafe } from "./safe-write.js";

const MARKER = "MARKER-CONTENT-4711";

function box(): { dir: string; file: string; done: () => void } {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "safe-read-")));
  const dir = path.join(base, "cfg");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = path.join(dir, "apps.json");
  writeFileSync(file, MARKER, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { dir, file, done: () => rmSync(base, { recursive: true, force: true }) };
}

function refused(run: () => unknown, code: string, ...mentions: string[]): void {
  assert.throws(run, (error: Error) => {
    assert.match(error.message, new RegExp(`^local-edge-kit-safe-read-${code}:`));
    assert.equal((error as Error & { code?: string }).code, `local-edge-kit-safe-read-${code}`);
    for (const text of mentions) {
      assert.ok(error.message.includes(text), `message should mention ${text}: ${error.message}`);
    }
    assert.ok(!error.message.includes(MARKER), "message must not carry file content");
    return true;
  });
}

void test("a 0600 file in a 0700 folder is read; 0644 and 0640 (read-only for others) too", () => {
  const b = box();
  try {
    assert.equal(LocalEdgeKit_readFileSafe(b.file, { root: b.dir }), MARKER);
    chmodSync(b.file, 0o644);
    assert.equal(LocalEdgeKit_readFileSafe(b.file, { root: b.dir }), MARKER);
    chmodSync(b.file, 0o640);
    assert.equal(LocalEdgeKit_readFileSafe(b.file, { root: b.dir }), MARKER);
    chmodSync(b.dir, 0o755);
    assert.equal(LocalEdgeKit_readFileSafe(b.file, { root: b.dir }), MARKER);
  } finally {
    b.done();
  }
});

void test("a file that group or others can write is refused with unsafe-mode naming the path", () => {
  const b = box();
  try {
    for (const mode of [0o666, 0o620, 0o602, 0o660, 0o606, 0o664, 0o646]) {
      chmodSync(b.file, mode);
      refused(() => LocalEdgeKit_readFileSafe(b.file, { root: b.dir }), "unsafe-mode", b.file, "0600");
    }
    chmodSync(b.file, 0o600);
    assert.equal(LocalEdgeKit_readFileSafe(b.file, { root: b.dir }), MARKER);
  } finally {
    b.done();
  }
});

void test("a folder that group or others can write is refused, with or without the sticky bit", () => {
  const b = box();
  try {
    for (const mode of [0o777, 0o770, 0o707, 0o720, 0o702, 0o1777]) {
      chmodSync(b.dir, mode);
      refused(() => LocalEdgeKit_readFileSafe(b.file, { root: b.dir }), "unsafe-mode", `folder ${b.dir}`, "0700");
    }
    chmodSync(b.dir, 0o700);
    assert.equal(LocalEdgeKit_readFileSafe(b.file, { root: b.dir }), MARKER);
  } finally {
    b.done();
  }
});

void test("a folder below the root that others can write is refused too (the containing folder is checked)", () => {
  const b = box();
  try {
    const sub = path.join(b.dir, "sub");
    mkdirSync(sub, { mode: 0o700 });
    writeFileSync(path.join(sub, "apps.json"), MARKER, { mode: 0o600 });
    assert.equal(LocalEdgeKit_readFileSafe(path.join(sub, "apps.json"), { root: b.dir }), MARKER);
    chmodSync(sub, 0o775);
    refused(() => LocalEdgeKit_readFileSafe(path.join(sub, "apps.json"), { root: b.dir }), "unsafe-mode", `folder ${sub}`);
  } finally {
    b.done();
  }
});

void test("a file or folder owned by someone else is refused with unsafe-owner (injected uid)", () => {
  const b = box();
  try {
    const me = process.getuid?.() ?? 0;
    assert.equal(LocalEdgeKit_readFileSafe(b.file, { root: b.dir, uid: me }), MARKER);
    // Folder matches, file does not: only the file check can refuse.
    refused(() => LocalEdgeKit_readFileSafe(b.file, { root: b.dir, uid: me + 1, folderUid: me }), "unsafe-owner", b.file);
    // File matches, folder does not: only the folder check can refuse.
    refused(() => LocalEdgeKit_readFileSafe(b.file, { root: b.dir, uid: me, folderUid: me + 1 }), "unsafe-owner", `folder ${b.dir}`);
  } finally {
    b.done();
  }
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Runs a read in a child process so a blocking open cannot hang the test run. */
function readInChild(scenario: "at-path" | "swap"): { status: number | null; stdout: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), "safe-read-fifo-"));
  try {
    const script = path.join(base, "run.mts");
    const dir = path.join(base, "cfg");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(
      script,
      `import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { LocalEdgeKit_readFileSafe } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "src", "safe-write.ts")).href)};
const dir = ${JSON.stringify(dir)};
const file = dir + "/apps.json";
const scenario = ${JSON.stringify(scenario)};
if (scenario === "at-path") execFileSync("mkfifo", [file]);
else writeFileSync(file, "{}", { mode: 0o600 });
const hooks = scenario === "swap" ? { beforeOpen: () => { unlinkSync(file); execFileSync("mkfifo", [file]); } } : undefined;
try {
  LocalEdgeKit_readFileSafe(file, { root: dir, hooks });
  console.log("NO-THROW");
} catch (error) {
  console.log(error.code);
}
`,
    );
    const result = spawnSync(process.execPath, ["--import", "tsx", script], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 20_000,
      killSignal: "SIGKILL",
    });
    return { status: result.status, stdout: result.stdout.trim() };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

void test("a FIFO at the path is refused promptly and never blocks", () => {
  const result = readInChild("at-path");
  assert.equal(result.status, 0, "the read must return, not hang");
  assert.equal(result.stdout, "local-edge-kit-safe-read-not-file");
});

void test("a FIFO swapped in between the check and the open is refused and never blocks (O_NONBLOCK)", () => {
  const result = readInChild("swap");
  assert.equal(result.status, 0, "the open must not block on the FIFO");
  assert.equal(result.stdout, "local-edge-kit-safe-read-not-file");
});

void test("the size cap holds by fstat: one byte over is refused without reading, the limit itself passes", () => {
  const b = box();
  try {
    assert.equal(LOCAL_EDGE_KIT_SAFE_READ_MAX_BYTES, 256 * 1024);
    truncateSync(b.file, LOCAL_EDGE_KIT_SAFE_READ_MAX_BYTES + 1);
    refused(() => LocalEdgeKit_readFileSafe(b.file, { root: b.dir }), "too-large", b.file, `${String(LOCAL_EDGE_KIT_SAFE_READ_MAX_BYTES + 1)} bytes, over the`);
    writeFileSync(b.file, "0123456789");
    assert.equal(LocalEdgeKit_readFileSafe(b.file, { root: b.dir, maxBytes: 10 }), "0123456789");
    refused(() => LocalEdgeKit_readFileSafe(b.file, { root: b.dir, maxBytes: 9 }), "too-large", "10 bytes, over the 9-byte limit");
  } finally {
    b.done();
  }
});

void test("the size cap holds while reading: a file that grows after fstat is refused", () => {
  const b = box();
  try {
    writeFileSync(b.file, "12345");
    refused(
      () =>
        LocalEdgeKit_readFileSafe(b.file, {
          root: b.dir,
          maxBytes: 10,
          hooks: { afterStat: () => appendFileSync(b.file, "x".repeat(100)) },
        }),
      "too-large",
      "grew past the 10-byte limit while reading",
    );
  } finally {
    b.done();
  }
});
