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
import type { LocalEdgeKit_Config } from "./config.js";
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
export type LocalEdgeKit_EnsureRunningRequestResult = {
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
} | {
    ok: false;
    exitCode: 1 | 2;
    stderrLine: string;
};
/** Config-driven start request resolved from startup env and project config. */
export type LocalEdgeKit_StartRequestResult = {
    ok: true;
    command: LocalEdgeKit_HostCommandPlan;
    method: string;
} | {
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
export type LocalEdgeKit_SetupRequestResult = {
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
} | {
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
export type LocalEdgeKit_StopRequestResult = {
    ok: true;
    allowPortKill: boolean;
    method: string;
    methodPlans: readonly LocalEdgeKit_StopMethodPlan[];
    timeoutSeconds: number;
    timeoutWarningLine: string | null;
} | {
    ok: false;
    exitCode: 1 | 2;
    stderrLine: string;
};
/** Host operations used by the stop lifecycle runner. */
export type LocalEdgeKit_StopLifecycleHooks = {
    isPortListening: (options: {
        host: string;
        port: number;
    }) => boolean;
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
export type LocalEdgeKit_StopLifecycleLoggers = LocalEdgeKit_SetupLifecycleLoggers;
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
    runTsx: (options: {
        args: readonly string[];
        timeoutMs: number;
    }) => number;
};
/** Generic host command plan for init post-write validation steps. */
export type LocalEdgeKit_HostCommandPlan = {
    command: "bash" | "npx";
    args: readonly string[];
    env?: Readonly<Record<string, string>>;
    timeoutMs: number;
};
/** Successful ensure-running request with method commands and router probe data. */
export type LocalEdgeKit_EnsureRunningRequest = Extract<LocalEdgeKit_EnsureRunningRequestResult, {
    ok: true;
}>;
/** Router probe contract emitted by ensure-running request planning. */
export type LocalEdgeKit_EnsureRunningRouterProbe = LocalEdgeKit_EnsureRunningRequest["routerProbe"];
/** Result expected from method readiness hooks before ensure-running mutates hosts. */
export type LocalEdgeKit_EnsureRunningMethodReadyResult = {
    ok: true;
} | {
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
    executeHostCommandPlan?: (options: LocalEdgeKit_RunHostCommandPlanOptions) => number;
    hooks: LocalEdgeKit_EnsureRunningRuntimeHooks;
    projectRoot?: string | null | undefined;
    stderr?: (line: string) => void;
    stdout?: (line: string) => void;
};
/** Full setup lifecycle runner options. */
export type LocalEdgeKit_RunSetupLifecycleOptions = {
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    executeHostCommandPlan?: (options: LocalEdgeKit_RunHostCommandPlanOptions) => number;
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
    executeHostCommandPlan?: (options: LocalEdgeKit_RunHostCommandPlanOptions) => number;
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
    executeHostCommandPlan?: (options: LocalEdgeKit_RunHostCommandPlanOptions) => number;
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
/** Resolves `startup-cli run init` env into file paths, flags, and post-write command plans. */
export declare function LocalEdgeKit_resolveInitRequest(options: {
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    projectRoot?: string | null | undefined;
}): LocalEdgeKit_InitRequest;
/** Resolves `startup-cli run doctor` env into flags, paths, and delegated script locations. */
export declare function LocalEdgeKit_resolveDoctorRequest(options: {
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    projectRoot?: string | null | undefined;
}): LocalEdgeKit_DoctorRequest;
/** Resolves `startup-cli run setup` env into a validated, host-operation-free setup plan. */
export declare function LocalEdgeKit_resolveSetupRequest(options: {
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    projectRoot?: string | null | undefined;
}): LocalEdgeKit_SetupRequestResult;
/** Resolves `startup-cli run start` env into a validated method start command plan. */
export declare function LocalEdgeKit_resolveStartRequest(options: {
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    projectRoot?: string | null | undefined;
}): LocalEdgeKit_StartRequestResult;
/** Resolves `startup-cli run ensure-running` env into a validated lifecycle request. */
export declare function LocalEdgeKit_resolveEnsureRunningRequest(options: {
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    projectRoot?: string | null | undefined;
}): LocalEdgeKit_EnsureRunningRequestResult;
/** Runs one package-planned host command and returns a process-style exit code. */
export declare function LocalEdgeKit_runHostCommandPlan(options: LocalEdgeKit_RunHostCommandPlanOptions): number;
/** Runs init env file creation, normalization, optional checks, and config snapshot printing. */
export declare function LocalEdgeKit_runInitLifecycle(options: LocalEdgeKit_RunInitLifecycleOptions): Promise<number>;
/** Runs the method-specific start command resolved from startup env and config. */
export declare function LocalEdgeKit_runStartLifecycle(options: LocalEdgeKit_RunStartLifecycleOptions): number;
/** Runs setup prerequisite validation, env-overlay validation, and optional artifact writing. */
export declare function LocalEdgeKit_runSetupLifecycle(options: LocalEdgeKit_RunSetupLifecycleOptions): number;
/** Runs stop commands, waits for listen tuples to clear, and writes stop artifacts. */
export declare function LocalEdgeKit_runStopLifecycle(options: LocalEdgeKit_RunStopLifecycleOptions): number;
/** Runs the full doctor diagnostic sequence from config plans and injectable host hooks. */
export declare function LocalEdgeKit_runDoctorLifecycle(options: LocalEdgeKit_RunDoctorLifecycleOptions): number;
/** Runs the full ensure-running state machine using config plans and adapter-supplied host hooks. */
export declare function LocalEdgeKit_runEnsureRunningLifecycle(options: LocalEdgeKit_RunEnsureRunningLifecycleOptions): number;
/** Resolves `startup-cli run stop` env into method stop plans and stop-time policy. */
export declare function LocalEdgeKit_resolveStopRequest(options: {
    config: LocalEdgeKit_Config;
    env?: NodeJS.ProcessEnv | undefined;
    projectRoot?: string | null | undefined;
}): LocalEdgeKit_StopRequestResult;
/** Builds a config-driven nginx-docker start plan without running host commands. */
export declare function LocalEdgeKit_buildStartNginxDockerPlan(options: LocalEdgeKit_LifecyclePlanOptions): LocalEdgeKit_StartNginxDockerPlan;
/** Builds a config-driven method stop plan without running host commands. */
export declare function LocalEdgeKit_buildStopMethodPlan(options: LocalEdgeKit_LifecyclePlanOptions): LocalEdgeKit_StopMethodPlan;
/** Shell single-quote escaping for one-line values. */
export declare function LocalEdgeKit_shellSingleQuote(value: string): string;
/** Renders shell assignment rows using the compatibility wrapper quoting contract. */
export declare function LocalEdgeKit_renderShellAssignments(assignments: readonly (readonly [string, string])[]): string;
/** Emits shell assignments consumed by nginx-docker start shell wrappers. */
export declare function LocalEdgeKit_renderStartNginxDockerPlanShellAssignments(plan: LocalEdgeKit_StartNginxDockerPlan): string;
