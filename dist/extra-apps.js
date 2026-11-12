/**
 * @fileoverview Per-machine extra apps for the router: route-only apps that are not part of the
 * project manifest, read from pluggable sources and merged with it.
 *
 * A source is anything with a name and a `load()` that returns extra apps. The built-in file
 * source reads a JSON file through `LocalEdgeKit_readFileSafe` from safe-write.ts, the same
 * containment as the careful writers: inside a given root, no symlinked folder below the root, no
 * symlinked file, opened with `O_NOFOLLOW` and rechecked while the descriptor is held. A missing
 * file means no extra apps. The file must be owned by you and writable by you alone (0600) in a
 * folder that is owned by you and not writable by group or others (0700), and at most 256 KiB;
 * otherwise it is refused, because it chooses which loopback ports are published. Parse errors give
 * a fixed message and the position, never file content, and unknown keys are refused. Every extra
 * app is route only (`external`): the supervisor lists, probes and routes it, and never starts,
 * stops or signals its process.
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
 * @see src/safe-write.ts - `LocalEdgeKit_readFileSafe`, the contained read this source uses.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import path from "node:path";
import { LocalEdgeCore_exposureAppHost } from "@gg-utils/local-edge-core/exposure";
import { LocalEdgeKit_readFileSafe } from "./safe-write.js";
import { LOCAL_EDGE_KIT_ROUTER_ID } from "./supervisor-router.js";
/**
 * Source name given to apps declared in the project config (those without a `source` of their own).
 * It is what `status` shows in the `SOURCE` column and what duplicate errors call the project side.
 *
 * @example
 * ```typescript
 * const merged = LocalEdgeKit_mergeExtraApps({ apps, sources: [] });
 * merged.every((app) => app.source === LOCAL_EDGE_KIT_PROJECT_APPS_SOURCE); // true
 * ```
 */
