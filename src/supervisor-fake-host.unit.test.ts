/**
 * @fileoverview In-memory supervisor host shared by the supervisor unit tests. It holds no tests;
 * the `.unit.test.ts` suffix keeps it out of the published build.
 *
 * @see src/supervisor.unit.test.ts - Main user of this fake.
 * @documentation reviewed=2026-11-11 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { type LocalEdgeKit_ProcessIdentity, LocalEdgeKit_formatPidFile } from "./process-identity.js";
import type { LocalEdgeKit_SupervisorHost } from "./supervisor.js";

/** A fake process. `uid`, `start` and `command` default to values derived from the pid. */
export type FakeProcess = {
  pid: number;
  group: number;
  port?: number;
  parent?: number;
  uid?: number;
  start?: string;
  command?: string;
};

/** Identity the fake host reports for a process seeded with defaults. */
export function fakeIdentity(pid: number, overrides: Partial<LocalEdgeKit_ProcessIdentity> = {}): LocalEdgeKit_ProcessIdentity {
  return { uid: 501, startedAt: `start-${String(pid)}`, command: `cmd-${String(pid)}`, ...overrides };
}

/** Pid file text as the supervisor writes it for a fake process with default identity. */
export function fakePidFile(pid: number, overrides: Partial<LocalEdgeKit_ProcessIdentity> = {}): string {
  return LocalEdgeKit_formatPidFile(pid, fakeIdentity(pid, overrides));
}

/** Fake host plus the recorded effects tests assert on. */
export type FakeSupervisorHost = LocalEdgeKit_SupervisorHost & {
  signals: { pid: number; signal: string | 0 }[];
  spawned: { cwd: string; command: string; args: readonly string[] }[];
  files: Map<string, string>;
  processes: Map<number, FakeProcess & { alive: boolean }>;
  /** Every lock file creation attempt, in order. */
  lockAttempts: string[];
};

/** In-memory host. Processes are pids with a group, alive flag and optional listening port. */
export function fakeHost(seed: {
  files?: Record<string, string>;
  processes?: FakeProcess[];
  ownGroup?: number;
  healthy?: (url: string) => number | null;
  onSpawn?: (host: FakeSupervisorHost, pid: number) => void;
} = {}): FakeSupervisorHost {
  const files = new Map(Object.entries(seed.files ?? {}));
  const processes = new Map((seed.processes ?? []).map((p) => [p.pid, { ...p, alive: true }]));
  const signals: { pid: number; signal: string | 0 }[] = [];
  const spawned: { cwd: string; command: string; args: readonly string[] }[] = [];
  let clock = 0;
  let nextPid = 9000;
  const lockAttempts: string[] = [];
  const host: FakeSupervisorHost = {
    signals,
    spawned,
    files,
    processes,
    lockAttempts,
    readText: (filePath) => files.get(filePath) ?? null,
    writeText: (filePath, text) => void files.set(filePath, text),
    createExclusive: (filePath, text) => {
      lockAttempts.push(filePath);
      if (files.has(filePath)) {
        return false;
      }
      files.set(filePath, text);
      return true;
    },
    removeFile: (filePath) => void files.delete(filePath),
    fileSize: (filePath) => (files.get(filePath) ?? "").length,
    pidIsAlive: (pid) => processes.get(pid)?.alive === true,
    processIdentity: (pid) => {
      const p = processes.get(pid);
      return p?.alive ? fakeIdentity(pid, { ...(p.uid === undefined ? {} : { uid: p.uid }), ...(p.start === undefined ? {} : { startedAt: p.start }), ...(p.command === undefined ? {} : { command: p.command }) }) : null;
    },
    ownPid: () => 1000,
    processGroupOf: (pid) => (processes.get(pid)?.alive ? (processes.get(pid)?.group ?? null) : null),
    parentOf: (pid) => processes.get(pid)?.parent ?? null,
    ownProcessGroup: () => seed.ownGroup ?? 1,
    listenerPids: (port) => [...processes.values()].filter((p) => p.alive && p.port === port).map((p) => p.pid),
    kill: (pid, signal) => {
      if (signal !== 0) {
        signals.push({ pid, signal });
      }
      const members = pid < 0 ? [...processes.values()].filter((p) => p.group === -pid) : [processes.get(pid)];
      const live = members.filter((p) => p?.alive);
      if (live.length === 0) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        for (const p of live) {
          if (p) p.alive = false;
        }
      }
    },
    httpStatus: (url) => Promise.resolve(seed.healthy ? seed.healthy(url) : 200),
    spawnDetached: (options) => {
      nextPid += 1;
      spawned.push(options);
      processes.set(nextPid, { pid: nextPid, group: nextPid, alive: true });
      seed.onSpawn?.(host, nextPid);
      return nextPid;
    },
    sleep: () => {
      clock += 500;
      return Promise.resolve();
    },
    sleepSync: (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return host;
}

