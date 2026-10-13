const { chromium, devices } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const COOKIE_FILE = path.join(__dirname, "..", "cookie.json");
const FLIPKART_URL = "https://www.flipkart.com/";
const COOKIE_DOMAIN = ".flipkart.com";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/** Parse a raw Cookie header string into Playwright / CDP cookie objects. */
function parseCookieHeader(raw, domain) {
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return null;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name) return null;
      // Incognito Chrome is strict: Secure + SameSite required for HTTPS sites
      return {
        name,
        value,
        domain,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        url: FLIPKART_URL,
      };
    })
    .filter(Boolean);
}

/** Set cookies via CDP — more reliable than addCookies when using connectOverCDP. */
async function injectCookiesViaCdp(client, cookies) {
  await client.send("Network.enable");
  let success = 0;
  for (const c of cookies) {
    const result = await client.send("Network.setCookie", {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    if (result && result.success) success += 1;
  }
  return success;
}

function loadCookiesFromFile(wantId) {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(`Missing cookie.json. Export your Flipkart cookies there first.`);
  }

  const data = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
  const entries = Array.isArray(data.ids) ? data.ids : [];
  if (!entries.length || !entries[0].cookie) {
    throw new Error("cookie.json has no ids[0].cookie string.");
  }

  const entry = wantId
    ? entries.find((e) => e.id === wantId)
    : entries[0];

  if (!entry) {
    throw new Error(`No account found for id: ${wantId}`);
  }

  const cookies = parseCookieHeader(entry.cookie, COOKIE_DOMAIN);
  if (!cookies.length) {
    throw new Error("Parsed zero cookies from the cookie string.");
  }

  return { accountId: entry.id, cookies };
}

function findChromePath() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function waitForCdp(port, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error("Timed out waiting for Chrome Incognito (CDP)."));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

/**
 * Launch real Google Chrome in Incognito, then attach Playwright.
 * (Playwright's bundled Chromium ignores --incognito for the automated window.)
 */
async function launchChromeIncognito() {
  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error(
      "Google Chrome not found. Install Chrome, or remove the Incognito requirement."
    );
  }

  const port = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fk-incognito-"));

  const chromeProc = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--incognito",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "about:blank",
    ],
    {
      stdio: "ignore",
      detached: true,
    }
  );
  chromeProc.unref();

  const cleanup = () => {
    try {
      process.kill(chromeProc.pid);
    } catch (_) {
      /* already closed */
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  };

  try {
    await waitForCdp(port);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    browser.on("disconnected", cleanup);
    return { browser, cleanup, chromePid: chromeProc.pid };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Opens Flipkart in a Pixel 7 viewport with injected cookies (Chrome Incognito).
 * Returns { browser, cleanup, accountId, cookieCount }.
 */
async function openFlipkartMobileSession(wantId) {
  const { accountId, cookies } = loadCookiesFromFile(wantId);
  const device = devices["Pixel 7"];

  const { browser, cleanup } = await launchChromeIncognito();

  // Native Incognito context created by Chrome --incognito
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());

  const client = await context.newCDPSession(page);
  await client.send("Emulation.setUserAgentOverride", {
    userAgent: device.userAgent,
  });
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: device.viewport.width,
    height: device.viewport.height,
    deviceScaleFactor: device.deviceScaleFactor,
    mobile: Boolean(device.isMobile),
  });

  // 1) Open Flipkart origin, 2) plant cookies in this Incognito profile, 3) reload logged-in
  await page.goto(FLIPKART_URL, { waitUntil: "domcontentloaded" });

  const cdpOk = await injectCookiesViaCdp(client, cookies);
  try {
    await context.addCookies(cookies);
  } catch (_) {
    /* CDP path is primary for Incognito attach */
  }

  const { cookies: stored } = await client.send("Network.getCookies", {
    urls: [FLIPKART_URL],
  });
  console.log(
    `Cookie inject: CDP ${cdpOk}/${cookies.length}, stored for Flipkart: ${stored.length}`
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  console.log("Opened Google Chrome in Incognito (mobile viewport).");

  return { browser, cleanup, accountId, cookieCount: cookies.length };
}

module.exports = {
  loadCookiesFromFile,
  openFlipkartMobileSession,
  FLIPKART_URL,
};
