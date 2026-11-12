/**
 * @fileoverview One-command supervisor CLI: `status`, `up`, `down`, `health`, `logs`, `plan`,
 * `expose` and `unexpose` over a project-owned supervisor config and an exposure backend.
 *
 * The project passes its config; this module owns parsing, dispatch and output. The exposure
 * backend comes from `@gg-utils/local-edge-core/exposure` and is picked by `--backend=<name>` or
 * the config default. `expose`/`unexpose` are dry runs unless `--apply` is given.
 * Flow: argv -> command -> supervisor/backend calls -> table or JSON on stdout -> exit code.
 *
 * @testing Node test runner (tsx): npm run test -- src/supervisor-cli.unit.test.ts
 *
 * @see src/supervisor.ts - Process inspection, start, stop and health.
 * @documentation reviewed=2026-11-11 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { spawn } from "node:child_process";
import { LOCAL_EDGE_CORE_DEFAULT_EXPOSURE_BACKEND, LOCAL_EDGE_CORE_HOSTNAMES_BACKEND, LocalEdgeCore_createExposureBackend, LocalEdgeCore_observeHostnamesServeTcp, LocalEdgeCore_resolveExposureBackendName, LocalEdgeCore_renderExposurePlanText, } from "@gg-utils/local-edge-core/exposure";
import { LocalEdgeKit_tailRuntimeLaunchLogToStderr } from "./runtime-launch.js";
import { LOCAL_EDGE_KIT_ROUTER_ID, LocalEdgeKit_inspectRouter, LocalEdgeKit_routerDown, LocalEdgeKit_routerUp, } from "./supervisor-router.js";
import { LocalEdgeKit_createSupervisorHost, LocalEdgeKit_inspectSupervisedApp, LocalEdgeKit_probeSupervisedAppHealth, LocalEdgeKit_resolveAppPath, LocalEdgeKit_supervisorDown, LocalEdgeKit_supervisorUp, LocalEdgeKit_validateSupervisedApps, } from "./supervisor.js";
function LocalEdgeKit_parseSupervisorArgs(args) {
    const positionals = [];
    const flags = new Map();
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index] ?? "";
        if (arg === "-n" || arg === "--lines") {
            flags.set("lines", args[index + 1] ?? "");
            index += 1;
        }
        else if (arg === "-f") {
            flags.set("follow", true);
        }
        else if (arg.startsWith("--")) {
            const [key, value] = arg.slice(2).split("=", 2);
            flags.set(key ?? "", value ?? true);
        }
        else {
            positionals.push(arg);
        }
    }
    return { positionals, flags };
}
/** Builds the backend-neutral exposure manifest from supervisor apps. */
export function LocalEdgeKit_buildExposureManifest(config) {
    return {
        protectedPorts: config.exposure.protectedPorts,
        hostname: config.exposure.hostname,
        rootZone: config.exposure.rootZone,
        hostnames: config.exposure.hostnames,
        apps: config.apps.map((app) => ({
            id: app.id,
            enabled: app.enabled,
            localPort: app.localPort,
            edgePort: app.edgePort,
            edgeName: app.edgeName,
            locations: app.locations,
            hostnameTemplate: app.hostnameTemplate,
        })),
    };
}
/** Renders rows as a padded text table. */
export function LocalEdgeKit_renderTable(header, rows) {
    const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)));
    const render = (row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();
    return `${[render(header), ...rows.map(render)].join("\n")}\n`;
}
function LocalEdgeKit_supervisorUsage(config) {
    const name = config.commandName ?? "local-edge";
    return [
        `Usage: ${name} <command> [args]`,
        "",
        "  status [--json] [--backend=<name>]   process, health and edge state per app",
        "  up [app...|router]                   start apps (and dependencies), adopting running ones;",
        "                                       with the hostnames backend also write the router config",
        "                                       and start or reload nginx",
        "  down [app...|router]                 stop apps (process group, TERM then KILL) and the router",
        "  health [app...] [--json]             probe health paths on 127.0.0.1",
        "  logs <app> [-n N] [-f]               tail an app log",
        "  plan [--backend=ports|hostnames|<name>] [--remove] [--json]   show exposure actions (never changes anything)",
        "  expose [--backend=<name>] [--apply]  map edge URLs; dry run without --apply",
        "  unexpose [--backend=<name>] [--apply] remove edge URLs this config owns; dry run without --apply",
        "",
    ].join("\n");
}
function LocalEdgeKit_selectIds(config, positionals) {
    if (positionals.length > 0) {
        for (const id of positionals) {
            if (!config.apps.some((app) => app.id === id)) {
                throw new Error(`unknown app "${id}"`);
            }
        }
        return [...positionals];
    }
    return config.apps.filter((app) => app.enabled).map((app) => app.id);
}
/**
 * Runs the supervisor CLI and returns a process exit code: 0 ok, 1 a step failed or an app is
 * unhealthy, 2 usage or config error.
 */
