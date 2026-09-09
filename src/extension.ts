import * as vscode from "vscode";
import { PreviewPanel, openSource } from "./preview";
import { ResolverOptions, SchemaResolver } from "./resolver";
import { VscodeSchemaFileSystem } from "./schemaFileSystem";

interface PreviewSession {
  panel: PreviewPanel;
  resolver: SchemaResolver;
  /** Per-document debounce, so editing one schema never cancels another's refresh. */
  refreshTimer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, PreviewSession>();
const fileSystem = new VscodeSchemaFileSystem();
const refreshDebounceMs = 250;

function isXsd(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
  return Boolean(
    document
      && (document.languageId === "xsd"
        || document.languageId === "xml"
        || document.uri.path.toLowerCase().endsWith(".xsd")),
  );
}

function resolverOptions(): ResolverOptions {
  const settings = vscode.workspace.getConfiguration("xsdTreeViewer");
  return {
    collapseRepeatedSubtrees: settings.get<boolean>("collapseRepeatedSubtrees", true),
    parseCctsAnnotations: settings.get<boolean>("parseCctsAnnotations", true),
    autoCollapseDepth: settings.get<number>("autoCollapseDepth", 3),
  };
}

/** Text of a document if it is open (so unsaved edits preview), otherwise undefined. */
function openDocumentText(uri: string): string | undefined {
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri)?.getText();
}

async function refreshPreview(key: string): Promise<void> {
  const session = sessions.get(key);
  if (!session) {
    return;
  }
  try {
    const model = await session.resolver.build(key, openDocumentText(key));
    session.panel.update(model);
  } catch (error) {
    void vscode.window.showErrorMessage(`XSD preview failed: ${String(error)}`);
  }
}

function scheduleRefresh(key: string): void {
  const session = sessions.get(key);
  if (!session) {
    return;
  }
  if (session.refreshTimer) {
    clearTimeout(session.refreshTimer);
  }
  session.refreshTimer = setTimeout(() => {
    session.refreshTimer = undefined;
    void refreshPreview(key);
  }, refreshDebounceMs);
}

function createResolver(): SchemaResolver {
  return new SchemaResolver(fileSystem, resolverOptions());
}

async function openPreview(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument | undefined,
  viewColumn: vscode.ViewColumn,
): Promise<PreviewSession | undefined> {
  if (!isXsd(document)) {
    void vscode.window.showWarningMessage("Open an XSD file before opening the XSD preview.");
    return undefined;
  }
  const key = document.uri.toString();
  const existing = sessions.get(key);
  if (existing) {
    existing.panel.reveal();
    return existing;
  }
  const resolver = createResolver();
  const panel = new PreviewPanel(context.extensionUri, document.uri, viewColumn, {
    onDispose: () => {
      const session = sessions.get(key);
      if (session?.refreshTimer) {
        clearTimeout(session.refreshTimer);
      }
      sessions.delete(key);
    },
    onExpand: async (nodeId) => resolver.expandNode(nodeId),
    onSearch: (query) => resolver.search(query),
  });
  const session: PreviewSession = { panel, resolver };
  sessions.set(key, session);
  await refreshPreview(key);
  return session;
}

/** The session to act on for preview-relative commands: focused panel, else the only one. */
function activeSession(): PreviewSession | undefined {
  for (const session of sessions.values()) {
    if (session.panel.isActive) {
      return session;
    }
  }
  const editorKey = vscode.window.activeTextEditor?.document.uri.toString();
  if (editorKey && sessions.has(editorKey)) {
    return sessions.get(editorKey);
  }
  return sessions.size === 1 ? [...sessions.values()][0] : undefined;
}

/** Opens (or focuses) the preview that covers `document` and selects the node at `line`. */
async function revealInPreview(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!isXsd(editor?.document)) {
    void vscode.window.showWarningMessage("Open an XSD file to reveal it in the XSD preview.");
    return;
  }
  const uri = editor.document.uri;
  const key = uri.toString();
  // An imported schema is covered by the preview of whichever root loaded it.
  const owning = sessions.get(key)
    ?? [...sessions.values()].find((session) => session.resolver.has(key));
  const session = owning ?? await openPreview(context, editor.document, vscode.ViewColumn.Beside);
  if (!session) {
    return;
  }
  session.panel.reveal(vscode.ViewColumn.Beside);
  session.panel.revealSource(uri, editor.selection.active.line);
}

async function goToDefinition(): Promise<void> {
  const location = activeSession()?.panel.selectedLocation;
  if (!location) {
    void vscode.window.showWarningMessage("Select a node in the XSD preview first.");
    return;
  }
  await openSource(location);
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("xsdTreeViewer.openPreview", () =>
      openPreview(context, vscode.window.activeTextEditor?.document, vscode.ViewColumn.Active),
    ),
    vscode.commands.registerCommand("xsdTreeViewer.openPreviewToSide", () =>
      openPreview(context, vscode.window.activeTextEditor?.document, vscode.ViewColumn.Beside),
    ),
    vscode.commands.registerCommand("xsdTreeViewer.revealInPreview", () => revealInPreview(context)),
    vscode.commands.registerCommand("xsdTreeViewer.goToDefinition", () => goToDefinition()),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (sessions.has(event.document.uri.toString()) && event.contentChanges.length > 0) {
        scheduleRefresh(event.document.uri.toString());
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const key = document.uri.toString();
      // Saving an imported schema refreshes every preview that depends on it.
      for (const [sessionKey, session] of sessions) {
        if (sessionKey === key || session.resolver.has(key)) {
          session.resolver.invalidate(key);
          void refreshPreview(sessionKey);
        }
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("xsdTreeViewer")) {
        return;
      }
      for (const [key, session] of sessions) {
        session.resolver.setOptions(resolverOptions());
        void refreshPreview(key);
      }
    }),
  );
}

export function deactivate(): void {
  for (const session of sessions.values()) {
    if (session.refreshTimer) {
      clearTimeout(session.refreshTimer);
    }
    session.panel.dispose();
  }
  sessions.clear();
}
