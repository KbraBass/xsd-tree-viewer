const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions[]} */
const builds = [
  {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    external: ["vscode"],
    platform: "node",
    target: "node18",
    format: "cjs",
    sourcemap: true,
    minify: false,
  },
  {
    entryPoints: ["src/webview/main.ts"],
    bundle: true,
    outfile: "dist/webview.js",
    platform: "browser",
    target: "es2022",
    format: "iife",
    sourcemap: true,
    minify: true,
  },
  {
    entryPoints: ["src/webview/main.css"],
    bundle: true,
    outfile: "dist/webview.css",
    sourcemap: true,
    minify: true,
  },
];

async function run() {
  if (watch) {
    const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
    await Promise.all(contexts.map((context) => context.watch()));
    console.log("esbuild: watching for changes");
    return;
  }
  await Promise.all(builds.map((options) => esbuild.build(options)));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
