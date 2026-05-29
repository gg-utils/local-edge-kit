/**
 * @fileoverview Verifies config-driven local-edge lifecycle planning and orchestration for start, stop,
 * ensure-running, setup, init, and doctor flows without live host shell or Docker I/O.
 *
 * This file owns regression coverage for `lifecycle-plans.js` plan builders, env-driven request resolvers,
 * and `LocalEdgeKit_run*` lifecycles when `executeHostCommandPlan`, filesystem hooks, and loggers are injected.
 * Flow: build `LocalEdgeKit_Config` fixture -> resolve or run lifecycle entrypoints -> assert derived commands,
 * artifacts, stdout/stderr lines, and exit codes.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/lifecycle-plans.unit.test.ts
 *
 * @see packages/local-edge-kit/src/lifecycle-plans.ts - Implementation under test that builds nginx-docker compose plans, resolves startup-cli requests, and sequences render/setup/start/stop/doctor work with injectable host-command and hook seams exercised here.
 * @see packages/local-edge-kit/src/config.ts - `LocalEdgeKit_Config` shape used by the inline `exampleConfig` fixture to keep router, lifecycle, render, and surface facts deterministic across resolver and runner assertions.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview contract governing this header shape and verification tags.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { LocalEdgeKit_Config } from "./config.js";
import {
  LocalEdgeKit_buildStartNginxDockerPlan,
  LocalEdgeKit_buildStopMethodPlan,
  LocalEdgeKit_renderStartNginxDockerPlanShellAssignments,
  LocalEdgeKit_resolveDoctorRequest,
  LocalEdgeKit_resolveEnsureRunningRequest,
  LocalEdgeKit_resolveInitRequest,
  LocalEdgeKit_resolveSetupRequest,
  LocalEdgeKit_resolveStartRequest,
  LocalEdgeKit_resolveStopRequest,
  LocalEdgeKit_runDoctorLifecycle,
  LocalEdgeKit_runEnsureRunningLifecycle,
  LocalEdgeKit_runInitLifecycle,
  LocalEdgeKit_runSetupLifecycle,
  LocalEdgeKit_runStartLifecycle,
  LocalEdgeKit_runStopLifecycle,
  type LocalEdgeKit_RunHostCommandPlanOptions,
} from "./lifecycle-plans.js";

const exampleConfig: LocalEdgeKit_Config = {
  identity: {
    defaultDeveloperSlug: "dev",
    defaultRealmSlug: "main",
    defaultRootZone: "local.test",
  },
  router: {
    primaryMethod: "nginx-docker",
    singleMethodMode: true,
    methods: [
      {
        kind: "nginx-docker",
        method: "nginx-docker",
        serviceName: "router",
        defaultListenHost: "127.0.0.1",
        defaultListenPort: 443,
        composePathEnvName: "EXAMPLE_COMPOSE_PATH",
        composeProjectNameEnvName: "EXAMPLE_COMPOSE_PROJECT",
        composeProjectNamePrefix: "example-router",
        includeRealmSlugInDefaultComposeProjectName: false,
      },
    ],
  },
  lifecycle: {
    ensureRouterProbeSurfaceId: "web",
    envOverlayValidationScript: "tools/validate-env.ts",
    initDefaultExposureMode: "split-dns",
    initDefaultIdentitySurfaceLabel: "T0",
    initDeprecatedEnvNames: ["OLD_EXAMPLE_ENV"],
    initDeveloperSlugPromptRejectedDefaults: ["legacy-user", "default"],
    initEnvTemplatePath: "config/.env.local-edge.example",
    setupMissingEnvWarnings: [
      { envName: "EXAMPLE_DEVELOPER", message: "developer missing" },
      { envName: "EXAMPLE_METHODS", message: "methods missing" },
    ],
    setupRequiredUtilities: ["bash", "npx"],
    setupStrictStartEnvName: "EXAMPLE_STRICT_START",
  },
  render: {
    artifactPath: "artifacts/render.json",
    nginxDocker: {
      certPath: "/cert.pem",
      keyPath: "/key.pem",
      configTargetPath: "/nginx.conf",
      defaultUpstreamHost: "host.docker.internal",
      image: "nginx:latest",
      labels: [],
      restartPolicy: "no",
      serviceName: "router",
    },
    nginxHttp: {
      generatedBy: "test",
      mimeTypesPath: "/mime.types",
      workerProcesses: 1,
      workerConnections: 1,
      keepaliveTimeoutSeconds: 1,
      serverNamesHashBucketSize: 1,
      variablesHashBucketSize: 1,
      variablesHashMaxSize: 1,
      clientBodyTimeoutSeconds: 1,
      clientMaxBodySize: "1m",
      proxyConnectTimeoutSeconds: 1,
      proxyReadTimeoutSeconds: 1,
      proxySendTimeoutSeconds: 1,
      sendTimeoutSeconds: 1,
      timeoutCommentLines: [],
      dockerResolver: null,
    },
    routeGroups: [],
    routerIngress: {
      healthPath: "/health",
      healthBody: "ok",
    },
    upstreams: [],
  },
  surfaces: [
    {
      id: "web",
      appPath: "/",
      statusPath: "/status",
    },
  ],
};

function LifecyclePlans_testCommandRole(
  options: LocalEdgeKit_RunHostCommandPlanOptions,
): "render" | "setup" | "start" | "status" | "stop" | "unknown" {
  const commandText = options.plan.args.join(" ");
  if (commandText.includes("render.ts")) return "render";
  if (commandText.includes(" setup ")) return "setup";
  if (commandText.includes("start-nginx-docker.sh")) return "start";
  if (commandText.includes("status.ts")) return "status";
  if (commandText.includes(" stop ")) return "stop";
  return "unknown";
}

test("LocalEdgeKit_buildStartNginxDockerPlan derives compose start commands", () => {
  const plan = LocalEdgeKit_buildStartNginxDockerPlan({
    config: exampleConfig,
    method: "nginx-docker",
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_DEVELOPER_SLUG: "ada",
      LOCAL_EDGE_ENV_SLUG: "feature-a",
    },
  });

  assert.equal(plan.method, "nginx-docker");
  assert.equal(plan.port, "443");
  assert.equal(plan.listenHost, "127.0.0.1");
  assert.equal(plan.timeoutSeconds, "20");
  assert.equal(plan.startBinary, "docker");
  assert.equal(plan.customLoopbackRequired, false);
  assert.equal(
    plan.startCommand,
    'docker compose -p "example-router-ada" -f "/tmp/example/.tmp/local-edge/router/nginx-docker/docker-compose.yml" up -d',
  );
});

test("LocalEdgeKit_buildStartNginxDockerPlan preserves command overrides", () => {
  const plan = LocalEdgeKit_buildStartNginxDockerPlan({
    config: exampleConfig,
    method: "nginx-docker",
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_NGINX_DOCKER_START_CMD: "'docker' compose up -d",
      LOCAL_EDGE_NGINX_DOCKER_HOST: "127.0.0.3",
      LOCAL_EDGE_START_TIMEOUT_SECONDS: "45",
    },
  });
  const assignments =
    LocalEdgeKit_renderStartNginxDockerPlanShellAssignments(plan);

  assert.equal(plan.startBinary, "docker");
  assert.equal(plan.customLoopbackRequired, true);
  assert.equal(plan.timeoutSeconds, "45");
  assert.match(assignments, /METHOD='nginx-docker'/);
  assert.match(assignments, /START_BIN='docker'/);
  assert.match(assignments, /TIMEOUT_SECONDS='45'/);
});

test("LocalEdgeKit_buildStopMethodPlan derives stop commands and paths", () => {
  const plan = LocalEdgeKit_buildStopMethodPlan({
    config: exampleConfig,
    method: "nginx-docker",
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_DEVELOPER_SLUG: "ada",
      LOCAL_EDGE_ENV_SLUG: "feature-a",
    },
  });

  assert.deepEqual(plan, {
    method: "nginx-docker",
    generatedDir: "/tmp/example/.tmp/local-edge",
    port: 443,
    listenHost: "127.0.0.1",
    stopCommand:
      'docker compose -p "example-router-ada" -f "/tmp/example/.tmp/local-edge/router/nginx-docker/docker-compose.yml" down',
    logDir: "/tmp/example/logs/local-edge",
    artifactsDir: "/tmp/example/logs/local-edge/artifacts",
  });
});

test("LocalEdgeKit_resolveStartRequest builds a method start command plan", () => {
  const result = LocalEdgeKit_resolveStartRequest({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.method, "nginx-docker");
    assert.deepEqual(result.command, {
      command: "bash",
      args: ["/tmp/example/scripts/local-edge/start-nginx-docker.sh"],
      timeoutMs: 120_000,
    });
  }
});

test("LocalEdgeKit_resolveStartRequest reports missing method env", () => {
  const result = LocalEdgeKit_resolveStartRequest({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {},
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.exitCode, 2);
    assert.equal(
      result.stderrLine,
      "[local-edge:start] Missing LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD.\n",
    );
  }
});

test("LocalEdgeKit_runStartLifecycle executes the resolved start plan", () => {
  const roles: string[] = [];
  const exitCode = LocalEdgeKit_runStartLifecycle({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
    },
    executeHostCommandPlan: (options) => {
      roles.push(LifecyclePlans_testCommandRole(options));
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(roles, ["start"]);
});

test("LocalEdgeKit_resolveStopRequest expands all configured methods", () => {
  const result = LocalEdgeKit_resolveStopRequest({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_DEVELOPER_SLUG: "ada",
      LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "all",
      LOCAL_EDGE_ALLOW_PORT_KILL: "true",
      LOCAL_EDGE_STOP_TIMEOUT_SECONDS: "9",
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.method, "all");
    assert.equal(result.allowPortKill, true);
    assert.equal(result.timeoutSeconds, 9);
    assert.equal(result.timeoutWarningLine, null);
    assert.equal(result.methodPlans.length, 1);
    assert.equal(result.methodPlans[0]?.method, "nginx-docker");
    assert.equal(
      result.methodPlans[0]?.stopCommand,
      'docker compose -p "example-router-ada" -f "/tmp/example/.tmp/local-edge/router/nginx-docker/docker-compose.yml" down',
    );
  }
});

test("LocalEdgeKit_runStopLifecycle stops methods and writes artifacts", () => {
  const infoLines: string[] = [];
  const warningLines: string[] = [];
  const stdoutLines: string[] = [];
  const stopCommands: string[] = [];
  const artifacts: Array<{
    artifactsDir: string;
    content: string;
    name: string;
  }> = [];

  const exitCode = LocalEdgeKit_runStopLifecycle({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_DEVELOPER_SLUG: "ada",
      LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
      LOCAL_EDGE_STOP_TIMEOUT_SECONDS: "1",
    },
    hooks: {
      isPortListening: () => false,
      runStopCommand: (options) => {
        stopCommands.push(`${options.method}:${options.command}`);
      },
      terminateListenersOnPort: () => {
        throw new Error("force kill should not be needed");
      },
      writeArtifact: (artifact) => {
        artifacts.push(artifact);
      },
    },
    loggers: {
      error: () => {},
      info: (line) => {
        infoLines.push(line);
      },
      warn: (line) => {
        warningLines.push(line);
      },
    },
    stdout: (line) => {
      stdoutLines.push(line);
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(infoLines, [
    "Stopping method='nginx-docker' on expected bind 127.0.0.1:443",
  ]);
  assert.deepEqual(warningLines, []);
  assert.deepEqual(stdoutLines, ["[local-edge:stop] Completed.\n"]);
  assert.deepEqual(stopCommands, [
    'nginx-docker:docker compose -p "example-router-ada" -f "/tmp/example/.tmp/local-edge/router/nginx-docker/docker-compose.yml" down',
  ]);
  assert.deepEqual(artifacts, [
    {
      artifactsDir: "/tmp/example/logs/local-edge/artifacts",
      content:
        "method=nginx-docker\nhost=127.0.0.1\nport=443\nstatus=stopped\n",
      name: "nginx-docker.stopped",
    },
  ]);
});

test("LocalEdgeKit_runStopLifecycle force-kills listeners when configured", () => {
  let listenChecks = 0;
  let nowMs = 0;
  const killedPorts: number[] = [];
  const artifacts: Array<{ content: string; name: string }> = [];

  const exitCode = LocalEdgeKit_runStopLifecycle({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_DEVELOPER_SLUG: "ada",
      LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
      LOCAL_EDGE_ALLOW_PORT_KILL: "true",
      LOCAL_EDGE_STOP_TIMEOUT_SECONDS: "1",
    },
    hooks: {
      isPortListening: () => {
        listenChecks += 1;
        return listenChecks === 1;
      },
      runStopCommand: () => {},
      terminateListenersOnPort: (port) => {
        killedPorts.push(port);
      },
      writeArtifact: (artifact) => {
        artifacts.push({
          content: artifact.content,
          name: artifact.name,
        });
      },
    },
    loggers: {
      error: () => {},
      info: () => {},
      warn: () => {},
    },
    nowMs: () => {
      nowMs += 1000;
      return nowMs;
    },
    sleep: () => {},
    stdout: () => {},
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(killedPorts, [443]);
  assert.deepEqual(artifacts, [
    {
      content:
        "method=nginx-docker\nhost=127.0.0.1\nport=443\nstatus=stopped-after-force-kill\n",
      name: "nginx-docker.stopped",
    },
  ]);
});

test("LocalEdgeKit_resolveStopRequest warns and defaults invalid timeouts", () => {
  const result = LocalEdgeKit_resolveStopRequest({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
      LOCAL_EDGE_STOP_TIMEOUT_SECONDS: "bad",
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.timeoutSeconds, 20);
    assert.equal(
      result.timeoutWarningLine,
      "LOCAL_EDGE_STOP_TIMEOUT_SECONDS must be numeric. Current value='bad'.",
    );
  }
});

test("LocalEdgeKit_resolveEnsureRunningRequest validates startup env", () => {
  const result = LocalEdgeKit_resolveEnsureRunningRequest({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_DEVELOPER_SLUG: "ada",
      LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
      LOCAL_EDGE_STARTUP_CLI_ENSURE_REALM_WAS_SET: "1",
      LOCAL_EDGE_STARTUP_CLI_ENSURE_REALM_VALUE: "demo",
      LOCAL_EDGE_STARTUP_CLI_ENSURE_RECREATE: "1",
      LOCAL_EDGE_ROUTER_PROBE_CONNECT_TIMEOUT_SECONDS: "4",
      LOCAL_EDGE_ROUTER_PROBE_MAX_TIME_SECONDS: "7",
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.method, "nginx-docker");
    assert.equal(result.realm, "demo");
    assert.equal(result.forceRecreateIfRunning, true);
    assert.deepEqual(result.configuredMethods, ["nginx-docker"]);
    assert.deepEqual(result.routerProbe, {
      connectTimeoutSeconds: 4,
      maxTimeSeconds: 7,
      url: "https://web.demo.nginx-docker.ada.local.test/health",
    });
    assert.deepEqual(result.commands.render, {
      command: "npx",
      args: [
        "tsx",
        "/tmp/example/scripts/local-edge/render.ts",
        "--method",
        "nginx-docker",
      ],
      timeoutMs: 120_000,
    });
    assert.deepEqual(result.commands.setup, {
      command: "npx",
      args: [
        "tsx",
        "/tmp/example/scripts/local-edge/startup-cli/local-edge-startup-cli.ts",
        "run",
        "setup",
        "--",
        "--method",
        "nginx-docker",
      ],
      timeoutMs: 120_000,
    });
    assert.deepEqual(result.commands.statusRequireRunning, {
      command: "npx",
      args: [
        "tsx",
        "/tmp/example/scripts/local-edge/status.ts",
        "--method",
        "nginx-docker",
        "--require-running",
      ],
      timeoutMs: 30_000,
    });
    assert.deepEqual(result.commands.start, {
      command: "bash",
      args: ["/tmp/example/scripts/local-edge/start-nginx-docker.sh"],
      env: {
        LOCAL_EDGE_SKIP_RENDER: "true",
        LOCAL_EDGE_SKIP_SETUP: "true",
      },
      timeoutMs: 120_000,
    });
  }
});

test("LocalEdgeKit_resolveEnsureRunningRequest reports missing method env", () => {
  const result = LocalEdgeKit_resolveEnsureRunningRequest({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {},
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.exitCode, 2);
    assert.equal(
      result.stderrLine,
      "[local-edge:ensure-running] Missing LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD.\n",
    );
  }
});

test("LocalEdgeKit_runEnsureRunningLifecycle cold-starts inactive method", () => {
  const commandRoles: string[] = [];
  const stdoutLines: string[] = [];
  const statusResults = [1, 0];
  const result = LocalEdgeKit_runEnsureRunningLifecycle({
    config: exampleConfig,
    env: {
      LOCAL_EDGE_DEVELOPER_SLUG: "ada",
      LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
    },
    executeHostCommandPlan: (options) => {
      const role = LifecyclePlans_testCommandRole(options);
      commandRoles.push(role);
      if (role === "status") {
        return statusResults.shift() ?? 1;
      }
      return 0;
    },
    hooks: {
      ensureMethodReadyForStartup: () => ({ ok: true }),
      methodRuntimeMatchesCurrentArtifacts: () => true,
      reloadRunningMethod: () => true,
      routerHostProbe: () => true,
    },
    projectRoot: "/tmp/example",
    stdout: (line) => {
      stdoutLines.push(line);
    },
  });

  assert.equal(result, 0);
  assert.deepEqual(commandRoles, [
    "status",
    "render",
    "setup",
    "start",
    "status",
  ]);
  assert.equal(
    stdoutLines.includes(
      "[local-edge:ensure-running] Method 'nginx-docker' is not running. Starting...\n",
    ),
    true,
  );
  assert.equal(
    stdoutLines.includes(
      "[local-edge:ensure-running] Method 'nginx-docker' is now running.\n",
    ),
    true,
  );
});

test("LocalEdgeKit_runEnsureRunningLifecycle recreates stale running method", () => {
  const commandRoles: string[] = [];
  const stdoutLines: string[] = [];
  const result = LocalEdgeKit_runEnsureRunningLifecycle({
    config: exampleConfig,
    env: {
      LOCAL_EDGE_DEVELOPER_SLUG: "ada",
      LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
    },
    executeHostCommandPlan: (options) => {
      commandRoles.push(LifecyclePlans_testCommandRole(options));
      return 0;
    },
    hooks: {
      ensureMethodReadyForStartup: () => ({ ok: true }),
      methodRuntimeMatchesCurrentArtifacts: () => false,
      reloadRunningMethod: () => true,
      routerHostProbe: () => true,
    },
    projectRoot: "/tmp/example",
    stdout: (line) => {
      stdoutLines.push(line);
    },
  });

  assert.equal(result, 0);
  assert.deepEqual(commandRoles, [
    "status",
    "render",
    "setup",
    "stop",
    "start",
    "status",
  ]);
  assert.equal(
    stdoutLines.includes(
      "[local-edge:ensure-running] Primary/local-edge method 'nginx-docker' is running with stale mounted artifacts.\n",
    ),
    true,
  );
  assert.equal(
    stdoutLines.includes(
      "[local-edge:ensure-running] Method 'nginx-docker' was recreated with current artifacts.\n",
    ),
    true,
  );
});

test("LocalEdgeKit_resolveSetupRequest builds a host-operation-free setup plan", () => {
  const result = LocalEdgeKit_resolveSetupRequest({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
      LOCAL_EDGE_STARTUP_CLI_SETUP_STRICT: "false",
      LOCAL_EDGE_STARTUP_CLI_SETUP_WRITE_ARTIFACT: "0",
      LOCAL_EDGE_NGINX_DOCKER_HOST: "127.0.0.3",
      LOCAL_EDGE_START_TIMEOUT_SECONDS: "bogus",
      EXAMPLE_DEVELOPER: "ada",
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.method, "nginx-docker");
    assert.equal(result.writeArtifact, false);
    assert.equal(result.customLoopbackHost, "127.0.0.3");
    assert.equal(result.setupStrictStartEnvName, "EXAMPLE_STRICT_START");
    assert.equal(result.setupStrictStartEnvValue, "false");
    assert.deepEqual(result.requiredUtilities, ["bash", "npx"]);
    assert.deepEqual(result.missingEnvWarningLines, ["methods missing"]);
    assert.equal(
      result.startTimeoutWarningLine,
      "LOCAL_EDGE_START_TIMEOUT_SECONDS must be numeric. Current value='bogus'.",
    );
    assert.deepEqual(result.envOverlayValidation, {
      command: "npx",
      args: ["tsx", "/tmp/example/tools/validate-env.ts"],
      timeoutMs: 30_000,
    });
    assert.deepEqual(result.artifact, {
      artifactsDir: "/tmp/example/logs/local-edge/artifacts",
      name: "setup-last-run.txt",
    });
  }
});

test("LocalEdgeKit_runSetupLifecycle validates overlays and writes setup artifact", () => {
  const commands: string[] = [];
  const infoLines: string[] = [];
  const warningLines: string[] = [];
  const errorLines: string[] = [];
  const stdoutLines: string[] = [];
  const artifacts: Array<{
    artifactsDir: string;
    content: string;
    name: string;
  }> = [];
  const env: NodeJS.ProcessEnv = {
    EXAMPLE_DEVELOPER: "ada",
    EXAMPLE_METHODS: "nginx-docker",
    LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
    LOCAL_EDGE_TLS_MODE: "provided",
  };

  const exitCode = LocalEdgeKit_runSetupLifecycle({
    config: exampleConfig,
    env,
    executeHostCommandPlan: (options) => {
      commands.push(options.plan.args.join(" "));
      return 0;
    },
    hooks: {
      commandExists: () => true,
      loopbackAliasExists: () => true,
      mkcertTrustDetected: () => true,
      writeArtifact: (artifact) => {
        artifacts.push(artifact);
      },
    },
    loggers: {
      error: (line) => {
        errorLines.push(line);
      },
      info: (line) => {
        infoLines.push(line);
      },
      warn: (line) => {
        warningLines.push(line);
      },
    },
    now: () => new Date("2026-05-20T00:00:00.000Z"),
    projectRoot: "/tmp/example",
    stdout: (line) => {
      stdoutLines.push(line);
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(commands, ["tsx /tmp/example/tools/validate-env.ts"]);
  assert.deepEqual(infoLines, ["Validating setup for method='nginx-docker'"]);
  assert.deepEqual(warningLines, []);
  assert.deepEqual(errorLines, []);
  assert.deepEqual(stdoutLines, [
    "[local-edge:setup] Setup validation completed.\n",
  ]);
  assert.deepEqual(artifacts, [
    {
      artifactsDir: "/tmp/example/logs/local-edge/artifacts",
      content:
        "runAt=2026-05-20T00:00:00.000Z\nmethod=nginx-docker\nstrict=false\nstatus=ok\n",
      name: "setup-last-run.txt",
    },
  ]);
});

test("LocalEdgeKit_runSetupLifecycle fails strict setup before overlay validation", () => {
  const commands: string[] = [];
  const warnings: string[] = [];
  const env: NodeJS.ProcessEnv = {
    EXAMPLE_DEVELOPER: "ada",
    EXAMPLE_METHODS: "nginx-docker",
    LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
    LOCAL_EDGE_STRICT_START: "true",
    LOCAL_EDGE_TLS_MODE: "provided",
  };

  const exitCode = LocalEdgeKit_runSetupLifecycle({
    config: exampleConfig,
    env,
    executeHostCommandPlan: (options) => {
      commands.push(options.plan.command);
      return 0;
    },
    hooks: {
      commandExists: (commandName) => commandName !== "npx",
      loopbackAliasExists: () => true,
      mkcertTrustDetected: () => true,
      writeArtifact: () => {
        throw new Error("artifact should not be written");
      },
    },
    loggers: {
      error: () => {},
      info: () => {},
      warn: (line) => {
        warnings.push(line);
      },
    },
    projectRoot: "/tmp/example",
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(commands, []);
  assert.deepEqual(warnings, ["Required utility not found: npx"]);
});

test("LocalEdgeKit_resolveInitRequest derives files, flags, and post-write commands", () => {
  const request = LocalEdgeKit_resolveInitRequest({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_ENV_FILE: "/tmp/custom/.env.local-edge",
      LOCAL_EDGE_STARTUP_CLI_INIT_WRITE_CHANGES: "0",
      LOCAL_EDGE_STARTUP_CLI_INIT_RUN_CHECKS: "1",
      LOCAL_EDGE_STARTUP_CLI_INIT_RUN_BOOTSTRAP: "true",
      LOCAL_EDGE_STARTUP_CLI_INIT_PROMPT_DEVELOPER_SLUG: "false",
      LOCAL_EDGE_STARTUP_CLI_INIT_DEVELOPER_SLUG_OVERRIDE: "ada",
    },
  });

  assert.equal(request.envFileEnvName, "LOCAL_EDGE_ENV_FILE");
  assert.equal(request.envFilePath, "/tmp/custom/.env.local-edge");
  assert.equal(
    request.envTemplatePath,
    "/tmp/example/config/.env.local-edge.example",
  );
  assert.deepEqual(request.deprecatedEnvNames, ["OLD_EXAMPLE_ENV"]);
  assert.equal(request.writeChanges, false);
  assert.equal(request.runChecks, true);
  assert.equal(request.runBootstrap, true);
  assert.equal(request.promptDeveloperSlug, "false");
  assert.equal(request.developerSlugOverride, "ada");
  assert.deepEqual(request.postWriteCommands.bootstrap, {
    command: "bash",
    args: ["/tmp/example/scripts/local-edge/setup-bootstrap.sh"],
    timeoutMs: 300_000,
  });
  assert.deepEqual(request.postWriteCommands.render, {
    command: "npx",
    args: ["tsx", "/tmp/example/scripts/local-edge/render.ts"],
    timeoutMs: 120_000,
  });
  assert.deepEqual(request.postWriteCommands.setup, {
    command: "npx",
    args: [
      "tsx",
      "/tmp/example/scripts/local-edge/startup-cli/local-edge-startup-cli.ts",
      "run",
      "setup",
      "--",
      "--no-artifact",
    ],
    timeoutMs: 120_000,
  });
  assert.deepEqual(request.postWriteCommands.configPrint, {
    command: "npx",
    args: ["tsx", "/tmp/example/scripts/local-edge/config-print.ts"],
    timeoutMs: 30_000,
  });
});

test("LocalEdgeKit_resolveInitRequest uses configured env file variable names", () => {
  const request = LocalEdgeKit_resolveInitRequest({
    config: {
      ...exampleConfig,
      env: {
        envFileEnvName: "EXAMPLE_LOCAL_EDGE_ENV_FILE",
      },
    },
    projectRoot: "/tmp/example",
    env: {
      EXAMPLE_LOCAL_EDGE_ENV_FILE: "relative.env",
      LOCAL_EDGE_STARTUP_CLI_INIT_PROMPT_DEVELOPER_SLUG: "unexpected",
    },
  });

  assert.equal(request.envFileEnvName, "EXAMPLE_LOCAL_EDGE_ENV_FILE");
  assert.equal(request.envFilePath, path.resolve("relative.env"));
  assert.equal(request.promptDeveloperSlug, "auto");
});

test("LocalEdgeKit_runInitLifecycle normalizes and writes env values", async () => {
  const files = new Map<string, string>([
    [
      "/tmp/example/config/.env.local-edge.example",
      [
        "LOCAL_EDGE_DEVELOPER_SLUG=legacy-user",
        "LOCAL_EDGE_ENV_SLUG=",
        "LOCAL_EDGE_METHODS=unknown,nginx-docker,nginx-docker",
        "LOCAL_EDGE_PRIMARY_METHOD=unknown",
        "LOCAL_EDGE_HEALTH_MONITOR_METHOD=nginx-docker",
        "LOCAL_EDGE_RUNTIME_AUDIT_METHOD=all",
        "OLD_EXAMPLE_ENV=remove-me",
      ].join("\n"),
    ],
  ]);
  const infoLines: string[] = [];
  const warningLines: string[] = [];

  const exitCode = await LocalEdgeKit_runInitLifecycle({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_STARTUP_CLI_INIT_RUN_CHECKS: "0",
      USER: "ada",
    },
    hooks: {
      copyFile: (sourcePath, targetPath) => {
        const content = files.get(sourcePath);
        if (content !== undefined) {
          files.set(targetPath, content);
        }
      },
      exists: (filePath) => files.has(filePath),
      loadEnvFile: () => {},
      promptDeveloperSlug: () => Promise.resolve("unused"),
      readText: (filePath) => files.get(filePath) ?? "",
      writeText: (filePath, content) => {
        files.set(filePath, content);
      },
    },
    isStdinTty: false,
    loggers: {
      error: () => {},
      info: (line) => {
        infoLines.push(line);
      },
      warn: (line) => {
        warningLines.push(line);
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(warningLines, []);
  assert.deepEqual(infoLines.slice(0, 4), [
    "Created env file from template: /tmp/example/.env.local-edge",
    "Target values:",
    "  LOCAL_EDGE_DEVELOPER_SLUG=legacy-user",
    "  LOCAL_EDGE_ENV_SLUG=main",
  ]);
  assert.equal(
    files.get("/tmp/example/.env.local-edge"),
    [
      "LOCAL_EDGE_DEVELOPER_SLUG=legacy-user",
      "LOCAL_EDGE_ENV_SLUG=main",
      "LOCAL_EDGE_METHODS=nginx-docker",
      "LOCAL_EDGE_PRIMARY_METHOD=nginx-docker",
      "LOCAL_EDGE_ROOT_ZONE=local.test",
      "LOCAL_EDGE_IDENTITY_SURFACE_LABEL=T0",
      "LOCAL_EDGE_EXPOSURE_MODE=split-dns",
      "LOCAL_EDGE_NGINX_DOCKER_HOST=127.0.0.1",
      "LOCAL_EDGE_SPLIT_DNS_NGINX_DOCKER_IP=127.0.0.1",
    ].join("\n"),
  );
});

test("LocalEdgeKit_runInitLifecycle prompts and runs render setup checks", async () => {
  const files = new Map<string, string>([
    [
      "/tmp/example/.env.local-edge",
      [
        "LOCAL_EDGE_DEVELOPER_SLUG=legacy-user",
        "LOCAL_EDGE_ENV_SLUG=feature",
        "LOCAL_EDGE_METHODS=nginx-docker",
        "LOCAL_EDGE_PRIMARY_METHOD=nginx-docker",
        "LOCAL_EDGE_ROOT_ZONE=local.test",
      ].join("\n"),
    ],
    ["/tmp/example/config/.env.local-edge.example", ""],
  ]);
  const commandRoles: string[] = [];
  const loadedEnvFiles: string[] = [];
  const promptDefaults: string[] = [];

  const exitCode = await LocalEdgeKit_runInitLifecycle({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_STARTUP_CLI_INIT_PROMPT_DEVELOPER_SLUG: "true",
      LOCAL_EDGE_STARTUP_CLI_INIT_RUN_CHECKS: "1",
    },
    executeHostCommandPlan: (options) => {
      commandRoles.push(LifecyclePlans_testCommandRole(options));
      return 0;
    },
    hooks: {
      exists: (filePath) => files.has(filePath),
      loadEnvFile: ({ env, envFilePath }) => {
        loadedEnvFiles.push(envFilePath);
        env.LOCAL_EDGE_LOADED_BY_TEST = "true";
      },
      promptDeveloperSlug: (options) => {
        promptDefaults.push(options.promptDefault);
        return Promise.resolve("grace");
      },
      readText: (filePath) => files.get(filePath) ?? "",
      writeText: (filePath, content) => {
        files.set(filePath, content);
      },
    },
    isStdinTty: true,
    loggers: {
      error: () => {},
      info: () => {},
      warn: () => {},
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(promptDefaults, ["dev"]);
  assert.deepEqual(loadedEnvFiles, ["/tmp/example/.env.local-edge"]);
  assert.deepEqual(commandRoles, ["render", "setup", "unknown"]);
  assert.match(
    files.get("/tmp/example/.env.local-edge") ?? "",
    /LOCAL_EDGE_DEVELOPER_SLUG=grace/,
  );
});

test("LocalEdgeKit_resolveDoctorRequest resolves flags and script paths", () => {
  const request = LocalEdgeKit_resolveDoctorRequest({
    config: exampleConfig,
    projectRoot: "/tmp/example",
    env: {
      LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
      LOCAL_EDGE_STARTUP_CLI_DOCTOR_STRICT: "true",
      LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_DNS: "1",
      LOCAL_EDGE_STARTUP_CLI_DOCTOR_WATCH_APPLICATION: "1",
      LOCAL_EDGE_STARTUP_CLI_DOCTOR_APPLICATION_INTERVAL_MS: "100",
      LOCAL_EDGE_TLS_CERT_PATH: "/tmp/custom-cert.pem",
    },
  });

  assert.equal(request.method, "nginx-docker");
  assert.equal(request.realm, "main");
  assert.equal(request.strict, true);
  assert.equal(request.strictArg, "--strict");
  assert.equal(request.skipDns, true);
  assert.equal(request.skipEdge, false);
  assert.equal(request.watchApplication, true);
  assert.equal(request.applicationIntervalMs, "100");
  assert.equal(
    request.paths.registryPath,
    "/tmp/example/.tmp/local-edge/registry/realms.json",
  );
  assert.equal(
    request.paths.renderArtifactPath,
    "/tmp/example/artifacts/render.json",
  );
  assert.equal(request.paths.tlsCertPath, "/tmp/custom-cert.pem");
  assert.equal(
    request.paths.startupCliScriptPath,
    "/tmp/example/scripts/local-edge/startup-cli/local-edge-startup-cli.ts",
  );
});

test("LocalEdgeKit_runDoctorLifecycle runs skipped diagnostics without host mutations", () => {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const tsxCalls: string[] = [];
  const env: NodeJS.ProcessEnv = {
    LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
    LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_APPLICATION: "1",
    LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_DNS: "1",
    LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_EDGE: "1",
    LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_RENDER: "1",
    LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_SETUP: "1",
  };

  const exitCode = LocalEdgeKit_runDoctorLifecycle({
    config: exampleConfig,
    env,
    hooks: {
      commandExists: () => false,
      exists: () => false,
      processIsRunning: () => false,
      readText: () => "",
      runCommandCapture: () => ({ status: 0, stdout: "" }),
      runTsx: (options) => {
        tsxCalls.push(options.args.join(" "));
        return 0;
      },
    },
    projectRoot: "/tmp/example",
    stderr: (line) => {
      stderrLines.push(line);
    },
    stdout: (line) => {
      stdoutLines.push(line);
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(stderrLines, []);
  assert.deepEqual(tsxCalls, ["/tmp/example/scripts/local-edge/realm-list.ts"]);
  assert.deepEqual(stdoutLines, [
    "[local-edge:doctor] Skipping render check.\n",
    "[local-edge:doctor] Inspecting registry integrity...\n",
    "[local-edge:doctor] WARNING: Registry file is missing at /tmp/example/.tmp/local-edge/registry/realms.json\n",
    "[local-edge:doctor] Inspecting realm registry view...\n",
    "[local-edge:doctor] Inspecting render artifact freshness...\n",
    "[local-edge:doctor] WARNING: Render artifact is missing at /tmp/example/artifacts/render.json\n",
    "[local-edge:doctor] Inspecting TLS SAN coverage for active realms...\n",
    "[local-edge:doctor] WARNING: TLS SAN verification skipped (missing cert, registry, or openssl).\n",
    "[local-edge:doctor] Skipping setup checks.\n",
    "[local-edge:doctor] Skipping edge status checks.\n",
    "[local-edge:doctor] Skipping DNS audit.\n",
    "[local-edge:doctor] Skipping host/surface health probes.\n",
    "[local-edge:doctor] Summary status=ok checks=0\n",
    "[local-edge:doctor] Completed.\n",
  ]);
});

test("LocalEdgeKit_runDoctorLifecycle returns strict failure from delegated checks", () => {
  const stderrLines: string[] = [];
  const tsxCalls: string[] = [];
  const env: NodeJS.ProcessEnv = {
    LOCAL_EDGE_STARTUP_CLI_RESOLVED_METHOD: "nginx-docker",
    LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_APPLICATION: "1",
    LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_DNS: "1",
    LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_EDGE: "1",
    LOCAL_EDGE_STARTUP_CLI_DOCTOR_SKIP_SETUP: "1",
    LOCAL_EDGE_STARTUP_CLI_DOCTOR_STRICT: "true",
  };

  const exitCode = LocalEdgeKit_runDoctorLifecycle({
    config: exampleConfig,
    env,
    hooks: {
      commandExists: () => false,
      exists: () => false,
      processIsRunning: () => false,
      readText: () => "",
      runCommandCapture: () => ({ status: 0, stdout: "" }),
      runTsx: (options) => {
        tsxCalls.push(options.args.join(" "));
        return options.args.some((arg) => arg.endsWith("render.ts")) ? 1 : 0;
      },
    },
    projectRoot: "/tmp/example",
    stderr: (line) => {
      stderrLines.push(line);
    },
    stdout: () => {},
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(tsxCalls, [
    "/tmp/example/scripts/local-edge/render.ts --method nginx-docker",
    "/tmp/example/scripts/local-edge/realm-list.ts",
  ]);
  assert.deepEqual(stderrLines, [
    "[local-edge:doctor] WARNING config failed (exit=1).\n",
    "[local-edge:doctor] Summary status=failed domains=config\n",
  ]);
});
