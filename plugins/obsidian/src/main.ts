import { ItemView, Notice, Plugin, setIcon, setTooltip, TFile } from "obsidian";

import {
    Canvas,
    compileCanvas,
    EmpathyCanvasNodeKind,
    generateHeader,
} from "./compile";
import { EmpathyCanvasIntegration } from "./canvas";

interface InternalCanvasView extends ItemView {
    canvas?: Canvas;
    file?: TFile;
}

export default class EmpathyPlugin extends Plugin {
    private canvasIntegration!: EmpathyCanvasIntegration;
    private compiling = false;

    onload(): void {
        this.canvasIntegration = new EmpathyCanvasIntegration(this, {
            setIcon,
            setTooltip: (element, tooltip) => setTooltip(element, tooltip, { placement: "top" }),
            showNotice: (message) => {
                new Notice(message);
            },
        });
        this.canvasIntegration.register();

        this.addCommand({
            id: "compile-active-canvas",
            name: "Compile active canvas",
            callback: () => void this.compileActiveCanvas(),
        });

        for (const kind of Object.values(EmpathyCanvasNodeKind)) {
            this.addCommand({
                id: `add-${kind}-node`,
                name: `Add ${kind.toUpperCase()} node`,
                checkCallback: (checking) => {
                    const view = this.activeCanvasView();
                    if (!view?.canvas || view.canvas.readonly) return false;
                    if (!checking) this.createNode(view.canvas, kind);
                    return true;
                },
            });
        }
    }

    private activeCanvasView(): InternalCanvasView | undefined {
        const view = this.app.workspace.activeLeaf?.view as InternalCanvasView | undefined;
        return view?.getViewType() === "canvas" ? view : undefined;
    }

    private createNode(canvas: Canvas, kind: EmpathyCanvasNodeKind): void {
        try {
            this.canvasIntegration.createNode(canvas, kind);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Empathy Canvas node creation failed", error);
            new Notice(`Empathy node creation failed: ${message}`);
        }
    }

    private async compileActiveCanvas(): Promise<void> {
        if (this.compiling) {
            new Notice("Empathy compile is already in progress");
            return;
        }

        this.compiling = true;
        try {
            const view = this.activeCanvasView();
            if (!view?.canvas) {
                throw new Error("active view is not a Canvas");
            }

            const file = view.file;
            if (!file || file.extension !== "canvas") {
                throw new Error("active Canvas is not backed by a .canvas file");
            }

            const result = compileCanvas(view.canvas);
            const outputBase = file.path.slice(0, -(file.extension.length + 1));
            const binaryPath = `${outputBase}.empathy.bin`;
            const headerPath = `${outputBase}.empathy.h`;
            const binary = new Uint8Array(result.bytecode).buffer;
            const header = generateHeader(result, file.basename);

            await this.app.vault.adapter.writeBinary(binaryPath, binary);
            await this.app.vault.adapter.write(headerPath, header);
            new Notice(`Empathy: compiled ${file.name} to ${binaryPath} and ${headerPath}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Empathy Canvas compile failed", error);
            new Notice(`Empathy compile failed: ${message}`);
        } finally {
            this.compiling = false;
        }
    }
}
