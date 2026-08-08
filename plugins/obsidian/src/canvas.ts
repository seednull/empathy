import type { EventRef, Menu, Plugin } from "obsidian";

import {
    Canvas,
    CanvasEdge,
    CanvasEdgeData,
    CanvasNode,
    CanvasNodeData,
    EmpathyCanvasNodeKind,
    getEmpathyCanvasNodeKind,
    NarrativeAssignment,
    NarrativeComparison,
    NarrativeCondition,
    NarrativeVariable,
    NarrativeVariableAccess,
    NarrativeVariableType,
    parseVariableName,
    validateCanvas,
} from "./compile";

interface CanvasPoint { x: number; y: number }
interface CanvasSize { width: number; height: number }

interface CanvasUi {
    setIcon(parent: HTMLElement, icon: string): void;
    setTooltip(element: HTMLElement, tooltip: string): void;
    showNotice(message: string): void;
    getVariables(): readonly NarrativeVariable[];
    openPanel(selectCreated?: (variable: NarrativeVariable) => void): void;
}

interface RuntimeCanvasNode extends CanvasNode {
    canvas: RuntimeCanvas;
    nodeEl: HTMLElement;
    isEditing?: boolean;
    setData(data: CanvasNodeData): void;
    setIsEditing(editing: boolean, ...args: unknown[]): void;
    attach(): void;
    render(): void;
    startEditing(): void;
}

interface RuntimeCanvasEdge extends CanvasEdge {
    canvas: RuntimeCanvas;
    edgeEl?: HTMLElement | SVGElement;
    lineGroupEl?: HTMLElement | SVGElement;
    getCenter(): CanvasPoint;
    setData(data: CanvasEdgeData): void;
    render(): void;
}

interface RuntimeCanvasMenu {
    menuEl: HTMLElement;
    render(...args: unknown[]): void;
}

interface RuntimeCanvas extends Canvas {
    readonly: boolean;
    cardMenuEl?: HTMLElement;
    menu: RuntimeCanvasMenu;
    selection: Set<RuntimeCanvasNode | RuntimeCanvasEdge>;
    createTextNode(options: {
        pos: CanvasPoint;
        size?: CanvasSize;
        position?: "center";
        text?: string;
        save?: boolean;
        focus?: boolean;
    }): RuntimeCanvasNode;
    posCenter(): CanvasPoint;
    selectOnly(item: RuntimeCanvasNode | RuntimeCanvasEdge): void;
    markDirty(item: RuntimeCanvasNode | RuntimeCanvasEdge): void;
    requestSave(pushHistory?: boolean): void;
    importData(data: { nodes: CanvasNodeData[]; edges: CanvasEdgeData[] }, clearMissing: boolean): void;
    setReadonly(readonly: boolean): void;
    showCreationMenu(menu: Menu, pos: CanvasPoint, size?: CanvasSize): void;
}

interface NodePatch {
    restore: Array<() => void>;
    headerEl?: HTMLElement;
    signature?: string;
    autoHeight?: number;
    characterSaveTimer?: ReturnType<typeof setTimeout>;
}

interface EdgeBadge {
    host: SVGForeignObjectElement;
    label: HTMLDivElement;
}

interface CanvasPatch {
    canvas: RuntimeCanvas;
    nodes: Map<RuntimeCanvasNode, NodePatch>;
    edgeBadges: Map<RuntimeCanvasEdge, EdgeBadge>;
    toolbarEl?: HTMLElement;
    edgeToolbarButtons?: HTMLElement[];
    edgeToolbarSignature?: string;
    edgeEditorEl?: HTMLElement;
    validationTimer?: ReturnType<typeof setTimeout>;
    resizeSaveTimer?: ReturnType<typeof setTimeout>;
    restore: Array<() => void>;
}

const requiredCanvasMethods = [
    "createTextNode", "posCenter", "selectOnly", "markDirty", "requestSave", "importData", "setReadonly", "showCreationMenu",
] as const;

const nodeLabels: Record<EmpathyCanvasNodeKind, string> = {
    entry: "ENTRY", say: "SAY", line: "LINE", choice: "CHOICE", set: "SET",
    "portal-receiver": "RECEIVER", "portal-transmitter": "TRANSMITTER", end: "END",
};
const nodeIcons: Record<EmpathyCanvasNodeKind, string> = {
    entry: "log-in", say: "message-square-quote", line: "text", choice: "list-tree", set: "variable",
    "portal-receiver": "log-in", "portal-transmitter": "log-out", end: "square",
};
const nodeSizes: Record<EmpathyCanvasNodeKind, CanvasSize> = {
    entry: { width: 390, height: 180 },
    say: { width: 360, height: 200 },
    line: { width: 360, height: 160 },
    choice: { width: 360, height: 180 },
    set: { width: 430, height: 220 },
    "portal-receiver": { width: 300, height: 100 },
    "portal-transmitter": { width: 300, height: 100 },
    end: { width: 220, height: 100 },
};
const nodeSymbols: Record<EmpathyCanvasNodeKind, string> = {
    entry: "↦", say: "“", line: "¶", choice: "◇", set: "=",
    "portal-receiver": "↓", "portal-transmitter": "↑", end: "■",
};
const nodeHints: Partial<Record<EmpathyCanvasNodeKind, string>> = {
    entry: "START", line: "NARRATION", choice: "ORDERED OPTIONS", set: "STATE CHANGE",
    "portal-receiver": "PORTAL IN", "portal-transmitter": "PORTAL OUT", end: "STOP",
};
const nodeKinds = Object.values(EmpathyCanvasNodeKind);
const creationNodeKinds: readonly EmpathyCanvasNodeKind[] = [
    EmpathyCanvasNodeKind.ENTRY,
    EmpathyCanvasNodeKind.SAY,
    EmpathyCanvasNodeKind.LINE,
    EmpathyCanvasNodeKind.CHOICE,
    EmpathyCanvasNodeKind.SET,
    EmpathyCanvasNodeKind.PORTAL_RECEIVER,
    EmpathyCanvasNodeKind.PORTAL_TRANSMITTER,
    EmpathyCanvasNodeKind.END,
];
const convertibleNodeKinds: readonly EmpathyCanvasNodeKind[] = [
    EmpathyCanvasNodeKind.ENTRY,
    EmpathyCanvasNodeKind.SAY,
    EmpathyCanvasNodeKind.LINE,
    EmpathyCanvasNodeKind.CHOICE,
    EmpathyCanvasNodeKind.SET,
    EmpathyCanvasNodeKind.END,
];
const nodeSemanticKeys = [
    "empathyCharacter", "empathyAssignments", "empathyEntryCondition", "empathyEntryMatchValue", "empathyChoices",
    "empathyPortalId", "empathyPortalName",
] as const;
const edgeSemanticKeys = ["empathyCondition", "empathyElse", "empathyConditionOrder", "empathyChoiceIndex"] as const;

function initialText(kind: EmpathyCanvasNodeKind): string {
    if (kind === EmpathyCanvasNodeKind.SAY) return "Dialogue";
    if (kind === EmpathyCanvasNodeKind.LINE) return "Line";
    if (kind === EmpathyCanvasNodeKind.ENTRY) return "Entry";
    return "";
}

function defaultLiteral(variable?: NarrativeVariable): string {
    return variable?.type === NarrativeVariableType.BOOLEAN ? "true" : "0";
}

function defaultCondition(variable?: NarrativeVariable): NarrativeCondition {
    return { variable: variable?.name ?? "", comparison: "==", literal: defaultLiteral(variable) };
}

function semanticDefaults(kind: EmpathyCanvasNodeKind): Partial<CanvasNodeData> {
    switch (kind) {
        case EmpathyCanvasNodeKind.SAY: return { empathyCharacter: "Character" };
        case EmpathyCanvasNodeKind.CHOICE: return { empathyChoices: [] };
        case EmpathyCanvasNodeKind.SET: return { empathyAssignments: [{ variable: "", operation: "=", literal: "" }] };
        default: return {};
    }
}

export function convertedEmpathyNodeData(data: CanvasNodeData, kind: EmpathyCanvasNodeKind): CanvasNodeData {
    const currentText = data.text ?? "";
    const converted: CanvasNodeData = {
        ...data,
        type: "text",
        text: currentText.trim().length === 0 ? initialText(kind) : currentText,
        empathyKind: kind,
    };
    for (const key of nodeSemanticKeys) delete converted[key];
    return { ...converted, ...semanticDefaults(kind) };
}

function requireCanvasRuntime(canvas: Canvas): RuntimeCanvas {
    const candidate = canvas as RuntimeCanvas;
    const runtime = canvas as unknown as Record<string, unknown>;
    const missing: string[] = requiredCanvasMethods.filter((method) => typeof runtime[method] !== "function");
    const nodes = runtime.nodes as { values?: unknown } | undefined;
    const edges = runtime.edges as { values?: unknown } | undefined;
    const selection = runtime.selection as { values?: unknown } | undefined;
    const menu = runtime.menu as { menuEl?: unknown; render?: unknown } | undefined;
    if (!nodes || typeof nodes.values !== "function") missing.push("nodes.values");
    if (!edges || typeof edges.values !== "function") missing.push("edges.values");
    if (!selection || typeof selection.values !== "function") missing.push("selection.values");
    const menuElement = menu?.menuEl as { append?: unknown } | undefined;
    if (typeof menuElement?.append !== "function") missing.push("menu.menuEl");
    if (typeof menu?.render !== "function") missing.push("menu.render");
    if (missing.length > 0) throw new Error(`unsupported Obsidian Canvas runtime; missing ${missing.join(", ")}`);
    return candidate;
}

function hasOwn(object: object, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function patchProperty<T extends object, K extends keyof T>(
    target: T,
    key: K,
    replacement: T[K],
): () => void {
    const originallyOwned = hasOwn(target, key);
    const original = target[key];
    target[key] = replacement;
    return () => {
        if (target[key] !== replacement) return;
        if (originallyOwned) target[key] = original;
        else delete (target as Partial<T>)[key];
    };
}

function stopCanvasEvents(element: HTMLElement): void {
    for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"] as const) {
        element.addEventListener(eventName, (event) => event.stopPropagation());
    }
    element.addEventListener("keydown", (event) => event.stopPropagation());
}

