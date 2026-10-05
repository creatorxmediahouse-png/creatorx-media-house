import vm from "node:vm";
import { composeScript, type ScriptEnvelope } from "../jsx/compose.js";
import { AeScriptError, SerialQueue, type AeBridge } from "./bridge.js";

/*
 * A small in-memory stand-in for the After Effects scripting DOM. It runs
 * the exact scripts the real bridge sends, in a sandbox stripped of every
 * built-in ExtendScript lacks, so the tools can be exercised (and an MCP
 * client can be wired up) on a machine without After Effects.
 * It models only what the tools touch.
 */

const PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 } as const;
const PropertyValueType = {
  NO_VALUE: 6412,
  ThreeD_SPATIAL: 6413,
  ThreeD: 6414,
  TwoD_SPATIAL: 6415,
  TwoD: 6416,
  OneD: 6417,
  COLOR: 6418,
  CUSTOM_VALUE: 6419,
  MARKER: 6420,
  LAYER_INDEX: 6421,
  MASK_INDEX: 6422,
  SHAPE: 6423,
  TEXT_DOCUMENT: 6424,
} as const;
const KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 } as const;
const RQItemStatus = {
  WILL_CONTINUE: 3012,
  NEEDS_OUTPUT: 3013,
  UNQUEUED: 3014,
  QUEUED: 3015,
  RENDERING: 3016,
  USER_STOPPED: 3017,
  ERR_STOPPED: 3018,
  DONE: 3019,
} as const;

type Value = unknown;

class KeyframeEase {
  constructor(
    readonly speed: number,
    readonly influence: number,
  ) {}
}

class TextDocument {
  fontSize = 72;
  applyFill = true;
  fillColor = [1, 1, 1];
  constructor(public text: string) {}
  clone(): TextDocument {
    return Object.assign(new TextDocument(this.text), this);
  }
}

abstract class PropertyBase {
  parentProperty: PropertyGroup | null = null;
  constructor(
    public name: string,
    readonly matchName: string,
  ) {}
  abstract readonly propertyType: number;
}

class Property extends PropertyBase {
  readonly propertyType = PropertyType.PROPERTY;
  canVaryOverTime = true;
  private keys: { time: number; value: Value; inInterp: number; outInterp: number; ease?: unknown[] }[] = [];

  constructor(
    name: string,
    matchName: string,
    readonly propertyValueType: number,
    private staticValue: Value,
  ) {
    super(name, matchName);
  }

  private copy(v: Value): Value {
    if (v instanceof TextDocument) return v.clone();
    return Array.isArray(v) ? [...v] : v;
  }

  private check(v: Value): void {
    if (this.propertyValueType === PropertyValueType.TEXT_DOCUMENT) {
      if (!(v instanceof TextDocument)) throw new Error("Value must be a TextDocument");
      return;
    }
    const dims =
      this.propertyValueType === PropertyValueType.OneD
        ? 0
        : this.propertyValueType === PropertyValueType.COLOR
          ? 4
          : [PropertyValueType.TwoD, PropertyValueType.TwoD_SPATIAL].includes(this.propertyValueType as 6416)
            ? 2
            : 3;
    if (dims === 0) {
      if (typeof v !== "number") throw new Error(`Bad argument - ${this.name} expects a number`);
    } else if (!Array.isArray(v) || v.length < 2 || v.length > dims || Array.from(v).some((x) => typeof x !== "number")) {
      throw new Error(`Bad argument - ${this.name} expects an array of ${dims} numbers`);
    }
  }

