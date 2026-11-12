/**
 * @fileoverview Verifies the careful writers against real temporary folders: no folder is
 * created below a symlink, ancestor swaps after the walk, after the open and before the rename
 * are refused without writing outside the root, target symlinks are refused, and new files and
 * folders get 0600 and 0700.
 *
 * @testing Node test runner (tsx): npm run test -- src/safe-write.unit.test.ts
 *
 * @see src/safe-write.ts - Module under test.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalEdgeKit_createFileExclusive,
  LocalEdgeKit_ensureSafeDir,
  LocalEdgeKit_openAppendSafe,
  LocalEdgeKit_writeFileAtomic,
} from "./safe-write.js";

function sandbox(): { root: string; outside: string; done: () => void } {
  const base = mkdtempSync(path.join(tmpdir(), "safe-write-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside, done: () => rmSync(base, { recursive: true, force: true }) };
}

void test("writes atomically with 0600 files and 0700 new folders, keeping an existing mode", () => {
  const box = sandbox();
  try {
    const file = path.join(box.root, "a", "b", "state.pid");
    LocalEdgeKit_writeFileAtomic(file, "1\n", { root: box.root });
    assert.equal(readFileSync(file, "utf8"), "1\n");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(box.root, "a")).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(box.root, "a", "b")).mode & 0o777, 0o700);
    LocalEdgeKit_writeFileAtomic(file, "2\n", { root: box.root });
    assert.equal(readFileSync(file, "utf8"), "2\n");
    assert.deepEqual(readdirSync(path.dirname(file)), ["state.pid"]);
  } finally {
    box.done();
  }
});

void test("a symlinked parent with a missing nested folder creates nothing outside the root", () => {
  const box = sandbox();
  try {
    symlinkSync(box.outside, path.join(box.root, "link"));
    assert.throws(
      () => LocalEdgeKit_writeFileAtomic(path.join(box.root, "link", "nested", "x.pid"), "1", { root: box.root }),
      /local-edge-kit-safe-write-symlink/,
    );
    assert.throws(() => LocalEdgeKit_ensureSafeDir(path.join(box.root, "link", "nested"), { root: box.root }), /symlink/);
    assert.deepEqual(readdirSync(box.outside), []);
  } finally {
    box.done();
  }
});

void test("an ancestor swapped for a symlink after the walk is refused and nothing is written outside", () => {
  const box = sandbox();
  try {
    const dir = path.join(box.root, "state");
    mkdirSync(dir);
    const swap = () => {
      renameSync(dir, path.join(box.root, "moved"));
      symlinkSync(box.outside, dir);
    };
    assert.throws(
      () => LocalEdgeKit_writeFileAtomic(path.join(dir, "x.pid"), "1", { root: box.root, hooks: { afterWalk: swap } }),
      /local-edge-kit-safe-write-changed/,
    );
    assert.deepEqual(readdirSync(box.outside), []);
  } finally {
    box.done();
  }
});

void test("an ancestor swapped just before the rename is refused and the target is never replaced", () => {
  const box = sandbox();
  try {
    const dir = path.join(box.root, "state");
    mkdirSync(dir);
    const swap = () => {
      renameSync(dir, path.join(box.root, "moved"));
      mkdirSync(dir);
    };
    assert.throws(
      () => LocalEdgeKit_writeFileAtomic(path.join(dir, "x.pid"), "1", { root: box.root, hooks: { beforeRename: swap } }),
      /local-edge-kit-safe-write-changed/,
    );
    assert.deepEqual(readdirSync(dir), []);
    assert.ok(!readdirSync(path.join(box.root, "moved")).includes("x.pid"));
  } finally {
    box.done();
  }
});

void test("target symlinks and paths outside the root are refused", () => {
  const box = sandbox();
  try {
    const victim = path.join(box.outside, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(victim, path.join(box.root, "x.pid"));
    assert.throws(() => LocalEdgeKit_writeFileAtomic(path.join(box.root, "x.pid"), "1", { root: box.root }), /symlink/);
    assert.throws(() => LocalEdgeKit_openAppendSafe(path.join(box.root, "x.pid"), { root: box.root }), /symlink/);
    assert.throws(() => LocalEdgeKit_writeFileAtomic(path.join(box.outside, "y"), "1", { root: box.root }), /outside-root/);
    assert.equal(readFileSync(victim, "utf8"), "keep");
  } finally {
    box.done();
  }
});

void test("append opens a new log as 0600 and refuses an ancestor swapped after the open", () => {
  const box = sandbox();
  try {
    const log = path.join(box.root, "logs", "app.log");
    const fd = LocalEdgeKit_openAppendSafe(log, { root: box.root });
    writeSync(fd, "line\n");
    closeSync(fd);
    assert.equal(statSync(log).mode & 0o777, 0o600);
    const dir = path.join(box.root, "logs");
    const swap = () => {
      renameSync(dir, path.join(box.root, "moved"));
      symlinkSync(box.outside, dir);
    };
    assert.throws(() => LocalEdgeKit_openAppendSafe(log, { root: box.root, hooks: { afterOpen: swap } }), /changed/);
  } finally {
    box.done();
  }
});

void test("exclusive create returns false for an existing file and refuses an ancestor swapped after the open", () => {
  const box = sandbox();
  try {
    const lock = path.join(box.root, "a.lock");
    assert.equal(LocalEdgeKit_createFileExclusive(lock, "1\n", { root: box.root }), true);
    assert.equal(LocalEdgeKit_createFileExclusive(lock, "2\n", { root: box.root }), false);
    assert.equal(readFileSync(lock, "utf8"), "1\n");
    assert.equal(statSync(lock).mode & 0o777, 0o600);
    const dir = path.join(box.root, "d");
    mkdirSync(dir);
    const swap = () => {
      renameSync(dir, path.join(box.root, "moved"));
      mkdirSync(dir);
    };
    assert.throws(() => LocalEdgeKit_createFileExclusive(path.join(dir, "b.lock"), "1", { root: box.root, hooks: { afterOpen: swap } }), /changed/);
    assert.equal(existsSync(path.join(dir, "b.lock")), false);
  } finally {
    box.done();
  }
});
