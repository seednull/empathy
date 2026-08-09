import { strict as assert } from "node:assert";
import { test } from "node:test";

import { EmpathyBytecodeInstructionSize, EmpathyBytecodeOpcode } from "./bytecode";
import {
    saveCanvasArtifact,
    SystemSaveDialogOptions,
} from "./artifacts";
import {
    convertedEmpathyNodeData,
    EmpathyCanvasIntegration,
    filterNarrativeCharacters,
    formatChoiceBadge,
    formatTransitionBadge,
    repairDuplicatedNodeAtoms,
    selectNarrativeCharacter,
} from "./canvas";
import {
    allocateAuthoredAtom,
    AuthoredAtom,
    AuthoredAtomType,
    generatedAtomKey,
    isValidAtomKey,
    MAXIMUM_ATOM_KEY_LENGTH,
} from "./atoms";
import {
    createNarrativeCharacter,
    NarrativeCharacter,
} from "./characters";
import {
    Canvas,
    CanvasEdge,
    CanvasEdgeData,
    CanvasNode,
    CanvasNodeData,
    characterUsageCount,
    collectCharacterAtoms,
    collectCanvasAtoms,
    compileCanvas,
    EmpathyCanvasNodeKind,
    escapeCStringUtf8,
    generateHeader,
    isValidHeaderPrefix,
    NarrativeAssignment,
    NarrativeCondition,
    NarrativeChoice,
    NarrativeVariable,
    parseVariableName,
    validateCanvas,
    validateCharacterConfiguration,
} from "./compile";

class MockNode implements CanvasNode {
    constructor(readonly id: string, private data: CanvasNodeData) {}
    getData(): CanvasNodeData { return { id: this.id, type: "text", text: "", ...this.data }; }
    setData(data: CanvasNodeData): void { this.data = data; }
}

class MockEdge implements CanvasEdge {
    readonly from: { node: CanvasNode };
    readonly to: { node: CanvasNode };
    constructor(readonly id: string, from: CanvasNode, to: CanvasNode, private data: CanvasEdgeData = {}) {
        this.from = { node: from };
        this.to = { node: to };
    }
    getData(): CanvasEdgeData { return { id: this.id, ...this.data }; }
    setData(data: CanvasEdgeData): void { this.data = data; }
}

class MockMenuItem {
    title = "";
    section = "";
    icon = "";
    click?: () => void;
    setTitle(value: string): this { this.title = value; return this; }
    setSection(value: string): this { this.section = value; return this; }
    setIcon(value: string): this { this.icon = value; return this; }
    onClick(callback: () => void): this { this.click = callback; return this; }
}

class MockMenu {
    readonly items: MockMenuItem[] = [];
    addItem(configure: (item: MockMenuItem) => unknown): this {
        const item = new MockMenuItem();
        configure(item);
        this.items.push(item);
        return this;
    }
}

let nextTestLineAtom = 100;
let nextTestChoiceAtom = 70;

function choice(text: string, condition?: NarrativeCondition, value = nextTestChoiceAtom++, key?: string): NarrativeChoice {
    return { atom: { value, ...(key === undefined ? {} : { key }) }, text, ...(condition ? { condition } : {}) };
}

function choices(...texts: string[]): NarrativeChoice[] {
    return texts.map((text) => choice(text));
}

function node(
    id: string,
    kind: string,
    data: Partial<CanvasNodeData> = {},
): MockNode {
    const normalized: CanvasNodeData = {
        text: kind === EmpathyCanvasNodeKind.ENTRY ? id : "",
        empathyKind: kind,
        ...data,
    };
    if ((kind === EmpathyCanvasNodeKind.SAY || kind === EmpathyCanvasNodeKind.LINE) && !normalized.empathyLineAtom) {
        normalized.empathyLineAtom = { value: nextTestLineAtom++ };
    }
    return new MockNode(id, normalized);
}

function portalNode(
    id: string,
    kind: typeof EmpathyCanvasNodeKind.PORTAL_RECEIVER | typeof EmpathyCanvasNodeKind.PORTAL_TRANSMITTER,
    portalId = "portal-a",
): MockNode {
    return node(id, kind, {
        empathyPortalId: portalId,
        ...(kind === EmpathyCanvasNodeKind.PORTAL_TRANSMITTER ? { empathyPortalName: "A" } : {}),
    });
}

function graph(nodes: MockNode[], edges: MockEdge[]): Canvas {
    return {
        nodes: new Map(nodes.map((value) => [value.id, value])),
        edges: new Map(edges.map((value) => [value.id, value])),
    };
}

const variables: NarrativeVariable[] = [
    { name: "world.radio_found", type: "boolean", access: "read-write" },
    { name: "npc.trust", type: "float", access: "read-write" },
    { name: "world.time", type: "float", access: "read" },
    { name: "quest.stage", type: "integer", access: "read-write" },
];

const mara: NarrativeCharacter = { atom: { value: 12, key: "chr_mara" }, name: "Мара" };

interface Instruction { offset: number; opcode: number; size: number }

function decode(bytecode: Uint8Array): Instruction[] {
    const sizes = new Map<number, number>();
    for (const name of Object.keys(EmpathyBytecodeOpcode) as Array<keyof typeof EmpathyBytecodeOpcode>) {
        sizes.set(EmpathyBytecodeOpcode[name], EmpathyBytecodeInstructionSize[name]);
    }
    const result: Instruction[] = [];
    for (let offset = 0; offset < bytecode.length;) {
        const opcode = bytecode[offset];
        const size = sizes.get(opcode);
        assert.notEqual(size, undefined, `unknown opcode at ${offset}`);
        result.push({ offset, opcode, size: size! });
        offset += size!;
        assert.ok(offset <= bytecode.length, "instruction crosses the bytecode boundary");
    }
    return result;
}

function assertJumpTargetsOnInstructionBoundaries(bytecode: Uint8Array): void {
    const instructions = decode(bytecode);
    const boundaries = new Set(instructions.map(({ offset }) => offset));
    for (const instruction of instructions) {
        if (
            instruction.opcode !== EmpathyBytecodeOpcode.JUMP &&
            instruction.opcode !== EmpathyBytecodeOpcode.JUMP_FALSE &&
            instruction.opcode !== EmpathyBytecodeOpcode.JUMP_TRUE
        ) continue;
        const target = Number(view(bytecode).getBigUint64(instruction.offset + 1, true));
        assert.ok(boundaries.has(target), `jump at ${instruction.offset} targets non-instruction byte ${target}`);
    }
}

function yieldedAtomValues(bytecode: Uint8Array, atomType: number): number[] {
    return decode(bytecode).flatMap((instruction) => {
        if (instruction.opcode !== EmpathyBytecodeOpcode.YIELD_PUSH_ATOM ||
            view(bytecode).getUint32(instruction.offset + 1, true) !== atomType) return [];
        return [view(bytecode).getUint32(instruction.offset + 5, true)];
    });
}

interface ChoiceDispatchResult {
    ended: boolean;
    stack: number[];
    targetOffset?: number;
}

function executeChoiceDispatch(
    bytecode: Uint8Array,
    choiceOffset: number,
    selected: number,
    targetOffsets: ReadonlySet<number>,
    parameters: readonly number[] = [],
): ChoiceDispatchResult {
    const instructions = decode(bytecode);
    const byOffset = new Map(instructions.map((instruction) => [instruction.offset, instruction]));
    const take = instructions.find(({ offset, opcode }) =>
        offset >= choiceOffset && opcode === EmpathyBytecodeOpcode.YIELD_TAKE);
    assert.ok(take, "CHOICE dispatch must take the host response");
    const stack = [selected];
    let offset = take.offset + take.size;
    for (let step = 0; step < 100; ++step) {
        if (targetOffsets.has(offset)) return { ended: false, stack, targetOffset: offset };
        const instruction = byOffset.get(offset);
        assert.ok(instruction, `CHOICE dispatch reached non-instruction byte ${offset}`);
        const next = offset + instruction.size;
        switch (instruction.opcode) {
            case EmpathyBytecodeOpcode.DUP:
                assert.ok(stack.length > 0);
                stack.push(stack.at(-1)!);
                offset = next;
                break;
            case EmpathyBytecodeOpcode.PUSH_U32:
                stack.push(view(bytecode).getUint32(offset + 1, true));
                offset = next;
                break;
            case EmpathyBytecodeOpcode.PUSH_ATOM:
                stack.push(view(bytecode).getUint32(offset + 5, true));
                offset = next;
                break;
            case EmpathyBytecodeOpcode.PUSH_U8:
                stack.push(bytecode[offset + 1]);
                offset = next;
                break;
            case EmpathyBytecodeOpcode.PUSH_F32:
                stack.push(view(bytecode).getFloat32(offset + 1, true));
                offset = next;
                break;
            case EmpathyBytecodeOpcode.LOAD:
                stack.push(parameters[view(bytecode).getUint32(offset + 1, true)] ?? 0);
                offset = next;
                break;
            case EmpathyBytecodeOpcode.EQUAL: {
                assert.ok(stack.length >= 2);
                const right = stack.pop()!;
                const left = stack.pop()!;
                stack.push(left === right ? 1 : 0);
                offset = next;
                break;
            }
            case EmpathyBytecodeOpcode.GREATER_EQUAL: {
                assert.ok(stack.length >= 2);
                const right = stack.pop()!;
                const left = stack.pop()!;
                stack.push(left >= right ? 1 : 0);
                offset = next;
                break;
            }
            case EmpathyBytecodeOpcode.JUMP_FALSE: {
                assert.ok(stack.length > 0);
                const condition = stack.pop()!;
                offset = condition === 0
                    ? Number(view(bytecode).getBigUint64(offset + 1, true))
                    : next;
                break;
            }
            case EmpathyBytecodeOpcode.DROP:
                assert.ok(stack.length > 0);
                stack.pop();
                offset = next;
                break;
            case EmpathyBytecodeOpcode.JUMP:
                offset = Number(view(bytecode).getBigUint64(offset + 1, true));
                break;
            case EmpathyBytecodeOpcode.END:
                return { ended: true, stack };
            default:
                assert.fail(`unexpected opcode ${instruction.opcode} in CHOICE dispatch`);
        }
    }
    assert.fail("CHOICE dispatch did not terminate");
}

function executeChoiceRequest(
    bytecode: Uint8Array,
    choiceOffset: number,
    parameters: readonly number[],
): { ended: boolean; choices: number[] } {
    const instructions = decode(bytecode);
    const byOffset = new Map(instructions.map((instruction) => [instruction.offset, instruction]));
    const stack: number[] = [];
    const choices: number[] = [];
    let offset = choiceOffset;
    for (let step = 0; step < 200; ++step) {
        const instruction = byOffset.get(offset);
        assert.ok(instruction, `CHOICE request reached non-instruction byte ${offset}`);
        const next = offset + instruction.size;
        switch (instruction.opcode) {
            case EmpathyBytecodeOpcode.PUSH_U32:
                stack.push(view(bytecode).getUint32(offset + 1, true));
                offset = next;
                break;
            case EmpathyBytecodeOpcode.PUSH_U8:
                stack.push(bytecode[offset + 1]);
                offset = next;
                break;
            case EmpathyBytecodeOpcode.PUSH_F32:
                stack.push(view(bytecode).getFloat32(offset + 1, true));
                offset = next;
                break;
            case EmpathyBytecodeOpcode.LOAD:
                stack.push(parameters[view(bytecode).getUint32(offset + 1, true)] ?? 0);
                offset = next;
                break;
            case EmpathyBytecodeOpcode.YIELD_PUSH_ATOM:
                choices.push(view(bytecode).getUint32(offset + 5, true));
                offset = next;
                break;
            case EmpathyBytecodeOpcode.ADD: {
                const right = stack.pop()!;
                const left = stack.pop()!;
                stack.push(left + right);
                offset = next;
                break;
            }
            case EmpathyBytecodeOpcode.DUP:
                stack.push(stack.at(-1)!);
                offset = next;
                break;
            case EmpathyBytecodeOpcode.DROP:
                stack.pop();
                offset = next;
                break;
            case EmpathyBytecodeOpcode.EQUAL: {
                const right = stack.pop()!;
                const left = stack.pop()!;
                stack.push(left === right ? 1 : 0);
                offset = next;
                break;
            }
            case EmpathyBytecodeOpcode.GREATER_EQUAL: {
                const right = stack.pop()!;
                const left = stack.pop()!;
                stack.push(left >= right ? 1 : 0);
                offset = next;
                break;
            }
            case EmpathyBytecodeOpcode.JUMP_FALSE:
                offset = stack.pop() === 0 ? Number(view(bytecode).getBigUint64(offset + 1, true)) : next;
                break;
            case EmpathyBytecodeOpcode.YIELD:
                assert.equal(stack.length, 0);
                return { ended: false, choices };
            case EmpathyBytecodeOpcode.END:
                assert.equal(stack.length, 0);
                return { ended: true, choices };
            default:
                assert.fail(`unexpected opcode ${instruction.opcode} in CHOICE request`);
        }
    }
    assert.fail("CHOICE request did not terminate or yield");
}

