/**
 * @fileoverview In-memory supervisor host shared by the supervisor unit tests. It holds no tests;
 * the `.unit.test.ts` suffix keeps it out of the published build.
 *
 * @see src/supervisor.unit.test.ts - Main user of this fake.
 * @documentation reviewed=2026-11-11 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import type { LocalEdgeKit_SupervisorHost } from "./supervisor.js";

/** Fake host plus the recorded effects tests assert on. */
export type FakeSupervisorHost = LocalEdgeKit_SupervisorHost & {
  signals: { pid: number; signal: string | 0 }[];
  spawned: { cwd: string; command: string; args: readonly string[] }[];
  files: Map<string, string>;
  processes: Map<number, { pid: number; group: number; port?: number; parent?: number; alive: boolean }>;
};

/** In-memory host. Processes are pids with a group, alive flag and optional listening port. */
export function fakeHost(seed: {
  files?: Record<string, string>;
  processes?: { pid: number; group: number; port?: number; parent?: number }[];
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
  const host: FakeSupervisorHost = {
    signals,
    spawned,
    files,
    processes,
    readText: (filePath) => files.get(filePath) ?? null,
    writeText: (filePath, text) => void files.set(filePath, text),
    removeFile: (filePath) => void files.delete(filePath),
    fileSize: (filePath) => (files.get(filePath) ?? "").length,
    pidIsAlive: (pid) => processes.get(pid)?.alive === true,
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

