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
/** Options shared by the careful writers. */
export type LocalEdgeKit_SafeWriteOptions = {
    /** Folder the target must stay inside, after resolving symlinks. */
    root: string;
    /** Mode for a new file. An existing file keeps its mode. Default 0o600. */
    mode?: number | undefined;
    /** Mode for folders created on the way. Default 0o700. */
    dirMode?: number | undefined;
};
/**
 * Checks that `filePath` stays inside `root` (lexically and after `realpath` of its folder) and
 * is not a symlink, creating missing folders with `dirMode`. Returns the resolved target path.
 * Throws with a `local-edge-kit-safe-write-` code otherwise.
 */
export declare function LocalEdgeKit_prepareSafeTarget(filePath: string, options: LocalEdgeKit_SafeWriteOptions): string;
/**
 * Replaces a file's whole content: temp file in the same folder, fsync, rename over the target,
 * fsync the folder. Keeps the target's mode when it exists; new files get `mode` (0o600).
 */
export declare function LocalEdgeKit_writeFileAtomic(filePath: string, text: string, options: LocalEdgeKit_SafeWriteOptions): void;
/** Opens a log file for append after the same checks, never following a symlink. Returns the fd. */
export declare function LocalEdgeKit_openAppendSafe(filePath: string, options: LocalEdgeKit_SafeWriteOptions): number;
