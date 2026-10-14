/**
 * Direct Flipkart Rome page/fetch API client (cookie-auth, no Chrome).
 * Prefer 1.rome.api.flipkart.com; sticky host + keep-alive + retries for DNS blips.
 */

const https = require("https");
const { loadCookiesFromFile } = require("./session");

const ROME_HOSTS = [
  "1.rome.api.flipkart.com",
  "2.rome.api.flipkart.com",
  // bare rome.* often 406 or flaky DNS under load — last resort only
  "rome.api.flipkart.com",
];

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const X_USER_AGENT = `${MOBILE_UA} FKUA/msite/0.0.1/msite/Mobile`;

/** Sticky working host (avoids hammering bad DNS under concurrency). */
let preferredHost = ROME_HOSTS[0];

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: 30000,
});

function cookiesToHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function emptyPageContext() {
  return {
    pageHashKey: null,
    slotContextMap: null,
    paginationContextMap: null,
    paginatedFetch: false,
    pageNumber: 1,
    fetchAllPages: false,
    networkSpeed: 0,
    trackingContext: null,
    fetchSeoData: false,
  };
}

function myOrdersBody() {
  return {
    requestContext: {
      type: "MY_ORDER_PAGE",
      pageView: "",
      queryTime: "",
      cxTenant: "cs",
      pageName: "",
      pageNumber: 1,
      salesAppFilter: "FLIPKART,SLAP,MINUTES,SUPERMONEY",
    },
    pageType: "MY_ORDER_PAGE",
    pageUri: "/cx/my_orders",
    pageContext: emptyPageContext(),
    locationContext: { pincode: "" },
  };
}

function orderDetailBody(orderId, unitId) {
  return {
    requestContext: {
      type: "CX_ORDER_DETAIL_PAGE",
      orderId,
      unitId: unitId || "",
      pageView: "",
      businessCategory: "",
      oAndI: false,
    },
    pageType: "CX_ORDER_DETAIL_PAGE",
    pageUri: "/cx/order_detail",
    pageContext: emptyPageContext(),
    locationContext: { pincode: "" },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientNetError(err) {
  const code = err?.code || "";
  const msg = String(err?.message || err || "");
  return (
    /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|timeout/i.test(
      `${code} ${msg}`
    )
  );
}

function postJson(host, bodyObj, cookieHeader, { timeoutMs = 25000 } = {}) {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        path: "/api/4/page/fetch",
        method: "POST",
        agent,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          accept: "*/*",
          "user-agent": MOBILE_UA,
          "x-user-agent": X_USER_AGENT,
          referer: "https://www.flipkart.com/",
          origin: "https://www.flipkart.com",
          "x-flipkart-client": "self-serve",
          flipkart_secure: "true",
          cookie: cookieHeader,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (_) {
            /* ignore */
          }
          resolve({
            host,
            status: res.statusCode,
            raw,
            json,
            ok: res.statusCode === 200 && !!json,
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Rome API timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function hostOrder() {
  // Try sticky host first, then the rest
  const rest = ROME_HOSTS.filter((h) => h !== preferredHost);
  return [preferredHost, ...rest];
}

/**
 * Try Rome hosts until one returns HTTP 200 JSON.
 * Retries transient DNS/network errors with backoff.
 */
async function romeFetch(bodyObj, cookieHeader, opts = {}) {
  const maxAttempts = opts.retries ?? 4;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const host of hostOrder()) {
      try {
        const res = await postJson(host, bodyObj, cookieHeader, opts);
        if (res.ok) {
          preferredHost = host;
          return res;
        }
        lastErr = new Error(`${host} → HTTP ${res.status}`);
        // 406 DC mismatch — try next host (don't burn retries)
        if (res.status === 406) continue;
        // Other HTTP errors: try next host
      } catch (err) {
        lastErr = err;
        if (!isTransientNetError(err)) {
          // Non-transient on this host — try next host
          continue;
        }
      }
    }
    if (attempt < maxAttempts) {
      await sleep(200 * attempt + Math.floor(Math.random() * 200));
    }
  }
  throw lastErr || new Error("Rome API failed on all hosts");
}

async function fetchMyOrdersJson(cookieHeader, opts) {
  return romeFetch(myOrdersBody(), cookieHeader, opts);
}

async function fetchOrderDetailJson(cookieHeader, orderId, unitId, opts) {
  return romeFetch(orderDetailBody(orderId, unitId), cookieHeader, opts);
}

function cookieHeaderForAccount(accountId, { cookieFile } = {}) {
  const { cookies } = loadCookiesFromFile(accountId, { cookieFile });
  return cookiesToHeader(cookies);
}

module.exports = {
  ROME_HOSTS,
  cookiesToHeader,
  cookieHeaderForAccount,
  fetchMyOrdersJson,
  fetchOrderDetailJson,
  romeFetch,
  myOrdersBody,
  orderDetailBody,
};
