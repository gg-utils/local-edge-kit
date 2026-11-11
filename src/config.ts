/**
 * @fileoverview Public configuration contract for repositories using the local-edge kit.
 *
 * The kit consumes explicit project config and keeps all repository-specific identity, root zones,
 * surfaces, and router labels in the caller-owned `local-edge.config.ts`. This package only defines
 * reusable schema shape and returns config values unchanged for type-safe authoring.
 *
 * @testing Jest unit: cd packages/local-edge-kit && npm run test
 *
 * @see packages/local-edge-kit/src/cli.ts - Kit CLI entry that accepts `LocalEdgeKit_Config` for usage text, env defaults, and argv delegation into local-edge commands.
 * @see local-edge.config.ts - Root consumer-authored `defineLocalEdgeConfig` object that satisfies the contract exported from this module.
 * @see docs/LOCAL-EDGE.md - Runbook describing how caller-owned configs, generated artifacts, and kit CLIs fit together for local development.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import type {
  LocalEdge_StartupCli_Command,
  LocalEdgeCore_NginxDockerResolverOptions,
  LocalEdgeCore_SurfaceAvailability,
} from "@gg-utils/local-edge-core";

/** Health probe options for one configured surface. */
export type LocalEdgeKit_SurfaceHealthcheckConfig = {
  include?: boolean;
  statusPath?: string;
  upstreamPortKey?: string;
  upstreamPortEnvName?: string;
  defaultUpstreamPort?: number;
  expectedAbsentProjectRelativePath?: string;
};

/** DNS-audit participation options for one configured surface. */
export type LocalEdgeKit_SurfaceDnsAuditConfig = {
  include?: boolean;
};

/** Render/manifest ownership options for one configured surface. */
export type LocalEdgeKit_SurfaceRenderConfig = {
  availability?: LocalEdgeCore_SurfaceAvailability;
};

/** One app/status surface that should appear in a URL-matrix command. */
export type LocalEdgeKit_SurfaceConfig = {
  id: string;
  appPath: string;
  statusPath: string;
  dnsAudit?: LocalEdgeKit_SurfaceDnsAuditConfig;
  healthcheck?: LocalEdgeKit_SurfaceHealthcheckConfig;
  includeInUrlMatrix?: boolean;
  render?: LocalEdgeKit_SurfaceRenderConfig;
};

/** Optional command-family paths/env names for the config-driven healthcheck runner. */
export type LocalEdgeKit_HealthcheckConfig = {
  aggregateArtifactPath?: string;
  compatibilityFallbackEnvName?: string;
  logVerbosityEnvName?: string;
  strictStartEnvName?: string;
};

/** Optional command-family paths/env names for the config-driven DNS audit runner. */
export type LocalEdgeKit_DnsAuditConfig = {
  artifactPath?: string;
  directProbeUtilityName?: string;
  listenAddressEnvName?: string;
  methodIpEnvNames?: Readonly<Record<string, string>>;
  portEnvName?: string;
  resolverDir?: string;
};

/** Product-neutral upstream target defaults used by render and manifest helpers. */
export type LocalEdgeKit_RenderUpstreamConfig = {
  id: string;
  host: string;
  port: number;
  protocol: "http" | "https";
};

/** One config-authored route group used by manifest and nginx adapters. */
export type LocalEdgeKit_RenderRouteGroupConfig = {
  id: string;
  surfaceHeader: string;
  hostnameSurfaceIds: readonly string[];
  upstreamId: string;
  upstreamPortKey: string;
  variableSuffix: string;
  websocketSafe: boolean;
};

/** Router-ingress constants shared by all generated server blocks. */
export type LocalEdgeKit_RenderRouterIngressConfig = {
  healthPath: string;
  healthBody: string;
};

/** Generic nginx `http` wrapper defaults consumed by the adapter renderer. */
export type LocalEdgeKit_RenderNginxHttpConfig = {
  generatedBy: string;
  mimeTypesPath: string;
  workerProcesses: number;
  workerConnections: number;
  keepaliveTimeoutSeconds: number;
  serverNamesHashBucketSize: number;
  variablesHashBucketSize: number;
  variablesHashMaxSize: number;
  clientBodyTimeoutSeconds: number;
  clientMaxBodySize: string;
  proxyConnectTimeoutSeconds: number;
  proxyReadTimeoutSeconds: number;
  proxySendTimeoutSeconds: number;
  sendTimeoutSeconds: number;
  timeoutCommentLines: readonly string[];
  dockerResolver: LocalEdgeCore_NginxDockerResolverOptions | null;
};

