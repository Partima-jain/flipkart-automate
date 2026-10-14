# Flipkart automate

## Place orders (Chrome / mobile)

```bash
npm run accounts          # buy flow per account
npm run accounts:fast     # --concurrency=3
npm run browse            # open My Orders in desktop Chrome, next on close
npm start                 # open one account logged in
```

## Order report (fast API)

```bash
npm run orders            # Rome API + cookies → order-report.json/.xlsx
npm run orders:retry      # re-fetch failed / missing tracking
npm run orders:enrich     # only accounts that already have orders
npm run orders:excel      # rebuild Excel from JSON
npm run orders:browser    # old Chrome scrape path
```

Cookies: `cookie.json` or `--cookie-file=cookies-files/...`
