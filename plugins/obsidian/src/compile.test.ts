import { strict as assert } from "node:assert";
import { test } from "node:test";

import { EmpathyBytecodeInstructionSize, EmpathyBytecodeOpcode } from "./bytecode";
import {
    convertedEmpathyNodeData,
    formatChoiceBadge,
    formatTransitionBadge,
    repairDuplicatedNodeAtoms,
} from "./canvas";
import {
    allocateAuthoredAtom,
    AuthoredAtomType,
    suggestedAtomKey,
    uniqueAtomKey,
} from "./atoms";
import {
    Canvas,
    CanvasEdge,
    CanvasEdgeData,
    CanvasNode,
    CanvasNodeData,
    collectCanvasAtoms,
    compileCanvas,
    EmpathyCanvasNodeKind,
    generateHeader,
    NarrativeAssignment,
    NarrativeCondition,
    NarrativeChoice,
    NarrativeVariable,
    parseVariableName,
    validateCanvas,
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

let nextTestLineAtom = 100;
let nextTestChoiceAtom = 70;

function choice(text: string, condition?: NarrativeCondition, value = nextTestChoiceAtom++): NarrativeChoice {
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `choice_${value}`;
    return { atom: { value, key }, text, ...(condition ? { condition } : {}) };
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
        normalized.empathyLineAtom = { value: nextTestLineAtom++, key: `line_${nextTestLineAtom - 1}` };
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
        text: string,
        character: string | undefined,
        usedValues: ReadonlySet<number>,
        usedKeys: ReadonlySet<string>,
    ) => {
        const result = allocateAuthoredAtom(type, text, character, next[type], usedValues, usedKeys);
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
    const say = node("say", EmpathyCanvasNodeKind.SAY, { text: "Can we trust it?", empathyCharacter: "Mara" });
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
    ), variables);
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

test("allocates new atoms monotonically without changing existing values or keys", () => {
    const usedValues = new Set<number>();
    const usedKeys = new Set<string>();
    const first = allocateAuthoredAtom(AuthoredAtomType.LINE, "Same line", undefined, 0, usedValues, usedKeys);
    const firstSnapshot = { ...first.atom };
    usedValues.add(first.atom.value);
    usedKeys.add(first.atom.key);
    const second = allocateAuthoredAtom(AuthoredAtomType.LINE, "Same line", undefined, first.nextValue, usedValues, usedKeys);
    usedValues.add(second.atom.value);
    usedKeys.add(second.atom.key);
    const third = allocateAuthoredAtom(AuthoredAtomType.LINE, "Inserted first", undefined, second.nextValue, usedValues, usedKeys);
    const firstAtom = first.atom;
    const secondAtom = second.atom;
    assert.equal(firstAtom.value, 0);
    assert.equal(secondAtom.value, 1);
    assert.equal(firstAtom.key, "same_line");
    assert.equal(secondAtom.key, "same_line_2");
    assert.equal(third.atom.value, 2);
    assert.deepEqual(first.atom, firstSnapshot);
});

test("explicit key regeneration changes only the human-readable identity", () => {
    const original = { value: 1482, key: "mara.the_tower_is_still_transmitting" };
    const regenerated = {
        value: original.value,
        key: uniqueAtomKey(
            suggestedAtomKey(AuthoredAtomType.LINE, "There's still a signal coming from the tower.", "Mara"),
            `line_${original.value}`,
            new Set(["mara.theres_still_a_signal_coming_from_the_tower"]),
        ),
    };
    assert.equal(regenerated.value, original.value);
    assert.equal(regenerated.key, "mara.theres_still_a_signal_coming_from_the_tower_2");
});

