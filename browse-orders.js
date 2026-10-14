/**
 * Open Flipkart accounts one-by-one in normal desktop Chrome (no mobile emulator):
 *   → My Orders → you work (copy/paste OK) → close Chrome → session cleared → next
 *
 * Usage:
 *   node browse-orders.js
 *   node browse-orders.js --cookie-file=cookies-files/cookie-14.json
 *   node browse-orders.js --batch=3          # open N at once; next batch when all closed
 *   node browse-orders.js amrit15            # filter id substring
 */

const fs = require("fs");
const path = require("path");
const { openFlipkartWebSession } = require("./lib/session");

const ORDERS_URL = "https://www.flipkart.com/account/orders";

const COOKIE_FILE_ARG = (
  process.argv.find((a) => a.startsWith("--cookie-file=")) || ""
).split("=")[1];
const COOKIE_FILE = COOKIE_FILE_ARG
  ? path.isAbsolute(COOKIE_FILE_ARG)
    ? COOKIE_FILE_ARG
    : path.join(__dirname, COOKIE_FILE_ARG)
  : fs.existsSync(path.join(__dirname, "cookies-files", "cookie-14.json"))
    ? path.join(__dirname, "cookies-files", "cookie-14.json")
    : path.join(__dirname, "cookie.json");

const BATCH =
  parseInt(
    (process.argv.find((a) => a.startsWith("--batch=")) || "").split("=")[1] ||
      "1",
    10
  ) || 1;

const FILTER = process.argv
  .slice(2)
  .find((a) => a && !a.startsWith("--"));

function readAccountIds() {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(`Missing cookie file: ${COOKIE_FILE}`);
  }
  const data = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
  let accounts = Array.isArray(data.ids) ? data.ids : [];
  if (FILTER) {
    accounts = accounts.filter((a) =>
      String(a.id || "").toLowerCase().includes(FILTER.toLowerCase())
    );
  }
  if (!accounts.length) {
    throw new Error(`No matching accounts in ${path.basename(COOKIE_FILE)}.`);
  }
  return accounts.map((a) => a.id);
}

function allPages(browser) {
  return browser.contexts().flatMap((c) => c.pages());
}

async function waitUntilSessionDone(browser) {
  if (!browser.isConnected()) return;

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve();
    };

    browser.once("disconnected", done);

    const watchPage = (page) => {
      page.once("close", () => {
        setTimeout(() => {
          if (!browser.isConnected() || allPages(browser).length === 0) done();
        }, 400);
      });
    };

    for (const context of browser.contexts()) {
      context.on("page", watchPage);
      for (const page of context.pages()) watchPage(page);
    }

    const poll = setInterval(() => {
      if (!browser.isConnected() || allPages(browser).length === 0) done();
    }, 500);
  });
}

async function clearSession(session) {
  try {
    if (session.browser?.isConnected()) await session.browser.close();
  } catch (_) {
    /* ignore */
  }
  try {
    session.cleanup?.();
  } catch (_) {
    /* ignore */
  }
}

async function openOrdersSession(accountId, slotIndex) {
  const session = await openFlipkartWebSession(accountId, {
    slotIndex,
    cookieFile: COOKIE_FILE,
  });
  const page = session.browser.contexts()[0].pages()[0];
  await page.goto(ORDERS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  console.log(`  → Orders open (desktop): ${accountId}`);
  return session;
}

async function main() {
  const ids = readAccountIds();
  const batchSize = Math.max(1, BATCH);
  const totalBatches = Math.ceil(ids.length / batchSize);

  console.log(`Accounts: ${ids.length}`);
  console.log(`Cookies:  ${COOKIE_FILE}`);
  console.log(
    batchSize === 1
      ? "Mode: 1 desktop Chrome at a time → My Orders → close → next (copy/paste OK)\n"
      : `Mode: ${batchSize} desktop Chrome at a time → close all → next batch\n`
  );

  for (let b = 0; b < totalBatches; b++) {
    const batch = ids.slice(b * batchSize, (b + 1) * batchSize);
    console.log(
      `=== ${batchSize === 1 ? "Account" : "Batch"} ${b + 1}/${totalBatches} ===`
    );
    for (const id of batch) console.log(`  ${id}`);

    const sessions = [];
    for (let i = 0; i < batch.length; i++) {
      try {
        sessions.push(await openOrdersSession(batch[i], i));
      } catch (err) {
        console.error(`  Failed ${batch[i]}: ${err.message || err}`);
      }
      if (i < batch.length - 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    if (!sessions.length) {
      console.log("  No sessions opened — skipping.\n");
      continue;
    }

    console.log(
      batchSize === 1
        ? "\nClose this Chrome when done — next account opens after.\n"
        : `\nClose all ${sessions.length} Chrome window(s) — next batch after.\n`
    );

    await Promise.all(
      sessions.map(async (session) => {
        await waitUntilSessionDone(session.browser);
        await clearSession(session);
        console.log(`  Cleared: ${session.accountId}`);
      })
    );
    console.log("");
  }

  console.log("All accounts finished.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
