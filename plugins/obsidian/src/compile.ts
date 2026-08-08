import {
    BytecodeWriter,
    EMPATHY_BYTECODE_VERSION,
    EmpathyBytecodeOpcode,
} from "./bytecode";
import {
    AuthoredAtom,
    AuthoredAtomType,
    isAuthoredAtom,
    isValidAtomKey,
    isValidAtomValue,
} from "./atoms";

// Deliberately small approximations of Obsidian's undocumented Canvas runtime objects.
// These are POC/internal typings, not a supported Canvas API.
export interface CanvasNodeData {
    id?: string;
    type?: string;
    text?: string;
    empathyKind?: string;
    empathyCharacter?: string;
    empathyAssignments?: NarrativeAssignment[];
    empathyEntryCondition?: NarrativeCondition;
    empathyEntryMatchValue?: string;
    empathyLineAtom?: AuthoredAtom;
    empathyChoices?: NarrativeChoice[];
    empathyPortalId?: string;
    empathyPortalName?: string;
    [key: string]: unknown;
}

export interface CanvasNode {
    id: string;
    getData(): CanvasNodeData;
    setData(data: CanvasNodeData): void;
}

export interface CanvasEdgeData {
    id?: string;
    label?: string;
    empathyCondition?: NarrativeCondition;
    empathyElse?: boolean;
    empathyConditionOrder?: number;
    empathyChoiceAtom?: number;
    [key: string]: unknown;
}

export interface CanvasEdge {
    id: string;
    from?: { node?: CanvasNode };
    to?: { node?: CanvasNode };
    getData(): CanvasEdgeData;
    setData(data: CanvasEdgeData): void;
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
    SET: "set",
    PORTAL_RECEIVER: "portal-receiver",
    PORTAL_TRANSMITTER: "portal-transmitter",
    END: "end",
} as const;

export type EmpathyCanvasNodeKind = typeof EmpathyCanvasNodeKind[keyof typeof EmpathyCanvasNodeKind];

export const NarrativeVariableType = {
    BOOLEAN: "boolean",
    INTEGER: "integer",
    FLOAT: "float",
} as const;

export type NarrativeVariableType = typeof NarrativeVariableType[keyof typeof NarrativeVariableType];

export const NarrativeVariableAccess = {
    READ: "read",
    WRITE: "write",
    READ_WRITE: "read-write",
} as const;

export type NarrativeVariableAccess = typeof NarrativeVariableAccess[keyof typeof NarrativeVariableAccess];

export interface NarrativeVariable {
    name: string;
    type: NarrativeVariableType;
    access: NarrativeVariableAccess;
}

export type NarrativeComparison = "==" | "!=" | "<" | "<=" | ">" | ">=";

export interface NarrativeCondition {
    variable: string;
    comparison: NarrativeComparison;
    literal: string;
}

export interface NarrativeAssignment {
    variable: string;
    operation: string;
    literal: string;
}

export interface NarrativeChoice {
    atom: AuthoredAtom;
    text: string;
    condition?: NarrativeCondition;
}

interface ParsedVariableName {
    tableName: string;
    variableName: string;
}

export interface CanvasIssue {
    message: string;
    nodeId?: string;
    edgeId?: string;
}

export interface AtomSource extends AuthoredAtom {
    type: typeof AuthoredAtomType.LINE | typeof AuthoredAtomType.CHOICE;
    text: string;
    nodeId: string;
    nodeKind: EmpathyCanvasNodeKind;
    character?: string;
    optionAtomValue?: number;
}

interface CompiledAuthoredAtom extends AuthoredAtom {
    text: string;
}

interface CompiledParameter extends NarrativeVariable, ParsedVariableName {
    parameterIndex: number;
    tableIndex: number;
}

export interface CompileResult {
    bytecode: Uint8Array;
    entryPoints: ReadonlyArray<{
        executionOffset: number;
        predicateOffset?: number;
        name: string;
    }>;
    lines: readonly CompiledAuthoredAtom[];
    characters: readonly string[];
    choices: readonly CompiledAuthoredAtom[];
    nodeOffsets: ReadonlyMap<string, number>;
    tables: ReadonlyArray<{ name: string; index: number }>;
    parameters: ReadonlyArray<CompiledParameter>;
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
    parameters: Map<string, CompiledParameter>;
    nodeOffsets: Map<string, number>;
    patches: JumpPatch[];
    queue: CanvasNode[];
    characterIds: Map<string, number>;
    lineValues: Set<number>;
    choiceValues: Set<number>;
    lines: CompiledAuthoredAtom[];
    characters: string[];
    choices: CompiledAuthoredAtom[];
}

export function parseVariableName(name: string): ParsedVariableName | undefined {
    if (typeof name !== "string" || name !== name.trim()) return undefined;
    const parts = name.split(".");
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) return undefined;
    return { tableName: parts[0], variableName: parts[1] };
}

export function getEmpathyCanvasNodeKind(data: CanvasNodeData): EmpathyCanvasNodeKind | undefined {
    if (data.type !== "text") return undefined;
    const value = data.empathyKind;
    return Object.values(EmpathyCanvasNodeKind).find((kind) => kind === value);
}

function normalizedNodeText(node: CanvasNode): string {
    const data = node.getData();
    if (data.type !== "text" || typeof data.text !== "string") {
        throw new Error(`Unknown node type at ${node.id}: expected a Canvas text node`);
    }
    return data.text.replace(/\r\n?/g, "\n").trim();
}

function outgoingEdges(canvas: Canvas, node: CanvasNode): CanvasEdge[] {
    return Array.from(canvas.edges.values()).filter((edge) => edge.from?.node === node);
}

function incomingEdges(canvas: Canvas, node: CanvasNode): CanvasEdge[] {
    return Array.from(canvas.edges.values()).filter((edge) => edge.to?.node === node);
}

function portalNodes(canvas: Canvas, portalId: string, kind: EmpathyCanvasNodeKind): CanvasNode[] {
    return Array.from(canvas.nodes.values()).filter((node) => {
        const data = node.getData();
        return getEmpathyCanvasNodeKind(data) === kind && data.empathyPortalId === portalId;
    });
}

function targetNode(canvas: Canvas, edge: CanvasEdge, sourceNode: CanvasNode): CanvasNode {
    const target = edge.to?.node;
    if (!target) {
        throw new Error(`Unresolved target on edge ${edge.id} from node ${sourceNode.id}`);
    }
    const canvasTarget = canvas.nodes.get(target.id);
    if (!canvasTarget) {
        throw new Error(`Unresolved target ${target.id} from node ${sourceNode.id}`);
    }
    return canvasTarget;
}

function isReadable(variable: NarrativeVariable): boolean {
    return variable.access === NarrativeVariableAccess.READ ||
        variable.access === NarrativeVariableAccess.READ_WRITE;
}

function isWritable(variable: NarrativeVariable): boolean {
    return variable.access === NarrativeVariableAccess.WRITE ||
        variable.access === NarrativeVariableAccess.READ_WRITE;
}

