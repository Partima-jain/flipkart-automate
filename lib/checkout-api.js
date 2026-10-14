/**
 * Cookie-auth Flipkart checkout APIs (Buy now → payment token → COD pay).
 * Same Rome + payments hosts the mobile site uses.
 */

const https = require("https");
const { cookiesToHeader, cookieHeaderForAccount } = require("./rome-api");

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const X_USER_AGENT = `${MOBILE_UA} FKUA/msite/0.0.3/msite/Mobile`;

const ROME_HOSTS = [
  "1.rome.api.flipkart.com",
  "2.rome.api.flipkart.com",
  "rome.api.flipkart.com",
];
const PAY_HOSTS = ["1.payments.flipkart.com", "2.payments.flipkart.com"];
let preferredRomeHost = ROME_HOSTS[0];

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 8,
  timeout: 30000,
});

/** Known listings (listingId + price + category tags for Buy now). */
const KNOWN_PRODUCTS = {
  MOBHQCH6FPTX5FZ2: {
    pid: "MOBHQCH6FPTX5FZ2",
    listingId: "LSTMOBHQCH6FPTX5FZ26HBEZT",
    primaryProductPrice: 46999,
    selectedActions: [
      "BUSINESS_UNIT=Mobile",
      "SUPERCATEGORY=Mobile",
      "VERTICAL=mobile",
      "PREXO_OPT_OUT",
      "BUY_NOW",
    ],
  },
  TABHHQEYGFNBJMB9: {
    pid: "TABHHQEYGFNBJMB9",
    listingId: null, // resolve on first dry-run / capture
    primaryProductPrice: null,
    selectedActions: [
      "BUSINESS_UNIT=Tablet",
      "SUPERCATEGORY=Computers",
      "VERTICAL=tablet",
      "PREXO_OPT_OUT",
      "BUY_NOW",
    ],
  },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseSetCookie(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const out = {};
  for (const line of list) {
    const pair = String(line).split(";")[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

function mergeCookieHeader(cookieHeader, setCookie) {
  const map = {};
  for (const part of String(cookieHeader || "").split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    map[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  }
  Object.assign(map, parseSetCookie(setCookie));
  // Also apply SESSION tokens from JSON body if present
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function applySessionToCookie(cookieHeader, session) {
  if (!session) return cookieHeader;
  const extras = [];
  if (session.at) extras.push(`at=${session.at}`);
  if (session.rt) extras.push(`rt=${session.rt}`);
  if (session.sn) extras.push(`SN=${session.sn}`);
  if (!extras.length) return cookieHeader;
  return mergeCookieHeader(cookieHeader, extras);
}

function requestHttp({
  hostname,
  path: reqPath,
  method = "POST",
  body = null,
  contentType = "application/json",
  cookieHeader,
  origin,
  referer,
  timeoutMs = 30000,
}) {
  return new Promise((resolve, reject) => {
    const headers = {
      accept: "*/*",
      "user-agent": MOBILE_UA,
      "x-user-agent": X_USER_AGENT,
      referer: referer || "https://www.flipkart.com/",
      origin: origin || "https://www.flipkart.com",
      cookie: cookieHeader,
    };
    if (body != null) {
      headers["content-type"] = contentType;
      headers["content-length"] = Buffer.byteLength(body);
    }
    const req = https.request(
      { hostname, path: reqPath, method, agent, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (_) {}
          resolve({
            hostname,
            path: reqPath,
            status: res.statusCode,
            headers: res.headers,
            setCookie: res.headers["set-cookie"],
            raw,
            json,
            ok: res.statusCode >= 200 && res.statusCode < 300,
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function requestJson(opts) {
  const body = opts.bodyObj == null ? null : JSON.stringify(opts.bodyObj);
  return requestHttp({ ...opts, body, contentType: "application/json" });
}

async function romePost(apiPath, bodyObj, cookieHeader, opts = {}) {
  const q = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const timeoutMs = opts.timeoutMs ?? 45000;
  const hosts = [
    preferredRomeHost,
    ...ROME_HOSTS.filter((h) => h !== preferredRomeHost),
  ];
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const host of hosts) {
      try {
        last = await requestJson({
          hostname: host,
          path: q,
          bodyObj,
          cookieHeader,
          timeoutMs,
        });
        if (last.ok) {
          preferredRomeHost = host;
          return last;
        }
        // 406 DC mismatch — try next host
        if (last.status === 406) continue;
      } catch (err) {
        last = {
          ok: false,
          status: 0,
          error: String(err.message || err),
          hostname: host,
          path: q,
        };
      }
    }
    if (attempt < 3) await sleep(500 * attempt);
  }
  return last || { ok: false, status: 0, error: "romePost failed" };
}

function checkoutBody(product) {
  const listingId = product.listingId;
  return {
    checkoutType: "PHYSICAL",
    cartRequest: {
      pageType: "ProductPage",
      cartContext: {
        [listingId]: {
          productId: product.pid,
          quantity: product.quantity || 1,
          cashifyDiscountApplied: false,
          vulcanDiscountApplied: false,
          payWithEMISelected: false,
          selectedActions: product.selectedActions,
          bottomSheetDisabled: false,
          primaryProductPrice: product.primaryProductPrice,
          loanAvailable: false,
          multiInsuranceOrRTOAvailable: false,
        },
      },
    },
  };
}

function viewCheckoutBody(pincode = "") {
  const pin =
    pincode === "" || pincode == null
      ? ""
      : Number.isFinite(Number(pincode))
        ? Number(pincode)
        : pincode;
  return {
    pageUri: "/viewcheckout?checkoutInitiated=true&tr_tenant=FLIPKART",
    pageContext: {
      trackingContext: { context: { eVar61: "" } },
      networkSpeed: 1500,
    },
    locationContext: { pincode: pin, changed: false },
  };
}

function paymentTokenBody() {
  return {
    actionRequestContext: {
      actionContext: {},
      isPartialPageLoadEnabled: false,
      pageNumber: 1,
      pageUri: "/viewcheckout?checkoutInitiated=true&tr_tenant=FLIPKART",
      preferredPayOptions: [],
      type: "CHECKOUT_PAYMENT_TOKEN_GENERATE",
    },
  };
}

function extractPaymentToken(json) {
  const url =
    json?.RESPONSE?.actionResponseContext?.landingPageAction?.url ||
    json?.RESPONSE?.actionResponseContext?.landingPageAction?.originalUrl ||
    "";
  const m = String(url).match(/[?&]token=([^&]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function extractCheckoutSummary(json) {
  const r = json?.RESPONSE || {};
  const summary = r.orderSummary?.checkoutSummary || {};
  const addr = r.addressData || {};
  const action = r.actionDetails?.actions?.[0] || {};
  return {
    success: !!action.success || action.action === "buy_now",
    listingId: action.listingId || null,
    grandTotal: summary.grandTotal ?? null,
    effectivePrice: summary.effectivePrice ?? null,
    pincode: addr.pincode || null,
    selectedAddressId: addr.selectedAddressId || null,
    email: r.accountInfo?.emailId || null,
  };
}

function payCodBody(token) {
  return {
    token,
    payment_instrument: "COD",
    remove_captcha_page: true,
    device_information: {
      colorDepth: 30,
      javaEnabled: false,
      javaScriptEnabled: true,
      language: "en-GB",
      screenHeight: 839,
      screenWidth: 412,
      timeDifference: -330,
    },
    device_capabilities: {
      read_sms: false,
      phonepe_sdk: false,
      juspay_sdk: false,
      nda_enabled: false,
      upi_enabled: false,
    },
    is_diff_shown_to_user: false,
  };
}

function isPaySuccess(payJson) {
  return (
    String(payJson?.response_status || "").toUpperCase() === "SUCCESS" &&
    /PAYMENT_SUCCESS/i.test(String(payJson?.response_type || ""))
  );
}

function extractOrderId(payload) {
  const s = typeof payload === "string" ? payload : JSON.stringify(payload || {});
  const m1 = s.match(/"orderId"\s*:\s*"([A-Z0-9]+)"/i);
  if (m1) return m1[1];
  const m2 = s.match(/"order_id"\s*:\s*"([A-Z0-9]+)"/i);
  if (m2) return m2[1];
  const m3 = s.match(/\bOD\d{10,}\b/);
  return m3 ? m3[0] : null;
}

/**
 * Finalize payment: POST primary_action.parameters to pgResponse (form body).
 * Without this step Flipkart never creates the order.
 */
async function completePgResponse(payJson, cookieHeader) {
  const action = payJson?.primary_action;
  if (!action?.url) {
    return { ok: false, reason: "no_pg_action", status: 0 };
  }
  const method = String(action.http_method || "POST").toUpperCase();
  const u = new URL(action.url);
  const params = action.parameters || {};
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    form.append(k, v == null ? "" : String(v));
  }
  const body = form.toString();
  const res = await requestHttp({
    hostname: u.hostname,
    path: u.pathname + u.search,
    method,
    body: method === "GET" ? null : body,
    contentType: "application/x-www-form-urlencoded",
    cookieHeader,
    origin: "https://www.flipkart.com",
    referer: "https://pay.flipkart.com/",
    timeoutMs: 60000,
  });
  const orderId = extractOrderId(res.json || res.raw);
  return {
    ok: res.status >= 200 && res.status < 400,
    status: res.status,
    orderId,
    raw: typeof res.raw === "string" ? res.raw.slice(0, 2000) : null,
    json: res.json,
    setCookie: res.setCookie,
  };
}

async function placeCodPay(token, cookieHeader) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const host of PAY_HOSTS) {
      try {
        last = await requestJson({
          hostname: host,
          path: "/fkpay/api/v3/payments/pay?instrument=COD",
          bodyObj: payCodBody(token),
          cookieHeader,
          origin: "https://pay.flipkart.com",
          referer: "https://pay.flipkart.com/",
          timeoutMs: 60000,
        });
        if (last.status === 200 && last.json) {
          if (isPaySuccess(last.json)) return last;
          // FAILED / technical error — don't treat HTTP 200 as success
          return last;
        }
      } catch (err) {
        last = { ok: false, status: 0, error: String(err.message || err), hostname: host };
      }
    }
    if (attempt < 3) await sleep(800 * attempt);
  }
  return last;
}

/**
 * Run checkout through payment-token (and optionally COD pay).
 * @param {{ dryRun?: boolean }} opts - dryRun=true (default) stops before COD pay
 */
function refreshCookies(cookieHeader, res) {
  let next = mergeCookieHeader(cookieHeader, res?.setCookie);
  next = applySessionToCookie(next, res?.json?.SESSION);
  return next;
}

async function checkoutCod(cookieHeader, product, opts = {}) {
  const dryRun = opts.dryRun !== false;
  const steps = [];
  let cookies = cookieHeader;

  if (!product?.listingId || !product?.pid) {
    throw new Error("product.pid and product.listingId required");
  }

  const checkout = await romePost(
    "/api/5/checkout?infoLevel=order_summary",
    checkoutBody(product),
    cookies
  );
  cookies = refreshCookies(cookies, checkout);
  const summary = extractCheckoutSummary(checkout.json || {});
  steps.push({ step: "checkout", status: checkout.status, summary });
  if (!checkout.ok) {
    return { ok: false, reason: "checkout_failed", dryRun, steps, checkout };
  }

  const view = await romePost(
    "/api/4/page/fetch",
    viewCheckoutBody(summary.pincode || ""),
    cookies
  );
  cookies = refreshCookies(cookies, view);
  steps.push({ step: "viewcheckout", status: view.status, ok: view.ok });

  const tokenRes = await romePost("/api/1/action/view", paymentTokenBody(), cookies);
  cookies = refreshCookies(cookies, tokenRes);
  const token = extractPaymentToken(tokenRes.json || {});
  steps.push({
    step: "payment_token",
    status: tokenRes.status,
    ok: tokenRes.ok && !!token,
    tokenPreview: token ? `${token.slice(0, 24)}…` : null,
  });
  if (!token) {
    return { ok: false, reason: "token_failed", dryRun, steps, tokenRes };
  }

  if (dryRun) {
    return {
      ok: true,
      reason: "dry_run_ready",
      dryRun: true,
      token,
      summary,
      steps,
      payPayloadPreview: payCodBody(token),
    };
  }

  const pay = await placeCodPay(token, cookies);
  const payOk = isPaySuccess(pay?.json);
  steps.push({
    step: "cod_pay",
    status: pay.status,
    ok: payOk,
    responseStatus: pay?.json?.response_status || null,
    bodyPreview:
      typeof pay.raw === "string" ? pay.raw.slice(0, 1200) : null,
  });
  if (!payOk) {
    const errMsg =
      pay?.json?.messages?.[0]?.message ||
      pay?.json?.response_status ||
      pay?.error ||
      "pay_failed";
    return {
      ok: false,
      reason: "pay_failed",
      error: errMsg,
      dryRun: false,
      token,
      summary,
      steps,
      pay,
    };
  }

  // Critical: finalize order via Rome pgResponse redirect target
  const pg = await completePgResponse(pay.json, cookies);
  cookies = refreshCookies(cookies, pg);
  steps.push({
    step: "pg_response",
    status: pg.status,
    ok: pg.ok,
    orderId: pg.orderId || null,
    bodyPreview: pg.raw,
  });

  return {
    ok: !!pg.ok,
    reason: pg.ok ? "placed" : "pg_response_failed",
    orderId: pg.orderId || null,
    dryRun: false,
    token,
    summary,
    steps,
    pay,
    pg,
  };
}

function resolveProduct(pidOrKey) {
  const known = KNOWN_PRODUCTS[pidOrKey];
  if (known) return { ...known, quantity: 1 };
  return null;
}

module.exports = {
  KNOWN_PRODUCTS,
  resolveProduct,
  cookieHeaderForAccount,
  cookiesToHeader,
  checkoutCod,
  checkoutBody,
  extractPaymentToken,
  extractCheckoutSummary,
  placeCodPay,
  completePgResponse,
  isPaySuccess,
  romePost,
};