function testAllocator() {
    const next = { line: 0, choice: 0 };
    return (
        type: typeof AuthoredAtomType.LINE | typeof AuthoredAtomType.CHOICE,
        usedValues: ReadonlySet<number>,
    ) => {
        const result = allocateAuthoredAtom(type, next[type], usedValues);
        next[type] = result.nextValue;
        return result.atom;
    };
}

function view(bytecode: Uint8Array): DataView {
    return new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);
}

function simpleEndGraph(): { canvas: Canvas; entry: MockNode; end: MockNode } {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY, { text: "start" });
    const end = node("end", EmpathyCanvasNodeKind.END);
    return { canvas: graph([entry, end], [new MockEdge("entry-end", entry, end)]), entry, end };
}

function setGraph(assignments: NarrativeAssignment[]): Canvas {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const set = node("set", EmpathyCanvasNodeKind.SET, { empathyAssignments: assignments });
    const end = node("end", EmpathyCanvasNodeKind.END);
    return graph([entry, set, end], [new MockEdge("entry-set", entry, set), new MockEdge("set-end", set, end)]);
}

test("saves header and bytecode independently through native file dialogs", async () => {
    const result = compileCanvas(simpleEndGraph().canvas, variables);
    const dialogOptions: SystemSaveDialogOptions[] = [];
    const selectedPaths = ["D:\\exports\\Chosen.h", "E:\\build\\Radio Story.empathy.bin"];
    const writes: Array<{ filePath: string; data: string | Uint8Array; encoding?: "utf8" }> = [];
    const dialog = {
        showSaveDialog: async (options: SystemSaveDialogOptions) => {
            dialogOptions.push(options);
            return { canceled: false, filePath: selectedPaths[dialogOptions.length - 1] };
        },
    };
    const fileSystem = {
        writeFile: async (filePath: string, data: string | Uint8Array, encoding?: "utf8") => {
            writes.push({ filePath, data, encoding });
        },
    };

    assert.equal(await saveCanvasArtifact(
        dialog,
        fileSystem,
        result,
        { kind: "header", headerPrefix: "Game_Api" },
    ), selectedPaths[0]);
    assert.equal(await saveCanvasArtifact(
        dialog,
        fileSystem,
        result,
        { kind: "bytecode", canvasName: "Radio Story" },
    ), selectedPaths[1]);
    assert.deepEqual(dialogOptions, [
        {
            title: "Save Empathy header",
            defaultPath: "Game_Api.empathy.h",
            filters: [
                { name: "C/C++ header", extensions: ["h"] },
                { name: "All Files", extensions: ["*"] },
            ],
            properties: ["showOverwriteConfirmation"],
        },
        {
            title: "Save Empathy bytecode",
            defaultPath: "Radio Story.empathy.bin",
            filters: [
                { name: "Empathy bytecode", extensions: ["bin"] },
                { name: "All Files", extensions: ["*"] },
            ],
            properties: ["showOverwriteConfirmation"],
        },
    ]);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], {
        filePath: selectedPaths[0],
        data: generateHeader(result, "Game_Api"),
        encoding: "utf8",
    });
    assert.match(writes[0].data as string, /typedef enum Game_Api_AtomType_t/);
    assert.match(writes[0].data as string, /#define GAME_API_LINE_COUNT/);
    assert.match(writes[0].data as string, /\bgame_api_line_atoms\b/);
    assert.doesNotMatch(writes[0].data as string, /Radio_Story/);
    assert.equal(writes[1].filePath, selectedPaths[1]);
    assert.deepEqual(writes[1].data, result.bytecode);
    assert.equal(writes[1].encoding, undefined);
});

test("does not write an artifact when its native save dialog is canceled", async () => {
    const result = compileCanvas(simpleEndGraph().canvas, variables);
    const replies = [
        { canceled: true, filePath: "D:\\ignored.empathy.h" },
        { canceled: false },
    ];
    let dialogCount = 0;
    let writeCount = 0;
    const dialog = {
        showSaveDialog: async (_options: SystemSaveDialogOptions) => replies[dialogCount++],
    };
    const fileSystem = {
        writeFile: async (_filePath: string, _data: string | Uint8Array, _encoding?: "utf8") => {
            ++writeCount;
        },
    };

    for (const request of [
        { kind: "header", headerPrefix: "Story" },
        { kind: "bytecode", canvasName: "story" },
    ] as const) {
        assert.equal(await saveCanvasArtifact(dialog, fileSystem, result, request), undefined);
    }
    assert.equal(dialogCount, 2);
    assert.equal(writeCount, 0);
});

test("propagates native dialog and file write failures", async () => {
    const result = compileCanvas(simpleEndGraph().canvas, variables);
    let writeCount = 0;
    await assert.rejects(saveCanvasArtifact({
        showSaveDialog: async (_options: SystemSaveDialogOptions) => { throw new Error("dialog failed"); },
    }, {
        writeFile: async (_filePath: string, _data: string | Uint8Array, _encoding?: "utf8") => {
            ++writeCount;
        },
    }, result, { kind: "header", headerPrefix: "Story" }), /dialog failed/);
    assert.equal(writeCount, 0);

    await assert.rejects(saveCanvasArtifact({
        showSaveDialog: async (_options: SystemSaveDialogOptions) => ({
            canceled: false,
            filePath: "D:\\story.empathy.bin",
        }),
    }, {
        writeFile: async (_filePath: string, _data: string | Uint8Array, _encoding?: "utf8") => {
            throw new Error("write failed");
        },
    }, result, { kind: "bytecode", canvasName: "story" }), /write failed/);
});

test("validates exact manual header prefixes before opening a save dialog", async () => {
    for (const valid of ["Canvas", "Game_Api", "x", "X9", "RaDiO_2", "R".repeat(128)]) {
        assert.equal(isValidHeaderPrefix(valid), true, valid);
    }
    for (const invalid of [
        "",
        " Radio",
        "Radio Story",
        "9Radio",
        "_Radio",
        "Radio_",
        "Radio__Story",
        "Радио",
    ]) {
        assert.equal(isValidHeaderPrefix(invalid), false, invalid);
    }

    const result = compileCanvas(simpleEndGraph().canvas, variables);
    let dialogCount = 0;
    await assert.rejects(saveCanvasArtifact({
        showSaveDialog: async (_options: SystemSaveDialogOptions) => {
            ++dialogCount;
            return { canceled: true };
        },
    }, {
        writeFile: async (_filePath: string, _data: string | Uint8Array, _encoding?: "utf8") => undefined,
    }, result, { kind: "header", headerPrefix: "Radio Story" }), /header prefix/);
    assert.equal(dialogCount, 0);
    assert.throws(() => generateHeader(result, "Radio Story"), /header prefix/);
    assert.match(generateHeader(result, "RaDiO_2"), /typedef enum RaDiO_2_AtomType_t/);
});

test("parses exactly one qualified-name separator", () => {
    assert.deepEqual(parseVariableName("world.time"), { tableName: "world", variableName: "time" });
    for (const invalid of ["world", ".time", "world.", "world.weather.time", " world.time"]) {
        assert.equal(parseVariableName(invalid), undefined);
    }
});

test("formats independent conditional and else edge badges from metadata", () => {
    assert.equal(formatTransitionBadge({
        empathyCondition: { variable: "npc.trust", comparison: ">=", literal: "0.5" },
        empathyConditionOrder: 0,
    }), "if npc.trust ≥ 0.5");
    assert.equal(formatTransitionBadge({ empathyElse: true }), "else");
    assert.equal(formatTransitionBadge({
        empathyCondition: { variable: "world.radio_found", comparison: "==", literal: "true" },
        empathyConditionOrder: 2,
    }), "if world.radio_found is true");
});

test("formats CHOICE badges from node options and ignores native edge labels", () => {
    const climb = choice("Climb", undefined, 10);
    const leave = choice("Leave", undefined, 20);
    assert.equal(formatChoiceBadge({ empathyChoiceAtom: 20, label: "Unrelated author text" }, [climb, leave]), "Leave");
    assert.equal(formatChoiceBadge({ label: "Anything the author wants" }, [climb]), "Unlinked choice");
});

test("adds every Empathy node kind to the connection-drop menu and preserves edge placement", () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const workspace = {
        getLeavesOfType: () => [],
        on: (name: string, callback: (...args: never[]) => void) => {
            handlers.set(name, callback as unknown as (...args: unknown[]) => void);
            return {};
        },
        onLayoutReady: (_callback: () => void) => undefined,
    };
    const plugin = {
        app: { workspace },
        registerEvent: (_event: unknown) => undefined,
        register: (_cleanup: () => void) => undefined,
    };
    const notices: string[] = [];
    const integration = new EmpathyCanvasIntegration(plugin as never, {
        setIcon: () => undefined,
        setTooltip: () => undefined,
        showNotice: (message: string) => notices.push(message),
        getVariables: () => [],
        openPanel: () => undefined,
        allocateAtom: () => ({ value: 1 }),
        atomsChanged: () => undefined,
    } as never);
    const createdNode = { id: "created" };
    const createCalls: unknown[][] = [];
    const connectCalls: unknown[][] = [];
    const harness = integration as unknown as {
        createNode: (...args: unknown[]) => unknown;
        connectNodes: (...args: unknown[]) => void;
    };
    harness.createNode = (...args) => { createCalls.push(args); return createdNode; };
    harness.connectNodes = (...args) => { connectCalls.push(args); };
    integration.register();

    const removed: unknown[] = [];
    const canvas = { readonly: false, removeEdge: (edge: unknown) => removed.push(edge) };
    const source = { id: "source", canvas };
    const pendingEdge = {
        id: "temporary-edge",
        canvas,
        from: { node: source, side: "right", end: "from" },
        to: { node: { x: 640, y: 360 }, side: "left", end: "to" },
    };
    const menu = new MockMenu();
    const handler = handlers.get("canvas:node-connection-drop-menu");
    assert.ok(handler);
    handler(menu, source, pendingEdge);
    assert.deepEqual(menu.items.map(({ title }) => title), [
        "Add Empathy ENTRY",
        "Add Empathy SAY",
        "Add Empathy LINE",
        "Add Empathy CHOICE",
        "Add Empathy SET",
        "Add Empathy RECEIVER",
        "Add Empathy TRANSMITTER",
        "Add Empathy END",
    ]);
    assert.ok(menu.items.every(({ section, icon, click }) => section === "action" && icon.length > 0 && click));

    menu.items.find(({ title }) => title === "Add Empathy LINE")!.click!();
    assert.deepEqual(removed, [pendingEdge]);
    assert.deepEqual(createCalls, [[canvas, EmpathyCanvasNodeKind.LINE, { x: 640, y: 360 }, { width: 360, height: 160 }, "left"]]);
    assert.deepEqual(connectCalls, [[source, createdNode, "right", "left", "temporary-edge"]]);
    assert.deepEqual(notices, []);

    canvas.readonly = true;
    const readonlyMenu = new MockMenu();
    handler(readonlyMenu, source, pendingEdge);
    assert.deepEqual(readonlyMenu.items, []);
});

