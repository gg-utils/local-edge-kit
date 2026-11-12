/**
 * @fileoverview Router lifecycle for the `hostnames` exposure backend: write the rendered nginx
 * config, check it, then start nginx or reload the one already running, and stop it.
 *
 * Identity: nginx writes its own pid file, so a pid there proves nothing. The router counts as
 * ours only when the live process at that pid matches the identity this module recorded when it
 * started or last reloaded it (`router.state.json` in `stateRoot`), or, for an nginx started
 * by hand, when it runs as our uid with an `nginx: master process` command line whose single
 * `-c` value is this config file (compared after resolving symlinks on both sides, never as a
 * substring). Anything else is `unverified`: never reloaded, quit or replaced. Reload and quit
 * are sent as SIGHUP and SIGQUIT straight to that pid, and the identity is read again
 * immediately before each signal (see `process-identity.ts`).
 *
 * Activation: a config that is written is not yet active, and a delivered SIGHUP is only a
 * request. The rendered config therefore carries a loopback-only marker server on a unix socket
 * inside `stateRoot` that answers with the SHA-256 of the render. After a reload or start the
 * marker is polled until it answers the new hash; only then does the state file record the
 * SHA-256 of the file as the config the verified nginx accepted. `up` does nothing only when the
 * render equals the file on disk and that file is the active one for the running pid; a written
 * but never activated config is reloaded on the next run. A rendered config is checked with
 * `nginx -t` as a candidate file before it replaces the real one; when the reload or start then
 * fails or is not confirmed in time, the previous bytes are put back (or the file is removed
 * when there was none), an nginx this run started is stopped, and nothing is recorded as
 * active, so the next run tries again.
 *
 * Files: every router file stays inside `stateRoot` and is written through `safe-write.ts`
 * (folders walked without following symlinks and checked again before the rename; the
 * `stateRoot` and its ancestors are trusted). nginx is not started without the certificate and
 * key.
 * Flow: manifest -> core render -> verify pid -> compare disk and activation -> candidate +
 * nginx -t -> atomic replace -> SIGHUP or start -> poll marker -> record activation, or restore
 * the previous bytes.
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

import {
  type LocalEdgeCore_ExposureHostnamesConfig,
  type LocalEdgeCore_ExposureManifest,
  LocalEdgeCore_renderExposureHostnamesNginxConfig,
} from "@gg-utils/local-edge-core/exposure";

import {
  type LocalEdgeKit_ProcessIdentity,
  LocalEdgeKit_parseProcessIdentity,
  LocalEdgeKit_verifyProcessIdentity,
} from "./process-identity.js";
import {
  type LocalEdgeKit_SupervisorHost,
  type LocalEdgeKit_SupervisorStepResult,
  type LocalEdgeKit_SupervisorWriter,
  LocalEdgeKit_readPidFile,
} from "./supervisor.js";

/** Router settings owned by the supervisor config. */
export type LocalEdgeKit_SupervisorRouterConfig = {
  /** Folder every router file (config, pid, logs, temp, state) must stay inside. */
  stateRoot: string;
  /** nginx executable. Default `nginx`. */
  nginxBin?: string | undefined;
  /** How long `down` waits for nginx to quit. Default 10 s. */
  stopTimeoutMs?: number | undefined;
  /**
   * Activation check. The rendered config gets a marker server on this HTTP unix socket that
   * answers `/local-edge-config` with the SHA-256 of the render; after a reload or start the
   * marker is polled until it answers the new hash. Default socket:
   * `<folder of nginx.pidPath>/confirm.sock`; default timeout 5 s.
   */
  confirm?: { socketPath?: string | undefined; timeoutMs?: number | undefined } | undefined;
};

/** URL path of the activation marker. */
export const LOCAL_EDGE_KIT_ROUTER_MARKER_PATH = "/local-edge-config";

/** Row id used for the router in supervisor output. */
export const LOCAL_EDGE_KIT_ROUTER_ID = "router";

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

/** What the module records about the router it runs. */
type LocalEdgeKit_RouterState = { pid: number; identity: LocalEdgeKit_ProcessIdentity; activeConfigSha256: string | null };

