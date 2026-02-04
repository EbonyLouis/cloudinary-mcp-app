#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { CloudinaryServer } from "./cloudinary-server.js";
import "dotenv/config";

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    exposedHeaders: ["Mcp-Session-Id", "Link"],
    allowedHeaders: ["Content-Type", "mcp-session-id", "Accept", "Authorization"],
  })
);

app.options("/mcp", cors());

app.use(express.json({ limit: "25mb" }));

app.get("/", (_req, res) => {
  res.json({ name: "cloudinary-mcp-server", status: "running", mcp: "/mcp" });
});

// ----------------------------------------------------------------------------
// Session state (transport + server) keyed by MCP session id
// ----------------------------------------------------------------------------
const transportsBySession = new Map<string, StreamableHTTPServerTransport>();
const serversBySession = new Map<string, CloudinaryServer>();

function getSessionId(req: express.Request): string | undefined {
  const v = req.headers["mcp-session-id"];
  return typeof v === "string" && v.length ? v : undefined;
}

// ----------------------------------------------------------------------------
// POST /mcp
// - initialize request (no session id): create session + connect server
// - otherwise: reuse existing session
// ----------------------------------------------------------------------------
app.post("/mcp", async (req, res) => {
  const sessionIdHeader = getSessionId(req);

  // Case A: existing session
  if (sessionIdHeader) {
    const transport = transportsBySession.get(sessionIdHeader);
    if (!transport) {
      return res.status(404).json({ error: { message: "Session not found" } });
    }
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling /mcp (existing session):", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
    return;
  }

  // Case B: new session must start with initialize
  if (!isInitializeRequest(req.body)) {
    return res.status(400).json({
      error: { message: "Bad Request: missing mcp-session-id and not an initialize request" },
    });
  }

  // Create new session
  const server = new CloudinaryServer();

  let transport!: StreamableHTTPServerTransport;

  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transportsBySession.set(sid, transport);
      serversBySession.set(sid, server);

      // Cleanup when session closes
      transport.onclose = async () => {
        transportsBySession.delete(sid);
        serversBySession.delete(sid);
        try {
          await transport.close();
        } catch {}
        try {
          await server.close();
        } catch {}
      };
    },
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling /mcp (initialize):", err);

    try {
      await transport.close();
    } catch {}
    try {
      await server.close();
    } catch {}

    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// ----------------------------------------------------------------------------
// GET /mcp  -> SSE stream (server-to-client) for an existing session
// DELETE /mcp -> session termination for an existing session
// ----------------------------------------------------------------------------
async function handleSessionRequest(req: express.Request, res: express.Response) {
  const sessionId = getSessionId(req);
  if (!sessionId) return res.status(400).send("Missing mcp-session-id");

  const transport = transportsBySession.get(sessionId);
  if (!transport) return res.status(404).send("Session not found");

  try {
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error(`Error handling /mcp (${req.method}) for session ${sessionId}:`, err);
    if (!res.headersSent) res.status(500).send("Internal server error");
  }
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`✅ Cloudinary MCP HTTP server running on port ${PORT}`);
});

export default app;