test("keeps a replacement edge distinct from the native provisional edge", () => {
    const integration = new EmpathyCanvasIntegration({} as never, {} as never);
    const pendingId = "123456789abcdef0";
    const imported: Array<{ nodes: CanvasNodeData[]; edges: CanvasEdgeData[] }> = [];
    let saves = 0;
    const edges = new Map<string, CanvasEdgeData>();
    const canvas = {
        edges,
        importData: (data: { nodes: CanvasNodeData[]; edges: CanvasEdgeData[] }) => {
            imported.push(data);
            for (const edge of data.edges) edges.set(String(edge.id), edge);
        },
        requestSave: () => { ++saves; },
    };
    const ownerDocument = { defaultView: { crypto: { getRandomValues: (values: Uint32Array) => {
        values[0] = 0x12345678;
        values[1] = 0x9ABCDEF0;
        return values;
    } } } };
    const source = { id: "source", canvas, nodeEl: { ownerDocument }, getData: () => ({ id: "source" }) };
    const target = { id: "target", getData: () => ({ id: "target" }) };
    const harness = integration as unknown as {
        connectNodes: (...args: unknown[]) => void;
    };
    harness.connectNodes(source, target, "right", "left", pendingId);

    assert.equal(imported.length, 1);
    assert.deepEqual(imported[0].nodes, [{ id: "source" }, { id: "target" }]);
    assert.deepEqual(imported[0].edges, [{
        id: `${pendingId}0`,
        fromNode: "source",
        fromSide: "right",
        toNode: "target",
        toSide: "left",
    }]);
    assert.equal(edges.has(pendingId), false);
    assert.equal(edges.has(`${pendingId}0`), true);
    assert.equal(saves, 1);
});

test("rejects obsolete Canvas shapes without migrating their metadata", () => {
    const markerEntry = new MockNode("marker-entry", {
        type: "text",
        text: "Start",
        empathyNodeType: "entry",
    } as CanvasNodeData);
    const markerEnd = node("marker-end", EmpathyCanvasNodeKind.END);
    const markerEdge = new MockEdge("marker-edge", markerEntry, markerEnd);
    const markerCanvas = graph([markerEntry, markerEnd], [markerEdge]);
    const markerSnapshot = JSON.stringify([markerEntry.getData(), markerEnd.getData(), markerEdge.getData()]);
    assert.throws(() => compileCanvas(markerCanvas, variables), /Canvas contains no ENTRY node/);
    assert.equal(JSON.stringify([markerEntry.getData(), markerEnd.getData(), markerEdge.getData()]), markerSnapshot);

    const typedEntry = new MockNode("typed-entry", {
        type: "empathy-entry",
        text: "Start",
        empathyKind: EmpathyCanvasNodeKind.ENTRY,
    });
    const typedEnd = node("typed-end", EmpathyCanvasNodeKind.END);
    const typedEdge = new MockEdge("typed-edge", typedEntry, typedEnd);
    const typedCanvas = graph([typedEntry, typedEnd], [typedEdge]);
    const typedSnapshot = JSON.stringify([typedEntry.getData(), typedEnd.getData(), typedEdge.getData()]);
    assert.throws(() => compileCanvas(typedCanvas, variables), /Canvas contains no ENTRY node/);
    assert.equal(JSON.stringify([typedEntry.getData(), typedEnd.getData(), typedEdge.getData()]), typedSnapshot);

    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const oldChoice = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: [choice("Leave", undefined, 73)] });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const entryEdge = new MockEdge("entry-choice", entry, oldChoice);
    const oldChoiceEdge = new MockEdge("choice-end", oldChoice, end, { empathyChoiceIndex: 0 } as CanvasEdgeData);
    const choiceCanvas = graph([entry, oldChoice, end], [entryEdge, oldChoiceEdge]);
    const choiceSnapshot = JSON.stringify([oldChoice.getData(), oldChoiceEdge.getData()]);
    assert.throws(() => compileCanvas(choiceCanvas, variables), /Obsolete empathyChoiceIndex metadata is not supported/);
    assert.equal(JSON.stringify([oldChoice.getData(), oldChoiceEdge.getData()]), choiceSnapshot);
    oldChoiceEdge.setData({ ...oldChoiceEdge.getData(), empathyChoiceAtom: 73 });
    const mixedChoiceSnapshot = JSON.stringify([oldChoice.getData(), oldChoiceEdge.getData()]);
    assert.throws(() => compileCanvas(choiceCanvas, variables), /Obsolete empathyChoiceIndex metadata is not supported/);
    assert.equal(JSON.stringify([oldChoice.getData(), oldChoiceEdge.getData()]), mixedChoiceSnapshot);

    const say = node("say", EmpathyCanvasNodeKind.SAY, {
        text: "Combined old dialogue",
        empathyCharacter: "Mara",
    });
    const sayEnd = node("say-end", EmpathyCanvasNodeKind.END);
    const sayCanvas = graph(
        [entry, say, sayEnd],
        [new MockEdge("entry-say", entry, say), new MockEdge("say-end", say, sayEnd)],
    );
    const saySnapshot = JSON.stringify(say.getData());
    assert.throws(() => compileCanvas(sayCanvas, variables), /Obsolete empathyCharacter metadata is not supported/);
    assert.equal(JSON.stringify(say.getData()), saySnapshot);
});

test("derives real parameter tables by first variable occurrence", () => {
    const result = compileCanvas(simpleEndGraph().canvas, variables);
    assert.deepEqual(result.tables, [
        { name: "world", index: 0 },
        { name: "npc", index: 1 },
        { name: "quest", index: 2 },
    ]);
    assert.deepEqual(result.parameters.map(({ name, tableIndex, parameterIndex }) => ({ name, tableIndex, parameterIndex })), [
        { name: "world.radio_found", tableIndex: 0, parameterIndex: 0 },
        { name: "npc.trust", tableIndex: 1, parameterIndex: 1 },
        { name: "world.time", tableIndex: 0, parameterIndex: 2 },
        { name: "quest.stage", tableIndex: 2, parameterIndex: 3 },
    ]);
});

test("patches a direct continuation jump to an instruction boundary", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const line = node("line", EmpathyCanvasNodeKind.LINE, { text: "Continue" });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(graph(
        [entry, line, end],
        [new MockEdge("entry-line", entry, line), new MockEdge("line-end", line, end)],
    ), variables);
    assertJumpTargetsOnInstructionBoundaries(result.bytecode);
    const jump = decode(result.bytecode).find(({ opcode }) => opcode === EmpathyBytecodeOpcode.JUMP)!;
    assert.equal(Number(view(result.bytecode).getBigUint64(jump.offset + 1, true)), result.nodeOffsets.get("end"));
});

test("lowers SET values and arithmetic with global parameter indices", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const set = node("set", EmpathyCanvasNodeKind.SET, { empathyAssignments: [
        { variable: "world.radio_found", operation: "=", literal: "true" },
        { variable: "npc.trust", operation: "+=", literal: "0.1" },
        { variable: "quest.stage", operation: "-=", literal: "1" },
    ] });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(graph(
        [entry, set, end],
        [new MockEdge("e0", entry, set), new MockEdge("e1", set, end)],
    ), variables);
    const instructions = decode(result.bytecode);
    assert.deepEqual(instructions.map(({ opcode }) => opcode), [
        EmpathyBytecodeOpcode.PUSH_U8, EmpathyBytecodeOpcode.STORE,
        EmpathyBytecodeOpcode.LOAD, EmpathyBytecodeOpcode.PUSH_F32, EmpathyBytecodeOpcode.ADD,
        EmpathyBytecodeOpcode.STORE,
        EmpathyBytecodeOpcode.LOAD, EmpathyBytecodeOpcode.PUSH_I32, EmpathyBytecodeOpcode.SUB,
        EmpathyBytecodeOpcode.STORE, EmpathyBytecodeOpcode.JUMP, EmpathyBytecodeOpcode.END,
    ]);
    const data = view(result.bytecode);
    const loadStores = instructions.filter(({ opcode }) => opcode === EmpathyBytecodeOpcode.LOAD || opcode === EmpathyBytecodeOpcode.STORE);
    assert.deepEqual(loadStores.map(({ offset }) => data.getUint32(offset + 1, true)), [0, 1, 1, 3, 3]);
    const booleanPush = instructions.find(({ opcode }) => opcode === EmpathyBytecodeOpcode.PUSH_U8)!;
    const floatPush = instructions.find(({ opcode }) => opcode === EmpathyBytecodeOpcode.PUSH_F32)!;
    const integerPush = instructions.find(({ opcode }) => opcode === EmpathyBytecodeOpcode.PUSH_I32)!;
    assert.equal(data.getUint8(booleanPush.offset + 1), 1);
    assert.ok(Math.abs(data.getFloat32(floatPush.offset + 1, true) - 0.1) < 1e-6);
    assert.equal(data.getInt32(integerPush.offset + 1, true), 1);
});

test("allows plain SET assignment to a write-only variable", () => {
    const writeOnly: NarrativeVariable[] = [{ name: "state.value", type: "float", access: "write" }];
    const result = compileCanvas(setGraph([
        { variable: "state.value", operation: "=", literal: "1" },
    ]), writeOnly);
    assert.deepEqual(decode(result.bytecode).map(({ opcode }) => opcode), [
        EmpathyBytecodeOpcode.PUSH_F32,
        EmpathyBytecodeOpcode.STORE,
        EmpathyBytecodeOpcode.JUMP,
        EmpathyBytecodeOpcode.END,
    ]);
});

test("rejects SET += through a write-only variable", () => {
    const writeOnly: NarrativeVariable[] = [{ name: "state.value", type: "float", access: "write" }];
    assert.throws(() => compileCanvas(setGraph([
        { variable: "state.value", operation: "+=", literal: "1" },
    ]), writeOnly), /compound assignment \+= requires both read and write access/);
});

test("rejects SET -= through a write-only variable", () => {
    const writeOnly: NarrativeVariable[] = [{ name: "state.value", type: "float", access: "write" }];
    assert.throws(() => compileCanvas(setGraph([
        { variable: "state.value", operation: "-=", literal: "1" },
    ]), writeOnly), /compound assignment -= requires both read and write access/);
});

test("allows SET compound assignment to a read-write variable", () => {
    const readWrite: NarrativeVariable[] = [{ name: "state.value", type: "float", access: "read-write" }];
    const result = compileCanvas(setGraph([
        { variable: "state.value", operation: "+=", literal: "1" },
    ]), readWrite);
    assert.deepEqual(decode(result.bytecode).map(({ opcode }) => opcode), [
        EmpathyBytecodeOpcode.LOAD,
        EmpathyBytecodeOpcode.PUSH_F32,
        EmpathyBytecodeOpcode.ADD,
        EmpathyBytecodeOpcode.STORE,
        EmpathyBytecodeOpcode.JUMP,
        EmpathyBytecodeOpcode.END,
    ]);
});

