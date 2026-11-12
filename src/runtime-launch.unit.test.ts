/**
 * @fileoverview Unit coverage for config-driven runtime-launch planning helpers and phase runners in
 * the reusable local-edge kit.
 *
 * This file owns regression coverage for URL-matrix construction, overlay resolution, subprocess
 * wiring, dependency checks, and lifecycle plan builders derived from LocalEdgeKit_Config snapshots.
 * Flow: build fixture config -> invoke runtime-launch helpers -> assert plans, log lines, and exit codes.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/runtime-launch.unit.test.ts
 *
 * @see packages/local-edge-kit/src/runtime-launch.ts - Runtime launch builders and phase runners under test whose command plans, env shaping, and log contracts are asserted here.
 * @see packages/local-edge-kit/src/config.ts - LocalEdgeKit_Config contract supplying deterministic runtime-launch fixture slices without live host, nginx, or Docker I/O.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview contract governing this header shape and verification tags.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { LocalEdgeKit_Config } from "./config.js";
import {
  LocalEdgeKit_applyRuntimeLaunchHostOverridePhase,
  LocalEdgeKit_buildRuntimeLaunchActiveEnvWatcherPlan,
  LocalEdgeKit_buildRuntimeLaunchBackgroundHealthPlan,
  LocalEdgeKit_checkRuntimeLaunchCommandAvailable,
  LocalEdgeKit_buildRuntimeLaunchCleanupPlan,
  LocalEdgeKit_buildRuntimeLaunchDependencyCheckReport,
  LocalEdgeKit_buildRuntimeLaunchConcurrentlyArgsPlan,
  LocalEdgeKit_buildRuntimeLaunchDelegationPlan,
  LocalEdgeKit_buildRuntimeLaunchDevOverlayPlan,
  LocalEdgeKit_buildRuntimeLaunchDirectUpstreamUrls,
  LocalEdgeKit_buildRuntimeLaunchEnvironmentPlan,
  LocalEdgeKit_buildRuntimeLaunchEnsureInfrastructurePlan,
  LocalEdgeKit_buildRuntimeLaunchHostOverridePlan,
  LocalEdgeKit_buildRuntimeLaunchNpmDevShellCommand,
  LocalEdgeKit_buildRuntimeLaunchOpenOnStartPlan,
  LocalEdgeKit_buildRuntimeLaunchPackageEnvFileList,
  LocalEdgeKit_buildRuntimeLaunchProcessCommandsPlan,
  LocalEdgeKit_buildRuntimeLaunchRenderArtifactsPlan,
  LocalEdgeKit_buildRuntimeLaunchRuntimeAuditPlan,
  LocalEdgeKit_buildRuntimeLaunchSigintStopPlan,
  LocalEdgeKit_buildRuntimeLaunchSplitUpstreamPortsPlan,
  LocalEdgeKit_buildRuntimeLaunchStartupReportPlan,
  LocalEdgeKit_buildRuntimeLaunchSurfaceUrls,
  LocalEdgeKit_buildRuntimeLaunchWorkspaceRegistrationPlan,
  LocalEdgeKit_findMissingRuntimeLaunchNpmDeps,
  LocalEdgeKit_parseRuntimeLaunchChildPid,
  LocalEdgeKit_readRuntimeLaunchPackageDependencyNames,
  LocalEdgeKit_requireRuntimeLaunchDevOverlayEntry,
  LocalEdgeKit_resolveRuntimeLaunchOverlayPath,
  LocalEdgeKit_runRuntimeLaunchCommandSync,
  LocalEdgeKit_runRuntimeLaunchCleanupPhase,
  LocalEdgeKit_runRuntimeLaunchDelegationPhase,
  LocalEdgeKit_runRuntimeLaunchDependencyCheckPhase,
  LocalEdgeKit_runRuntimeLaunchEnsureInfrastructurePhase,
  LocalEdgeKit_runRuntimeLaunchLoggedCommandSync,
  LocalEdgeKit_runRuntimeLaunchRenderArtifactsPhase,
  LocalEdgeKit_runRuntimeLaunchRuntimeAuditPhase,
  LocalEdgeKit_runRuntimeLaunchStartupReportPhase,
  LocalEdgeKit_runRuntimeLaunchPlatformWithOverlaysPhase,
  LocalEdgeKit_runRuntimeLaunchWorkspaceRegistrationPhase,
  LocalEdgeKit_runtimeLaunchExitCodeFromChildProcessEvent,
  LocalEdgeKit_shellQuoteSingle,
  LocalEdgeKit_startRuntimeLaunchActiveEnvWatcherPhase,
  LocalEdgeKit_startRuntimeLaunchBackgroundHealthPhase,
} from "./runtime-launch.js";

const runtimeLaunchConfig: LocalEdgeKit_Config = {
  identity: {
    defaultDeveloperSlug: "dev",
    defaultRealmSlug: "main",
    defaultRootZone: "local.test",
  },
  router: {
    primaryMethod: "nginx-docker",
    methods: [
      {
        kind: "nginx-docker",
        method: "nginx-docker",
        serviceName: "router",
        defaultListenHost: "127.0.0.1",
        defaultListenPort: 443,
        composeProjectNamePrefix: "router",
      },
    ],
  },
  runtimeLaunch: {
    activeEnvWatcher: {
      enabledEnvName: "WATCH_ENABLED",
      defaultEnabled: true,
      defaultEnvFileRelativePath: ".env.edge",
      defaultRootEnvFileValue: "",
      logFileName: "watch.log",
      scriptRunner: {
        command: "runner",
        runnerArgs: ["tsx"],
      },
      watcherScriptPath: "tools/watch.ts",
    },
    backgroundHealth: {
      enabledEnvName: "HEALTH_ENABLED",
      methodEnvName: "HEALTH_METHOD",
      realmEnvName: "HEALTH_REALM",
      intervalMsEnvName: "HEALTH_INTERVAL_MS",
      steadyIntervalMsEnvName: "HEALTH_STEADY_MS",
      timeoutMsEnvName: "HEALTH_TIMEOUT_MS",
      maxWaitMsEnvName: "HEALTH_MAX_WAIT_MS",
      strictEnvName: "HEALTH_STRICT",
      defaultEnabled: true,
      defaultIntervalMs: "5000",
      defaultSteadyIntervalMs: "15000",
      defaultTimeoutMs: "5000",
      defaultMaxWaitMs: "",
      defaultStrict: false,
      logFileName: "health.log",
      scriptRunner: {
        command: "runner",
        runnerArgs: ["tsx"],
      },
      healthcheckScriptPath: "tools/health.ts",
    },
    cleanup: {
      platformStopScriptPath: "tools/stop.ts",
      realmInactiveScriptPath: "tools/mark-inactive.ts",
      scriptRunner: {
        command: "runner",
        runnerArgs: ["tsx"],
      },
    },
    delegation: {
      bypassEnvName: "DELEGATE_BYPASS",
      commandScriptPath: "tools/delegate.ts",
      guardFilePath: ".tmp/delegate/metadata.json",
      projectRootArgName: "--workspace",
      scriptRunner: {
        command: "runner",
        runnerArgs: ["tsx"],
      },
      startLogLine: "delegating runtime launch",
    },
    ensureInfrastructure: {
      commandName: "ensure",
      methodArgName: "--method",
      realmArgName: "--realm",
      scriptRunner: {
        command: "runner",
        runnerArgs: ["tsx"],
      },
      startupCliScriptPath: "tools/startup.ts",
    },
    environment: {
      defaultEnvFileRelativePath: ".env.edge",
      generatedDirRelativePath: ".tmp/edge",
      generatedEnvSubdir: "env/generated",
      logEnvLoadsEnvName: "LOG_EDGE_ENV_LOADS",
    },
    hostOverride: {
      envName: "WEB_LISTEN_HOST",
      targetEnvName: "HOST",
      defaultValue: "0.0.0.0",
      logLabel: "web dev server",
    },
    renderArtifacts: {
      logFileName: "render.log",
      renderScriptPath: "tools/render.ts",
      scriptRunner: {
        command: "runner",
        runnerArgs: ["tsx"],
      },
    },
    sigintStop: {
      runtimeStopLibPath: "tools/runtime-stop-lib.sh",
      logLinePrefix: "interrupting pid",
      completionLogLine: "interrupt complete",
      collectProcessPatterns: ["runner.*api", "node.*watch"],
    },
    splitUpstreamPorts: {
      defaultSplitModeEnabled: true,
      primaryDefaultPort: 4100,
      primaryEnvName: "API_PORT",
      primaryFallbackEnvNames: ["LEGACY_API_PORT"],
      secondaryEnvName: "ADMIN_PORT",
      secondaryOffsetFromPrimary: 100,
      splitModeEnvName: "SPLIT_ENABLED",
    },
    startupReport: {
      commandLabel: "test-runtime",
      directHost: "localhost",
      directLabelPadWidth: 8,
      directSectionLogLine: "direct urls",
      edgeSectionLogLine: "edge urls",
      primaryMethodEnvName: "EDGE_METHOD",
      scopeLogPrefix: "scope",
      sectionLogLine: "url matrix",
      splitModeLogLabel: "split",
      topologySelectorLogLabel: "selector",
    },
    workspaceRegistration: {
      defaultEnvFileRelativePath: ".env.edge",
      defaultRootEnvFileValue: "",
      logFileName: "register.log",
      registerScriptPath: "tools/register.ts",
      scriptRunner: {
        command: "runner",
        runnerArgs: ["tsx"],
      },
    },
    concurrentlyProcesses: [
      {
        id: "api",
        name: "API",
        color: "blue.bold",
        includeWhenSplitModeEnabled: true,
        includeWhenSplitModeDisabled: false,
      },
      {
        id: "web",
        name: "WEB",
        color: "green.bold",
        includeWhenSplitModeEnabled: true,
        includeWhenSplitModeDisabled: true,
      },
      {
        id: "optional-docs",
        name: "DOCS",
        color: "yellow.bold",
        includeWhenSplitModeEnabled: true,
        includeWhenSplitModeDisabled: true,
        optionalProjectRelativePath: "docs/package.json",
        optionalAbsentLogLines: [
          "Optional docs checkout is absent; skipping docs server.",
        ],
      },
    ],
    directUpstreamUrls: [
      {
        label: "web",
        surfaceId: "web",
        requestPath: "/",
      },
      {
        label: "api",
        surfaceId: "api",
        requestPath: "v1/status",
      },
    ],
    devOverlays: [
      {
        id: "api",
        appName: "api-app",
        packageRelativePath: "apps/api",
        logLabel: "api overlay",
        requiredWhenSplitModeEnabled: true,
        requiredWhenSplitModeDisabled: false,
      },
      {
        id: "web",
        appName: "web-app",
        packageRelativePath: "apps/web",
        logLabel: "web overlay",
        requiredWhenSplitModeEnabled: true,
        requiredWhenSplitModeDisabled: true,
      },
    ],
    dependencyCheck: {
      skipEnvName: "SKIP_DEPS",
      skipCommand: "SKIP_DEPS=true npm run start",
      installAllCommand: "npm run install-all",
      packages: [
        {
          id: "api",
          packageRelativePath: "apps/api",
        },
        {
          id: "web",
          packageRelativePath: "apps/web",
        },
      ],
    },
    internalDependencyNamePrefixes: ["@example/"],
    openOnStart: {
      enabledEnvName: "OPEN_HELPER",
      requiredCommand: "runner",
      missingCommandWarning: "runner missing",
      startLogLine: "starting helper",
      scriptRunner: {
        command: "runner",
        runnerArgs: ["tsx"],
      },
      scriptPath: "tools/open.ts",
      projectRootArg: "--project-root",
      overlayId: "web",
      envFileEnvName: "ENV_FILES",
    },
    packageEnvFileNames: [".env", ".env.local"],
    processCommands: [
      {
        id: "api",
        kind: "local-edge-runtime-launch-process-command-kind-npm-dev",
        packageRelativePath: "apps/api",
        envExports: [
          {
            name: "MODE",
            source: "local-edge-runtime-launch-env-export-source-literal",
            value: "local-edge",
          },
          {
            name: "HOST",
            source: "local-edge-runtime-launch-env-export-source-surface-host",
            surfaceId: "api",
          },
          {
            name: "PORT",
            source: "local-edge-runtime-launch-env-export-source-upstream-port",
            surfaceId: "api",
          },
          {
            name: "ENV_FILES",
            source:
              "local-edge-runtime-launch-env-export-source-overlay-env-files",
            overlayId: "api",
          },
        ],
      },
      {
        id: "web",
        kind: "local-edge-runtime-launch-process-command-kind-shell",
        command: "npm --prefix apps/web run dev",
        envExports: [
          {
            name: "ENV_FILES",
            source:
              "local-edge-runtime-launch-env-export-source-overlay-env-files",
            overlayId: "web",
          },
        ],
      },
    ],
    runtimeAudit: {
      enabledEnvName: "AUDIT_ENABLED",
      methodEnvName: "AUDIT_METHOD",
      strictEnvName: "AUDIT_STRICT",
      defaultEnabled: true,
      defaultStrict: true,
      scriptRunner: {
        command: "runner",
        runnerArgs: ["tsx"],
      },
      statusScriptPath: "tools/status.ts",
      dnsAuditScriptPath: "tools/dns.ts",
    },
    startupUrlSurfaceIds: ["web", "api"],
  },
  surfaces: [
    {
      id: "web",
      appPath: "/",
      statusPath: "/status",
      healthcheck: {
        upstreamPortEnvName: "WEB_PORT",
        defaultUpstreamPort: 3000,
      },
    },
    {
      id: "api",
      appPath: "/v1/status",
      statusPath: "/v1/status",
      healthcheck: {
        upstreamPortEnvName: "API_PORT",
        defaultUpstreamPort: 4000,
      },
    },
    {
      id: "internal",
      appPath: "/",
      statusPath: "/health",
    },
  ],
};

const runtimeLaunchConfigWithCustomEnvNames: LocalEdgeKit_Config = {
  ...runtimeLaunchConfig,
  env: {
    envFileEnvName: "EDGE_ENV_FILE",
    generatedDirEnvName: "EDGE_GENERATED_DIR",
    primaryMethodEnvName: "EDGE_METHOD",
    projectRootEnvName: "EDGE_PROJECT_ROOT",
    realmSlugEnvName: "EDGE_REALM",
    rootEnvFileEnvName: "EDGE_ROOT_ENV_FILE",
  },
};

async function waitForRuntimeLaunchTestChildExit(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });
}

void test("LocalEdgeKit_buildRuntimeLaunchSurfaceUrls uses configured startup surfaces", () => {
  const rows = LocalEdgeKit_buildRuntimeLaunchSurfaceUrls({
    config: runtimeLaunchConfig,
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_DEVELOPER_SLUG: "ada",
      LOCAL_EDGE_ENV_SLUG: "feature",
    },
  });

  assert.deepEqual(
    rows.map((row) => row.surfaceId),
    ["web", "api"],
  );
  assert.equal(rows[0]?.host, "web.feature.nginx-docker.ada.local.test");
  assert.equal(
    rows[0]?.appUrl,
    "https://web.feature.nginx-docker.ada.local.test/",
  );
  assert.equal(
    rows[0]?.statusUrl,
    "https://web.feature.nginx-docker.ada.local.test/status",
  );
  assert.equal(
    rows[1]?.appUrl,
    "https://api.feature.nginx-docker.ada.local.test/v1/status",
  );
});

void test("LocalEdgeKit_buildRuntimeLaunchSurfaceUrls defaults to URL-matrix surfaces", () => {
  const baseConfig = { ...runtimeLaunchConfig };
  delete baseConfig.runtimeLaunch;
  const rows = LocalEdgeKit_buildRuntimeLaunchSurfaceUrls({
    config: {
      ...baseConfig,
      surfaces: [
        ...runtimeLaunchConfig.surfaces,
        {
          id: "hidden",
          appPath: "/",
          statusPath: "/status",
          includeInUrlMatrix: false,
        },
      ],
    },
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_NGINX_DOCKER_PORT: "8443",
    },
  });

  assert.deepEqual(
    rows.map((row) => row.surfaceId),
    ["web", "api", "internal"],
  );
  assert.equal(
    rows[0]?.appUrl,
    "https://web.main.nginx-docker.dev.local.test:8443/",
  );
});

void test("LocalEdgeKit_shellQuoteSingle preserves runtime shell escaping", () => {
  assert.equal(LocalEdgeKit_shellQuoteSingle(""), "''");
  assert.equal(LocalEdgeKit_shellQuoteSingle("a'b"), `'a'\"'\"''b'`);
});

void test("LocalEdgeKit_checkRuntimeLaunchCommandAvailable probes PATH", () => {
  assert.equal(
    LocalEdgeKit_checkRuntimeLaunchCommandAvailable({
      name: process.execPath,
    }),
    true,
  );
  assert.equal(
    LocalEdgeKit_checkRuntimeLaunchCommandAvailable({
      name: "local-edge-kit-definitely-missing-command",
    }),
    false,
  );
});

void test("LocalEdgeKit_runtimeLaunchExitCodeFromChildProcessEvent normalizes signals", () => {
  assert.equal(
    LocalEdgeKit_runtimeLaunchExitCodeFromChildProcessEvent(7, null),
    7,
  );
  assert.equal(
    LocalEdgeKit_runtimeLaunchExitCodeFromChildProcessEvent(null, "SIGINT"),
    130,
  );
  assert.equal(
    LocalEdgeKit_runtimeLaunchExitCodeFromChildProcessEvent(null, "SIGTERM"),
    143,
  );
  assert.equal(
    LocalEdgeKit_runtimeLaunchExitCodeFromChildProcessEvent(null, null),
    1,
  );
});

void test("LocalEdgeKit_parseRuntimeLaunchChildPid rejects invalid pid text", () => {
  assert.equal(LocalEdgeKit_parseRuntimeLaunchChildPid(""), null);
  assert.equal(LocalEdgeKit_parseRuntimeLaunchChildPid("abc"), null);
  assert.equal(LocalEdgeKit_parseRuntimeLaunchChildPid("123"), 123);
});

void test("LocalEdgeKit_runRuntimeLaunchCommandSync returns child exit status", () => {
  const result = LocalEdgeKit_runRuntimeLaunchCommandSync({
    command: {
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
    },
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
  });

  assert.equal(result.succeeded, false);
  assert.equal(result.status, 7);
});

void test("LocalEdgeKit_runRuntimeLaunchLoggedCommandSync writes command output", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "local-edge-kit-runtime-launch-"),
  );
  try {
    const logFile = path.join(tempDir, "runtime.log");
    const result = LocalEdgeKit_runRuntimeLaunchLoggedCommandSync({
      command: {
        command: process.execPath,
        args: ["-e", "console.log('logged runtime output')"],
      },
      cwd: tempDir,
      env: process.env,
      failureLogLine: "runtime helper failed",
      logFile,
      tailLines: 5,
    });

    assert.equal(result.succeeded, true);
    assert.match(readFileSync(logFile, "utf8"), /logged runtime output/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

void test("LocalEdgeKit_runRuntimeLaunchDelegationPhase returns delegated exit code", () => {
  const projectRoot = process.cwd();
  const config: LocalEdgeKit_Config = {
    ...runtimeLaunchConfig,
    runtimeLaunch: {
      delegation: {
        bypassEnvName: "BYPASS",
        commandScriptPath: "tools/delegate.ts",
        guardFilePath: ".tmp/delegate.json",
        projectRootArgName: "--workspace",
        scriptRunner: {
          command: process.execPath,
          runnerArgs: ["-e", "process.exit(5)"],
        },
        startLogLine: "delegating",
      },
    },
  };
  const logLines: string[] = [];
  const result = LocalEdgeKit_runRuntimeLaunchDelegationPhase({
    config,
    env: {},
    logLine: (line) => {
      logLines.push(line);
    },
    pathExists: (filePath) =>
      filePath === path.join(projectRoot, ".tmp/delegate.json"),
    projectRoot,
  });

  assert.deepEqual(result, {
    exitCode: 5,
  });
  assert.deepEqual(logLines, ["delegating"]);
});

void test("LocalEdgeKit_runRuntimeLaunchWorkspaceRegistrationPhase returns registered realm", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "local-edge-kit-registration-"),
  );
  try {
    const config: LocalEdgeKit_Config = {
      ...runtimeLaunchConfig,
      lifecycle: {
        logDir: "logs",
      },
      runtimeLaunch: {
        workspaceRegistration: {
          defaultEnvFileRelativePath: ".env.edge",
          defaultRootEnvFileValue: "",
          logFileName: "register.log",
          registerScriptPath: "tools/register.ts",
          scriptRunner: {
            command: process.execPath,
            runnerArgs: ["-e", "console.log('registered realm')"],
          },
        },
      },
    };
    const logLines: string[] = [];
    const result = LocalEdgeKit_runRuntimeLaunchWorkspaceRegistrationPhase({
      config,
      env: {
        LOCAL_EDGE_ENV_SLUG: "feature",
      },
      logLine: (line) => {
        logLines.push(line);
      },
      projectRoot: tempDir,
    });

    assert.deepEqual(result, {
      exitCode: null,
      registeredRealmSlug: "feature",
    });
    assert.deepEqual(logLines, [
      `[local] Registering root workspace realm 'feature' for ${tempDir}...`,
    ]);
    assert.match(
      readFileSync(path.join(tempDir, "logs", "register.log"), "utf8"),
      /registered realm/,
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

void test("LocalEdgeKit_runRuntimeLaunchRenderArtifactsPhase runs logged render command", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "local-edge-kit-render-"));
  try {
    const config: LocalEdgeKit_Config = {
      ...runtimeLaunchConfig,
      lifecycle: {
        logDir: "logs",
      },
      runtimeLaunch: {
        renderArtifacts: {
          logFileName: "render.log",
          renderScriptPath: "tools/render.ts",
          scriptRunner: {
            command: process.execPath,
            runnerArgs: ["-e", "console.log('rendered artifacts')"],
          },
        },
      },
    };
    const result = LocalEdgeKit_runRuntimeLaunchRenderArtifactsPhase({
      config,
      env: {},
      projectRoot: tempDir,
    });

    assert.deepEqual(result, {
      exitCode: null,
    });
    assert.match(
      readFileSync(path.join(tempDir, "logs", "render.log"), "utf8"),
      /rendered artifacts/,
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

void test("LocalEdgeKit_runRuntimeLaunchEnsureInfrastructurePhase returns failure status", () => {
  const projectRoot = process.cwd();
  const config: LocalEdgeKit_Config = {
    ...runtimeLaunchConfig,
    runtimeLaunch: {
      ensureInfrastructure: {
        commandName: "ensure",
        methodArgName: "--method",
        realmArgName: "--realm",
        scriptRunner: {
          command: process.execPath,
          runnerArgs: ["-e", "process.exit(7)"],
        },
        startupCliScriptPath: "tools/startup.ts",
      },
    },
  };
  const logLines: string[] = [];
  const result = LocalEdgeKit_runRuntimeLaunchEnsureInfrastructurePhase({
    config,
    env: {},
    logLine: (line) => {
      logLines.push(line);
    },
    projectRoot,
  });

  assert.deepEqual(result, {
    exitCode: 7,
  });
  assert.deepEqual(logLines, [
    "[local:section] Local Edge: Ensure Infrastructure",
    "[local] Ensuring local edge services are running...",
  ]);
});

void test("LocalEdgeKit_runRuntimeLaunchRuntimeAuditPhase returns strict audit failure", () => {
  const projectRoot = process.cwd();
  const statusScriptPath = path.join(projectRoot, "tools/status.ts");
  const config: LocalEdgeKit_Config = {
    ...runtimeLaunchConfig,
    runtimeLaunch: {
      runtimeAudit: {
        defaultEnabled: true,
        defaultStrict: true,
        dnsAuditScriptPath: "tools/dns.ts",
        enabledEnvName: "AUDIT_ENABLED",
        methodEnvName: "AUDIT_METHOD",
        scriptRunner: {
          command: process.execPath,
          runnerArgs: [
            "-e",
            `process.exit(process.argv.includes(${JSON.stringify(statusScriptPath)}) ? 3 : 0)`,
          ],
        },
        statusScriptPath: "tools/status.ts",
        strictEnvName: "AUDIT_STRICT",
      },
    },
  };
  const result = LocalEdgeKit_runRuntimeLaunchRuntimeAuditPhase({
    config,
    env: {},
    fallbackMethod: "nginx-docker",
    logLine: () => {
      // Suppress phase log lines in unit output.
    },
    projectRoot,
  });

  assert.deepEqual(result, {
    exitCode: 3,
  });
});

void test("LocalEdgeKit_runRuntimeLaunchStartupReportPhase emits report lines", () => {
  const logLines: string[] = [];
  const result = LocalEdgeKit_runRuntimeLaunchStartupReportPhase({
    config: runtimeLaunchConfig,
    env: {
      EDGE_METHOD: "nginx-docker",
      LOCAL_EDGE_DEVELOPER_SLUG: "ada",
      LOCAL_EDGE_ENV_SLUG: "feature",
      WEB_PORT: "3100",
      API_PORT: "4100",
    },
    logLine: (line) => {
      logLines.push(line);
    },
    projectRoot: "/repo",
  });

  assert.deepEqual(result, {
    exitCode: null,
  });
  assert.equal(logLines.includes("url matrix"), true);
  assert.equal(
    logLines.includes(
      "[local] nginx-docker app    web https://web.feature.nginx-docker.ada.local.test/",
    ),
    true,
  );
});

void test("LocalEdgeKit_runRuntimeLaunchPlatformWithOverlaysPhase returns overlay failure before launching", async () => {
  const errorLines: string[] = [];
  const logLines: string[] = [];
  const result = await LocalEdgeKit_runRuntimeLaunchPlatformWithOverlaysPhase({
    config: runtimeLaunchConfig,
    env: {},
    errorLine: (line) => {
      errorLines.push(line);
    },
    generatedEnvDir: "/tmp/generated/env",
    logLine: (line) => {
      logLines.push(line);
    },
    machineRoot: "/tmp/machine",
    method: "nginx-docker",
    pathExists: () => false,
    projectRoot: "/repo",
  });

  assert.equal(result, 1);
  assert.equal(
    logLines.includes(
      "[local:section] Platform Apps: Start Development Services",
    ),
    true,
  );
  assert.deepEqual(errorLines, [
    "[local] ERROR: Missing generated local-edge env overlay for api-app: /tmp/generated/env/api-app.env",
    "[local] ERROR: Missing generated local-edge env overlay for web-app: /tmp/generated/env/web-app.env",
  ]);
});

void test("LocalEdgeKit_startRuntimeLaunchBackgroundHealthPhase returns child pid", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "local-edge-kit-health-phase-"),
  );
  try {
    const config: LocalEdgeKit_Config = {
      ...runtimeLaunchConfig,
      runtimeLaunch: {
        backgroundHealth: {
          ...runtimeLaunchConfig.runtimeLaunch?.backgroundHealth,
          enabledEnvName: "HEALTH_ENABLED",
          methodEnvName: "HEALTH_METHOD",
          realmEnvName: "HEALTH_REALM",
          intervalMsEnvName: "HEALTH_INTERVAL_MS",
          steadyIntervalMsEnvName: "HEALTH_STEADY_MS",
          timeoutMsEnvName: "HEALTH_TIMEOUT_MS",
          maxWaitMsEnvName: "HEALTH_MAX_WAIT_MS",
          strictEnvName: "HEALTH_STRICT",
          defaultEnabled: true,
          defaultIntervalMs: "5000",
          defaultSteadyIntervalMs: "15000",
          defaultTimeoutMs: "5000",
          defaultMaxWaitMs: "",
          defaultStrict: false,
          logFileName: "health.log",
          scriptRunner: {
            command: process.execPath,
            runnerArgs: ["-e", ""],
          },
          healthcheckScriptPath: "tools/health.ts",
        },
      },
    };
    const logLines: string[] = [];
    const result = LocalEdgeKit_startRuntimeLaunchBackgroundHealthPhase({
      config,
      env: {},
      fallbackMethod: "nginx-docker",
      fallbackRealm: "main",
      logDir: tempDir,
      logLine: (line) => {
        logLines.push(line);
      },
      projectRoot: tempDir,
    });

    assert.deepEqual(result.exitCode, null);
    assert.equal(result.pid.length > 0, true);
    assert.equal(
      logLines.some((line) =>
        line.startsWith("[local] Background local-edge health monitor started"),
      ),
      true,
    );
  } finally {
    await waitForRuntimeLaunchTestChildExit();
    rmSync(tempDir, { force: true, recursive: true });
  }
});

void test("LocalEdgeKit_startRuntimeLaunchActiveEnvWatcherPhase returns child pid", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "local-edge-kit-watcher-phase-"),
  );
  try {
    const config: LocalEdgeKit_Config = {
      ...runtimeLaunchConfig,
      runtimeLaunch: {
        activeEnvWatcher: {
          defaultEnabled: true,
          defaultEnvFileRelativePath: ".env.edge",
          defaultRootEnvFileValue: "",
          enabledEnvName: "WATCH_ENABLED",
          logFileName: "watch.log",
          scriptRunner: {
            command: process.execPath,
            runnerArgs: ["-e", ""],
          },
          watcherScriptPath: "tools/watch.ts",
        },
      },
    };
    const result = LocalEdgeKit_startRuntimeLaunchActiveEnvWatcherPhase({
      config,
      env: {},
      logDir: tempDir,
      logLine: () => {
        // Suppress phase log lines in unit output.
      },
      projectRoot: tempDir,
    });

    assert.deepEqual(result.exitCode, null);
    assert.equal(result.pid.length > 0, true);
  } finally {
    await waitForRuntimeLaunchTestChildExit();
    rmSync(tempDir, { force: true, recursive: true });
  }
});

void test("LocalEdgeKit_applyRuntimeLaunchHostOverridePhase mutates configured env", () => {
  const env: NodeJS.ProcessEnv = {
    HOST: "127.0.0.1",
    WEB_LISTEN_HOST: "0.0.0.0",
  };
  const logLines: string[] = [];

  LocalEdgeKit_applyRuntimeLaunchHostOverridePhase({
    config: runtimeLaunchConfig,
    env,
    logLine: (line) => {
      logLines.push(line);
    },
  });

  assert.equal(env.HOST, "0.0.0.0");
  assert.deepEqual(logLines, [
    "[local] Overriding HOST for web dev server from WEB_LISTEN_HOST or its default.",
  ]);
});

void test("no echo: the host-override log line names the variables and never prints a value", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchHostOverridePlan({
    config: runtimeLaunchConfig,
    env: {
      HOST: "ECHOMARK-PRIOR.example.test",
      WEB_LISTEN_HOST: "ECHOMARK-NEW.example.test",
    },
  });

  assert.equal(plan.value, "ECHOMARK-NEW.example.test");
  assert.ok(plan.logLine !== null);
  assert.ok(plan.logLine.includes("HOST"));
  assert.ok(plan.logLine.includes("WEB_LISTEN_HOST"));
  assert.equal(plan.logLine.includes("ECHOMARK"), false);
  assert.equal(plan.logLine.includes("'"), false);
});

void test("LocalEdgeKit_runRuntimeLaunchDependencyCheckPhase returns report exit code", () => {
  const result = LocalEdgeKit_runRuntimeLaunchDependencyCheckPhase({
    config: runtimeLaunchConfig,
    env: {},
    filesystem: {
      exists: (filePath) => filePath === "/repo/apps/api/package.json",
      readText: () =>
        JSON.stringify({
          dependencies: {
            missing: "1.0.0",
          },
        }),
    },
    logLine: () => {
      // Suppress dependency report lines in unit output.
    },
    repoRoot: "/repo",
  });

  assert.deepEqual(result, {
    exitCode: 1,
  });
});

void test("LocalEdgeKit_runRuntimeLaunchCleanupPhase runs configured cleanup commands", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "local-edge-kit-cleanup-phase-"),
  );
  try {
    const cleanupLog = path.join(tempDir, "cleanup.log");
    const config: LocalEdgeKit_Config = {
      ...runtimeLaunchConfig,
      runtimeLaunch: {
        cleanup: {
          platformStopScriptPath: "tools/stop.ts",
          realmInactiveScriptPath: "tools/mark-inactive.ts",
          scriptRunner: {
            command: process.execPath,
            runnerArgs: [
              "-e",
              "require('node:fs').appendFileSync(process.env.CLEANUP_LOG, process.argv.slice(1).join('|') + '\\n')",
            ],
          },
        },
      },
    };

    LocalEdgeKit_runRuntimeLaunchCleanupPhase({
      config,
      env: {
        CLEANUP_LOG: cleanupLog,
      },
      healthPid: "",
      logLine: () => {
        // Suppress cleanup log lines in unit output.
      },
      pathExists: (filePath) =>
        filePath === path.join(tempDir, "tools/stop.ts"),
      projectRoot: tempDir,
      registeredRealmSlug: "feature",
      watcherPid: "",
    });

    const logText = readFileSync(cleanupLog, "utf8");
    assert.match(logText, /tools\/stop\.ts/);
    assert.match(logText, /tools\/mark-inactive\.ts\|feature/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

void test("LocalEdgeKit_buildRuntimeLaunchNpmDevShellCommand quotes env and prefix values", () => {
  assert.equal(
    LocalEdgeKit_buildRuntimeLaunchNpmDevShellCommand({
      prefixFolder: "app folder",
      envExports: {
        MODE: "local edge",
        TOKEN: "a'b",
      },
    }),
    `env MODE='local edge' TOKEN='a'\"'\"''b' npm run dev --prefix 'app folder'`,
  );
});

void test("LocalEdgeKit_resolveRuntimeLaunchOverlayPath prefers realm overlays", () => {
  assert.equal(
    LocalEdgeKit_resolveRuntimeLaunchOverlayPath({
      appName: "web",
      env: { LOCAL_EDGE_ENV_SLUG: "feature" },
      generatedEnvDir: "/tmp/generated/env",
      machineRoot: "/tmp/machine",
      pathExists: (filePath) =>
        filePath === "/tmp/machine/realms/feature/env/web.env",
    }),
    "/tmp/machine/realms/feature/env/web.env",
  );
  assert.equal(
    LocalEdgeKit_resolveRuntimeLaunchOverlayPath({
      appName: "web",
      env: { LOCAL_EDGE_ENV_SLUG: "feature" },
      generatedEnvDir: "/tmp/generated/env",
      machineRoot: "/tmp/machine",
      pathExists: () => false,
    }),
    "/tmp/generated/env/web.env",
  );
});

void test("LocalEdgeKit_buildRuntimeLaunchPackageEnvFileList uses configured env names", () => {
  assert.equal(
    LocalEdgeKit_buildRuntimeLaunchPackageEnvFileList({
      config: runtimeLaunchConfig,
      overlayFile: "/tmp/overlay.env",
      packageRoot: "/tmp/app",
    }),
    "/tmp/overlay.env:/tmp/app/.env:/tmp/app/.env.local",
  );
});

void test("LocalEdgeKit_readRuntimeLaunchPackageDependencyNames parses dependency sections", () => {
  assert.deepEqual(
    LocalEdgeKit_readRuntimeLaunchPackageDependencyNames(
      JSON.stringify({
        dependencies: {
          alpha: "1.0.0",
        },
        devDependencies: {
          beta: "1.0.0",
        },
      }),
    ),
    ["alpha", "beta"],
  );
});

void test("LocalEdgeKit_findMissingRuntimeLaunchNpmDeps skips configured internal prefixes", () => {
  const existingPaths = new Set([
    "/repo/app/package.json",
    "/repo/node_modules/present",
  ]);
  const missing = LocalEdgeKit_findMissingRuntimeLaunchNpmDeps({
    config: runtimeLaunchConfig,
    packageRoot: "/repo/app",
    repoRoot: "/repo",
    filesystem: {
      exists: (filePath) => existingPaths.has(filePath),
      readText: () =>
        JSON.stringify({
          dependencies: {
            present: "1.0.0",
            missing: "1.0.0",
            "@example/internal": "1.0.0",
          },
        }),
    },
  });

  assert.deepEqual(missing, ["missing"]);
});

void test("LocalEdgeKit_buildRuntimeLaunchDirectUpstreamUrls uses configured direct surfaces", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchDirectUpstreamUrls({
    config: runtimeLaunchConfig,
    env: {
      API_PORT: "4100",
    },
    host: "localhost",
  });

  assert.deepEqual(plan, {
    missingPortSurfaceIds: [],
    missingSurfaceIds: [],
    rows: [
      {
        label: "web",
        url: "http://localhost:3000/",
      },
      {
        label: "api",
        url: "http://localhost:4100/v1/status",
      },
    ],
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchDevOverlayPlan resolves required overlays and env lists", () => {
  const existingPaths = new Set([
    "/tmp/machine/realms/feature/env/api-app.env",
    "/tmp/generated/env/web-app.env",
  ]);
  const plan = LocalEdgeKit_buildRuntimeLaunchDevOverlayPlan({
    config: runtimeLaunchConfig,
    env: {
      LOCAL_EDGE_ENV_SLUG: "feature",
    },
    generatedEnvDir: "/tmp/generated/env",
    machineRoot: "/tmp/machine",
    pathExists: (filePath) => existingPaths.has(filePath),
    projectRoot: "/repo",
    splitModeEnabled: true,
  });

  const api = LocalEdgeKit_requireRuntimeLaunchDevOverlayEntry({
    id: "api",
    plan,
  });
  const web = LocalEdgeKit_requireRuntimeLaunchDevOverlayEntry({
    id: "web",
    plan,
  });

  assert.equal(api.overlayFile, "/tmp/machine/realms/feature/env/api-app.env");
  assert.equal(
    api.envFileList,
    "/tmp/machine/realms/feature/env/api-app.env:/repo/apps/api/.env:/repo/apps/api/.env.local",
  );
  assert.equal(web.overlayFile, "/tmp/generated/env/web-app.env");
  assert.deepEqual(plan.missingRequiredLogLines, []);
  assert.deepEqual(plan.overlayLogLines, [
    "[local] Launching platform services with per-app local-edge env overlays:",
    "[local] api overlay /tmp/machine/realms/feature/env/api-app.env",
    "[local] web overlay /tmp/generated/env/web-app.env",
  ]);
});

void test("LocalEdgeKit_buildRuntimeLaunchDevOverlayPlan reports missing required overlays", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchDevOverlayPlan({
    config: runtimeLaunchConfig,
    env: {},
    generatedEnvDir: "/tmp/generated/env",
    machineRoot: "/tmp/machine",
    pathExists: () => false,
    projectRoot: "/repo",
    splitModeEnabled: true,
  });

  assert.deepEqual(plan.missingRequiredLogLines, [
    "[local] ERROR: Missing generated local-edge env overlay for api-app: /tmp/generated/env/api-app.env",
    "[local] ERROR: Missing generated local-edge env overlay for web-app: /tmp/generated/env/web-app.env",
  ]);
});

void test("LocalEdgeKit_buildRuntimeLaunchProcessCommandsPlan builds npm and shell commands", () => {
  const overlayPlan = LocalEdgeKit_buildRuntimeLaunchDevOverlayPlan({
    config: runtimeLaunchConfig,
    env: {},
    generatedEnvDir: "/tmp/generated/env",
    machineRoot: "/tmp/machine",
    pathExists: (filePath) =>
      filePath === "/tmp/generated/env/api-app.env" ||
      filePath === "/tmp/generated/env/web-app.env",
    projectRoot: "/repo",
    splitModeEnabled: true,
  });
  const processCommandPlan = LocalEdgeKit_buildRuntimeLaunchProcessCommandsPlan(
    {
      config: runtimeLaunchConfig,
      env: {
        API_PORT: "4100",
      },
      method: "nginx-docker",
      overlayPlan,
      projectRoot: "/repo",
    },
  );

  assert.deepEqual(processCommandPlan.errorLogLines, []);
  assert.equal(
    processCommandPlan.processCommands.api,
    "env MODE='local-edge' HOST='api.main.nginx-docker.dev.local.test' PORT='4100' ENV_FILES='/tmp/generated/env/api-app.env:/repo/apps/api/.env:/repo/apps/api/.env.local' npm run dev --prefix 'apps/api'",
  );
  assert.equal(
    processCommandPlan.processCommands.web,
    "env ENV_FILES='/tmp/generated/env/web-app.env:/repo/apps/web/.env:/repo/apps/web/.env.local' npm --prefix apps/web run dev",
  );
});

void test("LocalEdgeKit_buildRuntimeLaunchOpenOnStartPlan builds optional helper command", () => {
  const overlayPlan = LocalEdgeKit_buildRuntimeLaunchDevOverlayPlan({
    config: runtimeLaunchConfig,
    env: {},
    generatedEnvDir: "/tmp/generated/env",
    machineRoot: "/tmp/machine",
    pathExists: (filePath) => filePath === "/tmp/generated/env/web-app.env",
    projectRoot: "/repo",
    splitModeEnabled: false,
  });
  const plan = LocalEdgeKit_buildRuntimeLaunchOpenOnStartPlan({
    config: runtimeLaunchConfig,
    env: {
      OPEN_HELPER: "true",
    },
    overlayPlan,
    projectRoot: "/repo",
  });

  assert.deepEqual(plan, {
    command: {
      command: "runner",
      args: ["tsx", "/repo/tools/open.ts", "--project-root", "/repo"],
    },
    enabled: true,
    envOverrides: {
      ENV_FILES:
        "/tmp/generated/env/web-app.env:/repo/apps/web/.env:/repo/apps/web/.env.local",
    },
    missingCommandWarning: "runner missing",
    requiredCommand: "runner",
    startLogLine: "starting helper",
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchCleanupPlan builds stop and realm inactive commands", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchCleanupPlan({
    config: runtimeLaunchConfig,
    pathExists: (filePath) => filePath === "/repo/tools/stop.ts",
    projectRoot: "/repo",
    realmSlug: "feature",
  });

  assert.deepEqual(plan, {
    platformStopCommand: {
      command: "runner",
      args: ["tsx", "/repo/tools/stop.ts"],
    },
    realmInactiveCommand: {
      command: "runner",
      args: ["tsx", "/repo/tools/mark-inactive.ts", "feature"],
    },
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchCleanupPlan omits absent optional stop script", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchCleanupPlan({
    config: runtimeLaunchConfig,
    pathExists: () => false,
    projectRoot: "/repo",
    realmSlug: null,
  });

  assert.deepEqual(plan, {
    platformStopCommand: null,
    realmInactiveCommand: null,
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchWorkspaceRegistrationPlan builds command, env, and logs", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchWorkspaceRegistrationPlan({
    config: runtimeLaunchConfigWithCustomEnvNames,
    env: {
      EDGE_METHOD: "nginx-docker",
      EDGE_REALM: "feature",
    },
    projectRoot: "/repo",
  });

  assert.deepEqual(plan, {
    command: {
      command: "runner",
      args: ["tsx", "/repo/tools/register.ts"],
    },
    envOverrides: {
      EDGE_ENV_FILE: "/repo/.env.edge",
      EDGE_PROJECT_ROOT: "/repo",
      EDGE_ROOT_ENV_FILE: "",
    },
    failureLogLine:
      "[local] ERROR: Root workspace realm registration failed. See /repo/logs/local-edge/register.log.",
    logFile: "/repo/logs/local-edge/register.log",
    realmSlug: "feature",
    startLogLine:
      "[local] Registering root workspace realm 'feature' for /repo...",
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchRenderArtifactsPlan builds render command", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchRenderArtifactsPlan({
    config: runtimeLaunchConfigWithCustomEnvNames,
    env: {
      EDGE_METHOD: "nginx-docker",
    },
    projectRoot: "/repo",
  });

  assert.deepEqual(plan, {
    command: {
      command: "runner",
      args: ["tsx", "/repo/tools/render.ts", "--method", "nginx-docker"],
    },
    failureLogLine:
      "[local] ERROR: Shared render failed. See /repo/logs/local-edge/render.log.",
    logFile: "/repo/logs/local-edge/render.log",
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchEnsureInfrastructurePlan builds startup command", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchEnsureInfrastructurePlan({
    config: runtimeLaunchConfigWithCustomEnvNames,
    env: {
      EDGE_METHOD: "nginx-docker",
      EDGE_REALM: "feature",
    },
    projectRoot: "/repo",
  });

  assert.deepEqual(plan, {
    command: {
      command: "runner",
      args: [
        "tsx",
        "/repo/tools/startup.ts",
        "run",
        "ensure",
        "--",
        "--method",
        "nginx-docker",
        "--realm",
        "feature",
      ],
    },
    logLines: [
      "[local:section] Local Edge: Ensure Infrastructure",
      "[local] Ensuring local edge services are running...",
    ],
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchSigintStopPlan builds runtime-stop shell command", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchSigintStopPlan({
    config: runtimeLaunchConfig,
    projectRoot: "/repo",
  });

  assert.deepEqual(plan.command?.command, "bash");
  assert.deepEqual(plan.command?.args[0], "-c");
  const script = plan.command?.args[1] ?? "";
  assert.equal(
    script.includes("source '/repo/tools/runtime-stop-lib.sh'"),
    true,
  );
  assert.equal(
    script.includes(
      "runtime_stop_collect_checkout_scoped_pids '/repo' 'runner.*api' 'node.*watch'",
    ),
    true,
  );
  assert.equal(
    script.includes("printf '%s %s\\n' 'interrupting pid' \"$sigint_pid\" >&2"),
    true,
  );
  assert.equal(
    script.includes("printf '%s\\n' 'interrupt complete' >&2"),
    true,
  );
});

void test("LocalEdgeKit_buildRuntimeLaunchEnvironmentPlan resolves env file and generated paths", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchEnvironmentPlan({
    config: runtimeLaunchConfig,
    env: {
      LOG_EDGE_ENV_LOADS: "true",
    },
    pathExists: (filePath) => filePath === "/repo/.env.edge",
    projectRoot: "/repo",
  });

  assert.deepEqual(plan, {
    envFile: "/repo/.env.edge",
    envFileLoadLogEnabled: true,
    envFileLoadedLogLine: "[local] Loaded local-edge env file: /repo/.env.edge",
    generatedEnvDir: "/repo/.tmp/edge/env/generated",
    logDir: "/repo/logs/local-edge",
    machineRoot: "/repo/.tmp/edge",
    shouldLoadEnvFile: true,
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchEnvironmentPlan respects env overrides", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchEnvironmentPlan({
    config: runtimeLaunchConfigWithCustomEnvNames,
    env: {
      EDGE_ENV_FILE: "/tmp/custom.env",
      EDGE_GENERATED_DIR: "/tmp/generated-root",
      EDGE_METHOD: "nginx-docker",
    },
    pathExists: () => false,
    projectRoot: "/repo",
  });

  assert.equal(plan.envFile, "/tmp/custom.env");
  assert.equal(plan.generatedEnvDir, "/tmp/generated-root/env/generated");
  assert.equal(plan.shouldLoadEnvFile, false);
  assert.equal(plan.envFileLoadLogEnabled, false);
  assert.equal(plan.envFileLoadedLogLine, null);
});

void test("LocalEdgeKit_buildRuntimeLaunchSplitUpstreamPortsPlan resolves split and combined ports", () => {
  const splitPlan = LocalEdgeKit_buildRuntimeLaunchSplitUpstreamPortsPlan({
    config: runtimeLaunchConfig,
    env: {
      LEGACY_API_PORT: "4200",
    },
  });

  assert.deepEqual(splitPlan, {
    envOverrides: {
      API_PORT: "4200",
      ADMIN_PORT: "4300",
    },
    primaryPort: 4200,
    secondaryPort: 4300,
    splitModeEnabled: true,
  });

  const combinedPlan = LocalEdgeKit_buildRuntimeLaunchSplitUpstreamPortsPlan({
    config: runtimeLaunchConfig,
    env: {
      API_PORT: "4101",
      SPLIT_ENABLED: "false",
    },
  });

  assert.deepEqual(combinedPlan, {
    envOverrides: {
      API_PORT: "4101",
      ADMIN_PORT: "4101",
    },
    primaryPort: 4101,
    secondaryPort: 4101,
    splitModeEnabled: false,
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchHostOverridePlan builds process env override", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchHostOverridePlan({
    config: runtimeLaunchConfig,
    env: {
      HOST: "127.0.0.1",
      WEB_LISTEN_HOST: "0.0.0.0",
    },
  });

  assert.deepEqual(plan, {
    envName: "HOST",
    logLine:
      "[local] Overriding HOST for web dev server from WEB_LISTEN_HOST or its default.",
    value: "0.0.0.0",
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchDelegationPlan builds command when guard exists", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchDelegationPlan({
    config: runtimeLaunchConfig,
    env: {},
    pathExists: (filePath) => filePath === "/repo/.tmp/delegate/metadata.json",
    projectRoot: "/repo",
  });

  assert.deepEqual(plan, {
    command: {
      command: "runner",
      args: ["tsx", "/repo/tools/delegate.ts", "--workspace", "/repo"],
    },
    startLogLine: "delegating runtime launch",
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchDelegationPlan skips absent guard and bypass env", () => {
  const absentGuardPlan = LocalEdgeKit_buildRuntimeLaunchDelegationPlan({
    config: runtimeLaunchConfig,
    env: {},
    pathExists: () => false,
    projectRoot: "/repo",
  });
  const bypassPlan = LocalEdgeKit_buildRuntimeLaunchDelegationPlan({
    config: runtimeLaunchConfig,
    env: {
      DELEGATE_BYPASS: "true",
    },
    pathExists: (filePath) => filePath === "/repo/.tmp/delegate/metadata.json",
    projectRoot: "/repo",
  });

  assert.deepEqual(absentGuardPlan, {
    command: null,
    startLogLine: null,
  });
  assert.deepEqual(bypassPlan, {
    command: null,
    startLogLine: null,
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchStartupReportPlan renders direct and edge URL lines", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchStartupReportPlan({
    config: runtimeLaunchConfig,
    env: {
      EDGE_METHOD: "nginx-docker",
      LOCAL_EDGE_DEVELOPER_SLUG: "ada",
      LOCAL_EDGE_ENV_SLUG: "feature",
      WEB_PORT: "3100",
      API_PORT: "4100",
    },
    projectRoot: "/repo",
  });

  assert.deepEqual(plan.errorLogLines, []);
  assert.deepEqual(plan.logLines.slice(0, 7), [
    "url matrix",
    "direct urls",
    "[local] web      http://localhost:3100/",
    "[local] api      http://localhost:4100/v1/status",
    "[local] split: SPLIT_ENABLED=true",
    "edge urls",
    "[local] selector: EDGE_METHOD=nginx-docker",
  ]);
  assert.equal(
    plan.logLines.includes("[local] scope: methods=nginx-docker"),
    true,
  );
  assert.equal(
    plan.logLines.includes(
      "[local] nginx-docker app    web https://web.feature.nginx-docker.ada.local.test/",
    ),
    true,
  );
});

void test("LocalEdgeKit_buildRuntimeLaunchRuntimeAuditPlan builds status and DNS commands", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchRuntimeAuditPlan({
    config: runtimeLaunchConfig,
    env: {
      AUDIT_METHOD: "all",
      AUDIT_STRICT: "false",
    },
    fallbackMethod: "nginx-docker",
    projectRoot: "/repo",
  });

  assert.equal(plan.enabled, true);
  assert.equal(plan.strict, false);
  assert.equal(plan.method, "nginx-docker");
  assert.deepEqual(plan.warningLines, [
    "[local] WARNING: AUDIT_METHOD=all is deprecated in single-method mode. Using 'nginx-docker'.",
  ]);
  assert.deepEqual(plan.statusCommand, {
    command: "runner",
    args: [
      "tsx",
      "/repo/tools/status.ts",
      "--method",
      "nginx-docker",
      "--require-running",
    ],
  });
  assert.deepEqual(plan.dnsAuditCommand, {
    command: "runner",
    args: [
      "tsx",
      "/repo/tools/dns.ts",
      "--method",
      "nginx-docker",
      "--no-strict",
    ],
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchRuntimeAuditPlan supports configured disable env", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchRuntimeAuditPlan({
    config: runtimeLaunchConfig,
    env: {
      AUDIT_ENABLED: "false",
    },
    fallbackMethod: "nginx-docker",
    projectRoot: "/repo",
  });

  assert.equal(plan.enabled, false);
  assert.equal(plan.statusCommand, null);
  assert.equal(plan.dnsAuditCommand, null);
  assert.deepEqual(plan.logLines, [
    "[local:section] Local Edge: Runtime Audit",
    "[local] Skipping runtime local-edge audit (AUDIT_ENABLED=false).",
  ]);
});

void test("LocalEdgeKit_buildRuntimeLaunchBackgroundHealthPlan builds monitor command", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchBackgroundHealthPlan({
    config: runtimeLaunchConfig,
    env: {
      HEALTH_METHOD: "unsupported",
      HEALTH_REALM: "feature",
      HEALTH_INTERVAL_MS: "1000",
      HEALTH_MAX_WAIT_MS: "30000",
      HEALTH_STRICT: "true",
    },
    fallbackMethod: "nginx-docker",
    fallbackRealm: "main",
    logDir: "/repo/logs",
    projectRoot: "/repo",
  });

  assert.equal(plan.enabled, true);
  assert.equal(plan.strict, true);
  assert.equal(plan.logFile, "/repo/logs/health.log");
  assert.deepEqual(plan.warningLines, [
    "[local] WARNING: Unsupported HEALTH_METHOD value. Using 'nginx-docker'.",
  ]);
  assert.deepEqual(plan.command, {
    command: "runner",
    args: [
      "tsx",
      "/repo/tools/health.ts",
      "--method",
      "nginx-docker",
      "--realm",
      "feature",
      "--watch",
      "--interval-ms",
      "1000",
      "--steady-interval-ms",
      "15000",
      "--timeout-ms",
      "5000",
      "--strict",
      "--max-wait-ms",
      "30000",
    ],
  });
});

void test("LocalEdgeKit_buildRuntimeLaunchBackgroundHealthPlan supports configured disable env", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchBackgroundHealthPlan({
    config: runtimeLaunchConfig,
    env: {
      HEALTH_ENABLED: "false",
    },
    fallbackMethod: "nginx-docker",
    fallbackRealm: "main",
    logDir: "/repo/logs",
    projectRoot: "/repo",
  });

  assert.equal(plan.enabled, false);
  assert.equal(plan.command, null);
  assert.equal(plan.logFile, null);
  assert.deepEqual(plan.logLines, [
    "[local] Skipping background local-edge health monitor (HEALTH_ENABLED=false).",
  ]);
});

void test("LocalEdgeKit_buildRuntimeLaunchActiveEnvWatcherPlan builds watcher command and env", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchActiveEnvWatcherPlan({
    config: runtimeLaunchConfig,
    env: {},
    logDir: "/repo/logs",
    projectRoot: "/repo",
  });

  assert.equal(plan.enabled, true);
  assert.equal(plan.logFile, "/repo/logs/watch.log");
  assert.deepEqual(plan.command, {
    command: "runner",
    args: ["tsx", "/repo/tools/watch.ts"],
  });
  assert.deepEqual(plan.envOverrides, {
    LOCAL_EDGE_PROJECT_ROOT: "/repo",
    LOCAL_EDGE_ENV_FILE: "/repo/.env.edge",
    LOCAL_EDGE_ROOT_ENV_FILE: "",
  });
  assert.deepEqual(plan.logLines, [
    "[local:section] Local Edge: Source Env Watcher",
    "[local] Starting active local-edge source watcher...",
    "[local] Source watcher log: /repo/logs/watch.log",
  ]);
});

void test("LocalEdgeKit_buildRuntimeLaunchActiveEnvWatcherPlan supports configured disable env", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchActiveEnvWatcherPlan({
    config: runtimeLaunchConfig,
    env: {
      WATCH_ENABLED: "false",
    },
    logDir: "/repo/logs",
    projectRoot: "/repo",
  });

  assert.equal(plan.enabled, false);
  assert.equal(plan.command, null);
  assert.equal(plan.logFile, null);
  assert.deepEqual(plan.logLines, [
    "[local] Skipping active local-edge source watcher (WATCH_ENABLED=false).",
  ]);
});

void test("LocalEdgeKit_buildRuntimeLaunchDependencyCheckReport renders failures from configured packages", () => {
  const packageJsonByPath = new Map([
    [
      "/repo/apps/api/package.json",
      JSON.stringify({
        dependencies: {
          present: "1.0.0",
          missing: "1.0.0",
        },
      }),
    ],
    [
      "/repo/apps/web/package.json",
      JSON.stringify({
        dependencies: {
          present: "1.0.0",
        },
      }),
    ],
  ]);
  const existingPaths = new Set([
    "/repo/apps/api/package.json",
    "/repo/apps/web/package.json",
    "/repo/node_modules/present",
  ]);
  const report = LocalEdgeKit_buildRuntimeLaunchDependencyCheckReport({
    config: runtimeLaunchConfig,
    env: {},
    repoRoot: "/repo",
    filesystem: {
      exists: (filePath) => existingPaths.has(filePath),
      readText: (filePath) => packageJsonByPath.get(filePath) ?? "{}",
    },
  });

  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.failures, [
    {
      id: "api",
      packageRelativePath: "apps/api",
      packageRoot: "/repo/apps/api",
      missingDependencyNames: ["missing"],
    },
  ]);
  assert.equal(report.skipped, false);
  assert.ok(report.logLines.includes("To skip this check, run with:"));
  assert.ok(report.logLines.includes("   SKIP_DEPS=true npm run start"));
});

void test("LocalEdgeKit_buildRuntimeLaunchDependencyCheckReport supports configured skip env", () => {
  const report = LocalEdgeKit_buildRuntimeLaunchDependencyCheckReport({
    config: runtimeLaunchConfig,
    env: { SKIP_DEPS: "true" },
    repoRoot: "/repo",
    filesystem: {
      exists: () => false,
      readText: () => "{}",
    },
  });

  assert.equal(report.exitCode, 0);
  assert.equal(report.skipped, true);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.logLines, [
    "[local] Skipping dependency check (SKIP_DEPS=true).",
  ]);
});

void test("LocalEdgeKit_buildRuntimeLaunchConcurrentlyArgsPlan filters by split mode and optional paths", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchConcurrentlyArgsPlan({
    config: runtimeLaunchConfig,
    projectRoot: "/repo",
    splitModeEnabled: true,
    pathExists: () => false,
    processCommands: {
      api: "npm run api",
      web: "npm run web",
      "optional-docs": "npm run docs",
    },
  });

  assert.deepEqual(plan.concurrentArgs, [
    "--names",
    "API,WEB",
    "--prefix",
    "{name}",
    "--prefix-colors",
    "blue.bold,green.bold",
    "npm run api",
    "npm run web",
  ]);
  assert.deepEqual(plan.skippedProcesses, [
    {
      id: "optional-docs",
      logLines: ["Optional docs checkout is absent; skipping docs server."],
    },
  ]);
  assert.deepEqual(plan.missingCommandProcessIds, []);
});

void test("LocalEdgeKit_buildRuntimeLaunchConcurrentlyArgsPlan reports missing required commands", () => {
  const plan = LocalEdgeKit_buildRuntimeLaunchConcurrentlyArgsPlan({
    config: runtimeLaunchConfig,
    projectRoot: "/repo",
    splitModeEnabled: false,
    pathExists: (filePath) => filePath === "/repo/docs/package.json",
    processCommands: {
      web: "npm run web",
    },
  });

  assert.deepEqual(plan.concurrentArgs, [
    "--names",
    "WEB",
    "--prefix",
    "{name}",
    "--prefix-colors",
    "green.bold",
    "npm run web",
  ]);
  assert.deepEqual(plan.missingCommandProcessIds, ["optional-docs"]);
  assert.deepEqual(plan.skippedProcesses, []);
});
