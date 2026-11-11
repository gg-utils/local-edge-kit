import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * @fileoverview Reusable Ink action-browser app for config-driven local-edge CLIs.
 *
 * Flow: injected categories/actions -> optional configured form screen -> preview -> streamed run
 * output -> result summary. Consumers provide project labels, form fields, spawn adapters, and action
 * catalog lookups while this package owns the Ink route machine and rendering shell.
 *
 * @testing Package: `npm run local-edge-kit:type-check`.
 * @see packages/local-edge-kit/src/ink-action-browser-model.ts - Row, tone, and status helpers.
 * @documentation reviewed=2026-05-21 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { useCallback, useEffect, useMemo, useState, } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { LocalEdgeKit_buildInkActionRows, LocalEdgeKit_buildInkCategoryRows, LocalEdgeKit_formatInkActionBrowserHeaderSummary, LocalEdgeKit_formatInkRunDoneStatusHeadline, LocalEdgeKit_getInkRiskTone, LocalEdgeKit_getInkSelectedItem, LocalEdgeKit_rotateInkSelectionIndex, } from "./ink-action-browser-model.js";
/** Finds the configured form screen for the active special phase. */
function findInkActionBrowserFormScreen(options) {
    return (options.formScreens.find((screen) => screen.phase === options.phase) ?? null);
}
/** Resolves the Ink flow that should follow action selection. */
function resolveInkActionBrowserFlowForSpecial(options) {
    if (options.special === "init") {
        return "init";
    }
    if (options.special === "realm-register") {
        return "realm";
    }
    if (options.special === "reconcile") {
        return "reconcile";
    }
    if (options.special === "realm-pool-next") {
        return "pool";
    }
    if (options.special === "logs") {
        return "logs";
    }
    return "review";
}
/** Renders a simple command preview block without importing project shared UI helpers. */
function InkActionBrowserCommandPreview({ commandLine, }) {
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: "Command" }), _jsx(Text, { wrap: "wrap", children: commandLine })] }));
}
/** Renders recent captured output lines with stderr highlighted. */
function InkActionBrowserCapturedOutput({ lines, maxLines, title, }) {
    const recentLines = lines.length <= maxLines ? lines : lines.slice(lines.length - maxLines);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: title }), recentLines.map((line, index) => (_jsx(Text, { color: line.source === "stderr" ? "red" : "white", children: line.text }, `${line.source}-${String(index)}`)))] }));
}
/** Renders keyboard hints. */
function InkActionBrowserLegend({ lines, }) {
    return (_jsx(Box, { marginTop: 1, flexDirection: "column", gap: 0, children: lines.map((line, index) => (_jsx(Text, { color: "gray", children: line }, String(index)))) }));
}
/** Renders the reusable configured form body. */
function InkActionBrowserConfiguredForm({ activeFieldBuffer, activeFieldIndex, model, screen, }) {
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: screen.title }), screen.quickToggles?.map((toggle) => (_jsxs(Text, { children: [toggle.keyLabel, ": ", toggle.label, " (", toggle.readLabel(model), ")"] }, toggle.keyLabel))) ?? null, screen.fields.map((field, index) => (_jsxs(Text, { ...(index === activeFieldIndex ? { color: "cyan" } : {}), children: [index === activeFieldIndex ? "> " : "  ", field.label, ":", " ", index === activeFieldIndex
                        ? activeFieldBuffer
                        : field.readValue(model)] }, field.id))), _jsx(InkActionBrowserLegend, { lines: ["Type to edit · Enter/Tab next · Esc back"] })] }));
}
/** Commits the active configured form field and advances or returns to review. */
function advanceInkActionBrowserFormField(options) {
    const field = options.screen.fields[options.activeFieldIndex];
    if (field === undefined) {
        options.setFlow("review");
        return;
    }
    let nextModelValue = null;
    options.setModel((currentModel) => {
        const nextModel = field.writeValue(currentModel, options.activeFieldBuffer);
        nextModelValue = nextModel;
        return nextModel;
    });
    if (options.activeFieldIndex >= options.screen.fields.length - 1) {
        options.setFlow("review");
        return;
    }
    const nextIndex = options.activeFieldIndex + 1;
    options.setActiveFieldIndex(nextIndex);
    const nextField = options.screen.fields[nextIndex];
    if (nextField !== undefined && nextModelValue !== null) {
        options.setActiveFieldBuffer(nextField.readValue(nextModelValue));
        return;
    }
    options.setActiveFieldBuffer("");
}
/** Handles keyboard input for configured form screens. */
function handleInkActionBrowserFormInput(options) {
    if (options.key.escape) {
        options.setFlow("actions");
        return;
    }
    const quickToggle = options.screen.quickToggles?.find((toggle) => toggle.keyLabel.toLowerCase() === options.input.toLowerCase());
    if (quickToggle !== undefined) {
        options.setModel((currentModel) => quickToggle.toggle(currentModel));
        return;
    }
    if (options.key.return || options.input === "\t") {
        advanceInkActionBrowserFormField(options);
        return;
    }
    if (options.key.backspace || options.key.delete) {
        options.setActiveFieldBuffer((buffer) => buffer.slice(0, -1));
        return;
    }
    const field = options.screen.fields[options.activeFieldIndex];
    if (field !== undefined &&
        options.input.length === 1 &&
        (field.acceptInput === undefined || field.acceptInput(options.input))) {
        options.setActiveFieldBuffer((buffer) => buffer + options.input);
    }
}
/** Reusable Ink root flow for config-driven local-edge action browsers. */
export function LocalEdgeKitInkActionBrowserApp({ actionsForCategory, appName, buildSpawnRequest, categories, defaultModel, description, formScreens, formatSpawnPreview, projectRoot, readMethodAll, runSpawnRequest, toggleMethodAll, }) {
    const { exit } = useApp();
    const [flow, setFlow] = useState("home");
    const [categoryIndex, setCategoryIndex] = useState(0);
    const [actionIndex, setActionIndex] = useState(0);
    const [model, setModel] = useState(() => defaultModel());
    const [confirmBuffer, setConfirmBuffer] = useState("");
    const [activeFieldIndex, setActiveFieldIndex] = useState(0);
    const [activeFieldBuffer, setActiveFieldBuffer] = useState("");
    const [lines, setLines] = useState([]);
    const [runDone, setRunDone] = useState(null);
    const [cancelRun, setCancelRun] = useState(null);
    const category = LocalEdgeKit_getInkSelectedItem({
        items: categories,
        selectedIndex: categoryIndex,
    }) ?? undefined;
    const actions = useMemo(() => {
        if (!category) {
            return [];
        }
        return actionsForCategory(category.id);
    }, [actionsForCategory, category]);
    const selectedAction = LocalEdgeKit_getInkSelectedItem({
        items: actions,
        selectedIndex: actionIndex,
    });
    const activeFormScreen = findInkActionBrowserFormScreen({
        formScreens,
        phase: flow,
    });
    const previewRequest = useMemo(() => {
        if (!selectedAction) {
            return null;
        }
        try {
            return buildSpawnRequest(selectedAction.id, model);
        }
        catch {
            return null;
        }
    }, [buildSpawnRequest, model, selectedAction]);
    const previewLine = previewRequest
        ? formatSpawnPreview(previewRequest)
        : "(fix form options — cannot build command)";
    const goHome = useCallback(() => {
        cancelRun?.();
        setCancelRun(null);
        setFlow("home");
        setRunDone(null);
        setLines([]);
        setConfirmBuffer("");
    }, [cancelRun]);
    const startRun = useCallback((request) => {
        setLines([]);
        setRunDone(null);
        setFlow("run");
        const task = runSpawnRequest(projectRoot, request, {
            onLine: (line) => {
                setLines((previous) => [...previous, line]);
            },
            onDone: (result) => {
                setRunDone(result);
                setFlow("result");
                setCancelRun(null);
            },
        });
        setCancelRun(() => task.cancel);
    }, [projectRoot, runSpawnRequest]);
    useEffect(() => {
        return () => {
            cancelRun?.();
        };
    }, [cancelRun]);
    useInput((input, key) => {
        if (key.ctrl && input === "c") {
            return;
        }
        if (flow === "run" && key.escape) {
            cancelRun?.();
            setFlow("review");
            setCancelRun(null);
            return;
        }
        if (flow === "result") {
            if (input === "q" || key.return) {
                goHome();
            }
            return;
        }
        if (flow === "home") {
            if (key.upArrow) {
                setCategoryIndex((index) => LocalEdgeKit_rotateInkSelectionIndex({
                    currentIndex: index,
                    direction: "up",
                    itemCount: categories.length,
                }));
                return;
            }
            if (key.downArrow) {
                setCategoryIndex((index) => LocalEdgeKit_rotateInkSelectionIndex({
                    currentIndex: index,
                    direction: "down",
                    itemCount: categories.length,
                }));
                return;
            }
            if (key.return) {
                setActionIndex(0);
                setFlow("actions");
                return;
            }
            if (input === "q") {
                exit();
            }
            return;
        }
        if (flow === "actions") {
            if (key.escape || input === "b") {
                setFlow("home");
                return;
            }
            if (key.upArrow) {
                setActionIndex((index) => LocalEdgeKit_rotateInkSelectionIndex({
                    currentIndex: index,
                    direction: "up",
                    itemCount: actions.length,
                }));
                return;
            }
            if (key.downArrow) {
                setActionIndex((index) => LocalEdgeKit_rotateInkSelectionIndex({
                    currentIndex: index,
                    direction: "down",
                    itemCount: actions.length,
                }));
                return;
            }
            if (key.return && selectedAction) {
                const nextModel = defaultModel();
                const nextFlow = resolveInkActionBrowserFlowForSpecial({
                    special: selectedAction.special,
                });
                const nextFormScreen = findInkActionBrowserFormScreen({
                    formScreens,
                    phase: nextFlow,
                });
                setModel(nextModel);
                setConfirmBuffer("");
                setActiveFieldIndex(0);
                setActiveFieldBuffer(nextFormScreen?.fields[0]?.readValue(nextModel) ?? "");
                setFlow(nextFlow);
                return;
            }
            if (input === "q") {
                exit();
            }
            return;
        }
        if (activeFormScreen) {
            handleInkActionBrowserFormInput({
                activeFieldBuffer,
                activeFieldIndex,
                input,
                key,
                screen: activeFormScreen,
                setActiveFieldBuffer,
                setActiveFieldIndex,
                setFlow,
                setModel,
            });
            return;
        }
        if (flow === "review") {
            if (key.escape || input === "b") {
                setFlow("actions");
                return;
            }
            if (selectedAction?.supportsMethodAll && input === "m") {
                setModel((currentModel) => toggleMethodAll(currentModel));
                return;
            }
            if (key.return) {
                const request = previewRequest;
                if (!request) {
                    return;
                }
                if (selectedAction?.requiresTypedConfirmation &&
                    confirmBuffer.trim().toUpperCase() !== "YES") {
                    return;
                }
                startRun(request);
                return;
            }
            if (selectedAction?.requiresTypedConfirmation) {
                if (key.backspace || key.delete) {
                    setConfirmBuffer((buffer) => buffer.slice(0, -1));
                }
                else if (input.length === 1) {
                    setConfirmBuffer((buffer) => buffer + input.toUpperCase());
                }
            }
            if (input === "q") {
                exit();
            }
        }
    });
    const categoryRows = LocalEdgeKit_buildInkCategoryRows({
        categories,
        selectedIndex: categoryIndex,
    });
    const actionRows = LocalEdgeKit_buildInkActionRows({
        actions,
        selectedIndex: actionIndex,
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsx(Text, { bold: true, color: "green", children: appName }), _jsx(Text, { color: "gray", children: description }), _jsx(Box, { children: _jsx(Text, { children: LocalEdgeKit_formatInkActionBrowserHeaderSummary({ projectRoot }) }) })] }), flow === "home" ? (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: "Categories" }), categoryRows.map((row) => (_jsxs(Text, { ...(row.selected ? { color: "cyan" } : {}), children: [row.marker, row.label] }, row.id))), _jsx(InkActionBrowserLegend, { lines: ["↑/↓: Browse  Enter: Open  Q: Quit"] })] })) : null, flow === "actions" && category ? (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: category.label }), actionRows.map((row) => (_jsxs(Text, { ...(row.selected ? { color: "cyan" } : {}), children: [row.marker, row.label, " ", _jsx(Text, { color: "gray", children: row.riskLabel })] }, row.id))), _jsx(InkActionBrowserLegend, { lines: ["↑/↓: Browse  Enter: Choose  Esc: Back  Q: Quit"] })] })) : null, activeFormScreen ? (_jsx(InkActionBrowserConfiguredForm, { activeFieldBuffer: activeFieldBuffer, activeFieldIndex: activeFieldIndex, model: model, screen: activeFormScreen })) : null, flow === "review" && selectedAction ? (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { bold: true, color: LocalEdgeKit_getInkRiskTone(selectedAction.risk), children: ["Review: ", selectedAction.label] }), _jsx(Text, { color: "gray", children: selectedAction.description }), selectedAction.supportsMethodAll ? (_jsxs(Text, { children: ["All methods [m]: ", String(readMethodAll(model))] })) : null, selectedAction.requiresTypedConfirmation ? (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { color: "red", children: "Type YES to confirm" }), _jsxs(Text, { children: ["Confirmation: ", confirmBuffer] })] })) : null, _jsx(Box, { marginTop: 1, children: _jsx(InkActionBrowserCommandPreview, { commandLine: previewLine }) }), _jsx(InkActionBrowserLegend, { lines: ["Enter: Run  Esc: Back  M: Toggle All  Q: Quit"] })] })) : null, flow === "run" ? (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: "Running... (Esc to cancel)" }), _jsx(InkActionBrowserCapturedOutput, { title: "Output", lines: lines, maxLines: 16 })] })) : null, flow === "result" && runDone ? (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { bold: true, children: [LocalEdgeKit_formatInkRunDoneStatusHeadline(runDone.status), " (exit", " ", String(runDone.exitCode), ")"] }), _jsx(InkActionBrowserCapturedOutput, { title: "Output", lines: lines, maxLines: 20 }), _jsx(Text, { children: "Enter or Q: Menu" })] })) : null] }));
}
