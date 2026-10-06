import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SimulatorBridge } from "../src/bridge/simulator.js";
import { createServer } from "../src/server.js";

export async function connectSimulator(): Promise<{ client: Client; bridge: SimulatorBridge }> {
  const bridge = new SimulatorBridge();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(bridge).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, bridge };
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
  json: any;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text: string }[];
  const text = content.map((c) => c.text).join("\n");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: res.isError === true, text, json };
}
