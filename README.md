# XSD Tree Viewer

A VS Code extension that renders XML Schema (`.xsd`) files as a rich,
read-only **preview panel** — like the built-in Markdown preview, but for
XSD structure: collapsible element tree, cardinality, resolved types,
documentation, and smart handling of recursive/deeply-reused schemas (e.g.
OASIS UBL).

[`docs/SPEC.md`](docs/SPEC.md) covers the goals, recursion/repetition
rendering strategy, architecture, data model, testing corpus, and milestones.

## Features

- **Preview panel** per document, opened from the editor title bar or the
  command palette, live-updating on edit (debounced) and on save.
- **Rich rows**: name with namespace prefix, resolved type, cardinality
  (styled differently for optional, required and repeatable), and
  `nillable` / `fixed` / `default` / `abstract` / `substitutionGroup` badges.
- **Cross-file resolution** of `ref`, `type`, `xs:import`, `xs:include` and
  `xs:redefine`/`xs:override`. Unresolved references are badged, not hidden.
  Saving an imported schema refreshes every preview that depends on it.
- **Finite recursion handling**: type cycles stop at a placeholder that
  expands one more level per click, with the guard reapplied each time.
- **Repeated-subtree collapsing**: a type reused many times collapses after
  its first expansions, with a jump link to the first full expansion, and
  stays expandable on demand.
- **Detail panel** with resolved XPath (copyable), schema properties,
  attributes, facets, `ccts:Component` documentation, and source location.
- **Filter** over names, types and documentation, plus a host-side
  declaration search that also reaches subtrees not yet lazily expanded.
- **Keyboard navigation** with arrow keys, Home/End and Enter/Space.

## Commands

| Command | Description |
| --- | --- |
| `XSD Tree Viewer: Open Preview` | Preview the active `.xsd` in the current column |
| `XSD Tree Viewer: Open Preview to the Side` | Preview beside the editor |
| `XSD Tree Viewer: Reveal in Preview` | Select the preview node declared at the cursor |
| `XSD Tree Viewer: Go to Definition` | Open the source of the selected preview node |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `xsdTreeViewer.autoCollapseDepth` | `3` | Element levels expanded without a click; deeper nodes load on demand |
| `xsdTreeViewer.collapseRepeatedSubtrees` | `true` | Collapse a repeated type after its first expansions |
| `xsdTreeViewer.parseCctsAnnotations` | `true` | Parse structured CCTS documentation used by UBL schemas |

Very large schemas pre-expand a bounded number of roots; the rest expand when
opened, and the preview reports how many were deferred.

## Development

```sh
npm install
npm run build      # typecheck + bundle extension, webview JS and CSS
npm run watch      # incremental rebuilds
npm test           # unit tests over test/fixtures
npm run package    # build, test, and produce a .vsix
```

The parser and resolver have no `vscode` dependency — file access goes
through the `SchemaFileSystem` port in [`src/schemaFileSystem.ts`](src/schemaFileSystem.ts) —
so they run under plain Node in the test suite. Layout is flatter than the
tree sketched in §7 of the spec: `src/{parser,resolver,model,preview,extension}.ts`
plus `src/webview/`.

## Status

Milestones M1–M5 of the spec are implemented. Validated against the OASIS
UBL 2.5 corpus described in §9 of the spec: all 116 `maindoc` and `common`
schemas resolve with no unresolved references, no unbounded expansion, and
sub-second builds.

## License

Apache-2.0
