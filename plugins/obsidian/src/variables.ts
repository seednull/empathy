import { ItemView, Modal, Notice, setIcon, WorkspaceLeaf } from "obsidian";

import {
    AtomSource,
    CharacterAtomSource,
    isValidHeaderPrefix,
    NarrativeVariable,
    NarrativeVariableAccess,
    NarrativeVariableType,
    parseVariableName,
} from "./compile";
import { CanvasArtifactKind } from "./artifacts";
import { NarrativeCharacter } from "./characters";

type CanvasAtomSource = Extract<AtomSource, { owner: "canvas" }>;
type CanvasAtomType = CanvasAtomSource["type"];

export const EMPATHY_PANEL_VIEW = "empathy-panel";

const variableTypeOptions: ReadonlyArray<readonly [NarrativeVariableType, string]> = [
    [NarrativeVariableType.BOOLEAN, "Boolean"],
    [NarrativeVariableType.INTEGER, "Integer"],
    [NarrativeVariableType.FLOAT, "Float"],
];
const variableAccessOptions: ReadonlyArray<readonly [NarrativeVariableAccess, string]> = [
    [NarrativeVariableAccess.READ, "Read"],
    [NarrativeVariableAccess.WRITE, "Write"],
    [NarrativeVariableAccess.READ_WRITE, "Read / Write"],
];

interface EmpathyPanelHost {
    getVariables(): readonly NarrativeVariable[];
    setVariables(variables: readonly NarrativeVariable[]): Promise<void>;
    getUsageCount(name: string): number;
    getCharacters(): readonly NarrativeCharacter[];
    createCharacter(name: string): Promise<NarrativeCharacter>;
    setCharacters(characters: readonly NarrativeCharacter[]): Promise<void>;
    getCharacterUsages(atomValue: number): ReadonlyArray<{ nodeId: string; text: string }>;
    goToCharacterUsage(atomValue: number, nodeId: string): boolean;
    getHeaderPrefix(): string;
    setHeaderPrefix(prefix: string): Promise<void>;
    getExporting(): CanvasArtifactKind | undefined;
    exportActiveCanvas(kind: CanvasArtifactKind): Promise<void>;
    getAtomSources(): readonly AtomSource[];
    renameAtomKey(source: AtomSource, key: string): string | undefined;
    generateAtomKey(source: AtomSource): string | undefined;
    removeAtomKey(source: AtomSource): string | undefined;
    goToAtomSource(source: AtomSource): boolean;
}

export class EmpathyPanelView extends ItemView {
    private selectCreated?: (variable: NarrativeVariable) => void;
    private creatingFor?: string | null;
    private creatingCharacter = false;
    private expandedCharacter?: number;
    private readonly atomQueries: Record<CanvasAtomType, string> = { line: "", choice: "" };
    private readonly atomOrder: Record<CanvasAtomType, string[]> = { line: [], choice: [] };

    constructor(leaf: WorkspaceLeaf, private readonly host: EmpathyPanelHost) {
        super(leaf);
    }

    getViewType(): string {
        return EMPATHY_PANEL_VIEW;
    }

    getDisplayText(): string {
        return "Empathy";
    }

    getIcon(): string {
        return "workflow";
    }

    onOpen(): Promise<void> {
        this.render();
        return Promise.resolve();
    }

    refresh(): void {
        if (this.containerEl.isConnected) this.render();
    }

    refreshExportControls(): void {
        if (!this.containerEl.isConnected) return;
        const exporting = this.host.getExporting();
        const prefixInput = this.contentEl.querySelector<HTMLInputElement>(".empathy-header-prefix");
        if (prefixInput) prefixInput.disabled = exporting === "header";
        this.contentEl.querySelectorAll<HTMLButtonElement>(".empathy-panel-export").forEach((button) => {
            const kind = button.dataset.empathyArtifact as CanvasArtifactKind;
            const label = button.dataset.empathyLabel!;
            const invalidPrefix = kind === "header" && !isValidHeaderPrefix(prefixInput?.value);
            button.disabled = exporting !== undefined || invalidPrefix;
            button.title = invalidPrefix
                ? "Set a valid header prefix first"
                : `${label} from the active Canvas`;
            button.querySelector<HTMLElement>("span:last-child")!.textContent = exporting === kind
                ? "Generating…"
                : label;
        });
    }

    startCreating(selectCreated?: (variable: NarrativeVariable) => void): void {
        this.selectCreated = selectCreated;
        this.creatingFor = this.host.getVariables().length > 0 ? null : undefined;
        this.render();
        const target = this.contentEl.querySelector<HTMLInputElement>(".empathy-variable-new-name");
        target?.focus();
        target?.select();
    }

