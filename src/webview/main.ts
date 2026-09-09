import type { PreviewModel, SchemaNode, SearchHit, SourceLocation } from "../model";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

type HostMessage =
  | { type: "update"; model: PreviewModel }
  | { type: "expanded"; id: string; children: SchemaNode[] }
  | { type: "searchResults"; query: string; hits: SearchHit[] }
  | { type: "revealSource"; uri: string; line: number };

const vscode = acquireVsCodeApi();
const titleElement = document.getElementById("title") as HTMLElement;
const namespaceElement = document.getElementById("namespace") as HTMLElement;
const filterInput = document.getElementById("filter") as HTMLInputElement;
const collapseAllButton = document.getElementById("collapse-all") as HTMLButtonElement;
const matchCountElement = document.getElementById("match-count") as HTMLElement;
const declarationsElement = document.getElementById("declarations") as HTMLElement;
const tree = document.getElementById("tree") as HTMLElement;
const detailsPanel = document.getElementById("details-panel") as HTMLElement;

let model: PreviewModel | undefined;
let selectedId: string | undefined;
let focusedId: string | undefined;
let query = "";
let searchDebounce: number | undefined;
let renderDebounce: number | undefined;

/** Nodes the reader opened, and nodes the reader explicitly closed. */
const expanded = new Set<string>();
const collapsedByUser = new Set<string>();
const loadingExpansions = new Set<string>();

/** Id indexes, so selection and path lookups stay O(1) on large schemas. */
const byId = new Map<string, SchemaNode>();
const parentOf = new Map<string, string>();
/** Per-render memo of "this subtree contains a filter match". */
const matchCache = new Map<string, boolean>();

/**
 * Publishes the sticky header's real height so the detail panel and
 * scroll-into-view offsets follow it when the toolbar wraps.
 */
function syncHeaderOffset(): void {
  const header = document.querySelector("header");
  if (!header) {
    return;
  }
  const height = Math.round(header.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--header-offset", `${height}px`);
}

const escapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => escapes[character] ?? character);
}

function indexSubtree(node: SchemaNode, parentId?: string): void {
  byId.set(node.id, node);
  if (parentId !== undefined) {
    parentOf.set(node.id, parentId);
  }
  for (const child of node.children) {
    indexSubtree(child, node.id);
  }
}

function findNode(id: string | undefined): SchemaNode | undefined {
  return id === undefined ? undefined : byId.get(id);
}

function findPath(id: string): SchemaNode[] | undefined {
  const node = byId.get(id);
  if (!node) {
    return undefined;
  }
  const path = [node];
  let currentId = id;
  for (;;) {
    const parentId = parentOf.get(currentId);
    const parent = parentId === undefined ? undefined : byId.get(parentId);
    if (!parent) {
      return path;
    }
    path.unshift(parent);
    currentId = parent.id;
  }
}

function cardinality(node: SchemaNode): string | undefined {
  if (node.minOccurs === undefined && node.maxOccurs === undefined) {
    return undefined;
  }
  const max = node.maxOccurs === "unbounded" ? "*" : node.maxOccurs ?? 1;
  return `[${node.minOccurs ?? 1}..${max}]`;
}

function isRepeatable(node: SchemaNode): boolean {
  return node.maxOccurs === "unbounded"
    || (typeof node.maxOccurs === "number" && node.maxOccurs > 1);
}

/** One of four buckets: required/optional crossed with single/repeatable. */
function cardinalityClass(node: SchemaNode): string {
  const required = (node.minOccurs ?? 1) > 0;
  if (required) {
    return isRepeatable(node) ? "req-many" : "req-one";
  }
  return isRepeatable(node) ? "opt-many" : "opt-one";
}

function cardinalityTitle(node: SchemaNode): string {
  const min = node.minOccurs ?? 1;
  const max = node.maxOccurs === "unbounded" ? "unbounded" : node.maxOccurs ?? 1;
  const shape = [
    min > 0 ? "required" : "optional",
    isRepeatable(node) ? "repeatable" : "single",
  ].join(", ");
  return `minOccurs=${min}, maxOccurs=${max} \u2014 ${shape}`;
}

