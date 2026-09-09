import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSchema, parseXml } from "../src/parser";
import { fixtureUri } from "./helpers";

function readFixture(relativePath: string): { uri: string; text: string } {
  const uri = fixtureUri(relativePath);
  return { uri, text: fs.readFileSync(fileURLToPath(uri), "utf8") };
}

test("indexes top-level declarations with namespaces and prefixes", () => {
  const { uri, text } = readFixture("nested-complex-type.xsd");
  const document = parseSchema(uri, text);
  assert.equal(document.targetNamespace, "urn:example:nested");
  assert.equal(document.prefixes.xs, "http://www.w3.org/2001/XMLSchema");
  assert.deepEqual(document.diagnostics, []);
  assert.ok(document.components.has("urn:example:nested|element|Order"));
  assert.ok(document.components.has("urn:example:nested|complexType|ItemType"));
});

test("records import and include locations separately", () => {
  const { uri, text } = readFixture("import-include/root.xsd");
  const document = parseSchema(uri, text);
  assert.deepEqual(document.imports, ["imported.xsd"]);
  assert.deepEqual(document.includes, ["included.xsd"]);
  assert.deepEqual(document.importNamespaces, ["urn:example:imported"]);
});

test("treats redefine as an include and indexes its declarations", () => {
  const { uri, text } = readFixture("redefine/main.xsd");
  const document = parseSchema(uri, text);
  assert.deepEqual(document.includes, ["base.xsd"]);
  assert.ok(document.components.has("urn:example:redefine|complexType|AddressType"));
});

test("source positions point at the opening angle bracket of a declaration", () => {
  const { uri, text } = readFixture("simple.xsd");
  const document = parseSchema(uri, text);
  const person = document.components.get("urn:example:simple|element|Person");
  assert.ok(person);
  const lines = text.split("\n");
  const { line, column } = person.node.location;
  assert.equal(lines[line].slice(column, column + 11), "<xs:element");
});

test("malformed XML yields diagnostics and still returns the parsed prefix", () => {
  const { uri, text } = readFixture("malformed.xsd");
  const result = parseXml(uri, text);
  assert.ok(result.diagnostics.length > 0, "expected at least one diagnostic");
  const document = parseSchema(uri, text);
  assert.ok(document.diagnostics.length > 0);
  assert.ok(
    document.components.has("urn:example:malformed|element|Good"),
    "declarations before the error should survive",
  );
});
