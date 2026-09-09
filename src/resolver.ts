import {
  ComponentDefinition,
  NodeKind,
  ParsedXmlNode,
  PreviewModel,
  SchemaDocument,
  SchemaNode,
  SearchHit,
  componentKey,
  sourceLocation,
  uriBasename,
} from "./model";
import {
  annotationText,
  childParticles,
  cctsInfo,
  derivationOf,
  nodeLocalName,
  parseSchema,
} from "./parser";
import { SchemaFileSystem } from "./schemaFileSystem";

export interface ResolverOptions {
  collapseRepeatedSubtrees: boolean;
  parseCctsAnnotations: boolean;
  autoCollapseDepth?: number;
  maxExpansionNodes?: number;
}

const maxTypeExpansions = 4;
const maxExpansionDepth = 24;
/** Roots expanded up front; the remainder load on demand to bound the first payload. */
const maxEagerRoots = 12;
const maxBaseFacetDepth = 8;
const defaultEagerNodes = 800;
const defaultAutoCollapseDepth = 3;
const xsdNamespace = "http://www.w3.org/2001/XMLSchema";
/** Shown as tree roots when a schema declares no global elements. */
const rootKinds = new Set<NodeKind>(["complexType", "simpleType", "group", "attributeGroup"]);

interface ExpansionState {
  remainingNodes: number;
  typeExpansionCounts: Map<string, number>;
  firstOccurrenceIds: Map<string, string>;
}

interface ExpansionContext {
  component: ComponentDefinition;
  depth: number;
  typeStack: string[];
  expandedTypes: Map<string, string>;
  occurrencePath: string;
  /**
   * Set on a cycle stub. Expanding the stub drops this type from the ancestor
   * chain so exactly one more level renders, then the guard applies again.
   */
  cycleTypeId?: string;
}

function splitQName(value: string | undefined): { prefix?: string; local: string } {
  if (!value) {
    return { local: "" };
  }
  const separator = value.indexOf(":");
  return separator < 0
    ? { local: value }
    : { prefix: value.slice(0, separator), local: value.slice(separator + 1) };
}

