
const { openFlipkartMobileSession } = require("./lib/session");

async function main() {
  const wantId = process.argv[2];
  let browser;

  try {
    const session = await openFlipkartMobileSession(wantId);
    browser = session.browser;

    console.log(
      `Loaded ${session.cookieCount} cookies for ${session.accountId}`
    );

    const context = browser.contexts()[0];
    const page = context.pages()[0];

    await page.goto("https://www.flipkart.com/viewcart", {
      waitUntil: "domcontentloaded",
    });

    console.log("Cart opened.");
    console.log("Current URL:", page.url());
    console.log("Verify the intended item, quantity, and price.");
    console.log(
      "Continue to checkout manually to inspect delivery and payment options."
    );
    console.log("Only proceed if COD is explicitly offered and the details are correct.");
    console.log("Close the Incognito window to exit.");

    await new Promise((resolve) => {
      if (browser.isConnected()) {
        browser.once("disconnected", resolve);
      } else {
        resolve();
      }
    });
  } finally {
    if (browser?.isConnected()) {
      await browser.close();
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});