/**
 * @fileoverview Config-driven helper-server port resolution for local-edge dashboard surfaces.
 *
 * Helper servers such as logs/status dashboards all need the same precedence chain: CLI flags,
 * active realm env overlays, process env, then a canonical-realm default. This package module owns
 * that reusable parsing and collision prevention while adapters provide service names, env keys,
 * defaults, and project-specific remediation wording.
 *
 * @example
 * ```typescript
 * import { LocalEdgeKit_resolveHelperServerPort } from "@gg-utils/local-edge-kit/helper-server-config";
 *
 * const resolved = LocalEdgeKit_resolveHelperServerPort({
 *   activeEnvFilePaths: ["/workspace/.env.local-edge"],
 *   argv: ["--logs-web-port", "9020"],
 *   canonicalRealmSlug: "main",
 *   defaultPort: 9011,
 *   env: { LOCAL_EDGE_ENV_SLUG: "main" },
 *   portEnvName: "LOCAL_EDGE_LOGS_WEB_UPSTREAM_PORT",
 *   portFlags: ["--logs-web-port"],
 *   realmSlugEnvName: "LOCAL_EDGE_ENV_SLUG",
 *   serviceLabel: "logs-web",
 * });
 * ```
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/helper-server-config.unit.test.ts
 *
 * @see consumer local-edge adapter - consumer adapter that forwards logs-web env keys, CLI flags, and remediation copy into this resolver before the logs helper binds.
 * @see consumer local-edge adapter - consumer adapter that wires platform-status helper-server names and realm stack inputs into this resolver the same way.
 * @see packages/local-edge-kit/src/helper-server-config.unit.test.ts - Node test module that locks precedence order and non-canonical default-port collision errors for the contract owned here.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";

/** Layer that supplied a helper-server bind port. */
export type LocalEdgeKit_HelperServerPortSource =
  | "cli"
  | "active-env"
  | "process-env"
  | "default";

/** Successful helper-server port resolution. */
export type LocalEdgeKit_HelperServerResolvedPort = {
  readonly port: number;
  readonly source: LocalEdgeKit_HelperServerPortSource;
};

/** Optional host filesystem operations for env-file reads. */
export type LocalEdgeKit_HelperServerConfigOperations = {
  readonly exists: (filePath: string) => boolean;
  readonly readText: (filePath: string) => string;
};

/** Config and inputs for helper-server port resolution. */
export type LocalEdgeKit_ResolveHelperServerPortOptions = {
  readonly activeEnvFilePaths: readonly string[];
  readonly argv: readonly string[];
  readonly canonicalRealmSlug: string;
  readonly defaultPort: number;
  readonly env: Record<string, string | undefined>;
  readonly operations?: Partial<LocalEdgeKit_HelperServerConfigOperations> | undefined;
  readonly portEnvName: string;
  readonly portFlags: readonly string[];
  readonly realmSlugEnvName: string;
  readonly serviceLabel: string;
  readonly defaultPortCollisionMessage?: (options: {
    port: number;
    portEnvName: string;
    realmSlug: string;
    serviceLabel: string;
  }) => string;
  readonly missingNonCanonicalPortMessage?: (options: {
    portEnvName: string;
    realmSlug: string;
    serviceLabel: string;
  }) => string;
};

function LocalEdgeKit_helperServerDefaultOperations(): LocalEdgeKit_HelperServerConfigOperations {
  return {
    exists: (filePath): boolean => fs.existsSync(filePath),
    readText: (filePath): string => fs.readFileSync(filePath, "utf8"),
  };
}

function LocalEdgeKit_helperServerOperations(
  operations: Partial<LocalEdgeKit_HelperServerConfigOperations> | undefined,
): LocalEdgeKit_HelperServerConfigOperations {
  const defaults = LocalEdgeKit_helperServerDefaultOperations();
  return {
    exists: operations?.exists ?? defaults.exists,
    readText: operations?.readText ?? defaults.readText,
  };
}

