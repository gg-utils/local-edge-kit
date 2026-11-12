/**
 * @fileoverview Careful file writes for supervisor state: pid files, rendered configs and logs.
 *
 * Every write first checks that the target sits inside a given root, by `realpath` of the root
 * and of the target's folder, so a symlinked folder cannot point a write elsewhere. A target that
 * is itself a symlink is refused. Whole-file writes go to a temp file in the same folder, are
 * synced, then renamed over the target, keeping the target's mode when it exists. Log files are
 * opened for append with `O_NOFOLLOW`.
 * Flow: target + root -> containment and symlink checks -> temp write + fsync -> rename -> dir fsync.
 *
 * @testing Node test runner (tsx): npm run test -- src/safe-write.unit.test.ts
 *
 * @see src/supervisor.ts - Uses these writers for pid files and logs.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import path from "node:path";

/** Options shared by the careful writers. */
export type LocalEdgeKit_SafeWriteOptions = {
  /** Folder the target must stay inside, after resolving symlinks. */
  root: string;
  /** Mode for a new file. An existing file keeps its mode. Default 0o600. */
  mode?: number | undefined;
  /** Mode for folders created on the way. Default 0o700. */
  dirMode?: number | undefined;
};

/** True when `child` equals `parent` or sits under it. Both must be absolute and normalized. */
function LocalEdgeKit_isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Returns the target's lstat, or null when it does not exist. */
function LocalEdgeKit_lstatOrNull(filePath: string): Stats | null {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Checks that `filePath` stays inside `root` (lexically and after `realpath` of its folder) and
 * is not a symlink, creating missing folders with `dirMode`. Returns the resolved target path.
 * Throws with a `local-edge-kit-safe-write-` code otherwise.
 */
export function LocalEdgeKit_prepareSafeTarget(filePath: string, options: LocalEdgeKit_SafeWriteOptions): string {
  const root = path.resolve(options.root);
  const target = path.resolve(filePath);
  if (!LocalEdgeKit_isWithin(root, target) || target === root) {
    throw new Error(`local-edge-kit-safe-write-outside-root: ${target} is not inside ${root}`);
  }
  mkdirSync(root, { recursive: true, mode: options.dirMode ?? 0o700 });
  const realRoot = realpathSync(root);
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true, mode: options.dirMode ?? 0o700 });
  const realDir = realpathSync(dir);
  if (!LocalEdgeKit_isWithin(realRoot, realDir)) {
    throw new Error(`local-edge-kit-safe-write-outside-root: ${dir} resolves to ${realDir}, outside ${realRoot}`);
  }
  const resolved = path.join(realDir, path.basename(target));
  if (LocalEdgeKit_lstatOrNull(resolved)?.isSymbolicLink()) {
    throw new Error(`local-edge-kit-safe-write-symlink: refusing to write through symlink ${resolved}`);
  }
  return resolved;
}

/**
 * Replaces a file's whole content: temp file in the same folder, fsync, rename over the target,
 * fsync the folder. Keeps the target's mode when it exists; new files get `mode` (0o600).
 */
export function LocalEdgeKit_writeFileAtomic(filePath: string, text: string, options: LocalEdgeKit_SafeWriteOptions): void {
  const target = LocalEdgeKit_prepareSafeTarget(filePath, options);
  const existing = LocalEdgeKit_lstatOrNull(target);
  const mode = existing ? existing.mode & 0o777 : (options.mode ?? 0o600);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  const dirFd = openSync(path.dirname(target), constants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Opens a log file for append after the same checks, never following a symlink. Returns the fd. */
export function LocalEdgeKit_openAppendSafe(filePath: string, options: LocalEdgeKit_SafeWriteOptions): number {
  const target = LocalEdgeKit_prepareSafeTarget(filePath, options);
  return openSync(
    target,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    options.mode ?? 0o600,
  );
}
