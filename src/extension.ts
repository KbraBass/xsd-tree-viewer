import * as vscode from "vscode";
import { PreviewPanel } from "./preview";
import { SchemaResolver } from "./resolver";

const panels = new Map<string, PreviewPanel>();
const resolvers = new Map<string, SchemaResolver>();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function isXsd(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
  return Boolean(
    document
      && (document.languageId === "xsd"
        || document.languageId === "xml"
        || document.uri.path.toLowerCase().endsWith(".xsd")),
  );
}

async function openPreview(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument | undefined,
  viewColumn: vscode.ViewColumn,
): Promise<void> {
  if (!isXsd(document)) {
    void vscode.window.showWarningMessage("Open an XSD file before opening the XSD preview.");
    return;
  }
  const key = document.uri.toString();
  const existing = panels.get(key);
  if (existing) {
    existing.reveal();
    await refreshPreview(context, document);
    return;
  }
  const panel = new PreviewPanel(
    context.extensionUri,
    document.uri,
    viewColumn,
    () => {
      panels.delete(key);
      resolvers.delete(key);
    },
    async (nodeId) => resolvers.get(key)?.expandNode(nodeId),
  );
  panels.set(key, panel);
  await refreshPreview(context, document);
}

async function refreshPreview(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
): Promise<void> {
  const panel = panels.get(document.uri.toString());
  if (!panel) {
    return;
  }
  try {
    const settings = vscode.workspace.getConfiguration("xsdTreeViewer");
    const resolver = new SchemaResolver(document.getText(), {
      collapseRepeatedSubtrees: settings.get<boolean>("collapseRepeatedSubtrees", true),
      parseCctsAnnotations: settings.get<boolean>("parseCctsAnnotations", true),
    });
    resolvers.set(document.uri.toString(), resolver);
    const model = await resolver.build(document.uri);
    panel.update(model);
  } catch (error) {
    void vscode.window.showErrorMessage(`XSD preview failed: ${String(error)}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("xsdTreeViewer.openPreview", () =>
      openPreview(context, vscode.window.activeTextEditor?.document, vscode.ViewColumn.Active),
    ),
    vscode.commands.registerCommand("xsdTreeViewer.openPreviewToSide", () =>
      openPreview(context, vscode.window.activeTextEditor?.document, vscode.ViewColumn.Beside),
    ),
    vscode.commands.registerCommand("xsdTreeViewer.revealInPreview", () =>
      openPreview(context, vscode.window.activeTextEditor?.document, vscode.ViewColumn.Beside),
    ),
    vscode.commands.registerCommand("xsdTreeViewer.goToDefinition", () =>
      openPreview(context, vscode.window.activeTextEditor?.document, vscode.ViewColumn.Beside),
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!panels.has(event.document.uri.toString())) {
        return;
      }
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      refreshTimer = setTimeout(() => {
        void refreshPreview(context, event.document);
      }, 250);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (panels.has(document.uri.toString())) {
        void refreshPreview(context, document);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (isXsd(editor?.document) && panels.has(editor.document.uri.toString())) {
        void refreshPreview(context, editor.document);
      }
    }),
  );
}

export function deactivate(): void {
  for (const panel of panels.values()) {
    panel.dispose();
  }
  panels.clear();
}
