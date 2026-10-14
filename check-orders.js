/**
 * Per-account Flipkart order report from My Orders (Rome page/fetch API):
 * count, product, order id, qty, status, arriving date, tracking id (when shipped).
 * Also writes order-report.xlsx (Summary + Orders + By Account sheets).
 *
 * Usage:
 *   node check-orders.js
 *   node check-orders.js --concurrency=4   # fetch N accounts in parallel (default 4)
 *   node check-orders.js ananki148
 *   node check-orders.js --no-details      # skip order detail pages (no tracking IDs)
 *   node check-orders.js --max=50          # cap detail pages per account (default: all open)
 *   node check-orders.js --from-json        # rebuild Excel from existing order-report.json
 *   node check-orders.js --enrich          # only re-check accounts that already have orders
 *   node check-orders.js --enrich --concurrency=8
 *   node check-orders.js --browse           # open 3 phone Chromes → Orders; next batch when all closed
 *   node check-orders.js --browse --batch=3 --cookie-file=cookie-pending.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const XLSX = require("xlsx");
const { openFlipkartMobileSession } = require("./lib/session");

const COOKIE_FILE_ARG = (
  process.argv.find((a) => a.startsWith("--cookie-file=")) || ""
).split("=")[1];
const COOKIE_FILE = COOKIE_FILE_ARG
  ? path.isAbsolute(COOKIE_FILE_ARG)
    ? COOKIE_FILE_ARG
    : path.join(__dirname, COOKIE_FILE_ARG)
  : path.join(__dirname, "cookie.json");
const OUT_FILE = path.join(__dirname, "order-report.json");
const EXCEL_FILE = path.join(__dirname, "order-report.xlsx");
const ORDERS_URL = "https://www.flipkart.com/rv/orders?link=home_orders";

// Detail pages required for tracking IDs — on by default; use --no-details to skip.
const WANT_DETAILS = !process.argv.includes("--no-details");
const FROM_JSON = process.argv.includes("--from-json");
const BROWSE = process.argv.includes("--browse");
const ENRICH = process.argv.includes("--enrich");
const BATCH =
  parseInt(
    (process.argv.find((a) => a.startsWith("--batch=")) || "").split("=")[1] ||
      "3",
    10
  ) || 3;

function parseFetchConcurrency() {
  const arg = process.argv.find((a) => a.startsWith("--concurrency="));
  const raw = arg ? arg.split("=")[1] : process.env.CONCURRENCY;
  // Enrich defaults higher — only accounts with orders
  let n = parseInt(raw || (ENRICH ? "8" : "4"), 10);
  if (!Number.isFinite(n) || n < 1) n = ENRICH ? 8 : 4;
  const max =
    Math.max(1, Math.min(10, parseInt(process.env.CONCURRENCY_MAX || "10", 10) || 10));
  return Math.min(n, max);
}

const FETCH_CONCURRENCY = parseFetchConcurrency();
const START_STAGGER_MS = Math.max(
  0,
  parseInt(
    process.env.START_STAGGER_MS || (ENRICH ? "300" : "800"),
    10
  ) || (ENRICH ? 300 : 800)
);
const MAX_DETAIL_ARG = (
  process.argv.find((a) => a.startsWith("--max=")) || ""
).split("=")[1];
/** Cap detail fetches per account; default = all open (non-cancelled) orders. */
const MAX_DETAIL = MAX_DETAIL_ARG
  ? Math.max(1, parseInt(MAX_DETAIL_ARG, 10) || 1)
  : Number.POSITIVE_INFINITY;
const FILTER = process.argv
  .slice(2)
  .find((a) => a && !a.startsWith("--"));

