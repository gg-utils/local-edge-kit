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
 * Reads (`LocalEdgeKit_readFileSafe`) use the same walk without creating anything, the same
 * `O_NOFOLLOW` open and the same chain and descriptor recheck before the bytes are read.
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
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync, } from "node:fs";
import path from "node:path";
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
/** Throws when any folder of the chain was replaced, removed or turned into a symlink. */
function LocalEdgeKit_recheckChain(chain) {
    for (const entry of chain) {
        const stats = LocalEdgeKit_lstatOrNull(entry.dir);
        if (stats === null || stats.isSymbolicLink() || !stats.isDirectory() || stats.dev !== entry.dev || stats.ino !== entry.ino) {
            throw LocalEdgeKit_safeWriteError("changed", `folder ${entry.dir} changed during the write`);
        }
    }
}
/** Throws unless `fd` is the regular file currently at `filePath`. */
function LocalEdgeKit_assertFdIsPath(fd, filePath) {
    const opened = fstatSync(fd);
    const atPath = LocalEdgeKit_lstatOrNull(filePath);
    if (atPath === null || !opened.isFile() || !atPath.isFile() || opened.dev !== atPath.dev || opened.ino !== atPath.ino) {
        throw LocalEdgeKit_safeWriteError("changed", `${filePath} changed while it was opened`);
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
    const chain = [{ dir: realRoot, dev: rootStats.dev, ino: rootStats.ino }];
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
        chain.push({ dir: current, dev: stats.dev, ino: stats.ino });
    }
    return chain;
}
/**
 * Reads a UTF-8 file inside `root` with the writers' containment rules: lexical containment, a
 * segment walk that refuses symlinked folders, no symlinked target, an `O_NOFOLLOW` open, and a
 * recheck of the folder chain and the descriptor's identity before reading.
 *
 * @param filePath - File to read; must be inside `options.root`.
 * @param options - Root the file must stay inside. The root itself may be a symlink.
 * @returns The file's text, or `null` when the file or a folder on the way does not exist.
 * @throws Error with a `local-edge-kit-safe-read-` code when the file is outside the root, is a
 * symlink or not a regular file, a folder on the way is a symlink, or a folder or the file
 * changed while it was opened.
 * @example
 * ```typescript
 * const text = LocalEdgeKit_readFileSafe("/home/me/.config/edge/apps.json", { root: "/home/me/.config/edge" });
 * ```
 */
export function LocalEdgeKit_readFileSafe(filePath, options) {
    const root = path.resolve(options.root);
    const target = path.resolve(filePath);
    if (!LocalEdgeKit_isWithin(root, target) || target === root) {
        throw LocalEdgeKit_safeReadError("outside-root", `${target} is not inside ${root}`);
    }
    let realRoot;
    try {
        realRoot = realpathSync(root);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
    const chain = LocalEdgeKit_walkDirsForRead(realRoot, path.relative(root, path.dirname(target)));
    if (chain === null) {
        return null;
    }
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
    const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        try {
            LocalEdgeKit_recheckChain(chain);
            LocalEdgeKit_assertFdIsPath(fd, resolved);
        }
        catch (error) {
            throw LocalEdgeKit_safeReadError("changed", error.message);
        }
        return readFileSync(fd, "utf8");
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
