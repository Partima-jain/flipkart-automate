/**
 * Loop each account in cookie.json:
 * open logged-in Incognito (Pixel 7 responsive) → Buy now → COD → Place Order → next SKU.
 * Skips suggested/wrong/unavailable items. Watches navigations for order-success signals.
 *
 * Parallel accounts (bounded pool — does not open all Chromes at once):
 *   node run-accounts.js --concurrency=3
 *   CONCURRENCY=3 node run-accounts.js
 *
 * Optional checklist prompts (forces concurrency=1): node run-accounts.js --ask
 */
// node run-accounts.js --concurrency=4

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const { openFlipkartMobileSession } = require("./lib/session");

const COOKIE_FILE = path.join(__dirname, "cookie.json");
const RESULTS_FILE = path.join(__dirname, "account-results.json");
const CART_URL = "https://www.flipkart.com/viewcart";
const ASK = process.argv.includes("--ask");

function parseConcurrency() {
  const arg = process.argv.find((a) => a.startsWith("--concurrency="));
  const raw = arg ? arg.split("=")[1] : process.env.CONCURRENCY;
  let n = parseInt(raw || "2", 10);
  if (!Number.isFinite(n) || n < 1) n = 2;
  // Cap so we don't spawn dozens of Chromes and thrash the machine / Flipkart
  const max = Math.max(1, Math.min(6, parseInt(process.env.CONCURRENCY_MAX || "6", 10) || 6));
  if (ASK) return 1;
  return Math.min(n, max);
}

const CONCURRENCY = parseConcurrency();
const START_STAGGER_MS = Math.max(
  0,
  parseInt(process.env.START_STAGGER_MS || "2500", 10) || 2500
);

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


const PRODUCTS = [
  {
    key: "galaxy_s25_fe_first",
    name: "Samsung Galaxy S25 FE 5G",
    url: "https://www.flipkart.com/samsung-galaxy-s25-fe-5g-jetblack-128-gb/p/itm90e887b150eea?pid=MOBHQCH6FPTX5FZ2",
    pid: "MOBHQCH6FPTX5FZ2",
    match: [/galaxy\s*s25\s*fe/i, /s25\s*fe/i],
    quantity: 1, // phone
  },
  {
    key: "galaxy_s25_fe_second",
    name: "Samsung Galaxy S25 FE 5G",
    url: "https://www.flipkart.com/samsung-galaxy-s25-fe-5g-jetblack-128-gb/p/itm90e887b150eea?pid=MOBHQCH6FPTX5FZ2",
    pid: "MOBHQCH6FPTX5FZ2",
    match: [/galaxy\s*s25\s*fe/i, /s25\s*fe/i],
    quantity: 1, // phone
  },
  {
    key: "galaxy_tab_a11",
    name: "Samsung Galaxy Tab A11",
    url: "https://www.flipkart.com/samsung-galaxy-tab-a11-6-gb-ram-128-rom-11-inch-wi-fi-5g-gaming-mediatek-mt8755-tablet-gray/p/itm0c62739da9f41?pid=TABHHQEYGFNBJMB9",
    pid: "TABHHQEYGFNBJMB9",
    match: [/galaxy\s*tab\s*a11/i, /tab\s*a11/i],
    quantity: 2, // tablet
  },
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

let resultsWriteChain = Promise.resolve();

function saveResults(results) {
  // Serialize writes when multiple workers finish near the same time
  resultsWriteChain = resultsWriteChain.then(() => {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  });
  return resultsWriteChain;
}

/** Run up to `concurrency` async workers over items (pool, not all-at-once). */
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  const n = Math.min(Math.max(1, concurrency), items.length || 1);
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

function logFor(id, ...args) {
  console.log(`[${id}]`, ...args);
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

async function fbtSheetVisible(page) {
  return page.evaluate(() => {
    // Already on Order Summary — not FBT
    if (
      Array.from(document.querySelectorAll("h1, .tf3rRV")).some((el) =>
        /^\s*Order Summary\s*$/i.test((el.textContent || "").trim())
      )
    ) {
      return false;
    }

    const heading = Array.from(document.querySelectorAll("h1, h2, .tf3rRV")).find((el) =>
      /Frequently Bought Together/i.test(el.textContent || "")
    );
    if (!heading) return false;
    const style = window.getComputedStyle(heading);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const r = heading.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;

    // Prefer real bottomsheet / sheet chrome (not inline PDP carousel)
    if (
      heading.closest("section.bottomsheetStyles") ||
      heading.closest('[class*="bottomsheet" i]') ||
      heading.closest(".nc3hzK")
    ) {
      return true;
    }

    // Close-X (path 10.543) near the heading = sheet
    const close = Array.from(document.querySelectorAll("a.jlLn4z, a")).find((a) => {
      const d = a.querySelector("svg path")?.getAttribute("d") || "";
      if (!d.includes("10.543")) return false;
      const cr = a.getBoundingClientRect();
      return Math.abs(cr.top - r.top) < 100;
    });
    return !!close;
  }).catch(() => false);
}

/**
 * FBT close X only — SVG path "10.543".
 * Never use bare a.jlLn4z (Order Summary back arrow shares that class).
 */
async function fbtClosePoint(page) {
  return page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("h1, h2, .tf3rRV")).find((el) =>
      /Frequently Bought Together/i.test(el.textContent || "")
    );
    if (!heading) return null;
    const hr = heading.getBoundingClientRect();

    const candidates = Array.from(document.querySelectorAll("a.jlLn4z, a")).filter((a) => {
      const d = a.querySelector("svg path")?.getAttribute("d") || "";
      return d.includes("10.543");
    });

    let best = null;
    let bestDist = Infinity;
    for (const a of candidates) {
      const r = a.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const dist = Math.abs(r.top - hr.top) + Math.abs(r.right - (hr.left + hr.width));
      if (dist < bestDist) {
        bestDist = dist;
        best = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return best;
  }).catch(() => null);
}

/**
 * Left tap that won't open Chrome's context menu.
 * Touch emulation (setEmitTouchEventsForMouse) turns delayed mouse clicks
 * into long-press → Back / Forward / Reload menu.
 */
async function leftTap(page, x, y) {
  // Dismiss any open native context menu first
  await page.keyboard.press("Escape").catch(() => {});

  const viaDom = await page
    .evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return false;
      const target = el.closest("a, button, [role='button']") || el;
      if (typeof target.click === "function") {
        target.click();
        return true;
      }
      target.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          button: 0,
        })
      );
      return true;
    }, { x, y })
    .catch(() => false);

  if (viaDom) return;

  await page.mouse.move(x, y);
  await page.mouse.click(x, y, { button: "left", delay: 0 });
}

