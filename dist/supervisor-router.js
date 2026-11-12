/**
 * @fileoverview Router lifecycle for the `hostnames` exposure backend: write the rendered nginx
 * config, check it, then start nginx or reload the one already running, and stop it.
 *
 * Identity: nginx writes its own pid file, so a pid there proves nothing. The router counts as
 * ours only when the live process at that pid matches the identity this module recorded when it
 * started or last reloaded it (`router.state.json` in `stateRoot`), or, for an nginx started
 * by hand, when it runs as our uid with an `nginx: master process` command line naming this
 * config file. Anything else is `unverified`: never reloaded, quit or replaced. Reload and quit
 * are sent as SIGHUP and SIGQUIT straight to that pid, and the identity is read again
 * immediately before each signal (see `process-identity.ts`).
 *
 * Activation: a config that is written is not yet active. The state file records the SHA-256 of
 * the config the verified nginx last accepted (start or reload). `up` does nothing only when the
 * render equals the file on disk and that file is the active one for the running pid; a written
 * but never activated config is reloaded on the next run. A rendered config is checked with
 * `nginx -t` as a candidate file before it replaces the real one; when the reload or start then
 * fails, the previous bytes are put back (or the file is removed when there was none), so the
 * file on disk never claims a config the router does not run.
 *
 * Files: every router file stays inside `stateRoot` and is written through `safe-write.ts`
 * (folders walked without following symlinks and checked again before the rename; the
 * `stateRoot` and its ancestors are trusted). nginx is not started without the certificate and
 * key.
 * Flow: manifest -> core render -> verify pid -> compare disk and activation -> candidate +
 * nginx -t -> atomic replace -> SIGHUP or start -> record activation, or restore the previous bytes.
 *
 * @example
 * ```typescript
 * const result = LocalEdgeKit_routerUp({ manifest, router: { stateRoot: "/w/state" }, host, out: process.stderr });
 * ```
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor-router.unit.test.ts
 *
 * @see src/supervisor-cli.ts - Calls these on `up`, `down` and `status` for the hostnames backend.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { LocalEdgeCore_renderExposureHostnamesNginxConfig, } from "@gg-utils/local-edge-core/exposure";
import { LocalEdgeKit_parseProcessIdentity, LocalEdgeKit_verifyProcessIdentity, } from "./process-identity.js";
import { LocalEdgeKit_readPidFile, } from "./supervisor.js";
/** Row id used for the router in supervisor output. */
export const LOCAL_EDGE_KIT_ROUTER_ID = "router";
function LocalEdgeKit_requireHostnames(manifest) {
    if (!manifest.hostnames) {
        throw new Error("the hostnames backend needs exposure.hostnames settings");
    }
    return manifest.hostnames;
}
function LocalEdgeKit_tryRender(manifest) {
    try {
        return { text: LocalEdgeCore_renderExposureHostnamesNginxConfig(manifest) };
    }
    catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}
function LocalEdgeKit_sha256(text) {
    return createHash("sha256").update(text).digest("hex");
}
/**
 * Path of the router state file inside `stateRoot`.
 *
 * @param router - Router settings.
 * @returns `<stateRoot>/router.state.json`.
 * @example
 * ```typescript
 * LocalEdgeKit_routerStatePath({ stateRoot: "/w/state" }); // "/w/state/router.state.json"
 * ```
 */
export function LocalEdgeKit_routerStatePath(router) {
    return path.join(path.resolve(router.stateRoot), "router.state.json");
}
function LocalEdgeKit_readRouterState(host, router) {
    const text = host.readText(LocalEdgeKit_routerStatePath(router));
    if (text === null) {
        return null;
    }
    try {
        const value = JSON.parse(text);
        const identity = LocalEdgeKit_parseProcessIdentity(JSON.stringify(value.identity ?? null));
        if (typeof value.pid !== "number" || identity === null) {
            return null;
        }
        return { pid: value.pid, identity, activeConfigSha256: typeof value.activeConfigSha256 === "string" ? value.activeConfigSha256 : null };
    }
    catch {
        return null;
    }
}
function LocalEdgeKit_writeRouterState(host, router, state) {
    host.writeText(LocalEdgeKit_routerStatePath(router), `${JSON.stringify(state)}\n`, { root: router.stateRoot, mode: 0o600 });
}
/**
 * True when `identity` looks like an nginx master we may adopt: same uid as the supervisor,
 * an `nginx: master process` command line, and that command line names `confPath`.
 */
