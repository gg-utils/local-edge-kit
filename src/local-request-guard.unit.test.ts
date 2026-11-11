/**
 * @fileoverview Node test coverage for the bind-address default and Host/Origin request checks.
 *
 * Flow: build a guard input -> call the check -> assert the decision and its reason.
 *
 * @testing Node test runner unit: npm test -- src/local-request-guard.unit.test.ts
 *
 * @see src/local-request-guard.ts - Module under test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalEdgeKit_checkLocalRequest,
  LocalEdgeKit_defaultBindHost,
  LocalEdgeKit_resolveBindHost,
} from "./local-request-guard.js";

const loopback = {
  bindHost: "127.0.0.1",
  localPort: 9100,
  originHeader: undefined,
};

void test("LocalEdgeKit_resolveBindHost falls back to loopback only when no host is given", () => {
  assert.equal(LocalEdgeKit_defaultBindHost, "127.0.0.1");
  assert.equal(LocalEdgeKit_resolveBindHost(undefined), "127.0.0.1");
  assert.equal(LocalEdgeKit_resolveBindHost(""), "127.0.0.1");
  assert.equal(LocalEdgeKit_resolveBindHost("  "), "127.0.0.1");
  assert.equal(LocalEdgeKit_resolveBindHost("0.0.0.0"), "0.0.0.0");
  assert.equal(LocalEdgeKit_resolveBindHost("192.0.2.10"), "192.0.2.10");
});

void test("LocalEdgeKit_checkLocalRequest accepts loopback names on the listening port", () => {
  for (const hostHeader of [
    "127.0.0.1:9100",
    "localhost:9100",
    "LOCALHOST:9100",
    "[::1]:9100",
  ]) {
    assert.deepEqual(
      LocalEdgeKit_checkLocalRequest({ ...loopback, hostHeader }),
      { allowed: true },
      hostHeader,
    );
  }
  assert.deepEqual(
    LocalEdgeKit_checkLocalRequest({
      ...loopback,
      hostHeader: "localhost",
      localPort: 80,
    }),
    { allowed: true },
  );
});

void test("LocalEdgeKit_checkLocalRequest rejects foreign, malformed and wrong-port hosts", () => {
  for (const hostHeader of [
    undefined,
    "",
    "attacker.example:9100",
    "127.0.0.1.attacker.example:9100",
    "localhost:9101",
    "localhost",
    "localhost:9100@attacker.example",
    "attacker.example/localhost:9100",
  ]) {
    assert.deepEqual(
      LocalEdgeKit_checkLocalRequest({ ...loopback, hostHeader }),
      { allowed: false, reason: "host" },
      String(hostHeader),
    );
  }
});

void test("LocalEdgeKit_checkLocalRequest accepts only the origin of the request host", () => {
  const request = { ...loopback, hostHeader: "localhost:9100" };
  assert.deepEqual(
    LocalEdgeKit_checkLocalRequest({
      ...request,
      originHeader: "http://localhost:9100",
    }),
    { allowed: true },
  );
  for (const originHeader of [
    "https://attacker.example",
    "http://attacker.example:9100",
    "http://localhost:9101",
    "http://127.0.0.1:9100",
    "null",
    "file://",
    "",
  ]) {
    assert.deepEqual(
      LocalEdgeKit_checkLocalRequest({ ...request, originHeader }),
      { allowed: false, reason: "origin" },
      originHeader,
    );
  }
});

void test("LocalEdgeKit_checkLocalRequest accepts an explicit non-loopback bind host as Host", () => {
  const request = {
    bindHost: "192.0.2.10",
    localPort: 9100,
    originHeader: undefined,
  };
  assert.deepEqual(
    LocalEdgeKit_checkLocalRequest({
      ...request,
      hostHeader: "192.0.2.10:9100",
    }),
    { allowed: true },
  );
  assert.deepEqual(
    LocalEdgeKit_checkLocalRequest({
      ...request,
      hostHeader: "192.0.2.11:9100",
    }),
    { allowed: false, reason: "host" },
  );
  assert.deepEqual(
    LocalEdgeKit_checkLocalRequest({
      bindHost: "::1",
      hostHeader: "[::1]:9100",
      localPort: 9100,
      originHeader: "http://[::1]:9100",
    }),
    { allowed: true },
  );
});

void test("LocalEdgeKit_checkLocalRequest never treats a wildcard bind address as a Host", () => {
  for (const [bindHost, hostHeader] of [
    ["0.0.0.0", "0.0.0.0:9100"],
    ["::", "[::]:9100"],
  ] as const) {
    assert.deepEqual(
      LocalEdgeKit_checkLocalRequest({
        bindHost,
        hostHeader,
        localPort: 9100,
        originHeader: undefined,
      }),
      { allowed: false, reason: "host" },
      bindHost,
    );
  }
  assert.deepEqual(
    LocalEdgeKit_checkLocalRequest({
      bindHost: "0.0.0.0",
      hostHeader: "attacker.example:9100",
      localPort: 9100,
      originHeader: undefined,
    }),
    { allowed: false, reason: "host" },
  );
});

void test("LocalEdgeKit_checkLocalRequest accepts configured proxy hosts exactly as written", () => {
  const request = {
    allowedHosts: ["logs.dev.example.test", "logs.dev.example.test:8443"],
    bindHost: "0.0.0.0",
    localPort: 9100,
  };
  assert.deepEqual(
    LocalEdgeKit_checkLocalRequest({
      ...request,
      hostHeader: "logs.dev.example.test",
      originHeader: "https://logs.dev.example.test",
    }),
    { allowed: true },
  );
  assert.deepEqual(
    LocalEdgeKit_checkLocalRequest({
      ...request,
      hostHeader: "logs.dev.example.test:8443",
      originHeader: "https://logs.dev.example.test:8443",
    }),
    { allowed: true },
  );
  assert.deepEqual(
    LocalEdgeKit_checkLocalRequest({
      ...request,
      hostHeader: "logs.dev.example.test:9999",
      originHeader: undefined,
    }),
    { allowed: false, reason: "host" },
  );
  assert.deepEqual(
    LocalEdgeKit_checkLocalRequest({
      ...request,
      hostHeader: "logs.dev.example.test",
      originHeader: "https://other.dev.example.test",
    }),
    { allowed: false, reason: "origin" },
  );
});
