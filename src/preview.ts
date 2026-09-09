import * as vscode from "vscode";
import { PreviewModel, SchemaNode } from "./model";

export class PreviewPanel {
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private latestModel?: PreviewModel;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sourceUri: vscode.Uri,
    viewColumn: vscode.ViewColumn,
    private readonly onDispose: () => void,
    private readonly onExpand: (nodeId: string) => Promise<SchemaNode["children"] | undefined>,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "xsdTreeViewer.preview",
      `XSD: ${sourceUri.path.split("/").pop() ?? sourceUri.path}`,
      viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      },
    );
    this.panel.iconPath = new vscode.ThemeIcon("file-code");
    this.panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "ready") {
        if (this.latestModel) {
          this.panel.webview.postMessage({ type: "update", model: this.latestModel });
        }
        return;
      }
      if (message.type === "copyText" && typeof message.text === "string") {
        await vscode.env.clipboard.writeText(message.text);
        return;
      }
      if (message.type === "expandNode" && typeof message.id === "string") {
        const children = await this.onExpand(message.id);
        this.panel.webview.postMessage({ type: "expanded", id: message.id, children: children ?? [] });
        return;
      }
      if (message.type === "openSource" && typeof message.uri === "string") {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(message.uri));
        const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
        const position = new vscode.Position(
          Math.max(0, Number(message.line ?? 0)),
          Math.max(0, Number(message.column ?? 0)),
        );
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
      }
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.onDispose();
    });
    this.panel.webview.html = this.html();
  }

  public update(model: PreviewModel): void {
    this.latestModel = model;
    if (!this.disposed) {
      this.panel.webview.postMessage({ type: "update", model });
    }
  }

  public reveal(): void {
    this.panel.reveal(this.panel.viewColumn);
  }

  public dispose(): void {
    this.panel.dispose();
  }

  private html(): string {
    const script = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
    );
    const nonce = String(Date.now());
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>XSD Tree Viewer</title>
  <style>
    :root { color-scheme: light dark; }
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); margin: 0; padding: 0 24px 48px; }
    header { position: sticky; top: 0; z-index: 2; padding: 16px 0 12px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { font-size: 1.35em; font-weight: 600; margin: 0 0 6px; }
    .namespace, .meta, .warning { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    input { box-sizing: border-box; width: 100%; max-width: 520px; margin-top: 12px; padding: 6px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 340px); gap: 24px; align-items: start; }
    .tree { min-width: 0; padding-top: 16px; }
    .details-panel { position: sticky; top: 101px; min-height: 180px; margin-top: 16px; padding: 12px 0 12px 18px; border-left: 1px solid var(--vscode-panel-border); }
    .details-heading { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; }
    .details-heading h2 { font-size: 1.05em; margin: 0; overflow-wrap: anywhere; }
    .details-empty { color: var(--vscode-descriptionForeground); line-height: 1.45; padding-top: 8px; }
    .detail-section { margin-top: 14px; }
    .detail-section h3 { color: var(--vscode-descriptionForeground); font-size: 0.8em; font-weight: 600; letter-spacing: 0; margin: 0 0 6px; text-transform: uppercase; }
    .detail-table, .attribute-list, .facet-list { border: 1px solid var(--vscode-panel-border); }
    .detail-table div, .attribute-list div, .facet-list div { display: grid; grid-template-columns: minmax(80px, 110px) minmax(0, 1fr); gap: 8px; padding: 5px 7px; border-bottom: 1px solid var(--vscode-panel-border); overflow-wrap: anywhere; }
    .detail-table div:last-child, .attribute-list div:last-child, .facet-list div:last-child { border-bottom: 0; }
    .detail-table strong, .attribute-list strong, .facet-list strong { color: var(--vscode-descriptionForeground); font-weight: 500; }
    .xpath-value, .source-location { color: var(--vscode-textPreformat-foreground); background: var(--vscode-textCodeBlock-background); padding: 7px; overflow-wrap: anywhere; word-break: break-word; }
    .copy-button { margin-top: 7px; padding: 4px 8px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .copy-button:hover { background: var(--vscode-button-hoverBackground); text-decoration: none; }
    .source-section { position: relative; }
    .source-section .icon-button { position: absolute; top: 18px; right: 0; }
    .node-item { position: relative; margin-left: 14px; border-left: 1px solid var(--vscode-tree-indentGuidesStroke); }
    .node-item.root { margin-left: 0; border-left: 0; }
    .node-item.root > .node-children { padding-left: 24px; }
    .structure-group { min-width: 0; margin-left: 14px; border-left: 1px solid var(--vscode-tree-indentGuidesStroke); }
    .structure-group > .node-item { margin-left: 0; border-left: 0; }
    .node-item:not(.root) > summary, .node-item:not(.root).leaf { padding-left: 5px; }
    summary { position: relative; cursor: pointer; list-style: none; padding: 4px 0; border-radius: 3px; }
    summary::-webkit-details-marker { display: none; }
    summary::before { content: "›"; position: absolute; left: -19px; top: 3px; width: 14px; color: var(--vscode-descriptionForeground); font-size: 1.15em; line-height: 1; text-align: center; transition: transform 100ms ease; }
    .node-item[open] > summary::before { transform: rotate(90deg); }
    .node-item.root > summary { padding-left: 24px; }
    .node-item.root > summary::before { left: 2px; }
    .structure-group > .node-item > summary::before { left: -19px; }
    summary:hover { background: var(--vscode-list-hoverBackground); }
    .selected > summary, .selected.leaf { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .node-item > summary:focus, .node-item.leaf:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .node-children { min-width: 0; }
    .row { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .name { color: var(--vscode-symbolIcon-variableForeground); font-weight: 600; }
    .attribute-name { color: var(--vscode-symbolIcon-propertyForeground); font-weight: 500; }
    .cardinality, .badge { color: var(--vscode-textPreformat-foreground); background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: 1px 5px; font-size: 0.82em; }
    .documentation { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.45; overflow-wrap: anywhere; }
    button { color: var(--vscode-textLink-foreground); background: transparent; border: 0; cursor: pointer; padding: 0 4px; }
    button:hover { text-decoration: underline; }
    .icon-button { min-width: 20px; font-size: 1em; }
    .source-link { opacity: 0; transition: opacity 100ms ease; }
    .row:hover .source-link, .selected .source-link, .source-link:focus { opacity: 1; }
    .repeat-badge, .recursive { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    .unresolved { color: var(--vscode-editorError-foreground); }
    .empty { color: var(--vscode-descriptionForeground); padding: 24px 0; }
    .warning { padding: 8px 0; color: var(--vscode-editorWarning-foreground); }
    @media (max-width: 760px) { body { padding: 0 12px 32px; } .layout { display: block; } .details-panel { position: static; margin-top: 20px; padding: 14px 0 0; border-left: 0; border-top: 1px solid var(--vscode-panel-border); } }
  </style>
</head>
<body>
  <header>
    <h1 id="title">XSD Tree Viewer</h1>
    <div class="namespace" id="namespace"></div>
    <input id="filter" type="search" placeholder="Filter elements, types, and documentation">
  </header>
  <div class="layout">
    <main id="tree" class="tree" role="tree"><div class="empty">Waiting for schema...</div></main>
    <aside id="details-panel" class="details-panel"><div class="details-empty">Select a node to inspect its schema details.</div></aside>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

export function collectNodeIds(nodes: SchemaNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...collectNodeIds(node.children)]);
}
