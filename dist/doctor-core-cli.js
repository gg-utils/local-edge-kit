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
import fs from "node:fs";
import { LOCAL_EDGE_CORE_DOCTOR_LOG_PREFIX, LocalEdgeCore_doctorCollectActiveRealmTlsWildcards, LocalEdgeCore_doctorFormatRegistrySummaryLine, LocalEdgeCore_doctorFormatRenderArtifactLine, LocalEdgeCore_doctorFormatMissingWorkspaceRegistryLine, LocalEdgeCore_doctorParseArgv, LocalEdgeCore_doctorParseJsonText, LocalEdgeCore_doctorRenderUsage, LocalEdgeCore_doctorSummarizeRegistryPayload, LocalEdgeCore_doctorSummarizeRenderArtifactPayload, LocalEdgeCore_doctorVerifyWorkspaceRegistrationPayload, } from "@gg-utils/local-edge-core";
function LocalEdgeKit_doctorCoreCliMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Executes the doctor-core compatibility CLI and returns the intended process exit code. */
export function LocalEdgeKit_runDoctorCoreCli(options) {
    const readText = options.readText ??
        ((filePath) => fs.readFileSync(filePath, "utf8"));
    const pathExists = options.pathExists ??
        ((filePath) => fs.existsSync(filePath));
    const stderr = options.stderr ?? ((line) => console.error(line));
    const stdout = options.stdout ?? ((line) => console.log(line));
    let parsed;
    try {
        parsed = LocalEdgeCore_doctorParseArgv(options.argv);
    }
    catch (error) {
        stderr(`${LOCAL_EDGE_CORE_DOCTOR_LOG_PREFIX} ${LocalEdgeKit_doctorCoreCliMessage(error)}`);
        return 2;
    }
    if (parsed.command === "help") {
        stdout(LocalEdgeCore_doctorRenderUsage());
        return 0;
    }
    try {
        if (parsed.command === "print-registry-line") {
            const raw = readText(parsed.registryPath);
            const payload = LocalEdgeCore_doctorParseJsonText(raw);
            const summary = LocalEdgeCore_doctorSummarizeRegistryPayload(payload);
            stdout(LocalEdgeCore_doctorFormatRegistrySummaryLine(summary));
            return 0;
        }
        if (parsed.command === "verify-root-workspace") {
            if (!pathExists(parsed.registryPath)) {
                stderr(LocalEdgeCore_doctorFormatMissingWorkspaceRegistryLine(parsed.registryPath));
                return 1;
            }
            const raw = readText(parsed.registryPath);
            const payload = LocalEdgeCore_doctorParseJsonText(raw);
            const result = LocalEdgeCore_doctorVerifyWorkspaceRegistrationPayload({
                registryPath: parsed.registryPath,
                workspacePath: parsed.workspacePath,
                expectedRealmSlug: parsed.realmSlug,
                payload,
            });
            if (!result.ok) {
                stderr(result.stderrLine);
                return result.exitCode;
            }
            stdout(result.line);
            return 0;
        }
        if (parsed.command === "print-render-line") {
            const raw = readText(parsed.artifactPath);
            const payload = LocalEdgeCore_doctorParseJsonText(raw);
            const summary = LocalEdgeCore_doctorSummarizeRenderArtifactPayload(payload);
            stdout(LocalEdgeCore_doctorFormatRenderArtifactLine(summary));
            return 0;
        }
        if (parsed.command === "print-tls-wildcards") {
            const raw = readText(parsed.registryPath);
            const payload = LocalEdgeCore_doctorParseJsonText(raw);
            const wildcards = LocalEdgeCore_doctorCollectActiveRealmTlsWildcards(payload);
            for (const line of wildcards) {
                stdout(line);
            }
            return 0;
        }
    }
    catch (error) {
        stderr(`${LOCAL_EDGE_CORE_DOCTOR_LOG_PREFIX} ${LocalEdgeKit_doctorCoreCliMessage(error)}`);
        return 1;
    }
    stderr(`${LOCAL_EDGE_CORE_DOCTOR_LOG_PREFIX} Unsupported doctor-core command.`);
    return 2;
}