test("validates access for every assignment in a SET node", () => {
    const writeOnly: NarrativeVariable[] = [
        { name: "state.first", type: "float", access: "write" },
        { name: "state.second", type: "float", access: "write" },
    ];
    const canvas = setGraph([
        { variable: "state.first", operation: "=", literal: "1" },
        { variable: "state.second", operation: "+=", literal: "1" },
    ]);
    const accessIssues = validateCanvas(canvas, writeOnly)
        .filter(({ message }) => message.includes("read and write access"));
    assert.deepEqual(accessIssues.map(({ message }) => message), [
        "SET assignment 1: compound assignment += requires both read and write access to state.second",
    ]);
    assert.throws(() => compileCanvas(canvas, writeOnly), /SET assignment 1/);
});

test("rejects SET writes through read-only variables", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const set = node("set", EmpathyCanvasNodeKind.SET, { empathyAssignments: [
        { variable: "world.time", operation: "=", literal: "1" },
    ] });
    const end = node("end", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(graph(
        [entry, set, end],
        [new MockEdge("a", entry, set), new MockEdge("b", set, end)],
    ), variables), /read-only/);
});

test("resolves Canvas references by name after variable reordering", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const set = node("set", EmpathyCanvasNodeKind.SET, { empathyAssignments: [
        { variable: "quest.stage", operation: "=", literal: "2" },
    ] });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const canvas = graph([entry, set, end], [new MockEdge("a", entry, set), new MockEdge("b", set, end)]);
    const reordered = [variables[3], variables[0], variables[1], variables[2]];
    const result = compileCanvas(canvas, reordered);
    const store = decode(result.bytecode).find(({ opcode }) => opcode === EmpathyBytecodeOpcode.STORE)!;
    assert.equal(view(result.bytecode).getUint32(store.offset + 1, true), 0);
    assert.equal(set.getData().empathyAssignments?.[0].variable, "quest.stage");
});

test("lowers ordered conditional edges and an else directly", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const say = node("say", EmpathyCanvasNodeKind.SAY, { text: "Can we trust it?", empathyCharacterAtom: mara.atom.value });
    const lineA = node("line-a", EmpathyCanvasNodeKind.LINE, { text: "Yes." });
    const lineB = node("line-b", EmpathyCanvasNodeKind.LINE, { text: "Not yet." });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const condition: NarrativeCondition = { variable: "npc.trust", comparison: ">=", literal: "0.5" };
    const result = compileCanvas(graph(
        [entry, say, lineA, lineB, end],
        [
            new MockEdge("entry-say", entry, say),
            new MockEdge("random-a", say, lineB, { empathyElse: true }),
            new MockEdge("random-z", say, lineA, { empathyCondition: condition, empathyConditionOrder: 0 }),
            new MockEdge("a-end", lineA, end), new MockEdge("b-end", lineB, end),
        ],
    ), variables, [mara]);
    const instructions = decode(result.bytecode);
    const opcodes = instructions.map(({ opcode }) => opcode);
    assert.ok(opcodes.includes(EmpathyBytecodeOpcode.LOAD));
    assert.ok(opcodes.includes(EmpathyBytecodeOpcode.PUSH_F32));
    assert.ok(opcodes.includes(EmpathyBytecodeOpcode.GREATER_EQUAL));
    assert.ok(opcodes.includes(EmpathyBytecodeOpcode.JUMP_FALSE));
    const load = instructions.find(({ opcode }) => opcode === EmpathyBytecodeOpcode.LOAD)!;
    assert.equal(view(result.bytecode).getUint32(load.offset + 1, true), 1);
    assertJumpTargetsOnInstructionBoundaries(result.bytecode);
});

test("rejects conditions that read write-only variables", () => {
    const writeOnly: NarrativeVariable[] = [{ name: "world.secret", type: "boolean", access: "write" }];
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const line = node("line", EmpathyCanvasNodeKind.LINE, { text: "Line" });
    const end = node("end", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(graph(
        [entry, line, end],
        [
            new MockEdge("a", entry, line),
            new MockEdge("b", line, end, {
                empathyCondition: { variable: "world.secret", comparison: "==", literal: "true" },
                empathyConditionOrder: 0,
            }),
        ],
    ), writeOnly), /write-only/);
});

test("rejects more than one else transition from the same node", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const line = node("line", EmpathyCanvasNodeKind.LINE, { text: "Line" });
    const endA = node("end-a", EmpathyCanvasNodeKind.END);
    const endB = node("end-b", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(graph(
        [entry, line, endA, endB],
        [
            new MockEdge("entry-line", entry, line),
            new MockEdge("else-a", line, endA, { empathyElse: true }),
            new MockEdge("else-b", line, endB, { empathyElse: true }),
        ],
    ), variables), /more than one else edge/);
});

test("rejects an evaluation order on an else transition", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const line = node("line", EmpathyCanvasNodeKind.LINE, { text: "Line" });
    const endA = node("end-a", EmpathyCanvasNodeKind.END);
    const endB = node("end-b", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(graph(
        [entry, line, endA, endB],
        [
            new MockEdge("entry-line", entry, line),
            new MockEdge("condition", line, endA, {
                empathyCondition: { variable: "world.radio_found", comparison: "==", literal: "true" },
                empathyConditionOrder: 0,
            }),
            new MockEdge("else", line, endB, { empathyElse: true, empathyConditionOrder: 1 }),
        ],
    ), variables), /else edge cannot have an evaluation order/);
});

test("emits distinct predicate offsets and match values for two ENTRY nodes", () => {
    const entryA = node("entry-a", EmpathyCanvasNodeKind.ENTRY, {
        text: "radio",
        empathyEntryCondition: { variable: "world.radio_found", comparison: "==", literal: "true" },
        empathyEntryMatchValue: "10",
    });
    const entryB = node("entry-b", EmpathyCanvasNodeKind.ENTRY, {
        text: "no radio",
        empathyEntryCondition: { variable: "world.radio_found", comparison: "==", literal: "false" },
        empathyEntryMatchValue: "20",
    });
    const endA = node("end-a", EmpathyCanvasNodeKind.END);
    const endB = node("end-b", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(graph(
        [entryA, entryB, endA, endB],
        [new MockEdge("a", entryA, endA), new MockEdge("b", entryB, endB)],
    ), variables);
    assert.deepEqual(result.entryPoints.map(({ name }) => name), ["radio", "no radio"]);
    assert.notEqual(result.entryPoints[0].predicateOffset, result.entryPoints[1].predicateOffset);
    const instructions = decode(result.bytecode);
    const boundaries = new Set(instructions.map(({ offset }) => offset));
    for (const entryPoint of result.entryPoints) {
        assert.ok(boundaries.has(entryPoint.executionOffset));
        assert.ok(boundaries.has(entryPoint.predicateOffset!));
        const startIndex = instructions.findIndex(({ offset }) => offset === entryPoint.predicateOffset);
        assert.deepEqual(instructions.slice(startIndex, startIndex + 6).map(({ opcode }) => opcode), [
            EmpathyBytecodeOpcode.LOAD, EmpathyBytecodeOpcode.PUSH_U8, EmpathyBytecodeOpcode.EQUAL,
            EmpathyBytecodeOpcode.REJECT_FALSE, EmpathyBytecodeOpcode.PUSH_U32, EmpathyBytecodeOpcode.MATCH,
        ]);
    }
    const data = view(result.bytecode);
    const matches = instructions.filter(({ opcode }) => opcode === EmpathyBytecodeOpcode.PUSH_U32)
        .map(({ offset }) => data.getUint32(offset + 1, true));
    assert.deepEqual(matches, [10, 20]);
});

test("leaves ENTRY without a predicate out of matching", () => {
    const result = compileCanvas(simpleEndGraph().canvas, variables);
    assert.equal(result.entryPoints[0].predicateOffset, undefined);
    assert.match(generateHeader(result, "story"), /\{0u, EMPATHY_PROGRAM_OFFSET_NONE\}/);
});

test("rejects an ENTRY without an explicit name", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY, { text: "" });
    const end = node("end", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(graph(
        [entry, end],
        [new MockEdge("entry-end", entry, end)],
    ), variables), /ENTRY requires a non-empty name/);
});

test("orders CHOICE options only by their authored array order", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choice = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: choices("First", "Second") });
    const first = node("first", EmpathyCanvasNodeKind.END);
    const second = node("second", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(graph(
        [entry, choice, first, second],
        [
            new MockEdge("entry", entry, choice),
            new MockEdge("aaa-id-but-second", choice, second, { label: "Ignored B", empathyChoiceAtom: choice.getData().empathyChoices![1].atom.value }),
            new MockEdge("zzz-id-but-first", choice, first, { label: "Ignored A", empathyChoiceAtom: choice.getData().empathyChoices![0].atom.value }),
        ],
    ), variables);
    assert.deepEqual(result.choices.map(({ text }) => text), ["First", "Second"]);
});

test("terminates invalid CHOICE resume atoms without selecting the final option", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choice = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: choices("First", "Second") });
    const first = node("first", EmpathyCanvasNodeKind.END);
    const second = node("second", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(graph(
        [entry, choice, first, second],
        [
            new MockEdge("entry-choice", entry, choice),
            new MockEdge("choice-first", choice, first, { empathyChoiceAtom: choice.getData().empathyChoices![0].atom.value }),
            new MockEdge("choice-second", choice, second, { empathyChoiceAtom: choice.getData().empathyChoices![1].atom.value }),
        ],
    ), variables);
    const firstOffset = result.nodeOffsets.get("first")!;
    const secondOffset = result.nodeOffsets.get("second")!;
    const targets = new Set([firstOffset, secondOffset]);
    const [firstChoice, secondChoice] = choice.getData().empathyChoices!;
    assert.deepEqual(executeChoiceDispatch(result.bytecode, result.nodeOffsets.get("choice")!, firstChoice.atom.value, targets), {
        ended: false, stack: [], targetOffset: firstOffset,
    });
    assert.deepEqual(executeChoiceDispatch(result.bytecode, result.nodeOffsets.get("choice")!, secondChoice.atom.value, targets), {
        ended: false, stack: [], targetOffset: secondOffset,
    });
    assert.deepEqual(executeChoiceDispatch(result.bytecode, result.nodeOffsets.get("choice")!, 2, targets), {
        ended: true, stack: [],
    });
    assert.deepEqual(executeChoiceDispatch(result.bytecode, result.nodeOffsets.get("choice")!, 0xFFFFFFFF, targets), {
        ended: true, stack: [],
    });
    assertJumpTargetsOnInstructionBoundaries(result.bytecode);
});

test("cleans the CHOICE resume atom before entering a middle branch", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choice = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: choices("First", "Middle", "Final") });
    const first = node("first", EmpathyCanvasNodeKind.END);
    const middle = node("middle", EmpathyCanvasNodeKind.END);
    const final = node("final", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(graph(
        [entry, choice, first, middle, final],
        [
            new MockEdge("entry-choice", entry, choice),
            new MockEdge("choice-first", choice, first, { empathyChoiceAtom: choice.getData().empathyChoices![0].atom.value }),
            new MockEdge("choice-middle", choice, middle, { empathyChoiceAtom: choice.getData().empathyChoices![1].atom.value }),
            new MockEdge("choice-final", choice, final, { empathyChoiceAtom: choice.getData().empathyChoices![2].atom.value }),
        ],
    ), variables);
    const targetOffsets = new Set(["first", "middle", "final"].map((id) => result.nodeOffsets.get(id)!));
    const middleAtom = choice.getData().empathyChoices![1].atom.value;
    assert.deepEqual(
        executeChoiceDispatch(result.bytecode, result.nodeOffsets.get("choice")!, middleAtom, targetOffsets),
        { ended: false, stack: [], targetOffset: result.nodeOffsets.get("middle") },
    );
});

