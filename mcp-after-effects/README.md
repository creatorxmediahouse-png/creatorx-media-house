# After Effects MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and any other MCP client control Adobe After Effects: list and create compositions, add layers, set keyframes, and drive the render queue.

It speaks both MCP transports:

- **stdio** for desktop clients that launch the server themselves (Claude Desktop, Claude Code, Cursor, ...).
- **Streamable HTTP** at `/mcp` for clients that connect to a URL (ChatGPT connectors, remote agents, ...).

## How it talks to After Effects

There are two ways in. The server picks one automatically (`--bridge auto`).

1. **The After Effects MCP panel (recommended).** This is a small extension that runs inside After Effects and starts with it. It receives each tool's script over a private local connection and runs it directly. It's fast, it shows what the AI is doing, and it needs no extra permissions.
2. **Scripts through the operating system (fallback).** When the panel isn't running, each call becomes a `.jsx` file that the server asks After Effects to run. On macOS this goes through `osascript` → `DoScriptFile`, and on Windows through `AfterFX.exe -r <script>`. The script writes its result to a JSON file, which the server reads back.

Either way, calls are queued so After Effects only ever runs one at a time. Every change is wrapped in an undo group, so Ctrl/Cmd+Z undoes a tool call.

## Requirements

- Node.js 20 or newer, on the same machine as After Effects.
- After Effects 2019 or newer, open with a project.
- With the panel installed, that's all you need. Without the panel:
  - In After Effects, turn on **Settings/Preferences → Scripting & Expressions → Allow Scripts to Write Files and Access Network**.
  - On macOS, the first call asks to let your terminal (or Claude Desktop) control After Effects. Allow it under **System Settings → Privacy & Security → Automation**.

## Install

```bash
cd mcp-after-effects
npm install
npm run build
```

Install the After Effects panel:

```bash
npm run install-extension
```

Then restart After Effects and open **Window → Extensions → After Effects MCP**. The panel should say "Ready for AI clients". It starts with After Effects from then on. To remove it, run `npm run uninstall-extension`.

The panel isn't packaged as a signed `.zxp`. The install script copies it into Adobe's per-user extensions folder and turns on Adobe's `PlayerDebugMode` setting, which lets After Effects load unsigned panels. The panel listens only on `127.0.0.1`, on port 8484 by default (you can change it in the panel). It only accepts requests carrying the random token it saves in `~/.after-effects-mcp/panel.json`, a file that only your user account can read.

Try it without After Effects using the built-in simulator, which runs the same scripts against an in-memory fake:

```bash
node dist/index.js --bridge simulator --transport http
# MCP endpoint: http://127.0.0.1:3000/mcp
```

## Connect a client

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-after-effects/dist/index.js"]
    }
  }
}
```

On Windows use a path like `"C:\\Users\\you\\creatorx-media-house\\mcp-after-effects\\dist\\index.js"`.

### Claude Code

```bash
claude mcp add after-effects -- node /absolute/path/to/mcp-after-effects/dist/index.js
```

### ChatGPT and other URL-based clients

Run the HTTP transport with a token:

```bash
MCP_AUTH_TOKEN=choose-a-long-random-string node dist/index.js --transport http --port 3000
```

ChatGPT connects from OpenAI's servers, so it needs a public HTTPS URL that reaches your machine, for example through a tunnel such as `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`. Then add a custom connector in ChatGPT (developer mode) pointing at:

```
https://<your-tunnel-host>/mcp?token=<your MCP_AUTH_TOKEN>
```

Clients that can send headers should use `Authorization: Bearer <token>` instead of the query string. Anyone with the URL and token can control After Effects on your machine, so keep the token secret and stop the tunnel when you're done.

Without `MCP_AUTH_TOKEN` the HTTP server only accepts requests addressed to `localhost`/`127.0.0.1`.

## Tools

| Tool | What it does |
| --- | --- |
| `list_compositions` | Lists compositions (size, duration, frame rate, optionally layers) and which one is active. |
| `create_composition` | Creates a composition. Defaults: 1920×1080, 10 s, 30 fps. |
| `add_layer` | Adds a solid, text, shape (rectangle/ellipse), null, adjustment, camera, light, or imported footage layer. |
| `set_keyframes` | Sets one or more keyframes on a property, with optional linear / bezier / easy-ease / hold interpolation. Accepts short names (`position`, `scale`, `rotation`, `opacity`, `anchorPoint`, `sourceText`) or a path like `Effects/Gaussian Blur/Blurriness`. |
| `add_to_render_queue` | Queues a composition with an output path and optional render-settings / output-module templates. |
| `get_render_queue` | Lists render queue items, their status and output files. |
| `start_render` | Renders the queue in After Effects (waits until done), or hands it to Media Encoder. |

Compositions are picked by `compId` or `compName`, falling back to the active composition. Layers are picked by `layerIndex` (1 = top) or `layerName`. Times are in seconds and colors are `[r, g, b]` from 0 to 1.

## Options

| Flag | Env var | Default |
| --- | --- | --- |
| `--transport stdio\|http` | `MCP_TRANSPORT` | `stdio` |
| `--host` | `HOST` | `127.0.0.1` |
| `--port` | `PORT` | `3000` |
| `--bridge auto\|panel\|script\|simulator` | `AE_BRIDGE` | `auto` (panel if running, else script) |
| | `MCP_AUTH_TOKEN` | none (HTTP only) |
| | `AE_APP_NAME` | newest `Adobe After Effects <year>` in `/Applications` (macOS) |
| | `AE_PATH` | newest `AfterFX.exe` under `Program Files\Adobe` (Windows) |
| | `AE_PANEL_PORT`, `AE_PANEL_TOKEN` | read from `~/.after-effects-mcp/panel.json` |
| | `AE_TIMEOUT_MS` | `60000` per call (`start_render` has its own `timeoutSeconds`) |

## Troubleshooting

- **"The After Effects MCP panel isn't reachable"** (with `--bridge panel`): open the panel from Window → Extensions and check it says "Ready".
- **Panel missing from Window → Extensions**: run `npm run install-extension` again, then fully quit and reopen After Effects.
- **"After Effects did not answer"**: check After Effects is open and isn't showing a dialog. Without the panel, also check the scripting preference above is on.
- **macOS "Not authorized to send Apple events"**: allow Automation access for the app running the server.
- **Wrong After Effects version picked**: set `AE_APP_NAME` (macOS) or `AE_PATH` (Windows).
- While `start_render` runs in After Effects, After Effects is busy and other calls wait in line.

## Development

```bash
npm test          # tool scripts against the simulator, both bridges, the panel, and HTTP
npm run typecheck
npm run dev -- --bridge simulator --transport http
```

ExtendScript is ECMAScript 3, so tool scripts can't use `JSON`, `let`/`const`, arrow functions or ES5 array methods. The tests parse every script as ES3 and run it in a sandbox with those built-ins removed. Code layout:

- `src/tools.ts`: tool schemas and their ExtendScript bodies
- `src/jsx/`: shared ExtendScript helpers and script assembly
- `extension/`: the After Effects panel (CEP). `js/bridge-server.js` is its local HTTP bridge
- `scripts/install-extension.mjs`: installs or removes the panel
- `src/bridge/panel-bridge.ts`: sends scripts to the panel, and the `auto` bridge
- `src/bridge/script-bridge.ts`: runs scripts through the OS when the panel isn't there
- `src/bridge/simulator.ts`: in-memory After Effects for tests and dry runs
- `src/server.ts`, `src/http.ts`, `src/index.ts`: MCP server, HTTP transport, CLI
