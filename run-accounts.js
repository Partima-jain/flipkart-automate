/**
 * Loop each account in cookie.json:
 * open logged-in Incognito → cart → close window → next account.
 * Watches navigations for order-success signals (does NOT place orders).
 *
 * Optional checklist prompts: node run-accounts.js --ask
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const { openFlipkartMobileSession } = require("./lib/session");

const COOKIE_FILE = path.join(__dirname, "cookie.json");
const RESULTS_FILE = path.join(__dirname, "account-results.json");
const CART_URL = "https://www.flipkart.com/viewcart";
const ASK = process.argv.includes("--ask");

/** URL patterns that usually mean checkout finished successfully */
const ORDER_SUCCESS_URL = [
  /order[_-]?success/i,
  /payment[_-]?success/i,
  /thank[_-]?you/i,
  /order[_-]?confirm/i,
  /confirmed/i,
  /\/rv\/checkout\/success/i,
  /[?&]orderId=/i,
  /[?&]oid=/i,
  /\/order_details/i,
  /\/orders?\/[^/]+/i,
];

const ORDER_SUCCESS_TEXT = [
  /order\s+placed/i,
  /ordered\s+successfully/i,
  /thank you for your order/i,
  /your order has been placed/i,
  /order confirmed/i,
];

function readAccountIds() {
  const data = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
  const accounts = Array.isArray(data.ids) ? data.ids : [];
  if (!accounts.length) throw new Error("No accounts found in cookie.json.");

  const ids = accounts.map((a) => a.id);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("Every account must have a unique, non-empty ID.");
  }
  return ids;
}

function readResults() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveResults(results) {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
}

function allPages(browser) {
  try {
    return browser.contexts().flatMap((c) => c.pages());
  } catch {
    return [];
  }
}

function looksLikeOrderSuccess(url) {
  return ORDER_SUCCESS_URL.some((re) => re.test(url || ""));
}

function attachOrderWatcher(browser, state) {
  const mark = (url, reason) => {
    if (state.order_placed) return;
    state.order_placed = true;
    state.evidence_url = url;
    state.evidence = reason;
    console.log(`Order signal detected (${reason}): ${url}`);
  };

  const watchPage = (page) => {
    const checkUrl = () => {
      try {
        const url = page.url();
        if (looksLikeOrderSuccess(url)) mark(url, "url");
      } catch (_) {
        /* page may be closing */
      }
    };

    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) checkUrl();
    });
    page.on("load", checkUrl);
    checkUrl();
  };

  for (const context of browser.contexts()) {
    context.on("page", watchPage);
    for (const page of context.pages()) watchPage(page);
  }

  // Also scan visible text occasionally (Flipkart success copy)
  const textPoll = setInterval(async () => {
    if (state.order_placed || !browser.isConnected()) return;
    for (const page of allPages(browser)) {
      try {
        const url = page.url();
        const body = await page.locator("body").innerText({ timeout: 1000 });
        if (ORDER_SUCCESS_TEXT.some((re) => re.test(body))) {
          mark(url, "page_text");
          return;
        }
      } catch (_) {
        /* ignore transient errors */
      }
    }
  }, 1500);

  return () => clearInterval(textPoll);
}

/**
 * Closing an Incognito window often leaves CDP connected.
 * Treat "no pages left" OR browser disconnect as "session done".
 */
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

async function askChecklist(rl, id, results, detected) {
  const hint = detected.order_placed
    ? "detected success page"
    : "no success page seen";
  const order = (
    await rl.question(
      `Order confirmed? Enter 'complete' or 'pending' [${hint}]: `
    )
  )
    .trim()
    .toLowerCase();

  let status;
  if (order === "complete") status = "complete";
  else if (order === "pending") status = "pending";
  else status = detected.order_placed ? "complete" : "pending";

  const yn = async (label) => {
    const answer = (await rl.question(label)).trim().toLowerCase();
    if (answer === "yes" || answer === "y") return true;
    if (answer === "no" || answer === "n") return false;
    return null;
  };

  results[id] = {
    status,
    order_placed: detected.order_placed,
    evidence: detected.evidence || null,
    evidence_url: detected.evidence_url || null,
    session_valid: await yn("Was the account logged in and verified? (yes/no): "),
    cart_verified: await yn("Was the intended item verified in the cart? (yes/no): "),
    cod_available: await yn("Was COD available? (yes/no/unknown): "),
    checked_at: new Date().toISOString(),
  };
  saveResults(results);
  console.log(`Saved result for ${id}: ${status} (order_placed=${detected.order_placed})`);
}

async function main() {
  const ids = readAccountIds();
  const results = readResults();
  const rl = ASK
    ? readline.createInterface({ input: stdin, output: stdout })
    : null;

  console.log(`Accounts to process: ${ids.length}`);
  console.log("Close each Incognito window to open the next account automatically.");
  console.log("If you reach an order-success screen, results will mark order_placed=true.");
  if (ASK) console.log("Checklist prompts enabled (--ask).\n");
  else console.log("Tip: use --ask for manual yes/no checklist between accounts.\n");

  try {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      console.log(`\n=== [${i + 1}/${ids.length}] ${id} ===`);
      let browser;
      let cleanup = () => {};
      const detected = {
        order_placed: false,
        evidence: null,
        evidence_url: null,
      };
      let stopWatcher = () => {};

      try {
        const session = await openFlipkartMobileSession(id);
        browser = session.browser;
        cleanup = session.cleanup || cleanup;
        console.log(`Loaded ${session.cookieCount} cookies for ${session.accountId}`);

        stopWatcher = attachOrderWatcher(browser, detected);

        const context = browser.contexts()[0];
        const page = context.pages()[0];
        await page.goto(CART_URL, { waitUntil: "domcontentloaded" });

        console.log("Cart opened:", page.url());
        console.log("Close this Incognito window when finished → next account opens.");

        await waitUntilSessionDone(browser);
        console.log(
          detected.order_placed
            ? `Window closed. Order likely placed (${detected.evidence}).`
            : "Window closed. No order-success page detected."
        );
      } finally {
        stopWatcher();
        try {
          if (browser?.isConnected()) await browser.close();
        } catch (_) {
          /* ignore */
        }
        cleanup();
      }

      if (ASK && rl) {
        await askChecklist(rl, id, results, detected);
      } else {
        results[id] = {
          status: detected.order_placed ? "complete" : "pending",
          order_placed: detected.order_placed,
          evidence: detected.evidence || null,
          evidence_url: detected.evidence_url || null,
          checked_at: new Date().toISOString(),
          window_closed: true,
        };
        saveResults(results);
        console.log(
          `Saved ${id}: status=${results[id].status}, order_placed=${results[id].order_placed}`
        );
      }
    }
  } finally {
    if (rl) rl.close();
  }

  console.log(`\nAll accounts processed. Results: ${RESULTS_FILE}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
