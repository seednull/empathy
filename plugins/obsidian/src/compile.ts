import {
    BytecodeWriter,
    EMPATHY_BYTECODE_VERSION,
    EmpathyBytecodeOpcode,
} from "./bytecode";

// Deliberately small approximations of Obsidian's undocumented Canvas runtime objects.
// These are POC/internal typings, not a supported Canvas API.
export interface CanvasNodeData {
    id?: string;
    type?: string;
    text?: string;
    empathyKind?: string;
    empathyCharacter?: string;
    [key: string]: unknown;
}

export interface CanvasNode {
    id?: string;
    getData(): CanvasNodeData;
}

export interface CanvasEdge {
    id?: string;
    label?: string;
    from?: { node?: CanvasNode };
    to?: { node?: CanvasNode };
    getData(): {
        id?: string;
        label?: string;
    };
}

export interface Canvas {
    nodes: Map<string, CanvasNode>;
    edges: Map<string, CanvasEdge>;
    readonly?: boolean;
}

export const EmpathyCanvasNodeKind = {
    ENTRY: "entry",
    SAY: "say",
    LINE: "line",
    CHOICE: "choice",
    END: "end",
} as const;

export type EmpathyCanvasNodeKind = typeof EmpathyCanvasNodeKind[keyof typeof EmpathyCanvasNodeKind];

export function getEmpathyCanvasNodeKind(data: CanvasNodeData): EmpathyCanvasNodeKind | undefined {
    if (data.type !== "text") return undefined;
    const value = data.empathyKind;
    return Object.values(EmpathyCanvasNodeKind).find((kind) => kind === value);
}

const EmpathyPocAtomType = {
    LINE: 0,
    CHARACTER: 1,
    CHOICE: 2,
} as const;

const EmpathyPocYieldType = {
    LINE: 0,
    CHOICE: 1,
    SAY: 2,
} as const;

interface JumpPatch {
    operandOffset: number;
    targetNodeId: string;
}

interface CompileState {
    canvas: Canvas;
    writer: BytecodeWriter;
    nodeOffsets: Map<string, number>;
    patches: JumpPatch[];
    queue: CanvasNode[];
    lineIds: Map<string, number>;
    characterIds: Map<string, number>;
    choiceIds: Map<string, number>;
    lines: string[];
    characters: string[];
    choices: string[];
}

export interface CompileResult {
    bytecode: Uint8Array;
    entryPoints: ReadonlyArray<{ executionOffset: number }>;
    lines: readonly string[];
    characters: readonly string[];
    choices: readonly string[];
    nodeOffsets: ReadonlyMap<string, number>;
}

function stableCompare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function nodeId(node: CanvasNode): string {
    const id = node.id ?? node.getData().id;
    if (typeof id !== "string" || id.length === 0) {
        throw new Error("Canvas graph contains a node without an id");
    }
    return id;
}

function edgeId(edge: CanvasEdge): string {
    const id = edge.id ?? edge.getData().id;
    if (typeof id !== "string" || id.length === 0) {
        throw new Error("Canvas graph contains an edge without an id");
    }
    return id;
}

function normalizedNodeText(node: CanvasNode): string {
    const data = node.getData();
    const id = nodeId(node);
    if (data.type !== "text") {
        throw new Error(`Unknown node type at ${id}: expected a Canvas text node`);
    }
    if (typeof data.text !== "string") {
        throw new Error(`Unknown node type at ${id}: expected a Canvas text node`);
    }
    return data.text.replace(/\r\n?/g, "\n").trim();
}

function empathyNodeKind(node: CanvasNode): EmpathyCanvasNodeKind | undefined {
    const data = node.getData();
    const kind = getEmpathyCanvasNodeKind(data);
    if (data.empathyKind !== undefined && kind === undefined) {
        throw new Error(`Unknown Empathy node type at ${nodeId(node)}: ${String(data.empathyKind)}`);
    }
    return kind;
}

