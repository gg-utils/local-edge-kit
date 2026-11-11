/**
 * @fileoverview File/stdio adapter for product-neutral local-edge doctor-core helpers.
 *
 * The core package owns JSON parsing, summary formatting, TLS wildcard extraction, and workspace
 * registration matching. This kit layer owns command dispatch over file paths plus explicit stdout
 * and stderr writers so repository scripts can stay as tiny compatibility entrypoints.
 *
 * @example
 * ```typescript
 * const exitCode = LocalEdgeKit_runDoctorCoreCli({ argv: ["print-registry-line", "--path", "registry.json"] });
 * ```
 *
 * @testing Package: `npm run local-edge-kit:test`.
 * @see packages/local-edge-core/src/doctor.ts - Product-neutral doctor summary helpers.
 * @documentation reviewed=2026-05-20 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
export type LocalEdgeKit_DoctorCoreCliOptions = {
    argv: readonly string[];
    pathExists?: (filePath: string) => boolean;
    readText?: (filePath: string) => string;
    stderr?: (line: string) => void;
    stdout?: (line: string) => void;
};
/** Executes the doctor-core compatibility CLI and returns the intended process exit code. */
export declare function LocalEdgeKit_runDoctorCoreCli(options: LocalEdgeKit_DoctorCoreCliOptions): number;
