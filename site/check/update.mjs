/**
 * 基準コミットを上げる前に、変わり方を測る。`npm --prefix site run check:update [-- <コミット>]`。
 *
 * /codewalk-update が、追従（変わった章だけ直す）か作り直し（章立てから）かを決める材料にする。
 * コミットを省くと、対象の origin/HEAD、無ければ HEAD。対象のリポジトリでは fetch しない
 * （新しいコミットを取り込むのは利用者。git -C <repo> pull）。
 *
 *   範囲   … 「読むコード」のうち、変わった・消えた・名前が変わったもの。同じ場所に増えたファイル
 *   章ごと … 「読むコード」と、メモの根拠（code・doc）が指すファイルのうち、変わったもの
 *   目安   … 追従か作り直しか、と理由。決めるのは /codewalk-update
 *
 * 書き換えはしない。✗ は設定・章立て・コミットが読めないときだけ。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { gitShow, loadConfig, loadPlan, readText, splitLines, workspaceDir } from "./config.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const stop = (msg) => {
  console.log(`✗ ${msg}`);
  process.exit(1);
};

let config;
let plan;
try {
  config = loadConfig(ROOT);
  plan = loadPlan(ROOT);
} catch (e) {
  stop(e.message);
}
if (!config) stop("workspace/codewalk.config.json がありません。/codewalk <パス> で始めます");
if (!plan) stop("workspace/notes/plan.md がありません。/codewalk <パス> で始めます");

const git = (...args) =>
  execFileSync("git", ["-C", config.repo, "-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
const tryGit = (...args) => {
  try {
    return git(...args).trim();
  } catch {
    return null;
  }
};

// ── 新しいコミットを決める ─────────────────────────────
const arg = process.argv[2];
if (arg?.startsWith("-")) stop(`コミットの指定が読めません: ${arg}`);
const target = arg
  ? tryGit("rev-parse", "--verify", "--quiet", `${arg}^{commit}`)
  : (tryGit("rev-parse", "--verify", "--quiet", "origin/HEAD^{commit}") ?? tryGit("rev-parse", "--verify", "--quiet", "HEAD^{commit}"));
if (!target) stop(arg ? `${config.repo} にコミット ${arg} がありません（新しいコミットは git -C <repo> pull で取り込む）` : `${config.repo} の HEAD が読めません`);

const old = config.commit;
const describe = (c) => tryGit("log", "-1", "--format=%h  %cs  %s", c);
console.log(`基準コミット   ${describe(old) ?? `${old.slice(0, 7)}（対象のリポジトリにありません）`}`);
console.log(`新しいコミット ${describe(target)}`);
console.log(`  ${target}${arg ? "" : "（引数なし：origin/HEAD、無ければ HEAD）"}`);
// 手元でコミットを進めている（まだ push していない・別のブランチにいる）と、HEAD が origin/HEAD と違う
const head = arg ? null : tryGit("rev-parse", "--verify", "--quiet", "HEAD^{commit}");
if (head && head !== target)
  console.log(`! 手元の HEAD（${describe(head)}）は origin/HEAD と違います。HEAD に合わせるなら、引数に HEAD を渡します`);
if (target === old) {
  console.log("\n基準コミットと同じです。上げるものはありません");
  process.exit(0);
}
if (tryGit("cat-file", "-e", `${old}^{commit}`) === null) {
  console.log("\n! 基準コミットが対象のリポジトリにありません（履歴が書き換えられた？）。差分が取れません");
  console.log("\n目安: 作り直し（章立てから）\n  - 基準コミットとの差分が取れない");
  process.exit(0);
}
const forward = tryGit("merge-base", "--is-ancestor", old, target) !== null;
if (forward) console.log(`  あいだのコミット ${tryGit("rev-list", "--count", `${old}..${target}`)} 件`);
else console.log("! 新しいコミットは基準コミットの子孫ではありません（別のブランチ・履歴の書き換え）。メモの commit の根拠が祖先から外れることがあります");

// ── 差分 ───────────────────────────────────────────────
// 対象の .git/config に仕込まれた変換のコマンドを走らせないよう、--no-textconv --no-ext-diff を付ける
const diff = (...opts) => git("diff", "--no-textconv", "--no-ext-diff", "-M", ...opts, "-z", old, target).split("\0");

/**
 * 変わったファイル。キーは基準コミットの側のパス（足されたものは新しい側）。
 * コピー（C）は元のファイルが残るので、元のファイル自身の変更と取り違えないよう、コピー先をキーにする
 */