/** Docker-specific generated artifact defaults for the nginx router method. */
export type LocalEdgeKit_RenderNginxDockerConfig = {
  certPath: string;
  configTargetPath: string;
  defaultUpstreamHost: string;
  image: string;
  keyPath: string;
  labels: readonly string[];
  restartPolicy: string;
  serviceName: string;
  upstreamHostEnvName?: string;
};

/** Full config-driven render/manifest section for the local-edge kit. */
export type LocalEdgeKit_RenderConfig = {
  artifactPath?: string;
  compatibilityFallbackEnvName?: string;
  forceRegenerateTlsEnvName?: string;
  nginxDocker: LocalEdgeKit_RenderNginxDockerConfig;
  nginxHttp: LocalEdgeKit_RenderNginxHttpConfig;
  routeGroups: readonly LocalEdgeKit_RenderRouteGroupConfig[];
  routerIngress: LocalEdgeKit_RenderRouterIngressConfig;
  tlsReuseExistingEnvName?: string;
  upstreams: readonly LocalEdgeKit_RenderUpstreamConfig[];
};

/** Config-driven startup dispatcher surface for lifecycle command adapters. */
export type LocalEdgeKit_StartupConfig = {
  implementationDirectory: string;
  implBaseNames?: Partial<Record<LocalEdge_StartupCli_Command, string>>;
  invocation: string;
};

/** Config-driven local-edge lifecycle planning defaults for start/stop adapters. */
export type LocalEdgeKit_LifecycleSetupMissingEnvWarning = {
  envName: string;
  message: string;
};

/** Config-driven setup command paths, utilities, artifacts, and warning policy. */
export type LocalEdgeKit_LifecycleConfig = {
  artifactsDir?: string;
  envOverlayValidationScript?: string;
  ensureRouterProbeSurfaceId?: string;
  initDefaultExposureMode?: string;
  initDefaultIdentitySurfaceLabel?: string;
  initDeprecatedEnvNames?: readonly string[];
  initDeveloperSlugPromptRejectedDefaults?: readonly string[];
  initEnvTemplatePath?: string;
  initExposureModeEnvName?: string;
  initIdentitySurfaceLabelEnvName?: string;
  logDir?: string;
  setupArtifactName?: string;
  setupMissingEnvWarnings?: readonly LocalEdgeKit_LifecycleSetupMissingEnvWarning[];
  setupRequiredUtilities?: readonly string[];
  setupStrictStartEnvName?: string;
  startCommandEnvNames?: Readonly<Record<string, string>>;
  startTimeoutSecondsEnvName?: string;
  stopCommandEnvNames?: Readonly<Record<string, string>>;
  stopTimeoutSecondsEnvName?: string;
};

/** One process entry in a runtime-launch `concurrently` catalog. */
export type LocalEdgeKit_RuntimeLaunchConcurrentlyProcessConfig = {
  color: string;
  id: string;
  includeWhenSplitModeDisabled: boolean;
  includeWhenSplitModeEnabled: boolean;
  name: string;
  optionalAbsentLogLines?: readonly string[];
  optionalProjectRelativePath?: string;
};

/** One direct upstream URL printed before edge-host URLs during runtime launch. */
export type LocalEdgeKit_RuntimeLaunchDirectUpstreamUrlConfig = {
  label: string;
  requestPath: string;
  surfaceId: string;
};

/** One generated env overlay consumed by a runtime-launch dev process. */
export type LocalEdgeKit_RuntimeLaunchDevOverlayConfig = {
  appName: string;
  id: string;
  logLabel: string;
  packageRelativePath: string;
  requiredWhenSplitModeDisabled: boolean;
  requiredWhenSplitModeEnabled: boolean;
};

