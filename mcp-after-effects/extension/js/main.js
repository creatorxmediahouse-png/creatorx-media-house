/*
 * Panel UI: starts the local bridge when After Effects starts and records its
 * port and token in ~/.after-effects-mcp/panel.json, where the MCP server
 * looks for them. ES2017 only (see bridge-server.js).
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

  var $ = function (id) { return document.getElementById(id); };
  var server = null;

  function readConfig() {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch (e) {
      return {};
    }
  }

  function writeConfig(config) {
    // CEP 9 ships Node 8, whose mkdirSync has no `recursive` option.
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR);
    // Only this user should be able to read the token.
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 384 });
  }

  var config = readConfig();
  if (!config.token) config.token = crypto.randomBytes(24).toString("hex");
  if (!config.port) config.port = DEFAULT_PORT;

  function evalScript(source) {
    return new Promise(function (resolve) {
      window.__adobe_cep__.evalScript(source, resolve);
    });
  }

  function setStatus(state, text, detail) {
    $("dot").className = "dot " + state;
    $("status").textContent = text;
    $("detail").textContent = detail || "";
    $("toggle").textContent = state === "on" ? "Stop" : "Start";
    $("toggle").className = state === "on" ? "secondary" : "";
  }

  function log(text, bad) {
    var li = document.createElement("li");
    li.textContent = new Date().toLocaleTimeString() + "  " + text;
    if (bad) li.className = "bad";
    var list = $("log");
    list.insertBefore(li, list.firstChild);
    while (list.children.length > 30) list.removeChild(list.lastChild);
  }

  function start() {
    var port = parseInt($("port").value, 10) || DEFAULT_PORT;
    var calls = 0;
    server = AEMCPBridge.createBridgeServer({
      http: http,
      evalScript: evalScript,
      token: config.token,
      onCall: function (call) {
        calls++;
        $("calls").textContent = String(calls);
        log(call.ok ? "Ran a tool (" + call.ms + " ms)" : "A tool failed (" + call.ms + " ms)", !call.ok);
      },
    });
    server.on("error", function (err) {
      server = null;
      var msg = err.code === "EADDRINUSE" ? "Port " + port + " is in use. Pick another and press Start." : err.message;
      setStatus("error", "Not running", msg);
      log(msg, true);
    });
    server.listen(port, "127.0.0.1", function () {
      config.port = port;
      writeConfig(config);
      setStatus("on", "Ready for AI clients", "Listening on 127.0.0.1:" + port);
      log("Bridge started on port " + port);
    });
  }

  function stop() {
    if (!server) return;
    server.close();
    server = null;
    setStatus("off", "Stopped", "AI clients can't reach After Effects through this panel.");
    log("Bridge stopped");
  }

  $("port").value = String(config.port);
  $("toggle").addEventListener("click", function () {
    if (server) stop();
    else start();
  });
  start();
})();
