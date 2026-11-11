import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// OpenTUI supplies a terminal input host with string change events.
const OpenTuiInput = "input";
/**
 * @fileoverview Reusable OpenTUI action-browser app for config-driven local-edge CLIs.
 *
 * Flow: injected categories and actions -> optional configured form screen -> preview -> streamed
 * run output -> result summary. Consumers provide project labels, form fields, spawn adapters, and
 * action catalog lookups while this package owns the terminal route machine and rendering shell.
 *
 * @testing Package: `npm run local-edge-kit:type-check`.
 * @see packages/local-edge-kit/src/opentui-action-browser-model.ts - Option and phase helpers.
 * @documentation reviewed=2026-05-21 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { LocalEdgeKit_buildOpenTuiActionOptions, LocalEdgeKit_buildOpenTuiCategoryOptions, LocalEdgeKit_buildOpenTuiContinueOptions, LocalEdgeKit_buildOpenTuiPreviewOptions, LocalEdgeKit_buildOpenTuiResultOptions, LocalEdgeKit_resolveOpenTuiPhaseForActionSpecial, LocalEdgeKit_shouldRunOpenTuiPreviewAction, } from "./opentui-action-browser-model.js";
/** Finds the configured form screen for the active special phase. */
function findOpenTuiActionBrowserFormScreen(options) {
    return (options.formScreens.find((screen) => screen.phase === options.phase) ?? null);
}
/** Renders one configured package-owned form screen. */
function LocalEdgeKitOpenTuiActionBrowserForm({ model, screen, setModel, setPhase, requestQuit, }) {
    return (_jsxs(_Fragment, { children: [_jsx("text", { children: screen.title }), _jsx("scrollbox", { style: { flexGrow: 1 }, children: _jsx("box", { style: { flexDirection: "column", gap: 1 }, children: screen.fields.map((field) => (_jsxs("box", { style: { flexDirection: "column" }, children: [_jsx("text", { children: field.label }), _jsx(OpenTuiInput, { value: field.readValue(model), onChange: (value) => {
                                    setModel((currentModel) => field.writeValue(currentModel, value));
                                } })] }, field.label))) }) }), _jsx("tab-select", { options: LocalEdgeKit_buildOpenTuiContinueOptions({
                    continueDescription: "Continue",
                    continueName: "Preview",
                    continueValue: "next",
                }), showDescription: true, onSelect: (_index, option) => {
                    const value = option?.value;
                    if (value === "back") {
                        setPhase("actions");
                        return;
                    }
                    if (value === "quit") {
                        requestQuit();
                        return;
                    }
                    if (value === "next") {
                        setPhase("preview");
                    }
                } })] }));
}
/** Reusable OpenTUI root flow for config-driven local-edge action browsers. */
export function LocalEdgeKitOpenTuiActionBrowserApp({ actionsForCategory, appName, buildSpawnRequest, categories, defaultModel, formScreens, formatSpawnPreview, getActionById, isActionId, projectRoot, readMethodAll, requestQuit, runSpawnRequest, subtitleLines, toggleMethodAll, }) {
    const cancelRef = useRef(null);
    const [phase, setPhase] = useState("category");
    const [categoryIndex, setCategoryIndex] = useState(0);
    const [actionId, setActionId] = useState(null);
    const [model, setModel] = useState(() => defaultModel());
    const [confirmYes, setConfirmYes] = useState("");
    const [runStdout, setRunStdout] = useState("");
    const [runStderr, setRunStderr] = useState("");
    const [runStatus, setRunStatus] = useState(null);
    const category = categories[categoryIndex];
    const actionMeta = actionId ? getActionById(actionId) : null;
    const formScreen = findOpenTuiActionBrowserFormScreen({
        formScreens,
        phase,
    });
    const spawnRequest = useMemo(() => {
        if (!actionId) {
            return null;
        }
        try {
            return buildSpawnRequest(actionId, model);
        }
        catch {
            return null;
        }
    }, [actionId, buildSpawnRequest, model]);
    const previewText = spawnRequest
        ? formatSpawnPreview(spawnRequest)
        : "(invalid options)";
    useEffect(() => {
        return () => {
            cancelRef.current?.();
        };
    }, []);
    function resetRun() {
        setRunStdout("");
        setRunStderr("");
        setRunStatus(null);
    }
    function goCategory() {
        cancelRef.current?.();
        cancelRef.current = null;
        setPhase("category");
        setActionId(null);
        setConfirmYes("");
        resetRun();
    }
    async function executeRun() {
        if (!spawnRequest) {
            return;
        }
        resetRun();
        setPhase("run");
        const task = runSpawnRequest(projectRoot, spawnRequest, {
            onStdoutChunk: (chunk) => {
                setRunStdout((previous) => previous + chunk);
            },
            onStderrChunk: (chunk) => {
                setRunStderr((previous) => previous + chunk);
            },
        });
        cancelRef.current = task.cancel;
        try {
            const result = await task.promise;
            setRunStatus(result.status);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setRunStderr((previous) => previous + message);
            setRunStatus(1);
        }
        finally {
            cancelRef.current = null;
            setPhase("result");
        }
    }
    const categoryOptions = LocalEdgeKit_buildOpenTuiCategoryOptions({
        categories,
    });
    const actionOptions = category
        ? LocalEdgeKit_buildOpenTuiActionOptions({
            actions: actionsForCategory(category.id),
        })
        : [];
    return (_jsxs("box", { style: { flexDirection: "column", flexGrow: 1, gap: 1, padding: 1 }, children: [_jsxs("text", { children: [appName, " \u2014 root: ", projectRoot] }), subtitleLines.map((line) => (_jsx("text", { children: line }, line))), phase === "category" ? (_jsxs(_Fragment, { children: [_jsx("text", { children: "Category" }), _jsx("tab-select", { options: categoryOptions, showDescription: true, onSelect: (_index, option) => {
                            const value = option?.value;
                            if (value === "quit") {
                                requestQuit();
                                return;
                            }
                            if (value && /^\d+$/.test(value)) {
                                setCategoryIndex(Number.parseInt(value, 10));
                                setPhase("actions");
                                setActionId(null);
                                setModel(defaultModel());
                            }
                        } })] })) : null, phase === "actions" && category ? (_jsxs(_Fragment, { children: [_jsx("text", { children: category.label }), _jsx("tab-select", { options: actionOptions, showDescription: true, onSelect: (_index, option) => {
                            const value = option?.value;
                            if (value === "back") {
                                goCategory();
                                return;
                            }
                            if (value === "quit") {
                                requestQuit();
                                return;
                            }
                            if (value && isActionId(value)) {
                                setActionId(value);
                                setModel(defaultModel());
                                setConfirmYes("");
                                const meta = getActionById(value);
                                setPhase(LocalEdgeKit_resolveOpenTuiPhaseForActionSpecial({
                                    special: meta?.special,
                                }));
                            }
                        } })] })) : null, formScreen ? (_jsx(LocalEdgeKitOpenTuiActionBrowserForm, { model: model, requestQuit: requestQuit, screen: formScreen, setModel: setModel, setPhase: setPhase })) : null, phase === "preview" && actionMeta ? (_jsxs(_Fragment, { children: [_jsxs("text", { children: ["Preview \u2014 ", actionMeta.label] }), _jsx("text", { children: actionMeta.description }), _jsx("text", { children: previewText }), actionMeta.supportsMethodAll ? (_jsx("tab-select", { options: [
                            {
                                name: readMethodAll(model)
                                    ? "method all: ON"
                                    : "method all: OFF",
                                description: "Toggle --method all",
                                value: "toggleMethod",
                            },
                        ], showDescription: true, onSelect: () => {
                            setModel((currentModel) => toggleMethodAll(currentModel));
                        } })) : null, actionMeta.requiresTypedConfirmation ? (_jsxs(_Fragment, { children: [_jsx("text", { color: "red", children: "Type YES to confirm destructive action" }), _jsx(OpenTuiInput, { value: confirmYes, onChange: (value) => setConfirmYes(value) })] })) : null, _jsx("tab-select", { options: LocalEdgeKit_buildOpenTuiPreviewOptions(), showDescription: true, onSelect: (_index, option) => {
                            const value = option?.value;
                            if (value === "quit") {
                                requestQuit();
                                return;
                            }
                            if (value === "back") {
                                setPhase("actions");
                                return;
                            }
                            if (value === "run") {
                                if (!LocalEdgeKit_shouldRunOpenTuiPreviewAction({
                                    confirmationInput: confirmYes,
                                    requiresTypedConfirmation: actionMeta.requiresTypedConfirmation,
                                })) {
                                    return;
                                }
                                void executeRun();
                            }
                        } })] })) : null, phase === "run" ? (_jsxs(_Fragment, { children: [_jsx("text", { children: "Running\u2026" }), _jsx("scrollbox", { style: { flexGrow: 1 }, children: _jsxs("box", { style: { flexDirection: "column" }, children: [_jsx("text", { children: runStdout }), _jsx("text", { children: runStderr })] }) })] })) : null, phase === "result" ? (_jsxs(_Fragment, { children: [_jsxs("text", { children: ["Exit ", String(runStatus)] }), _jsx("scrollbox", { style: { flexGrow: 1 }, children: _jsxs("box", { style: { flexDirection: "column" }, children: [_jsx("text", { children: runStdout }), _jsx("text", { children: runStderr })] }) }), _jsx("tab-select", { options: LocalEdgeKit_buildOpenTuiResultOptions(), showDescription: true, onSelect: () => {
                            goCategory();
                        } })] })) : null] }));
}
