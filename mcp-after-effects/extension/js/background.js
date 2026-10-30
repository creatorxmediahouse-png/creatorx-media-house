/*
 * Hidden helper extension. Starts with After Effects, runs the bridge that AI
 * apps reach After Effects through, and records its port and token in
 * ~/.after-effects-mcp/panel.json, where the MCP server looks for them.
 *
 * It lives apart from the visible panel so the user can close the panel without
 * cutting off AI apps, and so After Effects doesn't reopen the panel every time
 * it comes to the front. The panel talks to it with CEP events:
 * - com.creatorx.aemcp.command  panel -> here: { action: "status" | "start" | "stop", port }
 * - com.creatorx.aemcp.state    here -> panel: the status, call count and activity log
 * ES2017 only (see bridge-server.js).
 */
(function () {
  "use strict";

  var nodeRequire = (window.cep_node && window.cep_node.require) || window.require;
  var http = nodeRequire("http");
  var fs = nodeRequire("fs");
  var os = nodeRequire("os");
  var path = nodeRequire("path");
  var crypto = nodeRequire("crypto");

  var CONFIG_DIR = path.join(os.homedir(), ".after-effects-mcp");
  var CONFIG_FILE = path.join(CONFIG_DIR, "panel.json");
  var DEFAULT_PORT = 8484;
  var COMMAND_EVENT = "com.creatorx.aemcp.command";
  var STATE_EVENT = "com.creatorx.aemcp.state";

  var cep = window.__adobe_cep__;
  var server = null;

  function readConfig() {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch (e) {
      return {};
    }
  }

  function writeConfig() {
    // CEP 9 ships Node 8, whose mkdirSync has no `recursive` option.
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR);
    // Only this user should be able to read the token.
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 384 });
    fs.chmodSync(CONFIG_FILE, 384);
  }

  var config = readConfig();
  if (!config.token) config.token = crypto.randomBytes(24).toString("hex");
  if (!config.port) config.port = DEFAULT_PORT;

  var state = { state: "off", text: "Starting…", detail: "", running: false, port: config.port, calls: 0, log: [] };

  function broadcast() {
    var event = { type: STATE_EVENT, scope: "APPLICATION", appId: "", extensionId: "", data: JSON.stringify(state) };
    try {
      event.appId = JSON.parse(cep.getHostEnvironment()).appId;
      event.extensionId = cep.getExtensionId();
    } catch (e) {
      // Older hosts route the event without these.
    }
    cep.dispatchEvent(event);
  }

  function setStatus(name, text, detail, running) {
    state.state = name;
    state.text = text;
    state.detail = detail || "";
    state.running = !!running;
    broadcast();
  }

  function log(text, bad) {
    state.log.unshift({ time: new Date().toLocaleTimeString(), at: Date.now(), text: text, bad: !!bad });
    if (state.log.length > 30) state.log.length = 30;
    broadcast();
  }

  function evalScript(source) {
    return new Promise(function (resolve) {
      cep.evalScript(source, resolve);
    });
  }

  /** Resolves true when the bridge on this port answers with our token. */
  function ownBridgeRunning(port) {
    return new Promise(function (resolve) {
      var req = http.get(
        { hostname: "127.0.0.1", port: port, path: "/health", headers: { "x-aemcp-token": config.token } },
        function (res) {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );
      req.setTimeout(2000, function () { req.destroy(); });
      req.on("error", function () { resolve(false); });
    });
  }

  function start(port) {
    if (server) return;
    port = parseInt(port, 10) || config.port || DEFAULT_PORT;
    state.port = port;
    server = AEMCPBridge.createBridgeServer({
      http: http,
      evalScript: evalScript,
      token: config.token,
      onCall: function (call) {
        state.calls++;
        log(call.ok ? "Ran a tool (" + call.ms + " ms)" : "A tool failed (" + call.ms + " ms)", !call.ok);
      },
    });
    server.on("error", function (err) {
      server = null;
      if (err.code !== "EADDRINUSE") {
        setStatus("error", "Not running", err.message);
        log(err.message, true);
        return;
      }
      // An older copy of the panel may still hold the port until After Effects restarts.
      ownBridgeRunning(port).then(function (ours) {
        if (ours) {
          setStatus("on", "Ready for AI clients", "Another copy of the bridge is running on 127.0.0.1:" + port + ". Restart After Effects to clear it.");
          log("Bridge already running on port " + port);
        } else {
          var msg = "Port " + port + " is in use. Pick another and press Start.";
          setStatus("error", "Not running", msg);
          log(msg, true);
        }
      });
    });
    server.listen(port, "127.0.0.1", function () {
      config.port = port;
      writeConfig();
      setStatus("on", "Ready for AI clients", "Listening on 127.0.0.1:" + port, true);
      log("Bridge started on port " + port);
    });
  }

  function stop() {
    if (!server) return;
    server.close();
    server = null;
    setStatus("off", "Stopped", "AI clients can't reach After Effects until you press Start.");
    log("Bridge stopped");
  }

  cep.addEventListener(COMMAND_EVENT, function (event) {
    var command = event && event.data;
    if (typeof command === "string") {
      try {
        command = JSON.parse(command);
      } catch (e) {
        command = {};
      }
    }
    command = command || {};
    if (command.action === "start") start(command.port);
    else if (command.action === "stop") stop();
    else broadcast();
  });

  start(config.port);
})();
