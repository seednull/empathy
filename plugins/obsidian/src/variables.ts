import { ItemView, Modal, Notice, setIcon, WorkspaceLeaf } from "obsidian";

import {
    AtomSource,
    NarrativeVariable,
    NarrativeVariableAccess,
    NarrativeVariableType,
    parseVariableName,
} from "./compile";

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
    compileActiveCanvas(): Promise<void>;
    getAtomSources(): readonly AtomSource[];
    renameAtomKey(source: AtomSource, key: string): string | undefined;
    generateAtomKey(source: AtomSource): string | undefined;
    removeAtomKey(source: AtomSource): string | undefined;
    goToAtomSource(source: AtomSource): boolean;
}

export class EmpathyPanelView extends ItemView {
    private selectCreated?: (variable: NarrativeVariable) => void;
    private creatingFor?: string | null;
    private compiling = false;
    private atomQuery = "";

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

    startCreating(selectCreated?: (variable: NarrativeVariable) => void): void {
        this.selectCreated = selectCreated;
        this.creatingFor = this.host.getVariables().length > 0 ? null : undefined;
        this.render();
        const target = this.contentEl.querySelector<HTMLInputElement>(".empathy-variable-new-name");
        target?.focus();
        target?.select();
    }

    private render(): void {
        this.contentEl.replaceChildren();
        this.contentEl.className = "view-content empathy-panel-view";
        this.contentEl.append(this.panelHeader(), this.variablesSection(), this.atomsSection());
    }

    private panelHeader(): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const header = document.createElement("header");
        header.className = "empathy-panel-header";
        const title = document.createElement("h2");
        title.textContent = "Empathy";
        const compile = document.createElement("button");
        compile.type = "button";
        compile.className = "mod-cta empathy-panel-compile";
        const icon = document.createElement("span");
        setIcon(icon, "code-2");
        const text = document.createElement("span");
        text.textContent = this.compiling ? "Compiling…" : "Compile active Canvas";
        compile.disabled = this.compiling;
        compile.append(icon, text);
        compile.addEventListener("click", () => void this.compile(compile, text));
        header.append(title, compile);
        return header;
    }

    private async compile(button: HTMLButtonElement, text: HTMLElement): Promise<void> {
        if (this.compiling) return;
        this.compiling = true;
        button.disabled = true;
        text.textContent = "Compiling…";
        try {
            await this.host.compileActiveCanvas();
        } finally {
            this.compiling = false;
            if (button.isConnected) {
                button.disabled = false;
                text.textContent = "Compile active Canvas";
            }
        }
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

    private atomsSection(): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const section = document.createElement("section");
        section.className = "empathy-atoms-section";
        const heading = document.createElement("div");
        heading.className = "empathy-panel-section-heading";
        const title = document.createElement("h3");
        title.textContent = "Atoms";
        const intro = document.createElement("p");
        intro.textContent = "Optional project IDs for authored text in the active Canvas.";
        heading.append(title, intro);
        const search = document.createElement("input");
        search.type = "search";
        search.className = "empathy-atom-search";
        search.placeholder = "Search ID or text…";
        search.setAttribute("aria-label", "Search atoms by ID, character, or authored text");
        search.value = this.atomQuery;
        section.append(heading, search);
        const results = document.createElement("div");
        section.append(results);
        const renderResults = (): void => {
            this.atomQuery = search.value;
            results.replaceChildren();
            const query = this.atomQuery.trim().toLowerCase();
            const atoms = [...this.host.getAtomSources()].filter((source) => {
                const id = source.key ?? `${source.nodeKind}_${source.value}`;
                return !query || id.includes(query) || source.text.toLowerCase().includes(query) ||
                    source.character?.toLowerCase().includes(query);
            }).sort((left, right) => {
                const leftId = left.key ?? `${left.nodeKind}_${left.value}`;
                const rightId = right.key ?? `${right.nodeKind}_${right.value}`;
                if (leftId !== rightId) return leftId < rightId ? -1 : 1;
                if (left.type !== right.type) return left.type < right.type ? -1 : 1;
                if (left.value !== right.value) return left.value - right.value;
                return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
            });
            if (atoms.length === 0) {
                const empty = document.createElement("div");
                empty.className = "empathy-atoms-empty";
                empty.textContent = query ? "No matching atoms" : "No authored LINE or CHOICE atoms in the active Canvas";
                results.append(empty);
                return;
            }
            results.append(...atoms.map((source) => this.atomRow(source)));
        };
        search.addEventListener("input", renderResults);
        renderResults();
        return section;
    }

    private atomRow(source: AtomSource): HTMLElement {
        const document = this.contentEl.ownerDocument;
        const row = document.createElement("article");
        row.className = "empathy-atom-row";
        const sourceDescription = source.character ? `${source.character}: ${source.text}` : source.text;
        const rowIdentity = `${source.type}:${source.nodeId}:${source.value}`;
        const stubId = `${source.nodeKind}_${source.value}`;
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
        text.textContent = source.character ? `${source.character}: “${source.text}”` : `“${source.text}”`;
        text.title = text.textContent;
        const actions = document.createElement("div");
        actions.className = "empathy-atom-actions";
        type AtomControl = "id" | "generate" | "source";
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
        ): HTMLButtonElement => {
            const button = document.createElement("button");
            button.type = "button";
            button.title = title;
            button.dataset.empathyAtomAction = name;
            button.setAttribute("aria-label", `${title} for ${sourceDescription}`);
            setIcon(button, icon);
            button.addEventListener("mousedown", (event) => event.preventDefault());
            button.addEventListener("click", activate);
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
