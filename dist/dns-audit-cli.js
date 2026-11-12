/**
 * @fileoverview Shared split-DNS audit orchestration for local-edge kit adapters: resolves env and
 * config, validates macOS resolver files and dnsmasq listeners, optionally runs direct dig probes,
 * expands active realm hostnames from the generated registry, writes the audit artifact, and maps
 * failures to process-style exit codes.
 *
 * The runner consumes `LocalEdgeKit_Config` plus injectable I/O so kit CLIs and unit tests reuse the
 * same workflow without duplicating resolver parsing, registry reads, or probe wiring.
 * Flow: load env stack -> resolve runtime -> parse argv -> resolver checks -> listener -> realm host checks -> artifact -> summary/exit.
 *
 * @example
 * ```typescript
 * import { LocalEdgeKit_runDnsAuditCommand } from "@gg-utils/local-edge-kit/dns-audit-cli";
 * const localEdgeConfig = defineLocalEdgeConfig({ callerOwnedSettings });
 *
 * process.exitCode = await LocalEdgeKit_runDnsAuditCommand({
 *   args: process.argv.slice(2),
 *   config: localEdgeConfig,
 * });
 * ```
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/dns-audit-cli.unit.test.ts
 * @testing CLI: npm run test --prefix packages/local-edge-kit
 *
 * @see packages/local-edge-kit/src/cli.ts - Kit CLI dispatcher that routes the dns-audit subcommand into this runner with argv, config, and env wiring.
 * @see packages/local-edge-core/src/dns.ts - Core DNS audit argv parser, pass/fail state, artifact renderer, and macOS resolver helpers consumed by this orchestration layer.
 * @see scripts/local-edge/dns-audit.ts - Root npm script entrypoint that binds consumer local-edge.config.ts and forwards process.argv to the same exported command API.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview contract defining the audited tag order and documentation metadata shape used by this header.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import dns from "node:dns";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { LocalEdgeCore_buildHostnameFromParts, LocalEdgeCore_createDnsAuditState, LocalEdgeCore_formatDnsAuditPassLine, LocalEdgeCore_formatDnsAuditSummaryLine, LocalEdgeCore_formatDnsAuditWarningLine, LocalEdgeCore_parseDnsAuditCliArgs, LocalEdgeCore_parseMacosResolverContent, LocalEdgeCore_recordDnsAuditFailure, LocalEdgeCore_recordDnsAuditPass, LocalEdgeCore_renderDnsAuditArtifact, LocalEdgeCore_resolveMacosResolverPath, } from "@gg-utils/local-edge-core";
import { LocalEdgeKit_loadActiveEnvFileStack } from "./env.js";
import { LocalEdgeKit_messageWord } from "./safe-message.js";
/**
 * Bounds one value of a `detail` line, expected or actual. An empty value stays empty (it means
 * "nothing found"); anything else goes through `LocalEdgeKit_messageWord`, so a long or odd value
 * shows as `<N characters>`. The actual values come from the system resolver file and DNS answers,
 * which this kit does not control.
 */