function qualifiedName(node: SchemaNode): string {
  const name = node.kind === "attribute" || node.kind === "anyAttribute"
    ? `@${node.name ?? "attribute"}`
    : node.kind === "any"
      ? "*"
      : node.name ?? "(anonymous)";
  const prefix = node.namespace && model?.namespacePrefixes?.[node.namespace];
  return prefix && !name.startsWith("@") && name !== "*" ? `${prefix}:${name}` : name;
}

/** True when the node itself, or any descendant, matches the active filter. */
function matches(node: SchemaNode): boolean {
  if (!query) {
    return true;
  }
  const cached = matchCache.get(node.id);
  if (cached !== undefined) {
    return cached;
  }
  const haystack = [
    node.name,
    node.type,
    node.documentation,
    node.ccts?.definition,
    node.ccts?.dictionaryEntryName,
  ].filter(Boolean).join(" ").toLowerCase();
  const result = haystack.includes(query) || node.children.some((child) => matches(child));
  matchCache.set(node.id, result);
  return result;
}

function matchesSelf(node: SchemaNode): boolean {
  if (!query) {
    return false;
  }
  const haystack = [node.name, node.type, node.documentation].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(query);
}

function countMatches(nodes: SchemaNode[]): number {
  return nodes.reduce(
    (total, node) => total + (matchesSelf(node) ? 1 : 0) + countMatches(node.children),
    0,
  );
}

/** Structure particles that carry no information worth a tree row of their own. */
function isTransparentStructure(node: SchemaNode): boolean {
  return (node.kind === "sequence" || node.kind === "all")
    && (node.minOccurs ?? 1) === 1
    && (node.maxOccurs ?? 1) === 1;
}

/** Type nodes are an implementation detail — unless they stand in for a cycle or repeat. */
function isTransparentType(node: SchemaNode): boolean {
  return (node.kind === "complexType" || node.kind === "simpleType")
    && !node.recursion
    && !node.firstOccurrenceId
    && !node.collapsed;
}

function isStructureContainer(node: SchemaNode): boolean {
  return node.kind === "sequence" || node.kind === "choice" || node.kind === "all";
}

function directAttributes(node: SchemaNode): SchemaNode[] {
  const attributes: SchemaNode[] = [];
  for (const child of node.children) {
    if (child.kind === "attribute" || child.kind === "anyAttribute") {
      attributes.push(child);
    } else if (isStructureContainer(child) || child.kind === "group" || child.kind === "attributeGroup") {
      attributes.push(...directAttributes(child));
    }
  }
  return attributes;
}

function xpath(path: SchemaNode[]): string {
  const segments = path
    .filter((node) => node.kind === "element" || node.kind === "attribute")
    .map((node) => node.kind === "attribute" ? `@${node.name ?? "attribute"}` : qualifiedName(node));
  return segments.length ? `/${segments.join("/")}` : "/";
}

function definitionList(entries: [string, string][], className: string): string {
  return `<div class="${className}">${entries
    .map(([key, value]) => `<div><strong>${escape(key)}</strong><span>${escape(value)}</span></div>`)
    .join("")}</div>`;
}

function presentEntries(source: Record<string, string | undefined>): [string, string][] {
  return Object.entries(source).filter((entry): entry is [string, string] => Boolean(entry[1]));
}

