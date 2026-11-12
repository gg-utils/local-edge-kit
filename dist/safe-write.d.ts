/**
 * @fileoverview Careful file writes for supervisor state: pid files, lock files, rendered
 * configs and logs. Every write stays inside a caller-given root.
 *
 * Node has no `openat`/`mkdirat`/`renameat`, so a write cannot be bound to a directory
 * descriptor. Instead each folder between the root and the target is walked one segment at a
 * time: it is `lstat`ed (never followed), created with `dirMode` only when missing and only below
 * a folder already checked, and its device and inode are recorded. Nothing is created until the
 * lexical containment check passed, and nothing is created below a symlink. After the target
 * (or its temp file) is opened with `O_NOFOLLOW`, the whole chain is checked again while the
 * descriptor is held: every folder must still be a real folder with the recorded device and
 * inode, and the descriptor must be the file at the path. Whole-file writes check the chain a
 * third time immediately before the rename.
 *
 * Trust boundary: the root itself and its ancestors are trusted (they may be symlinks, such as
 * `/tmp` on macOS). Folders below the root must not be writable by another user. Within that
 * boundary every swap the checks can observe is refused; what remains is the window between the
 * last check and the `rename` system call, which only a process running as the same user can
 * use, and which Node cannot close without `renameat`.
 *
 * New files get `mode` (0o600) and new folders `dirMode` (0o700), independent of the umask
 * (the umask can only remove bits). An existing file keeps its mode.
 * Flow: lexical check -> segment walk (lstat, mkdir one level, record dev/ino) -> open
 * O_NOFOLLOW -> recheck chain + fd identity -> write + fsync -> recheck chain -> rename -> dir fsync.
 *
 * @example
 * ```typescript
 * LocalEdgeKit_writeFileAtomic("/w/app/.local/app.pid", "123\n", { root: "/w/app" });
 * const fd = LocalEdgeKit_openAppendSafe("/w/app/.local/app.log", { root: "/w/app" });
 * ```
 *
 * @testing Node test runner (tsx): npm run test -- src/safe-write.unit.test.ts
 *
 * @see src/supervisor.ts - Uses these writers for pid files, locks and logs.
 * @documentation reviewed=2026-11-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
/** Test seams called at the points where a swap could happen. Leave out in real use. */
export type LocalEdgeKit_SafeWriteHooks = {
    /** After the folder walk, before the target or temp file is opened. */
    afterWalk?: (() => void) | undefined;
    /** After the target or temp file was opened, before the chain is checked again. */
    afterOpen?: (() => void) | undefined;
    /** After the temp file was written and synced, before the last check and the rename. */
    beforeRename?: (() => void) | undefined;
};
/** Options shared by the careful writers. */
export type LocalEdgeKit_SafeWriteOptions = {
    /** Folder the target must stay inside. The root and its ancestors are trusted. */
    root: string;
    /** Mode for a new file. An existing file keeps its mode. Default 0o600. */
    mode?: number | undefined;
    /** Mode for folders created on the way. Default 0o700. */
    dirMode?: number | undefined;
    /** Test seams. */
    hooks?: LocalEdgeKit_SafeWriteHooks | undefined;
};
/**
 * Creates a folder (and missing folders above it, up to `root`) without following symlinks.
 *
 * @param dirPath - Folder to create; must be inside `options.root`.
 * @param options - Root and `dirMode` (default 0o700).
 * @returns The folder's path below the real root.
 * @throws Error with a `local-edge-kit-safe-write-` code when the folder is outside the root, a
 * folder on the way is a symlink or not a folder. Nothing is created below a refused folder.
 * @example
 * ```typescript
 * LocalEdgeKit_ensureSafeDir("/w/state/nginx/temp", { root: "/w/state" });
 * ```
 */
export declare function LocalEdgeKit_ensureSafeDir(dirPath: string, options: LocalEdgeKit_SafeWriteOptions): string;
/**
 * Replaces a file's whole content inside `root`: temp file beside the target (exclusive,
 * `O_NOFOLLOW`), fsync, rename over the target, fsync the folder.
 *
 * @param filePath - Target file; must be inside `options.root` and not a symlink.
 * @param text - UTF-8 content.
 * @param options - Root, new-file `mode` (0o600), folder `dirMode` (0o700) and test hooks.
 * @throws Error with a `local-edge-kit-safe-write-` code when the target is outside the root,
 * is a symlink or not a regular file, a folder on the way is a symlink, or a folder changed
 * during the write. The temp file is removed and the target is untouched on every failure.
 * @example
 * ```typescript
 * LocalEdgeKit_writeFileAtomic("/w/app/.local/app.pid", "123\n", { root: "/w/app" });
 * ```
 */
export declare function LocalEdgeKit_writeFileAtomic(filePath: string, text: string, options: LocalEdgeKit_SafeWriteOptions): void;
/**
 * Creates a new file inside `root` only when none exists, as a lock or marker. The complete
 * content is first written and synced to a unique temp file beside the target, which is then
 * `link()`ed to the target; `link` fails with EEXIST when the target exists. So the file is
 * never visible empty or half-written, and of two concurrent creations exactly one succeeds.
 *
 * @param filePath - File to create; must be inside `options.root`.
 * @param text - Content of the new file.
 * @param options - Root, `mode` (0o600), `dirMode` (0o700) and test hooks.
 * @returns True when this call created the file, false when it already existed.
 * @throws Error with a `local-edge-kit-safe-write-` code on the same refusals as
 * `LocalEdgeKit_writeFileAtomic`. The temp file is always removed; the target is created only
 * by the final `link`.
 * @example
 * ```typescript
 * if (!LocalEdgeKit_createFileExclusive("/w/app/.local/app.pid.lock", "123\n", { root: "/w/app" })) {
 *   // another supervisor holds the lock
 * }
 * ```
 */
export declare function LocalEdgeKit_createFileExclusive(filePath: string, text: string, options: LocalEdgeKit_SafeWriteOptions): boolean;
/**
 * Opens a log file for append inside `root`, never following a symlink. A new file gets `mode`
 * (0o600); an existing one keeps its mode.
 *
 * @param filePath - Log file; must be inside `options.root`.
 * @param options - Root, `mode`, `dirMode` and test hooks.
 * @returns An open descriptor; the caller closes it.
 * @throws Error with a `local-edge-kit-safe-write-` code when the file is outside the root, is a
 * symlink or not a regular file, or a folder on the way is a symlink or changed after the open.
 * @example
 * ```typescript
 * const fd = LocalEdgeKit_openAppendSafe("/w/app/.local/app.log", { root: "/w/app" });
 * ```
 */
export declare function LocalEdgeKit_openAppendSafe(filePath: string, options: LocalEdgeKit_SafeWriteOptions): number;
