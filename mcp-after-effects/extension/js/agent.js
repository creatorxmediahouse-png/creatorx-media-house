/*
 * The panel's built-in chat: sends what the user types to the AI they picked
 * (Claude, ChatGPT, Gemini or any OpenAI-compatible service) with the After
 * Effects tools attached, runs each tool call through evalScript, and loops
 * until the AI has an answer.
 *
 * It talks to each provider's HTTP API directly (main.js does the sending)
 * rather than through their SDKs, because the panel runs on the Node.js built
 * into After Effects (Node 8 in After Effects 2019) with no build step.
 * ES2017 only, like bridge-server.js. Loads in the panel as window.AEMCPAgent
 * and in Node through require().
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AEMCPAgent = factory();
})(this, function () {
  "use strict";

  /**
   * api "anthropic" is the Claude Messages API; api "openai" is the Chat
   * Completions format, which OpenAI, Gemini, OpenRouter, Groq, Ollama and
   * many others accept.
   */
  var PROVIDERS = {
    anthropic: {
      label: "Claude (Anthropic)",
      api: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-opus-5-5",
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      keyHelp: "Create a key at console.anthropic.com → API Keys.",
    },
    openai: {
      label: "ChatGPT (OpenAI)",
      api: "openai",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-5",
      prefer: /^gpt-\d/,
      keyHelp: "Create a key at platform.openai.com → API keys. A ChatGPT Plus subscription doesn't include API use.",
    },
    gemini: {
      label: "Gemini (Google)",
      api: "openai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      defaultModel: "gemini-2.5-flash",
      prefer: /^gemini-.*(pro|flash)/,
      keyHelp: "Create a free key at aistudio.google.com → Get API key.",
    },
    custom: {
      label: "Other (OpenAI-compatible)",
      api: "openai",
      baseUrl: "",
      defaultModel: "",
      keyOptional: true,
      keyHelp:
        "Any service with an OpenAI-compatible API: OpenRouter, Groq, DeepSeek, Mistral, or Ollama on this computer " +
        "(address http://localhost:11434/v1, no key needed).",
    },
  };
  var DEFAULT_PROVIDER = "anthropic";
  var MAX_STEPS = 40;
  var RETRY_DELAYS_MS = [2000, 6000];

  var SYSTEM_PROMPT = [
    "You are an AI assistant working inside Adobe After Effects, in a panel next to the user's project.",
    "You change the project directly with the tools you have, so do the work rather than describing how to do it.",
    "Look at the project with list_compositions before changing it, unless you already know what is there.",
    "Times are in seconds, colors are [r, g, b] from 0 to 1, opacity and scale are percentages, and layer indexes start at 1 (the top layer).",
    "Use run_script for anything the other tools don't cover. It runs ExtendScript, which is ECMAScript 3.",
    "Every tool call is one undo step, so the user can press Cmd+Z or Ctrl+Z to undo what you did.",
    "Reply in a sentence or two saying what changed. The panel is small, so skip headings and long lists.",
  ].join("\n");

  /** JSON is valid ES3 literal syntax apart from these two line terminators. */
  function toJsxLiteral(value) {
    var json = JSON.stringify(value);
    if (json === undefined) json = "null";
    return json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }

  /** Same program as composeScript() in src/jsx/compose.ts, returning the envelope to evalScript. */
  function composeScript(prelude, body, args) {
    return [
      "(function () {",
      prelude,
      "var __emit = function (json) { return json; };",
      "var __main = function (args) {",
      body,
      "};",
      "var __res;",
      "try {",
      "  __res = { ok: true, result: __main(" + toJsxLiteral(args) + ") };",
      "} catch (e) {",
      "  __res = { ok: false, error: String(e && e.message ? e.message : e), line: e && e.line };",
      "}",
      "return __emit(AEMCP.stringify(__res));",
      "})();",
      "",
    ].join("\n");
  }

  /** Fills in top-level schema defaults, as the MCP server does with zod. */
  function applyDefaults(schema, input) {
    var args = {};
    var key;
    for (key in input) if (Object.prototype.hasOwnProperty.call(input, key)) args[key] = input[key];
    var props = (schema && schema.properties) || {};
    for (key in props) {
      if (args[key] === undefined && Object.prototype.hasOwnProperty.call(props[key], "default")) {
        args[key] = props[key].default;
      }
    }
    return args;
  }

  var PORTABLE_KEYWORDS = ["type", "description", "properties", "required", "items", "enum", "anyOf", "minItems", "maxItems"];

  /**
   * Keeps the JSON Schema keywords every OpenAI-compatible provider accepts.
   * Some (Gemini among them) reject keywords like exclusiveMinimum; After
   * Effects checks the values anyway.
   */
  function portableSchema(schema) {
    if (Array.isArray(schema)) return schema.map(portableSchema);
    if (!schema || typeof schema !== "object") return schema;
    var out = {};
    PORTABLE_KEYWORDS.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(schema, k)) return;
      if (k === "properties") {
        out.properties = {};
        Object.keys(schema.properties).forEach(function (p) { out.properties[p] = portableSchema(schema.properties[p]); });
      } else if (k === "items" || k === "anyOf") {
        out[k] = portableSchema(schema[k]);
      } else {
        out[k] = schema[k];
      }
    });
    ["minimum", "maximum"].forEach(function (k) {
      if (typeof schema[k] === "number" && Math.abs(schema[k]) < 1e9) out[k] = schema[k];
    });
    return out;
  }

  function trimSlash(url) {
    return String(url || "").replace(/\/+$/, "");
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function errorDetail(json) {
    var body = Array.isArray(json) ? json[0] : json;
    return body && body.error && body.error.message ? String(body.error.message) : "";
  }

  // ---- Provider formats ----

  var anthropicApi = {
    request: function (config, tools, messages) {
      return {
        method: "POST",
        url: trimSlash(config.baseUrl) + "/messages",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "server-side-fallback-2026-07-01",
        },
        body: {
          model: config.model,
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
          tools: tools.map(function (t) {
            return { name: t.name, description: t.description, input_schema: t.input_schema };
          }),
          messages: messages,
          output_config: { effort: "medium" },
          // If Claude declines on safety grounds, the API retries with a fallback model.
          fallbacks: "default",
          // Caches the tools, system prompt and history between steps.
          cache_control: { type: "ephemeral" },
        },
      };
    },
    user: function (text) {
      return { role: "user", content: text };
    },
    parse: function (json) {
      var content = json.content || [];
      var stop = json.stop_reason === "tool_use" ? "tool_use"
        : json.stop_reason === "refusal" ? "refusal"
        : json.stop_reason === "max_tokens" ? "max_tokens" : "end";
      return {
        message: { role: "assistant", content: content },
        texts: content.filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }),
        calls: content.filter(function (b) { return b.type === "tool_use"; }).map(function (b) {
          return { id: b.id, name: b.name, input: b.input || {} };
        }),
        stop: stop,
      };
    },
    results: function (results) {
      return [{
        role: "user",
        content: results.map(function (r) {
          return { type: "tool_result", tool_use_id: r.id, content: r.text, is_error: !r.ok };
        }),
      }];
    },
  };

  var openaiApi = {
    request: function (config, tools, messages) {
      var headers = { "content-type": "application/json" };
      if (config.apiKey) headers.authorization = "Bearer " + config.apiKey;
      return {
        method: "POST",
        url: trimSlash(config.baseUrl) + "/chat/completions",
        headers: headers,
        body: {
          model: config.model,
          messages: [{ role: "system", content: SYSTEM_PROMPT }].concat(messages),
          tools: tools.map(function (t) {
            return {
              type: "function",
              function: { name: t.name, description: t.description, parameters: portableSchema(t.input_schema) },
            };
          }),
        },
      };
    },
    user: function (text) {
      return { role: "user", content: text };
    },
    parse: function (json) {
      var choice = (json.choices && json.choices[0]) || {};
      var msg = choice.message || {};
      var toolCalls = msg.tool_calls || [];
      var message = { role: "assistant", content: msg.content || "" };
      if (toolCalls.length) message.tool_calls = toolCalls;
      var calls = toolCalls.map(function (c) {
        var input;
        var raw = c.function && c.function.arguments;
        try {
          input = typeof raw === "string" ? (raw.trim() ? JSON.parse(raw) : {}) : raw || {};
        } catch (e) {
          input = null;
        }
        return { id: c.id, name: c.function && c.function.name, input: input };
      });
      var finish = choice.finish_reason;
      return {
        message: message,
        texts: typeof msg.content === "string" ? [msg.content] : [],
        calls: calls,
        stop: calls.length ? "tool_use"
          : finish === "content_filter" ? "refusal"
          : finish === "length" ? "max_tokens" : "end",
      };
    },
    results: function (results) {
      return results.map(function (r) {
        return { role: "tool", tool_call_id: r.id, content: r.ok ? r.text : "Error: " + r.text };
      });
    },
  };

  function apiFor(provider) {
    return PROVIDERS[provider] && PROVIDERS[provider].api === "anthropic" ? anthropicApi : openaiApi;
  }

  /** Fills in the provider's address and model when the saved settings leave them out. */
  function resolveConfig(config) {
    var preset = PROVIDERS[config.provider] || PROVIDERS[DEFAULT_PROVIDER];
    return {
      provider: PROVIDERS[config.provider] ? config.provider : DEFAULT_PROVIDER,
      label: preset.label,
      apiKey: config.apiKey || "",
      baseUrl: config.baseUrl || preset.baseUrl,
      model: config.model || preset.defaultModel,
    };
  }

  /** What's missing before this provider can be used, or "" when it's ready. */
  function missingSetup(config) {
    var c = resolveConfig(config);
    var preset = PROVIDERS[c.provider];
    if (!c.apiKey && !preset.keyOptional) return "Add your " + preset.label + " API key under Settings first.";
    if (!c.baseUrl) return "Add the service's API address under Settings first.";
    if (!c.model) return "Pick a model under Settings first.";
    return "";
  }

  function errorMessage(config, status, json) {
    var detail = errorDetail(json);
    var who = config.label;
    if (status === 401) return "Your " + who + " API key was rejected. Check it under Settings.";
    if (status === 403) return "Your " + who + " API key can't use this model. " + detail;
    if (status === 404) return who + " doesn't know the model \"" + config.model + "\". Pick another under Settings. " + detail;
    if (status === 429) return who + " is rate limiting this key, or its credit has run out. " + detail;
    if (status === 529 || status >= 500) return who + " is busy right now. Try again in a moment.";
    return who + " returned an error (" + status + "). " + detail;
  }

  /** Asks an OpenAI-compatible provider which models this key can use. */
  async function listModels(send, rawConfig) {
    var config = resolveConfig(rawConfig);
    var preset = PROVIDERS[config.provider];
    if (preset.models) return { models: preset.models.slice(), suggested: preset.defaultModel };
    var headers = {};
    if (config.apiKey) headers.authorization = "Bearer " + config.apiKey;
    var res = await send({ method: "GET", url: trimSlash(config.baseUrl) + "/models", headers: headers });
    if (res.status !== 200) throw new Error(errorMessage(config, res.status, res.json));
    var ids = ((res.json && res.json.data) || [])
      .map(function (m) { return String(m.id).replace(/^models\//, ""); })
      .sort();
    var preferred = preset.prefer
      ? ids.filter(function (id) { return preset.prefer.test(id) && !/(^|-)(audio|realtime|search|image|tts|transcribe|embedding|vision|lite|mini|nano)(-|$)/.test(id); })
      : [];
    // Newest first: model names carry rising version numbers.
    preferred.sort(function (a, b) { return b.localeCompare(a, undefined, { numeric: true }); });
    // Keep a model the user chose; otherwise suggest the newest main model.
    var suggested = rawConfig.model && ids.indexOf(rawConfig.model) >= 0 ? rawConfig.model : preferred[0] || config.model || ids[0];
    return { models: ids, suggested: suggested };
  }

  /**
   * options.send({ method, url, headers, body }) makes an HTTP request and
   * resolves to { status, json }; it rejects only when the request couldn't be made.
   * options.getConfig() returns { provider, apiKey, model, baseUrl } for the next request.
   * options.evalScript(source) runs ExtendScript and resolves to its result string.
   * options.onEvent({ type, ... }) is told about text, tool calls and errors as they happen.
   */
  function createAgent(options) {
    var catalog = options.catalog;
    var byName = {};
    catalog.tools.forEach(function (t) { byName[t.name] = t; });
    var messages = [];
    var busy = false;
    var emit = options.onEvent || function () {};
    var wait = options.delay || delay;

    async function post(config, request) {
      for (var attempt = 0; ; attempt++) {
        var res;
        try {
          res = await options.send(request);
        } catch (err) {
          if (attempt < RETRY_DELAYS_MS.length) {
            await wait(RETRY_DELAYS_MS[attempt]);
            continue;
          }
          throw new Error("Couldn't reach " + config.label + ". Check your internet connection and the address under Settings. (" + err.message + ")");
        }
        if (res.status === 200 && res.json) return res.json;
        var retryable = res.status === 429 || res.status === 529 || res.status >= 500;
        if (retryable && attempt < RETRY_DELAYS_MS.length) {
          await wait(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw new Error(errorMessage(config, res.status, res.json));
      }
    }

    async function runTool(call) {
      var tool = byName[call.name];
      if (!tool) return { ok: false, text: "There is no tool called " + call.name + "." };
      if (!call.input || typeof call.input !== "object") return { ok: false, text: "The tool arguments weren't valid JSON." };
      var source = composeScript(catalog.prelude, tool.jsx, applyDefaults(tool.input_schema, call.input));
      var output = await options.evalScript(source);
      if (output === "EvalScript error." || output === undefined || output === null) {
        return { ok: false, text: "After Effects couldn't run the script. Check that no dialog is open in After Effects." };
      }
      var envelope;
      try {
        envelope = JSON.parse(output);
      } catch (e) {
        return { ok: false, text: "After Effects returned something unexpected: " + String(output).slice(0, 200) };
      }
      if (!envelope.ok) {
        return { ok: false, text: envelope.error + (envelope.line ? " (line " + envelope.line + ")" : "") };
      }
      return { ok: true, text: JSON.stringify(envelope.result === undefined ? null : envelope.result) };
    }

    async function ask(text) {
      if (busy) throw new Error("The AI is still working on the last request.");
      busy = true;
      var config = resolveConfig(options.getConfig());
      var api = apiFor(config.provider);
      var start = messages.length;
      messages.push(api.user(text));
      try {
        for (var step = 0; step < MAX_STEPS; step++) {
          var turn = api.parse(await post(config, api.request(config, catalog.tools, messages)));

          if (turn.stop === "refusal") {
            messages.length = start;
            emit({ type: "error", text: config.label + " declined this request. Try rephrasing it." });
            return;
          }

          messages.push(turn.message);
          turn.texts.forEach(function (t) {
            if (t && t.trim()) emit({ type: "text", text: t });
          });

          if (turn.stop !== "tool_use") {
            if (turn.stop === "max_tokens") emit({ type: "error", text: "The reply was cut off. Ask it to continue." });
            return;
          }

          // After Effects runs one script at a time, so the calls run in order.
          var results = [];
          for (var i = 0; i < turn.calls.length; i++) {
            var call = turn.calls[i];
            var title = byName[call.name] ? byName[call.name].title : call.name;
            emit({ type: "tool", name: call.name, title: title, input: call.input });
            var outcome = await runTool(call);
            emit({ type: "tool_result", name: call.name, title: title, ok: outcome.ok, text: outcome.text });
            results.push({ id: call.id, ok: outcome.ok, text: outcome.text });
          }
          Array.prototype.push.apply(messages, api.results(results));
        }
        emit({ type: "error", text: "The AI took more than " + MAX_STEPS + " steps, so the panel stopped it. Ask it to carry on." });
      } catch (err) {
        // If the AI never answered, drop the question so it isn't merged into the next one.
        // Otherwise keep the turn: it ends with tool results, which is a valid place to resume.
        if (messages.length === start + 1) messages.length = start;
        emit({ type: "error", text: err.message });
      } finally {
        busy = false;
      }
    }

    return {
      ask: ask,
      reset: function () { messages = []; },
      isBusy: function () { return busy; },
      get messages() { return messages; },
    };
  }

  return {
    createAgent: createAgent,
    listModels: listModels,
    resolveConfig: resolveConfig,
    missingSetup: missingSetup,
    composeScript: composeScript,
    applyDefaults: applyDefaults,
    portableSchema: portableSchema,
    PROVIDERS: PROVIDERS,
    DEFAULT_PROVIDER: DEFAULT_PROVIDER,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
  };
});
