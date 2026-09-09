# XSD Tree Viewer

A VS Code extension that renders XML Schema (`.xsd`) files as a rich,
read-only **preview panel** — like the built-in Markdown preview, but for
XSD structure: collapsible element tree, cardinality, resolved types,
documentation, and smart handling of recursive/deeply-reused schemas (e.g.
OASIS UBL).

Requires VS Code 1.85 or newer. No network access, no telemetry, no native
dependencies; it works in VS Code Web and on virtual filesystems.

## Installing

The extension is not on the Marketplace yet (see
[`docs/PUBLISHING.md`](docs/PUBLISHING.md)). To install it from source:

```sh
git clone https://github.com/KbraBass/xsd-tree-viewer.git
cd xsd-tree-viewer
npm ci
npm run package                                   # writes xsd-tree-viewer-<version>.vsix
code --install-extension xsd-tree-viewer-*.vsix
```

Or press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with
the extension loaded.

Then open a `.xsd` file and run **XSD Tree Viewer: Open Preview**, or use the
preview icon in the editor title bar.

## Features

- **Preview panel** per document, opened from the editor title bar or the
  command palette, live-updating on edit (debounced) and on save.
- **Rich rows**: name with namespace prefix, resolved type, and
  `nillable` / `fixed` / `default` / `abstract` / `substitutionGroup` badges.
- **Colour-coded cardinality**: one pill style per min/max combination
  (required/optional crossed with single/repeatable), with a legend in the
  toolbar and a tooltip spelling out the `minOccurs`/`maxOccurs` pair. All
  combinations clear WCAG AA contrast in light and dark themes.
- **Readable deep trees**: `+`/`-` expanders, one indent guide per level, and
  alternating shading across siblings. Selecting a node emphasises the guide
  holding its children and lifts the guides back to the root, so a deep
  subtree reads as one group.
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
npm run test:webview  # browser check of the webview (needs playwright)
npm run package    # build, test, and produce a .vsix
```

The renderer only exists in a DOM, so it is out of reach of the Node suite.
`npm run test:webview` drives the real bundle in Chromium — install a browser
with `npx playwright install chromium` first, or point
`PLAYWRIGHT_CHROMIUM_PATH` at an existing build. It skips cleanly when
playwright is not present.

### Layout

| Path | Role |
| --- | --- |
| [`src/extension.ts`](src/extension.ts) | Activation, commands, preview sessions, refresh scheduling |
| [`src/parser.ts`](src/parser.ts) | XML → tree, with line/column tracking and error tolerance |
| [`src/resolver.ts`](src/resolver.ts) | `ref`/`type`/import/include resolution, cycle and repeat guards |
| [`src/model.ts`](src/model.ts) | Shared types, used by both the host and the webview |
| [`src/schemaFileSystem.ts`](src/schemaFileSystem.ts) | File-access port, plus its VS Code implementation |
| [`src/preview.ts`](src/preview.ts) | Webview panel, message handling, page shell |
| [`src/webview/`](src/webview/) | Renderer, stylesheet, and page body markup |
| [`test/`](test/) | Node suite over `test/fixtures/`, plus the browser check |

The parser and resolver have no `vscode` dependency — file access goes through
the `SchemaFileSystem` port — so they run under plain Node in the test suite,
and can be reused outside a webview host. The layout is flatter than the tree
sketched in §7 of the spec.

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — goals, recursion/repetition strategy,
  architecture, data model, testing corpus, milestones.
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md) — releasing to the Marketplace and
  to GitHub, and what has to be set up first.
- [`CHANGELOG.md`](CHANGELOG.md) — what changed in each version.

## Contributing

Issues and pull requests are welcome at
<https://github.com/KbraBass/xsd-tree-viewer>. Before opening a PR, please run
`npm run build` and `npm test`; if you touched anything under `src/webview/`,
run `npm run test:webview` too. New resolver behaviour should come with a
fixture under `test/fixtures/` covering it.

## Status

Milestones M1–M5 of the spec are implemented. Validated against the OASIS
UBL 2.5 corpus described in §9 of the spec: all 116 `maindoc` and `common`
schemas resolve with no unresolved references, no unbounded expansion, and
sub-second builds.

## License

[Apache-2.0](LICENSE).

The OASIS UBL schemas used for manual validation are not distributed with this
repository and remain subject to their own OASIS copyright and licence terms.