function outgoingEdges(canvas: Canvas, node: CanvasNode): CanvasEdge[] {
    const id = nodeId(node);
    return Array.from(canvas.edges.values()).filter((edge) => {
        const from = edge.from?.node;
        if (from === node) {
            return true;
        }
        if (!from) {
            return false;
        }
        const fromId = from.id ?? from.getData().id;
        return fromId === id;
    });
}

function targetNode(state: CompileState, edge: CanvasEdge, sourceNode: CanvasNode): CanvasNode {
    const target = edge.to?.node;
    const sourceId = nodeId(sourceNode);
    if (!target) {
        throw new Error(`Unresolved target on edge ${edgeId(edge)} from node ${sourceId}`);
    }

    const targetId = nodeId(target);
    const canvasTarget = state.canvas.nodes.get(targetId);
    if (!canvasTarget) {
        throw new Error(`Unresolved target ${targetId} from node ${sourceId}`);
    }
    return canvasTarget;
}

function queueTarget(state: CompileState, edge: CanvasEdge, sourceNode: CanvasNode): CanvasNode {
    const target = targetNode(state, edge, sourceNode);
    state.queue.push(target);
    return target;
}

function internAtom(value: string, values: string[], ids: Map<string, number>): number {
    const existing = ids.get(value);
    if (existing !== undefined) {
        return existing;
    }
    const id = values.length;
    values.push(value);
    ids.set(value, id);
    return id;
}

function emitJump(state: CompileState, target: CanvasNode): void {
    state.writer.opcode(EmpathyBytecodeOpcode.JUMP);
    const operandOffset = state.writer.offset;
    state.writer.u64(0n);
    state.patches.push({ operandOffset, targetNodeId: nodeId(target) });
}

function requireSingleOutgoing(state: CompileState, node: CanvasNode, kind: string): CanvasEdge {
    const outgoing = outgoingEdges(state.canvas, node);
    if (outgoing.length !== 1) {
        throw new Error(`${kind} node ${nodeId(node)} must have exactly one outgoing edge; found ${outgoing.length}`);
    }
    return outgoing[0];
}

function compileEntry(state: CompileState, node: CanvasNode): CanvasNode {
    normalizedNodeText(node);
    const edge = requireSingleOutgoing(state, node, "ENTRY");
    return queueTarget(state, edge, node);
}

function compileSay(state: CompileState, node: CanvasNode): void {
    const data = node.getData();
    const character = typeof data.empathyCharacter === "string" ? data.empathyCharacter.trim() : "";
    const line = normalizedNodeText(node);
    if (character.length === 0 || line.length === 0) {
        throw new Error(`SAY node ${nodeId(node)} is malformed; expected a non-empty character field and dialogue text`);
    }

    const edge = requireSingleOutgoing(state, node, "SAY");
    const lineId = internAtom(line, state.lines, state.lineIds);
    const characterId = internAtom(character, state.characters, state.characterIds);

    state.writer.opcode(EmpathyBytecodeOpcode.YIELD_PUSH_ATOM);
    state.writer.atom(EmpathyPocAtomType.LINE, lineId);
    state.writer.opcode(EmpathyBytecodeOpcode.YIELD_PUSH_ATOM);
    state.writer.atom(EmpathyPocAtomType.CHARACTER, characterId);
    state.writer.opcode(EmpathyBytecodeOpcode.YIELD);
    state.writer.u32(EmpathyPocYieldType.SAY);
    emitJump(state, queueTarget(state, edge, node));
}

function compileLine(state: CompileState, node: CanvasNode): void {
    const line = normalizedNodeText(node);
    if (line.length === 0) {
        throw new Error(`LINE node ${nodeId(node)} is malformed; expected line text`);
    }

    const edge = requireSingleOutgoing(state, node, "LINE");
    const lineId = internAtom(line, state.lines, state.lineIds);

    state.writer.opcode(EmpathyBytecodeOpcode.YIELD_PUSH_ATOM);
    state.writer.atom(EmpathyPocAtomType.LINE, lineId);
    state.writer.opcode(EmpathyBytecodeOpcode.YIELD);
    state.writer.u32(EmpathyPocYieldType.LINE);
    emitJump(state, queueTarget(state, edge, node));
}

