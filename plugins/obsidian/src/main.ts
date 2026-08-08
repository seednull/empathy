import { ItemView, Notice, Plugin, setIcon, setTooltip, TFile } from "obsidian";

import {
    Canvas,
    compileCanvas,
    EmpathyCanvasNodeKind,
    generateHeader,
    NarrativeVariable,
    NarrativeVariableAccess,
    NarrativeVariableType,
    parseVariableName,
} from "./compile";
import {
    allocateAuthoredAtom,
    AtomAllocatorState,
    AuthoredAtom,
    AuthoredAtomType,
    initialAtomAllocatorState,
    isValidAtomValue,
} from "./atoms";
import { EmpathyCanvasIntegration } from "./canvas";
import {
    EMPATHY_PANEL_VIEW,
    EmpathyPanelView,
} from "./variables";

interface InternalCanvasView extends ItemView {
    canvas: Canvas;
    file: TFile | null;
}

interface EmpathyPluginData {
    variables: NarrativeVariable[];
    nextAtomValue: AtomAllocatorState;
}

export default class EmpathyPlugin extends Plugin {
    private canvasIntegration!: EmpathyCanvasIntegration;
    private compiling = false;
    private variables: NarrativeVariable[] = [];
    private nextAtomValue: AtomAllocatorState = { ...initialAtomAllocatorState };
    private lastCanvasView?: InternalCanvasView;
    private dataSave: Promise<void> = Promise.resolve();

