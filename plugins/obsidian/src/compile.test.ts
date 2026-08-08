import { strict as assert } from "node:assert";
import { test } from "node:test";

import { EmpathyBytecodeInstructionSize, EmpathyBytecodeOpcode } from "./bytecode";
import { convertedEmpathyNodeData, formatChoiceBadge, formatTransitionBadge } from "./canvas";
import {
    Canvas,
    CanvasEdge,
    CanvasEdgeData,
    CanvasNode,
    CanvasNodeData,
    compileCanvas,
    EmpathyCanvasNodeKind,
    generateHeader,
    NarrativeCondition,
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

function node(id: string, kind: string, data: Partial<CanvasNodeData> = {}): MockNode {
    return new MockNode(id, { text: kind === EmpathyCanvasNodeKind.ENTRY ? id : "", empathyKind: kind, ...data });
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

function view(bytecode: Uint8Array): DataView {
    return new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);
}

function simpleEndGraph(): { canvas: Canvas; entry: MockNode; end: MockNode } {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY, { text: "start" });
    const end = node("end", EmpathyCanvasNodeKind.END);
    return { canvas: graph([entry, end], [new MockEdge("entry-end", entry, end)]), entry, end };
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
    assert.equal(formatChoiceBadge({ empathyChoiceIndex: 1, label: "Unrelated author text" }, ["Climb", "Leave"]), "Leave");
    assert.equal(formatChoiceBadge({ label: "Anything the author wants" }, ["Climb"]), "Unlinked choice");
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

test("lowers SET values and arithmetic with global parameter indices", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const set = node("set", EmpathyCanvasNodeKind.SET, { empathyAssignments: [
        { variable: "world.radio_found", operation: "=", literal: "true" },
        { variable: "npc.trust", operation: "+=", literal: "0.1" },
        { variable: "quest.stage", operation: "+=", literal: "1" },
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
        EmpathyBytecodeOpcode.LOAD, EmpathyBytecodeOpcode.PUSH_I32, EmpathyBytecodeOpcode.ADD,
        EmpathyBytecodeOpcode.STORE, EmpathyBytecodeOpcode.JUMP, EmpathyBytecodeOpcode.END,
    ]);
    const data = view(result.bytecode);
    const loadStores = instructions.filter(({ opcode }) => opcode === EmpathyBytecodeOpcode.LOAD || opcode === EmpathyBytecodeOpcode.STORE);
    assert.deepEqual(loadStores.map(({ offset }) => data.getUint32(offset + 1, true)), [0, 1, 1, 3, 3]);
    const floatPush = instructions.find(({ opcode }) => opcode === EmpathyBytecodeOpcode.PUSH_F32)!;
    const integerPush = instructions.find(({ opcode }) => opcode === EmpathyBytecodeOpcode.PUSH_I32)!;
    assert.ok(Math.abs(data.getFloat32(floatPush.offset + 1, true) - 0.1) < 1e-6);
    assert.equal(data.getInt32(integerPush.offset + 1, true), 1);
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
    const boundaries = new Set(instructions.map(({ offset }) => offset));
    for (const instruction of instructions.filter(({ opcode }) =>
        opcode === EmpathyBytecodeOpcode.JUMP || opcode === EmpathyBytecodeOpcode.JUMP_FALSE)) {
        assert.ok(boundaries.has(Number(view(result.bytecode).getBigUint64(instruction.offset + 1, true))));
    }
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

test("orders CHOICE options only by authored indices", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choice = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: ["First", "Second"] });
    const first = node("first", EmpathyCanvasNodeKind.END);
    const second = node("second", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(graph(
        [entry, choice, first, second],
        [
            new MockEdge("entry", entry, choice),
            new MockEdge("aaa-id-but-second", choice, second, { label: "Ignored B", empathyChoiceIndex: 1 }),
            new MockEdge("zzz-id-but-first", choice, first, { label: "Ignored A", empathyChoiceIndex: 0 }),
        ],
    ), variables);
    assert.deepEqual(result.choices, ["First", "Second"]);
});

test("does not use author edge labels as CHOICE option text", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choice = node("choice", EmpathyCanvasNodeKind.CHOICE);
    const end = node("end", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(graph(
        [entry, choice, end],
        [
            new MockEdge("a", entry, choice),
            new MockEdge("b", choice, end, { label: "Author note", empathyChoiceIndex: 0 }),
        ],
    ), variables), /must define at least one option/);
});

test("rejects missing and duplicate CHOICE edge links", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choice = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: ["One", "Two"] });
    const one = node("one", EmpathyCanvasNodeKind.END);
    const two = node("two", EmpathyCanvasNodeKind.END);
    const missing = graph(
        [entry, choice, one, two],
        [new MockEdge("a", entry, choice), new MockEdge("b", choice, one), new MockEdge("c", choice, two, { empathyChoiceIndex: 1 })],
    );
    assert.throws(() => compileCanvas(missing, variables), /not linked to an option/);
    const duplicate = graph(
        [entry, choice, one, two],
        [
            new MockEdge("a", entry, choice),
            new MockEdge("b", choice, one, { empathyChoiceIndex: 0 }),
            new MockEdge("c", choice, two, { empathyChoiceIndex: 0 }),
        ],
    );
    assert.throws(() => compileCanvas(duplicate, variables), /linked more than once/);
});

test("rejects CHOICE edges that reference options outside the node set", () => {
    const entry = node("entry", EmpathyCanvasNodeKind.ENTRY);
    const choice = node("choice", EmpathyCanvasNodeKind.CHOICE, { empathyChoices: ["One", "Two"] });
    const one = node("one", EmpathyCanvasNodeKind.END);
    const two = node("two", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(graph(
        [entry, choice, one, two],
        [
            new MockEdge("a", entry, choice),
            new MockEdge("b", choice, one, { empathyChoiceIndex: 0 }),
            new MockEdge("c", choice, two, { empathyChoiceIndex: 2 }),
        ],
    ), variables), /references missing option 2/);
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
    }, EmpathyCanvasNodeKind.SET);
    assert.equal(converted.empathyKind, EmpathyCanvasNodeKind.SET);
    assert.deepEqual(converted.empathyAssignments, [{ variable: "", operation: "=", literal: "" }]);
    assert.equal(converted.empathyCharacter, undefined);
    assert.equal(converted.empathyEntryMatchValue, undefined);
});
