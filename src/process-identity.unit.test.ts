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
import { spawn } from "node:child_process";
import test from "node:test";

import {
  LOCAL_EDGE_KIT_LAUNCH_ID_ENV,
  LocalEdgeKit_formatPidFile,
  LocalEdgeKit_launchIdFromEnvironment,
  LocalEdgeKit_newLaunchId,
  LocalEdgeKit_parsePsIdentityLine,
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

void test("same-second pid reuse with the same uid and command line fails on the launch id", () => {
  const launchId = LocalEdgeKit_newLaunchId();
  const ours = { ...recorded, launchId };
  const reason = (current: Parameters<typeof LocalEdgeKit_verifyProcessIdentity>[0]["current"]) => {
    const result = LocalEdgeKit_verifyProcessIdentity({ pid: 42, recorded: ours, current });
    return result.ok ? "ok" : result.reason;
  };
  assert.equal(reason({ ...recorded, launchId }), "ok");
  assert.equal(reason({ ...recorded, launchId: LocalEdgeKit_newLaunchId() }), "launch-id");
  assert.equal(reason({ ...recorded, launchId: null }), "launch-id");
  // Environment not readable: falls back to uid, start time and command line.
  assert.equal(reason({ ...recorded }), "ok");
  assert.deepEqual(LocalEdgeKit_parsePidFile(LocalEdgeKit_formatPidFile(42, ours)).identity, ours);
});

void test("parses the launch id from environ and ps -E listings, and one ps identity line", () => {
  const id = "0123456789abcdef0123456789abcdef";
  assert.equal(LocalEdgeKit_launchIdFromEnvironment(`A=1\0${LOCAL_EDGE_KIT_LAUNCH_ID_ENV}=${id}\0B=2\0`), id);
  assert.equal(LocalEdgeKit_launchIdFromEnvironment(`sleep 30 A=1 ${LOCAL_EDGE_KIT_LAUNCH_ID_ENV}=${id} B=2`), id);
  assert.equal(LocalEdgeKit_launchIdFromEnvironment(`X${LOCAL_EDGE_KIT_LAUNCH_ID_ENV}=${id}`), null);
  assert.equal(LocalEdgeKit_launchIdFromEnvironment("A=1\0"), null);
  assert.deepEqual(LocalEdgeKit_parsePsIdentityLine("  501 Thu Nov  5 03:47:37 2026     pnpm dev --port 1"), {
    uid: 501,
    startedAt: "Thu Nov 5 03:47:37 2026",
    command: "pnpm dev --port 1",
  });
  assert.equal(LocalEdgeKit_parsePsIdentityLine("garbage"), null);
});

void test("reads a child's launch id from its environment where the platform allows it", async () => {
  const launchId = LocalEdgeKit_newLaunchId();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    env: { ...process.env, [LOCAL_EDGE_KIT_LAUNCH_ID_ENV]: launchId },
    stdio: "ignore",
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const identity = LocalEdgeKit_readProcessIdentity(child.pid ?? 0);
    assert.ok(identity);
    if (process.platform === "linux") {
      assert.equal(identity.launchId, launchId);
    } else {
      assert.ok(identity.launchId === undefined || identity.launchId === launchId);
    }
  } finally {
    child.kill("SIGKILL");
  }
});
