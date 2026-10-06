import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { composeScript, type ScriptEnvelope } from "../jsx/compose.js";
import { AeBridgeError, AeScriptError, SerialQueue, type AeBridge, type RunOptions } from "./bridge.js";

/** Where the After Effects panel records how to reach it. */
export const PANEL_CONFIG_FILE = path.join(homedir(), ".after-effects-mcp", "panel.json");

export interface PanelConnection {
  port: number;
  token: string;
}

export function readPanelConnection(
  env: NodeJS.ProcessEnv = process.env,
  file: string = PANEL_CONFIG_FILE,
): PanelConnection | undefined {
  if (env["AE_PANEL_PORT"] && env["AE_PANEL_TOKEN"]) {
    return { port: Number(env["AE_PANEL_PORT"]), token: env["AE_PANEL_TOKEN"] };
  }
  try {
    const config = JSON.parse(readFileSync(file, "utf8")) as Partial<PanelConnection>;
    if (typeof config.port === "number" && typeof config.token === "string") return { port: config.port, token: config.token };
  } catch {
    // No panel installed yet.
  }
  return undefined;
}

export const PANEL_NOT_RUNNING =
  'The After Effects MCP panel isn\'t reachable. Open After Effects and check Window > Extensions > After Effects MCP says "Ready".';

/**
 * Talks to After Effects through the "After Effects MCP" panel extension,
 * which runs each script with CEP's evalScript. Faster than the script
 * bridge, and needs neither macOS Automation permission nor the
 * "Allow Scripts to Write Files" preference.
 */
export class PanelBridge implements AeBridge {
  readonly name = "panel";
  private readonly queue = new SerialQueue();

  constructor(
    private readonly connect: () => PanelConnection | undefined = () => readPanelConnection(),
    private readonly defaultTimeoutMs = 60_000,
  ) {}

  /** True when the panel answers. Used to pick a bridge automatically. */
  async isAvailable(): Promise<boolean> {
    const conn = this.connect();
    if (!conn) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${conn.port}/health`, {
        headers: { "x-aemcp-token": conn.token },
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  run(body: string, args: unknown, options: RunOptions = {}): Promise<unknown> {
    return this.queue.enqueue(() => this.runNow(body, args, options.timeoutMs ?? this.defaultTimeoutMs));
  }

  private async runNow(body: string, args: unknown, timeoutMs: number): Promise<unknown> {
    // Re-read each time: the panel may have been restarted on another port.
    const conn = this.connect();
    if (!conn) throw new AeBridgeError(PANEL_NOT_RUNNING);

    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${conn.port}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-aemcp-token": conn.token },
        body: JSON.stringify({ script: composeScript(body, args, "function (json) { return json; }") }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new AeBridgeError(`After Effects did not answer within ${Math.round(timeoutMs / 1000)}s. Check it isn't showing a dialog.`);
      }
      throw new AeBridgeError(PANEL_NOT_RUNNING);
    }

    const reply = (await res.json().catch(() => ({}))) as { output?: string; error?: string };
    if (!res.ok) throw new AeBridgeError(`The After Effects panel refused the request: ${reply.error ?? res.status}`);
    if (reply.output === undefined || reply.output === "EvalScript error.") {
      throw new AeScriptError("After Effects could not run the script.");
    }
    const envelope = JSON.parse(reply.output) as ScriptEnvelope;
    if (!envelope.ok) throw new AeScriptError(envelope.error ?? "Unknown After Effects error", envelope.line);
    return envelope.result;
  }
}

/**
 * Uses the panel when it is running, otherwise falls back to running scripts
 * through the operating system (if that is possible on this machine).
 */
export class AutoBridge implements AeBridge {
  readonly name = "auto";

  constructor(
    private readonly panel: PanelBridge,
    private readonly fallback: (() => AeBridge) | undefined,
  ) {}

  private fallbackBridge: AeBridge | undefined;

  async run(body: string, args: unknown, options?: RunOptions): Promise<unknown> {
    if (await this.panel.isAvailable()) return this.panel.run(body, args, options);
    if (!this.fallback) throw new AeBridgeError(PANEL_NOT_RUNNING);
    this.fallbackBridge ??= this.fallback();
    return this.fallbackBridge.run(body, args, options);
  }
}
