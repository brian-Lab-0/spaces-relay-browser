/**
 * Agent Browser Relay — CDP screencast + WebSocket bridge
 *
 * Architecture: Chrome's built-in Page.startScreencast pushes JPEG frames
 * continuously (~20fps during activity, 0fps when idle). No more
 * "action → wait → screenshot" blocking cycle.
 *
 * Client → Server (actions):
 *   { action: 'navigate', url }
 *   { action: 'click' | 'mouseDown' | 'mouseUp' | 'mouseMove', x, y }
 *   { action: 'type', text }
 *   { action: 'key', key }           — Playwright key name or chord e.g. 'Control+a'
 *   { action: 'scroll', deltaY }
 *   { action: 'back' | 'forward' | 'refresh' | 'screenshot' }
 *   { action: 'get_content' }        — returns text content (no screenshot needed)
 *   { action: 'copy' }               — returns selected text as { clipboard }
 *   { action: 'setQuality', quality }
 *   { action: 'resize', width, height }
 *
 * Server → Client (stream + events):
 *   { screenshot: '<base64 jpeg>', url, title }  — continuous stream frames
 *   { cursor: 'pointer' | 'default' | ... }      — hover cursor style
 *   { clipboard: '...' }                          — copy result
 *   { url, title, content }                       — get_content result
 *   { error: '...' }
 */

const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

const PORT   = process.env.PORT || 3333;
const VIEWPORT = { width: 1280, height: 720 };

const wss = new WebSocketServer({ port: PORT });
console.log(`[browser-relay] Listening on ws://localhost:${PORT}`);