function variableTypeLabel(type: NarrativeVariableType): string {
    return type === NarrativeVariableType.BOOLEAN ? "Bool" : type === NarrativeVariableType.INTEGER ? "Integer" : "Float";
}

export function formatTransitionBadge(data: CanvasEdgeData): string | undefined {
    if (data.empathyElse) return "else";
    const condition = data.empathyCondition;
    if (!condition) return undefined;
    if (condition.comparison === "==" && (condition.literal === "true" || condition.literal === "false")) {
        return `if ${condition.variable} is ${condition.literal}`;
    }
    const comparisons: Record<NarrativeComparison, string> = {
        "==": "=",
        "!=": "≠",
        "<": "<",
        "<=": "≤",
        ">": ">",
        ">=": "≥",
    };
    return `if ${condition.variable} ${comparisons[condition.comparison]} ${condition.literal}`;
}

export function formatChoiceBadge(data: CanvasEdgeData, choices: readonly string[]): string {
    const index = data.empathyChoiceIndex;
    const choice = Number.isInteger(index) ? choices[index!] : undefined;
    return choice?.trim() || "Unlinked choice";
}

export class EmpathyCanvasIntegration {
    private readonly patches = new Map<RuntimeCanvas, CanvasPatch>();
    private disposed = false;
    private runtimeIssueReported = false;

    constructor(private readonly plugin: Plugin, private readonly ui: CanvasUi) {}

    register(): void {
        this.disposed = false;
        const refresh = (): void => { if (!this.disposed) this.patchOpenCanvases(); };
        const workspace = this.plugin.app.workspace;
        this.plugin.registerEvent(workspace.on("layout-change", refresh));
        this.plugin.registerEvent(workspace.on("active-leaf-change", refresh));
        this.plugin.registerEvent(workspace.on("window-open", refresh));
        this.plugin.registerEvent(workspace.on("window-close", refresh));
        workspace.onLayoutReady(refresh);
        const canvasEvents = workspace as unknown as {
            on(name: "canvas:node-menu", callback: (menu: Menu, node: RuntimeCanvasNode) => void): EventRef;
            on(name: "canvas:edge-menu", callback: (menu: Menu, edge: RuntimeCanvasEdge) => void): EventRef;
        };
        this.plugin.registerEvent(canvasEvents.on("canvas:node-menu", (menu, node) => this.addNodeMenuItems(menu, node)));
        this.plugin.registerEvent(canvasEvents.on("canvas:edge-menu", (menu, edge) => this.addEdgeMenuItems(menu, edge)));
        this.plugin.register(() => this.unload());
        refresh();
    }

    variablesChanged(): void {
        for (const patch of this.patches.values()) {
            for (const [node, nodePatch] of patch.nodes) {
                nodePatch.signature = undefined;
                this.decorateNode(patch, node);
            }
            this.scheduleValidation(patch);
        }
    }

    variableUsageCount(name: string): number {
        let count = 0;
        for (const patch of this.patches.values()) {
            for (const node of patch.canvas.nodes.values()) {
                const data = node.getData();
                for (const assignment of data.empathyAssignments ?? []) {
                    if (assignment.variable === name) ++count;
                }
                if (data.empathyEntryCondition?.variable === name) ++count;
            }
            for (const edge of patch.canvas.edges.values()) {
                if (edge.getData().empathyCondition?.variable === name) ++count;
            }
        }
        return count;
    }

    patchCanvas(canvas: Canvas): RuntimeCanvas {
        if (this.disposed) throw new Error("Empathy plugin is unloaded");
        const runtime = requireCanvasRuntime(canvas);
        const existing = this.patches.get(runtime);
        if (existing) {
            this.syncNodes(existing);
            this.syncToolbar(existing);
            this.syncEdgeToolbar(existing);
            this.scheduleValidation(existing);
            return runtime;
        }
        const patch: CanvasPatch = {
            canvas: runtime,
            nodes: new Map(),
            edgeBadges: new Map(),
            restore: [],
        };
        this.patches.set(runtime, patch);
        const originalRequestSave = runtime.requestSave;
        const originalShowCreationMenu = runtime.showCreationMenu;
        const originalSetReadonly = runtime.setReadonly;
        const originalMenuRender = runtime.menu.render;
        const wrappedRequestSave: RuntimeCanvas["requestSave"] = (pushHistory) => {
            if (patch.resizeSaveTimer !== undefined) {
                clearTimeout(patch.resizeSaveTimer);
                patch.resizeSaveTimer = undefined;
            }
            originalRequestSave.call(runtime, pushHistory);
            if (!this.disposed) {
                this.syncNodes(patch);
                this.scheduleValidation(patch);
            }
        };
        const wrappedShowCreationMenu: RuntimeCanvas["showCreationMenu"] = (menu, pos, size) => {
            if (!this.disposed && !runtime.readonly) {
                for (const kind of creationNodeKinds) {
                    menu.addItem((item) => item.setTitle(`Add Empathy ${nodeLabels[kind]}`).setSection("create")
                        .setIcon(nodeIcons[kind]).onClick(() => this.tryCreateNode(runtime, kind, pos, size)));
                }
            }
            originalShowCreationMenu.call(runtime, menu, pos, size);
        };
        const wrappedSetReadonly: RuntimeCanvas["setReadonly"] = (readonly) => {
            if (readonly) this.flushCanvasCharacterSaves(patch);
            originalSetReadonly.call(runtime, readonly);
            if (!this.disposed) {
                this.syncToolbar(patch);
                this.syncEdgeToolbar(patch);
                for (const node of patch.nodes.keys()) this.decorateNode(patch, node);
            }
        };
        const wrappedMenuRender: RuntimeCanvasMenu["render"] = (...args) => {
            originalMenuRender.call(runtime.menu, ...args);
            if (!this.disposed) this.syncEdgeToolbar(patch);
        };
        patch.restore.push(
            patchProperty(runtime, "requestSave", wrappedRequestSave),
            patchProperty(runtime, "showCreationMenu", wrappedShowCreationMenu),
            patchProperty(runtime, "setReadonly", wrappedSetReadonly),
            patchProperty(runtime.menu, "render", wrappedMenuRender),
        );
        this.syncNodes(patch);
        this.syncToolbar(patch);
        this.syncEdgeToolbar(patch);
        this.scheduleValidation(patch);
        return runtime;
    }

    createNode(canvas: Canvas, kind: EmpathyCanvasNodeKind, pos?: CanvasPoint, requestedSize?: CanvasSize): RuntimeCanvasNode {
        const runtime = this.patchCanvas(canvas);
        if (runtime.readonly) throw new Error("active Canvas is read-only");
        const centered = pos === undefined;
        let metadata: Partial<CanvasNodeData> = {};
        if (kind === EmpathyCanvasNodeKind.PORTAL_TRANSMITTER) {
            metadata = { empathyPortalId: this.newPortalId(runtime), empathyPortalName: this.newPortalName(runtime) };
        } else if (kind === EmpathyCanvasNodeKind.PORTAL_RECEIVER) {
            const transmitters = this.portalTransmitters(runtime);
            metadata = {
                empathyPortalId: transmitters.length === 1
                    ? String(transmitters[0].getData().empathyPortalId ?? "")
                    : "",
            };
        }
        const node = this.createTypedNode(
            runtime,
            kind,
            pos ?? runtime.posCenter(),
            requestedSize ?? nodeSizes[kind],
            centered,
            metadata,
        );
        runtime.selectOnly(node);
        runtime.markDirty(node);
        runtime.requestSave();
        if (kind === EmpathyCanvasNodeKind.SAY) this.focusCharacterField(node);
        else if (kind === EmpathyCanvasNodeKind.LINE || kind === EmpathyCanvasNodeKind.ENTRY) node.startEditing();
        else if (kind === EmpathyCanvasNodeKind.SET) this.focusVariablePicker(node);
        else if (kind === EmpathyCanvasNodeKind.PORTAL_RECEIVER) this.focusPortalReceiver(node);
        else if (kind === EmpathyCanvasNodeKind.PORTAL_TRANSMITTER) this.focusPortalName(node);
        return node;
    }

    private createTypedNode(
        runtime: RuntimeCanvas,
        kind: EmpathyCanvasNodeKind,
        pos: CanvasPoint,
        size: CanvasSize,
        centered: boolean,
        metadata: Partial<CanvasNodeData> = {},
    ): RuntimeCanvasNode {
        const node = runtime.createTextNode({
            pos,
            size,
            position: centered ? "center" : undefined,
            text: initialText(kind),
            save: false,
            focus: false,
        });
        node.setData({
            ...node.getData(),
            type: "text",
            text: initialText(kind),
            empathyKind: kind,
            ...semanticDefaults(kind),
            ...metadata,
        });
        node.attach();
        node.render();
        return node;
    }

    private newPortalId(canvas: RuntimeCanvas): string {
        const ids = new Set(Array.from(canvas.nodes.values(), (node) => node.getData().empathyPortalId));
        const crypto = canvas.menu.menuEl.ownerDocument.defaultView?.crypto;
        let id: string;
        do {
            const random = crypto?.getRandomValues(new Uint32Array(2));
            id = random
                ? `portal-${Array.from(random, (value) => value.toString(16).padStart(8, "0")).join("")}`
                : `portal-${Date.now().toString(16)}-${Math.floor(Math.random() * 0xFFFFFFFF).toString(16)}`;
        } while (ids.has(id));
        return id;
    }

    private newPortalName(canvas: RuntimeCanvas): string {
        const names = new Set(Array.from(canvas.nodes.values(), (node) => node.getData().empathyPortalName));
        for (let suffix = 1; ; ++suffix) {
            const name = `Portal ${suffix}`;
            if (!names.has(name)) return name;
        }
    }

