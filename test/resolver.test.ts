import assert from "node:assert/strict";
import { test } from "node:test";
import { SchemaNode } from "../src/model";
import { allByName, buildFixture, findByName, fixtureUri, flatten, names, root } from "./helpers";

test("resolves a flat schema with cardinality, attributes and documentation", async () => {
  const { model } = await buildFixture("simple.xsd");
  const person = root(model, "Person");
  assert.equal(person.documentation, "A single person.");
  assert.equal(model.targetNamespace, "urn:example:simple");

  const name = findByName([person], "Name");
  assert.equal(name?.minOccurs, 1);
  assert.equal(name?.maxOccurs, 1);
  assert.equal(name?.type, "xs:string");

  const nickname = findByName([person], "Nickname");
  assert.equal(nickname?.minOccurs, 0);
  assert.equal(nickname?.maxOccurs, "unbounded");

  const id = findByName([person], "id");
  assert.equal(id?.kind, "attribute");
  assert.equal(id?.minOccurs, 1, "use=required maps to minOccurs 1");
  const active = findByName([person], "active");
  assert.equal(active?.minOccurs, 0);
  assert.equal(active?.default, "true");
});

test("expands nested named complex types up to the auto-collapse depth", async () => {
  const { model } = await buildFixture("nested-complex-type.xsd", { autoCollapseDepth: 3 });
  const order = root(model, "Order");
  assert.deepEqual(
    names([order]).sort(),
    ["Description", "Header", "Item", "Line", "Order", "Quantity", "Reference"],
  );
});

test("stops eager expansion at the configured depth and marks nodes expandable", async () => {
  const { model } = await buildFixture("nested-complex-type.xsd", { autoCollapseDepth: 1 });
  const order = root(model, "Order");
  const line = findByName([order], "Line");
  assert.ok(line);
  assert.equal(line.childrenLoaded, false, "beyond the eager depth children load on demand");
  assert.equal(line.expandable, true);
  assert.equal(line.children.length, 0);
});

test("expandNode loads exactly one more level on demand", async () => {
  const { model, resolver } = await buildFixture("nested-complex-type.xsd", { autoCollapseDepth: 1 });
  const line = findByName([root(model, "Order")], "Line");
  assert.ok(line);
  const children = resolver.expandNode(line.id);
  assert.ok(children);
  assert.deepEqual(names(children).sort(), ["Item", "Quantity"]);
  const item = findByName(children, "Item");
  assert.equal(item?.childrenLoaded, false, "the level after that still loads on demand");
});

test("resolves element refs, cross-file types, and flags unresolved refs", async () => {
  const { model } = await buildFixture("ref-resolution/main.xsd");
  const order = root(model, "Order");

  const orderId = findByName([order], "OrderId");
  assert.equal(orderId?.type, "xs:string");
  assert.equal(orderId?.documentation, "The order identifier.");

  const customer = findByName([order], "Customer");
  assert.equal(customer?.type, "t:CustomerType");
  assert.ok(findByName([order], "Name"), "the imported complex type expands");

  const missing = flattenUnresolved(model.roots);
  assert.deepEqual(missing, ["Missing"]);
});

function flattenUnresolved(nodes: SchemaNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.unresolvedRef ? [node.unresolvedRef] : []),
    ...flattenUnresolved(node.children),
  ]);
}

test("follows include and import chains from the root document", async () => {
  const { model, resolver } = await buildFixture("import-include/root.xsd");
  const rootNode = root(model, "Root");
  assert.ok(findByName([rootNode], "FromInclude"), "same-namespace include resolves");
  assert.ok(findByName([rootNode], "FromImport"), "cross-namespace import resolves");
  assert.ok(resolver.has(fixtureUri("import-include/included.xsd")));
  assert.ok(resolver.has(fixtureUri("import-include/imported.xsd")));
  assert.deepEqual(model.warnings, []);
});

test("a redefined type derives from the definition it replaces", async () => {
  const { model } = await buildFixture("redefine/main.xsd");
  const delivery = root(model, "Delivery");
  assert.deepEqual(names([delivery]).sort(), ["Country", "Delivery", "Street"]);
});

test("direct recursion terminates in an expandable stub", async () => {
  const { model, resolver } = await buildFixture("direct-recursion.xsd", { autoCollapseDepth: 5 });
  const tree = root(model, "Tree");
  const stubs = flatten([tree]).filter((node) => node.recursion);
  assert.ok(stubs.length > 0, "expected a recursion stub");
  for (const stub of stubs) {
    assert.ok(stub.recursion?.cyclesBackToTypeId.endsWith("|urn:example:direct|complexType|NodeType"));
    assert.equal(stub.expandable, true, "the cycle point is never a dead end");
    assert.equal(stub.children.length, 0);
  }
  const deeper = resolver.expandNode(stubs[0].id);
  assert.ok(deeper && deeper.length > 0, "expanding a stub yields one more level");
});