/** Yellow "Continue" on Order Summary (sticky bar). */
async function clickOrderSummaryContinue(page) {
  const onSummary = await page
    .locator("h1.tf3rRV, h1")
    .filter({ hasText: /Order Summary/i })
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  const hasDeliver = await page
    .getByText(/Deliver to:/i)
    .first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);

  if (!onSummary && !hasDeliver && !/viewcheckout/i.test(page.url())) {
    return false;
  }

  const pt = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("div")).filter((el) =>
      /^\s*Continue\s*$/i.test((el.textContent || "").trim()) && el.childElementCount === 0
    );
    const yellow = [];
    for (const label of labels) {
      let n = label;
      for (let i = 0; i < 6 && n; i++) {
        const bg = n.style?.backgroundColor || window.getComputedStyle(n).backgroundColor || "";
        if (/rgb\(\s*255\s*,\s*19[0-9]\s*,\s*\d+\s*\)/.test(bg) || bg.includes("255, 194, 0")) {
          const r = n.getBoundingClientRect();
          if (r.width > 50 && r.height > 24 && r.bottom > 40 && r.top < window.innerHeight) {
            yellow.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, yBottom: r.bottom });
          }
          break;
        }
        n = n.parentElement;
      }
    }
    // Prefer sticky footer Continue (lowest on screen)
    if (yellow.length) {
      yellow.sort((a, b) => b.yBottom - a.yBottom);
      return { x: yellow[0].x, y: yellow[0].y };
    }
    for (let i = labels.length - 1; i >= 0; i--) {
      const r = labels[i].getBoundingClientRect();
      if (r.width > 40 && r.height > 10 && r.top > 0 && r.bottom <= window.innerHeight + 20) {
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  }).catch(() => null);

  if (!pt) {
    const cont = page.getByText(/^\s*Continue\s*$/i).last();
    try {
      if (await cont.isVisible({ timeout: 1500 })) {
        await cont.click({ force: true, noWaitAfter: true });
        console.log("Checkout: clicked Continue (locator).");
        return true;
      }
    } catch (_) {
      return false;
    }
    return false;
  }

  await leftTap(page, pt.x, pt.y);
  console.log("Checkout: clicked yellow Continue on Order Summary.");
  await page.waitForTimeout(2000);
  return true;
}

async function dismissFrequentlyBoughtTogether(page) {
  if (!(await fbtSheetVisible(page))) return false;

  console.log("Dismissing Frequently Bought Together sheet…");

  for (let attempt = 0; attempt < 6; attempt++) {
    if (!(await fbtSheetVisible(page))) {
      console.log("FBT sheet gone.");
      return true;
    }

    // Clear Back/Forward context menu if a prior tap long-pressed
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(150);

    // Prefer DOM click on the close-X <a> (avoids touch long-press menu)
    const closedDom = await page
      .evaluate(() => {
        const heading = Array.from(document.querySelectorAll("h1, h2, .tf3rRV")).find((el) =>
          /Frequently Bought Together/i.test(el.textContent || "")
        );
        if (!heading) return false;
        const hr = heading.getBoundingClientRect();
        const anchors = Array.from(document.querySelectorAll("a.jlLn4z, a")).filter((a) => {
          const d = a.querySelector("svg path")?.getAttribute("d") || "";
          return d.includes("10.543");
        });
        let best = null;
        let bestDist = Infinity;
        for (const a of anchors) {
          const r = a.getBoundingClientRect();
          if (r.width < 1) continue;
          const dist = Math.abs(r.top - hr.top);
          if (dist < bestDist) {
            bestDist = dist;
            best = a;
          }
        }
        if (!best) return false;
        best.click();
        return true;
      })
      .catch(() => false);

    if (closedDom) {
      await page.waitForTimeout(600);
      if (!(await fbtSheetVisible(page))) {
        console.log("FBT closed via X.");
        return true;
      }
    }

    const pt = await fbtClosePoint(page);
    if (pt) {
      try {
        await leftTap(page, pt.x, pt.y);
      } catch (_) {
        /* ignore */
      }
      await page.waitForTimeout(600);
      if (!(await fbtSheetVisible(page))) {
        console.log("FBT closed via X.");
        return true;
      }
    }

    // SKIP & CONTINUE fallback
    const skipPt = await page.evaluate(() => {
      const skip = Array.from(document.querySelectorAll("div, button, span")).find((el) =>
        /^\s*SKIP\s*&\s*CONTINUE\s*$/i.test((el.textContent || "").trim())
      );
      if (!skip) return null;
      const r = skip.getBoundingClientRect();
      if (r.width < 1) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }).catch(() => null);
    if (skipPt) {
      await leftTap(page, skipPt.x, skipPt.y).catch(() => {});
      await page.waitForTimeout(600);
      if (!(await fbtSheetVisible(page))) {
        console.log("FBT closed via SKIP & CONTINUE.");
        return true;
      }
    }

    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
  }

  console.log("WARNING: FBT sheet still visible after dismiss attempts.");
  await page.screenshot({ path: "debug-fbt-stuck.png", fullPage: false }).catch(() => {});
  return !(await fbtSheetVisible(page));
}

