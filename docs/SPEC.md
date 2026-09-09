# XSD Tree Viewer — Specification

## 1. Overview
A Visual Studio Code extension that parses XML Schema (`.xsd`) files and
renders their structure (elements, attributes, complex/simple types, groups)
as a rich, read-only **preview panel** — the same interaction model as VS
Code's built-in Markdown preview (`Open Preview` / `Open Preview to the
Side`, live-updating as the source file changes), rather than a sidebar tree
view.

The preview shows a collapsible element tree annotated with cardinality,
type, namespace, and documentation, and is specifically designed to stay
readable on large, deeply-nested, highly cross-referenced schemas such as
OASIS UBL, where naive recursive rendering would blow up in size or loop
forever.

## 2. Goals
- Let a developer open a `.xsd` file and run "Open XSD Preview" to see a
  readable, rich tree of its element/type hierarchy, instead of raw
  angle-bracket XML.
- Live-update the preview as the underlying file changes (like Markdown
  preview), debounced, without losing the reader's expand/collapse state.
- Resolve `xs:element ref="..."`, `xs:type="..."`, `xs:group ref="..."`,
  `xs:attributeGroup ref="..."`, and `xs:import`/`xs:include` across files so
  the tree reflects the *effective* schema, not just the single file's
  syntax.
- Show rich per-node information: cardinality (`minOccurs`/`maxOccurs`),
  resolved type + namespace prefix, `nillable`/`fixed`/`default`, facets
  (enumerations, patterns, length, etc.), and human documentation pulled from
  `xs:annotation/xs:documentation` (including structured UBL/CCTS
  documentation such as `ccts:DictionaryEntryName`, `ccts:Definition`,
  `ccts:Cardinality`, `ccts:ObjectClass`).
- **Render recursive and heavily-reused structures intelligently**: detect
  direct and indirect type cycles and stop auto-expanding them; detect
  frequently-repeated subtrees (the same global element/type reused dozens of
  times, as is typical in UBL) and collapse them by default past a
  configurable depth, so the initial render stays a manageable size and the
  user opts into deeper expansion.
- Click-to-navigate: clicking a node jumps the source editor to the matching
  declaration.
- Handle real-world large schemas (UBL common-components files run to
  ~55,000 lines / many thousands of declarations) without freezing the UI.

## 3. Non-Goals (v1)
- Editing/authoring the XSD via the preview (strictly view-only, like
  Markdown preview).
- Full XSD 1.1 assertion/conditional-type validation.
- Validating XML instance documents against the schema (possible v2 feature).
- A free-form visual diagram/canvas (boxes-and-lines, drag-to-arrange); v1 is
  a structured, collapsible outline rendered in a webview, not a graph
  layout tool.
- Scroll-sync between source and preview (may be considered post-v1; the
  tree's node order doesn't map 1:1 to source line order once refs/imports
  are resolved and reused subtrees are deduplicated).

## 4. Target Users
Integration/backend developers and API designers who work with XSD-based
contracts (e.g., SOAP/WSDL, EDI-to-XML, B2B schemas such as UBL/PEPPOL) and
need to quickly understand or review deeply nested schemas without switching
to an external XML IDE.

## 5. Key Features

### 5.1 Preview Panel (webview)
- Command "XSD Tree Viewer: Open Preview" (mirrors Markdown's
  `markdown.showPreview`) and "...Open Preview to the Side"
  (`markdown.showPreviewToSide`), plus a preview icon in the editor
  title bar when a `.xsd` file is active.
- Renders in a VS Code Webview panel styled with the active color theme
  (using VS Code theme CSS variables / codicons), not a plain browser page.
- Auto-refreshes on document save and on debounced in-editor edits, similar
  to Markdown preview's live update; expand/collapse state and scroll
  position are preserved across refreshes (diff-patch the rendered tree
  rather than fully re-rendering/re-mounting).
- One preview panel per source document (re-focuses existing panel if
  already open for that file, again mirroring Markdown preview behavior).

### 5.2 Rich Node Rendering
Each tree row shows, inline:
- Name, kind icon (element / attribute / complexType / simpleType / group /
  choice / sequence / any / attributeGroup), and resolved type with
  namespace prefix (e.g. `cbc:IdentifierType`).
- Cardinality badge, e.g. `[0..1]`, `[1..1]`, `[0..*]`, using UBL-familiar
  `minOccurs..maxOccurs` notation; visually distinct styling for optional vs.
  required vs. repeatable.
- `nillable`, `fixed`, `default` flags shown as small badges when present.
- Facets (enumeration values, pattern, min/maxLength, min/maxInclusive, etc.)
  shown in an expandable "facets" sub-row rather than inline text, to avoid
  cluttering large enumerations.
- Documentation: plain `xs:documentation` text is shown directly; structured
  `ccts:Component` documentation (as used throughout UBL) is parsed into a
  small definition table (Dictionary Entry Name, Definition, Cardinality,
  Object Class, etc.) rendered on expand/hover rather than inline, since UBL
  repeats this block on nearly every element.
- A node detail side panel (or expandable inline panel) shows the full
  resolved path (e.g. `Invoice / cac:InvoiceLine / cac:Item /
  cac:ClassifiedTaxCategory / cac:TaxScheme`), namespace, and source file +
  line, with a "Go to definition" action.

### 5.3 Smart Recursive & Repeated-Structure Rendering
This is the feature most exercised by real-world schemas like UBL, and is
treated as a first-class design concern, not an edge case:

- **Cycle detection**: while expanding a subtree, the renderer tracks the
  chain of *type identities* (not just element names) from the root to the
  current node. If a node's resolved type already appears in its own
  ancestor chain (direct recursion, e.g. a clause type containing itself, or
  indirect recursion through several intermediate types, e.g. UBL's
  `Shipment`/`TransportHandlingUnit`-style nesting), rendering stops at that
  node: it is shown as a terminal "↻ recursive reference to `TypeName`"
  placeholder with a button to expand **one more level on demand** (tracked
  per node instance, not globally), instead of recursing until a depth limit
  or crashing the webview.
- **Repeated-subtree collapsing**: independent of recursion, the same
  global element/type is commonly reused dozens of times across a schema
  (e.g. `cac:Party`, `cac:Address`, `cac:TaxCategory` in UBL). Subtrees for
  types that have already been fully rendered once earlier in the same
  preview are, by default, collapsed to a single line with a "(same
  structure as `cac:Party` above — click to expand)" affordance and a jump
  link to the first full expansion, rather than being re-rendered in full
  every time. This is a rendering/display optimization only — it does not
  change the underlying resolved model, and any instance can still be
  expanded independently if its content differs (e.g. different
  cardinality/annotation at that usage site).
- **Depth-based auto-collapse**: nodes beyond a configurable depth
  (`xsdTreeViewer.autoCollapseDepth`, default 3) render collapsed by default;
  the user expands on demand. This bounds the initial DOM size on schemas
  with thousands of declarations.
- Together these three rules guarantee the initial render is always finite
  and bounded in size, even for pathological or accidentally-cyclic schemas.

### 5.4 Navigation
- Clicking a node's "go to source" action reveals and positions the cursor
  on the exact declaration in the source `.xsd` (or, for resolved `ref`
  nodes, the file where the referenced element/type is actually declared,
  which may be a different imported file).
- "Reveal in Preview" command from the editor context menu / cursor
  position, to jump from source back to the corresponding preview node.

### 5.5 Search / Filter
- Filter box docked at the top of the preview; fuzzy-matches element/type
  names and auto-expands (bypassing the collapse rules above) just enough of
  the tree to show matching nodes in context, then restores prior
  collapse state when the filter is cleared.

### 5.6 Cross-file Resolution
- Follows `xs:import`, `xs:include`, `xs:redefine`.
- Resolves `ref` and `type` attributes to their declarations, including in
  other files; unresolved references are shown with a distinct
  "unresolved" badge and tooltip rather than failing silently or omitting
  the node.

### 5.7 Performance
- Parsing/resolution happens in the extension host; the webview only
  receives an already-resolved, already-cycle-broken node model plus lazily
  requested subtrees for on-demand expansion (message-passing between
  extension and webview, not a monolithic upfront tree).
- Target: schemas up to ~10 MB / tens of thousands of declarations (i.e.,
  UBL-scale common-components files) open and become interactive within a
  few seconds, and expanding any individual collapsed node responds in well
  under 100 ms.

## 6. Non-Functional Requirements
- Works on VS Code Desktop and (best-effort) VS Code Web / github.dev
  (webview APIs are compatible; file resolution for imports/includes must
  work against the VS Code virtual filesystem, not `node:fs` directly).
- No network calls required for core functionality (fully offline).
- No telemetry beyond what VS Code's own extension telemetry conventions
  allow (opt-in only, if added at all).

## 7. Architecture

```
xsd-tree-viewer/
├── src/
│   ├── extension.ts              # activation, command/panel registration
│   ├── parser/
│   │   ├── xsdParser.ts          # XML -> AST (elements, types, groups, refs)
│   │   ├── schemaResolver.ts     # resolves imports/includes, ref/type lookups
│   │   ├── cctsAnnotations.ts    # parses ccts:Component-style documentation
│   │   └── model.ts              # typed schema object model (SchemaNode, etc.)
│   ├── render/
│   │   ├── recursionGuard.ts     # ancestor type-chain cycle detection
│   │   ├── repeatTracker.ts      # "already rendered once" collapse logic
│   │   └── nodeSerializer.ts     # SchemaNode -> webview message payload
│   ├── preview/
│   │   ├── previewManager.ts     # one panel per document, lifecycle, refresh
│   │   └── webview/
│   │       ├── main.ts           # webview-side rendering, expand/collapse, filter
│   │       └── main.css          # themed via VS Code CSS variables
│   ├── commands/
│   │   ├── openPreview.ts
│   │   ├── openPreviewToSide.ts
│   │   ├── revealInPreview.ts
│   │   └── goToDefinition.ts
│   └── util/
├── test/
│   ├── fixtures/                 # small synthetic schemas for fast unit tests:
│   │   ├── simple.xsd            #   flat element/attribute schema
│   │   ├── nested-complex-type.xsd
│   │   ├── ref-resolution/       #   multi-file element/type refs
│   │   ├── import-include/       #   multi-file xs:import / xs:include chains
│   │   ├── direct-recursion.xsd  #   type containing itself
│   │   ├── indirect-recursion.xsd#   A -> B -> C -> A cycle
│   │   ├── repeated-subtree.xsd  #   same global type reused N times
│   │   └── malformed.xsd         #   invalid XML, must fail gracefully
│   └── *.test.ts
├── docs/
│   └── SPEC.md
├── package.json                   # VS Code extension manifest (commands, menus)
└── README.md
```

### 7.1 Tech Stack
- Language: TypeScript, on both the extension-host and webview sides.
- XML parsing: a streaming/DOM XML parser (e.g., `fast-xml-parser` or `sax`)
  with line/column position tracking, chosen for license compatibility and
  no native dependencies (keeps the extension portable to VS Code Web).
- Webview UI: no framework dependency required for v1 — a small
  vanilla-TS renderer using `<details>/<summary>`-style collapsible rows and
  VS Code's `@vscode/webview-ui-toolkit` / codicons for visual consistency.
  (A framework such as Preact/Lit may be introduced later if the vanilla
  approach becomes hard to maintain — not a v1 requirement.)
- Build: esbuild (fast, standard for VS Code extensions; separate bundles
  for extension host and webview).
- Test: Mocha/Jest for pure parser/resolver/recursion-guard unit tests, plus
  `@vscode/test-electron` for integration tests that open a real preview
  panel.

### 7.2 Data Model (sketch)
```ts
interface SchemaNode {
  id: string;              // stable id: resolved-type + usage-site path hash
  kind: 'element' | 'attribute' | 'complexType' | 'simpleType' | 'group'
      | 'attributeGroup' | 'sequence' | 'choice' | 'any';
  name?: string;
  namespace?: string;
  type?: string;                          // resolved type name, if any
  minOccurs?: number;
  maxOccurs?: number | 'unbounded';
  nillable?: boolean;
  fixed?: string;
  default?: string;
  documentation?: string;                 // plain xs:documentation text
  ccts?: CctsComponentInfo;               // parsed ccts:Component block, if present
  facets?: Record<string, string | string[]>;
  sourceLocation: { uri: string; line: number; column: number };
  children: SchemaNode[];
  unresolvedRef?: string;    // set when a ref/type could not be resolved