test("indirect recursion through three types terminates", async () => {
  const { model } = await buildFixture("indirect-recursion.xsd", { autoCollapseDepth: 12 });
  const rootNode = root(model, "Root");
  const all = flatten([rootNode]);
  assert.ok(all.length < 500, `expected a bounded tree, got ${all.length} nodes`);
  const cycle = all.find((node) => node.recursion);
  assert.ok(cycle?.recursion?.cyclesBackToTypeId.endsWith("|urn:example:indirect|complexType|AType"));
});

test("repeated subtrees collapse after their first expansions with a jump target", async () => {
  const { model, resolver } = await buildFixture("repeated-subtree.xsd", { autoCollapseDepth: 4 });
  const rootNode = root(model, "Root");
  const streets = allByName([rootNode], "Street");
  assert.ok(streets.length >= 1, "the first occurrences expand in full");
  assert.ok(streets.length < 10, "later occurrences are collapsed instead of re-rendered");

  const collapsed = flatten([rootNode]).filter((node) => node.firstOccurrenceId);
  assert.ok(collapsed.length > 0, "expected collapsed repeat stubs");
  const first = collapsed[0];
  assert.equal(first.collapsed, true);
  assert.equal(first.expandable, true);
  assert.ok(
    flatten([rootNode]).some((node) => node.id === first.firstOccurrenceId),
    "the jump target is a node present in the tree",
  );
  const expanded = resolver.expandNode(first.id);
  assert.deepEqual(names(expanded ?? []).sort(), ["City", "Street"]);
});

test("repeat collapsing can be switched off", async () => {
  const { model } = await buildFixture("repeated-subtree.xsd", {
    autoCollapseDepth: 4,
    collapseRepeatedSubtrees: false,
  });
  const rootNode = root(model, "Root");
  assert.equal(allByName([rootNode], "Street").length, 10);
  assert.equal(flatten([rootNode]).filter((node) => node.firstOccurrenceId).length, 0);
});

test("collects facets, inherited restriction facets, lists and unions", async () => {
  const { model } = await buildFixture("facets.xsd");
  const status = root(model, "Status");
  assert.equal(status.facets?.base, "StatusType");
  assert.equal(status.facets?.pattern, "[a-z]+");
  assert.equal(status.facets?.maxLength, "12", "facets of the base type are merged in");
  assert.deepEqual(status.facets?.enumeration, ["draft", "sent", "paid"]);

  assert.equal(root(model, "Codes").facets?.list, "xs:token");
  assert.deepEqual(root(model, "Either").facets?.union, ["xs:decimal", "xs:string"]);
});

test("parses structured CCTS documentation and honours the setting", async () => {
  const { model } = await buildFixture("ccts.xsd");
  const id = root(model, "ID");
  assert.equal(id.ccts?.componentType, "BBIE");
  assert.equal(id.ccts?.dictionaryEntryName, "Invoice. Identifier");
  assert.equal(id.ccts?.definition, "An identifier for this document.");
  assert.equal(id.ccts?.objectClass, "Invoice");

  const { model: plain } = await buildFixture("ccts.xsd", { parseCctsAnnotations: false });
  assert.equal(root(plain, "ID").ccts, undefined);
});

test("CCTS annotations are read from the usage site and from the type", async () => {
  const { model } = await buildFixture("ccts.xsd");
  const invoice = root(model, "Invoice");
  assert.equal(invoice.ccts?.componentType, "ABIE", "the type's ABIE block describes the element using it");
  assert.equal(invoice.ccts?.objectClass, "Invoice");

  const id = findByName([invoice], "ID");
  assert.equal(id?.ccts?.cardinality, "0..1", "the particle's block wins over the global declaration");
  assert.equal(id?.ccts?.propertyTerm, "Identifier");
  assert.equal(id?.ccts?.dataType, "Identifier. Type");
  assert.equal(id?.ccts?.examples, "INV-1");
});

test("a CCTS block is not flattened into the documentation prose", async () => {
  const { model } = await buildFixture("ccts.xsd");
  const invoice = root(model, "Invoice");
  assert.equal(findByName([invoice], "ID")?.documentation, undefined);
  assert.equal(findByName([invoice], "Note")?.documentation, "Free-form commentary.");
});

