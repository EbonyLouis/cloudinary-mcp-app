#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CloudinaryServer } from "./cloudinary-server.js";
import "dotenv/config";


const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

app.get("/", (_req, res) => {
  res.json({ name: "cloudinary-mcp-server", status: "running", mcp: "/mcp" });
});

app.post("/mcp", async (req, res) => {
  const server = new CloudinaryServer(); // ✅ no args

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling /mcp request:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  } finally {
    try { await transport.close(); } catch {}
    try { await server.close(); } catch {}
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ message: "Use POST for MCP requests." });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`✅ Cloudinary MCP HTTP server running on port ${PORT}`);
});

export default app;
