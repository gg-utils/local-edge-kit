/**
 * @fileoverview Verifies the per-app supervisor lock under fixed interleavings with fake hosts
 * that share one file system: two contenders that both judged the same dead holder, an empty
 * lock that a live creator is still writing, N contenders that all judged the same stale lock
 * before any acted, a contender that died while holding the takeover guard, and release.
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor-lock.unit.test.ts
 *
 * @see src/supervisor.ts - `LocalEdgeKit_acquireSupervisorLock`, the module under test.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { type FakeProcess, type FakeSupervisorHost, fakeHost, fakeIdentity, fakePidFile } from "./supervisor-fake-host.unit.test.js";
import { type LocalEdgeKit_SupervisedApp, LocalEdgeKit_acquireSupervisorLock } from "./supervisor.js";

const app: LocalEdgeKit_SupervisedApp = {
  id: "auth",
  enabled: true,
  cwd: "/w/auth",
  command: "pnpm",
  localPort: 4300,
  healthPath: "/health",
  pidFile: ".local/edge.pid",
  logFile: ".local/edge.log",
};
const lockFile = "/w/auth/.local/edge.pid.lock";

type Taken = ReturnType<typeof LocalEdgeKit_acquireSupervisorLock>;

/** One shared file system and process table; contenders are pids 2001, 2002, ... */
function world(files: Record<string, string>, extra: FakeProcess[] = []) {
  const shared = {
    files: new Map(Object.entries(files)),
    processes: new Map<number, FakeProcess & { alive: boolean }>(extra.map((p) => [p.pid, { ...p, alive: true }])),
  };
  const contender = (ownPid: number, onRead?: (filePath: string, text: string | null) => void): FakeSupervisorHost => {
    shared.processes.set(ownPid, { pid: ownPid, group: ownPid, alive: true });
    return fakeHost({ shared, ownPid, ...(onRead ? { onRead } : {}) });
  };
  return { shared, contender };
}

/** Runs `inner` exactly once, the first time `host` reads the lock file and sees `when`. */
function onceOnLockRead(when: (text: string | null) => boolean, inner: () => void): (filePath: string, text: string | null) => void {
  let fired = false;
  return (filePath, text) => {
    if (!fired && filePath === lockFile && when(text)) {
      fired = true;
      inner();
    }
  };
}

const owners = (results: readonly Taken[]): number => results.filter((r) => "lock" in r).length;

void test("two contenders that both judged the same dead holder end with one owner", () => {
  const stale = fakePidFile(4242);
  const { contender, shared } = world({ [lockFile]: stale });
  let second: Taken | null = null;
  const b = contender(2002);
  const a = contender(
    2001,
    onceOnLockRead((text) => text === stale, () => {
      second = LocalEdgeKit_acquireSupervisorLock(app, b);
    }),
  );
  const first = LocalEdgeKit_acquireSupervisorLock(app, a);
  assert.ok(second);
  assert.equal(owners([first, second]), 1);
  assert.ok("lock" in (second as Taken), "the contender that acted first keeps the lock");
  assert.match(shared.files.get(lockFile) ?? "", /^2002\n/);
});

void test("an empty lock that a live creator is still writing is never removed on first sight", () => {
  const { contender, shared } = world({ [lockFile]: "" });
  const a = contender(2001);
  const taken = LocalEdgeKit_acquireSupervisorLock(app, a);
  assert.ok("error" in taken);
  assert.match(taken.error, /empty or unreadable/);
  assert.equal(shared.files.get(lockFile), "", "the creator's file is still there");
  // The creator now finishes writing its content; it still owns the lock.
  shared.files.set(lockFile, fakePidFile(2009));
  shared.processes.set(2009, { pid: 2009, group: 2009, alive: true });
  assert.ok("error" in LocalEdgeKit_acquireSupervisorLock(app, a));
  assert.match(shared.files.get(lockFile) ?? "", /^2009\n/);
});

void test("N contenders that all judged the same stale lock before any acted end with exactly one owner", () => {
  const stale = fakePidFile(4242);
  const n = 6;
  const { contender } = world({ [lockFile]: stale });
  const results: Taken[] = [];
  const hosts: FakeSupervisorHost[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const next = hosts[0];
    hosts.unshift(
      contender(
        2001 + i,
        next
          ? onceOnLockRead((text) => text === stale, () => {
              results.push(LocalEdgeKit_acquireSupervisorLock(app, next));
            })
          : undefined,
      ),
    );
  }
  const head = hosts[0];
  assert.ok(head);
  results.push(LocalEdgeKit_acquireSupervisorLock(app, head));
  assert.equal(results.length, n);
  assert.equal(owners(results), 1);
});

void test("a contender arriving while another holds the takeover guard refuses instead of removing", () => {
  const stale = fakePidFile(4242);
  const { contender, shared } = world({ [lockFile]: stale });
  let second: Taken | null = null;
  const b = contender(2002);
  let reads = 0;
  const a = contender(2001, (filePath) => {
    // The second read of the lock is A's re-read while it holds the takeover guard.
    if (filePath === lockFile && (reads += 1) === 2) {
      second = LocalEdgeKit_acquireSupervisorLock(app, b);
    }
  });
  const first = LocalEdgeKit_acquireSupervisorLock(app, a);
  assert.ok(second);
  assert.ok("error" in (second as Taken));
  assert.ok("lock" in first);
  assert.equal(owners([first, second]), 1);
  assert.deepEqual([...shared.files.keys()].filter((f) => f.includes("takeover")), []);
});

void test("a takeover guard left by a dead contender is itself taken over, then the stale lock", () => {
  const stale = fakePidFile(4242);
  // A contender (pid 2005) created the content-keyed guard for this exact stale lock and then
  // died before it removed the lock or its guard: both files are still in place.
  const guardFile = `${lockFile}.takeover-${createHash("sha256").update(stale, "utf8").digest("hex").slice(0, 32)}`;
  const abandonedGuard = `2005\n${JSON.stringify(fakeIdentity(2005))}\n${"a".repeat(32)}\n`;
  const { contender, shared } = world({ [lockFile]: stale, [guardFile]: abandonedGuard });
  assert.equal(shared.processes.has(2005), false, "the guard owner is dead");
  const taken = LocalEdgeKit_acquireSupervisorLock(app, contender(2001));
  assert.ok("lock" in taken, "error" in taken ? taken.error : "");
  assert.match(shared.files.get(lockFile) ?? "", /^2001\n/);
  assert.equal(shared.files.has(guardFile), false, "the abandoned guard was removed");
  assert.deepEqual([...shared.files.keys()].filter((f) => f.includes("takeover")), []);
});

void test("release removes only the releaser's own lock", () => {
  const { contender, shared } = world({});
  const a = contender(2001);
  const taken = LocalEdgeKit_acquireSupervisorLock(app, a);
  assert.ok("lock" in taken);
  // Someone replaced the lock behind our back (for example, a manual removal and a new owner).
  shared.files.set(lockFile, fakePidFile(2002));
  taken.lock.release();
  assert.match(shared.files.get(lockFile) ?? "", /^2002\n/);
});
