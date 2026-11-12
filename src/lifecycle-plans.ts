/**
 * @fileoverview Config-driven lifecycle plans for local-edge start/init/setup/doctor adapters.
 *
 * The kit owns reusable derivation of Docker compose start/stop commands, init env path and
 * post-write command planning, setup/doctor request planning, shell assignment output,
 * log/artifact paths, listen tuples, and timeout env defaults from `local-edge.config.ts`.
 * Adapters still own host execution, prompts, Docker subprocess I/O, and any consumer-specific
 * runtime process orchestration.
 *
 * @testing Jest unit: npm run test --prefix packages/local-edge-kit -- src/lifecycle-plans.unit.test.ts
 *
 * @see packages/local-edge-kit/src/config.ts - Typed local-edge.config.ts contract this module reads when deriving lifecycle commands, paths, and env overlay validation targets for adapters.
 * @see packages/local-edge-kit/src/runtime-config.ts - Resolves generated-dir, enabled methods, and realm slug inputs combined here with startup-cli env flags into concrete host command plans.
 * @see packages/local-edge-kit/src/docker-host.ts - Docker host adapter that imports ensure-running lifecycle contract types from this module when wiring nginx-docker adapter hooks for project-owned CLIs.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  LocalEdgeCore_buildDockerComposeDownCommand,
  LocalEdgeCore_buildDockerComposeUpDetachedCommand,
  LocalEdgeCore_commandExists,
  LocalEdgeCore_extractShellCommandBinary,
  LocalEdgeCore_formatHttpsUrl,
  LocalEdgeCore_isCustomLoopbackHost,
  LocalEdgeCore_isPortListening,
  LocalEdgeCore_isTruthy,
  LocalEdgeCore_logColorEnabled,
  LocalEdgeCore_logError,
  LocalEdgeCore_logInfo,
  LocalEdgeCore_logWarn,
  LocalEdgeCore_loopbackAliasExists,
  LocalEdgeCore_mkcertTrustDetected,
  LocalEdgeCore_resolveTlsCertPath,
  LocalEdgeCore_shouldFailHard,
  LocalEdgeCore_slugifySegment,
  LocalEdgeCore_terminateListenersOnPort,
  LocalEdgeCore_validatePositiveInteger,
  LocalEdgeCore_writeArtifact,
} from "@gg-utils/local-edge-core";

import type { LocalEdgeKit_Config } from "./config.js";
import { LocalEdgeKit_resolveProjectRoot } from "./env.js";
import {
  LocalEdgeKit_getRuntimeMethod,
  LocalEdgeKit_resolveRuntimeConfig,
  type LocalEdgeKit_RuntimeNginxDockerMethod,
} from "./runtime-config.js";
import { LocalEdgeKit_messageWord } from "./safe-message.js";

/** Fully resolved shell variables for an nginx-docker start wrapper. */
export type LocalEdgeKit_StartNginxDockerPlan = {
  method: string;
  port: string;
  listenHost: string;
  timeoutSeconds: string;
  startCommand: string;
  startBinary: string;
  customLoopbackRequired: boolean;
};

/** Resolved stop values for one local-edge method wrapper. */
export type LocalEdgeKit_StopMethodPlan = {
  method: string;
  generatedDir: string;
  port: number;
  listenHost: string;
  stopCommand: string;
  logDir: string;
  artifactsDir: string;
};

/** Resolved startup-cli ensure-running request after config/env validation. */
export type LocalEdgeKit_EnsureRunningRequestResult =
  | {
      ok: true;
      commands: {
        render: LocalEdgeKit_HostCommandPlan;
        setup: LocalEdgeKit_HostCommandPlan;
        start: LocalEdgeKit_HostCommandPlan;
        statusRequireRunning: LocalEdgeKit_HostCommandPlan;
        stop: LocalEdgeKit_HostCommandPlan;
      };
      configuredMethods: readonly string[];
      forceRecreateIfRunning: boolean;
      method: string;
      realm: string;
      routerProbe: {
        connectTimeoutSeconds: number;
        maxTimeSeconds: number;
        url: string;
      };
    }
  | {
      ok: false;
      exitCode: 1 | 2;
      stderrLine: string;
    };

/** Config-driven start request resolved from startup env and project config. */
export type LocalEdgeKit_StartRequestResult =
  | {
      ok: true;
      command: LocalEdgeKit_HostCommandPlan;
      method: string;
    }
  | {
      ok: false;
      exitCode: 1 | 2;
      stderrLine: string;
    };

/** Spawn plan for setup-time env overlay validation. */
export type LocalEdgeKit_SetupEnvOverlayValidationPlan = {
  command: "npx";
  args: readonly string[];
  timeoutMs: number;
};

/** Config-driven setup request resolved from startup env and runtime config. */
export type LocalEdgeKit_SetupRequestResult =
  | {
      ok: true;
      artifact: {
        artifactsDir: string;
        name: string;
      };
      customLoopbackHost: string | null;
      envOverlayValidation: LocalEdgeKit_SetupEnvOverlayValidationPlan;
      method: string;
      missingEnvWarningLines: readonly string[];
      requiredUtilities: readonly string[];
      setupStrictStartEnvName: string;
      setupStrictStartEnvValue: "true" | "false" | null;
      startTimeoutWarningLine: string | null;
      writeArtifact: boolean;
    }
  | {
      ok: false;
      exitCode: 1 | 2;
      stderrLine: string;
    };

/** Host/runtime operations used by the setup lifecycle runner. */
export type LocalEdgeKit_SetupLifecycleHooks = {
  commandExists: (commandName: string) => boolean;
  loopbackAliasExists: (host: string) => boolean;
  mkcertTrustDetected: () => boolean;
  writeArtifact: (options: {
    artifactsDir: string;
    content: string;
    name: string;
  }) => void;
};

/** Log sinks used by the setup lifecycle runner. */
export type LocalEdgeKit_SetupLifecycleLoggers = {
  error: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
};

/** Config-driven stop request resolved from startup env and project config. */
export type LocalEdgeKit_StopRequestResult =
  | {
      ok: true;
      allowPortKill: boolean;
      method: string;
      methodPlans: readonly LocalEdgeKit_StopMethodPlan[];
      timeoutSeconds: number;
      timeoutWarningLine: string | null;
    }
  | {
      ok: false;
      exitCode: 1 | 2;
      stderrLine: string;
    };

/** Host operations used by the stop lifecycle runner. */
export type LocalEdgeKit_StopLifecycleHooks = {
  isPortListening: (options: { host: string; port: number }) => boolean;
  runStopCommand: (options: {
    command: string;
    logDir: string;
    method: string;
  }) => void;
  terminateListenersOnPort: (port: number) => void;
  writeArtifact: (options: {
    artifactsDir: string;
    content: string;
    name: string;
  }) => void;
};

/** Log sinks used by the stop lifecycle runner. */
export type LocalEdgeKit_StopLifecycleLoggers =
  LocalEdgeKit_SetupLifecycleLoggers;

/** Strict flag token delegated to doctor subcommands. */
export type LocalEdgeKit_DoctorStrictArg = "--strict" | "--no-strict";

/** Config-driven doctor request resolved from startup env and runtime config. */
export type LocalEdgeKit_DoctorRequest = {
  applicationIntervalMs: string | undefined;
  applicationMaxWaitMs: string | undefined;
  applicationTimeoutMs: string | undefined;
  method: string;
  paths: {
    doctorCoreScriptPath: string;
    dnsAuditScriptPath: string;
    healthcheckScriptPath: string;
    realmListScriptPath: string;
    registryPath: string;
    renderArtifactPath: string;
    renderScriptPath: string;
    sessionPidPath: string;
    startupCliScriptPath: string;
    statusScriptPath: string;
    tlsCertPath: string;
  };
  realm: string;
  skipApplication: boolean;
  skipDns: boolean;
  skipEdge: boolean;
  skipRender: boolean;
  skipSetup: boolean;
  strict: boolean;
  strictArg: LocalEdgeKit_DoctorStrictArg;
  watchApplication: boolean;
};

/** Captured stdout result for doctor host commands that are parsed by the lifecycle runner. */
export type LocalEdgeKit_DoctorCapturedCommandResult = {
  status: number;
  stdout: string;
};

/** Host/runtime operations used by the doctor lifecycle runner. */
export type LocalEdgeKit_DoctorLifecycleHooks = {
  commandExists: (commandName: string) => boolean;
  exists: (filePath: string) => boolean;
  processIsRunning: (pid: number) => boolean;
  readText: (filePath: string) => string;
  runCommandCapture: (options: {
    args: readonly string[];
    command: string;
    timeoutMs: number;
  }) => LocalEdgeKit_DoctorCapturedCommandResult;
  runTsx: (options: { args: readonly string[]; timeoutMs: number }) => number;
};

/** Generic host command plan for init post-write validation steps. */
export type LocalEdgeKit_HostCommandPlan = {
  command: "bash" | "npx";
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
};

/** Successful ensure-running request with method commands and router probe data. */
export type LocalEdgeKit_EnsureRunningRequest = Extract<
  LocalEdgeKit_EnsureRunningRequestResult,
  { ok: true }
>;

/** Router probe contract emitted by ensure-running request planning. */
export type LocalEdgeKit_EnsureRunningRouterProbe =
  LocalEdgeKit_EnsureRunningRequest["routerProbe"];

/** Result expected from method readiness hooks before ensure-running mutates hosts. */
export type LocalEdgeKit_EnsureRunningMethodReadyResult =
  | {
      ok: true;
    }
  | {
      message: string;
      ok: false;
    };

/** Host/runtime hooks injected by project adapters for method-specific ensure-running work. */
export type LocalEdgeKit_EnsureRunningRuntimeHooks = {
  ensureMethodReadyForStartup: (options: {
    env: NodeJS.ProcessEnv;
    method: string;
  }) => LocalEdgeKit_EnsureRunningMethodReadyResult;
  methodRuntimeMatchesCurrentArtifacts: (options: {
    env: NodeJS.ProcessEnv;
    method: string;
  }) => boolean;
  reloadRunningMethod: (options: {
    env: NodeJS.ProcessEnv;
    method: string;
  }) => boolean;
  routerHostProbe: (options: {
    routerProbe: LocalEdgeKit_EnsureRunningRouterProbe;
  }) => boolean;
};

/** Options for running one lifecycle host command. */
export type LocalEdgeKit_RunHostCommandPlanOptions = {
  env: NodeJS.ProcessEnv;
  plan: LocalEdgeKit_HostCommandPlan;
  stdio: "inherit" | "ignore";
};

/** Full ensure-running lifecycle runner options. */
export type LocalEdgeKit_RunEnsureRunningLifecycleOptions = {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
  executeHostCommandPlan?: (
    options: LocalEdgeKit_RunHostCommandPlanOptions,
  ) => number;
  hooks: LocalEdgeKit_EnsureRunningRuntimeHooks;
  projectRoot?: string | null | undefined;
  stderr?: (line: string) => void;
  stdout?: (line: string) => void;
};

/** Full setup lifecycle runner options. */
export type LocalEdgeKit_RunSetupLifecycleOptions = {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
  executeHostCommandPlan?: (
    options: LocalEdgeKit_RunHostCommandPlanOptions,
  ) => number;
  hooks?: Partial<LocalEdgeKit_SetupLifecycleHooks>;
  loggers?: Partial<LocalEdgeKit_SetupLifecycleLoggers>;
  now?: () => Date;
  projectRoot?: string | null | undefined;
  stderr?: (line: string) => void;
  stdout?: (line: string) => void;
};

/** Full init lifecycle runner options. */
export type LocalEdgeKit_RunInitLifecycleOptions = {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
  executeHostCommandPlan?: (
    options: LocalEdgeKit_RunHostCommandPlanOptions,
  ) => number;
  hooks?: Partial<LocalEdgeKit_InitLifecycleHooks>;
  isStdinTty?: boolean;
  loggers?: Partial<LocalEdgeKit_SetupLifecycleLoggers>;
  projectRoot?: string | null | undefined;
  stderr?: (line: string) => void;
};

/** Full start lifecycle runner options. */
export type LocalEdgeKit_RunStartLifecycleOptions = {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
  executeHostCommandPlan?: (
    options: LocalEdgeKit_RunHostCommandPlanOptions,
  ) => number;
  projectRoot?: string | null | undefined;
  stderr?: (line: string) => void;
};

/** Full stop lifecycle runner options. */
export type LocalEdgeKit_RunStopLifecycleOptions = {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
  hooks?: Partial<LocalEdgeKit_StopLifecycleHooks>;
  loggers?: Partial<LocalEdgeKit_StopLifecycleLoggers>;
  nowMs?: () => number;
  projectRoot?: string | null | undefined;
  sleep?: () => void;
  stderr?: (line: string) => void;
  stdout?: (line: string) => void;
};

/** Full doctor lifecycle runner options. */
export type LocalEdgeKit_RunDoctorLifecycleOptions = {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
  hooks?: Partial<LocalEdgeKit_DoctorLifecycleHooks>;
  projectRoot?: string | null | undefined;
  stderr?: (line: string) => void;
  stdout?: (line: string) => void;
};

/** Config-driven init request resolved from startup env and project config. */
export type LocalEdgeKit_InitRequest = {
  deprecatedEnvNames: readonly string[];
  developerSlugOverride: string;
  envFileEnvName: string;
  envFilePath: string;
  envTemplatePath: string;
  postWriteCommands: {
    bootstrap: LocalEdgeKit_HostCommandPlan;
    configPrint: LocalEdgeKit_HostCommandPlan;
    render: LocalEdgeKit_HostCommandPlan;
    setup: LocalEdgeKit_HostCommandPlan;
  };
  promptDeveloperSlug: "auto" | "true" | "false";
  runBootstrap: boolean;
  runChecks: boolean;
  writeChanges: boolean;
};

