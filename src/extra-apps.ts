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

import path from "node:path";

import { type LocalEdgeCore_ExposureHostnamesConfig, LocalEdgeCore_exposureAppHost } from "@gg-utils/local-edge-core/exposure";

import { LocalEdgeKit_messageWord } from "./safe-message.js";
import { LocalEdgeKit_readFileSafe } from "./safe-write.js";
import type { LocalEdgeKit_SupervisedApp, LocalEdgeKit_SupervisedAppProxy } from "./supervisor.js";
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
export const LOCAL_EDGE_KIT_RESERVED_APP_IDS: readonly string[] = [LOCAL_EDGE_KIT_ROUTER_ID];

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

const LOCAL_EDGE_KIT_LOOPBACK = "127.0.0.1";

/** Parses `127.0.0.1:<port>` into the port; null when it is anything else. */
function LocalEdgeKit_loopbackPort(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(value);
  const port = match ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Shape of an app id read from a file: 1 to 63 lowercase letters, digits and dashes. */
const LOCAL_EDGE_KIT_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Shape of a host name: dot-separated labels of letters, digits and dashes, at most 253 characters, one optional trailing dot. */
function LocalEdgeKit_isHostShape(host: string): boolean {
  return host.length <= 253 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*\.?$/.test(host);
}

const LOCAL_EDGE_KIT_PROXY_KEYS = ["upstreamHost", "buffering", "readTimeout"] as const;
const LOCAL_EDGE_KIT_TOP_KEYS: readonly string[] = ["apps"];
const LOCAL_EDGE_KIT_APP_KEYS: readonly string[] = ["id", "host", "upstream", "description", "healthPath", "locations", ...LOCAL_EDGE_KIT_PROXY_KEYS];
const LOCAL_EDGE_KIT_LOCATION_KEYS: readonly string[] = ["path", "upstream", "upstreamPath", ...LOCAL_EDGE_KIT_PROXY_KEYS];

/** Lists keys of `value` that are not in `allowed`; a key is named only when it is a short plain token. */
function LocalEdgeKit_unknownKeyProblems(label: string, value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value)
    .map((key, index) => ({ key, index }))
    .filter((entry) => !allowed.includes(entry.key))
    .map((entry) =>
      /^[A-Za-z0-9_-]{1,40}$/.test(entry.key)
        ? `${label}: unknown key "${entry.key}"`
        : `${label}: unknown key (key number ${String(entry.index + 1)} in the object)`,
    );
}

/** True for the four JSON whitespace characters. */
function LocalEdgeKit_isJsonSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/** True for `0`-`9`. */
function LocalEdgeKit_isJsonDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/**
 * Scans the string that starts at `start` (a double quote). Returns the offset after the closing
 * quote, or the offset of the first character that is not allowed as `{ fail }`.
 */
function LocalEdgeKit_scanJsonString(text: string, start: number): { next: number } | { fail: number } {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === '"') {
      return { next: index + 1 };
    }
    if (char < " ") {
      return { fail: index };
    }
    if (char === "\\") {
      const escape = text[index + 1];
      if (escape === "u") {
        for (let offset = 2; offset <= 5; offset += 1) {
          if (!/^[0-9A-Fa-f]$/.test(text[index + offset] ?? "")) {
            return { fail: Math.min(index + offset, text.length) };
          }
        }
        index += 6;
        continue;
      }
      if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
        return { fail: Math.min(index + 1, text.length) };
      }
      index += 2;
      continue;
    }
    index += 1;
  }
  return { fail: text.length };
}