test("does not use author edge labels as CHOICE option text", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choice = node("choice", EmpathyCanvasNodeKind.CHOICE);
    const end = node("end", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(graph(
        [entry, choice, end],
        [
            new MockEdge("a", entry, choice),
            new MockEdge("b", choice, end, { label: "Author note", empathyChoiceAtom: 0 }),
        ],
    ), variables), /must define at least one option/);
});

test("rejects missing and duplicate CHOICE edge links", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choice = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: choices("One", "Two") });
    const one = node("one", EmpathyCanvasNodeKind.END);
    const two = node("two", EmpathyCanvasNodeKind.END);
    const missing = graph(
        [entry, choice, one, two],
        [new MockEdge("a", entry, choice), new MockEdge("b", choice, one), new MockEdge("c", choice, two, { empathyChoiceAtom: choice.getData().empathyChoices![1].atom.value })],
    );
    assert.throws(() => compileCanvas(missing, variables), /not linked to an option/);
    const duplicate = graph(
        [entry, choice, one, two],
        [
            new MockEdge("a", entry, choice),
            new MockEdge("b", choice, one, { empathyChoiceAtom: choice.getData().empathyChoices![0].atom.value }),
            new MockEdge("c", choice, two, { empathyChoiceAtom: choice.getData().empathyChoices![0].atom.value }),
        ],
    );
    assert.throws(() => compileCanvas(duplicate, variables), /linked more than once/);
});

test("rejects CHOICE edges that reference options outside the node set", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choice = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: choices("One", "Two") });
    const one = node("one", EmpathyCanvasNodeKind.END);
    const two = node("two", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(graph(
        [entry, choice, one, two],
        [
            new MockEdge("a", entry, choice),
            new MockEdge("b", choice, one, { empathyChoiceAtom: choice.getData().empathyChoices![0].atom.value }),
            new MockEdge("c", choice, two, { empathyChoiceAtom: 2 }),
        ],
    ), variables), /references missing option atom 2/);
});

test("keeps numeric atom identity automatic while human-readable IDs are explicit", () => {
    const usedValues = new Set<number>();
    const first = allocateAuthoredAtom(AuthoredAtomType.LINE, 0, usedValues);
    assert.deepEqual(first.atom, { value: 0 });
    usedValues.add(first.atom.value);
    const second = allocateAuthoredAtom(AuthoredAtomType.LINE, first.nextValue, usedValues);
    usedValues.add(second.atom.value);
    const third = allocateAuthoredAtom(AuthoredAtomType.LINE, second.nextValue, usedValues);
    assert.deepEqual(second.atom, { value: 1 });
    assert.equal(third.atom.value, 2);
    assert.throws(() => allocateAuthoredAtom(AuthoredAtomType.LINE, Number.NaN, new Set()), /No LINE atom values remain/);
    assert.throws(() => allocateAuthoredAtom(AuthoredAtomType.LINE, -1, new Set()), /No LINE atom values remain/);

    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const line = node("line", EmpathyCanvasNodeKind.LINE, { text: "Ask about the radio", empathyLineAtom: first.atom });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const canvas = graph(
        [entry, line, end],
        [new MockEdge("entry-line", entry, line), new MockEdge("line-end", line, end)],
    );
    assert.deepEqual(validateCanvas(canvas, variables), []);

    const generated = { value: first.atom.value, key: generatedAtomKey(
        AuthoredAtomType.LINE,
        line.getData().text!,
        first.atom.value,
        new Set(),
    ) };
    line.setData({ ...line.getData(), empathyLineAtom: generated });
    assert.deepEqual(line.getData().empathyLineAtom, { value: 0, key: "ask_about_the_radio" });

    line.setData({ ...line.getData(), text: "Leave the tower" });
    assert.deepEqual(line.getData().empathyLineAtom, generated);

    const regenerated = { value: generated.value, key: generatedAtomKey(
        AuthoredAtomType.LINE,
        line.getData().text!,
        generated.value,
        new Set(),
    ) };
    line.setData({ ...line.getData(), empathyLineAtom: regenerated });
    assert.deepEqual(line.getData().empathyLineAtom, { value: 0, key: "leave_the_tower" });

    line.setData({ ...line.getData(), empathyLineAtom: { value: regenerated.value } });
    assert.deepEqual(line.getData().empathyLineAtom, { value: 0 });
    assert.deepEqual(compileCanvas(canvas, variables).lines.map(({ value, key }) => ({ value, key })), [
        { value: 0, key: undefined },
    ]);
});

test("generates bounded collision-safe ASCII IDs from current authored text", () => {
    assert.equal(
        generatedAtomKey(AuthoredAtomType.CHOICE, "Ask about the radio", 73, new Set()),
        "ask_about_the_radio",
    );
    assert.equal(
        generatedAtomKey(AuthoredAtomType.CHOICE, "Спросить про радио", 73, new Set()),
        "sprosit_pro_radio",
    );
    const long = generatedAtomKey(
        AuthoredAtomType.LINE,
        "This deliberately long authored line keeps adding meaningful words beyond the useful identifier boundary",
        1482,
        new Set(),
    );
    assert.ok(long.length <= MAXIMUM_ATOM_KEY_LENGTH);
    assert.ok(isValidAtomKey(long));
    assert.doesNotMatch(long, /_$/);
    assert.equal(
        generatedAtomKey(AuthoredAtomType.CHOICE, "Ask about radio", 73, new Set(["ask_about_radio"])),
        "ask_about_radio_2",
    );
    assert.equal(generatedAtomKey(AuthoredAtomType.LINE, "塔はまだ信号を送っている", 1482, new Set()), "line_1482");
    for (const invalid of ["", "Dialog", "dialog.id", "dialog id", " dialog", "dialog ", "диалог", "_dialog", "dialog-"]) {
        assert.equal(isValidAtomKey(invalid), false, invalid);
    }
});

test("validates, compiles, and generates numeric enum members for unassigned atom IDs", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const line = node("line", EmpathyCanvasNodeKind.LINE, {
        text: "The tower is still transmitting.",
        empathyLineAtom: { value: 1482 },
    });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const canvas = graph(
        [entry, line, end],
        [new MockEdge("entry-line", entry, line), new MockEdge("line-end", line, end)],
    );
    assert.deepEqual(validateCanvas(canvas, variables), []);
    const result = compileCanvas(canvas, variables);
    assert.deepEqual(result.lines.map(({ value, key, text }) => ({ value, key, text })), [{
        value: 1482,
        key: undefined,
        text: "The tower is still transmitting.",
    }]);
    const header = generateHeader(result, "Radio_Story");
    assert.match(header, /typedef enum Radio_Story_LineAtom_t[\s\S]*RADIO_STORY_LINE_1482 = 1482u,[\s\S]*} Radio_Story_LineAtom;/);
    assert.doesNotMatch(header, /^#define (?:RADIO_STORY|Radio_Story)_LINE_1482/m);
    assert.match(header, /\{RADIO_STORY_LINE_1482, 0, "The tower is still transmitting\."\}/);
});

test("repairs duplicated SAY and CHOICE identities and remaps duplicated edges", () => {
    const originalSay = node("original-say", EmpathyCanvasNodeKind.SAY, {
        text: "Hello",
        empathyCharacterAtom: mara.atom.value,
        empathyLineAtom: { value: 20, key: "mara_hello" },
    });
    const duplicateSay = new MockNode("duplicate-say", originalSay.getData());
    const originalChoice = node("original-choice", EmpathyCanvasNodeKind.CHOICE, {
        empathyChoices: [choice("Stay", undefined, 30), choice("Leave", undefined, 31)],
    });
    const duplicateChoice = new MockNode("duplicate-choice", originalChoice.getData());
    const end = node("end", EmpathyCanvasNodeKind.END);
    const duplicatedEdge = new MockEdge("duplicate-edge", duplicateChoice, end, { empathyChoiceAtom: 30 });
    const canvas = graph([originalSay, duplicateSay, originalChoice, duplicateChoice, end], [duplicatedEdge]);
    const known = new Set([originalSay.id, originalChoice.id, end.id]);
    const allocate = testAllocator();
    assert.equal(repairDuplicatedNodeAtoms(canvas, duplicateSay, known, allocate), true);
    known.add(duplicateSay.id);
    assert.equal(repairDuplicatedNodeAtoms(canvas, duplicateChoice, known, allocate), true);
    assert.notDeepEqual(duplicateSay.getData().empathyLineAtom, originalSay.getData().empathyLineAtom);
    assert.equal(duplicateSay.getData().empathyLineAtom?.key, undefined);
    assert.equal(duplicateSay.getData().empathyCharacterAtom, mara.atom.value);
    const duplicateOptions = duplicateChoice.getData().empathyChoices!;
    assert.deepEqual(duplicateOptions.map(({ atom }) => atom.value), [32, 33]);
    assert.deepEqual(duplicateOptions.map(({ atom }) => atom.key), [undefined, undefined]);
    assert.equal(duplicatedEdge.getData().empathyChoiceAtom, 32);
});

test("keeps shared CHARACTER identity stable across SAY order, additions, and definition edits", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const first = node("say-a", EmpathyCanvasNodeKind.SAY, { text: "A", empathyCharacterAtom: 12 });
    const second = node("say-b", EmpathyCanvasNodeKind.SAY, { text: "B", empathyCharacterAtom: 12 });
    const third = node("say-c", EmpathyCanvasNodeKind.SAY, { text: "C", empathyCharacterAtom: 12 });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const initial = graph([entry, first, second, third, end], [
        new MockEdge("entry-a", entry, first),
        new MockEdge("a-b", first, second),
        new MockEdge("b-c", second, third),
        new MockEdge("c-end", third, end),
    ]);
    const initialResult = compileCanvas(initial, variables, [mara]);
    assert.deepEqual(yieldedAtomValues(initialResult.bytecode, 1), [12, 12, 12]);
    assert.deepEqual(initialResult.characters.map(({ value, key, text }) => ({ value, key, text })), [
        { value: 12, key: "chr_mara", text: "Мара" },
    ]);

    const sasha: NarrativeCharacter = { atom: { value: 4, key: "sasha" }, name: "Саша" };
    const earlier = node("say-earlier", EmpathyCanvasNodeKind.SAY, { text: "Earlier", empathyCharacterAtom: 4 });
    const reordered = graph([third, entry, earlier, second, first, end], [
        new MockEdge("entry-earlier", entry, earlier),
        new MockEdge("earlier-a", earlier, first),
        new MockEdge("a-b", first, second),
        new MockEdge("b-c", second, third),
        new MockEdge("c-end", third, end),
    ]);
    const withEarlierCharacter = compileCanvas(reordered, variables, [sasha, mara]);
    assert.deepEqual(yieldedAtomValues(withEarlierCharacter.bytecode, 1), [4, 12, 12, 12]);
    assert.deepEqual(withEarlierCharacter.characters.map(({ value }) => value), [4, 12]);

    const renamed: NarrativeCharacter = { atom: { value: 12, key: "npc_mara" }, name: "Мара Волкова" };
    const beforeRename = compileCanvas(initial, variables, [mara]);
    const afterRename = compileCanvas(initial, variables, [renamed]);
    assert.deepEqual(afterRename.bytecode, beforeRename.bytecode);
    assert.deepEqual([first, second, third].map((say) => say.getData().empathyCharacterAtom), [12, 12, 12]);
    assert.equal(afterRename.characters[0].value, 12);
});

