/**
 * chatgpt-adapter.ts
 *
 * Goal: Let the SAME MCP server support:
 *  - Goose / MCP Apps hosts (your current flow)
 *  - ChatGPT Apps SDK hosts (template + structured output)
 *
 * Mental model:
 *  - Goose (MCP Apps): tool returns _meta.ui.resourceUri -> host calls resources/read -> renders HTML
 *  - ChatGPT (Apps SDK): tool descriptor points to ONE static template via _meta["openai/outputTemplate"]
 *    and each tool call returns structuredContent. ChatGPT loads the template (text/html+skybridge)
 *    and injects the latest payload into window.openai.toolOutput.
 */

/** ChatGPT needs ONE stable template URI (tool descriptor is static). */
export const CHATGPT_TEMPLATE_URI = "ui://cloudinary/chatgpt-template";

/**
 * Types you can use in your structuredContent (keep it tight + idempotent).
 * ChatGPT may retry tool calls.
 */
export type CloudinaryUploadSummary = {
  public_id: string;
  resource_type: string;
  format?: string;
  bytes?: number;
  created_at?: string;
  secure_url?: string;
  url?: string;
  tags?: string[];
};

/** The shape your ChatGPT template expects at window.openai.toolOutput */
export type ChatGptToolOutput = {
  upload: CloudinaryUploadSummary;
};

/**
 * 1) CHATGPT TEMPLATE (static)
 *
 * This is what ChatGPT will iframe-render.
 * Important:
 *  - ChatGPT expects this resource to be served as `text/html+skybridge`
 *  - The widget runtime will be available at `window.openai`
 *
 * This template reads data from window.openai.toolOutput (your structuredContent),
 * and wires actions back to ChatGPT using window.openai.sendFollowUpMessage, etc.
 */
