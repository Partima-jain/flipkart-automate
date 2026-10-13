const { openFlipkartMobileSession } = require("./lib/session");

async function main() {
  const wantId = process.argv[2];
  const { browser, accountId, cookieCount } = await openFlipkartMobileSession(wantId);

  console.log(`Loading ${cookieCount} cookies for ${accountId}`);
  console.log("If you see Login instead of your account, refresh cookies in cookie.json.");
  console.log("Close the Incognito window to exit.");

  await new Promise((resolve) => {
    browser.on("disconnected", resolve);
  });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
