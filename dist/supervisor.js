/**
 * @fileoverview Generic app supervisor: start, stop, adopt, status, health and logs for a set of
 * loopback apps described by a project-owned config, each with a pid file and a log file.
 *
 * The supervisor never assumes it started a process. When it starts one it records the pid with
 * the process's identity (owner uid, start time, command line and a launch id it put in the
 * process environment; see `process-identity.ts`). An
 * app counts as running only when its pid file names a live process whose identity still
 * matches and the app's loopback port is held by that process's tree, so a run started by
 * another supervisor invocation is adopted instead of started twice, and a recycled pid is never
 * adopted. A pid file without a recorded identity is `unverified`: never adopted, never
 * signalled. A port held by anything else is reported as busy and never killed. Stop signals the
 * app's process group (SIGTERM, then SIGKILL after a timeout) through the core runtime-stop
 * helper, checking the identity again immediately before every signal.
 *
 * Concurrency: inspection, start and pid file publication (and inspection plus stop) run under
 * a per-app lock file (`<pidFile>.lock`, published complete by temp file + `link`). A lock
 * whose owner process is gone is taken over under a guard that removes only that exact stale
 * lock (see `LocalEdgeKit_acquireSupervisorLock`); a live owner makes the other supervisor fail
 * with a clear message.
 *
 * Files: pid and lock files are written inside the app's `cwd` through `safe-write.ts`
 * (no symlinks followed, atomic replace, 0600 files, 0700 folders); the log is opened for
 * append the same way. A pid or log path outside `cwd` is refused.
 * Env checks read names only: values are never returned or printed. Launch env values go to the
 * started process only; output lists their names. External apps are route only: never started,
 * stopped or signalled.
 * Flow: config -> validate + dependency order -> lock -> inspect (pid file + identity + port)
 * -> start/stop -> publish pid file -> unlock -> health.
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor.unit.test.ts
 *
 * @see src/supervisor-cli.ts - Command dispatcher that wires this module to an exposure backend.
 * @see src/runtime-launch.ts - Log tail helper reused for `logs`.
 * @documentation reviewed=2026-11-11 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { LocalEdgeCore_isHealthyHttpStatusCode } from "@gg-utils/local-edge-core/healthcheck";
import { LocalEdgeCore_runtimeStopParsePidLines, LocalEdgeCore_runtimeStopTerminatePidList, } from "@gg-utils/local-edge-core/runtime-stop";
import { LOCAL_EDGE_KIT_LAUNCH_ID_ENV, LocalEdgeKit_formatPidFile, LocalEdgeKit_newLaunchId, LocalEdgeKit_parsePidFile, LocalEdgeKit_readProcessIdentity, LocalEdgeKit_verifyProcessIdentity, } from "./process-identity.js";
import { LocalEdgeKit_createFileExclusive, LocalEdgeKit_ensureSafeDir, LocalEdgeKit_openAppendSafe, LocalEdgeKit_writeFileAtomic, } from "./safe-write.js";
const LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_START_TIMEOUT_MS = 60_000;
const LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_STOP_TIMEOUT_MS = 10_000;
const LOCAL_EDGE_KIT_SUPERVISOR_POLL_MS = 500;
/** Child script for `fetchUnixSocketText`: one GET over a unix socket, body on stdout, exit 0 on 200. */
const LOCAL_EDGE_KIT_UNIX_SOCKET_FETCH_SCRIPT = [
    'const http = require("node:http");',
    "const [socketPath, urlPath, ms] = process.argv.slice(1);",
    "const req = http.get({ socketPath, path: urlPath, timeout: Number(ms) }, (res) => {",
    '  let body = ""; res.setEncoding("utf8");',
    '  res.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });',
    '  res.on("end", () => { process.stdout.write(body); process.exit(res.statusCode === 200 ? 0 : 1); });',
    "});",
    'req.on("timeout", () => req.destroy());',
    'req.on("error", () => process.exit(1));',
].join("\n");
function LocalEdgeKit_runCapture(command, args) {
    const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return { status: result.status, stdout: result.stdout ?? "" };
}
/**
 * Real host effects: `ps`/`lsof` for inspection, `process.kill` for signals, `safe-write.ts` for
 * every file write. Spawned apps get their own process group and append to their log file.
 *
 * @returns A host for `LocalEdgeKit_supervisorUp`/`Down` and the CLI.
 * @example
 * ```typescript
 * const host = LocalEdgeKit_createSupervisorHost();
 * LocalEdgeKit_inspectSupervisedApp(app, host);
 * ```
 */