/** Env names that the init lifecycle normalizes and writes. */
export type LocalEdgeKit_InitEnvNames = {
  developerSlug: string;
  envSlug: string;
  exposureMode: string;
  healthMonitorMethod: string;
  identityLabel: string;
  methodsCsv: string;
  nginxDockerHost: string;
  primaryMethod: string;
  rootZone: string;
  runtimeAuditMethod: string;
  splitDnsNginxDockerIp: string;
};

/** Resolved local-edge env values ready to print and persist. */
export type LocalEdgeKit_InitResolvedValues = {
  developerSlug: string;
  envSlug: string;
  exposureMode: string;
  healthMonitorMethod: string;
  identityLabel: string;
  methodsCsv: string;
  nginxDockerHost: string;
  primaryMethod: string;
  rootZone: string;
  runtimeAuditMethod: string;
  splitDnsNginxDockerIp: string;
};

/** File, prompt, and env-loading hooks used by the init lifecycle runner. */
export type LocalEdgeKit_InitLifecycleHooks = {
  copyFile: (sourcePath: string, targetPath: string) => void;
  exists: (filePath: string) => boolean;
  loadEnvFile: (options: {
    env: NodeJS.ProcessEnv;
    envFilePath: string;
  }) => void;
  promptDeveloperSlug: (options: {
    currentSlug: string;
    env: NodeJS.ProcessEnv;
    promptDefault: string;
  }) => Promise<string>;
  readText: (filePath: string) => string;
  writeText: (filePath: string, content: string) => void;
};

/** Options shared by lifecycle plan builders. */
export type LocalEdgeKit_LifecyclePlanOptions = {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
  method: string;
  projectRoot?: string | null | undefined;
};

function LocalEdgeKit_lifecycleEnvKeyForMethod(options: {
  configuredNames: Readonly<Record<string, string>> | undefined;
  method: string;
  suffix: "START_CMD" | "STOP_CMD";
}): string {
  const configured = options.configuredNames?.[options.method];
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  return `LOCAL_EDGE_${options.method.toUpperCase().replace(/-/g, "_")}_${options.suffix}`;
}

function LocalEdgeKit_lifecycleProjectPath(options: {
  projectRoot: string;
  value: string;
}): string {
  if (path.isAbsolute(options.value)) {
    return options.value;
  }
  return path.join(options.projectRoot, options.value);
}

function LocalEdgeKit_lifecycleLogDir(options: {
  config: LocalEdgeKit_Config;
  projectRoot: string;
}): string {
  return LocalEdgeKit_lifecycleProjectPath({
    projectRoot: options.projectRoot,
    value: options.config.lifecycle?.logDir ?? "logs/local-edge",
  });
}

function LocalEdgeKit_lifecycleArtifactsDir(options: {
  config: LocalEdgeKit_Config;
  logDir: string;
  projectRoot: string;
}): string {
  const configuredArtifactsDir = options.config.lifecycle?.artifactsDir;
  if (
    configuredArtifactsDir !== undefined &&
    configuredArtifactsDir.length > 0
  ) {
    return LocalEdgeKit_lifecycleProjectPath({
      projectRoot: options.projectRoot,
      value: configuredArtifactsDir,
    });
  }
  return path.join(options.logDir, "artifacts");
}

function LocalEdgeKit_lifecycleImplementationPath(options: {
  config: LocalEdgeKit_Config;
  projectRoot: string;
  scriptName: string;
}): string {
  return LocalEdgeKit_lifecycleProjectPath({
    projectRoot: options.projectRoot,
    value: path.join(
      options.config.startup?.implementationDirectory ?? "scripts/local-edge",
      options.scriptName,
    ),
  });
}

function LocalEdgeKit_lifecycleArtifacts(options: {
  config: LocalEdgeKit_Config;
  projectRoot: string;
}): {
  artifactsDir: string;
  logDir: string;
} {
  const logDir = LocalEdgeKit_lifecycleLogDir({
    config: options.config,
    projectRoot: options.projectRoot,
  });
  return {
    logDir,
    artifactsDir: LocalEdgeKit_lifecycleArtifactsDir({
      config: options.config,
      logDir,
      projectRoot: options.projectRoot,
    }),
  };
}

function LocalEdgeKit_errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function LocalEdgeKit_lifecycleEnvFlag(
  env: NodeJS.ProcessEnv,
  key: string,
): boolean {
  return env[key] === "1";
}

function LocalEdgeKit_localEdgeEnvFilePath(options: {
  config: LocalEdgeKit_Config;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
}): {
  envFileEnvName: string;
  envFilePath: string;
} {
  const envFileEnvName =
    options.config.env?.envFileEnvName ?? "LOCAL_EDGE_ENV_FILE";
  const configuredEnvFile = options.env[envFileEnvName];
  if (configuredEnvFile !== undefined && configuredEnvFile.length > 0) {
    return {
      envFileEnvName,
      envFilePath: path.resolve(configuredEnvFile),
    };
  }
  return {
    envFileEnvName,
    envFilePath: path.join(options.projectRoot, ".env.local-edge"),
  };
}

function LocalEdgeKit_getLifecycleRuntimeMethod(
  options: LocalEdgeKit_LifecyclePlanOptions,
): {
  env: NodeJS.ProcessEnv;
  generatedDir: string;
  method: LocalEdgeKit_RuntimeNginxDockerMethod;
  projectRoot: string;
} {
  const env = options.env ?? process.env;
  const runtimeConfig = LocalEdgeKit_resolveRuntimeConfig({
    config: options.config,
    env,
    projectRoot: options.projectRoot,
  });
  const method = LocalEdgeKit_getRuntimeMethod({
    commandLabel: "local-edge:lifecycle",
    runtimeConfig,
    method: options.method,
  });
  return {
    env,
    generatedDir: runtimeConfig.generatedDir,
    method,
    projectRoot: runtimeConfig.projectRoot,
  };
}

function LocalEdgeKit_normalizeInitDeveloperSlugPrompt(
  rawValue: string | undefined,
): LocalEdgeKit_InitRequest["promptDeveloperSlug"] {
  if (rawValue === "true" || rawValue === "false" || rawValue === "auto") {
    return rawValue;
  }
  return "auto";
}

