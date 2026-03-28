# Spaces Browser Relay

> A lightweight open-source WebSocket-to-Playwright bridge that gives **Spaces** AI agents a live, interactive browser window — streaming real-time JPEG frames directly to the agent workspace.

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/powered%20by-Playwright-2EAD33)](https://playwright.dev)

---

## What is this?

The relay is a tiny Node.js server (~280 lines) that:

1. Accepts a WebSocket connection from the Spaces agent UI
2. Launches a headless Chromium browser via Playwright
3. Streams live JPEG frames back over WebSocket using Chrome's CDP `Page.startScreencast`
4. Receives action commands (click, type, scroll, navigate, …) from the agent and executes them instantly

The result: a Spaces agent can **see** a live browser viewport, navigate the web, read page content, and interact with pages — all from their workspace, without any cloud dependency.

```
Spaces UI  ←──WebSocket──→  Browser Relay  ←──CDP──→  Chromium (headless)
```

---

## Features

- **Zero cloud dependency** — runs entirely on your own machine
- **Live streaming** — CDP screencast pushes JPEG frames at ~20 fps during activity, 0 fps when idle (no polling loop)
- **Full interaction** — navigate, click, type, scroll, select text, go back/forward, resize viewport
- **Anti-detection** — `webdriver` property hidden, realistic UA + locale + timezone
- **New-tab interception** — `target="_blank"` links load in the current page instead of disappearing
- **Serial action queue** — mouse moves and scrolls are deduplicated; actions never race
- **Configurable quality** — client can tune JPEG quality and frame rate at runtime
- **Docker ready** — single container, no extra setup

---

## Quick Start

**Requirements:** Node.js 18+

```bash
# 1. Clone
git clone https://github.com/brian-Lab-0/spaces-relay-browser.git
cd spaces-relay-browser

# 2. Install dependencies
npm install

# 3. Download Chromium (one-time, ~150 MB)
npm run install-browser

# 4. Start the relay
npm start
```

The relay listens on `ws://localhost:3333` by default.

Open Spaces → Agent Chat → Browser window → paste `ws://localhost:3333` → **Launch Browser**.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3333` | WebSocket port to listen on |

```bash
PORT=4444 npm start
```

---

## Running on a Remote Machine (SSH)

You can run the relay on any server and tunnel it securely to your local Spaces instance.

```bash
# On the remote server — start the relay
PORT=3333 node relay.js

# On your local machine — forward the port via SSH
ssh -L 3333:localhost:3333 user@your-server

# In Spaces — connect to
ws://localhost:3333
```

The Spaces Browser window SSH tab automates this flow when you have an SSH connection configured.

---

## Docker

```bash
# Build
docker build -t spaces-relay-browser .

# Run
docker run -p 3333:3333 spaces-relay-browser
```

---

## WebSocket Protocol

All messages are JSON. The relay accepts action commands and streams back frames and events.

### Client → Server (actions)

| Action | Fields | Description |
|---|---|---|
| `navigate` | `url: string` | Navigate to a URL |
| `click` | `x, y: number` | Left-click at viewport coordinates |
| `mouseMove` | `x, y: number` | Move mouse (cursor style returned) |
| `mouseDown` | `x, y: number` | Mouse button down |
| `mouseUp` | `x, y: number` | Mouse button up |
| `type` | `text: string` | Type text into focused element |
| `key` | `key: string` | Press a key (Playwright key name, e.g. `Enter`, `Control+a`) |
| `scroll` | `deltaY: number` | Scroll vertically at center of viewport |
| `back` | — | Browser back |
| `forward` | — | Browser forward |
| `refresh` | — | Reload current page |
| `screenshot` | — | On-demand single JPEG frame |
| `get_content` | — | Returns visible page text (up to 15 000 chars) |
| `copy` | — | Returns current text selection |
| `resize` | `width, height: number` | Resize viewport |
| `setQuality` | `quality: number, everyNthFrame: number` | Tune stream quality (1–100) and frame rate |

```json
{ "action": "navigate",  "url": "https://example.com" }
{ "action": "click",     "x": 640, "y": 360 }
{ "action": "type",      "text": "hello world" }
{ "action": "key",       "key": "Enter" }
{ "action": "scroll",    "deltaY": 300 }
{ "action": "resize",    "width": 1280, "height": 720 }
{ "action": "setQuality","quality": 60, "everyNthFrame": 2 }
```

### Server → Client (stream)

```json
{ "screenshot": "<base64 jpeg>", "url": "https://...", "title": "Page Title" }
{ "cursor": "pointer" }
{ "clipboard": "selected text" }
{ "url": "https://...", "title": "...", "content": "page text..." }
{ "error": "message" }
```

The `screenshot` message streams continuously — the client renders frames as they arrive. No polling, no request/response cycle.

---

## Architecture

```
ws.on('message')
    │
    ▼
enqueue(fn, type)           ← mouseMove / scroll deduplicated
    │
    ▼
drain() → dispatch(cmd)
    │
    ├─ navigate  → page.goto()
    ├─ click     → withNav(page.mouse.click)   ← waits for nav commit
    ├─ type      → page.keyboard.type()
    ├─ key       → withNav(page.keyboard.press) if Enter
    ├─ scroll    → page.mouse.wheel()
    ├─ resize    → page.setViewportSize() + restart screencast
    └─ ...

CDP Page.startScreencast
    │
    ▼ Page.screencastFrame event
ws.send({ screenshot: base64, url, title })
```

**Why CDP screencast instead of polling screenshots?**

Chrome's compositor sends frames only when the page visually changes. During navigation you see live loading progress. When idle, zero frames are sent and zero CPU is used. A polling approach would either miss changes or waste CPU taking screenshots nobody asked for.

---

## Security

- Binds to `localhost` only by default — not exposed to the internet
- For remote access, use SSH port forwarding (recommended) or a firewall rule
- No authentication is built in — treat the WebSocket port as trusted-network only
- Each WebSocket connection gets its own isolated browser instance; closing the connection closes the browser

---

## Contributing

Issues and PRs are welcome. The relay is intentionally minimal (~280 lines) so it stays easy to audit and modify.

**Good first issues:**

- [ ] Multi-tab support (open/close tabs, switch between them)
- [ ] Optional token-based auth header for remote deployments
- [ ] File download support (intercept and return file bytes)
- [ ] Page.screencastFrame title passthrough on every frame (currently only on load)
- [ ] WebP format option alongside JPEG
- [ ] Reconnect / heartbeat on the client side

**Development:**

```bash
git clone https://github.com/brian-Lab-0/spaces-relay-browser.git
cd spaces-relay-browser
npm install
npm run install-browser

# Edit relay.js, then restart
node relay.js
```

The relay has no build step — it's plain Node.js. Edit `relay.js` and restart.

---

## Used By

This relay is the official browser bridge for **[Spaces](https://spaces.openbnet.com)** — a multi-agent AI workspace platform built by the Spaces Dev Team.

Spaces connects AI agents to real tools: browser automation, SSH terminals, canvas artifacts, a skills marketplace, and more.

---

## License

MIT © 2025 Spaces Dev Team
