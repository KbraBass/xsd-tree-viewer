import * as path from "node:path";
import * as vscode from "vscode";
import {
  ComponentDefinition,
  NodeKind,
  ParsedXmlNode,
  PreviewModel,
  SchemaDocument,
  SchemaNode,
  componentKey,
  sourceLocation,
} from "./model";
import {
  annotationText,
  childParticles,
  cctsInfo,
  nodeLocalName,
  parseSchema,
} from "./parser";

export interface ResolverOptions {
  collapseRepeatedSubtrees: boolean;
  parseCctsAnnotations: boolean;
  maxExpansionNodes?: number;
}

const maxTypeExpansions = 4;
const maxExpansionDepth = 12;

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
  return value === "unbounded" ? value : Number(value);
}

function firstChild(node: ParsedXmlNode, name: string): ParsedXmlNode | undefined {
  return node.children.find((child) => nodeLocalName(child) === name);
}

function normalizeType(type: string | undefined): string | undefined {
  return type?.trim() || undefined;
}

export class SchemaResolver {
  private readonly documents = new Map<string, SchemaDocument>();
  private readonly loading = new Set<string>();
  private readonly warnings: string[] = [];
  private readonly expansionContexts = new Map<string, ExpansionContext>();

  public constructor(
    private readonly rootText?: string,
    private readonly options: ResolverOptions = {
      collapseRepeatedSubtrees: true,
      parseCctsAnnotations: true,
    },
  ) {}

  private createExpansionState(): ExpansionState {
    return {
      remainingNodes: this.options.maxExpansionNodes ?? 120,
      typeExpansionCounts: new Map<string, number>(),
      firstOccurrenceIds: new Map<string, string>(),
    };
  }

  public async build(uri: vscode.Uri): Promise<PreviewModel> {
    await this.loadDocument(uri, this.rootText);
    const rootDocument = this.documents.get(uri.toString());
    if (!rootDocument) {
      throw new Error(`Unable to parse ${uri.toString()}`);
    }

    const rootComponents = rootDocument.components.size > 0
      ? [...rootDocument.components.values()]
      : [...this.documents.values()]
        .filter((document) => rootDocument.importNamespaces.includes(document.targetNamespace))
        .flatMap((document) => [...document.components.values()]);
    const roots = rootComponents
      .filter((component) => component.kind === "element")
      .map((component) => this.expandComponent(
        component,
        0,
        [],
        new Map<string, string>(),
        `${component.documentUri}|root|${component.name}`,
        this.createExpansionState(),
        true,
      ));
    const namespacePrefixes: Record<string, string> = {};
    for (const document of this.documents.values()) {
      for (const [prefix, namespace] of Object.entries(document.prefixes)) {
        if (prefix && !namespacePrefixes[namespace]) {
          namespacePrefixes[namespace] = prefix;
        }
      }
    }

    return {
      source: uri.toString(),
      title: path.basename(uri.fsPath),
      targetNamespace: rootDocument.targetNamespace,
      namespacePrefixes,
      warnings: [...this.warnings],
      roots,
    };
  }

  public expandNode(id: string): SchemaNode["children"] | undefined {
    const context = this.expansionContexts.get(id);
    if (!context) {
      return undefined;
    }
    const expanded = this.expandComponent(
      context.component,
      context.depth,
      context.typeStack,
      new Map(context.expandedTypes),
      context.occurrencePath,
      this.createExpansionState(),
      true,
    );
    return expanded.children;
  }

  private async loadDocument(uri: vscode.Uri, overrideText?: string): Promise<void> {
    const key = uri.toString();
    if (this.documents.has(key) || this.loading.has(key)) {
      return;
    }
    this.loading.add(key);
    try {
      const bytes = overrideText === undefined ? await vscode.workspace.fs.readFile(uri) : undefined;
      const source = overrideText ?? Buffer.from(bytes ?? []).toString("utf8");
      const document = parseSchema(uri, source);
      this.documents.set(key, document);
      for (const location of [...document.imports, ...document.includes]) {
        const importedUri = vscode.Uri.joinPath(uri, "..", location);
        try {
          await this.loadDocument(importedUri);
        } catch (error) {
          this.warnings.push(`Unable to load ${location}: ${String(error)}`);
        }
      }
    } catch (error) {
      this.loading.delete(key);
      throw error;
    }
    this.loading.delete(key);
  }

