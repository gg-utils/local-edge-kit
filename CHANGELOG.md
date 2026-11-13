# Changelog

## 0.6.2 - 2026-11-13

A fix for the health probe: the paths it requests stay on `127.0.0.1:<localPort>`.

- **Fix:** `status`, `health` and the `up` readiness wait built the probe URL by joining
  `http://127.0.0.1:<port>` and the configured path as text, and only `healthPath` had to start with
  `/`. A `readyPath` such as `@host.example/x` made the probe request another host. Now:
  - `healthPath` and a set `readyPath` are checked the same way by the config validation. The path
    must start with a single `/` (no `//` prefix, so no scheme and no protocol-relative host) and
    must not contain `@`, a backslash or a control character. A path without the leading `/` keeps
    the message `<id>: healthPath must start with /` (and `readyPath` has the same one); any other bad
    shape is the named error `local-edge-kit-probe-path-invalid`. Neither message repeats the value.
    An empty `readyPath` still counts as not set. Query text (`/health?full=1`) stays allowed.
  - The probe builds its URL with `new URL(path, "http://127.0.0.1:<port>")` and does not send the
    request unless the result has the scheme `http:`, the host exactly `127.0.0.1`, the app's port
    and no user-info. A refused path counts as failed (`status` null) and is shown without its text.
    This also covers an extra-apps file `healthPath`.
  - A project whose `readyPath` or `healthPath` has one of the refused shapes now fails the config
    check with the message above; fix the path (it was never a valid path on loopback).
- **Test:** `clientAddress`, `proxyProtocol`, `stream` and `nginx.errorLogLevel` set in the supervisor
  config's `exposure.hostnames` are shown to reach the core render that `up router` writes (the stream
  listener, the `proxy_protocol` HTTP listener and the `error_log` level are in the written config).
- **Test:** a zero-padded day in the start time (`Sun Nov 01 00:00:00 2026`) is accepted by `since` on
  purpose, and pinned; `ps` does not print it. Every other spacing stays refused.
- **Docs:** the JSDoc of that start-time parser says so, `LocalEdgeKit_walkAncestorsForRead` names the
  other filesystem errors it rethrows (such as `EACCES`), and the test helper for `since` has its
  `@param`.

## 0.6.1 - 2026-11-13

Fixes from the first consumer of 0.6.0, and the core pin moves to `v0.5.0`.

- **Core is pinned to `v0.5.0`.** The router config core renders now sets `X-Forwarded-For` and
  `X-Real-IP` to one value, adds `X-Real-Port`, clears client-sent `Forwarded`, `X-Client-IP` and
  `True-Client-IP`, and writes an access log with no addresses or query strings. The new
  `exposure.hostnames` settings `clientAddress` (`"connection"` by default, or `"proxy-protocol"`
  with `proxyProtocol` ports) and `nginx.errorLogLevel` pass through unchanged; see the core
  CHANGELOG for 0.5.0. A project that relied on the appended `X-Forwarded-For` or the old access
  log format sees a change when its router config is next rendered.

- **Fix:** `since` was `null` for a process that started on day 1-9 of a month: `ps -o lstart`
  pads a single-digit day with two spaces (`Fri Nov  6 08:01:02 2026`) and the strict parser wanted
  one. It now accepts the padded form and a one-space single-digit day, and stays strict otherwise
  (a two-digit day with two spaces, three spaces, a missing part and impossible dates are still `null`).
