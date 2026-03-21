/**
 * Agent Browser Relay — WebSocket → Playwright bridge
 * Run: node relay.js  (listens on ws://localhost:3333)
 *
 * Protocol (JSON messages both ways):
 *
 * Client → Server:
 *   { action: 'navigate', url: 'https://...' }
 *   { action: 'click', x: 640, y: 360 }          — viewport coords (1280×720)
 *   { action: 'type', text: 'hello' }
 *   { action: 'key', key: 'Enter' }               — Playwright key name
 *   { action: 'scroll', deltaY: 300 }
 *   { action: 'back' }
 *   { action: 'forward' }
 *   { action: 'refresh' }
 *   { action: 'screenshot' }                      — take screenshot only
 *   { action: 'get_content' }                     — get text content only (no screenshot)
 *
 * Server → Client:
 *   { screenshot: '<base64 jpeg>', url, title, content? }
 *   { url, title, content }                        — for get_content
 *   { error: '...', url? }
 */

const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3333;
const VIEWPORT = { width: 1280, height: 720 };

const wss = new WebSocketServer({ port: PORT });
console.log(`[browser-relay] Listening on ws://localhost:${PORT}`);

wss.on('connection', async (ws) => {
  console.log('[browser-relay] New connection — launching browser…');
  let browser, page;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT });
    page = await context.newPage();
    console.log('[browser-relay] Browser ready');
  } catch (err) {
    console.error('[browser-relay] Launch failed:', err.message);
    ws.send(JSON.stringify({ error: `Failed to launch browser: ${err.message}` }));
    ws.close();
    return;
  }

  /** Take screenshot + optionally extract text content, send as JSON */
  const sendScreenshot = async (includeContent = false) => {
    if (ws.readyState !== 1) return;
    try {
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 72 });
      const msg = {
        screenshot: screenshot.toString('base64'),
        url: page.url(),
        title: await page.title().catch(() => ''),
      };
      if (includeContent) {
        msg.content = await page.evaluate(() =>
          (document.body?.innerText ?? '').slice(0, 8000)
        ).catch(() => '');
      }
      ws.send(JSON.stringify(msg));
    } catch (err) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ error: err.message }));
    }
  };

  ws.on('message', async (data) => {
    let cmd;
    try { cmd = JSON.parse(data.toString()); }
    catch { ws.send(JSON.stringify({ error: 'Invalid JSON' })); return; }

    try {
      switch (cmd.action) {

        case 'navigate': {
          let url = String(cmd.url || '').trim();
          if (!url.startsWith('http')) url = 'https://' + url;
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          // Wait for content to stabilise — catches React/Vue/Next SPAs that hydrate after load
          try {
            await page.waitForFunction(
              () => (document.body?.innerText?.trim().length ?? 0) > 100,
              { timeout: 6000 }
            );
          } catch { /* image-heavy or intentionally minimal page — proceed */ }
          await page.waitForTimeout(600); // brief settle for late JS renders
          await sendScreenshot(true);
          break;
        }

        case 'resize':
          if (cmd.width && cmd.height) {
            await page.setViewportSize({ width: Number(cmd.width), height: Number(cmd.height) });
            await page.waitForTimeout(200);
            await sendScreenshot();
          }
          break;

        case 'click':
          await page.mouse.click(Number(cmd.x), Number(cmd.y));
          await page.waitForTimeout(600);
          await sendScreenshot();
          break;

        case 'type':
          await page.keyboard.type(String(cmd.text ?? ''));
          await sendScreenshot();
          break;

        case 'key':
          await page.keyboard.press(String(cmd.key ?? 'Enter'));
          await page.waitForTimeout(400);
          await sendScreenshot();
          break;

        case 'scroll':
          await page.mouse.wheel(0, Number(cmd.deltaY ?? 300));
          await page.waitForTimeout(200);
          await sendScreenshot();
          break;

        case 'back':
          try { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }); }
          catch { /* no history */ }
          await sendScreenshot();
          break;

        case 'forward':
          try { await page.goForward({ waitUntil: 'domcontentloaded', timeout: 10_000 }); }
          catch { /* no history */ }
          await sendScreenshot();
          break;

        case 'refresh':
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
          await sendScreenshot();
          break;

        case 'screenshot':
          await sendScreenshot();
          break;

        case 'get_content': {
          const content = await page.evaluate(() =>
            (document.body?.innerText ?? '').slice(0, 8000)
          ).catch(() => '');
          ws.send(JSON.stringify({
            url: page.url(),
            title: await page.title().catch(() => ''),
            content,
          }));
          break;
        }

        default:
          ws.send(JSON.stringify({ error: `Unknown action: ${cmd.action}` }));
      }
    } catch (err) {
      console.error('[browser-relay] Action error:', err.message);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ error: err.message, url: page?.url?.() }));
      }
    }
  });

  ws.on('close', async () => {
    console.log('[browser-relay] Connection closed — closing browser');
    try { await browser?.close(); } catch { /* ignore */ }
  });
});
