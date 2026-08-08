export const AuthoredAtomType = {
    LINE: "line",
    CHOICE: "choice",
} as const;

export type AuthoredAtomType = typeof AuthoredAtomType[keyof typeof AuthoredAtomType];

export interface AuthoredAtom {
    value: number;
    key: string;
}

export type AtomAllocatorState = Record<AuthoredAtomType, number>;

export const initialAtomAllocatorState: AtomAllocatorState = {
    line: 0,
    choice: 0,
};

const maximumKeyLength = 80;
const atomKeyPattern = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;

function slugPart(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
}

export function suggestedAtomKey(type: AuthoredAtomType, text: string, character?: string): string {
    const content = slugPart(text);
    const speaker = type === AuthoredAtomType.LINE ? slugPart(character ?? "") : "";
    return (speaker && content ? `${speaker}.${content}` : content || speaker).slice(0, maximumKeyLength);
}

export function isValidAtomKey(value: unknown): value is string {
    return typeof value === "string" && value.length <= maximumKeyLength && atomKeyPattern.test(value);
}

export function isValidAtomValue(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xFFFFFFFF;
}

export function isAuthoredAtom(value: unknown): value is AuthoredAtom {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<AuthoredAtom>;
    return isValidAtomValue(candidate.value) && isValidAtomKey(candidate.key);
}

export function uniqueAtomKey(base: string, fallback: string, usedKeys: ReadonlySet<string>): string {
    const normalized = isValidAtomKey(base) ? base : fallback;
    if (!usedKeys.has(normalized)) return normalized;
    for (let suffix = 2; ; ++suffix) {
        const suffixText = `_${suffix}`;
        const candidate = `${normalized.slice(0, maximumKeyLength - suffixText.length)}${suffixText}`;
        if (!usedKeys.has(candidate)) return candidate;
    }
}

export function allocateAuthoredAtom(
    type: AuthoredAtomType,
    text: string,
    character: string | undefined,
    nextValue: number,
    usedValues: ReadonlySet<number>,
    usedKeys: ReadonlySet<string>,
): { atom: AuthoredAtom; nextValue: number } {
    let value = Math.max(0, Number.isInteger(nextValue) ? nextValue : 0);
    for (const used of usedValues) {
        if (used < value) continue;
        if (used === 0xFFFFFFFF) throw new Error(`No ${type.toUpperCase()} atom values remain`);
        value = used + 1;
    }
    while (usedValues.has(value) && value < 0xFFFFFFFF) ++value;
    if (!isValidAtomValue(value) || usedValues.has(value)) {
        throw new Error(`No ${type.toUpperCase()} atom values remain`);
    }
    const fallback = `${type}_${value}`;
    const key = uniqueAtomKey(suggestedAtomKey(type, text, character), fallback, usedKeys);
    return { atom: { value, key }, nextValue: value === 0xFFFFFFFF ? value : value + 1 };
}