function LocalEdgeKit_looksLikeOurNginx(host, identity, confPath) {
    const own = host.processIdentity(host.ownPid());
    return own !== null && identity.uid === own.uid && identity.command.includes("nginx: master process") && identity.command.includes(confPath);
}
/** Classifies the pid in nginx's pid file as none, ours (verified) or unverified. Read-only. */
function LocalEdgeKit_routerOwner(host, router, settings) {
    const pid = LocalEdgeKit_readPidFile(host, settings.nginx.pidPath);
    if (pid === null) {
        return { kind: "none", pid: null };
    }
    const current = host.processIdentity(pid);
    if (current === null) {
        return host.pidIsAlive(pid)
            ? { kind: "unverified", pid, message: `nginx pid ${String(pid)} is alive but its identity cannot be read` }
            : { kind: "none", pid };
    }
    const recorded = LocalEdgeKit_readRouterState(host, router);
    if (recorded !== null && recorded.pid === pid) {
        const check = LocalEdgeKit_verifyProcessIdentity({ pid, recorded: recorded.identity, current });
        if (check.ok) {
            return { kind: "ours", pid, identity: current, recorded };
        }
    }
    if (LocalEdgeKit_looksLikeOurNginx(host, current, settings.nginx.confPath)) {
        return { kind: "ours", pid, identity: current, recorded: null };
    }
    return {
        kind: "unverified",
        pid,
        message: `pid ${String(pid)} in ${settings.nginx.pidPath} is not the recorded router and not an nginx master for this config`,
    };
}
/**
 * Sends one signal to a verified pid, reading its identity again immediately before.
 *
 * @returns null when sent, otherwise why it was not.
 */