function compileChoice(state: CompileState, node: CanvasNode): void {
    normalizedNodeText(node);

    const outgoing = outgoingEdges(state.canvas, node);
    if (outgoing.length === 0) {
        throw new Error(`CHOICE node ${nodeId(node)} must have at least one outgoing edge`);
    }
    outgoing.sort((left, right) => stableCompare(edgeId(left), edgeId(right)));

    const targets: CanvasNode[] = [];
    for (const edge of outgoing) {
        const label = edge.getData().label ?? edge.label;
        if (typeof label !== "string" || label.trim().length === 0) {
            throw new Error(`CHOICE edge ${edgeId(edge)} from node ${nodeId(node)} is missing a label`);
        }
        const choiceId = internAtom(label.trim(), state.choices, state.choiceIds);
        state.writer.opcode(EmpathyBytecodeOpcode.YIELD_PUSH_ATOM);
        state.writer.atom(EmpathyPocAtomType.CHOICE, choiceId);
        targets.push(queueTarget(state, edge, node));
    }

    state.writer.opcode(EmpathyBytecodeOpcode.YIELD_PUSH_U32);
    state.writer.u32(outgoing.length);
    state.writer.opcode(EmpathyBytecodeOpcode.YIELD);
    state.writer.u32(EmpathyPocYieldType.CHOICE);
    state.writer.opcode(EmpathyBytecodeOpcode.YIELD_TAKE);

    // Keep the selected index for subsequent comparisons, but drop it before every branch.
    for (let choiceIndex = 0; choiceIndex + 1 < targets.length; ++choiceIndex) {
        state.writer.opcode(EmpathyBytecodeOpcode.DUP);
        state.writer.opcode(EmpathyBytecodeOpcode.PUSH_U32);
        state.writer.u32(choiceIndex);
        state.writer.opcode(EmpathyBytecodeOpcode.EQUAL);
        state.writer.opcode(EmpathyBytecodeOpcode.JUMP_FALSE);
        const nextComparisonOffset = state.writer.offset;
        state.writer.u64(0n);
        state.writer.opcode(EmpathyBytecodeOpcode.DROP);
        emitJump(state, targets[choiceIndex]);
        state.writer.patchU64(nextComparisonOffset, state.writer.offset);
    }

    state.writer.opcode(EmpathyBytecodeOpcode.DROP);
    emitJump(state, targets[targets.length - 1]);
}

function compileEnd(state: CompileState, node: CanvasNode): void {
    normalizedNodeText(node);
    const outgoing = outgoingEdges(state.canvas, node);
    if (outgoing.length !== 0) {
        throw new Error(`END node ${nodeId(node)} must not have outgoing edges; found ${outgoing.length}`);
    }
    state.writer.opcode(EmpathyBytecodeOpcode.END);
}

function compileNode(state: CompileState, node: CanvasNode): void {
    const kind = empathyNodeKind(node);
    switch (kind) {
        case EmpathyCanvasNodeKind.SAY:
            compileSay(state, node);
            return;
        case EmpathyCanvasNodeKind.LINE:
            compileLine(state, node);
            return;
        case EmpathyCanvasNodeKind.CHOICE:
            compileChoice(state, node);
            return;
        case EmpathyCanvasNodeKind.END:
            compileEnd(state, node);
            return;
        case EmpathyCanvasNodeKind.ENTRY:
            throw new Error(`Graph node ${nodeId(node)} reached in an unsupported state: ENTRY`);
        default:
            throw new Error(`Unknown Empathy node type at ${nodeId(node)}: expected empathyKind metadata`);
    }
}