wss.on('connection', async (ws) => {
  console.log('[browser-relay] New connection — launching browser…');
  let browser, context, page, cdp;
  let streamQuality  = 60;
  let streamEveryNth = 2;   // ~30fps at Chrome's 60fps compositor

  // ── Launch browser ──────────────────────────────────────────────────────────
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-infobars',
        '--lang=en-US',
      ],
    });
    context = await browser.newContext({
      viewport: VIEWPORT,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });
    page = await context.newPage();
    cdp  = await context.newCDPSession(page);

    // Intercept new-tab navigations (target="_blank" links) and load them in the current page
    context.on('page', async (newPage) => {
      const url = newPage.url();
      await newPage.close().catch(() => {});
      if (url && url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    });

    console.log('[browser-relay] Browser ready');
  } catch (err) {
    console.error('[browser-relay] Launch failed:', err.message);
    ws.send(JSON.stringify({ error: `Failed to launch browser: ${err.message}` }));
    ws.close();
    return;
  }

  // ── CDP screencast ──────────────────────────────────────────────────────────
  // Pushes JPEG frames continuously; ~0fps when page is visually idle.

  const startScreencast = async () => {
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: streamQuality,
      maxWidth:  VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: streamEveryNth,
    }).catch(() => {});
  };

  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ screenshot: data, url: page.url() }));
  });

  await startScreencast();

  // Restart screencast after navigation (stream resets on page load)
  page.on('load', async () => {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await startScreencast();
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ url: page.url(), title: await page.title().catch(() => '') }));
    }
  });

  // ── Navigation helper ───────────────────────────────────────────────────────
  // Waits for navigation to commit + DOM ready. Stream shows live loading progress.
  const withNav = async (action, commitTimeout = 800) => {
    const commitPromise = page.waitForNavigation({ waitUntil: 'commit',          timeout: commitTimeout }).catch(() => null);
    const loadPromise   = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12_000       }).catch(() => null);
    await action();
    if (await commitPromise !== null) {
      await loadPromise;
      return true;
    }
    return false;
  };

  // ── Serial action queue ─────────────────────────────────────────────────────
  let queueBusy = false;
  const queue   = [];

  const enqueue = (fn, type) => {
    if (type === 'mouseMove' || type === 'scroll') {
      const i = queue.findIndex(e => e.type === type);
      if (i !== -1) queue.splice(i, 1);
    }
    queue.push({ fn, type });
    if (!queueBusy) drain();
  };

  const drain = async () => {
    queueBusy = true;
    while (queue.length > 0) {
      const { fn } = queue.shift();
      try { await fn(); } catch (err) {
        console.error('[browser-relay] Action error:', err.message);
        if (ws.readyState === 1) ws.send(JSON.stringify({ error: err.message }));
      }
    }
    queueBusy = false;
  };

  // ── Action dispatcher ───────────────────────────────────────────────────────
  // Most actions no longer need to trigger a screenshot — the stream handles it.

  const dispatch = async (cmd) => {
    switch (cmd.action) {

      case 'navigate': {
        let url = String(cmd.url || '').trim();
        if (!url.startsWith('http')) url = 'https://' + url;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        // Stream shows live progress; networkidle wait removed from queue
        break;
      }

      case 'resize':
        if (cmd.width && cmd.height) {
          await page.setViewportSize({ width: Number(cmd.width), height: Number(cmd.height) });
          await cdp.send('Page.stopScreencast').catch(() => {});
          await startScreencast();
        }
        break;

      case 'setQuality':
        streamQuality  = Math.max(10, Math.min(100, Number(cmd.quality)      || 60));
        streamEveryNth = Math.max(1,  Math.min(10,  Number(cmd.everyNthFrame) || 2));
        await cdp.send('Page.stopScreencast').catch(() => {});
        await startScreencast();
        break;

      case 'mouseMove': {
        const mx = Number(cmd.x), my = Number(cmd.y);
        await page.mouse.move(mx, my);
        // Cursor style detection: fire-and-forget, client applies it as CSS cursor on the img
        page.evaluate(([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return el ? window.getComputedStyle(el).cursor : 'default';
        }, [mx, my])
          .then(c => { if (ws.readyState === 1) ws.send(JSON.stringify({ cursor: c })); })
          .catch(() => {});
        break;
      }

      case 'mouseDown':
        await page.mouse.move(Number(cmd.x), Number(cmd.y));
        await page.mouse.down();
        break;

      case 'mouseUp':
        await page.mouse.move(Number(cmd.x), Number(cmd.y));
        await page.mouse.up();
        break;

      case 'click': {
        await withNav(() => page.mouse.click(Number(cmd.x), Number(cmd.y)), 1000);
        break;
      }

      case 'type':
        await page.keyboard.type(String(cmd.text ?? ''));
        break;

      case 'key': {
        const key = String(cmd.key ?? 'Enter');
        if (key === 'Enter') {
          await withNav(() => page.keyboard.press(key), 1000);
        } else {
          await page.keyboard.press(key);
        }
        break;
      }

      case 'scroll': {
        const vp = page.viewportSize() ?? VIEWPORT;
        await page.mouse.move(vp.width / 2, vp.height / 2);
        await page.mouse.wheel(0, Number(cmd.deltaY ?? 300));
        break;
      }

      case 'back':
        try { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }); } catch {}
        break;

      case 'forward':
        try { await page.goForward({ waitUntil: 'domcontentloaded', timeout: 10_000 }); } catch {}
        break;

      case 'refresh':
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
        break;

      case 'screenshot': {
        // On-demand screenshot for agent tools (stream bypasses this for UI)
        const buf = await page.screenshot({ type: 'jpeg', quality: streamQuality });
        ws.send(JSON.stringify({ screenshot: buf.toString('base64'), url: page.url(), title: await page.title().catch(() => '') }));
        break;
      }

      case 'copy': {
        const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '').catch(() => '');
        if (selected && ws.readyState === 1) ws.send(JSON.stringify({ clipboard: selected }));
        break;
      }

      case 'get_content': {
        try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}
        const content = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 15000)).catch(() => '');
        ws.send(JSON.stringify({ url: page.url(), title: await page.title().catch(() => ''), content }));
        break;
      }

      default:
        if (ws.readyState === 1) ws.send(JSON.stringify({ error: `Unknown action: ${cmd.action}` }));
    }
  };

  // ── Message entry point ─────────────────────────────────────────────────────
  ws.on('message', (data) => {
    let cmd;
    try { cmd = JSON.parse(data.toString()); }
    catch { if (ws.readyState === 1) ws.send(JSON.stringify({ error: 'Invalid JSON' })); return; }
    enqueue(() => dispatch(cmd), cmd.action);
  });

  ws.on('close', async () => {
    console.log('[browser-relay] Connection closed — closing browser');
    try { await browser?.close(); } catch {}
  });
});
