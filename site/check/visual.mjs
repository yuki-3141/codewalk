/**
 * 見た目と動きの検証。`npm run check:visual`（`npm run check` でビルドした後に実行する）。
 *
 * ビルド結果（dist/）をこのスクリプト内の小さな静的サーバーで配り、手元の Google Chrome を
 * DevTools Protocol で操作する（依存は増やさない。astro preview は同じプロジェクトで
 * 2つ目を起動できないため使わない）。章ごとに次を行う。
 *
 *   図の撮影   … data-figure を持つ要素をすべて、ライトとダークで撮る。「次へ」がある図は
 *                最後の段まで進めた姿も撮る。画像は site/.shots/ に出る（Git には入れない）
 *   行の強調   … 解説の段落（data-step）を1つずつ画面の中ほどへ送り、右のコードで光った行が
 *                その段落の data-start〜data-end と一致するかを確かめる
 *   エラー     … ページで起きた JS の例外と console.error を集める
 *   狭い幅     … 760px 幅で開いて、最初の画面を撮る
 *
 * 使い方：npm --prefix site run check:visual [-- 章のid か番号 ...]   （省略すると作成済みの全章とトップ）
 * Chrome の場所は環境変数 CHROME、追加の起動フラグは CHROME_FLAGS で指定できる。
 * ✗ が1つでもあれば終了コード 1。撮った画像は目で確かめる（撮るだけでは良し悪しは分からない）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";

const SITE = resolve(import.meta.dirname, "..");
const DIST = join(SITE, "dist");
const OUT = join(SITE, ".shots");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 追加の起動フラグ（例：Linux のコンテナで root のときの --no-sandbox）
const CHROME_FLAGS = (process.env.CHROME_FLAGS ?? "").split(/\s+/).filter(Boolean);

if (!existsSync(join(DIST, "meta.json"))) {
  console.error("✗ dist がありません。先に npm --prefix site run check（ビルドを含む）を実行してください");
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`✗ Chrome が見つかりません（${CHROME}）。環境変数 CHROME で場所を指定できます（例：CHROME=/usr/bin/chromium）`);
  process.exit(1);
}

const meta = JSON.parse(readFileSync(join(DIST, "meta.json"), "utf8"));
// 引数は章の id（02-parse-args）か番号（02）。top か空はトップページ。無い章は撮らずに止める
const ids = [];
for (const a of process.argv.slice(2)) {
  const hit = a === "" || a === "top" ? "" : meta.chapters.find((c) => c.id === a || c.id.startsWith(`${a}-`))?.id;
  if (hit === undefined) {
    console.error(`✗ サイトに無い章です: ${a}（作成済み：${meta.chapters.map((c) => c.id).join(" ") || "なし"}）`);
    process.exit(1);
  }
  ids.push(hit);
}
if (ids.length === 0) ids.push("", ...meta.chapters.map((c) => c.id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── 静的サーバーと Chrome を起こす ───────────────────────
// 対象のコードを配るので、この端末からだけ開けるようにする。ポートは空いているものを使う
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
let ORIGIN = "";
const server = createServer((req, res) => {
  // 別の名前（DNS の付け替え）で届いた要求には答えない
  if (req.headers.host !== ORIGIN.slice("http://".length)) return res.writeHead(403).end("forbidden");
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    return res.writeHead(400).end("bad request");
  }
  let file = join(DIST, normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!file.startsWith(DIST + sep) || !existsSync(file)) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
ORIGIN = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "codewalk-visual-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--window-size=1440,1000",
    `--user-data-dir=${profile}`,
    ...CHROME_FLAGS,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let chromeLog = "";
chrome.stderr.on("data", (d) => (chromeLog = (chromeLog + d).slice(-4000)));
const cleanup = () => {
  server.close();
  chrome.kill();
  // Chrome が終わりきる前に消そうとすると失敗することがある。残っても一時ディレクトリなので害は無い
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130));

async function waitFor(what, get) {
  for (let i = 0; i < 80; i++) {
    try {
      const v = await get();
      if (v) return v;
    } catch {}
    await sleep(250);
  }
  console.error(`✗ ${what} が起動しません`);
  if (chromeLog) console.error(`  Chrome の出力（最後の部分）:\n${chromeLog.replace(/^/gm, "    ")}`);
  console.error("  Linux のコンテナなどでは CHROME_FLAGS=--no-sandbox が要ることがあります");
  process.exit(1);
}
// 自分が起動した Chrome が書く DevToolsActivePort から、DevTools のポートを読む（ほかの Chrome につながない）
const devtoolsPort = await waitFor("Chrome", () => readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim());
const tab = (await waitFor("Chrome の DevTools", async () => (await fetch(`http://127.0.0.1:${devtoolsPort}/json`)).json())).find(
  (t) => t.type === "page",
);

// ── DevTools Protocol ─────────────────────────────────────
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const pending = new Map();
let pageErrors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result ?? m.error);
    pending.delete(m.id);
  }
  if (m.method === "Runtime.exceptionThrown")
    pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
    pageErrors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
});
const cdp = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = async (expression) =>
  (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;

async function open(id, { dark = false, width = 1440 } = {}) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await cdp("Page.navigate", { url: `${ORIGIN}/${id ? `${id}/` : ""}` });
  await sleep(1500);
  // 要素を撮るとき、貼り付いたヘッダーが上に重ならないようにする
  await js(`document.head.insertAdjacentHTML('beforeend', '<style>.site-header{position:static!important}</style>')`);
}

async function shotElement(index, name) {
  const rect = await js(`(() => {
    const el = document.querySelectorAll('[data-figure]')[${index}];
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
  })()`);
  await sleep(500);
  const res = await cdp("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 }, captureBeyondViewport: true });
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(res.data, "base64"));
  return file;
}

await cdp("Runtime.enable");
await cdp("Page.enable");

const errors = [];
const shots = [];
const summary = [];

for (const id of ids) {
  const label = id || "top";
  let stepsChecked = 0;

  for (const dark of [false, true]) {
    pageErrors = [];
    await open(id, { dark });
    const figures = await js(`[...document.querySelectorAll('[data-figure]')].map((el) => el.dataset.figure)`);
    const theme = dark ? "dark" : "light";
    for (const [i, name] of figures.entries()) {
      shots.push(await shotElement(i, `${label}--${String(i + 1).padStart(2, "0")}-${name}--${theme}`));
      // 「次へ」のある図は最後の段まで進めて、もう1枚
      const hasNext = await js(`!!document.querySelectorAll('[data-figure]')[${i}].querySelector('[data-act="next"]')`);
      if (hasNext) {
        await js(`(async () => {
          const next = document.querySelectorAll('[data-figure]')[${i}].querySelector('[data-act="next"]');
          for (let n = 0; n < 30 && !next.disabled; n++) { next.click(); await new Promise((r) => setTimeout(r, 120)); }
        })()`);
        await sleep(1600);
        shots.push(await shotElement(i, `${label}--${String(i + 1).padStart(2, "0")}-${name}--${theme}-end`));
      }
    }

    // 行の強調はライトのときだけ確かめる（テーマに依らない）
    if (!dark) {
      const count = await js(`document.querySelectorAll('[data-step]').length`);
      for (let s = 0; s < count; s++) {
        await js(`document.querySelectorAll('[data-step]')[${s}].scrollIntoView({ block: 'center' })`);
        await sleep(450);
        const r = await js(`(() => {
          const step = document.querySelectorAll('[data-step]')[${s}];
          const pane = step.closest('[data-walkthrough]');
          const title = step.querySelector('h3')?.textContent;
          if (!pane) return { title, outside: true };
          const lit = [...pane.querySelectorAll('.line.hl')].map((l) => Number(l.dataset.line));
          return { title, start: Number(step.dataset.start), end: Number(step.dataset.end), lit };
        })()`);
        if (r.outside) {
          errors.push(`${label}: 段落「${r.title}」が Walkthrough の外にあります（Step は Walkthrough の中に置く）`);
          continue;
        }
        const want = r.end - r.start + 1;
        if (r.lit.length !== want || r.lit[0] !== r.start || r.lit.at(-1) !== r.end)
          errors.push(`${label}: 段落「${r.title}」で光った行が違う（期待 ${r.start}–${r.end} / 実際 ${r.lit[0] ?? "-"}–${r.lit.at(-1) ?? "-"}）`);
        stepsChecked++;
      }
    }
    for (const e of pageErrors) errors.push(`${label}（${theme}）: JS のエラー: ${e}`);
    if (!dark) summary.push(`${label}: 図 ${figures.length} 個 / 段落 ${stepsChecked} 個`);
  }

  await open(id, { width: 760 });
  const res = await cdp("Page.captureScreenshot", { format: "png" });
  const narrow = join(OUT, `${label}--narrow.png`);
  writeFileSync(narrow, Buffer.from(res.data, "base64"));
  shots.push(narrow);
}

ws.close();
for (const s of summary) console.log(`  ${s}`);
console.log(`撮影 ${shots.length} 枚 → ${OUT}`);
if (errors.length) {
  for (const e of errors) console.log(`✗ ${e}`);
  process.exit(1);
}
console.log("✓ 行の強調・JS のエラーとも問題なし（画像は目で確かめること）");
process.exit(0);
