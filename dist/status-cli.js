/**
 * @fileoverview Generic status CLI runner for local-edge kit adapters.
 *
 * This file owns kit-layer orchestration for the status subcommand: load env stack and runtime
 * config, probe each configured nginx-docker compose service plus TCP listen state, assemble a
 * structured status report via core helpers, print JSON or text, and map health outcomes to exit
 * codes without embedding repository-specific labels or paths.
 *
 * @testing Jest unit: cd packages/local-edge-kit && npm run test
 *
 * @see packages/local-edge-kit/src/cli.ts - Kit CLI router that dispatches the status subcommand by calling LocalEdgeKit_runStatusCommand with parsed argv and loaded kit config.
 * @see packages/local-edge-core/src/status.ts - Core status helpers for argv parsing, report assembly, and text or JSON rendering consumed after kit-side probes finish.
 * @see packages/local-edge-kit/src/runtime-config.ts - Resolves supported nginx-docker methods, listen addresses, and compose coordinates used before per-method probes run.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { execFileSync } from "node:child_process";
import { LocalEdgeCore_buildStatusReport, LocalEdgeCore_isTcpPortListening, LocalEdgeCore_parseStatusCliArgs, LocalEdgeCore_probeDockerComposeServiceRunning, LocalEdgeCore_renderStatusJson, LocalEdgeCore_renderStatusText, LocalEdgeCore_resolveCommandPath, } from "@gg-utils/local-edge-core";
import { LocalEdgeKit_loadActiveEnvFileStack } from "./env.js";
import { LocalEdgeKit_resolveRuntimeConfig, } from "./runtime-config.js";
function LocalEdgeKit_statusCommandLabel(config) {
    return `${config.cli?.commandName ?? "local-edge"}:status`;
}
function LocalEdgeKit_nginxDockerContainerRunning(method) {
    const dockerCommand = LocalEdgeCore_resolveCommandPath("docker");
    if (dockerCommand === null) {
        return false;
    }
    return LocalEdgeCore_probeDockerComposeServiceRunning({
        projectName: method.composeProjectName,
        composePath: method.composePath,
        serviceName: method.serviceName,
        runDockerCommand(args) {
            return execFileSync(dockerCommand, [...args], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            });
        },
    });
}
async function LocalEdgeKit_resolveMethodStatus(method) {
    const running = LocalEdgeKit_nginxDockerContainerRunning(method) &&
        (await LocalEdgeCore_isTcpPortListening({
            host: method.listenHost,
            port: method.listenPort,
            timeoutMs: 1000,
        }));
    return {
        method: method.method,
        host: method.listenHost,
        port: method.listenPort,
        running,
    };
}
/** Runs the generic status command and returns a process-style exit code. */
export async function LocalEdgeKit_runStatusCommand(options) {
    const env = options.env ?? process.env;
    LocalEdgeKit_loadActiveEnvFileStack({
        config: options.config,
        env,
        logPrefix: options.config.cli?.logPrefix,
    });
    const runtimeConfig = LocalEdgeKit_resolveRuntimeConfig({
        config: options.config,
        env,
    });
    const commandLabel = LocalEdgeKit_statusCommandLabel(options.config);
    const parsed = LocalEdgeCore_parseStatusCliArgs({
        args: options.args,
        defaultMethod: runtimeConfig.primaryMethod,
        supportedMethods: runtimeConfig.supportedMethods,
        commandLabel,
    });
    const methodStatuses = await Promise.all(runtimeConfig.methods.map((method) => LocalEdgeKit_resolveMethodStatus(method)));
    const statusReport = LocalEdgeCore_buildStatusReport({
        selectedMethod: parsed.method,
        configuredMethods: runtimeConfig.configuredMethods,
        methodStatuses,
    });
    if (parsed.outputMode === "json") {
        console.log(LocalEdgeCore_renderStatusJson(statusReport));
    }
    else {
        console.log(LocalEdgeCore_renderStatusText(statusReport));
    }
    if (parsed.requireAll && !statusReport.allRunning) {
        return 1;
    }
    if (parsed.requireRunning && !statusReport.selected.running) {
        return 1;
    }
    return 0;
}
