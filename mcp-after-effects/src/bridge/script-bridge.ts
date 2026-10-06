import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeScript, toJsxLiteral, type ScriptEnvelope } from "../jsx/compose.js";
import { AeBridgeError, AeScriptError, SerialQueue, type AeBridge, type RunOptions } from "./bridge.js";

/** Starts After Effects on a .jsx file. Resolves or rejects only if the launcher itself fails. */
export type Launcher = (jsxPath: string) => { exited: Promise<{ code: number | null; stderr: string }> };

export interface ScriptBridgeOptions {
  launcher: Launcher;
  workDir?: string;
  defaultTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Talks to a running After Effects by asking the OS to execute a generated
 * .jsx file (AppleScript `DoScriptFile` on macOS, `AfterFX.exe -r` on
 * Windows). The script writes its result to a JSON file next to it, which
 * this bridge polls for. Nothing needs to be installed inside After Effects,
 * but "Allow Scripts to Write Files and Access Network" must be enabled.
 */
export class ScriptBridge implements AeBridge {
  readonly name = "script";
  private readonly queue = new SerialQueue();
  private readonly workDir: string;
  private readonly defaultTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: ScriptBridgeOptions) {
    this.workDir = options.workDir ?? path.join(tmpdir(), "after-effects-mcp");
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
  }

  run(body: string, args: unknown, options: RunOptions = {}): Promise<unknown> {
    return this.queue.enqueue(() => this.runNow(body, args, options.timeoutMs ?? this.defaultTimeoutMs));
  }

  private async runNow(body: string, args: unknown, timeoutMs: number): Promise<unknown> {
    await mkdir(this.workDir, { recursive: true });
    const id = randomUUID();
    const jsxPath = path.join(this.workDir, `cmd-${id}.jsx`);
    const resultName = `res-${id}.json`;
    const resultPath = path.join(this.workDir, resultName);
    // ExtendScript's File accepts forward slashes on every platform.
    const partialPath = path.join(this.workDir, `res-${id}.partial`).replace(/\\/g, "/");

    // Write to a partial file then rename, so a half-written result is never read.
    const emit = `function (json) {
  var f = new File(${toJsxLiteral(partialPath)});
  f.encoding = "UTF-8";
  if (!f.open("w")) { return; }
  f.write(json);
  f.close();
  f.rename(${toJsxLiteral(resultName)});
}`;
    await writeFile(jsxPath, composeScript(body, args, emit), "utf8");

    try {
      let launchFailure: string | undefined;
      const { exited } = this.options.launcher(jsxPath);
      exited.then(
        ({ code, stderr }) => {
          if (code !== 0 && code !== null) launchFailure = stderr.trim() || `launcher exited with code ${code}`;
        },
        (err: Error) => {
          launchFailure = err.message;
        },
      );

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (existsSync(resultPath)) {
          const envelope = JSON.parse(await readFile(resultPath, "utf8")) as ScriptEnvelope;
          if (!envelope.ok) throw new AeScriptError(envelope.error ?? "Unknown After Effects error", envelope.line);
          return envelope.result;
        }
        if (launchFailure) throw new AeBridgeError(`Could not run the script in After Effects: ${launchFailure}`);
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      }
      throw new AeBridgeError(
        `After Effects did not answer within ${Math.round(timeoutMs / 1000)}s. Check that it is open, not showing a modal dialog, ` +
          `and that Preferences > Scripting & Expressions > "Allow Scripts to Write Files and Access Network" is on.`,
      );
    } finally {
      await Promise.all([jsxPath, resultPath, partialPath].map((p) => rm(p, { force: true })));
    }
  }
}

function spawnLauncher(command: string, args: string[]): ReturnType<Launcher> {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += String(d)));
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
  // The launcher may outlive this request (e.g. AfterFX.exe starting the app); don't hold the process open for it.
  child.unref();
  return { exited };
}

/** Picks the newest "Adobe After Effects <year>" entry in a directory. */
function newestAfterEffects(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const candidates = readdirSync(dir)
    .filter((n) => /^Adobe After Effects/.test(n))
    .sort((a, b) => (b.match(/\d{4}/)?.[0] ?? "").localeCompare(a.match(/\d{4}/)?.[0] ?? ""));
  return candidates[0];
}

export function macLauncher(appName?: string): Launcher {
  const name = appName ?? newestAfterEffects("/Applications");
  if (!name) {
    throw new AeBridgeError('No "Adobe After Effects" folder found in /Applications. Set AE_APP_NAME, e.g. "Adobe After Effects 2025".');
  }
  return (jsxPath) => {
    const escaped = jsxPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    // AppleScript gives up on a reply after two minutes by default, which a render easily exceeds.
    return spawnLauncher("osascript", [
      "-e", "with timeout of 86400 seconds",
      "-e", `tell application "${name}" to DoScriptFile "${escaped}"`,
      "-e", "end timeout",
    ]);
  };
}

export function windowsLauncher(afterFxPath?: string): Launcher {
  let exe = afterFxPath;
  if (!exe) {
    const root = path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Adobe");
    const folder = newestAfterEffects(root);
    if (folder) exe = path.join(root, folder, "Support Files", "AfterFX.exe");
  }
  if (!exe || !existsSync(exe)) {
    throw new AeBridgeError("AfterFX.exe not found. Set AE_PATH to its full path, e.g. C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\AfterFX.exe.");
  }
  const resolved = exe;
  return (jsxPath) => spawnLauncher(resolved, ["-r", jsxPath]);
}

export function defaultLauncher(env: NodeJS.ProcessEnv = process.env): Launcher {
  if (process.platform === "darwin") return macLauncher(env["AE_APP_NAME"]);
  if (process.platform === "win32") return windowsLauncher(env["AE_PATH"]);
  throw new AeBridgeError(
    `After Effects only runs on macOS and Windows, and this is ${process.platform}. Use --bridge simulator to try the server without it.`,
  );
}
