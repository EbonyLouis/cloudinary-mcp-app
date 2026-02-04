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

import {
  registerChatGptTemplate,
  addChatGptToolMeta,
  buildChatGptStructuredContent,
  isChatGptTemplateUri,
} from "./chatgpt-adapter.js";

class UiStore {
    private map = new Map<string, string>();
  
    set(uri: string, html: string) {
      this.map.set(uri, html);
    }
  
    get(uri: string) {
      return this.map.get(uri);
    }
  
    keys() {
      return this.map.keys();
    }
  }

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export class CloudinaryServer {
  private server: Server;
  private uiStore = new UiStore();

  constructor() {
    // Cloudinary config
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

    // ✅ ChatGPT needs a stable template resource available immediately
    registerChatGptTemplate(this.uiStore as any);


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
        // ✅ ChatGPT: tool meta points to the one stable template
        addChatGptToolMeta({
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
        }),

        {
          name: "show_demo_app",
          description: "Shows a tiny MCP App demo UI (sanity check).",
          inputSchema: { type: "object", properties: {}, required: [] },
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
        const uri = "ui://cloudinary/demo";
        this.uiStore.set(
          uri,
          `<!doctype html><html><body style="font-family:system-ui;padding:16px">
            <h2>✅ Demo UI</h2>
            <p>If you can see this, resources/read is working.</p>
          </body></html>`
        );
        return { content: [{ type: "text", text: "Opening demo app…" }], _meta: { ui: { resourceUri: uri } } };
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    });

    // ✅ Resources: return skybridge only for the template URI
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: Array.from(this.uiStore.keys()).map((uri) => {
        const isTemplate = isChatGptTemplateUri(uri);
        return {
          uri,
          name: isTemplate ? "Cloudinary (ChatGPT Template)" : "Cloudinary UI",
          description: isTemplate ? "ChatGPT Apps SDK template" : "Goose MCP App UI",
          mimeType: isTemplate ? "text/html+skybridge" : "text/html;profile=mcp-app",
        };
      }),
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      const html = this.uiStore.get(uri);
      if (!html) throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${uri}`);

      const isTemplate = isChatGptTemplateUri(uri);
      const mimeType = isTemplate ? "text/html+skybridge" : "text/html;profile=mcp-app";

      return {
        contents: [
          {
            uri,
            mimeType,
            text: html,
            _meta: isTemplate
              ? {
                  "openai/widgetDescription": "Cloudinary upload viewer",
                  "openai/widgetCSP": {
                    connect_domains: ["https://res.cloudinary.com"],
                    resource_domains: ["https://res.cloudinary.com"],
                  },
                  "openai/widgetPrefersBorder": true,
                }
              : {
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
      };

      // Goose UI resource
      const uri = `ui://cloudinary-upload/${result.public_id}`;
      this.uiStore.set(uri, this.createUploadResultUI(result));

      return {
        content: [{ type: "text", text: `🎉 Upload successful!\n\n${JSON.stringify(response, null, 2)}` }],

        // ✅ ChatGPT uses this as window.openai.toolOutput
        structuredContent: buildChatGptStructuredContent({
          public_id: response.public_id,
          resource_type: response.resource_type,
          format: response.format,
          bytes: response.bytes,
          created_at: response.created_at,
          secure_url: response.secure_url,
          url: response.url,
          tags: result.tags,
        }),

        // ✅ Goose uses this to open the MCP App UI
        _meta: { ui: { resourceUri: uri } },
      };
    } catch (err) {
      throw new McpError(
        ErrorCode.InternalError,
        `Upload failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Keep your existing fancy HTML here (unchanged)
  private createUploadResultUI(result: UploadApiResponse): string {
    const isImage = result.resource_type === "image";
    const isVideo = result.resource_type === "video";
    // For workshop: you can keep your full UI.
    // I'm keeping it minimal here so the file isn't 1000 lines.
    return `
<!DOCTYPE html>
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
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="success-icon">✅</div>
      <h1>Upload Successful!</h1>
      <p>Your ${result.resource_type} has been uploaded to Cloudinary</p>
    </div>

    <div class="content">
      ${isImage || isVideo ? `
      <div class="preview-section">
        <h2>Preview</h2>
        ${isImage ? `<img src="${result.secure_url}" alt="Uploaded image" />` : `
          <video controls>
            <source src="${result.secure_url}" type="video/${result.format}">
            Your browser does not support the video tag.
          </video>`}
      </div>` : ""}

      <div class="info-grid">
        <div class="info-card">
          <h3>File Information</h3>
          <p>Public ID: <span class="value">${result.public_id}</span></p>
          <p>Format: <span class="value">${result.format}</span></p>
          <p>Type: <span class="value">${result.resource_type}</span></p>
          <p>Size: <span class="value">${(result.bytes / 1024 / 1024).toFixed(2)} MB</span></p>
        </div>

        <div class="info-card">
          <h3>Upload Details</h3>
          <p>Version: <span class="value">${result.version}</span></p>
          <p>Created: <span class="value">${new Date(result.created_at).toLocaleString()}</span></p>
          <p>Signature: <span class="value">${result.signature.substring(0, 20)}...</span></p>
          ${result.tags && result.tags.length > 0 ? `
            <p>Tags:</p>
            <div class="tags">
              ${result.tags.map(tag => `<span class="tag">${tag}</span>`).join("")}
            </div>` : ""}
        </div>
      </div>

      <div class="actions">
        <button class="btn btn-primary" onclick="makeMeme()">🎭 Make a Meme</button>
        <a href="${result.secure_url}" download class="btn btn-secondary">⬇️ Download</a>
        <button class="btn btn-success" onclick="shareOnTwitter()">📱 Tweet This</button>
      </div>

      ${isImage ? `
      <div class="transformations">
        <h3>🎨 Transformation Examples</h3>
        <p>Cloudinary provides powerful on-the-fly transformations. Here are some examples:</p>
        <div class="transform-examples">
          <div class="transform-example">
            <img src="${result.secure_url.replace("/upload/", "/upload/w_200,h_200,c_fill/")}" alt="Resized" />
            <p><strong>Resized (200x200)</strong></p>
            <button class="copy-btn" onclick="copyToClipboard('${result.secure_url.replace("/upload/", "/upload/w_200,h_200,c_fill/")}')">Copy URL</button>
          </div>
          <div class="transform-example">
            <img src="${result.secure_url.replace("/upload/", "/upload/e_sepia/")}" alt="Sepia effect" />
            <p><strong>Sepia Effect</strong></p>
            <button class="copy-btn" onclick="copyToClipboard('${result.secure_url.replace("/upload/", "/upload/e_sepia/")}')">Copy URL</button>
          </div>
          <div class="transform-example">
            <img src="${result.secure_url.replace("/upload/", "/upload/w_200,h_200,c_fill,r_max/")}" alt="Circular" />
            <p><strong>Circular Crop</strong></p>
            <button class="copy-btn" onclick="copyToClipboard('${result.secure_url.replace("/upload/", "/upload/w_200,h_200,c_fill,r_max/")}')">Copy URL</button>
          </div>
          <div class="transform-example">
            <img src="${result.secure_url.replace("/upload/", "/upload/e_blur:300/")}" alt="Blurred" />
            <p><strong>Blur Effect</strong></p>
            <button class="copy-btn" onclick="copyToClipboard('${result.secure_url.replace("/upload/", "/upload/e_blur:300/")}')">Copy URL</button>
          </div>
        </div>
      </div>` : ""}
    </div>
  </div>

  <script>
    // ----- MCP Apps JSON-RPC Client -----
    // MCP Apps standardize communication as JSON-RPC instead of custom message types

    class McpAppClient {
      constructor() {
        this.pending = new Map();
        this.id = 0;
        this.hostContext = null;
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

        // host context changes (theme, etc.)
        if (data.method === "ui/notifications/host-context-changed") {
          if (data.params?.theme) document.body.className = data.params.theme;
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
        const res = await this.request("ui/initialize", {});
        this.hostContext = res?.hostContext;

        if (this.hostContext?.theme) {
          document.body.className = this.hostContext.theme;
        }

        this.reportSize();
      }

      reportSize() {
        this.notify("ui/notifications/size-changed", { height: document.body.scrollHeight });
      }

      async sendChat(text) {
        return this.request("ui/message", { content: { type: "text", text } });
      }
    }

    const mcpApp = new McpAppClient();
    mcpApp.init().catch(console.error);

    // Existing helper
    function copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(function() {
        const notification = document.createElement("div");
        notification.textContent = "URL copied to clipboard!";
        notification.style.cssText = \`
          position: fixed;
          top: 20px;
          right: 20px;
          background: #4CAF50;
          color: white;
          padding: 15px 20px;
          border-radius: 25px;
          box-shadow: 0 5px 15px rgba(0,0,0,0.2);
          z-index: 1000;
          font-weight: 500;
        \`;
        document.body.appendChild(notification);

        setTimeout(() => document.body.removeChild(notification), 3000);
      }).catch(function(err) {
        console.error("Could not copy text: ", err);
        alert("Failed to copy URL to clipboard");
      });
    }

    // hover effects
    document.querySelectorAll(".btn").forEach(btn => {
      btn.addEventListener("mouseenter", function() { this.style.transform = "translateY(-2px)"; });
      btn.addEventListener("mouseleave", function() { this.style.transform = "translateY(0)"; });
    });

    // Resize handling for MCP Apps
    const resizeObserver = new ResizeObserver(() => mcpApp.reportSize());
    resizeObserver.observe(document.documentElement);
    window.addEventListener("load", () => mcpApp.reportSize());

    // Instead of MCP-UI's { type: "prompt" }
   // MCP Apps uses a real method: ui/message
    async function makeMeme() {
      await mcpApp.sendChat(
        "Create a funny meme caption for the image I just uploaded. Make it humorous and engaging, following popular meme formats."
      );
    }

    
    async function shareOnTwitter() {
      await mcpApp.sendChat(
        "Draft a tweet about this Cloudinary upload and include this link: ${result.secure_url}"
      );
    }
  </script>
</body>
</html>`;
  }
}
