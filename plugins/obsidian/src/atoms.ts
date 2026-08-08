export const AuthoredAtomType = {
    LINE: "line",
    CHOICE: "choice",
} as const;

export type AuthoredAtomType = typeof AuthoredAtomType[keyof typeof AuthoredAtomType];

export interface AuthoredAtom {
    value: number;
    key?: string;
}

export type AtomAllocatorState = Record<AuthoredAtomType, number>;

export const initialAtomAllocatorState: AtomAllocatorState = {
    line: 0,
    choice: 0,
};

export const MAXIMUM_ATOM_KEY_LENGTH = 64;

const atomKeyPattern = /^[a-z][a-z0-9_]*$/;
const russianCyrillicToLatin: Readonly<Record<string, string>> = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "",
    "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
};

export function isValidAtomKey(value: unknown): value is string {
    return typeof value === "string" && value.length <= MAXIMUM_ATOM_KEY_LENGTH && atomKeyPattern.test(value);
}

export function isValidAtomValue(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xFFFFFFFF;
}

export function isAuthoredAtom(value: unknown): value is AuthoredAtom {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<AuthoredAtom>;
    const keys = Object.keys(candidate);
    return keys.includes("value") && keys.every((key) => key === "value" || key === "key") &&
        isValidAtomValue(candidate.value) &&
        (candidate.key === undefined || isValidAtomKey(candidate.key));
}

export function generatedAtomKey(
    type: AuthoredAtomType,
    text: string,
    value: number,
    usedKeys: ReadonlySet<string>,
): string {
    const content = text
        .replace(/[А-ЯЁа-яё]/g, (character) => russianCyrillicToLatin[character.toLowerCase()])
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/['\u2019]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    const readable = content.length === 0 ? `${type}_${value}` : /^[a-z]/.test(content) ? content : `${type}_${content}`;
    const base = readable.slice(0, MAXIMUM_ATOM_KEY_LENGTH).replace(/_+$/g, "");
    if (!usedKeys.has(base)) return base;
    for (let suffix = 2; ; ++suffix) {
        const suffixText = `_${suffix}`;
        const prefix = base.slice(0, MAXIMUM_ATOM_KEY_LENGTH - suffixText.length).replace(/_+$/g, "");
        const candidate = `${prefix}${suffixText}`;
        if (!usedKeys.has(candidate)) return candidate;
    }
}

export function allocateAuthoredAtom(
    type: AuthoredAtomType,
    nextValue: number,
    usedValues: ReadonlySet<number>,
): { atom: AuthoredAtom; nextValue: number } {
    let value = nextValue;
    for (const used of usedValues) {
        if (used < value) continue;
        if (used === 0xFFFFFFFF) throw new Error(`No ${type.toUpperCase()} atom values remain`);
        value = used + 1;
    }
    while (usedValues.has(value) && value < 0xFFFFFFFF) ++value;
    if (!isValidAtomValue(value) || usedValues.has(value)) {
        throw new Error(`No ${type.toUpperCase()} atom values remain`);
    }
    return { atom: { value }, nextValue: value === 0xFFFFFFFF ? value : value + 1 };
}
