import { ItemView, Notice, Plugin, setIcon, setTooltip, TFile } from "obsidian";

import {
    AtomSource,
    Canvas,
    collectCharacterAtoms,
    compileCanvas,
    EmpathyCanvasNodeKind,
    isValidHeaderPrefix,
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
    generatedAtomKey,
    initialAtomAllocatorState,
    isValidAtomKey,
    isValidAtomValue,
    MAXIMUM_ATOM_KEY_LENGTH,
} from "./atoms";
import {
    CanvasArtifactKind,
    GeneratedFileSystem,
    saveCanvasArtifact,
    SystemSaveDialog,
} from "./artifacts";
import { EmpathyCanvasIntegration } from "./canvas";
import {
    createNarrativeCharacter,
    isNarrativeCharacter,
    NarrativeCharacter,
} from "./characters";
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
    characters: NarrativeCharacter[];
    nextAtomValue: AtomAllocatorState;
}

interface DesktopWindow extends Window {
    electron: { remote: { dialog: SystemSaveDialog } };
    require(module: "fs"): { promises: GeneratedFileSystem };
}

export default class EmpathyPlugin extends Plugin {
    private canvasIntegration!: EmpathyCanvasIntegration;
    private exporting?: CanvasArtifactKind;
    private headerPrefix = "Canvas";
    private variables: NarrativeVariable[] = [];
    private characters: NarrativeCharacter[] = [];
    private nextAtomValue: AtomAllocatorState = { ...initialAtomAllocatorState };
    private lastCanvasView?: InternalCanvasView;
    private dataSave: Promise<void> = Promise.resolve();

