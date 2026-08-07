import type { EventRef, Menu, Plugin } from "obsidian";

import {
    Canvas,
    CanvasNode,
    CanvasNodeData,
    EmpathyCanvasNodeKind,
    getEmpathyCanvasNodeKind,
} from "./compile";

interface CanvasPoint {
    x: number;
    y: number;
}

interface CanvasSize {
    width: number;
    height: number;
}

interface CanvasUi {
    setIcon(parent: HTMLElement, icon: string): void;
    setTooltip(element: HTMLElement, tooltip: string): void;
    showNotice(message: string): void;
}

interface RuntimeCanvasNode extends CanvasNode {
    canvas: RuntimeCanvas;
    nodeEl: HTMLElement;
    isEditing?: boolean;
    setData(data: CanvasNodeData): void;
    setIsEditing?(editing: boolean, ...args: unknown[]): void;
    attach(): void;
    render(): void;
    startEditing?(): void;
}

interface RuntimeCanvas extends Canvas {
    readonly?: boolean;
    wrapperEl?: HTMLElement;
    cardMenuEl?: HTMLElement;
    addNode(node: RuntimeCanvasNode): void;
    removeNode(node: RuntimeCanvasNode): void;
    createTextNode(options: {
        pos: CanvasPoint;
        size?: CanvasSize;
        position?: "center";
        text?: string;
        save?: boolean;
        focus?: boolean;
    }): RuntimeCanvasNode;
    posCenter(): CanvasPoint;
    selectOnly(node: RuntimeCanvasNode): void;
    markDirty(node: RuntimeCanvasNode): void;
    requestSave(pushHistory?: boolean): void;
    setReadonly?(readonly: boolean): void;
    showCreationMenu?(menu: Menu, pos: CanvasPoint, size?: CanvasSize): void;
}

interface NodePatch {
    hadOwnSetData: boolean;
    hadOwnRender: boolean;
    hadOwnSetIsEditing: boolean;
    originalSetData: RuntimeCanvasNode["setData"];
    originalRender: RuntimeCanvasNode["render"];
    originalSetIsEditing?: NonNullable<RuntimeCanvasNode["setIsEditing"]>;
    wrappedSetData: RuntimeCanvasNode["setData"];
    wrappedRender: RuntimeCanvasNode["render"];
    wrappedSetIsEditing?: NonNullable<RuntimeCanvasNode["setIsEditing"]>;
    headerEl?: HTMLElement;
    characterSaveTimer?: ReturnType<typeof setTimeout>;
}

interface CanvasPatch {
    canvas: RuntimeCanvas;
    nodes: Map<RuntimeCanvasNode, NodePatch>;
    toolbarEl?: HTMLElement;
    hadOwnAddNode: boolean;
    hadOwnRemoveNode: boolean;
    hadOwnShowCreationMenu: boolean;
    hadOwnSetReadonly: boolean;
    originalAddNode: RuntimeCanvas["addNode"];
    originalRemoveNode: RuntimeCanvas["removeNode"];
    originalShowCreationMenu?: NonNullable<RuntimeCanvas["showCreationMenu"]>;
    originalSetReadonly?: NonNullable<RuntimeCanvas["setReadonly"]>;
    wrappedAddNode: RuntimeCanvas["addNode"];
    wrappedRemoveNode: RuntimeCanvas["removeNode"];
    wrappedShowCreationMenu?: NonNullable<RuntimeCanvas["showCreationMenu"]>;
    wrappedSetReadonly?: NonNullable<RuntimeCanvas["setReadonly"]>;
}

const requiredCanvasMethods = [
    "addNode",
    "removeNode",
    "createTextNode",
    "posCenter",
    "selectOnly",
    "markDirty",
    "requestSave",
] as const;

function canvasCompatibilityError(canvas: RuntimeCanvas): Error | undefined {
    const runtime = canvas as unknown as Record<string, unknown>;
    const missing: string[] = requiredCanvasMethods.filter((method) =>
        typeof runtime[method] !== "function");
    const nodes = runtime.nodes as { values?: unknown } | undefined;
    if (!nodes || typeof nodes.values !== "function") missing.push("nodes.values");
    if (missing.length === 0) return undefined;
    return new Error(`unsupported Obsidian Canvas runtime; missing ${missing.join(", ")}`);
}

