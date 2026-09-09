import * as sax from "sax";
import {
  ComponentDefinition,
  ParsedXmlNode,
  SchemaDocument,
  NodeKind,
} from "./model";

function localName(name: string): string {
  const separator = name.indexOf(":");
  return separator >= 0 ? name.slice(separator + 1) : name;
}

/**
 * Maps absolute character offsets to zero-based line/column pairs.
 *
 * `sax` reports `line`/`column` for the position it has already consumed, which
 * for `onopentag` is the *end* of the tag. Declarations are navigated to by
 * their opening `<`, so positions are derived from `startTagPosition` instead.
 */
class LineIndex {
  private readonly lineStarts: number[] = [0];

  public constructor(text: string) {
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) {
        this.lineStarts.push(index + 1);
      }
    }
  }

  public positionAt(offset: number): { line: number; column: number } {
    const clamped = Math.max(0, offset);
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lineStarts[middle] <= clamped) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return { line: low, column: clamped - this.lineStarts[low] };
  }
}

export interface ParseResult {
  root: ParsedXmlNode;
  diagnostics: string[];
}

/**
 * Parses XML into a lightweight tree. Malformed input is reported through
 * `diagnostics` and parsing continues, so a partially broken schema still
 * previews whatever could be read instead of failing outright.
 */
export function parseXml(uri: string, text: string): ParseResult {
  const parser = sax.parser(true, { xmlns: false, trim: false, normalize: false });
  const index = new LineIndex(text);
  const diagnostics: string[] = [];
  const root: ParsedXmlNode = {
    name: "__document__",
    attributes: {},
    children: [],
    text: "",
    location: { uri, line: 0, column: 0 },
  };
  const stack: ParsedXmlNode[] = [root];

  parser.onerror = (error) => {
    if (diagnostics.length < 20) {
      diagnostics.push(String(error.message ?? error).split("\n")[0]);
    }
    parser.resume();
  };
  parser.onopentag = (tag) => {
    const node: ParsedXmlNode = {
      name: tag.name,
      attributes: Object.fromEntries(
        Object.entries(tag.attributes).map(([key, value]) => [
          key,
          typeof value === "string" ? value : String(value),
        ]),
      ),
      children: [],
      text: "",
      location: { uri, ...index.positionAt(parser.startTagPosition - 1) },
    };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  };
  parser.ontext = (value) => {
    stack[stack.length - 1].text += value;
  };
  parser.oncdata = (value) => {
    stack[stack.length - 1].text += value;
  };
  parser.onclosetag = () => {
    if (stack.length > 1) {
      stack.pop();
    }
  };

  try {
    parser.write(text);
    parser.close();
  } catch (error) {
    diagnostics.push(String(error instanceof Error ? error.message : error).split("\n")[0]);
  }

  return { root: root.children[0] ?? root, diagnostics };
}

function findChildren(node: ParsedXmlNode, name: string): ParsedXmlNode[] {
  return node.children.filter((child) => localName(child.name) === name);
}

function firstChild(node: ParsedXmlNode, name: string): ParsedXmlNode | undefined {
  return findChildren(node, name)[0];
}

function kindForDeclaration(name: string): NodeKind | undefined {
  switch (name) {
    case "element":
      return "element";
    case "attribute":
      return "attribute";
    case "complexType":
      return "complexType";
    case "simpleType":
      return "simpleType";
    case "group":
      return "group";
    case "attributeGroup":
      return "attributeGroup";
    default:
      return undefined;
  }
}

/** Top-level containers whose named children also declare global components. */
const redefiningContainers = new Set(["redefine", "override"]);

function schemaLocations(root: ParsedXmlNode, name: string): string[] {
  return findChildren(root, name)
    .map((node) => node.attributes.schemaLocation)
    .filter((location): location is string => Boolean(location));
}

