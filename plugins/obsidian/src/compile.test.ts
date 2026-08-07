import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
    EmpathyBytecodeInstructionSize,
    EmpathyBytecodeOpcode,
} from "./bytecode";
import {
    Canvas,
    CanvasEdge,
    CanvasNode,
    CanvasNodeData,
    compileCanvas,
    EmpathyCanvasNodeKind,
    type EmpathyCanvasNodeKind as EmpathyCanvasNodeKindValue,
    generateHeader,
} from "./compile";
import { convertedEmpathyNodeData } from "./canvas";

class MockNode implements CanvasNode {
    constructor(
        readonly id: string,
        private readonly text: string,
        private readonly empathyKind?: EmpathyCanvasNodeKindValue,
        private readonly extraData: Partial<CanvasNodeData> = {},
    ) {}

    getData(): CanvasNodeData {
        return {
            id: this.id,
            type: "text",
            text: this.text,
            ...(this.empathyKind === undefined ? {} : { empathyKind: this.empathyKind }),
            ...this.extraData,
        };
    }
}

class MockEdge implements CanvasEdge {
    readonly from: { node: CanvasNode };
    readonly to: { node: CanvasNode };

    constructor(
        readonly id: string,
        from: CanvasNode,
        to: CanvasNode,
        private readonly edgeLabel?: string,
    ) {
        this.from = { node: from };
        this.to = { node: to };
    }

    getData(): { id: string; label?: string } {
        return { id: this.id, label: this.edgeLabel };
    }
}

function canvas(nodes: MockNode[], edges: MockEdge[]): Canvas {
    return {
        nodes: new Map(nodes.map((node) => [node.id, node])),
        edges: new Map(edges.map((edge) => [edge.id, edge])),
    };
}

function decodedInstructions(bytecode: Uint8Array): Array<{ offset: number; opcode: number }> {
    const sizes = new Map<number, number>();
    for (const name of Object.keys(EmpathyBytecodeOpcode) as Array<keyof typeof EmpathyBytecodeOpcode>) {
        sizes.set(EmpathyBytecodeOpcode[name], EmpathyBytecodeInstructionSize[name]);
    }

    const instructions: Array<{ offset: number; opcode: number }> = [];
    for (let offset = 0; offset < bytecode.length;) {
        const opcode = bytecode[offset];
        const size = sizes.get(opcode);
        assert.notEqual(size, undefined, `unknown opcode at ${offset}`);
        instructions.push({ offset, opcode });
        offset += size!;
        assert.ok(offset <= bytecode.length, "instruction extends past bytecode payload");
    }
    return instructions;
}

