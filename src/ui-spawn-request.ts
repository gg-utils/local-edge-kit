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

import { LocalEdgeKit_messageWord } from "./safe-message.js";

/** Spawn request union produced by local-edge action-browser UIs. */
export type LocalEdgeKit_UiSpawnRequest =
  | {
      readonly args: readonly string[];
      readonly kind: "npm";
      readonly npmScript: string;
    }
  | {
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
export type LocalEdgeKit_UiSpawnDescriptor =
  | { readonly kind: "custom" }
  | { readonly kind: "init-npm"; readonly npmScript: string }
  | { readonly kind: "logs-npm"; readonly npmScript: string }
  | { readonly kind: "method-all-npm"; readonly npmScript: string }
  | {
      readonly args?: readonly string[] | undefined;
      readonly kind: "npm";
      readonly npmScript: string;
    }
  | { readonly kind: "pool-next-npm"; readonly npmScript: string }
  | {
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
export type LocalEdgeKit_UiSpawnRequestConfig<
  ActionId extends string,
  ResolveOptions extends LocalEdgeKit_UiResolveOptions<unknown>,
> = {
  readonly actionDescriptors: Readonly<
    Partial<Record<ActionId, LocalEdgeKit_UiSpawnDescriptor>>
  >;
  readonly buildCustomRequest?: (options: {
    readonly actionId: ActionId;
    readonly resolveOptions: ResolveOptions;
  }) => LocalEdgeKit_UiSpawnRequest | null;
  readonly getActionById: (
    actionId: ActionId,
  ) => LocalEdgeKit_UiSpawnActionInput<ActionId> | null;
};

/** Creates a fresh default resolve-options object for local-edge action browsers. */
export function LocalEdgeKit_createDefaultUiResolveOptions<
  RegisterOptions,
>(options: {
  readonly createRegisterOptions: () => RegisterOptions;
  readonly defaultLogsLines: string;
  readonly defaultReconcileMethod: string;
}): LocalEdgeKit_UiResolveOptions<RegisterOptions> {
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
export function LocalEdgeKit_buildUiSpawnRequest<
  ActionId extends string,
  ResolveOptions extends LocalEdgeKit_UiResolveOptions<unknown>,
>(options: {
  readonly actionId: ActionId;
  readonly config: LocalEdgeKit_UiSpawnRequestConfig<ActionId, ResolveOptions>;
  readonly resolveOptions: ResolveOptions;
}): LocalEdgeKit_UiSpawnRequest {
  const action = options.config.getActionById(options.actionId);
  if (!action) {
    throw new Error(`Unknown local-edge UI action: ${LocalEdgeKit_messageWord(options.actionId)}`);
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
        args: LocalEdgeKit_buildUiLogsLineArgs(
          options.resolveOptions.logsLines,
        ),
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
export function LocalEdgeKit_buildUiMethodAllArgs(options: {
  readonly methodAll: boolean;
  readonly supportsMethodAll: boolean;
}): string[] {
  if (!options.supportsMethodAll || !options.methodAll) {
    return [];
  }
  return ["--method", "all"];
}

/** Normalizes the logs line-count text field into npm argv fragments. */
export function LocalEdgeKit_buildUiLogsLineArgs(linesText: string): string[] {
  const trimmed = linesText.trim();
  if (/^\d+$/u.test(trimmed)) {
    return ["--lines", trimmed];
  }
  return [];
}

function LocalEdgeKit_buildUiInitArgs(
  init: LocalEdgeKit_UiInitOptions | undefined,
): string[] {
  const resolvedInit = init ?? {
    bootstrap: false,
    developerSlug: "",
    dryRun: false,
    noChecks: false,
  };
  const args: string[] = [];
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

function LocalEdgeKit_buildUiPoolNextArgs(
  resolveOptions: LocalEdgeKit_UiResolveOptions<unknown>,
): string[] {
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

function LocalEdgeKit_buildUiReconcileArgs(options: {
  readonly defaultMethod: string;
  readonly reconcile: LocalEdgeKit_UiReconcileOptions | undefined;
}): string[] {
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