function parsedLiteral(variable: NarrativeVariable, literal: unknown): boolean | number | undefined {
    if (typeof literal !== "string") return undefined;
    if (variable.type === NarrativeVariableType.BOOLEAN) {
        if (literal === "true") return true;
        if (literal === "false") return false;
        return undefined;
    }
    if (variable.type === NarrativeVariableType.INTEGER) {
        if (!/^[+-]?\d+$/.test(literal)) return undefined;
        const value = Number(literal);
        return Number.isSafeInteger(value) && value >= -0x80000000 && value <= 0x7FFFFFFF
            ? value
            : undefined;
    }
    const value = literal.trim().length > 0 ? Number(literal) : Number.NaN;
    return Number.isFinite(value) && Number.isFinite(Math.fround(value)) ? value : undefined;
}

function isCondition(value: unknown): value is NarrativeCondition {
    if (!value || typeof value !== "object") return false;
    const condition = value as Partial<NarrativeCondition>;
    const keys = Object.keys(condition);
    return keys.length === 3 && keys.every((key) => key === "variable" || key === "comparison" || key === "literal") &&
        typeof condition.variable === "string" &&
        typeof condition.comparison === "string" &&
        typeof condition.literal === "string";
}

export function isNarrativeChoice(value: unknown): value is NarrativeChoice {
    if (!value || typeof value !== "object") return false;
    const choice = value as Partial<NarrativeChoice>;
    const keys = Object.keys(choice);
    return keys.includes("atom") && keys.includes("text") &&
        keys.every((key) => key === "atom" || key === "text" || key === "condition") &&
        isAuthoredAtom(choice.atom) && typeof choice.text === "string" &&
        (choice.condition === undefined || isCondition(choice.condition));
}

export function collectCanvasAtoms(canvas: Canvas): AtomSource[] {
    if (!(canvas?.nodes instanceof Map)) return [];
    const result: AtomSource[] = [];
    for (const node of canvas.nodes.values()) {
        const data = node.getData();
        const kind = getEmpathyCanvasNodeKind(data);
        if ((kind === EmpathyCanvasNodeKind.SAY || kind === EmpathyCanvasNodeKind.LINE) && isAuthoredAtom(data.empathyLineAtom)) {
            result.push({
                ...data.empathyLineAtom,
                type: AuthoredAtomType.LINE,
                text: typeof data.text === "string" ? data.text.replace(/\r\n?/g, "\n").trim() : "",
                nodeId: node.id,
                nodeKind: kind,
                character: kind === EmpathyCanvasNodeKind.SAY && typeof data.empathyCharacter === "string"
                    ? data.empathyCharacter.trim()
                    : undefined,
            });
        }
        if (kind === EmpathyCanvasNodeKind.CHOICE && Array.isArray(data.empathyChoices)) {
            for (const value of data.empathyChoices as unknown[]) {
                if (!isNarrativeChoice(value)) continue;
                result.push({
                    ...value.atom,
                    type: AuthoredAtomType.CHOICE,
                    text: value.text.trim(),
                    nodeId: node.id,
                    nodeKind: kind,
                    optionAtomValue: value.atom.value,
                });
            }
        }
    }
    return result;
}

function issueForNode(issues: CanvasIssue[], node: CanvasNode, message: string): void {
    issues.push({ nodeId: node.id, message });
}

function issueForEdge(issues: CanvasIssue[], edge: CanvasEdge, message: string): void {
    issues.push({ edgeId: edge.id, message });
}

function validateCondition(
    condition: unknown,
    variables: ReadonlyMap<string, NarrativeVariable>,
    issues: CanvasIssue[],
    location: CanvasNode | CanvasEdge,
    prefix = "",
): void {
    const report = (message: string): void => {
        if ("from" in location) issueForEdge(issues, location, `${prefix}${message}`);
        else issueForNode(issues, location, `${prefix}${message}`);
    };
    if (!isCondition(condition)) {
        report("Condition is incomplete; select a variable, comparison, and literal");
        return;
    }
    const variable = variables.get(condition.variable);
    if (!variable) {
        report(`Variable ${condition.variable || "(not selected)"} is missing`);
        return;
    }
    if (!isReadable(variable)) {
        report(`Variable ${variable.name} is write-only and cannot be used in a condition`);
    }
    const numericComparisons: readonly NarrativeComparison[] = ["==", "!=", "<", "<=", ">", ">="];
    const allowed = variable.type === NarrativeVariableType.BOOLEAN
        ? condition.comparison === "=="
        : numericComparisons.includes(condition.comparison as NarrativeComparison);
    if (!allowed) report(`Comparison ${condition.comparison} is not valid for ${variable.type} ${variable.name}`);
    if (parsedLiteral(variable, condition.literal) === undefined) {
        report(`Literal ${JSON.stringify(condition.literal)} is not a valid ${variable.type} value for ${variable.name}`);
    }
}

function validateAuthoredAtoms(canvas: Canvas, issues: CanvasIssue[]): void {
    const values = new Map<AtomSource["type"], Map<number, CanvasNode>>([
        [AuthoredAtomType.LINE, new Map()],
        [AuthoredAtomType.CHOICE, new Map()],
    ]);
    const keys = new Map<AtomSource["type"], Map<string, CanvasNode>>([
        [AuthoredAtomType.LINE, new Map()],
        [AuthoredAtomType.CHOICE, new Map()],
    ]);
    const validate = (type: AtomSource["type"], atom: unknown, node: CanvasNode, label: string): void => {
        if (!atom || typeof atom !== "object") {
            issueForNode(issues, node, `${label} is missing stable ${type.toUpperCase()} atom metadata`);
            return;
        }
        const candidate = atom as Partial<AuthoredAtom>;
        const unsupported = Object.keys(candidate).filter((key) => key !== "value" && key !== "key");
        if (unsupported.length > 0) {
            issueForNode(issues, node, `${label} has unsupported ${type.toUpperCase()} atom metadata: ${unsupported.join(", ")}`);
        }
        if (!isValidAtomValue(candidate.value)) {
            issueForNode(issues, node, `${label} has an invalid ${type.toUpperCase()} atom value`);
        } else {
            const owner = values.get(type)!.get(candidate.value);
            if (owner && owner !== node) {
                issueForNode(issues, node, `${type.toUpperCase()} atom value ${candidate.value} is duplicated`);
            } else if (owner === node && type === AuthoredAtomType.CHOICE) {
                issueForNode(issues, node, `${type.toUpperCase()} atom value ${candidate.value} is duplicated`);
            } else values.get(type)!.set(candidate.value, node);
        }
        if (!isValidAtomKey(candidate.key)) {
            issueForNode(issues, node, `${label} has an empty or invalid ${type.toUpperCase()} atom key`);
        } else {
            const owner = keys.get(type)!.get(candidate.key);
            if (owner && owner !== node) {
                issueForNode(issues, node, `${type.toUpperCase()} atom key ${candidate.key} is duplicated`);
            } else if (owner === node && type === AuthoredAtomType.CHOICE) {
                issueForNode(issues, node, `${type.toUpperCase()} atom key ${candidate.key} is duplicated`);
            } else keys.get(type)!.set(candidate.key, node);
        }
    };
    for (const node of canvas.nodes.values()) {
        const data = node.getData();
        const kind = getEmpathyCanvasNodeKind(data);
        if (kind === EmpathyCanvasNodeKind.SAY || kind === EmpathyCanvasNodeKind.LINE) {
            validate(AuthoredAtomType.LINE, data.empathyLineAtom, node, kind.toUpperCase());
        } else if (kind === EmpathyCanvasNodeKind.CHOICE && Array.isArray(data.empathyChoices)) {
            (data.empathyChoices as unknown[]).forEach((choice, index) => {
                const atom = choice && typeof choice === "object" ? (choice as Partial<NarrativeChoice>).atom : undefined;
                validate(AuthoredAtomType.CHOICE, atom, node, `CHOICE option ${index}`);
            });
        }
    }
}