    private portalTransmitters(canvas: RuntimeCanvas): RuntimeCanvasNode[] {
        return Array.from(canvas.nodes.values() as IterableIterator<RuntimeCanvasNode>)
            .filter((node) => getEmpathyCanvasNodeKind(node.getData()) === EmpathyCanvasNodeKind.PORTAL_TRANSMITTER)
            .sort((left, right) => {
                const leftName = String(left.getData().empathyPortalName ?? "");
                const rightName = String(right.getData().empathyPortalName ?? "");
                return leftName.localeCompare(rightName);
            });
    }

    private syncToolbar(patch: CanvasPatch): void {
        if (this.disposed || patch.canvas.readonly) { this.removeToolbar(patch); return; }
        const host = patch.canvas.cardMenuEl;
        if (!host?.classList.contains("canvas-card-menu")) { this.removeToolbar(patch); return; }
        if (patch.toolbarEl?.parentElement === host) return;
        this.removeToolbar(patch);
        const toolbar = host.ownerDocument.createElement("div");
        toolbar.className = "empathy-canvas-toolbar";
        toolbar.setAttribute("role", "group");
        toolbar.setAttribute("aria-label", "Empathy authoring tools");
        for (const kind of creationNodeKinds) {
            const button = this.toolbarButton(host.ownerDocument, `Add Empathy ${nodeLabels[kind]}`, nodeIcons[kind], () => this.tryCreateNode(patch.canvas, kind));
            button.dataset.empathyKind = kind;
            toolbar.append(button);
        }
        host.append(toolbar);
        patch.toolbarEl = toolbar;
    }

    private toolbarButton(document: Document, title: string, icon: string, activate: () => void): HTMLElement {
        const button = document.createElement("div");
        button.className = "canvas-card-menu-button empathy-canvas-toolbar-button";
        button.setAttribute("role", "button");
        button.setAttribute("aria-label", title);
        button.tabIndex = 0;
        this.ui.setIcon(button, icon);
        this.ui.setTooltip(button, title);
        button.addEventListener("click", activate);
        button.addEventListener("keydown", (event) => {
            if (!event.repeat && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                event.stopPropagation();
                activate();
            }
        });
        return button;
    }

    private syncEdgeToolbar(patch: CanvasPatch): void {
        const edge = this.selectedEdge(patch.canvas);
        const host = patch.canvas.menu.menuEl;
        if (this.disposed || patch.canvas.readonly || !edge || !host.classList.contains("canvas-menu")) {
            this.removeEdgeToolbar(patch);
            return;
        }
        const signature = this.edgeToolbarSignature(patch, edge);
        if (patch.edgeToolbarButtons?.every((button) => button.parentElement === host) && patch.edgeToolbarSignature === signature) return;
        this.removeEdgeToolbar(patch);
        const buttons = this.edgeToolbarButtons(patch, host.ownerDocument, edge);
        buttons[0]?.classList.add("is-first");
        host.append(...buttons);
        patch.edgeToolbarButtons = buttons;
        patch.edgeToolbarSignature = signature;
    }

    private selectedEdge(canvas: RuntimeCanvas): RuntimeCanvasEdge | undefined {
        if (!canvas.selection || canvas.selection.size !== 1) return undefined;
        const selected = canvas.selection.values().next().value;
        for (const edge of canvas.edges.values() as IterableIterator<RuntimeCanvasEdge>) {
            if (edge === selected) return edge;
        }
        return undefined;
    }

    private edgeToolbarSignature(patch: CanvasPatch, edge: RuntimeCanvasEdge): string {
        const data = edge.getData();
        const sourceKind = getEmpathyCanvasNodeKind(edge.from?.node?.getData() ?? {});
        const anotherElse = this.otherElseEdge(patch, edge) !== undefined;
        return JSON.stringify([
            "edge",
            edge.id ?? data.id,
            sourceKind,
            data.empathyCondition,
            data.empathyElse,
            data.empathyConditionOrder,
            data.empathyChoiceIndex,
            anotherElse,
        ]);
    }