  get value(): Value {
    return this.copy(this.keys.length ? this.keys[0]!.value : this.staticValue);
  }
  get numKeys(): number {
    return this.keys.length;
  }
  setValue(v: Value): void {
    this.check(v);
    if (this.keys.length) throw new Error("Can't use setValue on a property with keyframes");
    this.staticValue = this.copy(v);
  }
  valueAtTime(time: number, _preExpression: boolean): Value {
    if (!this.keys.length) return this.copy(this.staticValue);
    let current = this.keys[0]!;
    for (const k of this.keys) if (k.time <= time) current = k;
    return this.copy(current.value);
  }
  setValueAtTime(time: number, v: Value): void {
    this.check(v);
    const existing = this.keys.find((k) => k.time === time);
    if (existing) existing.value = this.copy(v);
    else {
      const hold = KeyframeInterpolationType.HOLD;
      const isText = this.propertyValueType === PropertyValueType.TEXT_DOCUMENT;
      const interp = isText ? hold : KeyframeInterpolationType.LINEAR;
      this.keys.push({ time, value: this.copy(v), inInterp: interp, outInterp: interp });
      this.keys.sort((a, b) => a.time - b.time);
    }
  }
  private key(i: number) {
    const k = this.keys[i - 1];
    if (!k) throw new Error(`Keyframe index ${i} out of range`);
    return k;
  }
  keyTime(i: number): number {
    return this.key(i).time;
  }
  keyValue(i: number): Value {
    return this.copy(this.key(i).value);
  }
  keyInInterpolationType(i: number): number {
    return this.key(i).inInterp;
  }
  keyOutInterpolationType(i: number): number {
    return this.key(i).outInterp;
  }
  keyTemporalEase(i: number): unknown[] | undefined {
    return this.key(i).ease;
  }
  nearestKeyIndex(time: number): number {
    let best = 1;
    this.keys.forEach((k, i) => {
      if (Math.abs(k.time - time) < Math.abs(this.keys[best - 1]!.time - time)) best = i + 1;
    });
    return best;
  }
  setInterpolationTypeAtKey(i: number, inType: number, outType: number = inType): void {
    const k = this.key(i);
    k.inInterp = inType;
    k.outInterp = outType;
  }
  setTemporalEaseAtKey(i: number, inEase: unknown[], outEase: unknown[]): void {
    const current = this.key(i).value;
    const spatial = [PropertyValueType.TwoD_SPATIAL, PropertyValueType.ThreeD_SPATIAL].includes(this.propertyValueType as 6415);
    const dims = spatial || !Array.isArray(current) ? 1 : current.length;
    if (inEase.length !== dims || outEase.length !== dims) throw new Error(`Expected ${dims} KeyframeEase objects`);
    this.key(i).ease = inEase;
  }
}

class PropertyGroup extends PropertyBase {
  readonly propertyType: number = PropertyType.NAMED_GROUP;
  protected children: PropertyBase[] = [];
  constructor(
    name: string,
    matchName: string,
    private readonly factory: Record<string, () => PropertyBase> = {},
  ) {
    super(name, matchName);
  }
  add<T extends PropertyBase>(child: T): T {
    child.parentProperty = this;
    this.children.push(child);
    return child;
  }
  get numProperties(): number {
    return this.children.length;
  }
  property(ref: string | number): PropertyBase | null {
    if (typeof ref === "number") return this.children[ref - 1] ?? null;
    return this.children.find((c) => c.name === ref || c.matchName === ref) ?? null;
  }
  addProperty(matchName: string): PropertyBase {
    const make = this.factory[matchName];
    if (!make) throw new Error(`Can't add "${matchName}" to ${this.name}`);
    return this.add(make());
  }
}

function vectorGroup(): PropertyGroup {
  const contents = new PropertyGroup("Contents", "ADBE Vectors Group", {
    "ADBE Vector Shape - Rect": () => {
      const g = new PropertyGroup("Rectangle Path 1", "ADBE Vector Shape - Rect");
      g.add(new Property("Size", "ADBE Vector Rect Size", PropertyValueType.TwoD, [100, 100]));
      return g;
    },
    "ADBE Vector Shape - Ellipse": () => {
      const g = new PropertyGroup("Ellipse Path 1", "ADBE Vector Shape - Ellipse");
      g.add(new Property("Size", "ADBE Vector Ellipse Size", PropertyValueType.TwoD, [100, 100]));
      return g;
    },
    "ADBE Vector Graphic - Fill": () => {
      const g = new PropertyGroup("Fill 1", "ADBE Vector Graphic - Fill");
      g.add(new Property("Color", "ADBE Vector Fill Color", PropertyValueType.COLOR, [1, 0, 0, 1]));
      return g;
    },
  });
  const group = new PropertyGroup("Group 1", "ADBE Vector Group");
  group.add(contents);
  return group;
}

