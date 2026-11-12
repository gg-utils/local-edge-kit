/**
 * @fileoverview Per-machine extra apps for the router: route-only apps that are not part of the
 * project manifest, read from pluggable sources and merged with it.
 *
 * A source is anything with a name and a `load()` that returns extra apps. The built-in file
 * source reads a JSON file with the same rules as the careful writers: the file must sit inside a
 * given root after `realpath`, must not be a symlink, and is opened with `O_NOFOLLOW`. A missing
 * file means no extra apps. Every extra app is route only (`external`): the supervisor lists,
 * probes and routes it, and never starts, stops or signals its process.
 * Flow: sources -> load + validate -> supervised apps with `source` -> merge (ids and hosts unique).
 *
 * File shape:
 *   { "apps": [ { "id": "play", "host": "play.m1.example.test", "upstream": "127.0.0.1:5174",
 *     "upstreamHost": "127.0.0.1:5174", "buffering": false, "readTimeout": "3600s",
 *     "locations": [ { "path": "/api", "upstream": "127.0.0.1:33114" } ] } ] }
 *
 * @testing Node test runner (tsx): npm run test -- src/extra-apps.unit.test.ts
 *
 * @see src/supervisor-cli.ts - Merges the sources before every command.
 * @see src/safe-write.ts - The same containment and symlink rules for writes.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { type LocalEdgeCore_ExposureHostnamesConfig, LocalEdgeCore_exposureAppHost } from "@gg-utils/local-edge-core/exposure";

import type { LocalEdgeKit_SupervisedApp, LocalEdgeKit_SupervisedAppProxy } from "./supervisor.js";

/** Source name of apps declared in the project config. */
export const LOCAL_EDGE_KIT_PROJECT_APPS_SOURCE = "project";

/** One extra path route of an extra app. */
export type LocalEdgeKit_ExtraAppLocation = LocalEdgeKit_SupervisedAppProxy & {
  path: string;
  /** `127.0.0.1:<port>`. */
  upstream: string;
  /** Path sent upstream. Omitted: the request URI passes through unchanged. */
  upstreamPath?: string | undefined;
};

/** One route-only app declared outside the project config. */
export type LocalEdgeKit_ExtraApp = LocalEdgeKit_SupervisedAppProxy & {
  id: string;
  /** Exact host; must sit under one of the router's wildcards. */
  host: string;
  /** `127.0.0.1:<port>` the `/` location goes to. */
  upstream: string;
  description?: string | undefined;
  /** Health path for `status` and `health`. Default `/`. */
  healthPath?: string | undefined;
  locations?: readonly LocalEdgeKit_ExtraAppLocation[] | undefined;
};

/** A pluggable source of extra apps. */
export type LocalEdgeKit_ExtraAppsSource = {
  /** Shown in `status` and in errors, for example the file path. */
  name: string;
  /** Returns the apps, or throws with every problem found. */
  load: () => readonly LocalEdgeKit_ExtraApp[];
};

/** Options for `LocalEdgeKit_createExtraAppsFileSource`. */
export type LocalEdgeKit_ExtraAppsFileSourceOptions = {
  /** JSON file. A missing file means no extra apps. */
  filePath: string;
  /** Folder the file must stay inside after `realpath`. Default: the file's own folder. */
  root?: string | undefined;
  /** Source name. Default: the file path. */
  name?: string | undefined;
};

const LOCAL_EDGE_KIT_LOOPBACK = "127.0.0.1";

/** True when `child` equals `parent` or sits under it. */
function LocalEdgeKit_isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Reads a text file inside `root`: lexical and `realpath` containment, no symlinked target, opened
 * with `O_NOFOLLOW`. Returns null when the file does not exist. Throws otherwise.
 */
