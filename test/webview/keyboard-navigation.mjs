/**
 * Browser check for the webview's keyboard navigation.
 *
 * The renderer only exists in a DOM, so it is out of reach of the Node test
 * suite. This drives the real bundle in Chromium: it expands and re-collapses
 * nodes at random, then walks the tree with ArrowDown and asserts every row
 * the browser considers visible is reachable. A collapsed subtree keeps its
 * markup, so a stale visibility rule puts hidden rows into the keyboard order,
 * and focusing one silently fails — which stalls the arrow keys.
 *
 * Not part of `npm test`, since it needs a browser:
 *   npx playwright install chromium
 *   npm run test:webview
 * Set PLAYWRIGHT_CHROMIUM_PATH to use an existing Chromium build.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.log("SKIPPED: playwright is not installed (npx playwright install chromium)");
  process.exit(0);
}

let SchemaResolver;
let previewBodyHtml;
try {
  ({ SchemaResolver } = require(path.join(root, "out/src/resolver.js")));
  ({ previewBodyHtml } = require(path.join(root, "out/src/webview/body.js")));
} catch {
  console.error("Compile first: npx tsc -p tsconfig.test.json");
  process.exit(1);
}

/** A branchy schema, generated in memory purely through the resolver's file port. */
function generateSchema(levels, breadth) {
  const types = [];
  for (let level = 0; level < levels; level += 1) {
    const children = [];
    for (let index = 0; index < breadth; index += 1) {
      children.push(level + 1 < levels
        ? `      <xs:element name="Child${index}" type="Level${level + 1}Type" minOccurs="0" maxOccurs="unbounded"/>`
        : `      <xs:element name="Leaf${index}" type="xs:string" minOccurs="0"/>`);
    }
    types.push(`  <xs:complexType name="Level${level}Type">
    <xs:sequence>
${children.join("\n")}
    </xs:sequence>
    <xs:attribute name="id${level}" type="xs:string"/>
  </xs:complexType>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test:deep">
  <xs:element name="Root" type="Level0Type"/>
${types.join("\n")}
</xs:schema>`;
}

const schemaUri = "memory:/deep.xsd";
const memoryFileSystem = {
  files: new Map([[schemaUri, generateSchema(5, 4)]]),
  async readFile(uri) {
    const text = this.files.get(uri);
    if (text === undefined) {
      throw new Error(`No such schema: ${uri}`);
    }
    return text;
  },
  resolveRelative(_baseUri, location) {
    return location;
  },
};

const resolver = new SchemaResolver(memoryFileSystem, {
  collapseRepeatedSubtrees: false,
  parseCctsAnnotations: false,
  autoCollapseDepth: 6,
  maxExpansionNodes: 4000,
});
const model = await resolver.build(schemaUri);

const [css, js] = await Promise.all([
  readFile(path.join(root, "dist/webview.css"), "utf8"),
  readFile(path.join(root, "dist/webview.js"), "utf8"),
]);

const page = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body>${previewBodyHtml()}
<script>window.acquireVsCodeApi = () => ({ postMessage: () => {} });</script>
<script>${js}</script>
<script>
  window.postMessage({ type: "update", model: ${JSON.stringify(model)} }, "*");
  setTimeout(() => { window.__ready = true; }, 60);
</script>
</body></html>`;

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const tab = await browser.newPage({ viewport: { width: 1000, height: 900 } });
await tab.setContent(page);
await tab.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

let failures = 0;
for (let round = 1; round <= 5; round += 1) {
  const toggles = await tab.evaluate((seed) => {
    let state = seed;
    const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    const flip = (element, open) => {
      if (element.open !== open) {
        element.open = open;
        element.dispatchEvent(new Event("toggle"));
      }
    };
    let count = 0;
    for (let step = 0; step < 30; step += 1) {
      const rows = [...document.querySelectorAll("#tree details.node-item")];
      const element = rows[Math.floor(random() * rows.length)];
      if (!element) {
        continue;
      }
      // Expand, then usually collapse again: the stalling case needs a
      // collapsed node nested inside another collapsed node.
      flip(element, true);
      if (random() < 0.6) {
        flip(element, false);
      }
      count += 1;
    }
    return count;
  }, round * 7919);

  const expected = await tab.evaluate(() =>
    [...document.querySelectorAll("#tree .node-item > summary, #tree .node-item.leaf")]
      .filter((element) => element.checkVisibility()).length);

  await tab.evaluate(() => {
    document.querySelector("#tree .node-item > summary, #tree .node-item.leaf").focus();
  });

  const visited = new Set();
  let repeats = 0;
  for (let step = 0; step < expected + 40; step += 1) {
    const id = await tab.evaluate(() => {
      const active = document.activeElement;
      const item = active?.closest?.("#tree .node-item");
      return item ? item.dataset.id : null;
    });
    if (id === null) {
      break;
    }
    if (visited.has(id)) {
      repeats += 1;
      if (repeats > 2) {
        break;
      }
    } else {
      repeats = 0;
      visited.add(id);
    }
    await tab.keyboard.press("ArrowDown");
  }

  const ok = visited.size === expected;
  failures += ok ? 0 : 1;
  console.log(`round ${round}: ${toggles} toggles, ${expected} visible rows, ${visited.size} reached by ArrowDown ${ok ? "ok" : "MISMATCH"}`);
}

await browser.close();
if (failures > 0) {
  console.error(`FAIL: ${failures} round(s) could not reach every visible row`);
  process.exit(1);
}
console.log("PASS: every visible row is reachable by keyboard after expand/collapse churn");
