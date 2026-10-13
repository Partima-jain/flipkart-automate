/**
 * Learning demo: QR code on your phone → triggers Flipkart session on THIS computer.
 *
 * What this teaches:
 * - A URL can tell YOUR server to do something (launch Playwright).
 * - A URL cannot plant Flipkart cookies into the phone's browser for flipkart.com.
 * - So the logged-in window always opens on the PC, not as Flipkart-on-phone.
 */

const http = require("http");
const os = require("os");
const QRCode = require("qrcode");
const { openFlipkartMobileSession } = require("./lib/session");
const { mobileInjectHtml } = require("./lib/mobile-inject-page");

const PORT = Number(process.env.PORT) || 3847;
let launching = false;
let lastLaunch = null;

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

function htmlPage({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --bg: #0f1419;
      --card: #1a2332;
      --text: #e7ecf3;
      --muted: #9aa8bc;
      --accent: #f8e16c;
      --ok: #6bcB77;
      --line: #2a3548;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", system-ui, sans-serif;
      background:
        radial-gradient(ellipse 80% 50% at 50% -20%, #243552 0%, transparent 55%),
        var(--bg);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    main {
      width: min(440px, 100%);
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 28px 24px;
      text-align: center;
    }
    h1 { font-size: 1.25rem; margin: 0 0 8px; font-weight: 650; }
    p { color: var(--muted); line-height: 1.5; margin: 0 0 16px; font-size: 0.95rem; }
    .qr {
      background: #fff;
      border-radius: 12px;
      padding: 16px;
      display: inline-block;
      margin: 8px 0 16px;
    }
    .qr img { display: block; width: 220px; height: 220px; }
    code, .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8rem;
      color: var(--accent);
      word-break: break-all;
    }
    .lesson {
      text-align: left;
      border-top: 1px solid var(--line);
      margin-top: 20px;
      padding-top: 16px;
    }
    .lesson h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 10px; }
    .lesson li { margin: 0 0 8px; color: var(--text); font-size: 0.9rem; line-height: 1.4; }
    .ok { color: var(--ok); font-weight: 600; }
    a.btn {
      display: inline-block;
      margin-top: 8px;
      padding: 12px 18px;
      background: var(--accent);
      color: #1a1a1a;
      text-decoration: none;
      border-radius: 10px;
      font-weight: 650;
    }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

async function handleLaunch(res) {
  if (launching) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage({
        title: "Already launching",
        body: `
          <h1>Already launching…</h1>
          <p>A Flipkart session is already being opened on the computer.</p>
          <p class="ok">Look at your computer screen — not this phone.</p>
        `,
      })
    );
    return;
  }

  launching = true;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    htmlPage({
      title: "Triggered on computer",
      body: `
        <h1>Signal received ✓</h1>
        <p>Your phone only hit <span class="mono">this demo server</span>.</p>
        <p class="ok">Flipkart should now open on your computer, already logged in via cookies.</p>
        <div class="lesson">
          <h2>What just happened</h2>
          <ol>
            <li>QR → URL on <em>your LAN server</em> (not Flipkart).</li>
            <li>Server ran Playwright and injected cookies locally.</li>
            <li>Phone browser never received Flipkart auth cookies — browsers forbid that.</li>
          </ol>
        </div>
      `,
    })
  );

  try {
    const { browser, accountId, cookieCount } = await openFlipkartMobileSession();
    lastLaunch = { at: new Date().toISOString(), accountId, cookieCount };
    console.log(`[launch] ${cookieCount} cookies → ${accountId}`);
    browser.on("disconnected", () => {
      console.log("[launch] browser closed");
      launching = false;
    });
  } catch (err) {
    launching = false;
    console.error("[launch] failed:", err.message || err);
  }
}

async function start() {
  const lanIp = getLanIp();
  const triggerUrl = `http://${lanIp}:${PORT}/launch`;
  const mobileUrl = `http://${lanIp}:${PORT}/mobile`;
  const qrDataUrl = await QRCode.toDataURL(triggerUrl, {
    margin: 1,
    width: 440,
    errorCorrectionLevel: "M",
  });
  const mobileQrDataUrl = await QRCode.toDataURL(mobileUrl, {
    margin: 1,
    width: 440,
    errorCorrectionLevel: "M",
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/launch") {
      await handleLaunch(res);
      return;
    }

    if (url.pathname === "/mobile") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(mobileInjectHtml());
      return;
    }

    if (url.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ launching, lastLaunch, triggerUrl, mobileUrl }, null, 2));
      return;
    }

    // Home: show both demos
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage({
        title: "Cookie learning demos",
        body: `
          <h1>Two learning demos</h1>
          <p>Same Wi‑Fi for phone ↔ PC links.</p>

          <h2 style="text-align:left;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin:18px 0 8px;">A) On-device (phone browser)</h2>
          <p>Bookmarklet runs on Flipkart and sets cookies in <em>this</em> phone browser.</p>
          <div class="qr"><img src="${mobileQrDataUrl}" alt="QR for mobile inject" /></div>
          <p class="mono">${mobileUrl}</p>
          <a class="btn" href="/mobile">Open phone inject guide</a>

          <h2 style="text-align:left;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin:28px 0 8px;">B) On PC via QR</h2>
          <p>Scan to launch Playwright on the computer (not logged-in Flipkart on the phone).</p>
          <div class="qr"><img src="${qrDataUrl}" alt="QR for PC launch" /></div>
          <p class="mono">${triggerUrl}</p>
          <a class="btn" href="/launch">Launch on this computer</a>

          <div class="lesson">
            <h2>Learning takeaway</h2>
            <ul>
              <li>Random webpages cannot set flipkart.com cookies.</li>
              <li>A bookmarklet can, because it runs on flipkart.com itself.</li>
              <li>Playwright can set cookies because it controls the whole browser profile.</li>
            </ul>
          </div>
        `,
      })
    );
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("Learning demos running");
    console.log(`  Home:          http://127.0.0.1:${PORT}`);
    console.log(`  Phone inject:  ${mobileUrl}`);
    console.log(`  PC launch QR:  ${triggerUrl}`);
    console.log("");
    console.log("For on-phone login testing, open /mobile on your phone.");
    console.log("Ctrl+C to stop.");
  });
}

start().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