- **Fix:** `status` now probes the health path of an enabled `external` entry that has a
  `localPort` and `healthPath`, exactly like a `run` entry (read-only GET on `127.0.0.1` through the
  host's fetch, same timeout and healthy rule). The health column and `healthStatus` / `healthy` /
  `health` in `--json` show the result instead of `-` / `null`, so an observe-only entry can show
  "listening and healthy". `check` entries stay `not run`; a disabled entry is not probed; an
  unhealthy `external` row does not change the exit code of `status`.
- **Test:** the ancestor recheck while a file is open is now covered: with `refuseSymlinkedParents`,
  an ancestor folder swapped for a symlink between the walk and the open is refused with
  `local-edge-kit-safe-read-changed`.
- **Docs:** `@param`/`@returns`/`@throws` on the ancestor walk; the orphaned doc block above
  `processIdentity` on the supervisor host is merged into one comment; the README says that on
  macOS `os.tmpdir()` (under the `/var` symlink) is refused for external files, so give resolved
  paths (`/private/var/...`).

## 0.6.0 - 2026-11-13

First slice of a local runner: the catalog entry gets a kind, and `status` gets read-only fields. Nothing new is started: `up` and `down` behave as before for `run` entries and skip the new `check` entries. The core pin stays `v0.4.1`.

- **`kind` on `LocalEdgeKit_SupervisedApp`:** `"run" | "external" | "check"`, optional. The resolved
  kind is `kind ?? (external ? "external" : "run")`. `external` stays accepted (its JSDoc says it is
  replaced by `kind`). `kind` with a conflicting `external` is the named error
  `local-edge-kit-kind-conflict`, and an unknown `kind` is `local-edge-kit-kind-unknown`; both come
  from the new `LocalEdgeKit_resolveAppKind` and from `LocalEdgeKit_validateSupervisedApps`.
- **`check` entries.** They have a `cwd` and `command`/`args` and no port. `localPort` and
  `healthPath` are now optional in the type and required by validation for `run` and `external`
  only. `up` and `down` skip `check` entries in this release; `status` lists them as `check` with
  health `not run`, `health` lists them as `not run` without failing, and the exposure manifest
  leaves them out. Running them on demand comes in a later release. The extra-apps file source
  still produces `external` entries, now shown as `kind: "external"`.
- **Read-only pid and log files outside `cwd` for `external` entries.** They may name an absolute
  `pidFile` and `logFile` anywhere (a relative path is a config problem). They are only read,
  through `LocalEdgeKit_readFileSafe` via the new `readExternalText` member of
  `LocalEdgeKit_SupervisorHost`; never written, never signalled. No symlink is followed: the file,
  its folder and every folder above it must be real (a symlinked parent is refused with
  `local-edge-kit-safe-read-symlinked-parent`; on macOS give `/private/var/...`, not `/var/...`).
  `status` shows the pid observed in the pid file, with its process group, command line and start
  time. The pid is looked up in the process list without reading that process's environment (no
  `ps -E`, no `/proc/<pid>/environ`), so an observed pid has no launch id and its identity is uid,
  start time and command line. `logs <external app>` prints the last lines of the log (up to
  8 MiB; a larger log is refused, not truncated; `-f` is refused). `run` entries keep the
  inside-`cwd` rule and never use this path.
- **New status fields** for every kind, in `status --json` rows: `kind`, `processGroup`,
  `commandLine` (the observed pid's command line from the process list; control characters, bidi
  and other format characters removed, at most 200 characters), `cwd` as configured, `envFile` (path
  only) with `envFilePresent` (checked without opening the file), `since` (ISO time of the observed
  process start) and `restarts` (always `0`; the runner sets the counter later), plus `healthStatus`.
  The human table adds `KIND`, `PGID`, `SINCE` and `RESTARTS` after `EDGE-STATE`; the long fields
  (command line, cwd, env file) are only in `--json`. There is no `--wide` view.
- **Breaking for custom hosts and typed consumers.** `LocalEdgeKit_SupervisorHost` has a new
  required member `readExternalText(filePath, options?)`; `LocalEdgeKit_createSupervisorHost()`
  provides it. Its `processIdentity(pid, options?)` takes an optional `{ readLaunchId }` (a custom
  host that ignores it keeps reading the environment for external pids).
  `LocalEdgeKit_SupervisedAppInspection` gains `observed` and `restarts`, and
  `LocalEdgeKit_SupervisedAppState` gains `"check"`. On the exported type
  `LocalEdgeKit_SupervisedApp`, `localPort` and `healthPath` became optional (they were required);
  code that reads them as required stops compiling until it handles `undefined`.
- **`since` is parsed strictly.** The process list's start time (`Thu Nov 12 03:47:37 2026`, local
  time) is converted only when it has exactly that shape and is a real date; anything else gives
  `null`.
- **Library additions.** `LocalEdgeKit_readProcessIdentity(pid, { readLaunchId: false })` skips the
  process environment; `LocalEdgeKit_readFileSafe` takes `refuseSymlinkedParents`, which refuses a
  symlink anywhere in the path of its root (`local-edge-kit-safe-read-symlinked-parent`).
- **README:** new section "Catalog kinds and status fields". Examples point at `#v0.6.0`.

## 0.5.1 - 2026-11-12

Follow-ups to 0.5.0 from review: the apps-file read reports its errors accurately, the README says exactly what is checked, and the messages that repeated a command-line word, an env value or file text are now bounded. The core pin stays `v0.4.1`.

- **`LocalEdgeKit_readFileSafe` errors.** A folder or file that changed during a read now gives
  `local-edge-kit-safe-read-changed: folder <path> changed during the read` (one prefix, worded for
  a read; 0.5.0 doubled the prefix and said "during the write"). A symlink swapped in between the
  check and the open is the named `local-edge-kit-safe-read-symlink`, not a raw `ELOOP`. `@throws`
  now lists `not-a-folder` and the symlink swap.
- **README matches the code.** The extra-apps file is not "checked like a secret": it is refused
  when someone else owns it or group or others can write it, and the same for the folder that holds
  it. `0640`, `0644` and `0400` are read; folders between `root` and the holding folder and
  everything above `root` are trusted. `0600` in a `0700` folder stays the recommended setup.