class Layer extends PropertyGroup {
  containingComp!: CompItem;
  enabled = true;
  inPoint = 0;
  outPoint: number;
  private _startTime = 0;
  nullLayer = false;
  adjustmentLayer = false;
  source: FootageItem | null = null;

  constructor(name: string, comp: CompItem, duration = comp.duration) {
    super(name, "ADBE AV Layer");
    this.containingComp = comp;
    this.outPoint = duration;
    const t = this.add(new PropertyGroup("Transform", "ADBE Transform Group"));
    t.add(new Property("Anchor Point", "ADBE Anchor Point", PropertyValueType.ThreeD_SPATIAL, [0, 0, 0]));
    t.add(new Property("Position", "ADBE Position", PropertyValueType.ThreeD_SPATIAL, [comp.width / 2, comp.height / 2, 0]));
    t.add(new Property("Scale", "ADBE Scale", PropertyValueType.ThreeD, [100, 100, 100]));
    t.add(new Property("Rotation", "ADBE Rotate Z", PropertyValueType.OneD, 0));
    t.add(new Property("Opacity", "ADBE Opacity", PropertyValueType.OneD, 100));
    this.add(new PropertyGroup("Effects", "ADBE Effect Parade"));
  }
  get index(): number {
    return this.containingComp.layers.indexOf(this);
  }
  get startTime(): number {
    return this._startTime;
  }
  set startTime(t: number) {
    const shift = t - this._startTime;
    this._startTime = t;
    this.inPoint += shift;
    this.outPoint += shift;
  }
}
class AVLayer extends Layer {}
class ShapeLayer extends AVLayer {
  constructor(comp: CompItem) {
    super("Shape Layer 1", comp);
    this.add(new PropertyGroup("Contents", "ADBE Root Vectors Group", { "ADBE Vector Group": vectorGroup }));
  }
}
class TextLayer extends AVLayer {
  constructor(comp: CompItem, text: string) {
    super(text, comp);
    const t = this.add(new PropertyGroup("Text", "ADBE Text Properties"));
    t.add(new Property("Source Text", "ADBE Text Document", PropertyValueType.TEXT_DOCUMENT, new TextDocument(text)));
  }
}
class CameraLayer extends Layer {}
class LightLayer extends Layer {}

class SolidSource {
  constructor(readonly color: number[]) {}
}
class FileSource {
  constructor(readonly file: SimFile) {}
}

class Item {
  private static nextId = 1;
  readonly id = Item.nextId++;
  constructor(public name: string) {}
}
class FootageItem extends Item {
  constructor(
    name: string,
    readonly mainSource: SolidSource | FileSource,
    readonly width: number,
    readonly height: number,
  ) {
    super(name);
  }
}

class LayerCollection {
  private list: Layer[] = [];
  constructor(private readonly comp: CompItem) {}
  get length(): number {
    return this.list.length;
  }
  at(i: number): Layer | undefined {
    return this.list[i - 1];
  }
  indexOf(layer: Layer): number {
    return this.list.indexOf(layer) + 1;
  }
  private push<T extends Layer>(layer: T): T {
    this.list.unshift(layer); // new layers go on top, like After Effects
    return layer;
  }
  addSolid(color: number[], name: string, width: number, height: number, _par: number, duration?: number): AVLayer {
    if (!Array.isArray(color) || color.length !== 3) throw new Error("Bad argument - color must be [r, g, b]");
    if (!(width >= 4 && height >= 4)) throw new Error("Bad argument - solid size out of range");
    const layer = new AVLayer(name, this.comp, duration);
    layer.source = new FootageItem(name, new SolidSource(color), width, height);
    return this.push(layer);
  }
  addText(text: string): TextLayer {
    return this.push(new TextLayer(this.comp, text));
  }
  addShape(): ShapeLayer {
    return this.push(new ShapeLayer(this.comp));
  }
  addNull(duration?: number): AVLayer {
    const layer = new AVLayer("Null 1", this.comp, duration);
    layer.nullLayer = true;
    return this.push(layer);
  }
  addCamera(name: string, _center: number[]): CameraLayer {
    return this.push(new CameraLayer(name, this.comp));
  }
  addLight(name: string, _center: number[]): LightLayer {
    return this.push(new LightLayer(name, this.comp));
  }
  add(item: Item): AVLayer {
    if (!(item instanceof FootageItem) && !(item instanceof CompItem)) throw new Error("Bad argument - not an AVItem");
    const layer = new AVLayer(item.name, this.comp);
    if (item instanceof FootageItem) layer.source = item;
    return this.push(layer);
  }
}