function validateVariableConfiguration(variables: readonly NarrativeVariable[]): CanvasIssue[] {
    const issues: CanvasIssue[] = [];
    const names = new Set<string>();
    for (let index = 0; index < variables.length; ++index) {
        const variable = variables[index];
        if (!parseVariableName(variable.name)) {
            issues.push({ message: `Variable ${index + 1} must use exactly table.variable with two non-empty parts` });
        }
        if (names.has(variable.name)) issues.push({ message: `Variable name ${variable.name} is duplicated` });
        names.add(variable.name);
        if (!Object.values(NarrativeVariableType).includes(variable.type)) {
            issues.push({ message: `Variable ${variable.name} has unsupported type ${String(variable.type)}` });
        }
        if (!Object.values(NarrativeVariableAccess).includes(variable.access)) {
            issues.push({ message: `Variable ${variable.name} has unsupported access ${String(variable.access)}` });
        }
    }
    return issues;
}

function validTarget(
    canvas: Canvas,
    edge: CanvasEdge,
    source: CanvasNode,
    issues: CanvasIssue[],
): CanvasNode | undefined {
    try {
        return targetNode(canvas, edge, source);
    } catch (error) {
        issueForEdge(issues, edge, error instanceof Error ? error.message : String(error));
        return undefined;
    }
}

function validateOrderedConditionalEdges(
    canvas: Canvas,
    source: CanvasNode,
    edges: CanvasEdge[],
    variables: ReadonlyMap<string, NarrativeVariable>,
    issues: CanvasIssue[],
    queue: CanvasNode[],
): void {
    const orders = new Set<number>();
    let elseCount = 0;
    for (const edge of edges) {
        const data = edge.getData();
        if (!data.empathyElse && data.empathyCondition === undefined) {
            issueForEdge(issues, edge, "Every edge in a conditional fan-out must have a condition or be else");
        }
        if (data.empathyElse) {
            ++elseCount;
            if (data.empathyCondition !== undefined) {
                issueForEdge(issues, edge, "An else edge cannot also have a condition");
            }
            if (data.empathyConditionOrder !== undefined) {
                issueForEdge(issues, edge, "An else edge cannot have an evaluation order");
            }
        } else {
            if (!Number.isInteger(data.empathyConditionOrder) || (data.empathyConditionOrder ?? -1) < 0) {
                issueForEdge(issues, edge, "Conditional edge is missing a non-negative authored order");
            } else {
                const order = data.empathyConditionOrder!;
                if (orders.has(order)) issueForEdge(issues, edge, `Conditional edge order ${order} is duplicated`);
                orders.add(order);
            }
            validateCondition(data.empathyCondition, variables, issues, edge);
        }
        const target = validTarget(canvas, edge, source, issues);
        if (target) queue.push(target);
    }
    if (elseCount > 1) issueForNode(issues, source, "Conditional fan-out has more than one else edge");
}

function validateContinuation(
    canvas: Canvas,
    node: CanvasNode,
    kind: string,
    variables: ReadonlyMap<string, NarrativeVariable>,
    issues: CanvasIssue[],
    queue: CanvasNode[],
): void {
    const edges = outgoingEdges(canvas, node);
    if (edges.length === 0) {
        issueForNode(issues, node, `${kind} node must have at least one outgoing continuation`);
        return;
    }
    const normal = edges.filter((edge) => !edge.getData().empathyElse && edge.getData().empathyCondition === undefined);
    if (edges.length === 1 && normal.length === 1) {
        const target = validTarget(canvas, edges[0], node, issues);
        if (target) queue.push(target);
        return;
    }
    if (normal.length > 0) {
        issueForNode(issues, node, `${kind} fan-out mixes unconditional and conditional edges`);
    }
    validateOrderedConditionalEdges(canvas, node, edges, variables, issues, queue);
}

function validatePortalReceiver(
    canvas: Canvas,
    receiver: CanvasNode,
    issues: CanvasIssue[],
    queue: CanvasNode[],
): void {
    const data = receiver.getData();
    const portalId = data.empathyPortalId;
    if (typeof portalId !== "string" || portalId.length === 0) {
        issueForNode(issues, receiver, "PORTAL RECEIVER requires a portal id");
    }
    const outgoing = outgoingEdges(canvas, receiver);
    if (outgoing.length !== 0) {
        issueForNode(issues, receiver, `PORTAL RECEIVER must not have outgoing visual edges; found ${outgoing.length}`);
    }
    if (typeof portalId !== "string" || portalId.length === 0) return;

    const transmitters = portalNodes(canvas, portalId, EmpathyCanvasNodeKind.PORTAL_TRANSMITTER);
    if (transmitters.length !== 1) {
        issueForNode(issues, receiver, `Portal ${portalId} must have exactly one TRANSMITTER; found ${transmitters.length}`);
        return;
    }

    const transmitter = transmitters[0];
    const transmitterData = transmitter.getData();
    if (typeof transmitterData.empathyPortalName !== "string" || transmitterData.empathyPortalName.trim().length === 0) {
        issueForNode(issues, transmitter, "PORTAL TRANSMITTER requires a non-empty name");
    }
    const incoming = incomingEdges(canvas, transmitter);
    if (incoming.length !== 0) {
        issueForNode(issues, transmitter, `PORTAL TRANSMITTER must not have incoming visual edges; found ${incoming.length}`);
    }
    const transmitterEdges = outgoingEdges(canvas, transmitter);
    if (transmitterEdges.length !== 1) {
        issueForNode(issues, transmitter, `PORTAL TRANSMITTER must have exactly one outgoing edge; found ${transmitterEdges.length}`);
        return;
    }
    const edge = transmitterEdges[0];
    const edgeData = edge.getData();
    if (edgeData.empathyCondition !== undefined || edgeData.empathyElse || edgeData.empathyChoiceAtom !== undefined) {
        issueForEdge(issues, edge, "PORTAL TRANSMITTER continuation must be a normal, unconditional edge");
    }
    const target = validTarget(canvas, edge, transmitter, issues);
    if (target) queue.push(target);
}

