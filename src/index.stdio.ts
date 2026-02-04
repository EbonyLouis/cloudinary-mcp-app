#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CloudinaryServer } from "./cloudinary-server.js";

async function main() {
  const server = new CloudinaryServer();
  await server.connect(new StdioServerTransport());
  console.error("Cloudinary MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