export const LOCAL_EDGE_KIT_PROJECT_APPS_SOURCE = "project";
/** App ids the supervisor uses itself; an extra app may not take them. */
export const LOCAL_EDGE_KIT_RESERVED_APP_IDS = [LOCAL_EDGE_KIT_ROUTER_ID];
const LOCAL_EDGE_KIT_LOOPBACK = "127.0.0.1";
/** Parses `127.0.0.1:<port>` into the port; null when it is anything else. */
function LocalEdgeKit_loopbackPort(value) {
    if (typeof value !== "string") {
        return null;
    }
    const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(value);
    const port = match ? Number(match[1]) : NaN;
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
const LOCAL_EDGE_KIT_PROXY_KEYS = ["upstreamHost", "buffering", "readTimeout"];
const LOCAL_EDGE_KIT_TOP_KEYS = ["apps"];
const LOCAL_EDGE_KIT_APP_KEYS = ["id", "host", "upstream", "description", "healthPath", "locations", ...LOCAL_EDGE_KIT_PROXY_KEYS];
const LOCAL_EDGE_KIT_LOCATION_KEYS = ["path", "upstream", "upstreamPath", ...LOCAL_EDGE_KIT_PROXY_KEYS];
/** Lists keys of `value` that are not in `allowed`; a key is named only when it is a short plain token. */
function LocalEdgeKit_unknownKeyProblems(label, value, allowed) {
    return Object.keys(value)
        .map((key, index) => ({ key, index }))
        .filter((entry) => !allowed.includes(entry.key))
        .map((entry) => /^[A-Za-z0-9_-]{1,40}$/.test(entry.key)
        ? `${label}: unknown key "${entry.key}"`
        : `${label}: unknown key (key number ${String(entry.index + 1)} in the object)`);
}
/**
 * Describes where a `JSON.parse` failure is, without any file content: line and column when the
 * engine reports them or a character position, otherwise that no position is known.
 */
function LocalEdgeKit_jsonErrorPosition(text, error) {
    const message = error instanceof Error ? error.message : "";
    const lineColumn = /\(line (\d+) column (\d+)\)/.exec(message);
    if (lineColumn !== null) {
        return `line ${lineColumn[1] ?? "?"}, column ${lineColumn[2] ?? "?"}`;
    }
    const position = /position (\d+)/.exec(message);
    if (position !== null) {
        const offset = Number(position[1]);
        const before = text.slice(0, offset);
        const line = before.split("\n").length;
        return `line ${String(line)}, column ${String(offset - before.lastIndexOf("\n"))}`;
    }
    return "position not reported";
}
/** Checks the optional proxy fields of an app or location object. */
function LocalEdgeKit_proxyFieldProblems(label, value) {
    const problems = [];
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
function LocalEdgeKit_pickProxy(value) {
    const proxy = {};
    for (const key of LOCAL_EDGE_KIT_PROXY_KEYS) {
        if (value[key] !== undefined) {
            Object.assign(proxy, { [key]: value[key] });
        }
    }
    return proxy;
}
/** True for a plain object. */
function LocalEdgeKit_isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Parses and checks extra-apps JSON. Throws one error listing every problem, prefixed with the
 * source name. Host labels and proxy values are checked again by the router against its config.
 * Unknown keys are refused at every level (a typo such as `upstreamhost` must not be dropped
 * silently); a key is named only when it is a short plain token. A JSON syntax error gives a fixed
 * message and the position, never any of the file's text.
 *
 * @param text - The JSON text, for example the file's content.
 * @param sourceName - Name shown in every error, for example the file path.
 * @returns The validated apps, each with a (possibly empty) `locations` array.
 * @throws Error `local-edge-kit-extra-apps-invalid: <source>: ...` for a syntax error, a wrong
 * shape, an unknown key or an invalid field; all field problems are listed in one message.
 * @example
 * ```typescript
 * const apps = LocalEdgeKit_parseExtraAppsJson(
 *   '{ "apps": [{ "id": "play", "host": "play.m1.example.test", "upstream": "127.0.0.1:5174" }] }',
 *   "apps.json",
 * );
 * apps[0]?.id; // "play"
 * ```
 */
export function LocalEdgeKit_parseExtraAppsJson(text, sourceName) {
    let data;
    try {
        data = JSON.parse(text);
    }
    catch (error) {
        throw new Error(`local-edge-kit-extra-apps-invalid: ${sourceName}: not valid JSON (${LocalEdgeKit_jsonErrorPosition(text, error)})`);
    }
    if (!LocalEdgeKit_isRecord(data) || !Array.isArray(data.apps)) {
        throw new Error(`local-edge-kit-extra-apps-invalid: ${sourceName}: expected an object with an "apps" array`);
    }
    const problems = LocalEdgeKit_unknownKeyProblems("top level", data, LOCAL_EDGE_KIT_TOP_KEYS);
    const apps = [];
    data.apps.forEach((raw, index) => {
        const label = `apps[${String(index)}]`;
        if (!LocalEdgeKit_isRecord(raw)) {
            problems.push(`${label}: must be an object`);
            return;
        }
        const id = typeof raw.id === "string" ? raw.id : "";
        const appLabel = /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : label;
        const before = problems.length;
        problems.push(...LocalEdgeKit_unknownKeyProblems(appLabel, raw, LOCAL_EDGE_KIT_APP_KEYS));
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
        const locations = [];
        if (raw.locations !== undefined && !Array.isArray(raw.locations)) {
            problems.push(`${appLabel}: locations must be an array`);
        }
        (Array.isArray(raw.locations) ? raw.locations : []).forEach((location, locationIndex) => {
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
            problems.push(...LocalEdgeKit_unknownKeyProblems(locationLabel, location, LOCAL_EDGE_KIT_LOCATION_KEYS));
            problems.push(...LocalEdgeKit_proxyFieldProblems(locationLabel, location));
            locations.push(location);
        });
        if (problems.length === before) {
            apps.push({ ...raw, locations });
        }
    });
    if (problems.length > 0) {
        throw new Error(`local-edge-kit-extra-apps-invalid: ${sourceName}: ${problems.join("; ")}`);
    }
    return apps;
}
/**
 * A source that reads extra apps from a JSON file with the careful-read rules. Loading throws
 * when the file is a symlink, outside the root, not a regular file, over 256 KiB, owned by
 * someone else or writable by group or others, or in a folder that is owned by someone else or
 * writable by group or others (use 0600 in a 0700 folder). A missing file loads as no apps.
 *
 * @param options - File path, optional root (default: the file's folder) and source name.
 * @returns A source whose `load()` reads and validates the file each time it is called.
 * @throws At `load()`: `local-edge-kit-safe-read-*` for the file rules above, or
 * `local-edge-kit-extra-apps-invalid` for content problems.
 * @example
 * ```typescript
 * const source = LocalEdgeKit_createExtraAppsFileSource({ filePath: "/home/me/.config/edge/apps.json" });
 * const apps = source.load(); // [] when the file does not exist
 * ```
 */
export function LocalEdgeKit_createExtraAppsFileSource(options) {
    const name = options.name ?? options.filePath;
    return {
        name,
        load: () => {
            const text = LocalEdgeKit_readFileSafe(options.filePath, { root: options.root ?? path.dirname(options.filePath) });
            return text === null ? [] : LocalEdgeKit_parseExtraAppsJson(text, name);
        },
    };
}
/**
 * Turns one extra app into a route-only supervised app tagged with its source. Only the named
 * fields are copied, and `external` is always true, so an extra app can never start a command.
 *
 * @param app - A validated extra app.
 * @param source - Source name stored on the result.
 * @returns A supervised app with `external: true`, `enabled: true`, the host and proxy overrides.
 * @example
 * ```typescript
 * const supervised = LocalEdgeKit_extraAppToSupervisedApp(
 *   { id: "play", host: "play.m1.example.test", upstream: "127.0.0.1:5174" },
 *   "apps.json",
 * );
 * supervised.localPort; // 5174
 * ```
 */
export function LocalEdgeKit_extraAppToSupervisedApp(app, source) {
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
/** Lowercases a host and drops trailing dots, so `A.Example.test.` and `a.example.test` compare equal. */
function LocalEdgeKit_normalizeHost(host) {
    return host.toLowerCase().replace(/\.+$/, "");
}
/**
 * Merges project apps with every source's apps. Project apps keep their `source` or get
 * `project`. Ids compare case-insensitively and hosts after lowercasing and dropping a trailing
 * dot.
 *
 * @param options - Project apps, the sources to load, and (to check hosts) the hostname settings.
 * @returns The project apps followed by each source's apps, in source order.
 * @throws `local-edge-kit-extra-apps-reserved-id` when a source app uses an id the supervisor
 * keeps for itself (`router`); `local-edge-kit-extra-apps-conflict`, naming both sources, on a
 * duplicate id or (when hostname settings are given) a duplicate host among enabled apps. A
 * source's own `load()` errors pass through.
 * @example
 * ```typescript
 * const apps = LocalEdgeKit_mergeExtraApps({
 *   apps: projectApps,
 *   sources: [LocalEdgeKit_createExtraAppsFileSource({ filePath })],
 *   hostnames,
 * });
 * ```
 */
export function LocalEdgeKit_mergeExtraApps(options) {
    const merged = options.apps.map((app) => ({
        ...app,
        source: app.source ?? LOCAL_EDGE_KIT_PROJECT_APPS_SOURCE,
    }));
    for (const source of options.sources) {
        for (const extra of source.load()) {
            if (LOCAL_EDGE_KIT_RESERVED_APP_IDS.includes(extra.id.toLowerCase())) {
                throw new Error(`local-edge-kit-extra-apps-reserved-id: ${source.name}: app id ${extra.id} is reserved for the supervisor`);
            }
            merged.push(LocalEdgeKit_extraAppToSupervisedApp(extra, source.name));
        }
    }
    const problems = [];
    const ids = new Map();
    const hosts = new Map();
    for (const app of merged) {
        const idKey = app.id.toLowerCase();
        const other = ids.get(idKey);
        if (other !== undefined) {
            problems.push(`duplicate app id ${app.id}: ${other.source ?? "-"} and ${app.source ?? "-"}`);
        }
        ids.set(idKey, app);
        if (!app.enabled || options.hostnames === undefined) {
            continue;
        }
        let host;
        try {
            host = LocalEdgeKit_normalizeHost(LocalEdgeCore_exposureAppHost(options.hostnames, app));
        }
        catch {
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
