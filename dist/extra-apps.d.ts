/**
 * @fileoverview Per-machine extra apps for the router: route-only apps that are not part of the
 * project manifest, read from pluggable sources and merged with it.
 *
 * A source is anything with a name and a `load()` that returns extra apps. The built-in file
 * source reads a JSON file through `LocalEdgeKit_readFileSafe` from safe-write.ts, the same
 * containment as the careful writers: inside a given root, no symlinked folder below the root, no
 * symlinked file, opened with `O_NOFOLLOW` and rechecked while the descriptor is held. A missing
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
 * @see src/safe-write.ts - `LocalEdgeKit_readFileSafe`, the contained read this source uses.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { type LocalEdgeCore_ExposureHostnamesConfig } from "@gg-utils/local-edge-core/exposure";
import type { LocalEdgeKit_SupervisedApp, LocalEdgeKit_SupervisedAppProxy } from "./supervisor.js";
/** Source name of apps declared in the project config. */
export declare const LOCAL_EDGE_KIT_PROJECT_APPS_SOURCE = "project";
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
 * Parses and checks extra-apps JSON. Throws one error listing every problem, prefixed with the
 * source name. Host labels and proxy values are checked again by the router against its config.
 */
export declare function LocalEdgeKit_parseExtraAppsJson(text: string, sourceName: string): LocalEdgeKit_ExtraApp[];
/** A source that reads extra apps from a JSON file with the careful-read rules. */
export declare function LocalEdgeKit_createExtraAppsFileSource(options: LocalEdgeKit_ExtraAppsFileSourceOptions): LocalEdgeKit_ExtraAppsSource;
/** Turns one extra app into a route-only supervised app tagged with its source. */
export declare function LocalEdgeKit_extraAppToSupervisedApp(app: LocalEdgeKit_ExtraApp, source: string): LocalEdgeKit_SupervisedApp;
/**
 * Merges project apps with every source's apps. Project apps keep their `source` or get
 * `project`. Throws, naming both sources, on a duplicate id or (when hostname settings are given)
 * a duplicate host among enabled apps.
 */
export declare function LocalEdgeKit_mergeExtraApps(options: {
    apps: readonly LocalEdgeKit_SupervisedApp[];
    sources: readonly LocalEdgeKit_ExtraAppsSource[];
    hostnames?: LocalEdgeCore_ExposureHostnamesConfig | undefined;
}): LocalEdgeKit_SupervisedApp[];
