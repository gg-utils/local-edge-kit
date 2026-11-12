/**
 * @fileoverview Router lifecycle for the `hostnames` exposure backend: write the rendered nginx
 * config, check it, then start nginx or reload the one already running.
 *
 * The router is adopted by its pid file: a live process there is reloaded with `-s reload`,
 * never restarted. A config is checked with `nginx -t` as a candidate file next to the real one
 * before it replaces the real one, so a bad render never reaches the running router. When the
 * rendered text equals the file on disk and nginx runs, nothing is written or signalled.
 * nginx is not started without the certificate and key. All files stay inside `stateRoot`
 * and are written atomically (see `safe-write.ts`).
 * Flow: manifest -> core render -> compare -> candidate + nginx -t -> atomic replace -> reload or start.
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
    /** Folder every router file (config, pid, logs, temp) must stay inside. */
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
    state: "running" | "stopped" | "stale-pid";
    pid: number | null;
    /** Whether the file on disk equals the current render. */
    config: "current" | "differs" | "missing" | "invalid";
    note: string;
};
/** Inspects the router: pid file process and whether the config on disk is current. Read-only. */
export declare function LocalEdgeKit_inspectRouter(options: {
    manifest: LocalEdgeCore_ExposureManifest;
    host: LocalEdgeKit_SupervisorHost;
}): LocalEdgeKit_RouterInspection;
/**
 * Brings the router up: renders the config, and when it differs from the file on disk checks a
 * candidate with `nginx -t`, then replaces the file. Reloads a running nginx (only when the file
 * changed) or starts one. Never restarts a running nginx.
 */
export declare function LocalEdgeKit_routerUp(options: {
    manifest: LocalEdgeCore_ExposureManifest;
    router: LocalEdgeKit_SupervisorRouterConfig;
    host: LocalEdgeKit_SupervisorHost;
    out: LocalEdgeKit_SupervisorWriter;
}): LocalEdgeKit_SupervisorStepResult;
/** Stops the router with `nginx -s quit` when its pid file names a live process. */
export declare function LocalEdgeKit_routerDown(options: {
    manifest: LocalEdgeCore_ExposureManifest;
    router: LocalEdgeKit_SupervisorRouterConfig;
    host: LocalEdgeKit_SupervisorHost;
}): LocalEdgeKit_SupervisorStepResult;