export function validateCanvas(canvas: Canvas, variables: readonly NarrativeVariable[] = []): CanvasIssue[] {
    const issues = validateVariableConfiguration(variables);
    if (!(canvas?.nodes instanceof Map) || !(canvas?.edges instanceof Map)) {
        return [...issues, { message: "Active Canvas runtime does not expose nodes and edges maps" }];
    }
    for (const edge of canvas.edges.values()) {
        if (Object.prototype.hasOwnProperty.call(edge.getData(), "empathyChoiceIndex")) {
            issueForEdge(issues, edge, "Obsolete empathyChoiceIndex metadata is not supported");
        }
    }
    validateAuthoredAtoms(canvas, issues);
    const variableMap = new Map(variables.map((variable) => [variable.name, variable]));
    const entries = Array.from(canvas.nodes.values())
        .filter((node) => getEmpathyCanvasNodeKind(node.getData()) === EmpathyCanvasNodeKind.ENTRY)
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    if (entries.length === 0) return [...issues, { message: "Canvas contains no ENTRY node" }];

    const queue: CanvasNode[] = [];
    for (const entry of entries) {
        const data = entry.getData();
        if (typeof data.text !== "string" || data.text.trim().length === 0) {
            issueForNode(issues, entry, "ENTRY requires a non-empty name");
        }
        const edges = outgoingEdges(canvas, entry);
        if (edges.length !== 1) {
            issueForNode(issues, entry, `ENTRY node must have exactly one outgoing edge; found ${edges.length}`);
        } else {
            const edgeData = edges[0].getData();
            if (edgeData.empathyCondition !== undefined || edgeData.empathyElse) {
                issueForEdge(issues, edges[0], "ENTRY continuation must be a normal, unconditional edge");
            }
            const target = validTarget(canvas, edges[0], entry, issues);
            if (target) queue.push(target);
        }
        if (data.empathyEntryCondition !== undefined) {
            validateCondition(data.empathyEntryCondition, variableMap, issues, entry);
            const match = Number(data.empathyEntryMatchValue);
            if (!Number.isInteger(match) || match < 0 || match > 0xFFFFFFFF) {
                issueForNode(issues, entry, "ENTRY predicate requires a UINT32 match value");
            }
        } else if (data.empathyEntryMatchValue !== undefined && data.empathyEntryMatchValue !== "") {
            issueForNode(issues, entry, "ENTRY match value requires an availability predicate");
        }
    }

    const visited = new Set<string>();
    for (let index = 0; index < queue.length; ++index) {
        const node = queue[index];
        const id = node.id;
        if (visited.has(id)) continue;
        visited.add(id);
        const data = node.getData();
        const kind = getEmpathyCanvasNodeKind(data);
        if (!kind) {
            issueForNode(issues, node, `Unsupported semantic node reached from ENTRY at ${id}; expected empathyKind metadata`);
            continue;
        }
        if (kind === EmpathyCanvasNodeKind.ENTRY) {
            issueForNode(issues, node, "An ENTRY node cannot be reached as an executable continuation");
            continue;
        }
        if (kind === EmpathyCanvasNodeKind.SAY) {
            if (typeof data.empathyCharacter !== "string" || data.empathyCharacter.trim().length === 0 ||
                typeof data.text !== "string" || data.text.trim().length === 0) {
                issueForNode(issues, node, "SAY requires a non-empty character and dialogue");
            }
            validateContinuation(canvas, node, "SAY", variableMap, issues, queue);
        } else if (kind === EmpathyCanvasNodeKind.LINE) {
            if (typeof data.text !== "string" || data.text.trim().length === 0) {
                issueForNode(issues, node, "LINE requires non-empty text");
            }
            validateContinuation(canvas, node, "LINE", variableMap, issues, queue);
        } else if (kind === EmpathyCanvasNodeKind.SET) {
            const assignments = Array.isArray(data.empathyAssignments) ? data.empathyAssignments : [];
            if (assignments.length === 0) issueForNode(issues, node, "SET must define at least one assignment");
            assignments.forEach((assignment, assignmentIndex) => {
                if (!assignment || typeof assignment !== "object") {
                    issueForNode(issues, node, `SET assignment ${assignmentIndex} is malformed`);
                    return;
                }
                const assignmentKeys = Object.keys(assignment);
                if (assignmentKeys.length !== 3 ||
                    !assignmentKeys.includes("variable") || !assignmentKeys.includes("operation") || !assignmentKeys.includes("literal")) {
                    issueForNode(issues, node, `SET assignment ${assignmentIndex} does not match the current metadata schema`);
                    return;
                }
                const variable = typeof assignment.variable === "string"
                    ? variableMap.get(assignment.variable)
                    : undefined;
                if (!variable) {
                    issueForNode(issues, node, `SET assignment ${assignmentIndex}: variable ${String(assignment.variable || "(not selected)")} is missing`);
                    return;
                }
                const operation = String(assignment.operation);
                if (operation === "=" && !isWritable(variable)) {
                    issueForNode(issues, node, `SET assignment ${assignmentIndex}: variable ${variable.name} is read-only and cannot be assigned`);
                } else if ((operation === "+=" || operation === "-=") && (!isReadable(variable) || !isWritable(variable))) {
                    issueForNode(
                        issues,
                        node,
                        `SET assignment ${assignmentIndex}: compound assignment ${operation} requires both read and write access to ${variable.name}`,
                    );
                }
                const operations = variable.type === NarrativeVariableType.BOOLEAN ? ["="] : ["=", "+=", "-="];
                if (!operations.includes(operation)) {
                    issueForNode(issues, node, `SET assignment ${assignmentIndex}: operation ${String(assignment.operation)} is not valid for ${variable.type} ${variable.name}`);
                }
                if (parsedLiteral(variable, assignment.literal) === undefined) {
                    issueForNode(issues, node, `SET assignment ${assignmentIndex}: literal ${JSON.stringify(assignment.literal)} is not valid for ${variable.type} ${variable.name}`);
                }
            });
            const edges = outgoingEdges(canvas, node);
            if (edges.length !== 1) {
                issueForNode(issues, node, `SET node must have exactly one outgoing edge; found ${edges.length}`);
            } else {
                const edgeData = edges[0].getData();
                if (edgeData.empathyCondition !== undefined || edgeData.empathyElse) {
                    issueForEdge(issues, edges[0], "SET continuation must be a normal, unconditional edge");
                }
                const target = validTarget(canvas, edges[0], node, issues);
                if (target) queue.push(target);
            }
        } else if (kind === EmpathyCanvasNodeKind.CHOICE) {
            const edges = outgoingEdges(canvas, node);
            const choices = Array.isArray(data.empathyChoices) ? data.empathyChoices as unknown[] : [];
            if (choices.length === 0) issueForNode(issues, node, "CHOICE must define at least one option");
            choices.forEach((choice, choiceIndex) => {
                if (!choice || typeof choice !== "object") {
                    issueForNode(issues, node, `CHOICE option ${choiceIndex} is missing authored option metadata`);
                    return;
                }
                const option = choice as Partial<NarrativeChoice>;
                const optionKeys = Object.keys(option);
                if (!optionKeys.includes("atom") || !optionKeys.includes("text") ||
                    optionKeys.some((key) => key !== "atom" && key !== "text" && key !== "condition")) {
                    issueForNode(issues, node, `CHOICE option ${choiceIndex} does not match the current metadata schema`);
                    return;
                }
                if (typeof option.text !== "string" || option.text.trim().length === 0) {
                    issueForNode(issues, node, `CHOICE option ${choiceIndex} requires non-empty text`);
                }
                if (option.condition !== undefined) {
                    validateCondition(option.condition, variableMap, issues, node, `CHOICE option ${choiceIndex}: `);
                }
            });
            if (edges.length !== choices.length) {
                issueForNode(issues, node, `CHOICE must have exactly one edge per option; found ${choices.length} options and ${edges.length} edges`);
            }
            const optionValues = new Set(choices.flatMap((choice) => {
                const atom = choice && typeof choice === "object" ? (choice as Partial<NarrativeChoice>).atom : undefined;
                return isValidAtomValue(atom?.value) ? [atom.value] : [];
            }));
            const linked = new Set<number>();
            for (const edge of edges) {
                const edgeData = edge.getData();
                if (!isValidAtomValue(edgeData.empathyChoiceAtom)) {
                    issueForEdge(issues, edge, "CHOICE edge is not linked to an option");
                } else if (!optionValues.has(edgeData.empathyChoiceAtom)) {
                    issueForEdge(issues, edge, `CHOICE edge references missing option atom ${edgeData.empathyChoiceAtom}`);
                } else if (linked.has(edgeData.empathyChoiceAtom)) {
                    issueForEdge(issues, edge, `CHOICE option atom ${edgeData.empathyChoiceAtom} is linked more than once`);
                } else linked.add(edgeData.empathyChoiceAtom);
                if (edgeData.empathyCondition !== undefined || edgeData.empathyElse) {
                    issueForEdge(issues, edge, "CHOICE option edges cannot also be conditional transitions");
                }
                const target = validTarget(canvas, edge, node, issues);
                if (target) queue.push(target);
            }
            if (linked.size !== choices.length && edges.length === choices.length) {
                issueForNode(issues, node, "Every CHOICE option must be linked to exactly one edge");
            }
        } else if (kind === EmpathyCanvasNodeKind.PORTAL_RECEIVER) {
            validatePortalReceiver(canvas, node, issues, queue);
        } else if (kind === EmpathyCanvasNodeKind.PORTAL_TRANSMITTER) {
            issueForNode(issues, node, "PORTAL TRANSMITTER cannot accept incoming visual edges; connect flow to its RECEIVER");
        } else if (kind === EmpathyCanvasNodeKind.END) {
            const edges = outgoingEdges(canvas, node);
            if (edges.length !== 0) issueForNode(issues, node, `END node must not have outgoing edges; found ${edges.length}`);
        }
    }
    return issues;
}

