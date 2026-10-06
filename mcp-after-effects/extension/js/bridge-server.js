/*
 * Local HTTP bridge hosted by the After Effects panel. The MCP server sends a
 * ready-made ExtendScript program to POST /run; the panel runs it with CEP's
 * evalScript and returns the script's completion value.
 *
 * Runs inside After Effects' embedded Chromium/Node (CEP 9+), so it sticks to
 * ES2017 (no optional chaining or ?? operators). Loaded both by the panel and
 * by the Node test suite.
 */
(function () {
  "use strict";

  var LOOPBACK = { "127.0.0.1": true, localhost: true, "::1": true, "[::1]": true };
  var MAX_BODY = 5 * 1024 * 1024;

  /**
   * options.http         Node's http module
   * options.evalScript   function (source) -> Promise<string>
   * options.token        shared secret the MCP server must send
   * options.onCall       optional function ({ ok, ms }) for the panel's activity log
   */
  function createBridgeServer(options) {
    var queue = Promise.resolve();
    var calls = 0;

    // After Effects runs one script at a time.
    function enqueue(task) {
      var next = queue.then(task, task);
      queue = next.catch(function () {});
      return next;
    }

    function send(res, status, body) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    }

    var server = options.http.createServer(function (req, res) {
      var hostname = String(req.headers.host || "").replace(/:\d+$/, "");
      if (!LOOPBACK[hostname]) return send(res, 403, { error: "Only local connections are allowed." });
      if (req.headers["x-aemcp-token"] !== options.token) return send(res, 401, { error: "Wrong or missing token." });

      if (req.method === "GET" && req.url === "/health") {
        return send(res, 200, { ok: true, calls: calls });
      }
      if (req.method !== "POST" || req.url !== "/run") return send(res, 404, { error: "Not found." });

      var chunks = [];
      var size = 0;
      req.on("data", function (chunk) {
        size += chunk.length;
        if (size > MAX_BODY) {
          send(res, 413, { error: "Script too large." });
          req.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      req.on("end", function () {
        if (res.headersSent) return;
        var payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (e) {
          return send(res, 400, { error: "Body must be JSON." });
        }
        if (!payload || typeof payload.script !== "string") return send(res, 400, { error: "Missing script." });

        var started = Date.now();
        enqueue(function () {
          return options.evalScript(payload.script);
        }).then(
          function (output) {
            calls++;
            if (options.onCall) options.onCall({ ok: output !== "EvalScript error.", ms: Date.now() - started });
            send(res, 200, { output: String(output) });
          },
          function (err) {
            calls++;
            if (options.onCall) options.onCall({ ok: false, ms: Date.now() - started });
            send(res, 500, { error: String((err && err.message) || err) });
          }
        );
      });
    });

    return server;
  }

  var api = { createBridgeServer: createBridgeServer };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.AEMCPBridge = api;
})();
