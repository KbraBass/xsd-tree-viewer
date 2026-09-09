const esbuild = require("esbuild");

Promise.all([
  esbuild.build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    external: ["vscode"],
    platform: "node",
    format: "cjs",
    sourcemap: true,
    minify: false,
  }),
  esbuild.build({
    entryPoints: ["src/webview/main.ts"],
    bundle: true,
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
    sourcemap: true,
    minify: true,
  }),
]).catch(() => process.exit(1));
