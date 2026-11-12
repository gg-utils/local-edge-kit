/**
 * @fileoverview Resolves consumer config plus env into runtime facts for local-edge kit commands.
 *
 * Resolution happens after the env stack is loaded. The returned structure gives command runners a
 * method allowlist, selected router defaults, URL-matrix identity, and Docker Compose coordinates
 * without reading repository-specific files.
 *
 * @testing Jest unit: npm run test --prefix packages/local-edge-kit -- src/url-matrix.unit.test.ts
 *
 * @see packages/local-edge-kit/src/config.ts - Declares router methods, surfaces, and env key names read while assembling the runtime snapshot.
 * @see packages/local-edge-kit/src/env.ts - Resolves the workspace project root anchoring generated-dir and compose path outputs here.
 * @see packages/local-edge-core/src/method-config.ts - Slug, method allowlist, and nginx-docker primitives composed into the resolved method records returned upstream.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import path from "node:path";
import { LocalEdgeCore_isSupportedMethod, LocalEdgeCore_resolveDeveloperSlug, LocalEdgeCore_resolveEnvSlug, LocalEdgeCore_resolveGeneratedDirBase, LocalEdgeCore_resolveNginxDockerComposePath, LocalEdgeCore_resolveNginxDockerListenHost, LocalEdgeCore_resolveNginxDockerPort, LocalEdgeCore_slugifySegment, } from "@gg-utils/local-edge-core";
import { LocalEdgeKit_resolveProjectRoot } from "./env.js";
import { LocalEdgeKit_messageEnvNames } from "./safe-message.js";
function LocalEdgeKit_generatedDirEnvName(config) {
    return config.env?.generatedDirEnvName ?? "LOCAL_EDGE_GENERATED_DIR";
}
function LocalEdgeKit_methodsEnvName(config) {
    return config.env?.methodsEnvName ?? "LOCAL_EDGE_METHODS";
}
function LocalEdgeKit_primaryMethodEnvName(config) {
    return config.env?.primaryMethodEnvName ?? "LOCAL_EDGE_PRIMARY_METHOD";
}
function LocalEdgeKit_developerSlugEnvName(config) {
    return config.env?.developerSlugEnvName ?? "LOCAL_EDGE_DEVELOPER_SLUG";
}
function LocalEdgeKit_realmSlugEnvName(config) {
    return config.env?.realmSlugEnvName ?? "LOCAL_EDGE_ENV_SLUG";
}
function LocalEdgeKit_rootZoneEnvName(config) {
    return config.env?.rootZoneEnvName ?? "LOCAL_EDGE_ROOT_ZONE";
}
function LocalEdgeKit_findUnsupportedLegacyKeys(env) {
    return Object.keys(env).filter((key) => key.startsWith("LOCAL_EDGE_") && key.includes("MACOS"));
}
function LocalEdgeKit_supportedMethods(config) {
    return config.router.methods.map((methodConfig) => methodConfig.method);
}
function LocalEdgeKit_parseConfiguredMethods(options) {
    const rawMethodsCsv = options.rawMethodsCsv && options.rawMethodsCsv.trim().length > 0
        ? options.rawMethodsCsv
        : options.defaultMethod;
    const uniqueMethods = Array.from(new Set(rawMethodsCsv
        .split(",")
        .map((method) => method.trim())
        .filter((method) => method.length > 0)));
    const invalidMethods = uniqueMethods.filter((method) => !LocalEdgeCore_isSupportedMethod({
        method,
        supportedMethods: options.supportedMethods,
    }));
    if (invalidMethods.length > 0) {
        throw new Error(`[local-edge:config] ${options.methodsEnvName} has ${String(invalidMethods.length)} unsupported method(s). Supported: ${options.supportedMethods.join(", ")}.`);
    }
    if (uniqueMethods.length === 0) {
        throw new Error(`[local-edge:config] ${options.methodsEnvName} must contain at least one method.`);
    }
    if (options.singleMethodMode && uniqueMethods.length !== 1) {
        throw new Error(`[local-edge:config] ${options.methodsEnvName} must contain exactly one method in single-method mode; it has ${String(uniqueMethods.length)}.`);
    }
    return uniqueMethods;
}
function LocalEdgeKit_resolvePrimaryMethod(options) {
    const candidate = (options.rawPrimaryMethod ?? options.configuredMethods[0] ?? options.defaultMethod).trim();
    if (candidate.trim().length === 0) {
        throw new Error(`[local-edge:config] ${options.primaryMethodEnvName} is required and cannot be empty.`);
    }
    if (!LocalEdgeCore_isSupportedMethod({
        method: candidate,
        supportedMethods: options.supportedMethods,
    })) {
        throw new Error(`[local-edge:config] ${options.primaryMethodEnvName}='${candidate}' is unsupported. Allowed value: ${options.supportedMethods.join(", ")}.`);
    }
    if (!options.configuredMethods.includes(candidate)) {
        throw new Error(`[local-edge:config] ${options.primaryMethodEnvName}='${candidate}' is not present in ${options.methodsEnvName}='${options.configuredMethods.join(",")}'.`);
    }
    return candidate;
}
function LocalEdgeKit_findConfiguredMethod(options) {
    const methodConfig = options.config.router.methods.find((candidate) => candidate.method === options.method);
    if (methodConfig === undefined) {
        throw new Error(`[local-edge:config] Configured method '${options.method}' is missing from router.methods.`);
    }
    return methodConfig;
}
function LocalEdgeKit_resolveComposeProjectName(options) {
    const projectNameEnvName = options.config.composeProjectNameEnvName ?? "LOCAL_EDGE_NGINX_DOCKER_PROJECT_NAME";
    const configuredProjectName = options.env[projectNameEnvName] ?? "";
    if (configuredProjectName.trim().length > 0) {
        return LocalEdgeCore_slugifySegment(configuredProjectName);
    }
    const fallbackParts = [
        options.config.composeProjectNamePrefix,
        options.developerSlug,
    ];
    if (options.config.includeRealmSlugInDefaultComposeProjectName === true) {
        fallbackParts.push(options.realmSlug);
    }
    return LocalEdgeCore_slugifySegment(fallbackParts.join("-"));
}
function LocalEdgeKit_resolveNginxDockerRuntimeMethod(options) {
    const listenHostEnvName = options.config.listenHostEnvName ?? "LOCAL_EDGE_NGINX_DOCKER_HOST";
    const listenPortEnvName = options.config.listenPortEnvName ?? "LOCAL_EDGE_NGINX_DOCKER_PORT";
    const composePathEnvName = options.config.composePathEnvName ?? "LOCAL_EDGE_NGINX_DOCKER_CONFIG_PATH";
    return {
        kind: "nginx-docker",
        method: options.config.method,
        listenHost: LocalEdgeCore_resolveNginxDockerListenHost({
            rawHost: options.env[listenHostEnvName],
            defaultHost: options.config.defaultListenHost,
        }),
        listenPort: LocalEdgeCore_resolveNginxDockerPort({
            rawPort: options.env[listenPortEnvName],
            defaultPort: options.config.defaultListenPort,
        }),
        composePath: LocalEdgeCore_resolveNginxDockerComposePath({
            generatedDir: options.generatedDir,
            rawConfigPath: options.env[composePathEnvName],
        }),
        composeProjectName: LocalEdgeKit_resolveComposeProjectName({
            config: options.config,
            developerSlug: options.developerSlug,
            env: options.env,
            realmSlug: options.realmSlug,
        }),
        serviceName: options.config.serviceName,
    };
}
/** Resolves the generic local-edge runtime config from consumer config and environment. */
export function LocalEdgeKit_resolveRuntimeConfig(options) {
    const env = options.env ?? process.env;
    const projectRoot = LocalEdgeKit_resolveProjectRoot({
        config: options.config,
        env,
        projectRoot: options.projectRoot,
    });
    const supportedMethods = LocalEdgeKit_supportedMethods(options.config);
    const defaultMethod = options.config.router.primaryMethod;
    const methodsEnvName = LocalEdgeKit_methodsEnvName(options.config);
    const primaryMethodEnvName = LocalEdgeKit_primaryMethodEnvName(options.config);
    const unsupportedLegacyEnvKeys = LocalEdgeKit_findUnsupportedLegacyKeys(env);
    if (unsupportedLegacyEnvKeys.length > 0) {
        throw new Error(`[local-edge:config] Unsupported legacy host-managed local-edge env keys detected. Remove: ${LocalEdgeKit_messageEnvNames(unsupportedLegacyEnvKeys.sort())}.`);
    }
    const configuredMethods = LocalEdgeKit_parseConfiguredMethods({
        rawMethodsCsv: env[methodsEnvName],
        supportedMethods,
        defaultMethod,
        methodsEnvName,
        singleMethodMode: options.config.router.singleMethodMode ?? true,
    });
    const primaryMethod = LocalEdgeKit_resolvePrimaryMethod({
        rawPrimaryMethod: env[primaryMethodEnvName],
        configuredMethods,
        supportedMethods,
        defaultMethod,
        primaryMethodEnvName,
        methodsEnvName,
    });
    const developerSlug = LocalEdgeCore_resolveDeveloperSlug({
        configuredDeveloperSlug: env[LocalEdgeKit_developerSlugEnvName(options.config)],
        user: env.USER,
        defaultDeveloperSlug: options.config.identity.defaultDeveloperSlug,
    });
    const realmSlug = LocalEdgeCore_resolveEnvSlug({
        configuredEnvSlug: env[LocalEdgeKit_realmSlugEnvName(options.config)],
        defaultEnvSlug: options.config.identity.defaultRealmSlug,
    });
    const generatedDir = LocalEdgeCore_resolveGeneratedDirBase({
        projectRoot,
        configuredGeneratedDir: env[LocalEdgeKit_generatedDirEnvName(options.config)],
    });
    const rootZone = env[LocalEdgeKit_rootZoneEnvName(options.config)] ??
        options.config.identity.defaultRootZone;
    const methods = configuredMethods.map((method) => LocalEdgeKit_resolveNginxDockerRuntimeMethod({
        config: LocalEdgeKit_findConfiguredMethod({ config: options.config, method }),
        developerSlug,
        env,
        generatedDir,
        realmSlug,
    }));
    return {
        configuredMethods,
        developerSlug,
        generatedDir: path.resolve(generatedDir),
        methods,
        primaryMethod,
        projectRoot,
        realmSlug,
        rootZone,
        surfaces: options.config.surfaces,
        supportedMethods,
    };
}
/** Returns a runtime method by name or throws with a command-scoped error. */
export function LocalEdgeKit_getRuntimeMethod(options) {
    const method = options.runtimeConfig.methods.find((candidate) => candidate.method === options.method);
    if (method === undefined) {
        throw new Error(`[${options.commandLabel}] Method '${options.method}' is not configured for this runtime.`);
    }
    return method;
}
