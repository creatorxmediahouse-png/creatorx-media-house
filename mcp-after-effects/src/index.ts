#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AeBridge } from "./bridge/bridge.js";
import { AutoBridge, PanelBridge } from "./bridge/panel-bridge.js";
import { ScriptBridge, defaultLauncher } from "./bridge/script-bridge.js";
import { SimulatorBridge } from "./bridge/simulator.js";
import { startHttpServer } from "./http.js";
import { createServer } from "./server.js";

const USAGE = `after-effects-mcp: an MCP server for Adobe After Effects

Usage: after-effects-mcp [options]

  --transport <stdio|http>   How clients connect (default: stdio, or $MCP_TRANSPORT)
  --host <host>              HTTP bind address (default: 127.0.0.1, or $HOST)
  --port <port>              HTTP port (default: 3000, or $PORT)
  --bridge <auto|panel|script|simulator>
                             How to reach After Effects (default: auto, or $AE_BRIDGE).
                             auto: the After Effects MCP panel if it's running, else script.
                             panel: only the panel extension. script: run scripts via the OS.
                             simulator: an in-memory fake, for trying the server without it.
  --help

Environment:
  MCP_AUTH_TOKEN   Require this bearer token on HTTP requests
  AE_APP_NAME      macOS app name, e.g. "Adobe After Effects 2025" (auto-detected)
  AE_PATH          Windows path to AfterFX.exe (auto-detected)
  AE_TIMEOUT_MS    How long to wait for After Effects per call (default 60000)
  AE_PANEL_PORT, AE_PANEL_TOKEN
                   Reach the panel without reading ~/.after-effects-mcp/panel.json
`;

// stdout carries the stdio protocol, so all logging goes to stderr.
const log = (message: string) => process.stderr.write(`[after-effects-mcp] ${message}\n`);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      transport: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      bridge: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const env = process.env;
  const transport = values.transport ?? env["MCP_TRANSPORT"] ?? "stdio";
  const bridgeName = values.bridge ?? env["AE_BRIDGE"] ?? "auto";
  const timeout = Number(env["AE_TIMEOUT_MS"]);
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
  const scriptBridge = () => new ScriptBridge({ launcher: defaultLauncher(env), defaultTimeoutMs: timeoutMs });

  let bridge: AeBridge;
  if (bridgeName === "simulator") {
    bridge = new SimulatorBridge();
  } else if (bridgeName === "script") {
    bridge = scriptBridge();
  } else if (bridgeName === "panel") {
    bridge = new PanelBridge(undefined, timeoutMs);
  } else if (bridgeName === "auto") {
    bridge = new AutoBridge(new PanelBridge(undefined, timeoutMs), scriptBridge);
  } else {
    throw new Error(`Unknown bridge "${bridgeName}". Use auto, panel, script or simulator.`);
  }

  if (transport === "stdio") {
    await createServer(bridge).connect(new StdioServerTransport());
    log(`ready on stdio (bridge: ${bridge.name})`);
  } else if (transport === "http") {
    const host = values.host ?? env["HOST"] ?? "127.0.0.1";
    const port = Number(values.port ?? env["PORT"] ?? 3000);
    await startHttpServer(() => createServer(bridge), { host, port, authToken: env["MCP_AUTH_TOKEN"] || undefined, log });
    log(`ready at http://${host}:${port}/mcp (bridge: ${bridge.name}${env["MCP_AUTH_TOKEN"] ? ", token required" : ""})`);
  } else {
    throw new Error(`Unknown transport "${transport}". Use "stdio" or "http".`);
  }
}

main().catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