const nodeLabels: Record<EmpathyCanvasNodeKind, string> = {
    [EmpathyCanvasNodeKind.ENTRY]: "ENTRY",
    [EmpathyCanvasNodeKind.SAY]: "SAY",
    [EmpathyCanvasNodeKind.LINE]: "LINE",
    [EmpathyCanvasNodeKind.CHOICE]: "CHOICE",
    [EmpathyCanvasNodeKind.END]: "END",
};

const nodeIcons: Record<EmpathyCanvasNodeKind, string> = {
    [EmpathyCanvasNodeKind.ENTRY]: "log-in",
    [EmpathyCanvasNodeKind.SAY]: "message-square-quote",
    [EmpathyCanvasNodeKind.LINE]: "text",
    [EmpathyCanvasNodeKind.CHOICE]: "list-tree",
    [EmpathyCanvasNodeKind.END]: "square",
};

const nodeSizes: Record<EmpathyCanvasNodeKind, CanvasSize> = {
    [EmpathyCanvasNodeKind.ENTRY]: { width: 220, height: 100 },
    [EmpathyCanvasNodeKind.SAY]: { width: 360, height: 200 },
    [EmpathyCanvasNodeKind.LINE]: { width: 360, height: 160 },
    [EmpathyCanvasNodeKind.CHOICE]: { width: 240, height: 100 },
    [EmpathyCanvasNodeKind.END]: { width: 220, height: 100 },
};

const nodeSymbols: Record<EmpathyCanvasNodeKind, string> = {
    [EmpathyCanvasNodeKind.ENTRY]: "↦",
    [EmpathyCanvasNodeKind.SAY]: "“",
    [EmpathyCanvasNodeKind.LINE]: "¶",
    [EmpathyCanvasNodeKind.CHOICE]: "◇",
    [EmpathyCanvasNodeKind.END]: "■",
};

const nodeHints: Record<Exclude<EmpathyCanvasNodeKind, "say">, string> = {
    [EmpathyCanvasNodeKind.ENTRY]: "START",
    [EmpathyCanvasNodeKind.LINE]: "NARRATION",
    [EmpathyCanvasNodeKind.CHOICE]: "BRANCH",
    [EmpathyCanvasNodeKind.END]: "STOP",
};

function initialText(kind: EmpathyCanvasNodeKind): string {
    if (kind === EmpathyCanvasNodeKind.SAY) return "Dialogue";
    if (kind === EmpathyCanvasNodeKind.LINE) return "Line";
    return "";
}

function combinedSayText(character: string, dialogue: string): string {
    return `${character}\n${dialogue}`;
}

export function convertedEmpathyNodeData(
    data: CanvasNodeData,
    kind: EmpathyCanvasNodeKind,
): CanvasNodeData {
    const currentText = typeof data.text === "string" ? data.text : "";
    const text = currentText.trim().length === 0 ? initialText(kind) : currentText;
    const converted: CanvasNodeData = {
        ...data,
        type: "text",
        text,
        empathyKind: kind,
    };
    delete converted.empathyCharacter;
    if (kind === EmpathyCanvasNodeKind.SAY) converted.empathyCharacter = "Character";
    return converted;
}

