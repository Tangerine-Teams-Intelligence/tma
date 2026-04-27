import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const ROUTES = [
  ["auth", "/auth"],
  ["today", "/today"],
  ["memory", "/memory"],
  ["co-thinker", "/co-thinker"],
  ["canvas", "/canvas"],
  ["reviews", "/reviews"],
  ["marketplace", "/marketplace"],
  ["sources-discord", "/sources/discord"],
  ["settings", "/settings"],
];

const OUT = path.resolve("./_dogfood_screenshots");
await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 840 } });

// Inject stub session before any page script runs (bypass auth gate in STUB mode).
// Matches the key/shape used in app/src/lib/auth.ts.
await ctx.addInitScript(() => {
  try {
    window.localStorage.setItem(
      "tangerine.auth.stubSession",
      JSON.stringify({ email: "ceo@tangerineintelligence.ai", signedInAt: Date.now() })
    );
  } catch {}
});

const results = [];
for (const [name, route] of ROUTES) {
  const page = await ctx.newPage();
  const consoleErrs = [];
  const pageErrs = [];
  const failedReqs = [];
  page.on("console", m => {
    if (m.type() === "error" || m.type() === "warning") {
      consoleErrs.push(`[${m.type()}] ${m.text()}`);
    }
  });
  page.on("pageerror", e => pageErrs.push(String(e.message || e)));
  page.on("requestfailed", r => failedReqs.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));

  let loadOk = false, status = null, bodyText = "", bodyLen = 0;
  try {
    const resp = await page.goto(`http://localhost:1420${route}`, { waitUntil: "networkidle", timeout: 20000 });
    status = resp ? resp.status() : null;
    await page.waitForTimeout(1500);
    loadOk = true;
    bodyText = await page.evaluate(() => document.body?.innerText || "");
    bodyLen = bodyText.length;
  } catch (e) {
    pageErrs.push(`NAV: ${e.message}`);
  }

  try {
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  } catch (e) {
    pageErrs.push(`SS: ${e.message}`);
  }

  results.push({
    route, name, loadOk, status, bodyLen,
    bodySnippet: bodyText.slice(0, 200).replace(/\s+/g, " "),
    consoleErrs: consoleErrs.slice(0, 8),
    pageErrs: pageErrs.slice(0, 8),
    failedReqs: failedReqs.slice(0, 8),
  });
  await page.close();
}

await browser.close();
await fs.writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
