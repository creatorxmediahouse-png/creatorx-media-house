#!/usr/bin/env node
// Builds the two files people download instead of using a terminal:
//   release/after-effects-mcp.mcpb       Claude Desktop extension (double-click to install)
//   release/AfterEffectsMCP-Panel.zip    the After Effects panel with double-click installers
// Run `npm run package` (which builds first). Needs `zip` on PATH and network for `npm ci`.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = path.join(root, "build");
const release = path.join(root, "release");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

rmSync(build, { recursive: true, force: true });
mkdirSync(release, { recursive: true });

// --- Claude Desktop extension (.mcpb) ---
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const bundle = path.join(build, "mcpb");
cpSync(path.join(root, "dist"), path.join(bundle, "server"), {
  recursive: true,
  filter: (src) => !src.endsWith(".map"),
});
const manifest = JSON.parse(readFileSync(path.join(root, "packaging", "mcpb-manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(
  path.join(bundle, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module", dependencies: pkg.dependencies }, null, 2) + "\n",
);
cpSync(path.join(root, "package-lock.json"), path.join(bundle, "package-lock.json"));
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], bundle);
const mcpbFile = path.join(release, "after-effects-mcp.mcpb");
rmSync(mcpbFile, { force: true });
run(path.join(root, "node_modules", ".bin", "mcpb"), ["pack", bundle, mcpbFile], root);

// --- After Effects panel zip ---
const folderName = "After Effects MCP Panel";
const panel = path.join(build, "panel", folderName);
cpSync(path.join(root, "extension"), path.join(panel, "com.creatorx.aemcp"), { recursive: true });
cpSync(path.join(root, "packaging", "panel-installers"), panel, { recursive: true });
const zipFile = path.join(release, "AfterEffectsMCP-Panel.zip");
rmSync(zipFile, { force: true });
// -X drops extra attributes; zip keeps the .command files executable.
run("zip", ["-r", "-X", "-q", zipFile, folderName], path.join(build, "panel"));

console.log(`\nWrote ${path.relative(root, mcpbFile)} and ${path.relative(root, zipFile)}`);