  private findComponent(
    document: SchemaDocument,
    kind: NodeKind,
    qname: string | undefined,
  ): ComponentDefinition | undefined {
    const parsed = splitQName(qname);
    if (!parsed.local) {
      return undefined;
    }
    const namespace = parsed.prefix
      ? document.prefixes[parsed.prefix] ?? ""
      : document.targetNamespace;
    const exact = this.documents.get(document.uri.toString())?.components.get(
      componentKey(namespace, kind, parsed.local),
    );
    if (exact) {
      return exact;
    }
    for (const candidate of this.documents.values()) {
      const found = candidate.components.get(componentKey(namespace, kind, parsed.local));
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private expandComponent(
    component: ComponentDefinition,
    depth: number,
    typeStack: string[],
    expandedTypes: Map<string, string>,
    occurrencePath: string,
    state: ExpansionState,
    expandChildren: boolean,
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

    const ccts = this.options.parseCctsAnnotations ? cctsInfo(component.node) : {};
    if (Object.keys(ccts).length > 0) {
      node.ccts = {
        componentType: ccts.ComponentType,
        dictionaryEntryName: ccts.DictionaryEntryName,
        definition: ccts.Definition,
        cardinality: ccts.Cardinality,
        objectClass: ccts.ObjectClass,
      };
    }

    this.expansionContexts.set(node.id, {
      component,
      depth,
      typeStack: [...typeStack],
      expandedTypes: new Map(expandedTypes),
      occurrencePath,
    });

    if (component.kind === "element") {
      node.type = normalizeType(component.node.attributes.type);
      node.minOccurs = Number(component.node.attributes.minOccurs ?? "1");
      node.maxOccurs = occurrence(component.node.attributes.maxOccurs, 1);
      node.nillable = component.node.attributes.nillable === "true";
      node.fixed = component.node.attributes.fixed;
      node.default = component.node.attributes.default;
      const ref = component.node.attributes.ref;
      if (ref) {
        const referenced = this.findComponent(this.documentFor(component), "element", ref);
        if (referenced) {
          node.type = node.type ?? referenced.node.attributes.type;
          node.documentation = node.documentation ?? annotationText(referenced.node);
          node.ccts = node.ccts ?? this.cctsFor(referenced.node);
        } else {
          node.unresolvedRef = ref;
        }
      }
      const inlineType = firstChild(component.node, "complexType");
      const complexType = node.type ? this.findComponent(this.documentFor(component), "complexType", node.type) : undefined;
      node.expandable = Boolean(inlineType || complexType);
      if (complexType) {
        const typeId = `${complexType.namespace}|complexType|${complexType.name}`;
        if (typeStack.includes(typeId)) {
          node.recursion = {
            cyclesBackToTypeId: typeId,
            targetNodeId: expandedTypes.get(typeId),
          };
          node.expandable = false;
          node.childrenLoaded = true;
          return node;
        }
      }
      node.childrenLoaded = !node.expandable || expandChildren;
      if (!expandChildren || !hasBudget || depth >= maxExpansionDepth) {
        return node;
      }
      if (inlineType) {
        node.children = this.expandParticles(
          inlineType,
          depth + 1,
          typeStack,
          expandedTypes,
          component.documentUri,
          node.id,
          state,
        );
      } else if (node.type) {
        node.children = this.expandType(
          this.documentFor(component),
          node.type,
          depth + 1,
          typeStack,
          expandedTypes,
          node.id,
          state,
        );
        const simpleType = this.findComponent(this.documentFor(component), "simpleType", node.type);
        if (simpleType) {
          node.documentation = node.documentation ?? annotationText(simpleType.node);
          node.facets = this.facets(simpleType.node);
          node.ccts = node.ccts ?? this.cctsFor(simpleType.node);
        }
      }
    } else if (component.kind === "complexType") {
      if (!expandChildren || !hasBudget || depth >= maxExpansionDepth) {
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
      );
    } else if (component.kind === "group" || component.kind === "attributeGroup") {
      if (!expandChildren || !hasBudget || depth >= maxExpansionDepth) {
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
      );
    } else if (component.kind === "attribute") {
      node.type = normalizeType(component.node.attributes.type);
      node.minOccurs = component.node.attributes.use === "required" ? 1 : 0;
      node.maxOccurs = 1;
      node.fixed = component.node.attributes.fixed;
      node.default = component.node.attributes.default;
      if (node.type) {
        const simpleType = this.findComponent(this.documentFor(component), "simpleType", node.type);
        if (simpleType) {
          node.documentation = node.documentation ?? annotationText(simpleType.node);
          node.facets = this.facets(simpleType.node);
        }
      }
    } else if (component.kind === "simpleType") {
      node.facets = this.facets(component.node);
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
  ): SchemaNode[] {
    const type = this.findComponent(document, "complexType", typeName);
    if (!type) {
      const simpleType = this.findComponent(document, "simpleType", typeName);
      if (simpleType) {
        return [];
      }
      return [];
    }
    const typeId = `${type.namespace}|complexType|${type.name}`;
    if (typeStack.includes(typeId)) {
      return [
        {
          id: `${typeId}|recursive|${occurrenceId}`,
          kind: "complexType",
          name: type.name,
          namespace: type.namespace,
          type: type.name,
          sourceLocation: sourceLocation(type.documentUri, type.node),
          children: [],
          recursion: { cyclesBackToTypeId: typeId, targetNodeId: expandedTypes.get(typeId) },
        },
      ];
    }
    const expansionCount = state.typeExpansionCounts.get(typeId) ?? 0;
    const firstOccurrenceId = state.firstOccurrenceIds.get(typeId);
    if (this.options.collapseRepeatedSubtrees && expansionCount >= maxTypeExpansions) {
      return [{
        id: `${typeId}|repeat|${occurrenceId}`,
        kind: "complexType",
        name: type.name,
        namespace: type.namespace,
        type: type.name,
        sourceLocation: sourceLocation(type.documentUri, type.node),
        children: [],
        firstOccurrenceId,
        collapsed: true,
      }];
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
    );
  }

  private expandParticles(
    node: ParsedXmlNode,
    depth: number,
    typeStack: string[],
    expandedTypes: Map<string, string>,
    documentUri: string,
    parentId: string,
    state: ExpansionState,
  ): SchemaNode[] {
    const document = this.documents.get(documentUri);
    if (!document) {
      return [];
    }
    const particles = childParticles(node);
    const structuredContent = firstChild(node, "complexContent") ?? firstChild(node, "simpleContent");
    const derivation = structuredContent
      ? firstChild(structuredContent, "extension") ?? firstChild(structuredContent, "restriction")
      : undefined;
    const inherited = derivation?.attributes.base
      ? this.expandType(document, derivation.attributes.base, depth + 1, typeStack, new Map(expandedTypes), parentId, state)
      : [];
    const output: SchemaNode[] = [...inherited];
    for (const particle of particles) {
      const branchTypes = new Map(expandedTypes);
      const branchState = typeStack.length <= 1 ? this.createExpansionState() : state;
      const particleKind = nodeLocalName(particle) as NodeKind;
      if (particleKind === "sequence" || particleKind === "choice" || particleKind === "all") {
        if (branchState.remainingNodes > 0) {
          branchState.remainingNodes -= 1;
        }
        output.push({
          id: `${parentId}|${particleKind}|${particle.location.line}|${particle.location.column}`,
          kind: particleKind,
          name: particleKind,
          minOccurs: Number(particle.attributes.minOccurs ?? "1"),
          maxOccurs: occurrence(particle.attributes.maxOccurs, 1),
          sourceLocation: sourceLocation(documentUri, particle),
          documentation: annotationText(particle),
          children: this.expandParticles(
            particle,
            depth + 1,
            typeStack,
            branchTypes,
            documentUri,
            `${parentId}|${particleKind}|${particle.location.line}|${particle.location.column}`,
            branchState,
          ),
        });
        continue;
      }
      if (particleKind === "group") {
        const ref = particle.attributes.ref;
        const group = this.findComponent(document, "group", ref);
        if (group) {
          output.push(this.expandComponent(
            group,
            depth + 1,
            typeStack,
            branchTypes,
            `${parentId}|${particleKind}|${particle.location.line}|${particle.location.column}`,
            branchState,
            true,
          ));
        } else {
          output.push(this.unresolvedNode(documentUri, particle, "group", ref));
        }
        continue;
      }
      if (particleKind === "attributeGroup") {
        const ref = particle.attributes.ref;
        const group = this.findComponent(document, "attributeGroup", ref);
        if (group) {
          output.push(this.expandComponent(
            group,
            depth + 1,
            typeStack,
            branchTypes,
            `${parentId}|${particleKind}|${particle.location.line}|${particle.location.column}`,
            branchState,
            true,
          ));
        } else {
          output.push(this.unresolvedNode(documentUri, particle, "attributeGroup", ref));
        }
        continue;
      }
      if (particleKind === "attribute") {
        const component: ComponentDefinition = particle.attributes.ref
          ? this.findComponent(document, "attribute", particle.attributes.ref) ?? {
              kind: "attribute",
              name: particle.attributes.ref,
              namespace: document.targetNamespace,
              node: particle,
              documentUri,
            }
          : {
              kind: "attribute",
              name: particle.attributes.name ?? "attribute",
              namespace: document.targetNamespace,
              node: particle,
              documentUri,
            };
        const child = this.expandComponent(
          component,
          depth + 1,
          typeStack,
          branchTypes,
          `${parentId}|${particleKind}|${particle.location.line}|${particle.location.column}`,
          branchState,
          false,
        );
        child.documentation = annotationText(particle) ?? child.documentation;
        output.push(child);
        continue;
      }
      const kind: NodeKind = particleKind === "any" ? "any" : "element";
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
        output.push(this.unresolvedNode(documentUri, particle, kind, ref));
        continue;
      }
      const child = this.expandComponent(
        component,
        depth + 1,
        typeStack,
        branchTypes,
        `${parentId}|${particleKind}|${particle.location.line}|${particle.location.column}`,
        this.createExpansionState(),
        false,
      );
      child.minOccurs = Number(particle.attributes.minOccurs ?? child.minOccurs ?? "1");
      const inheritedMaxOccurs = child.maxOccurs === "unbounded" ? "unbounded" : child.maxOccurs ?? 1;
      child.maxOccurs = particle.attributes.maxOccurs
        ? occurrence(particle.attributes.maxOccurs, 1)
        : inheritedMaxOccurs;
      child.documentation = annotationText(particle) ?? child.documentation;
      child.nillable = particle.attributes.nillable === "true" || child.nillable;
      output.push(child);
    }
    return output;
  }

  private unresolvedNode(
    documentUri: string,
    node: ParsedXmlNode,
    kind: NodeKind,
    reference: string | undefined,
  ): SchemaNode {
    return {
      id: `${documentUri}|unresolved|${node.location.line}|${node.location.column}`,
      kind,
      name: reference ?? node.attributes.name ?? "unresolved",
      sourceLocation: sourceLocation(documentUri, node),
      children: [],
      unresolvedRef: reference,
      documentation: annotationText(node),
    };
  }

  private facets(node: ParsedXmlNode): Record<string, string | string[]> {
    const restriction = firstChild(node, "restriction");
    if (!restriction) {
      return {};
    }
    const grouped = new Map<string, string[]>();
    for (const child of restriction.children) {
      const name = nodeLocalName(child);
      const value = child.attributes.value;
      if (value) {
        grouped.set(name, [...(grouped.get(name) ?? []), value]);
      }
    }
    return Object.fromEntries(
      [...grouped.entries()].map(([key, values]) => [key, values.length === 1 ? values[0] : values]),
    );
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
    };
  }
}