function occurrence(value: string | undefined, fallback: number): number | "unbounded" {
  if (!value) {
    return fallback;
  }
  if (value.trim() === "unbounded") {
    return "unbounded";
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function count(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) ? parsed : fallback;
}

function firstChild(node: ParsedXmlNode, name: string): ParsedXmlNode | undefined {
  return node.children.find((child) => nodeLocalName(child) === name);
}

/**
 * Combines a type's inherited content with what it declares itself.
 *
 * An `xs:extension` appends. An `xs:restriction` restates: a re-declared
 * component replaces the inherited one of the same name rather than appearing
 * twice. Attributes are always merged by name, since a type cannot carry two
 * attributes with the same name under either kind of derivation.
 */
function mergeDerivedContent(
  inherited: SchemaNode[],
  own: SchemaNode[],
  isRestriction: boolean,
): SchemaNode[] {
  const replaceable = (node: SchemaNode): boolean => Boolean(node.name)
    && (isRestriction || node.kind === "attribute" || node.kind === "anyAttribute");
  const keyOf = (node: SchemaNode): string => `${node.kind}|${node.name}`;
  const overrides = new Map<string, SchemaNode>();
  for (const node of own) {
    if (replaceable(node)) {
      overrides.set(keyOf(node), node);
    }
  }
  if (overrides.size === 0) {
    return [...inherited, ...own];
  }
  const consumed = new Set<string>();
  // Overrides keep the inherited component's position, which is the order a
  // reader of the base type expects.
  const merged = inherited.map((node) => {
    if (!replaceable(node)) {
      return node;
    }
    const key = keyOf(node);
    const override = overrides.get(key);
    if (!override) {
      return node;
    }
    consumed.add(key);
    return override;
  });
  for (const node of own) {
    if (replaceable(node) && consumed.has(keyOf(node)) && overrides.get(keyOf(node)) === node) {
      continue;
    }
    merged.push(node);
  }
  return merged;
}

function normalizeType(type: string | undefined): string | undefined {
  return type?.trim() || undefined;
}

/**
 * Identity used by the cycle and repeat guards. The declaring document is part
 * of it because `xs:redefine` lets two documents declare the same type name,
 * and a redefinition deriving from the original is not a cycle.
 */
function typeIdentity(type: ComponentDefinition): string {
  return `${type.documentUri}|${type.namespace}|${type.kind}|${type.name}`;
}

export class SchemaResolver {
  private readonly documents = new Map<string, SchemaDocument>();
  private readonly warnings: string[] = [];
  private readonly expansionContexts = new Map<string, ExpansionContext>();

  public constructor(
    private readonly fileSystem: SchemaFileSystem,
    private options: ResolverOptions = {
      collapseRepeatedSubtrees: true,
      parseCctsAnnotations: true,
    },
  ) {}

  /** Applies changed settings in place; the parsed document cache is unaffected. */
  public setOptions(options: ResolverOptions): void {
    this.options = options;
  }

  /** True when `uri` is part of this resolver's loaded document graph. */
  public has(uri: string): boolean {
    return this.documents.has(uri);
  }

  /** Drops a cached document so the next `build` re-reads it from disk. */
  public invalidate(uri: string): void {
    this.documents.delete(uri);
  }

  private createExpansionState(): ExpansionState {
    return {
      remainingNodes: this.options.maxExpansionNodes ?? defaultEagerNodes,
      typeExpansionCounts: new Map<string, number>(),
      firstOccurrenceIds: new Map<string, string>(),
    };
  }

  public async build(uri: string, rootText?: string): Promise<PreviewModel> {
    this.warnings.length = 0;
    this.expansionContexts.clear();
    await this.loadDocument(uri, rootText, new Set<string>());
    const rootDocument = this.documents.get(uri);
    if (!rootDocument) {
      throw new Error(`Unable to parse ${uri}`);
    }

    for (const document of this.documents.values()) {
      for (const diagnostic of document.diagnostics) {
        this.warnings.push(`${uriBasename(document.uri)}: ${diagnostic}`);
      }
    }

    const localComponents = [...rootDocument.components.values()];
    const componentPool = localComponents.length > 0
      ? localComponents
      : [...this.documents.values()]
        .filter((document) => rootDocument.importNamespaces.includes(document.targetNamespace))
        .flatMap((document) => [...document.components.values()]);
    const elements = componentPool.filter((component) => component.kind === "element");
    // A library schema declares only types and groups; showing those is far
    // more useful than an empty preview.
    const rootElements = elements.length > 0
      ? elements
      : componentPool.filter((component) => rootKinds.has(component.kind));
    const eagerLevels = this.eagerLevels();
    const roots = rootElements.map((component, index) => this.expandComponent(
      component,
      0,
      [],
      new Map<string, string>(),
      `${component.documentUri}|root|${component.name}`,
      this.createExpansionState(),
      index < maxEagerRoots ? eagerLevels : 0,
    ));
    if (rootElements.length > maxEagerRoots) {
      const label = elements.length > 0 ? "global elements" : "global type declarations";
      this.warnings.push(
        `${rootElements.length} ${label} found; the first ${maxEagerRoots} are pre-expanded, the rest load when opened.`,
      );
    }

    const namespacePrefixes: Record<string, string> = {};
    for (const document of this.documents.values()) {
      for (const [prefix, namespace] of Object.entries(document.prefixes)) {
        if (prefix && !namespacePrefixes[namespace]) {
          namespacePrefixes[namespace] = prefix;
        }
      }
    }

    return {
      source: uri,
      title: uriBasename(uri),
      targetNamespace: rootDocument.targetNamespace,
      namespacePrefixes,
      warnings: [...this.warnings],
      roots,
      autoCollapseDepth: this.eagerLevels(),
    };
  }

  /** Element levels expanded without a click, mirroring `autoCollapseDepth`. */
  private eagerLevels(): number {
    return Math.max(1, this.options.autoCollapseDepth ?? defaultAutoCollapseDepth);
  }

  public expandNode(id: string): SchemaNode["children"] | undefined {
    const context = this.expansionContexts.get(id);
    if (!context) {
      return undefined;
    }
    const typeStack = context.cycleTypeId
      ? context.typeStack.filter((typeId) => typeId !== context.cycleTypeId)
      : context.typeStack;
    const expanded = this.expandComponent(
      context.component,
      context.depth,
      typeStack,
      new Map(context.expandedTypes),
      context.occurrencePath,
      this.createExpansionState(),
      1,
    );
    return expanded.children;
  }

  /** Matches global declarations across every loaded document by name and documentation. */
  public search(query: string, limit = 50): SearchHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return [];
    }
    const hits: SearchHit[] = [];
    for (const document of this.documents.values()) {
      for (const component of document.components.values()) {
        const documentation = annotationText(component.node);
        const haystack = `${component.name} ${documentation ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) {
          continue;
        }
        hits.push({
          kind: component.kind,
          name: component.name,
          namespace: component.namespace,
          documentation,
          sourceLocation: sourceLocation(component.documentUri, component.node),
        });
        if (hits.length >= limit) {
          return hits;
        }
      }
    }
    return hits;
  }

  /**
   * Loads `uri` and everything it imports/includes. Cached documents are not
   * re-parsed, but their references are still walked, so invalidating a single
   * imported schema is enough to make the next build pick it up again.
   */
  private async loadDocument(
    uri: string,
    overrideText: string | undefined,
    visited: Set<string>,
  ): Promise<void> {
    if (visited.has(uri)) {
      return;
    }
    visited.add(uri);
    let document = this.documents.get(uri);
    if (!document || overrideText !== undefined) {
      const source = overrideText ?? await this.fileSystem.readFile(uri);
      document = parseSchema(uri, source);
      this.documents.set(uri, document);
    }
    for (const location of [...document.imports, ...document.includes]) {
      let importedUri: string;
      try {
        importedUri = this.fileSystem.resolveRelative(uri, location);
      } catch (error) {
        this.warnings.push(`Unable to resolve ${location}: ${String(error)}`);
        continue;
      }
      try {
        await this.loadDocument(importedUri, undefined, visited);
      } catch (error) {
        this.warnings.push(`Unable to load ${location}: ${String(error)}`);
      }
    }
  }

  /** Lookup key for a QName as written in `document`, or undefined for built-ins. */
  private componentKeyFor(
    document: SchemaDocument,
    kind: NodeKind,
    qname: string | undefined,
  ): string | undefined {
    const parsed = splitQName(qname);
    if (!parsed.local) {
      return undefined;
    }
    const namespace = parsed.prefix
      ? document.prefixes[parsed.prefix] ?? ""
      : document.targetNamespace;
    if (namespace === xsdNamespace) {
      return undefined;
    }
    return componentKey(namespace, kind, parsed.local);
  }

  private findComponent(
    document: SchemaDocument,
    kind: NodeKind,
    qname: string | undefined,
  ): ComponentDefinition | undefined {
    const key = this.componentKeyFor(document, kind, qname);
    if (!key) {
      return undefined;
    }
    // The referencing document wins, so `redefine`/`override` shadowing applies.
    return document.components.get(key) ?? this.findInAnyDocument(key);
  }

  private findInAnyDocument(key: string, excludeUri?: string): ComponentDefinition | undefined {
    for (const candidate of this.documents.values()) {
      if (candidate.uri === excludeUri) {
        continue;
      }
      const found = candidate.components.get(key);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /**
   * Builds one node. `eagerLevels` is how many further *element* levels to
   * expand without a click; structure particles, groups and types pass it
   * through unchanged so it counts levels the reader actually sees.
   */
  private expandComponent(
    component: ComponentDefinition,
    depth: number,
    typeStack: string[],
    expandedTypes: Map<string, string>,
    occurrencePath: string,
    state: ExpansionState,
    eagerLevels: number,
  ): SchemaNode {
    const hasBudget = state.remainingNodes > 0;
    if (hasBudget) {
      state.remainingNodes -= 1;
    }
    const componentId = `${component.documentUri}|${component.kind}|${component.name}`;
    const node: SchemaNode = {
      id: `${componentId}|${occurrencePath}`,
      kind: component.kind,
      name: component.name,
      namespace: component.namespace,
      sourceLocation: sourceLocation(component.documentUri, component.node),
      documentation: annotationText(component.node),
      children: [],
    };

    const ccts = this.cctsFor(component.node);
    if (ccts) {
      node.ccts = ccts;
    }

    const context: ExpansionContext = {
      component,
      depth,
      typeStack: [...typeStack],
      expandedTypes: new Map(expandedTypes),
      occurrencePath,
    };
    this.expansionContexts.set(node.id, context);

    const document = this.documentFor(component);

    if (component.kind === "element") {
      node.type = normalizeType(component.node.attributes.type);
      node.minOccurs = count(component.node.attributes.minOccurs, 1);
      node.maxOccurs = occurrence(component.node.attributes.maxOccurs, 1);
      node.nillable = component.node.attributes.nillable === "true";
      node.abstract = component.node.attributes.abstract === "true" || undefined;
      node.substitutionGroup = normalizeType(component.node.attributes.substitutionGroup);
      node.fixed = component.node.attributes.fixed;
      node.default = component.node.attributes.default;
      const ref = component.node.attributes.ref;
      if (ref) {
        const referenced = this.findComponent(document, "element", ref);
        if (referenced) {
          node.type = node.type ?? referenced.node.attributes.type;
          node.documentation = node.documentation ?? annotationText(referenced.node);
          node.ccts = node.ccts ?? this.cctsFor(referenced.node);
        } else {
          node.unresolvedRef = ref;
        }
      }
      const inlineComplexType = firstChild(component.node, "complexType");
      const inlineSimpleType = firstChild(component.node, "simpleType");
      if (inlineSimpleType) {
        node.facets = this.facets(inlineSimpleType, document);
      }
      const complexType = node.type
        ? this.findComponent(document, "complexType", node.type)
        : undefined;
      node.expandable = Boolean(inlineComplexType || complexType);
      // Simple content is cheap to describe, so facets and docs are attached
      // whether or not this node is being expanded.
      if (node.type && !complexType && !inlineSimpleType) {
        const simpleType = this.findComponent(document, "simpleType", node.type);
        if (simpleType) {
          node.documentation = node.documentation ?? annotationText(simpleType.node);
          node.facets = this.facets(simpleType.node, this.documentFor(simpleType));
          node.ccts = node.ccts ?? this.cctsFor(simpleType.node);
        }
      }
      if (complexType) {
        // A type's own annotation (UBL's ABIE block) describes the element
        // that uses it, so it is attached even at a cycle stub.
        node.ccts = node.ccts ?? this.cctsFor(complexType.node);
        node.documentation = node.documentation ?? annotationText(complexType.node);
        const typeId = typeIdentity(complexType);
        if (typeStack.includes(typeId)) {
          node.recursion = {
            cyclesBackToTypeId: typeId,
            targetNodeId: expandedTypes.get(typeId),
          };
          // Expandable on demand: one more level per click, guard re-applied.
          node.expandable = true;
          node.childrenLoaded = false;
          context.cycleTypeId = typeId;
          return node;
        }
      }
      const canExpand = eagerLevels > 0 && hasBudget && depth < maxExpansionDepth;
      node.childrenLoaded = node.expandable ? canExpand : true;
      if (!canExpand) {
        return node;
      }
      if (inlineComplexType) {
        node.children = this.expandParticles(
          inlineComplexType,
          depth + 1,
          typeStack,
          expandedTypes,
          component.documentUri,
          node.id,
          state,
          eagerLevels,
        );
      } else if (node.type) {
        node.children = this.expandType(
          document,
          node.type,
          depth + 1,
          typeStack,
          expandedTypes,
          node.id,
          state,
          eagerLevels,
        );
      }
    } else if (
      component.kind === "complexType"
      || component.kind === "group"
      || component.kind === "attributeGroup"
    ) {
      if (eagerLevels <= 0 || !hasBudget || depth >= maxExpansionDepth) {
        node.expandable = true;
        node.childrenLoaded = false;
        return node;
      }
      node.children = this.expandParticles(
        component.node,
        depth + 1,
        typeStack,
        expandedTypes,
        component.documentUri,
        node.id,
        state,
        eagerLevels,
      );
      node.childrenLoaded = true;
    } else if (component.kind === "attribute") {
      node.type = normalizeType(component.node.attributes.type);
      node.minOccurs = component.node.attributes.use === "required" ? 1 : 0;
      node.maxOccurs = 1;
      node.fixed = component.node.attributes.fixed;
      node.default = component.node.attributes.default;
      const inlineSimpleType = firstChild(component.node, "simpleType");
      if (inlineSimpleType) {
        node.facets = this.facets(inlineSimpleType, document);
      } else if (node.type) {
        const simpleType = this.findComponent(document, "simpleType", node.type);
        if (simpleType) {
          node.documentation = node.documentation ?? annotationText(simpleType.node);
          node.facets = this.facets(simpleType.node, this.documentFor(simpleType));
        }
      }
    } else if (component.kind === "simpleType") {
      node.facets = this.facets(component.node, document);
    }

    return node;
  }

  private expandType(
    document: SchemaDocument,
    typeName: string,
    depth: number,
    typeStack: string[],
    expandedTypes: Map<string, string>,
    occurrenceId: string,
    state: ExpansionState,
    eagerLevels: number,
    derivingFrom?: ParsedXmlNode,
  ): SchemaNode[] {
    let type = this.findComponent(document, "complexType", typeName);
    if (type && derivingFrom && type.node === derivingFrom) {
      // `xs:redefine`/`xs:override` restate a type in terms of the definition
      // they replace, so the base is the shadowed original, not this one.
      const key = this.componentKeyFor(document, "complexType", typeName);
      type = key ? this.findInAnyDocument(key, type.documentUri) : undefined;
    }
    if (!type) {
      return [];
    }
    const typeId = typeIdentity(type);
    if (typeStack.includes(typeId)) {
      return [this.typeStub(type, typeId, `${typeId}|recursive|${occurrenceId}`, {
        depth,
        typeStack,
        expandedTypes,
        recursion: { cyclesBackToTypeId: typeId, targetNodeId: expandedTypes.get(typeId) },
      })];
    }
    const expansionCount = state.typeExpansionCounts.get(typeId) ?? 0;
    const firstOccurrenceId = state.firstOccurrenceIds.get(typeId);
    if (this.options.collapseRepeatedSubtrees && expansionCount >= maxTypeExpansions) {
      return [this.typeStub(type, typeId, `${typeId}|repeat|${occurrenceId}`, {
        depth,
        typeStack,
        expandedTypes,
        firstOccurrenceId,
      })];
    }
    state.typeExpansionCounts.set(typeId, expansionCount + 1);
    state.firstOccurrenceIds.set(typeId, firstOccurrenceId ?? occurrenceId);
    expandedTypes.set(typeId, occurrenceId);
    return this.expandParticles(
      type.node,
      depth,
      [...typeStack, typeId],
      expandedTypes,
      type.documentUri,
      occurrenceId,
      state,
      eagerLevels,
    );
  }

  /**
   * A collapsed placeholder for a type that cycles or repeats. Both kinds stay
   * expandable on demand — the guards are display hints, never a dead end.
   */
  private typeStub(
    type: ComponentDefinition,
    typeId: string,
    id: string,
    details: {
      depth: number;
      typeStack: string[];
      expandedTypes: Map<string, string>;
      recursion?: SchemaNode["recursion"];
      firstOccurrenceId?: string;
    },
  ): SchemaNode {
    this.expansionContexts.set(id, {
      component: type,
      depth: details.depth,
      typeStack: [...details.typeStack],
      expandedTypes: new Map(details.expandedTypes),
      occurrencePath: id,
      cycleTypeId: details.recursion ? typeId : undefined,
    });
    return {
      id,
      kind: "complexType",
      name: type.name,
      namespace: type.namespace,
      type: type.name,
      sourceLocation: sourceLocation(type.documentUri, type.node),
      documentation: annotationText(type.node),
      children: [],
      recursion: details.recursion,
      firstOccurrenceId: details.firstOccurrenceId,
      collapsed: true,
      expandable: true,
      childrenLoaded: false,
    };
  }

  private expandParticles(
    node: ParsedXmlNode,
    depth: number,
    typeStack: string[],
    expandedTypes: Map<string, string>,
    documentUri: string,
    parentId: string,
    state: ExpansionState,
    eagerLevels: number,
  ): SchemaNode[] {
    const document = this.documents.get(documentUri);
    if (!document) {
      return [];
    }
    const derivation = derivationOf(node);
    const inherited = derivation?.attributes.base
      ? this.expandType(
        document,
        derivation.attributes.base,
        depth + 1,
        typeStack,
        new Map(expandedTypes),
        parentId,
        state,
        eagerLevels,
        node,
      )
      : [];
    const own: SchemaNode[] = [];
    for (const particle of childParticles(node)) {
      const branchTypes = new Map(expandedTypes);
      const particleKind = nodeLocalName(particle) as NodeKind;
      const particleId = `${parentId}|${particleKind}|${particle.location.line}|${particle.location.column}`;
      if (particleKind === "sequence" || particleKind === "choice" || particleKind === "all") {
        if (state.remainingNodes > 0) {
          state.remainingNodes -= 1;
        }
        own.push({
          id: particleId,
          kind: particleKind,
          name: particleKind,
          minOccurs: count(particle.attributes.minOccurs, 1),
          maxOccurs: occurrence(particle.attributes.maxOccurs, 1),
          sourceLocation: sourceLocation(documentUri, particle),
          documentation: annotationText(particle),
          childrenLoaded: true,
          children: this.expandParticles(
            particle,
            depth + 1,
            typeStack,
            branchTypes,
            documentUri,
            particleId,
            state,
            eagerLevels,
          ),
        });
        continue;
      }
      if (particleKind === "group" || particleKind === "attributeGroup") {
        const ref = particle.attributes.ref;
        const group = this.findComponent(document, particleKind, ref);
        own.push(group
          ? this.expandComponent(group, depth + 1, typeStack, branchTypes, particleId, state, eagerLevels)
          : this.unresolvedNode(documentUri, particle, particleKind, ref));
        continue;
      }
      if (particleKind === "any" || particleKind === "anyAttribute") {
        own.push(this.wildcardNode(documentUri, particle, particleKind, particleId));
        continue;
      }
      if (particleKind === "attribute") {
        const referenced = particle.attributes.ref
          ? this.findComponent(document, "attribute", particle.attributes.ref)
          : undefined;
        const component: ComponentDefinition = referenced ?? {
          kind: "attribute",
          name: particle.attributes.ref ?? particle.attributes.name ?? "attribute",
          namespace: document.targetNamespace,
          node: particle,
          documentUri,
        };
        const child = this.expandComponent(
          component,
          depth + 1,
          typeStack,
          branchTypes,
          particleId,
          state,
          0,
        );
        if (particle.attributes.ref && !referenced) {
          child.unresolvedRef = particle.attributes.ref;
        }
        if (referenced) {
          // `use` lives on the reference, not the global declaration.
          child.minOccurs = particle.attributes.use === "required" ? 1 : 0;
        }
        child.documentation = annotationText(particle) ?? child.documentation;
        child.ccts = this.cctsFor(particle) ?? child.ccts;
        own.push(child);
        continue;
      }
      const ref = particle.attributes.ref;
      const component = ref
        ? this.findComponent(document, "element", ref)
        : particle.attributes.name
          ? {
              kind: "element" as const,
              name: particle.attributes.name,
              namespace: document.targetNamespace,
              node: particle,
              documentUri,
            }
          : undefined;
      if (!component) {
        own.push(this.unresolvedNode(documentUri, particle, "element", ref));
        continue;
      }
      const child = this.expandComponent(
        component,
        depth + 1,
        typeStack,
        branchTypes,
        particleId,
        state,
        eagerLevels - 1,
      );
      child.minOccurs = count(particle.attributes.minOccurs, child.minOccurs ?? 1);
      const inheritedMaxOccurs = child.maxOccurs ?? 1;
      child.maxOccurs = particle.attributes.maxOccurs
        ? occurrence(particle.attributes.maxOccurs, 1)
        : inheritedMaxOccurs;
      child.documentation = annotationText(particle) ?? child.documentation;
      child.ccts = this.cctsFor(particle) ?? child.ccts;
      child.nillable = particle.attributes.nillable === "true" || child.nillable;
      own.push(child);
    }
    return mergeDerivedContent(
      inherited,
      own,
      derivation !== undefined && nodeLocalName(derivation) === "restriction",
    );
  }

  private wildcardNode(
    documentUri: string,
    node: ParsedXmlNode,
    kind: "any" | "anyAttribute",
    id: string,
  ): SchemaNode {
    return {
      id,
      kind,
      name: kind === "any" ? "any" : "anyAttribute",
      minOccurs: kind === "any" ? count(node.attributes.minOccurs, 1) : undefined,
      maxOccurs: kind === "any" ? occurrence(node.attributes.maxOccurs, 1) : undefined,
      wildcard: {
        namespace: node.attributes.namespace ?? "##any",
        processContents: node.attributes.processContents ?? "strict",
      },
      sourceLocation: sourceLocation(documentUri, node),
      documentation: annotationText(node),
      children: [],
      childrenLoaded: true,
    };
  }

  private unresolvedNode(
    documentUri: string,
    node: ParsedXmlNode,
    kind: NodeKind,
    reference: string | undefined,
  ): SchemaNode {
    return {
      id: `${documentUri}|unresolved|${kind}|${node.location.line}|${node.location.column}`,
      kind,
      name: reference ?? node.attributes.name ?? "unresolved",
      sourceLocation: sourceLocation(documentUri, node),
      children: [],
      childrenLoaded: true,
      unresolvedRef: reference,
      documentation: annotationText(node),
    };
  }

  /**
   * Facets of a simple type, including those inherited from its restriction
   * base, plus `list`/`union` descriptors.
   */
  private facets(
    node: ParsedXmlNode,
    document: SchemaDocument,
    depth = 0,
  ): Record<string, string | string[]> {
    const list = firstChild(node, "list");
    const union = firstChild(node, "union");
    const restriction = firstChild(node, "restriction")
      ?? firstChild(firstChild(node, "simpleContent") ?? node, "restriction");
    const facets: Record<string, string | string[]> = {};
    if (list) {
      const itemType = normalizeType(list.attributes.itemType);
      facets.list = itemType ?? "(inline item type)";
    }
    if (union) {
      const members = normalizeType(union.attributes.memberTypes);
      facets.union = members ? members.split(/\s+/) : "(inline member types)";
    }
    if (!restriction) {
      return facets;
    }
    const base = normalizeType(restriction.attributes.base);
    if (base) {
      facets.base = base;
      if (depth < maxBaseFacetDepth) {
        const baseType = this.findComponent(document, "simpleType", base);
        if (baseType) {
          Object.assign(facets, this.facets(baseType.node, this.documentFor(baseType), depth + 1));
          facets.base = base;
        }
      }
    }
    const grouped = new Map<string, string[]>();
    for (const child of restriction.children) {
      const name = nodeLocalName(child);
      const value = child.attributes.value;
      if (value !== undefined) {
        grouped.set(name, [...(grouped.get(name) ?? []), value]);
      }
    }
    for (const [key, values] of grouped) {
      facets[key] = values.length === 1 ? values[0] : values;
    }
    return facets;
  }

  private documentFor(component: ComponentDefinition): SchemaDocument {
    const document = this.documents.get(component.documentUri);
    if (!document) {
      throw new Error(`Schema document is not loaded: ${component.documentUri}`);
    }
    return document;
  }

  private cctsFor(node: ParsedXmlNode) {
    if (!this.options.parseCctsAnnotations) {
      return undefined;
    }
    const values = cctsInfo(node);
    if (Object.keys(values).length === 0) {
      return undefined;
    }
    return {
      componentType: values.ComponentType,
      dictionaryEntryName: values.DictionaryEntryName,
      definition: values.Definition,
      cardinality: values.Cardinality,
      objectClass: values.ObjectClass,
      propertyTerm: values.PropertyTerm,
      representationTerm: values.RepresentationTerm,
      dataType: values.DataType,
      examples: values.Examples,
    };
  }
}
