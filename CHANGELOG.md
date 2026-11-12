# Changelog

## Unreleased

Adds per-machine extra apps: route-only apps that are not part of the project config, read from pluggable sources.

- **Extra-apps sources.** The supervisor config takes `extraApps`, a list of sources, each with a
  `name` and a `load()`. The sources are merged with `apps` before every command by
  `LocalEdgeKit_resolveSupervisorConfig`. New subpath export: `@gg-utils/local-edge-kit/extra-apps`.
- **Contained file source.** `LocalEdgeKit_createExtraAppsFileSource({ filePath, root? })` reads a
  JSON file through the new `LocalEdgeKit_readFileSafe` (in `safe-write.ts`): the file must stay
  inside `root` after `realpath`, no folder below the root may be a symlink, a symlinked file is
  refused, and the file is opened with `O_NOFOLLOW` and rechecked while the descriptor is held. A
  missing file means no extra apps.
- **Route-only apps.** Every extra app is `external`: the supervisor lists, probes and routes it and
  never starts, stops or signals it. Apps and locations carry `host`, `upstreamHost`, `buffering`
  and `readTimeout` through to the core router; a location without `upstreamPath` passes the
  request URI through. `LocalEdgeKit_SupervisedApp` gains `host`, `proxy` and `source`.
- **Duplicates are refused.** A duplicate id or hostname across sources is an error that names the
  host and both sources.
- **`status` shows a `SOURCE` column** (`project` for apps from the config), and `status --json`
  rows gain a `source` field.
- **Core is pinned to `v0.4.0`** (exact hosts, `upstreamHost`, buffering, `readTimeout`,
  per-location proxy).

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