function hasOwn(object: object, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function hasClass(value: unknown, className: string): value is HTMLElement {
    if (!value || typeof value !== "object") return false;
    const classList = (value as { classList?: { contains?: unknown } }).classList;
    return typeof classList?.contains === "function" && classList.contains(className);
}

function restorePatchedProperty<T extends object, K extends keyof T>(
    target: T,
    key: K,
    wrapped: T[K],
    original: T[K],
    originallyOwned: boolean,
): void {
    if (target[key] !== wrapped) return;
    if (originallyOwned) target[key] = original;
    else delete (target as Partial<T>)[key];
}

export class EmpathyCanvasIntegration {
    private readonly patches = new Map<RuntimeCanvas, CanvasPatch>();
    private disposed = false;
    private compatibilityIssueReported = false;

    constructor(
        private readonly plugin: Plugin,
        private readonly ui: CanvasUi,
    ) {}

    register(): void {
        this.disposed = false;
        const refresh = (): void => {
            if (!this.disposed) this.patchOpenCanvases();
        };
        const workspace = this.plugin.app.workspace;
        this.plugin.registerEvent(workspace.on("layout-change", refresh));
        this.plugin.registerEvent(workspace.on("active-leaf-change", refresh));
        this.plugin.registerEvent(workspace.on("window-open", refresh));
        this.plugin.registerEvent(workspace.on("window-close", refresh));
        workspace.onLayoutReady(refresh);

        const canvasEvents = workspace as unknown as {
            on(name: "canvas:node-menu", callback: (menu: Menu, node: RuntimeCanvasNode) => void): EventRef;
        };
        this.plugin.registerEvent(canvasEvents.on(
            "canvas:node-menu",
            (menu, node) => this.addNodeMenuItems(menu, node),
        ));
        this.plugin.register(() => this.unload());
        refresh();
    }

    patchCanvas(canvas: Canvas): RuntimeCanvas {
        if (this.disposed) throw new Error("Empathy plugin is unloaded");
        const runtime = canvas as RuntimeCanvas;
        const compatibilityError = canvasCompatibilityError(runtime);
        if (compatibilityError) {
            this.reportCompatibilityIssue(compatibilityError);
            throw compatibilityError;
        }
        const existingPatch = this.patches.get(runtime);
        if (existingPatch) {
            this.runCleanup("sync the Canvas toolbar", () => this.syncToolbar(existingPatch));
            return runtime;
        }

        const originalAddNode = runtime.addNode;
        const originalRemoveNode = runtime.removeNode;
        const originalShowCreationMenu = runtime.showCreationMenu;
        const originalSetReadonly = runtime.setReadonly;
        const patch = {} as CanvasPatch;

        const wrappedAddNode: RuntimeCanvas["addNode"] = (node) => {
            originalAddNode.call(runtime, node);
            if (!this.disposed) this.patchNode(patch, node);
        };
        const wrappedRemoveNode: RuntimeCanvas["removeNode"] = (node) => {
            if (!this.disposed) this.unpatchNode(patch, node);
            originalRemoveNode.call(runtime, node);
        };
        const wrappedShowCreationMenu = originalShowCreationMenu
            ? (menu: Menu, pos: CanvasPoint, size?: CanvasSize): void => {
                originalShowCreationMenu.call(runtime, menu, pos, size);
                if (!this.disposed && !runtime.readonly) {
                    for (const kind of Object.values(EmpathyCanvasNodeKind)) {
                        menu.addItem((item) => item
                            .setTitle(`Add Empathy ${nodeLabels[kind]}`)
                            .setSection("create")
                            .setIcon(nodeIcons[kind])
                            .onClick(() => {
                                if (!this.disposed && this.patches.get(runtime) === patch) {
                                    this.tryCreateNode(runtime, kind, pos, size);
                                }
                            }));
                    }
                }
            }
            : undefined;
        const wrappedSetReadonly = originalSetReadonly
            ? (readonly: boolean): void => {
                if (!this.disposed && readonly) {
                    this.runCleanup(
                        "save pending Canvas character changes",
                        () => this.flushCanvasCharacterSaves(patch),
                    );
                }
                originalSetReadonly.call(runtime, readonly);
                if (!this.disposed) {
                    this.runCleanup("sync the Canvas toolbar", () => this.syncToolbar(patch));
                    for (const node of patch.nodes.keys()) this.decorateNode(patch, node);
                }
            }
            : undefined;

        Object.assign(patch, {
            canvas: runtime,
            nodes: new Map(),
            hadOwnAddNode: hasOwn(runtime, "addNode"),
            hadOwnRemoveNode: hasOwn(runtime, "removeNode"),
            hadOwnShowCreationMenu: hasOwn(runtime, "showCreationMenu"),
            hadOwnSetReadonly: hasOwn(runtime, "setReadonly"),
            originalAddNode,
            originalRemoveNode,
            originalShowCreationMenu,
            originalSetReadonly,
            wrappedAddNode,
            wrappedRemoveNode,
            wrappedShowCreationMenu,
            wrappedSetReadonly,
        });
        this.patches.set(runtime, patch);
        runtime.addNode = wrappedAddNode;
        runtime.removeNode = wrappedRemoveNode;
        if (wrappedShowCreationMenu) runtime.showCreationMenu = wrappedShowCreationMenu;
        if (wrappedSetReadonly) runtime.setReadonly = wrappedSetReadonly;

        for (const node of runtime.nodes.values()) {
            this.patchNode(patch, node as RuntimeCanvasNode);
        }
        this.runCleanup("install the Canvas toolbar", () => this.syncToolbar(patch));
        return runtime;
    }

    createNode(
        canvas: Canvas,
        kind: EmpathyCanvasNodeKind,
        pos?: CanvasPoint,
        requestedSize?: CanvasSize,
    ): RuntimeCanvasNode {
        if (this.disposed) throw new Error("Empathy plugin is unloaded");
        const runtime = this.patchCanvas(canvas);
        if (runtime.readonly) {
            throw new Error("active Canvas is read-only");
        }

        const centered = pos === undefined;
        const text = initialText(kind);
        const node = runtime.createTextNode({
            pos: pos ?? runtime.posCenter(),
            size: requestedSize ?? nodeSizes[kind],
            position: centered ? "center" : undefined,
            text,
            save: false,
            focus: false,
        });
        node.setData({
            ...node.getData(),
            type: "text",
            text,
            empathyKind: kind,
            ...(kind === EmpathyCanvasNodeKind.SAY ? { empathyCharacter: "Character" } : {}),
        });
        node.attach();
        node.render();
        runtime.selectOnly(node);
        runtime.markDirty(node);
        runtime.requestSave();

        if (kind === EmpathyCanvasNodeKind.SAY) {
            this.focusCharacterField(node);
        } else if (kind === EmpathyCanvasNodeKind.LINE) {
            node.startEditing?.();
        }
        return node;
    }

    private syncToolbar(patch: CanvasPatch): void {
        if (this.disposed || patch.canvas.readonly) {
            this.removeToolbar(patch);
            return;
        }

        const host = this.cardMenu(patch.canvas);
        if (!host) {
            this.removeToolbar(patch);
            return;
        }

        const ownedToolbars = Array.from(host.children)
            .filter((child) => child.classList.contains("empathy-canvas-toolbar"));
        const expectedButtons = Object.values(EmpathyCanvasNodeKind).length;
        if (
            patch.toolbarEl?.parentElement === host &&
            ownedToolbars.length === 1 &&
            ownedToolbars[0] === patch.toolbarEl &&
            patch.toolbarEl.querySelectorAll(":scope > .empathy-canvas-toolbar-button").length === expectedButtons
        ) {
            return;
        }

        this.removeToolbar(patch);
        for (const toolbar of ownedToolbars) toolbar.remove();

        const toolbar = host.ownerDocument.createElement("div");
        toolbar.className = "empathy-canvas-toolbar";
        toolbar.setAttribute("role", "group");
        toolbar.setAttribute("aria-label", "Add Empathy node");

        for (const kind of Object.values(EmpathyCanvasNodeKind)) {
            const title = `Add Empathy ${nodeLabels[kind]}`;
            const button = host.ownerDocument.createElement("div");
            button.className = "canvas-card-menu-button empathy-canvas-toolbar-button";
            button.dataset.empathyKind = kind;
            button.setAttribute("role", "button");
            button.setAttribute("aria-label", title);
            button.tabIndex = 0;
            this.ui.setIcon(button, nodeIcons[kind]);
            this.ui.setTooltip(button, title);

            const activate = (): void => this.createNodeFromToolbar(patch, kind);
            button.addEventListener("click", activate);
            button.addEventListener("keydown", (event) => {
                if (event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
                event.preventDefault();
                event.stopPropagation();
                activate();
            });
            toolbar.append(button);
        }

        host.append(toolbar);
        patch.toolbarEl = toolbar;
    }

    private cardMenu(canvas: RuntimeCanvas): HTMLElement | undefined {
        const { cardMenuEl, wrapperEl } = canvas;
        if (
            hasClass(cardMenuEl, "canvas-card-menu") &&
            (!wrapperEl || cardMenuEl.parentElement === wrapperEl)
        ) {
            return cardMenuEl;
        }
        if (!wrapperEl || typeof wrapperEl.querySelector !== "function") return undefined;
        const fallback = wrapperEl.querySelector(":scope > .canvas-card-menu");
        return hasClass(fallback, "canvas-card-menu") ? fallback : undefined;
    }

    private createNodeFromToolbar(patch: CanvasPatch, kind: EmpathyCanvasNodeKind): void {
        if (this.disposed || this.patches.get(patch.canvas) !== patch || patch.canvas.readonly) return;
        this.tryCreateNode(patch.canvas, kind);
    }

    private tryCreateNode(
        canvas: RuntimeCanvas,
        kind: EmpathyCanvasNodeKind,
        pos?: CanvasPoint,
        size?: CanvasSize,
    ): void {
        if (this.disposed) return;
        try {
            this.createNode(canvas, kind, pos, size);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Empathy Canvas node creation failed", error);
            this.ui.showNotice(`Empathy node creation failed: ${message}`);
        }
    }

    private removeToolbar(patch: CanvasPatch): void {
        try {
            patch.toolbarEl?.remove();
        } finally {
            delete patch.toolbarEl;
        }
    }

    private patchOpenCanvases(): void {
        const liveCanvases = new Set<RuntimeCanvas>();
        for (const leaf of this.plugin.app.workspace.getLeavesOfType("canvas")) {
            const view = leaf.view as unknown as { canvas?: Canvas };
            if (!view.canvas) continue;
            try {
                liveCanvases.add(this.patchCanvas(view.canvas));
            } catch (error) {
                this.reportCompatibilityIssue(error);
            }
        }
        for (const canvas of Array.from(this.patches.keys())) {
            if (!liveCanvases.has(canvas)) this.unpatchCanvas(canvas);
        }
    }

    private patchNode(patch: CanvasPatch, node: RuntimeCanvasNode): void {
        if (!node || typeof node.setData !== "function" || typeof node.render !== "function" || !node.nodeEl) {
            return;
        }
        if (patch.nodes.has(node)) {
            this.decorateNode(patch, node);
            return;
        }

        const originalSetData = node.setData;
        const originalRender = node.render;
        const originalSetIsEditing = node.setIsEditing;
        const wrappedSetData: RuntimeCanvasNode["setData"] = (data) => {
            originalSetData.call(node, data);
            if (!this.disposed) this.decorateNode(patch, node);
        };
        const wrappedRender: RuntimeCanvasNode["render"] = () => {
            originalRender.call(node);
            if (!this.disposed) this.decorateNode(patch, node);
        };
        const wrappedSetIsEditing = originalSetIsEditing
            ? (editing: boolean, ...args: unknown[]): void => {
                originalSetIsEditing.call(node, editing, ...args);
                if (!this.disposed) this.decorateNode(patch, node);
            }
            : undefined;
        patch.nodes.set(node, {
            hadOwnSetData: hasOwn(node, "setData"),
            hadOwnRender: hasOwn(node, "render"),
            hadOwnSetIsEditing: hasOwn(node, "setIsEditing"),
            originalSetData,
            originalRender,
            originalSetIsEditing,
            wrappedSetData,
            wrappedRender,
            wrappedSetIsEditing,
        });
        node.setData = wrappedSetData;
        node.render = wrappedRender;
        if (wrappedSetIsEditing) node.setIsEditing = wrappedSetIsEditing;
        this.decorateNode(patch, node);
    }

    private unpatchNode(patch: CanvasPatch, node: RuntimeCanvasNode): void {
        const nodePatch = patch.nodes.get(node);
        if (!nodePatch) return;
        try {
            this.runCleanup("cancel a pending character save", () => this.cancelCharacterSave(patch, node));
            this.runCleanup("restore Canvas node setData", () => restorePatchedProperty(
                node,
                "setData",
                nodePatch.wrappedSetData,
                nodePatch.originalSetData,
                nodePatch.hadOwnSetData,
            ));
            this.runCleanup("restore Canvas node render", () => restorePatchedProperty(
                node,
                "render",
                nodePatch.wrappedRender,
                nodePatch.originalRender,
                nodePatch.hadOwnRender,
            ));
            if (nodePatch.wrappedSetIsEditing && nodePatch.originalSetIsEditing) {
                this.runCleanup("restore Canvas node setIsEditing", () => restorePatchedProperty(
                    node,
                    "setIsEditing",
                    nodePatch.wrappedSetIsEditing!,
                    nodePatch.originalSetIsEditing!,
                    nodePatch.hadOwnSetIsEditing,
                ));
            }
            this.runCleanup("remove Canvas node decoration", () => this.clearDecoration(patch, node));
        } finally {
            patch.nodes.delete(node);
        }
    }

    private decorateNode(patch: CanvasPatch, node: RuntimeCanvasNode): void {
        const data = node.getData();
        const kind = getEmpathyCanvasNodeKind(data);
        if (kind !== EmpathyCanvasNodeKind.SAY) this.cancelCharacterSave(patch, node);
        if (!kind) {
            this.clearDecoration(patch, node);
            return;
        }
        for (const knownKind of Object.values(EmpathyCanvasNodeKind)) {
            node.nodeEl.classList.remove(`empathy-canvas-node-${knownKind}`);
        }
        node.nodeEl.classList.add("empathy-canvas-node", `empathy-canvas-node-${kind}`);
        node.nodeEl.dataset.empathyKind = kind;
        node.nodeEl.dataset.empathyMode = node.isEditing || node.nodeEl.classList.contains("is-editing")
            ? "edit"
            : "preview";
        this.ensureHeader(patch, node, kind, data);
    }

    private clearDecoration(patch: CanvasPatch, node: RuntimeCanvasNode): void {
        node.nodeEl.classList.remove("empathy-canvas-node");
        for (const kind of Object.values(EmpathyCanvasNodeKind)) {
            node.nodeEl.classList.remove(`empathy-canvas-node-${kind}`);
        }
        delete node.nodeEl.dataset.empathyKind;
        delete node.nodeEl.dataset.empathyMode;
        const nodePatch = patch.nodes.get(node);
        nodePatch?.headerEl?.remove();
        if (nodePatch) nodePatch.headerEl = undefined;
        for (const child of Array.from(node.nodeEl.children)) {
            if (child.classList.contains("empathy-canvas-node-header")) child.remove();
        }
    }

    private ensureHeader(
        patch: CanvasPatch,
        node: RuntimeCanvasNode,
        kind: EmpathyCanvasNodeKind,
        data: CanvasNodeData,
    ): void {
        const nodePatch = patch.nodes.get(node);
        if (!nodePatch) return;

        let header = nodePatch.headerEl;
        if (!header || header.parentElement !== node.nodeEl || header.dataset.empathyKind !== kind) {
            header?.remove();
            const existing = Array.from(node.nodeEl.children).find((child) =>
                child.classList.contains("empathy-canvas-node-header"));
            existing?.remove();

            const document = node.nodeEl.ownerDocument;
            header = document.createElement("div");
            header.className = "empathy-canvas-node-header";
            header.dataset.empathyKind = kind;

            const symbol = document.createElement("span");
            symbol.className = "empathy-canvas-node-symbol";
            symbol.textContent = nodeSymbols[kind];
            symbol.setAttribute("aria-hidden", "true");
            header.appendChild(symbol);

            const label = document.createElement("span");
            label.className = "empathy-canvas-node-type";
            label.textContent = nodeLabels[kind];
            header.appendChild(label);

            if (kind === EmpathyCanvasNodeKind.SAY) {
                const character = document.createElement("label");
                character.className = "empathy-canvas-character-field";

                const caption = document.createElement("span");
                caption.className = "empathy-canvas-character-label";
                caption.textContent = "CHARACTER";
                character.appendChild(caption);

                const input = document.createElement("input");
                input.className = "empathy-canvas-character-input";
                input.type = "text";
                input.placeholder = "Character";
                input.autocomplete = "off";
                input.spellcheck = false;
                input.setAttribute("aria-label", "Character");
                input.addEventListener("input", () => this.updateCharacter(patch, node, input.value));
                input.addEventListener("change", () => this.flushCharacterSave(patch, node));
                input.addEventListener("blur", () => this.flushCharacterSave(patch, node));
                input.addEventListener("pointerdown", (event) => {
                    node.canvas.selectOnly(node);
                    event.stopPropagation();
                });
                for (const eventName of ["mousedown", "click", "dblclick", "contextmenu"] as const) {
                    input.addEventListener(eventName, (event) => event.stopPropagation());
                }
                input.addEventListener("keydown", (event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                        event.preventDefault();
                        node.startEditing?.();
                    } else if (event.key === "Escape") {
                        input.blur();
                    }
                });
                character.appendChild(input);
                header.appendChild(character);
            } else {
                const hint = document.createElement("span");
                hint.className = "empathy-canvas-node-hint";
                hint.textContent = nodeHints[kind];
                header.appendChild(hint);
            }

            node.nodeEl.appendChild(header);
            nodePatch.headerEl = header;
        }

        if (kind === EmpathyCanvasNodeKind.SAY) {
            const input = header.querySelector<HTMLInputElement>(".empathy-canvas-character-input");
            const character = typeof data.empathyCharacter === "string"
                ? data.empathyCharacter
                : "";
            if (input && node.nodeEl.ownerDocument.activeElement !== input) input.value = character;
            if (input) {
                input.disabled = Boolean(
                    node.canvas.readonly || node.isEditing || node.nodeEl.classList.contains("is-editing"),
                );
                input.title = input.disabled && !node.canvas.readonly
                    ? "Finish editing the dialogue before changing the character"
                    : "";
            }
            header.setAttribute("aria-label", `SAY node, character ${character || "not set"}`);
        } else {
            header.setAttribute("aria-label", `${nodeLabels[kind]} node, ${nodeHints[kind].toLowerCase()}`);
        }
    }

    private updateCharacter(patch: CanvasPatch, node: RuntimeCanvasNode, character: string): void {
        if (
            this.disposed ||
            node.canvas.readonly ||
            node.isEditing ||
            node.nodeEl.classList.contains("is-editing")
        ) {
            return;
        }
        const data = node.getData();
        if (getEmpathyCanvasNodeKind(data) !== EmpathyCanvasNodeKind.SAY) return;
        node.setData({
            ...data,
            empathyCharacter: character,
        });
        node.canvas.markDirty(node);
        this.scheduleCharacterSave(patch, node);
    }

    private scheduleCharacterSave(patch: CanvasPatch, node: RuntimeCanvasNode): void {
        const nodePatch = patch.nodes.get(node);
        if (!nodePatch) return;
        if (nodePatch.characterSaveTimer !== undefined) clearTimeout(nodePatch.characterSaveTimer);
        nodePatch.characterSaveTimer = setTimeout(() => {
            nodePatch.characterSaveTimer = undefined;
            if (!this.disposed && patch.nodes.get(node) === nodePatch && !node.canvas.readonly) {
                node.canvas.requestSave();
            }
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
        if (!nodePatch || nodePatch.characterSaveTimer === undefined) return;
        clearTimeout(nodePatch.characterSaveTimer);
        nodePatch.characterSaveTimer = undefined;
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

    private focusCharacterField(node: RuntimeCanvasNode): void {
        const input = node.nodeEl.querySelector<HTMLInputElement>(".empathy-canvas-character-input");
        input?.focus();
        input?.select();
    }

    private addNodeMenuItems(menu: Menu, node: RuntimeCanvasNode): void {
        if (this.disposed) return;
        const data = node?.getData?.();
        if (!data || data.type !== "text" || !node.canvas || node.canvas.readonly) return;
        const current = getEmpathyCanvasNodeKind(data);
        for (const kind of Object.values(EmpathyCanvasNodeKind)) {
            menu.addItem((item) => item
                .setTitle(`Set as Empathy ${nodeLabels[kind]}`)
                .setSection("action")
                .setIcon(nodeIcons[kind])
                .setChecked(current === kind)
                .onClick(() => this.setNodeKind(node, kind)));
        }
        if (current) {
            menu.addItem((item) => item
                .setTitle("Remove Empathy node type")
                .setSection("action")
                .setIcon("circle-off")
                .onClick(() => this.removeNodeKind(node)));
        }
    }

    private setNodeKind(node: RuntimeCanvasNode, kind: EmpathyCanvasNodeKind): void {
        if (this.disposed) return;
        const data = node.getData();
        const current = getEmpathyCanvasNodeKind(data);
        if (current === kind) return;

        node.setData(convertedEmpathyNodeData(data, kind));
        node.canvas.markDirty(node);
        node.canvas.requestSave();
    }

    private removeNodeKind(node: RuntimeCanvasNode): void {
        if (this.disposed) return;
        const data = { ...node.getData() };
        if (
            getEmpathyCanvasNodeKind(data) === EmpathyCanvasNodeKind.SAY &&
            typeof data.empathyCharacter === "string"
        ) {
            data.text = combinedSayText(
                data.empathyCharacter,
                typeof data.text === "string" ? data.text : "",
            );
        }
        delete data.empathyKind;
        delete data.empathyCharacter;
        node.setData(data);
        node.canvas.markDirty(node);
        node.canvas.requestSave();
    }

    private unpatchCanvas(canvas: RuntimeCanvas): void {
        const patch = this.patches.get(canvas);
        if (!patch) return;
        try {
            this.runCleanup("remove the Canvas toolbar", () => this.removeToolbar(patch));
            this.runCleanup("save pending Canvas character changes", () => this.flushCanvasCharacterSaves(patch));
            for (const node of Array.from(patch.nodes.keys())) {
                this.runCleanup("unpatch a Canvas node", () => this.unpatchNode(patch, node));
            }
            this.runCleanup("restore Canvas addNode", () => restorePatchedProperty(
                canvas,
                "addNode",
                patch.wrappedAddNode,
                patch.originalAddNode,
                patch.hadOwnAddNode,
            ));
            this.runCleanup("restore Canvas removeNode", () => restorePatchedProperty(
                canvas,
                "removeNode",
                patch.wrappedRemoveNode,
                patch.originalRemoveNode,
                patch.hadOwnRemoveNode,
            ));
            if (patch.wrappedShowCreationMenu && patch.originalShowCreationMenu) {
                this.runCleanup("restore Canvas showCreationMenu", () => restorePatchedProperty(
                    canvas,
                    "showCreationMenu",
                    patch.wrappedShowCreationMenu!,
                    patch.originalShowCreationMenu!,
                    patch.hadOwnShowCreationMenu,
                ));
            }
            if (patch.wrappedSetReadonly && patch.originalSetReadonly) {
                this.runCleanup("restore Canvas setReadonly", () => restorePatchedProperty(
                    canvas,
                    "setReadonly",
                    patch.wrappedSetReadonly!,
                    patch.originalSetReadonly!,
                    patch.hadOwnSetReadonly,
                ));
            }
        } finally {
            this.patches.delete(canvas);
        }
    }

    private unload(): void {
        this.disposed = true;
        try {
            for (const canvas of Array.from(this.patches.keys())) {
                this.runCleanup("unpatch a Canvas", () => this.unpatchCanvas(canvas));
            }
        } finally {
            this.patches.clear();
        }
    }

    private reportCompatibilityIssue(error: unknown): void {
        if (this.compatibilityIssueReported) return;
        this.compatibilityIssueReported = true;
        console.error("Empathy Canvas integration is unavailable in this Obsidian version", error);
    }

    private runCleanup(action: string, cleanup: () => void): void {
        try {
            cleanup();
        } catch (error) {
            console.error(`Empathy Canvas failed to ${action}`, error);
        }
    }
}