export function compileCanvas(canvas: Canvas): CompileResult {
    if (!(canvas?.nodes instanceof Map) || !(canvas?.edges instanceof Map)) {
        throw new Error("Active Canvas runtime does not expose nodes and edges maps");
    }

    const entries = Array.from(canvas.nodes.values())
        .filter((node) => getEmpathyCanvasNodeKind(node.getData()) === EmpathyCanvasNodeKind.ENTRY)
        .sort((left, right) => stableCompare(nodeId(left), nodeId(right)));
    if (entries.length === 0) {
        throw new Error("Canvas contains no ENTRY node");
    }

    const state: CompileState = {
        canvas,
        writer: new BytecodeWriter(),
        nodeOffsets: new Map(),
        patches: [],
        queue: [],
        lineIds: new Map(),
        characterIds: new Map(),
        choiceIds: new Map(),
        lines: [],
        characters: [],
        choices: [],
    };

    const entryTargets = entries.map((entry) => compileEntry(state, entry));
    for (let queueIndex = 0; queueIndex < state.queue.length; ++queueIndex) {
        const node = state.queue[queueIndex];
        const id = nodeId(node);
        if (state.nodeOffsets.has(id)) {
            continue;
        }
        state.nodeOffsets.set(id, state.writer.offset);
        compileNode(state, node);
    }

    for (const patch of state.patches) {
        const targetOffset = state.nodeOffsets.get(patch.targetNodeId);
        if (targetOffset === undefined) {
            throw new Error(`Unresolved target node ${patch.targetNodeId}`);
        }
        state.writer.patchU64(patch.operandOffset, targetOffset);
    }

    const entryPoints = entryTargets.map((target) => {
        const executionOffset = state.nodeOffsets.get(nodeId(target));
        if (executionOffset === undefined) {
            throw new Error(`Unresolved ENTRY target ${nodeId(target)}`);
        }
        return { executionOffset };
    });

    return {
        bytecode: state.writer.finish(),
        entryPoints,
        lines: state.lines,
        characters: state.characters,
        choices: state.choices,
        nodeOffsets: state.nodeOffsets,
    };
}

function cString(value: string): string {
    let result = "\"";
    for (const byte of new TextEncoder().encode(value)) {
        if (byte === 92) result += "\\\\";
        else if (byte === 34) result += "\\\"";
        else if (byte === 10) result += "\\n";
        else if (byte === 13) result += "\\r";
        else if (byte === 9) result += "\\t";
        else if (byte < 32 || byte >= 127) result += `\\${byte.toString(8).padStart(3, "0")}`;
        else result += String.fromCharCode(byte);
    }
    return result + "\"";
}

function generatedName(sourceName: string): { macro: string; symbol: string } {
    let clean = sourceName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (clean.length === 0) clean = "CANVAS";
    if (/^[0-9]/.test(clean)) clean = `canvas_${clean}`;
    return {
        macro: `${clean.toUpperCase()}_EMPATHY`,
        symbol: `${clean.toLowerCase()}_empathy`,
    };
}

function stringTable(symbol: string, values: readonly string[]): string[] {
    const contents = values.length > 0 ? values.map((value) => `    ${cString(value)},`) : ["    0,"];
    return [
        `static const char *const ${symbol}[] =`,
        "{",
        ...contents,
        "};",
    ];
}

function atomRange(count: number): { min: number; max: number } {
    return count === 0 ? { min: 1, max: 0 } : { min: 0, max: count - 1 };
}