/** One env export value used while building a runtime-launch process command. */
export type LocalEdgeKit_RuntimeLaunchProcessCommandEnvExportConfig =
  | {
      name: string;
      source: "local-edge-runtime-launch-env-export-source-literal";
      value: string;
    }
  | {
      name: string;
      overlayId: string;
      source: "local-edge-runtime-launch-env-export-source-overlay-env-files";
    }
  | {
      name: string;
      source: "local-edge-runtime-launch-env-export-source-surface-host";
      surfaceId: string;
    }
  | {
      name: string;
      source: "local-edge-runtime-launch-env-export-source-upstream-port";
      surfaceId: string;
    };

/** One process command template consumed by the runtime-launch process catalog. */
export type LocalEdgeKit_RuntimeLaunchProcessCommandConfig =
  | {
      envExports: readonly LocalEdgeKit_RuntimeLaunchProcessCommandEnvExportConfig[];
      id: string;
      kind: "local-edge-runtime-launch-process-command-kind-npm-dev";
      packageRelativePath: string;
    }
  | {
      command: string;
      envExports?: readonly LocalEdgeKit_RuntimeLaunchProcessCommandEnvExportConfig[];
      id: string;
      kind: "local-edge-runtime-launch-process-command-kind-shell";
    };

/** Optional open-on-start helper process planning. */
export type LocalEdgeKit_RuntimeLaunchOpenOnStartConfig = {
  enabledEnvName: string;
  envFileEnvName: string;
  missingCommandWarning: string;
  overlayId: string;
  projectRootArg: string;
  requiredCommand: string;
  scriptPath: string;
  scriptRunner: LocalEdgeKit_RuntimeLaunchScriptRunnerConfig;
  startLogLine: string;
};

/** Runtime-launch cleanup subprocess planning. */
export type LocalEdgeKit_RuntimeLaunchCleanupConfig = {
  platformStopScriptPath: string;
  realmInactiveScriptPath: string;
  scriptRunner: LocalEdgeKit_RuntimeLaunchScriptRunnerConfig;
};

/** Runtime-launch root-workspace realm registration planning. */
export type LocalEdgeKit_RuntimeLaunchWorkspaceRegistrationConfig = {
  defaultEnvFileRelativePath: string;
  defaultRootEnvFileValue: string;
  logFileName: string;
  registerScriptPath: string;
  scriptRunner: LocalEdgeKit_RuntimeLaunchScriptRunnerConfig;
};

/** Runtime-launch shared artifact render planning. */
export type LocalEdgeKit_RuntimeLaunchRenderArtifactsConfig = {
  logFileName: string;
  renderScriptPath: string;
  scriptRunner: LocalEdgeKit_RuntimeLaunchScriptRunnerConfig;
};

/** Runtime-launch infrastructure ensure command planning. */
export type LocalEdgeKit_RuntimeLaunchEnsureInfrastructureConfig = {
  commandName: string;
  methodArgName: string;
  realmArgName: string;
  scriptRunner: LocalEdgeKit_RuntimeLaunchScriptRunnerConfig;
  startupCliScriptPath: string;
};

/** Runtime-launch SIGINT cleanup process discovery planning. */
export type LocalEdgeKit_RuntimeLaunchSigintStopConfig = {
  collectProcessPatterns: readonly string[];
  completionLogLine: string;
  logLinePrefix: string;
  runtimeStopLibPath: string;
};

/** Runtime-launch env file and generated-path planning. */
export type LocalEdgeKit_RuntimeLaunchEnvironmentConfig = {
  defaultEnvFileRelativePath: string;
  generatedDirRelativePath: string;
  generatedEnvSubdir: string;
  logEnvLoadsEnvName: string;
};

/** Runtime-launch paired upstream port defaults used by split-process adapters. */
export type LocalEdgeKit_RuntimeLaunchSplitUpstreamPortsConfig = {
  defaultSplitModeEnabled: boolean;
  primaryDefaultPort: number;
  primaryEnvName: string;
  primaryFallbackEnvNames: readonly string[];
  secondaryEnvName: string;
  secondaryOffsetFromPrimary: number;
  splitModeEnvName: string;
};

/** Runtime-launch process env override planning. */
export type LocalEdgeKit_RuntimeLaunchHostOverrideConfig = {
  defaultValue: string;
  envName: string;
  logLabel: string;
  targetEnvName: string;
};

