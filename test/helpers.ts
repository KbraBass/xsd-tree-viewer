import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PreviewModel, SchemaNode } from "../src/model";
import { ResolverOptions, SchemaResolver } from "../src/resolver";
import { SchemaFileSystem } from "../src/schemaFileSystem";

export const fixturesDirectory = path.join(__dirname, "..", "..", "test", "fixtures");

/** Reads fixtures straight off disk; the resolver never touches `vscode`. */
export class NodeSchemaFileSystem implements SchemaFileSystem {
  public readonly reads: string[] = [];

  public async readFile(uri: string): Promise<string> {
    this.reads.push(uri);
    return fs.readFile(fileURLToPath(uri), "utf8");
  }

  public resolveRelative(baseUri: string, location: string): string {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(location)) {
      return location;
    }
    return pathToFileURL(path.resolve(path.dirname(fileURLToPath(baseUri)), location)).toString();
  }
}

export function fixtureUri(relativePath: string): string {
  return pathToFileURL(path.join(fixturesDirectory, relativePath)).toString();
}

export function createResolver(options: Partial<ResolverOptions> = {}): {
  resolver: SchemaResolver;
  fileSystem: NodeSchemaFileSystem;
} {
  const fileSystem = new NodeSchemaFileSystem();
  const resolver = new SchemaResolver(fileSystem, {
    collapseRepeatedSubtrees: true,
    parseCctsAnnotations: true,
    ...options,
  });
  return { resolver, fileSystem };
}

export async function buildFixture(
  relativePath: string,
  options: Partial<ResolverOptions> = {},
): Promise<{ model: PreviewModel; resolver: SchemaResolver }> {
  const { resolver } = createResolver(options);
  const model = await resolver.build(fixtureUri(relativePath));
  return { model, resolver };
}

export function flatten(nodes: SchemaNode[]): SchemaNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

export function findByName(nodes: SchemaNode[], name: string): SchemaNode | undefined {
  return flatten(nodes).find((node) => node.name === name);
}

export function allByName(nodes: SchemaNode[], name: string): SchemaNode[] {
  return flatten(nodes).filter((node) => node.name === name);
}

export function root(model: PreviewModel, name: string): SchemaNode {
  const node = model.roots.find((candidate) => candidate.name === name);
  if (!node) {
    throw new Error(`No root element named ${name} in ${model.title}`);
  }
  return node;
}

/** Element/attribute names of a subtree, ignoring structure and type wrappers. */
export function names(nodes: SchemaNode[]): string[] {
  return flatten(nodes)
    .filter((node) => node.kind === "element" || node.kind === "attribute")
    .map((node) => node.name ?? "");
}