export function generateHeader(result: CompileResult, sourceName: string): string {
    const { macro, symbol } = generatedName(sourceName);
    const lineRange = atomRange(result.lines.length);
    const characterRange = atomRange(result.characters.length);
    const choiceRange = atomRange(result.choices.length);
    const lines: string[] = [
        "#pragma once",
        "",
        "// Generated by the Empathy Obsidian POC. Do not edit manually.",
        "#include <empathy.h>",
        "",
        `typedef enum ${macro}_AtomType_t`,
        "{",
        `    ${macro}_ATOM_TYPE_LINE = ${EmpathyPocAtomType.LINE},`,
        `    ${macro}_ATOM_TYPE_CHARACTER = ${EmpathyPocAtomType.CHARACTER},`,
        `    ${macro}_ATOM_TYPE_CHOICE = ${EmpathyPocAtomType.CHOICE},`,
        `} ${macro}_AtomType;`,
        "",
        `typedef enum ${macro}_YieldType_t`,
        "{",
        `    ${macro}_YIELD_TYPE_LINE = ${EmpathyPocYieldType.LINE},`,
        `    ${macro}_YIELD_TYPE_CHOICE = ${EmpathyPocYieldType.CHOICE},`,
        `    ${macro}_YIELD_TYPE_SAY = ${EmpathyPocYieldType.SAY},`,
        `} ${macro}_YieldType;`,
        "",
        `#define ${macro}_LINE_COUNT ${result.lines.length}u`,
        `#define ${macro}_CHARACTER_COUNT ${result.characters.length}u`,
        `#define ${macro}_CHOICE_COUNT ${result.choices.length}u`,
        `#define ${macro}_ENTRY_POINT_COUNT ${result.entryPoints.length}u`,
        `#define ${macro}_BYTECODE_VERSION 0x${EMPATHY_BYTECODE_VERSION.toString(16).toUpperCase().padStart(8, "0")}u`,
        `#define ${macro}_BYTECODE_SIZE ${result.bytecode.length}u`,
        "",
    ];

    for (let id = 0; id < result.lines.length; ++id) lines.push(`#define ${macro}_LINE_${id} ${id}u`);
    for (let id = 0; id < result.characters.length; ++id) lines.push(`#define ${macro}_CHARACTER_${id} ${id}u`);
    for (let id = 0; id < result.choices.length; ++id) lines.push(`#define ${macro}_CHOICE_${id} ${id}u`);
    lines.push("");

    lines.push(...stringTable(`${symbol}_line_strings`, result.lines), "");
    lines.push(...stringTable(`${symbol}_character_strings`, result.characters), "");
    lines.push(...stringTable(`${symbol}_choice_strings`, result.choices), "");
    lines.push(
        `static const Empathy_AtomTypeDesc ${symbol}_atom_types[] =`,
        "{",
        `    {${macro}_ATOM_TYPE_LINE, ${lineRange.min}u, ${lineRange.max}u},`,
        `    {${macro}_ATOM_TYPE_CHARACTER, ${characterRange.min}u, ${characterRange.max}u},`,
        `    {${macro}_ATOM_TYPE_CHOICE, ${choiceRange.min}u, ${choiceRange.max}u},`,
        "};",
        "",
        `static const Empathy_ValueType ${symbol}_choice_resume_types[] =`,
        "{",
        "    {EMPATHY_VALUE_BASE_TYPE_UINT32, 0u},",
        "};",
        "",
        `static const Empathy_YieldDesc ${symbol}_yields[] =`,
        "{",
        "    {0u, 0},",
        `    {1u, ${symbol}_choice_resume_types},`,
        "    {0u, 0},",
        "};",
        "",
        `static const Empathy_ProgramLayoutDesc ${symbol}_layout_desc =`,
        "{",
        `    3u, ${symbol}_atom_types,`,
        "    0u, 0,",
        `    3u, ${symbol}_yields,`,
        "};",
        "",
        `static const Empathy_EntryPointDesc ${symbol}_entry_points[] =`,
        "{",
    );
    for (const entryPoint of result.entryPoints) {
        lines.push(`    {${entryPoint.executionOffset}u, EMPATHY_PROGRAM_OFFSET_NONE},`);
    }
    lines.push(
        "};",
        "",
    );
    return lines.join("\n");
}