function LocalEdgeKit_parsePositiveIntegerEnv(options: {
  defaultValue: number;
  env: NodeJS.ProcessEnv;
  key: string;
}): number {
  const rawValue = options.env[options.key];
  if (rawValue === undefined || rawValue.length === 0) {
    return options.defaultValue;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return options.defaultValue;
}

function LocalEdgeKit_startScriptNameForMethod(method: string): string | null {
  if (method === "nginx-docker") {
    return "start-nginx-docker.sh";
  }
  if (method === "all") {
    return "start-all.sh";
  }
  return null;
}

/** Resolves `startup-cli run init` env into file paths, flags, and post-write command plans. */
export function LocalEdgeKit_resolveInitRequest(options: {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
  projectRoot?: string | null | undefined;
}): LocalEdgeKit_InitRequest {
  const env = options.env ?? process.env;
  const projectRoot = LocalEdgeKit_resolveProjectRoot({
    config: options.config,
    env,
    projectRoot: options.projectRoot,
  });
  const envFile = LocalEdgeKit_localEdgeEnvFilePath({
    config: options.config,
    env,
    projectRoot,
  });
  const implementationPath = (scriptName: string): string =>
    LocalEdgeKit_lifecycleImplementationPath({
      config: options.config,
      projectRoot,
      scriptName,
    });

  return {
    deprecatedEnvNames: options.config.lifecycle?.initDeprecatedEnvNames ?? [],
    developerSlugOverride:
      env.LOCAL_EDGE_STARTUP_CLI_INIT_DEVELOPER_SLUG_OVERRIDE ?? "",
    envFileEnvName: envFile.envFileEnvName,
    envFilePath: envFile.envFilePath,
    envTemplatePath: LocalEdgeKit_lifecycleProjectPath({
      projectRoot,
      value:
        options.config.lifecycle?.initEnvTemplatePath ??
        path.join(
          options.config.startup?.implementationDirectory ??
            "scripts/local-edge",
          ".env.example",
        ),
    }),
    postWriteCommands: {
      bootstrap: {
        command: "bash",
        args: [implementationPath("setup-bootstrap.sh")],
        timeoutMs: 300_000,
      },
      configPrint: {
        command: "npx",
        args: ["tsx", implementationPath("config-print.ts")],
        timeoutMs: 30_000,
      },
      render: {
        command: "npx",
        args: ["tsx", implementationPath("render.ts")],
        timeoutMs: 120_000,
      },
      setup: {
        command: "npx",
        args: [
          "tsx",
          implementationPath(
            path.join("startup-cli", "local-edge-startup-cli.ts"),
          ),
          "run",
          "setup",
          "--",
          "--no-artifact",
        ],
        timeoutMs: 120_000,
      },
    },
    promptDeveloperSlug: LocalEdgeKit_normalizeInitDeveloperSlugPrompt(
      env.LOCAL_EDGE_STARTUP_CLI_INIT_PROMPT_DEVELOPER_SLUG,
    ),
    runBootstrap: LocalEdgeCore_isTruthy(
      env.LOCAL_EDGE_STARTUP_CLI_INIT_RUN_BOOTSTRAP ?? "false",
    ),
    runChecks: LocalEdgeCore_isTruthy(
      env.LOCAL_EDGE_STARTUP_CLI_INIT_RUN_CHECKS ?? "true",
    ),
    writeChanges: LocalEdgeCore_isTruthy(
      env.LOCAL_EDGE_STARTUP_CLI_INIT_WRITE_CHANGES ?? "true",
    ),
  };
}

/** Resolves `startup-cli run doctor` env into flags, paths, and delegated script locations. */
export function LocalEdgeKit_resolveDoctorRequest(options: {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
  projectRoot?: string | null | undefined;
}): LocalEdgeKit_DoctorRequest {
  const env = options.env ?? process.env;
  const runtimeConfig = LocalEdgeKit_resolveRuntimeConfig({
    config: options.config,
    env,
    projectRoot: options.projectRoot,
  });
  const method =
    env.LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD ?? runtimeConfig.primaryMethod;
  const explicitStrict = env.LOCAL_EDGE_STARTUP_CLI_DOCTOR_STRICT;
  const strict =
    explicitStrict === "true"
      ? true
      : explicitStrict === "false"
        ? false
        : LocalEdgeCore_isTruthy(env.LOCAL_EDGE_STRICT_START ?? "false");
  const renderArtifactPath = LocalEdgeKit_lifecycleProjectPath({
    projectRoot: runtimeConfig.projectRoot,
    value:
      options.config.render?.artifactPath ??
      "logs/local-edge/artifacts/render-last-run.json",
  });

  return {
    applicationIntervalMs:
      env.LOCAL_EDGE_STARTUP_CLI_DOCTOR_APPLICATION_INTERVAL_MS,
    applicationMaxWaitMs:
      env.LOCAL_EDGE_STARTUP_CLI_DOCTOR_APPLICATION_MAX_WAIT_MS,
    applicationTimeoutMs:
      env.LOCAL_EDGE_STARTUP_CLI_DOCTOR_APPLICATION_TIMEOUT_MS,
    method,
    paths: {
      doctorCoreScriptPath: LocalEdgeKit_lifecycleImplementationPath({
        config: options.config,
        projectRoot: runtimeConfig.projectRoot,
        scriptName: "doctor-core.ts",
      }),
      dnsAuditScriptPath: LocalEdgeKit_lifecycleImplementationPath({
        config: options.config,
        projectRoot: runtimeConfig.projectRoot,
        scriptName: "dns-audit.ts",
      }),
      healthcheckScriptPath: LocalEdgeKit_lifecycleImplementationPath({
        config: options.config,
        projectRoot: runtimeConfig.projectRoot,
        scriptName: "healthcheck.ts",
      }),
      realmListScriptPath: LocalEdgeKit_lifecycleImplementationPath({
        config: options.config,
        projectRoot: runtimeConfig.projectRoot,
        scriptName: "realm-list.ts",
      }),
      registryPath: path.join(
        runtimeConfig.generatedDir,
        "registry",
        "realms.json",
      ),
      renderArtifactPath,
      renderScriptPath: LocalEdgeKit_lifecycleImplementationPath({
        config: options.config,
        projectRoot: runtimeConfig.projectRoot,
        scriptName: "render.ts",
      }),
      sessionPidPath: path.join(
        runtimeConfig.generatedDir,
        "run",
        "local-session-child.pid",
      ),
      startupCliScriptPath: LocalEdgeKit_lifecycleImplementationPath({
        config: options.config,
        projectRoot: runtimeConfig.projectRoot,
        scriptName: path.join("startup-cli", "local-edge-startup-cli.ts"),
      }),
      statusScriptPath: LocalEdgeKit_lifecycleImplementationPath({
        config: options.config,
        projectRoot: runtimeConfig.projectRoot,
        scriptName: "status.ts",
      }),
      tlsCertPath: LocalEdgeCore_resolveTlsCertPath({
        generatedDir: runtimeConfig.generatedDir,
        rawCertPath: env.LOCAL_EDGE_TLS_CERT_PATH,
      }),
    },
    realm: runtimeConfig.realmSlug,
    skipApplication: LocalEdgeKit_lifecycleEnvFlag(
      env,
      "LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_APPLICATION",
    ),
    skipDns: LocalEdgeKit_lifecycleEnvFlag(
      env,
      "LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_DNS",
    ),
    skipEdge: LocalEdgeKit_lifecycleEnvFlag(
      env,
      "LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_EDGE",
    ),
    skipRender: LocalEdgeKit_lifecycleEnvFlag(
      env,
      "LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_RENDER",
    ),
    skipSetup: LocalEdgeKit_lifecycleEnvFlag(
      env,
      "LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_SETUP",
    ),
    strict,
    strictArg: strict ? "--strict" : "--no-strict",
    watchApplication: LocalEdgeKit_lifecycleEnvFlag(
      env,
      "LOCAL_EDGE_STARTUP_CLI_DOCTOR_WATCH_APPLICATION",
    ),
  };
}

/** Resolves `startup-cli run setup` env into a validated, host-operation-free setup plan. */
export function LocalEdgeKit_resolveSetupRequest(options: {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
  projectRoot?: string | null | undefined;
}): LocalEdgeKit_SetupRequestResult {
  const env = options.env ?? process.env;
  const method = env.LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD;
  if (method === undefined || method.length === 0) {
    return {
      ok: false,
      exitCode: 2,
      stderrLine:
        "[local-edge:setup] Missing LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD.\n",
    };
  }

  try {
    const runtimeConfig = LocalEdgeKit_resolveRuntimeConfig({
      config: options.config,
      env,
      projectRoot: options.projectRoot,
    });
    if (!runtimeConfig.configuredMethods.includes(method)) {
      const methodsEnvName =
        options.config.env?.methodsEnvName ?? "LOCAL_EDGE_METHODS";
      return {
        ok: false,
        exitCode: 1,
        stderrLine: `[local-edge:setup] Requested method '${LocalEdgeKit_messageWord(method)}' is not enabled by ${methodsEnvName}.\n`,
      };
    }

    const runtimeMethod = LocalEdgeKit_getRuntimeMethod({
      commandLabel: "local-edge:setup",
      runtimeConfig,
      method,
    });
    const lifecycleConfig = options.config.lifecycle;
    const startTimeoutEnvName =
      lifecycleConfig?.startTimeoutSecondsEnvName ??
      "LOCAL_EDGE_START_TIMEOUT_SECONDS";
    const startTimeoutValue = env[startTimeoutEnvName];
    const startTimeoutValidation =
      startTimeoutValue !== undefined && startTimeoutValue.length > 0
        ? LocalEdgeCore_validatePositiveInteger({
            label: startTimeoutEnvName,
            value: startTimeoutValue,
          })
        : { ok: true as const };
    const strictOverrideRaw =
      env.LOCAL_EDGE_STARTUP_CLI_SETUP_STRICT ?? "unset";
    const setupStrictStartEnvValue =
      strictOverrideRaw === "true" || strictOverrideRaw === "1"
        ? "true"
        : strictOverrideRaw === "false" || strictOverrideRaw === "0"
          ? "false"
          : null;
    const setupStrictStartEnvName =
      lifecycleConfig?.setupStrictStartEnvName ?? "LOCAL_EDGE_STRICT_START";
    const { artifactsDir } = LocalEdgeKit_lifecycleArtifacts({
      config: options.config,
      projectRoot: runtimeConfig.projectRoot,
    });
    const envOverlayValidationScript =
      lifecycleConfig?.envOverlayValidationScript ??
      "scripts/local-edge/validate-env-overlays.ts";

    return {
      ok: true,
      artifact: {
        artifactsDir,
        name: lifecycleConfig?.setupArtifactName ?? "setup-last-run.txt",
      },
      customLoopbackHost: LocalEdgeCore_isCustomLoopbackHost(
        runtimeMethod.listenHost,
      )
        ? runtimeMethod.listenHost
        : null,
      envOverlayValidation: {
        command: "npx",
        args: [
          "tsx",
          LocalEdgeKit_lifecycleProjectPath({
            projectRoot: runtimeConfig.projectRoot,
            value: envOverlayValidationScript,
          }),
        ],
        timeoutMs: 30_000,
      },
      method,
      missingEnvWarningLines: (lifecycleConfig?.setupMissingEnvWarnings ?? [])
        .filter((warning) => (env[warning.envName] ?? "").length === 0)
        .map((warning) => warning.message),
      requiredUtilities: lifecycleConfig?.setupRequiredUtilities ?? [
        "bash",
        "lsof",
        "nohup",
        "npx",
      ],
      setupStrictStartEnvName,
      setupStrictStartEnvValue,
      startTimeoutWarningLine: startTimeoutValidation.ok
        ? null
        : startTimeoutValidation.message,
      writeArtifact: LocalEdgeCore_isTruthy(
        env.LOCAL_EDGE_STARTUP_CLI_SETUP_WRITE_ARTIFACT ?? "true",
      ),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      exitCode: 1,
      stderrLine: `[local-edge:setup] ${LocalEdgeKit_errorMessage(error)}\n`,
    };
  }
}

/** Resolves `startup-cli run start` env into a validated method start command plan. */
export function LocalEdgeKit_resolveStartRequest(options: {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
  projectRoot?: string | null | undefined;
}): LocalEdgeKit_StartRequestResult {
  const env = options.env ?? process.env;
  const method = env.LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD;
  if (method === undefined || method.length === 0) {
    return {
      ok: false,
      exitCode: 2,
      stderrLine:
        "[local-edge:start] Missing LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD.\n",
    };
  }

  const scriptName = LocalEdgeKit_startScriptNameForMethod(method);
  if (scriptName === null) {
    return {
      ok: false,
      exitCode: 2,
      stderrLine: `[local-edge:start] Unsupported --method '${LocalEdgeKit_messageWord(method)}'.\n`,
    };
  }

  try {
    const projectRoot = LocalEdgeKit_resolveProjectRoot({
      config: options.config,
      env,
      projectRoot: options.projectRoot,
    });
    return {
      ok: true,
      command: {
        command: "bash",
        args: [
          LocalEdgeKit_lifecycleImplementationPath({
            config: options.config,
            projectRoot,
            scriptName,
          }),
        ],
        timeoutMs: 120_000,
      },
      method,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      exitCode: 1,
      stderrLine: `[local-edge:start] ERROR: ${LocalEdgeKit_errorMessage(error)}\n`,
    };
  }
}

/** Resolves `startup-cli run ensure-running` env into a validated lifecycle request. */
export function LocalEdgeKit_resolveEnsureRunningRequest(options: {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
  projectRoot?: string | null | undefined;
}): LocalEdgeKit_EnsureRunningRequestResult {
  const env = options.env ?? process.env;
  const method = env.LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD;
  if (method === undefined || method.length === 0) {
    return {
      ok: false,
      exitCode: 2,
      stderrLine:
        "[local-edge:ensure-running] Missing LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD.\n",
    };
  }

  try {
    const runtimeConfig = LocalEdgeKit_resolveRuntimeConfig({
      config: options.config,
      env,
      projectRoot: options.projectRoot,
    });
    if (!runtimeConfig.configuredMethods.includes(method)) {
      const methodsEnvName =
        options.config.env?.methodsEnvName ?? "LOCAL_EDGE_METHODS";
      return {
        ok: false,
        exitCode: 1,
        stderrLine: `[local-edge:ensure-running] ERROR: Method '${LocalEdgeKit_messageWord(method)}' is not enabled by ${methodsEnvName}.\n`,
      };
    }

    let realm = runtimeConfig.realmSlug;
    if (env.LOCAL_EDGE_STARTUP_CLI_ENSURE_REALM_WAS_SET === "1") {
      realm = env.LOCAL_EDGE_STARTUP_CLI_ENSURE_REALM_VALUE ?? realm;
    }
    if (realm.length === 0) {
      realm = runtimeConfig.realmSlug;
    }
    const lifecycleConfig = options.config.lifecycle;
    const runtimeMethod = LocalEdgeKit_getRuntimeMethod({
      commandLabel: "local-edge:ensure-running",
      runtimeConfig,
      method,
    });
    const implementationPath = (scriptName: string): string =>
      LocalEdgeKit_lifecycleImplementationPath({
        config: options.config,
        projectRoot: runtimeConfig.projectRoot,
        scriptName,
      });
    const startupCliScriptPath = implementationPath(
      path.join("startup-cli", "local-edge-startup-cli.ts"),
    );
    const routerProbeSurfaceId =
      lifecycleConfig?.ensureRouterProbeSurfaceId ??
      options.config.runtimeLaunch?.startupUrlSurfaceIds?.[0] ??
      options.config.surfaces[0]?.id;
    if (routerProbeSurfaceId === undefined) {
      return {
        ok: false,
        exitCode: 1,
        stderrLine:
          "[local-edge:ensure-running] ERROR: No surface is configured for router health probing.\n",
      };
    }
    const routerProbeHost = [
      routerProbeSurfaceId,
      realm,
      runtimeMethod.method,
      runtimeConfig.developerSlug,
      runtimeConfig.rootZone,
    ].join(".");
    const routerHealthPath =
      options.config.render?.routerIngress.healthPath ??
      "/__local-edge/router-health";

    return {
      ok: true,
      commands: {
        render: {
          command: "npx",
          args: ["tsx", implementationPath("render.ts"), "--method", method],
          timeoutMs: 120_000,
        },
        setup: {
          command: "npx",
          args: [
            "tsx",
            startupCliScriptPath,
            "run",
            "setup",
            "--",
            "--method",
            method,
          ],
          timeoutMs: 120_000,
        },
        start: {
          command: "bash",
          args: [implementationPath("start-nginx-docker.sh")],
          env: {
            LOCAL_EDGE_SKIP_RENDER: "true",
            LOCAL_EDGE_SKIP_SETUP: "true",
          },
          timeoutMs: 120_000,
        },
        statusRequireRunning: {
          command: "npx",
          args: [
            "tsx",
            implementationPath("status.ts"),
            "--method",
            method,
            "--require-running",
          ],
          timeoutMs: 30_000,
        },
        stop: {
          command: "npx",
          args: [
            "tsx",
            startupCliScriptPath,
            "run",
            "stop",
            "--",
            "--method",
            method,
          ],
          timeoutMs: 120_000,
        },
      },
      configuredMethods: runtimeConfig.configuredMethods,
      forceRecreateIfRunning:
        env.LOCAL_EDGE_STARTUP_CLI_ENSURE_RECREATE === "1",
      method,
      realm,
      routerProbe: {
        connectTimeoutSeconds: LocalEdgeKit_parsePositiveIntegerEnv({
          defaultValue: 3,
          env,
          key: "LOCAL_EDGE_ROUTER_PROBE_CONNECT_TIMEOUT_SECONDS",
        }),
        maxTimeSeconds: LocalEdgeKit_parsePositiveIntegerEnv({
          defaultValue: 6,
          env,
          key: "LOCAL_EDGE_ROUTER_PROBE_MAX_TIME_SECONDS",
        }),
        url: LocalEdgeCore_formatHttpsUrl({
          host: routerProbeHost,
          port: runtimeMethod.listenPort,
          requestPath: routerHealthPath,
        }),
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      exitCode: 1,
      stderrLine: `[local-edge:ensure-running] ERROR: ${LocalEdgeKit_errorMessage(error)}\n`,
    };
  }
}

/** Runs one package-planned host command and returns a process-style exit code. */
export function LocalEdgeKit_runHostCommandPlan(
  options: LocalEdgeKit_RunHostCommandPlanOptions,
): number {
  const env =
    options.plan.env === undefined
      ? options.env
      : { ...options.env, ...options.plan.env };
  const result = spawnSync(options.plan.command, [...options.plan.args], {
    env,
    stdio:
      options.stdio === "inherit" ? "inherit" : ["ignore", "ignore", "ignore"],
    timeout: options.plan.timeoutMs,
  });
  return result.status ?? 1;
}

function LocalEdgeKit_defaultInitLifecycleHooks(): LocalEdgeKit_InitLifecycleHooks {
  return {
    copyFile: copyFileSync,
    exists: existsSync,
    loadEnvFile: (options): void => {
      if (!existsSync(options.envFilePath)) {
        return;
      }
      const content = readFileSync(options.envFilePath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (
          trimmed.length === 0 ||
          trimmed.startsWith("#") ||
          !trimmed.includes("=")
        ) {
          continue;
        }
        const equalsIndex = trimmed.indexOf("=");
        const key = trimmed.slice(0, equalsIndex);
        const value = trimmed
          .slice(equalsIndex + 1)
          .replace(/^["']|["']$/g, "");
        options.env[key] = value;
      }
    },
    promptDeveloperSlug: (options): Promise<string> =>
      Promise.resolve(
        options.promptDefault.length > 0
          ? options.promptDefault
          : LocalEdgeCore_slugifySegment(
              options.currentSlug.length > 0
                ? options.currentSlug
                : (options.env.USER ?? "dev"),
            ),
      ),
    readText: (filePath: string): string => readFileSync(filePath, "utf-8"),
    writeText: (filePath: string, content: string): void => {
      writeFileSync(filePath, content);
    },
  };
}

function LocalEdgeKit_resolveInitLifecycleHooks(
  hooks: Partial<LocalEdgeKit_InitLifecycleHooks> | undefined,
): LocalEdgeKit_InitLifecycleHooks {
  const defaults = LocalEdgeKit_defaultInitLifecycleHooks();
  return {
    copyFile: hooks?.copyFile ?? defaults.copyFile,
    exists: hooks?.exists ?? defaults.exists,
    loadEnvFile: hooks?.loadEnvFile ?? defaults.loadEnvFile,
    promptDeveloperSlug:
      hooks?.promptDeveloperSlug ?? defaults.promptDeveloperSlug,
    readText: hooks?.readText ?? defaults.readText,
    writeText: hooks?.writeText ?? defaults.writeText,
  };
}

function LocalEdgeKit_initEnvNames(
  config: LocalEdgeKit_Config,
): LocalEdgeKit_InitEnvNames {
  const nginxDockerMethod = config.router.methods.find(
    (method) => method.method === "nginx-docker",
  );
  return {
    developerSlug:
      config.env?.developerSlugEnvName ?? "LOCAL_EDGE_DEVELOPER_SLUG",
    envSlug: config.env?.realmSlugEnvName ?? "LOCAL_EDGE_ENV_SLUG",
    exposureMode:
      config.lifecycle?.initExposureModeEnvName ?? "LOCAL_EDGE_EXPOSURE_MODE",
    healthMonitorMethod:
      config.runtimeLaunch?.backgroundHealth?.methodEnvName ??
      "LOCAL_EDGE_HEALTH_MONITOR_METHOD",
    identityLabel:
      config.lifecycle?.initIdentitySurfaceLabelEnvName ??
      "LOCAL_EDGE_IDENTITY_SURFACE_LABEL",
    methodsCsv: config.env?.methodsEnvName ?? "LOCAL_EDGE_METHODS",
    nginxDockerHost:
      nginxDockerMethod?.listenHostEnvName ?? "LOCAL_EDGE_NGINX_DOCKER_HOST",
    primaryMethod:
      config.env?.primaryMethodEnvName ?? "LOCAL_EDGE_PRIMARY_METHOD",
    rootZone: config.env?.rootZoneEnvName ?? "LOCAL_EDGE_ROOT_ZONE",
    runtimeAuditMethod:
      config.runtimeLaunch?.runtimeAudit?.methodEnvName ??
      "LOCAL_EDGE_RUNTIME_AUDIT_METHOD",
    splitDnsNginxDockerIp:
      config.dnsAudit?.methodIpEnvNames?.["nginx-docker"] ??
      "LOCAL_EDGE_SPLIT_DNS_NGINX_DOCKER_IP",
  };
}

function LocalEdgeKit_initReadEnvValue(options: {
  content: string;
  key: string;
}): string {
  const prefix = `${options.key}=`;
  let lastMatch = "";

  for (const line of options.content.split("\n")) {
    if (line.startsWith(prefix)) {
      lastMatch = line.slice(prefix.length);
    }
  }

  return lastMatch.replace(/^["']|["']$/g, "");
}

function LocalEdgeKit_initUpsertEnvValue(options: {
  content: string;
  key: string;
  value: string;
}): string {
  const lines = options.content.split("\n");
  const prefix = `${options.key}=`;
  let replaced = false;
  const result: string[] = [];

  for (const line of lines) {
    if (line.startsWith(prefix)) {
      if (!replaced) {
        result.push(`${options.key}=${options.value}`);
        replaced = true;
      }
    } else {
      result.push(line);
    }
  }

  if (!replaced) {
    result.push(`${options.key}=${options.value}`);
  }

  return result.join("\n");
}

function LocalEdgeKit_initRemoveEnvKey(options: {
  content: string;
  key: string;
}): string {
  const prefix = `${options.key}=`;
  return options.content
    .split("\n")
    .filter((line) => !line.startsWith(prefix))
    .join("\n");
}

function LocalEdgeKit_initMethodInCsv(options: {
  csv: string;
  needle: string;
}): boolean {
  for (const token of options.csv.split(",")) {
    if (token === options.needle) {
      return true;
    }
  }
  return false;
}

function LocalEdgeKit_initSupportedMethods(
  config: LocalEdgeKit_Config,
): readonly string[] {
  return config.router.methods.map((method) => method.method);
}

function LocalEdgeKit_normalizeInitMethodsCsv(options: {
  config: LocalEdgeKit_Config;
  rawCsv: string;
}): string {
  const supportedMethods = LocalEdgeKit_initSupportedMethods(options.config);
  const defaultMethod = options.config.router.primaryMethod;
  const tokens = options.rawCsv
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const normalized: string[] = [];

  for (const method of tokens) {
    if (!supportedMethods.includes(method)) {
      continue;
    }
    if (normalized.includes(method)) {
      continue;
    }
    normalized.push(method);
  }

  if (normalized.length === 0) {
    return defaultMethod;
  }

  if (normalized.length === 1) {
    return normalized[0] ?? defaultMethod;
  }

  if (
    LocalEdgeKit_initMethodInCsv({
      needle: defaultMethod,
      csv: normalized.join(","),
    })
  ) {
    return defaultMethod;
  }

  return normalized[0] ?? defaultMethod;
}

function LocalEdgeKit_chooseInitPrimaryMethod(options: {
  candidate: string;
  config: LocalEdgeKit_Config;
  methodsCsv: string;
}): string {
  const supportedMethods = LocalEdgeKit_initSupportedMethods(options.config);
  const defaultMethod = options.config.router.primaryMethod;

  if (
    options.candidate.length > 0 &&
    supportedMethods.includes(options.candidate) &&
    LocalEdgeKit_initMethodInCsv({
      needle: options.candidate,
      csv: options.methodsCsv,
    })
  ) {
    return options.candidate;
  }

  if (
    LocalEdgeKit_initMethodInCsv({
      needle: defaultMethod,
      csv: options.methodsCsv,
    })
  ) {
    return defaultMethod;
  }

  const first = options.methodsCsv.split(",")[0];
  if (first !== undefined && first.length > 0) {
    return first;
  }

  return defaultMethod;
}

function LocalEdgeKit_normalizeInitOptionalMethodScope(options: {
  config: LocalEdgeKit_Config;
  current: string;
  methodsCsv: string;
  primaryMethod: string;
}): string {
  if (options.current.length === 0 || options.current === "all") {
    return "";
  }

  const supportedMethods = LocalEdgeKit_initSupportedMethods(options.config);
  if (!supportedMethods.includes(options.current)) {
    return "";
  }

  if (
    LocalEdgeKit_initMethodInCsv({
      needle: options.current,
      csv: options.methodsCsv,
    })
  ) {
    if (options.current === options.primaryMethod) {
      return "";
    }
    return options.current;
  }

  return "";
}

function LocalEdgeKit_initDefaultNginxDockerListenHost(
  config: LocalEdgeKit_Config,
): string {
  const nginxDockerMethod = config.router.methods.find(
    (method) => method.method === "nginx-docker",
  );
  return nginxDockerMethod?.defaultListenHost ?? "127.0.0.1";
}

function LocalEdgeKit_chooseDefaultDeveloperSlugForPrompt(options: {
  config: LocalEdgeKit_Config;
  currentSlug: string;
  env: NodeJS.ProcessEnv;
}): string {
  const currentNormalized = LocalEdgeCore_slugifySegment(options.currentSlug);
  const fallbackFromUser = LocalEdgeCore_slugifySegment(
    options.env.USER ?? options.config.identity.defaultDeveloperSlug,
  );
  const rejected = new Set(
    options.config.lifecycle?.initDeveloperSlugPromptRejectedDefaults ?? [
      "default",
    ],
  );

  if (
    options.currentSlug.length > 0 &&
    !rejected.has(currentNormalized) &&
    currentNormalized !== "default"
  ) {
    return currentNormalized;
  }

  if (!rejected.has(fallbackFromUser) && fallbackFromUser !== "default") {
    return fallbackFromUser;
  }

  return "";
}

async function LocalEdgeKit_resolveInitValues(options: {
  config: LocalEdgeKit_Config;
  currentValues: LocalEdgeKit_InitResolvedValues;
  developerSlugOverride: string;
  env: NodeJS.ProcessEnv;
  hooks: LocalEdgeKit_InitLifecycleHooks;
  isStdinTty: boolean;
  promptDeveloperSlug: LocalEdgeKit_InitRequest["promptDeveloperSlug"];
}): Promise<LocalEdgeKit_InitResolvedValues> {
  const { config, currentValues } = options;
  let developerSlug: string;

  if (options.developerSlugOverride.length > 0) {
    developerSlug = LocalEdgeCore_slugifySegment(options.developerSlugOverride);
  } else {
    const shouldPrompt =
      options.promptDeveloperSlug === "true" ||
      (options.promptDeveloperSlug === "auto" && options.isStdinTty);

    if (shouldPrompt) {
      developerSlug = await options.hooks.promptDeveloperSlug({
        currentSlug: currentValues.developerSlug,
        env: options.env,
        promptDefault: LocalEdgeKit_chooseDefaultDeveloperSlugForPrompt({
          config,
          currentSlug: currentValues.developerSlug,
          env: options.env,
        }),
      });
    } else {
      developerSlug = LocalEdgeCore_slugifySegment(
        currentValues.developerSlug.length > 0
          ? currentValues.developerSlug
          : (options.env.USER ?? config.identity.defaultDeveloperSlug),
      );
    }
  }

  const envSlug = LocalEdgeCore_slugifySegment(
    currentValues.envSlug.length > 0
      ? currentValues.envSlug
      : config.identity.defaultRealmSlug,
  );
  const methodsCsv = LocalEdgeKit_normalizeInitMethodsCsv({
    config,
    rawCsv:
      currentValues.methodsCsv.length > 0
        ? currentValues.methodsCsv
        : config.router.primaryMethod,
  });
  const primaryMethod = LocalEdgeKit_chooseInitPrimaryMethod({
    candidate: currentValues.primaryMethod,
    config,
    methodsCsv,
  });
  const rootZone =
    currentValues.rootZone.length > 0
      ? currentValues.rootZone
      : config.identity.defaultRootZone;
  const identityLabel =
    currentValues.identityLabel.length > 0
      ? currentValues.identityLabel
      : (config.lifecycle?.initDefaultIdentitySurfaceLabel ?? "default");
  const exposureMode =
    currentValues.exposureMode.length > 0
      ? currentValues.exposureMode
      : (config.lifecycle?.initDefaultExposureMode ?? "split-dns");
  const nginxDockerHost =
    currentValues.nginxDockerHost.length > 0
      ? currentValues.nginxDockerHost
      : LocalEdgeKit_initDefaultNginxDockerListenHost(config);
  const splitDnsNginxDockerIp =
    currentValues.splitDnsNginxDockerIp.length > 0
      ? currentValues.splitDnsNginxDockerIp
      : nginxDockerHost;

  return {
    developerSlug,
    envSlug,
    exposureMode,
    healthMonitorMethod: LocalEdgeKit_normalizeInitOptionalMethodScope({
      config,
      current: currentValues.healthMonitorMethod,
      methodsCsv,
      primaryMethod,
    }),
    identityLabel,
    methodsCsv,
    nginxDockerHost,
    primaryMethod,
    rootZone,
    runtimeAuditMethod: LocalEdgeKit_normalizeInitOptionalMethodScope({
      config,
      current: currentValues.runtimeAuditMethod,
      methodsCsv,
      primaryMethod,
    }),
    splitDnsNginxDockerIp,
  };
}

function LocalEdgeKit_readInitCurrentValues(options: {
  content: string;
  envNames: LocalEdgeKit_InitEnvNames;
}): LocalEdgeKit_InitResolvedValues {
  const { content, envNames } = options;
  return {
    developerSlug: LocalEdgeKit_initReadEnvValue({
      content,
      key: envNames.developerSlug,
    }),
    envSlug: LocalEdgeKit_initReadEnvValue({
      content,
      key: envNames.envSlug,
    }),
    exposureMode: LocalEdgeKit_initReadEnvValue({
      content,
      key: envNames.exposureMode,
    }),
    healthMonitorMethod: LocalEdgeKit_initReadEnvValue({
      content,
      key: envNames.healthMonitorMethod,
    }),
    identityLabel: LocalEdgeKit_initReadEnvValue({
      content,
      key: envNames.identityLabel,
    }),
    methodsCsv: LocalEdgeKit_initReadEnvValue({
      content,
      key: envNames.methodsCsv,
    }),
    nginxDockerHost: LocalEdgeKit_initReadEnvValue({
      content,
      key: envNames.nginxDockerHost,
    }),
    primaryMethod: LocalEdgeKit_initReadEnvValue({
      content,
      key: envNames.primaryMethod,
    }),
    rootZone: LocalEdgeKit_initReadEnvValue({
      content,
      key: envNames.rootZone,
    }),
    runtimeAuditMethod: LocalEdgeKit_initReadEnvValue({
      content,
      key: envNames.runtimeAuditMethod,
    }),
    splitDnsNginxDockerIp: LocalEdgeKit_initReadEnvValue({
      content,
      key: envNames.splitDnsNginxDockerIp,
    }),
  };
}

function LocalEdgeKit_printInitTargetValues(options: {
  envNames: LocalEdgeKit_InitEnvNames;
  loggers: LocalEdgeKit_SetupLifecycleLoggers;
  values: LocalEdgeKit_InitResolvedValues;
}): void {
  const { envNames, loggers, values } = options;
  loggers.info("Target values:");
  loggers.info(`  ${envNames.developerSlug}=${values.developerSlug}`);
  loggers.info(`  ${envNames.envSlug}=${values.envSlug}`);
  loggers.info(`  ${envNames.methodsCsv}=${values.methodsCsv}`);
  loggers.info(`  ${envNames.primaryMethod}=${values.primaryMethod}`);
  loggers.info(`  ${envNames.rootZone}=${values.rootZone}`);
  loggers.info(`  ${envNames.identityLabel}=${values.identityLabel}`);
  loggers.info(`  ${envNames.exposureMode}=${values.exposureMode}`);
  loggers.info(`  ${envNames.nginxDockerHost}=${values.nginxDockerHost}`);
  loggers.info(
    `  ${envNames.splitDnsNginxDockerIp}=${values.splitDnsNginxDockerIp}`,
  );
  loggers.info(
    `  ${envNames.healthMonitorMethod}=${values.healthMonitorMethod.length > 0 ? values.healthMonitorMethod : "<inherit primary>"}`,
  );
  loggers.info(
    `  ${envNames.runtimeAuditMethod}=${values.runtimeAuditMethod.length > 0 ? values.runtimeAuditMethod : "<inherit primary>"}`,
  );
}

function LocalEdgeKit_writeInitResolvedValues(options: {
  deprecatedEnvNames: readonly string[];
  envFile: string;
  envNames: LocalEdgeKit_InitEnvNames;
  hooks: LocalEdgeKit_InitLifecycleHooks;
  loggers: LocalEdgeKit_SetupLifecycleLoggers;
  values: LocalEdgeKit_InitResolvedValues;
  writeChanges: boolean;
}): void {
  if (!options.writeChanges) {
    options.loggers.info("DRY-RUN: no file changes were written.");
    return;
  }

  const { envNames, values } = options;
  let content = options.hooks.readText(options.envFile);
  content = LocalEdgeKit_initUpsertEnvValue({
    content,
    key: envNames.developerSlug,
    value: values.developerSlug,
  });
  content = LocalEdgeKit_initUpsertEnvValue({
    content,
    key: envNames.envSlug,
    value: values.envSlug,
  });
  content = LocalEdgeKit_initUpsertEnvValue({
    content,
    key: envNames.methodsCsv,
    value: values.methodsCsv,
  });
  content = LocalEdgeKit_initUpsertEnvValue({
    content,
    key: envNames.primaryMethod,
    value: values.primaryMethod,
  });
  content = LocalEdgeKit_initUpsertEnvValue({
    content,
    key: envNames.rootZone,
    value: values.rootZone,
  });
  content = LocalEdgeKit_initUpsertEnvValue({
    content,
    key: envNames.identityLabel,
    value: values.identityLabel,
  });
  content = LocalEdgeKit_initUpsertEnvValue({
    content,
    key: envNames.exposureMode,
    value: values.exposureMode,
  });
  content = LocalEdgeKit_initUpsertEnvValue({
    content,
    key: envNames.nginxDockerHost,
    value: values.nginxDockerHost,
  });
  content = LocalEdgeKit_initUpsertEnvValue({
    content,
    key: envNames.splitDnsNginxDockerIp,
    value: values.splitDnsNginxDockerIp,
  });

  if (values.healthMonitorMethod.length > 0) {
    content = LocalEdgeKit_initUpsertEnvValue({
      content,
      key: envNames.healthMonitorMethod,
      value: values.healthMonitorMethod,
    });
  } else {
    content = LocalEdgeKit_initRemoveEnvKey({
      content,
      key: envNames.healthMonitorMethod,
    });
  }

  if (values.runtimeAuditMethod.length > 0) {
    content = LocalEdgeKit_initUpsertEnvValue({
      content,
      key: envNames.runtimeAuditMethod,
      value: values.runtimeAuditMethod,
    });
  } else {
    content = LocalEdgeKit_initRemoveEnvKey({
      content,
      key: envNames.runtimeAuditMethod,
    });
  }

  for (const deprecatedKey of options.deprecatedEnvNames) {
    content = LocalEdgeKit_initRemoveEnvKey({ content, key: deprecatedKey });
  }

  options.hooks.writeText(options.envFile, content);
  options.loggers.info(`Updated env file: ${options.envFile}`);
}

function LocalEdgeKit_runInitPostWriteChecks(options: {
  env: NodeJS.ProcessEnv;
  envFileEnvName: string;
  envFile: string;
  executeHostCommandPlan: (
    options: LocalEdgeKit_RunHostCommandPlanOptions,
  ) => number;
  hooks: LocalEdgeKit_InitLifecycleHooks;
  loggers: LocalEdgeKit_SetupLifecycleLoggers;
  postWriteCommands: LocalEdgeKit_InitRequest["postWriteCommands"];
  runBootstrap: boolean;
  runChecks: boolean;
}): number {
  if (!options.runChecks) {
    options.loggers.info("Skipping setup checks (--no-checks).");
    return 0;
  }

  options.env[options.envFileEnvName] = options.envFile;
  options.hooks.loadEnvFile({
    env: options.env,
    envFilePath: options.envFile,
  });

  if (options.runBootstrap) {
    options.loggers.info("Running centralized bootstrap...");
    const bootstrapStatus = options.executeHostCommandPlan({
      env: options.env,
      plan: options.postWriteCommands.bootstrap,
      stdio: "inherit",
    });
    if (bootstrapStatus !== 0) {
      return bootstrapStatus;
    }
  } else {
    options.loggers.info("Running render + setup validation...");

    const renderStatus = options.executeHostCommandPlan({
      env: options.env,
      plan: options.postWriteCommands.render,
      stdio: "inherit",
    });
    if (renderStatus !== 0) {
      return renderStatus;
    }

    const setupStatus = options.executeHostCommandPlan({
      env: options.env,
      plan: options.postWriteCommands.setup,
      stdio: "inherit",
    });
    if (setupStatus !== 0) {
      return setupStatus;
    }
  }

  options.loggers.info("Effective config snapshot:");
  const configPrintStatus = options.executeHostCommandPlan({
    env: options.env,
    plan: options.postWriteCommands.configPrint,
    stdio: "inherit",
  });
  if (configPrintStatus !== 0) {
    options.loggers.warn("config-print exited with non-zero status.");
  }

  options.loggers.info("Completed.");
  return 0;
}

/** Runs init env file creation, normalization, optional checks, and config snapshot printing. */
export async function LocalEdgeKit_runInitLifecycle(
  options: LocalEdgeKit_RunInitLifecycleOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const stderr =
    options.stderr ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  const hooks = LocalEdgeKit_resolveInitLifecycleHooks(options.hooks);
  const loggers = LocalEdgeKit_resolveSetupLifecycleLoggers({
    env,
    loggers: options.loggers,
  });
  const executeHostCommandPlan =
    options.executeHostCommandPlan ?? LocalEdgeKit_runHostCommandPlan;
  const request = LocalEdgeKit_resolveInitRequest({
    config: options.config,
    env,
    projectRoot: options.projectRoot,
  });
  const envFile = request.envFilePath;
  const envTemplate = request.envTemplatePath;

  if (!hooks.exists(envFile)) {
    if (!hooks.exists(envTemplate)) {
      loggers.error(`Missing env template: ${envTemplate}`);
      return 1;
    }
    if (request.writeChanges) {
      hooks.copyFile(envTemplate, envFile);
      loggers.info(`Created env file from template: ${envFile}`);
    } else {
      loggers.info(`DRY-RUN would create env file: ${envFile}`);
    }
  }

  if (!hooks.exists(envFile)) {
    loggers.error(`Env file is required for initialization: ${envFile}`);
    return 1;
  }

  const envNames = LocalEdgeKit_initEnvNames(options.config);
  const currentValues = LocalEdgeKit_readInitCurrentValues({
    content: hooks.readText(envFile),
    envNames,
  });
  const values = await LocalEdgeKit_resolveInitValues({
    config: options.config,
    currentValues,
    developerSlugOverride: request.developerSlugOverride,
    env,
    hooks,
    isStdinTty: options.isStdinTty ?? Boolean(process.stdin.isTTY),
    promptDeveloperSlug: request.promptDeveloperSlug,
  });

  LocalEdgeKit_printInitTargetValues({ envNames, loggers, values });
  LocalEdgeKit_writeInitResolvedValues({
    deprecatedEnvNames: request.deprecatedEnvNames,
    envFile,
    envNames,
    hooks,
    loggers,
    values,
    writeChanges: request.writeChanges,
  });

  try {
    return LocalEdgeKit_runInitPostWriteChecks({
      env,
      envFileEnvName: request.envFileEnvName,
      envFile,
      executeHostCommandPlan,
      hooks,
      loggers,
      postWriteCommands: request.postWriteCommands,
      runBootstrap: request.runBootstrap,
      runChecks: request.runChecks,
    });
  } catch (error: unknown) {
    stderr(`${LocalEdgeKit_errorMessage(error)}\n`);
    return 1;
  }
}

/** Runs the method-specific start command resolved from startup env and config. */
export function LocalEdgeKit_runStartLifecycle(
  options: LocalEdgeKit_RunStartLifecycleOptions,
): number {
  const env = options.env ?? process.env;
  const stderr =
    options.stderr ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  const executeHostCommandPlan =
    options.executeHostCommandPlan ?? LocalEdgeKit_runHostCommandPlan;
  const request = LocalEdgeKit_resolveStartRequest({
    config: options.config,
    env,
    projectRoot: options.projectRoot,
  });
  if (!request.ok) {
    stderr(request.stderrLine);
    return request.exitCode;
  }

  return executeHostCommandPlan({
    env,
    plan: request.command,
    stdio: "inherit",
  });
}

function LocalEdgeKit_defaultSetupLifecycleHooks(): LocalEdgeKit_SetupLifecycleHooks {
  return {
    commandExists: LocalEdgeCore_commandExists,
    loopbackAliasExists: LocalEdgeCore_loopbackAliasExists,
    mkcertTrustDetected: LocalEdgeCore_mkcertTrustDetected,
    writeArtifact: LocalEdgeCore_writeArtifact,
  };
}

function LocalEdgeKit_resolveSetupLifecycleHooks(
  hooks: Partial<LocalEdgeKit_SetupLifecycleHooks> | undefined,
): LocalEdgeKit_SetupLifecycleHooks {
  const defaults = LocalEdgeKit_defaultSetupLifecycleHooks();
  return {
    commandExists: hooks?.commandExists ?? defaults.commandExists,
    loopbackAliasExists:
      hooks?.loopbackAliasExists ?? defaults.loopbackAliasExists,
    mkcertTrustDetected:
      hooks?.mkcertTrustDetected ?? defaults.mkcertTrustDetected,
    writeArtifact: hooks?.writeArtifact ?? defaults.writeArtifact,
  };
}

function LocalEdgeKit_defaultSetupLifecycleLoggers(options: {
  env: NodeJS.ProcessEnv;
}): LocalEdgeKit_SetupLifecycleLoggers {
  const colorEnabled = LocalEdgeCore_logColorEnabled({
    colorMode: options.env.LOCAL_EDGE_COLOR,
    formatterActive: false,
    isTtyStdout: Boolean(process.stdout.isTTY),
    noColor: options.env.NO_COLOR,
  });
  const logOptions = { colorEnabled };
  return {
    error: (message: string): void => {
      LocalEdgeCore_logError(message, logOptions);
    },
    info: (message: string): void => {
      LocalEdgeCore_logInfo(message, logOptions);
    },
    warn: (message: string): void => {
      LocalEdgeCore_logWarn(message, logOptions);
    },
  };
}

function LocalEdgeKit_resolveSetupLifecycleLoggers(options: {
  env: NodeJS.ProcessEnv;
  loggers: Partial<LocalEdgeKit_SetupLifecycleLoggers> | undefined;
}): LocalEdgeKit_SetupLifecycleLoggers {
  const defaults = LocalEdgeKit_defaultSetupLifecycleLoggers({
    env: options.env,
  });
  return {
    error: options.loggers?.error ?? defaults.error,
    info: options.loggers?.info ?? defaults.info,
    warn: options.loggers?.warn ?? defaults.warn,
  };
}

function LocalEdgeKit_validateSetupTlsMode(options: {
  hooks: LocalEdgeKit_SetupLifecycleHooks;
  loggers: LocalEdgeKit_SetupLifecycleLoggers;
  strict: boolean;
  tlsMode: string;
}): number | undefined {
  const { hooks, loggers, strict, tlsMode } = options;
  if (tlsMode === "mkcert") {
    if (!hooks.commandExists("mkcert")) {
      loggers.error("mkcert is required but not found.");
      if (strict) {
        return 1;
      }
      return undefined;
    }
    if (!hooks.mkcertTrustDetected()) {
      loggers.warn(
        "mkcert root CA trust not detected. Browser warnings will persist until trust is installed. Run: npm run local:edge:tls:trust",
      );
      if (strict) {
        return 1;
      }
      return undefined;
    }
    return undefined;
  }
  if (tlsMode !== "self-signed" && tlsMode !== "provided") {
    loggers.warn("Unsupported LOCAL_EDGE_TLS_MODE value. Use 'mkcert', 'self-signed' or 'provided'.");
    if (strict) {
      return 1;
    }
  }
  return undefined;
}

function LocalEdgeKit_defaultStopLifecycleHooks(): LocalEdgeKit_StopLifecycleHooks {
  return {
    isPortListening: LocalEdgeCore_isPortListening,
    runStopCommand: (options): void => {
      spawnSync("bash", ["-lc", options.command], {
        stdio: "inherit",
        timeout: 30_000,
      });
    },
    terminateListenersOnPort: LocalEdgeCore_terminateListenersOnPort,
    writeArtifact: LocalEdgeCore_writeArtifact,
  };
}

function LocalEdgeKit_resolveStopLifecycleHooks(
  hooks: Partial<LocalEdgeKit_StopLifecycleHooks> | undefined,
): LocalEdgeKit_StopLifecycleHooks {
  const defaults = LocalEdgeKit_defaultStopLifecycleHooks();
  return {
    isPortListening: hooks?.isPortListening ?? defaults.isPortListening,
    runStopCommand: hooks?.runStopCommand ?? defaults.runStopCommand,
    terminateListenersOnPort:
      hooks?.terminateListenersOnPort ?? defaults.terminateListenersOnPort,
    writeArtifact: hooks?.writeArtifact ?? defaults.writeArtifact,
  };
}

function LocalEdgeKit_stopLifecycleSleep(): void {
  spawnSync("sleep", ["1"], { stdio: "ignore", timeout: 2000 });
}

function LocalEdgeKit_waitForStopped(options: {
  hooks: LocalEdgeKit_StopLifecycleHooks;
  host: string;
  nowMs: () => number;
  port: number;
  sleep: () => void;
  timeoutSeconds: number;
}): boolean {
  const deadline = options.nowMs() + options.timeoutSeconds * 1000;
  while (options.nowMs() < deadline) {
    if (
      !options.hooks.isPortListening({
        port: options.port,
        host: options.host,
      })
    ) {
      return true;
    }
    options.sleep();
  }
  return !options.hooks.isPortListening({
    port: options.port,
    host: options.host,
  });
}

function LocalEdgeKit_stopMethod(options: {
  allowPortKill: boolean;
  hooks: LocalEdgeKit_StopLifecycleHooks;
  loggers: LocalEdgeKit_StopLifecycleLoggers;
  nowMs: () => number;
  plan: LocalEdgeKit_StopMethodPlan;
  sleep: () => void;
  timeoutSeconds: number;
}): boolean {
  const { plan } = options;
  const method = plan.method;
  const { port, listenHost } = plan;

  options.loggers.info(
    `Stopping method='${method}' on expected bind ${listenHost}:${String(port)}`,
  );

  options.hooks.runStopCommand({
    command: plan.stopCommand,
    logDir: plan.logDir,
    method,
  });

  if (
    LocalEdgeKit_waitForStopped({
      hooks: options.hooks,
      port,
      host: listenHost,
      timeoutSeconds: options.timeoutSeconds,
      nowMs: options.nowMs,
      sleep: options.sleep,
    })
  ) {
    options.hooks.writeArtifact({
      artifactsDir: plan.artifactsDir,
      name: `${method}.stopped`,
      content: `method=${method}\nhost=${listenHost}\nport=${String(port)}\nstatus=stopped\n`,
    });
    return true;
  }

  options.loggers.warn(
    `Method '${method}' is still listening on ${listenHost}:${String(port)} after stop command.`,
  );

  if (options.allowPortKill) {
    options.hooks.terminateListenersOnPort(port);

    if (
      LocalEdgeKit_waitForStopped({
        hooks: options.hooks,
        port,
        host: listenHost,
        timeoutSeconds: options.timeoutSeconds,
        nowMs: options.nowMs,
        sleep: options.sleep,
      })
    ) {
      options.hooks.writeArtifact({
        artifactsDir: plan.artifactsDir,
        name: `${method}.stopped`,
        content: `method=${method}\nhost=${listenHost}\nport=${String(port)}\nstatus=stopped-after-force-kill\n`,
      });
      return true;
    }
  }

  options.loggers.warn(
    `Unable to stop method '${method}' on ${listenHost}:${String(port)}.`,
  );
  return false;
}

/** Runs setup prerequisite validation, env-overlay validation, and optional artifact writing. */
export function LocalEdgeKit_runSetupLifecycle(
  options: LocalEdgeKit_RunSetupLifecycleOptions,
): number {
  const env = options.env ?? process.env;
  const stdout =
    options.stdout ??
    ((line: string): void => {
      process.stdout.write(line);
    });
  const stderr =
    options.stderr ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  const executeHostCommandPlan =
    options.executeHostCommandPlan ?? LocalEdgeKit_runHostCommandPlan;
  const hooks = LocalEdgeKit_resolveSetupLifecycleHooks(options.hooks);
  const loggers = LocalEdgeKit_resolveSetupLifecycleLoggers({
    env,
    loggers: options.loggers,
  });

  const request = LocalEdgeKit_resolveSetupRequest({
    config: options.config,
    env,
    projectRoot: options.projectRoot,
  });
  if (!request.ok) {
    stderr(request.stderrLine);
    return request.exitCode;
  }

  const { method } = request;
  const strict = LocalEdgeCore_shouldFailHard(env);

  if (request.setupStrictStartEnvValue !== null) {
    env[request.setupStrictStartEnvName] = request.setupStrictStartEnvValue;
  }

  for (const util of request.requiredUtilities) {
    if (!hooks.commandExists(util)) {
      loggers.warn(`Required utility not found: ${util}`);
      if (strict) {
        return 1;
      }
    }
  }

  const tlsMode = (env.LOCAL_EDGE_TLS_MODE ?? "mkcert").toLowerCase();
  const tlsExit = LocalEdgeKit_validateSetupTlsMode({
    hooks,
    loggers,
    strict,
    tlsMode,
  });
  if (tlsExit !== undefined) {
    return tlsExit;
  }

  if (request.startTimeoutWarningLine !== null) {
    loggers.warn(request.startTimeoutWarningLine);
  }

  for (const warningLine of request.missingEnvWarningLines) {
    loggers.warn(warningLine);
  }

  if (request.customLoopbackHost !== null) {
    if (!hooks.loopbackAliasExists(request.customLoopbackHost)) {
      loggers.error(
        `Custom loopback alias ${request.customLoopbackHost} is required for ${method} but is not configured.`,
      );
      loggers.error("Run once: npm run local:edge:loopback:alias:apply");
      return 1;
    }
  }

  loggers.info(`Validating setup for method='${method}'`);

  const envOverlayStatus = executeHostCommandPlan({
    env,
    plan: request.envOverlayValidation,
    stdio: "inherit",
  });
  if (envOverlayStatus !== 0) {
    loggers.error("Canonical env overlay validation failed.");
    return 1;
  }

  if (request.writeArtifact) {
    const runAt = (options.now ?? (() => new Date()))().toISOString();
    hooks.writeArtifact({
      artifactsDir: request.artifact.artifactsDir,
      name: request.artifact.name,
      content: `runAt=${runAt}\nmethod=${method}\nstrict=${env.LOCAL_EDGE_STRICT_START ?? "false"}\nstatus=ok\n`,
    });
  }

  stdout("[local-edge:setup] Setup validation completed.\n");
  return 0;
}

/** Runs stop commands, waits for listen tuples to clear, and writes stop artifacts. */
export function LocalEdgeKit_runStopLifecycle(
  options: LocalEdgeKit_RunStopLifecycleOptions,
): number {
  const env = options.env ?? process.env;
  const stdout =
    options.stdout ??
    ((line: string): void => {
      process.stdout.write(line);
    });
  const stderr =
    options.stderr ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  const hooks = LocalEdgeKit_resolveStopLifecycleHooks(options.hooks);
  const loggers = LocalEdgeKit_resolveSetupLifecycleLoggers({
    env,
    loggers: options.loggers,
  });
  const request = LocalEdgeKit_resolveStopRequest({
    config: options.config,
    env,
    projectRoot: options.projectRoot,
  });
  if (!request.ok) {
    stderr(request.stderrLine);
    return request.exitCode;
  }

  if (request.timeoutWarningLine !== null) {
    loggers.warn(request.timeoutWarningLine);
  }

  let hasFailure = false;
  const nowMs = options.nowMs ?? Date.now;
  const sleep = options.sleep ?? LocalEdgeKit_stopLifecycleSleep;

  for (const plan of request.methodPlans) {
    if (
      !LocalEdgeKit_stopMethod({
        allowPortKill: request.allowPortKill,
        hooks,
        loggers,
        nowMs,
        plan,
        sleep,
        timeoutSeconds: request.timeoutSeconds,
      })
    ) {
      hasFailure = true;
    }
  }

  if (hasFailure) {
    return 1;
  }

  stdout("[local-edge:stop] Completed.\n");
  return 0;
}

function LocalEdgeKit_doctorDefaultProcessIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function LocalEdgeKit_doctorRunTsx(options: {
  args: readonly string[];
  timeoutMs: number;
}): number {
  const result = spawnSync("npx", ["tsx", ...options.args], {
    stdio: "inherit",
    timeout: options.timeoutMs,
  });
  return result.status ?? 1;
}

function LocalEdgeKit_doctorRunCommandCapture(options: {
  args: readonly string[];
  command: string;
  timeoutMs: number;
}): LocalEdgeKit_DoctorCapturedCommandResult {
  const result = spawnSync(options.command, [...options.args], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: options.timeoutMs,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout?.toString("utf-8") ?? "",
  };
}

function LocalEdgeKit_defaultDoctorLifecycleHooks(): LocalEdgeKit_DoctorLifecycleHooks {
  return {
    commandExists: LocalEdgeCore_commandExists,
    exists: existsSync,
    processIsRunning: LocalEdgeKit_doctorDefaultProcessIsRunning,
    readText: (filePath: string): string => readFileSync(filePath, "utf-8"),
    runCommandCapture: LocalEdgeKit_doctorRunCommandCapture,
    runTsx: LocalEdgeKit_doctorRunTsx,
  };
}

function LocalEdgeKit_resolveDoctorLifecycleHooks(
  hooks: Partial<LocalEdgeKit_DoctorLifecycleHooks> | undefined,
): LocalEdgeKit_DoctorLifecycleHooks {
  const defaults = LocalEdgeKit_defaultDoctorLifecycleHooks();
  return {
    commandExists: hooks?.commandExists ?? defaults.commandExists,
    exists: hooks?.exists ?? defaults.exists,
    processIsRunning: hooks?.processIsRunning ?? defaults.processIsRunning,
    readText: hooks?.readText ?? defaults.readText,
    runCommandCapture: hooks?.runCommandCapture ?? defaults.runCommandCapture,
    runTsx: hooks?.runTsx ?? defaults.runTsx,
  };
}

function LocalEdgeKit_doctorLog(options: {
  message: string;
  stdout: (line: string) => void;
}): void {
  options.stdout(`${options.message}\n`);
}

function LocalEdgeKit_doctorRecordCheckResult(options: {
  checksRun: Set<string>;
  domain: string;
  failedDomains: Set<string>;
  status: number;
  stderr: (line: string) => void;
}): void {
  options.checksRun.add(options.domain);
  if (options.status === 0) {
    return;
  }
  options.failedDomains.add(options.domain);
  options.stderr(
    `[local-edge:doctor] WARNING ${options.domain} failed (exit=${options.status}).\n`,
  );
}

function LocalEdgeKit_doctorPushOptionalValueArg(options: {
  args: string[];
  flag: string;
  value: string | undefined;
}): void {
  if (options.value !== undefined && options.value.length > 0) {
    options.args.push(options.flag, options.value);
  }
}

function LocalEdgeKit_doctorVerifyRootWorkspaceRegistrationIfActive(options: {
  hooks: LocalEdgeKit_DoctorLifecycleHooks;
  paths: LocalEdgeKit_DoctorRequest["paths"];
  projectRoot: string;
  realm: string;
  stdout: (line: string) => void;
}): void {
  if (!options.hooks.exists(options.paths.sessionPidPath)) {
    return;
  }

  const pidContent = options.hooks
    .readText(options.paths.sessionPidPath)
    .trim();
  const sessionPid = Number.parseInt(pidContent, 10);
  if (!Number.isFinite(sessionPid)) {
    return;
  }

  if (!options.hooks.processIsRunning(sessionPid)) {
    return;
  }

  LocalEdgeKit_doctorLog({
    stdout: options.stdout,
    message:
      "[local-edge:doctor] Active npm run local session detected. Verifying root-workspace realm registration...",
  });
  options.hooks.runTsx({
    args: [
      options.paths.doctorCoreScriptPath,
      "verify-root-workspace",
      "--registry",
      options.paths.registryPath,
      "--workspace",
      options.projectRoot,
      "--realm",
      options.realm,
    ],
    timeoutMs: 30_000,
  });
}

function LocalEdgeKit_doctorPrintRenderArtifactFreshness(options: {
  hooks: LocalEdgeKit_DoctorLifecycleHooks;
  paths: LocalEdgeKit_DoctorRequest["paths"];
  stdout: (line: string) => void;
}): void {
  LocalEdgeKit_doctorLog({
    stdout: options.stdout,
    message: "[local-edge:doctor] Inspecting render artifact freshness...",
  });
  if (!options.hooks.exists(options.paths.renderArtifactPath)) {
    LocalEdgeKit_doctorLog({
      stdout: options.stdout,
      message: `[local-edge:doctor] WARNING: Render artifact is missing at ${options.paths.renderArtifactPath}`,
    });
    return;
  }

  options.hooks.runTsx({
    args: [
      options.paths.doctorCoreScriptPath,
      "print-render-line",
      "--path",
      options.paths.renderArtifactPath,
    ],
    timeoutMs: 30_000,
  });
}

function LocalEdgeKit_doctorPrintTlsSanCoverage(options: {
  hooks: LocalEdgeKit_DoctorLifecycleHooks;
  paths: LocalEdgeKit_DoctorRequest["paths"];
  stdout: (line: string) => void;
}): void {
  LocalEdgeKit_doctorLog({
    stdout: options.stdout,
    message:
      "[local-edge:doctor] Inspecting TLS SAN coverage for active realms...",
  });
  if (
    !options.hooks.exists(options.paths.tlsCertPath) ||
    !options.hooks.commandExists("openssl") ||
    !options.hooks.exists(options.paths.registryPath)
  ) {
    LocalEdgeKit_doctorLog({
      stdout: options.stdout,
      message:
        "[local-edge:doctor] WARNING: TLS SAN verification skipped (missing cert, registry, or openssl).",
    });
    return;
  }

  const certTextResult = options.hooks.runCommandCapture({
    command: "openssl",
    args: ["x509", "-in", options.paths.tlsCertPath, "-noout", "-text"],
    timeoutMs: 10_000,
  });
  const certificateText =
    certTextResult.status === 0 ? certTextResult.stdout : "";

  const wildcardResult = options.hooks.runCommandCapture({
    command: "npx",
    args: [
      "tsx",
      options.paths.doctorCoreScriptPath,
      "print-tls-wildcards",
      "--path",
      options.paths.registryPath,
    ],
    timeoutMs: 10_000,
  });

  if (wildcardResult.status !== 0) {
    return;
  }

  const wildcards = wildcardResult.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0);

  for (const wildcard of wildcards) {
    if (certificateText.includes(`DNS:${wildcard}`)) {
      LocalEdgeKit_doctorLog({
        stdout: options.stdout,
        message: `[local-edge:doctor] OK tls-san ${wildcard}`,
      });
    } else {
      LocalEdgeKit_doctorLog({
        stdout: options.stdout,
        message: `[local-edge:doctor] WARNING missing TLS SAN coverage for ${wildcard}`,
      });
    }
  }
}

/** Runs the full doctor diagnostic sequence from config plans and injectable host hooks. */
export function LocalEdgeKit_runDoctorLifecycle(
  options: LocalEdgeKit_RunDoctorLifecycleOptions,
): number {
  const env = options.env ?? process.env;
  const stdout =
    options.stdout ??
    ((line: string): void => {
      process.stdout.write(line);
    });
  const stderr =
    options.stderr ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  const hooks = LocalEdgeKit_resolveDoctorLifecycleHooks(options.hooks);
  const request = LocalEdgeKit_resolveDoctorRequest({
    config: options.config,
    env,
    projectRoot: options.projectRoot,
  });
  const { method, strict } = request;
  const failedDomains = new Set<string>();
  const checksRun = new Set<string>();

  if (!request.skipRender) {
    LocalEdgeKit_doctorLog({
      stdout,
      message: `[local-edge:doctor] Running render check (method='${method}')...`,
    });
    const renderStatus = hooks.runTsx({
      args: [request.paths.renderScriptPath, "--method", method],
      timeoutMs: 30_000,
    });
    LocalEdgeKit_doctorRecordCheckResult({
      checksRun,
      domain: "config",
      failedDomains,
      status: renderStatus,
      stderr,
    });
  } else {
    LocalEdgeKit_doctorLog({
      stdout,
      message: "[local-edge:doctor] Skipping render check.",
    });
  }

  LocalEdgeKit_doctorLog({
    stdout,
    message: "[local-edge:doctor] Inspecting registry integrity...",
  });
  if (!hooks.exists(request.paths.registryPath)) {
    LocalEdgeKit_doctorLog({
      stdout,
      message: `[local-edge:doctor] WARNING: Registry file is missing at ${request.paths.registryPath}`,
    });
  } else {
    hooks.runTsx({
      args: [
        request.paths.doctorCoreScriptPath,
        "print-registry-line",
        "--path",
        request.paths.registryPath,
      ],
      timeoutMs: 30_000,
    });
  }

  LocalEdgeKit_doctorLog({
    stdout,
    message: "[local-edge:doctor] Inspecting realm registry view...",
  });
  hooks.runTsx({
    args: [request.paths.realmListScriptPath],
    timeoutMs: 30_000,
  });

  const projectRoot = LocalEdgeKit_resolveProjectRoot({
    config: options.config,
    env,
    projectRoot: options.projectRoot,
  });
  LocalEdgeKit_doctorVerifyRootWorkspaceRegistrationIfActive({
    hooks,
    paths: request.paths,
    projectRoot,
    realm: request.realm,
    stdout,
  });

  LocalEdgeKit_doctorPrintRenderArtifactFreshness({
    hooks,
    paths: request.paths,
    stdout,
  });

  LocalEdgeKit_doctorPrintTlsSanCoverage({
    hooks,
    paths: request.paths,
    stdout,
  });

  if (!request.skipSetup) {
    LocalEdgeKit_doctorLog({
      stdout,
      message: `[local-edge:doctor] Running setup checks (method='${method}')...`,
    });
    const setupStatus = hooks.runTsx({
      args: [
        request.paths.startupCliScriptPath,
        "run",
        "setup",
        "--",
        "--method",
        method,
        "--no-artifact",
        request.strictArg,
      ],
      timeoutMs: 60_000,
    });
    LocalEdgeKit_doctorRecordCheckResult({
      checksRun,
      domain: "config",
      failedDomains,
      status: setupStatus,
      stderr,
    });
  } else {
    LocalEdgeKit_doctorLog({
      stdout,
      message: "[local-edge:doctor] Skipping setup checks.",
    });
  }

  if (!request.skipEdge) {
    LocalEdgeKit_doctorLog({
      stdout,
      message: `[local-edge:doctor] Running local-edge runtime status (method='${method}')...`,
    });
    const edgeStatus = hooks.runTsx({
      args: [
        request.paths.statusScriptPath,
        "--method",
        method,
        "--require-running",
      ],
      timeoutMs: 60_000,
    });
    LocalEdgeKit_doctorRecordCheckResult({
      checksRun,
      domain: "edge",
      failedDomains,
      status: edgeStatus,
      stderr,
    });
  } else {
    LocalEdgeKit_doctorLog({
      stdout,
      message: "[local-edge:doctor] Skipping edge status checks.",
    });
  }

  if (!request.skipDns) {
    LocalEdgeKit_doctorLog({
      stdout,
      message: `[local-edge:doctor] Running DNS audit (method='${method}')...`,
    });
    const dnsStatus = hooks.runTsx({
      args: [
        request.paths.dnsAuditScriptPath,
        "--method",
        method,
        request.strictArg,
      ],
      timeoutMs: 60_000,
    });
    LocalEdgeKit_doctorRecordCheckResult({
      checksRun,
      domain: "dns",
      failedDomains,
      status: dnsStatus,
      stderr,
    });
  } else {
    LocalEdgeKit_doctorLog({
      stdout,
      message: "[local-edge:doctor] Skipping DNS audit.",
    });
  }

  if (!request.skipApplication) {
    const healthcheckArgs = ["--method", method, request.strictArg];
    LocalEdgeKit_doctorPushOptionalValueArg({
      args: healthcheckArgs,
      flag: "--interval-ms",
      value: request.applicationIntervalMs,
    });
    LocalEdgeKit_doctorPushOptionalValueArg({
      args: healthcheckArgs,
      flag: "--timeout-ms",
      value: request.applicationTimeoutMs,
    });
    if (request.watchApplication) {
      healthcheckArgs.push("--watch", "--until-healthy");
      LocalEdgeKit_doctorPushOptionalValueArg({
        args: healthcheckArgs,
        flag: "--max-wait-ms",
        value: request.applicationMaxWaitMs,
      });
    }

    LocalEdgeKit_doctorLog({
      stdout,
      message: `[local-edge:doctor] Running host/surface health probes (method='${method}')...`,
    });
    const applicationStatus = hooks.runTsx({
      args: [request.paths.healthcheckScriptPath, ...healthcheckArgs],
      timeoutMs: 60_000,
    });
    LocalEdgeKit_doctorRecordCheckResult({
      checksRun,
      domain: "application",
      failedDomains,
      status: applicationStatus,
      stderr,
    });
  } else {
    LocalEdgeKit_doctorLog({
      stdout,
      message: "[local-edge:doctor] Skipping host/surface health probes.",
    });
  }

  if (failedDomains.size > 0) {
    const failedDomainsCsv = Array.from(failedDomains).join(",");
    stderr(
      `[local-edge:doctor] Summary status=failed domains=${failedDomainsCsv}\n`,
    );
    if (strict) {
      return 1;
    }
  } else {
    LocalEdgeKit_doctorLog({
      stdout,
      message: `[local-edge:doctor] Summary status=ok checks=${checksRun.size}`,
    });
  }

  LocalEdgeKit_doctorLog({
    stdout,
    message: "[local-edge:doctor] Completed.",
  });
  return 0;
}

/** Runs the full ensure-running state machine using config plans and adapter-supplied host hooks. */
export function LocalEdgeKit_runEnsureRunningLifecycle(
  options: LocalEdgeKit_RunEnsureRunningLifecycleOptions,
): number {
  const env = options.env ?? process.env;
  const stdout =
    options.stdout ??
    ((line: string): void => {
      process.stdout.write(line);
    });
  const stderr =
    options.stderr ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  const executeHostCommandPlan =
    options.executeHostCommandPlan ?? LocalEdgeKit_runHostCommandPlan;

  const request = LocalEdgeKit_resolveEnsureRunningRequest({
    config: options.config,
    env,
    projectRoot: options.projectRoot,
  });
  if (!request.ok) {
    stderr(request.stderrLine);
    return request.exitCode;
  }

  const { commands, method, routerProbe, forceRecreateIfRunning } = request;
  if (method === "nginx-docker") {
    const readyResult = options.hooks.ensureMethodReadyForStartup({
      env,
      method,
    });
    if (!readyResult.ok) {
      stderr(`[local-edge:ensure-running] ERROR: ${readyResult.message}\n`);
      return 1;
    }
  }

  const isRunning = LocalEdgeKit_statusRequireRunning({
    commands,
    env,
    executeHostCommandPlan,
  });

  if (isRunning) {
    if (method === "nginx-docker") {
      const runningNginxDockerOutcome =
        LocalEdgeKit_ensureRunningWhenRunningNginxDocker({
          commands,
          env,
          executeHostCommandPlan,
          forceRecreateIfRunning,
          hooks: options.hooks,
          method,
          routerProbe,
          stderr,
          stdout,
        });
      if (runningNginxDockerOutcome !== null) {
        return runningNginxDockerOutcome;
      }
    }

    stdout(
      `[local-edge:ensure-running] Primary/local-edge method '${method}' is already running.\n`,
    );
    return 0;
  }

  stdout(
    `[local-edge:ensure-running] Method '${method}' is not running. Starting...\n`,
  );

  if (
    executeHostCommandPlan({
      env,
      plan: commands.render,
      stdio: "inherit",
    }) !== 0
  ) {
    stdout(
      `[local-edge:ensure-running] ERROR: render.ts failed for method '${method}'. Aborting cold start.\n`,
    );
    return 1;
  }
  if (
    executeHostCommandPlan({
      env,
      plan: commands.setup,
      stdio: "inherit",
    }) !== 0
  ) {
    stdout(
      `[local-edge:ensure-running] ERROR: setup failed for method '${method}'. Aborting cold start.\n`,
    );
    return 1;
  }
  if (
    executeHostCommandPlan({
      env,
      plan: commands.start,
      stdio: "inherit",
    }) !== 0
  ) {
    stdout(
      `[local-edge:ensure-running] ERROR: start failed for method '${method}'. Aborting cold start.\n`,
    );
    return 1;
  }

  if (
    LocalEdgeKit_statusRequireRunning({
      commands,
      env,
      executeHostCommandPlan,
    })
  ) {
    if (
      method === "nginx-docker" &&
      !LocalEdgeKit_routerIsHealthy({
        hooks: options.hooks,
        routerProbe,
        stderr,
        stdout,
      })
    ) {
      stdout(
        `[local-edge:ensure-running] Method '${method}' started but router-only HTTPS ingress is unhealthy. Retrying once...\n`,
      );
      LocalEdgeKit_recreateMethod({
        commands,
        env,
        executeHostCommandPlan,
        method,
        stdout,
      });

      const retryVerifyCode = LocalEdgeKit_verifyRunningAndRouterAfterRecreate({
        commands,
        env,
        executeHostCommandPlan,
        hooks: options.hooks,
        messages: {
          notRunningStderrLine: `[local-edge:ensure-running] WARNING: Method '${method}' did not come back after router ingress retry.\n`,
          routerUnhealthyStderrLine: `[local-edge:ensure-running] WARNING: Method '${method}' is still failing router-only HTTPS ingress after retry.\n`,
        },
        method,
        routerProbe,
        stderr,
        stdout,
      });
      if (retryVerifyCode !== 0) {
        return retryVerifyCode;
      }
    }

    stdout(`[local-edge:ensure-running] Method '${method}' is now running.\n`);
    return 0;
  }

  stderr(
    `[local-edge:ensure-running] WARNING: Method '${method}' is not running after start attempt.\n`,
  );
  if (LocalEdgeCore_isTruthy(env.LOCAL_EDGE_STRICT_START)) {
    return 1;
  }
  return 0;
}

type LocalEdgeKit_EnsureRunningVerifyMessages = {
  notRunningStderrLine: string;
  routerUnhealthyStderrLine: string;
  successStdoutLine?: string;
};

function LocalEdgeKit_statusRequireRunning(options: {
  commands: LocalEdgeKit_EnsureRunningRequest["commands"];
  env: NodeJS.ProcessEnv;
  executeHostCommandPlan: (
    options: LocalEdgeKit_RunHostCommandPlanOptions,
  ) => number;
}): boolean {
  return (
    options.executeHostCommandPlan({
      env: options.env,
      plan: options.commands.statusRequireRunning,
      stdio: "ignore",
    }) === 0
  );
}

function LocalEdgeKit_recreateMethod(options: {
  commands: LocalEdgeKit_EnsureRunningRequest["commands"];
  env: NodeJS.ProcessEnv;
  executeHostCommandPlan: (
    options: LocalEdgeKit_RunHostCommandPlanOptions,
  ) => number;
  method: string;
  stdout: (line: string) => void;
}): number {
  options.stdout(
    `[local-edge:ensure-running] Recreating method '${options.method}' with fresh shared artifacts...\n`,
  );

  if (
    options.executeHostCommandPlan({
      env: options.env,
      plan: options.commands.render,
      stdio: "inherit",
    }) !== 0
  ) {
    options.stdout(
      `[local-edge:ensure-running] ERROR: render.ts failed for method '${options.method}'. Aborting recreate.\n`,
    );
    return 1;
  }
  if (
    options.executeHostCommandPlan({
      env: options.env,
      plan: options.commands.setup,
      stdio: "inherit",
    }) !== 0
  ) {
    options.stdout(
      `[local-edge:ensure-running] ERROR: setup failed for method '${options.method}'. Aborting recreate.\n`,
    );
    return 1;
  }
  if (
    options.executeHostCommandPlan({
      env: options.env,
      plan: options.commands.stop,
      stdio: "inherit",
    }) !== 0
  ) {
    options.stdout(
      `[local-edge:ensure-running] ERROR: stop failed for method '${options.method}'. Aborting recreate.\n`,
    );
    return 1;
  }
  return options.executeHostCommandPlan({
    env: options.env,
    plan: options.commands.start,
    stdio: "inherit",
  });
}

function LocalEdgeKit_routerIsHealthy(options: {
  hooks: LocalEdgeKit_EnsureRunningRuntimeHooks;
  routerProbe: LocalEdgeKit_EnsureRunningRouterProbe;
  stderr: (line: string) => void;
  stdout: (line: string) => void;
}): boolean {
  const healthy = options.hooks.routerHostProbe({
    routerProbe: options.routerProbe,
  });
  if (healthy) {
    options.stdout(
      `[local-edge:ensure-running] Verified router-only HTTPS ingress via ${options.routerProbe.url}.\n`,
    );
  } else {
    options.stderr(
      `[local-edge:ensure-running] WARNING: Router-only HTTPS ingress probe failed for ${options.routerProbe.url}.\n`,
    );
  }
  return healthy;
}

function LocalEdgeKit_verifyRunningAndRouterAfterRecreate(options: {
  commands: LocalEdgeKit_EnsureRunningRequest["commands"];
  env: NodeJS.ProcessEnv;
  executeHostCommandPlan: (
    options: LocalEdgeKit_RunHostCommandPlanOptions,
  ) => number;
  hooks: LocalEdgeKit_EnsureRunningRuntimeHooks;
  messages: LocalEdgeKit_EnsureRunningVerifyMessages;
  method: string;
  routerProbe: LocalEdgeKit_EnsureRunningRouterProbe;
  stderr: (line: string) => void;
  stdout: (line: string) => void;
}): 0 | 1 {
  if (
    !LocalEdgeKit_statusRequireRunning({
      commands: options.commands,
      env: options.env,
      executeHostCommandPlan: options.executeHostCommandPlan,
    })
  ) {
    options.stderr(options.messages.notRunningStderrLine);
    return 1;
  }
  if (
    !LocalEdgeKit_routerIsHealthy({
      hooks: options.hooks,
      routerProbe: options.routerProbe,
      stderr: options.stderr,
      stdout: options.stdout,
    })
  ) {
    options.stderr(options.messages.routerUnhealthyStderrLine);
    return 1;
  }
  if (options.messages.successStdoutLine !== undefined) {
    options.stdout(options.messages.successStdoutLine);
  }
  return 0;
}

function LocalEdgeKit_ensureRunningWhenRunningNginxDocker(options: {
  commands: LocalEdgeKit_EnsureRunningRequest["commands"];
  env: NodeJS.ProcessEnv;
  executeHostCommandPlan: (
    options: LocalEdgeKit_RunHostCommandPlanOptions,
  ) => number;
  forceRecreateIfRunning: boolean;
  hooks: LocalEdgeKit_EnsureRunningRuntimeHooks;
  method: string;
  routerProbe: LocalEdgeKit_EnsureRunningRouterProbe;
  stderr: (line: string) => void;
  stdout: (line: string) => void;
}): 0 | 1 | null {
  if (options.forceRecreateIfRunning) {
    options.stdout(
      `[local-edge:ensure-running] Recreating method '${options.method}' because source-env refresh requested router reconciliation.\n`,
    );
    LocalEdgeKit_recreateMethod(options);
    return LocalEdgeKit_verifyRunningAndRouterAfterRecreate({
      ...options,
      messages: {
        notRunningStderrLine: `[local-edge:ensure-running] WARNING: Method '${options.method}' did not come back after forced recreation.\n`,
        routerUnhealthyStderrLine: `[local-edge:ensure-running] WARNING: Method '${options.method}' is still failing router-only HTTPS ingress after forced recreation.\n`,
        successStdoutLine: `[local-edge:ensure-running] Method '${options.method}' was recreated for source-env router reconciliation.\n`,
      },
    });
  }

  if (
    !options.hooks.methodRuntimeMatchesCurrentArtifacts({
      env: options.env,
      method: options.method,
    })
  ) {
    options.stdout(
      `[local-edge:ensure-running] Primary/local-edge method '${options.method}' is running with stale mounted artifacts.\n`,
    );
    LocalEdgeKit_recreateMethod(options);
    return LocalEdgeKit_verifyRunningAndRouterAfterRecreate({
      ...options,
      messages: {
        notRunningStderrLine: `[local-edge:ensure-running] WARNING: Method '${options.method}' did not come back after recreation.\n`,
        routerUnhealthyStderrLine: `[local-edge:ensure-running] WARNING: Method '${options.method}' is running but router-only HTTPS ingress is still unhealthy after recreation.\n`,
        successStdoutLine: `[local-edge:ensure-running] Method '${options.method}' was recreated with current artifacts.\n`,
      },
    });
  }

  if (
    !options.hooks.reloadRunningMethod({
      env: options.env,
      method: options.method,
    })
  ) {
    options.stderr(
      `[local-edge:ensure-running] WARNING: Failed to reload running '${options.method}' container after render. Recreating method...\n`,
    );
    LocalEdgeKit_recreateMethod(options);
    return LocalEdgeKit_verifyRunningAndRouterAfterRecreate({
      ...options,
      messages: {
        notRunningStderrLine: `[local-edge:ensure-running] WARNING: Method '${options.method}' did not come back after reload fallback recreation.\n`,
        routerUnhealthyStderrLine: `[local-edge:ensure-running] WARNING: Method '${options.method}' is still failing router-only HTTPS ingress after reload fallback recreation.\n`,
        successStdoutLine: `[local-edge:ensure-running] Method '${options.method}' was recreated after reload fallback.\n`,
      },
    });
  }

  options.stdout(
    `[local-edge:ensure-running] Reloaded running '${options.method}' container to apply rendered router artifacts.\n`,
  );
  if (
    !LocalEdgeKit_routerIsHealthy({
      hooks: options.hooks,
      routerProbe: options.routerProbe,
      stderr: options.stderr,
      stdout: options.stdout,
    })
  ) {
    options.stdout(
      `[local-edge:ensure-running] Primary/local-edge method '${options.method}' is running but router-only HTTPS ingress is unhealthy.\n`,
    );
    LocalEdgeKit_recreateMethod(options);
    return LocalEdgeKit_verifyRunningAndRouterAfterRecreate({
      ...options,
      messages: {
        notRunningStderrLine: `[local-edge:ensure-running] WARNING: Method '${options.method}' did not come back after router ingress recovery.\n`,
        routerUnhealthyStderrLine: `[local-edge:ensure-running] WARNING: Method '${options.method}' is still failing router-only HTTPS ingress after recovery.\n`,
        successStdoutLine: `[local-edge:ensure-running] Method '${options.method}' recovered router-only HTTPS ingress.\n`,
      },
    });
  }

  return null;
}

/** Resolves `startup-cli run stop` env into method stop plans and stop-time policy. */
export function LocalEdgeKit_resolveStopRequest(options: {
  config: LocalEdgeKit_Config;
  env?: NodeJS.ProcessEnv | undefined;
  projectRoot?: string | null | undefined;
}): LocalEdgeKit_StopRequestResult {
  const env = options.env ?? process.env;
  const method = env.LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD;
  if (method === undefined || method.length === 0) {
    return {
      ok: false,
      exitCode: 2,
      stderrLine:
        "[local-edge:stop] Missing LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD.\n",
    };
  }

  try {
    const runtimeConfig = LocalEdgeKit_resolveRuntimeConfig({
      config: options.config,
      env,
      projectRoot: options.projectRoot,
    });
    const timeoutEnvName =
      options.config.lifecycle?.stopTimeoutSecondsEnvName ??
      "LOCAL_EDGE_STOP_TIMEOUT_SECONDS";
    const timeoutRaw = env[timeoutEnvName] ?? "20";
    const timeoutValidation = LocalEdgeCore_validatePositiveInteger({
      label: timeoutEnvName,
      value: timeoutRaw,
    });
    const timeoutSeconds = timeoutValidation.ok
      ? Number.parseInt(timeoutRaw, 10)
      : 20;
    const methodNames =
      method === "all" ? runtimeConfig.configuredMethods : [method];
    const methodPlans = methodNames.map((methodName) =>
      LocalEdgeKit_buildStopMethodPlan({
        config: options.config,
        env,
        method: methodName,
        projectRoot: runtimeConfig.projectRoot,
      }),
    );

    return {
      ok: true,
      allowPortKill: LocalEdgeCore_isTruthy(env.LOCAL_EDGE_ALLOW_PORT_KILL),
      method,
      methodPlans,
      timeoutSeconds,
      timeoutWarningLine: timeoutValidation.ok
        ? null
        : timeoutValidation.message,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      exitCode: 1,
      stderrLine: `[local-edge:stop] ${LocalEdgeKit_errorMessage(error)}\n`,
    };
  }
}

/** Builds a config-driven nginx-docker start plan without running host commands. */
export function LocalEdgeKit_buildStartNginxDockerPlan(
  options: LocalEdgeKit_LifecyclePlanOptions,
): LocalEdgeKit_StartNginxDockerPlan {
  const { env, method } = LocalEdgeKit_getLifecycleRuntimeMethod(options);
  const startCommandEnvName = LocalEdgeKit_lifecycleEnvKeyForMethod({
    configuredNames: options.config.lifecycle?.startCommandEnvNames,
    method: method.method,
    suffix: "START_CMD",
  });
  const startCommandOverride = env[startCommandEnvName];
  const startCommand =
    startCommandOverride !== undefined && startCommandOverride.trim().length > 0
      ? startCommandOverride
      : LocalEdgeCore_buildDockerComposeUpDetachedCommand({
          projectName: method.composeProjectName,
          composePath: method.composePath,
        });
  const startTimeoutSecondsEnvName =
    options.config.lifecycle?.startTimeoutSecondsEnvName ??
    "LOCAL_EDGE_START_TIMEOUT_SECONDS";

  return {
    method: method.method,
    port: String(method.listenPort),
    listenHost: method.listenHost,
    timeoutSeconds: env[startTimeoutSecondsEnvName] ?? "20",
    startCommand,
    startBinary: LocalEdgeCore_extractShellCommandBinary(startCommand),
    customLoopbackRequired: LocalEdgeCore_isCustomLoopbackHost(
      method.listenHost,
    ),
  };
}

/** Builds a config-driven method stop plan without running host commands. */
export function LocalEdgeKit_buildStopMethodPlan(
  options: LocalEdgeKit_LifecyclePlanOptions,
): LocalEdgeKit_StopMethodPlan {
  const { env, generatedDir, method, projectRoot } =
    LocalEdgeKit_getLifecycleRuntimeMethod(options);
  const stopCommandEnvName = LocalEdgeKit_lifecycleEnvKeyForMethod({
    configuredNames: options.config.lifecycle?.stopCommandEnvNames,
    method: method.method,
    suffix: "STOP_CMD",
  });
  const stopCommandOverride = env[stopCommandEnvName];
  const stopCommand =
    stopCommandOverride !== undefined && stopCommandOverride.trim().length > 0
      ? stopCommandOverride
      : LocalEdgeCore_buildDockerComposeDownCommand({
          projectName: method.composeProjectName,
          composePath: method.composePath,
        });
  const { artifactsDir, logDir } = LocalEdgeKit_lifecycleArtifacts({
    config: options.config,
    projectRoot,
  });

  return {
    method: method.method,
    generatedDir,
    port: method.listenPort,
    listenHost: method.listenHost,
    stopCommand,
    logDir,
    artifactsDir,
  };
}

/** Shell single-quote escaping for one-line values. */
export function LocalEdgeKit_shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** Renders shell assignment rows using the compatibility wrapper quoting contract. */
export function LocalEdgeKit_renderShellAssignments(
  assignments: readonly (readonly [string, string])[],
): string {
  return assignments
    .map(([key, value]) => `${key}=${LocalEdgeKit_shellSingleQuote(value)}`)
    .join("\n");
}

/** Emits shell assignments consumed by nginx-docker start shell wrappers. */
export function LocalEdgeKit_renderStartNginxDockerPlanShellAssignments(
  plan: LocalEdgeKit_StartNginxDockerPlan,
): string {
  return LocalEdgeKit_renderShellAssignments([
    ["METHOD", plan.method],
    ["PORT", plan.port],
    ["LISTEN_HOST", plan.listenHost],
    ["TIMEOUT_SECONDS", plan.timeoutSeconds],
    ["START_CMD", plan.startCommand],
    ["START_BIN", plan.startBinary],
    [
      "CUSTOM_LOOPBACK_REQUIRED",
      plan.customLoopbackRequired ? "true" : "false",
    ],
  ]);
}