export async function LocalEdgeKit_runSupervisorCli(options) {
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    const { config } = options;
    const host = options.host ?? LocalEdgeKit_createSupervisorHost();
    const createBackend = options.createBackend ?? ((name) => LocalEdgeCore_createExposureBackend(name));
    const [command, ...rest] = options.args;
    const parsed = LocalEdgeKit_parseSupervisorArgs(rest);
    const json = parsed.flags.has("json");
    const backendFlag = parsed.flags.get("backend");
    const backendName = typeof backendFlag === "string" ? backendFlag : (config.exposure.backend ?? LOCAL_EDGE_CORE_DEFAULT_EXPOSURE_BACKEND);
    const usesRouter = config.exposure.router !== undefined &&
        LocalEdgeCore_resolveExposureBackendName(backendName) === LOCAL_EDGE_CORE_HOSTNAMES_BACKEND;
    const routerRequested = parsed.positionals.length === 0 || parsed.positionals.includes(LOCAL_EDGE_KIT_ROUTER_ID);
    const appPositionals = parsed.positionals.filter((id) => !usesRouter || id !== LOCAL_EDGE_KIT_ROUTER_ID);
    if (!command || command === "help" || command === "--help" || command === "-h") {
        stdout.write(LocalEdgeKit_supervisorUsage(config));
        return command ? 0 : 2;
    }
    const problems = LocalEdgeKit_validateSupervisedApps(config.apps);
    if (problems.length > 0) {
        stderr.write(`config invalid:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n`);
        return 2;
    }
    try {
        const manifest = LocalEdgeKit_buildExposureManifest(config);
        switch (command) {
            case "status": {
                const backend = createBackend(backendName);
                const edge = new Map(backend.status(manifest).map((entry) => [entry.appId, entry]));
                const rows = await Promise.all(config.apps.map(async (app) => {
                    const inspection = LocalEdgeKit_inspectSupervisedApp(app, host);
                    const health = inspection.state === "running" ? await LocalEdgeKit_probeSupervisedAppHealth(app, host) : null;
                    return { app, inspection, health, edge: edge.get(app.id) ?? null };
                }));
                const router = usesRouter && manifest.hostnames
                    ? {
                        inspection: LocalEdgeKit_inspectRouter({ manifest, host }),
                        serve: LocalEdgeCore_observeHostnamesServeTcp(manifest.hostnames, (cmd, args) => host.runCommand(cmd, args), "tailscale"),
                        listen: `${manifest.hostnames.routerHost}:${String(manifest.hostnames.routerPort)}`,
                        edgePort: manifest.hostnames.edgePort ?? manifest.hostnames.routerPort,
                    }
                    : null;
                if (json) {
                    stdout.write(`${JSON.stringify({
                        backend: backend.name,
                        router,
                        apps: rows.map((row) => ({
                            id: row.app.id,
                            enabled: row.app.enabled,
                            state: row.inspection.state,
                            pid: row.inspection.pid,
                            localPort: row.app.localPort,
                            healthy: row.health?.healthy ?? null,
                            health: row.health?.checks ?? [],
                            note: row.inspection.note,
                            edge: row.edge,
                        })),
                    }, null, 2)}\n`);
                }
                else {
                    stdout.write(`exposure backend: ${backend.name}\n`);
                    stdout.write(LocalEdgeKit_renderTable(["APP", "STATE", "PID", "LOCAL", "HEALTH", "EDGE", "EDGE-STATE", "NOTE"], rows.map((row) => [
                        row.app.id,
                        row.inspection.state,
                        row.inspection.pid === null ? "-" : String(row.inspection.pid),
                        `127.0.0.1:${String(row.app.localPort)}`,
                        row.health === null ? "-" : row.health.healthy ? "ok" : "fail",
                        row.edge?.edgeUrl ?? "-",
                        row.edge?.state ?? "-",
                        row.inspection.note,
                    ]).concat(router === null
                        ? []
                        : [
                            [
                                LOCAL_EDGE_KIT_ROUTER_ID,
                                router.inspection.state,
                                router.inspection.pid === null ? "-" : String(router.inspection.pid),
                                router.listen,
                                "-",
                                `serve :${String(router.edgePort)}`,
                                router.serve.state,
                                `${router.inspection.note}; ${router.serve.note}`,
                            ],
                        ])));
                }
                const routerDown = router !== null && router.inspection.state !== "running";
                return routerDown || rows.some((row) => row.app.enabled && row.health !== null && !row.health.healthy) ? 1 : 0;
            }
            case "health": {
                const ids = LocalEdgeKit_selectIds(config, appPositionals);
                const apps = config.apps.filter((app) => ids.includes(app.id));
                const results = await Promise.all(apps.map((app) => LocalEdgeKit_probeSupervisedAppHealth(app, host)));
                if (json) {
                    stdout.write(`${JSON.stringify(results, null, 2)}\n`);
                }
                else {
                    stdout.write(LocalEdgeKit_renderTable(["APP", "HEALTH", "CHECKS"], results.map((result) => [
                        result.appId,
                        result.healthy ? "ok" : "fail",
                        result.checks.map((check) => `${check.path}=${String(check.status ?? "no answer")}`).join(" "),
                    ])));
                }
                return results.every((result) => result.healthy) ? 0 : 1;
            }
            case "up":
            case "down": {
                const onlyRouter = parsed.positionals.length > 0 && appPositionals.length === 0;
                const ids = onlyRouter ? [] : LocalEdgeKit_selectIds(config, appPositionals);
                const router = config.exposure.router;
                const routerStep = usesRouter && routerRequested && router !== undefined;
                const results = command === "up"
                    ? await LocalEdgeKit_supervisorUp({ apps: config.apps, requestedIds: ids, host, out: stderr })
                    : [];
                if (routerStep) {
                    results.push(command === "up"
                        ? LocalEdgeKit_routerUp({ manifest, router, host, out: stderr })
                        : LocalEdgeKit_routerDown({ manifest, router, host }));
                }
                if (command === "down") {
                    results.push(...LocalEdgeKit_supervisorDown({ apps: config.apps, requestedIds: ids, host, out: stderr }));
                }
                stdout.write(LocalEdgeKit_renderTable(["APP", "RESULT", "MESSAGE"], results.map((result) => [result.appId, result.action, result.message])));
                return results.every((result) => result.ok) ? 0 : 1;
            }
            case "logs": {
                const [id] = parsed.positionals;
                const app = config.apps.find((candidate) => candidate.id === id);
                if (!app) {
                    stderr.write(`logs needs a known app id\n`);
                    return 2;
                }
                if (!app.logFile) {
                    stderr.write(`${app.id} has no log file (external apps are route only)\n`);
                    return 2;
                }
                const linesFlag = parsed.flags.get("lines");
                const lines = typeof linesFlag === "string" && /^\d+$/.test(linesFlag) ? Number(linesFlag) : 100;
                const logFile = LocalEdgeKit_resolveAppPath(app, app.logFile);
                if (parsed.flags.has("follow")) {
                    const follow = options.followLog ??
                        ((file, count) => new Promise((resolve) => {
                            const child = spawn("tail", ["-n", String(count), "-F", file], { stdio: "inherit" });
                            child.on("exit", (code) => resolve(code ?? 0));
                        }));
                    return await follow(logFile, lines);
                }
                LocalEdgeKit_tailRuntimeLaunchLogToStderr({ lines, logPath: logFile });
                return 0;
            }
            case "plan":
            case "expose":
            case "unexpose": {
                const backend = createBackend(backendName);
                const remove = command === "unexpose" || (command === "plan" && parsed.flags.has("remove"));
                const plan = remove ? backend.planRemove(manifest) : backend.plan(manifest);
                if (command === "plan") {
                    stdout.write(json ? `${JSON.stringify(plan, null, 2)}\n` : LocalEdgeCore_renderExposurePlanText(plan));
                    return 0;
                }
                const result = backend.apply(plan, { apply: parsed.flags.has("apply") });
                if (json) {
                    stdout.write(`${JSON.stringify({ plan, result }, null, 2)}\n`);
                }
                else {
                    stdout.write(LocalEdgeCore_renderExposurePlanText(plan));
                    for (const ran of result.ran) {
                        stdout.write(`ran (${String(ran.status)}): ${ran.argv.join(" ")}\n`);
                    }
                    stdout.write(`${result.ok ? "ok" : "refused"}: ${result.message}\n`);
                }
                return result.ok ? 0 : 1;
            }
            default:
                stderr.write(`unknown command "${command}"\n${LocalEdgeKit_supervisorUsage(config)}`);
                return 2;
        }
    }
    catch (error) {
        stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
    }
}
