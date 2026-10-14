/**
 * Per-account Flipkart order report from My Orders (Rome page/fetch API):
 * count, product, order id, qty, status, arriving date, tracking id (when shipped).
 * Also writes order-report.xlsx (Summary + Orders + By Account sheets).
 *
 * Usage:
 *   node check-orders.js
 *   node check-orders.js ananki148
 *   node check-orders.js --details          # also open each order detail page
 *   node check-orders.js --max=10
 *   node check-orders.js --from-json        # rebuild Excel from existing order-report.json
 *   node check-orders.js --browse           # open 3 phone Chromes → Orders; next batch when all closed
 *   node check-orders.js --browse --batch=3 --cookie-file=cookie-pending.json
 */

const fs = require("fs");
const path = require("path");
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

const WANT_DETAILS = process.argv.includes("--details");
const FROM_JSON = process.argv.includes("--from-json");
const BROWSE = process.argv.includes("--browse");
const BATCH =
  parseInt(
    (process.argv.find((a) => a.startsWith("--batch=")) || "").split("=")[1] ||
      (process.argv.find((a) => a.startsWith("--concurrency=")) || "").split(
        "="
      )[1] ||
      "3",
    10
  ) || 3;
const MAX_DETAIL =
  parseInt(
    (process.argv.find((a) => a.startsWith("--max=")) || "").split("=")[1] || "12",
    10
  ) || 12;
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

    orders.push({
      orderId,
      product,
      quantity,
      status: status ? String(status).replace(/\s+/g, " ").trim() : null,
      arriving: arriving ? String(arriving).replace(/\s+/g, " ").trim() : null,
      trackingId: null,
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

function extractDetailFields(json) {
  const text = JSON.stringify(json);
  const orderId = (text.match(/OD\d{10,}/) || [])[0] || null;
  const trackingKey = text.match(/"trackingId"\s*:\s*"([^"]+)"/i);
  const trackingId =
    (trackingKey && trackingKey[1]) ||
    (text.match(/\bFMP[A-Z0-9]{8,}\b/i) || [])[0] ||
    null;

  let product = null;
  let arriving = null;
  let status = null;

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
      if (!arriving && /Delivery expected by|Delivered on|Arriving|Cancelled/i.test(s)) {
        arriving = s;
      }
      if (
        !status &&
        /Order has been placed|Shipped|Out for delivery|Delivered|Cancelled|canceled/i.test(s)
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
    arriving,
    status,
  };
}

function waitForRomeFetch(page, { timeoutMs = 15000, preferOds = true } = {}) {
  const hits = [];
  const onResponse = async (res) => {
    try {
      if (res.status() !== 200) return;
      if (!/rome\.api\.flipkart\.com\/api\/4\/page\/fetch/i.test(res.url())) return;
      const json = await res.json();
      const text = JSON.stringify(json);
      const ods = [...new Set(text.match(/OD\d{10,}/g) || [])];
      hits.push({ json, len: text.length, ods });
    } catch (_) {
      /* ignore */
    }
  };
  page.on("response", onResponse);

  const done = (async () => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (preferOds) {
        const withOd = hits.filter((h) => h.ods.length).sort((a, b) => b.ods.length - a.ods.length);
        if (withOd[0]) return withOd[0];
      } else if (hits.length) {
        return hits.sort((a, b) => b.len - a.len)[0];
      }
      await page.waitForTimeout(200);
    }
    return hits.sort((a, b) => b.ods.length - a.ods.length || b.len - a.len)[0] || null;
  })();

  return {
    promise: done.finally(() => page.off("response", onResponse)),
  };
}