    private edgeToolbarButtons(patch: CanvasPatch, document: Document, edge: RuntimeCanvasEdge): HTMLElement[] {
        const buttons: HTMLElement[] = [];
        const data = edge.getData();
        const sourceKind = getEmpathyCanvasNodeKind(edge.from?.node?.getData() ?? {});
        const append = (title: string, icon: string, action: string, activate: () => void, disabled = false): void => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "clickable-icon empathy-canvas-edge-toolbar-button";
            button.dataset.empathyEdgeAction = action;
            button.disabled = disabled;
            button.setAttribute("aria-label", title);
            this.ui.setIcon(button, icon);
            this.ui.setTooltip(button, title);
            if (!disabled) button.addEventListener("click", activate);
            buttons.push(button);
        };
        if (sourceKind === EmpathyCanvasNodeKind.CHOICE) {
            append(
                data.empathyChoiceIndex === undefined ? "Link Empathy choice" : "Change linked Empathy choice",
                "list-ordered",
                "choice",
                () => this.openEdgeEditor(patch, edge, "choice"),
            );
            append("Unlink Empathy choice", "unlink", "clear", () => this.clearChoiceEdge(patch, edge), data.empathyChoiceIndex === undefined);
            return buttons;
        }
        append(
            data.empathyCondition ? "Edit Empathy condition" : "Make Empathy conditional",
            "git-branch",
            "condition",
            () => this.openEdgeEditor(patch, edge, "condition"),
        );
        const anotherElse = this.otherElseEdge(patch, edge) !== undefined;
        append(
            data.empathyElse ? "This is the Empathy else transition" : anotherElse ? "Another else transition already exists" : "Make Empathy else",
            "corner-down-right",
            "else",
            () => this.makeEdgeElse(patch, edge),
            Boolean(data.empathyElse || anotherElse),
        );
        append(
            "Clear Empathy condition",
            "circle-off",
            "clear",
            () => this.clearEdgeMetadata(patch, edge),
            data.empathyCondition === undefined && !data.empathyElse,
        );
        return buttons;
    }

    private groupedVariables(): Array<{ table: string; variables: NarrativeVariable[] }> {
        const groups = new Map<string, NarrativeVariable[]>();
        for (const variable of this.ui.getVariables()) {
            const table = parseVariableName(variable.name)?.tableName ?? "Invalid names";
            const values = groups.get(table) ?? [];
            values.push(variable);
            groups.set(table, values);
        }
        return Array.from(groups, ([table, variables]) => ({ table, variables }));
    }

    private select(document: Document, options: Array<[string, string]>, selected: string): HTMLSelectElement {
        const select = document.createElement("select");
        for (const [value, label] of options) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            select.append(option);
        }
        select.value = selected;
        return select;
    }

    private selectPreserving(document: Document, options: Array<[string, string]>, selected: string): HTMLSelectElement {
        const values = options.some(([value]) => value === selected)
            ? options
            : [...options, [selected, `${selected || "(empty)"} (invalid)`] as [string, string]];
        return this.select(document, values, selected);
    }

    private createVariablePicker(
        document: Document,
        selected: string,
        onSelect: (name: string) => void,
    ): HTMLElement {
        const root = document.createElement("div");
        root.className = "empathy-variable-picker";
        const input = document.createElement("input");
        input.type = "search";
        input.placeholder = "Search variables…";
        input.autocomplete = "off";
        const popup = document.createElement("div");
        popup.className = "empathy-variable-picker-popup";
        root.append(input);
        stopCanvasEvents(root);
        stopCanvasEvents(popup);
        let committed = selected;
        const close = (): void => {
            popup.classList.remove("is-open");
            popup.remove();
        };
        const position = (): void => {
            const view = document.defaultView;
            if (!view) return;
            const bounds = input.getBoundingClientRect();
            const gap = 4;
            const margin = 8;
            const width = Math.min(Math.max(bounds.width, 230), view.innerWidth - margin * 2);
            const below = view.innerHeight - bounds.bottom - gap - margin;
            const above = bounds.top - gap - margin;
            const opensAbove = below < 120 && above > below;
            popup.style.width = `${width}px`;
            popup.style.maxHeight = `${Math.max(80, Math.min(250, opensAbove ? above : below))}px`;
            popup.style.left = `${Math.max(margin, Math.min(bounds.left, view.innerWidth - width - margin))}px`;
            if (opensAbove) {
                popup.style.top = "auto";
                popup.style.bottom = `${view.innerHeight - bounds.top + gap}px`;
            } else {
                popup.style.top = `${bounds.bottom + gap}px`;
                popup.style.bottom = "auto";
            }
        };
        const open = (): void => {
            document.body.append(popup);
            popup.classList.add("is-open");
            position();
            render();
        };
        const restore = (): void => {
            input.value = committed;
            close();
            input.classList.toggle("is-missing", Boolean(committed) && !this.ui.getVariables().some((variable) => variable.name === committed));
        };
        const render = (): void => {
            popup.replaceChildren();
            const query = input.value.toLowerCase();
            if (committed && !this.ui.getVariables().some((variable) => variable.name === committed)) {
                const missing = document.createElement("div");
                missing.className = "empathy-variable-missing";
                missing.textContent = `⚠ ${committed} (missing)`;
                popup.append(missing);
            }
            for (const group of this.groupedVariables()) {
                const matching = group.variables.filter((variable) => variable.name.toLowerCase().includes(query));
                if (matching.length === 0) continue;
                const heading = document.createElement("div");
                heading.className = "empathy-variable-picker-group";
                heading.textContent = group.table;
                popup.append(heading);
                for (const variable of matching) {
                    const button = document.createElement("button");
                    button.type = "button";
                    const parsed = parseVariableName(variable.name);
                    const name = document.createElement("span");
                    name.textContent = parsed?.variableName ?? variable.name;
                    const type = document.createElement("small");
                    type.textContent = variableTypeLabel(variable.type);
                    button.append(name, type);
                    button.addEventListener("mousedown", (event) => event.preventDefault());
                    button.addEventListener("click", () => {
                        committed = variable.name;
                        input.value = variable.name;
                        close();
                        onSelect(variable.name);
                    });
                    popup.append(button);
                }
            }
            const create = document.createElement("button");
            create.type = "button";
            create.className = "empathy-variable-picker-new";
            create.textContent = "+ New variable";
            create.addEventListener("mousedown", (event) => event.preventDefault());
            create.addEventListener("click", () => {
                close();
                this.ui.openPanel((variable) => {
                    committed = variable.name;
                    input.value = variable.name;
                    onSelect(variable.name);
                });
            });
            popup.append(create);
        };
        input.addEventListener("focus", () => { input.select(); open(); });
        input.addEventListener("input", () => { position(); render(); });
        input.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                restore();
            }
        });
        root.addEventListener("focusout", () => setTimeout(() => {
            if (!root.contains(document.activeElement)) restore();
        }, 0));
        restore();
        return root;
    }

    private conditionControls(
        document: Document,
        condition: NarrativeCondition,
        onChange: (condition: NarrativeCondition) => void,
    ): HTMLElement {
        const root = document.createElement("div");
        root.className = "empathy-condition-controls";
        const picker = this.createVariablePicker(document, condition.variable, (name) => {
            const selected = this.ui.getVariables().find((item) => item.name === name);
            onChange(condition.variable ? { ...condition, variable: name } : defaultCondition(selected));
        });
        root.append(picker);
        const variable = this.ui.getVariables().find((item) => item.name === condition.variable);
        if (variable?.type === NarrativeVariableType.BOOLEAN) {
            if (condition.comparison === "==" && (condition.literal === "true" || condition.literal === "false")) {
                const truth = this.select(document, [["true", "is true"], ["false", "is false"]], condition.literal);
                truth.addEventListener("change", () => onChange({ ...condition, literal: truth.value }));
                root.append(truth);
            } else {
                const comparison = this.selectPreserving(document, [["==", "=="]], condition.comparison);
                const literal = this.selectPreserving(document, [["true", "true"], ["false", "false"]], condition.literal);
                comparison.addEventListener("change", () => onChange({ ...condition, comparison: comparison.value as NarrativeComparison }));
                literal.addEventListener("change", () => onChange({ ...condition, literal: literal.value }));
                root.append(comparison, literal);
            }
        } else {
            const comparison = this.select(document, [["==", "=="], ["!=", "!="], ["<", "<"], ["<=", "<="], [">", ">"], [">=", ">="]], condition.comparison);
            const literal = document.createElement("input");
            literal.type = "text";
            literal.inputMode = "decimal";
            literal.value = condition.literal;
            comparison.addEventListener("change", () => onChange({ ...condition, comparison: comparison.value as NarrativeComparison }));
            literal.addEventListener("change", () => onChange({ ...condition, literal: literal.value }));
            root.append(comparison, literal);
        }
        return root;
    }

    private patchOpenCanvases(): void {
        const live = new Set<RuntimeCanvas>();
        for (const leaf of this.plugin.app.workspace.getLeavesOfType("canvas")) {
            const view = leaf.view as unknown as { canvas?: Canvas };
            if (!view.canvas) continue;
            try { live.add(this.patchCanvas(view.canvas)); } catch (error) { this.reportRuntimeIssue(error); }
        }
        for (const canvas of this.patches.keys()) if (!live.has(canvas)) this.unpatchCanvas(canvas);
    }

    private syncNodes(patch: CanvasPatch): void {
        const live = new Set(Array.from(patch.canvas.nodes.values()) as RuntimeCanvasNode[]);
        for (const node of patch.nodes.keys()) {
            if (!live.has(node)) this.unpatchNode(patch, node);
        }
        for (const node of live) this.patchNode(patch, node);
    }

    private patchNode(patch: CanvasPatch, node: RuntimeCanvasNode): void {
        if (node.getData().type !== "text") return;
        if (patch.nodes.has(node)) { this.decorateNode(patch, node); return; }
        const originalSetData = node.setData;
        const originalRender = node.render;
        const originalSetIsEditing = node.setIsEditing;
        const nodePatch: NodePatch = { restore: [] };
        patch.nodes.set(node, nodePatch);
        const wrappedSetData: RuntimeCanvasNode["setData"] = (data) => {
            originalSetData.call(node, data);
            if (!this.disposed) { this.decorateNode(patch, node); this.scheduleValidation(patch); }
        };
        const wrappedRender: RuntimeCanvasNode["render"] = () => {
            originalRender.call(node);
            if (!this.disposed) this.decorateNode(patch, node);
        };
        const wrappedSetIsEditing: RuntimeCanvasNode["setIsEditing"] = (editing, ...args) => {
            originalSetIsEditing.call(node, editing, ...args);
            if (!this.disposed) this.decorateNode(patch, node);
        };
        nodePatch.restore.push(
            patchProperty(node, "setData", wrappedSetData),
            patchProperty(node, "render", wrappedRender),
            patchProperty(node, "setIsEditing", wrappedSetIsEditing),
        );
        this.decorateNode(patch, node);
    }

    private nodeSignature(node: RuntimeCanvasNode, kind: EmpathyCanvasNodeKind, data: CanvasNodeData): string {
        switch (kind) {
            case EmpathyCanvasNodeKind.CHOICE:
                return JSON.stringify([kind, data.empathyChoices, ...this.outgoingRuntimeEdges(node.canvas, node).map((edge) => edge.getData().empathyChoiceIndex)]);
            case EmpathyCanvasNodeKind.SET:
                return JSON.stringify([kind, data.empathyAssignments]);
            case EmpathyCanvasNodeKind.ENTRY:
                return JSON.stringify([kind, data.empathyEntryCondition, data.empathyEntryMatchValue]);
            case EmpathyCanvasNodeKind.PORTAL_RECEIVER:
                return JSON.stringify([
                    kind,
                    data.empathyPortalId,
                    ...this.portalTransmitters(node.canvas).map((transmitter) => {
                        const transmitterData = transmitter.getData();
                        return [transmitterData.empathyPortalId, transmitterData.empathyPortalName];
                    }),
                ]);
            case EmpathyCanvasNodeKind.PORTAL_TRANSMITTER:
                return JSON.stringify([kind, data.empathyPortalId]);
            default:
                return kind;
        }
    }

    private decorateNode(patch: CanvasPatch, node: RuntimeCanvasNode): void {
        const data = node.getData();
        const kind = getEmpathyCanvasNodeKind(data);
        if (kind !== EmpathyCanvasNodeKind.SAY) this.cancelCharacterSave(patch, node);
        if (!kind) { this.clearDecoration(patch, node); return; }
        for (const known of nodeKinds) node.nodeEl.classList.remove(`empathy-canvas-node-${known}`);
        node.nodeEl.classList.add("empathy-canvas-node", `empathy-canvas-node-${kind}`);
        node.nodeEl.dataset.empathyMode = node.isEditing || node.nodeEl.classList.contains("is-editing") ? "edit" : "preview";
        this.ensureHeader(patch, node, kind, data);
    }

    private ensureHeader(patch: CanvasPatch, node: RuntimeCanvasNode, kind: EmpathyCanvasNodeKind, data: CanvasNodeData): void {
        const nodePatch = patch.nodes.get(node);
        if (!nodePatch) return;
        const signature = this.nodeSignature(node, kind, data);
        if (!nodePatch.headerEl || nodePatch.headerEl.parentElement !== node.nodeEl || nodePatch.signature !== signature) {
            nodePatch.headerEl?.remove();
            const header = node.nodeEl.ownerDocument.createElement("div");
            header.className = "empathy-canvas-node-header";
            const title = node.nodeEl.ownerDocument.createElement("div");
            title.className = "empathy-canvas-node-title";
            const symbol = node.nodeEl.ownerDocument.createElement("span");
            symbol.className = "empathy-canvas-node-symbol";
            symbol.textContent = nodeSymbols[kind];
            const label = node.nodeEl.ownerDocument.createElement("span");
            label.className = "empathy-canvas-node-type";
            label.textContent = nodeLabels[kind];
            const hint = node.nodeEl.ownerDocument.createElement("span");
            hint.className = "empathy-canvas-node-hint";
            hint.textContent = nodeHints[kind] ?? "";
            title.append(symbol, label, hint);
            header.append(title);
            if (kind === EmpathyCanvasNodeKind.SAY) this.addCharacterControl(patch, node, header);
            else if (kind === EmpathyCanvasNodeKind.SET) this.addSetControls(node, header, data);
            else if (kind === EmpathyCanvasNodeKind.ENTRY) this.addEntryControls(node, header, data);
            else if (kind === EmpathyCanvasNodeKind.CHOICE) this.addChoiceControls(patch, node, header, data);
            else if (kind === EmpathyCanvasNodeKind.PORTAL_RECEIVER) this.addPortalReceiverControl(patch, node, header);
            else if (kind === EmpathyCanvasNodeKind.PORTAL_TRANSMITTER) this.addPortalTransmitterControl(patch, node, header);
            node.nodeEl.append(header);
            nodePatch.headerEl = header;
            nodePatch.signature = signature;
        }
        if (kind === EmpathyCanvasNodeKind.SAY) {
            const input = nodePatch.headerEl.querySelector<HTMLInputElement>(".empathy-canvas-character-input");
            const character = typeof data.empathyCharacter === "string" ? data.empathyCharacter : "";
            if (input && node.nodeEl.ownerDocument.activeElement !== input) input.value = character;
            if (input) input.disabled = Boolean(node.canvas.readonly || node.isEditing || node.nodeEl.classList.contains("is-editing"));
        }
        if (kind === EmpathyCanvasNodeKind.PORTAL_TRANSMITTER) {
            const input = nodePatch.headerEl.querySelector<HTMLInputElement>(".empathy-canvas-portal-input");
            const name = typeof data.empathyPortalName === "string" ? data.empathyPortalName : "";
            if (input && node.nodeEl.ownerDocument.activeElement !== input) input.value = name;
            if (input) input.disabled = node.canvas.readonly;
        }
        if (kind === EmpathyCanvasNodeKind.PORTAL_RECEIVER) {
            const select = nodePatch.headerEl.querySelector<HTMLSelectElement>(".empathy-canvas-portal-select");
            if (select) {
                select.value = typeof data.empathyPortalId === "string" ? data.empathyPortalId : "";
                select.disabled = node.canvas.readonly;
            }
        }
        const controls = nodePatch.headerEl.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
            ".empathy-node-controls input, .empathy-node-controls select, .empathy-node-controls button",
        );
        for (const control of Array.from(controls)) {
            control.disabled = node.canvas.readonly;
        }
        this.fitExpandableNode(patch, node, kind, nodePatch.headerEl);
    }

    private fitExpandableNode(
        patch: CanvasPatch,
        node: RuntimeCanvasNode,
        kind: EmpathyCanvasNodeKind,
        header: HTMLElement,
    ): void {
        const nodePatch = patch.nodes.get(node);
        if (!nodePatch) return;
        if (kind !== EmpathyCanvasNodeKind.CHOICE && kind !== EmpathyCanvasNodeKind.SET) {
            node.nodeEl.style.removeProperty("--empathy-node-header-height");
            nodePatch.autoHeight = undefined;
            return;
        }

        const headerHeight = Math.ceil(header.scrollHeight);
        if (headerHeight <= 0) return;
        node.nodeEl.style.setProperty("--empathy-node-header-height", `${headerHeight}px`);
        if (node.canvas.readonly) return;

        const data = node.getData();
        const currentHeight = typeof data.height === "number" ? data.height : nodeSizes[kind].height;
        const requiredHeight = Math.max(nodeSizes[kind].height, headerHeight + 12);
        let nextHeight = currentHeight;
        if (currentHeight < requiredHeight) nextHeight = requiredHeight;
        else if (nodePatch.autoHeight === currentHeight && currentHeight > requiredHeight) nextHeight = requiredHeight;
        else if (currentHeight === requiredHeight) nodePatch.autoHeight = currentHeight;
        else if (nodePatch.autoHeight !== currentHeight) nodePatch.autoHeight = undefined;
        if (nextHeight === currentHeight) return;

        nodePatch.autoHeight = nextHeight;
        node.setData({ ...data, height: nextHeight });
        node.canvas.markDirty(node);
        if (patch.resizeSaveTimer === undefined) {
            patch.resizeSaveTimer = setTimeout(() => {
                patch.resizeSaveTimer = undefined;
                if (!this.disposed && this.patches.get(patch.canvas) === patch && !patch.canvas.readonly) {
                    patch.canvas.requestSave();
                }
            }, 0);
        }
    }

    private addCharacterControl(patch: CanvasPatch, node: RuntimeCanvasNode, header: HTMLElement): void {
        const input = header.ownerDocument.createElement("input");
        input.className = "empathy-canvas-character-input";
        input.type = "text";
        input.placeholder = "Character";
        input.value = typeof node.getData().empathyCharacter === "string" ? node.getData().empathyCharacter! : "";
        input.addEventListener("input", () => this.updateCharacter(patch, node, input.value));
        input.addEventListener("change", () => this.flushCharacterSave(patch, node));
        input.addEventListener("blur", () => this.flushCharacterSave(patch, node));
        stopCanvasEvents(input);
        header.querySelector(".empathy-canvas-node-title")!.append(input);
    }

    private addPortalTransmitterControl(patch: CanvasPatch, node: RuntimeCanvasNode, header: HTMLElement): void {
        const input = header.ownerDocument.createElement("input");
        input.className = "empathy-canvas-portal-input";
        input.type = "text";
        input.placeholder = "Portal name";
        input.value = typeof node.getData().empathyPortalName === "string" ? node.getData().empathyPortalName! : "";
        input.addEventListener("input", () => this.updatePortalName(patch, node, input.value));
        input.addEventListener("change", () => {
            if (!node.canvas.readonly) node.canvas.requestSave();
        });
        stopCanvasEvents(input);
        header.querySelector(".empathy-canvas-node-title")!.append(input);
    }

    private addPortalReceiverControl(patch: CanvasPatch, node: RuntimeCanvasNode, header: HTMLElement): void {
        const select = header.ownerDocument.createElement("select");
        select.className = "empathy-canvas-portal-select";
        const empty = header.ownerDocument.createElement("option");
        empty.value = "";
        empty.textContent = "Select transmitter…";
        select.append(empty);
        const selected = typeof node.getData().empathyPortalId === "string" ? node.getData().empathyPortalId! : "";
        let selectedExists = selected.length === 0;
        for (const transmitter of this.portalTransmitters(node.canvas)) {
            const data = transmitter.getData();
            const portalId = typeof data.empathyPortalId === "string" ? data.empathyPortalId : "";
            if (portalId.length === 0) continue;
            const option = header.ownerDocument.createElement("option");
            option.value = portalId;
            option.textContent = typeof data.empathyPortalName === "string" && data.empathyPortalName.trim().length > 0
                ? data.empathyPortalName
                : "Unnamed transmitter";
            select.append(option);
            if (portalId === selected) selectedExists = true;
        }
        if (!selectedExists) {
            const missing = header.ownerDocument.createElement("option");
            missing.value = selected;
            missing.textContent = "Missing transmitter";
            select.append(missing);
        }
        select.value = selected;
        select.addEventListener("change", () => this.updatePortalReceiver(patch, node, select.value));
        stopCanvasEvents(select);
        header.querySelector(".empathy-canvas-node-title")!.append(select);
    }

    private addSetControls(node: RuntimeCanvasNode, header: HTMLElement, data: CanvasNodeData): void {
        const controls = header.ownerDocument.createElement("div");
        controls.className = "empathy-node-controls empathy-set-controls";
        const assignments = Array.isArray(data.empathyAssignments) ? data.empathyAssignments : [];
        assignments.forEach((assignment, index) => {
            const row = header.ownerDocument.createElement("div");
            row.className = "empathy-set-row";
            const picker = this.createVariablePicker(header.ownerDocument, assignment.variable, (name) => {
                const selected = this.ui.getVariables().find((item) => item.name === name);
                this.updateSetAssignment(node, index, assignment.variable
                    ? { variable: name }
                    : { variable: name, operation: "=", literal: defaultLiteral(selected) });
            });
            const variable = this.ui.getVariables().find((item) => item.name === assignment.variable);
            const operationOptions: Array<[string, string]> = variable?.type === NarrativeVariableType.BOOLEAN
                ? [["=", "="]]
                : [["=", "="], ["+=", "+="], ["-=", "-="]];
            const operation = this.selectPreserving(header.ownerDocument, operationOptions, assignment.operation);
            operation.addEventListener("change", () => this.updateSetAssignment(node, index, { operation: operation.value }));
            let literal: HTMLElement;
            if (variable?.type === NarrativeVariableType.BOOLEAN) {
                const boolean = this.selectPreserving(
                    header.ownerDocument,
                    [["true", "true"], ["false", "false"]],
                    assignment.literal,
                );
                boolean.addEventListener("change", () => this.updateSetAssignment(node, index, { literal: boolean.value }));
                literal = boolean;
            } else {
                const number = header.ownerDocument.createElement("input");
                number.type = "text";
                number.inputMode = "decimal";
                number.value = assignment.literal;
                number.addEventListener("change", () => this.updateSetAssignment(node, index, { literal: number.value }));
                literal = number;
            }
            const remove = header.ownerDocument.createElement("button");
            remove.type = "button";
            remove.className = "empathy-set-remove";
            remove.title = "Remove assignment";
            remove.setAttribute("aria-label", "Remove assignment");
            this.ui.setIcon(remove, "x");
            remove.addEventListener("click", () => this.removeSetAssignment(node, index));
            row.append(picker, operation, literal, remove);
            controls.append(row);
        });
        const add = header.ownerDocument.createElement("button");
        add.type = "button";
        add.className = "empathy-set-add";
        add.textContent = "+ Assignment";
        add.addEventListener("click", () => this.addSetAssignment(node));
        controls.append(add);
        stopCanvasEvents(controls);
        header.append(controls);
    }

    private addSetAssignment(node: RuntimeCanvasNode): void {
        const current = Array.isArray(node.getData().empathyAssignments) ? node.getData().empathyAssignments! : [];
        const variable = this.ui.getVariables().find((item) => item.access !== NarrativeVariableAccess.READ);
        const assignment: NarrativeAssignment = {
            variable: variable?.name ?? "",
            operation: "=",
            literal: defaultLiteral(variable),
        };
        this.updateNode(node, { empathyAssignments: [...current, assignment] });
    }

    private updateSetAssignment(node: RuntimeCanvasNode, index: number, updates: Partial<NarrativeAssignment>): void {
        const assignments = Array.isArray(node.getData().empathyAssignments) ? [...node.getData().empathyAssignments!] : [];
        if (!assignments[index]) return;
        assignments[index] = { ...assignments[index], ...updates };
        this.updateNode(node, { empathyAssignments: assignments });
    }

    private removeSetAssignment(node: RuntimeCanvasNode, index: number): void {
        const assignments = Array.isArray(node.getData().empathyAssignments) ? [...node.getData().empathyAssignments!] : [];
        if (index < 0 || index >= assignments.length) return;
        assignments.splice(index, 1);
        this.updateNode(node, { empathyAssignments: assignments });
    }

    private addEntryControls(node: RuntimeCanvasNode, header: HTMLElement, data: CanvasNodeData): void {
        const controls = header.ownerDocument.createElement("div");
        controls.className = "empathy-node-controls empathy-entry-controls";
        if (!data.empathyEntryCondition) {
            const add = header.ownerDocument.createElement("button");
            add.type = "button";
            add.textContent = "+ Availability predicate";
            add.addEventListener("click", () => {
                const variable = this.ui.getVariables().find((item) => item.access !== NarrativeVariableAccess.WRITE);
                this.updateNode(node, { empathyEntryCondition: defaultCondition(variable), empathyEntryMatchValue: "0" });
            });
            controls.append(add);
        } else {
            controls.append(this.conditionControls(header.ownerDocument, data.empathyEntryCondition, (condition) => this.updateNode(node, { empathyEntryCondition: condition })));
            const match = header.ownerDocument.createElement("input");
            match.type = "number";
            match.min = "0";
            match.max = "4294967295";
            match.step = "1";
            match.value = String(data.empathyEntryMatchValue ?? "0");
            match.title = "UINT32 match value";
            match.addEventListener("change", () => this.updateNode(node, { empathyEntryMatchValue: match.value }));
            const remove = header.ownerDocument.createElement("button");
            remove.type = "button";
            remove.textContent = "×";
            remove.title = "Remove availability predicate";
            remove.addEventListener("click", () => this.updateNode(node, { empathyEntryCondition: undefined, empathyEntryMatchValue: undefined }));
            controls.append(match, remove);
        }
        stopCanvasEvents(controls);
        header.append(controls);
    }

    private addChoiceControls(patch: CanvasPatch, node: RuntimeCanvasNode, header: HTMLElement, data: CanvasNodeData): void {
        const controls = header.ownerDocument.createElement("div");
        controls.className = "empathy-node-controls empathy-choice-controls";
        const choices = Array.isArray(data.empathyChoices) ? data.empathyChoices : [];
        const edges = this.outgoingRuntimeEdges(node.canvas, node);
        for (let index = 0; index < choices.length; ++index) {
            const row = header.ownerDocument.createElement("div");
            row.className = "empathy-choice-row";
            const order = header.ownerDocument.createElement("span");
            order.textContent = String(index);
            const text = header.ownerDocument.createElement("input");
            text.type = "text";
            text.value = typeof choices[index] === "string" ? choices[index] : "";
            text.placeholder = "Choice text";
            text.addEventListener("change", () => this.renameChoice(node, index, text.value));
            const connection = header.ownerDocument.createElement("span");
            const linked = edges.some((edge) => edge.getData().empathyChoiceIndex === index);
            connection.className = linked ? "empathy-choice-link is-linked" : "empathy-choice-link";
            connection.textContent = linked ? "●" : "○";
            connection.title = linked ? "Linked to an edge" : "Not linked to an edge";
            const up = header.ownerDocument.createElement("button");
            up.type = "button"; up.textContent = "↑"; up.disabled = index === 0;
            const down = header.ownerDocument.createElement("button");
            down.type = "button"; down.textContent = "↓"; down.disabled = index + 1 === choices.length;
            const remove = header.ownerDocument.createElement("button");
            remove.type = "button"; remove.textContent = "×"; remove.title = "Remove choice";
            up.addEventListener("click", () => this.moveChoice(patch, node, index, index - 1));
            down.addEventListener("click", () => this.moveChoice(patch, node, index, index + 1));
            remove.addEventListener("click", () => this.removeChoice(patch, node, index));
            row.append(order, text, connection, up, down, remove);
            controls.append(row);
        }
        const add = header.ownerDocument.createElement("button");
        add.type = "button";
        add.className = "empathy-choice-add";
        add.textContent = "+ Choice";
        add.addEventListener("click", () => this.addChoice(node));
        controls.append(add);
        stopCanvasEvents(controls);
        header.append(controls);
    }

    private addChoice(node: RuntimeCanvasNode): void {
        const choices = Array.isArray(node.getData().empathyChoices) ? [...node.getData().empathyChoices!] : [];
        choices.push(`Choice ${choices.length + 1}`);
        this.updateNode(node, { empathyChoices: choices });
    }

    private renameChoice(node: RuntimeCanvasNode, index: number, text: string): void {
        const choices = Array.isArray(node.getData().empathyChoices) ? [...node.getData().empathyChoices!] : [];
        if (index >= choices.length) return;
        choices[index] = text;
        this.updateNode(node, { empathyChoices: choices });
    }

    private moveChoice(patch: CanvasPatch, node: RuntimeCanvasNode, from: number, to: number): void {
        const choices = Array.isArray(node.getData().empathyChoices) ? [...node.getData().empathyChoices!] : [];
        if (from < 0 || to < 0 || from >= choices.length || to >= choices.length || from === to) return;
        [choices[from], choices[to]] = [choices[to], choices[from]];
        for (const edge of this.outgoingRuntimeEdges(node.canvas, node)) {
            const index = edge.getData().empathyChoiceIndex;
            if (index === from) this.updateChoiceEdge(patch, edge, to);
            else if (index === to) this.updateChoiceEdge(patch, edge, from);
        }
        node.setData({ ...node.getData(), empathyChoices: choices });
        node.canvas.markDirty(node);
        node.canvas.requestSave();
    }

    private removeChoice(patch: CanvasPatch, node: RuntimeCanvasNode, removed: number): void {
        const choices = Array.isArray(node.getData().empathyChoices) ? [...node.getData().empathyChoices!] : [];
        if (removed < 0 || removed >= choices.length) return;
        choices.splice(removed, 1);
        for (const edge of this.outgoingRuntimeEdges(node.canvas, node)) {
            const index = edge.getData().empathyChoiceIndex;
            if (index === removed) this.updateChoiceEdge(patch, edge, undefined);
            else if (typeof index === "number" && index > removed) this.updateChoiceEdge(patch, edge, index - 1);
        }
        node.setData({ ...node.getData(), empathyChoices: choices });
        node.canvas.markDirty(node);
        node.canvas.requestSave();
    }

    private updateChoiceEdge(patch: CanvasPatch, edge: RuntimeCanvasEdge, index: number | undefined): void {
        const data = { ...edge.getData(), empathyChoiceIndex: index };
        if (index === undefined) delete data.empathyChoiceIndex;
        edge.setData(data);
        edge.render();
        this.syncEdgeBadge(patch, edge);
        patch.canvas.markDirty(edge);
    }

    private updateNode(node: RuntimeCanvasNode, updates: Partial<CanvasNodeData>): void {
        node.setData({ ...node.getData(), ...updates });
        node.canvas.markDirty(node);
        node.canvas.requestSave();
    }

    private outgoingRuntimeEdges(canvas: RuntimeCanvas, node: RuntimeCanvasNode): RuntimeCanvasEdge[] {
        const id = node.id ?? node.getData().id;
        return Array.from(canvas.edges.values()).filter((edge) => {
            const source = edge.from?.node;
            return source === node || (source?.id ?? source?.getData().id) === id;
        }) as RuntimeCanvasEdge[];
    }

    private addEdgeMenuItems(menu: Menu, edge: RuntimeCanvasEdge): void {
        const patch = this.patches.get(edge.canvas);
        if (!patch || patch.canvas.readonly) return;
        const sourceKind = getEmpathyCanvasNodeKind(edge.from?.node?.getData() ?? {});
        if (sourceKind === EmpathyCanvasNodeKind.CHOICE) {
            const linked = edge.getData().empathyChoiceIndex !== undefined;
            menu.addItem((item) => item.setTitle(linked ? "Change linked Empathy choice…" : "Link Empathy choice…").setSection("action").setIcon("list-ordered")
                .onClick(() => this.openEdgeEditor(patch, edge, "choice")));
            menu.addItem((item) => item.setTitle("Unlink Empathy choice").setSection("action").setIcon("unlink")
                .setDisabled(!linked).onClick(() => this.clearChoiceEdge(patch, edge)));
            return;
        }
        const data = edge.getData();
        menu.addItem((item) => item.setTitle(data.empathyCondition ? "Edit Empathy condition…" : "Make conditional…")
            .setSection("action").setIcon("git-branch").onClick(() => this.openEdgeEditor(patch, edge, "condition")));
        const anotherElse = this.otherElseEdge(patch, edge) !== undefined;
        menu.addItem((item) => item.setTitle(data.empathyElse ? "This is the Empathy else transition" : anotherElse ? "Another else transition already exists" : "Make Empathy else")
            .setSection("action").setIcon("corner-down-right").setDisabled(Boolean(data.empathyElse || anotherElse))
            .onClick(() => this.makeEdgeElse(patch, edge)));
        if (data.empathyCondition !== undefined || data.empathyElse) {
            menu.addItem((item) => item.setTitle("Remove Empathy transition metadata").setSection("action").setIcon("circle-off")
                .onClick(() => this.clearEdgeMetadata(patch, edge)));
        }
    }

    private otherElseEdge(patch: CanvasPatch, edge: RuntimeCanvasEdge): RuntimeCanvasEdge | undefined {
        const source = edge.from?.node as RuntimeCanvasNode | undefined;
        if (!source) return undefined;
        return this.outgoingRuntimeEdges(patch.canvas, source).find((candidate) => candidate !== edge && candidate.getData().empathyElse);
    }

    private openEdgeEditor(patch: CanvasPatch, edge: RuntimeCanvasEdge, mode: "choice" | "condition"): void {
        patch.edgeEditorEl?.remove();
        const document = (edge.edgeEl ?? edge.lineGroupEl ?? patch.canvas.cardMenuEl)?.ownerDocument ?? window.document;
        const view = document.defaultView ?? window;
        const editor = document.createElement("div");
        editor.className = "empathy-edge-editor";
        stopCanvasEvents(editor);
        const heading = document.createElement("strong");
        heading.textContent = mode === "choice" ? "Link choice" : "Transition condition";
        editor.append(heading);
        const order = document.createElement("input");
        order.type = "number"; order.min = "0"; order.step = "1";
        order.value = String(edge.getData().empathyConditionOrder ?? "");
        let choiceSelect: HTMLSelectElement | undefined;
        if (mode === "choice") {
            const choices = edge.from?.node?.getData().empathyChoices;
            choiceSelect = document.createElement("select");
            const placeholder = document.createElement("option");
            placeholder.value = "";
            placeholder.textContent = "Select a choice…";
            placeholder.selected = edge.getData().empathyChoiceIndex === undefined;
            choiceSelect.append(placeholder);
            if (Array.isArray(choices)) choices.forEach((choice, index) => {
                const option = document.createElement("option");
                option.value = String(index);
                option.textContent = `${index} · ${choice}`;
                option.selected = edge.getData().empathyChoiceIndex === index;
                choiceSelect!.append(option);
            });
            editor.append(choiceSelect);
        }
        let condition = edge.getData().empathyCondition ?? defaultCondition(this.ui.getVariables().find((item) => item.access !== NarrativeVariableAccess.WRITE));
        if (mode === "condition") {
            const conditionHost = document.createElement("div");
            const render = (): void => {
                conditionHost.replaceChildren(this.conditionControls(document, condition, (value) => { condition = value; render(); }));
            };
            render();
            editor.append(conditionHost);
        }
        if (mode === "condition") {
            const orderRow = document.createElement("label");
            orderRow.textContent = "Evaluation order ";
            orderRow.append(order);
            editor.append(orderRow);
        }
        const actions = document.createElement("div");
        actions.className = "empathy-edge-editor-actions";
        const save = document.createElement("button");
        save.type = "button"; save.textContent = "Save";
        const cancel = document.createElement("button");
        cancel.type = "button"; cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => this.closeEdgeEditor(patch));
        save.addEventListener("click", () => {
            if (mode === "choice" && choiceSelect?.value === "") { choiceSelect.classList.add("is-invalid"); return; }
            const value = Number(mode === "choice" ? choiceSelect?.value : order.value);
            if (!Number.isInteger(value) || value < 0) { (choiceSelect ?? order).classList.add("is-invalid"); return; }
            if (mode === "choice") {
                this.persistEdgeData(patch, edge, {
                    empathyChoiceIndex: value,
                    empathyCondition: undefined,
                    empathyElse: undefined,
                    empathyConditionOrder: undefined,
                });
            } else {
                this.persistEdgeData(patch, edge, {
                    empathyChoiceIndex: undefined,
                    empathyElse: undefined,
                    empathyCondition: condition,
                    empathyConditionOrder: value,
                });
            }
            this.closeEdgeEditor(patch);
        });
        actions.append(save, cancel);
        editor.append(actions);
        document.body.append(editor);
        editor.style.left = `${Math.max(12, view.innerWidth / 2 - 190)}px`;
        editor.style.top = `${Math.max(12, view.innerHeight / 2 - 100)}px`;
        patch.edgeEditorEl = editor;
    }

    private makeEdgeElse(patch: CanvasPatch, edge: RuntimeCanvasEdge): void {
        if (edge.getData().empathyElse) return;
        if (this.otherElseEdge(patch, edge)) {
            this.ui.showNotice("This node already has an Empathy else transition");
            return;
        }
        this.persistEdgeData(patch, edge, {
            empathyChoiceIndex: undefined,
            empathyElse: true,
            empathyCondition: undefined,
            empathyConditionOrder: undefined,
        });
    }

    private persistEdgeData(patch: CanvasPatch, edge: RuntimeCanvasEdge, updates: Partial<CanvasEdgeData>): void {
        const data = { ...edge.getData(), ...updates };
        for (const key of edgeSemanticKeys) {
            if (data[key] === undefined) delete data[key];
        }
        edge.setData(data);
        edge.render();
        this.syncEdgeBadge(patch, edge);
        patch.canvas.markDirty(edge);
        patch.canvas.requestSave();
        const source = edge.from?.node as RuntimeCanvasNode | undefined;
        if (source && patch.nodes.has(source)) this.decorateNode(patch, source);
        this.syncEdgeToolbar(patch);
    }

    private clearEdgeMetadata(patch: CanvasPatch, edge: RuntimeCanvasEdge): void {
        this.persistEdgeData(patch, edge, { empathyCondition: undefined, empathyElse: undefined, empathyConditionOrder: undefined });
    }

    private clearChoiceEdge(patch: CanvasPatch, edge: RuntimeCanvasEdge): void {
        this.persistEdgeData(patch, edge, { empathyChoiceIndex: undefined });
    }

    private closeEdgeEditor(patch: CanvasPatch): void {
        patch.edgeEditorEl?.remove();
        patch.edgeEditorEl = undefined;
    }

    private scheduleValidation(patch: CanvasPatch): void {
        if (patch.validationTimer !== undefined) clearTimeout(patch.validationTimer);
        patch.validationTimer = setTimeout(() => {
            patch.validationTimer = undefined;
            if (!this.disposed && this.patches.get(patch.canvas) === patch) {
                for (const node of patch.nodes.keys()) {
                    if (getEmpathyCanvasNodeKind(node.getData()) === EmpathyCanvasNodeKind.CHOICE) {
                        this.decorateNode(patch, node);
                    }
                }
                this.applyValidation(patch);
            }
        }, 150);
    }

    private applyValidation(patch: CanvasPatch): void {
        for (const node of patch.nodes.keys()) {
            if (node.nodeEl.dataset.empathyValidation) node.nodeEl.removeAttribute("title");
            node.nodeEl.classList.remove("empathy-canvas-invalid");
            delete node.nodeEl.dataset.empathyValidation;
        }
        const edges = Array.from(patch.canvas.edges.values() as IterableIterator<RuntimeCanvasEdge>);
        const liveEdges = new Set(edges);
        for (const [edge, badge] of patch.edgeBadges) {
            if (!liveEdges.has(edge)) {
                badge.host.remove();
                patch.edgeBadges.delete(edge);
            }
        }
        for (const edge of edges) {
            const element = edge.edgeEl ?? edge.lineGroupEl;
            if (element?.hasAttribute("data-empathy-summary") || element?.hasAttribute("data-empathy-validation")) {
                element.removeAttribute("title");
            }
            element?.removeAttribute("data-empathy-summary");
            element?.removeAttribute("data-empathy-validation");
            element?.classList.remove("empathy-canvas-edge-invalid", "empathy-canvas-edge-conditional", "empathy-canvas-edge-else");
            if (edge.getData().empathyCondition) element?.classList.add("empathy-canvas-edge-conditional");
            if (edge.getData().empathyElse) element?.classList.add("empathy-canvas-edge-else");
            const summary = this.syncEdgeBadge(patch, edge);
            if (element && summary) {
                element.setAttribute("title", summary);
                element.setAttribute("data-empathy-summary", summary);
            }
        }
        const issues = validateCanvas(patch.canvas, this.ui.getVariables());
        const nodeMessages = new Map<string, string[]>();
        const edgeMessages = new Map<string, string[]>();
        for (const issue of issues) {
            if (issue.nodeId) nodeMessages.set(issue.nodeId, [...nodeMessages.get(issue.nodeId) ?? [], issue.message]);
            if (issue.edgeId) edgeMessages.set(issue.edgeId, [...edgeMessages.get(issue.edgeId) ?? [], issue.message]);
        }
        for (const node of patch.nodes.keys()) {
            const id = node.id ?? node.getData().id;
            const messages = id ? nodeMessages.get(id) : undefined;
            if (messages) {
                node.nodeEl.classList.add("empathy-canvas-invalid");
                node.nodeEl.dataset.empathyValidation = messages.join("\n");
                node.nodeEl.title = messages.join("\n");
            }
        }
        for (const edge of edges) {
            const id = edge.id ?? edge.getData().id;
            const messages = id ? edgeMessages.get(id) : undefined;
            const element = edge.edgeEl ?? edge.lineGroupEl;
            if (messages && element) {
                element.classList.add("empathy-canvas-edge-invalid");
                element.setAttribute("title", messages.join("\n"));
                element.setAttribute("data-empathy-validation", messages.join("\n"));
            }
        }
    }

    private syncEdgeBadge(patch: CanvasPatch, edge: RuntimeCanvasEdge): string | undefined {
        const data = edge.getData();
        const sourceKind = getEmpathyCanvasNodeKind(edge.from?.node?.getData() ?? {});
        const kind = data.empathyElse
            ? "else"
            : data.empathyCondition
                ? "condition"
                : sourceKind === EmpathyCanvasNodeKind.CHOICE
                    ? "choice"
                    : undefined;
        const choices = edge.from?.node?.getData().empathyChoices;
        const summary = kind === "choice" ? formatChoiceBadge(data, Array.isArray(choices) ? choices : []) : formatTransitionBadge(data);
        const lineGroup = edge.lineGroupEl;
        const center = edge.getCenter();
        if (!kind || summary === undefined || lineGroup?.namespaceURI !== "http://www.w3.org/2000/svg") {
            patch.edgeBadges.get(edge)?.host.remove();
            patch.edgeBadges.delete(edge);
            return summary;
        }

        let badge = patch.edgeBadges.get(edge);
        if (!badge || badge.host.parentElement !== lineGroup) {
            badge?.host.remove();
            const host = lineGroup.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
            host.classList.add("empathy-canvas-edge-badge-host");
            const label = lineGroup.ownerDocument.createElement("div");
            label.className = "empathy-canvas-edge-badge";
            host.append(label);
            lineGroup.append(host);
            badge = { host, label };
            patch.edgeBadges.set(edge, badge);
        }

        badge.host.setAttribute("x", String(center.x - 160));
        badge.host.setAttribute("y", String(center.y - 42));
        badge.host.setAttribute("width", "320");
        badge.host.setAttribute("height", "34");
        badge.label.className = `empathy-canvas-edge-badge empathy-canvas-edge-badge-${kind}`;
        badge.label.textContent = summary;
        badge.label.title = summary;
        return summary;
    }

    private addNodeMenuItems(menu: Menu, node: RuntimeCanvasNode): void {
        if (this.disposed || node.canvas.readonly || node.getData().type !== "text") return;
        const current = getEmpathyCanvasNodeKind(node.getData());
        for (const kind of convertibleNodeKinds) {
            menu.addItem((item) => item.setTitle(`Set as Empathy ${nodeLabels[kind]}`).setSection("action")
                .setIcon(nodeIcons[kind]).setChecked(current === kind).onClick(() => this.setNodeKind(node, kind)));
        }
        if (
            current &&
            (
                current === EmpathyCanvasNodeKind.SAY ||
                current === EmpathyCanvasNodeKind.LINE ||
                current === EmpathyCanvasNodeKind.SET ||
                current === EmpathyCanvasNodeKind.PORTAL_TRANSMITTER
            ) &&
            this.outgoingRuntimeEdges(node.canvas, node).length === 0
        ) {
            for (const kind of [
                EmpathyCanvasNodeKind.SAY,
                EmpathyCanvasNodeKind.LINE,
                EmpathyCanvasNodeKind.CHOICE,
                EmpathyCanvasNodeKind.SET,
                EmpathyCanvasNodeKind.PORTAL_RECEIVER,
                EmpathyCanvasNodeKind.END,
            ]) {
                menu.addItem((item) => item.setTitle(`Continue with Empathy ${nodeLabels[kind]}`).setSection("create")
                    .setIcon(nodeIcons[kind]).onClick(() => this.createContinuation(node, kind)));
            }
        }
        if (current) menu.addItem((item) => item.setTitle("Remove Empathy node type").setSection("action")
            .setIcon("circle-off").onClick(() => this.removeNodeKind(node)));
    }

    private createContinuation(source: RuntimeCanvasNode, kind: EmpathyCanvasNodeKind): void {
        const canvas = source.canvas;
        if (canvas.readonly) return;
        const sourceData = source.getData();
        const x = typeof sourceData.x === "number" ? sourceData.x : canvas.posCenter().x;
        const y = typeof sourceData.y === "number" ? sourceData.y : canvas.posCenter().y;
        const height = typeof sourceData.height === "number" ? sourceData.height : 160;
        try {
            const target = this.createNode(canvas, kind, { x, y: y + height + 100 }, nodeSizes[kind]);
            this.connectNodes(source, target);
            if (kind === EmpathyCanvasNodeKind.SAY) this.focusCharacterField(target);
            else if (kind === EmpathyCanvasNodeKind.LINE) target.startEditing();
            else if (kind === EmpathyCanvasNodeKind.SET) this.focusVariablePicker(target);
            else if (kind === EmpathyCanvasNodeKind.PORTAL_RECEIVER) this.focusPortalReceiver(target);
        } catch (error) {
            this.ui.showNotice(`Empathy continuation creation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private connectNodes(source: RuntimeCanvasNode, target: RuntimeCanvasNode): void {
        const canvas = source.canvas;
        const sourceData = source.getData();
        const targetData = target.getData();
        const sourceId = source.id ?? sourceData.id;
        const targetId = target.id ?? targetData.id;
        if (!sourceId || !targetId) throw new Error("Canvas did not assign node ids");
        const random = source.nodeEl.ownerDocument.defaultView?.crypto.getRandomValues(new Uint32Array(2));
        let edgeId = random
            ? Array.from(random, (value) => value.toString(16).padStart(8, "0")).join("")
            : `${Date.now().toString(16)}${Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, "0")}`;
        while (canvas.edges.has(edgeId)) edgeId += "0";
        canvas.importData({
            nodes: [sourceData, targetData],
            edges: [{
                id: edgeId,
                fromNode: sourceId,
                fromSide: "bottom",
                toNode: targetId,
                toSide: "top",
            }],
        }, false);
        canvas.requestSave();
    }

    private setNodeKind(node: RuntimeCanvasNode, kind: EmpathyCanvasNodeKind): void {
        if (getEmpathyCanvasNodeKind(node.getData()) === kind) return;
        node.setData(convertedEmpathyNodeData(node.getData(), kind));
        node.canvas.markDirty(node);
        node.canvas.requestSave();
    }

    private removeNodeKind(node: RuntimeCanvasNode): void {
        const data = { ...node.getData() };
        delete data.empathyKind;
        for (const key of nodeSemanticKeys) delete data[key];
        node.setData(data);
        node.canvas.markDirty(node);
        node.canvas.requestSave();
    }

    private updatePortalName(patch: CanvasPatch, node: RuntimeCanvasNode, name: string): void {
        if (node.canvas.readonly) return;
        const data = node.getData();
        if (getEmpathyCanvasNodeKind(data) !== EmpathyCanvasNodeKind.PORTAL_TRANSMITTER) return;
        node.setData({ ...data, empathyPortalName: name });
        patch.canvas.markDirty(node);
        for (const [candidate, nodePatch] of patch.nodes) {
            if (getEmpathyCanvasNodeKind(candidate.getData()) !== EmpathyCanvasNodeKind.PORTAL_RECEIVER) continue;
            nodePatch.signature = undefined;
            this.decorateNode(patch, candidate);
        }
    }

    private updatePortalReceiver(patch: CanvasPatch, node: RuntimeCanvasNode, portalId: string): void {
        if (node.canvas.readonly) return;
        const data = node.getData();
        if (getEmpathyCanvasNodeKind(data) !== EmpathyCanvasNodeKind.PORTAL_RECEIVER) return;
        node.setData({ ...data, empathyPortalId: portalId });
        patch.canvas.markDirty(node);
        patch.canvas.requestSave();
    }

    private updateCharacter(patch: CanvasPatch, node: RuntimeCanvasNode, character: string): void {
        if (node.canvas.readonly || node.isEditing || node.nodeEl.classList.contains("is-editing")) return;
        const data = node.getData();
        if (getEmpathyCanvasNodeKind(data) !== EmpathyCanvasNodeKind.SAY) return;
        node.setData({ ...data, empathyCharacter: character });
        node.canvas.markDirty(node);
        const nodePatch = patch.nodes.get(node);
        if (!nodePatch) return;
        if (nodePatch.characterSaveTimer !== undefined) clearTimeout(nodePatch.characterSaveTimer);
        nodePatch.characterSaveTimer = setTimeout(() => {
            nodePatch.characterSaveTimer = undefined;
            if (!node.canvas.readonly) node.canvas.requestSave();
        }, 300);
    }

    private flushCharacterSave(patch: CanvasPatch, node: RuntimeCanvasNode): void {
        const nodePatch = patch.nodes.get(node);
        if (!nodePatch || nodePatch.characterSaveTimer === undefined) return;
        clearTimeout(nodePatch.characterSaveTimer);
        nodePatch.characterSaveTimer = undefined;
        if (!node.canvas.readonly) node.canvas.requestSave();
    }

    private cancelCharacterSave(patch: CanvasPatch, node: RuntimeCanvasNode): void {
        const nodePatch = patch.nodes.get(node);
        if (nodePatch?.characterSaveTimer !== undefined) clearTimeout(nodePatch.characterSaveTimer);
        if (nodePatch) nodePatch.characterSaveTimer = undefined;
    }

    private flushCanvasCharacterSaves(patch: CanvasPatch): void {
        let pending = false;
        for (const nodePatch of patch.nodes.values()) {
            if (nodePatch.characterSaveTimer === undefined) continue;
            clearTimeout(nodePatch.characterSaveTimer);
            nodePatch.characterSaveTimer = undefined;
            pending = true;
        }
        if (pending && !patch.canvas.readonly) patch.canvas.requestSave();
    }

    private clearDecoration(patch: CanvasPatch, node: RuntimeCanvasNode): void {
        node.nodeEl.classList.remove("empathy-canvas-node", "empathy-canvas-invalid");
        for (const kind of nodeKinds) node.nodeEl.classList.remove(`empathy-canvas-node-${kind}`);
        delete node.nodeEl.dataset.empathyMode;
        const nodePatch = patch.nodes.get(node);
        nodePatch?.headerEl?.remove();
        node.nodeEl.style.removeProperty("--empathy-node-header-height");
        if (nodePatch) { nodePatch.headerEl = undefined; nodePatch.signature = undefined; nodePatch.autoHeight = undefined; }
    }

    private unpatchNode(patch: CanvasPatch, node: RuntimeCanvasNode): void {
        const nodePatch = patch.nodes.get(node);
        if (!nodePatch) return;
        this.cancelCharacterSave(patch, node);
        for (const restore of [...nodePatch.restore].reverse()) restore();
        this.clearDecoration(patch, node);
        patch.nodes.delete(node);
    }

    private unpatchCanvas(canvas: RuntimeCanvas): void {
        const patch = this.patches.get(canvas);
        if (!patch) return;
        this.removeToolbar(patch);
        this.removeEdgeToolbar(patch);
        this.closeEdgeEditor(patch);
        for (const badge of patch.edgeBadges.values()) badge.host.remove();
        patch.edgeBadges.clear();
        if (patch.validationTimer !== undefined) clearTimeout(patch.validationTimer);
        if (patch.resizeSaveTimer !== undefined) clearTimeout(patch.resizeSaveTimer);
        this.flushCanvasCharacterSaves(patch);
        for (const node of Array.from(patch.nodes.keys())) this.unpatchNode(patch, node);
        for (const restore of [...patch.restore].reverse()) restore();
        this.patches.delete(canvas);
    }

    private removeToolbar(patch: CanvasPatch): void {
        patch.toolbarEl?.remove();
        patch.toolbarEl = undefined;
    }
    private removeEdgeToolbar(patch: CanvasPatch): void {
        for (const button of patch.edgeToolbarButtons ?? []) button.remove();
        patch.edgeToolbarButtons = undefined;
        patch.edgeToolbarSignature = undefined;
    }
    private tryCreateNode(canvas: RuntimeCanvas, kind: EmpathyCanvasNodeKind, pos?: CanvasPoint, size?: CanvasSize): void {
        try { this.createNode(canvas, kind, pos, size); }
        catch (error) { this.ui.showNotice(`Empathy node creation failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    private focusCharacterField(node: RuntimeCanvasNode): void { node.nodeEl.querySelector<HTMLInputElement>(".empathy-canvas-character-input")?.focus(); }
    private focusVariablePicker(node: RuntimeCanvasNode): void { node.nodeEl.querySelector<HTMLInputElement>(".empathy-variable-picker input")?.focus(); }
    private focusPortalReceiver(node: RuntimeCanvasNode): void { node.nodeEl.querySelector<HTMLSelectElement>(".empathy-canvas-portal-select")?.focus(); }
    private focusPortalName(node: RuntimeCanvasNode): void { node.nodeEl.querySelector<HTMLInputElement>(".empathy-canvas-portal-input")?.focus(); }
    private unload(): void {
        this.disposed = true;
        for (const canvas of Array.from(this.patches.keys())) this.unpatchCanvas(canvas);
        this.patches.clear();
    }
    private reportRuntimeIssue(error: unknown): void {
        if (this.runtimeIssueReported) return;
        this.runtimeIssueReported = true;
        console.error("Empathy Canvas runtime integration failed", error);
        this.ui.showNotice("Empathy Canvas runtime integration failed; see the developer console");
    }
}