    async onload(): Promise<void> {
        const storedHeaderPrefix = this.app.loadLocalStorage(`${this.manifest.id}:header-prefix`);
        if (storedHeaderPrefix !== null) {
            if (!isValidHeaderPrefix(storedHeaderPrefix)) {
                throw new Error("Empathy header prefix does not match the current schema");
            }
            this.headerPrefix = storedHeaderPrefix;
        }
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
            const characterValues = new Set<number>();
            const characterKeys = new Set<string>();
            const charactersAreCurrent = Array.isArray(candidate.characters) && candidate.characters.every((character) => {
                if (!isNarrativeCharacter(character) || characterValues.has(character.atom.value) ||
                    (character.atom.key !== undefined && characterKeys.has(character.atom.key))) return false;
                characterValues.add(character.atom.value);
                if (character.atom.key !== undefined) characterKeys.add(character.atom.key);
                return true;
            });
            const allocator = candidate.nextAtomValue;
            const dataKeys = Object.keys(candidate);
            const allocatorKeys = allocator ? Object.keys(allocator) : [];
            if (dataKeys.length !== 3 || !dataKeys.includes("variables") || !dataKeys.includes("characters") ||
                !dataKeys.includes("nextAtomValue") || !variablesAreCurrent || !charactersAreCurrent || !allocator ||
                allocatorKeys.length !== 3 || !allocatorKeys.includes("line") || !allocatorKeys.includes("character") ||
                !allocatorKeys.includes("choice") || !isValidAtomValue(allocator.line) ||
                !isValidAtomValue(allocator.character) || !isValidAtomValue(allocator.choice)) {
                throw new Error("Empathy plugin data does not match the current schema");
            }
            this.variables = [...candidate.variables!];
            this.characters = candidate.characters!.map((character) => ({ ...character, atom: { ...character.atom } }));
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
            getCharacters: () => this.characters,
            createCharacter: (name) => this.createCharacter(name),
            setCharacters: (characters) => this.setCharacters(characters),
            getCharacterUsages: (atomValue) => withActiveCanvas(
                [],
                (canvas) => this.canvasIntegration.characterUsages(canvas, atomValue),
            ),
            goToCharacterUsage: (atomValue, nodeId) => withActiveCanvas(false, (canvas, view) => {
                void this.app.workspace.revealLeaf(view.leaf);
                return this.canvasIntegration.goToCharacterUsage(canvas, atomValue, nodeId);
            }),
            getHeaderPrefix: () => this.headerPrefix,
            setHeaderPrefix: (prefix) => this.setHeaderPrefix(prefix),
            getExporting: () => this.exporting,
            exportActiveCanvas: (kind) => this.exportActiveCanvas(kind),
            getAtomSources: () => withActiveCanvas<readonly AtomSource[]>(
                collectCharacterAtoms(this.characters),
                (canvas) => [...this.canvasIntegration.atomSources(canvas), ...collectCharacterAtoms(this.characters, canvas)],
            ),
            renameAtomKey: (source, key) => this.renameAtomKey(source, key),
            generateAtomKey: (source) => this.generateAtomKey(source),
            removeAtomKey: (source) => this.removeAtomKey(source),
            goToAtomSource: (source) => withActiveCanvas(false, (canvas, view) => {
                if (source.owner !== "canvas") return false;
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
            getCharacters: () => this.characters,
            createCharacter: (name) => this.createCharacter(name),
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

        for (const kind of ["header", "bytecode"] as const) {
            this.addCommand({
                id: `generate-active-canvas-${kind}`,
                name: `Generate active Canvas ${kind}`,
                callback: () => void this.exportActiveCanvas(kind),
            });
        }

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

    private async setCharacters(characters: readonly NarrativeCharacter[]): Promise<void> {
        this.characters = characters.map((character) => ({ ...character, atom: { ...character.atom } }));
        await this.persistData();
        this.canvasIntegration.charactersChanged();
        this.refreshPanels();
    }

    private async createCharacter(name: string): Promise<NarrativeCharacter> {
        const character = createNarrativeCharacter(
            name,
            this.characters,
            (type, usedValues) => this.allocateAtom(type, usedValues),
        );
        await this.setCharacters([...this.characters, character]);
        return character;
    }

    private renameAtomKey(source: AtomSource, key: string): string | undefined {
        if (source.owner === "canvas") {
            const view = this.activeCanvasView();
            return view
                ? this.canvasIntegration.renameAtomKey(view.canvas, source, key)
                : "No active Canvas is available.";
        }
        if (!isValidAtomKey(key)) {
            return `Use at most ${MAXIMUM_ATOM_KEY_LENGTH} lowercase ASCII letters, numbers, and underscores; start with a letter.`;
        }
        if (this.characters.some((character) => character.atom.value !== source.value && character.atom.key === key)) {
            return `CHARACTER key ${key} already exists.`;
        }
        const index = this.characters.findIndex((character) => character.atom.value === source.value);
        if (index < 0) return "The character definition is no longer available.";
        const characters = [...this.characters];
        characters[index] = { ...characters[index], atom: { value: source.value, key } };
        void this.setCharacters(characters);
        return undefined;
    }

    private generateAtomKey(source: AtomSource): string | undefined {
        if (source.owner === "canvas") {
            const view = this.activeCanvasView();
            return view
                ? this.canvasIntegration.generateAtomKey(view.canvas, source)
                : "No active Canvas is available.";
        }
        const index = this.characters.findIndex((character) => character.atom.value === source.value);
        if (index < 0) return "The character definition is no longer available.";
        const usedKeys = new Set(this.characters.flatMap((character, characterIndex) =>
            characterIndex === index || character.atom.key === undefined ? [] : [character.atom.key]));
        const characters = [...this.characters];
        const character = characters[index];
        characters[index] = {
            ...character,
            atom: {
                value: character.atom.value,
                key: generatedAtomKey(AuthoredAtomType.CHARACTER, character.name, character.atom.value, usedKeys),
            },
        };
        void this.setCharacters(characters);
        return undefined;
    }

    private removeAtomKey(source: AtomSource): string | undefined {
        if (source.owner === "canvas") {
            const view = this.activeCanvasView();
            return view
                ? this.canvasIntegration.removeAtomKey(view.canvas, source)
                : "No active Canvas is available.";
        }
        const index = this.characters.findIndex((character) => character.atom.value === source.value);
        if (index < 0) return "The character definition is no longer available.";
        const characters = [...this.characters];
        characters[index] = { ...characters[index], atom: { value: characters[index].atom.value } };
        void this.setCharacters(characters);
        return undefined;
    }

    private setHeaderPrefix(prefix: string): Promise<void> {
        if (!isValidHeaderPrefix(prefix)) throw new Error("invalid Empathy header prefix");
        const previousPrefix = this.headerPrefix;
        this.headerPrefix = prefix;
        try {
            this.app.saveLocalStorage(`${this.manifest.id}:header-prefix`, prefix);
        } catch (error) {
            this.headerPrefix = previousPrefix;
            throw error;
        }
        this.refreshPanels();
        return Promise.resolve();
    }

    private persistData(): Promise<void> {
        const snapshot: EmpathyPluginData = {
            variables: [...this.variables],
            characters: this.characters.map((character) => ({ ...character, atom: { ...character.atom } })),
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

    private refreshExportControls(): void {
        for (const leaf of this.app.workspace.getLeavesOfType(EMPATHY_PANEL_VIEW)) {
            if (leaf.view instanceof EmpathyPanelView) leaf.view.refreshExportControls();
        }
    }

    private async openPanel(selectCreated?: (variable: NarrativeVariable) => void): Promise<void> {
        const leaf = await this.app.workspace.ensureSideLeaf(EMPATHY_PANEL_VIEW, "right", {
            active: true,
            reveal: true,
        });
        if (leaf.view instanceof EmpathyPanelView && selectCreated) leaf.view.startCreating(selectCreated);
    }

    private async exportActiveCanvas(kind: CanvasArtifactKind): Promise<void> {
        if (this.exporting !== undefined) {
            new Notice("Empathy export is already in progress");
            return;
        }

        this.exporting = kind;
        this.refreshExportControls();
        try {
            const view = this.activeCanvasView();
            if (!view) {
                throw new Error("active view is not a Canvas");
            }

            const file = view.file;
            if (!file || file.extension !== "canvas") {
                throw new Error("active Canvas is not backed by a .canvas file");
            }

            const result = compileCanvas(view.canvas, this.variables, this.characters);
            const desktop = window as unknown as DesktopWindow;
            const outputPath = await saveCanvasArtifact(
                desktop.electron.remote.dialog,
                desktop.require("fs").promises,
                result,
                kind === "header"
                    ? { kind, headerPrefix: this.headerPrefix }
                    : { kind, canvasName: file.basename },
            );
            if (outputPath) new Notice(`Empathy: saved ${kind} to ${outputPath}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Empathy Canvas ${kind} export failed`, error);
            new Notice(`Empathy ${kind} export failed: ${message}`);
        } finally {
            this.exporting = undefined;
            this.refreshExportControls();
        }
    }
}
