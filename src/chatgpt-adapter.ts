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
  // NOTE: Keep it simple for the workshop. You can progressively move your existing fancy HTML here.
  // TODO (you can narrate this live):
  // - Replace this minimal UI with your nicer Cloudinary UI
  // - Add error states + loading states
  // - Add transformations panel, etc.
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cloudinary Upload</title>
    <style>
      body { font-family: system-ui; padding: 16px; margin: 0; }
      .card { border: 1px solid #e5e5e5; border-radius: 12px; padding: 14px; }
      .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
      img, video { max-width: 100%; border-radius: 12px; }
      button { padding: 10px 12px; border-radius: 10px; border: 1px solid #ccc; background: white; cursor: pointer; }
      button:hover { background: #f7f7f7; }
      code { background: #f3f3f3; padding: 2px 6px; border-radius: 6px; }
      .muted { color: #666; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2 style="margin-top:0;">☁️ Cloudinary Upload</h2>
      <p class="muted" id="status">Waiting for tool output…</p>

      <div id="preview" style="margin: 12px 0;"></div>
      <div id="details"></div>

      <div class="row" style="margin-top: 14px;">
        <button id="memeBtn">🎭 Make meme caption</button>
        <button id="tweetBtn">📱 Draft tweet</button>
        <button id="copyBtn">🔗 Copy URL</button>
      </div>

      <p class="muted" style="margin-bottom:0;margin-top:12px;">
        Data source: <code>window.openai.toolOutput</code>
      </p>
    </div>

    <script>
      // ChatGPT-specific: window.openai is the widget runtime injected by ChatGPT.
      // It exposes toolOutput (your structuredContent), plus helpers like:
      // - sendFollowUpMessage
      // - notifyIntrinsicHeight
      // (Exact helpers may vary by host/runtime.)

      function getToolOutput() {
        try {
          return window.openai?.toolOutput || null;
        } catch {
          return null;
        }
      }

      function bytesToMb(bytes) {
        if (typeof bytes !== "number") return "";
        return (bytes / 1024 / 1024).toFixed(2) + " MB";
      }

      function render() {
        const out = getToolOutput();
        const statusEl = document.getElementById("status");
        const previewEl = document.getElementById("preview");
        const detailsEl = document.getElementById("details");

        if (!out || !out.upload) {
          statusEl.textContent = "Waiting for tool output… run the upload tool.";
          previewEl.innerHTML = "";
          detailsEl.innerHTML = "";
          return;
        }

        const u = out.upload;
        statusEl.textContent = "Upload loaded ✅";

        const url = u.secure_url || u.url || "";
        const isImage = u.resource_type === "image";
        const isVideo = u.resource_type === "video";

        if (url && (isImage || isVideo)) {
          previewEl.innerHTML = isImage
            ? \`<img src="\${url}" alt="Uploaded image" />\`
            : \`<video controls><source src="\${url}" /></video>\`;
        } else {
          previewEl.innerHTML = "";
        }

        detailsEl.innerHTML = \`
          <p><strong>public_id:</strong> <code>\${u.public_id}</code></p>
          <p><strong>type:</strong> <code>\${u.resource_type}</code> \${u.format ? \`(<code>\${u.format}</code>)\` : ""}</p>
          \${u.bytes ? \`<p><strong>size:</strong> \${bytesToMb(u.bytes)}</p>\` : ""}
          \${u.created_at ? \`<p><strong>created:</strong> \${u.created_at}</p>\` : ""}
          \${url ? \`<p><strong>url:</strong> <code>\${url}</code></p>\` : ""}
        \`;

        // Tell ChatGPT our iframe height so it sizes nicely.
        try {
          window.openai?.notifyIntrinsicHeight?.(document.body.scrollHeight);
        } catch {}
      }

      async function followUp(text) {
        // ChatGPT-specific: sendFollowUpMessage posts a user-visible message from the widget.
        if (!window.openai?.sendFollowUpMessage) {
          alert("window.openai.sendFollowUpMessage not available.");
          return;
        }
        await window.openai.sendFollowUpMessage({ message: text });
      }

      document.getElementById("memeBtn").addEventListener("click", async () => {
        const out = getToolOutput();
        const url = out?.upload?.secure_url || out?.upload?.url || "";
        await followUp(\`Create a funny meme caption for this upload. Link: \${url}\`);
      });

      document.getElementById("tweetBtn").addEventListener("click", async () => {
        const out = getToolOutput();
        const url = out?.upload?.secure_url || out?.upload?.url || "";
        await followUp(\`Draft a tweet about this Cloudinary upload and include this link: \${url}\`);
      });

      document.getElementById("copyBtn").addEventListener("click", async () => {
        const out = getToolOutput();
        const url = out?.upload?.secure_url || out?.upload?.url || "";
        if (!url) return alert("No URL to copy.");
        await navigator.clipboard.writeText(url);
        alert("Copied!");
      });

      // Simple polling so the template updates after each tool call.
      // TODO: Replace with a runtime subscription if you build a richer UI framework later.
      setInterval(render, 400);
      render();
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
