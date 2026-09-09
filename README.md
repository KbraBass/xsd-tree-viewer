# XSD Tree Viewer

XSD Tree Viewer is a Visual Studio Code extension for exploring XML Schema
files as an interactive, read-only tree.

It is designed for large schemas such as UBL and supports:

- lazy expansion of nested types and imported schemas;
- source navigation, filters, keyboard navigation, and copyable XPaths;
- namespace-qualified names such as `cac:Item` and `cbc:ID`;
- attributes, cardinality, documentation, CCTS metadata, type lineage, and
  restrictions;
- recursion and repeated-type handling without unbounded expansion.

## Install

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=KbraBass.xsd-tree-viewer),
or install a local VSIX:

```sh
code --install-extension xsd-tree-viewer-<version>.vsix
```

Open an `.xsd` file and run **XSD Tree Viewer: Open Preview**. You can also
right-click an XSD file in the Explorer and choose **XSD Tree Viewer: Open
Preview**.

## Development

```sh
npm ci
npm run build
npm test
npm run package
```

The package command produces a ready-to-install `.vsix`. The short
Marketplace-facing description lives in [`README.vsix.md`](README.vsix.md).

## Project Docs

- [`docs/SPEC.md`](docs/SPEC.md): architecture and behavior specification.
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md): GitHub and Marketplace release steps.

## Links

- [Marketplace](https://marketplace.visualstudio.com/items?itemName=KbraBass.xsd-tree-viewer)
- [Issues](https://github.com/KbraBass/xsd-tree-viewer/issues)
- [Source repository](https://github.com/KbraBass/xsd-tree-viewer)

## License

Apache-2.0. See [`LICENSE`](LICENSE).