const entries = new Map();
const ns = diff("--name-status");
for (let i = 0; i < ns.length; ) {
  const status = ns[i++];
  if (!status) continue;
  const from = ns[i++];
  const to = status[0] === "R" || status[0] === "C" ? ns[i++] : from;
  entries.set(status[0] === "C" ? to : from, { status: status[0], from, to, add: 0, del: 0 });
}
const byTo = new Map([...entries.values()].map((e) => [e.to, e]));
const num = diff("--numstat");
for (let i = 0; i < num.length; ) {
  const head = num[i++];
  if (!head) continue;
  const [a, d, path] = head.split("\t");
  // 名前が変わったものは、パスの欄が空で、続く2つが元と先
  const to = path === "" ? (i++, num[i++]) : path;
  const e = byTo.get(to);
  if (e) {
    e.add = a === "-" ? 0 : Number(a);
    e.del = d === "-" ? 0 : Number(d);
  }
}

const show = (e) =>
  e.status === "D"
    ? `${e.from}（消えた）`
    : e.status === "R"
      ? `${e.from} → ${e.to}（名前が変わった${e.add + e.del ? ` +${e.add} −${e.del}` : ""}）`
      : `${e.from}（+${e.add} −${e.del}）`;

// ── 範囲 ───────────────────────────────────────────────
const planFiles = [...new Set(plan.chapters.flatMap((c) => c.files))];
const scopeLines = planFiles.reduce((n, f) => n + splitLines(gitShow(config, f)).length, 0);
const changed = planFiles.map((f) => entries.get(f)).filter(Boolean);
const gone = changed.filter((e) => e.status === "D" || e.status === "R");
const changedLines = changed.reduce((n, e) => n + e.add + e.del, 0);

// 「読むコード」と同じディレクトリ・同じ拡張子に増えたファイルは、範囲に入れるかを決める候補
const dirs = new Set(planFiles.map((f) => dirname(f)));
const exts = new Set(planFiles.map((f) => extname(f)));
const addedFiles = [...entries.values()].filter((e) => e.status === "A" || e.status === "C");
const fresh = addedFiles.filter((e) => dirs.has(dirname(e.to)) && exts.has(extname(e.to)));
const elsewhere = addedFiles.length - fresh.length;

console.log(`\n範囲（読むコード ${planFiles.length} ファイル・${scopeLines} 行）`);
console.log(`  変わった ${changed.length} ファイル（足した ${changed.reduce((n, e) => n + e.add, 0)} 行・消した ${changed.reduce((n, e) => n + e.del, 0)} 行）`);
console.log(`  消えた・名前が変わった ${gone.length ? "" : "なし"}`);
for (const e of gone) console.log(`    ${show(e)}`);
console.log(`  同じ場所に増えたファイル（範囲に入れるか決める） ${fresh.length ? "" : "なし"}`);
for (const e of fresh) console.log(`    ${e.to}（${e.add} 行）`);
if (elsewhere) console.log(`  ほかの場所に増えたファイル ${elsewhere} 個（git -C <repo> diff --no-textconv --no-ext-diff --name-status ${old.slice(0, 7)}..${target.slice(0, 7)} で見る）`);

// ── 章ごと ─────────────────────────────────────────────
/** メモの根拠（code・doc）が指すファイル */
function cited(id) {
  const file = join(workspaceDir(ROOT), "notes", `${id}.md`);
  if (!existsSync(file)) return [];
  return [...readText(file).matchAll(/^\s+- (?:code|doc) `([^`]+)`/gm)].map((m) => m[1]);
}
console.log("\n章ごと（読むコードと、メモの根拠が指すファイルのうち、変わったもの）");
const untouched = [];
for (const c of plan.chapters) {
  const hits = [...new Set([...c.files, ...cited(c.id)])].map((f) => entries.get(f)).filter(Boolean);
  if (hits.length) console.log(`  ${c.id}  ${hits.map(show).join("  ")}`);
  else untouched.push(c.id);
}
if (untouched.length) console.log(`  変わらない章: ${untouched.join(" ")}`);

// ── 目安 ───────────────────────────────────────────────
// 読むコードが1つも無い（地図の章だけの）章立てでは、割合が意味を持たないので判定しない
if (planFiles.length === 0) {
  console.log("\n目安: 出せません（章立てに「読むコード」がありません。差分を読んで決めます）");
  process.exit(0);
}
const reasons = [];
if (gone.length * 2 >= planFiles.length) reasons.push(`読むコードの半分以上（${gone.length}/${planFiles.length}）が消えた・名前が変わった`);
if (changedLines * 2 >= scopeLines) reasons.push(`範囲 ${scopeLines} 行に対して、変わった行（足した＋消した）が ${changedLines}`);
if (fresh.length * 2 >= planFiles.length) reasons.push(`同じ場所に増えたファイルが ${fresh.length} 個（読むコードは ${planFiles.length} 個）`);
console.log(`\n目安: ${reasons.length ? "作り直し（章立てから）" : "追従（変わった章だけ直す）"}`);
for (const r of reasons) console.log(`  - ${r}`);
