import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SimulatorBridge } from "../src/bridge/simulator.js";
import { startHttpServer } from "../src/http.js";
import { createServer } from "../src/server.js";

async function start(authToken?: string) {
  const bridge = new SimulatorBridge();
  const server = await startHttpServer(() => createServer(bridge), { host: "127.0.0.1", port: 0, authToken });
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function connect(url: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: "http-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

describe("HTTP transport", () => {
  const servers: { close(): void }[] = [];
  after(() => servers.forEach((s) => s.close()));

  it("serves tools over Streamable HTTP and shares one After Effects across requests", async () => {
    const { server, base } = await start();
    servers.push(server);
    const client = await connect(`${base}/mcp`);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);

    await client.callTool({ name: "create_composition", arguments: { name: "Over HTTP" } });
    const second = await connect(`${base}/mcp`);
    const res = await second.callTool({ name: "list_compositions", arguments: {} });
    const text = (res.content as { text: string }[])[0]!.text;
    assert.equal(JSON.parse(text).compositions[0].name, "Over HTTP");
    await client.close();
    await second.close();
  });

  it("answers /health and rejects other paths and GET on /mcp", async () => {
    const { server, base } = await start();
    servers.push(server);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
  });

  it("rejects non-loopback Host headers when no token is set", async () => {
    const { server, base } = await start();
    servers.push(server);
    // fetch won't let us set Host, so use a raw request.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/mcp`, { method: "POST", headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(status, 403);
  });

  it("requires the token when one is set, by header or query", async () => {
    const { server, base } = await start("s3cret");
    servers.push(server);
    await assert.rejects(connect(`${base}/mcp`));
    await assert.rejects(connect(`${base}/mcp`, { authorization: "Bearer wrong" }));

    const byHeader = await connect(`${base}/mcp`, { authorization: "Bearer s3cret" });
    assert.equal((await byHeader.listTools()).tools.length, 7);
    const byQuery = await connect(`${base}/mcp?token=s3cret`);
    assert.equal((await byQuery.listTools()).tools.length, 7);
    await byHeader.close();
    await byQuery.close();
  });
});
