import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";
import { parse } from "acorn";
import { AeBridgeError, AeScriptError } from "../src/bridge/bridge.js";
import { ScriptBridge, type Launcher } from "../src/bridge/script-bridge.js";
import { TOOLS } from "../src/tools.js";

/** ExtendScript's File, backed by the real disk, as far as the bridge's emit function uses it. */
class DiskFile {
  encoding = "BINARY";
  private buffer = "";
  constructor(private filePath: string) {}
  open(_mode: string): boolean {
    return true;
  }
  write(s: string): void {
    this.buffer += s;
  }
  close(): void {
    writeFileSync(this.filePath, this.buffer, "utf8");
  }
  rename(newName: string): boolean {
    assert.ok(!newName.includes("/") && !newName.includes("\\"), "File.rename takes a bare name");
    renameSync(this.filePath, path.join(path.dirname(this.filePath), newName));
    return true;
  }
}

class CompItem {}

/** Pretends to be After Effects: runs the .jsx file it is handed against an empty project. */
function runLikeAfterEffects(jsxPath: string, onDone: () => void = () => {}): ReturnType<Launcher> {
  const source = readFileSync(jsxPath, "utf8");
  parse(source, { ecmaVersion: 3 });
  const app = { project: { numItems: 0, activeItem: null, file: null, item: () => undefined } };
  setTimeout(() => {
    vm.runInNewContext(source, { app, CompItem, File: DiskFile });
    onDone();
  }, 20);
  return { exited: Promise.resolve({ code: 0, stderr: "" }) };
}
const fakeAfterEffects: Launcher = (jsxPath) => runLikeAfterEffects(jsxPath);

const listCompositions = TOOLS.find((t) => t.name === "list_compositions")!;

function bridgeWith(launcher: Launcher, workDir = mkdtempSync(path.join(tmpdir(), "ae-mcp-test-"))) {
  return { bridge: new ScriptBridge({ launcher, workDir, pollIntervalMs: 10 }), workDir };
}

describe("ScriptBridge", () => {
  it("runs a script through the launcher and reads back its result file", async () => {
    const { bridge, workDir } = bridgeWith(fakeAfterEffects);
    const result = await bridge.run(listCompositions.jsx, {});
    assert.deepEqual(result, { projectFile: null, activeCompId: null, compositions: [] });
    assert.deepEqual(readdirSync(workDir), [], "temporary files are cleaned up");
  });

  it("round-trips unicode and quotes through the result file", async () => {
    const { bridge } = bridgeWith(fakeAfterEffects);
    const tricky = 'Ünïcödé "quoted" \\ back\nslash \u2028 ✨';
    const result = await bridge.run("return { echo: args.s };", { s: tricky });
    assert.deepEqual(result, { echo: tricky });
  });

  it("surfaces errors thrown inside After Effects", async () => {
    const { bridge } = bridgeWith(fakeAfterEffects);
    await assert.rejects(bridge.run('throw new Error("comp is locked");', {}), (err: unknown) => {
      assert.ok(err instanceof AeScriptError);
      assert.equal(err.message, "comp is locked");
      return true;
    });
  });

  it("runs calls one at a time", async () => {
    let running = 0;
    let maxRunning = 0;
    const tracking: Launcher = (jsxPath) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      return runLikeAfterEffects(jsxPath, () => running--);
    };
    const { bridge } = bridgeWith(tracking);
    await Promise.all([1, 2, 3].map((n) => bridge.run("return args.n;", { n })));
    assert.equal(maxRunning, 1);
  });

  it("reports a launcher failure", async () => {
    const failing: Launcher = () => ({ exited: Promise.resolve({ code: 1, stderr: "Application isn't running." }) });
    const { bridge } = bridgeWith(failing);
    await assert.rejects(bridge.run("return 1;", {}), (err: unknown) => {
      assert.ok(err instanceof AeBridgeError);
      assert.match(err.message, /Application isn't running/);
      return true;
    });
  });

  it("times out when After Effects never answers", async () => {
    const silent: Launcher = () => ({ exited: new Promise(() => {}) });
    const { bridge } = bridgeWith(silent);
    await assert.rejects(bridge.run("return 1;", {}, { timeoutMs: 100 }), /did not answer/);
  });
});
