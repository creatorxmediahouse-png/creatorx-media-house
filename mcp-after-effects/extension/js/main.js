/*
 * Panel UI. Three jobs:
 * - The chat: the user asks an AI for something and agent.js carries it out here.
 * - The bridge status: the bridge itself runs in the hidden helper extension
 *   (background.js), so closing this panel doesn't cut off AI apps. This panel
 *   shows its status and can stop or restart it.
 * - Closing: the × button closes the panel until the user opens it again from
 *   Window > Extensions.
 * ES2017 only (see bridge-server.js).
 */
(function () {
  "use strict";

  var nodeRequire = (window.cep_node && window.cep_node.require) || window.require;
  var http = nodeRequire("http");
  var https = nodeRequire("https");
  var Buffer = nodeRequire("buffer").Buffer;
  var fs = nodeRequire("fs");
  var os = nodeRequire("os");
  var path = nodeRequire("path");

  var CONFIG_DIR = path.join(os.homedir(), ".after-effects-mcp");
  var CHAT_FILE = path.join(CONFIG_DIR, "chat.json");
  var BRIDGE_ID = "com.creatorx.aemcp.bridge";
  var COMMAND_EVENT = "com.creatorx.aemcp.command";
  var STATE_EVENT = "com.creatorx.aemcp.state";

  var $ = function (id) { return document.getElementById(id); };
  var cep = window.__adobe_cep__;

  function readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      return {};
    }
  }

  function writeJson(file, value) {
    // CEP 9 ships Node 8, whose mkdirSync has no `recursive` option.
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR);
    // Only this user should be able to read the API keys.
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 384 });
    fs.chmodSync(file, 384);
  }

  function evalScript(source) {
    return new Promise(function (resolve) {
      window.__adobe_cep__.evalScript(source, resolve);
    });
  }

  // ---- Bridge status ----

  var bridge = null;
  var chatLog = [];

  function sendCommand(command) {
    var event = { type: COMMAND_EVENT, scope: "APPLICATION", appId: "", extensionId: "", data: JSON.stringify(command) };
    try {
      event.appId = JSON.parse(cep.getHostEnvironment()).appId;
      event.extensionId = cep.getExtensionId();
    } catch (e) {
      // Older hosts route the event without these.
    }
    cep.dispatchEvent(event);
  }

  function renderLog() {
    var entries = chatLog.concat(bridge ? bridge.log : []);
    entries.sort(function (x, y) { return y.at - x.at; });
    var list = $("log");
    list.innerHTML = "";
    entries.slice(0, 30).forEach(function (entry) {
      var li = document.createElement("li");
      li.textContent = entry.time + "  " + entry.text;
      if (entry.bad) li.className = "bad";
      list.appendChild(li);
    });
  }

  function log(text, bad) {
    chatLog.unshift({ time: new Date().toLocaleTimeString(), at: Date.now(), text: text, bad: !!bad });
    if (chatLog.length > 30) chatLog.length = 30;
    renderLog();
  }

  function showBridge(next) {
    bridge = next;
    $("dot").className = "dot " + bridge.state;
    $("status").textContent = bridge.text;
    $("detail").textContent = bridge.detail || "";
    $("toggle").textContent = bridge.running ? "Stop" : "Start";
    $("toggle").className = bridge.running ? "secondary" : "";
    if (document.activeElement !== $("port")) $("port").value = String(bridge.port);
    $("calls").textContent = String(bridge.calls);
    renderLog();
  }

  cep.addEventListener(STATE_EVENT, function (event) {
    var data = event && event.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (e) {
        return;
      }
    }
    if (data) showBridge(data);
  });

  $("toggle").addEventListener("click", function () {
    if (bridge && bridge.running) sendCommand({ action: "stop" });
    else sendCommand({ action: "start", port: $("port").value });
  });

  // Make sure the helper is running (it normally starts with After Effects), then ask for its status.
  try {
    cep.requestOpenExtension(BRIDGE_ID, "");
  } catch (e) {
    // Hosts without this call start the helper from the manifest.
  }
  sendCommand({ action: "status" });
  setTimeout(function () { if (!bridge) sendCommand({ action: "status" }); }, 1000);
  setTimeout(function () {
    if (bridge) return;
    $("dot").className = "dot error";
    $("status").textContent = "Bridge not running";
    $("detail").textContent = "Restart After Effects. If this stays, run the installer again.";
  }, 4000);

  $("close").addEventListener("click", function () {
    // Only the panel closes. AI apps can still reach After Effects through the helper.
    cep.closeExtension();
  });

  // ---- Chat ----

  var Agent = AEMCPAgent;
  var PROVIDERS = Agent.PROVIDERS;

  /**
   * chat.json: { provider, providers: { <id>: { apiKey, model, baseUrl } } }.
   * Older versions saved a single Claude key as { apiKey, model }.
   */
  var chat = readJson(CHAT_FILE);
  if (!chat.providers) {
    chat = { provider: Agent.DEFAULT_PROVIDER, providers: chat.apiKey ? { anthropic: { apiKey: chat.apiKey, model: chat.model } } : {} };
  }
  if (!PROVIDERS[chat.provider]) chat.provider = Agent.DEFAULT_PROVIDER;

  function saveChat() {
    writeJson(CHAT_FILE, chat);
  }

  function current() {
    if (!chat.providers[chat.provider]) chat.providers[chat.provider] = {};
    return chat.providers[chat.provider];
  }

  function currentConfig() {
    var p = current();
    return { provider: chat.provider, apiKey: p.apiKey, model: p.model, baseUrl: p.baseUrl };
  }

  function send(request) {
    return new Promise(function (resolve, reject) {
      var url = new URL(request.url);
      var data = request.body === undefined ? null : JSON.stringify(request.body);
      var headers = Object.assign({}, request.headers);
      if (data !== null) headers["content-length"] = Buffer.byteLength(data);
      var lib = url.protocol === "http:" ? http : https;
      var req = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: request.method,
          headers: headers,
        },
        function (res) {
          var chunks = [];
          res.on("data", function (c) { chunks.push(c); });
          res.on("end", function () {
            var json = null;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch (e) {
              // Leave json null; the status code explains the failure.
            }
            resolve({ status: res.statusCode, json: json });
          });
        }
      );
      req.setTimeout(600000, function () { req.destroy(new Error("timed out")); });
      req.on("error", reject);
      if (data !== null) req.end(data);
      else req.end();
    });
  }

  function addMessage(kind, text) {
    var welcome = $("welcome");
    if (welcome) welcome.parentNode.removeChild(welcome);
    var div = document.createElement("div");
    div.className = "msg " + kind;
    div.textContent = text;
    $("messages").appendChild(div);
    $("messages").scrollTop = $("messages").scrollHeight;
    return div;
  }

  var working = null;

  var agent = Agent.createAgent({
    catalog: AEMCPTools,
    getConfig: currentConfig,
    send: send,
    evalScript: evalScript,
    onEvent: function (event) {
      if (event.type === "text") addMessage("claude", event.text);
      else if (event.type === "tool") working = addMessage("step", "▸ " + event.title + "…");
      else if (event.type === "tool_result") {
        if (working) {
          working.textContent = (event.ok ? "✓ " : "✗ ") + event.title + (event.ok ? "" : ": " + event.text);
          if (!event.ok) working.className = "msg step bad";
        }
        log((event.ok ? "Chat ran " : "Chat tool failed: ") + event.name, !event.ok);
      } else if (event.type === "error") addMessage("error", event.text);
    },
  });

  function showUsing() {
    var c = Agent.resolveConfig(currentConfig());
    $("using").textContent = Agent.missingSetup(currentConfig()) ? "Set up an AI under Settings" : c.label + " · " + c.model;
  }

  function setBusy(busy) {
    $("send").disabled = busy;
    $("newChat").disabled = busy;
    $("send").textContent = busy ? "Working…" : "Send";
  }

  async function submit() {
    var text = $("prompt").value.trim();
    if (!text || agent.isBusy()) return;
    var missing = Agent.missingSetup(currentConfig());
    if (missing) {
      $("settings").open = true;
      addMessage("error", missing);
      return;
    }
    $("prompt").value = "";
    addMessage("user", text);
    var thinking = addMessage("thinking", "Working…");
    setBusy(true);
    try {
      await agent.ask(text);
    } finally {
      thinking.parentNode.removeChild(thinking);
      setBusy(false);
      $("prompt").focus();
    }
  }

  $("composer").addEventListener("submit", function (e) {
    e.preventDefault();
    submit();
  });
  $("prompt").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  function newChat(note) {
    agent.reset();
    $("messages").innerHTML = "";
    addMessage("note", note);
  }
  $("newChat").addEventListener("click", function () {
    newChat("New chat. The AI won't remember the earlier messages.");
  });

  // ---- Settings ----

  Object.keys(PROVIDERS).forEach(function (id) {
    var option = document.createElement("option");
    option.value = id;
    option.textContent = PROVIDERS[id].label;
    $("provider").appendChild(option);
  });

  function fillModels(models) {
    var list = $("modelList");
    list.innerHTML = "";
    models.forEach(function (id) {
      var option = document.createElement("option");
      option.value = id;
      list.appendChild(option);
    });
  }

  async function loadModels() {
    var preset = PROVIDERS[chat.provider];
    if (preset.models) {
      fillModels(preset.models);
      return;
    }
    if (Agent.missingSetup(Object.assign(currentConfig(), { model: "x" }))) return;
    $("modelHint").textContent = "Loading the models this key can use…";
    try {
      var found = await Agent.listModels(send, currentConfig());
      fillModels(found.models);
      if (!current().model && found.suggested) {
        current().model = found.suggested;
        $("model").value = found.suggested;
        saveChat();
        showUsing();
      }
      $("modelHint").textContent = found.models.length + " models available. Type to search.";
    } catch (err) {
      $("modelHint").textContent = err.message;
    }
  }

  function showSettings() {
    var preset = PROVIDERS[chat.provider];
    var p = current();
    $("provider").value = chat.provider;
    $("keyHelp").textContent = preset.keyHelp;
    $("apiKey").value = "";
    $("apiKey").placeholder = p.apiKey ? "Saved. Paste a new key to replace it." : preset.keyOptional ? "Key (if the service needs one)" : "Paste your API key";
    $("baseUrlRow").style.display = preset.baseUrl ? "none" : "";
    $("baseUrl").value = p.baseUrl || "";
    $("model").value = p.model || preset.defaultModel;
    $("modelHint").textContent = "";
    fillModels(preset.models || []);
    showUsing();
    loadModels();
  }

  $("provider").addEventListener("change", function () {
    chat.provider = $("provider").value;
    saveChat();
    showSettings();
    // Each AI keeps its own conversation format, so switching starts over.
    newChat("Now using " + PROVIDERS[chat.provider].label + ". This is a new chat.");
  });

  $("saveKey").addEventListener("click", function () {
    var p = current();
    var key = $("apiKey").value.trim();
    if (key) p.apiKey = key;
    if (!PROVIDERS[chat.provider].baseUrl) p.baseUrl = $("baseUrl").value.trim();
    saveChat();
    showSettings();
    var missing = Agent.missingSetup(currentConfig());
    if (!missing) {
      $("settings").open = false;
      addMessage("note", "Saved. Ask " + PROVIDERS[chat.provider].label + " something.");
    }
  });

  $("model").addEventListener("change", function () {
    current().model = $("model").value.trim();
    saveChat();
    showUsing();
  });

  showSettings();
  if (Agent.missingSetup(currentConfig())) $("settings").open = true;
})();
