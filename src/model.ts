import type * as vscode from "vscode";

export type NodeKind =
  | "element"
  | "attribute"
  | "complexType"
  | "simpleType"
  | "group"
  | "attributeGroup"
  | "sequence"
  | "choice"
  | "all"
  | "any";

export interface SourceLocation {
  uri: string;
  line: number;
  column: number;
}

export interface CctsComponentInfo {
  componentType?: string;
  dictionaryEntryName?: string;
  definition?: string;
  cardinality?: string;
  objectClass?: string;
}

export interface SchemaNode {
  id: string;
  kind: NodeKind;
  name?: string;
  namespace?: string;
  type?: string;
  minOccurs?: number;
  maxOccurs?: number | "unbounded";
  nillable?: boolean;
  fixed?: string;
  default?: string;
  documentation?: string;
  ccts?: CctsComponentInfo;
  facets?: Record<string, string | string[]>;
  sourceLocation: SourceLocation;
  children: SchemaNode[];
  unresolvedRef?: string;
  recursion?: { cyclesBackToTypeId: string; targetNodeId?: string };
  firstOccurrenceId?: string;
  collapsed?: boolean;
  expandable?: boolean;
  childrenLoaded?: boolean;
}

export interface ParsedXmlNode {
  name: string;
  attributes: Record<string, string>;
  children: ParsedXmlNode[];
  text: string;
  location: SourceLocation;
}

export interface ComponentDefinition {
  kind: NodeKind;
  name: string;
  namespace: string;
  node: ParsedXmlNode;
  documentUri: string;
}

export interface SchemaDocument {
  uri: vscode.Uri;
  targetNamespace: string;
  prefixes: Record<string, string>;
  root: ParsedXmlNode;
  imports: string[];
  importNamespaces: string[];
  includes: string[];
  components: Map<string, ComponentDefinition>;
}

export interface PreviewModel {
  source: string;
  title: string;
  targetNamespace: string;
  namespacePrefixes: Record<string, string>;
  warnings: string[];
  roots: SchemaNode[];
}

export function componentKey(namespace: string, kind: NodeKind, name: string): string {
  return `${namespace}|${kind}|${name}`;
}

export function sourceLocation(uri: string, node: ParsedXmlNode): SourceLocation {
  return {
    uri,
    line: node.location.line,
    column: node.location.column,
  };
}