function LocalEdgeKit_helperServerPrefix(serviceLabel: string): string {
  return `[${serviceLabel}]`;
}

/** Parses and validates a decimal TCP port. */
export function LocalEdgeKit_parseHelperServerPort(options: {
  readonly label: string;
  readonly rawValue: string;
  readonly serviceLabel: string;
}): number {
  const normalized = options.rawValue.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `${LocalEdgeKit_helperServerPrefix(options.serviceLabel)} ${options.label} must be a positive integer port. Received '${options.rawValue}'.`,
    );
  }

  const parsed = Number.parseInt(normalized, 10);
  if (parsed < 1 || parsed > 65535) {
    throw new Error(
      `${LocalEdgeKit_helperServerPrefix(options.serviceLabel)} ${options.label} must be between 1 and 65535. Received '${options.rawValue}'.`,
    );
  }
  return parsed;
}

/** Removes matching single or double quotes around dotenv values. */
export function LocalEdgeKit_stripHelperServerEnvValue(
  rawValue: string,
): string {
  const normalized = rawValue.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

/** Reads the last dotenv-style assignment for `key` from `envFilePath`. */
export function LocalEdgeKit_readHelperServerEnvFileValue(options: {
  readonly envFilePath: string | null;
  readonly key: string;
  readonly operations?: Partial<LocalEdgeKit_HelperServerConfigOperations> | undefined;
}): string | null {
  const operations = LocalEdgeKit_helperServerOperations(options.operations);
  if (!options.envFilePath || !operations.exists(options.envFilePath)) {
    return null;
  }

  const content = operations.readText(options.envFilePath);
  let resolved: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const candidateKey = trimmed.slice(0, separatorIndex).trim();
    if (candidateKey === options.key) {
      resolved = LocalEdgeKit_stripHelperServerEnvValue(
        trimmed.slice(separatorIndex + 1),
      );
    }
  }
  return resolved;
}

/** Returns the most specific active env file path from a general-to-specific stack. */
export function LocalEdgeKit_activeHelperServerEnvFilePath(
  activeEnvFilePaths: readonly string[],
): string | null {
  return activeEnvFilePaths[activeEnvFilePaths.length - 1] ?? null;
}

function LocalEdgeKit_parseHelperServerCliPort(
  options: LocalEdgeKit_ResolveHelperServerPortOptions,
): LocalEdgeKit_HelperServerResolvedPort | null {
  for (let index = 0; index < options.argv.length; index += 1) {
    const argument = options.argv[index] ?? "";
    for (const flag of options.portFlags) {
      if (argument === flag) {
        const value = options.argv[index + 1];
        if (!value) {
          throw new Error(
            `${LocalEdgeKit_helperServerPrefix(options.serviceLabel)} ${flag} requires a port value.`,
          );
        }
        return {
          port: LocalEdgeKit_parseHelperServerPort({
            label: flag,
            rawValue: value,
            serviceLabel: options.serviceLabel,
          }),
          source: "cli",
        };
      }

      const assignmentPrefix = `${flag}=`;
      if (argument.startsWith(assignmentPrefix)) {
        return {
          port: LocalEdgeKit_parseHelperServerPort({
            label: flag,
            rawValue: argument.slice(assignmentPrefix.length),
            serviceLabel: options.serviceLabel,
          }),
          source: "cli",
        };
      }
    }
  }
  return null;
}

function LocalEdgeKit_defaultPortCollisionMessage(options: {
  port: number;
  portEnvName: string;
  realmSlug: string;
  serviceLabel: string;
}): string {
  return (
    `${LocalEdgeKit_helperServerPrefix(options.serviceLabel)} Refusing to bind non-canonical realm ` +
    `'${options.realmSlug}' to the canonical helper port ${options.port}. Set ` +
    `${options.portEnvName} in the active realm env file or pass an explicit port flag.`
  );
}