test("renders xs:any and xs:anyAttribute as wildcards rather than unresolved refs", async () => {
  const { model } = await buildFixture("wildcard.xsd");
  const envelope = root(model, "Envelope");
  const all = flatten([envelope]);
  const any = all.find((node) => node.kind === "any");
  assert.equal(any?.wildcard?.namespace, "##other");
  assert.equal(any?.wildcard?.processContents, "lax");
  assert.equal(any?.maxOccurs, "unbounded");
  const anyAttribute = all.find((node) => node.kind === "anyAttribute");
  assert.equal(anyAttribute?.wildcard?.processContents, "skip");
  assert.equal(all.filter((node) => node.unresolvedRef).length, 0);
});

test("malformed input surfaces a warning instead of throwing", async () => {
  const { model } = await buildFixture("malformed.xsd");
  assert.ok(model.warnings.length > 0);
  assert.ok(model.warnings.some((warning) => warning.startsWith("malformed.xsd:")));
  assert.ok(model.roots.some((node) => node.name === "Good"));
});

test("a missing root document rejects rather than returning an empty model", async () => {
  await assert.rejects(buildFixture("does-not-exist.xsd"));
});

test("an unreadable import degrades to a warning", async () => {
  const { model, resolver } = await buildFixture("simple.xsd");
  assert.deepEqual(model.warnings, []);
  const missing = fixtureUri("missing-import.xsd");
  assert.equal(resolver.has(missing), false);
});

test("search finds declarations across every loaded document", async () => {
  const { resolver } = await buildFixture("import-include/root.xsd");
  const hits = resolver.search("ImportedType");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "complexType");
  assert.equal(hits[0].namespace, "urn:example:imported");
  assert.ok(hits[0].sourceLocation.uri.endsWith("imported.xsd"));
  assert.deepEqual(resolver.search(""), []);
  assert.ok(resolver.search("order").length === 0);
});

test("search matches documentation text and respects the limit", async () => {
  const { resolver } = await buildFixture("ref-resolution/main.xsd");
  const hits = resolver.search("order identifier");
  assert.deepEqual(hits.map((hit) => hit.name), ["OrderId"]);
  assert.equal(resolver.search("o", 2).length, 2);
});

test("invalidate re-reads a document on the next build", async () => {
  const { model, resolver } = await buildFixture("import-include/root.xsd");
  assert.ok(model.roots.length > 0);
  const included = fixtureUri("import-include/included.xsd");
  resolver.invalidate(included);
  assert.equal(resolver.has(included), false);
  const rebuilt = await resolver.build(fixtureUri("import-include/root.xsd"));
  assert.ok(findByName(rebuilt.roots, "FromInclude"), "the include is reloaded");
});

test("build accepts unsaved editor text for the root document", async () => {
  const { resolver } = await buildFixture("simple.xsd");
  const edited = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:example:simple">
  <xs:element name="Renamed" type="xs:string"/>
</xs:schema>`;
  const model = await resolver.build(fixtureUri("simple.xsd"), edited);
  assert.deepEqual(model.roots.map((node) => node.name), ["Renamed"]);
});

test("node ids are unique and stable across rebuilds", async () => {
  const { model, resolver } = await buildFixture("nested-complex-type.xsd");
  const ids = flatten(model.roots).map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate ids would break selection");
  const again = await resolver.build(fixtureUri("nested-complex-type.xsd"));
  assert.deepEqual(flatten(again.roots).map((node) => node.id), ids);
});

test("a library schema with no global elements shows its types as roots", async () => {
  const { model } = await buildFixture("ref-resolution/types.xsd");
  assert.deepEqual(model.roots.map((node) => node.name), ["CustomerType"]);
  assert.equal(model.roots[0].kind, "complexType");
  assert.ok(findByName(model.roots, "Name"), "the type's content is expanded");
});

test("a restriction restates components instead of duplicating them", async () => {
  const { model } = await buildFixture("derivation.xsd");
  const restricted = root(model, "Restricted");
  const attributes = flatten([restricted]).filter((node) => node.kind === "attribute");
  assert.deepEqual(
    attributes.map((node) => node.name),
    ["schemeID", "schemeName", "schemeAgencyID"],
    "re-declared attributes replace the inherited ones and keep their position",
  );
  const schemeName = attributes.find((node) => node.name === "schemeName");
  assert.equal(schemeName?.type, "xs:normalizedString", "the restricting declaration wins");
  assert.equal(schemeName?.minOccurs, 1, "use=required comes from the restriction");
});

test("an extension appends to the base content model", async () => {
  const { model } = await buildFixture("derivation.xsd");
  const extended = root(model, "Extended");
  assert.deepEqual(names([extended]), ["Extended", "First", "Second"]);
});
