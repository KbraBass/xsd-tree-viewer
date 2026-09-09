/**
 * Body markup of the preview page. Kept free of any `vscode` dependency so the
 * browser-based webview checks can render the real page structure instead of
 * duplicating it.
 */
export function previewBodyHtml(): string {
  return `  <header>
    <h1 id="title">XSD Tree Viewer</h1>
    <div class="namespace" id="namespace"></div>
    <div class="toolbar">
      <input id="filter" type="search" placeholder="Filter elements, types, and documentation">
      <button id="collapse-all" class="text-button" type="button">Collapse all</button>
      <span id="match-count" class="match-count"></span>
    </div>
    <div class="legend" aria-label="Cardinality legend">
      <span class="legend-label">Cardinality</span>
      <span class="cardinality req-one" title="Exactly one occurrence is required">[1..1]</span>
      <span class="cardinality opt-one" title="At most one occurrence, optional">[0..1]</span>
      <span class="cardinality req-many" title="At least one occurrence, repeatable">[1..*]</span>
      <span class="cardinality opt-many" title="Any number of occurrences, optional">[0..*]</span>
    </div>
  </header>
  <div class="layout">
    <div class="main-column">
      <section id="declarations" class="declarations" hidden></section>
      <main id="tree" class="tree" role="tree" aria-label="Schema tree"><div class="empty">Waiting for schema...</div></main>
    </div>
    <aside id="details-panel" class="details-panel"><div class="details-empty">Select a node to inspect its schema details.</div></aside>
  </div>`;
}
