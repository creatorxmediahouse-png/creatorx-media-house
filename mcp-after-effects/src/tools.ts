import { z } from "zod";

/**
 * One MCP tool backed by an ExtendScript body. `jsx` is the inside of
 * `function (args) { ... }` (ES3 only, see jsx/prelude.ts) and its return
 * value becomes the tool result.
 */
export interface AeTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  jsx: string;
  readOnly?: boolean;
  timeoutMs?: (args: Record<string, unknown>) => number | undefined;
}

const compRef = {
  compId: z.number().int().optional().describe("Composition id from list_compositions. Takes precedence over compName."),
  compName: z
    .string()
    .optional()
    .describe("Composition name. If neither compId nor compName is given, the active composition is used."),
};

const layerRef = {
  layerIndex: z.number().int().min(1).optional().describe("1-based layer index (1 is the top layer)."),
  layerName: z.string().optional().describe("Layer name, used when layerIndex is not given."),
};

const rgb = z.array(z.number().min(0).max(1)).length(3).describe("RGB color, each channel 0 to 1.");

const listCompositions: AeTool = {
  name: "list_compositions",
  title: "List compositions",
  description: "List every composition in the open After Effects project, with size, duration and frame rate.",
  readOnly: true,
  inputSchema: {
    includeLayers: z.boolean().optional().describe("Also list each composition's layers."),
  },
  jsx: String.raw`
    var proj = app.project;
    var comps = [];
    for (var i = 1; i <= proj.numItems; i++) {
      var it = proj.item(i);
      if (it instanceof CompItem) { comps.push(AEMCP.compInfo(it, args.includeLayers === true)); }
    }
    var active = proj.activeItem instanceof CompItem ? proj.activeItem.id : null;
    return { projectFile: proj.file ? proj.file.fsName : null, activeCompId: active, compositions: comps };
  `,
};

const createComposition: AeTool = {
  name: "create_composition",
  title: "Create composition",
  description: "Create a new composition in the open project.",
  inputSchema: {
    name: z.string().min(1),
    width: z.number().int().min(4).max(30000).default(1920),
    height: z.number().int().min(4).max(30000).default(1080),
    duration: z.number().positive().max(10800).default(10).describe("Length in seconds."),
    frameRate: z.number().min(1).max(999).default(30),
    pixelAspect: z.number().min(0.01).max(100).default(1),
    bgColor: rgb.optional(),
    open: z.boolean().default(true).describe("Open the new composition in the viewer."),
  },
  jsx: String.raw`
    app.beginUndoGroup("MCP: Create composition");
    try {
      var comp = app.project.items.addComp(args.name, args.width, args.height, args.pixelAspect, args.duration, args.frameRate);
      if (AEMCP.has(args, "bgColor")) { comp.bgColor = args.bgColor; }
      if (args.open) { comp.openInViewer(); }
      return AEMCP.compInfo(comp, false);
    } finally {
      app.endUndoGroup();
    }
  `,
};

