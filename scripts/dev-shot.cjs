// A screenshot of the web client of scripts/dev.sh, signed in as one of its people, against the real server:
// what app/screens.test.tsx can't show (real data, real timing). Uses the Playwright and Chromium of the
// machine (Claude Code cloud sessions have both).
//
//   node scripts/dev-shot.cjs out.png                     张伟, 1280×800
//   node scripts/dev-shot.cjs --as wl --size 390x844 out.png
//   node scripts/dev-shot.cjs --lang zh out.png            in Chinese
//   node scripts/dev-shot.cjs --click 70,105 out.png      click points (x,y) first, 1.5 s apart
//
// DEV_PORT as for dev.sh. The session comes from .dev/state.json, put where the web app keeps it.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(require("node:child_process").execSync("npm root -g").toString().trim() + "/playwright"); }

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const who = opt("--as", "zw");
const [width, height] = opt("--size", "1280x800").split("x").map(Number);
const wait = Number(opt("--wait", "5000"));
const lang = opt("--lang", ""); // zh | en: the app's language (default: the browser's)
const clicks = [];
for (let c; (c = opt("--click", null));) clicks.push(c.split(",").map(Number));
const out = args[0] || "dev-shot.png";

const state = JSON.parse(readFileSync(join(__dirname, "..", ".dev", "state.json"), "utf8"));
const url = `http://127.0.0.1:${process.env.DEV_PORT || 8080}`;
const id = JSON.parse(readFileSync(join(__dirname, "..", "app", "nsh.json"), "utf8")).id;

(async () => {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript(([id, url, session, lang]) => {
    localStorage.setItem(`nsh:${id}:team.url`, url);
    localStorage.setItem(`nsh:${id}:team.session`, session);
    if (lang) localStorage.setItem(`nsh:${id}:hub.lang`, lang);
  }, [id, url, state[who], lang]);
  await page.goto(url);
  await page.waitForTimeout(wait);
  for (const [x, y] of clicks) { await page.mouse.click(x, y); await page.waitForTimeout(1500); }
  await page.screenshot({ path: out });
  await browser.close();
  console.log(`dev-shot: ${out}`);
})();
