import { PRELUDE } from "./prelude.js";

/** JSON is valid ES3 literal syntax apart from these two line terminators. */
export function toJsxLiteral(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Wraps a tool body in a self-contained ES3 program.
 *
 * `body` is the inside of `function (args) { ... }` and returns the tool's
 * result. `emit` is the source of a `function (json) { ... }` expression that
 * hands the serialized `{ ok, result | error }` envelope back to the bridge.
 * Everything lives inside one IIFE so nothing leaks into After Effects' global
 * scope between calls.
 */
export function composeScript(body: string, args: unknown, emit: string): string {
  return [
    "(function () {",
    PRELUDE,
    "var __emit = " + emit + ";",
    "var __main = function (args) {",
    body,
    "};",
    "var __res;",
    "try {",
    "  __res = { ok: true, result: __main(" + toJsxLiteral(args) + ") };",
    "} catch (e) {",
    "  __res = { ok: false, error: String(e && e.message ? e.message : e), line: e && e.line };",
    "}",
    "__emit(AEMCP.stringify(__res));",
    "})();",
    "",
  ].join("\n");
}

export interface ScriptEnvelope {
  ok: boolean;
  result?: unknown;
  error?: string;
  line?: number;
}