  // Rendering hints computed by the render layer, not the parser:
  recursion?: { cyclesBackToTypeId: string };   // present => render as stub
  firstOccurrenceId?: string;                   // present => "same as above"
}

interface CctsComponentInfo {
  componentType?: string;      // ABIE / BBIE / ASBIE
  dictionaryEntryName?: string;
  definition?: string;
  cardinality?: string;
  objectClass?: string;
}
```

### 7.3 Recursion & Repetition Algorithm (summary)
1. Resolve the full model as usual (refs/imports followed), but resolution
   itself is memoized per resolved-type-id — it never recurses into a type
   that is already on the current resolution stack; it instead returns a
   lightweight "cycle" marker node referencing that type id.
2. At render time, `recursionGuard` walks the ancestor chain for the node
   about to be expanded; if the node's type id is already an ancestor, it
   renders the terminal recursive-reference stub described in §5.3 instead
   of expanding further, with an affordance to expand one more level.
3. `repeatTracker` keeps a per-preview-session map of type id → first node
   id where it was fully expanded. Subsequent occurrences of the same type
   id render collapsed with a link to that first occurrence, unless the
   user explicitly expands that instance.
4. Both guards are advisory to the *renderer* only; the underlying resolved
   model always has the real structure available, so "expand anyway" always
   works on demand.

## 8. Commands & Contribution Points (package.json)
- `xsdTreeViewer.openPreview` — "XSD Tree Viewer: Open Preview"
- `xsdTreeViewer.openPreviewToSide` — "XSD Tree Viewer: Open Preview to the Side"
- `xsdTreeViewer.revealInPreview`
- `xsdTreeViewer.goToDefinition`
- Editor title-bar preview icon, shown when `resourceExtname == .xsd`
  (mirrors `markdown.extension.editing`'s preview button placement).
- Settings:
  - `xsdTreeViewer.autoCollapseDepth` (default `3`)
  - `xsdTreeViewer.collapseRepeatedSubtrees` (default `true`)
  - `xsdTreeViewer.parseCctsAnnotations` (default `true`)

## 9. Testing Corpus & Manual Validation
- **Automated unit/integration tests** use small, purpose-built synthetic
  fixtures under `test/fixtures/` (see §7 tree) that isolate one concern
  each (recursion, repetition, cross-file refs, malformed input) so tests
  stay fast and don't depend on external repositories.
- **Manual / performance validation** uses the real OASIS UBL 2.5 schemas
  from a local checkout of the OASIS distribution, i.e.
  `<ubl-2.5-checkout>/os-UBL-2.5/xsd/`:
  - `maindoc/UBL-Invoice-2.5.xsd` (~1,150 lines) — good smoke-test document:
    single import chain, moderate nesting, real `ccts:Component`
    documentation blocks.
  - `common/UBL-CommonAggregateComponents-2.5.xsd` (~55,000 lines) — stress
    test for performance, deep reuse (e.g. `cac:Party`, `cac:Address`,
    `cac:TaxCategory` referenced dozens of times), and indirect
    recursion/nesting (e.g. `cac:Shipment` / `cac:TransportHandlingUnit`
    style structures nested via several intermediate types).
  - `maindoc/*.xsd` (101 documents total) — used to spot-check that the
    preview opens correctly across a wide variety of real document types.
  - This UBL checkout is external to this repository and is **not** copied
    into `xsd-tree-viewer`; it's referenced here purely as a manual
    validation corpus each developer obtains separately, subject to its own
    OASIS copyright/license terms.

## 10. Acceptance Criteria (v1 "done")
1. "Open Preview" on any single-file `.xsd` renders a themed webview tree
   within 2s for files under 1 MB, and within a few seconds for
   UBL-common-components-scale files (~55k lines).
2. Multi-file schemas with `xs:import`/`xs:include` resolve refs across
   files without manual configuration (relative paths only in v1).
3. Direct recursion (a type containing itself) and indirect recursion (a
   cycle through ≥2 intermediate types, as found in UBL) both render as a
   finite tree with an expand-on-demand stub at the cycle point — no
   infinite loop, no crash, no unbounded DOM growth.
4. A type/element reused many times in one document (e.g. ≥10 times) is,
   by default, collapsed after its first full expansion, with a working
   jump-to-first-occurrence link.
5. Clicking any tree node's "go to source" action navigates to the correct
   line in the correct file.
6. The preview live-updates on save and preserves expand/collapse state.
7. Unit tests cover: simple schema, nested complex types, ref resolution,
   import/include resolution, direct + indirect circular references,
   repeated-subtree collapsing, and malformed XML (graceful error, not a
   crash).
8. Manual smoke test against `UBL-Invoice-2.5.xsd` and
   `UBL-CommonAggregateComponents-2.5.xsd` from the corpus in §9 passes
   without errors or unresponsive UI.
9. Extension packages via `vsce package` and installs cleanly from the
   generated `.vsix`.

## 11. Milestones
- M1: Parse single-file XSD → static resolved schema model + unit tests
      (including recursion-guard and repeat-tracker logic against the
      synthetic fixtures).
- M2: Webview preview panel wired to M1 output (read-only render,
      expand/collapse, cardinality/type/documentation display).
- M3: Cross-file resolution (import/include/ref/type); validate against
      the UBL corpus in §9.
- M4: Search/filter, node detail panel, `ccts:Component` documentation
      parsing, live-update on save with state preservation.
- M5: Performance pass against `UBL-CommonAggregateComponents-2.5.xsd`,
      packaging, README, marketplace listing assets, CI.

## 12. Open Questions
- Should "expand one more level" at a recursion stub be a single click that
  re-applies the same cycle guard one level deeper (so you can keep
  clicking through a genuinely deep recursive structure), or a "expand
  fully" escape hatch with a confirmation for very large subtrees? (Default
  assumption: click-to-expand-one-level, repeatable, since it composes
  naturally with the same guard logic.)
- Should top-level categories (Elements / Complex Types / Simple Types /
  Groups) be shown as separate root sections, or merged into one
  alphabetical list with icons only? (Default assumption: separate
  sections, configurable via a setting.)
- Should the extension also parse embedded schemas inside `.wsdl` files in
  v1, or defer to v2? (Default assumption: defer to v2, but keep the parser
  schema-source-agnostic so it's an additive change.)
