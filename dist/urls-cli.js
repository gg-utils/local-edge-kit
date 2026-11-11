/**
 * @fileoverview Owns the shared `urls` subcommand runner that prints router URL-matrix rows for local-edge kit adapters.
 *
 * This module loads the active env stack, resolves runtime routing config, parses `--method` selectors from argv, and emits formatted matrix lines for the primary method, every configured method, or one explicit method.
 * Flow: env stack -> runtime config -> argv parse -> URL-matrix line builder -> stdout.
 *
 * @testing Jest unit: cd packages/local-edge-kit && npm run test -- src/cli.unit.test.ts
 * @testing CLI: npm run local:edge:urls
 *
 * @see packages/local-edge-kit/src/cli.ts - Kit CLI that dispatches the `urls` subcommand into LocalEdgeKit_runUrlsCommand with the active argv slice.
 * @see packages/local-edge-kit/src/url-matrix.ts - Matrix line builder consumed after runtime resolution and method selection to format operator-facing URL rows.
 * @see packages/local-edge-core/src/url-matrix.ts - Core URL-matrix CLI argv parser and shared primitives this runner calls after resolving supported methods from kit runtime config.
 * @see scripts/local-edge/urls.ts - Root compatibility script that forwards argv through the repo local-edge.config adapter into LocalEdgeKit_runUrlsCommand for stable npm script entrypoints.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { LocalEdgeCore_parseUrlMatrixCliArgs } from "@gg-utils/local-edge-core";
import { LocalEdgeKit_loadActiveEnvFileStack } from "./env.js";
import { LocalEdgeKit_resolveRuntimeConfig } from "./runtime-config.js";
import { LocalEdgeKit_buildUrlMatrixLines } from "./url-matrix.js";
function LocalEdgeKit_urlsCommandLabel(config) {
    return `${config.cli?.commandName ?? "local-edge"}:urls`;
}
function LocalEdgeKit_printUrlsUsage(options) {
    console.log("Usage:");
    console.log(`  ${options.commandName} urls [--method <primary|all|${options.supportedMethods.join("|")}>]`);
}
/**
 * Runs the `urls` subcommand and returns a process-style exit code suitable for process.exit.
 *
 * @remarks
 * I/O: reads env files via LocalEdgeKit_loadActiveEnvFileStack, resolves runtime routing, writes usage or matrix lines to stdout.
 */
export function LocalEdgeKit_runUrlsCommand(options) {
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
    const commandLabel = LocalEdgeKit_urlsCommandLabel(options.config);
    const parsed = LocalEdgeCore_parseUrlMatrixCliArgs({
        args: options.args,
        defaultMethod: "primary",
        supportedMethods: runtimeConfig.supportedMethods,
        commandLabel,
    });
    if (parsed.help) {
        LocalEdgeKit_printUrlsUsage({
            commandName: options.config.cli?.commandName ?? "local-edge",
            supportedMethods: runtimeConfig.supportedMethods,
        });
        return 0;
    }
    if (parsed.method === "primary") {
        for (const line of LocalEdgeKit_buildUrlMatrixLines({
            commandLabel,
            method: runtimeConfig.primaryMethod,
            runtimeConfig,
        })) {
            console.log(line);
        }
        return 0;
    }
    if (parsed.method === "all") {
        for (const method of runtimeConfig.configuredMethods) {
            for (const line of LocalEdgeKit_buildUrlMatrixLines({
                commandLabel,
                method,
                runtimeConfig,
            })) {
                console.log(line);
            }
        }
        return 0;
    }
    for (const line of LocalEdgeKit_buildUrlMatrixLines({
        commandLabel,
        method: parsed.method,
        runtimeConfig,
    })) {
        console.log(line);
    }
    return 0;
}
