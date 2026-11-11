/**
 * @fileoverview Config-driven local-edge UI spawn-request planner.
 *
 * Project adapters supply action ids, npm script names, bash paths, and any custom serializers. The
 * reusable planner handles common local-edge action-browser command families: simple npm runs,
 * method-all npm runs, init flags, pool-next args, reconcile bash args, and logs line-count args.
 *
 * @testing Node test runner unit: cd packages/local-edge-kit && npm run test -- src/ui-spawn-request.unit.test.ts
 *
 * @see packages/local-edge-kit/src/ui-spawn-request.unit.test.ts - Regression coverage that asserts argv mapping for init, logs, method-all, pool-next, reconcile-bash, generic npm, and custom descriptor branches owned by this planner.
 * @see consumer local-edge adapter - consumer action-browser adapter that injects descriptors and calls LocalEdgeKit_buildUiSpawnRequest so Ink and OpenTUI runners receive executable spawn payloads.
 * @see local-edge-ui.config.ts - Repository-root adapter that binds consumer npm script names and bash helper paths into LocalEdgeKit_UiSpawnRequestConfig shapes consumed through @gg-utils/local-edge-kit.
 * @documentation reviewed=2026-05-23 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
/** Creates a fresh default resolve-options object for local-edge action browsers. */
export function LocalEdgeKit_createDefaultUiResolveOptions(options) {
    return {
        init: {
            bootstrap: false,
            developerSlug: "",
            dryRun: false,
            noChecks: false,
        },
        logsLines: options.defaultLogsLines,
        methodAll: false,
        poolNextRealm: "",
        poolNextStackName: "",
        realmRegister: options.createRegisterOptions(),
        reconcile: {
            method: options.defaultReconcileMethod,
            realm: "",
            recreateIfRunning: false,
        },
    };
}
/** Builds the spawn request that Ink/OpenTUI runners can execute. */
export function LocalEdgeKit_buildUiSpawnRequest(options) {
    const action = options.config.getActionById(options.actionId);
    if (!action) {
        throw new Error(`Unknown local-edge UI action: ${options.actionId}`);
    }
    const descriptor = options.config.actionDescriptors[options.actionId];
    if (!descriptor) {
        const customRequest = options.config.buildCustomRequest?.({
            actionId: options.actionId,
            resolveOptions: options.resolveOptions,
        });
        if (customRequest) {
            return customRequest;
        }
        throw new Error(`Unhandled action: ${String(options.actionId)}`);
    }
    switch (descriptor.kind) {
        case "npm":
            return {
                args: descriptor.args ?? [],
                kind: "npm",
                npmScript: descriptor.npmScript,
            };
        case "method-all-npm":
            return {
                args: LocalEdgeKit_buildUiMethodAllArgs({
                    methodAll: options.resolveOptions.methodAll,
                    supportsMethodAll: action.supportsMethodAll,
                }),
                kind: "npm",
                npmScript: descriptor.npmScript,
            };
        case "init-npm":
            return {
                args: LocalEdgeKit_buildUiInitArgs(options.resolveOptions.init),
                kind: "npm",
                npmScript: descriptor.npmScript,
            };
        case "pool-next-npm":
            return {
                args: LocalEdgeKit_buildUiPoolNextArgs(options.resolveOptions),
                kind: "npm",
                npmScript: descriptor.npmScript,
            };
        case "reconcile-bash":
            return {
                args: LocalEdgeKit_buildUiReconcileArgs({
                    defaultMethod: descriptor.defaultMethod,
                    reconcile: options.resolveOptions.reconcile,
                }),
                kind: "bash",
                scriptPathFromRepoRoot: descriptor.scriptPathFromRepoRoot,
            };
        case "logs-npm":
            return {
                args: LocalEdgeKit_buildUiLogsLineArgs(options.resolveOptions.logsLines),
                kind: "npm",
                npmScript: descriptor.npmScript,
            };
        case "custom": {
            const customRequest = options.config.buildCustomRequest?.({
                actionId: options.actionId,
                resolveOptions: options.resolveOptions,
            });
            if (customRequest) {
                return customRequest;
            }
            throw new Error(`Unhandled custom action: ${String(options.actionId)}`);
        }
    }
}
/** Appends `--method all` when the selected action supports grouped execution. */
export function LocalEdgeKit_buildUiMethodAllArgs(options) {
    if (!options.supportsMethodAll || !options.methodAll) {
        return [];
    }
    return ["--method", "all"];
}
/** Normalizes the logs line-count text field into npm argv fragments. */
export function LocalEdgeKit_buildUiLogsLineArgs(linesText) {
    const trimmed = linesText.trim();
    if (/^\d+$/u.test(trimmed)) {
        return ["--lines", trimmed];
    }
    return [];
}
function LocalEdgeKit_buildUiInitArgs(init) {
    const resolvedInit = init ?? {
        bootstrap: false,
        developerSlug: "",
        dryRun: false,
        noChecks: false,
    };
    const args = [];
    if (resolvedInit.dryRun) {
        args.push("--dry-run");
    }
    if (resolvedInit.noChecks) {
        args.push("--no-checks");
    }
    if (resolvedInit.bootstrap) {
        args.push("--bootstrap");
    }
    const developerSlug = resolvedInit.developerSlug.trim();
    if (developerSlug.length > 0) {
        args.push("--developer-slug", developerSlug);
    }
    return args;
}
function LocalEdgeKit_buildUiPoolNextArgs(resolveOptions) {
    const stackName = resolveOptions.poolNextStackName.trim();
    if (stackName.length === 0) {
        throw new Error("realm:pool:next requires a stack name (--stack-name).");
    }
    const args = ["--stack-name", stackName];
    const realm = resolveOptions.poolNextRealm.trim();
    if (realm.length > 0) {
        args.push("--realm", realm);
    }
    return args;
}
function LocalEdgeKit_buildUiReconcileArgs(options) {
    const resolvedReconcile = options.reconcile ?? {
        method: options.defaultMethod,
        realm: "",
        recreateIfRunning: false,
    };
    const args = [
        "--method",
        resolvedReconcile.method.trim() || options.defaultMethod,
    ];
    const realm = resolvedReconcile.realm.trim();
    if (realm.length > 0) {
        args.push("--realm", realm);
    }
    if (resolvedReconcile.recreateIfRunning) {
        args.push("--recreate-if-running");
    }
    return args;
}