function LocalEdgeKit_dnsAuditDetailValue(value) {
    return value === "" ? "" : LocalEdgeKit_messageWord(value);
}
import { LocalEdgeKit_getRuntimeMethod, LocalEdgeKit_resolveRuntimeConfig, } from "./runtime-config.js";
function LocalEdgeKit_defaultDnsAuditOutput() {
    return {
        log(message) {
            console.log(message);
        },
        warn(message) {
            console.warn(message);
        },
        error(message) {
            console.error(message);
        },
    };
}
function LocalEdgeKit_isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function LocalEdgeKit_stringFromRecord(options) {
    const value = options.record[options.key];
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    return options.fallback ?? "";
}
function LocalEdgeKit_isTruthy(value) {
    if (value === undefined) {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
}
async function LocalEdgeKit_defaultReadTextFile(filePath) {
    return await fs.readFile(filePath, "utf8");
}
async function LocalEdgeKit_defaultIsDnsListenerAvailable(options) {
    const execFileAsync = promisify(execFile);
    const udpCheck = execFileAsync("lsof", [
        "-nP",
        `-iUDP@${options.listenAddress}:${options.port}`,
    ])
        .then(() => true)
        .catch(() => false);
    const tcpCheck = execFileAsync("lsof", [
        "-nP",
        `-iTCP@${options.listenAddress}:${options.port}`,
        "-sTCP:LISTEN",
    ])
        .then(() => true)
        .catch(() => false);
    const [udpListening, tcpListening] = await Promise.all([udpCheck, tcpCheck]);
    return udpListening || tcpListening;
}
async function LocalEdgeKit_defaultIsDirectProbeUtilityAvailable(utilityName) {
    const execFileAsync = promisify(execFile);
    try {
        await execFileAsync(utilityName, ["-v"]);
        return true;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return !message.includes("ENOENT");
    }
}
async function LocalEdgeKit_resolveHostWithSystemDns(hostname) {
    const execFileAsync = promisify(execFile);
    if (process.platform === "darwin") {
        try {
            const { stdout } = await execFileAsync("dscacheutil", [
                "-q",
                "host",
                "-a",
                "name",
                hostname,
            ]);
            for (const line of stdout.split("\n")) {
                const trimmed = line.trim();
                if (trimmed.startsWith("ip_address:")) {
                    const ip = trimmed.slice("ip_address:".length).trim();
                    if (ip.length > 0) {
                        return ip;
                    }
                }
            }
        }
        catch {
            // Fall through to Node DNS lookup.
        }
    }
    try {
        const records = await dns.promises.lookup(hostname, {
            all: true,
            verbatim: true,
        });
        const firstV4 = records.find((entry) => typeof entry.address === "string" && entry.address.includes("."));
        const selected = firstV4 ?? records[0];
        return typeof selected?.address === "string" ? selected.address : null;
    }
    catch {
        return null;
    }
}
async function LocalEdgeKit_defaultResolveDirectHost(options) {
    const execFileAsync = promisify(execFile);
    try {
        const { stdout } = await execFileAsync(options.utilityName, [
            "+time=1",
            "+tries=1",
            "+short",
            `@${options.listenAddress}`,
            "-p",
            options.port,
            options.hostname,
            "A",
        ]);
        const firstLine = stdout.split("\n")[0]?.trim() ?? "";
        return firstLine.length > 0 ? firstLine : null;
    }
    catch {
        return null;
    }
}
function LocalEdgeKit_defaultDnsAuditOperations() {
    return {
        readTextFile: LocalEdgeKit_defaultReadTextFile,
        isDnsListenerAvailable: LocalEdgeKit_defaultIsDnsListenerAvailable,
        isDirectProbeUtilityAvailable: LocalEdgeKit_defaultIsDirectProbeUtilityAvailable,
        resolveSystemHost: LocalEdgeKit_resolveHostWithSystemDns,
        resolveDirectHost: LocalEdgeKit_defaultResolveDirectHost,
    };
}
function LocalEdgeKit_dnsAuditCommandLabel(config) {
    return `${config.cli?.commandName ?? "local-edge"}:dns-audit`;
}
function LocalEdgeKit_dnsAuditSurfaces(config) {
    return config.surfaces.filter((surface) => surface.dnsAudit?.include === true);
}
function LocalEdgeKit_dnsAuditListenAddress(options) {
    const envName = options.config.dnsAudit?.listenAddressEnvName ??
        "LOCAL_EDGE_SPLIT_DNS_LISTEN_ADDRESS";
    return options.env[envName] ?? "127.0.0.1";
}
function LocalEdgeKit_dnsAuditPort(options) {
    const envName = options.config.dnsAudit?.portEnvName ?? "LOCAL_EDGE_SPLIT_DNS_PORT";
    return options.env[envName] ?? "53535";
}
function LocalEdgeKit_dnsAuditUtilityName(config) {
    return config.dnsAudit?.directProbeUtilityName ?? "dig";
}
function LocalEdgeKit_dnsAuditResolverDir(config) {
    return config.dnsAudit?.resolverDir ?? "/etc/resolver";
}
function LocalEdgeKit_dnsAuditArtifactPath(options) {
    const configuredPath = options.config.dnsAudit?.artifactPath;
    if (configuredPath === undefined || configuredPath.trim().length === 0) {
        return path.join(options.runtimeConfig.projectRoot, "logs", "local-edge", "artifacts", "dns-audit-last-run.txt");
    }
    return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.join(options.runtimeConfig.projectRoot, configuredPath);
}
function LocalEdgeKit_expectedIpForMethod(options) {
    const configuredEnvName = options.config.dnsAudit?.methodIpEnvNames?.[options.method];
    if (configuredEnvName !== undefined) {
        const configuredIp = options.env[configuredEnvName];
        if (configuredIp !== undefined && configuredIp.trim().length > 0) {
            return configuredIp;
        }
    }
    return LocalEdgeKit_getRuntimeMethod({
        commandLabel: LocalEdgeKit_dnsAuditCommandLabel(options.config),
        runtimeConfig: options.runtimeConfig,
        method: options.method,
    }).listenHost;
}
function LocalEdgeKit_readRegistryRealmRecord(options) {
    if (!LocalEdgeKit_isRecord(options.value)) {
        throw new Error(`[local-edge:dns-audit] Registry realm '${LocalEdgeKit_messageWord(options.realmSlug)}' must be an object.`);
    }
    const realmSlug = LocalEdgeKit_stringFromRecord({
        record: options.value,
        key: "realmSlug",
        fallback: options.realmSlug,
    });
    if (realmSlug !== options.realmSlug) {
        throw new Error(`[local-edge:dns-audit] Registry realm key '${LocalEdgeKit_messageWord(options.realmSlug)}' does not match its realmSlug field.`);
    }
    return {
        realmSlug,
        status: LocalEdgeKit_stringFromRecord({
            record: options.value,
            key: "status",
            fallback: "inactive",
        }),
        method: LocalEdgeKit_stringFromRecord({
            record: options.value,
            key: "primaryMethod",
            fallback: LocalEdgeKit_stringFromRecord({
                record: options.value,
                key: "method",
                fallback: options.runtimeConfig.primaryMethod,
            }),
        }),
        developerSlug: LocalEdgeKit_stringFromRecord({
            record: options.value,
            key: "developerSlug",
            fallback: options.runtimeConfig.developerSlug,
        }),
        rootZone: LocalEdgeKit_stringFromRecord({
            record: options.value,
            key: "rootZone",
            fallback: options.runtimeConfig.rootZone,
        }),
    };
}
async function LocalEdgeKit_readDnsAuditRegistryRealms(runtimeConfig) {
    const registryPath = path.join(runtimeConfig.generatedDir, "registry", "realms.json");
    try {
        const rawRegistry = await fs.readFile(registryPath, "utf8");
        const registry = JSON.parse(rawRegistry);
        if (!LocalEdgeKit_isRecord(registry)) {
            throw new Error("[local-edge:dns-audit] Registry file must be an object.");
        }
        const realms = registry["realms"];
        if (!LocalEdgeKit_isRecord(realms)) {
            throw new Error("[local-edge:dns-audit] Registry file is missing a realms object.");
        }
        return Object.entries(realms).map(([realmSlug, value]) => LocalEdgeKit_readRegistryRealmRecord({
            realmSlug,
            runtimeConfig,
            value,
        }));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("ENOENT")) {
            return [];
        }
        throw error;
    }
}
async function LocalEdgeKit_collectActiveRealmTargets(options) {
    const targets = [];
    const surfaces = LocalEdgeKit_dnsAuditSurfaces(options.config);
    const realms = await LocalEdgeKit_readDnsAuditRegistryRealms(options.runtimeConfig);
    for (const realm of realms) {
        if (realm.status !== "active") {
            continue;
        }
        if (options.methodScope !== "all" && realm.method !== options.methodScope) {
            continue;
        }
        if (realm.realmSlug.length === 0 ||
            realm.method.length === 0 ||
            realm.developerSlug.length === 0 ||
            realm.rootZone.length === 0) {
            continue;
        }
        for (const surface of surfaces) {
            targets.push({
                realm: realm.realmSlug,
                method: realm.method,
                surface: surface.id,
                expectedHost: LocalEdgeCore_buildHostnameFromParts({
                    surface: surface.id,
                    realmSlug: realm.realmSlug,
                    method: realm.method,
                    developerSlug: realm.developerSlug,
                    rootZone: realm.rootZone,
                }),
            });
        }
    }
    return targets;
}
function LocalEdgeKit_recordDnsAuditPass(options) {
    LocalEdgeCore_recordDnsAuditPass(options.state);
    options.output.log(LocalEdgeCore_formatDnsAuditPassLine(options.label));
}
function LocalEdgeKit_recordDnsAuditFail(options) {
    LocalEdgeCore_recordDnsAuditFailure({
        state: options.state,
        label: options.label,
        detail: options.detail,
    });
    options.output.error(LocalEdgeCore_formatDnsAuditWarningLine({
        label: options.label,
        detail: options.detail,
    }));
}
async function LocalEdgeKit_checkResolverFile(options) {
    let fileContent = null;
    try {
        fileContent = await options.operations.readTextFile(options.resolverPath);
        LocalEdgeKit_recordDnsAuditPass({
            output: options.output,
            state: options.state,
            label: "resolver.file.exists",
        });
    }
    catch {
        LocalEdgeKit_recordDnsAuditFail({
            output: options.output,
            state: options.state,
            label: "resolver.file.exists",
            detail: `missing resolver file '${options.resolverPath}'`,
        });
    }
    if (fileContent === null) {
        LocalEdgeKit_recordDnsAuditFail({
            output: options.output,
            state: options.state,
            label: "resolver.nameserver",
            detail: `expected='${LocalEdgeKit_dnsAuditDetailValue(options.expectedNameserver)}' actual=''`,
        });
        LocalEdgeKit_recordDnsAuditFail({
            output: options.output,
            state: options.state,
            label: "resolver.port",
            detail: `expected='${LocalEdgeKit_dnsAuditDetailValue(options.expectedPort)}' actual=''`,
        });
        return;
    }
    const parsedResolver = LocalEdgeCore_parseMacosResolverContent(fileContent);
    const resolverNameserver = parsedResolver.nameserver ?? "";
    const resolverPort = parsedResolver.port ?? "";
    if (resolverNameserver === options.expectedNameserver) {
        LocalEdgeKit_recordDnsAuditPass({
            output: options.output,
            state: options.state,
            label: "resolver.nameserver",
        });
    }
    else {
        LocalEdgeKit_recordDnsAuditFail({
            output: options.output,
            state: options.state,
            label: "resolver.nameserver",
            detail: `expected='${LocalEdgeKit_dnsAuditDetailValue(options.expectedNameserver)}' actual='${LocalEdgeKit_dnsAuditDetailValue(resolverNameserver)}'`,
        });
    }
    if (resolverPort === options.expectedPort) {
        LocalEdgeKit_recordDnsAuditPass({
            output: options.output,
            state: options.state,
            label: "resolver.port",
        });
    }
    else {
        LocalEdgeKit_recordDnsAuditFail({
            output: options.output,
            state: options.state,
            label: "resolver.port",
            detail: `expected='${LocalEdgeKit_dnsAuditDetailValue(options.expectedPort)}' actual='${LocalEdgeKit_dnsAuditDetailValue(resolverPort)}'`,
        });
    }
}
async function LocalEdgeKit_checkRealmSurfaces(options) {
    for (const target of options.targets) {
        const expectedIp = options.expectedIpByMethod.get(target.method) ?? options.listenAddress;
        const systemResolvedIp = await options.operations.resolveSystemHost(target.expectedHost);
        const systemLabel = `system.${target.realm}.${target.surface}`;
        if (systemResolvedIp === expectedIp) {
            LocalEdgeKit_recordDnsAuditPass({
                output: options.output,
                state: options.state,
                label: systemLabel,
            });
        }
        else {
            LocalEdgeKit_recordDnsAuditFail({
                output: options.output,
                state: options.state,
                label: systemLabel,
                detail: `host='${target.expectedHost}' expected='${LocalEdgeKit_dnsAuditDetailValue(expectedIp)}' actual='${LocalEdgeKit_dnsAuditDetailValue(systemResolvedIp ?? "")}'`,
            });
        }
        if (options.runDirectDnsProbe && options.directProbeAvailable) {
            const directLabel = `direct.${target.realm}.${target.surface}`;
            const directResolvedIp = await options.operations.resolveDirectHost({
                hostname: target.expectedHost,
                listenAddress: options.listenAddress,
                port: options.dnsmasqPort,
                utilityName: options.utilityName,
            });
            if (directResolvedIp === expectedIp) {
                LocalEdgeKit_recordDnsAuditPass({
                    output: options.output,
                    state: options.state,
                    label: directLabel,
                });
            }
            else {
                LocalEdgeKit_recordDnsAuditFail({
                    output: options.output,
                    state: options.state,
                    label: directLabel,
                    detail: `host='${target.expectedHost}' expected='${LocalEdgeKit_dnsAuditDetailValue(expectedIp)}' actual='${LocalEdgeKit_dnsAuditDetailValue(directResolvedIp ?? "")}'`,
                });
            }
        }
    }
}
async function LocalEdgeKit_writeDnsAuditArtifact(options) {
    const runAtIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const content = LocalEdgeCore_renderDnsAuditArtifact({
        state: options.state,
        runAtIso,
        method: options.method,
        strict: options.strict,
        resolverPath: options.resolverPath,
        expectedNameserver: options.expectedNameserver,
        expectedPort: options.expectedPort,
    });
    const artifactPath = LocalEdgeKit_dnsAuditArtifactPath({
        config: options.config,
        runtimeConfig: options.runtimeConfig,
    });
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, content, "utf8");
    return artifactPath;
}
/** Runs the generic DNS audit command and returns a process-style exit code. */
export async function LocalEdgeKit_runDnsAuditCommand(options) {
    const env = options.env ?? process.env;
    const output = options.output ?? LocalEdgeKit_defaultDnsAuditOutput();
    const operations = options.operations ?? LocalEdgeKit_defaultDnsAuditOperations();
    try {
        LocalEdgeKit_loadActiveEnvFileStack({
            config: options.config,
            env,
            logPrefix: LocalEdgeKit_dnsAuditCommandLabel(options.config),
        });
        const runtimeConfig = LocalEdgeKit_resolveRuntimeConfig({
            config: options.config,
            env,
        });
        const parsed = LocalEdgeCore_parseDnsAuditCliArgs({
            args: options.args,
            defaultMethod: runtimeConfig.primaryMethod,
            defaultStrict: LocalEdgeKit_isTruthy(env.LOCAL_EDGE_STRICT_START),
            supportedMethods: runtimeConfig.supportedMethods,
        });
        if (!parsed.ok) {
            output.error(parsed.message);
            return parsed.exitCode;
        }
        const methodsToCheck = parsed.options.method === "all"
            ? runtimeConfig.configuredMethods
            : [parsed.options.method];
        if (methodsToCheck.length === 0) {
            output.error(`[local-edge:dns-audit] No configured methods found for scope '${parsed.options.method}'.`);
            return 1;
        }
        const listenAddress = LocalEdgeKit_dnsAuditListenAddress({
            config: options.config,
            env,
        });
        const dnsmasqPort = LocalEdgeKit_dnsAuditPort({ config: options.config, env });
        const resolverPath = LocalEdgeCore_resolveMacosResolverPath({
            resolverDir: LocalEdgeKit_dnsAuditResolverDir(options.config),
            rootZone: runtimeConfig.rootZone,
        });
        const expectedIpByMethod = new Map();
        for (const method of methodsToCheck) {
            expectedIpByMethod.set(method, LocalEdgeKit_expectedIpForMethod({
                config: options.config,
                env,
                method,
                runtimeConfig,
            }));
        }
        output.log(`[local-edge:dns-audit] Starting DNS audit (method='${parsed.options.method}', strict=${String(parsed.options.strict)}).`);
        output.log(`[local-edge:dns-audit] resolver=${resolverPath} expectedNameserver=${listenAddress} expectedPort=${dnsmasqPort}`);
        const state = LocalEdgeCore_createDnsAuditState();
        await LocalEdgeKit_checkResolverFile({
            expectedNameserver: listenAddress,
            expectedPort: dnsmasqPort,
            operations,
            output,
            resolverPath,
            state,
        });
        const listenerAvailable = await operations.isDnsListenerAvailable({
            listenAddress,
            port: dnsmasqPort,
        });
        if (listenerAvailable) {
            LocalEdgeKit_recordDnsAuditPass({
                output,
                state,
                label: "dnsmasq.listener",
            });
        }
        else {
            LocalEdgeKit_recordDnsAuditFail({
                output,
                state,
                label: "dnsmasq.listener",
                detail: `no listener on ${listenAddress}:${dnsmasqPort}`,
            });
        }
        const utilityName = LocalEdgeKit_dnsAuditUtilityName(options.config);
        let directProbeAvailable = false;
        if (parsed.options.runDirectDnsProbe) {
            directProbeAvailable =
                await operations.isDirectProbeUtilityAvailable(utilityName);
            if (directProbeAvailable) {
                LocalEdgeKit_recordDnsAuditPass({
                    output,
                    state,
                    label: "dns.direct-probe.utility",
                });
            }
            else {
                LocalEdgeKit_recordDnsAuditFail({
                    output,
                    state,
                    label: "dns.direct-probe.utility",
                    detail: "dig is required for direct dnsmasq probe (install dnsutils/bind tools)",
                });
            }
        }
        if (!listenerAvailable) {
            output.log(`[local-edge:dns-audit] Skipping per-host resolution checks until dnsmasq is listening on ${listenAddress}:${dnsmasqPort}.`);
        }
        else {
            const targets = await LocalEdgeKit_collectActiveRealmTargets({
                config: options.config,
                methodScope: parsed.options.method,
                runtimeConfig,
            });
            if (targets.length === 0) {
                output.log(`[local-edge:dns-audit] No active registered realms found for method scope '${parsed.options.method}'. Skipping realm host resolution checks.`);
            }
            else {
                await LocalEdgeKit_checkRealmSurfaces({
                    dnsmasqPort,
                    expectedIpByMethod,
                    listenAddress,
                    operations,
                    output,
                    runDirectDnsProbe: parsed.options.runDirectDnsProbe,
                    directProbeAvailable,
                    state,
                    targets,
                    utilityName,
                });
            }
        }
        await LocalEdgeKit_writeDnsAuditArtifact({
            config: options.config,
            expectedNameserver: listenAddress,
            expectedPort: dnsmasqPort,
            method: parsed.options.method,
            resolverPath,
            runtimeConfig,
            state,
            strict: parsed.options.strict,
        });
        output.log(LocalEdgeCore_formatDnsAuditSummaryLine(state));
        if (state.checkFailed > 0) {
            output.log("[local-edge:dns-audit] Failure domains:");
            for (const failure of state.failures) {
                output.log(`  - ${failure}`);
            }
            if (parsed.options.strict) {
                return 1;
            }
        }
        return 0;
    }
    catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        return 2;
    }
}
