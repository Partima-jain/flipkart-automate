/**
 * Place (or dry-run) Flipkart COD phone orders via Rome + payments APIs.
 * Phones only — no tab. Places COUNT orders one-by-one per account.
 *
 * Usage:
 *   node place-orders-api.js --all                    # dry-run all accounts × 3 phones
 *   node place-orders-api.js --place --all            # REAL: 3 COD phones each account
 *   node place-orders-api.js --place --count=3 ananki345
 */
const fs = require("fs");
const path = require("path");
const {
  KNOWN_PRODUCTS,
  resolveProduct,
  cookieHeaderForAccount,
  checkoutCod,
} = require("./lib/checkout-api");

const COOKIE_FILE =
  process.argv.find((a) => a.startsWith("--cookie-file="))?.split("=")[1] ||
  path.join(__dirname, "cookie.json");

const PLACE = process.argv.includes("--place");
const ALL = process.argv.includes("--all");
const COUNT = Math.max(
  1,
  Number(process.argv.find((a) => a.startsWith("--count="))?.split("=")[1] || 3)
);
/** Optional remaining map: --remain=346:2,347:3,349:3 */
const REMAIN_ARG = process.argv.find((a) => a.startsWith("--remain="))?.slice("--remain=".length);
const PID =
  process.argv.find((a) => a.startsWith("--pid="))?.split("=")[1] ||
  "MOBHQCH6FPTX5FZ2";
const FILTER = process.argv
  .slice(2)
  .find((a) => a && !a.startsWith("--"));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadIds() {
  const data = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
  const ids = (data.ids || []).map((a) => a.id).filter(Boolean);
  if (!ids.length) throw new Error("No accounts in cookie file");
  if (FILTER) {
    const hit = ids.filter((id) => id.includes(FILTER));
    if (!hit.length) throw new Error(`No account matching ${FILTER}`);
    return hit;
  }
  // Default: all accounts in cookie.json (same as --all)
  return ids;
}

/** Per-account remaining counts from --remain=346:2,347:3 */
function remainMap() {
  if (!REMAIN_ARG) return null;
  const map = {};
  for (const part of REMAIN_ARG.split(",")) {
    const [k, v] = part.split(":");
    if (k && v) map[k] = Math.max(1, Number(v) || 1);
  }
  return map;
}

function paySummary(res) {
  return {
    orderId: res.orderId || null,
    error: res.error || null,
    pgPreview: res.pg?.raw ? String(res.pg.raw).slice(0, 400) : null,
    payStatus: res.pay?.json?.response_status || null,
  };
}

async function main() {
  const product = resolveProduct(PID);
  if (!product?.listingId) {
    console.error(
      `Unknown/incomplete product ${PID}. Known:`,
      Object.keys(KNOWN_PRODUCTS).filter((k) => KNOWN_PRODUCTS[k].listingId)
    );
    process.exit(1);
  }

  if (PLACE) {
    console.log(`⚠ REAL PLACE — ${COUNT} phone COD order(s) per account (no tab).`);
  } else {
    console.log(`Dry-run: ${COUNT}× checkout+token per account — no orders created.`);
  }

  console.log(`Product: ${product.pid} listing=${product.listingId}`);
  const ids = loadIds();
  const remain = remainMap();
  console.log(`Accounts: ${ids.length}${ALL || !FILTER ? " (all in cookie.json)" : ""}`);

  const results = [];
  for (const id of ids) {
    const key = Object.keys(remain || {}).find((k) => id.includes(k));
    const need = remain ? (key ? remain[key] : 0) : COUNT;
    if (need <= 0) continue;
    console.log(`\n=== ${id} (${need} phone(s)) ===`);
    const accountOrders = [];
    for (let n = 1; n <= need; n++) {
      process.stdout.write(`  phone ${n}/${need} … `);
      try {
        const cookieHeader = cookieHeaderForAccount(id, { cookieFile: COOKIE_FILE });
        const res = await checkoutCod(cookieHeader, product, { dryRun: !PLACE });
        const pay = PLACE ? paySummary(res) : {};
        const line =
          `${res.ok ? "OK" : "FAIL"} ${res.reason}` +
          (res.summary?.grandTotal != null ? ` ₹${res.summary.grandTotal}` : "") +
          (pay.orderId ? ` order=${pay.orderId}` : "") +
          (pay.error ? ` (${pay.error})` : "");
        console.log(line);
        accountOrders.push({
          n,
          ok: res.ok,
          reason: res.reason,
          grandTotal: res.summary?.grandTotal ?? null,
          pincode: res.summary?.pincode ?? null,
          orderId: pay.orderId || null,
          error: pay.error || null,
          steps: res.steps,
          pgPreview: pay.pgPreview || null,
        });
        if (!res.ok) break; // stop this account on failure
      } catch (e) {
        console.log("ERR", e.message || e);
        accountOrders.push({ n, ok: false, reason: String(e.message || e) });
        break;
      }
      if (n < need) await sleep(PLACE ? 2000 : 400);
    }
    const okCount = accountOrders.filter((o) => o.ok).length;
    console.log(`  → ${okCount}/${need} phone(s) ${PLACE ? "placed" : "ready"}`);
    results.push({ id, okCount, need, orders: accountOrders });
  }

  const out = path.join(__dirname, "place-orders-api-result.json");
  fs.writeFileSync(
    out,
    JSON.stringify({ place: PLACE, count: COUNT, remain: remain || null, product, results }, null, 2)
  );
  console.log(`\nWrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