const addLayer: AeTool = {
  name: "add_layer",
  title: "Add layer",
  description:
    "Add a layer to a composition: solid, text, shape (rectangle or ellipse), null, adjustment, camera, light, or imported footage from a file path.",
  inputSchema: {
    ...compRef,
    type: z.enum(["solid", "text", "shape", "null", "adjustment", "camera", "light", "footage"]),
    name: z.string().optional().describe("Layer name. Defaults to After Effects' own naming."),
    color: rgb.optional().describe("Solid color, shape fill, or text fill. Defaults to white."),
    text: z.string().optional().describe("Text content, for text layers."),
    fontSize: z.number().positive().optional().describe("Font size in pixels, for text layers."),
    shape: z.enum(["rectangle", "ellipse"]).optional().describe("Shape to draw, for shape layers. Defaults to rectangle."),
    size: z
      .array(z.number().positive())
      .length(2)
      .optional()
      .describe("[width, height] in pixels for solids and shapes. Defaults to the composition size (shapes: half of it)."),
    filePath: z.string().optional().describe("Absolute path of the file to import, for footage layers."),
    startTime: z.number().optional().describe("Layer start time in seconds."),
  },
  jsx: String.raw`
    var comp = AEMCP.findComp(args);
    var color = AEMCP.has(args, "color") ? args.color : [1, 1, 1];
    var w = AEMCP.has(args, "size") ? args.size[0] : comp.width;
    var h = AEMCP.has(args, "size") ? args.size[1] : comp.height;
    var center = [comp.width / 2, comp.height / 2];
    var layer;
    app.beginUndoGroup("MCP: Add layer");
    try {
      if (args.type === "solid" || args.type === "adjustment") {
        var solidName = AEMCP.has(args, "name") ? args.name : (args.type === "adjustment" ? "Adjustment Layer" : "Solid");
        layer = comp.layers.addSolid(color, solidName, w, h, comp.pixelAspect, comp.duration);
        if (args.type === "adjustment") { layer.adjustmentLayer = true; }
      } else if (args.type === "text") {
        layer = comp.layers.addText(AEMCP.has(args, "text") ? args.text : "Text");
        if (AEMCP.has(args, "fontSize") || AEMCP.has(args, "color")) {
          var sourceText = layer.property("ADBE Text Properties").property("ADBE Text Document");
          var doc = sourceText.value;
          if (AEMCP.has(args, "fontSize")) { doc.fontSize = args.fontSize; }
          if (AEMCP.has(args, "color")) { doc.applyFill = true; doc.fillColor = args.color; }
          sourceText.setValue(doc);
        }
      } else if (args.type === "shape") {
        layer = comp.layers.addShape();
        var sw = AEMCP.has(args, "size") ? args.size[0] : comp.width / 2;
        var sh = AEMCP.has(args, "size") ? args.size[1] : comp.height / 2;
        var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
        var contents = group.property("ADBE Vectors Group");
        if (args.shape === "ellipse") {
          contents.addProperty("ADBE Vector Shape - Ellipse").property("ADBE Vector Ellipse Size").setValue([sw, sh]);
        } else {
          contents.addProperty("ADBE Vector Shape - Rect").property("ADBE Vector Rect Size").setValue([sw, sh]);
        }
        contents.addProperty("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue([color[0], color[1], color[2], 1]);
        layer.property("ADBE Transform Group").property("ADBE Position").setValue(center);
      } else if (args.type === "null") {
        layer = comp.layers.addNull(comp.duration);
      } else if (args.type === "camera") {
        layer = comp.layers.addCamera(AEMCP.has(args, "name") ? args.name : "Camera", center);
      } else if (args.type === "light") {
        layer = comp.layers.addLight(AEMCP.has(args, "name") ? args.name : "Light", center);
      } else if (args.type === "footage") {
        if (!AEMCP.has(args, "filePath")) { throw new Error("filePath is required for footage layers."); }
        var file = new File(args.filePath);
        if (!file.exists) { throw new Error("File not found: " + args.filePath); }
        var item = app.project.importFile(new ImportOptions(file));
        layer = comp.layers.add(item);
      } else {
        throw new Error("Unknown layer type: " + args.type);
      }
      if (AEMCP.has(args, "name")) { layer.name = args.name; }
      if (AEMCP.has(args, "startTime")) { layer.startTime = args.startTime; }
      return { compId: comp.id, compName: comp.name, layer: AEMCP.layerInfo(layer) };
    } finally {
      app.endUndoGroup();
    }
  `,
};

const keyframeValue = z
  .union([z.number(), z.array(z.number()).min(1).max(4), z.string()])
  .describe("A number (opacity, rotation), an array ([x, y] position, [x, y, z] scale), or a string for Source Text.");

