/**
 * @fileoverview Verifies process identity: pid file format and parsing (with the plain legacy
 * format), every comparison outcome, and a real `ps` read of the test process.
 *
 * @testing Node test runner (tsx): npm run test -- src/process-identity.unit.test.ts
 *
 * @see src/process-identity.ts - Module under test.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalEdgeKit_formatPidFile,
  LocalEdgeKit_parsePidFile,
  LocalEdgeKit_readProcessIdentity,
  LocalEdgeKit_verifyProcessIdentity,
} from "./process-identity.js";

const recorded = { uid: 501, startedAt: "Thu Nov 12 03:47:37 2026", command: "pnpm dev" };

void test("pid files round-trip and plain pid files parse without an identity", () => {
  assert.deepEqual(LocalEdgeKit_parsePidFile(LocalEdgeKit_formatPidFile(42, recorded)), { pid: 42, identity: recorded });
  assert.deepEqual(LocalEdgeKit_parsePidFile("42\n"), { pid: 42, identity: null });
  assert.deepEqual(LocalEdgeKit_parsePidFile("42\n{not json\n"), { pid: 42, identity: null });
  assert.deepEqual(LocalEdgeKit_parsePidFile("-1\n"), { pid: null, identity: null });
  assert.deepEqual(LocalEdgeKit_parsePidFile(null), { pid: null, identity: null });
});

void test("verification requires uid, start time and command to match", () => {
  const verify = (current: typeof recorded | null, rec: typeof recorded | null = recorded) =>
    LocalEdgeKit_verifyProcessIdentity({ pid: 42, recorded: rec, current });
  assert.deepEqual(verify(recorded), { ok: true });
  const reason = (result: ReturnType<typeof verify>) => (result.ok ? "ok" : result.reason);
  assert.equal(reason(verify(null)), "gone");
  assert.equal(reason(verify(recorded, null)), "unrecorded");
  assert.equal(reason(verify({ ...recorded, uid: 0 })), "uid");
  assert.equal(reason(verify({ ...recorded, startedAt: "Fri Nov 13 00:00:00 2026" })), "started-at");
  assert.equal(reason(verify({ ...recorded, command: "sshd" })), "command");
});

void test("reads the identity of a live process and nothing for a missing one", () => {
  const own = LocalEdgeKit_readProcessIdentity(process.pid);
  assert.ok(own);
  assert.equal(own.uid, process.getuid?.());
  assert.ok(own.startedAt.length > 0);
  assert.equal(LocalEdgeKit_verifyProcessIdentity({ pid: process.pid, recorded: own, current: LocalEdgeKit_readProcessIdentity(process.pid) }).ok, true);
  assert.equal(LocalEdgeKit_readProcessIdentity(0), null);
});
