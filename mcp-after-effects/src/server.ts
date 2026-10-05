import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AeBridge } from "./bridge/bridge.js";
import { TOOLS } from "./tools.js";

export const SERVER_NAME = "after-effects-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(bridge: AeBridge): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Controls a running Adobe After Effects. Start with list_compositions to see the project. " +
        "Times are in seconds, colors are RGB arrays from 0 to 1, and layer indexes start at 1.",
    },
  );

  for (const tool of TOOLS) {
    const schema = z.object(tool.inputSchema);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly ?? false, destructiveHint: false, openWorldHint: false },
      },
      async (rawArgs: unknown) => {
        // The SDK has already validated; parsing again applies schema defaults in one place.
        const args = schema.parse(rawArgs ?? {}) as Record<string, unknown>;
        try {
          const result = await bridge.run(tool.jsx, args, { timeoutMs: tool.timeoutMs?.(args) });
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { isError: true, content: [{ type: "text" as const, text: message }] };
        }
      },
    );
  }

  return server;
}