test("compiles branching Canvas runtime objects with deterministic choices and convergence", () => {
    const entry = new MockNode("entry", "", EmpathyCanvasNodeKind.ENTRY);
    const intro = new MockNode(
        "intro",
        "The signal tower is still lit.",
        EmpathyCanvasNodeKind.SAY,
        { empathyCharacter: "Mara" },
    );
    const choice = new MockNode("choice", "", EmpathyCanvasNodeKind.CHOICE);
    const signal = new MockNode(
        "signal",
        "The lamp is warm.",
        EmpathyCanvasNodeKind.SAY,
        { empathyCharacter: "Mara" },
    );
    const footprints = new MockNode(
        "footprints",
        "Fresh footprints.",
        EmpathyCanvasNodeKind.SAY,
        { empathyCharacter: "Ilya" },
    );
    const end = new MockNode("end", "", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(canvas(
        [entry, intro, choice, signal, footprints, end],
        [
            new MockEdge("01-entry", entry, intro),
            new MockEdge("02-intro", intro, choice),
            new MockEdge("choice-b", choice, footprints, "Follow the footprints"),
            new MockEdge("choice-a", choice, signal, "Climb to the signal room"),
            new MockEdge("04-signal", signal, end),
            new MockEdge("05-footprints", footprints, end),
        ],
    ));

    assert.deepEqual(result.choices, ["Climb to the signal room", "Follow the footprints"]);
    assert.deepEqual(result.characters, ["Mara", "Ilya"]);
    assert.deepEqual(result.lines, [
        "The signal tower is still lit.",
        "The lamp is warm.",
        "Fresh footprints.",
    ]);
    assert.equal(result.nodeOffsets.size, 5, "ENTRY emits nothing and converging END emits once");
    assert.deepEqual(Object.fromEntries(result.nodeOffsets), {
        intro: 0,
        choice: 32,
        signal: 97,
        footprints: 129,
        end: 161,
    });
    assert.equal(result.bytecode.length, 162);

    const view = new DataView(result.bytecode.buffer, result.bytecode.byteOffset, result.bytecode.byteLength);
    assert.equal(result.bytecode[0], EmpathyBytecodeOpcode.YIELD_PUSH_ATOM);
    assert.equal(view.getUint32(1, true), 0, "line atom type is little-endian");
    assert.equal(view.getUint32(5, true), 0, "line atom id is little-endian");
    assert.equal(view.getUint32(10, true), 1, "character atom type is little-endian");
    assert.equal(view.getUint32(14, true), 0, "character atom id is little-endian");
    assert.equal(view.getUint32(19, true), 2, "SAY yield index is little-endian");
    assert.equal(view.getBigUint64(24, true), 32n, "node jump target is little-endian");
    assert.equal(view.getUint32(51, true), 2, "choice count is little-endian");

    const instructions = decodedInstructions(result.bytecode);
    const boundaries = new Set(instructions.map(({ offset }) => offset));
    const jumps: Array<[number, number]> = [];
    assert.equal(instructions.at(-1)?.opcode, EmpathyBytecodeOpcode.END);
    assert.equal(instructions.filter(({ opcode }) => opcode === EmpathyBytecodeOpcode.END).length, 1);
    for (const { offset, opcode } of instructions) {
        if (
            opcode === EmpathyBytecodeOpcode.JUMP ||
            opcode === EmpathyBytecodeOpcode.JUMP_FALSE ||
            opcode === EmpathyBytecodeOpcode.JUMP_TRUE
        ) {
            const target = Number(view.getBigUint64(offset + 1, true));
            assert.ok(boundaries.has(target), `jump at ${offset} targets instruction boundary ${target}`);
            jumps.push([offset, target]);
        }
    }
    assert.deepEqual(jumps, [
        [23, 32],
        [68, 87],
        [78, 97],
        [88, 129],
        [120, 161],
        [152, 161],
    ]);
    for (const entryPoint of result.entryPoints) {
        assert.ok(boundaries.has(entryPoint.executionOffset));
    }

    const header = generateHeader(result, "radio");
    assert.ok(header.startsWith("#pragma once\n\n"));
    assert.match(header, /^#include <empathy\.h>$/m);
    assert.doesNotMatch(header, /^#(?:if|ifdef|ifndef|endif)\b/m);
    assert.doesNotMatch(header, /RADIO_EMPATHY_GENERATED_H|<stddef\.h>|\bNULL\b/);
    assert.doesNotMatch(header, /#define RADIO_EMPATHY_(?:ATOM|YIELD)_TYPE_/);
    assert.match(
        header,
        /typedef enum RADIO_EMPATHY_AtomType_t\n\{\n    RADIO_EMPATHY_ATOM_TYPE_LINE = 0,\n    RADIO_EMPATHY_ATOM_TYPE_CHARACTER = 1,\n    RADIO_EMPATHY_ATOM_TYPE_CHOICE = 2,\n\} RADIO_EMPATHY_AtomType;/,
    );
    assert.match(
        header,
        /typedef enum RADIO_EMPATHY_YieldType_t\n\{\n    RADIO_EMPATHY_YIELD_TYPE_LINE = 0,\n    RADIO_EMPATHY_YIELD_TYPE_CHOICE = 1,\n    RADIO_EMPATHY_YIELD_TYPE_SAY = 2,\n\} RADIO_EMPATHY_YieldType;/,
    );
    assert.match(header, /RADIO_EMPATHY_CHOICE_0 0u/);
    assert.match(header, /\{0u, EMPATHY_PROGRAM_OFFSET_NONE\}/);
    assert.match(header, /EMPATHY_VALUE_BASE_TYPE_UINT32/);
    const unicodeHeader = generateHeader({ ...result, lines: [...result.lines, "Маяк 👋"] }, "radio");
    assert.doesNotMatch(unicodeHeader, /[^\x00-\x7F]/, "generated header is source-encoding independent");
    assert.match(unicodeHeader, /\\320\\234/, "UTF-8 bytes use fixed-width octal escapes");

    const emptyTablesHeader = generateHeader({ ...result, characters: [], choices: [] }, "empty-tables");
    assert.doesNotMatch(emptyTablesHeader, /\bNULL\b/);
    assert.match(
        emptyTablesHeader,
        /static const char \*const empty_tables_empathy_character_strings\[\] =\n\{\n    0,\n\};/,
    );
});

test("reports focused Canvas semantic errors", () => {
    const end = new MockNode("end", "", EmpathyCanvasNodeKind.END);
    assert.throws(() => compileCanvas(canvas([end], [])), /no ENTRY/);

    const entry = new MockNode("entry", "", EmpathyCanvasNodeKind.ENTRY);
    const unknown = new MockNode("unknown", "NOTE\nNot narrative");
    assert.throws(
        () => compileCanvas(canvas([entry, unknown], [new MockEdge("edge", entry, unknown)])),
        /expected empathyKind metadata/,
    );

    const choice = new MockNode("choice", "", EmpathyCanvasNodeKind.CHOICE);
    assert.throws(
        () => compileCanvas(canvas([entry, choice], [new MockEdge("edge", entry, choice)])),
        /at least one outgoing edge/,
    );
});

test("prefixes generated C identifiers for digit-leading Canvas names", () => {
    const entry = new MockNode("entry", "", EmpathyCanvasNodeKind.ENTRY);
    const end = new MockNode("end", "", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(canvas([entry, end], [new MockEdge("entry-end", entry, end)]));
    const header = generateHeader(result, "123-radio");

    assert.match(header, /typedef enum CANVAS_123_RADIO_EMPATHY_AtomType_t/);
    assert.match(header, /static const Empathy_ProgramLayoutDesc canvas_123_radio_empathy_layout_desc/);
});

test("lowers LINE directly to a line yield", () => {
    const entry = new MockNode("entry", "", EmpathyCanvasNodeKind.ENTRY);
    const line = new MockNode(
        "line",
        "Rain erased the road behind the last train.",
        EmpathyCanvasNodeKind.LINE,
    );
    const end = new MockNode("end", "", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(canvas(
        [entry, line, end],
        [new MockEdge("entry-line", entry, line), new MockEdge("line-end", line, end)],
    ));

    assert.deepEqual(result.lines, ["Rain erased the road behind the last train."]);
    assert.equal(result.bytecode.length, 24);
    assert.equal(result.bytecode[0], EmpathyBytecodeOpcode.YIELD_PUSH_ATOM);
    assert.equal(result.bytecode[9], EmpathyBytecodeOpcode.YIELD);
    assert.equal(result.bytecode[14], EmpathyBytecodeOpcode.JUMP);
    assert.equal(result.bytecode[23], EmpathyBytecodeOpcode.END);
    const view = new DataView(result.bytecode.buffer, result.bytecode.byteOffset, result.bytecode.byteLength);
    assert.equal(view.getUint32(10, true), 0);
    assert.equal(view.getBigUint64(15, true), 23n);
});

test("compiles metadata-typed Canvas nodes", () => {
    const entry = new MockNode("entry", "", EmpathyCanvasNodeKind.ENTRY);
    const say = new MockNode(
        "say",
        "The signal tower is still lit.",
        EmpathyCanvasNodeKind.SAY,
        { empathyCharacter: "Mara" },
    );
    const choice = new MockNode("choice", "", EmpathyCanvasNodeKind.CHOICE);
    const line = new MockNode(
        "line",
        "Rain erased the road behind the last train.",
        EmpathyCanvasNodeKind.LINE,
    );
    const end = new MockNode("end", "", EmpathyCanvasNodeKind.END);
    const result = compileCanvas(canvas(
        [entry, say, choice, line, end],
        [
            new MockEdge("entry-say", entry, say),
            new MockEdge("say-choice", say, choice),
            new MockEdge("choice-line", choice, line, "Continue"),
            new MockEdge("line-end", line, end),
        ],
    ));

    assert.deepEqual(result.characters, ["Mara"]);
    assert.deepEqual(result.lines, [
        "The signal tower is still lit.",
        "Rain erased the road behind the last train.",
    ]);
    assert.deepEqual(result.choices, ["Continue"]);
    assert.deepEqual(result.entryPoints, [{ executionOffset: 0 }]);
    assert.equal(result.bytecode.at(-1), EmpathyBytecodeOpcode.END);

    const malformedSay = new MockNode(
        "bad-say",
        "Dialogue without a character.",
        EmpathyCanvasNodeKind.SAY,
        { empathyCharacter: "" },
    );
    assert.throws(
        () => compileCanvas(canvas(
            [entry, malformedSay, end],
            [
                new MockEdge("entry-bad", entry, malformedSay),
                new MockEdge("bad-end", malformedSay, end),
            ],
        )),
        /expected a non-empty character field and dialogue text/,
    );

    const nodeAfterEnd = new MockNode("after-end", "", EmpathyCanvasNodeKind.END);
    assert.throws(
        () => compileCanvas(canvas(
            [entry, end, nodeAfterEnd],
            [
                new MockEdge("entry-end", entry, end),
                new MockEdge("end-after", end, nodeAfterEnd),
            ],
        )),
        /END node end must not have outgoing edges/,
    );
});

test("converts canonical node kinds without folding character metadata into dialogue", () => {
    const line = convertedEmpathyNodeData({
        type: "text",
        text: "Hello from the tower.",
        empathyKind: EmpathyCanvasNodeKind.SAY,
        empathyCharacter: "Mara",
    }, EmpathyCanvasNodeKind.LINE);
    assert.equal(line.text, "Hello from the tower.");
    assert.equal(line.empathyKind, EmpathyCanvasNodeKind.LINE);
    assert.equal(line.empathyCharacter, undefined);

    const say = convertedEmpathyNodeData(line, EmpathyCanvasNodeKind.SAY);
    assert.equal(say.text, "Hello from the tower.");
    assert.equal(say.empathyCharacter, "Character");
});

test("rejects legacy text markers and combined SAY payloads", () => {
    const markerEntry = new MockNode("marker-entry", "ENTRY");
    const markerEnd = new MockNode("marker-end", "END");
    assert.throws(
        () => compileCanvas(canvas(
            [markerEntry, markerEnd],
            [new MockEdge("marker-edge", markerEntry, markerEnd)],
        )),
        /no ENTRY/,
    );

    const prefixedEntry = new MockNode("prefixed-entry", "", undefined, { type: "empathy-entry" });
    assert.throws(() => compileCanvas(canvas([prefixedEntry], [])), /no ENTRY/);

    const wrongTypeEntry = new MockNode(
        "wrong-type-entry",
        "",
        EmpathyCanvasNodeKind.ENTRY,
        { type: "empathy-entry" },
    );
    assert.throws(() => compileCanvas(canvas([wrongTypeEntry], [])), /no ENTRY/);

    const entry = new MockNode("entry", "", EmpathyCanvasNodeKind.ENTRY);
    const legacySay = new MockNode(
        "legacy-say",
        "Mara\nThis combined payload is not migrated.",
        EmpathyCanvasNodeKind.SAY,
    );
    const end = new MockNode("end", "", EmpathyCanvasNodeKind.END);
    assert.throws(
        () => compileCanvas(canvas(
            [entry, legacySay, end],
            [
                new MockEdge("entry-say", entry, legacySay),
                new MockEdge("say-end", legacySay, end),
            ],
        )),
        /expected a non-empty character field and dialogue text/,
    );
});

test("compiles the bundled signal-tower demo Canvas", () => {
    interface StoredNode extends CanvasNodeData {
        id: string;
        type: string;
        text?: string;
    }
    interface StoredEdge {
        id: string;
        fromNode: string;
        toNode: string;
        label?: string;
    }
    interface StoredCanvas {
        nodes: StoredNode[];
        edges: StoredEdge[];
    }

    const stored = JSON.parse(readFileSync(
        resolve(process.cwd(), "examples", "signal-tower-demo.canvas"),
        "utf8",
    )) as StoredCanvas;
    const nodes = stored.nodes.map((data) => new MockNode(
        data.id,
        data.text ?? "",
        data.empathyKind as EmpathyCanvasNodeKindValue | undefined,
        data,
    ));
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const edges = stored.edges.map((data) => {
        const from = nodesById.get(data.fromNode);
        const to = nodesById.get(data.toNode);
        assert.ok(from, `missing fixture edge source ${data.fromNode}`);
        assert.ok(to, `missing fixture edge target ${data.toNode}`);
        return new MockEdge(data.id, from, to, data.label);
    });

    const result = compileCanvas(canvas(nodes, edges));
    assert.deepEqual(result.entryPoints, [{ executionOffset: 0 }]);
    assert.deepEqual(result.characters, ["Мара", "Илья"]);
    assert.deepEqual(result.choices, ["Подняться на крышу", "Ответить по радио"]);
    assert.equal(result.lines.length, 6);
    assert.equal(
        decodedInstructions(result.bytecode)
            .filter(({ opcode }) => opcode === EmpathyBytecodeOpcode.END)
            .length,
        2,
    );
});