function deriveParameters(variables: readonly NarrativeVariable[]): {
    tables: Array<{ name: string; index: number }>;
    parameters: CompiledParameter[];
} {
    const tableIndices = new Map<string, number>();
    const tables: Array<{ name: string; index: number }> = [];
    const parameters = variables.map((variable, parameterIndex): CompiledParameter => {
        const parsed = parseVariableName(variable.name)!;
        let tableIndex = tableIndices.get(parsed.tableName);
        if (tableIndex === undefined) {
            tableIndex = tables.length;
            tableIndices.set(parsed.tableName, tableIndex);
            tables.push({ name: parsed.tableName, index: tableIndex });
        }
        return { ...variable, ...parsed, parameterIndex, tableIndex };
    });
    return { tables, parameters };
}

function internCharacter(value: string, values: string[], ids: Map<string, number>): number {
    const existing = ids.get(value);
    if (existing !== undefined) return existing;
    const id = values.length;
    values.push(value);
    ids.set(value, id);
    return id;
}

function registerAuthoredAtom(atom: AuthoredAtom, text: string, values: CompiledAuthoredAtom[], seen: Set<number>): void {
    if (seen.has(atom.value)) return;
    seen.add(atom.value);
    values.push({ ...atom, text });
}

function queueTarget(state: CompileState, edge: CanvasEdge, source: CanvasNode): CanvasNode {
    const target = targetNode(state.canvas, edge, source);
    state.queue.push(target);
    return target;
}

function emitJump(state: CompileState, target: CanvasNode): void {
    state.writer.u8(EmpathyBytecodeOpcode.JUMP);
    const operandOffset = state.writer.offset;
    state.writer.u64(0n);
    state.patches.push({ operandOffset, targetNodeId: target.id });
}

function emitLiteral(writer: BytecodeWriter, variable: NarrativeVariable, literal: string): void {
    const value = parsedLiteral(variable, literal)!;
    if (variable.type === NarrativeVariableType.BOOLEAN) {
        writer.u8(EmpathyBytecodeOpcode.PUSH_U8);
        writer.u8(value ? 1 : 0);
    } else if (variable.type === NarrativeVariableType.INTEGER) {
        writer.u8(EmpathyBytecodeOpcode.PUSH_I32);
        writer.i32(value as number);
    } else {
        writer.u8(EmpathyBytecodeOpcode.PUSH_F32);
        writer.f32(value as number);
    }
}

function emitCondition(state: CompileState, condition: NarrativeCondition): void {
    const parameter = state.parameters.get(condition.variable)!;
    state.writer.u8(EmpathyBytecodeOpcode.LOAD);
    state.writer.u32(parameter.parameterIndex);
    emitLiteral(state.writer, parameter, condition.literal);
    const opcodes: Record<NarrativeComparison, number> = {
        "==": EmpathyBytecodeOpcode.EQUAL,
        "!=": EmpathyBytecodeOpcode.NOT_EQUAL,
        "<": EmpathyBytecodeOpcode.LESS,
        "<=": EmpathyBytecodeOpcode.LESS_EQUAL,
        ">": EmpathyBytecodeOpcode.GREATER,
        ">=": EmpathyBytecodeOpcode.GREATER_EQUAL,
    };
    state.writer.u8(opcodes[condition.comparison]);
}

