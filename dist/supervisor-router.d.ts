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
import { type LocalEdgeCore_ExposureManifest } from "@gg-utils/local-edge-core/exposure";
import { type LocalEdgeKit_SupervisorHost, type LocalEdgeKit_SupervisorStepResult, type LocalEdgeKit_SupervisorWriter } from "./supervisor.js";
/** Router settings owned by the supervisor config. */
export type LocalEdgeKit_SupervisorRouterConfig = {
    /** Folder every router file (config, pid, logs, temp, state) must stay inside. */
    stateRoot: string;
    /** nginx executable. Default `nginx`. */
    nginxBin?: string | undefined;
    /** How long `down` waits for nginx to quit. Default 10 s. */
    stopTimeoutMs?: number | undefined;
};
/** Row id used for the router in supervisor output. */
export declare const LOCAL_EDGE_KIT_ROUTER_ID = "router";
/** Observed router state. */
export type LocalEdgeKit_RouterInspection = {
    state: "running" | "stopped" | "stale-pid" | "unverified";
    /** Verified router pid; null unless `state` is `running`. */
    pid: number | null;
    /** Whether the file on disk equals the current render. */
    config: "current" | "differs" | "missing" | "invalid";
    /** Whether the running router last accepted exactly the file on disk. */
    active: boolean;
    note: string;
};
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
export declare function LocalEdgeKit_routerStatePath(router: LocalEdgeKit_SupervisorRouterConfig): string;
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
export declare function LocalEdgeKit_inspectRouter(options: {
    manifest: LocalEdgeCore_ExposureManifest;
    host: LocalEdgeKit_SupervisorHost;
    router: LocalEdgeKit_SupervisorRouterConfig;
}): LocalEdgeKit_RouterInspection;
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
export declare function LocalEdgeKit_routerUp(options: {
    manifest: LocalEdgeCore_ExposureManifest;
    router: LocalEdgeKit_SupervisorRouterConfig;
    host: LocalEdgeKit_SupervisorHost;
    out: LocalEdgeKit_SupervisorWriter;
}): LocalEdgeKit_SupervisorStepResult;
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
export declare function LocalEdgeKit_routerDown(options: {
    manifest: LocalEdgeCore_ExposureManifest;
    router: LocalEdgeKit_SupervisorRouterConfig;
    host: LocalEdgeKit_SupervisorHost;
}): LocalEdgeKit_SupervisorStepResult;
