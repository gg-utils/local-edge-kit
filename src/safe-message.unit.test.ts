/**
 * @fileoverview Verifies that kit messages never repeat environment variable values, and that
 * command-line words and env variable names are repeated only when short and plainly shaped.
 *
 * @testing Node.js node:test via tsx: npm test
 */
import assert from "node:assert/strict";
import test from "node:test";

import { LocalEdgeKit_commandRuntimeValidateRequestedMethod } from "./command-runtime.js";
import { defineLocalEdgeConfig } from "./config.js";
import { LocalEdgeKit_parseHelperServerPort } from "./helper-server-config.js";
import { LocalEdgeKit_resolveRuntimeConfig } from "./runtime-config.js";
import { LocalEdgeKit_messageEnvNames, LocalEdgeKit_messageWord } from "./safe-message.js";

const MARKER = "ECHOMARK7";

function SafeMessageTest_config(singleMethodMode: boolean) {
  return defineLocalEdgeConfig({
    identity: { defaultDeveloperSlug: "dev", defaultRealmSlug: "main", defaultRootZone: "example.test" },
    router: {
      primaryMethod: "nginx-docker",
      singleMethodMode,
      methods: [
        {
          kind: "nginx-docker",
          method: "nginx-docker",
          serviceName: "edge-router",
          defaultListenHost: "127.0.0.1",
          defaultListenPort: 443,
          composeProjectNamePrefix: "local-edge-nginx-docker",
        },
        {
          kind: "nginx-docker",
          method: "nginx-docker-b",
          serviceName: "edge-router-b",
          defaultListenHost: "127.0.0.1",
          defaultListenPort: 8443,
          composeProjectNamePrefix: "local-edge-nginx-docker-b",
        },
      ],
    },
    surfaces: [],
  });
}

function SafeMessageTest_thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected a throw");
}

void test("no echo: a helper port from env or CLI names the label and the rule, never the value", () => {
  for (const rawValue of [MARKER, "70000", `9${MARKER}`]) {
    const message = SafeMessageTest_thrown(() =>
      LocalEdgeKit_parseHelperServerPort({ label: "EXAMPLE_PORT", rawValue: `${rawValue}`, serviceLabel: "helper" }),
    );
    assert.ok(!message.includes(MARKER) && !message.includes("70000"), message);
  }
  assert.equal(
    SafeMessageTest_thrown(() => LocalEdgeKit_parseHelperServerPort({ label: "EXAMPLE_PORT", rawValue: MARKER, serviceLabel: "helper" })),
    "[helper] EXAMPLE_PORT must be a positive integer port.",
  );
  assert.equal(
    SafeMessageTest_thrown(() => LocalEdgeKit_parseHelperServerPort({ label: "EXAMPLE_PORT", rawValue: "70000", serviceLabel: "helper" })),
    "[helper] EXAMPLE_PORT must be between 1 and 65535.",
  );
});

void test("no echo: unsupported methods from env are counted, never repeated", () => {
  const message = SafeMessageTest_thrown(() =>
    LocalEdgeKit_resolveRuntimeConfig({
      config: SafeMessageTest_config(false),
      env: { LOCAL_EDGE_METHODS: `nginx-docker,${MARKER},${MARKER}2` },
      projectRoot: "/tmp/example-project",
    }),
  );
  assert.equal(message, "[local-edge:config] LOCAL_EDGE_METHODS has 2 unsupported method(s). Supported: nginx-docker, nginx-docker-b.");
});

void test("no echo: single-method mode counts the methods, never repeats them", () => {
  const message = SafeMessageTest_thrown(() =>
    LocalEdgeKit_resolveRuntimeConfig({
      config: SafeMessageTest_config(true),
      env: { LOCAL_EDGE_METHODS: "nginx-docker,nginx-docker-b" },
      projectRoot: "/tmp/example-project",
    }),
  );
  assert.equal(message, "[local-edge:config] LOCAL_EDGE_METHODS must contain exactly one method in single-method mode; it has 2.");
});

void test("no echo: legacy env key names are capped at five and shape-checked", () => {
  const env: NodeJS.ProcessEnv = { [`LOCAL_EDGE_MACOS ${MARKER}`]: "x" };
  for (const letter of ["A", "B", "C", "D", "E", "F"]) {
    env[`LOCAL_EDGE_MACOS_${letter}`] = "value";
  }
  const message = SafeMessageTest_thrown(() =>
    LocalEdgeKit_resolveRuntimeConfig({ config: SafeMessageTest_config(false), env, projectRoot: "/tmp/example-project" }),
  );
  assert.ok(!message.includes(MARKER), message);
  assert.ok(!message.includes("value"), message);
  assert.match(message, /Remove: <\d+ characters>, LOCAL_EDGE_MACOS_A, LOCAL_EDGE_MACOS_B, LOCAL_EDGE_MACOS_C, LOCAL_EDGE_MACOS_D \(and 2 more\)\.$/);
});

void test("no echo: a requested --method is repeated only when it is a short plain word", () => {
  const validate = (method: string): string =>
    SafeMessageTest_thrown(() =>
      LocalEdgeKit_commandRuntimeValidateRequestedMethod({
        allowAll: false,
        commandLabel: "local-edge:test",
        method,
        supportedMethods: ["nginx-docker"],
      }),
    );
  assert.equal(validate("bogus"), "[local-edge:test] Unsupported --method 'bogus'.");
  assert.equal(validate(`${MARKER} token`), "[local-edge:test] Unsupported --method '<15 characters>'.");
  assert.equal(validate(`${MARKER}\n`), "[local-edge:test] Unsupported --method '<10 characters>'.");
});

void test("message helpers: words are bounded, env names are shape-checked and capped", () => {
  assert.equal(LocalEdgeKit_messageWord("nginx-docker"), "nginx-docker");
  assert.equal(LocalEdgeKit_messageWord("x".repeat(48)), "x".repeat(48));
  assert.equal(LocalEdgeKit_messageWord("x".repeat(49)), "<49 characters>");
  assert.equal(LocalEdgeKit_messageWord("a b"), "<3 characters>");
  assert.equal(LocalEdgeKit_messageWord(""), "<0 characters>");
  assert.equal(LocalEdgeKit_messageEnvNames(["A_KEY", "B_KEY"]), "A_KEY, B_KEY");
  assert.equal(LocalEdgeKit_messageEnvNames(["bad name"]), "<8 characters>");
  assert.equal(LocalEdgeKit_messageEnvNames([`A${"B".repeat(64)}`]), "<65 characters>");
  assert.equal(LocalEdgeKit_messageEnvNames(["A", "B", "C", "D", "E", "F", "G"]), "A, B, C, D, E (and 2 more)");
});