function emitTransitions(state: CompileState, node: CanvasNode): void {
    const edges = outgoingEdges(state.canvas, node);
    const onlyData = edges[0]?.getData();
    if (edges.length === 1 && onlyData.empathyCondition === undefined && !onlyData.empathyElse) {
        emitJump(state, queueTarget(state, edges[0], node));
        return;
    }
    edges.sort((left, right) => {
        if (left.getData().empathyElse) return right.getData().empathyElse ? 0 : 1;
        if (right.getData().empathyElse) return -1;
        return left.getData().empathyConditionOrder! - right.getData().empathyConditionOrder!;
    });
    for (const edge of edges) {
        const data = edge.getData();
        const target = queueTarget(state, edge, node);
        if (data.empathyElse) {
            emitJump(state, target);
            return;
        }
        emitCondition(state, data.empathyCondition!);
        state.writer.u8(EmpathyBytecodeOpcode.JUMP_FALSE);
        const nextOffset = state.writer.offset;
        state.writer.u64(0n);
        emitJump(state, target);
        state.writer.patchU64(nextOffset, state.writer.offset);
    }
    state.writer.u8(EmpathyBytecodeOpcode.END);
}

function compileSay(state: CompileState, node: CanvasNode): void {
    const data = node.getData();
    const line = normalizedNodeText(node);
    const character = (data.empathyCharacter as string).trim();
    const lineAtom = data.empathyLineAtom!;
    registerAuthoredAtom(lineAtom, line, state.lines, state.lineValues);
    const characterId = internCharacter(character, state.characters, state.characterIds);
    state.writer.u8(EmpathyBytecodeOpcode.YIELD_PUSH_ATOM);
    state.writer.atom(EmpathyPocAtomType.LINE, lineAtom.value);
    state.writer.u8(EmpathyBytecodeOpcode.YIELD_PUSH_ATOM);
    state.writer.atom(EmpathyPocAtomType.CHARACTER, characterId);
    state.writer.u8(EmpathyBytecodeOpcode.YIELD);
    state.writer.u32(EmpathyPocYieldType.SAY);
    emitTransitions(state, node);
}

function compileLine(state: CompileState, node: CanvasNode): void {
    const line = normalizedNodeText(node);
    const lineAtom = node.getData().empathyLineAtom!;
    registerAuthoredAtom(lineAtom, line, state.lines, state.lineValues);
    state.writer.u8(EmpathyBytecodeOpcode.YIELD_PUSH_ATOM);
    state.writer.atom(EmpathyPocAtomType.LINE, lineAtom.value);
    state.writer.u8(EmpathyBytecodeOpcode.YIELD);
    state.writer.u32(EmpathyPocYieldType.LINE);
    emitTransitions(state, node);
}

function compileSet(state: CompileState, node: CanvasNode): void {
    for (const assignment of node.getData().empathyAssignments!) {
        const parameter = state.parameters.get(assignment.variable)!;
        if (assignment.operation !== "=") {
            state.writer.u8(EmpathyBytecodeOpcode.LOAD);
            state.writer.u32(parameter.parameterIndex);
        }
        emitLiteral(state.writer, parameter, assignment.literal);
        if (assignment.operation === "+=") state.writer.u8(EmpathyBytecodeOpcode.ADD);
        else if (assignment.operation === "-=") state.writer.u8(EmpathyBytecodeOpcode.SUB);
        state.writer.u8(EmpathyBytecodeOpcode.STORE);
        state.writer.u32(parameter.parameterIndex);
    }
    const edge = outgoingEdges(state.canvas, node)[0];
    emitJump(state, queueTarget(state, edge, node));
}

function compileChoice(state: CompileState, node: CanvasNode): void {
    const choices = node.getData().empathyChoices!;
    const edgesByAtom = new Map(outgoingEdges(state.canvas, node).map((edge) => [edge.getData().empathyChoiceAtom!, edge]));
    const targets = new Map<number, CanvasNode>();
    state.writer.u8(EmpathyBytecodeOpcode.PUSH_U32);
    state.writer.u32(0);
    for (const choice of choices) {
        registerAuthoredAtom(choice.atom, choice.text.trim(), state.choices, state.choiceValues);
        let skipOffset: number | undefined;
        if (choice.condition) {
            emitCondition(state, choice.condition);
            state.writer.u8(EmpathyBytecodeOpcode.JUMP_FALSE);
            skipOffset = state.writer.offset;
            state.writer.u64(0n);
        }
        state.writer.u8(EmpathyBytecodeOpcode.YIELD_PUSH_ATOM);
        state.writer.atom(EmpathyPocAtomType.CHOICE, choice.atom.value);
        state.writer.u8(EmpathyBytecodeOpcode.PUSH_U32);
        state.writer.u32(1);
        state.writer.u8(EmpathyBytecodeOpcode.ADD);
        if (skipOffset !== undefined) state.writer.patchU64(skipOffset, state.writer.offset);
        targets.set(choice.atom.value, queueTarget(state, edgesByAtom.get(choice.atom.value)!, node));
    }
    state.writer.u8(EmpathyBytecodeOpcode.DUP);
    state.writer.u8(EmpathyBytecodeOpcode.PUSH_U32);
    state.writer.u32(0);
    state.writer.u8(EmpathyBytecodeOpcode.EQUAL);
    state.writer.u8(EmpathyBytecodeOpcode.JUMP_FALSE);
    const hasOptionsOffset = state.writer.offset;
    state.writer.u64(0n);
    state.writer.u8(EmpathyBytecodeOpcode.DROP);
    state.writer.u8(EmpathyBytecodeOpcode.END);
    state.writer.patchU64(hasOptionsOffset, state.writer.offset);
    state.writer.u8(EmpathyBytecodeOpcode.DROP);
    state.writer.u8(EmpathyBytecodeOpcode.YIELD);
    state.writer.u32(EmpathyPocYieldType.CHOICE);
    state.writer.u8(EmpathyBytecodeOpcode.YIELD_TAKE);
    const hiddenChoiceOffsets: number[] = [];
    for (const choice of choices) {
        state.writer.u8(EmpathyBytecodeOpcode.DUP);
        state.writer.u8(EmpathyBytecodeOpcode.PUSH_ATOM);
        state.writer.atom(EmpathyPocAtomType.CHOICE, choice.atom.value);
        state.writer.u8(EmpathyBytecodeOpcode.EQUAL);
        state.writer.u8(EmpathyBytecodeOpcode.JUMP_FALSE);
        const nextComparisonOffset = state.writer.offset;
        state.writer.u64(0n);
        if (choice.condition) {
            emitCondition(state, choice.condition);
            state.writer.u8(EmpathyBytecodeOpcode.JUMP_FALSE);
            hiddenChoiceOffsets.push(state.writer.offset);
            state.writer.u64(0n);
        }
        state.writer.u8(EmpathyBytecodeOpcode.DROP);
        emitJump(state, targets.get(choice.atom.value)!);
        state.writer.patchU64(nextComparisonOffset, state.writer.offset);
    }
    for (const offset of hiddenChoiceOffsets) state.writer.patchU64(offset, state.writer.offset);
    state.writer.u8(EmpathyBytecodeOpcode.DROP);
    state.writer.u8(EmpathyBytecodeOpcode.END);
}

