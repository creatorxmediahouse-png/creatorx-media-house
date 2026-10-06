import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface HttpOptions {
  host: string;
  port: number;
  /** When set, requests must carry `Authorization: Bearer <token>` or `?token=<token>`. */
  authToken?: string;
  log?: (message: string) => void;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function tokenMatches(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/**
 * Serves MCP over Streamable HTTP at /mcp, statelessly: each POST gets a
 * fresh server instance, so any number of clients can connect.
 */
export function startHttpServer(makeServer: () => McpServer, options: HttpOptions): Promise<Server> {
  const log = options.log ?? (() => {});

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://placeholder");

    if (url.pathname === "/health") return sendJson(res, 200, { ok: true });
    if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "Not found. The MCP endpoint is /mcp." });

    if (options.authToken) {
      const header = req.headers.authorization;
      const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
      if (!tokenMatches(bearer ?? url.searchParams.get("token"), options.authToken)) {
        return rpcError(res, 401, "Missing or wrong token.");
      }
    } else {
      // Without a token, only answer requests addressed to a loopback host, so a web page
      // can't reach this server through DNS rebinding.
      const hostname = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!LOOPBACK.has(hostname)) return rpcError(res, 403, `Host "${hostname}" is not allowed without MCP_AUTH_TOKEN.`);
    }

    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return rpcError(res, 405, "This server is stateless; use POST.");
    }

    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log(`HTTP request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) rpcError(res, 500, "Internal server error");
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      if (!options.authToken && !LOOPBACK.has(options.host)) {
        log(`Warning: listening on ${options.host} without MCP_AUTH_TOKEN; only loopback Host headers will be accepted.`);
      }
      resolve(httpServer);
    });
  });
}