test("repairs duplicated SAY and CHOICE identities and remaps duplicated edges", () => {
    const originalSay = node("original-say", EmpathyCanvasNodeKind.SAY, {
        text: "Hello",
        empathyCharacter: "Mara",
        empathyLineAtom: { value: 20, key: "mara.hello" },
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
    const duplicateOptions = duplicateChoice.getData().empathyChoices!;
    assert.deepEqual(duplicateOptions.map(({ atom }) => atom.value), [32, 33]);
    assert.equal(duplicatedEdge.getData().empathyChoiceAtom, 32);
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

test("generates stable atom-key constants and an ATOM CHOICE resume contract", () => {
    const fixture = conditionalChoiceGraph();
    const line = node("line", EmpathyCanvasNodeKind.LINE, {
        text: "The tower is still transmitting.",
        empathyLineAtom: { value: 1482, key: "mara.radio_tower_intro" },
    });
    const entry = Array.from(fixture.canvas.nodes.values()).find((value) => value.id === "entry")! as MockNode;
    (fixture.canvas.nodes as Map<string, CanvasNode>).set(line.id, line);
    const originalEntryEdge = fixture.canvas.edges.get("entry-choice")! as MockEdge;
    originalEntryEdge.to.node = line;
    fixture.canvas.edges.set("line-choice", new MockEdge("line-choice", line, fixture.choiceNode));
    const result = compileCanvas(fixture.canvas, variables);
    const header = generateHeader(result, "radio story");
    assert.match(header, /RADIO_STORY_EMPATHY_LINE_MARA_RADIO_TOWER_INTRO 1482u/);
    assert.match(header, /RADIO_STORY_EMPATHY_CHOICE_RADIO 91u/);
    assert.match(header, /\{EMPATHY_VALUE_BASE_TYPE_ATOM, RADIO_STORY_EMPATHY_ATOM_TYPE_CHOICE\}/);
    line.setData({ ...line.getData(), empathyLineAtom: { value: 1482, key: "mara.renamed_intro" } });
    const renamed = generateHeader(compileCanvas(fixture.canvas, variables), "radio story");
    assert.match(renamed, /RADIO_STORY_EMPATHY_LINE_MARA_RENAMED_INTRO 1482u/);
    assert.doesNotMatch(renamed, /MARA_RADIO_TOWER_INTRO/);
    assert.equal(entry.id, "entry");
});

test("validates duplicate atom identities and conditional CHOICE variable access", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const first = node("first", EmpathyCanvasNodeKind.LINE, { text: "One", empathyLineAtom: { value: 7, key: "same" } });
    const second = node("second", EmpathyCanvasNodeKind.LINE, { text: "Two", empathyLineAtom: { value: 7, key: "same" } });
    const end = node("end", EmpathyCanvasNodeKind.END);
    const duplicateIssues = validateCanvas(graph(
        [entry, first, second, end],
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

test("generates multi-table host structs, constants, descriptors, and offsets", () => {
    const result = compileCanvas(simpleEndGraph().canvas, variables);
    const header = generateHeader(result, "radio story");
    assert.match(header, /^#include <stddef\.h>$/m);
    assert.match(header, /^#include <stdint\.h>$/m);
    assert.match(header, /typedef struct WorldState[\s\S]*uint8_t radio_found;[\s\S]*float time;[\s\S]*} WorldState;/);
    assert.match(header, /typedef struct NpcState[\s\S]*float trust;[\s\S]*} NpcState;/);
    assert.match(header, /typedef struct QuestState[\s\S]*int32_t stage;[\s\S]*} QuestState;/);
    assert.match(header, /RADIO_STORY_EMPATHY_PARAMETER_TABLE_WORLD = 0/);
    assert.match(header, /RADIO_STORY_EMPATHY_PARAMETER_TABLE_NPC = 1/);
    assert.match(header, /RADIO_STORY_EMPATHY_PARAMETER_TABLE_QUEST = 2/);
    assert.match(header, /RADIO_STORY_EMPATHY_PARAMETER_WORLD_TIME = 2/);
    assert.match(header, /offsetof\(WorldState, time\)/);
    assert.match(header, /offsetof\(NpcState, trust\)/);
    assert.match(header, /EMPATHY_VALUE_BASE_TYPE_FLOAT32/);
    assert.match(header, /EMPATHY_PARAMETER_ACCESS_FLAGS_READ,/);
    assert.match(header, /#define RADIO_STORY_EMPATHY_PARAMETER_TABLE_COUNT 3u/);
    assert.match(header, /#define RADIO_STORY_EMPATHY_REQUIRED_PARAMETER_TABLE_COUNT 3u/);
    assert.match(header, /4u, radio_story_empathy_parameters,/);
});

test("adds a new parameter table without compiler source changes", () => {
    const expanded = [...variables, { name: "weather.raining", type: "boolean", access: "read" } as NarrativeVariable];
    const result = compileCanvas(simpleEndGraph().canvas, expanded);
    assert.deepEqual(result.tables.at(-1), { name: "weather", index: 3 });
    assert.match(generateHeader(result, "story"), /STORY_EMPATHY_PARAMETER_TABLE_WEATHER = 3/);
    assert.match(generateHeader(result, "story"), /typedef struct WeatherState/);
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
        empathyEntryMatchValue: "12",
        empathyPortalId: "stale-portal",
        empathyPortalName: "Stale portal",
    }, EmpathyCanvasNodeKind.SET);
    assert.equal(converted.empathyKind, EmpathyCanvasNodeKind.SET);
    assert.deepEqual(converted.empathyAssignments, [{ variable: "", operation: "=", literal: "" }]);
    assert.equal(converted.empathyCharacter, undefined);
    assert.equal(converted.empathyEntryMatchValue, undefined);
    assert.equal(converted.empathyPortalId, undefined);
    assert.equal(converted.empathyPortalName, undefined);
});