class CompItem extends Item {
  readonly layers = new LayerCollection(this);
  bgColor = [0, 0, 0];
  openedInViewer = false;
  constructor(
    name: string,
    readonly width: number,
    readonly height: number,
    readonly pixelAspect: number,
    readonly duration: number,
    readonly frameRate: number,
  ) {
    super(name);
  }
  get numLayers(): number {
    return this.layers.length;
  }
  layer(ref: number | string): Layer | null {
    if (typeof ref === "number") {
      const l = this.layers.at(ref);
      if (!l) throw new Error(`Layer index ${ref} out of range`);
      return l;
    }
    for (let i = 1; i <= this.layers.length; i++) if (this.layers.at(i)!.name === ref) return this.layers.at(i)!;
    return null;
  }
  openInViewer(): void {
    this.openedInViewer = true;
    project.activeItem = this;
  }
}

class SimFile {
  constructor(readonly path: string) {}
  get fsName(): string {
    return this.path;
  }
  get exists(): boolean {
    return !this.path.includes("missing");
  }
}

class ImportOptions {
  constructor(readonly file: SimFile) {}
}

class OutputModule {
  file: SimFile | null = null;
  template = "High Quality";
  readonly templates = ["High Quality", "High Quality with Alpha", "H.264 - Match Render Settings - 15 Mbps", "Lossless"];
  applyTemplate(name: string): void {
    if (!this.templates.includes(name)) throw new Error(`No output module template named "${name}"`);
    this.template = name;
  }
}

class RenderQueueItem {
  status: number = RQItemStatus.NEEDS_OUTPUT;
  render = true;
  template = "Best Settings";
  readonly templates = ["Best Settings", "Current Settings", "Draft Settings", "Multi-Machine Settings"];
  private readonly modules = [new OutputModule()];
  constructor(
    readonly comp: CompItem,
    private readonly queue: RenderQueue,
  ) {
    const om = this.modules[0]!;
    // After Effects fills in a default output file next to the project.
    om.file = new SimFile(`/renders/${comp.name}.mov`);
    this.status = RQItemStatus.QUEUED;
  }
  get numOutputModules(): number {
    return this.modules.length;
  }
  outputModule(i: number): OutputModule {
    const m = this.modules[i - 1];
    if (!m) throw new Error(`Output module ${i} out of range`);
    return m;
  }
  remove(): void {
    this.queue.removeItem(this);
  }
  applyTemplate(name: string): void {
    if (!this.templates.includes(name)) throw new Error(`No render settings template named "${name}"`);
    this.template = name;
  }
}

class RenderQueue {
  private list: RenderQueueItem[] = [];
  rendering = false;
  readonly items = {
    add: (comp: CompItem) => {
      if (!(comp instanceof CompItem)) throw new Error("Bad argument - not a CompItem");
      const item = new RenderQueueItem(comp, this);
      this.list.push(item);
      return item;
    },
  };
  get numItems(): number {
    return this.list.length;
  }
  removeItem(item: RenderQueueItem): void {
    this.list = this.list.filter((it) => it !== item);
  }
  item(i: number): RenderQueueItem {
    const it = this.list[i - 1];
    if (!it) throw new Error(`Render queue index ${i} out of range`);
    return it;
  }
  render(): void {
    for (const it of this.list) if (it.status === RQItemStatus.QUEUED) it.status = RQItemStatus.DONE;
  }
  queueInAME(_start: boolean): void {
    for (const it of this.list) if (it.status === RQItemStatus.QUEUED) it.status = RQItemStatus.UNQUEUED;
  }
}

