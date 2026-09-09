import * as vscode from "vscode";

/**
 * File access port used by the parser/resolver. Keeping I/O behind an interface
 * keeps `resolver.ts` free of any `vscode` runtime dependency, so it can be
 * unit-tested in plain Node and reused from a non-webview host later.
 */
export interface SchemaFileSystem {
  readFile(uri: string): Promise<string>;
  /** Resolves an `xs:import`/`xs:include` schemaLocation against the importing document. */
  resolveRelative(baseUri: string, location: string): string;
}

const absoluteUriPattern = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * VS Code implementation. Uses `workspace.fs` (not `node:fs`) and `TextDecoder`
 * (not `Buffer`) so imports resolve on virtual filesystems and in VS Code Web.
 */
export class VscodeSchemaFileSystem implements SchemaFileSystem {
  private readonly decoder = new TextDecoder("utf-8");

  public async readFile(uri: string): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(uri));
    return this.decoder.decode(bytes);
  }

  public resolveRelative(baseUri: string, location: string): string {
    const trimmed = location.trim();
    if (absoluteUriPattern.test(trimmed)) {
      return vscode.Uri.parse(trimmed).toString();
    }
    const base = vscode.Uri.parse(baseUri);
    if (trimmed.startsWith("/")) {
      return base.with({ path: trimmed, query: "", fragment: "" }).toString();
    }
    return vscode.Uri.joinPath(base, "..", trimmed).toString();
  }
}