/** Scans the number that starts at `start`. Returns the offset after it, or the first offending offset as `{ fail }`. */
function LocalEdgeKit_scanJsonNumber(text: string, start: number): { next: number } | { fail: number } {
  let index = start;
  if (text[index] === "-") {
    index += 1;
  }
  if (text[index] === "0") {
    index += 1;
  } else if (LocalEdgeKit_isJsonDigit(text[index])) {
    while (LocalEdgeKit_isJsonDigit(text[index])) {
      index += 1;
    }
  } else {
    return { fail: Math.min(index, text.length) };
  }
  if (text[index] === ".") {
    index += 1;
    if (!LocalEdgeKit_isJsonDigit(text[index])) {
      return { fail: Math.min(index, text.length) };
    }
    while (LocalEdgeKit_isJsonDigit(text[index])) {
      index += 1;
    }
  }
  if (text[index] === "e" || text[index] === "E") {
    index += 1;
    if (text[index] === "+" || text[index] === "-") {
      index += 1;
    }
    if (!LocalEdgeKit_isJsonDigit(text[index])) {
      return { fail: Math.min(index, text.length) };
    }
    while (LocalEdgeKit_isJsonDigit(text[index])) {
      index += 1;
    }
  }
  return { next: index };
}

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
export function LocalEdgeKit_jsonFirstErrorOffset(text: string): number | null {
  const stack: ("array" | "object")[] = [];
  let index = 0;
  let state: "value" | "valueOrEnd" | "keyOrEnd" | "key" | "colon" | "afterValue" = "value";
  for (;;) {
    while (LocalEdgeKit_isJsonSpace(text[index])) {
      index += 1;
    }
    const char = text[index];
    if (char === undefined && !(state === "afterValue" && stack.length === 0)) {
      return text.length;
    }
    switch (state) {
      case "colon":
        if (char !== ":") {
          return index;
        }
        index += 1;
        state = "value";
        break;
      case "afterValue": {
        const top = stack[stack.length - 1];
        if (top === undefined) {
          return char === undefined ? null : index;
        }
        if (char === ",") {
          index += 1;
          state = top === "array" ? "value" : "key";
        } else if ((top === "array" && char === "]") || (top === "object" && char === "}")) {
          stack.pop();
          index += 1;
        } else {
          return index;
        }
        break;
      }
      case "key":
      case "keyOrEnd": {
        if (state === "keyOrEnd" && char === "}") {
          stack.pop();
          index += 1;
          state = "afterValue";
          break;
        }
        if (char !== '"') {
          return index;
        }
        const key = LocalEdgeKit_scanJsonString(text, index);
        if ("fail" in key) {
          return key.fail;
        }
        index = key.next;
        state = "colon";
        break;
      }
      default: {
        // "value" or "valueOrEnd"
        if (state === "valueOrEnd" && char === "]") {
          stack.pop();
          index += 1;
          state = "afterValue";
          break;
        }
        if (char === "{" || char === "[") {
          stack.push(char === "{" ? "object" : "array");
          index += 1;
          state = char === "{" ? "keyOrEnd" : "valueOrEnd";
          break;
        }
        if (char === '"') {
          const value = LocalEdgeKit_scanJsonString(text, index);
          if ("fail" in value) {
            return value.fail;
          }
          index = value.next;
        } else if (char === "-" || LocalEdgeKit_isJsonDigit(char)) {
          const value = LocalEdgeKit_scanJsonNumber(text, index);
          if ("fail" in value) {
            return value.fail;
          }
          index = value.next;
        } else {
          const word = ["true", "false", "null"].find((candidate) => candidate[0] === char);
          if (word === undefined) {
            return index;
          }
          for (let offset = 1; offset < word.length; offset += 1) {
            if (text[index + offset] !== word[offset]) {
              return Math.min(index + offset, text.length);
            }
          }
          index += word.length;
        }
        state = "afterValue";
      }
    }
  }
}

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
export function LocalEdgeKit_jsonErrorPosition(text: string, error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const reported = /position (\d+)/.exec(message);
  const engineOffset = reported === null ? null : Number(reported[1]);
  const offset = engineOffset !== null && engineOffset <= text.length ? engineOffset : LocalEdgeKit_jsonFirstErrorOffset(text);
  if (offset === null) {
    return "position not reported";
  }
  const before = text.slice(0, offset);
  return `line ${String(before.split("\n").length)}, column ${String(offset - before.lastIndexOf("\n"))}`;
}

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
export function LocalEdgeKit_parseExtraAppsJson(text: string, sourceName: string): LocalEdgeKit_ExtraApp[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`local-edge-kit-extra-apps-invalid: ${sourceName}: not valid JSON (${LocalEdgeKit_jsonErrorPosition(text, error)})`);
  }
  if (!LocalEdgeKit_isRecord(data) || !Array.isArray(data.apps)) {
    throw new Error(`local-edge-kit-extra-apps-invalid: ${sourceName}: expected an object with an "apps" array`);
  }
  const problems: string[] = LocalEdgeKit_unknownKeyProblems("top level", data, LOCAL_EDGE_KIT_TOP_KEYS);
  const apps: LocalEdgeKit_ExtraApp[] = [];
  data.apps.forEach((raw: unknown, index: number) => {
    const label = `apps[${String(index)}]`;
    if (!LocalEdgeKit_isRecord(raw)) {
      problems.push(`${label}: must be an object`);
      return;
    }
    const id = typeof raw.id === "string" ? raw.id : "";
    const appLabel = LOCAL_EDGE_KIT_ID_SHAPE.test(id) ? id : label;
    const before = problems.length;
    problems.push(...LocalEdgeKit_unknownKeyProblems(appLabel, raw, LOCAL_EDGE_KIT_APP_KEYS));
    if (!LOCAL_EDGE_KIT_ID_SHAPE.test(id)) {
      problems.push(`${label}: id must be 1 to 63 lowercase letters, digits and dashes, starting with a letter or digit`);
    }
    if (typeof raw.host !== "string" || raw.host.length === 0) {
      problems.push(`${appLabel}: host is required`);
    } else if (!LocalEdgeKit_isHostShape(raw.host)) {
      problems.push(`${appLabel}: host must be a host name of letters, digits, dots and dashes (at most 253 characters)`);
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
      problems.push(...LocalEdgeKit_unknownKeyProblems(locationLabel, location, LOCAL_EDGE_KIT_LOCATION_KEYS));
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

/** Lowercases an app id and drops trailing dots, so `ROUTER.` compares equal to `router`. */
function LocalEdgeKit_normalizeAppId(id: string): string {
  return id.toLowerCase().replace(/\.+$/, "");
}

/** Lowercases a host and drops trailing dots, so `A.Example.test.` and `a.example.test` compare equal. */
function LocalEdgeKit_normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

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
    for (const extra of source.load()) {
      if (LOCAL_EDGE_KIT_RESERVED_APP_IDS.includes(LocalEdgeKit_normalizeAppId(extra.id))) {
        throw new Error(
          `local-edge-kit-extra-apps-reserved-id: ${source.name}: app id ${LocalEdgeKit_messageWord(extra.id)} is reserved for the supervisor`,
        );
      }
      merged.push(LocalEdgeKit_extraAppToSupervisedApp(extra, source.name));
    }
  }
  const problems: string[] = [];
  const ids = new Map<string, LocalEdgeKit_SupervisedApp>();
  const hosts = new Map<string, LocalEdgeKit_SupervisedApp>();
  for (const app of merged) {
    const idKey = LocalEdgeKit_normalizeAppId(app.id);
    const other = ids.get(idKey);
    if (other !== undefined) {
      problems.push(`duplicate app id ${LocalEdgeKit_messageWord(app.id)}: ${other.source ?? "-"} and ${app.source ?? "-"}`);
    }
    ids.set(idKey, app);
    if (!app.enabled || options.hostnames === undefined) {
      continue;
    }
    let host: string;
    try {
      host = LocalEdgeKit_normalizeHost(LocalEdgeCore_exposureAppHost(options.hostnames, app));
    } catch {
      continue;
    }
    const holder = hosts.get(host);
    if (holder !== undefined) {
      problems.push(
        `duplicate hostname ${LocalEdgeKit_messageWord(host)}: ${LocalEdgeKit_messageWord(holder.id)} (${holder.source ?? "-"}) and ${LocalEdgeKit_messageWord(app.id)} (${app.source ?? "-"})`,
      );
    }
    hosts.set(host, app);
  }
  if (problems.length > 0) {
    throw new Error(`local-edge-kit-extra-apps-conflict: ${problems.join("; ")}`);
  }
  return merged;
}