/** Runtime-launch handoff/delegation planning for alternate checkout modes. */
export type LocalEdgeKit_RuntimeLaunchDelegationConfig = {
  bypassEnvName: string;
  commandScriptPath: string;
  guardFilePath: string;
  projectRootArgName: string;
  scriptRunner: LocalEdgeKit_RuntimeLaunchScriptRunnerConfig;
  startLogLine: string;
};

/** Runtime-launch startup URL report rendering. */
export type LocalEdgeKit_RuntimeLaunchStartupReportConfig = {
  commandLabel: string;
  directHost: string;
  directLabelPadWidth: number;
  directSectionLogLine: string;
  edgeSectionLogLine: string;
  primaryMethodEnvName: string;
  scopeLogPrefix: string;
  sectionLogLine: string;
  splitModeLogLabel: string;
  topologySelectorLogLabel: string;
};

/** Script-runner command defaults used by runtime-launch helpers. */
export type LocalEdgeKit_RuntimeLaunchScriptRunnerConfig = {
  command: string;
  runnerArgs: readonly string[];
};

/** Config-driven runtime audit command planning. */
export type LocalEdgeKit_RuntimeLaunchRuntimeAuditConfig = {
  defaultEnabled: boolean;
  defaultStrict: boolean;
  dnsAuditScriptPath: string;
  enabledEnvName: string;
  methodEnvName: string;
  scriptRunner: LocalEdgeKit_RuntimeLaunchScriptRunnerConfig;
  statusScriptPath: string;
  strictEnvName: string;
};

/** Config-driven background health monitor command planning. */
export type LocalEdgeKit_RuntimeLaunchBackgroundHealthConfig = {
  defaultEnabled: boolean;
  defaultIntervalMs: string;
  defaultMaxWaitMs: string;
  defaultSteadyIntervalMs: string;
  defaultStrict: boolean;
  defaultTimeoutMs: string;
  enabledEnvName: string;
  healthcheckScriptPath: string;
  intervalMsEnvName: string;
  logFileName: string;
  maxWaitMsEnvName: string;
  methodEnvName: string;
  realmEnvName: string;
  scriptRunner: LocalEdgeKit_RuntimeLaunchScriptRunnerConfig;
  steadyIntervalMsEnvName: string;
  strictEnvName: string;
  timeoutMsEnvName: string;
};

/** Config-driven active realm env watcher command planning. */
export type LocalEdgeKit_RuntimeLaunchActiveEnvWatcherConfig = {
  defaultEnabled: boolean;
  defaultEnvFileRelativePath: string;
  defaultRootEnvFileValue: string;
  enabledEnvName: string;
  logFileName: string;
  scriptRunner: LocalEdgeKit_RuntimeLaunchScriptRunnerConfig;
  watcherScriptPath: string;
};

/** One package whose dependencies should be checked before runtime launch. */
export type LocalEdgeKit_RuntimeLaunchDependencyCheckPackageConfig = {
  id: string;
  packageRelativePath: string;
};

/** Config-driven dependency preflight policy for runtime launch. */
export type LocalEdgeKit_RuntimeLaunchDependencyCheckConfig = {
  installAllCommand?: string;
  packages: readonly LocalEdgeKit_RuntimeLaunchDependencyCheckPackageConfig[];
  skipCommand?: string;
  skipEnvName: string;
};