/** Result of checking who the pid in nginx's pid file is. */
type LocalEdgeKit_RouterOwner =
  | { kind: "none"; pid: number | null }
  | { kind: "ours"; pid: number; identity: LocalEdgeKit_ProcessIdentity; recorded: LocalEdgeKit_RouterState | null }
  | { kind: "unverified"; pid: number; message: string };

function LocalEdgeKit_requireHostnames(manifest: LocalEdgeCore_ExposureManifest): LocalEdgeCore_ExposureHostnamesConfig {
  if (!manifest.hostnames) {
    throw new Error("the hostnames backend needs exposure.hostnames settings");
  }
  return manifest.hostnames;
}

function LocalEdgeKit_sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A rendered router config: the file text, the hash the marker answers, and the marker socket. */
type LocalEdgeKit_RouterRender = { text: string; markerSha: string; socketPath: string };

/**
 * Path of the activation marker socket.
 *
 * @param router - Router settings.
 * @param settings - Hostnames settings (the pid path locates the default).
 * @returns The socket path.
 * @example
 * ```typescript
 * LocalEdgeKit_routerMarkerSocket({ stateRoot: "/w/state" }, settings); // "/w/state/nginx/confirm.sock"
 * ```
 */
export function LocalEdgeKit_routerMarkerSocket(
  router: LocalEdgeKit_SupervisorRouterConfig,
  settings: LocalEdgeCore_ExposureHostnamesConfig,
): string {
  return path.resolve(router.confirm?.socketPath ?? path.join(path.dirname(settings.nginx.pidPath), "confirm.sock"));
}

/**
 * Renders the core config and adds the loopback-only activation marker: a server on a unix
 * socket inside `stateRoot` that answers with the SHA-256 of the core render.
 */
function LocalEdgeKit_tryRender(
  manifest: LocalEdgeCore_ExposureManifest,
  router: LocalEdgeKit_SupervisorRouterConfig,
): LocalEdgeKit_RouterRender | { error: string } {
  try {
    const settings = LocalEdgeKit_requireHostnames(manifest);
    const base = LocalEdgeCore_renderExposureHostnamesNginxConfig(manifest);
    const socketPath = LocalEdgeKit_routerMarkerSocket(router, settings);
    const relative = path.relative(path.resolve(router.stateRoot), socketPath);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return { error: `marker socket ${socketPath} must be inside ${router.stateRoot}` };
    }
    if (!/^[A-Za-z0-9._/@+-]+$/.test(socketPath) || Buffer.byteLength(socketPath) > 100) {
      return { error: `marker socket path ${socketPath} is too long or has characters nginx cannot take; set router.confirm.socketPath` };
    }
    if (!base.endsWith("\n}\n")) {
      return { error: "the core render does not end with the http block; cannot add the activation marker" };
    }
    const markerSha = LocalEdgeKit_sha256(base);
    const marker =
      `  server { listen unix:${socketPath}; access_log off; ` +
      `location = ${LOCAL_EDGE_KIT_ROUTER_MARKER_PATH} { default_type text/plain; return 200 "${markerSha}"; } ` +
      "location / { return 404; } }";
    return { text: `${base.slice(0, -2)}${marker}\n}\n`, markerSha, socketPath };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The value of nginx's `-c` option in an nginx master's command line (`-c <path>` or
 * `-c<path>`), or null when the line is not an nginx master or has no, or more than one, `-c`.
 *
 * @param command - Command line as `ps` prints it, such as `nginx: master process nginx -c /w/nginx.conf`.
 * @returns The exact `-c` value.
 * @example
 * ```typescript
 * LocalEdgeKit_nginxMasterConfigArg("nginx: master process nginx -c /w/nginx.conf"); // "/w/nginx.conf"
 * ```
 */
export function LocalEdgeKit_nginxMasterConfigArg(command: string): string | null {
  const prefix = "nginx: master process ";
  if (!command.startsWith(prefix)) {
    return null;
  }
  const tokens = command.slice(prefix.length).trim().split(/\s+/);
  const values: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "-c") {
      values.push(tokens[index + 1] ?? "");
      index += 1;
    } else if (token.startsWith("-c") && token.length > 2) {
      values.push(token.slice(2));
    }
  }
  return values.length === 1 && values[0] !== "" ? (values[0] ?? null) : null;
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
export function LocalEdgeKit_routerStatePath(router: LocalEdgeKit_SupervisorRouterConfig): string {
  return path.join(path.resolve(router.stateRoot), "router.state.json");
}

