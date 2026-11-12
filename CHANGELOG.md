# Changelog

## Unreleased

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