    async onload(): Promise<void> {
        const stored = await this.loadData() as unknown;
        if (stored !== null && stored !== undefined) {
            if (typeof stored !== "object" || Array.isArray(stored)) {
                throw new Error("Empathy plugin data does not match the current schema");
            }
            const candidate = stored as Partial<EmpathyPluginData>;
            const names = new Set<string>();
            const variablesAreCurrent = Array.isArray(candidate.variables) && candidate.variables.every((variable) => {
                const keys = variable !== null && typeof variable === "object" ? Object.keys(variable) : [];
                if (variable === null || typeof variable !== "object" ||
                    keys.length !== 3 || !keys.includes("name") || !keys.includes("type") || !keys.includes("access") ||
                    typeof variable.name !== "string" || parseVariableName(variable.name) === undefined ||
                    !Object.values(NarrativeVariableType).includes(variable.type) ||
                    !Object.values(NarrativeVariableAccess).includes(variable.access) || names.has(variable.name)) {
                    return false;
                }
                names.add(variable.name);
                return true;
            });
            const allocator = candidate.nextAtomValue;
            const dataKeys = Object.keys(candidate);
            const allocatorKeys = allocator ? Object.keys(allocator) : [];
            if (dataKeys.length !== 2 || !dataKeys.includes("variables") || !dataKeys.includes("nextAtomValue") ||
                !variablesAreCurrent || !allocator || allocatorKeys.length !== 2 ||
                !allocatorKeys.includes("line") || !allocatorKeys.includes("choice") ||
                !isValidAtomValue(allocator.line) || !isValidAtomValue(allocator.choice)) {
                throw new Error("Empathy plugin data does not match the current schema");
            }
            this.variables = [...candidate.variables!];
            this.nextAtomValue = { ...allocator };
        }
        const withActiveCanvas = <T>(fallback: T, action: (canvas: Canvas, view: InternalCanvasView) => T): T => {
            const view = this.activeCanvasView();
            return view ? action(view.canvas, view) : fallback;
        };
        this.registerView(EMPATHY_PANEL_VIEW, (leaf) => new EmpathyPanelView(leaf, {
            getVariables: () => this.variables,
            setVariables: (variables) => this.setVariables(variables),
            getUsageCount: (name) => this.canvasIntegration.variableUsageCount(name),
            compileActiveCanvas: () => this.compileActiveCanvas(),
            getAtomSources: () => withActiveCanvas([], (canvas) => this.canvasIntegration.atomSources(canvas)),
            renameAtomKey: (source, key) => withActiveCanvas(
                "No active Canvas is available.",
                (canvas) => this.canvasIntegration.renameAtomKey(canvas, source, key),
            ),
            generateAtomKey: (source) => withActiveCanvas(
                "No active Canvas is available.",
                (canvas) => this.canvasIntegration.generateAtomKey(canvas, source),
            ),
            removeAtomKey: (source) => withActiveCanvas(
                "No active Canvas is available.",
                (canvas) => this.canvasIntegration.removeAtomKey(canvas, source),
            ),
            goToAtomSource: (source) => withActiveCanvas(false, (canvas, view) => {
                void this.app.workspace.revealLeaf(view.leaf);
                return this.canvasIntegration.goToAtomSource(canvas, source);
            }),
        }));
        this.canvasIntegration = new EmpathyCanvasIntegration(this, {
            setIcon,
            setTooltip: (element, tooltip) => setTooltip(element, tooltip, { placement: "top" }),
            showNotice: (message) => {
                new Notice(message);
            },
            getVariables: () => this.variables,
            openPanel: (selectCreated) => void this.openPanel(selectCreated),
            allocateAtom: (type, usedValues) => this.allocateAtom(type, usedValues),
            atomsChanged: () => this.refreshPanels(),
        });
        this.canvasIntegration.register();

        this.rememberCanvas(this.app.workspace.activeLeaf?.view);
        this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.rememberCanvas(leaf?.view)));

        this.addRibbonIcon("workflow", "Open Empathy panel", () => void this.openPanel());
        this.addCommand({
            id: "open-empathy-panel",
            name: "Open Empathy panel",
            callback: () => void this.openPanel(),
        });

        this.addCommand({
            id: "compile-active-canvas",
            name: "Compile active canvas",
            callback: () => void this.compileActiveCanvas(),
        });

        for (const kind of Object.values(EmpathyCanvasNodeKind)) {
            this.addCommand({
                id: `add-${kind}-node`,
                name: `Add ${kind.replace("-", " ").toUpperCase()} node`,
                checkCallback: (checking) => {
                    const view = this.activeCanvasView();
                    if (!view || view.canvas.readonly) return false;
                    if (!checking) this.createNode(view.canvas, kind);
                    return true;
                },
            });
        }
    }

    onunload(): void {
        this.app.workspace.detachLeavesOfType(EMPATHY_PANEL_VIEW);
    }

    private activeCanvasView(): InternalCanvasView | undefined {
        const view = this.app.workspace.activeLeaf?.view as InternalCanvasView | undefined;
        if (view?.getViewType() === "canvas") {
            this.lastCanvasView = view;
            return view;
        }
        const live = this.app.workspace.getLeavesOfType("canvas").map((leaf) => leaf.view as InternalCanvasView);
        if (this.lastCanvasView && live.includes(this.lastCanvasView)) return this.lastCanvasView;
        if (live.length === 1) {
            this.lastCanvasView = live[0];
            return live[0];
        }
        return undefined;
    }

    private rememberCanvas(view: unknown): void {
        const candidate = view as InternalCanvasView | undefined;
        if (candidate?.getViewType() === "canvas") {
            this.lastCanvasView = candidate;
        } else if (this.lastCanvasView) {
            const live = this.app.workspace.getLeavesOfType("canvas").map((leaf) => leaf.view as InternalCanvasView);
            if (!live.includes(this.lastCanvasView)) this.lastCanvasView = undefined;
        }
        this.refreshPanels();
    }

    private createNode(canvas: Canvas, kind: EmpathyCanvasNodeKind): void {
        try {
            this.canvasIntegration.createNode(canvas, kind);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Empathy Canvas node creation failed", error);
            new Notice(`Empathy node creation failed: ${message}`);
        }
    }

    private async setVariables(variables: readonly NarrativeVariable[]): Promise<void> {
        this.variables = [...variables];
        await this.persistData();
        this.canvasIntegration.variablesChanged();
        this.refreshPanels();
    }

    private persistData(): Promise<void> {
        const snapshot: EmpathyPluginData = {
            variables: [...this.variables],
            nextAtomValue: { ...this.nextAtomValue },
        };
        const save = (): Promise<void> => this.saveData(snapshot);
        this.dataSave = this.dataSave.then(save, save);
        return this.dataSave;
    }

    private allocateAtom(
        type: AuthoredAtomType,
        usedValues: ReadonlySet<number>,
    ): AuthoredAtom {
        const allocation = allocateAuthoredAtom(
            type,
            this.nextAtomValue[type],
            usedValues,
        );
        this.nextAtomValue = { ...this.nextAtomValue, [type]: allocation.nextValue };
        void this.persistData();
        return allocation.atom;
    }

    private refreshPanels(): void {
        for (const leaf of this.app.workspace.getLeavesOfType(EMPATHY_PANEL_VIEW)) {
            if (leaf.view instanceof EmpathyPanelView) leaf.view.refresh();
        }
    }

    private async openPanel(selectCreated?: (variable: NarrativeVariable) => void): Promise<void> {
        const leaf = await this.app.workspace.ensureSideLeaf(EMPATHY_PANEL_VIEW, "right", {
            active: true,
            reveal: true,
        });
        if (leaf.view instanceof EmpathyPanelView && selectCreated) leaf.view.startCreating(selectCreated);
    }

    private async compileActiveCanvas(): Promise<void> {
        if (this.compiling) {
            new Notice("Empathy compile is already in progress");
            return;
        }

        this.compiling = true;
        try {
            const view = this.activeCanvasView();
            if (!view) {
                throw new Error("active view is not a Canvas");
            }

            const file = view.file;
            if (!file || file.extension !== "canvas") {
                throw new Error("active Canvas is not backed by a .canvas file");
            }

            const result = compileCanvas(view.canvas, this.variables);
            const outputBase = file.path.slice(0, -(file.extension.length + 1));
            const binaryPath = `${outputBase}.empathy.bin`;
            const headerPath = `${outputBase}.empathy.h`;
            const binary = new Uint8Array(result.bytecode).buffer;
            const header = generateHeader(result, file.basename);

            await this.app.vault.adapter.writeBinary(binaryPath, binary);
            await this.app.vault.adapter.write(headerPath, header);
            new Notice(`Empathy: compiled ${file.name} to ${binaryPath} and ${headerPath}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Empathy Canvas compile failed", error);
            new Notice(`Empathy compile failed: ${message}`);
        } finally {
            this.compiling = false;
        }
    }
}
