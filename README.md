# Cloudinary MCP App → ChatGPT Workshop

A Streamable HTTP MCP server that uploads images/videos to Cloudinary and exposes a rich interactive UI that works in:

✅ ChatGPT Apps  
✅ Goose  
✅ Any MCP host

This repo is used in the workshop:

> **“Plug Your MCP App into ChatGPT”**

It demonstrates how to:

- Convert an MCP App into a ChatGPT-compatible app
- Serve MCP over Streamable HTTP
- Host it on Railway
- Use one server for Goose + ChatGPT

---

## Architecture Overview

```
ChatGPT
   ↓
Streamable HTTP (Railway)
   ↓
Cloudinary MCP Server
   ↓
Cloudinary API
```

The same server supports:

- Goose MCP Apps (ui:// resources)
- ChatGPT Apps SDK (skybridge template + structured output)

---

## Features

- Upload images/videos to Cloudinary
- Interactive UI preview
- Works in ChatGPT + Goose
- Structured tool output for ChatGPT
- MCP App UI for Goose
- Remote Streamable HTTP deployment
- Stateless server (safe for hosting)

---

## Requirements

- Node.js 18+
- Cloudinary account

Get credentials:

👉 https://console.cloudinary.com/settings/api-keys

You’ll need:

```
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
```

---

## Local Development

### Install

```bash
npm install
```

### Run dev server

```bash
npm run dev
```

Server runs at:

```
http://localhost:3000
```

Health check:

```
GET /
```

MCP endpoint:

```
POST /mcp
```

---

## Environment Variables

Create a `.env` file in the project root:

```
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

Do NOT commit this file.

---

## Deploy to Railway

1. Push repo to GitHub
2. Go to https://railway.app
3. New Project → Deploy from GitHub
4. Select this repo
5. Add environment variables in Railway dashboard
6. Deploy

Railway will give you a URL:

```
https://your-app.up.railway.app
```

Your MCP endpoint becomes:

```
https://your-app.up.railway.app/mcp
```

---

## Connect to Goose

Add a remote extension:

```
goose configure
```

Choose:

```
Remote Extension (Streamable HTTP)
```

Endpoint:

```
https://your-app.up.railway.app/mcp
```

Now Goose can call the Cloudinary upload tool.

---

## Connect to ChatGPT

In ChatGPT:

Add a custom MCP app using the same endpoint:

```
https://your-app.up.railway.app/mcp
```

ChatGPT will:

- load the template UI
- inject structured tool output
- render the upload preview

---

## Available Tool

### upload

Uploads media to Cloudinary.

Parameters:

- `file_path` — local path (Goose)
- `file` — URL or data URI (ChatGPT)
- `resource_type` — image/video/raw
- `public_id`
- `overwrite`
- `tags`

Returns:

- JSON metadata
- interactive UI
- ChatGPT structured output

---

## Workshop Goals

This project teaches:

- MCP server structure
- Streamable HTTP hosting
- ChatGPT adapter pattern
- Template + structuredContent bridge
- Cross-host UI compatibility