function compilePortalReceiver(state: CompileState, node: CanvasNode): void {
    const transmitter = portalNodes(
        state.canvas,
        node.getData().empathyPortalId!,
        EmpathyCanvasNodeKind.PORTAL_TRANSMITTER,
    )[0];
    const edge = outgoingEdges(state.canvas, transmitter)[0];
    emitJump(state, queueTarget(state, edge, transmitter));
}

function compileNode(state: CompileState, node: CanvasNode): void {
    switch (getEmpathyCanvasNodeKind(node.getData())) {
        case EmpathyCanvasNodeKind.SAY: compileSay(state, node); return;
        case EmpathyCanvasNodeKind.LINE: compileLine(state, node); return;
        case EmpathyCanvasNodeKind.SET: compileSet(state, node); return;
        case EmpathyCanvasNodeKind.CHOICE: compileChoice(state, node); return;
        case EmpathyCanvasNodeKind.PORTAL_RECEIVER: compilePortalReceiver(state, node); return;
        case EmpathyCanvasNodeKind.END: state.writer.u8(EmpathyBytecodeOpcode.END); return;
        default: throw new Error(`Unsupported semantic node ${node.id}`);
    }
}

class CanvasValidationError extends Error {
    constructor(readonly issues: readonly CanvasIssue[]) {
        super(issues.length === 1
            ? issues[0].message
            : `${issues[0].message} (${issues.length - 1} more validation error${issues.length === 2 ? "" : "s"})`);
        this.name = "CanvasValidationError";
    }
}

