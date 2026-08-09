import {
    AuthoredAtom,
    AuthoredAtomType,
    isAuthoredAtom,
} from "./atoms";

export interface NarrativeCharacter {
    atom: AuthoredAtom;
    name: string;
}

export type CharacterAtomAllocator = (
    type: typeof AuthoredAtomType.CHARACTER,
    usedValues: ReadonlySet<number>,
) => AuthoredAtom;

export function isNarrativeCharacter(value: unknown): value is NarrativeCharacter {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<NarrativeCharacter>;
    const keys = Object.keys(candidate);
    return keys.length === 2 && keys.includes("atom") && keys.includes("name") &&
        isAuthoredAtom(candidate.atom) && typeof candidate.name === "string" && candidate.name.trim().length > 0;
}

export function createNarrativeCharacter(
    name: string,
    characters: readonly NarrativeCharacter[],
    allocate: CharacterAtomAllocator,
): NarrativeCharacter {
    const normalizedName = name.trim();
    if (normalizedName.length === 0) throw new Error("Character name cannot be empty");
    const usedValues = new Set(characters.map((character) => character.atom.value));
    return {
        atom: allocate(AuthoredAtomType.CHARACTER, usedValues),
        name: normalizedName,
    };
}
