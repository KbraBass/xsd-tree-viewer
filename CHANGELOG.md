# Changelog

All notable changes to XSD Tree Viewer are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-09-09

Add entries here as you go; the release workflow renames this heading to the
version being released and uses the section as the release notes.

### Added
- CI on every push and pull request: typecheck, bundle, unit tests, and a
  packaging step (`dist/` is git-ignored, so a tree that compiles but cannot be
  packaged would otherwise only fail at release time). A second job installs
  playwright and runs the webview keyboard check.
- A `Release` workflow that cuts a release entirely on GitHub: it bumps the
  version, packages the `.vsix`, tags, and publishes a GitHub Release with the
  `.vsix` attached, so it is downloadable without a local build. Takes a semver
  bump or an exact version, refuses to run if the tag exists, and has a
  `dry_run` mode. Release notes come from this section. The Marketplace publish
  is the final step and skips itself until a `VSCE_PAT` secret exists.

- An extension icon ([`images/icon.png`](images/icon.png)), and `publisher`
  set to `KbraBass`, making the Marketplace identity
  `KbraBass.xsd-tree-viewer`.

### Fixed
- `npm test` resolved `out/test/` as a module on Node 22 and failed with
  `MODULE_NOT_FOUND`; only newer versions accept the directory form. It now
  passes the test files explicitly.
- The `.vsix` no longer ships `.gitignore` or source maps. A lone `*` does not
  cross `/` in a `.vscodeignore` glob, so `*.map` never matched
  `dist/webview.js.map`; the package drops from roughly 81 KB to 44 KB.

## [0.2.0] - 2026-09-09

### Fixed
- Keyboard navigation no longer stalls at a subtree that was expanded and then
  re-collapsed. The reachability check stopped at the first collapsed
  `<details>` ancestor, so a closed node's own row counted as reachable even
  when an outer ancestor was closed too. A collapsed subtree keeps its markup,
  so those hidden rows entered the arrow-key order, and focusing one silently
  fails — leaving the cursor stuck. Every ancestor is now checked, and
  collapsing a node brings the tab stop back out of it.
- An `xs:restriction` no longer duplicates the components it restates. Derived
  declarations replace the inherited ones of the same name instead of being
  appended, which had every UBL leaf showing `@schemeName` and
  `@schemeAgencyID` twice. Attributes are merged by name under either kind of
  derivation, since a type cannot carry two attributes with the same name.
- The "go to source" arrow appeared on every descendant of the selected row,
  because its reveal rule used a descendant selector.
- Everything in a selected row now takes the selection foreground. Per-kind
  colours were kept, which put dark-blue element names on a blue selection
  background in light themes.
- A row whose content wraps keeps its expander aligned to the first text line
  rather than dropping it into the gap between lines.
- The sticky detail panel no longer tucks under the header; both it and
  scroll-into-view offsets follow the header's measured height.
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
- Tree layout pass: `+`/`-` expanders in place of chevrons, roomier rows and a
  wider indent step, one indent guide per level, and alternating shading
  across sibling rows.
- Selecting a node emphasises the indent guide holding its children and lifts
  the guides along the path back to the root, so a deep subtree reads as one
  group.
- Cardinality is colour-coded by min/max combination — required/optional
  crossed with single/repeatable — with a legend in the toolbar and a tooltip
  spelling out each `minOccurs`/`maxOccurs` pair. The hue rides on the pill's
  tint and ring rather than its text, because a theme's chart colours are not
  guaranteed to contrast with the editor background at that text size; every
  combination clears WCAG AA in both light and dark themes.
- Rows carry their node kind as a class, so elements, attributes, types and
  structure particles are styled distinctly, and an `xs:choice` gets a dashed
  guide of its own to mark it as a decision point.
- Repository, homepage and issue-tracker metadata in `package.json`, a
  publishing guide in `docs/PUBLISHING.md`, and install/layout/contributing
  sections in the README.
- `npm run test:webview`: a browser check that drives the real webview bundle,
  expanding and re-collapsing nodes at random and asserting every visible row
  stays reachable by keyboard. Needs `npx playwright install chromium`; it
  skips cleanly when playwright is absent and is not part of `npm test`.
- A unit-test suite (`npm test`) over synthetic fixtures covering simple
  schemas, nested types, ref/import/include/redefine resolution, direct and
  indirect recursion, repeated-subtree collapsing, restriction/extension
  derivation, facets, CCTS annotations, wildcards and malformed input.
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
- "Open Preview" is available from the explorer context menu on `.xsd` files,
  and both preview commands accept a resource URI.
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
- A transparent `xs:sequence` no longer adds a level of indentation, since it
  renders no row of its own. An `xs:choice`, or a sequence with non-default
  cardinality, still gets a row.
- Buttons no longer underline on hover, which read as a link.
- `package-lock.json` resolves packages from the public npm registry rather
  than an internal mirror, so `npm ci` works outside that network. Integrity
  hashes are unchanged.
- The webview shares its type definitions with the extension host instead of
  duplicating them, and the preview's body markup lives in one `vscode`-free
  module so the browser checks render the real page structure.

## [0.1.0] - 2026-09-09

- Initial MVP: webview preview, source navigation, cross-file
  imports/includes, annotations, facets, and finite handling of recursive and
  repeated types.