async function fetchOrdersForAccount(accountId) {
  let browser;
  let cleanup = () => {};

  try {
    const session = await openFlipkartMobileSession(accountId, {
      cookieFile: COOKIE_FILE,
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
      console.log(
        `  Rome list payload missing ODs (dom hints: expected=${expected}, cancelled=${cancelled}).`
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
    console.log(`  List API: ${orders.length} order card(s).`);

    if (WANT_DETAILS && orders.length) {
      for (const o of orders.slice(0, MAX_DETAIL)) {
        const detailWait = waitForRomeFetch(page, { timeoutMs: 12000, preferOds: false });
        const url = "https://www.flipkart.com" + o.detailPath;
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
          await page.waitForTimeout(2500);
          const detailHit = await detailWait.promise;
          if (detailHit) {
            const d = extractDetailFields(detailHit.json);
            o.product = cleanProduct(d.product) || o.product;
            o.arriving = d.arriving || o.arriving;
            o.status = d.status || o.status;
            o.trackingId = d.trackingId || o.trackingId;
            o.source = "rome_list+detail";
          }
        } catch (err) {
          console.log(`  Detail failed ${o.orderId}: ${err.message || err}`);
        }
      }
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

function isMobile(order) {
  return /s25\s*fe|galaxy-s25|mobile/i.test(order.product || "");
}

function isTab(order) {
  return /tab\s*a11|galaxy\s*tab|TABHHQEY/i.test(order.product || "");
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

/** Normalize arriving text → bucket key for delivery-date pivots. */
function deliveryBucket(order) {
  const raw = String(order.arriving || "").replace(/\s+/g, " ").trim();
  if (isCancelled(order) || /^cancel/i.test(raw)) return "Cancelled";
  if (!raw) return "Unknown / not set";

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
function buildByDeliveryDate(reports) {
  const map = new Map();
  for (const report of reports) {
    for (const o of report.orders || []) {
      const key = deliveryBucket(o);
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

/** Write Summary + Orders + By Account + By Delivery Date sheets */
function writeExcelReport(payload) {
  const reports = payload.reports || [];
  const stats = payload.summary || buildSummary(reports);
  const checkedAt = payload.checked_at || new Date().toISOString();
  const byDelivery = buildByDeliveryDate(reports);

  const summaryRows = [
    { Field: "Checked at", Value: checkedAt },
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
    { Field: "— By expected delivery —", Value: "Phones | Tabs" },
    ...byDelivery.map((r) => ({
      Field: r["Delivery / expected"],
      Value: `${r.Phones} phones, ${r.Tabs} tabs` + (r.Other ? `, ${r.Other} other` : ""),
    })),
  ];

  const orderRows = [];
  for (const report of reports) {
    const accountId = report.accountId || "";
    const orders = report.orders || [];
    if (!orders.length) {
      orderRows.push({
        Account: accountId,
        "Order ID": "",
        Product: "",
        Type: "",
        Qty: "",
        Status: report.ok === false ? `ERROR: ${report.error || ""}` : "(no orders)",
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
        "Delivery bucket": deliveryBucket(o),
        "Tracking ID": o.trackingId || "",
        Checked: report.checked_at || checkedAt,
      });
    }
  }

  const byAccountRows = reports.map((report) => {
    const orders = report.orders || [];
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
    return {
      Account: report.accountId || "",
      "Total orders": orders.length,
      Mobile: mobile,
      Tab: tab,
      Success: success,
      Cancelled: cancelled,
      OK: report.ok === false ? "error" : "ok",
      Checked: report.checked_at || checkedAt,
    };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "Summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byDelivery), "By Delivery Date");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orderRows), "Orders");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byAccountRows), "By Account");
  XLSX.writeFile(wb, EXCEL_FILE);
  return EXCEL_FILE;
}

async function main() {
  if (FROM_JSON) {
    if (!fs.existsSync(OUT_FILE)) {
      throw new Error(`No ${OUT_FILE} — run without --from-json first.`);
    }
    const payload = JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
    const excelPath = writeExcelReport(payload);
    printSummary(payload.summary || buildSummary(payload.reports || []));
    console.log(`Excel saved: ${excelPath}`);
    return;
  }

  const ids = readAccountIds();

  if (BROWSE) {
    await runBrowseBatches(ids);
    return;
  }

  console.log(`Checking orders for ${ids.length} account(s)…`);
  if (WANT_DETAILS) console.log("Detail pages enabled (--details).");
  console.log(`Report → ${OUT_FILE}`);
  console.log(`Excel  → ${EXCEL_FILE}\n`);

  const reports = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    console.log(`[${i + 1}/${ids.length}] ${id}`);
    const report = await fetchOrdersForAccount(id);
    reports.push(report);
    printAccount(report);
  }

  const stats = buildSummary(reports);
  printSummary(stats);

  const summary = {
    checked_at: new Date().toISOString(),
    summary: stats,
    accounts: stats.accounts,
    total_orders: stats.total_orders,
    mobile: stats.mobile,
    tab: stats.tab,
    success: stats.success,
    cancelled: stats.cancelled,
    reports,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2));
  const excelPath = writeExcelReport(summary);
  console.log(`Saved: ${OUT_FILE}`);
  console.log(`Excel: ${excelPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
