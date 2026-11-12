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
import { spawnSync } from "node:child_process";
function LocalEdgeKit_psField(pid, field) {
    const result = spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
    });
    const text = (result.stdout ?? "").trim();
    return result.status === 0 && text.length > 0 ? text : null;
}
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
export function LocalEdgeKit_readProcessIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return null;
    }
    const uidText = LocalEdgeKit_psField(pid, "uid");
    const startedAt = LocalEdgeKit_psField(pid, "lstart");
    const command = LocalEdgeKit_psField(pid, "command");
    const uid = Number(uidText);
    if (uidText === null || !Number.isInteger(uid) || startedAt === null || command === null) {
        return null;
    }
    return { uid, startedAt: startedAt.replace(/\s+/g, " "), command };
}
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
export function LocalEdgeKit_verifyProcessIdentity(options) {
    const { pid, recorded, current } = options;
    const who = `pid ${String(pid)}`;
    if (current === null) {
        return { ok: false, reason: "gone", message: `${who} is not running` };
    }
    if (recorded === null) {
        return { ok: false, reason: "unrecorded", message: `${who} has no recorded identity, so it is not known to be ours` };
    }
    if (current.uid !== recorded.uid) {
        return { ok: false, reason: "uid", message: `${who} now belongs to another user; the recorded process is gone` };
    }
    if (current.startedAt !== recorded.startedAt) {
        return { ok: false, reason: "started-at", message: `${who} started at another time; the recorded process is gone` };
    }
    if (current.command !== recorded.command) {
        return { ok: false, reason: "command", message: `${who} runs another command than the recorded one` };
    }
    return { ok: true };
}
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
export function LocalEdgeKit_formatPidFile(pid, identity) {
    return identity === null ? `${String(pid)}\n` : `${String(pid)}\n${JSON.stringify(identity)}\n`;
}
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
export function LocalEdgeKit_parsePidFile(text) {
    if (text === null) {
        return { pid: null, identity: null };
    }
    const [first, second] = text.split("\n");
    const pid = Number((first ?? "").trim());
    return {
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
        identity: LocalEdgeKit_parseProcessIdentity(second ?? ""),
    };
}
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
export function LocalEdgeKit_parseProcessIdentity(text) {
    if (text.trim() === "") {
        return null;
    }
    try {
        const value = JSON.parse(text);
        if (value !== null &&
            typeof value === "object" &&
            typeof value.uid === "number" &&
            typeof value.startedAt === "string" &&
            typeof value.command === "string") {
            return { uid: value.uid, startedAt: value.startedAt, command: value.command };
        }
    }
    catch {
        // Malformed identity: treated as unrecorded.
    }
    return null;
}
