/**
 * @fileoverview Verifies the careful writers: atomic replace keeping the mode, refusal of
 * symlinked targets and of folders that resolve outside the root, and append without following
 * symlinks.
 *
 * @testing Node test runner (tsx): npm run test -- src/safe-write.unit.test.ts
 *
 * @see src/safe-write.ts - Writers under test.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalEdgeKit_openAppendSafe, LocalEdgeKit_writeFileAtomic } from "./safe-write.js";

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), "kit-safe-write-"));
}

void test("atomic write creates 0600 files, replaces content, keeps an existing mode and leaves no temp", () => {
  const root = scratch();
  const file = path.join(root, "state", "app.pid");
  LocalEdgeKit_writeFileAtomic(file, "1\n", { root });
  assert.equal(readFileSync(file, "utf8"), "1\n");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  chmodSync(file, 0o640);
  LocalEdgeKit_writeFileAtomic(file, "2\n", { root });
  assert.equal(readFileSync(file, "utf8"), "2\n");
  assert.equal(statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(path.dirname(file)), ["app.pid"]);
});

void test("refuses a symlinked target, a folder that resolves outside the root, and a path outside", () => {
  const root = scratch();
  const outside = scratch();
  writeFileSync(path.join(outside, "victim"), "keep");
  symlinkSync(path.join(outside, "victim"), path.join(root, "link"));
  assert.throws(() => LocalEdgeKit_writeFileAtomic(path.join(root, "link"), "x", { root }), /symlink/);
  symlinkSync(outside, path.join(root, "dirlink"));
  assert.throws(() => LocalEdgeKit_writeFileAtomic(path.join(root, "dirlink", "victim"), "x", { root }), /outside-root/);
  assert.throws(() => LocalEdgeKit_writeFileAtomic(path.join(outside, "other"), "x", { root }), /outside-root/);
  assert.equal(readFileSync(path.join(outside, "victim"), "utf8"), "keep");
});

void test("append opens without following a symlink", () => {
  const root = scratch();
  mkdirSync(path.join(root, "logs"));
  const fd = LocalEdgeKit_openAppendSafe(path.join(root, "logs", "app.log"), { root });
  writeSync(fd, "line\n");
  closeSync(fd);
  assert.equal(readFileSync(path.join(root, "logs", "app.log"), "utf8"), "line\n");
  const outside = scratch();
  symlinkSync(path.join(outside, "x.log"), path.join(root, "logs", "evil.log"));
  assert.throws(() => LocalEdgeKit_openAppendSafe(path.join(root, "logs", "evil.log"), { root }), /symlink/);
});