/**
 * After Buy now: wait for FBT to appear (it mounts late), then close it.
 */
async function waitAndDismissFbt(page, { timeoutMs = 16000, waitForAppearMs = 6000 } = {}) {
  const start = Date.now();

  let saw = false;
  while (Date.now() - start < waitForAppearMs) {
    if (await fbtSheetVisible(page)) {
      saw = true;
      break;
    }
    if (isCheckoutUrl(page.url())) break;
    await page.waitForTimeout(250);
  }

  if (!saw && !(await fbtSheetVisible(page))) return true;

  while (Date.now() - start < timeoutMs) {
    if (!(await fbtSheetVisible(page))) return true;
    await dismissFrequentlyBoughtTogether(page).catch(() => false);
    if (!(await fbtSheetVisible(page))) return true;
    await page.waitForTimeout(350);
  }
  return !(await fbtSheetVisible(page));
}

async function dismissCommonOverlays(page) {
  await dismissFrequentlyBoughtTogether(page).catch(() => {});

  const closers = [
    page.getByRole("button", { name: /^(✕|×|close)$/i }),
    page.locator("button._2KpZ6l._2doB4z"), // common Flipkart login dismiss
    page.locator("button:has-text('✕')"),
    page.locator("span:has-text('✕')"),
  ];
  for (const loc of closers) {
    try {
      const el = loc.first();
      if (await el.isVisible({ timeout: 800 })) await el.click({ timeout: 1000 });
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * Flipkart m-site sticky footer uses:
 * - icon-only Add to Cart (SVG clipPath id="AddToCart")
 * - text "Buy now" / "Buy with EMI" inside nested divs (not <button>)
 */
async function findProductCtas(page) {
  const found = {};

  // Prefer sticky purchase bar (where Buy now actually lives)
  const footer = page.locator('[data-id="sticky-footer-container"]');
  try {
    await footer.first().waitFor({ state: "visible", timeout: 8000 });
    found.sticky_footer = true;
  } catch (_) {
    found.sticky_footer = false;
  }

  const scopes = found.sticky_footer
    ? [footer.first(), page.locator("body")]
    : [page.locator("body")];

  const markText = async (scope, key, re) => {
    if (found[key]) return;
    const loc = scope.getByText(re).first();
    try {
      if (await loc.isVisible({ timeout: 1200 })) {
        found[key] = true;
        found[`${key}_text`] = ((await loc.innerText()) || "").trim().slice(0, 80);
      }
    } catch (_) {
      /* not visible in this scope */
    }
  };

  for (const scope of scopes) {
    await markText(scope, "buy_now", /^\s*Buy now\s*$/i);
    await markText(scope, "buy_with_emi", /Buy with EMI/i);
    await markText(scope, "add_to_cart", /add\s*to\s*cart/i);
    await markText(scope, "go_to_cart", /go\s*to\s*cart/i);
  }

  // Icon-only ATC in sticky footer (clipPath id AddToCart from your HTML dump)
  if (!found.add_to_cart) {
    const iconAtc = page.locator(
      '[data-id="sticky-footer-container"] clipPath#AddToCart, [data-id="sticky-footer-container"] [id="AddToCart"]'
    );
    try {
      if ((await iconAtc.count()) > 0) {
        found.add_to_cart = true;
        found.add_to_cart_text = "icon (AddToCart SVG)";
      }
    } catch (_) {
      /* ignore */
    }
  }

  const purchaseReady =
    !!(found.buy_now || found.buy_with_emi || found.add_to_cart || found.go_to_cart);

  // OOS / Notify Me: only trust sticky footer. Page body often has those strings
  // on ads/similar SKUs even when this product's Buy now is live.
  if (!purchaseReady) {
    const oosScope = found.sticky_footer ? footer.first() : page.locator("body");
    await markText(oosScope, "notify_me", /notify\s*me/i);
    await markText(oosScope, "out_of_stock", /out\s*of\s*stock|sold\s*out/i);
  }

  // COD is shown as a benefit chip on this page — inspection only
  try {
    const cod = page.getByText(/Cash on\s*Delivery/i).first();
    if (await cod.isVisible({ timeout: 1000 })) {
      found.cod_mentioned = true;
      found.cod_text = ((await cod.innerText()) || "").replace(/\s+/g, " ").trim();
    }
  } catch (_) {
    found.cod_mentioned = false;
  }

  found.purchase_ready = purchaseReady;
  return found;
}

function pidFromUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("pid") || "";
  } catch {
    const m = String(url || "").match(/[?&]pid=([^&]+)/i);
    return m ? decodeURIComponent(m[1]) : "";
  }
}

async function pageLooksLikeExpectedProduct(page, product) {
  const finalUrl = page.url();
  const title = (await page.title().catch(() => "")) || "";
  const bodySnippet = await page
    .locator("h1, [class*='product'], [data-id='title']")
    .first()
    .innerText({ timeout: 2000 })
    .catch(() => "");

  const hay = `${title}\n${bodySnippet}\n${finalUrl}`;
  const pidOk = !product.pid || pidFromUrl(finalUrl) === product.pid;
  const nameOk = (product.match || []).some((re) => re.test(hay));

  // Flipkart sometimes swaps in a suggested SKU (different pid / Edge / other model)
  if (!pidOk) {
    return {
      ok: false,
      reason: "suggested_or_wrong_pid",
      finalUrl,
      title,
      gotPid: pidFromUrl(finalUrl),
    };
  }
  if (!nameOk) {
    return {
      ok: false,
      reason: "suggested_or_wrong_title",
      finalUrl,
      title,
      gotPid: pidFromUrl(finalUrl),
    };
  }
  return { ok: true, finalUrl, title, gotPid: pidFromUrl(finalUrl) };
}

async function readQuantity(page) {
  const fromDom = await page.evaluate(() => {
    const inputs = Array.from(
      document.querySelectorAll(
        'select[name*="quantity" i], input[name*="quantity" i], [data-id="quantity"] input, select'
      )
    );
    for (const el of inputs) {
      const v = el.value || el.getAttribute("value");
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0 && n < 100) return n;
    }
    // Prefer the product-row Qty chip (leaf text node), ignore picker leftovers
    const chips = Array.from(document.querySelectorAll("div, span")).filter((el) => {
      if (el.childElementCount !== 0) return false;
      if (!/^\s*Qty\s*[:.]?\s*\d+\s*$/i.test((el.textContent || "").trim())) return false;
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 10 && r.top > 40;
    });
    if (chips.length) {
      const m = (chips[0].textContent || "").match(/(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }).catch(() => null);
  return fromDom;
}

/** Center of the Order Summary "Qty: N" chip (not the sticky footer). */
async function qtyChipPoint(page) {
  return page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("div, span")).filter((n) =>
      /^\s*Qty\s*[:.]?\s*\d+\s*$/i.test((n.textContent || "").trim()) && n.childElementCount === 0
    );
    for (const el of labels) {
      const hit =
        el.closest('[class*="r-61z16t"]') ||
        el.closest('[style*="height: 32px"]') ||
        el.parentElement ||
        el;
      const r = hit.getBoundingClientRect();
      if (r.width >= 40 && r.height >= 20 && r.top > 40 && r.bottom < window.innerHeight - 40) {
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  }).catch(() => null);
}

/**
 * Flipkart checkout shows a "Qty: 1" chip (not +/-). Tap it, then pick N
 * from the bottomsheet / list that opens.
 */
async function setQuantityViaQtyChip(page, wantQty) {
  const pt = await qtyChipPoint(page);
  if (!pt) {
    const chip = page.getByText(/^\s*Qty\s*[:.]?\s*\d+\s*$/i).first();
    try {
      if (!(await chip.isVisible({ timeout: 1500 }))) return false;
    } catch (_) {
      return false;
    }
  }

  console.log(`Opening quantity picker (want ${wantQty})…`);
  if (pt) {
    await leftTap(page, pt.x, pt.y);
  } else {
    await page
      .getByText(/^\s*Qty\s*[:.]?\s*\d+\s*$/i)
      .first()
      .click({ force: true, noWaitAfter: true })
      .catch(() => {});
  }
  await page.waitForTimeout(1000);

  // Pick N from the open sheet — prefer a fresh option row, not the chip itself
  const optionPt = await page.evaluate((n) => {
    const want = String(n);
    const nodes = Array.from(document.querySelectorAll("div, span, li, button, label, p"));
    // Exact digit option (picker rows), skip anything that still says "Qty:"
    const exact = nodes.find((el) => {
      const t = (el.textContent || "").trim();
      if (t !== want || el.childElementCount > 2) return false;
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 8 && r.top > 0 && r.bottom < window.innerHeight;
    });
    const target = exact;
    if (!target) return null;
    const hit =
      target.closest("li") ||
      target.closest('[role="button"]') ||
      target.closest("button") ||
      target.parentElement ||
      target;
    const r = hit.getBoundingClientRect();
    if (r.width < 1) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, wantQty);

  if (optionPt) {
    await leftTap(page, optionPt.x, optionPt.y);
  } else {
    const opt = page
      .locator("div, span, li, button")
      .filter({ hasText: new RegExp(`^\\s*${wantQty}\\s*$`) })
      .first();
    try {
      if (await opt.isVisible({ timeout: 2000 })) {
        await opt.click({ force: true, noWaitAfter: true });
      }
    } catch (_) {
      /* ignore */
    }
  }

  await page.waitForTimeout(1200);
  await page
    .getByText(new RegExp(`updated quantity.*to\\s*${wantQty}`, "i"))
    .first()
    .waitFor({ state: "visible", timeout: 4000 })
    .catch(() => {});

  // Confirm chip text actually changed
  const now = await readQuantity(page);
  if (now === wantQty) {
    console.log(`Qty chip now shows ${wantQty}.`);
    return true;
  }
  console.log(`Qty chip still ${now} after picker (want ${wantQty}).`);
  return false;
}

async function setQuantityIfPossible(page, wantQty) {
  if (!wantQty || wantQty < 1) return { ok: true, quantity: wantQty };

  let current = await readQuantity(page);
  if (current == null) {
    // Qty chip may still be loading
    const chipVisible = await page
      .getByText(/^\s*Qty\s*[:.]?\s*\d+\s*$/i)
      .first()
      .isVisible({ timeout: 800 })
      .catch(() => false);
    if (!chipVisible) return { ok: true, quantity: null, deferred: true };
    current = await readQuantity(page);
  }
  if (current === wantQty) return { ok: true, quantity: current };

  // Primary path on viewcheckout: "Qty: 1" chip → pick 2
  if (current != null && current !== wantQty) {
    await setQuantityViaQtyChip(page, wantQty);
    current = await readQuantity(page);
    if (current === wantQty) return { ok: true, quantity: current };
  }

  // Native <select>
  const select = page
    .locator('select[name*="quantity" i], select')
    .filter({ has: page.locator(`option[value="${wantQty}"]`) })
    .first();
  try {
    if (await select.isVisible({ timeout: 600 })) {
      await select.selectOption(String(wantQty));
      await page.waitForTimeout(500);
      current = await readQuantity(page);
      if (current === wantQty) return { ok: true, quantity: current };
    }
  } catch (_) {
    /* +/- path */
  }

  // Fallback +/- steppers
  for (let guard = 0; guard < 10 && current != null && current !== wantQty; guard++) {
    const clicked = await page.evaluate((dir) => {
      const candidates = Array.from(document.querySelectorAll("button, div, span, a")).filter(
        (el) => {
          const t = (el.textContent || "").trim();
          return t === "+" || t === "＋" || t === "−" || t === "-" || t === "–";
        }
      );
      const plus = candidates.find((el) => ["+", "＋"].includes((el.textContent || "").trim()));
      const minus = candidates.find((el) =>
        ["−", "-", "–"].includes((el.textContent || "").trim())
      );
      const target = dir === "up" ? plus : minus;
      if (!target) return false;
      const hit = target.closest("button") || target.closest('[role="button"]') || target;
      hit.click();
      return true;
    }, current < wantQty ? "up" : "down");
    if (!clicked) break;
    await page.waitForTimeout(500);
    current = await readQuantity(page);
  }

  return { ok: current === wantQty, quantity: current };
}

/** Retry until quantity matches (critical for tablet qty 2). */
async function ensureQuantity(page, wantQty, { rounds = 8 } = {}) {
  if (!wantQty || wantQty < 1) return { ok: true, quantity: wantQty };

  // Wait for checkout Qty chip to appear
  await page
    .getByText(/^\s*Qty\s*[:.]?\s*\d+\s*$/i)
    .first()
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(() => {});

  let last = { ok: false, quantity: null, deferred: true };
  for (let i = 0; i < rounds; i++) {
    await dismissFrequentlyBoughtTogether(page).catch(() => {});
    last = await setQuantityIfPossible(page, wantQty);
    if (last.ok && last.quantity === wantQty) {
      console.log(`Quantity confirmed: ${wantQty}`);
      return last;
    }
    if (last.quantity != null) {
      console.log(`Quantity attempt ${i + 1}: now ${last.quantity}, want ${wantQty}`);
    } else {
      console.log(`Quantity attempt ${i + 1}: Qty chip not ready yet`);
    }
    await page.waitForTimeout(800);
  }
  return last;
}

function isCheckoutUrl(url) {
  return /viewcheckout|\/checkout|checkoutInitiated|pay\.flipkart\.com|\/payments|order_summary|rv\/checkout/i.test(
    url || ""
  );
}

async function clickBuyNow(page) {
  const footer = page.locator('[data-id="sticky-footer-container"]');
  const label = footer.getByText(/^\s*Buy now\s*$/i).first();
  await label.waitFor({ state: "visible", timeout: 8000 });

  const before = page.url();

  // Nested div CTA: navigation detaches the node — noWaitAfter avoids false timeouts
  try {
    await label.click({ timeout: 4000, force: true, noWaitAfter: true });
  } catch (err) {
    if (isCheckoutUrl(page.url()) || page.url() !== before) return;
    try {
      await label.evaluate((el) => {
        let node = el;
        for (let i = 0; i < 8 && node; i++) {
          const bg = window.getComputedStyle(node).backgroundColor || "";
          if (/rgb\(\s*25[0-5]/.test(bg) || node.getAttribute("role") === "button") {
            node.click();
            return;
          }
          node = node.parentElement;
        }
        (el.parentElement || el).click();
      });
    } catch (err2) {
      if (isCheckoutUrl(page.url()) || page.url() !== before) return;
      throw err2.message ? err2 : err;
    }
  }

  // Buy now often opens FBT immediately — close it before / while waiting for checkout
  await page.waitForTimeout(800);
  const fbtGone = await waitAndDismissFbt(page, { timeoutMs: 18000 });
  if (!fbtGone) {
    throw new Error("Frequently Bought Together sheet could not be closed (X)");
  }

  await page
    .waitForURL((url) => url.toString() !== before || isCheckoutUrl(url.toString()), {
      timeout: 20000,
    })
    .catch(() => {});
  await page.waitForTimeout(1000);
  // Sheet can flash again after navigation
  await waitAndDismissFbt(page, { timeoutMs: 6000 }).catch(() => {});
  await dismissCommonOverlays(page).catch(() => {});

  if (page.url() === before && !isCheckoutUrl(page.url())) {
    // One more wait after close — SKIP may navigate
    await page.waitForTimeout(2500);
  }
  if (page.url() === before && !isCheckoutUrl(page.url())) {
    throw new Error("Buy now click did not navigate away from product page");
  }
}

async function clickFirstVisible(page, locators, { force = true, timeout = 2500 } = {}) {
  for (const loc of locators) {
    try {
      const el = loc.first();
      if (await el.isVisible({ timeout: 800 })) {
        await el.click({ timeout, force, noWaitAfter: true });
        return true;
      }
    } catch (_) {
      /* try next */
    }
  }
  return false;
}

/** Select Cash on Delivery, then click Place Order on Flipkart checkout / pay.flipkart.com. */
async function selectCodAndPlaceOrder(page, { wantQty } = {}) {
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await dismissFrequentlyBoughtTogether(page).catch(() => {});
  await dismissCommonOverlays(page).catch(() => {});

  // Wait for Order Summary (after FBT close / Buy now)
  await page
    .locator("h1.tf3rRV, h1")
    .filter({ hasText: /Order Summary/i })
    .first()
    .waitFor({ state: "visible", timeout: 12000 })
    .catch(() => {});

  // Set qty on Order Summary BEFORE Continue (tab must be 2)
  if (wantQty && wantQty >= 2) {
    const q = await ensureQuantity(page, wantQty, { rounds: 8 });
    if (!(q.ok && q.quantity === wantQty)) {
      return {
        ok: false,
        reason: "quantity_not_set",
        url: page.url(),
        quantity: q.quantity,
        wantedQuantity: wantQty,
      };
    }
  }

  // Order Summary → yellow Continue → Payments
  for (let step = 0; step < 4; step++) {
    await dismissFrequentlyBoughtTogether(page).catch(() => {});

    const onPay = /pay\.flipkart\.com|\/payments/i.test(page.url());
    const codVisible = await page
      .getByText(/Cash on\s*Delivery/i)
      .first()
      .isVisible({ timeout: 1200 })
      .catch(() => false);
    if (codVisible || onPay) break;

    const continued = await clickOrderSummaryContinue(page);
    if (!continued) {
      const alt = await clickFirstVisible(page, [
        page.getByRole("button", { name: /^\s*Continue\s*$/i }),
        page.getByText(/^\s*Continue\s*$/i),
        page.getByText(/deliver\s*here|use this address/i),
      ]);
      if (alt) console.log("Checkout: clicked Continue (fallback).");
      else break;
    }
    await page.waitForTimeout(2000);
    await dismissCommonOverlays(page).catch(() => {});
  }

  // Wait for payment page (token URL) to settle
  await page
    .waitForURL(/pay\.flipkart\.com|\/payments|viewcheckout/i, { timeout: 15000 })
    .catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // pay.flipkart.com: COD is a collapsed accordion; Place Order = #cod-place-order
  await page
    .locator('[data-testid="payment-options-list"]')
    .first()
    .waitFor({ state: "visible", timeout: 20000 })
    .catch(() => {});

  // Dump option labels for debugging when COD is missing
  const optionLabels = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("span.QbbOLN, [data-testid='payment-options-list'] .font-m-semibold"))
      .map((el) => (el.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 20);
  }).catch(() => []);
  if (optionLabels.length) console.log("Payment options seen:", optionLabels);

  // Scroll payment list (UPI panel is tall; COD sits under Net Banking)
  for (let y = 0; y <= 2400; y += 200) {
    await page.evaluate((top) => {
      window.scrollTo(0, top);
      const list = document.querySelector('[data-testid="payment-options-list"]');
      if (list) list.scrollTop = top;
    }, y).catch(() => {});
    await page.waitForTimeout(150);
  }

  const codOpen = await page.evaluate(() => {
    const exact = (el) => /^\s*Cash on Delivery\s*$/i.test((el.textContent || "").trim());
    const nodes = Array.from(document.querySelectorAll("span, div, p, h3, button"));
    let label = nodes.find((el) => exact(el) && el.childElementCount === 0);
    if (!label) label = nodes.find((el) => exact(el));
    if (!label) {
      const img = document.querySelector('img[src*="cash-icon"]');
      if (img) {
        const row =
          img.closest('[class*="nbl1sF"]') ||
          img.closest('[class*="AccordionItem"]') ||
          img.parentElement;
        row?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return { ok: !!row, how: "cash-icon" };
      }
      return { ok: false, how: "missing" };
    }
    const row =
      label.closest('[class*="nbl1sF"]') ||
      label.closest('[class*="AccordionItem"]') ||
      label.parentElement?.parentElement ||
      label;
    row.scrollIntoView({ block: "center" });
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    // also click label itself
    label.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return { ok: true, how: "label" };
  });

  const codInLabels = optionLabels.some((t) => /cash on\s*delivery/i.test(t));
  const codBlockedCopy = await page
    .getByText(/COD\s*(is\s*)?not available|not available for Cash on Delivery|Cash on Delivery.*(not available|unavailable)/i)
    .first()
    .isVisible({ timeout: 800 })
    .catch(() => false);

  const codClicked = !!(codOpen && codOpen.ok);
  if (codClicked) {
    console.log(`Opened Cash on Delivery (${codOpen.how}).`);
    await page.waitForTimeout(1500);
    // Ensure COD panel content (fee note + Place Order) is painted
    await page
      .locator("#cod-place-order")
      .waitFor({ state: "attached", timeout: 8000 })
      .catch(() => {});
  } else {
    console.log("COD not available on payments page — treating account as done (likely 3 COD orders already).");
    await page
      .screenshot({ path: "debug-checkout-no-cod.png", fullPage: true })
      .catch(() => {});
    return {
      ok: false,
      reason: "cod_unavailable",
      accountDone: true,
      url: page.url(),
      codClicked: false,
      optionLabels,
      codInLabels,
      codBlockedCopy,
    };
  }

  // After expand: <button id="cod-place-order" data-testid="payButton">Place Order</button>
  const beforePlace = page.url();
  let placed = false;
  try {
    const codPlaceBtn = page.locator("#cod-place-order");
    await codPlaceBtn.waitFor({ state: "visible", timeout: 10000 });
    await codPlaceBtn.click({ force: true, noWaitAfter: true, timeout: 5000 });
    placed = true;
  } catch (_) {
    placed = await page.evaluate(() => {
      const btn =
        document.querySelector("#cod-place-order") ||
        document.querySelector('button[data-testid="payButton"]');
      if (!btn) return false;
      btn.scrollIntoView({ block: "center" });
      btn.click();
      return true;
    });
  }

  if (!placed) {
    placed = await clickFirstVisible(
      page,
      [
        page.locator('button[data-testid="payButton"]').filter({ hasText: /Place\s*Order/i }),
        page.getByRole("button", { name: /place\s*order/i }),
      ],
      { force: true, timeout: 4000 }
    );
  }

  if (!placed) {
    await page
      .screenshot({ path: "debug-checkout-no-place-order.png", fullPage: true })
      .catch(() => {});
    // COD row opened but Place Order missing → still treat as COD dead-end for this account
    return {
      ok: false,
      reason: "cod_unavailable",
      accountDone: true,
      url: page.url(),
      codClicked,
      optionLabels,
    };
  }

  console.log("Clicked Place Order (#cod-place-order).");
  await page.waitForTimeout(2000);

  // Confirm Order bottomsheet / dialog (required after COD Place Order)
  let confirmed = false;
  for (let attempt = 0; attempt < 4 && !confirmed; attempt++) {
    confirmed = await clickFirstVisible(
      page,
      [
        page.getByRole("button", { name: /^\s*Confirm\s*Order\s*$/i }),
        page.getByRole("button", { name: /^\s*Confirm\s*$/i }),
        page.locator("button").filter({ hasText: /^\s*Confirm\s*Order\s*$/i }),
        page.locator("button").filter({ hasText: /^\s*Confirm\s*$/i }),
        page.getByText(/^\s*Confirm\s*Order\s*$/i),
        page
          .locator(
            '[class*="BottomSheet"], [class*="bottom-sheet"], [class*="bottomsheet"]'
          )
          .getByText(/^\s*Confirm(\s*Order)?\s*$/i),
        page.locator('button[data-testid*="confirm" i], button[id*="confirm" i]'),
      ],
      { force: true, timeout: 3500 }
    );

    if (!confirmed) {
      confirmed = await page.evaluate(() => {
        const match = (t) => /^\s*Confirm(\s*Order)?\s*$/i.test((t || "").trim());
        const btns = Array.from(document.querySelectorAll("button, [role='button'], div"));
        const btn = btns.find((el) => match(el.textContent) && el.childElementCount <= 2);
        if (!btn) return false;
        btn.scrollIntoView({ block: "center" });
        btn.click();
        return true;
      });
    }

    if (confirmed) {
      console.log("Clicked Confirm Order.");
      break;
    }
    await page.waitForTimeout(1000);
  }

  if (!confirmed) {
    console.log("Confirm Order not found after Place Order — may already have submitted.");
    await page
      .screenshot({ path: "debug-checkout-no-confirm.png", fullPage: true })
      .catch(() => {});
  }

  await page
    .waitForURL(
      (url) => {
        const s = url.toString();
        return s !== beforePlace || looksLikeOrderSuccess(s);
      },
      { timeout: 30000 }
    )
    .catch(() => {});
  await page.waitForTimeout(2500);

  const url = page.url();
  const success =
    looksLikeOrderSuccess(url) ||
    (await page
      .getByText(/order\s+placed|ordered\s+successfully|thank you for your order/i)
      .first()
      .isVisible({ timeout: 4000 })
      .catch(() => false));

  return {
    ok: true,
    reason: success
      ? "order_success_signal"
      : confirmed
        ? "confirm_order_clicked"
        : "place_order_clicked",
    url,
    codClicked,
    confirmed,
    success,
  };
}

async function inspectAndAddProduct(page, product) {
  await page.goto(product.url, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await dismissCommonOverlays(page);

  // Sticky bar often mounts after offers accordion; nudge scroll so it paints
  await page.evaluate(() => window.scrollTo(0, 400)).catch(() => {});
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

  const identity = await pageLooksLikeExpectedProduct(page, product);
  console.log(`Product: ${product.name}`);
  console.log(`Page title: ${identity.title}`);
  console.log(`Final URL: ${identity.finalUrl}`);
  console.log(`Expected quantity: ${product.quantity}`);

  const onProductPage =
    /\/p\/itm/i.test(identity.finalUrl) || /[?&]pid=/i.test(identity.finalUrl);
  if (!onProductPage) {
    console.log("Skip: not on a product detail page (campaign / suggest redirect).");
    return {
      status: "skipped",
      reason: "not_product_page",
      finalUrl: identity.finalUrl,
      title: identity.title,
    };
  }

  if (!identity.ok) {
    console.log(
      `Skip: page looks like a suggested/different item (want pid=${product.pid}, got=${identity.gotPid}).`
    );
    await page
      .screenshot({ path: `debug-${product.key}-skip.png`, fullPage: false })
      .catch(() => {});
    return {
      status: "skipped",
      reason: identity.reason,
      finalUrl: identity.finalUrl,
      title: identity.title,
      gotPid: identity.gotPid,
    };
  }

  const ctas = await findProductCtas(page);
  console.log("CTAs found:", ctas);

  if (!ctas.purchase_ready && (ctas.out_of_stock || ctas.notify_me)) {
    console.log("Skip: unavailable (Notify Me / Out of Stock).");
    return {
      status: "skipped",
      reason: "unavailable",
      ctas,
      finalUrl: identity.finalUrl,
    };
  }

  if (!ctas.purchase_ready || !ctas.buy_now) {
    console.log("Skip: Buy now not available in sticky footer.");
    await page
      .screenshot({ path: `debug-${product.key}.png`, fullPage: false })
      .catch(() => {});
    return {
      status: "skipped",
      reason: "button_not_found",
      ctas,
      finalUrl: identity.finalUrl,
      title: identity.title,
    };
  }

  // Try qty on PDP (often absent); Buy now anyway, force on checkout
  let qtyResult = await setQuantityIfPossible(page, product.quantity);
  if (qtyResult.deferred) {
    console.log(`Quantity control not on PDP; will set ${product.quantity} after Buy now.`);
  }

  console.log("Buy now available — will select COD and Place Order.");
  if (ctas.cod_mentioned) {
    console.log("Page mentions Cash on Delivery on PDP.");
  }

  try {
    await clickBuyNow(page);
  } catch (err) {
    const maybeUrl = page.url();
    if (isCheckoutUrl(maybeUrl)) {
      console.log("Buy now reached checkout despite click warning — continuing.");
    } else {
      console.log(`Skip: Buy now click failed (${err.message || err}).`);
      return {
        status: "skipped",
        reason: "buy_now_click_failed",
        ctas,
        finalUrl: maybeUrl,
      };
    }
  }

  // After Buy now: ensure FBT is fully gone, then force quantity (tab must be 2)
  await waitAndDismissFbt(page, { timeoutMs: 10000, waitForAppearMs: 2000 }).catch(() => {});

  qtyResult = await ensureQuantity(page, product.quantity, { rounds: 8 });
  if (product.quantity >= 2 && !(qtyResult.ok && qtyResult.quantity === product.quantity)) {
    console.log(
      `Skip: could not set quantity to ${product.quantity} (got ${qtyResult.quantity}). Not placing order.`
    );
    await page
      .screenshot({ path: `debug-${product.key}-qty.png`, fullPage: false })
      .catch(() => {});
    return {
      status: "skipped",
      reason: "quantity_not_set",
      quantity: qtyResult.quantity,
      wantedQuantity: product.quantity,
      finalUrl: page.url(),
    };
  }

  const afterUrl = page.url();
  console.log(`After Buy now URL: ${afterUrl}`);

  const order = await selectCodAndPlaceOrder(page, { wantQty: product.quantity });
  console.log("COD / Place Order:", order);

  if (!order.ok) {
    if (order.reason === "cod_unavailable" || order.accountDone) {
      return {
        status: "account_done",
        reason: "cod_unavailable",
        ctas,
        quantity: qtyResult.quantity,
        wantedQuantity: product.quantity,
        finalUrl: order.url || afterUrl,
        order,
      };
    }
    return {
      status: "skipped",
      reason: order.reason || "place_order_failed",
      ctas,
      quantity: qtyResult.quantity,
      wantedQuantity: product.quantity,
      finalUrl: order.url || afterUrl,
      order,
    };
  }

  return {
    status: "continued",
    reason: order.reason,
    ctas,
    quantity: qtyResult.quantity,
    wantedQuantity: product.quantity,
    finalUrl: order.url || afterUrl,
    order,
  };
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

async function processAccount(id, { index, total, slotIndex, results, rl }) {
  logFor(id, `=== [${index + 1}/${total}] start (slot ${slotIndex}) ===`);
  let browser;
  let cleanup = () => {};
  const detected = {
    order_placed: false,
    evidence: null,
    evidence_url: null,
    cod_unavailable: false,
  };
  let stopWatcher = () => {};

  try {
    const session = await openFlipkartMobileSession(id, { slotIndex });
    browser = session.browser;
    cleanup = session.cleanup || cleanup;
    logFor(id, `Loaded ${session.cookieCount} cookies`);

    stopWatcher = attachOrderWatcher(browser, detected);

    const context = browser.contexts()[0];
    const page = context.pages()[0];

    for (const product of PRODUCTS) {
      logFor(id, `--- ${product.key} ---`);

      if (page.isClosed()) {
        logFor(id, "Page closed — stopping products for this account.");
        break;
      }

      let result;
      try {
        result = await inspectAndAddProduct(page, product);
      } catch (err) {
        if (/has been closed/i.test(String(err.message || err))) {
          logFor(id, "Browser/page closed during product — stopping this account.");
          break;
        }
        result = {
          status: "skipped",
          reason: "error",
          error: String(err.message || err),
        };
      }

      logFor(id, "Result:", result);

      if (result.status === "account_done" || result.reason === "cod_unavailable") {
        logFor(id, "COD unavailable — closing this account.");
        detected.cod_unavailable = true;
        break;
      }

      if (result.status === "skipped") {
        logFor(id, "Continuing to next product…");
        continue;
      }

      if (result.status === "continued" && !page.isClosed()) {
        logFor(
          id,
          result.order?.success
            ? `Order signal for ${product.name}. Next SKU shortly…`
            : `Place Order attempted for ${product.name}. Next SKU shortly…`
        );
        // Shorter pause when running parallel (less idle wall-clock time)
        const pauseMs = CONCURRENCY > 1 ? 1500 : 3000;
        await page.waitForTimeout(pauseMs).catch(() => {});
      }
    }

    logFor(id, "All products done — closing session…");
  } catch (err) {
    logFor(id, `Account error: ${err.message || err}`);
    detected.error = String(err.message || err);
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
    const status = detected.error
      ? "error"
      : detected.cod_unavailable
        ? detected.order_placed
          ? "complete"
          : "cod_unavailable"
        : detected.order_placed
          ? "complete"
          : "pending";
    results[id] = {
      status,
      order_placed: detected.order_placed,
      cod_unavailable: !!detected.cod_unavailable,
      evidence: detected.evidence || (detected.cod_unavailable ? "cod_unavailable" : null),
      evidence_url: detected.evidence_url || null,
      error: detected.error || null,
      checked_at: new Date().toISOString(),
      window_closed: true,
    };
    await saveResults(results);
    logFor(
      id,
      `Saved: status=${results[id].status}, order_placed=${results[id].order_placed}`
    );
  }

  return detected;
}

async function main() {
  const ids = readAccountIds();
  const results = readResults();
  const rl = ASK
    ? readline.createInterface({ input: stdin, output: stdout })
    : null;

  const cpuHint = Math.max(1, Math.min(4, (os.cpus() || []).length || 2));
  console.log(`Accounts to process: ${ids.length}`);
  console.log(
    `Concurrency: ${CONCURRENCY} parallel Chrome session(s)` +
      (ASK ? " (--ask forces 1)" : ` (default 2; try --concurrency=${cpuHint} or 3)`)
  );
  console.log(`Start stagger: ${START_STAGGER_MS}ms between new sessions`);
  console.log("Each account closes its own Chrome when done; pool picks up the next id.");
  console.log("If you reach an order-success screen, results will mark order_placed=true.");
  if (ASK) console.log("Checklist prompts enabled (--ask).\n");
  else console.log("Tip: use --ask for manual yes/no checklist between accounts.\n");

  // Slot counter so tiled window positions stay unique across the pool
  let slotSeq = 0;

  try {
    await mapPool(ids, CONCURRENCY, async (id, index) => {
      const slotIndex = slotSeq++;
      // Stagger only the first wave of Chromes (pool refills start immediately)
      if (START_STAGGER_MS > 0 && slotIndex < CONCURRENCY) {
        await new Promise((r) => setTimeout(r, START_STAGGER_MS * slotIndex));
      }
      return processAccount(id, {
        index,
        total: ids.length,
        slotIndex,
        results,
        rl,
      });
    });
  } finally {
    if (rl) rl.close();
    await resultsWriteChain;
  }

  console.log(`\nAll accounts processed. Results: ${RESULTS_FILE}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