export function LocalEdgeKit_createSupervisorHost() {
    const sleepSync = (ms) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    };
    const processGroupOf = (pid) => {
        const result = LocalEdgeKit_runCapture("ps", ["-o", "pgid=", "-p", String(pid)]);
        const value = Number(result.stdout.trim());
        return result.status === 0 && Number.isInteger(value) && value > 0 ? value : null;
    };
    return {
        readText: (filePath) => (existsSync(filePath) ? readFileSync(filePath, "utf8") : null),
        writeText: (filePath, text, options) => LocalEdgeKit_writeFileAtomic(filePath, text, options),
        createExclusive: (filePath, text, options) => LocalEdgeKit_createFileExclusive(filePath, text, options),
        ensureDir: (dirPath, options) => {
            LocalEdgeKit_ensureSafeDir(dirPath, options);
        },
        runCommand: (command, args) => {
            const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
            return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
        },
        realPath: (filePath) => {
            try {
                return realpathSync(filePath);
            }
            catch {
                return null;
            }
        },
        fetchUnixSocketText: (socketPath, urlPath, timeoutMs) => {
            const result = spawnSync(process.execPath, ["-e", LOCAL_EDGE_KIT_UNIX_SOCKET_FETCH_SCRIPT, socketPath, urlPath, String(timeoutMs)], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: timeoutMs + 2000,
            });
            return result.status === 0 ? (result.stdout ?? "") : null;
        },
        removeFile: (filePath) => rmSync(filePath, { force: true }),
        fileSize: (filePath) => (existsSync(filePath) ? statSync(filePath).size : 0),
        pidIsAlive: (pid) => {
            try {
                process.kill(pid, 0);
                return true;
            }
            catch (error) {
                return error.code === "EPERM";
            }
        },
        processIdentity: (pid) => LocalEdgeKit_readProcessIdentity(pid),
        ownPid: () => process.pid,
        processGroupOf,
        parentOf: (pid) => {
            const result = LocalEdgeKit_runCapture("ps", ["-o", "ppid=", "-p", String(pid)]);
            const value = Number(result.stdout.trim());
            return result.status === 0 && Number.isInteger(value) && value > 0 ? value : null;
        },
        ownProcessGroup: () => processGroupOf(process.pid),
        listenerPids: (port) => {
            const result = LocalEdgeKit_runCapture("lsof", [`-tiTCP:${String(port)}`, "-sTCP:LISTEN"]);
            return result.status === 0 ? LocalEdgeCore_runtimeStopParsePidLines(result.stdout) : [];
        },
        kill: (pid, signal) => {
            process.kill(pid, signal);
        },
        httpStatus: async (url, timeoutMs) => {
            try {
                const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
                await response.body?.cancel();
                return response.status;
            }
            catch {
                return null;
            }
        },
        spawnDetached: (options) => {
            const fd = LocalEdgeKit_openAppendSafe(options.logFile, { root: options.logRoot });
            try {
                const child = spawn(options.command, [...options.args], {
                    cwd: options.cwd,
                    detached: true,
                    env: {
                        ...process.env,
                        ...options.env,
                        ...(options.launchId === undefined ? {} : { [LOCAL_EDGE_KIT_LAUNCH_ID_ENV]: options.launchId }),
                    },
                    stdio: ["ignore", fd, fd],
                });
                child.unref();
                if (child.pid === undefined) {
                    throw new Error(`could not spawn ${options.command}`);
                }
                return child.pid;
            }
            finally {
                closeSync(fd);
            }
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        sleepSync,
        now: () => Date.now(),
    };
}
/**
 * Resolves an app path against its cwd (or the process cwd when the app has none).
 *
 * @param app - The app.
 * @param filePath - Path from the app config, relative or absolute.
 * @returns An absolute path. It is not checked for containment; writers check that.
 * @example
 * ```typescript
 * LocalEdgeKit_resolveAppPath({ ...app, cwd: "/w/web" }, ".local/edge.pid"); // "/w/web/.local/edge.pid"
 * ```
 */
export function LocalEdgeKit_resolveAppPath(app, filePath) {
    return path.resolve(app.cwd ?? process.cwd(), filePath);
}
/**
 * Validates supervisor apps: unique ids, required fields on enabled apps, unique local ports,
 * known dependencies, enabled apps depending only on enabled apps, and no cycles.
 *
 * @param apps - All configured apps.
 * @returns One line per problem; an empty list means valid. Never throws.
 * @example
 * ```typescript
 * LocalEdgeKit_validateSupervisedApps(config.apps); // [] or ["web: depends on unknown app \"db\""]
 * ```
 */
