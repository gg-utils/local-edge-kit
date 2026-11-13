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
 * Reads (`LocalEdgeKit_readFileSafe`) use the same walk without creating anything, a
 * non-blocking `O_NOFOLLOW` open and the same chain and descriptor recheck before the bytes are
 * read, then refuse a file or folder that group or others can write or that another user owns,
 * and a file over the size limit. With `refuseSymlinkedParents` the path of the root and every
 * folder above it are walked too, and a symlink anywhere in it is refused.
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
/** Largest file `LocalEdgeKit_readFileSafe` reads by default: 256 KiB. */
export declare const LOCAL_EDGE_KIT_SAFE_READ_MAX_BYTES: number;
/** Options for `LocalEdgeKit_readFileSafe`. */
export type LocalEdgeKit_SafeReadOptions = {
    /** Folder the file must stay inside. The root itself may be a symlink unless `refuseSymlinkedParents` is set. */
    root: string;
    /**
     * Refuse a symlink anywhere in the path of `root`, from the filesystem root down (the file's
     * parent folder and every folder above it). Default false: the root and its ancestors are
     * trusted and `root` is resolved with `realpath`. The supervisor sets it for external files.
     */
    refuseSymlinkedParents?: boolean | undefined;
    /** Largest file accepted, checked by `fstat` and again while reading. Default 256 KiB. */
    maxBytes?: number | undefined;
    /** Owner the file must have. Default: the current user. Test seam. */
    uid?: number | undefined;
    /** Owner the containing folder must have. Default: `uid`. Test seam. */
    folderUid?: number | undefined;
    /** Test seams. Leave out in real use. */
    hooks?: {
        /** After the path checks, before the file is opened. */
        beforeOpen?: (() => void) | undefined;
        /** After the descriptor was checked with `fstat`, before the bytes are read. */
        afterStat?: (() => void) | undefined;
    } | undefined;
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
 * Reads a UTF-8 file inside `root` with the writers' containment rules: lexical containment, a
 * segment walk that refuses symlinked folders, no symlinked target, a non-blocking `O_NOFOLLOW`
 * open, a recheck of the folder chain and the descriptor's identity, and then `fstat` of the
 * descriptor: it must be a regular file owned by the current user and not writable by group or
 * others, in a folder that is owned by the current user and not writable by group or others (a
 * sticky bit does not excuse a writable folder), and no larger than `maxBytes`. The bytes are
 * read with the same bound. Error messages name the path and the rule, never file content.
 *
 * @param filePath - File to read; must be inside `options.root`.
 * @param options - Root the file must stay inside, plus optional `maxBytes` (default 256 KiB) and
 * `refuseSymlinkedParents`.
 * @returns The file's text, or `null` when the file or a folder on the way does not exist.
 * @throws Error with a `local-edge-kit-safe-read-` code when the file is outside the root
 * (`outside-root`), is a symlink, also one swapped in just before the open (`symlink`), or not a
 * regular file (`not-file`), the root or a folder on the way is not a folder (`not-a-folder`) or
 * is a symlink (`symlink`; with `refuseSymlinkedParents` a symlink in the path of the root or
 * above it is `symlinked-parent`), a folder or the file changed while it was opened (`changed`), the
 * file or its folder is writable by group or others (`unsafe-mode`) or owned by someone else
 * (`unsafe-owner`), or the file is over the size limit (`too-large`). Any other operating-system
 * error (for example `EACCES`) passes through as it is; it names the path, never the content.
 * @example
 * ```typescript
 * // The folder should be 0700 and the file 0600.
 * const text = LocalEdgeKit_readFileSafe("/home/me/.config/edge/apps.json", { root: "/home/me/.config/edge" });
 * ```
 */
export declare function LocalEdgeKit_readFileSafe(filePath: string, options: LocalEdgeKit_SafeReadOptions): string | null;
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
