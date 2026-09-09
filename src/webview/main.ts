interface SourceLocation {
  uri: string;
  line: number;
  column: number;
}

interface CctsInfo {
  componentType?: string;
  dictionaryEntryName?: string;
  definition?: string;
  cardinality?: string;
  objectClass?: string;
}

interface Node {
  id: string;
  kind: string;
  name?: string;
  namespace?: string;
  type?: string;
  minOccurs?: number;
  maxOccurs?: number | "unbounded";
  nillable?: boolean;
  fixed?: string;
  default?: string;
  documentation?: string;
  ccts?: CctsInfo;
  facets?: Record<string, string | string[]>;
  sourceLocation: SourceLocation;
  children: Node[];
  unresolvedRef?: string;
  recursion?: { cyclesBackToTypeId: string; targetNodeId?: string };
  firstOccurrenceId?: string;
  collapsed?: boolean;
  expandable?: boolean;
  childrenLoaded?: boolean;
}

interface Model {
  source: string;
  title: string;
  targetNamespace: string;
  namespacePrefixes: Record<string, string>;
  warnings: string[];
  roots: Node[];
}

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

const vscode = acquireVsCodeApi();
const title = document.getElementById("title") as HTMLElement;
const namespace = document.getElementById("namespace") as HTMLElement;
const filter = document.getElementById("filter") as HTMLInputElement;
const tree = document.getElementById("tree") as HTMLElement;
const detailsPanel = document.getElementById("details-panel") as HTMLElement;
let model: Model | undefined;
const expanded = new Set<string>();
let selectedId: string | undefined;
let focusedId: string | undefined;
const loadingExpansions = new Set<string>();

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[character] ?? character));
}

function cardinality(node: Node): string | undefined {
  if (node.minOccurs === undefined && node.maxOccurs === undefined) {
    return undefined;
  }
  return `[${node.minOccurs ?? 1}..${node.maxOccurs === "unbounded" ? "*" : node.maxOccurs ?? 1}]`;
}

function qualifiedName(node: Node): string {
  const name = node.kind === "attribute"
    ? `@${node.name ?? "attribute"}`
    : node.kind === "any"
      ? "*"
      : node.name ?? "(anonymous)";
  const prefix = node.namespace && model?.namespacePrefixes?.[node.namespace];
  return prefix && !name.startsWith("@") && name !== "*" ? `${prefix}:${name}` : name;
}

function matches(node: Node, query: string): boolean {
  if (!query) {
    return true;
  }
  const haystack = [
    node.name,
    node.type,
    node.documentation,
    node.ccts?.definition,
    node.ccts?.dictionaryEntryName,
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase()) || node.children.some((child) => matches(child, query));
}

function findPath(nodes: Node[], targetId: string, path: Node[] = []): Node[] | undefined {
  for (const node of nodes) {
    const nextPath = [...path, node];
    if (node.id === targetId) {
      return nextPath;
    }
    const nestedPath = findPath(node.children, targetId, nextPath);
    if (nestedPath) {
      return nestedPath;
    }
  }
  return undefined;
}

function xpath(path: Node[]): string {
  const segments = path
    .filter((node) => node.kind === "element" || node.kind === "attribute")
    .map((node) => node.kind === "attribute"
      ? `@${node.name ?? "attribute"}`
      : qualifiedName(node));
  return segments.length ? `/${segments.join("/")}` : "/";
}

function directAttributes(node: Node): Node[] {
  const attributes: Node[] = [];
  for (const child of node.children) {
    if (child.kind === "attribute") {
      attributes.push(child);
    } else if (["sequence", "choice", "all", "group", "attributeGroup"].includes(child.kind)) {
      attributes.push(...directAttributes(child));
    }
  }
  return attributes;
}

