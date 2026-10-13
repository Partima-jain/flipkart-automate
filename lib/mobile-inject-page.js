/**
 * On-device cookie inject (learning demo).
 *
 * A random webpage CANNOT set cookies for flipkart.com (browser same-origin rules).
 * A bookmarklet CAN, because it runs while you are already on flipkart.com.
 *
 * Flow: save short bookmarklet → open Flipkart → tap bookmarklet → paste YOUR cookie string.
 */

const BOOKMARKLET = `javascript:(function(){try{var d=location.hostname;if(d.indexOf('flipkart.com')===-1){alert('Open www.flipkart.com first, then tap this bookmark again.');return;}var raw=prompt('Paste your Flipkart cookie string (name=value; ...)');if(!raw)return;var n=0;raw.split(';').forEach(function(part){part=part.trim();if(!part)return;var i=part.indexOf('=');if(i<1)return;var name=part.slice(0,i).trim();var value=part.slice(i+1).trim();if(!name)return;document.cookie=name+'='+value+'; path=/; domain=.flipkart.com; Secure; SameSite=Lax';n++;});alert('Set '+n+' cookies on this device. Reloading…');location.href='https://www.flipkart.com/';}catch(e){alert('Failed: '+e);}})();`;

function mobileInjectHtml() {
  const safeHref = BOOKMARKLET.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>On-device cookie inject (learning)</title>
  <style>
    :root {
      --bg: #0f1419;
      --card: #1a2332;
      --text: #e7ecf3;
      --muted: #9aa8bc;
      --accent: #f8e16c;
      --ok: #6bcB77;
      --warn: #f0a060;
      --line: #2a3548;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", system-ui, sans-serif;
      background:
        radial-gradient(ellipse 80% 50% at 50% -20%, #243552 0%, transparent 55%),
        var(--bg);
      color: var(--text);
      padding: 20px 16px 40px;
    }
    main {
      width: min(520px, 100%);
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 24px 20px;
    }
    h1 { font-size: 1.2rem; margin: 0 0 8px; }
    h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 22px 0 10px; }
    p, li { color: var(--muted); line-height: 1.5; font-size: 0.95rem; }
    ol { padding-left: 1.2rem; margin: 0; }
    li { margin-bottom: 10px; color: var(--text); }
    .warn {
      background: rgba(240, 160, 96, 0.12);
      border: 1px solid rgba(240, 160, 96, 0.35);
      color: var(--warn);
      border-radius: 10px;
      padding: 12px 14px;
      font-size: 0.9rem;
      margin: 14px 0;
    }
    .ok { color: var(--ok); }
    a.bookmarklet {
      display: block;
      text-align: center;
      margin: 14px 0;
      padding: 14px 16px;
      background: var(--accent);
      color: #1a1a1a;
      text-decoration: none;
      border-radius: 12px;
      font-weight: 700;
      font-size: 1rem;
    }
    .hint { font-size: 0.85rem; color: var(--muted); }
    textarea {
      width: 100%;
      min-height: 120px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: #0f1419;
      color: var(--text);
      padding: 12px;
      font-family: ui-monospace, Menlo, monospace;
      font-size: 0.75rem;
      resize: vertical;
    }
    button.copy {
      margin-top: 10px;
      width: 100%;
      padding: 12px;
      border: 0;
      border-radius: 10px;
      background: #2a3548;
      color: var(--text);
      font-weight: 650;
      font-size: 0.95rem;
    }
    .nav { margin-top: 18px; font-size: 0.9rem; }
    .nav a { color: var(--accent); }
  </style>
</head>
<body>
  <main>
    <h1>Test login on THIS phone</h1>
    <p>A normal webpage cannot log you into Flipkart. A <strong>bookmarklet</strong> can, because it runs <em>on</em> flipkart.com and sets cookies only in this browser.</p>

    <div class="warn">
      Use only your own account cookies. Never share this bookmark or pasted cookies — they are full account access.
    </div>

    <h2>Step 1 — Save the tool (once)</h2>
    <p class="hint"><strong>Android Chrome:</strong> tap-and-hold the yellow button → “Bookmark” / star it. Or copy the code below and create a bookmark whose URL is that code.</p>
    <p class="hint"><strong>iPhone Safari:</strong> bookmark this page first → Bookmarks → Edit → change the bookmark URL to the copied javascript code → rename to “FK Inject”.</p>

    <a class="bookmarklet" href="${safeHref}">FK Cookie Inject</a>
    <p class="hint">If the button just navigates away, your browser blocked javascript: links. Use the copy method below.</p>

    <textarea id="code" readonly>${BOOKMARKLET.replace(/</g, "&lt;")}</textarea>
    <button class="copy" type="button" id="copyBtn">Copy bookmarklet code</button>

    <h2>Step 2 — Use it on Flipkart</h2>
    <ol>
      <li>Open <span class="ok">https://www.flipkart.com</span> in this same browser.</li>
      <li>Tap your <strong>FK Cookie Inject</strong> bookmark.</li>
      <li>Paste the cookie string from <code>cookie.json</code> → <code>ids[0].cookie</code> (the long <code>name=value; …</code> part only).</li>
      <li>Page reloads — check if your account is logged in.</li>
    </ol>

    <h2>Why this works (learning)</h2>
    <ol>
      <li>Browsers only allow cookie writes for the <em>current</em> site.</li>
      <li>So the script must run while you are on flipkart.com.</li>
      <li>Cookies are pasted at use-time (prompt) so the bookmark stays short and stays on your device.</li>
      <li>JS-set cookies are not HttpOnly; many sites still accept them for testing. If Flipkart rejects them, the server-side Playwright method is more reliable.</li>
    </ol>

    <div class="nav">
      <a href="/">← QR demo (opens session on PC)</a>
    </div>
  </main>
  <script>
    document.getElementById("copyBtn").addEventListener("click", async function () {
      var text = document.getElementById("code").value;
      try {
        await navigator.clipboard.writeText(text);
        this.textContent = "Copied ✓";
      } catch (e) {
        document.getElementById("code").select();
        document.execCommand("copy");
        this.textContent = "Copied ✓";
      }
    });
  </script>
</body>
</html>`;
}

module.exports = { mobileInjectHtml, BOOKMARKLET };
