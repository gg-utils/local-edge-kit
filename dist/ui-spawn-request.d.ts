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
/** Spawn request union produced by local-edge action-browser UIs. */
export type LocalEdgeKit_UiSpawnRequest = {
    readonly args: readonly string[];
    readonly kind: "npm";
    readonly npmScript: string;
} | {
    readonly args: readonly string[];
    readonly kind: "bash";
    readonly scriptPathFromRepoRoot: string;
};
/** Options for the shared init action family. */
export type LocalEdgeKit_UiInitOptions = {
    readonly bootstrap: boolean;
    readonly developerSlug: string;
    readonly dryRun: boolean;
    readonly noChecks: boolean;
};
/** Options for the shared reconcile-router action family. */
export type LocalEdgeKit_UiReconcileOptions = {
    readonly method: string;
    readonly realm: string;
    readonly recreateIfRunning: boolean;
};
/** Shared controlled state used by the reusable spawn planner. */
export type LocalEdgeKit_UiResolveOptions<RegisterOptions> = {
    readonly init?: LocalEdgeKit_UiInitOptions;
    readonly logsLines: string;
    readonly methodAll: boolean;
    readonly poolNextRealm: string;
    readonly poolNextStackName: string;
    readonly realmRegister?: RegisterOptions;
    readonly reconcile?: LocalEdgeKit_UiReconcileOptions;
};
/** Common descriptor families handled by the reusable spawn planner. */
export type LocalEdgeKit_UiSpawnDescriptor = {
    readonly kind: "custom";
} | {
    readonly kind: "init-npm";
    readonly npmScript: string;
} | {
    readonly kind: "logs-npm";
    readonly npmScript: string;
} | {
    readonly kind: "method-all-npm";
    readonly npmScript: string;
} | {
    readonly args?: readonly string[] | undefined;
    readonly kind: "npm";
    readonly npmScript: string;
} | {
    readonly kind: "pool-next-npm";
    readonly npmScript: string;
} | {
    readonly defaultMethod: string;
    readonly kind: "reconcile-bash";
    readonly scriptPathFromRepoRoot: string;
};
/** Minimal action metadata needed to decide `--method all` handling. */
export type LocalEdgeKit_UiSpawnActionInput<ActionId extends string> = {
    readonly id: ActionId;
    readonly supportsMethodAll: boolean;
};
/** Config injected by project adapters into the reusable spawn planner. */
export type LocalEdgeKit_UiSpawnRequestConfig<ActionId extends string, ResolveOptions extends LocalEdgeKit_UiResolveOptions<unknown>> = {
    readonly actionDescriptors: Readonly<Partial<Record<ActionId, LocalEdgeKit_UiSpawnDescriptor>>>;
    readonly buildCustomRequest?: (options: {
        readonly actionId: ActionId;
        readonly resolveOptions: ResolveOptions;
    }) => LocalEdgeKit_UiSpawnRequest | null;
    readonly getActionById: (actionId: ActionId) => LocalEdgeKit_UiSpawnActionInput<ActionId> | null;
};
/** Creates a fresh default resolve-options object for local-edge action browsers. */
export declare function LocalEdgeKit_createDefaultUiResolveOptions<RegisterOptions>(options: {
    readonly createRegisterOptions: () => RegisterOptions;
    readonly defaultLogsLines: string;
    readonly defaultReconcileMethod: string;
}): LocalEdgeKit_UiResolveOptions<RegisterOptions>;
/** Builds the spawn request that Ink/OpenTUI runners can execute. */
export declare function LocalEdgeKit_buildUiSpawnRequest<ActionId extends string, ResolveOptions extends LocalEdgeKit_UiResolveOptions<unknown>>(options: {
    readonly actionId: ActionId;
    readonly config: LocalEdgeKit_UiSpawnRequestConfig<ActionId, ResolveOptions>;
    readonly resolveOptions: ResolveOptions;
}): LocalEdgeKit_UiSpawnRequest;
/** Appends `--method all` when the selected action supports grouped execution. */
export declare function LocalEdgeKit_buildUiMethodAllArgs(options: {
    readonly methodAll: boolean;
    readonly supportsMethodAll: boolean;
}): string[];
/** Normalizes the logs line-count text field into npm argv fragments. */
export declare function LocalEdgeKit_buildUiLogsLineArgs(linesText: string): string[];
