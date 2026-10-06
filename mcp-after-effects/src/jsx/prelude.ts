/**
 * ExtendScript helpers shared by every tool script.
 *
 * After Effects runs ExtendScript, which is ECMAScript 3: no JSON object,
 * no Array.prototype.indexOf/forEach, no Object.keys, no let/const or arrow
 * functions. Everything here (and every tool body) must stay inside ES3.
 * The test suite parses each generated script as ES3 and runs it with those
 * built-ins removed to enforce this.
 */
export const PRELUDE = String.raw`
var AEMCP = {};

AEMCP.isArray = function (v) {
  return Object.prototype.toString.call(v) === "[object Array]";
};

AEMCP.quote = function (s) {
  var out = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c === '"') { out += '\\"'; }
    else if (c === "\\") { out += "\\\\"; }
    else if (c === "\n") { out += "\\n"; }
    else if (c === "\r") { out += "\\r"; }
    else if (c === "\t") { out += "\\t"; }
    else if (code < 32 || code === 8232 || code === 8233) {
      var h = code.toString(16);
      while (h.length < 4) { h = "0" + h; }
      out += "\\u" + h;
    }
    else { out += c; }
  }
  return out + '"';
};

AEMCP.stringify = function (v) {
  if (v === null || v === undefined) { return "null"; }
  var t = typeof v;
  if (t === "number") { return isFinite(v) ? String(v) : "null"; }
  if (t === "boolean") { return v ? "true" : "false"; }
  if (t === "string") { return AEMCP.quote(v); }
  if (t === "function") { return "null"; }
  var parts = [];
  var i;
  if (AEMCP.isArray(v)) {
    for (i = 0; i < v.length; i++) { parts.push(AEMCP.stringify(v[i])); }
    return "[" + parts.join(",") + "]";
  }
  for (var k in v) {
    if (Object.prototype.hasOwnProperty.call(v, k)) {
      var x = v[k];
      if (x === undefined || typeof x === "function") { continue; }
      parts.push(AEMCP.quote(k) + ":" + AEMCP.stringify(x));
    }
  }
  return "{" + parts.join(",") + "}";
};

AEMCP.has = function (args, key) {
  return args[key] !== undefined && args[key] !== null;
};

AEMCP.findComp = function (args) {
  var proj = app.project;
  var i, it;
  if (AEMCP.has(args, "compId")) {
    for (i = 1; i <= proj.numItems; i++) {
      it = proj.item(i);
      if (it instanceof CompItem && it.id === args.compId) { return it; }
    }
    throw new Error("No composition with id " + args.compId + ". Use list_compositions to see what exists.");
  }
  if (AEMCP.has(args, "compName")) {
    for (i = 1; i <= proj.numItems; i++) {
      it = proj.item(i);
      if (it instanceof CompItem && it.name === args.compName) { return it; }
    }
    throw new Error("No composition named \"" + args.compName + "\". Use list_compositions to see what exists.");
  }
  if (proj.activeItem && proj.activeItem instanceof CompItem) { return proj.activeItem; }
  throw new Error("No composition given and none is active in After Effects. Pass compId or compName.");
};

AEMCP.findLayer = function (comp, args) {
  var i;
  if (AEMCP.has(args, "layerIndex")) {
    if (args.layerIndex < 1 || args.layerIndex > comp.numLayers) {
      throw new Error("Layer index " + args.layerIndex + " is out of range; \"" + comp.name + "\" has " + comp.numLayers + " layers.");
    }
    return comp.layer(args.layerIndex);
  }
  if (AEMCP.has(args, "layerName")) {
    for (i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).name === args.layerName) { return comp.layer(i); }
    }
    throw new Error("No layer named \"" + args.layerName + "\" in \"" + comp.name + "\".");
  }
  throw new Error("Pass layerIndex or layerName.");
};

AEMCP.layerType = function (layer) {
  if (layer instanceof TextLayer) { return "text"; }
  if (layer instanceof ShapeLayer) { return "shape"; }
  if (layer instanceof CameraLayer) { return "camera"; }
  if (layer instanceof LightLayer) { return "light"; }
  if (layer.nullLayer) { return "null"; }
  if (layer.adjustmentLayer) { return "adjustment"; }
  if (layer.source && layer.source.mainSource instanceof SolidSource) { return "solid"; }
  return "footage";
};

AEMCP.layerInfo = function (layer) {
  return {
    index: layer.index,
    name: layer.name,
    type: AEMCP.layerType(layer),
    enabled: layer.enabled,
    inPoint: layer.inPoint,
    outPoint: layer.outPoint,
    startTime: layer.startTime
  };
};

AEMCP.compInfo = function (comp, includeLayers) {
  var info = {
    id: comp.id,
    name: comp.name,
    width: comp.width,
    height: comp.height,
    pixelAspect: comp.pixelAspect,
    duration: comp.duration,
    frameRate: comp.frameRate,
    numLayers: comp.numLayers,
    bgColor: comp.bgColor
  };
  if (includeLayers) {
    info.layers = [];
    for (var i = 1; i <= comp.numLayers; i++) { info.layers.push(AEMCP.layerInfo(comp.layer(i))); }
  }
  return info;
};

AEMCP.enumName = function (enumObj, value, names) {
  for (var i = 0; i < names.length; i++) {
    if (enumObj[names[i]] === value) { return names[i]; }
  }
  return String(value);
};

AEMCP.rqStatus = function (status) {
  return AEMCP.enumName(RQItemStatus, status, [
    "WILL_CONTINUE", "NEEDS_OUTPUT", "UNQUEUED", "QUEUED",
    "RENDERING", "USER_STOPPED", "ERR_STOPPED", "DONE"
  ]);
};

AEMCP.rqItemInfo = function (item, index) {
  var outputs = [];
  for (var i = 1; i <= item.numOutputModules; i++) {
    var om = item.outputModule(i);
    outputs.push({ index: i, file: om.file ? om.file.fsName : null });
  }
  return {
    index: index,
    compName: item.comp ? item.comp.name : null,
    status: AEMCP.rqStatus(item.status),
    render: item.render,
    outputs: outputs
  };
};
`;
