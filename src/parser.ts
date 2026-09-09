import * as sax from "sax";
import type * as vscode from "vscode";
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

function attributesOf(node: ParsedXmlNode): Record<string, string> {
  return node.attributes;
}

export function parseXml(uri: vscode.Uri, text: string): ParsedXmlNode {
  const parser = sax.parser(true, { xmlns: false, trim: false, normalize: false });
  const root: ParsedXmlNode = {
    name: "__document__",
    attributes: {},
    children: [],
    text: "",
    location: { uri: uri.toString(), line: 0, column: 0 },
  };
  const stack: ParsedXmlNode[] = [root];

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
      location: {
        uri: uri.toString(),
        line: parser.line,
        column: parser.column,
      },
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
  parser.write(text).close();
  return root.children[0] ?? root;
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

export function parseSchema(uri: vscode.Uri, text: string): SchemaDocument {
  const root = parseXml(uri, text);
  const rootAttributes = attributesOf(root);
  const prefixes: Record<string, string> = {};
  for (const [key, value] of Object.entries(rootAttributes)) {
    if (key === "xmlns") {
      prefixes[""] = value;
    } else if (key.startsWith("xmlns:")) {
      prefixes[key.slice("xmlns:".length)] = value;
    }
  }

  const targetNamespace = rootAttributes.targetNamespace ?? prefixes[""] ?? "";
  const components = new Map<string, ComponentDefinition>();
  for (const child of root.children) {
    const kind = kindForDeclaration(localName(child.name));
    const name = child.attributes.name;
    if (kind && name) {
      components.set(
        `${targetNamespace}|${kind}|${name}`,
        {
          kind,
          name,
          namespace: targetNamespace,
          node: child,
          documentUri: uri.toString(),
        },
      );
    }
  }

  return {
    uri,
    targetNamespace,
    prefixes,
    root,
    imports: findChildren(root, "import")
      .map((node) => node.attributes.schemaLocation)
      .filter((location): location is string => Boolean(location)),
    importNamespaces: findChildren(root, "import")
      .map((node) => node.attributes.namespace)
      .filter((namespace): namespace is string => Boolean(namespace)),
    includes: findChildren(root, "include")
      .map((node) => node.attributes.schemaLocation)
      .filter((location): location is string => Boolean(location)),
    components,
  };
}

export function annotationText(node: ParsedXmlNode): string | undefined {
  const annotation = firstChild(node, "annotation");
  if (!annotation) {
    return undefined;
  }
  const documentation = firstChild(annotation, "documentation");
  if (!documentation) {
    return undefined;
  }
  const text = collectText(documentation).replace(/\s+/g, " ").trim();
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

export function childParticles(node: ParsedXmlNode): ParsedXmlNode[] {
  const structuredContent = firstChild(node, "complexContent") ?? firstChild(node, "simpleContent");
  const extension = structuredContent ? firstChild(structuredContent, "extension") : undefined;
  const restriction = structuredContent ? firstChild(structuredContent, "restriction") : undefined;
  const content = extension ?? restriction ?? node;
  const particles: ParsedXmlNode[] = [];
  const particleNames = new Set([
    "sequence",
    "choice",
    "all",
    "group",
    "element",
    "any",
    "attribute",
    "attributeGroup",
  ]);
  for (const child of content.children) {
    if (particleNames.has(localName(child.name))) {
      particles.push(child);
    }
  }
  return particles;
}

export function nodeLocalName(node: ParsedXmlNode): string {
  return localName(node.name);
}
