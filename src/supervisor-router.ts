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

import path from "node:path";

import {
  type LocalEdgeCore_ExposureHostnamesConfig,
  type LocalEdgeCore_ExposureManifest,
  LocalEdgeCore_renderExposureHostnamesNginxConfig,
} from "@gg-utils/local-edge-core/exposure";

import {
  type LocalEdgeKit_SupervisorHost,
  type LocalEdgeKit_SupervisorStepResult,
  type LocalEdgeKit_SupervisorWriter,
  LocalEdgeKit_readPidFile,
} from "./supervisor.js";

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
export const LOCAL_EDGE_KIT_ROUTER_ID = "router";

/** Observed router state. */
export type LocalEdgeKit_RouterInspection = {
  state: "running" | "stopped" | "stale-pid";
  pid: number | null;
  /** Whether the file on disk equals the current render. */
  config: "current" | "differs" | "missing" | "invalid";
  note: string;
};

/** Returns the hostname settings or throws a clear error. */
function LocalEdgeKit_requireHostnames(manifest: LocalEdgeCore_ExposureManifest): LocalEdgeCore_ExposureHostnamesConfig {
  if (!manifest.hostnames) {
    throw new Error("the hostnames backend needs exposure.hostnames settings");
  }
  return manifest.hostnames;
}

/** Renders the config, or returns the error text. */
function LocalEdgeKit_tryRender(manifest: LocalEdgeCore_ExposureManifest): { text: string } | { error: string } {
  try {
    return { text: LocalEdgeCore_renderExposureHostnamesNginxConfig(manifest) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Inspects the router: pid file process and whether the config on disk is current. Read-only. */
export function LocalEdgeKit_inspectRouter(options: {
  manifest: LocalEdgeCore_ExposureManifest;
  host: LocalEdgeKit_SupervisorHost;
}): LocalEdgeKit_RouterInspection {
  const settings = LocalEdgeKit_requireHostnames(options.manifest);
  const { host } = options;
  const pid = LocalEdgeKit_readPidFile(host, settings.nginx.pidPath);
  const alive = pid !== null && host.pidIsAlive(pid);
  const onDisk = host.readText(settings.nginx.confPath);
  const rendered = LocalEdgeKit_tryRender(options.manifest);
  const config =
    "error" in rendered ? "invalid" : onDisk === null ? "missing" : onDisk === rendered.text ? "current" : "differs";
  const state = alive ? "running" : pid !== null ? "stale-pid" : "stopped";
  const where = `${settings.routerHost}:${String(settings.routerPort)}`;
  const note =
    state === "running"
      ? `nginx pid ${String(pid)} on ${where}; config ${config}`
      : state === "stale-pid"
        ? `pid file names a dead process; config ${config}`
        : `not running; config ${config}`;
  return { state, pid: alive ? pid : null, config, note };
}

/** Runs nginx and returns a one-line failure text, or null on success. */
function LocalEdgeKit_runNginx(host: LocalEdgeKit_SupervisorHost, bin: string, args: readonly string[]): string | null {
  const result = host.runCommand(bin, args);
  if (result.status === 0) {
    return null;
  }
  const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" | ");
  return `${[bin, ...args].join(" ")} exited ${String(result.status)}${detail ? `: ${detail}` : ""}`;
}

/**
 * Brings the router up: renders the config, and when it differs from the file on disk checks a
 * candidate with `nginx -t`, then replaces the file. Reloads a running nginx (only when the file
 * changed) or starts one. Never restarts a running nginx.
 */
export function LocalEdgeKit_routerUp(options: {
  manifest: LocalEdgeCore_ExposureManifest;
  router: LocalEdgeKit_SupervisorRouterConfig;
  host: LocalEdgeKit_SupervisorHost;
  out: LocalEdgeKit_SupervisorWriter;
}): LocalEdgeKit_SupervisorStepResult {
  const { host, router, out } = options;
  const id = LOCAL_EDGE_KIT_ROUTER_ID;
  const fail = (message: string): LocalEdgeKit_SupervisorStepResult => ({ appId: id, ok: false, action: "failed", message });
  let settings: LocalEdgeCore_ExposureHostnamesConfig;
  try {
    settings = LocalEdgeKit_requireHostnames(options.manifest);
  } catch (error) {
    return fail((error as Error).message);
  }
  const rendered = LocalEdgeKit_tryRender(options.manifest);
  if ("error" in rendered) {
    return fail(rendered.error);
  }
  const bin = router.nginxBin ?? "nginx";
  const { nginx } = settings;
  const root = { root: router.stateRoot };
  const pid = LocalEdgeKit_readPidFile(host, nginx.pidPath);
  const alive = pid !== null && host.pidIsAlive(pid);
  const changed = host.readText(nginx.confPath) !== rendered.text;

  if (!changed && alive) {
    return { appId: id, ok: true, action: "adopted", message: `nginx pid ${String(pid)} adopted; config current` };
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
  } catch (error) {
    return fail((error as Error).message);
  }
  if (alive) {
    const reloaded = LocalEdgeKit_runNginx(host, bin, ["-c", nginx.confPath, "-s", "reload"]);
    return reloaded === null
      ? { appId: id, ok: true, action: "adopted", message: `nginx pid ${String(pid)} reloaded with the new config` }
      : fail(reloaded);
  }
  const started = LocalEdgeKit_runNginx(host, bin, ["-c", nginx.confPath]);
  if (started !== null) {
    return fail(started);
  }
  const newPid = LocalEdgeKit_readPidFile(host, nginx.pidPath);
  return newPid !== null && host.pidIsAlive(newPid)
    ? { appId: id, ok: true, action: "started", message: `nginx pid ${String(newPid)} on ${settings.routerHost}:${String(settings.routerPort)}` }
    : fail("nginx returned 0 but its pid file names no live process");
}

/** Stops the router with `nginx -s quit` when its pid file names a live process. */
export function LocalEdgeKit_routerDown(options: {
  manifest: LocalEdgeCore_ExposureManifest;
  router: LocalEdgeKit_SupervisorRouterConfig;
  host: LocalEdgeKit_SupervisorHost;
}): LocalEdgeKit_SupervisorStepResult {
  const { host, router } = options;
  const id = LOCAL_EDGE_KIT_ROUTER_ID;
  const settings = LocalEdgeKit_requireHostnames(options.manifest);
  const pid = LocalEdgeKit_readPidFile(host, settings.nginx.pidPath);
  if (pid === null || !host.pidIsAlive(pid)) {
    return { appId: id, ok: true, action: "already-stopped", message: "nginx not running" };
  }
  const quit = LocalEdgeKit_runNginx(host, router.nginxBin ?? "nginx", ["-c", settings.nginx.confPath, "-s", "quit"]);
  if (quit !== null) {
    return { appId: id, ok: false, action: "failed", message: quit };
  }
  const deadline = host.now() + (router.stopTimeoutMs ?? 10_000);
  while (host.pidIsAlive(pid) && host.now() < deadline) {
    host.sleepSync(200);
  }
  const stopped = !host.pidIsAlive(pid);
  return {
    appId: id,
    ok: stopped,
    action: stopped ? "stopped" : "failed",
    message: stopped ? `nginx pid ${String(pid)} quit` : "nginx still running after quit",
  };
}