export function LocalEdgeKit_readFileSafe(filePath: string, options: { root: string }): string | null {
  const root = path.resolve(options.root);
  const target = path.resolve(filePath);
  if (!LocalEdgeKit_isWithin(root, target) || target === root) {
    throw new Error(`local-edge-kit-safe-read-outside-root: ${target} is not inside ${root}`);
  }
  let realRoot: string;
  let realDir: string;
  try {
    realRoot = realpathSync(root);
    realDir = realpathSync(path.dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!LocalEdgeKit_isWithin(realRoot, realDir)) {
    throw new Error(`local-edge-kit-safe-read-outside-root: ${path.dirname(target)} resolves to ${realDir}, outside ${realRoot}`);
  }
  const resolved = path.join(realDir, path.basename(target));
  let stats;
  try {
    stats = lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`local-edge-kit-safe-read-symlink: refusing to read through symlink ${resolved}`);
  }
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`local-edge-kit-safe-read-not-file: ${resolved} is not a regular file`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Parses `127.0.0.1:<port>` into the port; null when it is anything else. */
function LocalEdgeKit_loopbackPort(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(value);
  const port = match ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

const LOCAL_EDGE_KIT_PROXY_KEYS = ["upstreamHost", "buffering", "readTimeout"] as const;

/** Checks the optional proxy fields of an app or location object. */
function LocalEdgeKit_proxyFieldProblems(label: string, value: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (value.upstreamHost !== undefined && typeof value.upstreamHost !== "string") {
    problems.push(`${label}: upstreamHost must be a string`);
  }
  if (value.buffering !== undefined && typeof value.buffering !== "boolean") {
    problems.push(`${label}: buffering must be true or false`);
  }
  if (value.readTimeout !== undefined && typeof value.readTimeout !== "string") {
    problems.push(`${label}: readTimeout must be a string such as "3600s"`);
  }
  return problems;
}

/** Picks the proxy fields that are set. */
function LocalEdgeKit_pickProxy(value: LocalEdgeKit_SupervisedAppProxy): LocalEdgeKit_SupervisedAppProxy {
  const proxy: LocalEdgeKit_SupervisedAppProxy = {};
  for (const key of LOCAL_EDGE_KIT_PROXY_KEYS) {
    if (value[key] !== undefined) {
      Object.assign(proxy, { [key]: value[key] });
    }
  }
  return proxy;
}

/** True for a plain object. */
function LocalEdgeKit_isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses and checks extra-apps JSON. Throws one error listing every problem, prefixed with the
 * source name. Host labels and proxy values are checked again by the router against its config.
 */
export function LocalEdgeKit_parseExtraAppsJson(text: string, sourceName: string): LocalEdgeKit_ExtraApp[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`local-edge-kit-extra-apps-invalid: ${sourceName}: not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!LocalEdgeKit_isRecord(data) || !Array.isArray(data.apps)) {
    throw new Error(`local-edge-kit-extra-apps-invalid: ${sourceName}: expected an object with an "apps" array`);
  }
  const problems: string[] = [];
  const apps: LocalEdgeKit_ExtraApp[] = [];
  data.apps.forEach((raw: unknown, index: number) => {
    const label = `apps[${String(index)}]`;
    if (!LocalEdgeKit_isRecord(raw)) {
      problems.push(`${label}: must be an object`);
      return;
    }
    const id = typeof raw.id === "string" ? raw.id : "";
    const appLabel = id === "" ? label : id;
    const before = problems.length;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      problems.push(`${label}: id must be lowercase letters, digits and dashes`);
    }
    if (typeof raw.host !== "string" || raw.host.length === 0) {
      problems.push(`${appLabel}: host is required`);
    }
    if (LocalEdgeKit_loopbackPort(raw.upstream) === null) {
      problems.push(`${appLabel}: upstream must be ${LOCAL_EDGE_KIT_LOOPBACK}:<port>`);
    }
    if (raw.description !== undefined && typeof raw.description !== "string") {
      problems.push(`${appLabel}: description must be a string`);
    }
    if (raw.healthPath !== undefined && (typeof raw.healthPath !== "string" || !raw.healthPath.startsWith("/"))) {
      problems.push(`${appLabel}: healthPath must start with /`);
    }
    problems.push(...LocalEdgeKit_proxyFieldProblems(appLabel, raw));
    const locations: LocalEdgeKit_ExtraAppLocation[] = [];
    if (raw.locations !== undefined && !Array.isArray(raw.locations)) {
      problems.push(`${appLabel}: locations must be an array`);
    }
    (Array.isArray(raw.locations) ? (raw.locations as unknown[]) : []).forEach((location, locationIndex) => {
      const locationLabel = `${appLabel}: locations[${String(locationIndex)}]`;
      if (!LocalEdgeKit_isRecord(location)) {
        problems.push(`${locationLabel}: must be an object`);
        return;
      }
      if (typeof location.path !== "string") {
        problems.push(`${locationLabel}: path is required`);
      }
      if (LocalEdgeKit_loopbackPort(location.upstream) === null) {
        problems.push(`${locationLabel}: upstream must be ${LOCAL_EDGE_KIT_LOOPBACK}:<port>`);
      }
      if (location.upstreamPath !== undefined && typeof location.upstreamPath !== "string") {
        problems.push(`${locationLabel}: upstreamPath must be a string`);
      }
      problems.push(...LocalEdgeKit_proxyFieldProblems(locationLabel, location));
      locations.push(location as LocalEdgeKit_ExtraAppLocation);
    });
    if (problems.length === before) {
      apps.push({ ...(raw as LocalEdgeKit_ExtraApp), locations });
    }
  });
  if (problems.length > 0) {
    throw new Error(`local-edge-kit-extra-apps-invalid: ${sourceName}: ${problems.join("; ")}`);
  }
  return apps;
}

/** A source that reads extra apps from a JSON file with the careful-read rules. */
export function LocalEdgeKit_createExtraAppsFileSource(options: LocalEdgeKit_ExtraAppsFileSourceOptions): LocalEdgeKit_ExtraAppsSource {
  const name = options.name ?? options.filePath;
  return {
    name,
    load: () => {
      const text = LocalEdgeKit_readFileSafe(options.filePath, { root: options.root ?? path.dirname(options.filePath) });
      return text === null ? [] : LocalEdgeKit_parseExtraAppsJson(text, name);
    },
  };
}

/** Turns one extra app into a route-only supervised app tagged with its source. */
export function LocalEdgeKit_extraAppToSupervisedApp(app: LocalEdgeKit_ExtraApp, source: string): LocalEdgeKit_SupervisedApp {
  return {
    id: app.id,
    enabled: true,
    external: true,
    description: app.description,
    localPort: LocalEdgeKit_loopbackPort(app.upstream) ?? 0,
    healthPath: app.healthPath ?? "/",
    host: app.host,
    proxy: LocalEdgeKit_pickProxy(app),
    locations: (app.locations ?? []).map((location) => ({
      path: location.path,
      localPort: LocalEdgeKit_loopbackPort(location.upstream) ?? 0,
      upstreamPath: location.upstreamPath ?? "",
      ...LocalEdgeKit_pickProxy(location),
    })),
    source,
  };
}

/**
 * Merges project apps with every source's apps. Project apps keep their `source` or get
 * `project`. Throws, naming both sources, on a duplicate id or (when hostname settings are given)
 * a duplicate host among enabled apps.
 */
export function LocalEdgeKit_mergeExtraApps(options: {
  apps: readonly LocalEdgeKit_SupervisedApp[];
  sources: readonly LocalEdgeKit_ExtraAppsSource[];
  hostnames?: LocalEdgeCore_ExposureHostnamesConfig | undefined;
}): LocalEdgeKit_SupervisedApp[] {
  const merged: LocalEdgeKit_SupervisedApp[] = options.apps.map((app) => ({
    ...app,
    source: app.source ?? LOCAL_EDGE_KIT_PROJECT_APPS_SOURCE,
  }));
  for (const source of options.sources) {
    merged.push(...source.load().map((app) => LocalEdgeKit_extraAppToSupervisedApp(app, source.name)));
  }
  const problems: string[] = [];
  const ids = new Map<string, LocalEdgeKit_SupervisedApp>();
  const hosts = new Map<string, LocalEdgeKit_SupervisedApp>();
  for (const app of merged) {
    const other = ids.get(app.id);
    if (other !== undefined) {
      problems.push(`duplicate app id ${app.id}: ${other.source ?? "-"} and ${app.source ?? "-"}`);
    }
    ids.set(app.id, app);
    if (!app.enabled || options.hostnames === undefined) {
      continue;
    }
    let host: string;
    try {
      host = LocalEdgeCore_exposureAppHost(options.hostnames, app);
    } catch {
      continue;
    }
    const holder = hosts.get(host);
    if (holder !== undefined) {
      problems.push(`duplicate hostname ${host}: ${holder.id} (${holder.source ?? "-"}) and ${app.id} (${app.source ?? "-"})`);
    }
    hosts.set(host, app);
  }
  if (problems.length > 0) {
    throw new Error(`local-edge-kit-extra-apps-conflict: ${problems.join("; ")}`);
  }
  return merged;
}