function LocalEdgeKit_missingNonCanonicalPortMessage(options: {
  portEnvName: string;
  realmSlug: string;
  serviceLabel: string;
}): string {
  return (
    `${LocalEdgeKit_helperServerPrefix(options.serviceLabel)} Missing ${options.portEnvName} ` +
    `for non-canonical realm '${options.realmSlug}'. Non-canonical realms must use explicit helper ports.`
  );
}

function LocalEdgeKit_assertHelperServerNonCanonicalPort(options: {
  port: number;
  portSource: LocalEdgeKit_HelperServerPortSource;
  resolveOptions: LocalEdgeKit_ResolveHelperServerPortOptions;
  realmSlug: string;
}): LocalEdgeKit_HelperServerResolvedPort {
  if (
    options.realmSlug !== options.resolveOptions.canonicalRealmSlug &&
    options.port === options.resolveOptions.defaultPort
  ) {
    const buildMessage =
      options.resolveOptions.defaultPortCollisionMessage ??
      LocalEdgeKit_defaultPortCollisionMessage;
    throw new Error(
      buildMessage({
        port: options.port,
        portEnvName: options.resolveOptions.portEnvName,
        realmSlug: options.realmSlug,
        serviceLabel: options.resolveOptions.serviceLabel,
      }),
    );
  }

  return { port: options.port, source: options.portSource };
}

/** Resolves a helper-server bind port from CLI args, active env files, process env, or default. */
export function LocalEdgeKit_resolveHelperServerPort(
  options: LocalEdgeKit_ResolveHelperServerPortOptions,
): LocalEdgeKit_HelperServerResolvedPort {
  const cliPort = LocalEdgeKit_parseHelperServerCliPort(options);
  if (cliPort !== null) {
    return cliPort;
  }

  const activeEnvFilePath = LocalEdgeKit_activeHelperServerEnvFilePath(
    options.activeEnvFilePaths,
  );
  const activeEnvRealmSlug =
    LocalEdgeKit_readHelperServerEnvFileValue({
      envFilePath: activeEnvFilePath,
      key: options.realmSlugEnvName,
      operations: options.operations,
    }) ?? options.canonicalRealmSlug;
  const realmSlug = (
    options.env[options.realmSlugEnvName] ?? activeEnvRealmSlug
  )
    .trim()
    .toLowerCase();
  const activeEnvPort = LocalEdgeKit_readHelperServerEnvFileValue({
    envFilePath: activeEnvFilePath,
    key: options.portEnvName,
    operations: options.operations,
  });

  if (activeEnvPort) {
    const port = LocalEdgeKit_parseHelperServerPort({
      label: options.portEnvName,
      rawValue: activeEnvPort,
      serviceLabel: options.serviceLabel,
    });
    return LocalEdgeKit_assertHelperServerNonCanonicalPort({
      port,
      portSource: "active-env",
      realmSlug,
      resolveOptions: options,
    });
  }

  const processEnvPort = options.env[options.portEnvName];
  if (processEnvPort) {
    const port = LocalEdgeKit_parseHelperServerPort({
      label: options.portEnvName,
      rawValue: processEnvPort,
      serviceLabel: options.serviceLabel,
    });
    return LocalEdgeKit_assertHelperServerNonCanonicalPort({
      port,
      portSource: "process-env",
      realmSlug,
      resolveOptions: options,
    });
  }

  if (realmSlug !== options.canonicalRealmSlug) {
    const buildMessage =
      options.missingNonCanonicalPortMessage ??
      LocalEdgeKit_missingNonCanonicalPortMessage;
    throw new Error(
      buildMessage({
        portEnvName: options.portEnvName,
        realmSlug,
        serviceLabel: options.serviceLabel,
      }),
    );
  }

  return {
    port: options.defaultPort,
    source: "default",
  };
}
