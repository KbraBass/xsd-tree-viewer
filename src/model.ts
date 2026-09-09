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
  | "any"
  | "anyAttribute";

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
  propertyTerm?: string;
  representationTerm?: string;
  dataType?: string;
  examples?: string;
}

export interface WildcardInfo {
  namespace?: string;
  processContents?: string;
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
  abstract?: boolean;
  substitutionGroup?: string;
  wildcard?: WildcardInfo;
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
  uri: string;
  targetNamespace: string;
  prefixes: Record<string, string>;
  root: ParsedXmlNode;
  imports: string[];
  importNamespaces: string[];
  includes: string[];
  components: Map<string, ComponentDefinition>;
  diagnostics: string[];
}

/** A schema declaration matched by a host-side search over every loaded document. */
export interface SearchHit {
  kind: NodeKind;
  name: string;
  namespace: string;
  documentation?: string;
  sourceLocation: SourceLocation;
}

export interface PreviewModel {
  source: string;
  title: string;
  targetNamespace: string;
  namespacePrefixes: Record<string, string>;
  warnings: string[];
  roots: SchemaNode[];
  autoCollapseDepth: number;
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

/** Last path segment of a URI, used for panel and preview titles. */
export function uriBasename(uri: string): string {
  const withoutQuery = uri.split(/[?#]/)[0];
  const segments = withoutQuery.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? uri;
  return decodeURIComponent(last);
}