test("deleting a shared character preserves explicit missing SAY references and blocks compilation", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const first = node("say-a", EmpathyCanvasNodeKind.SAY, { text: "A", empathyCharacterAtom: 12 });
    const second = node("say-b", EmpathyCanvasNodeKind.SAY, { text: "B", empathyCharacterAtom: 12 });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const canvas = graph([entry, first, second, end], [
        new MockEdge("entry-a", entry, first),
        new MockEdge("a-b", first, second),
        new MockEdge("b-end", second, end),
    ]);
    assert.doesNotThrow(() => compileCanvas(canvas, variables, [mara]));
    const issues = validateCanvas(canvas, variables, []);
    assert.deepEqual(issues.filter(({ message }) => message.includes("missing CHARACTER atom 12")).map(({ nodeId }) => nodeId), [
        "say-a",
        "say-b",
    ]);
    assert.throws(() => compileCanvas(canvas, variables, []), /missing CHARACTER atom 12/);
    assert.equal(first.getData().empathyCharacterAtom, 12);
    assert.equal(second.getData().empathyCharacterAtom, 12);
});

test("creates a character with an allocated atom and selects it without requiring an ID", () => {
    const existing: NarrativeCharacter[] = [{ atom: { value: 0 }, name: "Existing" }];
    let nextValue = 0;
    const created = createNarrativeCharacter("  Мара  ", existing, (type, usedValues) => {
        assert.equal(type, AuthoredAtomType.CHARACTER);
        const allocation = allocateAuthoredAtom(type, nextValue, usedValues);
        nextValue = allocation.nextValue;
        return allocation.atom;
    });
    assert.deepEqual(created, { atom: { value: 1 }, name: "Мара" });
    const selected = selectNarrativeCharacter({
        type: "text",
        text: "Вышка всё ещё передаёт сигнал.",
        empathyKind: EmpathyCanvasNodeKind.SAY,
    }, created);
    assert.equal(selected.empathyCharacterAtom, 1);
    assert.equal(created.atom.key, undefined);
    assert.equal(generatedAtomKey(AuthoredAtomType.CHARACTER, created.name, created.atom.value, new Set()), "mara");
});

test("shows every existing character before the SAY picker search is edited", () => {
    const characters: NarrativeCharacter[] = [
        { atom: { value: 4, key: "ded" }, name: "Дед" },
        { atom: { value: 9, key: "avtomat" }, name: "Автомат" },
    ];
    assert.deepEqual(filterNarrativeCharacters(characters).map(({ name }) => name), ["Дед", "Автомат"]);
    assert.deepEqual(filterNarrativeCharacters(characters, "авт").map(({ name }) => name), ["Автомат"]);
    assert.deepEqual(filterNarrativeCharacters(characters, "ded").map(({ name }) => name), ["Дед"]);
});

test("validates CHARACTER definitions independently and reports active Canvas usages", () => {
    const invalid = [
        { atom: { value: 12, key: "mara" }, name: "Мара" },
        { atom: { value: 12, key: "mara" }, name: "" },
        { atom: { value: -1, key: "Not_ASCII" }, name: "Саша" },
    ] as NarrativeCharacter[];
    const messages = validateCharacterConfiguration(invalid).map(({ message }) => message);
    assert.ok(messages.some((message) => message.includes("value 12 is duplicated")));
    assert.ok(messages.some((message) => message.includes("key mara is duplicated")));
    assert.ok(messages.some((message) => message.includes("requires a non-empty name")));
    assert.ok(messages.some((message) => message.includes("invalid CHARACTER atom value")));
    assert.ok(messages.some((message) => message.includes("invalid CHARACTER atom key")));

    const first = node("say-a", EmpathyCanvasNodeKind.SAY, { text: "A", empathyCharacterAtom: 12 });
    const second = node("say-b", EmpathyCanvasNodeKind.SAY, { text: "B", empathyCharacterAtom: 12 });
    const canvas = graph([first, second], []);
    assert.equal(characterUsageCount(canvas, 12), 2);
    assert.deepEqual(collectCharacterAtoms([mara], canvas), [{
        owner: "character",
        type: AuthoredAtomType.CHARACTER,
        value: 12,
        key: "chr_mara",
        text: "Мара",
        usageCount: 2,
    }]);
});

test("keeps sidebar atom source lookup stable across CHOICE reorder", () => {
    const first = choice("First", undefined, 73);
    const second = choice("Second", undefined, 91);
    const choiceNode = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: [first, second] });
    const canvas = graph([choiceNode], []);
    assert.equal(collectCanvasAtoms(canvas).find(({ value }) => value === 73)?.text, "First");
    choiceNode.setData({ ...choiceNode.getData(), empathyChoices: [second, first] });
    const source = collectCanvasAtoms(canvas).find(({ value }) => value === 73);
    assert.equal(source?.nodeId, "choice");
    assert.equal(source?.optionAtomValue, 73);
    assert.equal(source?.text, "First");
    assert.deepEqual(collectCanvasAtoms(canvas).map(({ value }) => value), [91, 73]);
});

function conditionalChoiceGraph(): { canvas: Canvas; choiceNode: MockNode; targets: MockNode[] } {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choiceNode = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: [
        choice("Always", undefined, 73),
        choice("Radio", { variable: "world.radio_found", comparison: "==", literal: "true" }, 91),
        choice("Trusted", { variable: "npc.trust", comparison: ">=", literal: "0.5" }, 104),
    ] });
    const targets = [node("always", EmpathyCanvasNodeKind.END), node("radio", EmpathyCanvasNodeKind.END), node("trusted", EmpathyCanvasNodeKind.END)];
    return {
        canvas: graph([entry, choiceNode, ...targets], [
            new MockEdge("entry-choice", entry, choiceNode),
            new MockEdge("always", choiceNode, targets[0], { empathyChoiceAtom: 73 }),
            new MockEdge("radio", choiceNode, targets[1], { empathyChoiceAtom: 91 }),
            new MockEdge("trusted", choiceNode, targets[2], { empathyChoiceAtom: 104 }),
        ]),
        choiceNode,
        targets,
    };
}

test("yields only visible stable CHOICE atoms in authored order", () => {
    const fixture = conditionalChoiceGraph();
    const result = compileCanvas(fixture.canvas, variables);
    const offset = result.nodeOffsets.get("choice")!;
    assert.deepEqual(executeChoiceRequest(result.bytecode, offset, [0, 0]), { ended: false, choices: [73] });
    assert.deepEqual(executeChoiceRequest(result.bytecode, offset, [1, 0]), { ended: false, choices: [73, 91] });
    assert.deepEqual(executeChoiceRequest(result.bytecode, offset, [0, 1]), { ended: false, choices: [73, 104] });
    assert.deepEqual(executeChoiceRequest(result.bytecode, offset, [1, 1]), { ended: false, choices: [73, 91, 104] });
});

test("dispatches by stable CHOICE atom and rejects hidden or unrelated atoms", () => {
    const fixture = conditionalChoiceGraph();
    const result = compileCanvas(fixture.canvas, variables);
    const offset = result.nodeOffsets.get("choice")!;
    const targets = new Set(fixture.targets.map(({ id }) => result.nodeOffsets.get(id)!));
    assert.deepEqual(executeChoiceDispatch(result.bytecode, offset, 104, targets, [0, 1]), {
        ended: false,
        stack: [],
        targetOffset: result.nodeOffsets.get("trusted"),
    });
    assert.deepEqual(executeChoiceDispatch(result.bytecode, offset, 91, targets, [0, 1]), { ended: true, stack: [] });
    assert.deepEqual(executeChoiceDispatch(result.bytecode, offset, 999, targets, [1, 1]), { ended: true, stack: [] });
    assert.deepEqual(executeChoiceDispatch(result.bytecode, offset, 500, targets, [1, 1]), { ended: true, stack: [] });
});

test("ends without yielding when every CHOICE option is hidden", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choiceNode = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: [
        choice("Radio", { variable: "world.radio_found", comparison: "==", literal: "true" }, 73),
        choice("Trusted", { variable: "npc.trust", comparison: ">=", literal: "0.5" }, 91),
    ] });
    const first = node("first", EmpathyCanvasNodeKind.END);
    const second = node("second", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(graph([entry, choiceNode, first, second], [
        new MockEdge("entry-choice", entry, choiceNode),
        new MockEdge("first", choiceNode, first, { empathyChoiceAtom: 73 }),
        new MockEdge("second", choiceNode, second, { empathyChoiceAtom: 91 }),
    ]), variables);
    assert.deepEqual(executeChoiceRequest(result.bytecode, result.nodeOffsets.get("choice")!, [0, 0]), {
        ended: true,
        choices: [],
    });
});

test("generates keyed and numeric-fallback atom enums without changing the CHOICE resume contract", () => {
    const fixture = conditionalChoiceGraph();
    fixture.choiceNode.setData({
        ...fixture.choiceNode.getData(),
        empathyChoices: fixture.choiceNode.getData().empathyChoices!.map((option) => option.atom.value === 91
            ? { ...option, atom: { ...option.atom, key: "choice_radio_ask" } }
            : option),
    });
    const line = node("line", EmpathyCanvasNodeKind.LINE, {
        text: "The tower is still transmitting.",
        empathyLineAtom: { value: 1482, key: "dlg_radio_intro_00" },
    });
    const entry = Array.from(fixture.canvas.nodes.values()).find((value) => value.id === "entry")! as MockNode;
    (fixture.canvas.nodes as Map<string, CanvasNode>).set(line.id, line);
    const originalEntryEdge = fixture.canvas.edges.get("entry-choice")! as MockEdge;
    originalEntryEdge.to.node = line;
    fixture.canvas.edges.set("line-choice", new MockEdge("line-choice", line, fixture.choiceNode));
    const result = compileCanvas(fixture.canvas, variables);
    const header = generateHeader(result, "Radio_Story");
    assert.match(header, /RADIO_STORY_LINE_DLG_RADIO_INTRO_00 = 1482u/);
    assert.match(header, /RADIO_STORY_CHOICE_CHOICE_RADIO_ASK = 91u/);
    assert.match(header, /RADIO_STORY_CHOICE_73 = 73u/);
    assert.match(header, /\{RADIO_STORY_CHOICE_73, 0, "Always"\}/);
    assert.match(header, /\{RADIO_STORY_CHOICE_CHOICE_RADIO_ASK, "choice_radio_ask", "Radio"\}/);
    assert.match(header, /\{EMPATHY_VALUE_BASE_TYPE_ATOM, RADIO_STORY_ATOM_TYPE_CHOICE\}/);
    assert.match(header, /static const Radio_Story_AtomText radio_story_line_atoms\[\]/);
    assert.doesNotMatch(header, /_EMPATHY/);
    assert.doesNotMatch(header, /^#define RADIO_STORY_(?:LINE|CHARACTER|CHOICE)_(?!COUNT)/m);
    line.setData({ ...line.getData(), empathyLineAtom: { value: 1482, key: "for" } });
    const keyword = generateHeader(compileCanvas(fixture.canvas, variables), "Radio_Story");
    assert.match(keyword, /RADIO_STORY_LINE_FOR = 1482u/);
    assert.doesNotMatch(keyword, /LINE__FOR/);
    line.setData({ ...line.getData(), empathyLineAtom: { value: 1482, key: "dlg_radio_intro_01" } });
    const renamed = generateHeader(compileCanvas(fixture.canvas, variables), "Radio_Story");
    assert.match(renamed, /RADIO_STORY_LINE_DLG_RADIO_INTRO_01 = 1482u/);
    assert.doesNotMatch(renamed, /DLG_RADIO_INTRO_00/);
    line.setData({ ...line.getData(), empathyLineAtom: { value: 1482 } });
    const removed = generateHeader(compileCanvas(fixture.canvas, variables), "Radio_Story");
    assert.match(removed, /RADIO_STORY_LINE_1482 = 1482u/);
    assert.match(removed, /\{RADIO_STORY_LINE_1482, 0, "The tower is still transmitting\."\}/);
    assert.equal(entry.id, "entry");
});

test("keeps authored Unicode readable in UTF-8 C literals", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
        ["ASCII", "Hello world", '"Hello world"'],
        ["Cyrillic", "Привет, Мара", '"Привет, Мара"'],
        ["Japanese", "塔はまだ信号を送っている", '"塔はまだ信号を送っている"'],
        ["Emoji", "The water is rising 🌊", '"The water is rising 🌊"'],
        ["Question mark", "Куда пойдём?", '"Куда пойдём?"'],
        ["Quotes", 'She said "hello"', '"She said \\"hello\\""'],
        ["C trigraph safety", "What??/next", '"What?\\?/next"'],
        ["Backslash", "C:\\radio\\tower", '"C:\\\\radio\\\\tower"'],
        ["Newline", "line one\nline two", '"line one\\nline two"'],
        ["Carriage return", "line one\rline two", '"line one\\rline two"'],
        ["Tab", "left\tright", '"left\\tright"'],
    ];
    for (const [label, value, expected] of cases) {
        assert.equal(escapeCStringUtf8(value), expected, label);
    }
    assert.equal(escapeCStringUtf8("\u00017"), '"\\0017"');
    assert.equal(escapeCStringUtf8("\u00857"), '"\\302\\2057"');
    assert.throws(() => escapeCStringUtf8("\uD800"), /unpaired UTF-16 surrogate/);
    for (const suffix of ["=", "/", "'", "(", ")", "!", "<", ">", "-"]) {
        assert.doesNotMatch(escapeCStringUtf8(`??${suffix}`), /\?\?[=\/'()!<>-]/);
    }
});

test("writes readable UTF-8 literals for line, character, and choice header tables", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const say = node("say", EmpathyCanvasNodeKind.SAY, {
        text: "Привет, Мара",
        empathyCharacterAtom: 12,
        empathyLineAtom: { value: 1482 },
    });
    const choiceNode = node("choice", EmpathyCanvasNodeKind.CHOICE, {
        empathyChoices: [choice("The water is rising 🌊", undefined, 73)],
    });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const header = generateHeader(compileCanvas(graph(
        [entry, say, choiceNode, end],
        [
            new MockEdge("entry-say", entry, say),
            new MockEdge("say-choice", say, choiceNode),
            new MockEdge("choice-end", choiceNode, end, { empathyChoiceAtom: 73 }),
        ],
    ), variables, [{ atom: { value: 12, key: "tower" }, name: "塔はまだ信号を送っている" }]), "unicode");
    assert.ok(header.includes(`{UNICODE_LINE_1482, 0, ${escapeCStringUtf8("Привет, Мара")}}`));
    assert.ok(header.includes(`{UNICODE_CHARACTER_TOWER, "tower", ${escapeCStringUtf8("塔はまだ信号を送っている")}}`));
    assert.ok(header.includes(`{UNICODE_CHOICE_73, 0, ${escapeCStringUtf8("The water is rising 🌊")}}`));
    assert.match(header, /typedef enum unicode_CharacterAtom_t[\s\S]*UNICODE_CHARACTER_TOWER = 12u/);
    assert.doesNotMatch(header, /\\(?:320|321|343|345|351|360)/);
    const bytes = Buffer.from(header, "utf8");
    assert.ok(bytes.includes(Buffer.from("Привет, Мара", "utf8")));
    assert.ok(bytes.includes(Buffer.from("塔はまだ信号を送っている", "utf8")));
    assert.ok(bytes.includes(Buffer.from("The water is rising 🌊", "utf8")));
});

