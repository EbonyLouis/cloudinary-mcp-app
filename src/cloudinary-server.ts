import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { v2 as cloudinary, UploadApiResponse } from "cloudinary";
import { readFile } from "node:fs/promises";

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * Deterministic MCP Apps UI URI (portable across Goose + ChatGPT).
 * The UI hydrates from tool-result notifications / tool output.
 */
const UPLOAD_UI_URI = "ui://cloudinary/upload";
const DEMO_UI_URI = "ui://cloudinary/demo";

export class CloudinaryServer {
  private server: Server;

  constructor() {
    cloudinary.config({
      cloud_name: requireEnv("CLOUDINARY_CLOUD_NAME"),
      api_key: requireEnv("CLOUDINARY_API_KEY"),
      api_secret: requireEnv("CLOUDINARY_API_SECRET"),
    });

    this.server = new Server(
      { name: "cloudinary-server", version: "1.2.0" },
      { capabilities: { tools: {}, resources: {} } }
    );

    this.setupHandlers();
    this.server.onerror = (err) => console.error("[MCP Error]", err);
  }

  async connect(transport: Transport) {
    await this.server.connect(transport);
  }

  async close() {
    await this.server.close();
  }

  // ---------------- Handlers ----------------

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "upload",
          description:
            "Upload media (images/videos) to Cloudinary. `file_path` for local; `file` for URL/data URI. Returns details + opens UI.",
          inputSchema: {
            type: "object",
            properties: {
              file_path: {
                type: "string",
                description: "Local filesystem path (best for Goose/local).",
              },
              file: {
                type: "string",
                description:
                  "URL or base64 data URI (best for ChatGPT). Also accepts a local path.",
              },
              resource_type: {
                type: "string",
                enum: ["image", "video", "raw"],
              },
              public_id: { type: "string" },
              overwrite: { type: "boolean" },
              tags: { type: "array", items: { type: "string" } },
            },
            required: [],
          },
          // ✅ MCP Apps standard: declare the UI resource here
          _meta: {
            ui: { resourceUri: UPLOAD_UI_URI },
          },
        },

        {
          name: "show_demo_app",
          description: "Shows a tiny MCP App demo UI (sanity check).",
          inputSchema: { type: "object", properties: {}, required: [] },
          _meta: {
            ui: { resourceUri: DEMO_UI_URI },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = request.params.arguments as {
        file_path?: string;
        file?: string;
        resource_type?: "image" | "video" | "raw";
        public_id?: string;
        overwrite?: boolean;
        tags?: string[];
      };

      if (request.params.name === "upload") return this.handleUpload(args);

      if (request.params.name === "show_demo_app") {
        return {
          content: [{ type: "text", text: "Opening demo app…" }],
          _meta: { ui: { resourceUri: DEMO_UI_URI } },
          structuredContent: {
            demo: {
              message: "If you can see the demo UI, resources/read works ✅",
              timestamp: new Date().toISOString(),
            },
          },
        };
      }

      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${request.params.name}`
      );
    });

    // ✅ Deterministic resources list (no per-upload URIs)
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: UPLOAD_UI_URI,
          name: "Cloudinary Upload UI",
          description: "Deterministic MCP App UI for showing the latest upload",
          mimeType: "text/html;profile=mcp-app",
        },
        {
          uri: DEMO_UI_URI,
          name: "Cloudinary Demo UI",
          description: "Sanity-check MCP App UI",
          mimeType: "text/html;profile=mcp-app",
        },
      ],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      if (uri === UPLOAD_UI_URI) {
        return {
          contents: [
            {
              uri,
              mimeType: "text/html;profile=mcp-app",
              text: this.createDeterministicUploadUI(),
              _meta: {
                ui: {
                  csp: {
                    connectDomains: ["https://res.cloudinary.com"],
                    resourceDomains: ["https://res.cloudinary.com"],
                  },
                  prefersBorder: true,
                },
              },
            },
          ],
        };
      }

      if (uri === DEMO_UI_URI) {
        return {
          contents: [
            {
              uri,
              mimeType: "text/html;profile=mcp-app",
              text: this.createDemoUI(),
              _meta: {
                ui: {
                  prefersBorder: true,
                },
              },
            },
          ],
        };
      }

      throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${uri}`);
    });
  }

  // ---------------- Upload logic ----------------

  private async performUpload(args: {
    file_path?: string;
    file?: string;
    resource_type?: "image" | "video" | "raw";
    public_id?: string;
    overwrite?: boolean;
    tags?: string[];
  }): Promise<UploadApiResponse> {
    const options: any = {
      resource_type: args.resource_type || "auto",
      public_id: args.public_id,
      overwrite: args.overwrite,
      tags: args.tags,
      chunk_size: 20_000_000,
    };

    const input = args.file_path ?? args.file;
    if (!input) throw new Error("Missing required input: provide `file_path` or `file`.");

    // URL upload
    if (/^https?:\/\//i.test(input)) {
      return (await cloudinary.uploader.upload(input, options)) as UploadApiResponse;
    }

    // data URI upload
    if (/^data:/i.test(input)) {
      const match = input.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new Error("Invalid data URI format. Expected data:<mime>;base64,<data>");
      const buffer = Buffer.from(match[2], "base64");

      return await new Promise<UploadApiResponse>((resolve, reject) => {
        cloudinary.uploader
          .upload_stream(options, (err: any, r: any) => (err ? reject(err) : resolve(r)))
          .end(buffer);
      });
    }

    // local path upload
    const buffer = await readFile(input);
    return await new Promise<UploadApiResponse>((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(options, (err: any, r: any) => (err ? reject(err) : resolve(r)))
        .end(buffer);
    });
  }

  private async handleUpload(args: {
    file_path?: string;
    file?: string;
    resource_type?: "image" | "video" | "raw";
    public_id?: string;
    overwrite?: boolean;
    tags?: string[];
  }) {
    try {
      const result = await this.performUpload(args);

      const response = {
        public_id: result.public_id,
        format: result.format,
        resource_type: result.resource_type,
        created_at: result.created_at,
        bytes: result.bytes,
        url: result.url,
        secure_url: result.secure_url,
        tags: result.tags || [],
      };

      return {
        content: [
          {
            type: "text",
            text: `🎉 Upload successful!\n\n${JSON.stringify(response, null, 2)}`,
          },
        ],

        // ✅ This is what the UI hydrates from (portable)
        structuredContent: { upload: response },

        // ✅ Always open the SAME deterministic UI resource
        _meta: { ui: { resourceUri: UPLOAD_UI_URI } },
      };
    } catch (err) {
      throw new McpError(
        ErrorCode.InternalError,
        `Upload failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ---------------- Deterministic MCP Apps UI ----------------

  /**
   * This UI is deterministic. It does NOT bake result.* into the HTML.
   * It hydrates from MCP Apps notifications (tool-result) and/or host context.
   */
  private createDeterministicUploadUI(): string {
    // Note: We keep your original CSS so it can match Goose visually.
    // The only change is: render uses data received from tool-result (structuredContent.upload).
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudinary Upload Result</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); overflow-x: hidden; }
    .container { max-width: 800px; margin: 0 auto; background: white; border-radius: 15px; box-shadow: 0 20px 40px rgba(0,0,0,0.1); overflow: hidden; }
    .header { background: linear-gradient(135deg, #4CAF50, #45a049); color: white; padding: 30px; text-align: center; }
    .header h1 { margin: 0; font-size: 2em; font-weight: 300; }
    .header .success-icon { font-size: 3em; margin-bottom: 10px; }
    .content { padding: 30px; }
    .preview-section { text-align: center; margin-bottom: 30px; }
    .preview-section img, .preview-section video { max-width: 100%; max-height: 300px; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
    .info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .info-card { background: #f8f9fa; padding: 20px; border-radius: 10px; border-left: 4px solid #4CAF50; }
    .info-card h3 { margin: 0 0 10px 0; color: #333; font-size: 1.1em; }
    .info-card p { margin: 5px 0; color: #666; }
    .info-card .value { font-weight: bold; color: #333; word-break: break-all; }
    .actions { display: flex; gap: 15px; flex-wrap: wrap; justify-content: center; }
    .btn { padding: 12px 24px; border: none; border-radius: 25px; cursor: pointer; font-size: 14px; font-weight: 500; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; transition: all 0.3s ease; }
    .btn-primary { background: linear-gradient(135deg, #007bff, #0056b3); color: white; }
    .btn-secondary { background: linear-gradient(135deg, #6c757d, #545b62); color: white; }
    .btn-success { background: linear-gradient(135deg, #28a745, #1e7e34); color: white; }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(0,0,0,0.2); }
    .copy-btn { background: #17a2b8; color: white; border: none; padding: 5px 10px; border-radius: 15px; cursor: pointer; font-size: 12px; margin-top: 5px; }
    .copy-btn:hover { background: #138496; }
    .transformations { margin-top: 30px; padding: 20px; background: #f8f9fa; border-radius: 10px; }
    .transformations h3 { margin-top: 0; color: #333; }
    .transform-examples { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 15px; }
    .transform-example { text-align: center; padding: 15px; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .transform-example img { max-width: 100%; height: 100px; object-fit: cover; border-radius: 5px; margin-bottom: 10px; }
    .tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .tag { background: #e9ecef; color: #495057; padding: 4px 12px; border-radius: 15px; font-size: 12px; }
    .muted { color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="success-icon">✅</div>
      <h1>Upload Successful!</h1>
      <p id="subtitle" class="muted" style="color:rgba(255,255,255,0.9)">Waiting for upload data…</p>
    </div>

    <div class="content">
      <div id="previewRoot" class="preview-section" style="display:none;">
        <h2>Preview</h2>
        <div id="preview"></div>
      </div>

      <div class="info-grid">
        <div class="info-card">
          <h3>File Information</h3>
          <p>Public ID: <span class="value" id="publicId">—</span></p>
          <p>Format: <span class="value" id="format">—</span></p>
          <p>Type: <span class="value" id="type">—</span></p>
          <p>Size: <span class="value" id="size">—</span></p>
        </div>

        <div class="info-card">
          <h3>Upload Details</h3>
          <p>Created: <span class="value" id="created">—</span></p>
          <p>URL: <span class="value" id="url">—</span></p>
          <div id="tagsRoot" style="display:none;">
            <p>Tags:</p>
            <div class="tags" id="tags"></div>
          </div>
        </div>
      </div>

      <div class="actions">
        <button class="btn btn-primary" id="memeBtn">🎭 Make a Meme</button>
        <a href="#" id="downloadLink" class="btn btn-secondary" style="pointer-events:none;opacity:.6">⬇️ Download</a>
        <button class="btn btn-success" id="tweetBtn">📱 Tweet This</button>
      </div>

      <div class="transformations" id="transformRoot" style="display:none;">
        <h3>🎨 Transformation Examples</h3>
        <p>Cloudinary provides powerful on-the-fly transformations. Here are some examples:</p>
        <div class="transform-examples" id="transformExamples"></div>
      </div>
    </div>
  </div>

  <script>
    // ----- MCP Apps JSON-RPC Client -----
    class McpAppClient {
      constructor() {
        this.pending = new Map();
        this.id = 0;
        this.latestUpload = null;
        window.addEventListener("message", (e) => this.onMessage(e));
      }

      onMessage(event) {
        const data = event.data;
        if (!data || typeof data !== "object") return;

        // responses
        if ("id" in data && this.pending.has(data.id)) {
          const { resolve, reject } = this.pending.get(data.id);
          this.pending.delete(data.id);
          if (data.error) reject(new Error(data.error.message));
          else resolve(data.result);
          return;
        }

        // MCP Apps standard: tool result notification
        if (data.method === "ui/notifications/tool-result") {
          const upload = data.params?.result?.structuredContent?.upload;
          if (upload) {
            this.latestUpload = upload;
            render(upload);
            this.reportSize();
          }
        }

        // host context changes (theme, etc.)
        if (data.method === "ui/notifications/host-context-changed") {
          // Optional: respond to theme changes if you want
        }
      }

      request(method, params) {
        return new Promise((resolve, reject) => {
          const id = ++this.id;
          this.pending.set(id, { resolve, reject });
          window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
          setTimeout(() => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              reject(new Error("Request timed out"));
            }
          }, 30000);
        });
      }

      notify(method, params) {
        window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
      }

      async init() {
        await this.request("ui/initialize", {});
        this.reportSize();
      }

      reportSize() {
        this.notify("ui/notifications/size-changed", { height: document.body.scrollHeight });
      }

      async sendChat(text) {
        return this.request("ui/message", { content: { type: "text", text } });
      }
    }

    function bytesToMb(bytes) {
      if (typeof bytes !== "number") return "—";
      return (bytes / 1024 / 1024).toFixed(2) + " MB";
    }

    function esc(s) {
      return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
      }[c]));
    }

    function render(u) {
      document.getElementById("subtitle").textContent =
        "Your " + (u.resource_type || "asset") + " has been uploaded to Cloudinary";

      document.getElementById("publicId").textContent = u.public_id || "—";
      document.getElementById("format").textContent = u.format || "—";
      document.getElementById("type").textContent = u.resource_type || "—";
      document.getElementById("size").textContent = bytesToMb(u.bytes);
      document.getElementById("created").textContent = u.created_at || "—";

      const url = u.secure_url || u.url || "";
      document.getElementById("url").textContent = url ? url : "—";

      // Download link
      const dl = document.getElementById("downloadLink");
      if (url) {
        dl.href = url;
        dl.style.pointerEvents = "auto";
        dl.style.opacity = "1";
      } else {
        dl.href = "#";
        dl.style.pointerEvents = "none";
        dl.style.opacity = ".6";
      }

      // Preview
      const isImage = u.resource_type === "image";
      const isVideo = u.resource_type === "video";

      const previewRoot = document.getElementById("previewRoot");
      const preview = document.getElementById("preview");
      if (url && (isImage || isVideo)) {
        previewRoot.style.display = "block";
        preview.innerHTML = isImage
          ? '<img src="' + esc(url) + '" alt="Uploaded image" />'
          : '<video controls><source src="' + esc(url) + '"></video>';
      } else {
        previewRoot.style.display = "none";
        preview.innerHTML = "";
      }

      // Tags
      const tags = Array.isArray(u.tags) ? u.tags : [];
      const tagsRoot = document.getElementById("tagsRoot");
      const tagsEl = document.getElementById("tags");
      if (tags.length) {
        tagsRoot.style.display = "block";
        tagsEl.innerHTML = tags.map(t => '<span class="tag">' + esc(t) + '</span>').join("");
      } else {
        tagsRoot.style.display = "none";
        tagsEl.innerHTML = "";
      }

      // Transformations (images only)
      const transformRoot = document.getElementById("transformRoot");
      const transformExamples = document.getElementById("transformExamples");
      if (isImage && url) {
        transformRoot.style.display = "block";
        const mk = (label, transformedUrl) => {
          return '<div class="transform-example">' +
            '<img src="' + esc(transformedUrl) + '" alt="' + esc(label) + '" />' +
            '<p><strong>' + esc(label) + '</strong></p>' +
            '<button class="copy-btn" data-copy="' + esc(transformedUrl) + '">Copy URL</button>' +
          '</div>';
        };
        const resized = url.replace("/upload/", "/upload/w_200,h_200,c_fill/");
        const sepia = url.replace("/upload/", "/upload/e_sepia/");
        const circle = url.replace("/upload/", "/upload/w_200,h_200,c_fill,r_max/");
        const blur = url.replace("/upload/", "/upload/e_blur:300/");

        transformExamples.innerHTML =
          mk("Resized (200x200)", resized) +
          mk("Sepia Effect", sepia) +
          mk("Circular Crop", circle) +
          mk("Blur Effect", blur);

        transformExamples.querySelectorAll("button[data-copy]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const val = btn.getAttribute("data-copy") || "";
            await navigator.clipboard.writeText(val);
            alert("Copied!");
          });
        });
      } else {
        transformRoot.style.display = "none";
        transformExamples.innerHTML = "";
      }
    }

    const mcp = new McpAppClient();
    mcp.init().catch(console.error);

    document.getElementById("memeBtn").addEventListener("click", async () => {
      const url = mcp.latestUpload?.secure_url || mcp.latestUpload?.url || "";
      await mcp.sendChat(
        "Create a funny meme caption for the image I just uploaded. Link: " + url
      );
    });

    document.getElementById("tweetBtn").addEventListener("click", async () => {
      const url = mcp.latestUpload?.secure_url || mcp.latestUpload?.url || "";
      await mcp.sendChat(
        "Draft a tweet about this Cloudinary upload and include this link: " + url
      );
    });

    // Keep size updated
    const ro = new ResizeObserver(() => mcp.reportSize());
    ro.observe(document.documentElement);
    window.addEventListener("load", () => mcp.reportSize());
  </script>
</body>
<div style="position:fixed;top:8px;right:8px;z-index:9999;
background:#ff00ff;color:white;padding:6px 10px;border-radius:8px;
font-weight:700;">
MCP APPS UI v2026-02-04
</div>
</html>`;
  }

  private createDemoUI(): string {
    return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
  <body style="font-family: system-ui; padding: 16px;">
    <h2>✅ Cloudinary MCP App Demo</h2>
    <p class="muted">If you can see this, resources/read is working.</p>
    <button id="btn" style="padding: 10px 12px; border-radius: 8px; border: 1px solid #ccc; cursor:pointer;">
      Send message to chat
    </button>

    <script>
      class McpAppClient {
        constructor() {
          this.pending = new Map();
          this.id = 0;
          window.addEventListener("message", (e) => this.onMessage(e));
        }
        onMessage(event) {
          const data = event.data;
          if (!data || typeof data !== "object") return;
          if ("id" in data && this.pending.has(data.id)) {
            const { resolve, reject } = this.pending.get(data.id);
            this.pending.delete(data.id);
            if (data.error) reject(new Error(data.error.message));
            else resolve(data.result);
            return;
          }
        }
        request(method, params) {
          return new Promise((resolve, reject) => {
            const id = ++this.id;
            this.pending.set(id, { resolve, reject });
            window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
            setTimeout(() => {
              if (this.pending.has(id)) {
                this.pending.delete(id);
                reject(new Error("Request timed out"));
              }
            }, 30000);
          });
        }
        notify(method, params) {
          window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
        }
        async init() {
          await this.request("ui/initialize", {});
          this.notify("ui/notifications/size-changed", { height: document.body.scrollHeight });
        }
        async sendChat(text) {
          return this.request("ui/message", { content: { type: "text", text } });
        }
      }
      const mcp = new McpAppClient();
      mcp.init().catch(console.error);
      document.getElementById("btn").addEventListener("click", async () => {
        await mcp.sendChat("hi from the Cloudinary MCP App demo 👋");
      });
    </script>
  </body>
</html>`;
  }
}
