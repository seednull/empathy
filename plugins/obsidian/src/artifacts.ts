import { CompileResult, generateHeader } from "./compile";

export type CanvasArtifactKind = "header" | "bytecode";
export type CanvasArtifactRequest =
    | { kind: "header"; headerPrefix: string }
    | { kind: "bytecode"; canvasName: string };

export interface SystemSaveDialogOptions {
    title: string;
    defaultPath: string;
    filters: Array<{ name: string; extensions: string[] }>;
    properties: ["showOverwriteConfirmation"];
}

export interface SystemSaveDialog {
    showSaveDialog(options: SystemSaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
}

export interface GeneratedFileSystem {
    writeFile(filePath: string, data: string | Uint8Array, encoding?: "utf8"): Promise<void>;
}

export async function saveCanvasArtifact(
    dialog: SystemSaveDialog,
    fileSystem: GeneratedFileSystem,
    result: CompileResult,
    request: CanvasArtifactRequest,
): Promise<string | undefined> {
    const header = request.kind === "header";
    const data = header ? generateHeader(result, request.headerPrefix) : result.bytecode;
    const selection = await dialog.showSaveDialog({
        title: header ? "Save Empathy header" : "Save Empathy bytecode",
        defaultPath: header
            ? `${request.headerPrefix}.empathy.h`
            : `${request.canvasName}.empathy.bin`,
        filters: [
            header
                ? { name: "C/C++ header", extensions: ["h"] }
                : { name: "Empathy bytecode", extensions: ["bin"] },
            { name: "All Files", extensions: ["*"] },
        ],
        properties: ["showOverwriteConfirmation"],
    });
    if (selection.canceled || !selection.filePath) return undefined;

    if (header) {
        await fileSystem.writeFile(selection.filePath, data, "utf8");
    } else {
        await fileSystem.writeFile(selection.filePath, data);
    }
    return selection.filePath;
}