export function parseSchema(uri: string, text: string): SchemaDocument {
  const { root, diagnostics } = parseXml(uri, text);
  const prefixes: Record<string, string> = {};
  for (const [key, value] of Object.entries(root.attributes)) {
    if (key === "xmlns") {
      prefixes[""] = value;
    } else if (key.startsWith("xmlns:")) {
      prefixes[key.slice("xmlns:".length)] = value;
    }
  }

  const targetNamespace = root.attributes.targetNamespace ?? prefixes[""] ?? "";
  const components = new Map<string, ComponentDefinition>();
  const declarationScopes: ParsedXmlNode[] = [root];
  for (const child of root.children) {
    if (redefiningContainers.has(localName(child.name))) {
      declarationScopes.push(child);
    }
  }
  for (const scope of declarationScopes) {
    for (const child of scope.children) {
      const kind = kindForDeclaration(localName(child.name));
      const name = child.attributes.name;
      if (kind && name) {
        // A `redefine`/`override` child intentionally shadows the same name
        // pulled in from the referenced document.
        components.set(`${targetNamespace}|${kind}|${name}`, {
          kind,
          name,
          namespace: targetNamespace,
          node: child,
          documentUri: uri,
        });
      }
    }
  }

  return {
    uri,
    targetNamespace,
    prefixes,
    root,
    imports: schemaLocations(root, "import"),
    importNamespaces: findChildren(root, "import")
      .map((node) => node.attributes.namespace)
      .filter((namespace): namespace is string => Boolean(namespace)),
    includes: [
      ...schemaLocations(root, "include"),
      ...schemaLocations(root, "redefine"),
      ...schemaLocations(root, "override"),
    ],
    components,
    diagnostics,
  };
}

/**
 * Human documentation from `xs:annotation/xs:documentation`. A structured
 * `ccts:Component` block is excluded — it is surfaced separately by
 * `cctsInfo`, and flattening it here would produce a run-on of its field
 * values instead of prose.
 */
export function annotationText(node: ParsedXmlNode): string | undefined {
  const annotation = firstChild(node, "annotation");
  const documentation = annotation ? firstChild(annotation, "documentation") : undefined;
  if (!documentation) {
    return undefined;
  }
  const text = [
    documentation.text,
    ...documentation.children
      .filter((child) => localName(child.name) !== "Component")
      .map(collectText),
  ].join(" ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

export function cctsInfo(node: ParsedXmlNode): Record<string, string> {
  const documentation = firstChild(firstChild(node, "annotation") ?? node, "documentation");
  const component = documentation
    ? documentation.children.find((child) => localName(child.name) === "Component")
    : undefined;
  if (!component) {
    return {};
  }
  const values: Record<string, string> = {};
  for (const child of component.children) {
    const key = localName(child.name);
    const value = collectText(child).replace(/\s+/g, " ").trim();
    if (value) {
      values[key] = value;
    }
  }
  return values;
}

export function collectText(node: ParsedXmlNode): string {
  return `${node.text} ${node.children.map(collectText).join(" ")}`.trim();
}

const particleNames = new Set([
  "sequence",
  "choice",
  "all",
  "group",
  "element",
  "any",
  "attribute",
  "attributeGroup",
  "anyAttribute",
]);

/** The derivation step (`extension`/`restriction`) of a complex or simple type, if any. */
export function derivationOf(node: ParsedXmlNode): ParsedXmlNode | undefined {
  const structuredContent = firstChild(node, "complexContent") ?? firstChild(node, "simpleContent");
  if (!structuredContent) {
    return undefined;
  }
  return firstChild(structuredContent, "extension") ?? firstChild(structuredContent, "restriction");
}

export function childParticles(node: ParsedXmlNode): ParsedXmlNode[] {
  const content = derivationOf(node) ?? node;
  return content.children.filter((child) => particleNames.has(localName(child.name)));
}

export function nodeLocalName(node: ParsedXmlNode): string {
  return localName(node.name);
}

export { firstChild as firstChildNamed };