function LocalEdgeKit_readRouterState(host: LocalEdgeKit_SupervisorHost, router: LocalEdgeKit_SupervisorRouterConfig): LocalEdgeKit_RouterState | null {
  const text = host.readText(LocalEdgeKit_routerStatePath(router));
  if (text === null) {
    return null;
  }
  try {
    const value = JSON.parse(text) as { pid?: unknown; identity?: unknown; activeConfigSha256?: unknown };
    const identity = LocalEdgeKit_parseProcessIdentity(JSON.stringify(value.identity ?? null));
    if (typeof value.pid !== "number" || identity === null) {
      return null;
    }
    return { pid: value.pid, identity, activeConfigSha256: typeof value.activeConfigSha256 === "string" ? value.activeConfigSha256 : null };
  } catch {
    return null;
  }
}

function LocalEdgeKit_writeRouterState(
  host: LocalEdgeKit_SupervisorHost,
  router: LocalEdgeKit_SupervisorRouterConfig,
  state: LocalEdgeKit_RouterState,
): void {
  host.writeText(LocalEdgeKit_routerStatePath(router), `${JSON.stringify(state)}\n`, { root: router.stateRoot, mode: 0o600 });
}

/**
 * True when `identity` looks like an nginx master we may adopt: same uid as the supervisor, an
 * `nginx: master process` command line, and exactly one absolute `-c` value that is the same
 * file as `confPath` after resolving symlinks on both sides. A longer name, a prefix or a
 * suffix of `confPath` is a different file and never matches.
 */
function LocalEdgeKit_looksLikeOurNginx(
  host: LocalEdgeKit_SupervisorHost,
  identity: LocalEdgeKit_ProcessIdentity,
  confPath: string,
): boolean {
  const own = host.processIdentity(host.ownPid());
  if (own === null || identity.uid !== own.uid) {
    return false;
  }
  const arg = LocalEdgeKit_nginxMasterConfigArg(identity.command);
  if (arg === null || !path.isAbsolute(arg)) {
    return false;
  }
  const canonical = (filePath: string): string => host.realPath(filePath) ?? path.resolve(filePath);
  return canonical(arg) === canonical(confPath);
}

