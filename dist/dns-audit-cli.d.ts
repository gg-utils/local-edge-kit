/**
 * @fileoverview Shared split-DNS audit orchestration for local-edge kit adapters: resolves env and
 * config, validates macOS resolver files and dnsmasq listeners, optionally runs direct dig probes,
 * expands active realm hostnames from the generated registry, writes the audit artifact, and maps
 * failures to process-style exit codes.
 *
 * The runner consumes `LocalEdgeKit_Config` plus injectable I/O so kit CLIs and unit tests reuse the
 * same workflow without duplicating resolver parsing, registry reads, or probe wiring.
 * Flow: load env stack -> resolve runtime -> parse argv -> resolver checks -> listener -> realm host checks -> artifact -> summary/exit.
 *
 * @example
 * ```typescript
 * import { LocalEdgeKit_runDnsAuditCommand } from "@gg-utils/local-edge-kit/dns-audit-cli";
 * const localEdgeConfig = defineLocalEdgeConfig({ callerOwnedSettings });
 *
 * process.exitCode = await LocalEdgeKit_runDnsAuditCommand({
 *   args: process.argv.slice(2),
 *   config: localEdgeConfig,
 * });
 * ```
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/dns-audit-cli.unit.test.ts
 * @testing CLI: npm run test --prefix packages/local-edge-kit
 *
 * @see packages/local-edge-kit/src/cli.ts - Kit CLI dispatcher that routes the dns-audit subcommand into this runner with argv, config, and env wiring.
 * @see packages/local-edge-core/src/dns.ts - Core DNS audit argv parser, pass/fail state, artifact renderer, and macOS resolver helpers consumed by this orchestration layer.
 * @see scripts/local-edge/dns-audit.ts - Root npm script entrypoint that binds consumer local-edge.config.ts and forwards process.argv to the same exported command API.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview contract defining the audited tag order and documentation metadata shape used by this header.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import type { LocalEdgeKit_Config } from "./config.js";
/** Minimal output sink used by tests and CLI adapters. */
export type LocalEdgeKit_DnsAuditOutput = {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
};
/** Host target expanded from one active realm plus one audited surface. */
export type LocalEdgeKit_DnsAuditRealmSurfaceTarget = {
    readonly realm: string;
    readonly method: string;
    readonly surface: string;
    readonly expectedHost: string;
};
/** Injectable host operations for DNS audit tests and production execution. */
export type LocalEdgeKit_DnsAuditOperations = {
    readTextFile(filePath: string): Promise<string>;
    isDnsListenerAvailable(options: {
        readonly listenAddress: string;
        readonly port: string;
    }): Promise<boolean>;
    isDirectProbeUtilityAvailable(utilityName: string): Promise<boolean>;
    resolveSystemHost(hostname: string): Promise<string | null>;
    resolveDirectHost(options: {
        readonly hostname: string;
        readonly listenAddress: string;
        readonly port: string;
        readonly utilityName: string;
    }): Promise<string | null>;
};
/** Options for invoking the generic DNS audit command. */
export type LocalEdgeKit_RunDnsAuditCommandOptions = {
    readonly args: readonly string[];
    readonly config: LocalEdgeKit_Config;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly operations?: LocalEdgeKit_DnsAuditOperations;
    readonly output?: LocalEdgeKit_DnsAuditOutput;
};
/** Runs the generic DNS audit command and returns a process-style exit code. */
export declare function LocalEdgeKit_runDnsAuditCommand(options: LocalEdgeKit_RunDnsAuditCommandOptions): Promise<number>;