function renderDetails(): void {
  const node = findNode(selectedId);
  const path = selectedId ? findPath(selectedId) : undefined;
  if (!node || !path) {
    detailsPanel.innerHTML = `<div class="details-empty">Select a node to inspect its schema details.</div>`;
    return;
  }
  const nodePath = xpath(path);
  const schemaEntries = presentEntries({
    Kind: node.kind,
    Name: node.name,
    Type: node.type,
    Namespace: node.namespace,
    Cardinality: cardinality(node),
    Nillable: node.nillable ? "true" : undefined,
    Abstract: node.abstract ? "true" : undefined,
    "Substitutes": node.substitutionGroup,
    Fixed: node.fixed,
    Default: node.default,
    Wildcard: node.wildcard
      ? `${node.wildcard.namespace ?? "##any"} (${node.wildcard.processContents ?? "strict"})`
      : undefined,
    Unresolved: node.unresolvedRef,
  });
  const attributes = directAttributes(node);
  const attributeMarkup = attributes.length
    ? `<section class="detail-section"><h3>Attributes</h3>${definitionList(
        attributes.map((attribute): [string, string] => [
          attribute.name ?? "attribute",
          `${attribute.type ?? ""}${cardinality(attribute) ?? ""}`,
        ]),
        "attribute-list",
      )}</section>`
    : "";
  const cctsEntries = node.ccts
    ? presentEntries({
        "Component type": node.ccts.componentType,
        "Dictionary entry": node.ccts.dictionaryEntryName,
        Definition: node.ccts.definition,
        Cardinality: node.ccts.cardinality,
        "Object class": node.ccts.objectClass,
        "Property term": node.ccts.propertyTerm,
        "Representation": node.ccts.representationTerm,
        "Data type": node.ccts.dataType,
        Examples: node.ccts.examples,
      })
    : [];
  const cctsMarkup = cctsEntries.length
    ? `<section class="detail-section"><h3>CCTS</h3>${definitionList(cctsEntries, "detail-table")}</section>`
    : "";
  const facetEntries: [string, string][] = Object.entries(node.facets ?? {})
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]);
  const facetsMarkup = facetEntries.length
    ? `<section class="detail-section"><h3>Facets</h3>${definitionList(facetEntries, "facet-list")}</section>`
    : "";
  detailsPanel.innerHTML = `
    <div class="details-heading"><span class="kind">${escape(node.kind)}</span><h2>${escape(node.name ?? node.type ?? "Anonymous node")}</h2></div>
    <section class="detail-section xpath-section">
      <h3>XPath</h3>
      <div class="xpath-value">${escape(nodePath)}</div>
      <button class="copy-button" data-action="copy-xpath" data-xpath="${escape(nodePath)}" title="Copy XPath">Copy XPath</button>
    </section>
    <section class="detail-section"><h3>Schema</h3>${definitionList(schemaEntries, "detail-table")}</section>
    ${node.documentation ? `<section class="detail-section"><h3>Documentation</h3><p class="documentation">${escape(node.documentation)}</p></section>` : ""}
    ${attributeMarkup}
    ${cctsMarkup}
    ${facetsMarkup}
    <section class="detail-section source-section"><h3>Source</h3><div class="source-location">${escape(node.sourceLocation.uri)}:${node.sourceLocation.line + 1}:${node.sourceLocation.column + 1}</div><button class="icon-button" data-action="source" data-uri="${escape(node.sourceLocation.uri)}" data-line="${node.sourceLocation.line}" data-column="${node.sourceLocation.column}" title="Go to source" aria-label="Go to source">&#8599;</button></section>`;
}

function sourceButton(location: SourceLocation, className = "icon-button source-link"): string {
  return `<button class="${className}" data-action="source" data-uri="${escape(location.uri)}" data-line="${location.line}" data-column="${location.column}" title="Go to source" aria-label="Go to source">&#8599;</button>`;
}

