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
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeSync, } from "node:fs";
import path from "node:path";
/** Largest file `LocalEdgeKit_readFileSafe` reads by default: 256 KiB. */
export const LOCAL_EDGE_KIT_SAFE_READ_MAX_BYTES = 256 * 1024;
function LocalEdgeKit_isWithin(parent, child) {
    const relative = path.relative(parent, child);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function LocalEdgeKit_lstatOrNull(filePath) {
    try {
        return lstatSync(filePath);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}
function LocalEdgeKit_safeWriteError(code, message) {
    return Object.assign(new Error(`local-edge-kit-safe-write-${code}: ${message}`), { code: `local-edge-kit-safe-write-${code}` });
}
/**
 * Walks from the real root down to `dir`, one segment at a time, refusing symlinks and
 * non-folders and creating missing folders one level at a time with `dirMode`.
 */
function LocalEdgeKit_walkDirs(realRoot, relativeDir, dirMode) {
    const rootStats = lstatSync(realRoot);
    if (!rootStats.isDirectory()) {
        throw LocalEdgeKit_safeWriteError("not-a-folder", `${realRoot} is not a folder`);
    }
    const chain = [{ dir: realRoot, dev: rootStats.dev, ino: rootStats.ino }];
    let current = realRoot;
    for (const segment of relativeDir.split(path.sep).filter((part) => part !== "" && part !== ".")) {
        current = path.join(current, segment);
        let stats = LocalEdgeKit_lstatOrNull(current);
        if (stats === null) {
            try {
                mkdirSync(current, { mode: dirMode });
            }
            catch (error) {
                if (error.code !== "EEXIST") {
                    throw error;
                }
            }
            stats = lstatSync(current);
        }
        if (stats.isSymbolicLink()) {
            throw LocalEdgeKit_safeWriteError("symlink", `refusing to write below symlinked folder ${current}`);
        }
        if (!stats.isDirectory()) {
            throw LocalEdgeKit_safeWriteError("not-a-folder", `${current} is not a folder`);
        }
        chain.push({ dir: current, dev: stats.dev, ino: stats.ino });
    }
    return chain;
}
/** Throws `fail("changed", ...)` when any folder of the chain was replaced, removed or turned into a symlink. */
function LocalEdgeKit_recheckChain(chain, fail = LocalEdgeKit_safeWriteError, during = "the write") {
    for (const entry of chain) {
        const stats = LocalEdgeKit_lstatOrNull(entry.dir);
        if (stats === null || stats.isSymbolicLink() || !stats.isDirectory() || stats.dev !== entry.dev || stats.ino !== entry.ino) {
            throw fail("changed", `folder ${entry.dir} changed during ${during}`);
        }
    }
}
/** Throws `fail("changed", ...)` unless `fd` is the regular file currently at `filePath`. */
function LocalEdgeKit_assertFdIsPath(fd, filePath, fail = LocalEdgeKit_safeWriteError) {
    const opened = fstatSync(fd);
    const atPath = LocalEdgeKit_lstatOrNull(filePath);
    if (atPath === null || !opened.isFile() || !atPath.isFile() || opened.dev !== atPath.dev || opened.ino !== atPath.ino) {
        throw fail("changed", `${filePath} changed while it was opened`);
    }
}
function LocalEdgeKit_checkTarget(filePath, options) {
    const root = path.resolve(options.root);
    const target = path.resolve(filePath);
    if (!LocalEdgeKit_isWithin(root, target) || target === root) {
        throw LocalEdgeKit_safeWriteError("outside-root", `${target} is not inside ${root}`);
    }
    const realRoot = realpathSync(root);
    const relativeDir = path.relative(root, path.dirname(target));
    const chain = LocalEdgeKit_walkDirs(realRoot, relativeDir, options.dirMode ?? 0o700);
    const resolved = path.join(chain[chain.length - 1]?.dir ?? realRoot, path.basename(target));
    const existing = LocalEdgeKit_lstatOrNull(resolved);
    if (existing?.isSymbolicLink()) {
        throw LocalEdgeKit_safeWriteError("symlink", `refusing to write through symlink ${resolved}`);
    }
    if (existing !== null && !existing.isFile()) {
        throw LocalEdgeKit_safeWriteError("not-a-file", `${resolved} is not a regular file`);
    }
    return { target: resolved, chain };
}
function LocalEdgeKit_safeReadError(code, message) {
    return Object.assign(new Error(`local-edge-kit-safe-read-${code}: ${message}`), { code: `local-edge-kit-safe-read-${code}` });
}
/**
 * Walks from the real root down to `relativeDir` without creating anything. Returns null when a
 * folder is missing; refuses symlinked folders and non-folders like the write walk does.
 */
function LocalEdgeKit_walkDirsForRead(realRoot, relativeDir) {
    const rootStats = lstatSync(realRoot);
    if (!rootStats.isDirectory()) {
        throw LocalEdgeKit_safeReadError("not-a-folder", `${realRoot} is not a folder`);
    }
    const chain = [{ dir: realRoot, dev: rootStats.dev, ino: rootStats.ino, mode: rootStats.mode, uid: rootStats.uid }];
    let current = realRoot;
    for (const segment of relativeDir.split(path.sep).filter((part) => part !== "" && part !== ".")) {
        current = path.join(current, segment);
        const stats = LocalEdgeKit_lstatOrNull(current);
        if (stats === null) {
            return null;
        }
        if (stats.isSymbolicLink()) {
            throw LocalEdgeKit_safeReadError("symlink", `refusing to read below symlinked folder ${current}`);
        }
        if (!stats.isDirectory()) {
            throw LocalEdgeKit_safeReadError("not-a-folder", `${current} is not a folder`);
        }
        chain.push({ dir: current, dev: stats.dev, ino: stats.ino, mode: stats.mode, uid: stats.uid });
    }
    return chain;
}
/**
 * Walks the path of `root` from the filesystem root, one folder at a time with `lstat`, and
 * returns every folder on the way (the last one is `root`). Returns null when a folder is
 * missing. A symlink on the way is `symlinked-parent`; a non-folder is `not-a-folder`.
 *
 * @param root - Absolute, resolved path of the root folder whose ancestors are walked.
 * @returns Every folder from the filesystem root down to `root` with its device, inode, mode and
 * owner, or null when a folder on the way does not exist.
 * @throws Error `local-edge-kit-safe-read-symlinked-parent` for a symlink on the way and
 * `local-edge-kit-safe-read-not-a-folder` for a non-folder.
 */
function LocalEdgeKit_walkAncestorsForRead(root) {
    const parsed = path.parse(root);
    const entries = [];
    let current = parsed.root;
    for (const segment of ["", ...root.slice(parsed.root.length).split(path.sep).filter((part) => part !== "")]) {
        current = segment === "" ? current : path.join(current, segment);
        const stats = LocalEdgeKit_lstatOrNull(current);
        if (stats === null) {
            return null;
        }
        if (stats.isSymbolicLink()) {
            throw LocalEdgeKit_safeReadError("symlinked-parent", `refusing to read below symlinked folder ${current}; give the real path`);
        }
        if (!stats.isDirectory()) {
            throw LocalEdgeKit_safeReadError("not-a-folder", `${current} is not a folder`);
        }
        entries.push({ dir: current, dev: stats.dev, ino: stats.ino, mode: stats.mode, uid: stats.uid });
    }
    return entries;
}
/** Owner every file and folder read here must have; undefined where the platform has no uids. */
function LocalEdgeKit_currentUid() {
    return typeof process.getuid === "function" ? process.getuid() : undefined;
}
/**
 * Refuses a folder that another user could change: owned by someone else, or writable by group
 * or others. A sticky bit does not excuse it; the folder holding the file must be private.
 */
function LocalEdgeKit_assertPrivateFolder(entry, uid) {
    if (process.platform === "win32") {
        return;
    }
    if (uid !== undefined && entry.uid !== undefined && entry.uid !== uid) {
        throw LocalEdgeKit_safeReadError("unsafe-owner", `folder ${entry.dir} is not owned by the current user; the folder must be owned by you`);
    }
    if (entry.mode !== undefined && (entry.mode & 0o022) !== 0) {
        throw LocalEdgeKit_safeReadError("unsafe-mode", `folder ${entry.dir} is writable by group or others (mode ${(entry.mode & 0o777).toString(8)}); use 0700`);
    }
}
/** Refuses a file owned by someone else or writable by group or others. */
function LocalEdgeKit_assertPrivateFile(stats, filePath, uid) {
    if (process.platform === "win32") {
        return;
    }
    if (uid !== undefined && stats.uid !== uid) {
        throw LocalEdgeKit_safeReadError("unsafe-owner", `${filePath} is not owned by the current user; the file must be owned by you`);
    }
    if ((stats.mode & 0o022) !== 0) {
        throw LocalEdgeKit_safeReadError("unsafe-mode", `${filePath} is writable by group or others (mode ${(stats.mode & 0o777).toString(8)}); use 0600`);
    }
}
/** Opens `filePath` for reading; a symlink swapped in after the checks is the named `symlink` error, not a raw `ELOOP`. */
function LocalEdgeKit_openForRead(filePath) {
    try {
        return openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    catch (error) {
        if (error.code === "ELOOP") {
            throw LocalEdgeKit_safeReadError("symlink", `refusing to read through symlink ${filePath}`);
        }
        throw error;
    }
}
/** Reads at most `maxBytes` from `fd`; throws when the file turns out to be longer. */
function LocalEdgeKit_readBounded(fd, filePath, maxBytes) {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    for (;;) {
        const count = readSync(fd, buffer, total, buffer.length - total, null);
        if (count === 0) {
            break;
        }
        total += count;
        if (total > maxBytes) {
            throw LocalEdgeKit_safeReadError("too-large", `${filePath} grew past the ${String(maxBytes)}-byte limit while reading`);
        }
    }
    return buffer.toString("utf8", 0, total);
}
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
export function LocalEdgeKit_readFileSafe(filePath, options) {
    const root = path.resolve(options.root);
    const target = path.resolve(filePath);
    if (!LocalEdgeKit_isWithin(root, target) || target === root) {
        throw LocalEdgeKit_safeReadError("outside-root", `${target} is not inside ${root}`);
    }
    const maxBytes = options.maxBytes ?? LOCAL_EDGE_KIT_SAFE_READ_MAX_BYTES;
    const uid = options.uid ?? LocalEdgeKit_currentUid();
    const folderUid = options.folderUid ?? uid;
    let realRoot;
    let ancestors = [];
    if (options.refuseSymlinkedParents === true) {
        const walked = LocalEdgeKit_walkAncestorsForRead(root);
        if (walked === null) {
            return null;
        }
        // The folders above the root are rechecked with the rest of the chain; the root itself is
        // the first entry of the walk below.
        ancestors = walked.slice(0, -1);
        realRoot = root;
    }
    else {
        try {
            realRoot = realpathSync(root);
        }
        catch (error) {
            if (error.code === "ENOENT") {
                return null;
            }
            throw error;
        }
    }
    const below = LocalEdgeKit_walkDirsForRead(realRoot, path.relative(root, path.dirname(target)));
    if (below === null) {
        return null;
    }
    const chain = [...ancestors, ...below];
    const resolved = path.join(chain[chain.length - 1]?.dir ?? realRoot, path.basename(target));
    const existing = LocalEdgeKit_lstatOrNull(resolved);
    if (existing === null) {
        return null;
    }
    if (existing.isSymbolicLink()) {
        throw LocalEdgeKit_safeReadError("symlink", `refusing to read through symlink ${resolved}`);
    }
    if (!existing.isFile()) {
        throw LocalEdgeKit_safeReadError("not-file", `${resolved} is not a regular file`);
    }
    options.hooks?.beforeOpen?.();
    // O_NONBLOCK: a FIFO swapped in after the checks above must not block the open.
    const fd = LocalEdgeKit_openForRead(resolved);
    try {
        const opened = fstatSync(fd);
        if (!opened.isFile()) {
            throw LocalEdgeKit_safeReadError("not-file", `${resolved} is not a regular file`);
        }
        LocalEdgeKit_recheckChain(chain, LocalEdgeKit_safeReadError, "the read");
        LocalEdgeKit_assertFdIsPath(fd, resolved, LocalEdgeKit_safeReadError);
        const folder = chain[chain.length - 1];
        if (folder !== undefined) {
            LocalEdgeKit_assertPrivateFolder(folder, folderUid);
        }
        LocalEdgeKit_assertPrivateFile(opened, resolved, uid);
        if (opened.size > maxBytes) {
            throw LocalEdgeKit_safeReadError("too-large", `${resolved} is ${String(opened.size)} bytes, over the ${String(maxBytes)}-byte limit`);
        }
        options.hooks?.afterStat?.();
        return LocalEdgeKit_readBounded(fd, resolved, maxBytes);
    }
    finally {
        closeSync(fd);
    }
}
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
export function LocalEdgeKit_ensureSafeDir(dirPath, options) {
    const root = path.resolve(options.root);
    const target = path.resolve(dirPath);
    if (!LocalEdgeKit_isWithin(root, target)) {
        throw LocalEdgeKit_safeWriteError("outside-root", `${target} is not inside ${root}`);
    }
    const chain = LocalEdgeKit_walkDirs(realpathSync(root), path.relative(root, target), options.dirMode ?? 0o700);
    return chain[chain.length - 1]?.dir ?? root;
}
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
export function LocalEdgeKit_writeFileAtomic(filePath, text, options) {
    const { target, chain } = LocalEdgeKit_checkTarget(filePath, options);
    const existing = LocalEdgeKit_lstatOrNull(target);
    const mode = existing ? existing.mode & 0o777 : (options.mode ?? 0o600);
    const dir = path.dirname(target);
    const temp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
    options.hooks?.afterWalk?.();
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    let renamed = false;
    try {
        try {
            options.hooks?.afterOpen?.();
            LocalEdgeKit_recheckChain(chain);
            LocalEdgeKit_assertFdIsPath(fd, temp);
            const bytes = Buffer.from(text, "utf8");
            let offset = 0;
            while (offset < bytes.length) {
                offset += writeSync(fd, bytes, offset, bytes.length - offset);
            }
            fchmodSync(fd, mode);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        options.hooks?.beforeRename?.();
        LocalEdgeKit_recheckChain(chain);
        if (LocalEdgeKit_lstatOrNull(target)?.isSymbolicLink()) {
            throw LocalEdgeKit_safeWriteError("symlink", `refusing to replace symlink ${target}`);
        }
        renameSync(temp, target);
        renamed = true;
    }
    finally {
        if (!renamed) {
            rmSync(temp, { force: true });
        }
    }
    try {
        const dirFd = openSync(dir, constants.O_RDONLY);
        try {
            fsyncSync(dirFd);
        }
        finally {
            closeSync(dirFd);
        }
    }
    catch {
        // Folder fsync is best effort; the file content is already synced and renamed.
    }
}
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
export function LocalEdgeKit_createFileExclusive(filePath, text, options) {
    const { target, chain } = LocalEdgeKit_checkTarget(filePath, options);
    const dir = path.dirname(target);
    const temp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
    options.hooks?.afterWalk?.();
    const mode = options.mode ?? 0o600;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
        try {
            options.hooks?.afterOpen?.();
            LocalEdgeKit_recheckChain(chain);
            LocalEdgeKit_assertFdIsPath(fd, temp);
            const bytes = Buffer.from(text, "utf8");
            let offset = 0;
            while (offset < bytes.length) {
                offset += writeSync(fd, bytes, offset, bytes.length - offset);
            }
            fchmodSync(fd, mode);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        options.hooks?.beforeRename?.();
        LocalEdgeKit_recheckChain(chain);
        try {
            linkSync(temp, target);
        }
        catch (error) {
            if (error.code === "EEXIST") {
                return false;
            }
            throw error;
        }
    }
    finally {
        rmSync(temp, { force: true });
    }
    return true;
}
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
export function LocalEdgeKit_openAppendSafe(filePath, options) {
    const { target, chain } = LocalEdgeKit_checkTarget(filePath, options);
    options.hooks?.afterWalk?.();
    const fd = openSync(target, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, options.mode ?? 0o600);
    try {
        options.hooks?.afterOpen?.();
        LocalEdgeKit_recheckChain(chain);
        LocalEdgeKit_assertFdIsPath(fd, target);
    }
    catch (error) {
        closeSync(fd);
        throw error;
    }
    return fd;
}
