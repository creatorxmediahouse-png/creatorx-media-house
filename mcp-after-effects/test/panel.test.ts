import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http, { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";
import { parse } from "acorn";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AeBridge } from "../src/bridge/bridge.js";
import { AutoBridge, PanelBridge, readPanelConnection, type PanelConnection } from "../src/bridge/panel-bridge.js";
import { SimulatorBridge } from "../src/bridge/simulator.js";
import { createServer } from "../src/server.js";
import { call } from "./helpers.js";

const require = createRequire(import.meta.url);
const { createBridgeServer } = require("../extension/js/bridge-server.js") as {
  createBridgeServer(options: {
    http: typeof http;
    evalScript: (source: string) => Promise<string>;
    token: string;
    onCall?: (c: { ok: boolean; ms: number }) => void;
  }): http.Server;
};

const servers: http.Server[] = [];
after(() => servers.forEach((s) => s.close()));

/** Starts the panel's bridge with the simulator standing in for After Effects. */
async function startPanel(token = "panel-token") {
  const sim = new SimulatorBridge();
  const calls: boolean[] = [];
  const server = createBridgeServer({
    http,
    token,
    evalScript: async (source) => sim.evalScript(source),
    onCall: (c) => calls.push(c.ok),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const conn: PanelConnection = { port: (server.address() as AddressInfo).port, token };
  return { sim, conn, calls, server };
}

async function connectClient(bridge: AeBridge): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(bridge).connect(serverSide);
  const client = new Client({ name: "panel-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

function rawStatus(port: number, headers: Record<string, string>, pathName = "/health"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: pathName, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("panel extension files", () => {
  for (const file of ["bridge-server.js", "main.js"]) {
    it(`${file} only uses syntax After Effects' panel browser supports (ES2017)`, () => {
      const source = readFileSync(new URL(`../extension/js/${file}`, import.meta.url), "utf8");
      assert.doesNotThrow(() => parse(source, { ecmaVersion: 2017, sourceType: "script" }));
    });
  }

  it("has a manifest for After Effects with Node enabled", () => {
    const manifest = readFileSync(new URL("../extension/CSXS/manifest.xml", import.meta.url), "utf8");
    assert.match(manifest, /<Host Name="AEFT"/);
    assert.match(manifest, /--enable-nodejs/);
  });
});

describe("PanelBridge", () => {
  it("runs every kind of tool through the panel", async () => {
    const { conn, calls } = await startPanel();
    const client = await connectClient(new PanelBridge(() => conn));

    const comp = await call(client, "create_composition", { name: "Via panel" });
    assert.equal(comp.isError, false, comp.text);
    const layer = await call(client, "add_layer", { type: "text", text: "Hi" });
    assert.equal(layer.isError, false, layer.text);
    const keys = await call(client, "set_keyframes", {
      layerIndex: 1,
      property: "opacity",
      interpolation: "easyEase",
      keyframes: [
        { time: 0, value: 0 },
        { time: 1, value: 100 },
      ],
    });
    assert.equal(keys.isError, false, keys.text);
    const listed = await call(client, "list_compositions", { includeLayers: true });
    assert.equal(listed.json.compositions[0].layers[0].name, "Hi");
    assert.equal(calls.length, 4);
  });

  it("passes After Effects errors through", async () => {
    const { conn } = await startPanel();
    const client = await connectClient(new PanelBridge(() => conn));
    const res = await call(client, "add_layer", { compName: "Missing", type: "null" });
    assert.equal(res.isError, true);
    assert.match(res.text, /No composition named "Missing"/);
  });

  it("explains when the panel isn't running", async () => {
    const client = await connectClient(new PanelBridge(() => ({ port: 1, token: "x" })));
    const res = await call(client, "list_compositions");
    assert.equal(res.isError, true);
    assert.match(res.text, /Window > Extensions > After Effects MCP/);
  });

  it("rejects a wrong token and non-local hosts", async () => {
    const { conn } = await startPanel();
    assert.equal(await rawStatus(conn.port, { "x-aemcp-token": conn.token }), 200);
    assert.equal(await rawStatus(conn.port, { "x-aemcp-token": "nope" }), 401);
    assert.equal(await rawStatus(conn.port, { "x-aemcp-token": conn.token, host: "evil.example" }), 403);
    assert.equal(await new PanelBridge(() => ({ ...conn, token: "nope" })).isAvailable(), false);
    assert.equal(await new PanelBridge(() => conn).isAvailable(), true);
  });
});

describe("AutoBridge", () => {
  it("uses the panel when it answers", async () => {
    const { conn, calls } = await startPanel();
    const auto = new AutoBridge(new PanelBridge(() => conn), () => {
      throw new Error("fallback should not be used");
    });
    assert.deepEqual(await auto.run("return 41 + 1;", {}), 42);
    assert.equal(calls.length, 1);
  });

  it("falls back when the panel is down", async () => {
    const fallback = new SimulatorBridge();
    const auto = new AutoBridge(new PanelBridge(() => undefined), () => fallback);
    assert.equal(await auto.run("return 'fallback';", {}), "fallback");
    assert.equal(fallback.scripts.length, 1);
  });
});

describe("readPanelConnection", () => {
  it("reads the file the panel writes, and prefers environment variables", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "ae-panel-")), "panel.json");
    assert.equal(readPanelConnection({}, file), undefined);
    writeFileSync(file, JSON.stringify({ port: 8484, token: "abc" }));
    assert.deepEqual(readPanelConnection({}, file), { port: 8484, token: "abc" });
    assert.deepEqual(readPanelConnection({ AE_PANEL_PORT: "9000", AE_PANEL_TOKEN: "env" }, file), { port: 9000, token: "env" });
  });
});
