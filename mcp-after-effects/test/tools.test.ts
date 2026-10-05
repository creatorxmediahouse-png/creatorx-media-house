import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "acorn";
import { SIM } from "../src/bridge/simulator.js";
import { composeScript } from "../src/jsx/compose.js";
import { TOOLS } from "../src/tools.js";
import { call, connectSimulator } from "./helpers.js";

describe("generated ExtendScript", () => {
  for (const tool of TOOLS) {
    it(`${tool.name} parses as ECMAScript 3`, () => {
      const script = composeScript(tool.jsx, { text: "line\u2028break \"quoted\"" }, "function (json) {}");
      assert.doesNotThrow(() => parse(script, { ecmaVersion: 3 }));
    });
  }
});

describe("tools against the simulator", () => {
  it("exposes the expected tools", async () => {
    const { client } = await connectSimulator();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["add_layer", "add_to_render_queue", "create_composition", "get_render_queue", "list_compositions", "set_keyframes", "start_render"],
    );
    assert.equal(tools.find((t) => t.name === "list_compositions")?.annotations?.readOnlyHint, true);
  });

  it("creates and lists compositions with defaults applied", async () => {
    const { client, bridge } = await connectSimulator();
    const empty = await call(client, "list_compositions");
    assert.deepEqual(empty.json.compositions, []);

    const created = await call(client, "create_composition", { name: "Intro \"v1\" ✨", bgColor: [0.1, 0.2, 0.3] });
    assert.equal(created.isError, false, created.text);
    assert.equal(created.json.name, "Intro \"v1\" ✨");
    assert.equal(created.json.width, 1920);
    assert.equal(created.json.frameRate, 30);
    assert.deepEqual(created.json.bgColor, [0.1, 0.2, 0.3]);
    assert.deepEqual(bridge.undoGroups, ["MCP: Create composition"]);

    const listed = await call(client, "list_compositions");
    assert.equal(listed.json.compositions.length, 1);
    assert.equal(listed.json.activeCompId, created.json.id);
  });

  it("adds every layer type", async () => {
    const { client } = await connectSimulator();
    await call(client, "create_composition", { name: "Main", width: 1280, height: 720 });
    const cases: [Record<string, unknown>, string][] = [
      [{ type: "solid", name: "BG", color: [1, 0, 0] }, "solid"],
      [{ type: "adjustment" }, "adjustment"],
      [{ type: "text", text: "Hello", fontSize: 96, color: [0, 1, 0] }, "text"],
      [{ type: "shape", shape: "ellipse", size: [200, 200] }, "shape"],
      [{ type: "null", name: "Controller" }, "null"],
      [{ type: "camera" }, "camera"],
      [{ type: "light", name: "Key" }, "light"],
      [{ type: "footage", filePath: "/footage/clip.mov" }, "footage"],
    ];
    for (const [args, type] of cases) {
      const res = await call(client, "add_layer", { compName: "Main", ...args });
      assert.equal(res.isError, false, `${type}: ${res.text}`);
      assert.equal(res.json.layer.type, type);
      assert.equal(res.json.layer.index, 1);
    }
    const listed = await call(client, "list_compositions", { includeLayers: true });
    const names = listed.json.compositions[0].layers.map((l: { name: string }) => l.name);
    assert.equal(names.length, cases.length);
    assert.ok(names.includes("BG") && names.includes("Controller") && names.includes("Hello"));
  });

  it("reports a missing composition or file as a tool error", async () => {
    const { client } = await connectSimulator();
    const noComp = await call(client, "add_layer", { compName: "Nope", type: "null" });
    assert.equal(noComp.isError, true);
    assert.match(noComp.text, /No composition named "Nope"/);

    await call(client, "create_composition", { name: "Main" });
    const noFile = await call(client, "add_layer", { type: "footage", filePath: "/missing.mov" });
    assert.equal(noFile.isError, true);
    assert.match(noFile.text, /File not found/);
  });

  it("sets keyframes by alias and by path, with interpolation", async () => {
    const { client, bridge } = await connectSimulator();
    await call(client, "create_composition", { name: "Main" });
    await call(client, "add_layer", { type: "solid", name: "Box" });

    const pos = await call(client, "set_keyframes", {
      layerName: "Box",
      property: "Position",
      interpolation: "easyEase",
      keyframes: [
        { time: 0, value: [0, 540] },
        { time: 2, value: [1920, 540] },
      ],
    });
    assert.equal(pos.isError, false, pos.text);
    assert.equal(pos.json.matchName, "ADBE Position");
    assert.deepEqual(pos.json.keyframes, [
      { time: 0, value: [0, 540] },
      { time: 2, value: [1920, 540] },
    ]);

    const opacity = await call(client, "set_keyframes", {
      layerIndex: 1,
      property: "Transform/Opacity",
      interpolation: "hold",
      keyframes: [{ time: 1, value: 50 }],
    });
    assert.equal(opacity.isError, false, opacity.text);

    const layer = bridge.project.item(1) as unknown as { layer(i: number): { property(n: string): { property(n: string): Record<string, (i: number) => unknown> } } };
    const opacityProp = layer.layer(1).property("ADBE Transform Group").property("ADBE Opacity");
    assert.equal(opacityProp.keyOutInterpolationType!(1), SIM.KeyframeInterpolationType.HOLD);
    const scale = await call(client, "set_keyframes", {
      layerIndex: 1,
      property: "scale",
      interpolation: "easyEase",
      keyframes: [{ time: 0, value: [50, 50, 100] }],
    });
    assert.equal(scale.isError, false, scale.text);
  });

  it("keyframes source text", async () => {
    const { client } = await connectSimulator();
    await call(client, "create_composition", { name: "Main" });
    await call(client, "add_layer", { type: "text", text: "One" });
    const res = await call(client, "set_keyframes", {
      layerName: "One",
      property: "sourceText",
      interpolation: "linear",
      keyframes: [
        { time: 0, value: "One" },
        { time: 1, value: "Two" },
      ],
    });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(
      res.json.keyframes.map((k: { value: string }) => k.value),
      ["One", "Two"],
    );
  });

  it("explains a bad property path", async () => {
    const { client } = await connectSimulator();
    await call(client, "create_composition", { name: "Main" });
    await call(client, "add_layer", { type: "null" });
    const res = await call(client, "set_keyframes", {
      layerIndex: 1,
      property: "Effects/Gaussian Blur/Blurriness",
      keyframes: [{ time: 0, value: 10 }],
    });
    assert.equal(res.isError, true);
    assert.match(res.text, /Property "Gaussian Blur" not found/);
  });

  it("queues and renders", async () => {
    const { client } = await connectSimulator();
    await call(client, "create_composition", { name: "Main" });

    const nothing = await call(client, "start_render");
    assert.equal(nothing.isError, true);

    const added = await call(client, "add_to_render_queue", {
      compName: "Main",
      outputPath: "/out/main.mp4",
      renderSettingsTemplate: "Best Settings",
      outputModuleTemplate: "H.264 - Match Render Settings - 15 Mbps",
    });
    assert.equal(added.isError, false, added.text);
    assert.equal(added.json.status, "QUEUED");
    assert.equal(added.json.outputs[0].file, "/out/main.mp4");
    assert.ok(added.json.outputModuleTemplates.includes("High Quality"));

    const badTemplate = await call(client, "add_to_render_queue", { compName: "Main", outputModuleTemplate: "Nope" });
    assert.equal(badTemplate.isError, true);
    assert.match(badTemplate.text, /Output modules: High Quality/);

    const rendered = await call(client, "start_render");
    assert.equal(rendered.isError, false, rendered.text);
    assert.equal(rendered.json.items[0].status, "DONE");

    const queue = await call(client, "get_render_queue");
    assert.equal(queue.json.items.length, 1);
  });
});