    private render(): void {
        const scrollTop = this.contentEl.scrollTop;
        this.contentEl.replaceChildren();
        this.contentEl.className = "view-content empathy-panel-view";
        this.contentEl.append(
            this.panelHeader(),
            this.variablesSection(),
            this.charactersSection(),
            this.atomSection("line", "Lines"),
            this.atomSection("choice", "Choices"),
        );
        this.contentEl.scrollTop = scrollTop;
        queueMicrotask(() => {
            if (this.containerEl.isConnected) this.contentEl.scrollTop = scrollTop;
        });
    }

    private panelHeader(): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const header = document.createElement("header");
        header.className = "empathy-panel-header";
        const title = document.createElement("h2");
        title.textContent = "Empathy";
        const prefixField = document.createElement("label");
        prefixField.className = "empathy-header-prefix-field";
        const prefixLabel = document.createElement("span");
        prefixLabel.textContent = "Header prefix";
        const prefixInput = document.createElement("input");
        prefixInput.type = "text";
        prefixInput.className = "empathy-header-prefix";
        prefixInput.value = this.host.getHeaderPrefix();
        prefixInput.placeholder = "Canvas";
        prefixInput.spellcheck = false;
        prefixInput.setAttribute("aria-label", "Generated header prefix");
        const prefixError = document.createElement("span");
        prefixError.className = "empathy-header-prefix-error";
        prefixError.setAttribute("aria-live", "polite");
        const prefixValidationMessage = "Start with an ASCII letter; use letters, digits, and single internal underscores.";
        const setPrefixError = (message?: string): void => {
            prefixField.classList.toggle("is-invalid", Boolean(message));
            prefixInput.toggleAttribute("aria-invalid", Boolean(message));
            prefixInput.setCustomValidity(message ?? "");
            prefixInput.title = message ?? "C identifier used for generated header symbols";
            prefixError.textContent = message ?? "";
            prefixError.hidden = message === undefined;
        };
        const commitPrefix = async (): Promise<boolean> => {
            const prefix = prefixInput.value;
            if (!isValidHeaderPrefix(prefix)) {
                setPrefixError(prefixValidationMessage);
                prefixInput.focus();
                return false;
            }
            setPrefixError();
            if (prefix === this.host.getHeaderPrefix()) return true;
            try {
                await this.host.setHeaderPrefix(prefix);
                return true;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                setPrefixError(message);
                new Notice(`Could not save the header prefix: ${message}`);
                return false;
            }
        };
        prefixInput.addEventListener("input", () => {
            setPrefixError(isValidHeaderPrefix(prefixInput.value) ? undefined : prefixValidationMessage);
            this.refreshExportControls();
        });
        prefixInput.addEventListener("change", () => void commitPrefix());
        prefixInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                prefixInput.blur();
            } else if (event.key === "Escape") {
                prefixInput.value = this.host.getHeaderPrefix();
                setPrefixError();
                this.refreshExportControls();
                prefixInput.blur();
            }
        });
        setPrefixError();
        prefixField.append(prefixLabel, prefixInput, prefixError);
        const exports = document.createElement("div");
        exports.className = "empathy-panel-exports";
        const exporting = this.host.getExporting();
        const startExport = async (kind: CanvasArtifactKind): Promise<void> => {
            const activeElement = document.activeElement;
            if (activeElement?.classList.contains("empathy-atom-id") ||
                activeElement?.classList.contains("empathy-character-id")) {
                const atomId = activeElement as HTMLInputElement;
                atomId.blur();
                if (!atomId.checkValidity()) {
                    atomId.focus();
                    return;
                }
            }
            if (kind === "header") {
                if (!await commitPrefix()) return;
            } else if (isValidHeaderPrefix(prefixInput.value) && prefixInput.value !== this.host.getHeaderPrefix()) {
                await commitPrefix();
            }
            if (this.host.getExporting() === undefined) await this.host.exportActiveCanvas(kind);
        };
        for (const { kind, label, icon } of [
            { kind: "header", label: "Generate header", icon: "code-2" },
            { kind: "bytecode", label: "Generate bytecode", icon: "binary" },
        ] as const) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "mod-cta empathy-panel-export";
            button.dataset.empathyArtifact = kind;
            button.dataset.empathyLabel = label;
            const invalidPrefix = kind === "header" && !isValidHeaderPrefix(prefixInput.value);
            button.disabled = exporting !== undefined || invalidPrefix;
            button.title = invalidPrefix ? "Set a valid header prefix first" : `${label} from the active Canvas`;
            const buttonIcon = document.createElement("span");
            setIcon(buttonIcon, icon);
            const text = document.createElement("span");
            text.textContent = exporting === kind ? "Generating…" : label;
            button.append(buttonIcon, text);
            button.addEventListener("mousedown", (event) => event.preventDefault());
            button.addEventListener("click", () => void startExport(kind));
            exports.append(button);
        }
        header.append(title, prefixField, exports);
        return header;
    }

    private variablesSection(): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const section = document.createElement("section");
        const heading = document.createElement("div");
        heading.className = "empathy-panel-section-heading";
        const title = document.createElement("h3");
        title.textContent = "Variables";
        const intro = document.createElement("p");
        intro.textContent = "Qualified names create real parameter tables: table.variable";
        heading.append(title, intro);
        section.append(heading);

        const groups = new Map<string, Array<{ variable: NarrativeVariable; index: number }>>();
        this.host.getVariables().forEach((variable, index) => {
            const table = parseVariableName(variable.name)!.tableName;
            const values = groups.get(table) ?? [];
            values.push({ variable, index });
            groups.set(table, values);
        });

        if (groups.size === 0) {
            const empty = document.createElement("div");
            empty.className = "empathy-variables-empty";
            empty.textContent = "No variables yet";
            section.append(empty, this.newVariableForm());
            return section;
        }

        for (const [table, values] of groups) section.append(this.variableTable(table, values));
        if (this.creatingFor === null) section.append(this.newVariableForm());
        else {
            const addTable = document.createElement("button");
            addTable.type = "button";
            addTable.className = "empathy-variable-new-table";
            const icon = document.createElement("span");
            setIcon(icon, "plus");
            const text = document.createElement("span");
            text.textContent = "Variable in new table";
            addTable.append(icon, text);
            addTable.addEventListener("click", () => {
                this.creatingFor = null;
                this.render();
                this.contentEl.querySelector<HTMLInputElement>(".empathy-variable-new-name")?.focus();
            });
            section.append(addTable);
        }
        return section;
    }

    private charactersSection(): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const section = document.createElement("section");
        section.className = "empathy-characters-section";
        const heading = document.createElement("div");
        heading.className = "empathy-panel-section-heading empathy-character-heading";
        const copy = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = "Characters";
        const intro = document.createElement("p");
        intro.textContent = "Shared definitions referenced by stable CHARACTER atoms.";
        copy.append(title, intro);
        const add = document.createElement("button");
        add.type = "button";
        add.title = "Add character";
        add.setAttribute("aria-label", "Add character");
        setIcon(add, "plus");
        add.addEventListener("click", () => {
            this.creatingCharacter = true;
            this.render();
            this.contentEl.querySelector<HTMLInputElement>(".empathy-character-new-name")?.focus();
        });
        heading.append(copy, add);
        section.append(heading);

        const characters = this.host.getCharacters();
        if (characters.length === 0 && !this.creatingCharacter) {
            const empty = document.createElement("div");
            empty.className = "empathy-characters-empty";
            empty.textContent = "No characters yet";
            section.append(empty);
        }
        for (const character of characters) section.append(this.characterRow(character));
        if (this.creatingCharacter || characters.length === 0) section.append(this.newCharacterForm());
        return section;
    }

    private characterRow(character: NarrativeCharacter): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const row = document.createElement("article");
        row.className = "empathy-character-row";
        const usages = this.host.getCharacterUsages(character.atom.value);
        const source: CharacterAtomSource = {
            ...character.atom,
            owner: "character",
            type: "character",
            text: character.name,
            usageCount: usages.length,
        };
        const keyInput = document.createElement("input");
        keyInput.type = "text";
        keyInput.className = "empathy-character-id";
        keyInput.value = character.atom.key ?? "";
        keyInput.placeholder = "Human-readable ID";
        keyInput.spellcheck = false;
        keyInput.setAttribute("aria-label", `Human-readable ID for ${character.name}`);
        const name = document.createElement("input");
        name.type = "text";
        name.className = "empathy-character-name";
        name.value = character.name;
        name.placeholder = "Display value";
        name.setAttribute("aria-label", `Display name for character ${character.atom.value}`);
        const actions = document.createElement("div");
        actions.className = "empathy-character-actions";
        const error = document.createElement("div");
        error.className = "empathy-character-error";
        let keyError = "";
        let nameError = "";
        const updateError = (): void => {
            error.textContent = keyError || nameError;
            row.classList.toggle("is-invalid-id", keyError.length > 0);
            row.classList.toggle("is-invalid-name", nameError.length > 0);
        };
        const commitKey = (): string | undefined => {
            const currentKey = character.atom.key ?? "";
            if (keyInput.value === currentKey) {
                keyError = "";
                updateError();
                return undefined;
            }
            const message = keyInput.value === ""
                ? this.host.removeAtomKey(source)
                : this.host.renameAtomKey(source, keyInput.value);
            keyError = message ?? "";
            updateError();
            if (message) new Notice(message);
            return message;
        };
        const commitName = async (): Promise<void> => {
            const nextName = name.value.trim();
            if (nextName.length === 0) {
                nameError = "Character display value cannot be empty.";
                updateError();
                name.focus();
                return;
            }
            nameError = "";
            updateError();
            if (nextName === character.name) return;
            await this.host.setCharacters(this.host.getCharacters().map((candidate) =>
                candidate.atom.value === character.atom.value ? { ...candidate, name: nextName } : candidate));
        };
        keyInput.addEventListener("change", commitKey);
        keyInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                keyInput.blur();
            } else if (event.key === "Escape") {
                keyInput.value = character.atom.key ?? "";
                keyError = "";
                updateError();
                keyInput.blur();
            }
        });
        name.addEventListener("change", () => void commitName());
        name.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                name.blur();
            } else if (event.key === "Escape") {
                name.value = character.name;
                nameError = "";
                updateError();
                name.blur();
            }
        });
        const action = (
            icon: string,
            title: string,
            activate: () => void,
            disabled = false,
            className?: string,
        ): HTMLButtonElement => {
            const button = document.createElement("button");
            button.type = "button";
            button.title = title;
            button.setAttribute("aria-label", `${title} for ${character.name}`);
            button.disabled = disabled;
            if (className) button.className = className;
            setIcon(button, icon);
            button.addEventListener("mousedown", (event) => event.preventDefault());
            if (!disabled) button.addEventListener("click", activate);
            return button;
        };
        actions.append(
            action("refresh-cw", character.atom.key === undefined
                ? "Generate ID from display value"
                : "Regenerate ID from display value", () => {
                const message = this.host.generateAtomKey(source);
                if (message) new Notice(message);
            }),
            action("unlink", "Remove ID", () => {
                const message = this.host.removeAtomKey(source);
                if (message) new Notice(message);
            }, character.atom.key === undefined),
            action("users", `${this.expandedCharacter === character.atom.value ? "Hide" : "Show"} usages (${usages.length})`, () => {
                if (commitKey()) return;
                this.expandedCharacter = this.expandedCharacter === character.atom.value ? undefined : character.atom.value;
                this.render();
            }),
            action("trash-2", "Delete character", () => void this.deleteCharacter(character, usages.length), false, "empathy-character-delete"),
        );
        row.append(keyInput, name, actions, error);
        if (this.expandedCharacter === character.atom.value) row.append(this.characterUsageList(character.atom.value));
        return row;
    }

    private characterUsageList(atomValue: number): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const list = document.createElement("div");
        list.className = "empathy-character-usages";
        const usages = this.host.getCharacterUsages(atomValue);
        if (usages.length === 0) {
            const empty = document.createElement("div");
            empty.textContent = "No usages in the active Canvas";
            list.append(empty);
            return list;
        }
        for (const usage of usages) {
            const button = document.createElement("button");
            button.type = "button";
            button.title = "Go to usage";
            const text = document.createElement("span");
            text.textContent = `SAY “${usage.text || "(empty dialogue)"}”`;
            const arrow = document.createElement("span");
            arrow.textContent = "↗";
            button.append(text, arrow);
            button.addEventListener("click", () => {
                if (!this.host.goToCharacterUsage(atomValue, usage.nodeId)) {
                    new Notice("The character usage is no longer available.");
                }
            });
            list.append(button);
        }
        return list;
    }

    private newCharacterForm(): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const form = document.createElement("div");
        form.className = "empathy-character-new";
        const name = document.createElement("input");
        name.type = "text";
        name.className = "empathy-character-new-name";
        name.placeholder = "Name";
        name.setAttribute("aria-label", "New character name");
        const create = document.createElement("button");
        create.type = "button";
        create.className = "mod-cta";
        create.textContent = "Create";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.hidden = this.host.getCharacters().length === 0;
        const error = document.createElement("small");
        const submit = async (): Promise<void> => {
            const characterName = name.value.trim();
            if (characterName.length === 0) {
                error.textContent = "Enter a character name.";
                name.focus();
                return;
            }
            error.textContent = "";
            create.disabled = true;
            this.creatingCharacter = false;
            try {
                await this.host.createCharacter(characterName);
            } catch (reason) {
                this.creatingCharacter = true;
                error.textContent = reason instanceof Error ? reason.message : String(reason);
                create.disabled = false;
            }
        };
        create.addEventListener("click", () => void submit());
        cancel.addEventListener("click", () => {
            this.creatingCharacter = false;
            this.render();
        });
        name.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                void submit();
            }
        });
        form.append(name, create, cancel, error);
        return form;
    }

    private async deleteCharacter(character: NarrativeCharacter, usages: number): Promise<void> {
        const confirmed = await new Promise<boolean>((resolve) => {
            const modal = new Modal(this.app);
            let accepted = false;
            modal.titleEl.textContent = "Delete character?";
            const copy = modal.contentEl.createDiv({ cls: "empathy-variable-confirm-copy" });
            copy.createEl("p", { text: `Delete “${character.name}”?` });
            if (usages > 0) copy.createEl("p", {
                text: `It is used by ${usages} SAY node${usages === 1 ? "" : "s"}. Those numeric references will remain missing and compilation will fail until fixed.`,
            });
            const actions = modal.contentEl.createDiv({ cls: "empathy-modal-actions" });
            const cancel = actions.createEl("button", { text: "Cancel" });
            const remove = actions.createEl("button", { cls: "mod-warning empathy-variable-confirm-delete", text: "Delete character" });
            cancel.addEventListener("click", () => modal.close());
            remove.addEventListener("click", () => { accepted = true; modal.close(); });
            modal.onClose = () => {
                modal.contentEl.replaceChildren();
                resolve(accepted);
            };
            modal.open();
        });
        if (!confirmed) return;
        await this.host.setCharacters(this.host.getCharacters().filter((candidate) => candidate.atom.value !== character.atom.value));
    }

    private atomIdentity(source: CanvasAtomSource): string {
        return `${source.type}:${source.nodeId}:${source.value}`;
    }

    private atomDisplayId(source: CanvasAtomSource): string {
        return source.key ?? `${source.nodeKind}_${source.value}`;
    }

    private orderedAtomSources(type: CanvasAtomType): CanvasAtomSource[] {
        const sources = this.host.getAtomSources().filter((source): source is CanvasAtomSource =>
            source.owner === "canvas" && source.type === type);
        const byIdentity = new Map(sources.map((source) => [this.atomIdentity(source), source]));
        const order = this.atomOrder[type].filter((identity) => byIdentity.has(identity));
        const known = new Set(order);
        for (const source of sources) {
            const identity = this.atomIdentity(source);
            if (!known.has(identity)) {
                order.push(identity);
                known.add(identity);
            }
        }
        this.atomOrder[type] = order;
        return order.map((identity) => byIdentity.get(identity)!);
    }

    private atomSection(type: CanvasAtomType, label: "Lines" | "Choices"): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const section = document.createElement("section");
        section.className = "empathy-atoms-section";
        const heading = document.createElement("div");
        heading.className = "empathy-panel-section-heading";
        const title = document.createElement("h3");
        title.textContent = label;
        const intro = document.createElement("p");
        intro.textContent = "Optional project IDs for authored text in the active Canvas.";
        heading.append(title, intro);
        const toolbar = document.createElement("div");
        toolbar.className = "empathy-atom-toolbar";
        const search = document.createElement("input");
        search.type = "search";
        search.className = "empathy-atom-search";
        search.placeholder = "Search ID or text…";
        search.setAttribute("aria-label", `Search ${label.toLowerCase()} by ID or authored text`);
        search.value = this.atomQueries[type];
        const sort = document.createElement("button");
        sort.type = "button";
        sort.className = "empathy-atom-sort";
        sort.title = `Sort ${label.toLowerCase()} lexicographically`;
        sort.setAttribute("aria-label", sort.title);
        setIcon(sort, "arrow-down-a-z");
        toolbar.append(search, sort);
        section.append(heading, toolbar);
        const results = document.createElement("div");
        section.append(results);
        const renderResults = (): void => {
            this.atomQueries[type] = search.value;
            results.replaceChildren();
            const query = this.atomQueries[type].trim().toLowerCase();
            const atoms = this.orderedAtomSources(type).filter((source) => {
                const id = this.atomDisplayId(source).toLowerCase();
                return !query || id.includes(query) || source.text.toLowerCase().includes(query);
            });
            if (atoms.length === 0) {
                const empty = document.createElement("div");
                empty.className = "empathy-atoms-empty";
                empty.textContent = query ? "No matching atoms" : `No ${label.toLowerCase()} in the active Canvas`;
                results.append(empty);
                return;
            }
            results.append(...atoms.map((source) => this.atomRow(source)));
        };
        search.addEventListener("input", renderResults);
        sort.addEventListener("click", () => {
            const atoms = this.orderedAtomSources(type).sort((left, right) => {
                const byId = this.atomDisplayId(left).localeCompare(this.atomDisplayId(right), "en");
                if (byId !== 0) return byId;
                return left.value - right.value;
            });
            this.atomOrder[type] = atoms.map((source) => this.atomIdentity(source));
            renderResults();
        });
        renderResults();
        return section;
    }

    private atomRow(source: CanvasAtomSource): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const row = document.createElement("article");
        row.className = "empathy-atom-row";
        const sourceDescription = source.text;
        const rowIdentity = this.atomIdentity(source);
        const stubId = this.atomDisplayId({ ...source, key: undefined });
        row.dataset.empathyAtomIdentity = rowIdentity;
        row.setAttribute("aria-label", `Atom for ${sourceDescription}`);
        const keyInput = document.createElement("input");
        keyInput.type = "text";
        keyInput.className = "empathy-atom-id";
        keyInput.value = source.key ?? "";
        keyInput.placeholder = stubId;
        keyInput.spellcheck = false;
        const inputLabel = source.key === undefined
            ? `Atom ID for ${sourceDescription}; default ${stubId}`
            : `Atom ID for ${sourceDescription}`;
        keyInput.setAttribute("aria-label", inputLabel);
        const text = document.createElement("div");
        text.className = "empathy-atom-text";
        text.textContent = `“${source.text}”`;
        text.title = text.textContent;
        const actions = document.createElement("div");
        actions.className = "empathy-atom-actions";
        type AtomControl = "id" | "generate" | "remove" | "source";
        type FocusTarget = { atomIdentity: string; control: AtomControl } | { controlIndex: number };
        const panelControls = (): HTMLElement[] => Array.from(this.contentEl.querySelectorAll<HTMLElement>(
            "input:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex=\"-1\"])",
        ));
        const describeFocusTarget = (target: EventTarget | null): FocusTarget | undefined => {
            const element = target as HTMLElement | null;
            if (!element || !this.contentEl.contains(element)) return undefined;
            const atomRow = element.closest<HTMLElement>(".empathy-atom-row");
            const atomIdentity = atomRow?.dataset.empathyAtomIdentity;
            if (atomIdentity) {
                const control = element.classList.contains("empathy-atom-id")
                    ? "id"
                    : element.dataset.empathyAtomAction as AtomControl | undefined;
                if (control) return { atomIdentity, control };
            }
            const controlIndex = panelControls().indexOf(element);
            return controlIndex < 0 ? undefined : { controlIndex };
        };
        const restoreFocus = (target: FocusTarget): void => queueMicrotask(() => {
            if ("controlIndex" in target) {
                panelControls()[target.controlIndex]?.focus();
                return;
            }
            const liveRow = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".empathy-atom-row"))
                .find((candidate) => candidate.dataset.empathyAtomIdentity === target.atomIdentity);
            const control = target.control === "id"
                ? liveRow?.querySelector<HTMLInputElement>(".empathy-atom-id")
                : liveRow?.querySelector<HTMLButtonElement>(`[data-empathy-atom-action="${target.control}"]`);
            control?.focus();
        });
        const setValidationError = (message?: string): void => {
            row.classList.toggle("is-invalid", Boolean(message));
            keyInput.toggleAttribute("aria-invalid", Boolean(message));
            keyInput.title = message ?? "";
            keyInput.setCustomValidity(message ?? "");
            keyInput.setAttribute("aria-label", message ? `${inputLabel}. ${message}` : inputLabel);
        };
        const currentKey = source.key ?? "";
        const commitKey = (): string | undefined => {
            if (keyInput.value === currentKey || (source.key === undefined && keyInput.value === "")) {
                setValidationError();
                return undefined;
            }
            const message = keyInput.value === ""
                ? this.host.removeAtomKey(source)
                : this.host.renameAtomKey(source, keyInput.value);
            setValidationError(message);
            if (message) new Notice(message);
            return message;
        };
        const action = (
            name: Exclude<AtomControl, "id">,
            icon: string,
            title: string,
            activate: () => void,
            disabled = false,
        ): HTMLButtonElement => {
            const button = document.createElement("button");
            button.type = "button";
            button.title = title;
            button.dataset.empathyAtomAction = name;
            button.disabled = disabled;
            button.setAttribute("aria-label", `${title} for ${sourceDescription}`);
            setIcon(button, icon);
            button.addEventListener("mousedown", (event) => event.preventDefault());
            if (!disabled) button.addEventListener("click", activate);
            return button;
        };
        let focusAfterCommit: FocusTarget | undefined;
        keyInput.addEventListener("blur", (event) => {
            const focus = focusAfterCommit ?? describeFocusTarget(event.relatedTarget);
            focusAfterCommit = undefined;
            commitKey();
            if (focus) restoreFocus(focus);
        });
        keyInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                if (keyInput.value === currentKey || (source.key === undefined && keyInput.value === "")) {
                    setValidationError();
                    return;
                }
                focusAfterCommit = { atomIdentity: rowIdentity, control: "id" };
                keyInput.blur();
            } else if (event.key === "Escape") {
                keyInput.value = currentKey;
                setValidationError();
                keyInput.blur();
            }
        });
        actions.append(
            action("generate", "refresh-cw", source.key === undefined
                ? "Generate ID from current text"
                : "Regenerate ID from current text", () => {
                const message = this.host.generateAtomKey(source);
                if (message) new Notice(message);
                else restoreFocus({ atomIdentity: rowIdentity, control: "generate" });
            }),
            action("remove", "unlink", "Remove ID", () => {
                const message = this.host.removeAtomKey(source);
                if (message) new Notice(message);
                else restoreFocus({ atomIdentity: rowIdentity, control: "remove" });
            }, source.key === undefined),
            action("source", "locate-fixed", "Go to source", () => {
                if (commitKey()) return;
                if (!this.host.goToAtomSource(source)) new Notice("The atom source is no longer available.");
            }),
        );
        row.append(keyInput, text, actions);
        return row;
    }

    private variableTable(
        table: string,
        values: Array<{ variable: NarrativeVariable; index: number }>,
    ): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const section = document.createElement("section");
        section.className = "empathy-variable-table";
        const heading = document.createElement("h4");
        heading.textContent = table;
        section.append(heading);
        for (const { variable, index } of values) section.append(this.variableRow(variable, index));
        if (this.creatingFor === table) section.append(this.newVariableForm(table));
        else {
            const add = document.createElement("button");
            add.type = "button";
            add.className = "empathy-variable-table-add";
            const icon = document.createElement("span");
            setIcon(icon, "plus");
            const text = document.createElement("span");
            text.textContent = `Add variable to ${table}`;
            add.append(icon, text);
            add.addEventListener("click", () => {
                this.creatingFor = table;
                this.render();
                const input = this.contentEl.querySelector<HTMLInputElement>(".empathy-variable-new-name");
                input?.focus();
                input?.setSelectionRange(input.value.length, input.value.length);
            });
            section.append(add);
        }
        return section;
    }

    private variableRow(variable: NarrativeVariable, index: number): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const row = document.createElement("div");
        row.className = "empathy-variable-row";
        const name = document.createElement("input");
        name.type = "text";
        name.value = variable.name;
        name.spellcheck = false;
        name.setAttribute("aria-label", `Name of ${variable.name}`);
        name.title = variable.name;
        const type = this.select(variableTypeOptions, variable.type, "Type");
        const access = this.select(variableAccessOptions, variable.access, "Access");
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "empathy-variable-delete";
        remove.setAttribute("aria-label", `Delete ${variable.name}`);
        remove.title = `Delete ${variable.name}`;
        setIcon(remove, "trash-2");
        const error = document.createElement("div");
        error.className = "empathy-variable-error";
        row.append(name, type, access, remove, error);

        const commit = async (): Promise<void> => {
            const candidate: NarrativeVariable = {
                name: name.value.trim(),
                type: type.value as NarrativeVariableType,
                access: access.value as NarrativeVariableAccess,
            };
            const message = this.variableNameError(candidate.name, index);
            if (message) {
                row.classList.add("is-invalid");
                error.textContent = message;
                name.focus();
                return;
            }
            const variables = [...this.host.getVariables()];
            variables[index] = candidate;
            await this.host.setVariables(variables);
        };
        name.addEventListener("change", () => void commit());
        type.addEventListener("change", () => void commit());
        access.addEventListener("change", () => void commit());
        remove.addEventListener("click", () => void this.deleteVariable(variable));
        return row;
    }

    private newVariableForm(table?: string): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const form = document.createElement("section");
        form.className = "empathy-variable-new";
        const nameField = document.createElement("div");
        nameField.className = "empathy-variable-name-field";
        const name = document.createElement("input");
        name.className = "empathy-variable-new-name";
        name.type = "text";
        name.value = table ? `${table}.` : "";
        name.placeholder = "table_name.variable_name";
        name.spellcheck = false;
        name.setAttribute("aria-label", table ? `New variable in ${table}` : "New qualified variable name");
        nameField.append(name);
        const type = this.select(variableTypeOptions, NarrativeVariableType.BOOLEAN, "Type");
        const access = this.select(variableAccessOptions, NarrativeVariableAccess.READ_WRITE, "Access");
        const add = document.createElement("button");
        add.type = "button";
        add.className = "mod-cta empathy-variable-new-confirm";
        add.title = "Add variable";
        add.setAttribute("aria-label", "Add variable");
        setIcon(add, "check");
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "empathy-variable-new-cancel";
        cancel.title = "Cancel";
        cancel.setAttribute("aria-label", "Cancel adding variable");
        setIcon(cancel, "x");
        cancel.hidden = this.host.getVariables().length === 0;
        const error = document.createElement("div");
        error.className = "empathy-variable-error";
        form.append(nameField, type, access, add, cancel, error);

        const create = async (): Promise<void> => {
            const variable: NarrativeVariable = {
                name: name.value.trim(),
                type: type.value as NarrativeVariableType,
                access: access.value as NarrativeVariableAccess,
            };
            const message = this.variableNameError(variable.name);
            if (message) {
                error.textContent = message;
                name.focus();
                return;
            }
            const selectCreated = this.selectCreated;
            this.selectCreated = undefined;
            this.creatingFor = undefined;
            await this.host.setVariables([...this.host.getVariables(), variable]);
            selectCreated?.(variable);
        };
        add.addEventListener("click", () => void create());
        cancel.addEventListener("click", () => {
            this.creatingFor = undefined;
            this.selectCreated = undefined;
            this.render();
        });
        name.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                void create();
            }
        });
        return form;
    }

    private variableNameError(name: string, editedIndex?: number): string | undefined {
        if (!parseVariableName(name)) return "Use exactly table.variable with two non-empty parts.";
        if (this.host.getVariables().some((variable, index) => index !== editedIndex && variable.name === name)) {
            return `Variable ${name} already exists.`;
        }
        return undefined;
    }

    private select(options: ReadonlyArray<readonly [string, string]>, selected: string, label: string): HTMLSelectElement {
        const select = this.contentEl.ownerDocument.createElement("select");
        select.setAttribute("aria-label", label);
        select.title = label;
        for (const [value, text] of options) {
            const option = this.contentEl.ownerDocument.createElement("option");
            option.value = value;
            option.textContent = text;
            select.append(option);
        }
        select.value = selected;
        return select;
    }

    private async deleteVariable(variable: NarrativeVariable): Promise<void> {
        const usages = this.host.getUsageCount(variable.name);
        if (!await this.confirmVariableDeletion(variable, usages)) return;
        await this.host.setVariables(this.host.getVariables().filter((item) => item.name !== variable.name));
    }

    private confirmVariableDeletion(variable: NarrativeVariable, usages: number): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            let confirmed = false;
            modal.titleEl.textContent = "Delete variable?";
            const copy = modal.contentEl.createDiv({ cls: "empathy-variable-confirm-copy" });
            copy.createEl("p", { text: `Delete ${variable.name}?` });
            if (usages > 0) {
                copy.createEl("p", {
                    text: `It is referenced ${usages} time${usages === 1 ? "" : "s"}. Those references will remain missing and compilation will fail until they are fixed.`,
                });
            }
            const actions = modal.contentEl.createDiv({ cls: "empathy-modal-actions" });
            const cancel = actions.createEl("button", { text: "Cancel" });
            const remove = actions.createEl("button", { cls: "mod-warning empathy-variable-confirm-delete", text: "Delete variable" });
            cancel.addEventListener("click", () => modal.close());
            remove.addEventListener("click", () => { confirmed = true; modal.close(); });
            modal.onClose = () => {
                modal.contentEl.replaceChildren();
                resolve(confirmed);
            };
            modal.open();
        });
    }
}
