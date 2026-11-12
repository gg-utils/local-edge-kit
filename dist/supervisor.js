/**
 * @fileoverview Generic app supervisor: start, stop, adopt, status, health and logs for a set of
 * loopback apps described by a project-owned config, each with a pid file and a log file.
 *
 * The supervisor never assumes it started a process. An app counts as running when its pid file
 * names a live process and the app's loopback port is held by a process in the same process
 * group, so processes started by someone else are adopted instead of started twice. A port held
 * by anything else is reported as busy and never killed. Stop signals the app's process group
 * (SIGTERM, then SIGKILL after a timeout) through the core runtime-stop helper.
 * Env checks read names only: values are never returned or printed. Launch env values go to the
 * started process only; output lists their names. External apps are route only: never started,
 * stopped or signalled. Pid files are written atomically and log files opened without following
 * symlinks, both inside the app's cwd.
 * Flow: config -> validate + dependency order -> inspect (pid file + port) -> start/stop/health.
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor.unit.test.ts
 *
 * @see src/supervisor-cli.ts - Command dispatcher that wires this module to an exposure backend.
 * @see src/runtime-launch.ts - Log tail helper reused for `logs`.
 * @documentation reviewed=2026-11-11 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { LocalEdgeCore_isHealthyHttpStatusCode } from "@gg-utils/local-edge-core/healthcheck";
import { LocalEdgeCore_runtimeStopParsePidLines, LocalEdgeCore_runtimeStopTerminatePidList, } from "@gg-utils/local-edge-core/runtime-stop";
import { LocalEdgeKit_openAppendSafe, LocalEdgeKit_prepareSafeTarget, LocalEdgeKit_writeFileAtomic } from "./safe-write.js";
const LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_START_TIMEOUT_MS = 60_000;
const LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_STOP_TIMEOUT_MS = 10_000;
const LOCAL_EDGE_KIT_SUPERVISOR_POLL_MS = 500;
function LocalEdgeKit_runCapture(command, args) {
    const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return { status: result.status, stdout: result.stdout ?? "" };
}
/** Real host effects. Spawned apps get their own process group and append to their log file. */
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
        ensureDir: (dirPath, options) => {
            LocalEdgeKit_prepareSafeTarget(path.join(dirPath, ".probe"), options);
        },
        runCommand: (command, args) => {
            const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
            return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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
                    env: { ...process.env, ...options.env },
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
/** Resolves an app path against its cwd. */
export function LocalEdgeKit_resolveAppPath(app, filePath) {
    return path.resolve(app.cwd ?? process.cwd(), filePath);
}
/**
 * Validates supervisor apps: unique ids, required fields on enabled apps, known dependencies,
 * enabled apps depending only on enabled apps, and no cycles. Returns problems; empty is valid.
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
 * @throws When an id is unknown or the dependency graph has a cycle.
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
 * process group, or has `pid` among its ancestors. Dev servers often move their server into a
 * child process group, so the group check alone is not enough.
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
/** Reads a pid file and returns a positive integer pid, or null. */
export function LocalEdgeKit_readPidFile(host, filePath) {
    const text = host.readText(filePath);
    if (text === null) {
        return null;
    }
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}
/** Inspects one app by pid file plus port check. Read-only. */
export function LocalEdgeKit_inspectSupervisedApp(app, host) {
    const listenerPids = host.listenerPids(app.localPort);
    const base = { appId: app.id, listenerPids };
    if (!app.enabled) {
        const busy = listenerPids.length > 0 ? `; port ${String(app.localPort)} is in use` : "";
        return { ...base, state: "disabled", pid: null, processGroup: null, note: `${app.disabledReason ?? "disabled"}${busy}` };
    }
    if (app.external === true) {
        const listening = listenerPids.length > 0;
        return {
            ...base,
            state: "external",
            pid: null,
            processGroup: null,
            note: `route only; port ${listening ? "listening" : "not listening"}`,
        };
    }
    const pid = app.pidFile ? LocalEdgeKit_readPidFile(host, LocalEdgeKit_resolveAppPath(app, app.pidFile)) : null;
    const alive = pid !== null && host.pidIsAlive(pid);
    const processGroup = alive ? host.processGroupOf(pid) : null;
    if (alive) {
        if (listenerPids.length === 0) {
            return { ...base, state: "starting", pid, processGroup, note: "process alive, port not listening yet" };
        }
        const owned = listenerPids.some((listener) => LocalEdgeKit_listenerBelongsTo({ listener, pid, processGroup, host }));
        if (owned) {
            return { ...base, state: "running", pid, processGroup, note: "pid file process holds the port" };
        }
        return { ...base, state: "port-busy", pid, processGroup, note: `port held by another process (${listenerPids.join(",")})` };
    }
    if (listenerPids.length > 0) {
        return { ...base, state: "port-busy", pid, processGroup: null, note: `no live pid file process; port held by ${listenerPids.join(",")}` };
    }
    if (pid !== null) {
        return { ...base, state: "stale-pid", pid, processGroup: null, note: "pid file names a dead process" };
    }
    return { ...base, state: "stopped", pid: null, processGroup: null, note: "not running" };
}
/** Probes an app's health path (and ready path, when set) on loopback. */
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
/** Waits until the app is healthy (and its ready log line appeared after `logOffset`). */
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
/**
 * Starts the requested apps and their dependencies in order, adopting any that already run.
 * Stops at the first failure; later apps are reported as skipped.
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
        const inspection = LocalEdgeKit_inspectSupervisedApp(app, host);
        if (inspection.state === "running" || inspection.state === "starting") {
            out.write(`[${app.id}] adopting pid ${String(inspection.pid)} (${inspection.state})\n`);
            const ready = await LocalEdgeKit_waitForSupervisedAppReady({ app, host, logOffset: 0, timeoutMs, pid: inspection.pid ?? undefined });
            results.push({ appId: app.id, ok: ready.ready, action: ready.ready ? "adopted" : "failed", message: ready.message });
            failed ||= !ready.ready;
            continue;
        }
        if (inspection.state === "port-busy") {
            results.push({ appId: app.id, ok: false, action: "failed", message: `refusing to start: ${inspection.note}` });
            failed = true;
            continue;
        }
        let launchEnv;
        try {
            launchEnv = typeof app.launchEnv === "function" ? app.launchEnv() : (app.launchEnv ?? {});
        }
        catch (error) {
            results.push({
                appId: app.id,
                ok: false,
                action: "failed",
                message: `launch env unavailable: ${error instanceof Error ? error.message : String(error)}`,
            });
            failed = true;
            continue;
        }
        const launchNames = Object.keys(launchEnv);
        const missing = LocalEdgeKit_missingEnvNames({
            envText: app.envFile ? host.readText(LocalEdgeKit_resolveAppPath(app, app.envFile)) : null,
            requiredNames: (app.requiredEnvNames ?? []).filter((name) => !launchNames.includes(name)),
        });
        if (missing.length > 0) {
            results.push({ appId: app.id, ok: false, action: "failed", message: `env file lacks: ${missing.join(", ")}` });
            failed = true;
            continue;
        }
        const root = app.cwd ?? process.cwd();
        const logFile = LocalEdgeKit_resolveAppPath(app, app.logFile ?? "");
        const logOffset = host.fileSize(logFile);
        if (launchNames.length > 0) {
            out.write(`[${app.id}] launch env: ${launchNames.join(", ")}\n`);
        }
        const pid = host.spawnDetached({
            cwd: root,
            command: app.command ?? "",
            args: app.args ?? [],
            logFile,
            logRoot: root,
            env: launchEnv,
        });
        host.writeText(LocalEdgeKit_resolveAppPath(app, app.pidFile ?? ""), `${String(pid)}\n`, { root });
        out.write(`[${app.id}] started pid ${String(pid)}, waiting for health\n`);
        const ready = await LocalEdgeKit_waitForSupervisedAppReady({ app, host, logOffset, timeoutMs, pid });
        results.push({ appId: app.id, ok: ready.ready, action: ready.ready ? "started" : "failed", message: ready.message });
        failed ||= !ready.ready;
    }
    return results;
}
/**
 * Stops the requested apps, dependants first. Only processes named by the app's pid file are
 * signalled; a foreign listener on the port is never touched.
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
        const inspection = LocalEdgeKit_inspectSupervisedApp(app, host);
        const pidFile = LocalEdgeKit_resolveAppPath(app, app.pidFile);
        if (inspection.state === "stopped") {
            return { appId: app.id, ok: true, action: "already-stopped", message: "not running" };
        }
        if (inspection.state === "stale-pid") {
            host.removeFile(pidFile);
            return { appId: app.id, ok: true, action: "already-stopped", message: "removed stale pid file" };
        }
        if (inspection.pid === null || !host.pidIsAlive(inspection.pid)) {
            return { appId: app.id, ok: false, action: "failed", message: `not stopping: ${inspection.note}` };
        }
        const ownedListeners = inspection.listenerPids.filter((listener) => LocalEdgeKit_listenerBelongsTo({ listener, pid: inspection.pid ?? 0, processGroup: inspection.processGroup, host }));
        LocalEdgeKit_terminateProcessGroup({
            pid: inspection.pid,
            extraPids: ownedListeners,
            host,
            timeoutMs: app.stopTimeoutMs ?? LOCAL_EDGE_KIT_SUPERVISOR_DEFAULT_STOP_TIMEOUT_MS,
            out: options.out,
        });
        const stillAlive = host.pidIsAlive(inspection.pid);
        if (!stillAlive) {
            host.removeFile(pidFile);
        }
        return {
            appId: app.id,
            ok: !stillAlive,
            action: stillAlive ? "failed" : "stopped",
            message: stillAlive ? "process survived SIGKILL" : `stopped pid ${String(inspection.pid)}`,
        };
    });
}
/**
 * Sends SIGTERM to the process group of `pid` (and of each `extraPids` entry, such as an owned
 * listener in a child group), waits up to `timeoutMs`, then SIGKILL.
 *
 * @remarks
 * A process that shares the supervisor's own process group is signalled by pid only, so the
 * supervisor never signals its own group.
 */
export function LocalEdgeKit_terminateProcessGroup(options) {
    const { host } = options;
    const ownGroup = host.ownProcessGroup();
    const targets = new Set();
    for (const pid of [options.pid, ...(options.extraPids ?? [])]) {
        const group = host.processGroupOf(pid);
        targets.add(group !== null && group > 1 && group !== ownGroup ? -group : pid);
    }
    LocalEdgeCore_runtimeStopTerminatePidList({
        pids: [...targets],
        kill: (pid, signal) => host.kill(pid, signal ?? "SIGTERM"),
        pidIsAlive: (pid) => {
            try {
                host.kill(pid, 0);
                return true;
            }
            catch {
                return false;
            }
        },
        stderr: options.out,
        waitForPidsExit: ({ pids }) => {
            const deadline = host.now() + options.timeoutMs;
            for (;;) {
                const alive = pids.some((pid) => {
                    try {
                        host.kill(pid, 0);
                        return true;
                    }
                    catch {
                        return false;
                    }
                });
                if (!alive) {
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