export function LocalEdgeKit_validateSupervisedApps(apps) {
    const problems = [];
    const byId = new Map();
    for (const app of apps) {
        if (byId.has(app.id)) {
            problems.push(`app id "${app.id}" is listed twice`);
        }
        byId.set(app.id, app);
    }
    const ports = new Map();
    for (const app of apps) {
        if (!app.healthPath.startsWith("/")) {
            problems.push(`${app.id}: healthPath must start with /`);
        }
        if (!app.enabled) {
            continue;
        }
        if (app.external === true) {
            if (app.command !== undefined) {
                problems.push(`${app.id}: external apps are route only and may not set command`);
            }
        }
        else if (!app.cwd || !app.command || !app.pidFile || !app.logFile) {
            problems.push(`${app.id}: enabled apps need cwd, command, pidFile and logFile`);
        }
        const other = ports.get(app.localPort);
        if (other !== undefined) {
            problems.push(`${app.id}: local port ${String(app.localPort)} is also used by ${other}`);
        }
        ports.set(app.localPort, app.id);
        for (const dep of app.dependsOn ?? []) {
            const target = byId.get(dep);
            if (target === undefined) {
                problems.push(`${app.id}: depends on unknown app "${dep}"`);
            }
            else if (!target.enabled) {
                problems.push(`${app.id}: depends on disabled app "${dep}"`);
            }
        }
    }
    try {
        LocalEdgeKit_orderSupervisedApps(apps, apps.map((app) => app.id));
    }
    catch (error) {
        problems.push(error.message);
    }
    return problems;
}
/**
 * Returns the requested apps plus their dependencies, dependencies first.
 *
 * @param apps - All configured apps.
 * @param requestedIds - Ids to start.
 * @returns Apps in start order, each once.
 * @throws When an id is unknown or the dependency graph has a cycle.
 * @example
 * ```typescript
 * LocalEdgeKit_orderSupervisedApps(apps, ["web"]).map((app) => app.id); // ["auth", "web"]
 * ```
 */
export function LocalEdgeKit_orderSupervisedApps(apps, requestedIds) {
    const byId = new Map(apps.map((app) => [app.id, app]));
    const ordered = [];
    const done = new Set();
    const visiting = new Set();
    const visit = (id, trail) => {
        if (done.has(id)) {
            return;
        }
        const app = byId.get(id);
        if (app === undefined) {
            throw new Error(`unknown app "${id}"`);
        }
        if (visiting.has(id)) {
            throw new Error(`dependency cycle: ${[...trail, id].join(" -> ")}`);
        }
        visiting.add(id);
        for (const dep of app.dependsOn ?? []) {
            if (byId.has(dep)) {
                visit(dep, [...trail, id]);
            }
        }
        visiting.delete(id);
        done.add(id);
        ordered.push(app);
    };
    for (const id of requestedIds) {
        visit(id, []);
    }
    return ordered;
}
/**
 * Lists which required env names are absent or empty in an env file. Only names are returned;
 * values are read to test emptiness and then dropped.
 *
 * @param options - Env file text (null when there is no file) and the required names.
 * @returns Missing or empty names, in the order given.
 * @example
 * ```typescript
 * LocalEdgeKit_missingEnvNames({ envText: "A=1\nB=\n", requiredNames: ["A", "B"] }); // ["B"]
 * ```
 */