export function createChatGptTemplateUI(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cloudinary Upload Result</title>
  <style>
    html, body { height: 100%; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      margin: 0;
      padding: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      overflow-x: hidden;
      box-sizing: border-box;
    }
    *, *::before, *::after { box-sizing: inherit; }

    .container {
      max-width: 800px;
      margin: 0 auto;
      background: white;
      border-radius: 15px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #4CAF50, #45a049);
      color: white;
      padding: 30px;
      text-align: center;
    }
    .header h1 { margin: 0; font-size: 2em; font-weight: 300; }
    .header .success-icon { font-size: 3em; margin-bottom: 10px; }
    .content { padding: 30px; }

    .preview-section { text-align: center; margin-bottom: 30px; }
    .preview-section img, .preview-section video {
      max-width: 100%;
      max-height: 300px;
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    }

    .info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .info-card {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 10px;
      border-left: 4px solid #4CAF50;
    }
    .info-card h3 { margin: 0 0 10px 0; color: #333; font-size: 1.1em; }
    .info-card p { margin: 5px 0; color: #666; }
    .info-card .value { font-weight: bold; color: #333; word-break: break-all; }

    .actions { display: flex; gap: 15px; flex-wrap: wrap; justify-content: center; }
    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 25px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.3s ease;
      color: white;
    }
    .btn-primary { background: linear-gradient(135deg, #007bff, #0056b3); }
    .btn-secondary { background: linear-gradient(135deg, #6c757d, #545b62); }
    .btn-success { background: linear-gradient(135deg, #28a745, #1e7e34); }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(0,0,0,0.2); }

    .copy-btn {
      background: #17a2b8; color: white; border: none;
      padding: 5px 10px; border-radius: 15px;
      cursor: pointer; font-size: 12px; margin-top: 5px;
    }
    .copy-btn:hover { background: #138496; }

    .transformations { margin-top: 30px; padding: 20px; background: #f8f9fa; border-radius: 10px; }
    .transformations h3 { margin-top: 0; color: #333; }

    .transform-examples {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-top: 15px;
    }
    .transform-example {
      text-align: center;
      padding: 15px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .transform-example img {
      max-width: 100%;
      height: 100px;
      object-fit: cover;
      border-radius: 5px;
      margin-bottom: 10px;
    }

    .tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .tag { background: #e9ecef; color: #495057; padding: 4px 12px; border-radius: 15px; font-size: 12px; }

    .muted { color: rgba(255,255,255,0.9); margin-top: 8px; }
    .hidden { display: none; }
  </style>
</head>

<body>
  <div class="container">
    <div class="header">
      <div class="success-icon">✅</div>
      <h1>Upload Successful!</h1>
      <p id="subtitle">Your file has been uploaded to Cloudinary</p>
      <p class="muted" id="status">Waiting for tool output…</p>
    </div>

    <div class="content">
      <div id="previewWrap" class="preview-section hidden">
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
          <div id="tagsWrap" class="hidden">
            <p>Tags:</p>
            <div class="tags" id="tags"></div>
          </div>
        </div>
      </div>

      <div class="actions">
        <button class="btn btn-primary" id="memeBtn">🎭 Make a Meme</button>
        <a id="downloadBtn" class="btn btn-secondary" href="#" download>⬇️ Download</a>
        <button class="btn btn-success" id="tweetBtn">📱 Tweet This</button>
      </div>

      <div id="transformWrap" class="transformations hidden">
        <h3>🎨 Transformation Examples</h3>
        <p>Cloudinary provides powerful on-the-fly transformations. Here are some examples:</p>
        <div class="transform-examples" id="transforms"></div>
      </div>
    </div>
  </div>

  <script>
    function getUpload() {
      try { return window.openai?.toolOutput?.upload || null; } catch { return null; }
    }

    function bytesToMb(bytes) {
      if (typeof bytes !== "number") return "—";
      return (bytes / 1024 / 1024).toFixed(2) + " MB";
    }

    function setText(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value ?? "—";
    }

    function show(id) { document.getElementById(id)?.classList.remove("hidden"); }
    function hide(id) { document.getElementById(id)?.classList.add("hidden"); }

    function render() {
      const u = getUpload();
      const statusEl = document.getElementById("status");
      if (!u) {
        statusEl.textContent = "Waiting for tool output… run the upload tool.";
        return notifyHeight();
      }

      statusEl.textContent = "Upload loaded ✅";
      const url = u.secure_url || u.url || "";
      const isImage = u.resource_type === "image";
      const isVideo = u.resource_type === "video";

      document.getElementById("subtitle").textContent =
        "Your " + (u.resource_type || "file") + " has been uploaded to Cloudinary";

      setText("publicId", u.public_id);
      setText("format", u.format || "—");
      setText("type", u.resource_type || "—");
      setText("size", bytesToMb(u.bytes));
      setText("created", u.created_at || "—");

      // Preview
      if (url && (isImage || isVideo)) {
        show("previewWrap");
        document.getElementById("preview").innerHTML = isImage
          ? '<img src="' + url + '" alt="Uploaded image" />'
          : '<video controls><source src="' + url + '" /></video>';
      } else {
        hide("previewWrap");
        document.getElementById("preview").innerHTML = "";
      }

      // Download link
      const dl = document.getElementById("downloadBtn");
      dl.href = url || "#";

      // Tags
      const tags = Array.isArray(u.tags) ? u.tags : [];
      if (tags.length) {
        show("tagsWrap");
        document.getElementById("tags").innerHTML =
          tags.map(t => '<span class="tag">' + t + '</span>').join("");
      } else {
        hide("tagsWrap");
        document.getElementById("tags").innerHTML = "";
      }

      // Transformations (images only)
      if (isImage && url.includes("/upload/")) {
        show("transformWrap");
        const transforms = [
          { label: "Resized (200x200)", t: "w_200,h_200,c_fill" },
          { label: "Sepia Effect", t: "e_sepia" },
          { label: "Circular Crop", t: "w_200,h_200,c_fill,r_max" },
          { label: "Blur Effect", t: "e_blur:300" },
        ];
        const html = transforms.map(({label, t}) => {
          const tu = url.replace("/upload/", "/upload/" + t + "/");
          return \`
            <div class="transform-example">
              <img src="\${tu}" alt="\${label}" />
              <p><strong>\${label}</strong></p>
              <button class="copy-btn" data-copy="\${tu}">Copy URL</button>
            </div>\`;
        }).join("");
        document.getElementById("transforms").innerHTML = html;
      } else {
        hide("transformWrap");
        document.getElementById("transforms").innerHTML = "";
      }

      notifyHeight();
    }

    async function followUp(text) {
      if (!window.openai?.sendFollowUpMessage) {
        alert("sendFollowUpMessage not available in this host.");
        return;
      }
      await window.openai.sendFollowUpMessage({ message: text });
    }

    function notifyHeight() {
      try { window.openai?.notifyIntrinsicHeight?.(document.body.scrollHeight); } catch {}
    }

    document.addEventListener("click", async (e) => {
      const btn = e.target?.closest?.("button");
      if (!btn) return;

      // Copy transform URL buttons
      if (btn.classList.contains("copy-btn")) {
        const url = btn.getAttribute("data-copy") || "";
        if (!url) return;
        try { await navigator.clipboard.writeText(url); alert("Copied!"); }
        catch { alert("Copy failed (clipboard blocked)."); }
        return;
      }
    });

    document.getElementById("memeBtn").addEventListener("click", async () => {
      const u = getUpload();
      const url = u?.secure_url || u?.url || "";
      await followUp("Create a funny meme caption for the image I just uploaded. Link: " + url);
    });

    document.getElementById("tweetBtn").addEventListener("click", async () => {
      const u = getUpload();
      const url = u?.secure_url || u?.url || "";
      await followUp("Draft a tweet about this Cloudinary upload and include this link: " + url);
    });

    // Re-render when toolOutput updates (simple polling is fine for workshop)
    setInterval(render, 400);
    render();
    window.addEventListener("load", notifyHeight);
    new ResizeObserver(notifyHeight).observe(document.documentElement);
  </script>
</body>
</html>`;
}


/**
 * 2) Register the ChatGPT template resource in YOUR resources system.
 *
 * You already have a ReadResource handler that reads from `uiByUri`.
 * So: just store CHATGPT_TEMPLATE_URI -> template HTML.
 *
 * IMPORTANT:
 *  - Goose wants "text/html;profile=mcp-app"
 *  - ChatGPT wants "text/html+skybridge" (Apps SDK template)
 */
export function registerChatGptTemplate(uiByUri: Map<string, string>) {
  uiByUri.set(CHATGPT_TEMPLATE_URI, createChatGptTemplateUI());
}

/**
 * 3) Tool descriptor patching (ListTools response)
 *
 * - Goose will happily ignore these keys.
 * - ChatGPT looks for _meta["openai/outputTemplate"] to know which template to render.
 */
export function addChatGptToolMeta(baseTool: any) {
  return {
    ...baseTool,
    _meta: {
      ...(baseTool?._meta || {}),
      // ChatGPT uses this (Apps SDK):
      "openai/outputTemplate": CHATGPT_TEMPLATE_URI,

      // Optional nice-to-haves (keep only if you verify they’re respected in your host):
      // "openai/toolInvocation/invoking": "Uploading to Cloudinary…",
      // "openai/toolInvocation/invoked": "Upload ready",
      // "openai/widgetAccessible": true,
    },
  };
}

/**
 * 4) Tool result patching (CallTool response)
 *
 * - Goose uses: _meta.ui.resourceUri + resources/read to fetch HTML (your current behavior)
 * - ChatGPT uses: structuredContent (becomes window.openai.toolOutput in the template)
 */
export function buildChatGptStructuredContent(upload: CloudinaryUploadSummary): ChatGptToolOutput {
  return {
    // This becomes window.openai.toolOutput.upload inside the template
    upload,
  };
}

/**
 * 5) Resource mimeType helper:
 *
 * In YOUR ReadResource handler, you can do:
 *  - if (uri === CHATGPT_TEMPLATE_URI) mimeType = "text/html+skybridge"
 *  - else mimeType = "text/html;profile=mcp-app"
 *
 * That’s the whole “two resources” idea, translated into your current Map-based server.
 */
export function isChatGptTemplateUri(uri: string) {
  return uri === CHATGPT_TEMPLATE_URI;
}
