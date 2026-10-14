# Flipkart automate

## Place orders

```bash
npm run accounts:api:place   # API: 3 phone COD each account (no tab)
npm run accounts:api         # dry-run (token only, no order)
npm run accounts             # Chrome buy flow
npm run accounts:fast        # Chrome, --concurrency=3
npm run browse               # My Orders in desktop Chrome
npm start                    # open one account logged in
```

## Order report

```bash
npm run orders:api           # Rome API → order-report.json/.xlsx
npm run orders               # same as orders:api
npm run orders:retry         # re-fetch failed / missing tracking
npm run orders:enrich        # only accounts that already have orders
npm run orders:excel         # rebuild Excel from JSON
npm run orders:browser       # Chrome scrape path
```

Cookies: `cookie.json` or `--cookie-file=cookies-files/...`