export function LocalEdgeKit_missingEnvNames(options) {
    if (options.requiredNames.length === 0) {
        return [];
    }
    const present = new Set();
    for (const line of (options.envText ?? "").split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match?.[1]) {
            continue;
        }
        const rawValue = (match[2] ?? "").trim();
        const unquoted = rawValue.replace(/^(['"])(.*)\1$/, "$2");
        if (unquoted.length > 0 && !unquoted.startsWith("#")) {
            present.add(match[1]);
        }
    }
    return options.requiredNames.filter((name) => !present.has(name));
}
/**
 * True when `listener` belongs to the process tree started by `pid`: it is `pid`, shares its
 * process group, or has `pid` among its ancestors (up to 32 levels). Dev servers often move
 * their server into a child process group, so the group check alone is not enough. Callers must
 * have verified `pid`'s identity first; this only relates the listener to it.
 *
 * @param options - Listener pid, verified pid, its process group and the host.
 * @returns Whether the listener is part of that process tree.
 * @example
 * ```typescript
 * LocalEdgeKit_listenerBelongsTo({ listener: 41941, pid: 41844, processGroup: 41844, host });
 * ```
 */
export function LocalEdgeKit_listenerBelongsTo(options) {
    const { listener, pid, processGroup, host } = options;
    if (listener === pid || (processGroup !== null && host.processGroupOf(listener) === processGroup)) {
        return true;
    }
    let current = listener;
    for (let depth = 0; depth < 32 && current !== null && current > 1; depth += 1) {
        current = host.parentOf(current);
        if (current === pid) {
            return true;
        }
    }
    return false;
}
/**
 * Reads a pid file and returns its pid.
 *
 * @param host - Supervisor host.
 * @param filePath - Absolute pid file path.
 * @returns A positive integer pid, or null when the file is absent or malformed.
 * @example
 * ```typescript
 * LocalEdgeKit_readPidFile(host, "/w/app/.local/app.pid"); // 4242
 * ```
 */
export function LocalEdgeKit_readPidFile(host, filePath) {
    return LocalEdgeKit_parsePidFile(host.readText(filePath)).pid;
}
/**
 * Inspects one app by pid file, recorded identity and port check. Read-only: never writes or
 * signals.
 *
 * @param app - The app.
 * @param host - Supervisor host.
 * @returns `running`/`starting` only for a live process whose identity matches the recorded one;
 * `unverified` for a live pid without a recorded identity; `stale-pid` for a dead or recycled
 * pid; `port-busy` when the port is held by a process that is not ours.
 * @example
 * ```typescript
 * LocalEdgeKit_inspectSupervisedApp(app, host).state; // "running"
 * ```
 */
export function LocalEdgeKit_inspectSupervisedApp(app, host) {
    const listenerPids = host.listenerPids(app.localPort);
    const base = { appId: app.id, listenerPids, identity: null };
    if (!app.enabled) {
        const busy = listenerPids.length > 0 ? `; port ${String(app.localPort)} is in use` : "";
        return { ...base, state: "disabled", pid: null, processGroup: null, note: `${app.disabledReason ?? "disabled"}${busy}` };
    }
    if (app.external === true) {
        const listening = listenerPids.length > 0;
        return { ...base, state: "external", pid: null, processGroup: null, note: `route only; port ${listening ? "listening" : "not listening"}` };
    }
    const parsed = LocalEdgeKit_parsePidFile(app.pidFile ? host.readText(LocalEdgeKit_resolveAppPath(app, app.pidFile)) : null);
    const { pid } = parsed;
    const current = pid === null ? null : host.processIdentity(pid);
    const check = pid === null ? null : LocalEdgeKit_verifyProcessIdentity({ pid, recorded: parsed.identity, current });
    if (pid !== null && check?.ok === true) {
        const processGroup = host.processGroupOf(pid);
        const verified = { ...base, pid, processGroup, identity: parsed.identity };
        if (listenerPids.length === 0) {
            return { ...verified, state: "starting", note: "process alive, port not listening yet" };
        }
        const owned = listenerPids.some((listener) => LocalEdgeKit_listenerBelongsTo({ listener, pid, processGroup, host }));
        if (owned) {
            return { ...verified, state: "running", note: "pid file process holds the port" };
        }
        return { ...verified, state: "port-busy", note: `port held by another process (${listenerPids.join(",")})` };
    }
    const failure = check !== null && !check.ok ? check : null;
    if (pid !== null && (failure?.reason === "unrecorded" || (current === null && host.pidIsAlive(pid)))) {
        const why = failure?.reason === "unrecorded" ? failure.message : `pid ${String(pid)} is alive but its identity cannot be read`;
        return { ...base, state: "unverified", pid, processGroup: null, note: `${why}; not adopted or signalled, stop it yourself and remove the pid file` };
    }
    const stale = failure?.message ?? "";
    if (listenerPids.length > 0) {
        const prefix = pid === null ? "no pid file process" : `pid file is stale (${stale})`;
        return { ...base, state: "port-busy", pid, processGroup: null, note: `${prefix}; port held by ${listenerPids.join(",")}` };
    }
    if (pid !== null) {
        return { ...base, state: "stale-pid", pid, processGroup: null, note: `pid file is stale: ${stale}` };
    }
    return { ...base, state: "stopped", pid: null, processGroup: null, note: "not running" };
}
/**
 * Probes an app's health path (and ready path, when set) on `127.0.0.1`.
 *
 * @param app - The app.
 * @param host - Supervisor host (HTTP through `host.httpStatus`).
 * @param timeoutMs - Per-request timeout. Default 3000.
 * @returns Per-path status; healthy when every path answers 2xx/3xx. Never throws.
 * @example
 * ```typescript
 * (await LocalEdgeKit_probeSupervisedAppHealth(app, host)).healthy;
 * ```
 */
export async function LocalEdgeKit_probeSupervisedAppHealth(app, host, timeoutMs = 3000) {
    const paths = [app.healthPath, ...(app.readyPath ? [app.readyPath] : [])];
    const checks = await Promise.all(paths.map(async (probePath) => {
        const status = await host.httpStatus(`http://127.0.0.1:${String(app.localPort)}${probePath}`, timeoutMs);
        return { path: probePath, status, ok: LocalEdgeCore_isHealthyHttpStatusCode(status) };
    }));
    return { appId: app.id, healthy: checks.every((check) => check.ok), checks };
}
function LocalEdgeKit_logContainsSince(app, host, offset) {
    if (!app.readyLogLine || !app.logFile) {
        return true;
    }
    const text = host.readText(LocalEdgeKit_resolveAppPath(app, app.logFile)) ?? "";
    return text.slice(offset).includes(app.readyLogLine);
}
/**
 * Waits until the app is healthy and, when `readyLogLine` is set, that line appeared in the log
 * after `logOffset`. Polls every 500 ms.
 *
 * @param options - App, host, log offset, timeout and the pid that must stay alive meanwhile.
 * @returns `ready: false` with a reason when the pid exits or the timeout passes.
 * @example
 * ```typescript
 * await LocalEdgeKit_waitForSupervisedAppReady({ app, host, logOffset: 0, timeoutMs: 60_000, pid });
 * ```
 */
export async function LocalEdgeKit_waitForSupervisedAppReady(options) {
    const { app, host } = options;
    const deadline = host.now() + options.timeoutMs;
    let last = "not probed";
    for (;;) {
        if (options.pid !== undefined && !host.pidIsAlive(options.pid)) {
            return { ready: false, message: "process exited before it became ready; see logs" };
        }
        const health = await LocalEdgeKit_probeSupervisedAppHealth(app, host);
        const logReady = LocalEdgeKit_logContainsSince(app, host, options.logOffset);
        if (health.healthy && logReady) {
            return { ready: true, message: "healthy" };
        }
        last = health.checks.map((check) => `${check.path}=${String(check.status ?? "no answer")}`).join(" ");
        if (!logReady) {
            last += " (ready log line not seen)";
        }
        if (host.now() >= deadline) {
            return { ready: false, message: `not ready after ${String(options.timeoutMs)} ms: ${last}` };
        }
        await host.sleep(LOCAL_EDGE_KIT_SUPERVISOR_POLL_MS);
    }
}
/** Lock and guard file text: pid, identity JSON (empty when unreadable) and a random token. */
function LocalEdgeKit_formatLockFile(pid, identity, token) {
    return `${String(pid)}\n${identity === null ? "" : JSON.stringify(identity)}\n${token}\n`;
}
/** Parses lock or guard text; `token` is null for an empty, partial or older lock. */
function LocalEdgeKit_parseLockFile(text) {
    const token = text.split("\n")[2]?.trim() ?? "";
    return { ...LocalEdgeKit_parsePidFile(text), token: /^[0-9a-f]{32}$/.test(token) ? token : null };
}
/** True only when the holder's process is provably gone: dead, or its identity changed. */
function LocalEdgeKit_lockHolderGone(host, holder) {
    const current = host.processIdentity(holder.pid);
    if (current === null) {
        return !host.pidIsAlive(holder.pid);
    }
    const check = LocalEdgeKit_verifyProcessIdentity({ pid: holder.pid, recorded: holder.identity, current });
    return !check.ok && check.reason !== "unrecorded";
}
const LOCAL_EDGE_KIT_LOCK_MAX_GUARD_DEPTH = 4;
/** Guard key for one exact lock content: its SHA-256, shortened. */
function LocalEdgeKit_lockContentKey(text) {
    return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}
/**
 * Removes the stale file at `filePath` only if it is still exactly `seenText`, under the
 * takeover guard `<filePath>.takeover-<key of seenText>`.
 *
 * @returns `"retry"` when the caller should try to publish again, or an error message.
 */
function LocalEdgeKit_removeStaleUnderGuard(options) {
    const { filePath, host, root } = options;
    const guardFile = `${filePath}.takeover-${LocalEdgeKit_lockContentKey(options.seenText)}`;
    const guardToken = randomBytes(16).toString("hex");
    if (!host.createExclusive(guardFile, options.ownText(guardToken), { root })) {
        const guardText = host.readText(guardFile);
        if (guardText === null) {
            return "retry";
        }
        const guard = LocalEdgeKit_parseLockFile(guardText);
        if (guard.pid === null || guard.identity === null) {
            return { error: `takeover guard ${guardFile} is empty or unreadable; if no supervisor runs, remove it` };
        }
        if (!LocalEdgeKit_lockHolderGone(host, { pid: guard.pid, identity: guard.identity })) {
            return { error: `another supervisor (pid ${String(guard.pid)}) is taking over ${filePath}` };
        }
        if (options.depth >= LOCAL_EDGE_KIT_LOCK_MAX_GUARD_DEPTH) {
            return { error: `too many abandoned takeover guards beside ${filePath}; remove them by hand` };
        }
        const nested = LocalEdgeKit_removeStaleUnderGuard({
            ...options,
            filePath: guardFile,
            seenText: guardText,
            depth: options.depth + 1,
        });
        return nested === "retry" ? "retry" : nested;
    }
    try {
        if (host.readText(filePath) === options.seenText) {
            host.removeFile(filePath);
        }
    }
    finally {
        const guardNow = host.readText(guardFile);
        if (guardNow !== null && LocalEdgeKit_parseLockFile(guardNow).token === guardToken) {
            host.removeFile(guardFile);
        }
    }
    return "retry";
}
/**
 * Takes the per-app supervisor lock `<pidFile>.lock` inside the app's `cwd`. The lock file holds
 * the owner's pid, identity and a random 128-bit token. A lock whose owner is gone (or is a
 * recycled pid) is taken over; a live owner, or an owner without a readable identity, keeps it.
 *
 * Why at most one owner:
 * 1. Publication is atomic. `host.createExclusive` writes the complete text to a unique temp
 *    file and `link()`s it to the lock path, which fails with EEXIST when a lock exists. A lock
 *    is therefore never visible empty or half-written, and no two creations both succeed.
 * 2. A lock file is removed only by its owner's `release` (which re-reads it and removes it
 *    only when it holds the owner's token) or by a takeover. An owner cannot lose its lock while
 *    it is alive, because a takeover needs the holder to be provably gone.
 * 3. A takeover of the stale lock S first creates the guard `<lock>.takeover-<k>`, where `k`
 *    is the SHA-256 of S's bytes, the same exclusive way, then re-reads the lock and removes it
 *    only when its bytes are still exactly S. While the guard is held, S cannot be replaced: its
 *    owner is dead, only the guard holder may remove it, and nothing can be published over an
 *    existing file. So the removal removes S and never a successor. A contender that judged S
 *    stale too, but gets the guard only after S was removed, finds other bytes and removes
 *    nothing. Every lock carries a random token (an older version's lock carries the identity
 *    of a process that is now gone), so no later lock has S's bytes.
 * 4. A guard whose holder died is itself stale and is taken over by the same rule, under the
 *    guard `<guard>.takeover-<k>` (at most four levels deep).
 * 5. A lock without a pid and a complete identity (empty or partial) is never removed
 *    automatically: an older version, which wrote after an exclusive open, could still be
 *    writing it. The caller gets an error that says to remove it by
 *    hand once no supervisor runs.
 *
 * @param app - The app; `pidFile` and `cwd` locate the lock.
 * @param host - Supervisor host.
 * @returns `{ lock }` on success, or `{ error }` naming the holder.
 * @example
 * ```typescript
 * const taken = LocalEdgeKit_acquireSupervisorLock(app, host);
 * if ("lock" in taken) try { ... } finally { taken.lock.release(); }
 * ```
 */
export function LocalEdgeKit_acquireSupervisorLock(app, host) {
    const root = app.cwd ?? process.cwd();
    if (!app.pidFile) {
        return { error: `${app.id} has no pid file to lock` };
    }
    const lockFile = `${LocalEdgeKit_resolveAppPath(app, app.pidFile)}.lock`;
    const ownPid = host.ownPid();
    const ownIdentity = host.processIdentity(ownPid);
    const ownText = (token) => LocalEdgeKit_formatLockFile(ownPid, ownIdentity, token);
    const token = randomBytes(16).toString("hex");
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (host.createExclusive(lockFile, ownText(token), { root })) {
            return {
                lock: {
                    release: () => {
                        const now = host.readText(lockFile);
                        if (now !== null && LocalEdgeKit_parseLockFile(now).token === token) {
                            host.removeFile(lockFile);
                        }
                    },
                },
            };
        }
        const seenText = host.readText(lockFile);
        if (seenText === null) {
            continue;
        }
        const holder = LocalEdgeKit_parseLockFile(seenText);
        if (holder.pid === null || holder.identity === null) {
            return {
                error: `${lockFile} is empty or unreadable (a supervisor may still be writing it); if no supervisor runs, remove it`,
            };
        }
        if (!LocalEdgeKit_lockHolderGone(host, { pid: holder.pid, identity: holder.identity })) {
            return { error: `another supervisor (pid ${String(holder.pid)}) holds ${lockFile}` };
        }
        const removed = LocalEdgeKit_removeStaleUnderGuard({
            filePath: lockFile,
            seenText,
            root,
            host,
            ownText,
            depth: 0,
        });
        if (removed !== "retry") {
            return removed;
        }
    }
    return { error: `could not take ${lockFile}` };
}
/**
 * Starts the requested apps and their dependencies in order, adopting any that already run
 * (pid file process with a matching identity). Stops at the first failure; later apps are
 * reported as skipped. Inspection, spawn and pid file publication run under the app's lock.
 *
 * @param options - Apps, requested ids, host and progress writer.
 * @returns One result per app in start order.
 * @throws When a requested id is unknown or dependencies form a cycle.
 * @example
 * ```typescript
 * const results = await LocalEdgeKit_supervisorUp({ apps, requestedIds: ["web"], host, out: process.stderr });
 * ```
 */
export async function LocalEdgeKit_supervisorUp(options) {
    const { host, out } = options;
    const ordered = LocalEdgeKit_orderSupervisedApps(options.apps, options.requestedIds);
    const results = [];
    let failed = false;
    for (const app of ordered) {
        if (failed) {
            results.push({ appId: app.id, ok: false, action: "skipped", message: "an earlier app failed" });
            continue;
        }
        if (!app.enabled) {
            results.push({ appId: app.id, ok: true, action: "skipped", message: app.disabledReason ?? "disabled" });
            continue;
        }
        if (app.external === true) {
            results.push({ appId: app.id, ok: true, action: "skipped", message: "external: route only, never started" });
            continue;
        }
        const timeoutMs = app.startTimeoutMs ?? LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_START_TIMEOUT_MS;
        const step = LocalEdgeKit_startUnderLock(app, host, out);
        if ("result" in step) {
            results.push(step.result);
            failed ||= !step.result.ok;
            continue;
        }
        const ready = await LocalEdgeKit_waitForSupervisedAppReady({ app, host, logOffset: step.logOffset, timeoutMs, pid: step.pid });
        if (ready.ready && step.action === "started") {
            LocalEdgeKit_refreshRecordedIdentity(app, host, step.pid, step.identity);
        }
        results.push({ appId: app.id, ok: ready.ready, action: ready.ready ? step.action : "failed", message: ready.message });
        failed ||= !ready.ready;
    }
    return results;
}
/** Lock, inspect, then adopt or spawn and publish the pid file; unlock before the health wait. */
function LocalEdgeKit_startUnderLock(app, host, out) {
    const fail = (message) => ({ result: { appId: app.id, ok: false, action: "failed", message } });
    const taken = LocalEdgeKit_acquireSupervisorLock(app, host);
    if ("error" in taken) {
        return fail(`not starting: ${taken.error}`);
    }
    try {
        const inspection = LocalEdgeKit_inspectSupervisedApp(app, host);
        if ((inspection.state === "running" || inspection.state === "starting") && inspection.pid !== null) {
            out.write(`[${app.id}] adopting pid ${String(inspection.pid)} (${inspection.state})\n`);
            return { action: "adopted", pid: inspection.pid, logOffset: 0, identity: inspection.identity };
        }
        if (inspection.state === "port-busy" || inspection.state === "unverified") {
            return fail(`refusing to start: ${inspection.note}`);
        }
        let launchEnv;
        try {
            launchEnv = typeof app.launchEnv === "function" ? app.launchEnv() : (app.launchEnv ?? {});
        }
        catch (error) {
            return fail(`launch env unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
        const launchNames = Object.keys(launchEnv);
        const missing = LocalEdgeKit_missingEnvNames({
            envText: app.envFile ? host.readText(LocalEdgeKit_resolveAppPath(app, app.envFile)) : null,
            requiredNames: (app.requiredEnvNames ?? []).filter((name) => !launchNames.includes(name)),
        });
        if (missing.length > 0) {
            return fail(`env file lacks: ${missing.join(", ")}`);
        }
        const root = app.cwd ?? process.cwd();
        const logFile = LocalEdgeKit_resolveAppPath(app, app.logFile ?? "");
        const logOffset = host.fileSize(logFile);
        if (launchNames.length > 0) {
            out.write(`[${app.id}] launch env: ${launchNames.join(", ")}\n`);
        }
        const launchId = LocalEdgeKit_newLaunchId();
        const pid = host.spawnDetached({ cwd: root, command: app.command ?? "", args: app.args ?? [], logFile, logRoot: root, env: launchEnv, launchId });
        const read = host.processIdentity(pid);
        const identity = read === null ? null : { ...read, launchId };
        host.writeText(LocalEdgeKit_resolveAppPath(app, app.pidFile ?? ""), LocalEdgeKit_formatPidFile(pid, identity), { root });
        out.write(`[${app.id}] started pid ${String(pid)}, waiting for health\n`);
        return { action: "started", pid, logOffset, identity };
    }
    catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
    finally {
        taken.lock.release();
    }
}
/**
 * After a successful start, records the command line again when the same process (same uid and
 * start time) changed its title while starting, so a later stop still recognises it.
 */
function LocalEdgeKit_refreshRecordedIdentity(app, host, pid, recorded) {
    const current = host.processIdentity(pid);
    if (recorded === null ||
        current === null ||
        current.uid !== recorded.uid ||
        current.startedAt !== recorded.startedAt ||
        current.command === recorded.command ||
        (typeof recorded.launchId === "string" && current.launchId !== undefined && current.launchId !== recorded.launchId)) {
        return;
    }
    if (!app.pidFile) {
        return;
    }
    const pidFile = LocalEdgeKit_resolveAppPath(app, app.pidFile);
    if (LocalEdgeKit_parsePidFile(host.readText(pidFile)).pid === pid) {
        const refreshed = { uid: current.uid, startedAt: current.startedAt, command: current.command, ...(typeof recorded.launchId === "string" ? { launchId: recorded.launchId } : {}) };
        host.writeText(pidFile, LocalEdgeKit_formatPidFile(pid, refreshed), { root: app.cwd ?? process.cwd() });
    }
}
/**
 * Stops the requested apps, dependants first. Only a pid file process whose recorded identity
 * matches is signalled, and the identity is checked again before every signal; a foreign
 * listener, a recycled pid and an unverified pid are never touched. Runs under the app's lock.
 *
 * @param options - Apps, requested ids, host and progress writer.
 * @returns One result per requested app in stop order.
 * @throws When a requested id is unknown or dependencies form a cycle.
 * @example
 * ```typescript
 * LocalEdgeKit_supervisorDown({ apps, requestedIds: ["web"], host, out: process.stderr });
 * ```
 */
export function LocalEdgeKit_supervisorDown(options) {
    const { host } = options;
    const requested = new Set(options.requestedIds);
    const ordered = LocalEdgeKit_orderSupervisedApps(options.apps, options.requestedIds)
        .filter((app) => requested.has(app.id))
        .reverse();
    return ordered.map((app) => {
        if (!app.enabled) {
            return { appId: app.id, ok: true, action: "skipped", message: app.disabledReason ?? "disabled" };
        }
        if (app.external === true || !app.pidFile) {
            return { appId: app.id, ok: true, action: "skipped", message: "external: route only, never signalled" };
        }
        const taken = LocalEdgeKit_acquireSupervisorLock(app, host);
        if ("error" in taken) {
            return { appId: app.id, ok: false, action: "failed", message: `not stopping: ${taken.error}` };
        }
        try {
            return LocalEdgeKit_stopLocked(app, host, options.out);
        }
        catch (error) {
            return { appId: app.id, ok: false, action: "failed", message: error instanceof Error ? error.message : String(error) };
        }
        finally {
            taken.lock.release();
        }
    });
}
function LocalEdgeKit_stopLocked(app, host, out) {
    const inspection = LocalEdgeKit_inspectSupervisedApp(app, host);
    const pidFile = LocalEdgeKit_resolveAppPath(app, app.pidFile ?? "");
    if (inspection.state === "stopped") {
        return { appId: app.id, ok: true, action: "already-stopped", message: "not running" };
    }
    if (inspection.state === "stale-pid") {
        host.removeFile(pidFile);
        return { appId: app.id, ok: true, action: "already-stopped", message: `removed stale pid file (${inspection.note})` };
    }
    const { pid, identity } = inspection;
    if (pid === null || identity === null) {
        return { appId: app.id, ok: false, action: "failed", message: `not stopping: ${inspection.note}` };
    }
    const targets = [{ pid, identity }];
    for (const listener of inspection.listenerPids) {
        if (listener === pid || !LocalEdgeKit_listenerBelongsTo({ listener, pid, processGroup: inspection.processGroup, host })) {
            continue;
        }
        const listenerIdentity = host.processIdentity(listener);
        if (listenerIdentity !== null) {
            targets.push({ pid: listener, identity: listenerIdentity });
        }
    }
    LocalEdgeKit_terminateProcessGroup({
        targets,
        host,
        timeoutMs: app.stopTimeoutMs ?? LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_STOP_TIMEOUT_MS,
        out,
    });
    const stillOurs = LocalEdgeKit_verifyProcessIdentity({ pid, recorded: identity, current: host.processIdentity(pid) }).ok;
    if (!stillOurs) {
        host.removeFile(pidFile);
    }
    return {
        appId: app.id,
        ok: !stillOurs,
        action: stillOurs ? "failed" : "stopped",
        message: stillOurs ? "process survived SIGKILL" : `stopped pid ${String(pid)}`,
    };
}
/**
 * Sends SIGTERM to the process group of each target (such as the pid file process and an owned
 * listener in a child group), waits up to `timeoutMs`, then SIGKILL. Immediately before every
 * signal, including the liveness probes, the target's identity is read again; a target that is
 * gone, recycled or has left its group is treated as exited and is not signalled again.
 *
 * @param options - Targets with recorded identities, host, timeout and progress writer.
 * @remarks
 * A target that shares the supervisor's own process group is signalled by pid only, so the
 * supervisor never signals its own group. A group is signalled only while its recorded member
 * is still in it.
 * @example
 * ```typescript
 * LocalEdgeKit_terminateProcessGroup({ targets: [{ pid, identity }], host, timeoutMs: 10_000, out: process.stderr });
 * ```
 */
export function LocalEdgeKit_terminateProcessGroup(options) {
    const { host } = options;
    const ownGroup = host.ownProcessGroup();
    const guards = new Map();
    for (const target of options.targets) {
        const group = host.processGroupOf(target.pid);
        const signalPid = group !== null && group > 1 && group !== ownGroup ? -group : target.pid;
        guards.set(signalPid, () => {
            const current = host.processIdentity(target.pid);
            const same = LocalEdgeKit_verifyProcessIdentity({ pid: target.pid, recorded: target.identity, current }).ok;
            return same && (signalPid > 0 || host.processGroupOf(target.pid) === -signalPid);
        });
    }
    const guardedKill = (pid, signal) => {
        if (guards.get(pid)?.() !== true) {
            throw Object.assign(new Error(`pid ${String(pid)} is no longer the recorded process`), { code: "ESRCH" });
        }
        host.kill(pid, signal);
    };
    const probe = (pid) => {
        try {
            guardedKill(pid, 0);
            return true;
        }
        catch {
            return false;
        }
    };
    LocalEdgeCore_runtimeStopTerminatePidList({
        pids: [...guards.keys()],
        kill: (pid, signal) => guardedKill(pid, signal ?? "SIGTERM"),
        pidIsAlive: probe,
        stderr: options.out,
        waitForPidsExit: ({ pids }) => {
            const deadline = host.now() + options.timeoutMs;
            for (;;) {
                if (!pids.some(probe)) {
                    return true;
                }
                if (host.now() >= deadline) {
                    return false;
                }
                host.sleepSync(200);
            }
        },
    });
}
