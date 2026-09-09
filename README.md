# XSD Tree Viewer

A VS Code extension that renders XML Schema (`.xsd`) files as a rich,
read-only **preview panel** — like the built-in Markdown preview, but for
XSD structure: collapsible element tree, cardinality, resolved types,
documentation, and smart handling of recursive/deeply-reused schemas (e.g.
OASIS UBL).

The repository specification covers the goals, recursion/repetition rendering
strategy, architecture, data model, testing corpus, and milestones.

## Status

Initial MVP implementation is available. It currently supports a webview
preview, source navigation, cross-file imports/includes, rich annotations,
facets, and finite handling of recursive/repeated types.

## Roadmap (short version)

1. Parse a single `.xsd` file into a typed, resolved schema model.
2. Render that model in a VS Code webview preview panel with
   click-to-navigate, cardinality, and documentation.
3. Resolve cross-file references (`import`/`include`/`ref`/`type`) and
   validate against real-world UBL schemas.
4. Add search/filter, a node detail panel, and live-update on save.
5. Package and publish.
