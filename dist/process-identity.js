/**
 * @fileoverview Process identity: which process a pid names, so a recycled pid is never
 * adopted or signalled.
 *
 * A pid alone is not an identity: after the process exits the kernel may hand the same number
 * to an unrelated process. The supervisor therefore records, when it starts a process, the
 * process's owner uid, its start time and its command line, and stores them with the pid.
 * `ps` prints the start time to the second only, so a pid reused within the same second by
 * the same user with the same command line would look identical. To tell those apart the
 * supervisor also gives every process it starts a random launch id in its environment
 * (`LOCAL_EDGE_KIT_LAUNCH_ID`) and records it. The check reads it back from the process's own
 * environment: `/proc/<pid>/environ` on Linux, `ps -E` on macOS. Where the environment cannot
 * be read (recent macOS versions show no environment in `ps -E`, even for the same user), the
 * check falls back to uid, start time and command line, with the one-second limit above. Before
 * it adopts, reloads or signals that pid it reads the identity again and requires the uid and the
 * start time to match exactly, and the command line too. A pid with no recorded identity is
 * "unverified" and is never signalled. The check runs again immediately before every signal, so
 * a process that exits while a stop is in progress cannot pass its pid on to a new process that
 * then receives the next signal. A narrow window remains between that last check and the
 * `kill` system call itself; POSIX offers no pid handle to close it from Node.
 * Uid, start time and command line come from one `ps` call; the environment is read after it,
 * and only when the caller asks for the launch id (`readLaunchId`, the default). A pid the
 * supervisor did not start (an observed external pid) is read with `readLaunchId: false`: its
 * identity is uid, start time and command line, with no launch id, and its environment is not
 * opened or listed at all.
 * A process that still carries the recorded launch id when its environment is read was the
 * process at that pid since its start, so the fields read just before belong to it too.
 * Flow: start (with launch id) -> read identity (ps) -> store with pid -> later: read again ->
 * compare -> act or refuse.
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
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
/** Environment variable that carries a launch id into every process the supervisor starts. */
export const LOCAL_EDGE_KIT_LAUNCH_ID_ENV = "LOCAL_EDGE_KIT_LAUNCH_ID";
function LocalEdgeKit_ps(args) {
    const result = spawnSync("ps", [...args], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
    });
    const text = (result.stdout ?? "").trim();
    return result.status === 0 && text.length > 0 ? text : null;
}
/**
 * Creates a new random launch id (128 bits, hex).
 *
 * @returns A 32-character hex string.
 * @example
 * ```typescript
 * const env = { ...process.env, [LOCAL_EDGE_KIT_LAUNCH_ID_ENV]: LocalEdgeKit_newLaunchId() };
 * ```
 */
export function LocalEdgeKit_newLaunchId() {
    return randomBytes(16).toString("hex");
}
/**
 * Finds the launch id in an environment listing (NUL- or space-separated `NAME=value` entries).
 *
 * @param text - `/proc/<pid>/environ` content or `ps -E` output.
 * @returns The id, or null when the listing has none.
 * @example
 * ```typescript
 * LocalEdgeKit_launchIdFromEnvironment("A=1\0LOCAL_EDGE_KIT_LAUNCH_ID=ab12\0"); // "ab12"
 * ```
 */
export function LocalEdgeKit_launchIdFromEnvironment(text) {
    const match = new RegExp(`(?:^|[\\0\\s])${LOCAL_EDGE_KIT_LAUNCH_ID_ENV}=([0-9a-f]{32})(?=$|[\\0\\s])`).exec(text);
    return match?.[1] ?? null;
}
/**
 * Reads the launch id from a process's own environment.
 * Linux: `/proc/<pid>/environ` (readable for the same user); a readable file without the
 * variable gives null. macOS: `ps -E`; since it may show no environment at all, a missing
 * variable there gives undefined (cannot tell).
 */
function LocalEdgeKit_readLaunchId(pid) {
    if (process.platform === "linux") {
        try {
            return LocalEdgeKit_launchIdFromEnvironment(readFileSync(`/proc/${String(pid)}/environ`, "latin1"));
        }
        catch {
            return undefined;
        }
    }
    const listing = LocalEdgeKit_ps(["-E", "-ww", "-o", "command=", "-p", String(pid)]);
    return listing === null ? undefined : (LocalEdgeKit_launchIdFromEnvironment(listing) ?? undefined);
}
/**
 * Parses one `ps -o uid=,lstart=,command=` line.
 *
 * @param line - The line.
 * @returns The fields, or null when the line does not have that shape.
 * @example
 * ```typescript
 * LocalEdgeKit_parsePsIdentityLine("  501 Thu Nov 12 03:47:37 2026     pnpm dev");
 * ```
 */
export function LocalEdgeKit_parsePsIdentityLine(line) {
    const match = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*?)\s*$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) {
        return null;
    }
    return { uid: Number(match[1]), startedAt: match[2].replace(/\s+/g, " "), command: match[3] };
}
/**
 * Reads a live process's identity: uid, start time and command line from one `ps` call, then
 * (unless `readLaunchId` is false) the launch id from its environment.
 *
 * @param pid - Process id.
 * @param options - `readLaunchId` (default true). With false the process environment is not
 * read (no `ps -E`, no `/proc/<pid>/environ`) and the identity has no `launchId`.
 * @returns The identity, or null when the process does not exist or `ps` cannot read it.
 * @example
 * ```typescript
 * LocalEdgeKit_readProcessIdentity(process.pid); // { uid: 501, startedAt: "Thu Nov 12 03:47:37 2026", command: "node ..." }
 * ```
 */
export function LocalEdgeKit_readProcessIdentity(pid, options = {}) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return null;
    }
    const line = LocalEdgeKit_ps(["-o", "uid=,lstart=,command=", "-p", String(pid)]);
    const fields = line === null ? null : LocalEdgeKit_parsePsIdentityLine(line);
    if (fields === null) {
        return null;
    }
    if (options.readLaunchId === false) {
        return fields;
    }
    const launchId = LocalEdgeKit_readLaunchId(pid);
    return launchId === undefined ? fields : { ...fields, launchId };
}
/**
 * Compares a recorded identity with the live one.
 *
 * @param options - `recorded` (null when nothing was recorded) and `current` (null when the
 * process is gone).
 * @returns `{ ok: true }` only when both exist and uid, start time and command are equal, and,
 * when a launch id was recorded and the live environment could be read, the launch ids too.
 * A recorded launch id with an unreadable environment falls back to the other three fields.
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
    if (typeof recorded.launchId === "string" && current.launchId !== undefined && current.launchId !== recorded.launchId) {
        return { ok: false, reason: "launch-id", message: `${who} carries another launch id; the recorded process is gone` };
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
            const base = { uid: value.uid, startedAt: value.startedAt, command: value.command };
            return typeof value.launchId === "string" ? { ...base, launchId: value.launchId } : base;
        }
    }
    catch {
        // Malformed identity: treated as unrecorded.
    }
    return null;
}