- **Reserved id.** `LocalEdgeKit_mergeExtraApps` compares ids after lowercasing and dropping a
  trailing dot, so `ROUTER.` from a custom source is refused as reserved, and `play` and `PLAY.`
  are duplicates.
- **Parse-error position.** `not valid JSON (line L, column C)` is computed by the kit from the
  character offset the engine gives, or from the kit's own strict scan when it gives none, so
  multi-line files get a position on every Node version. It never includes file text.
  `LocalEdgeKit_jsonErrorPosition` and `LocalEdgeKit_jsonFirstErrorOffset` are exported from
  `@gg-utils/local-edge-kit/extra-apps` and the package root.
- **Ids and hosts from the file are shape-checked.** An id is 1 to 63 lowercase letters, digits and
  dashes (it was unbounded) and a host must look like a host name; a value that does not is refused
  without being repeated. Ids and hosts in duplicate messages go through the word helper.
- **More messages no longer repeat what they were given.** The requested method in
  `setup` and `ensure-running` is bounded, and those two messages name `LOCAL_EDGE_METHODS` (or the
  configured variable) and the rule, never its value. The primary-method errors name the variables
  only. A command-line word is repeated only when it is short and plain in: unknown action id and
  option (`ui-launcher`), unknown app and command (`supervisor`), invalid menu choice, unknown
  command (`cli`), the first startup word, the unknown UI action. Registry realm keys are bounded and
  the registry `realmSlug` field is not printed.
- **Wording matches core 0.4.1:** `<1 character>` in the singular and env names joined with `,`.
  Message texts changed accordingly. Core's helpers are not exported yet; when a core release
  exports them the kit can import them instead of its own copy.
- **Three more messages no longer print a value.**
  - The host-override log line (`runtime-launch`) names the two env variables and prints neither
    the prior value nor the new one.
  - The `dns-audit` detail lines still show what was expected and what was found, but both go
    through the word helper, so a long or odd value (an env value, a resolver file line or a DNS
    answer) shows as `<N characters>`. An empty value stays empty. A value that is not a short
    plain token, such as an IPv6 address, also shows as its length.
  - An invalid search pattern in the logs web server is logged as `Invalid search pattern (N
    characters)`. The pattern and the engine's error text, which repeats all of it, are not logged.
- **What is newly refused.** Nothing else about which files are read or refused changed. Three
  things that 0.5.0 accepted are refused now, all in the extra-apps file or a custom source: an
  app id longer than 63 characters in a file, a `host` in a file that is not a host name (letters,
  digits, dots and dashes, at most 253 characters), and the reserved id `ROUTER.` (a trailing dot,
  any case) from a custom source. The ownership and write-permission checks on the file and its
  folder are unchanged.

## 0.5.0 - 2026-11-12

Adds per-machine extra apps: route-only apps that are not part of the project config, read from pluggable sources. The file source is strict: a too-open apps file is refused.

- **Extra-apps sources.** The supervisor config takes `extraApps`, a list of sources, each with a
  `name` and a `load()`. The sources are merged with `apps` before every command by
  `LocalEdgeKit_resolveSupervisorConfig`. New subpath export: `@gg-utils/local-edge-kit/extra-apps`.
- **Contained file source.** `LocalEdgeKit_createExtraAppsFileSource({ filePath, root? })` reads a
  JSON file through the new `LocalEdgeKit_readFileSafe` (in `safe-write.ts`): the file must stay
  inside `root` after `realpath`, no folder below the root may be a symlink, a symlinked file is
  refused, and the file is opened with `O_NOFOLLOW` and rechecked while the descriptor is held. A
  missing file means no extra apps.
- **A too-open apps file is refused.** The file picks which loopback ports are published, so
  `LocalEdgeKit_readFileSafe` now checks the opened descriptor with `fstat`: a file that group or
  others can write (`0666`, `0620`, `0602`, ...) or that another user owns is refused with
  `local-edge-kit-safe-read-unsafe-mode` / `-unsafe-owner`, and so is a containing folder that
  group or others can write (a sticky bit does not excuse it) or that another user owns. The error
  names the path and the rule, not the content. Keep the file `0600` in a `0700` folder.
- **No file text in errors.** A JSON syntax error reports a fixed message with the line and
  column (or that no position is known), not the engine's excerpt of the file.
- **Unknown keys are refused** at the top level, in each app and in each location, so a typo such
  as `upstreamhost` is an error instead of being dropped. A key is named only when it is a short
  plain token; otherwise its number in the object is given.
- **Size cap and non-blocking open.** The file is opened with `O_NONBLOCK`, a non-regular file is
  refused after `fstat`, and files over 256 KiB (`LOCAL_EDGE_KIT_SAFE_READ_MAX_BYTES`, option
  `maxBytes`) are refused by size and again while reading.