test("generates keyed and keyless CHARACTER constants at their persisted numeric values", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const say = node("say", EmpathyCanvasNodeKind.SAY, {
        text: "Вышка всё ещё передаёт сигнал.",
        empathyCharacterAtom: 12,
        empathyLineAtom: { value: 100 },
    });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const characters: NarrativeCharacter[] = [
        { atom: { value: 12, key: "chr_mara" }, name: "Мара" },
        { atom: { value: 14 }, name: "Миша" },
    ];
    const result = compileCanvas(graph([entry, say, end], [
        new MockEdge("entry-say", entry, say),
        new MockEdge("say-end", say, end),
    ]), variables, characters);
    const header = generateHeader(result, "Story");
    assert.match(header, /STORY_CHARACTER_CHR_MARA = 12u/);
    assert.match(header, /STORY_CHARACTER_14 = 14u/);
    assert.match(header, /#define STORY_CHARACTER_COUNT 2u/);
    assert.match(header, /\{STORY_ATOM_TYPE_CHARACTER, 12u, 14u\}/);
    assert.ok(header.includes(`{STORY_CHARACTER_CHR_MARA, "chr_mara", ${escapeCStringUtf8("Мара")}}`));
    assert.ok(header.includes(`{STORY_CHARACTER_14, 0, ${escapeCStringUtf8("Миша")}}`));
    assert.ok(Buffer.from(header, "utf8").includes(Buffer.from("Мара", "utf8")));
});

test("validates optional IDs only when present and scopes uniqueness to atom type", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const line = node("line", EmpathyCanvasNodeKind.LINE, {
        text: "Introduction",
        empathyLineAtom: { value: 8, key: "intro" },
    });
    const choiceNode = node("choice", EmpathyCanvasNodeKind.CHOICE, {
        empathyChoices: [choice("Leave", undefined, 73, "intro")],
    });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const canvas = graph(
        [entry, line, choiceNode, end],
        [
            new MockEdge("entry-line", entry, line),
            new MockEdge("line-choice", line, choiceNode),
            new MockEdge("choice-end", choiceNode, end, { empathyChoiceAtom: 73 }),
        ],
    );
    assert.deepEqual(validateCanvas(canvas, variables), []);

    line.setData({ ...line.getData(), empathyLineAtom: { value: 8, key: "invalid.id" } });
    assert.ok(validateCanvas(canvas, variables).some(({ message }) => message.includes("invalid LINE atom key")));
});

test("keeps numeric atom metadata mandatory and within the UINT32 domain", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const line = node("line", EmpathyCanvasNodeKind.LINE, { text: "Line", empathyLineAtom: { value: 9 } });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const canvas = graph(
        [entry, line, end],
        [new MockEdge("entry-line", entry, line), new MockEdge("line-end", line, end)],
    );
    const issuesFor = (atom: AuthoredAtom | undefined): string[] => {
        line.setData({ ...line.getData(), empathyLineAtom: atom });
        return validateCanvas(canvas, variables).map(({ message }) => message);
    };
    assert.ok(issuesFor(undefined).some((message) => message.includes("missing stable LINE atom metadata")));
    assert.ok(issuesFor({ key: "line" } as AuthoredAtom).some((message) => message.includes("invalid LINE atom value")));
    for (const value of [-1, 1.5, 0x100000000]) {
        assert.ok(issuesFor({ value }).some((message) => message.includes("invalid LINE atom value")), String(value));
    }
    assert.ok(issuesFor({ value: 9, automatic: true } as unknown as AuthoredAtom)
        .some((message) => message.includes("unsupported LINE atom metadata: automatic")));
});

test("validates duplicate atom identities and conditional CHOICE variable access", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const first = node("first", EmpathyCanvasNodeKind.LINE, { text: "One", empathyLineAtom: { value: 7, key: "same" } });
    const second = node("second", EmpathyCanvasNodeKind.LINE, { text: "Two", empathyLineAtom: { value: 8, key: "same" } });
    const third = node("third", EmpathyCanvasNodeKind.LINE, { text: "Three", empathyLineAtom: { value: 7, key: "other" } });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const duplicateIssues = validateCanvas(graph(
        [entry, first, second, third, end],
        [new MockEdge("entry-first", entry, first), new MockEdge("first-end", first, end)],
    ), variables);
    assert.ok(duplicateIssues.some(({ message }) => message.includes("LINE atom value 7 is duplicated")));
    assert.ok(duplicateIssues.some(({ message }) => message.includes("LINE atom key same is duplicated")));

    const writeOnly = { name: "secret.flag", type: "boolean", access: "write" } as NarrativeVariable;
    const choiceNode = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: [
        choice("Secret", { variable: "secret.flag", comparison: "==", literal: "true" }, 20),
    ] });
    const choiceEnd = node("choice-end", EmpathyCanvasNodeKind.END);
    const issues = validateCanvas(graph(
        [entry, choiceNode, choiceEnd],
        [new MockEdge("entry-choice", entry, choiceNode), new MockEdge("choice-end", choiceNode, choiceEnd, { empathyChoiceAtom: 20 })],
    ), [...variables, writeOnly]);
    assert.ok(issues.some(({ message }) => message.includes("write-only") && message.includes("CHOICE option 0")));
});

test("emits a converging target exactly once", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const line = node("line", EmpathyCanvasNodeKind.LINE, { text: "Branch" });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(graph(
        [entry, line, end],
        [
            new MockEdge("a", entry, line),
            new MockEdge("b", line, end, { empathyCondition: { variable: "world.radio_found", comparison: "==", literal: "true" }, empathyConditionOrder: 0 }),
            new MockEdge("c", line, end, { empathyElse: true }),
        ],
    ), variables);
    assert.equal(decode(result.bytecode).filter(({ opcode }) => opcode === EmpathyBytecodeOpcode.END).length, 1);
    assert.equal(result.nodeOffsets.get("end") !== undefined, true);
    assertJumpTargetsOnInstructionBoundaries(result.bytecode);
});

test("routes multiple receivers and incoming branches through one transmitter", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choice = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: choices("One", "Two", "Three") });
    const receiverA = portalNode("receiver-a", EmpathyCanvasNodeKind.PORTAL_RECEIVER);
    const receiverB = portalNode("receiver-b", EmpathyCanvasNodeKind.PORTAL_RECEIVER);
    const transmitter = portalNode("transmitter", EmpathyCanvasNodeKind.PORTAL_TRANSMITTER);
    const end = node("end", EmpathyCanvasNodeKind.END);
    const canvas = graph(
        [entry, choice, receiverA, receiverB, transmitter, end],
        [
            new MockEdge("entry-choice", entry, choice),
            new MockEdge("choice-one", choice, receiverA, { empathyChoiceAtom: choice.getData().empathyChoices![0].atom.value }),
            new MockEdge("choice-two", choice, receiverA, { empathyChoiceAtom: choice.getData().empathyChoices![1].atom.value }),
            new MockEdge("choice-three", choice, receiverB, { empathyChoiceAtom: choice.getData().empathyChoices![2].atom.value }),
            new MockEdge("transmitter-end", transmitter, end),
        ],
    );
    const result = compileCanvas(canvas, variables);
    const endOffset = result.nodeOffsets.get("end")!;
    for (const receiver of [receiverA, receiverB]) {
        const receiverOffset = result.nodeOffsets.get(receiver.id)!;
        assert.ok(receiverOffset < endOffset);
        assert.equal(result.bytecode[receiverOffset], EmpathyBytecodeOpcode.JUMP);
        assert.equal(Number(view(result.bytecode).getBigUint64(receiverOffset + 1, true)), endOffset);
    }
    assert.equal(result.nodeOffsets.has("transmitter"), false);
    assert.equal(Array.from(canvas.edges.values()).some((edge) =>
        (edge.from?.node === receiverA || edge.from?.node === receiverB) && edge.to?.node === transmitter), false);
    assert.equal(decode(result.bytecode).filter(({ opcode }) => opcode === EmpathyBytecodeOpcode.END).length, 3);
    assertJumpTargetsOnInstructionBoundaries(result.bytecode);
});

test("routes a portal by stable identity independently of its display name", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const receiver = portalNode("receiver", EmpathyCanvasNodeKind.PORTAL_RECEIVER);
    const transmitter = portalNode("transmitter", EmpathyCanvasNodeKind.PORTAL_TRANSMITTER);
    const end = node("end", EmpathyCanvasNodeKind.END);
    const canvas = graph(
        [entry, receiver, transmitter, end],
        [new MockEdge("entry-receiver", entry, receiver), new MockEdge("transmitter-end", transmitter, end)],
    );
    const beforeRename = compileCanvas(canvas, variables);
    transmitter.setData({ ...transmitter.getData(), empathyPortalName: "Renamed portal" });
    const afterRename = compileCanvas(canvas, variables);
    assert.deepEqual(afterRename.bytecode, beforeRename.bytecode);
    assert.equal(afterRename.nodeOffsets.get("receiver"), beforeRename.nodeOffsets.get("receiver"));
});