const setKeyframes: AeTool = {
  name: "set_keyframes",
  title: "Set keyframes",
  description:
    "Set one or more keyframes on a layer property. Common properties have short names: position, scale, rotation, opacity, anchorPoint, sourceText. " +
    'Anything else takes a path of property names or match names separated by "/", e.g. "Effects/Gaussian Blur/Blurriness". ' +
    "Opacity and scale are percentages (100 = full).",
  inputSchema: {
    ...compRef,
    ...layerRef,
    property: z.string().min(1),
    keyframes: z
      .array(z.object({ time: z.number().min(0).describe("Time in seconds."), value: keyframeValue }))
      .min(1),
    interpolation: z
      .enum(["linear", "bezier", "easyEase", "hold"])
      .optional()
      .describe("Interpolation applied to the keyframes set here. Defaults to After Effects' own (linear)."),
  },
  jsx: String.raw`
    var comp = AEMCP.findComp(args);
    var layer = AEMCP.findLayer(comp, args);
    var aliases = {
      position: ["ADBE Transform Group", "ADBE Position"],
      scale: ["ADBE Transform Group", "ADBE Scale"],
      rotation: ["ADBE Transform Group", "ADBE Rotate Z"],
      opacity: ["ADBE Transform Group", "ADBE Opacity"],
      anchorpoint: ["ADBE Transform Group", "ADBE Anchor Point"],
      sourcetext: ["ADBE Text Properties", "ADBE Text Document"]
    };
    var key = args.property.toLowerCase().replace(/[\s_-]/g, "");
    var path = aliases.hasOwnProperty(key) ? aliases[key] : args.property.split("/");
    var prop = layer;
    for (var i = 0; i < path.length; i++) {
      var next = prop.property(path[i]);
      if (!next) { throw new Error("Property \"" + path[i] + "\" not found on layer \"" + layer.name + "\" (path: " + path.join(" / ") + ")."); }
      prop = next;
    }
    if (prop.propertyType !== PropertyType.PROPERTY) { throw new Error("\"" + args.property + "\" is a property group, not a property."); }
    if (!prop.canVaryOverTime) { throw new Error("\"" + prop.name + "\" cannot be keyframed."); }

    var isText = prop.propertyValueType === PropertyValueType.TEXT_DOCUMENT;
    var spatial = prop.propertyValueType === PropertyValueType.TwoD_SPATIAL || prop.propertyValueType === PropertyValueType.ThreeD_SPATIAL;
    var interp = null;
    if (args.interpolation === "linear") { interp = KeyframeInterpolationType.LINEAR; }
    else if (args.interpolation === "hold") { interp = KeyframeInterpolationType.HOLD; }
    else if (args.interpolation === "bezier" || args.interpolation === "easyEase") { interp = KeyframeInterpolationType.BEZIER; }

    app.beginUndoGroup("MCP: Set keyframes");
    try {
      for (var k = 0; k < args.keyframes.length; k++) {
        var kf = args.keyframes[k];
        var value = kf.value;
        if (isText) {
          var doc = prop.valueAtTime(kf.time, false);
          doc.text = String(value);
          value = doc;
        }
        prop.setValueAtTime(kf.time, value);
        // Source Text keyframes are always hold keyframes, so interpolation doesn't apply.
        if (interp !== null && !isText) {
          var idx = prop.nearestKeyIndex(kf.time);
          prop.setInterpolationTypeAtKey(idx, interp, interp);
          if (args.interpolation === "easyEase") {
            var current = prop.keyValue(idx);
            var dims = spatial ? 1 : (AEMCP.isArray(current) ? current.length : 1);
            var ease = [];
            for (var d = 0; d < dims; d++) { ease.push(new KeyframeEase(0, 33.33)); }
            prop.setTemporalEaseAtKey(idx, ease, ease);
          }
        }
      }
    } finally {
      app.endUndoGroup();
    }
    var keys = [];
    for (var n = 1; n <= prop.numKeys; n++) {
      var v = prop.keyValue(n);
      keys.push({ time: prop.keyTime(n), value: isText ? v.text : v });
    }
    return { layer: layer.name, property: prop.name, matchName: prop.matchName, keyframes: keys };
  `,
};