/** Classifies the pid in nginx's pid file as none, ours (verified) or unverified. Read-only. */
function LocalEdgeKit_routerOwner(
  host: LocalEdgeKit_SupervisorHost,
  router: LocalEdgeKit_SupervisorRouterConfig,
  settings: LocalEdgeCore_ExposureHostnamesConfig,
): LocalEdgeKit_RouterOwner {
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
function LocalEdgeKit_signalVerified(
  host: LocalEdgeKit_SupervisorHost,
  pid: number,
  identity: LocalEdgeKit_ProcessIdentity,
  signal: NodeJS.Signals,
): string | null {
  const check = LocalEdgeKit_verifyProcessIdentity({ pid, recorded: identity, current: host.processIdentity(pid) });
  if (!check.ok) {
    return `${signal} not sent: ${check.message}`;
  }
  try {
    host.kill(pid, signal);
    return null;
  } catch (error) {
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
export function LocalEdgeKit_inspectRouter(options: {
  manifest: LocalEdgeCore_ExposureManifest;
  host: LocalEdgeKit_SupervisorHost;
  router: LocalEdgeKit_SupervisorRouterConfig;
}): LocalEdgeKit_RouterInspection {
  const settings = LocalEdgeKit_requireHostnames(options.manifest);
  const { host } = options;
  const owner = LocalEdgeKit_routerOwner(host, options.router, settings);
  const onDisk = host.readText(settings.nginx.confPath);
  const rendered = LocalEdgeKit_tryRender(options.manifest, options.router);
  const config =
    "error" in rendered ? "invalid" : onDisk === null ? "missing" : onDisk === rendered.text ? "current" : "differs";
  const active =
    owner.kind === "ours" && onDisk !== null && owner.recorded?.activeConfigSha256 === LocalEdgeKit_sha256(onDisk);
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
function LocalEdgeKit_runNginx(host: LocalEdgeKit_SupervisorHost, bin: string, args: readonly string[]): string | null {
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
 * verified running nginx, or starts nginx when none runs, and polls the activation marker until
 * it answers the new render's hash. When the reload or start fails or is not confirmed in time,
 * one rollback runs: an nginx this run started is stopped (SIGQUIT, identity checked again), the
 * previous bytes are restored (or a config this run created is removed), and nothing is
 * recorded as active. Never restarts a running nginx
 * and never touches an unverified one.
 *
 * @param options - Manifest with `hostnames` settings, router settings, host and progress writer.
 * @returns `adopted` (current and active, or reloaded), `started`, or `failed` with the reason;
 * a failure after the write says whether the previous config was restored. Every failed rollback
 * step, and a host call that threw once the config may have been replaced, is also listed in
 * `errors` (absent when none failed), in rollback order. A confirmed activation whose state file
 * cannot be written is `failed` with that error in `errors`, while nginx keeps running the
 * confirmed config. An nginx this run started whose identity could not be confirmed after a host
 * call threw is left running: it is named in `errors` and the message (with its pid when known) and
 * is not recorded. Once the config may have been replaced it never throws; a host read that
 * fails before anything is changed (the config, the pid file) can still throw, with nothing
 * changed.
 * @example
 * ```typescript
 * LocalEdgeKit_routerUp({ manifest, router: { stateRoot: "/w/state" }, host, out: process.stderr });
 * ```
 */
export function LocalEdgeKit_routerUp(options: {
  manifest: LocalEdgeCore_ExposureManifest;
  router: LocalEdgeKit_SupervisorRouterConfig;
  host: LocalEdgeKit_SupervisorHost;
  out: LocalEdgeKit_SupervisorWriter;
}): LocalEdgeKit_SupervisorStepResult {
  const { host, router, out } = options;
  const id = LOCAL_EDGE_KIT_ROUTER_ID;
  const fail = (message: string, errors: readonly string[] = []): LocalEdgeKit_SupervisorStepResult => ({
    appId: id,
    ok: false,
    action: "failed",
    message,
    ...(errors.length > 0 ? { errors } : {}),
  });
  let settings: LocalEdgeCore_ExposureHostnamesConfig;
  try {
    settings = LocalEdgeKit_requireHostnames(options.manifest);
  } catch (error) {
    return fail((error as Error).message);
  }
  const rendered = LocalEdgeKit_tryRender(options.manifest, router);
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
  /**
   * The one rollback for every failure after the file may have been replaced, on the reload and
   * the start path alike:
   * 1. `stop`: quit the nginx this run started (it was verified ours by identity, and the
   *    identity is read again before the signal), so no router keeps running a config that was
   *    never confirmed;
   * 2. `unconfirmed`: record that pid with no active config, so the next run signals again
   *    instead of adopting;
   * 3. put the previous bytes back, or remove a config this run created.
   *
   * Every step is best-effort: each runs even when an earlier one failed or threw, and every
   * failure is kept in the result's `errors` (and spelled out in the message), so the caller gets
   * the structured failure and never an exception. `thrown` is an exception that interrupted the
   * activation itself (a host call that threw); it is listed first in `errors`. `unidentified` is
   * an nginx this run started but could not identify: it is neither stopped nor recorded, and the
   * result says so (with the pid when known) and what to check.
   */
  const rollBack = (
    reason: string,
    steps: {
      unconfirmed?: { pid: number; identity: LocalEdgeKit_ProcessIdentity } | undefined;
      stop?: boolean | undefined;
      thrown?: unknown;
      /** An nginx this run started whose identity could not be confirmed, so it was left running. */
      unidentified?: { pid: number | null } | undefined;
    } = {},
  ): LocalEdgeKit_SupervisorStepResult => {
    const notes: string[] = [];
    const errors: string[] = [];
    const failed = (what: string, error: unknown): void => {
      const text = `${what}: ${error instanceof Error ? error.message : String(error)}`;
      notes.push(text);
      errors.push(text);
    };
    if ("thrown" in steps) {
      failed("a host call failed", steps.thrown);
    }
    if (steps.unidentified) {
      const { pid } = steps.unidentified;
      const text = `the router this run launched may still be running${pid === null ? " (its pid is unknown)" : ` (pid ${String(pid)})`}, but that process could not be identified as its nginx (the pid may now belong to another process), so it was not stopped and not recorded as active. Check ${nginx.pidPath} and the process list for an nginx master started with -c ${nginx.confPath}, and stop it with SIGQUIT if it is yours; the next up adopts a verified one and reloads it`;
      notes.push(text);
      errors.push(text);
    }
    if (steps.unconfirmed) {
      const { pid, identity } = steps.unconfirmed;
      if (steps.stop) {
        try {
          const quit = LocalEdgeKit_quitVerifiedRouter(host, router, pid, identity);
          if (quit.error === null) {
            notes.push(`nginx pid ${String(pid)} it started was stopped`);
          } else {
            failed("stopping the nginx it started failed", quit.error);
          }
          if (quit.stateError !== null) {
            failed("removing the router state file also failed", quit.stateError);
          }
        } catch (error) {
          failed("stopping the nginx it started failed", error);
        }
      }
      try {
        LocalEdgeKit_writeRouterState(host, router, { pid, identity, activeConfigSha256: null });
        notes.push("not recorded as active");
      } catch (error) {
        failed("recording it as not active failed", error);
      }
    }
    if (changed) {
      try {
        if (previous === null) {
          host.removeFile(nginx.confPath);
          notes.push("the config it created was removed");
        } else {
          host.writeText(nginx.confPath, previous, { ...root, mode: 0o600 });
          notes.push("previous config restored");
        }
      } catch (error) {
        failed("restoring the previous config also failed", error);
      }
    }
    return fail([reason, ...notes].join("; "), errors);
  };

  let replaced = false;
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
      // From here the file may be replaced (or half-replaced), so a failure must roll back.
      replaced = true;
      host.writeText(nginx.confPath, rendered.text, { ...root, mode: 0o600 });
      out.write(`[${id}] wrote ${nginx.confPath}\n`);
    } else {
      // Unchanged but not confirmed active: check the file itself before asking nginx to load it.
      const tested = LocalEdgeKit_runNginx(host, bin, ["-t", "-q", "-c", nginx.confPath]);
      if (tested !== null) {
        return fail(`config on disk failed the check, nginx not signalled: ${tested}`);
      }
    }
  } catch (error) {
    return replaced ? rollBack("writing the config failed", { thrown: error }) : fail((error as Error).message);
  }

  const confirmMs = router.confirm?.timeoutMs ?? 5000;
  /** Polls the marker until it answers the new render's hash; returns null when it did. */
  const confirm = (): string | null => {
    const deadline = host.now() + confirmMs;
    let last: string | null = null;
    for (;;) {
      last = host.fetchUnixSocketText(rendered.socketPath, LOCAL_EDGE_KIT_ROUTER_MARKER_PATH, 1000);
      if (last?.trim() === rendered.markerSha) {
        return null;
      }
      if (host.now() >= deadline) {
        const seen = last === null ? "no answer" : `hash ${last.trim().slice(0, 12)}`;
        return `nginx did not confirm the new config within ${String(confirmMs)} ms (marker gave ${seen}, expected ${rendered.markerSha.slice(0, 12)})`;
      }
      host.sleepSync(200);
    }
  };
  // What a rollback must undo once nginx has been signalled or started: set as soon as that is
  // true, so a host call that throws later (the marker poll, say) still stops what this run
  // started and records it as not active.
  let pending: { unconfirmed: { pid: number; identity: LocalEdgeKit_ProcessIdentity }; stop: boolean } | undefined;
  // Set once `nginx -c` returned 0 and cleared when `pending` is set: the window in which a
  // started nginx exists but is not yet identified. `pid` is the pid file's value, when it was read.
  let starting: { pid: number | null } | undefined;
  /**
   * After a throw inside that window, tries once more to identify the started nginx (pid file,
   * identity, nginx-master-for-this-config check). Identified: the verified-quit path can stop it.
   * Otherwise it is reported as possibly still running, with the pid when it is known.
   *
   * @param known - The pid already read from nginx's pid file in this run, or `null` to read it again.
   * @returns `{ unconfirmed, stop: true }` when the pid is an nginx master for this config, so the
   *   rollback may stop it with a verified signal; otherwise `{ unidentified: { pid } }`, so the
   *   rollback signals nothing and reports it. Never throws: a failed read leaves it unidentified.
   */
  const identifyStarted = (known: number | null): Pick<NonNullable<Parameters<typeof rollBack>[1]>, "unconfirmed" | "stop" | "unidentified"> => {
    let pid = known;
    try {
      pid ??= LocalEdgeKit_readPidFile(host, nginx.pidPath);
      const identity = pid === null ? null : host.processIdentity(pid);
      if (pid !== null && identity !== null && LocalEdgeKit_looksLikeOurNginx(host, identity, nginx.confPath)) {
        return { unconfirmed: { pid, identity }, stop: true };
      }
    } catch {
      // The read that failed the first time failed again: it stays unidentified.
    }
    return { unidentified: { pid } };
  };
  const activate = (): LocalEdgeKit_SupervisorStepResult => {
    if (owner.kind === "ours") {
      const reloaded = LocalEdgeKit_signalVerified(host, owner.pid, owner.identity, "SIGHUP");
      if (reloaded !== null) {
        return rollBack(`reload failed: ${reloaded}`);
      }
      pending = { unconfirmed: { pid: owner.pid, identity: owner.identity }, stop: false };
      const unconfirmed = confirm();
      if (unconfirmed !== null) {
        return rollBack(`reload not activated: ${unconfirmed}`, pending);
      }
      try {
        LocalEdgeKit_writeRouterState(host, router, { pid: owner.pid, identity: owner.identity, activeConfigSha256: sha });
      } catch (error) {
        return fail(
          `nginx reloaded but its state could not be recorded: ${(error as Error).message}; nginx pid ${String(owner.pid)} is still running and the confirmed new config stays active and in place (nothing was rolled back); the next run will reload it again and record the state`,
          [(error as Error).message],
        );
      }
      return { appId: id, ok: true, action: "adopted", message: `nginx pid ${String(owner.pid)} reloaded with the new config` };
    }
    // No nginx runs: a socket file left by a crashed one would block the marker listener.
    host.removeFile(rendered.socketPath);
    const started = LocalEdgeKit_runNginx(host, bin, ["-c", nginx.confPath]);
    if (started !== null) {
      return rollBack(started);
    }
    starting = { pid: null };
    const newPid = LocalEdgeKit_readPidFile(host, nginx.pidPath);
    starting.pid = newPid;
    const identity = newPid === null ? null : host.processIdentity(newPid);
    if (newPid === null || identity === null) {
      return rollBack("nginx returned 0 but its pid file names no live process");
    }
    if (!LocalEdgeKit_looksLikeOurNginx(host, identity, nginx.confPath)) {
      return rollBack(`nginx returned 0 but pid ${String(newPid)} is not an nginx master for this config; not recorded or signalled`);
    }
    pending = { unconfirmed: { pid: newPid, identity }, stop: true };
    starting = undefined;
    const unconfirmedStart = confirm();
    if (unconfirmedStart !== null) {
      return rollBack(`nginx pid ${String(newPid)} started but not activated: ${unconfirmedStart}`, pending);
    }
    try {
      LocalEdgeKit_writeRouterState(host, router, { pid: newPid, identity, activeConfigSha256: sha });
    } catch (error) {
      return fail(
        `nginx started but its state could not be recorded: ${(error as Error).message}; nginx pid ${String(newPid)} is still running and the confirmed new config stays active and in place (nothing was rolled back); the next run will reload it again and record the state`,
        [(error as Error).message],
      );
    }
    return { appId: id, ok: true, action: "started", message: `nginx pid ${String(newPid)} on ${settings.routerHost}:${String(settings.routerPort)}` };
  };
  try {
    return activate();
  } catch (error) {
    return rollBack("activation was interrupted", { ...(pending ?? (starting ? identifyStarted(starting.pid) : {})), thrown: error });
  }
}

/**
 * Stops the router with SIGQUIT (graceful) when its pid file names a verified nginx, reading the
 * identity again immediately before the signal and while waiting. An unverified pid is never
 * signalled.
 *
 * @param options - Manifest with `hostnames` settings, router settings and host.
 * @returns `already-stopped`, `stopped`, or `failed` with the reason. A stopped router whose
 * state file could not be removed is still `ok: true` with action `stopped`; the removal error is
 * in `errors` and the message, and the next `up` starts nginx normally. A host call that throws
 * while stopping gives `ok: false` with that error in `errors`. The reads before the signal (the
 * pid file, the state file, the process identity) are not caught: if one fails the call throws,
 * and nothing has been signalled, stopped or removed.
 * @throws When the manifest has no `hostnames` settings, or when a read before the signal (pid
 * file, state, identity) fails; in both cases nothing has been changed.
 * @example
 * ```typescript
 * LocalEdgeKit_routerDown({ manifest, router: { stateRoot: "/w/state" }, host });
 * ```
 */
export function LocalEdgeKit_routerDown(options: {
  manifest: LocalEdgeCore_ExposureManifest;
  router: LocalEdgeKit_SupervisorRouterConfig;
  host: LocalEdgeKit_SupervisorHost;
}): LocalEdgeKit_SupervisorStepResult {
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
  let quit: ReturnType<typeof LocalEdgeKit_quitVerifiedRouter>;
  try {
    quit = LocalEdgeKit_quitVerifiedRouter(host, router, owner.pid, owner.identity);
  } catch (error) {
    // A host call threw after the signal may have gone out: report it, do not throw.
    const text = `stopping the router failed: ${error instanceof Error ? error.message : String(error)}`;
    return { appId: id, ok: false, action: "failed", message: text, errors: [text] };
  }
  const errors = [quit.error, quit.stateError === null ? null : `removing the router state file failed: ${quit.stateError}`].filter((e): e is string => e !== null);
  return {
    appId: id,
    ok: quit.error === null,
    action: quit.error === null ? "stopped" : "failed",
    message: quit.error ?? [`nginx pid ${String(owner.pid)} quit`, ...errors].join("; "),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/**
 * Sends SIGQUIT to a verified nginx (identity read again right before the signal) and waits up
 * to `stopTimeoutMs` for it to exit; then removes the state file. A state file that cannot be
 * removed does not undo the stop: it is reported in `stateError` and left to the caller.
 *
 * @returns `error` is null when it quit, otherwise why not; `stateError` is why the state file
 * could not be removed after a quit, otherwise null.
 */
function LocalEdgeKit_quitVerifiedRouter(
  host: LocalEdgeKit_SupervisorHost,
  router: LocalEdgeKit_SupervisorRouterConfig,
  pid: number,
  identity: LocalEdgeKit_ProcessIdentity,
): { error: string | null; stateError: string | null } {
  const quit = LocalEdgeKit_signalVerified(host, pid, identity, "SIGQUIT");
  if (quit !== null) {
    return { error: quit, stateError: null };
  }
  const stillOurs = () => LocalEdgeKit_verifyProcessIdentity({ pid, recorded: identity, current: host.processIdentity(pid) }).ok;
  const deadline = host.now() + (router.stopTimeoutMs ?? 10_000);
  while (stillOurs() && host.now() < deadline) {
    host.sleepSync(200);
  }
  if (stillOurs()) {
    return { error: "nginx still running after quit", stateError: null };
  }
  try {
    host.removeFile(LocalEdgeKit_routerStatePath(router));
  } catch (error) {
    return { error: null, stateError: error instanceof Error ? error.message : String(error) };
  }
  return { error: null, stateError: null };
}