/** Config-driven runtime-launch defaults that are still generic across consumers. */
export type LocalEdgeKit_RuntimeLaunchConfig = {
  activeEnvWatcher?: LocalEdgeKit_RuntimeLaunchActiveEnvWatcherConfig;
  backgroundHealth?: LocalEdgeKit_RuntimeLaunchBackgroundHealthConfig;
  cleanup?: LocalEdgeKit_RuntimeLaunchCleanupConfig;
  concurrentlyProcesses?: readonly LocalEdgeKit_RuntimeLaunchConcurrentlyProcessConfig[];
  dependencyCheck?: LocalEdgeKit_RuntimeLaunchDependencyCheckConfig;
  delegation?: LocalEdgeKit_RuntimeLaunchDelegationConfig;
  directUpstreamUrls?: readonly LocalEdgeKit_RuntimeLaunchDirectUpstreamUrlConfig[];
  devOverlays?: readonly LocalEdgeKit_RuntimeLaunchDevOverlayConfig[];
  ensureInfrastructure?: LocalEdgeKit_RuntimeLaunchEnsureInfrastructureConfig;
  environment?: LocalEdgeKit_RuntimeLaunchEnvironmentConfig;
  hostOverride?: LocalEdgeKit_RuntimeLaunchHostOverrideConfig;
  internalDependencyNamePrefixes?: readonly string[];
  openOnStart?: LocalEdgeKit_RuntimeLaunchOpenOnStartConfig;
  packageEnvFileNames?: readonly string[];
  processCommands?: readonly LocalEdgeKit_RuntimeLaunchProcessCommandConfig[];
  renderArtifacts?: LocalEdgeKit_RuntimeLaunchRenderArtifactsConfig;
  runtimeAudit?: LocalEdgeKit_RuntimeLaunchRuntimeAuditConfig;
  sigintStop?: LocalEdgeKit_RuntimeLaunchSigintStopConfig;
  splitUpstreamPorts?: LocalEdgeKit_RuntimeLaunchSplitUpstreamPortsConfig;
  startupReport?: LocalEdgeKit_RuntimeLaunchStartupReportConfig;
  startupUrlSurfaceIds?: readonly string[];
  workspaceRegistration?: LocalEdgeKit_RuntimeLaunchWorkspaceRegistrationConfig;
};

/** Environment variable names used by the kit's generic loader and config resolver. */
export type LocalEdgeKit_EnvNamesConfig = {
  projectRootEnvName?: string;
  envFileEnvName?: string;
  rootEnvFileEnvName?: string;
  generatedDirEnvName?: string;
  methodsEnvName?: string;
  primaryMethodEnvName?: string;
  developerSlugEnvName?: string;
  realmSlugEnvName?: string;
  rootZoneEnvName?: string;
};

/** Generic nginx-docker method wiring consumed by status and URL-matrix commands. */
export type LocalEdgeKit_NginxDockerMethodConfig = {
  kind: "nginx-docker";
  method: string;
  serviceName: string;
  defaultListenHost: string;
  defaultListenPort: number;
  listenHostEnvName?: string;
  listenPortEnvName?: string;
  composePathEnvName?: string;
  composeProjectNameEnvName?: string;
  composeProjectNamePrefix: string;
  includeRealmSlugInDefaultComposeProjectName?: boolean;
};

/** Method config union, intentionally small until more router kinds are migrated into the kit. */
export type LocalEdgeKit_MethodConfig = LocalEdgeKit_NginxDockerMethodConfig;

/** Router-level config used by reusable local-edge commands. */
export type LocalEdgeKit_RouterConfig = {
  methods: readonly LocalEdgeKit_MethodConfig[];
  primaryMethod: string;
  singleMethodMode?: boolean;
};

/** Stable identity defaults that consumers may override through env. */
export type LocalEdgeKit_IdentityConfig = {
  defaultDeveloperSlug: string;
  defaultRealmSlug: string;
  defaultRootZone: string;
};

/** Output and diagnostic labels used by generic command runners. */
export type LocalEdgeKit_CliConfig = {
  commandName?: string;
  logPrefix?: string | undefined;
};

/** Full consumer-authored config consumed by the kit. */
export type LocalEdgeKit_Config = {
  cli?: LocalEdgeKit_CliConfig;
  dnsAudit?: LocalEdgeKit_DnsAuditConfig;
  env?: LocalEdgeKit_EnvNamesConfig;
  healthcheck?: LocalEdgeKit_HealthcheckConfig;
  identity: LocalEdgeKit_IdentityConfig;
  lifecycle?: LocalEdgeKit_LifecycleConfig;
  render?: LocalEdgeKit_RenderConfig;
  router: LocalEdgeKit_RouterConfig;
  runtimeLaunch?: LocalEdgeKit_RuntimeLaunchConfig;
  startup?: LocalEdgeKit_StartupConfig;
  surfaces: readonly LocalEdgeKit_SurfaceConfig[];
};

/** Returns the provided config unchanged while giving config files a stable authoring helper. */
export function defineLocalEdgeConfig(
  config: LocalEdgeKit_Config,
): LocalEdgeKit_Config {
  return config;
}
