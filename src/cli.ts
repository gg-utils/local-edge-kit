/**
 * @fileoverview Reusable local-edge kit CLI dispatcher that routes argv into kit-owned subcommands
 * for repository adapters.
 *
 * Adapters pass their project-owned `local-edge.config.ts` plus argv. The kit dispatches only the
 * command families it owns today; other local-edge families can migrate here in later slices.
 * Flow: argv + config -> command switch -> delegated handler -> process-style exit code.
 *
 * @testing Jest unit: npm run test --prefix packages/local-edge-kit
 *
 * @see packages/local-edge-kit/src/bin/local-edge-kit.ts - Published bin stub that refuses to run without a repo adapter and points operators at wiring LocalEdgeKit_runCli with explicit config instead.
 * @see scripts/local-edge/cli.ts - Root-repo local-edge script that imports LocalEdgeKit_runCli and supplies the platform local-edge.config.ts adapter for kit-owned command families.
 * @see packages/local-edge-kit/src/config.ts - LocalEdgeKit_Config contract consumed here for CLI naming and settings forwarded into delegated subcommands.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import type { LocalEdgeKit_Config } from "./config.js";
import { LocalEdgeKit_runDnsAuditCommand } from "./dns-audit-cli.js";
import { LocalEdgeKit_runHealthcheckCommand } from "./healthcheck-cli.js";
import { LocalEdgeKit_runStatusCommand } from "./status-cli.js";
import { LocalEdgeKit_messageWord } from "./safe-message.js";
import { LocalEdgeKit_runUrlsCommand } from "./urls-cli.js";

/** Options for invoking the reusable kit dispatcher. */
export type LocalEdgeKit_RunCliOptions = {
  args: readonly string[];
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
};

function LocalEdgeKit_usage(config: LocalEdgeKit_Config): string {
  return `Usage: ${config.cli?.commandName ?? "local-edge"} <dns-audit|healthcheck|status|urls> [args]`;
}

/**
 * Runs the reusable local-edge kit CLI and returns a process-style exit code.
 *
 * @remarks
 * Prints usage on missing argv, `--help`, or `-h` (exit 0). Returns 2 for unknown commands or
 * caught failures after logging a concise error message to stderr.
 */
export async function LocalEdgeKit_runCli(
  options: LocalEdgeKit_RunCliOptions,
): Promise<number> {
  const [command, ...commandArgs] = options.args;

  try {
    if (!command || command === "--help" || command === "-h") {
      console.log(LocalEdgeKit_usage(options.config));
      return 0;
    }

    if (command === "status") {
      return await LocalEdgeKit_runStatusCommand({
        args: commandArgs,
        config: options.config,
        env: options.env,
      });
    }

    if (command === "healthcheck") {
      return await LocalEdgeKit_runHealthcheckCommand({
        args: commandArgs,
        config: options.config,
        env: options.env,
      });
    }

    if (command === "dns-audit") {
      return await LocalEdgeKit_runDnsAuditCommand({
        args: commandArgs,
        config: options.config,
        env: options.env,
      });
    }

    if (command === "urls") {
      return LocalEdgeKit_runUrlsCommand({
        args: commandArgs,
        config: options.config,
        env: options.env,
      });
    }

    console.error(`[local-edge-kit:error] Unknown command: ${LocalEdgeKit_messageWord(command)}`);
    return 2;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