function findNode(nodes: Node[], targetId: string): Node | undefined {
  for (const node of nodes) {
    if (node.id === targetId) {
      return node;
    }
    const nested = findNode(node.children, targetId);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function isStructure(node: Node): boolean {
  return ["sequence", "choice", "all", "group", "attributeGroup"].includes(node.kind);
}

function isImplementationMarker(node: Node): boolean {
  return node.kind === "complexType" || node.kind === "simpleType";
}

function renderDetails(): void {
  if (!model || !selectedId) {
    detailsPanel.innerHTML = `<div class="details-empty">Select a node to inspect its schema details.</div>`;
    return;
  }
  const path = findPath(model.roots, selectedId);
  const node = findNode(model.roots, selectedId);
  if (!path || !node) {
    detailsPanel.innerHTML = `<div class="details-empty">Select a node to inspect its schema details.</div>`;
    return;
  }
  const entries = Object.entries({
    Kind: node.kind,
    Name: node.name,
    Type: node.type,
    Namespace: node.namespace,
    Cardinality: cardinality(node),
    Nillable: node.nillable ? "true" : undefined,
    Fixed: node.fixed,
    Default: node.default,
  }).filter((entry): entry is [string, string] => Boolean(entry[1]));
  const attributes = directAttributes(node);
  const attributeMarkup = attributes.length
    ? `<section class="detail-section"><h3>Attributes</h3><div class="attribute-list">${attributes.map((attribute) => `<div><strong>${escape(attribute.name ?? "attribute")}</strong><span>${escape(attribute.type ?? "")}${escape(cardinality(attribute) ?? "")}</span></div>`).join("")}</div></section>`
    : "";
  const cctsEntries = node.ccts
    ? Object.entries({
        "Component type": node.ccts.componentType,
        "Dictionary entry": node.ccts.dictionaryEntryName,
        "Definition": node.ccts.definition,
        "Cardinality": node.ccts.cardinality,
        "Object class": node.ccts.objectClass,
      }).filter((entry): entry is [string, string] => Boolean(entry[1]))
    : [];
  const cctsMarkup = cctsEntries.length
    ? `<section class="detail-section"><h3>CCTS</h3><div class="detail-table">${cctsEntries.map(([key, value]) => `<div><strong>${escape(key)}</strong><span>${escape(value)}</span></div>`).join("")}</div></section>`
    : "";
  const facetsMarkup = node.facets && Object.keys(node.facets).length
    ? `<section class="detail-section"><h3>Facets</h3><div class="facet-list">${Object.entries(node.facets).map(([key, value]) => `<div><strong>${escape(key)}</strong><span>${escape(Array.isArray(value) ? value.join(", ") : value)}</span></div>`).join("")}</div></section>`
    : "";
  detailsPanel.innerHTML = `
    <div class="details-heading"><span class="kind">${escape(node.kind)}</span><h2>${escape(node.name ?? node.type ?? "Anonymous node")}</h2></div>
    <section class="detail-section xpath-section">
      <h3>XPath</h3>
      <div class="xpath-value">${escape(xpath(path))}</div>
      <button class="copy-button" data-action="copy-xpath" data-xpath="${escape(xpath(path))}" title="Copy XPath">Copy XPath</button>
    </section>
    <section class="detail-section"><h3>Schema</h3><div class="detail-table">${entries.map(([key, value]) => `<div><strong>${escape(key)}</strong><span>${escape(value)}</span></div>`).join("")}</div></section>
    ${node.documentation ? `<section class="detail-section"><h3>Documentation</h3><p class="documentation">${escape(node.documentation)}</p></section>` : ""}
    ${attributeMarkup}
    ${cctsMarkup}
    ${facetsMarkup}
    <section class="detail-section source-section"><h3>Source</h3><div class="source-location">${escape(node.sourceLocation.uri)}:${node.sourceLocation.line + 1}:${node.sourceLocation.column + 1}</div><button class="icon-button" data-action="source" data-uri="${escape(node.sourceLocation.uri)}" data-line="${node.sourceLocation.line}" data-column="${node.sourceLocation.column}" title="Go to source" aria-label="Go to source">↗</button></section>`;
}

function row(node: Node): string {
  const displayName = qualifiedName(node);
  const labels = [
    `<span class="name ${node.kind === "attribute" ? "attribute-name" : ""}">${escape(displayName)}</span>`,
    cardinality(node) ? `<span class="cardinality">${escape(cardinality(node) ?? "")}</span>` : "",
    node.nillable ? `<span class="badge">nillable</span>` : "",
    node.fixed ? `<span class="badge">fixed=${escape(node.fixed)}</span>` : "",
    node.default ? `<span class="badge">default=${escape(node.default)}</span>` : "",
    node.unresolvedRef ? `<span class="unresolved">unresolved ${escape(node.unresolvedRef)}</span>` : "",
    node.recursion ? `<span class="recursive">↻ recursive</span>` : "",
    node.firstOccurrenceId ? `<span class="repeat-badge">↻</span>` : "",
  ];
  const sourceButton = `<button class="icon-button source-link" data-action="source" data-uri="${escape(node.sourceLocation.uri)}" data-line="${node.sourceLocation.line}" data-column="${node.sourceLocation.column}" title="Go to source" aria-label="Go to source">↗</button>`;
  const repeatButton = node.firstOccurrenceId
    ? `<button class="icon-button" data-action="jump" data-target="${escape(node.firstOccurrenceId)}" title="Show first full expansion" aria-label="Show first full expansion">↪</button>`
    : "";
  const recursionButton = node.recursion?.targetNodeId
    ? `<button class="icon-button" data-action="jump" data-target="${escape(node.recursion.targetNodeId)}" title="Jump to containing expansion" aria-label="Jump to containing expansion">↩</button>`
    : "";
  return `<span class="row">${labels.join("")}${repeatButton}${recursionButton}${sourceButton}</span>`;
}

function renderStructure(node: Node): string {
  const query = filter.value.trim();
  if (!matches(node, query)) {
    return "";
  }
  const children = node.children.map((child) => renderNode(child)).join("");
  return `<div class="structure-group" data-id="${escape(node.id)}">${children}</div>`;
}

function renderNode(node: Node, root = false): string {
  const query = filter.value.trim();
  if (!matches(node, query)) {
    return "";
  }
  if (isImplementationMarker(node)) {
    return node.children.map((child) => renderNode(child)).join("");
  }
  if (isStructure(node)) {
    return renderStructure(node);
  }
  const hasChildren = node.children.some((child) => matches(child, query)) || Boolean(node.expandable);
  const open = expanded.has(node.id) || query.length > 0;
  const selected = selectedId === node.id ? " selected" : "";
  if (!hasChildren) {
    return `<div class="node-item${root ? " root" : ""} leaf${selected}" data-id="${escape(node.id)}" role="treeitem" tabindex="-1">${row(node)}</div>`;
  }
  const children = open ? node.children.map((child) => renderNode(child)).join("") : "";
  const childMarkup = `<div class="node-children"${open ? " data-rendered=\"true\"" : ""}>${children}</div>`;
  return `<details class="node-item${root ? " root" : ""}${selected}" data-id="${escape(node.id)}" ${open ? "open" : ""}><summary role="treeitem" tabindex="-1" aria-expanded="${open}">${row(node)}</summary>${childMarkup}</details>`;
}

function focusableForNode(element: HTMLElement): HTMLElement {
  return element.matches("summary, .leaf") ? element : element.querySelector<HTMLElement>(":scope > summary") ?? element;
}

function focusableNodes(): HTMLElement[] {
  return Array.from(tree.querySelectorAll<HTMLElement>(".node-item > summary, .node-item.leaf"))
    .filter(isVisibleTreeElement);
}

function isVisibleTreeElement(element: HTMLElement): boolean {
  let ancestor = element.parentElement;
  while (ancestor && ancestor !== tree) {
    if (ancestor.tagName.toLowerCase() === "details" && !(ancestor as HTMLDetailsElement).open) {
      return element.tagName.toLowerCase() === "summary" && element.parentElement === ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return element.getClientRects().length > 0;
}

function updateTabStops(): void {
  const nodes = focusableNodes();
  nodes.forEach((element) => {
    element.tabIndex = element.dataset.id === (focusedId ?? selectedId) ? 0 : -1;
  });
  if (nodes.length && !nodes.some((element) => element.tabIndex === 0)) {
    nodes[0].tabIndex = 0;
    focusedId = nodes[0].closest<HTMLElement>("[data-id]")?.dataset.id;
  }
}

function focusNode(id: string): void {
  const element = Array.from(tree.querySelectorAll<HTMLElement>("[data-id]"))
    .find((candidate) => candidate.dataset.id === id);
  if (!element) {
    return;
  }
  focusedId = id;
  updateTabStops();
  focusableForNode(element).focus();
}

function detailsForNode(id: string): HTMLDetailsElement | undefined {
  const element = Array.from(tree.querySelectorAll<HTMLElement>("details[data-id]"))
    .find((candidate) => candidate.dataset.id === id);
  return element as HTMLDetailsElement | undefined;
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
    const node = model ? findNode(model.roots, id) : undefined;
    const children = details.querySelector<HTMLElement>(":scope > .node-children");
    if (node?.expandable && !node.childrenLoaded) {
      if (!loadingExpansions.has(id)) {
        loadingExpansions.add(id);
        vscode.postMessage({ type: "expandNode", id });
      }
    } else if (node && children && children.dataset.rendered !== "true") {
      children.innerHTML = node.children.map((child) => renderNode(child)).join("");
      children.dataset.rendered = "true";
    }
  } else {
    const summary = details.querySelector<HTMLElement>(":scope > summary");
    const active = document.activeElement;
    if (summary && active instanceof HTMLElement && active !== summary && details.contains(active)) {
      focusedId = id;
      summary.focus();
    }
    expanded.delete(id);
  }
  updateTabStops();
}

function applyExpansion(id: string, children: Node[]): void {
  const node = model ? findNode(model.roots, id) : undefined;
  if (!node) {
    return;
  }
  loadingExpansions.delete(id);
  node.children = children;
  node.childrenLoaded = true;
  node.expandable = false;
  const details = detailsForNode(id);
  const container = details?.querySelector<HTMLElement>(":scope > .node-children");
  if (details?.open && container) {
    container.innerHTML = children.map((child) => renderNode(child)).join("");
    container.dataset.rendered = "true";
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
  if (!target || !model) {
    return;
  }
  const id = target.dataset.id;
  if (!id) {
    return;
  }
  const details = detailsForNode(id);
  const node = findNode(model.roots, id);
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
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveTo(current + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveTo(current - 1);
  } else if (event.key === "Home") {
    event.preventDefault();
    moveTo(0);
  } else if (event.key === "End") {
    event.preventDefault();
    moveTo(visible.length - 1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    if (expandableDetails && !expandableDetails.open) {
      setNodeOpen(expandableDetails, true);
    } else {
      moveTo(current + 1);
    }
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (expandableDetails && expandableDetails.open) {
      setNodeOpen(expandableDetails, false);
    } else {
      const parent = parentFocusable(target);
      const parentId = parent?.closest<HTMLElement>("[data-id]")?.dataset.id;
      if (parentId) {
        focusNode(parentId);
      }
    }
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectNode(id);
    if (expandableDetails) {
      setNodeOpen(expandableDetails, !expandableDetails.open);
    }
  }
}

function render(): void {
  if (!model) {
    return;
  }
  title.textContent = model.title;
  namespace.textContent = model.targetNamespace ? `Target namespace: ${model.targetNamespace}` : "No target namespace";
  const warnings = model.warnings.map((warning) => `<div class="warning">${escape(warning)}</div>`).join("");
  const roots = model.roots.map((node) => renderNode(node, true)).join("");
  tree.innerHTML = `${warnings}${roots || '<div class="empty">No matching schema nodes.</div>'}`;
  updateTabStops();
  renderDetails();
}

function selectNode(id: string): void {
  selectedId = id;
  tree.querySelectorAll<HTMLElement>(".selected").forEach((element) => element.classList.remove("selected"));
  const selected = Array.from(tree.querySelectorAll<HTMLElement>("[data-id]")).find((element) => element.dataset.id === id);
  selected?.classList.add("selected");
  focusedId = id;
  updateTabStops();
  renderDetails();
}

function revealNode(id: string): void {
  if (!model) {
    return;
  }
  const path = findPath(model.roots, id);
  if (!path) {
    return;
  }
  path.forEach((node) => {
    if (node.children.length) {
      expanded.add(node.id);
    }
  });
  selectedId = id;
  render();
  window.requestAnimationFrame(() => {
    const target = Array.from(tree.querySelectorAll<HTMLElement>("[data-id]")).find((element) => element.dataset.id === id);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function handleButton(button: HTMLButtonElement): void {
  if (button.dataset.action === "jump") {
    const targetId = button.dataset.target;
    if (targetId) {
      revealNode(targetId);
    }
    return;
  }
  if (button.dataset.action === "copy-xpath") {
    const value = button.dataset.xpath;
    if (value) {
      vscode.postMessage({ type: "copyText", text: value });
      button.textContent = "Copied";
      window.setTimeout(() => { button.textContent = "Copy XPath"; }, 1200);
    }
    return;
  }
  if (button.dataset.action === "source") {
    vscode.postMessage({
      type: "openSource",
      uri: button.dataset.uri,
      line: Number(button.dataset.line ?? 0),
      column: Number(button.dataset.column ?? 0),
    });
  }
}

tree.addEventListener("toggle", (event) => {
  const target = event.target as HTMLDetailsElement;
  if (target.tagName.toLowerCase() !== "details") {
    return;
  }
  const id = target.dataset.id;
  if (!id) {
    return;
  }
  if (target.open) {
    setNodeOpen(target, true);
  } else {
    setNodeOpen(target, false);
  }
}, true);

tree.addEventListener("keydown", handleTreeKeydown);

tree.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest("button");
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
  handleButton(button as HTMLButtonElement);
});

detailsPanel.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest("button");
  if (!button) {
    return;
  }
  event.preventDefault();
  handleButton(button as HTMLButtonElement);
});

filter.addEventListener("input", render);
window.addEventListener("message", (event: MessageEvent<{ type: string; model?: Model; id?: string; children?: Node[] }>) => {
  if (event.data.type === "update" && event.data.model) {
    model = event.data.model;
    render();
  }
  if (event.data.type === "expanded" && event.data.id && event.data.children) {
    applyExpansion(event.data.id, event.data.children);
  }
});
vscode.postMessage({ type: "ready" });