function readAccountIds() {
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

/**
 * Closing an Incognito window often leaves CDP connected briefly.
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

async function openOrdersBrowseSession(accountId, slotIndex) {
  const session = await openFlipkartMobileSession(accountId, {
    slotIndex,
    cookieFile: COOKIE_FILE,
  });
  const page = session.browser.contexts()[0].pages()[0];
  await page.goto(ORDERS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  console.log(`  → Orders open: ${accountId}`);
  return session;
}

async function runBrowseBatches(ids) {
  const batchSize = Math.max(1, BATCH);
  const totalBatches = Math.ceil(ids.length / batchSize);
  console.log(
    `Browse mode: ${ids.length} account(s), ${batchSize} at a time → My Orders`
  );
  console.log(`Cookies: ${path.basename(COOKIE_FILE)}`);
  console.log(
    "Do your work, then close each Chrome window. Next batch starts when all are closed.\n"
  );

  for (let b = 0; b < totalBatches; b++) {
    const batch = ids.slice(b * batchSize, (b + 1) * batchSize);
    console.log(
      `=== Batch ${b + 1}/${totalBatches} (${batch.length}) ===\n` +
        batch.map((id, i) => `  ${i + 1}. ${id}`).join("\n")
    );

    const sessions = [];
    for (let i = 0; i < batch.length; i++) {
      try {
        sessions.push(await openOrdersBrowseSession(batch[i], i));
      } catch (err) {
        console.error(`  Failed ${batch[i]}: ${err.message || err}`);
      }
      // Small stagger so windows tile cleanly
      if (i < batch.length - 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    if (!sessions.length) {
      console.log("  No sessions opened in this batch — skipping.\n");
      continue;
    }

    console.log(
      `\nWaiting until you close all ${sessions.length} Chrome window(s)…\n`
    );

    await Promise.all(
      sessions.map(async (session) => {
        await waitUntilSessionDone(session.browser);
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
        console.log(`  Cleared session: ${session.accountId}`);
      })
    );

    console.log(`Batch ${b + 1}/${totalBatches} done.\n`);
  }

  console.log("All batches finished.");
}

function productFromIcon(iconUrl = "", blob = "") {
  const hay = `${iconUrl} ${blob}`;
  if (/TABHHQEY|tab-a11|galaxy-tab-a11/i.test(hay)) return "Samsung Galaxy Tab A11";
  if (/MOBHQCH6|imahrju566uwzv7g|galaxy-s25-fe|\/mobile\//i.test(hay))
    return "Samsung Galaxy S25 FE 5G";
  return null;
}

function cleanProduct(p) {
  if (!p) return null;
  const s = String(p).replace(/\s+/g, " ").trim();
  if (/^https?:\/\//i.test(s) || s.startsWith("/")) {
    if (/s25\s*fe|galaxy-s25-fe/i.test(s)) return "Samsung Galaxy S25 FE 5G";
    if (/tab-a11|tab_a11|TABHHQEY/i.test(s)) return "Samsung Galaxy Tab A11";
    return null;
  }
  if (/^Pay\b/i.test(s)) return null;
  return s;
}

/** Parse ORDER_CARD_SUPER_WIDGET slots from Rome my-orders page/fetch. */
function extractListOrders(json) {
  const orders = [];
  const slots = json?.RESPONSE?.slots || [];

  for (const slot of slots) {
    const blob = JSON.stringify(slot);
    if (!/ORDER_CARD_SUPER_WIDGET/i.test(blob)) continue;

    const orderId =
      slot?.widget?.params?.trackingParams?.orderId ||
      (blob.match(/OD\d{10,}/) || [])[0];
    if (!orderId) continue;

    const rc =
      slot?.widget?.data?.subWidgets?.[0]?.data?.buttons?.renderableComponents?.[0];

    let arriving = null;
    let status = rc?.value?.subText || null;
    const iconUrl = rc?.value?.iconUrl || null;

    for (const c of rc?.value?.heading?.contents || []) {
      if (c?.text && /Delivery expected|Delivered|Cancelled|Arriving/i.test(c.text)) {
        arriving = c.text;
      }
    }
    arriving = pickBestArriving(arriving, extractArrivingFromText(blob));
    if (!arriving) {
      const m = blob.match(/Cancelled[^"\\]{0,48}/i);
      if (m) arriving = m[0];
    }

    // Cancelled cards often put explanation in a later subwidget text
    if (/cancel/i.test(arriving || "") || /cancel/i.test(status || "")) {
      const cancelMsg = blob.match(
        /Your order has been canceled[^"\\]{0,120}/i
      );
      if (cancelMsg) status = cancelMsg[0];
    }

    const unitId =
      rc?.action?.nonWidgetizeRedirection?.queryParam?.unit_id ||
      slot?.widget?.params?.trackingParams?.unitId ||
      null;
    const itemId = rc?.action?.nonWidgetizeRedirection?.queryParam?.item_id || null;

    const qtyMatch = blob.match(/"text"\s*:\s*"x(\d+)"/i);
    const quantity = qtyMatch ? Number(qtyMatch[1]) : 1;

    const product = productFromIcon(iconUrl, blob);

    // List cards rarely include tracking; grab it when present.
    const trackingFromList =
      (blob.match(/"trackingId"\s*:\s*"([^"]+)"/i) || [])[1] ||
      (blob.match(/\bFMP[A-Z0-9]{8,}\b/i) || [])[0] ||
      null;

    orders.push({
      orderId,
      product,
      quantity,
      status: status ? String(status).replace(/\s+/g, " ").trim() : null,
      arriving: arriving ? String(arriving).replace(/\s+/g, " ").trim() : null,
      trackingId: trackingFromList
        ? String(trackingFromList).toUpperCase()
        : null,
      unitId,
      itemId,
      detailPath: `/rv/orderDetails?order_id=${encodeURIComponent(orderId)}${
        unitId ? `&unit_id=${encodeURIComponent(unitId)}` : ""
      }&link=MyOrders`,
      source: "rome_list",
    });
  }

  // Dedupe by orderId (keep first)
  const map = new Map();
  for (const o of orders) {
    if (!map.has(o.orderId)) map.set(o.orderId, o);
  }
  return [...map.values()];
}

function extractTrackingId(text) {
  if (!text) return null;
  const key = text.match(/"trackingId"\s*:\s*"([^"]+)"/i);
  if (key?.[1] && !/^OD\d/i.test(key[1]) && key[1].length >= 8) {
    return String(key[1]).toUpperCase();
  }
  const fmp = text.match(/\bFMP[A-Z0-9]{8,}\b/i);
  if (fmp) return String(fmp[0]).toUpperCase();
  const labeled = text.match(
    /tracking(?:\s*id)?["\s:=\-]+["']?([A-Z0-9]{8,})/i
  );
  if (labeled?.[1] && !/^OD\d/i.test(labeled[1])) {
    return String(labeled[1]).toUpperCase();
  }
  return null;
}

/** Pull delivery / arriving line from free text (API or DOM). */
function extractArrivingFromText(text) {
  if (!text) return null;
  const patterns = [
    /Delivery expected by[^"\\.]{0,60}/i,
    /Arriving tomorrow(?:\s+by\s+[^"\\.]{0,40})?/i,
    /Arriving today(?:\s+by\s+[^"\\.]{0,40})?/i,
    /Arriving(?:\s+by)?\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}[^"\\.]{0,40}/i,
    /Delivered on[^"\\.]{0,60}/i,
    /Cancelled(?:\s+Today)?(?:,?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2})?[^"\\.]{0,40}/i,
  ];
  for (const re of patterns) {
    const m = String(text).match(re);
    if (m) return m[0].replace(/\s+/g, " ").trim();
  }
  return null;
}

/** Prefer the more specific / fresher arriving string. */
function pickBestArriving(...candidates) {
  const scored = candidates
    .filter(Boolean)
    .map((raw) => {
      const s = String(raw).replace(/\s+/g, " ").trim();
      let score = 0;
      if (/Delivery expected by/i.test(s)) score += 5;
      if (/Arriving tomorrow|Arriving today/i.test(s)) score += 4;
      if (/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/i.test(s))
        score += 3;
      if (/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i.test(s)) score += 1;
      if (/by\s+\d/i.test(s)) score += 1;
      if (/Delivered on/i.test(s)) score += 2;
      if (/cancel/i.test(s)) score += 2;
      score += Math.min(s.length, 40) / 100;
      return { s, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.s || null;
}

function extractDetailFields(json) {
  const text = JSON.stringify(json);
  const orderId = (text.match(/OD\d{10,}/) || [])[0] || null;
  const trackingId = extractTrackingId(text);

  let product = null;
  let arriving = extractArrivingFromText(text);
  let status = null;
  const arrivingCandidates = arriving ? [arriving] : [];

  function walk(n, d = 0) {
    if (!n || d > 22) return;
    if (typeof n === "string") {
      const s = n.replace(/\s+/g, " ").trim();
      if (
        !product &&
        /Samsung|Galaxy|Tab A/i.test(s) &&
        s.length > 10 &&
        s.length < 180 &&
        !/^https?:/i.test(s) &&
        !s.startsWith("/")
      ) {
        product = s;
      }
      if (/Delivery expected by|Delivered on|Arriving|Cancelled/i.test(s) && s.length < 120) {
        arrivingCandidates.push(s);
      }
      if (
        !status &&
        /Order has been placed|Shipped|Out for delivery|Delivered|Cancelled|canceled|packed|dispatched/i.test(
          s
        )
      ) {
        status = s;
      }
      return;
    }
    if (Array.isArray(n)) return n.forEach((x) => walk(x, d + 1));
    if (typeof n === "object") {
      for (const [k, v] of Object.entries(n)) {
        if (typeof v === "string" && /productTitle|itemTitle/i.test(k) && v.length < 180) {
          product = product || cleanProduct(v);
        }
        walk(v, d + 1);
      }
    }
  }
  walk(json);

  return {
    orderId,
    trackingId: trackingId ? String(trackingId).toUpperCase() : null,
    product: cleanProduct(product),
    arriving: pickBestArriving(...arrivingCandidates),
    status,
  };
}

function waitForRomeFetch(
  page,
  {
    timeoutMs = 15000,
    preferOds = true,
    preferTracking = false,
    preferDetail = false,
  } = {}
) {
  const hits = [];
  const onResponse = async (res) => {
    try {
      if (res.status() !== 200) return;
      if (!/rome\.api\.flipkart\.com\/api\/4\/page\/fetch/i.test(res.url())) return;
      const json = await res.json();
      const text = JSON.stringify(json);
      const ods = [...new Set(text.match(/OD\d{10,}/g) || [])];
      const trackingId = extractTrackingId(text);
      const arriving = extractArrivingFromText(text);
      hits.push({ json, len: text.length, ods, trackingId, arriving, text });
    } catch (_) {
      /* ignore */
    }
  };
  page.on("response", onResponse);

  const pickBest = () => {
    if (!hits.length) return null;
    if (preferDetail || preferTracking) {
      // Prefer payload that has tracking and/or a delivery line; then largest.
      return [...hits].sort((a, b) => {
        const sa =
          (a.trackingId ? 10 : 0) + (a.arriving ? 6 : 0) + Math.min(a.len, 50000) / 100000;
        const sb =
          (b.trackingId ? 10 : 0) + (b.arriving ? 6 : 0) + Math.min(b.len, 50000) / 100000;
        return sb - sa;
      })[0];
    }
    if (preferOds) {
      return [...hits]
        .filter((h) => h.ods.length)
        .sort((a, b) => b.ods.length - a.ods.length || b.len - a.len)[0] ||
        [...hits].sort((a, b) => b.len - a.len)[0];
    }
    return [...hits].sort((a, b) => b.len - a.len)[0];
  };

  const done = (async () => {
    const start = Date.now();
    let readyAt = 0;
    while (Date.now() - start < timeoutMs) {
      if (preferDetail || preferTracking) {
        const good = hits.find((h) => h.trackingId && h.arriving);
        if (good) {
          // Brief settle so late fields can still arrive
          if (!readyAt) readyAt = Date.now();
          if (Date.now() - readyAt >= 400) return pickBest();
        } else if (hits.some((h) => h.trackingId || h.arriving)) {
          if (!readyAt) readyAt = Date.now();
          // Wait a bit longer for the other field
          if (Date.now() - readyAt >= 1200) return pickBest();
        }
      } else if (preferOds) {
        const withOd = hits.filter((h) => h.ods.length);
        if (withOd[0]) return pickBest();
      } else if (hits.length) {
        return pickBest();
      }
      await page.waitForTimeout(150);
    }
    return pickBest();
  })();

  return {
    promise: done.finally(() => page.off("response", onResponse)),
  };
}

/** DOM scrape for tracking + delivery line on order detail page. */
async function scrapeDetailDom(page) {
  return page.evaluate(() => {
    const t = (document.body?.innerText || "").replace(/\s+/g, " ");
    let trackingId = null;
    const fmp = t.match(/\bFMP[A-Z0-9]{8,}\b/i);
    if (fmp) trackingId = fmp[0];
    if (!trackingId) {
      const labeled = t.match(/Tracking\s*ID\s*[:\-]?\s*([A-Z0-9]{8,})/i);
      if (labeled) trackingId = labeled[1];
    }
    let arriving = null;
    const a =
      t.match(/Delivery expected by[^.]{0,60}/i) ||
      t.match(/Arriving tomorrow(?:\s+by\s+[^.]{0,40})?/i) ||
      t.match(/Arriving today(?:\s+by\s+[^.]{0,40})?/i) ||
      t.match(/Arriving(?:\s+by)?\s+[A-Za-z]{0,9}\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}[^.]{0,40}/i) ||
      t.match(/Delivered on[^.]{0,60}/i);
    if (a) arriving = a[0].trim();
    let status = null;
    const st = t.match(
      /(?:Order has been placed|Shipped|Out for delivery|Delivered|Cancelled|Packed|Dispatched)[^.!]{0,80}/i
    );
    if (st) status = st[0].trim();
    return { trackingId, arriving, status };
  });
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

async function fetchOrdersForAccount(accountId, { slotIndex = 0 } = {}) {
  let browser;
  let cleanup = () => {};

  try {
    const session = await openFlipkartMobileSession(accountId, {
      cookieFile: COOKIE_FILE,
      slotIndex,
    });
    browser = session.browser;
    cleanup = session.cleanup || cleanup;
    const page = browser.contexts()[0].pages()[0];

    const listWait = waitForRomeFetch(page, { timeoutMs: 18000, preferOds: true });
    await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    const listHit = await listWait.promise;

    if (!listHit || !listHit.ods.length) {
      // DOM fallback summary
      const body = await page.evaluate(() =>
        (document.body?.innerText || "").replace(/\s+/g, " ").trim()
      );
      const expected = (body.match(/Delivery expected by/gi) || []).length;
      const cancelled = (body.match(/\bCancelled\b/gi) || []).length;
      logFor(
        accountId,
        `Rome list payload missing ODs (dom hints: expected=${expected}, cancelled=${cancelled}).`
      );
      return {
        accountId,
        ok: true,
        count: 0,
        orders: [],
        checked_at: new Date().toISOString(),
        note: "Could not parse orders API; cookie may be stale.",
      };
    }

    let orders = extractListOrders(listHit.json);
    logFor(accountId, `List API: ${orders.length} order card(s).`);

    // Always open every open order detail — refresh delivery date + tracking.
    if (WANT_DETAILS && orders.length) {
      const needDetail = orders.filter((o) => !isCancelled(o) && !isDelivered(o));
      const toFetch = needDetail.slice(
        0,
        Number.isFinite(MAX_DETAIL) ? MAX_DETAIL : needDetail.length
      );
      logFor(
        accountId,
        `Detail verify (delivery + tracking): ${toFetch.length} open order(s)`
      );

      for (const o of toFetch) {
        const listArriving = o.arriving;
        const detailWait = waitForRomeFetch(page, {
          timeoutMs: 16000,
          preferOds: false,
          preferDetail: true,
        });
        const url = "https://www.flipkart.com" + o.detailPath;
        try {
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 45000,
          });
          await page.waitForTimeout(900);
          const detailHit = await detailWait.promise;
          if (detailHit) {
            const d = extractDetailFields(detailHit.json);
            o.product = cleanProduct(d.product) || o.product;
            o.arriving = pickBestArriving(
              d.arriving,
              detailHit.arriving,
              listArriving,
              o.arriving
            );
            o.status = d.status || o.status;
            o.trackingId =
              d.trackingId || detailHit.trackingId || o.trackingId || null;
            o.source = "rome_list+detail";
          }

          // Always DOM-scrape as second source (catches UI-only updates)
          const dom = await scrapeDetailDom(page).catch(() => null);
          if (dom) {
            o.arriving = pickBestArriving(dom.arriving, o.arriving, listArriving);
            if (dom.status) o.status = dom.status || o.status;
            if (dom.trackingId) {
              o.trackingId = String(dom.trackingId).toUpperCase();
              if (!o.source || o.source === "rome_list") {
                o.source = "rome_list+detail_dom";
              }
            }
          }

          // One retry if still missing tracking on a likely-shipped order
          const likelyShipped =
            /arriv|expected|ship|out for|dispatch|pack/i.test(
              `${o.arriving || ""} ${o.status || ""}`
            );
          if (!o.trackingId && likelyShipped) {
            await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(
              () => {}
            );
            await page.waitForTimeout(1200);
            const retryWait = waitForRomeFetch(page, {
              timeoutMs: 10000,
              preferDetail: true,
            });
            const retryHit = await retryWait.promise;
            if (retryHit) {
              const d = extractDetailFields(retryHit.json);
              o.arriving = pickBestArriving(
                d.arriving,
                retryHit.arriving,
                o.arriving
              );
              o.trackingId =
                d.trackingId || retryHit.trackingId || o.trackingId || null;
              o.status = d.status || o.status;
            }
            const dom2 = await scrapeDetailDom(page).catch(() => null);
            if (dom2) {
              o.arriving = pickBestArriving(dom2.arriving, o.arriving);
              if (dom2.trackingId) {
                o.trackingId = String(dom2.trackingId).toUpperCase();
              }
            }
          }
        } catch (err) {
          logFor(accountId, `Detail failed ${o.orderId}: ${err.message || err}`);
        }
      }
      const open = orders.filter((o) => !isCancelled(o) && !isDelivered(o));
      const withTrack = open.filter((o) => o.trackingId).length;
      const withDate = open.filter((o) => o.arriving).length;
      logFor(
        accountId,
        `Open orders: ${open.length} | delivery dates ${withDate} | tracking ${withTrack}`
      );
    }

    orders = orders.map((o) => ({
      orderId: o.orderId,
      product: o.product,
      quantity: o.quantity,
      status: o.status,
      arriving: o.arriving,
      trackingId: o.trackingId,
      source: o.source,
    }));

    return {
      accountId,
      ok: true,
      count: orders.length,
      orders,
      checked_at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      accountId,
      ok: false,
      error: String(err.message || err),
      count: 0,
      orders: [],
      checked_at: new Date().toISOString(),
    };
  } finally {
    try {
      if (browser?.isConnected()) await browser.close();
    } catch (_) {
      /* ignore */
    }
    cleanup();
  }
}

function isCancelled(order) {
  const hay = `${order.status || ""} ${order.arriving || ""}`;
  return /cancel/i.test(hay);
}

function isDelivered(order) {
  const status = String(order.status || "").trim();
  const arriving = String(order.arriving || "");
  // Already delivered — exclude from Excel. Skip "not … delivered" / "Out for delivery".
  if (/not\s+(?:been\s+)?(?:dispatched or )?delivered/i.test(`${status} ${arriving}`)) {
    return false;
  }
  if (/out for delivery/i.test(`${status} ${arriving}`)) return false;
  return /^delivered\b/i.test(status) || /\bDelivered on\b/i.test(arriving);
}

function isMobile(order) {
  return /s25\s*fe|galaxy-s25|mobile/i.test(order.product || "");
}

function isTab(order) {
  return /tab\s*a11|galaxy\s*tab|TABHHQEY/i.test(order.product || "");
}

const USAGE_TARGET = 3;

/** Successful mobile + tab order cards (tab ×2 qty = 1 card). Cancelled excluded. */
function mobileTabSuccessCount(orders) {
  let n = 0;
  for (const o of orders || []) {
    if (isCancelled(o)) continue;
    if (isMobile(o) || isTab(o)) n += 1;
  }
  return n;
}

/**
 * unused = 0, half_used = 1..2, complete = >= 3 (mobile+tab success).
 */
function usageLabel(count) {
  if (count <= 0) return "unused";
  if (count < USAGE_TARGET) return "half_used";
  return "complete";
}

function buildUsageBuckets(reports) {
  const unused = [];
  const half = [];
  const complete = [];

  for (const report of reports) {
    const orders = report.orders || [];
    let mobileSuccess = 0;
    let tabSuccess = 0;
    for (const o of orders) {
      if (isCancelled(o)) continue;
      if (isMobile(o)) mobileSuccess += 1;
      else if (isTab(o)) tabSuccess += 1;
    }
    const mobileTab = mobileSuccess + tabSuccess;
    const row = {
      "Mail ID": report.accountId || "",
      "Mobile+Tab orders": mobileTab,
      Mobile: mobileSuccess,
      Tab: tabSuccess,
      Needed: Math.max(0, USAGE_TARGET - mobileTab),
      Usage: usageLabel(mobileTab),
    };
    if (mobileTab <= 0) unused.push(row);
    else if (mobileTab < USAGE_TARGET) half.push(row);
    else complete.push(row);
  }

  const sortFn = (a, b) =>
    a["Mobile+Tab orders"] - b["Mobile+Tab orders"] ||
    String(a["Mail ID"]).localeCompare(String(b["Mail ID"]));
  unused.sort(sortFn);
  half.sort(sortFn);
  complete.sort(sortFn);

  return { unused, half, complete };
}

/**
 * Aggregate mobiles / tabs / cancelled / success across all accounts.
 * Each order card counts as 1 (tab qty 2 = 1 tab order, not 2).
 * Tab counts are kept in a separate block from mobile.
 */
function buildSummary(reports) {
  const all = reports.flatMap((r) => r.orders || []);
  const mobile = { orders: 0, success: 0, cancelled: 0 };
  const tab = { orders: 0, success: 0, cancelled: 0 };
  let other = 0;
  let cancelled = 0;
  let success = 0;

  for (const o of all) {
    const cancelledOrder = isCancelled(o);
    if (cancelledOrder) cancelled += 1;
    else success += 1;

    if (isMobile(o)) {
      mobile.orders += 1;
      if (cancelledOrder) mobile.cancelled += 1;
      else mobile.success += 1;
    } else if (isTab(o)) {
      tab.orders += 1;
      if (cancelledOrder) tab.cancelled += 1;
      else tab.success += 1;
    } else {
      other += 1;
    }
  }

  return {
    accounts: reports.length,
    total_orders: all.length,
    mobile,
    tab,
    success,
    cancelled,
    other,
  };
}

function printSummary(summary) {
  console.log("\n========== SUMMARY ==========");
  console.log(`Accounts:          ${summary.accounts}`);
  console.log(`Total orders:      ${summary.total_orders}`);
  console.log("--- Mobile ---");
  console.log(`  Orders:          ${summary.mobile.orders}`);
  console.log(`  Success:         ${summary.mobile.success}`);
  console.log(`  Cancelled:       ${summary.mobile.cancelled}`);
  console.log("--- Tab (qty 2 = 1 order) ---");
  console.log(`  Orders:          ${summary.tab.orders}`);
  console.log(`  Success:         ${summary.tab.success}`);
  console.log(`  Cancelled:       ${summary.tab.cancelled}`);
  console.log("--- Overall ---");
  console.log(`  Success:         ${summary.success}`);
  console.log(`  Cancelled:       ${summary.cancelled}`);
  if (summary.other) console.log(`  Other / unknown: ${summary.other}`);
  console.log("=============================\n");
}

function printAccount(report) {
  console.log(`\n=== ${report.accountId} ===`);
  if (!report.ok) {
    console.log(`  ERROR: ${report.error}`);
    return;
  }
  console.log(`  Orders found: ${report.count}`);
  if (report.note) console.log(`  Note: ${report.note}`);
  report.orders.forEach((o, i) => {
    console.log(`  ${i + 1}. ${o.product || "(product unknown)"}${o.quantity > 1 ? ` ×${o.quantity}` : ""}`);
    console.log(`     Order ID:    ${o.orderId || "—"}`);
    console.log(`     Tracking ID: ${o.trackingId || "—"}`);
    console.log(`     Arriving:    ${o.arriving || "—"}`);
    if (o.status) console.log(`     Status:      ${o.status}`);
  });
}

function productType(order) {
  if (isTab(order)) return "Tab";
  if (isMobile(order)) return "Mobile";
  return "Other";
}

function outcome(order) {
  return isCancelled(order) ? "Cancelled" : "Success";
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Calendar day in Asia/Kolkata for report "today" (Flipkart relative dates). */
function reportRefDate(checkedAt) {
  const d = checkedAt ? new Date(checkedAt) : new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return new Date(get("year"), get("month") - 1, get("day"));
}

function formatMonthDay(date) {
  return `${MONTH_NAMES[date.getMonth()]} ${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Resolve arriving text → { month, day, year } including relative
 * "today" / "tomorrow" (e.g. "Arriving tomorrow by 11 pm").
 */
function resolveArrivingDate(order, refDate) {
  if (isCancelled(order) || isDelivered(order)) return null;
  const raw = String(order.arriving || "").replace(/\s+/g, " ").trim();
  if (!raw || /cancel/i.test(raw)) return null;

  const base = refDate instanceof Date ? refDate : reportRefDate();

  if (/\btoday\b/i.test(raw)) {
    return {
      month: MONTH_NAMES[base.getMonth()],
      day: base.getDate(),
      year: base.getFullYear(),
    };
  }
  if (/\btomorrow\b/i.test(raw)) {
    const t = new Date(base);
    t.setDate(t.getDate() + 1);
    return {
      month: MONTH_NAMES[t.getMonth()],
      day: t.getDate(),
      year: t.getFullYear(),
    };
  }

  const m = raw.match(
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:,?\s*(\d{4}))?\b/i
  );
  if (!m) return null;
  return {
    month: m[1],
    day: Number(m[2]),
    year: m[3] ? Number(m[3]) : base.getFullYear(),
  };
}

/** Normalize arriving text → bucket key for delivery-date pivots. */
function deliveryBucket(order, refDate) {
  const raw = String(order.arriving || "").replace(/\s+/g, " ").trim();
  if (isCancelled(order) || /^cancel/i.test(raw)) return "Cancelled";
  if (!raw) return "Unknown / not set";

  // Resolve today/tomorrow to a real calendar date for Excel sheets
  const resolved = resolveArrivingDate(order, refDate);
  if (resolved && /\b(today|tomorrow)\b/i.test(raw)) {
    return `Expected: ${resolved.month} ${resolved.day}`;
  }

  let m = raw.match(/Delivery expected by\s+(.+?)(?:\.|$)/i);
  if (m) return `Expected: ${m[1].trim()}`;

  m = raw.match(/Delivered on\s+(.+?)(?:\.|$)/i);
  if (m) return `Delivered: ${m[1].trim()}`;

  m = raw.match(/Arriving(?:\s+by)?\s+(.+?)(?:\.|$)/i);
  if (m) return `Expected: ${m[1].trim()}`;

  // Ignore long fee / policy blurbs mis-scraped as arriving
  if (raw.length > 80 || /invoice|refund|fee may/i.test(raw)) return "Unknown / not set";
  return raw;
}

function deliverySortKey(label) {
  if (label === "Cancelled") return Number.MAX_SAFE_INTEGER - 1;
  if (label === "Unknown / not set") return Number.MAX_SAFE_INTEGER;
  const year = new Date().getFullYear();
  const bare = label.replace(/^(Expected|Delivered):\s*/i, "");
  const t = Date.parse(`${bare} ${year}`);
  if (Number.isFinite(t)) return t;
  return label;
}

/** Phone / tab counts per expected delivery date (tab qty 2 = 1 order). */
function buildByDeliveryDate(reports, refDate) {
  const map = new Map();
  for (const report of reports) {
    for (const o of report.orders || []) {
      if (isDelivered(o)) continue;
      const key = deliveryBucket(o, refDate);
      if (!map.has(key)) {
        map.set(key, { "Delivery / expected": key, Phones: 0, Tabs: 0, Other: 0 });
      }
      const row = map.get(key);
      if (isMobile(o)) row.Phones += 1;
      else if (isTab(o)) row.Tabs += 1;
      else row.Other += 1;
    }
  }

  return [...map.values()]
    .map((r) => ({
      "Delivery / expected": r["Delivery / expected"],
      Phones: r.Phones,
      Tabs: r.Tabs,
      Other: r.Other,
      Total: r.Phones + r.Tabs + r.Other,
    }))
    .sort(
      (a, b) =>
        deliverySortKey(a["Delivery / expected"]) - deliverySortKey(b["Delivery / expected"])
    );
}

/** Parse month + day from arriving text (absolute or today/tomorrow). */
function parseArrivingMonthDay(order, refDate) {
  const resolved = resolveArrivingDate(order, refDate);
  if (!resolved) return null;
  return { month: resolved.month, day: resolved.day };
}

function deviceLabel(order) {
  if (isTab(order)) return "Tab";
  if (isMobile(order)) return "Mobile";
  return "Other";
}

/** Oct days to split into dedicated Excel sheets (today through Oct 20). */
const ARRIVING_OCT_DAYS = [14, 15, 16, 17, 18, 19, 20];

/**
 * Rows for a target calendar day (month + day), non-cancelled only.
 */
function buildArrivingDayRows(reports, month, day, refDate) {
  const monthRe = new RegExp(`^${month}$`, "i");
  const rows = [];
  for (const report of reports) {
    for (const o of report.orders || []) {
      if (isCancelled(o) || isDelivered(o)) continue;
      const md = parseArrivingMonthDay(o, refDate);
      if (!md || !monthRe.test(md.month) || md.day !== day) continue;
      rows.push({
        "Mail ID": report.accountId || "",
        "Order ID": o.orderId || "",
        "Tracking ID": o.trackingId || "",
        "Delivery expected": o.arriving || deliveryBucket(o, refDate),
        Device: deviceLabel(o),
        Product: o.product || "",
        Qty: o.quantity ?? 1,
        Status: o.status || "",
      });
    }
  }
  rows.sort((a, b) =>
    String(a["Mail ID"]).localeCompare(String(b["Mail ID"])) ||
    String(a["Order ID"]).localeCompare(String(b["Order ID"]))
  );
  return rows;
}

function buildArrivingRangeRows(reports, month, days, refDate) {
  const daySet = new Set(days);
  const rows = [];
  for (const day of days) {
    for (const r of buildArrivingDayRows(reports, month, day, refDate)) {
      rows.push({ Day: `${month} ${day}`, ...r });
    }
  }
  // keep day order already from loop; ignore unused daySet lint
  void daySet;
  return rows;
}

/** Write Summary + Orders + By Account + By Delivery Date sheets (delivered excluded). */
function writeExcelReport(payload) {
  const reports = payload.reports || [];
  const reportsOpen = reports.map((r) => ({
    ...r,
    orders: (r.orders || []).filter((o) => !isDelivered(o)),
  }));
  const stats = buildSummary(reportsOpen);
  const checkedAt = payload.checked_at || new Date().toISOString();
  const refDate = reportRefDate(checkedAt);
  const byDelivery = buildByDeliveryDate(reportsOpen, refDate);
  const arrivingByDay = ARRIVING_OCT_DAYS.map((day) => ({
    day,
    sheet: `Oct ${day}`,
    rows: buildArrivingDayRows(reportsOpen, "Oct", day, refDate),
  }));
  const arrivingRange = buildArrivingRangeRows(
    reportsOpen,
    "Oct",
    ARRIVING_OCT_DAYS,
    refDate
  );
  // Full history (incl. delivered) for usage: unused / half / complete
  const usage = buildUsageBuckets(reports);

  const summaryRows = [
    { Field: "Checked at", Value: checkedAt },
    {
      Field: "Report day (IST)",
      Value: `${formatMonthDay(refDate)} ${refDate.getFullYear()} (today/tomorrow resolved from this)`,
    },
    { Field: "Note", Value: "Delivered orders excluded from order sheets; usage uses all success mobile+tab" },
    { Field: "Accounts", Value: stats.accounts },
    { Field: "Total orders", Value: stats.total_orders },
    { Field: "Mobile orders", Value: stats.mobile?.orders ?? 0 },
    { Field: "Mobile success", Value: stats.mobile?.success ?? 0 },
    { Field: "Mobile cancelled", Value: stats.mobile?.cancelled ?? 0 },
    { Field: "Tab orders (qty 2 = 1 order)", Value: stats.tab?.orders ?? 0 },
    { Field: "Tab success", Value: stats.tab?.success ?? 0 },
    { Field: "Tab cancelled", Value: stats.tab?.cancelled ?? 0 },
    { Field: "Overall success", Value: stats.success ?? 0 },
    { Field: "Overall cancelled", Value: stats.cancelled ?? 0 },
    { Field: "", Value: "" },
    {
      Field: "— Account usage (mobile+tab success, tab×2=1, target 3) —",
      Value: "cancelled excluded",
    },
    { Field: "Unused (=0)", Value: usage.unused.length },
    { Field: "Half used (1–2)", Value: usage.half.length },
    { Field: "Complete used (>=3)", Value: usage.complete.length },
    { Field: "", Value: "" },
    { Field: "— Arriving Oct 14–20 —", Value: "open orders only" },
    ...arrivingByDay.map(({ sheet, rows }) => ({
      Field: sheet,
      Value: rows.length,
    })),
    {
      Field: "Oct 14–20 total",
      Value: arrivingRange.length,
    },
    { Field: "", Value: "" },
    { Field: "— By expected delivery —", Value: "Phones | Tabs" },
    ...byDelivery.map((r) => ({
      Field: r["Delivery / expected"],
      Value: `${r.Phones} phones, ${r.Tabs} tabs` + (r.Other ? `, ${r.Other} other` : ""),
    })),
  ];

  const orderRows = [];
  for (const report of reports) {
    const accountId = report.accountId || "";
    const orders = (report.orders || []).filter((o) => !isDelivered(o));
    if (!orders.length) {
      orderRows.push({
        Account: accountId,
        "Order ID": "",
        Product: "",
        Type: "",
        Qty: "",
        Status: report.ok === false ? `ERROR: ${report.error || ""}` : "(no open orders)",
        Outcome: "",
        Arriving: "",
        "Delivery bucket": "",
        "Tracking ID": "",
        Checked: report.checked_at || checkedAt,
      });
      continue;
    }
    for (const o of orders) {
      orderRows.push({
        Account: accountId,
        "Order ID": o.orderId || "",
        Product: o.product || "",
        Type: productType(o),
        Qty: o.quantity ?? 1,
        Status: o.status || "",
        Outcome: outcome(o),
        Arriving: o.arriving || "",
        "Delivery bucket": deliveryBucket(o, refDate),
        "Tracking ID": o.trackingId || "",
        Checked: report.checked_at || checkedAt,
      });
    }
  }

  const byAccountRows = reports.map((report) => {
    const orders = (report.orders || []).filter((o) => !isDelivered(o));
    let mobile = 0;
    let tab = 0;
    let success = 0;
    let cancelled = 0;
    for (const o of orders) {
      if (isCancelled(o)) cancelled += 1;
      else success += 1;
      if (isMobile(o)) mobile += 1;
      else if (isTab(o)) tab += 1;
    }
    const mobileTab = mobileTabSuccessCount(report.orders || []);
    return {
      Account: report.accountId || "",
      "Total orders": orders.length,
      Mobile: mobile,
      Tab: tab,
      "Mobile+Tab success": mobileTab,
      Usage: usageLabel(mobileTab),
      Success: success,
      Cancelled: cancelled,
      OK: report.ok === false ? "error" : "ok",
      Checked: report.checked_at || checkedAt,
    };
  });

  const emptyDay = [
    {
      "Mail ID": "",
      "Order ID": "",
      "Tracking ID": "",
      "Delivery expected": "(none)",
      Device: "",
      Product: "",
      Qty: "",
      Status: "",
    },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "Summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byDelivery), "By Delivery Date");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(arrivingRange.length ? arrivingRange : [{ Day: "", ...emptyDay[0] }]),
    "Oct 14-20"
  );
  for (const { sheet, rows } of arrivingByDay) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(rows.length ? rows : emptyDay),
      sheet
    );
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orderRows), "Orders");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byAccountRows), "By Account");

  const emptyUsage = [
    {
      "Mail ID": "",
      "Mobile+Tab orders": "",
      Mobile: "",
      Tab: "",
      Needed: "",
      Usage: "(none)",
    },
  ];
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(usage.unused.length ? usage.unused : emptyUsage),
    "Unused IDs"
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(usage.half.length ? usage.half : emptyUsage),
    "Half Used IDs"
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(usage.complete.length ? usage.complete : emptyUsage),
    "Complete Used IDs"
  );

  XLSX.writeFile(wb, EXCEL_FILE);
  console.log(
    "Arriving sheets: " +
      arrivingByDay.map(({ sheet, rows }) => `${sheet}=${rows.length}`).join(", ") +
      ` | Oct 14-20 total=${arrivingRange.length}`
  );
  console.log(
    `Usage: unused=${usage.unused.length}, half=${usage.half.length}, complete=${usage.complete.length}`
  );
  return EXCEL_FILE;
}

/** Rebuild report payload from existing order-report.xlsx Orders sheet. */
function payloadFromExcel(excelPath = EXCEL_FILE) {
  if (!fs.existsSync(excelPath)) {
    throw new Error(`No ${excelPath}`);
  }
  const wb = XLSX.readFile(excelPath);
  const sheet = wb.Sheets.Orders;
  if (!sheet) throw new Error(`No "Orders" sheet in ${path.basename(excelPath)}`);
  const rows = XLSX.utils.sheet_to_json(sheet);
  const byAccount = new Map();
  for (const r of rows) {
    const accountId = r.Account || "";
    if (!accountId) continue;
    if (!byAccount.has(accountId)) {
      byAccount.set(accountId, {
        accountId,
        ok: true,
        orders: [],
        checked_at: r.Checked || null,
      });
    }
    if (!r["Order ID"] && /no orders|ERROR/i.test(String(r.Status || ""))) {
      continue;
    }
    if (!r["Order ID"]) continue;
    byAccount.get(accountId).orders.push({
      orderId: r["Order ID"] || null,
      product: r.Product || null,
      quantity: r.Qty ?? 1,
      status: r.Status || null,
      arriving: r.Arriving || null,
      trackingId: r["Tracking ID"] || null,
    });
  }
  const reports = [...byAccount.values()].map((rep) => ({
    ...rep,
    count: rep.orders.length,
  }));
  return {
    checked_at: new Date().toISOString(),
    reports,
    summary: buildSummary(reports),
  };
}

function loadExistingPayload() {
  if (fs.existsSync(OUT_FILE)) {
    return JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
  }
  if (fs.existsSync(EXCEL_FILE)) {
    console.log(`No ${path.basename(OUT_FILE)} — loading from ${path.basename(EXCEL_FILE)}`);
    return payloadFromExcel(EXCEL_FILE);
  }
  return null;
}

function mergeReports(baseReports, freshReports) {
  const byId = new Map((baseReports || []).map((r) => [r.accountId, r]));
  for (const fresh of freshReports) {
    const prev = byId.get(fresh.accountId);
    if (!fresh.ok && prev) {
      // Keep previous good data if enrich failed
      byId.set(fresh.accountId, {
        ...prev,
        enrich_error: fresh.error,
        enrich_attempted_at: fresh.checked_at,
      });
      continue;
    }
    if (fresh.ok && (!fresh.orders || !fresh.orders.length) && prev?.orders?.length) {
      // Unexpected empty — keep previous, flag it
      byId.set(fresh.accountId, {
        ...prev,
        enrich_note: "re-fetch returned 0 orders; kept previous",
        enrich_attempted_at: fresh.checked_at,
      });
      continue;
    }
    // Merge: keep best delivery date + never drop a known tracking id
    if (prev?.orders?.length && fresh.orders?.length) {
      const prevByOd = new Map(prev.orders.map((o) => [o.orderId, o]));
      fresh.orders = fresh.orders.map((o) => {
        const old = prevByOd.get(o.orderId);
        if (!old) return o;
        return {
          ...o,
          trackingId: o.trackingId || old.trackingId || null,
          product: o.product || old.product || null,
          arriving: pickBestArriving(o.arriving, old.arriving),
          status: o.status || old.status || null,
        };
      });
    }
    byId.set(fresh.accountId, fresh);
  }
  return [...byId.values()];
}

function writePayload(reports, { enrich = false } = {}) {
  const stats = buildSummary(reports);
  const summary = {
    checked_at: new Date().toISOString(),
    summary: stats,
    accounts: stats.accounts,
    total_orders: stats.total_orders,
    mobile: stats.mobile,
    tab: stats.tab,
    success: stats.success,
    cancelled: stats.cancelled,
    enrich: enrich || undefined,
    reports,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  if (FROM_JSON) {
    const payload = loadExistingPayload();
    if (!payload) {
      throw new Error(`No ${OUT_FILE} or ${EXCEL_FILE} — run a full check first.`);
    }
    const excelPath = writeExcelReport(payload);
    printSummary(payload.summary || buildSummary(payload.reports || []));
    console.log(`Excel saved: ${excelPath}`);
    return;
  }

  if (BROWSE) {
    await runBrowseBatches(readAccountIds());
    return;
  }

  let ids = readAccountIds();
  let existingPayload = null;

  if (ENRICH) {
    existingPayload = loadExistingPayload();
    if (!existingPayload?.reports?.length) {
      throw new Error("--enrich needs an existing order-report.json (run a full check first).");
    }
    const withOrders = new Set(
      existingPayload.reports
        .filter((r) => (r.orders || []).length > 0)
        .map((r) => r.accountId)
    );
    const before = ids.length;
    ids = ids.filter((id) => withOrders.has(id));
    console.log(
      `ENRICH mode: ${ids.length}/${before} accounts that already have orders (skipping empty)`
    );
    const needTrack = existingPayload.reports
      .filter((r) => withOrders.has(r.accountId))
      .reduce((n, r) => {
        for (const o of r.orders || []) {
          if (isCancelled(o) || isDelivered(o)) continue;
          if (!o.trackingId) n += 1;
        }
        return n;
      }, 0);
    console.log(`Open orders still missing tracking (from last report): ${needTrack}`);
  }

  console.log(`Checking orders for ${ids.length} account(s)…`);
  console.log(
    `Concurrency: ${FETCH_CONCURRENCY} parallel Chrome session(s)` +
      (ENRICH ? " (enrich fast default 8)" : " (default 4)")
  );
  console.log(`Start stagger: ${START_STAGGER_MS}ms between first-wave sessions`);
  if (WANT_DETAILS) {
    console.log(
      "Detail pages ON — re-verify fields + fetch tracking for every open order."
    );
  } else {
    console.log("Detail pages OFF (--no-details) — tracking IDs will usually be empty.");
  }
  console.log(`Cookies: ${COOKIE_FILE}`);
  console.log(`Report → ${OUT_FILE}`);
  console.log(`Excel  → ${EXCEL_FILE}\n`);

  let doneCount = 0;
  let slotSeq = 0;
  const freshById = new Map();

  const freshReports = await mapPool(ids, FETCH_CONCURRENCY, async (id, index) => {
    const slotIndex = slotSeq++;
    if (START_STAGGER_MS > 0 && slotIndex < FETCH_CONCURRENCY) {
      await new Promise((r) => setTimeout(r, START_STAGGER_MS * slotIndex));
    }
    logFor(id, `start [${index + 1}/${ids.length}] (slot ${slotIndex})`);
    const report = await fetchOrdersForAccount(id, { slotIndex });
    freshById.set(id, report);
    doneCount += 1;
    const tracked = (report.orders || []).filter((o) => o.trackingId).length;
    logFor(
      id,
      report.ok
        ? `done — ${report.count} order(s), tracking ${tracked}  (${doneCount}/${ids.length})`
        : `ERROR: ${report.error}  (${doneCount}/${ids.length})`
    );

    // Checkpoint every 25 accounts so progress isn't lost
    if (ENRICH && existingPayload && doneCount % 25 === 0) {
      const merged = mergeReports(existingPayload.reports, [...freshById.values()]);
      writePayload(merged, { enrich: true });
      console.log(`  ↳ checkpoint saved (${doneCount}/${ids.length})`);
    }

    return report;
  });

  let reports = freshReports;
  if (ENRICH && existingPayload) {
    reports = mergeReports(existingPayload.reports, freshReports);
  }

  const summary = writePayload(reports, { enrich: ENRICH });
  printSummary(summary.summary);
  const excelPath = writeExcelReport(summary);
  console.log(`Saved: ${OUT_FILE}`);
  console.log(`Excel: ${excelPath}`);

  if (ENRICH) {
    let withTrack = 0;
    let open = 0;
    for (const r of reports) {
      for (const o of r.orders || []) {
        if (isCancelled(o) || isDelivered(o)) continue;
        open += 1;
        if (o.trackingId) withTrack += 1;
      }
    }
    console.log(`Open orders with tracking: ${withTrack}/${open}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