function row(node: SchemaNode): string {
  const stub = node.recursion
    ? `<span class="stub-note">recursive reference to ${escape(node.name ?? "type")} &mdash; expand for one more level</span>`
    : node.firstOccurrenceId
      ? `<span class="stub-note">same structure as ${escape(node.name ?? "type")} above</span>`
      : "";
  const labels = [
    `<span class="name${node.kind === "attribute" || node.kind === "anyAttribute" ? " attribute-name" : ""}">${escape(qualifiedName(node))}</span>`,
    node.type && node.type !== node.name ? `<span class="type-name">${escape(node.type)}</span>` : "",
    cardinality(node)
      ? `<span class="cardinality ${cardinalityClass(node)}" title="${escape(cardinalityTitle(node))}">${escape(cardinality(node) ?? "")}</span>`
      : "",
    node.kind === "choice" ? `<span class="badge">choice</span>` : "",
    node.nillable ? `<span class="badge">nillable</span>` : "",
    node.abstract ? `<span class="badge">abstract</span>` : "",
    node.substitutionGroup ? `<span class="badge">substitutes ${escape(node.substitutionGroup)}</span>` : "",
    node.wildcard ? `<span class="badge">${escape(node.wildcard.namespace ?? "##any")}</span>` : "",
    node.fixed ? `<span class="badge">fixed=${escape(node.fixed)}</span>` : "",
    node.default ? `<span class="badge">default=${escape(node.default)}</span>` : "",
    node.unresolvedRef ? `<span class="unresolved">unresolved ${escape(node.unresolvedRef)}</span>` : "",
    node.recursion ? `<span class="recursive">&#8635;</span>` : "",
    node.firstOccurrenceId ? `<span class="repeat-badge">&#8635;</span>` : "",
    stub,
  ];
  const jumpTarget = node.firstOccurrenceId ?? node.recursion?.targetNodeId;
  const jumpButton = jumpTarget
    ? `<button class="icon-button" data-action="jump" data-target="${escape(jumpTarget)}" title="Jump to first full expansion" aria-label="Jump to first full expansion">&#8618;</button>`
    : "";
  return `<span class="row">${labels.join("")}${jumpButton}${sourceButton(node.sourceLocation)}</span>`;
}

function shouldAutoOpen(node: SchemaNode, depth: number): boolean {
  if (node.collapsed || node.childrenLoaded === false) {
    return false;
  }
  return depth < (model?.autoCollapseDepth ?? 3);
}

function renderNode(node: SchemaNode, depth: number, root = false): string {
  if (!matches(node)) {
    return "";
  }
  if (!root && (isTransparentType(node) || (isTransparentStructure(node) && node.children.length > 0))) {
    const children = node.children.map((child) => renderNode(child, depth)).join("");
    return isTransparentType(node)
      ? children
      : `<div class="structure-group" role="group" data-id="${escape(node.id)}">${children}</div>`;
  }
  const renderedChildren = node.children.filter((child) => matches(child));
  const hasChildren = renderedChildren.length > 0 || Boolean(node.expandable);
  const selected = selectedId === node.id ? " selected" : "";
  const classes = `node-item kind-${node.kind}${root ? " root" : ""}${selected}`;
  if (!hasChildren) {
    return `<div class="${classes} leaf" data-id="${escape(node.id)}" role="treeitem" tabindex="-1">${row(node)}</div>`;
  }
  const open = query
    ? renderedChildren.length > 0
    : expanded.has(node.id) || (shouldAutoOpen(node, depth) && !collapsedByUser.has(node.id));
  const children = open ? renderedChildren.map((child) => renderNode(child, depth + 1)).join("") : "";
  const childMarkup = `<div class="node-children"${open ? ' data-rendered="true"' : ""}>${children}</div>`;
  return `<details class="${classes}" data-id="${escape(node.id)}"${open ? " open" : ""}><summary role="treeitem" tabindex="-1" aria-expanded="${open}">${row(node)}</summary>${childMarkup}</details>`;
}

function focusableForNode(element: HTMLElement): HTMLElement {
  return element.matches("summary, .leaf")
    ? element
    : element.querySelector<HTMLElement>(":scope > summary") ?? element;
}

function elementForNode(id: string): HTMLElement | undefined {
  return tree.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) ?? undefined;
}

function detailsForNode(id: string): HTMLDetailsElement | undefined {
  const element = elementForNode(id);
  return element instanceof HTMLDetailsElement ? element : undefined;
}

