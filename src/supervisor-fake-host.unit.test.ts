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
  /** Launch id the fake host reads from the process environment; leave out for "cannot read". */
  launchId?: string | null;
};

/** Identity the fake host reports for a process seeded with defaults. */
export function fakeIdentity(pid: number, overrides: Partial<LocalEdgeKit_ProcessIdentity> = {}): LocalEdgeKit_ProcessIdentity {
  return { uid: 501, startedAt: `start-${String(pid)}`, command: `cmd-${String(pid)}`, ...overrides };
}

/** Pid file text as the supervisor writes it for a fake process with default identity. */
export function fakePidFile(pid: number, overrides: Partial<LocalEdgeKit_ProcessIdentity> = {}): string {
  return LocalEdgeKit_formatPidFile(pid, fakeIdentity(pid, overrides));
}

/** Fake host plus the recorded effects tests assert on. The supervisor itself is pid 1000. */
export type FakeSupervisorHost = LocalEdgeKit_SupervisorHost & {
  signals: { pid: number; signal: string | 0 }[];
  spawned: { cwd: string; command: string; args: readonly string[]; env?: Readonly<Record<string, string>> | undefined; launchId?: string | undefined }[];
  commands: string[][];
  dirs: string[];
  files: Map<string, string>;
  processes: Map<number, FakeProcess & { alive: boolean }>;
  /** Every lock file creation attempt, in order. */
  lockAttempts: string[];
  /** Every path read through `readExternalText`, in order. */
  externalReads: string[];
  /** Every `processIdentity` call: the pid and whether the launch id (process environment) was asked for. */
  identityReads: { pid: number; readLaunchId: boolean }[];
};

/** In-memory host. Processes are pids with a group, alive flag and optional listening port. */
export function fakeHost(seed: {
  files?: Record<string, string>;
  processes?: FakeProcess[];
  ownGroup?: number;
  healthy?: (url: string) => number | null;
  onSpawn?: (host: FakeSupervisorHost, pid: number) => void;
  onCommand?: (
    host: FakeSupervisorHost,
    command: string,
    args: readonly string[],
  ) => { status: number | null; stdout: string; stderr: string } | undefined;
  /** Shares files and processes with other fake hosts, to model concurrent supervisors. */
  shared?: { files: Map<string, string>; processes: Map<number, FakeProcess & { alive: boolean }> };
  /** Canonical paths the fake `realPath` returns; any other path is returned unchanged. */
  realPaths?: Record<string, string>;
  /** Paths the fake `realPath` reports as missing (null). */
  absentPaths?: readonly string[];
  /**
   * Answers `readExternalText` (the safe read of an external entry's pid or log file). Default:
   * the text in `files`, or null. A thrown error models a refusal such as `unsafe-mode`.
   */
  readExternal?: (filePath: string) => string | null;
  /** Answers `fetchUnixSocketText`; default null (no answer). */
  fetchUnixSocket?: (socketPath: string, urlPath: string) => string | null;
  /** This supervisor's own pid. Default 1000. */
  ownPid?: number;
  /** Called after every read with the path and the text returned; used to interleave contenders. */
  onRead?: (filePath: string, text: string | null) => void;
} = {}): FakeSupervisorHost {
  const files = seed.shared?.files ?? new Map(Object.entries(seed.files ?? {}));
  const processes = seed.shared?.processes ?? new Map((seed.processes ?? []).map((p) => [p.pid, { ...p, alive: true }]));
  const signals: { pid: number; signal: string | 0 }[] = [];
  const spawned: { cwd: string; command: string; args: readonly string[]; env?: Readonly<Record<string, string>> | undefined; launchId?: string | undefined }[] = [];
  const commands: string[][] = [];
  const dirs: string[] = [];
  let clock = 0;
  let nextPid = 9000;
  const lockAttempts: string[] = [];
  const externalReads: string[] = [];
  const identityReads: { pid: number; readLaunchId: boolean }[] = [];
  const host: FakeSupervisorHost = {
    signals,
    spawned,
    commands,
    dirs,
    files,
    processes,
    lockAttempts,
    externalReads,
    identityReads,
    readText: (filePath) => {
      const text = files.get(filePath) ?? null;
      seed.onRead?.(filePath, text);
      return text;
    },
    readExternalText: (filePath) => {
      externalReads.push(filePath);
      return seed.readExternal ? seed.readExternal(filePath) : (files.get(filePath) ?? null);
    },
    writeText: (filePath, text) => void files.set(filePath, text),
    ensureDir: (dirPath) => void dirs.push(dirPath),
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return seed.onCommand?.(host, command, args) ?? { status: 0, stdout: "", stderr: "" };
    },
    createExclusive: (filePath, text) => {
      lockAttempts.push(filePath);
      if (files.has(filePath)) {
        return false;
      }
      files.set(filePath, text);
      return true;
    },
    realPath: (filePath) => (seed.absentPaths?.includes(filePath) === true ? null : (seed.realPaths?.[filePath] ?? filePath)),
    fetchUnixSocketText: (socketPath, urlPath) => seed.fetchUnixSocket?.(socketPath, urlPath) ?? null,
    removeFile: (filePath) => void files.delete(filePath),
    fileSize: (filePath) => (files.get(filePath) ?? "").length,
    pidIsAlive: (pid) => processes.get(pid)?.alive === true,
    processIdentity: (pid, options) => {
      identityReads.push({ pid, readLaunchId: options?.readLaunchId !== false });
      if (pid === 1000) {
        return fakeIdentity(1000);
      }
      const p = processes.get(pid);
      return p?.alive
        ? fakeIdentity(pid, {
            ...(p.uid === undefined ? {} : { uid: p.uid }),
            ...(p.start === undefined ? {} : { startedAt: p.start }),
            ...(p.command === undefined ? {} : { command: p.command }),
            ...(p.launchId === undefined ? {} : { launchId: p.launchId }),
          })
        : null;
    },
    ownPid: () => seed.ownPid ?? 1000,
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
      if (signal === "SIGTERM" || signal === "SIGKILL" || signal === "SIGQUIT") {
        for (const p of live) {
          if (p) p.alive = false;
        }
      }
    },
    httpStatus: (url) => Promise.resolve(seed.healthy ? seed.healthy(url) : 200),
    spawnDetached: (options) => {
      nextPid += 1;
      spawned.push(options);
      processes.set(nextPid, { pid: nextPid, group: nextPid, alive: true, ...(options.launchId === undefined ? {} : { launchId: options.launchId }) });
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

