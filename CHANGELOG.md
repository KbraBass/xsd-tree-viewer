# Changelog

All notable changes to XSD Tree Viewer are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-09

### Fixed
- Repeated-subtree and recursion placeholders no longer disappear from the
  tree. They were emitted as `complexType` nodes, which the renderer treated
  as an implementation detail and flattened away, so whole branches — and the
  jump-to-first-occurrence links with them — silently vanished.
- `xs:any` and `xs:anyAttribute` render as wildcards instead of being reported
  as unresolved references.
- `xsdTreeViewer.autoCollapseDepth` is now honoured. Expansion previously
  stopped one element level below each root regardless of the setting.
- `revealInPreview` and `goToDefinition` do what their names say; both were
  aliases of "Open Preview to the Side".
- Structured `ccts:Component` documentation is read from the usage-site
  particle and from the type definition, which is where UBL puts it. It is
  also no longer flattened into the plain documentation text, which used to
  turn every UBL row's prose into a run-on of CCTS field values.
- Subtrees truncated by the node budget are marked expandable instead of
  appearing as leaves.
- Refresh debouncing is per document; editing one schema no longer cancels a
  pending refresh for another.
- The preview keeps its scroll position across live updates.
- Malformed XML reports a warning and previews everything that could be read,
  instead of failing the whole document.
- Source locations point at the start of a declaration rather than at the end
  of its opening tag.
- Facets and documentation from a simple type are attached to leaf nodes.
- A schema declaring no global elements (a shared types library) shows its
  global types and groups instead of an empty preview.
- `xs:redefine`/`xs:override` are followed, and a redefinition derives from
  the definition it replaces rather than being treated as a cycle.
- Attribute `use="required"` on a reference is honoured over the global
  declaration's own value.
- Invalidating one imported schema now takes effect on the next build; a
  cached parent used to short-circuit the reload walk.

### Added
- A unit-test suite (`npm test`) over synthetic fixtures covering simple
  schemas, nested types, ref/import/include/redefine resolution, direct and
  indirect recursion, repeated-subtree collapsing, facets, CCTS annotations,
  wildcards and malformed input.
- Recursion and repeat placeholders expand on demand — one more level per
  click, with the guard reapplied — so no branch is ever a dead end.
- Declaration search in the extension host, so the filter also finds
  declarations in subtrees that have not been lazily expanded yet.
- "Collapse all" action and a match counter in the preview toolbar.
- `xs:choice`, `abstract`, `substitutionGroup` and wildcard namespace details
  are shown; optional, required and repeatable cardinalities are styled
  distinctly.
- Facets cover `xs:list`, `xs:union`, and facets inherited from a restriction
  base; the CCTS table includes property term, representation term, data type
  and examples.
- Saving an imported schema refreshes every preview that depends on it.
- Changing a setting refreshes open previews.
- `npm run watch` for incremental builds.

### Changed
- The parser and resolver no longer depend on the `vscode` module; file access
  goes through a `SchemaFileSystem` port. This is what makes them testable,
  and it replaced `Buffer` with `TextDecoder` and `workspace.fs` so imports
  resolve on virtual filesystems and in VS Code Web.
- Eager expansion is bounded by one shared node budget per root, so
  repeated-subtree detection now applies across a whole root subtree rather
  than resetting per branch.
- Webview styles moved to a bundled stylesheet, and the CSP no longer needs
  `style-src 'unsafe-inline'`. Nonces are random rather than `Date.now()`.
- The webview shares its type definitions with the extension host instead of
  duplicating them.

## [0.1.0] - 2026-09-09

- Initial MVP: webview preview, source navigation, cross-file
  imports/includes, annotations, facets, and finite handling of recursive and
  repeated types.