test("routes a portal to a continuation that was already emitted without duplicating it", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choice = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: choices("Direct", "Portal") });
    const receiver = portalNode("receiver", EmpathyCanvasNodeKind.PORTAL_RECEIVER);
    const transmitter = portalNode("transmitter", EmpathyCanvasNodeKind.PORTAL_TRANSMITTER);
    const end = node("end", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(graph(
        [entry, choice, receiver, transmitter, end],
        [
            new MockEdge("entry-choice", entry, choice),
            new MockEdge("choice-direct", choice, end, { empathyChoiceAtom: choice.getData().empathyChoices![0].atom.value }),
            new MockEdge("choice-portal", choice, receiver, { empathyChoiceAtom: choice.getData().empathyChoices![1].atom.value }),
            new MockEdge("transmitter-end", transmitter, end),
        ],
    ), variables);
    const receiverOffset = result.nodeOffsets.get("receiver")!;
    assert.ok(result.nodeOffsets.get("end")! < receiverOffset);
    assert.equal(result.bytecode[receiverOffset], EmpathyBytecodeOpcode.JUMP);
    assert.equal(
        Number(view(result.bytecode).getBigUint64(receiverOffset + 1, true)),
        result.nodeOffsets.get("end"),
    );
    assert.equal(decode(result.bytecode).filter(({ opcode }) => opcode === EmpathyBytecodeOpcode.END).length, 3);
    assertJumpTargetsOnInstructionBoundaries(result.bytecode);
});

test("rejects an outgoing visual edge from a portal receiver", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const receiver = portalNode("receiver", EmpathyCanvasNodeKind.PORTAL_RECEIVER);
    const transmitter = portalNode("transmitter", EmpathyCanvasNodeKind.PORTAL_TRANSMITTER);
    const end = node("end", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(graph(
        [entry, receiver, transmitter, end],
        [
            new MockEdge("entry-receiver", entry, receiver),
            new MockEdge("receiver-end", receiver, end),
            new MockEdge("transmitter-end", transmitter, end),
        ],
    ), variables), /RECEIVER must not have outgoing visual edges/);
});

test("rejects an incoming visual edge to a portal transmitter", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const receiver = portalNode("receiver", EmpathyCanvasNodeKind.PORTAL_RECEIVER);
    const transmitter = portalNode("transmitter", EmpathyCanvasNodeKind.PORTAL_TRANSMITTER);
    const end = node("end", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(graph(
        [entry, receiver, transmitter, end],
        [new MockEdge("entry-transmitter", entry, transmitter), new MockEdge("transmitter-end", transmitter, end)],
    ), variables), /TRANSMITTER cannot accept incoming visual edges/);
});

test("requires a portal transmitter continuation", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const receiver = portalNode("receiver", EmpathyCanvasNodeKind.PORTAL_RECEIVER);
    const transmitter = portalNode("transmitter", EmpathyCanvasNodeKind.PORTAL_TRANSMITTER);
    assert.throws(() => compileCanvas(graph(
        [entry, receiver, transmitter],
        [new MockEdge("entry-receiver", entry, receiver)],
    ), variables), /TRANSMITTER must have exactly one outgoing edge; found 0/);
});

test("rejects multiple portal transmitter continuations", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const receiver = portalNode("receiver", EmpathyCanvasNodeKind.PORTAL_RECEIVER);
    const transmitter = portalNode("transmitter", EmpathyCanvasNodeKind.PORTAL_TRANSMITTER);
    const first = node("first", EmpathyCanvasNodeKind.END);
    const second = node("second", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(graph(
        [entry, receiver, transmitter, first, second],
        [
            new MockEdge("entry-receiver", entry, receiver),
            new MockEdge("transmitter-first", transmitter, first),
            new MockEdge("transmitter-second", transmitter, second),
        ],
    ), variables), /TRANSMITTER must have exactly one outgoing edge; found 2/);
});

test("requires exactly one transmitter for a reachable portal", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const receiver = portalNode("receiver", EmpathyCanvasNodeKind.PORTAL_RECEIVER);
    assert.throws(() => compileCanvas(graph(
        [entry, receiver],
        [new MockEdge("entry-receiver", entry, receiver)],
    ), variables), /must have exactly one TRANSMITTER; found 0/);
});

test("rejects duplicate transmitters for the same portal", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const receiver = portalNode("receiver", EmpathyCanvasNodeKind.PORTAL_RECEIVER);
    const transmitterA = portalNode("transmitter-a", EmpathyCanvasNodeKind.PORTAL_TRANSMITTER);
    const transmitterB = portalNode("transmitter-b", EmpathyCanvasNodeKind.PORTAL_TRANSMITTER);
    const end = node("end", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(graph(
        [entry, receiver, transmitterA, transmitterB, end],
        [
            new MockEdge("entry-receiver", entry, receiver),
            new MockEdge("transmitter-a-end", transmitterA, end),
            new MockEdge("transmitter-b-end", transmitterB, end),
        ],
    ), variables), /must have exactly one TRANSMITTER; found 2/);
});

test("orders case-preserving header sections and emits standard offsetof expressions", () => {
    const result = compileCanvas(simpleEndGraph().canvas, variables);
    const header = generateHeader(result, "Radio_Story");
    assert.deepEqual(header.match(/^#include .+$/gm), ["#include <stddef.h>", "#include <empathy.h>"]);
    assert.doesNotMatch(header, /_EMPATHY/);
    assert.match(header, /typedef struct Radio_Story_WorldState[\s\S]*uint8_t radio_found;[\s\S]*float time;[\s\S]*} Radio_Story_WorldState;/);
    assert.match(header, /typedef struct Radio_Story_NpcState[\s\S]*float trust;[\s\S]*} Radio_Story_NpcState;/);
    assert.match(header, /typedef struct Radio_Story_QuestState[\s\S]*int32_t stage;[\s\S]*} Radio_Story_QuestState;/);
    for (const symbol of [
        "line_atoms",
        "character_atoms",
        "choice_atoms",
        "atom_types",
        "parameters",
        "choice_resume_types",
        "yields",
        "layout_desc",
        "entry_points",
    ]) {
        assert.match(header, new RegExp(`\\bradio_story_${symbol}\\b`));
        assert.doesNotMatch(header, new RegExp(`\\bRadio_Story_${symbol}\\b`));
    }
    assert.match(header, /RADIO_STORY_PARAMETER_TABLE_WORLD = 0/);
    assert.match(header, /RADIO_STORY_PARAMETER_TABLE_NPC = 1/);
    assert.match(header, /RADIO_STORY_PARAMETER_TABLE_QUEST = 2/);
    assert.match(header, /RADIO_STORY_PARAMETER_WORLD_TIME = 2/);
    assert.doesNotMatch(header, /RADIO_STORY_OFFSET_OF/);
    assert.match(header, /offsetof\(Radio_Story_WorldState, time\)/);
    assert.match(header, /offsetof\(Radio_Story_NpcState, trust\)/);
    assert.match(header, /EMPATHY_VALUE_BASE_TYPE_FLOAT32/);
    assert.match(header, /EMPATHY_PARAMETER_ACCESS_FLAGS_READ,/);
    assert.match(header, /#define RADIO_STORY_PARAMETER_TABLE_COUNT 3u/);
    assert.match(header, /#define RADIO_STORY_REQUIRED_PARAMETER_TABLE_COUNT 3u/);
    assert.match(header, /4u, radio_story_parameters,/);
    assert.doesNotMatch(header, /typedef enum Radio_Story_(?:Line|Character|Choice)Atom_t/);

    const pragma = header.indexOf("#pragma once");
    const stddefInclude = header.indexOf("#include <stddef.h>");
    const empathyInclude = header.indexOf("#include <empathy.h>");
    const firstDefine = header.indexOf("#define RADIO_STORY_");
    const lastDefine = header.lastIndexOf("#define RADIO_STORY_");
    const firstEnum = header.indexOf("typedef enum Radio_Story_");
    const lastEnum = header.lastIndexOf("typedef enum Radio_Story_");
    const firstAtomTexts = header.indexOf("static const Radio_Story_AtomText radio_story_line_atoms[]");
    const lastAtomTexts = header.indexOf("static const Radio_Story_AtomText radio_story_choice_atoms[]");
    const descriptors = header.indexOf("static const Empathy_AtomTypeDesc radio_story_atom_types[]");
    assert.equal(pragma, 0);
    assert.ok(pragma < stddefInclude && stddefInclude < empathyInclude && empathyInclude < firstDefine);
    assert.ok(firstDefine <= lastDefine && lastDefine < firstEnum);
    assert.ok(firstEnum <= lastEnum && lastEnum < firstAtomTexts);
    assert.ok(firstAtomTexts < lastAtomTexts && lastAtomTexts < descriptors);
});

test("adds a new parameter table without compiler source changes", () => {
    const expanded = [...variables, { name: "weather.raining", type: "boolean", access: "read" } as NarrativeVariable];
    const result = compileCanvas(simpleEndGraph().canvas, expanded);
    assert.deepEqual(result.tables.at(-1), { name: "weather", index: 3 });
    assert.match(generateHeader(result, "story"), /STORY_PARAMETER_TABLE_WEATHER = 3/);
    assert.match(generateHeader(result, "story"), /typedef struct story_WeatherState/);
});

test("preserves deleted variable strings and reports them as missing", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const set = node("set", EmpathyCanvasNodeKind.SET, { empathyAssignments: [
        { variable: "npc.trust", operation: "=", literal: "0.5" },
    ] });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const canvas = graph([entry, set, end], [new MockEdge("a", entry, set), new MockEdge("b", set, end)]);
    const withoutTrust = variables.filter(({ name }) => name !== "npc.trust");
    const issues = validateCanvas(canvas, withoutTrust);
    assert.ok(issues.some(({ message }) => message.includes("npc.trust") && message.includes("missing")));
    assert.throws(() => compileCanvas(canvas, withoutTrust), /npc\.trust.*missing/);
    assert.equal(set.getData().empathyAssignments?.[0].variable, "npc.trust");
});

test("surfaces malformed variable configuration before emitting bytecode", () => {
    const invalid: NarrativeVariable[] = [
        { name: "world", type: "boolean", access: "read-write" },
        { name: "world", type: "boolean", access: "read-write" },
    ];
    assert.throws(() => compileCanvas(simpleEndGraph().canvas, invalid), /table\.variable/);
});

test("converts nodes to SET metadata without retaining unrelated semantic fields", () => {
    const converted = convertedEmpathyNodeData({
        type: "text",
        text: "",
        empathyKind: EmpathyCanvasNodeKind.SAY,
        empathyCharacter: "Mara",
        empathyCharacterAtom: 12,
        empathyEntryMatchValue: "12",
        empathyPortalId: "stale-portal",
        empathyPortalName: "Stale portal",
    }, EmpathyCanvasNodeKind.SET);
    assert.equal(converted.empathyKind, EmpathyCanvasNodeKind.SET);
    assert.deepEqual(converted.empathyAssignments, [{ variable: "", operation: "=", literal: "" }]);
    assert.equal(converted.empathyCharacter, undefined);
    assert.equal(converted.empathyCharacterAtom, undefined);
    assert.equal(converted.empathyEntryMatchValue, undefined);
    assert.equal(converted.empathyPortalId, undefined);
    assert.equal(converted.empathyPortalName, undefined);
});
