/**
 * サイトの検証。`npm run check`（ビルドの後に実行される）。
 *
 * ビルドそのものが、アンカー（コードの位置）と章立ての読み取りを検査している。
 * ここではビルド結果に対して、次を照合する。
 *
 *   リンク        … 内部リンクと #見出し が実在するか
 *   判断の ID     … 本文と図に書いた ID（ADR-0003 など）が、判断の記録にあるか（設定の decisions があるときだけ）
 *   コード        … 表示したコードが、基準コミットのファイルと1行も違わないか
 *   章とメモ      … 事実メモの `##` を covers がすべて扱っているか（done の章は必須）、files が章立てと同じか
 *   メモの鮮度    … 書き起こした後に、事実メモが変わっていないか（workspace/ の Git の履歴で見る）
 *   中身の置き場所 … 利用者の中身や生成物がキットの Git に入っていないか、workspace/ の push の守り
 *
 * ✗ が1つでもあれば終了コード 1。! は要確認の知らせで、失敗にはしない。
 * 出すコマンドは、キットのルートで実行する形にする。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decisionIds, gitShow, loadConfig, loadPlan, memoHeadings, splitLines, workspaceDir } from "./config.mjs";
import { HOOK_SOURCE, hookTarget } from "./hooks.mjs";

const SITE = resolve(import.meta.dirname, "..");
const DIST = join(SITE, "dist");
const ROOT = resolve(SITE, "..");
const WS = workspaceDir(ROOT);
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const fail = (msg) => {
  console.log(`✗ ${msg}`);
  process.exit(1);
};

// ── 中身がキットの Git に入っていないか（設定の有無に関わらず最初に見る） ──
// workspace/ は対象のコードの断片を、site/dist と site/.shots は対象のファイルの全文を含む
let kitIsGit = true;
try {
  git(ROOT, "rev-parse", "--is-inside-work-tree");
} catch {
  kitIsGit = false;
}
if (kitIsGit) {
  const PRIVATE = ["workspace", "site/dist", "site/.shots", "site/.astro"];
  const tracked = git(ROOT, "ls-files", "--", ...PRIVATE).trim();
  if (tracked) {
    console.log("✗ 対象のコードを含むもの（workspace/ や site/dist など）が、キットの Git に追跡されています。公開すると漏れます");
    console.log(`    ${tracked.split("\n").slice(0, 5).join("\n    ")}`);
    fail(`外すには：git rm -r -f --cached ${PRIVATE.join(" ")}（ファイルは消えません）`);
  }
}

let config;
try {
  config = loadConfig(ROOT);
} catch (e) {
  fail(e.message);
}
if (!config) {
  console.log("! workspace/codewalk.config.json がまだありません。/codewalk <パス> で始めます（ビルドだけ確かめました）");
  process.exit(0);
}
if (!existsSync(join(DIST, "meta.json"))) fail("site/dist がありません。npm --prefix site run check で、ビルドから実行してください");
const meta = JSON.parse(readFileSync(join(DIST, "meta.json"), "utf8"));
const plan = loadPlan(ROOT);

const errors = [];
const notes = [];
// Shiki は < を &#x3C; のような数値参照で書くので、名前付きと数値の両方を戻す
const NAMED = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, ref) =>
    ref[0] === "#"
      ? String.fromCodePoint(ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1)))
      : (NAMED[ref] ?? all),
  );

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? htmlFiles(join(dir, d.name)) : d.name.endsWith(".html") ? [join(dir, d.name)] : [],
  );
}
const pages = new Map(htmlFiles(DIST).map((f) => [f, readFileSync(f, "utf8")]));
const urlOf = (file) => "/" + file.slice(DIST.length + 1).replace(/index\.html$/, "");

// ── リンク ─────────────────────────────────────────────
let linkCount = 0;
const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
for (const [file, raw] of pages) {
  const here = urlOf(file);
  // 図の中で JS が組み立てるリンク（データの JSON 内の "/NN-slug/"）は、JSON の中だけから拾う
  const json = [...raw.matchAll(/<script\b[^>]*application\/json[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  // スクリプトの中のテンプレート（href="${…}"）はリンクではないので除く
  const html = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  const hrefs = new Set([
    ...[...html.matchAll(/\shref="([^"]+)"/g)].map((m) => decode(m[1])),
    ...[...json.matchAll(/"(\/\d{2}-[a-z0-9-]+\/(?:#[^"]*)?)"/g)].map((m) => m[1]),
  ]);
  for (const href of hrefs) {
    if (/^(https?:|mailto:|data:)/.test(href) || href.startsWith("/_astro/")) continue;
    linkCount++;
    // 相対リンクは、そのページの URL から解決する（ブラウザと同じ）
    const url = new URL(href, `http://site${here}`);
    const path = decodeURIComponent(url.pathname);
    const target = join(DIST, path.endsWith("/") ? `${path}index.html` : path);
    if (!existsSync(target)) {
      errors.push(`リンク切れ: ${here} → ${href}`);
      continue;
    }
    const hash = decodeURIComponent(url.hash.slice(1));
    if (hash && target.endsWith(".html") && !ids(pages.get(target) ?? "").has(hash)) errors.push(`見出しが無い: ${here} → ${href}`);
  }
}

// ── 判断の ID ───────────────────────────────────────────
let known = null;
try {
  known = decisionIds(config);
} catch (e) {
  errors.push(e.message);
}
const used = new Map();
if (known) {
  const sources = [join(WS, "chapters"), join(WS, "diagrams"), join(SITE, "src", "diagrams")].flatMap((d) =>
    existsSync(d)
      ? readdirSync(d)
          .filter((f) => /\.(mdx|astro)$/.test(f))
          .map((f) => join(d, f))
      : [],
  );
  for (const f of sources)
    for (const m of readFileSync(f, "utf8").matchAll(config.decisions.token)) used.set(m[0], f.slice(ROOT.length + 1));
  for (const [d, where] of used) if (!known.has(d)) errors.push(`${d} が ${config.decisions.path} にありません（${where}）`);
}

// ── コード ─────────────────────────────────────────────
// 左のコード欄（data-code-pane）だけを照合する。Step も data-file を持つので取り違えない
let codeLines = 0;
for (const [file, html] of pages) {
  for (const pane of html.matchAll(/data-code-pane data-file="([^"]+)"[\s\S]*?<code>([\s\S]*?)<\/code>/g)) {
    const path = decode(pane[1]);
    const expected = splitLines(gitShow(config, path));
    const shown = [...pane[2].matchAll(/<span class="line" data-line="(\d+)">([\s\S]*?)<\/span>(?=<span class="line"|$)/g)];
    if (shown.length !== expected.length)
      errors.push(`コードの行数が違う: ${urlOf(file)} ${path}（表示 ${shown.length} / 実物 ${expected.length}）`);
    for (const [, n, body] of shown) {
      codeLines++;
      const text = decode(body.replace(/<[^>]+>/g, ""));
      if (text !== expected[Number(n) - 1]) errors.push(`コードが違う: ${path}:${n}`);
    }
  }
}

// ── 章とメモ・メモの鮮度 ──────────────────────────────
const wsIsGit = existsSync(join(WS, ".git"));
const coverage = [];
for (const ch of meta.chapters) {
  const planned = plan?.chapters.find((c) => c.id === ch.id);
  if (planned) {
    const want = [...planned.files].sort().join(", ");
    const have = [...ch.files].sort().join(", ");
    if (want !== have) errors.push(`${ch.id}: frontmatter の files が章立ての「読むコード」と違います（章: ${have || "なし"} / 章立て: ${want || "なし"}）`);
  }
  const headings = memoHeadings(ROOT, ch.id);
  if (!headings) {
    errors.push(`${ch.id}: 事実メモ workspace/notes/${ch.id}.md がありません（サイトの章はメモから作ります）`);
    continue;
  }
  const covered = headings.filter((h) => h in ch.covers);
  const missing = headings.filter((h) => !(h in ch.covers));
  const extra = Object.keys(ch.covers).filter((k) => !headings.includes(k));
  coverage.push(`${ch.id}  ${ch.status === "done" ? "完成" : "書きかけ"}  メモの見出し ${covered.length}/${headings.length}`);
  for (const k of extra) errors.push(`${ch.id}: covers の「${k}」がメモにありません（見出しが変わった？）`);
  if (ch.status === "done") for (const h of missing) errors.push(`${ch.id}: メモの「${h}」を扱っていません`);

  if (!wsIsGit) continue;
  const memo = `notes/${ch.id}.md`;
  let changed = "";
  try {
    changed = git(WS, "log", "--format=%h %s", `${ch.basedOn}..HEAD`, "--", memo).trim();
  } catch {
    errors.push(`${ch.id}: basedOn ${ch.basedOn} が workspace/ の Git にありません`);
  }
  if (changed)
    notes.push(
      `${ch.id}: 書き起こした後（${ch.basedOn}）にメモが変わっています — 要見直し（差分：git -C workspace diff ${ch.basedOn} -- ${memo}）\n      ${changed.replace(/\n/g, "\n      ")}`,
    );
  if (git(WS, "status", "--porcelain", "--", memo).trim()) notes.push(`${ch.id}: メモに未コミットの変更があります`);
}

// ── workspace/ の Git と push の守り ──────────────────
if (!wsIsGit) {
  if (meta.chapters.length) errors.push("workspace/ が Git のリポジトリではありません（git -C workspace init -b main）");
} else {
  // URL に埋め込まれた認証情報（https://user:token@…）は伏せる。出力は Claude Code の会話にも残る
  const remotes = git(WS, "remote", "-v").trim().replace(/(https?:\/\/)[^@/\s]+@/gi, "$1***@");
  const hook = hookTarget(WS);
  const installed = existsSync(hook) && readFileSync(hook, "utf8") === readFileSync(HOOK_SOURCE, "utf8");
  if (!installed) {
    const msg = "workspace/ に push の守り（pre-push フック）が入っていない、または古いままです。npm --prefix site run hooks で入れます";
    if (remotes) errors.push(msg);
    else notes.push(msg);
  }
  if (remotes)
    notes.push(
      `workspace/ にリモートがあります。push 先が公開リポジトリなら、pre-push フックが止めます\n      ${remotes.split("\n")[0]}`,
    );
}

// ── 結果 ───────────────────────────────────────────────
const line = (ok, s) => console.log(`${ok ? "✓" : "✗"} ${s}`);
console.log(`基準コミット ${config.short} / ページ ${pages.size}`);
line(!errors.some((e) => e.startsWith("リンク") || e.startsWith("見出しが無い")), `リンク ${linkCount} 本`);
if (known)
  line(!errors.some((e) => e.includes(config.decisions.path)), `判断の ID ${used.size} 個（${[...used.keys()].sort().join(" ") || "なし"}）`);
line(!errors.some((e) => e.startsWith("コード")), `コード ${codeLines} 行を基準コミットと照合`);
console.log("  見出しの対応");
for (const c of coverage) console.log(`    ${c}`);
for (const n of notes) console.log(`! ${n}`);
if (errors.length) {
  console.log("");
  for (const e of errors) console.log(`✗ ${e}`);
  process.exit(1);
}
console.log("\nすべて通りました。");