function isVisibleTreeElement(element: HTMLElement): boolean {
  let ancestor = element.parentElement;
  while (ancestor && ancestor !== tree) {
    if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
      return element.tagName.toLowerCase() === "summary" && element.parentElement === ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return element.getClientRects().length > 0;
}

function focusableNodes(): HTMLElement[] {
  return Array.from(tree.querySelectorAll<HTMLElement>(".node-item > summary, .node-item.leaf"))
    .filter(isVisibleTreeElement);
}

function updateTabStops(): void {
  const nodes = focusableNodes();
  const active = focusedId ?? selectedId;
  for (const element of nodes) {
    const id = element.closest<HTMLElement>("[data-id]")?.dataset.id;
    element.tabIndex = id === active ? 0 : -1;
  }
  if (nodes.length && !nodes.some((element) => element.tabIndex === 0)) {
    nodes[0].tabIndex = 0;
    focusedId = nodes[0].closest<HTMLElement>("[data-id]")?.dataset.id;
  }
}

function focusNode(id: string): void {
  const element = elementForNode(id);
  if (!element) {
    return;
  }
  focusedId = id;
  updateTabStops();
  focusableForNode(element).focus();
}

function setNodeOpen(details: HTMLDetailsElement, open: boolean): void {
  const id = details.dataset.id;
  if (!id) {
    return;
  }
  details.open = open;
  details.querySelector<HTMLElement>(":scope > summary")?.setAttribute("aria-expanded", String(open));
  if (open) {
    expanded.add(id);
    collapsedByUser.delete(id);
    const node = findNode(id);
    const children = details.querySelector<HTMLElement>(":scope > .node-children");
    if (node?.expandable && node.childrenLoaded === false) {
      if (!loadingExpansions.has(id)) {
        loadingExpansions.add(id);
        vscode.postMessage({ type: "expandNode", id });
      }
    } else if (node && children && children.dataset.rendered !== "true") {
      children.innerHTML = node.children
        .filter((child) => matches(child))
        .map((child) => renderNode(child, depthOf(id) + 1))
        .join("");
      children.dataset.rendered = "true";
      updateAncestorTrail();
    }
  } else {
    expanded.delete(id);
    collapsedByUser.add(id);
    const summary = details.querySelector<HTMLElement>(":scope > summary");
    const active = document.activeElement;
    if (summary && active instanceof HTMLElement && active !== summary && details.contains(active)) {
      focusedId = id;
      summary.focus();
    }
  }
  updateTabStops();
}

/** Collapse depth of a node, counting only rows that render a level of their own. */
function depthOf(id: string): number {
  const path = findPath(id);
  if (!path) {
    return 0;
  }
  return path.slice(0, -1).filter((node) => !isTransparentType(node) && !isTransparentStructure(node)).length;
}

function applyExpansion(id: string, children: SchemaNode[]): void {
  loadingExpansions.delete(id);
  const node = findNode(id);
  if (!node) {
    return;
  }
  node.children = children;
  node.childrenLoaded = true;
  for (const child of children) {
    indexSubtree(child, id);
  }
  const details = detailsForNode(id);
  const container = details?.querySelector<HTMLElement>(":scope > .node-children");
  if (details?.open && container) {
    container.innerHTML = children
      .filter((child) => matches(child))
      .map((child) => renderNode(child, depthOf(id) + 1))
      .join("");
    container.dataset.rendered = "true";
    updateAncestorTrail();
  }
  updateTabStops();
}

function parentFocusable(element: HTMLElement): HTMLElement | undefined {
  const current = element.closest<HTMLElement>(".node-item");
  const parent = current?.parentElement?.closest<HTMLElement>(".node-item");
  return parent ? focusableForNode(parent) : undefined;
}

function handleTreeKeydown(event: KeyboardEvent): void {
  if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLInputElement) {
    return;
  }
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-id]");
  const id = target?.dataset.id;
  if (!target || !id || !model) {
    return;
  }
  const details = detailsForNode(id);
  const node = findNode(id);
  const expandableDetails = node && (node.expandable || node.children.length) && details ? details : undefined;
  const visible = focusableNodes();
  const current = visible.indexOf(focusableForNode(target));
  const moveTo = (index: number): void => {
    const next = visible[Math.max(0, Math.min(visible.length - 1, index))];
    const nextId = next?.closest<HTMLElement>("[data-id]")?.dataset.id;
    if (nextId) {
      focusNode(nextId);
    }
  };
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      moveTo(current + 1);
      return;
    case "ArrowUp":
      event.preventDefault();
      moveTo(current - 1);
      return;
    case "Home":
      event.preventDefault();
      moveTo(0);
      return;
    case "End":
      event.preventDefault();
      moveTo(visible.length - 1);
      return;
    case "ArrowRight":
      event.preventDefault();
      if (expandableDetails && !expandableDetails.open) {
        setNodeOpen(expandableDetails, true);
      } else {
        moveTo(current + 1);
      }
      return;
    case "ArrowLeft": {
      event.preventDefault();
      if (expandableDetails?.open) {
        setNodeOpen(expandableDetails, false);
        return;
      }
      const parentId = parentFocusable(target)?.closest<HTMLElement>("[data-id]")?.dataset.id;
      if (parentId) {
        focusNode(parentId);
      }
      return;
    }
    case "Enter":
    case " ":
      event.preventDefault();
      selectNode(id);
      if (expandableDetails) {
        setNodeOpen(expandableDetails, !expandableDetails.open);
      }
      return;
    default:
      return;
  }
}