class Project {
  private list: Item[] = [];
  activeItem: Item | null = null;
  file: SimFile | null = null;
  readonly renderQueue = new RenderQueue();
  readonly items = {
    addComp: (name: string, w: number, h: number, par: number, dur: number, fps: number) => {
      if (typeof name !== "string" || ![w, h, par, dur, fps].every((n) => typeof n === "number")) {
        throw new Error("Bad argument - addComp(name, width, height, pixelAspect, duration, frameRate)");
      }
      const comp = new CompItem(name, w, h, par, dur, fps);
      this.list.push(comp);
      return comp;
    },
  };
  get numItems(): number {
    return this.list.length;
  }
  item(i: number): Item {
    const it = this.list[i - 1];
    if (!it) throw new Error(`Item index ${i} out of range`);
    return it;
  }
  importFile(options: ImportOptions): FootageItem {
    const name = options.file.path.split(/[\\/]/).pop() ?? "footage";
    const item = new FootageItem(name, new FileSource(options.file), 1920, 1080);
    this.list.push(item);
    return item;
  }
}

let project = new Project();

/** ES5+ built-ins that ExtendScript doesn't have; removed so tool scripts can't depend on them. */
const STRIP_BUILTINS = `
  delete this.JSON;
  delete Object.keys; delete Object.create; delete Object.defineProperty; delete Object.freeze;
  delete Array.isArray;
  delete Array.prototype.indexOf; delete Array.prototype.lastIndexOf; delete Array.prototype.forEach;
  delete Array.prototype.map; delete Array.prototype.filter; delete Array.prototype.reduce;
  delete Array.prototype.some; delete Array.prototype.every; delete Array.prototype.includes;
  delete Array.prototype.find;
  delete String.prototype.trim; delete String.prototype.includes; delete String.prototype.startsWith;
  delete String.prototype.endsWith; delete String.prototype.padStart; delete String.prototype.repeat;
`;

export class SimulatorBridge implements AeBridge {
  readonly name = "simulator";
  private readonly queue = new SerialQueue();
  readonly undoGroups: string[] = [];
  /** Every script sent, for tests. */
  readonly scripts: string[] = [];

  constructor() {
    project = new Project();
  }

  get project(): Project {
    return project;
  }

  run(body: string, args: unknown): Promise<unknown> {
    return this.queue.enqueue(async () => {
      let emitted: string | undefined;
      const script = composeScript(body, args, "function (json) { __hostEmit(json); }");
      this.scripts.push(script);
      const app = {
        project,
        beginUndoGroup: (name: string) => this.undoGroups.push(name),
        endUndoGroup: () => undefined,
      };
      const context = vm.createContext({
        app,
        __hostEmit: (json: string) => (emitted = json),
        CompItem,
        FootageItem,
        AVLayer,
        TextLayer,
        ShapeLayer,
        CameraLayer,
        LightLayer,
        SolidSource,
        File: function SimFileCtor(p: string) {
          return new SimFile(p);
        },
        ImportOptions,
        KeyframeEase,
        PropertyType,
        PropertyValueType,
        KeyframeInterpolationType,
        RQItemStatus,
      });
      vm.runInContext(STRIP_BUILTINS, context);
      vm.runInContext(script, context, { filename: "tool.jsx", timeout: 5000 });
      if (emitted === undefined) throw new Error("Script finished without emitting a result");
      const envelope = JSON.parse(emitted) as ScriptEnvelope;
      if (!envelope.ok) throw new AeScriptError(envelope.error ?? "Unknown error", envelope.line);
      return envelope.result;
    });
  }
}

export const SIM = { PropertyValueType, KeyframeInterpolationType, RQItemStatus, TextDocument };