const addToRenderQueue: AeTool = {
  name: "add_to_render_queue",
  title: "Add to render queue",
  description:
    "Add a composition to the render queue, optionally with an output file path and render settings / output module templates. " +
    "The result lists the template names available in this After Effects install.",
  inputSchema: {
    ...compRef,
    outputPath: z.string().optional().describe("Absolute path of the file to render to. The extension should match the output module."),
    renderSettingsTemplate: z.string().optional().describe('e.g. "Best Settings".'),
    outputModuleTemplate: z.string().optional().describe('e.g. "High Quality" or "H.264 - Match Render Settings - 15 Mbps".'),
  },
  jsx: String.raw`
    var comp = AEMCP.findComp(args);
    var rq = app.project.renderQueue;
    var item = rq.items.add(comp);
    var om = item.outputModule(1);
    try {
      if (AEMCP.has(args, "renderSettingsTemplate")) { item.applyTemplate(args.renderSettingsTemplate); }
      if (AEMCP.has(args, "outputModuleTemplate")) { om.applyTemplate(args.outputModuleTemplate); }
      if (AEMCP.has(args, "outputPath")) { om.file = new File(args.outputPath); }
    } catch (e) {
      // Don't leave a half-configured item behind in the queue.
      var available = "Render settings: " + item.templates.join(", ") + ". Output modules: " + om.templates.join(", ") + ".";
      item.remove();
      throw new Error(e.message + " " + available);
    }
    var info = AEMCP.rqItemInfo(item, rq.numItems);
    info.renderSettingsTemplates = item.templates;
    info.outputModuleTemplates = om.templates;
    return info;
  `,
};

const getRenderQueue: AeTool = {
  name: "get_render_queue",
  title: "Get render queue",
  description: "List the items in the render queue with their status and output files.",
  readOnly: true,
  inputSchema: {},
  jsx: String.raw`
    var rq = app.project.renderQueue;
    var items = [];
    for (var i = 1; i <= rq.numItems; i++) { items.push(AEMCP.rqItemInfo(rq.item(i), i)); }
    return { rendering: rq.rendering, items: items };
  `,
};

const startRender: AeTool = {
  name: "start_render",
  title: "Start render",
  description:
    "Render every queued item in the render queue. By default After Effects renders in place and this call waits until it finishes " +
    "(After Effects is busy meanwhile). With useMediaEncoder the queue is handed to Adobe Media Encoder and the call returns right away.",
  inputSchema: {
    useMediaEncoder: z.boolean().default(false),
    timeoutSeconds: z.number().int().positive().default(3600).describe("How long to wait for an in-place render."),
  },
  timeoutMs: (args) => (args["useMediaEncoder"] ? undefined : Number(args["timeoutSeconds"]) * 1000),
  jsx: String.raw`
    var rq = app.project.renderQueue;
    var queued = 0;
    for (var i = 1; i <= rq.numItems; i++) {
      if (rq.item(i).status === RQItemStatus.QUEUED) { queued++; }
    }
    if (queued === 0) { throw new Error("Nothing is queued. Add a composition with add_to_render_queue first."); }
    if (args.useMediaEncoder) {
      rq.queueInAME(true);
    } else {
      rq.render();
    }
    var items = [];
    for (var j = 1; j <= rq.numItems; j++) { items.push(AEMCP.rqItemInfo(rq.item(j), j)); }
    return { mode: args.useMediaEncoder ? "mediaEncoder" : "afterEffects", queuedBefore: queued, items: items };
  `,
};

export const TOOLS: AeTool[] = [
  listCompositions,
  createComposition,
  addLayer,
  setKeyframes,
  addToRenderQueue,
  getRenderQueue,
  startRender,
];