- **Route-only apps.** Every extra app is `external`: the supervisor lists, probes and routes it and
  never starts, stops or signals it. Apps and locations carry `host`, `upstreamHost`, `buffering`
  and `readTimeout` through to the core router; a location without `upstreamPath` passes the
  request URI through. `LocalEdgeKit_SupervisedApp` gains `host`, `proxy` and `source`.
- **Duplicates are refused.** A duplicate id or hostname across sources is an error that names the
  host and both sources. Hosts compare after lowercasing and dropping a trailing dot, ids without
  regard to case, and the id `router` is reserved (`local-edge-kit-extra-apps-reserved-id`).
- **`status` shows a `SOURCE` column** (`project` for apps from the config), and `status --json`
  rows gain a `source` field.
- **Core is pinned to `v0.4.1`** (exact hosts, `upstreamHost`, buffering, `readTimeout`,
  per-location proxy from 0.4.0; error messages that never echo env values from 0.4.1).
- **Kit messages never echo env values.** Like core 0.4.1, kit messages built from an env value
  name the variable and the rule only: helper ports, unsupported or extra methods in the methods
  list, `LOCAL_EDGE_TLS_MODE` and the launch method warning. Unknown legacy env key names are
  listed at most five at a time and only when name-shaped, and a `--method` word is repeated only
  when it is short and plain. Message texts changed accordingly.
- **Clearer rollback note.** When `up` cannot identify the nginx it launched, the note now says the
  router this run launched may still be running and that the process could not be identified as its
  nginx, instead of calling an unidentified process "an nginx started by this run".

## 0.4.1

Follow-ups to the 0.4.0 router: every host call that throws after the config may have been replaced is rolled back, and `down` reports failures instead of throwing.

- **Router step results can carry `errors`.** `LocalEdgeKit_SupervisorStepResult` has a new
  optional `errors?: readonly string[]`, set by the router steps only and absent when empty. On a
  failed `up` it lists every failed rollback or cleanup step (stop, state removal, not-active
  record, config restore) and any host call that threw once the config might be replaced, in
  order; `routerUp` rolls those throws back instead of throwing. `down` now returns `ok: true`,
  action `stopped`, plus `errors` when nginx quit but only its state file could not be removed;
  a host call that throws while stopping gives `ok: false` with the error.
- **A started nginx whose identity could not be read is stopped, or reported.** If a host call
  throws after `nginx -c` returned 0 but before its pid is verified, `routerUp` identifies the
  started nginx once more. If that works it is stopped through the verified-quit path and recorded
  as not active; if not, nothing is signalled and both the message and `errors` say that an nginx
  started by this run may still be running, with its pid when known, and what to check (the pid
  file and the process list). The next `up` adopts a verified one.
- **`routerDown` documents its reads.** The reads before the signal (pid file, state, identity)
  can still throw, with nothing changed.

## 0.4.0

Adds the `hostnames` router backend config (a supervised nginx with SNI routing, activation confirmed by a marker hash, rollback on failure) and hardens the app supervisor.

Compatibility changes in the app supervisor:

- **Pid files without an identity show as `unverified`.** Pid files now record the process's
  owner uid, start time, command line and launch id. A pid file in the old one-line format (or
  written by another tool) names a process the supervisor cannot prove it started, so `status`
  shows it as `unverified` and `up`/`down` never adopt or signal it. Recovery: stop that process
  yourself, delete the pid file, then run `up` again.
- **Launch id.** Every started app gets `LOCAL_EDGE_KIT_LAUNCH_ID` in its environment, and it
  is recorded with the pid. It is checked where the process environment can be read (Linux);
  elsewhere the check falls back to uid, start time and command line.
- **Paths must be inside `cwd`.** Pid, lock and log files must resolve inside the app's `cwd`;
  a config that points them elsewhere is refused. Move those paths below `cwd`.
- **Lock file.** `up` and `down` hold `<pidFile>.lock` while they inspect, start or stop. The
  lock records the holder's pid, identity and a random token. A lock left by a process that is
  gone is taken over; a lock held by a live supervisor makes the second one fail. An empty or
  partial lock is never removed automatically: delete it by hand once no supervisor runs.
- **The router is reloaded and stopped by signal.** With the `hostnames` backend, `up` reloads a
  running nginx with SIGHUP and `down` stops it with SIGQUIT, sent straight to the verified
  master pid. A config counts as active only after the marker socket
  (`<folder of nginx.pidPath>/confirm.sock` by default) answers its hash; the rendered config now
  contains that marker server. An nginx is adopted only when its `-c` value is exactly this
  config file; one started with another file is `unverified` and never signalled.