function renderMatchCount(): void {
  if (!query || !model) {
    matchCountElement.textContent = "";
    return;
  }
  const total = countMatches(model.roots);
  matchCountElement.textContent = total === 1 ? "1 match in tree" : `${total} matches in tree`;
}

function render(): void {
  if (!model) {
    return;
  }
  const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
  const previouslyFocused = document.activeElement instanceof HTMLElement
    && tree.contains(document.activeElement);
  matchCache.clear();
  titleElement.textContent = model.title;
  namespaceElement.textContent = model.targetNamespace
    ? `Target namespace: ${model.targetNamespace}`
    : "No target namespace";
  const warnings = model.warnings
    .map((warning) => `<div class="warning">${escape(warning)}</div>`)
    .join("");
  const roots = model.roots.map((node) => renderNode(node, 0, true)).join("");
  tree.innerHTML = `${warnings}${roots || '<div class="empty">No matching schema nodes.</div>'}`;
  updateAncestorTrail();
  renderMatchCount();
  updateTabStops();
  renderDetails();
  document.documentElement.scrollTop = scrollTop;
  document.body.scrollTop = scrollTop;
  if (previouslyFocused && focusedId) {
    const element = elementForNode(focusedId);
    if (element) {
      focusableForNode(element).focus({ preventScroll: true });
    }
  }
}

/**
 * Marks the selected node's ancestors so their indent guides stand out,
 * letting the reader trace a deep row back to its root. CSS handles the
 * selected node's own children guide.
 */
function updateAncestorTrail(): void {
  for (const element of tree.querySelectorAll<HTMLElement>(".trail")) {
    element.classList.remove("trail");
  }
  const selected = selectedId ? elementForNode(selectedId) : undefined;
  if (!selected) {
    return;
  }
  // Only `.node-item` draws a guide; a transparent structure group has none.
  let ancestor = selected.parentElement?.closest<HTMLElement>(".node-item");
  while (ancestor && tree.contains(ancestor)) {
    ancestor.classList.add("trail");
    ancestor = ancestor.parentElement?.closest<HTMLElement>(".node-item");
  }
}

function selectNode(id: string): void {
  selectedId = id;
  for (const element of tree.querySelectorAll<HTMLElement>(".selected")) {
    element.classList.remove("selected");
  }
  elementForNode(id)?.classList.add("selected");
  updateAncestorTrail();
  focusedId = id;
  updateTabStops();
  renderDetails();
  const node = findNode(id);
  if (node) {
    vscode.postMessage({
      type: "selection",
      id,
      uri: node.sourceLocation.uri,
      line: node.sourceLocation.line,
      column: node.sourceLocation.column,
    });
  }
}