function LocalEdgeKit_signalVerified(host, pid, identity, signal) {
    const check = LocalEdgeKit_verifyProcessIdentity({ pid, recorded: identity, current: host.processIdentity(pid) });
    if (!check.ok) {
        return `${signal} not sent: ${check.message}`;
    }
    try {
        host.kill(pid, signal);
        return null;
    }
    catch (error) {
        return `${signal} to pid ${String(pid)} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
}
/**
 * Inspects the router: who the pid file names, whether the config on disk equals the render,
 * and whether the running router last accepted that file. Read-only.
 *
 * @param options - Manifest with `hostnames` settings, host, and the router settings (they
 * locate the state file).
 * @returns The router inspection.
 * @throws When the manifest has no `hostnames` settings.
 * @example
 * ```typescript
 * LocalEdgeKit_inspectRouter({ manifest, host, router: { stateRoot: "/w/state" } }).state; // "running"
 * ```
 */
export function LocalEdgeKit_inspectRouter(options) {
    const settings = LocalEdgeKit_requireHostnames(options.manifest);
    const { host } = options;
    const owner = LocalEdgeKit_routerOwner(host, options.router, settings);
    const onDisk = host.readText(settings.nginx.confPath);
    const rendered = LocalEdgeKit_tryRender(options.manifest);
    const config = "error" in rendered ? "invalid" : onDisk === null ? "missing" : onDisk === rendered.text ? "current" : "differs";
    const active = owner.kind === "ours" && onDisk !== null && owner.recorded?.activeConfigSha256 === LocalEdgeKit_sha256(onDisk);
    const where = `${settings.routerHost}:${String(settings.routerPort)}`;
    const activeNote = active ? "active" : "not confirmed active";
    if (owner.kind === "ours") {
        return { state: "running", pid: owner.pid, config, active, note: `nginx pid ${String(owner.pid)} on ${where}; config ${config}, ${activeNote}` };
    }
    if (owner.kind === "unverified") {
        return { state: "unverified", pid: null, config, active: false, note: `${owner.message}; not touched` };
    }
    if (owner.pid !== null) {
        return { state: "stale-pid", pid: null, config, active: false, note: `pid file names a dead process; config ${config}` };
    }
    return { state: "stopped", pid: null, config, active: false, note: `not running; config ${config}` };
}
/** Runs nginx and returns a one-line failure text, or null on success. */
function LocalEdgeKit_runNginx(host, bin, args) {
    const result = host.runCommand(bin, args);
    if (result.status === 0) {
        return null;
    }
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" | ");
    return `${[bin, ...args].join(" ")} exited ${String(result.status)}${detail ? `: ${detail}` : ""}`;
}
/**
 * Brings the router up. Renders the config; when it differs from the file on disk, checks a
 * candidate with `nginx -t` and replaces the file atomically. Then activates it: SIGHUP to a
 * verified running nginx, or starts nginx when none runs. When activation fails the previous
 * bytes are restored. Never restarts a running nginx and never touches an unverified one.
 *
 * @param options - Manifest with `hostnames` settings, router settings, host and progress writer.
 * @returns `adopted` (current and active, or reloaded), `started`, or `failed` with the reason;
 * a failure after the write says whether the previous config was restored. Never throws.
 * @example
 * ```typescript
 * LocalEdgeKit_routerUp({ manifest, router: { stateRoot: "/w/state" }, host, out: process.stderr });
 * ```
 */
export function LocalEdgeKit_routerUp(options) {
    const { host, router, out } = options;
    const id = LOCAL_EDGE_KIT_ROUTER_ID;
    const fail = (message) => ({ appId: id, ok: false, action: "failed", message });
    let settings;
    try {
        settings = LocalEdgeKit_requireHostnames(options.manifest);
    }
    catch (error) {
        return fail(error.message);
    }
    const rendered = LocalEdgeKit_tryRender(options.manifest);
    if ("error" in rendered) {
        return fail(rendered.error);
    }
    const sha = LocalEdgeKit_sha256(rendered.text);
    const bin = router.nginxBin ?? "nginx";
    const { nginx } = settings;
    const root = { root: router.stateRoot };
    const owner = LocalEdgeKit_routerOwner(host, router, settings);
    if (owner.kind === "unverified") {
        return fail(`${owner.message}; nginx not touched`);
    }
    const previous = host.readText(nginx.confPath);
    const changed = previous !== rendered.text;
    if (!changed && owner.kind === "ours" && owner.recorded?.activeConfigSha256 === sha) {
        return { appId: id, ok: true, action: "adopted", message: `nginx pid ${String(owner.pid)} adopted; config current and active` };
    }
    if (host.fileSize(settings.tls.certPath) === 0 || host.fileSize(settings.tls.keyPath) === 0) {
        return fail(`certificate or key missing (${settings.tls.certPath}, ${settings.tls.keyPath}); nginx not touched`);
    }
    try {
        for (const dir of [nginx.tempDir, path.dirname(nginx.errorLogPath), path.dirname(nginx.accessLogPath), path.dirname(nginx.pidPath)]) {
            host.ensureDir(dir, root);
        }
        if (changed) {
            const candidate = path.join(path.dirname(nginx.confPath), `.${path.basename(nginx.confPath)}.candidate`);
            host.writeText(candidate, rendered.text, { ...root, mode: 0o600 });
            const tested = LocalEdgeKit_runNginx(host, bin, ["-t", "-q", "-c", candidate]);
            host.removeFile(candidate);
            if (tested !== null) {
                return fail(`rendered config failed the check, nothing replaced: ${tested}`);
            }
            host.writeText(nginx.confPath, rendered.text, { ...root, mode: 0o600 });
            out.write(`[${id}] wrote ${nginx.confPath}\n`);
        }
    }
    catch (error) {
        return fail(error.message);
    }
    const restore = (reason) => {
        if (!changed) {
            return fail(reason);
        }
        try {
            if (previous === null) {
                host.removeFile(nginx.confPath);
            }
            else {
                host.writeText(nginx.confPath, previous, { ...root, mode: 0o600 });
            }
            return fail(`${reason}; previous config restored`);
        }
        catch (error) {
            return fail(`${reason}; restoring the previous config also failed: ${error.message}`);
        }
    };
    if (owner.kind === "ours") {
        const reloaded = LocalEdgeKit_signalVerified(host, owner.pid, owner.identity, "SIGHUP");
        if (reloaded !== null) {
            return restore(`reload failed: ${reloaded}`);
        }
        try {
            LocalEdgeKit_writeRouterState(host, router, { pid: owner.pid, identity: owner.identity, activeConfigSha256: sha });
        }
        catch (error) {
            return fail(`nginx reloaded but its state could not be recorded: ${error.message}`);
        }
        return { appId: id, ok: true, action: "adopted", message: `nginx pid ${String(owner.pid)} reloaded with the new config` };
    }
    const started = LocalEdgeKit_runNginx(host, bin, ["-c", nginx.confPath]);
    if (started !== null) {
        return restore(started);
    }
    const newPid = LocalEdgeKit_readPidFile(host, nginx.pidPath);
    const identity = newPid === null ? null : host.processIdentity(newPid);
    if (newPid === null || identity === null) {
        return restore("nginx returned 0 but its pid file names no live process");
    }
    if (!LocalEdgeKit_looksLikeOurNginx(host, identity, nginx.confPath)) {
        return fail(`nginx returned 0 but pid ${String(newPid)} is not an nginx master for this config; not recorded`);
    }
    try {
        LocalEdgeKit_writeRouterState(host, router, { pid: newPid, identity, activeConfigSha256: sha });
    }
    catch (error) {
        return fail(`nginx started but its state could not be recorded: ${error.message}`);
    }
    return { appId: id, ok: true, action: "started", message: `nginx pid ${String(newPid)} on ${settings.routerHost}:${String(settings.routerPort)}` };
}
/**
 * Stops the router with SIGQUIT (graceful) when its pid file names a verified nginx, reading the
 * identity again immediately before the signal and while waiting. An unverified pid is never
 * signalled.
 *
 * @param options - Manifest with `hostnames` settings, router settings and host.
 * @returns `already-stopped`, `stopped`, or `failed` with the reason.
 * @throws When the manifest has no `hostnames` settings.
 * @example
 * ```typescript
 * LocalEdgeKit_routerDown({ manifest, router: { stateRoot: "/w/state" }, host });
 * ```
 */
export function LocalEdgeKit_routerDown(options) {
    const { host, router } = options;
    const id = LOCAL_EDGE_KIT_ROUTER_ID;
    const settings = LocalEdgeKit_requireHostnames(options.manifest);
    const owner = LocalEdgeKit_routerOwner(host, router, settings);
    if (owner.kind === "none") {
        return { appId: id, ok: true, action: "already-stopped", message: "nginx not running" };
    }
    if (owner.kind === "unverified") {
        return { appId: id, ok: false, action: "failed", message: `not stopping: ${owner.message}` };
    }
    const quit = LocalEdgeKit_signalVerified(host, owner.pid, owner.identity, "SIGQUIT");
    if (quit !== null) {
        return { appId: id, ok: false, action: "failed", message: quit };
    }
    const stillOurs = () => LocalEdgeKit_verifyProcessIdentity({ pid: owner.pid, recorded: owner.identity, current: host.processIdentity(owner.pid) }).ok;
    const deadline = host.now() + (router.stopTimeoutMs ?? 10_000);
    while (stillOurs() && host.now() < deadline) {
        host.sleepSync(200);
    }
    const stopped = !stillOurs();
    if (stopped) {
        host.removeFile(LocalEdgeKit_routerStatePath(router));
    }
    return {
        appId: id,
        ok: stopped,
        action: stopped ? "stopped" : "failed",
        message: stopped ? `nginx pid ${String(owner.pid)} quit` : "nginx still running after quit",
    };
}
