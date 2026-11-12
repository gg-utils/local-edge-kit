/**
 * @fileoverview Process identity: which process a pid names, so a recycled pid is never
 * adopted or signalled.
 *
 * A pid alone is not an identity: after the process exits the kernel may hand the same number
 * to an unrelated process. The supervisor therefore records, when it starts a process, the
 * process's owner uid, its start time and its command line, and stores them with the pid. Before
 * it adopts, reloads or signals that pid it reads the identity again and requires the uid and the
 * start time to match exactly, and the command line too. A pid with no recorded identity is
 * "unverified" and is never signalled. The check runs again immediately before every signal, so
 * a process that exits while a stop is in progress cannot pass its pid on to a new process that
 * then receives the next signal. A narrow window remains between that last check and the
 * `kill` system call itself; POSIX offers no pid handle to close it from Node.
 * Flow: start -> read identity (ps) -> store with pid -> later: read again -> compare -> act or refuse.
 *
 * @example
 * ```typescript
 * const recorded = host.processIdentity(pid);
 * const text = LocalEdgeKit_formatPidFile(pid, recorded);
 * // later
 * const parsed = LocalEdgeKit_parsePidFile(text);
 * const check = LocalEdgeKit_verifyProcessIdentity({ pid: parsed.pid, recorded: parsed.identity, current: host.processIdentity(parsed.pid) });
 * ```
 *
 * @testing Node test runner (tsx): npm run test -- src/process-identity.unit.test.ts
 *
 * @see src/supervisor.ts - Records identities at start and checks them before adopt and stop.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
/** What identifies one process instance. */
export type LocalEdgeKit_ProcessIdentity = {
    /** Real uid of the process owner. */
    uid: number;
    /** Start time as `ps -o lstart=` prints it in the C locale. */
    startedAt: string;
    /** Full command line as `ps -o command=` prints it. */
    command: string;
};
/** Result of comparing a recorded identity with the live process. */
export type LocalEdgeKit_ProcessIdentityCheck = {
    ok: true;
} | {
    ok: false;
    reason: "gone" | "unrecorded" | "uid" | "started-at" | "command";
    message: string;
};
/**
 * Reads a live process's identity with `ps`.
 *
 * @param pid - Process id.
 * @returns The identity, or null when the process does not exist or `ps` cannot read it.
 * @example
 * ```typescript
 * LocalEdgeKit_readProcessIdentity(process.pid); // { uid: 501, startedAt: "Thu Nov 12 03:47:37 2026", command: "node ..." }
 * ```
 */
export declare function LocalEdgeKit_readProcessIdentity(pid: number): LocalEdgeKit_ProcessIdentity | null;
/**
 * Compares a recorded identity with the live one.
 *
 * @param options - `recorded` (null when nothing was recorded) and `current` (null when the
 * process is gone).
 * @returns `{ ok: true }` only when both exist and uid, start time and command are equal.
 * @example
 * ```typescript
 * LocalEdgeKit_verifyProcessIdentity({ pid: 42, recorded, current: host.processIdentity(42) });
 * ```
 */
export declare function LocalEdgeKit_verifyProcessIdentity(options: {
    pid: number;
    recorded: LocalEdgeKit_ProcessIdentity | null;
    current: LocalEdgeKit_ProcessIdentity | null;
}): LocalEdgeKit_ProcessIdentityCheck;
/**
 * Formats a pid file: the pid on the first line (as before, for other tools), the identity as
 * JSON on the second.
 *
 * @param pid - Process id.
 * @param identity - Identity read right after the start, or null when it could not be read.
 * @returns Pid file text.
 * @example
 * ```typescript
 * LocalEdgeKit_formatPidFile(42, { uid: 501, startedAt: "Thu Nov 12 03:47:37 2026", command: "pnpm dev" });
 * ```
 */
export declare function LocalEdgeKit_formatPidFile(pid: number, identity: LocalEdgeKit_ProcessIdentity | null): string;
/**
 * Parses a pid file written by `LocalEdgeKit_formatPidFile`, or a plain one-line pid file.
 *
 * @param text - Pid file text, or null when there is no file.
 * @returns The pid (null when absent or not a positive integer) and the identity (null when
 * absent or malformed).
 * @example
 * ```typescript
 * LocalEdgeKit_parsePidFile("42\n"); // { pid: 42, identity: null }
 * ```
 */
export declare function LocalEdgeKit_parsePidFile(text: string | null): {
    pid: number | null;
    identity: LocalEdgeKit_ProcessIdentity | null;
};
/**
 * Parses an identity from JSON text, returning null for anything malformed.
 *
 * @param text - JSON text.
 * @returns The identity, or null.
 * @example
 * ```typescript
 * LocalEdgeKit_parseProcessIdentity('{"uid":501,"startedAt":"x","command":"y"}');
 * ```
 */
export declare function LocalEdgeKit_parseProcessIdentity(text: string): LocalEdgeKit_ProcessIdentity | null;