function revealNode(id: string): void {
  const path = findPath(id);
  if (!path) {
    return;
  }
  for (const node of path.slice(0, -1)) {
    expanded.add(node.id);
    collapsedByUser.delete(node.id);
  }
  selectedId = id;
  render();
  window.requestAnimationFrame(() => {
    elementForNode(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

/** Selects the tree node declared closest to (and at or before) a source line. */
function revealSourceLine(uri: string, line: number): void {
  let best: SchemaNode | undefined;
  for (const node of byId.values()) {
    if (node.sourceLocation.uri !== uri || node.sourceLocation.line > line) {
      continue;
    }
    if (!best || node.sourceLocation.line > best.sourceLocation.line) {
      best = node;
    }
  }
  if (best) {
    revealNode(best.id);
    selectNode(best.id);
  }
}

function renderDeclarations(hits: SearchHit[]): void {
  if (!hits.length) {
    declarationsElement.hidden = true;
    declarationsElement.innerHTML = "";
    return;
  }
  declarationsElement.hidden = false;
  declarationsElement.innerHTML = `<h2>Matching declarations</h2><ul>${hits
    .map((hit) => `<li><span class="name">${escape(hit.name)}</span><span class="type-name">${escape(hit.kind)}</span>${sourceButton(hit.sourceLocation, "icon-button")}${hit.documentation ? `<span class="documentation">${escape(hit.documentation.slice(0, 120))}</span>` : ""}</li>`)
    .join("")}</ul>`;
}

function handleButton(button: HTMLButtonElement): void {
  const action = button.dataset.action;
  if (action === "jump" && button.dataset.target) {
    revealNode(button.dataset.target);
    return;
  }
  if (action === "copy-xpath" && button.dataset.xpath) {
    vscode.postMessage({ type: "copyText", text: button.dataset.xpath });
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = "Copy XPath"; }, 1200);
    return;
  }
  if (action === "source") {
    vscode.postMessage({
      type: "openSource",
      uri: button.dataset.uri,
      line: Number(button.dataset.line ?? 0),
      column: Number(button.dataset.column ?? 0),
    });
  }
}

tree.addEventListener("toggle", (event) => {
  const target = event.target;
  if (target instanceof HTMLDetailsElement && target.dataset.id) {
    setNodeOpen(target, target.open);
  }
}, true);

tree.addEventListener("keydown", handleTreeKeydown);

tree.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>("button");
  const nodeElement = target.closest<HTMLElement>("[data-id]");
  if (nodeElement?.dataset.id && !button) {
    selectNode(nodeElement.dataset.id);
    return;
  }
  if (!button) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (nodeElement?.dataset.id) {
    selectNode(nodeElement.dataset.id);
  }
  handleButton(button);
});

for (const container of [detailsPanel, declarationsElement]) {
  container.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!button) {
      return;
    }
    event.preventDefault();
    handleButton(button);
  });
}

collapseAllButton.addEventListener("click", () => {
  expanded.clear();
  collapsedByUser.clear();
  for (const node of byId.values()) {
    if (node.children.length || node.expandable) {
      collapsedByUser.add(node.id);
    }
  }
  render();
});

filterInput.addEventListener("input", () => {
  query = filterInput.value.trim().toLowerCase();
  // Re-rendering is debounced so typing stays responsive on schemas with
  // thousands of nodes.
  if (renderDebounce !== undefined) {
    window.clearTimeout(renderDebounce);
  }
  renderDebounce = window.setTimeout(render, 120);
  if (searchDebounce !== undefined) {
    window.clearTimeout(searchDebounce);
  }
  // Declaration search runs in the extension host, so it also finds nodes that
  // have not been lazily expanded into the tree yet.
  searchDebounce = window.setTimeout(() => {
    if (query.length >= 2) {
      vscode.postMessage({ type: "search", query });
    } else {
      renderDeclarations([]);
    }
  }, 200);
});

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === "update") {
    model = message.model;
    byId.clear();
    parentOf.clear();
    for (const root of model.roots) {
      indexSubtree(root);
    }
    loadingExpansions.clear();
    render();
    return;
  }
  if (message.type === "expanded") {
    applyExpansion(message.id, message.children);
    return;
  }
  if (message.type === "searchResults") {
    if (message.query === query) {
      renderDeclarations(message.hits);
    }
    return;
  }
  if (message.type === "revealSource") {
    revealSourceLine(message.uri, message.line);
  }
});

syncHeaderOffset();
const header = document.querySelector("header");
if (header && typeof ResizeObserver !== "undefined") {
  new ResizeObserver(syncHeaderOffset).observe(header);
}

vscode.postMessage({ type: "ready" });
