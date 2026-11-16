import * as esbuild from "esbuild";
import * as fs from "fs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// The dashboard webview uses the codicon font; node_modules is not packaged.
fs.mkdirSync("dist/codicons", { recursive: true });
for (const file of ["codicon.css", "codicon.ttf"]) {
  fs.copyFileSync(`node_modules/@vscode/codicons/dist/${file}`, `dist/codicons/${file}`);
}

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"],
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
