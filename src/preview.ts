import * as vscode from "vscode";
import { PreviewModel, SchemaNode, SearchHit, SourceLocation, uriBasename } from "./model";

export interface PreviewPanelHandlers {
  onDispose: () => void;
  onExpand: (nodeId: string) => Promise<SchemaNode["children"] | undefined>;
  onSearch: (query: string) => SearchHit[];
}

export class PreviewPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private ready = false;
  private latestModel?: PreviewModel;
  private selection?: SourceLocation;
  private pendingReveal?: { uri: string; line: number };

  public constructor(
    private readonly extensionUri: vscode.Uri,
    sourceUri: vscode.Uri,
    viewColumn: vscode.ViewColumn,
    private readonly handlers: PreviewPanelHandlers,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "xsdTreeViewer.preview",
      `XSD: ${uriBasename(sourceUri.toString())}`,
      viewColumn,
      {
        enableScripts: true,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      },
    );
    this.panel.iconPath = new vscode.ThemeIcon("file-code");
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handleMessage(message);
      }),
      this.panel.onDidDispose(() => {
        this.disposed = true;
        this.handlers.onDispose();
      }),
    );
    this.panel.webview.html = this.html();
  }

  /** True while this preview panel holds focus. */
  public get isActive(): boolean {
    return !this.disposed && this.panel.active;
  }

  /** Source location of the node currently selected in the preview, if any. */
  public get selectedLocation(): SourceLocation | undefined {
    return this.selection;
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const payload = message as Record<string, unknown>;
    switch (payload.type) {
      case "ready":
        this.ready = true;
        if (this.latestModel) {
          void this.post({ type: "update", model: this.latestModel });
        }
        this.flushReveal();
        return;
      case "copyText":
        if (typeof payload.text === "string") {
          await vscode.env.clipboard.writeText(payload.text);
        }
        return;
      case "expandNode":
        if (typeof payload.id === "string") {
          const children = await this.handlers.onExpand(payload.id);
          void this.post({ type: "expanded", id: payload.id, children: children ?? [] });
        }
        return;
      case "search":
        if (typeof payload.query === "string") {
          void this.post({
            type: "searchResults",
            query: payload.query,
            hits: this.handlers.onSearch(payload.query),
          });
        }
        return;
      case "selection":
        this.selection = typeof payload.uri === "string"
          ? { uri: payload.uri, line: Number(payload.line ?? 0), column: Number(payload.column ?? 0) }
          : undefined;
        return;
      case "openSource":
        if (typeof payload.uri === "string") {
          await openSource({
            uri: payload.uri,
            line: Number(payload.line ?? 0),
            column: Number(payload.column ?? 0),
          });
        }
        return;
      default:
        return;
    }
  }

  private post(message: unknown): Thenable<boolean> | undefined {
    return this.disposed ? undefined : this.panel.webview.postMessage(message);
  }

  public update(model: PreviewModel): void {
    this.latestModel = model;
    void this.post({ type: "update", model });
    this.flushReveal();
  }

  /**
   * Asks the webview to select the node declared closest to a source position.
   * Held until the webview is ready and has a model, since a message sent
   * before then would simply be dropped.
   */
  public revealSource(uri: vscode.Uri, line: number): void {
    this.pendingReveal = { uri: uri.toString(), line };
    this.flushReveal();
  }

  private flushReveal(): void {
    if (!this.ready || !this.latestModel || !this.pendingReveal) {
      return;
    }
    void this.post({ type: "revealSource", ...this.pendingReveal });
    this.pendingReveal = undefined;
  }

  public reveal(viewColumn?: vscode.ViewColumn): void {
    this.panel.reveal(viewColumn ?? this.panel.viewColumn);
  }

  public dispose(): void {
    this.panel.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private html(): string {
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
    const stylesheet = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css"));
    const nonce = createNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${stylesheet}">
  <title>XSD Tree Viewer</title>
</head>
<body>
  <header>
    <h1 id="title">XSD Tree Viewer</h1>
    <div class="namespace" id="namespace"></div>
    <div class="toolbar">
      <input id="filter" type="search" placeholder="Filter elements, types, and documentation">
      <button id="collapse-all" class="text-button" type="button">Collapse all</button>
      <span id="match-count" class="match-count"></span>
    </div>
  </header>
  <div class="layout">
    <div class="main-column">
      <section id="declarations" class="declarations" hidden></section>
      <main id="tree" class="tree" role="tree" aria-label="Schema tree"><div class="empty">Waiting for schema...</div></main>
    </div>
    <aside id="details-panel" class="details-panel"><div class="details-empty">Select a node to inspect its schema details.</div></aside>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

/** Opens an editor at a resolved declaration, tolerating unparsable URIs. */
export async function openSource(location: SourceLocation): Promise<void> {
  let target: vscode.Uri;
  try {
    target = vscode.Uri.parse(location.uri, true);
  } catch {
    void vscode.window.showWarningMessage(`Cannot open schema location: ${location.uri}`);
    return;
  }
  try {
    const document = await vscode.workspace.openTextDocument(target);
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const position = new vscode.Position(
      Math.max(0, Math.min(document.lineCount - 1, location.line)),
      Math.max(0, location.column),
    );
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch (error) {
    void vscode.window.showWarningMessage(`Cannot open ${location.uri}: ${String(error)}`);
  }
}

function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