export function compileCanvas(canvas: Canvas, variables: readonly NarrativeVariable[] = []): CompileResult {
    const issues = validateCanvas(canvas, variables);
    if (issues.length > 0) throw new CanvasValidationError(issues);
    const { tables, parameters } = deriveParameters(variables);
    const entries = Array.from(canvas.nodes.values())
        .filter((node) => getEmpathyCanvasNodeKind(node.getData()) === EmpathyCanvasNodeKind.ENTRY)
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const state: CompileState = {
        canvas,
        writer: new BytecodeWriter(),
        parameters: new Map(parameters.map((parameter) => [parameter.name, parameter])),
        nodeOffsets: new Map(),
        patches: [],
        queue: [],
        characterIds: new Map(),
        lineValues: new Set(),
        choiceValues: new Set(),
        lines: [],
        characters: [],
        choices: [],
    };
    const entryTargets = entries.map((entry) => queueTarget(state, outgoingEdges(canvas, entry)[0], entry));
    for (let queueIndex = 0; queueIndex < state.queue.length; ++queueIndex) {
        const node = state.queue[queueIndex];
        const id = node.id;
        if (state.nodeOffsets.has(id)) continue;
        state.nodeOffsets.set(id, state.writer.offset);
        compileNode(state, node);
    }
    const entryPoints = entries.map((entry, index) => {
        const executionOffset = state.nodeOffsets.get(entryTargets[index].id)!;
        const condition = entry.getData().empathyEntryCondition;
        if (!condition) return { executionOffset, name: normalizedNodeText(entry) };
        const predicateOffset = state.writer.offset;
        emitCondition(state, condition);
        state.writer.u8(EmpathyBytecodeOpcode.REJECT_FALSE);
        state.writer.u8(EmpathyBytecodeOpcode.PUSH_U32);
        state.writer.u32(Number(entry.getData().empathyEntryMatchValue));
        state.writer.u8(EmpathyBytecodeOpcode.MATCH);
        return { executionOffset, predicateOffset, name: normalizedNodeText(entry) };
    });
    for (const jump of state.patches) {
        const targetOffset = state.nodeOffsets.get(jump.targetNodeId);
        if (targetOffset === undefined) throw new Error(`Unresolved target node ${jump.targetNodeId}`);
        state.writer.patchU64(jump.operandOffset, targetOffset);
    }
    return {
        bytecode: state.writer.finish(),
        entryPoints,
        lines: state.lines.sort((left, right) => left.value - right.value),
        characters: state.characters,
        choices: state.choices.sort((left, right) => left.value - right.value),
        nodeOffsets: state.nodeOffsets,
        tables,
        parameters,
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
    return { macro: `${clean.toUpperCase()}_EMPATHY`, symbol: `${clean.toLowerCase()}_empathy` };
}

const cKeywords = new Set(["auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long", "register", "restrict", "return", "short", "signed", "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned", "void", "volatile", "while"]);

function cIdentifier(value: string, fallback: string): string {
    let result = value.replace(/[^A-Za-z0-9_]/g, "_");
    if (result.length === 0) result = fallback;
    if (/^[0-9]/.test(result) || cKeywords.has(result)) result = `_${result}`;
    return result;
}

function cTypeName(value: string): string {
    const words = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
    let result = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("") || "Table";
    if (/^[0-9]/.test(result)) result = `Table${result}`;
    return `${result}State`;
}

function uniqueName(base: string, used: Set<string>): string {
    let result = base;
    for (let suffix = 2; used.has(result); ++suffix) result = `${base}_${suffix}`;
    used.add(result);
    return result;
}

function stringTable(symbol: string, values: readonly string[]): string[] {
    return [
        `static const char *const ${symbol}[] =`,
        "{",
        ...(values.length > 0 ? values.map((value) => `    ${cString(value)},`) : ["    0,"]),
        "};",
    ];
}

function authoredAtomTable(typeName: string, symbol: string, values: readonly CompiledAuthoredAtom[]): string[] {
    return [
        `static const ${typeName} ${symbol}[] =`,
        "{",
        ...(values.length > 0
            ? values.map((atom) => `    {${atom.value}u, ${cString(atom.key)}, ${cString(atom.text)}},`)
            : ["    {0u, 0, 0},"]),
        "};",
    ];
}

function atomRange(count: number): { min: number; max: number } {
    return count === 0 ? { min: 1, max: 0 } : { min: 0, max: count - 1 };
}

function authoredAtomRange(values: readonly CompiledAuthoredAtom[]): { min: number; max: number } {
    if (values.length === 0) return { min: 1, max: 0 };
    return {
        min: Math.min(...values.map(({ value }) => value)),
        max: Math.max(...values.map(({ value }) => value)),
    };
}

function authoredAtomConstants(
    macro: string,
    kind: "LINE" | "CHOICE",
    values: readonly CompiledAuthoredAtom[],
): Map<number, string> {
    const used = new Set<string>();
    return new Map(values.map((atom) => [
        atom.value,
        uniqueName(`${macro}_${kind}_${cIdentifier(atom.key, `${kind}_${atom.value}`).toUpperCase()}`, used),
    ]));
}

export function generateHeader(result: CompileResult, sourceName: string): string {
    const { macro, symbol } = generatedName(sourceName);
    const lineRange = authoredAtomRange(result.lines);
    const characterRange = atomRange(result.characters.length);
    const choiceRange = authoredAtomRange(result.choices);
    const usedTypes = new Set<string>();
    const tableTypes = new Map(result.tables.map((table) => [table.name, uniqueName(cTypeName(table.name), usedTypes)]));
    const tableConstants = new Map<string, string>();
    const usedTableConstants = new Set<string>();
    for (const table of result.tables) {
        tableConstants.set(table.name, uniqueName(`${macro}_PARAMETER_TABLE_${cIdentifier(table.name, "TABLE").toUpperCase()}`, usedTableConstants));
    }
    const parameterConstants = new Map<string, string>();
    const usedParameterConstants = new Set<string>();
    const fields = new Map<string, string>();
    const fieldsByTable = new Map<string, Set<string>>();
    const lineConstants = authoredAtomConstants(macro, "LINE", result.lines);
    const choiceConstants = authoredAtomConstants(macro, "CHOICE", result.choices);
    for (const parameter of result.parameters) {
        const tableFields = fieldsByTable.get(parameter.tableName) ?? new Set<string>();
        fieldsByTable.set(parameter.tableName, tableFields);
        fields.set(parameter.name, uniqueName(cIdentifier(parameter.variableName, "value"), tableFields));
        const base = `${macro}_PARAMETER_${cIdentifier(parameter.tableName, "TABLE").toUpperCase()}_${cIdentifier(parameter.variableName, "VALUE").toUpperCase()}`;
        parameterConstants.set(parameter.name, uniqueName(base, usedParameterConstants));
    }
    const typeNames: Record<NarrativeVariableType, string> = {
        boolean: "uint8_t",
        integer: "int32_t",
        float: "float",
    };
    const valueTypes: Record<NarrativeVariableType, string> = {
        boolean: "EMPATHY_VALUE_BASE_TYPE_UINT8",
        integer: "EMPATHY_VALUE_BASE_TYPE_INT32",
        float: "EMPATHY_VALUE_BASE_TYPE_FLOAT32",
    };
    const accesses: Record<NarrativeVariableAccess, string> = {
        read: "EMPATHY_PARAMETER_ACCESS_FLAGS_READ",
        write: "EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE",
        "read-write": "EMPATHY_PARAMETER_ACCESS_FLAGS_READ_WRITE",
    };
    const lines: string[] = [
        "#pragma once",
        "",
        "// Generated by the Empathy Obsidian POC. Do not edit manually.",
        "#include <empathy.h>",
        "#include <stddef.h>",
        "#include <stdint.h>",
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
        `typedef struct ${macro}_AtomText_t`,
        "{",
        "    uint32_t value;",
        "    const char *key;",
        "    const char *text;",
        `} ${macro}_AtomText;`,
        "",
    ];
    if (result.tables.length > 0) {
        lines.push(`typedef enum ${macro}_ParameterTable_t`, "{");
        for (const table of result.tables) lines.push(`    ${tableConstants.get(table.name)} = ${table.index},`);
        lines.push(`} ${macro}_ParameterTable;`, "");
    }
    if (result.parameters.length > 0) {
        lines.push(`typedef enum ${macro}_Parameter_t`, "{");
        for (const parameter of result.parameters) lines.push(`    ${parameterConstants.get(parameter.name)} = ${parameter.parameterIndex},`);
        lines.push(`} ${macro}_Parameter;`, "");
    }
    for (const table of result.tables) {
        lines.push(`typedef struct ${tableTypes.get(table.name)}`, "{");
        for (const parameter of result.parameters.filter((value) => value.tableName === table.name)) {
            lines.push(`    ${typeNames[parameter.type]} ${fields.get(parameter.name)};`);
        }
        lines.push(`} ${tableTypes.get(table.name)};`, "");
    }
    lines.push(
        `#define ${macro}_PARAMETER_TABLE_COUNT ${result.tables.length}u`,
        `#define ${macro}_REQUIRED_PARAMETER_TABLE_COUNT ${result.tables.length}u`,
        `#define ${macro}_PARAMETER_COUNT ${result.parameters.length}u`,
        `#define ${macro}_LINE_COUNT ${result.lines.length}u`,
        `#define ${macro}_CHARACTER_COUNT ${result.characters.length}u`,
        `#define ${macro}_CHOICE_COUNT ${result.choices.length}u`,
        `#define ${macro}_ENTRY_POINT_COUNT ${result.entryPoints.length}u`,
        `#define ${macro}_BYTECODE_VERSION 0x${EMPATHY_BYTECODE_VERSION.toString(16).toUpperCase().padStart(8, "0")}u`,
        `#define ${macro}_BYTECODE_SIZE ${result.bytecode.length}u`,
        "",
    );
    for (const atom of result.lines) lines.push(`#define ${lineConstants.get(atom.value)} ${atom.value}u`);
    for (let id = 0; id < result.characters.length; ++id) lines.push(`#define ${macro}_CHARACTER_${id} ${id}u`);
    for (const atom of result.choices) lines.push(`#define ${choiceConstants.get(atom.value)} ${atom.value}u`);
    lines.push(
        "",
        ...authoredAtomTable(`${macro}_AtomText`, `${symbol}_line_atoms`, result.lines),
        "",
        ...stringTable(`${symbol}_character_strings`, result.characters),
        "",
        ...authoredAtomTable(`${macro}_AtomText`, `${symbol}_choice_atoms`, result.choices),
        "",
    );
    lines.push(
        `static const Empathy_AtomTypeDesc ${symbol}_atom_types[] =`,
        "{",
        `    {${macro}_ATOM_TYPE_LINE, ${lineRange.min}u, ${lineRange.max}u},`,
        `    {${macro}_ATOM_TYPE_CHARACTER, ${characterRange.min}u, ${characterRange.max}u},`,
        `    {${macro}_ATOM_TYPE_CHOICE, ${choiceRange.min}u, ${choiceRange.max}u},`,
        "};",
        "",
    );
    if (result.parameters.length > 0) {
        lines.push(`static const Empathy_ParameterDesc ${symbol}_parameters[] =`, "{");
        for (const parameter of result.parameters) {
            lines.push(
                `    {${tableConstants.get(parameter.tableName)}, {${valueTypes[parameter.type]}, 0u}, ${accesses[parameter.access]}, offsetof(${tableTypes.get(parameter.tableName)}, ${fields.get(parameter.name)})},`,
            );
        }
        lines.push("};", "");
    }
    lines.push(
        `static const Empathy_ValueType ${symbol}_choice_resume_types[] =`,
        "{",
        `    {EMPATHY_VALUE_BASE_TYPE_ATOM, ${macro}_ATOM_TYPE_CHOICE},`,
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
        `    ${result.parameters.length}u, ${result.parameters.length > 0 ? `${symbol}_parameters` : "0"},`,
        `    3u, ${symbol}_yields,`,
        "};",
        "",
        `static const Empathy_EntryPointDesc ${symbol}_entry_points[] =`,
        "{",
    );
    for (const entryPoint of result.entryPoints) {
        lines.push(`    {${entryPoint.executionOffset}u, ${entryPoint.predicateOffset === undefined ? "EMPATHY_PROGRAM_OFFSET_NONE" : `${entryPoint.predicateOffset}u`}},`);
    }
    lines.push("};", "");
    return lines.join("\n");
}
