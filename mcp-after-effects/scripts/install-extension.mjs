#!/usr/bin/env node
// Installs the "After Effects MCP" panel for the current user on macOS or Windows.
//
// The panel isn't signed as a ZXP, so this also turns on Adobe's
// PlayerDebugMode, which lets After Effects load unsigned panels.
// Run with --uninstall to remove the panel again.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_ID = "com.creatorx.aemcp";
// CSXS 9 = After Effects 2019 ... CSXS 12+ = After Effects 2024 and newer.
const CSXS_VERSIONS = [9, 10, 11, 12, 13];

const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
const uninstall = process.argv.includes("--uninstall");

let extensionsDir;
if (process.platform === "darwin") {
  extensionsDir = path.join(homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions");
} else if (process.platform === "win32") {
  extensionsDir = path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "Adobe", "CEP", "extensions");
} else {
  console.error("After Effects runs on macOS and Windows only, so there is nothing to install here.");
  process.exit(1);
}
const target = path.join(extensionsDir, BUNDLE_ID);

if (uninstall) {
  rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
  console.log("Restart After Effects to finish.");
  process.exit(0);
}

if (!existsSync(path.join(source, "CSXS", "manifest.xml"))) {
  console.error(`Can't find the panel files in ${source}.`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`Copied the panel to ${target}`);

for (const v of CSXS_VERSIONS) {
  if (process.platform === "darwin") {
    execFileSync("defaults", ["write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1"]);
  } else {
    execFileSync("reg", ["add", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"], {
      stdio: "ignore",
    });
  }
}
console.log("Allowed After Effects to load the panel (PlayerDebugMode).");
console.log("");
console.log("Done. Restart After Effects, then open Window > Extensions > After Effects MCP.");
