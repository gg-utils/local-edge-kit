/**
 * @fileoverview Per-machine extra apps for the router: route-only apps that are not part of the
 * project manifest, read from pluggable sources and merged with it.
 *
 * A source is anything with a name and a `load()` that returns extra apps. The built-in file
 * source reads a JSON file through `LocalEdgeKit_readFileSafe` from safe-write.ts, the same
 * containment as the careful writers: inside a given root, no symlinked folder below the root, no
 * symlinked file, opened with `O_NOFOLLOW` and rechecked while the descriptor is held. A missing
 * file means no extra apps. The file must be owned by you and not writable by group or others, in
 * a folder that is owned by you and not writable by group or others, and at most 256 KiB;
 * otherwise it is refused, because it chooses which loopback ports are published (who can change
 * it matters, not who can read it, so read access by group or others is not refused; 0600 in a
 * 0700 folder is the recommended setup). Only the folder holding the file is checked; folders
 * between the root and it, and everything above the root, are trusted. Parse errors give
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
import { type LocalEdgeCore_ExposureHostnamesConfig } from "@gg-utils/local-edge-core/exposure";
import type { LocalEdgeKit_SupervisedApp, LocalEdgeKit_SupervisedAppProxy } from "./supervisor.js";
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
export declare const LOCAL_EDGE_KIT_PROJECT_APPS_SOURCE = "project";
/** App ids the supervisor uses itself; an extra app may not take them. */
export declare const LOCAL_EDGE_KIT_RESERVED_APP_IDS: readonly string[];
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
    /** Folder the file must stay inside; no symlinked folder below it. Default: the file's own folder. */
    root?: string | undefined;
    /** Source name. Default: the file path. */
    name?: string | undefined;
};
/**
 * Finds the first character offset (UTF-16 units, from 0) at which `text` stops being strict
 * JSON, with a small tokenizer of our own, so the answer does not depend on how any engine words
 * its `JSON.parse` message. It uses an explicit stack, so deeply nested input cannot overflow the
 * call stack. An unexpected end of input is reported at `text.length`.
 *
 * @param text - The text to scan.
 * @returns The offset of the first offending character, or `null` when the text is valid JSON.
 *
 * @example
 * ```typescript
 * LocalEdgeKit_jsonFirstErrorOffset('{"a": 1,}'); // 8
 * LocalEdgeKit_jsonFirstErrorOffset('{"a": 1}'); // null
 * ```
 */
export declare function LocalEdgeKit_jsonFirstErrorOffset(text: string): number | null;
/**
 * Describes where a `JSON.parse` failure is, without any file content: `line L, column C`
 * (both from 1; a line break is `\n`; the column counts UTF-16 units) when a position can be
 * found, otherwise `position not reported`.
 *
 * The line and column are always computed here from a character offset. The offset is the one the
 * engine's message gives (`... at position N`, a form Node 22 to 26 all use when they report a
 * position) when it lies inside the text; otherwise it comes from our own strict scan, so a
 * multi-line file or a change in the engine's wording still gets a position. The engine's
 * message is only read for that number and is never repeated.
 *
 * @param text - The text that failed to parse.
 * @param error - What `JSON.parse` threw.
 * @returns Text that is safe to put in a message.
 *
 * @example
 * ```typescript
 * LocalEdgeKit_jsonErrorPosition('{\n  "a": 1,\n}', new Error("anything")); // "line 3, column 1"
 * ```
 */
export declare function LocalEdgeKit_jsonErrorPosition(text: string, error: unknown): string;
/**
 * Parses and checks extra-apps JSON. Throws one error listing every problem, prefixed with the
 * source name. Host labels and proxy values are checked again by the router against its config.
 * Unknown keys are refused at every level (a typo such as `upstreamhost` must not be dropped
 * silently); a key is named only when it is a short plain token. An id must be 1 to 63 lowercase
 * letters, digits and dashes and a host must have the shape of a host name; a value that does
 * not is refused without being repeated, so file text never reaches a later message. A JSON syntax error gives a fixed
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
export declare function LocalEdgeKit_parseExtraAppsJson(text: string, sourceName: string): LocalEdgeKit_ExtraApp[];
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
export declare function LocalEdgeKit_createExtraAppsFileSource(options: LocalEdgeKit_ExtraAppsFileSourceOptions): LocalEdgeKit_ExtraAppsSource;
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
export declare function LocalEdgeKit_extraAppToSupervisedApp(app: LocalEdgeKit_ExtraApp, source: string): LocalEdgeKit_SupervisedApp;
/**
 * Merges project apps with every source's apps. Project apps keep their `source` or get
 * `project`. Ids compare after lowercasing and dropping a trailing dot (so `ROUTER.` is `router`)
 * and hosts the same way.
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
export declare function LocalEdgeKit_mergeExtraApps(options: {
    apps: readonly LocalEdgeKit_SupervisedApp[];
    sources: readonly LocalEdgeKit_ExtraAppsSource[];
    hostnames?: LocalEdgeCore_ExposureHostnamesConfig | undefined;
}): LocalEdgeKit_SupervisedApp[];
