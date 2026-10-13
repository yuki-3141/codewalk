/**
 * 章ごとの進み具合と、次に作る章を出す。`npm --prefix site run check:progress`。
 *
 * /codewalk が、続きをどの章から進めるかを決めるのに使う。ビルドはしない。
 *
 *   メモ   … workspace/notes/NN-slug.md があるか
 *   サイト … workspace/chapters/NN-slug.mdx があるか、status が done（完成）か draft（書きかけ）か
 *   要見直し … サイトを書き起こした後（basedOn より後）に、メモが変わったか
 *
 * 次に作る章は、要見直し → 書きかけ → サイトが無い（メモはある）→ メモが無い、の順。
 * 同じ順の中では若い番号から。✗ は設定・章立てが読めないときだけ。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { chapterBases, loadConfig, loadPlan, readText, workspaceDir } from "./config.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const WS = workspaceDir(ROOT);
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
if (!config || !plan) {
  console.log("まだ始まっていません（workspace/codewalk.config.json か workspace/notes/plan.md がありません）");
  console.log("次: 調べる（/codewalk <パス>）");
  process.exit(0);
}

const wsIsGit = existsSync(join(WS, ".git"));
const git = (...args) => execFileSync("git", ["-C", WS, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const bases = new Map(chapterBases(ROOT).map((c) => [c.id, c.basedOn]));

const rows = plan.chapters.map((c) => {
  const memo = existsSync(join(WS, "notes", `${c.id}.md`));
  const page = join(WS, "chapters", `${c.id}.mdx`);
  let site = null;
  if (existsSync(page)) {
    const fm = readText(page).match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
    site = /^status:\s*["']?done["']?\s*$/m.test(fm) ? "done" : "draft";
  }
  let stale = false;
  if (site && memo && wsIsGit) {
    const based = bases.get(c.id);
    try {
      stale = !based || git("log", "--format=%h", `${based}..HEAD`, "--", `notes/${c.id}.md`) !== "" || git("status", "--porcelain", "--", `notes/${c.id}.md`) !== "";
    } catch {
      stale = true; // basedOn が workspace/ の Git に無い
    }
  }
  return { ...c, memo, site, stale };
});

// 全角の文字は2桁ぶんとして数え、列をそろえる
const cols = (s) => [...s].reduce((n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
const label = (r) => (r.site === "done" ? "完成" : r.site === "draft" ? "書きかけ" : "—");
const width = Math.max(...rows.map((r) => cols(`${r.n} ${r.title}`)));
const count = (f) => rows.filter(f).length;
console.log(
  `基準コミット ${config.short} / 章立て ${rows.length}章 / メモ ${count((r) => r.memo)} / サイト ${count((r) => r.site)}（完成 ${count((r) => r.site === "done")}・書きかけ ${count((r) => r.site === "draft")}）/ 要見直し ${count((r) => r.stale)}`,
);
for (const r of rows) {
  const name = `${r.n} ${r.title}`;
  console.log(`  ${name}${" ".repeat(width - cols(name))}  メモ ${r.memo ? "✓" : "—"}  サイト ${label(r)}${r.stale ? "  要見直し" : ""}`);
}

const next = [
  ...rows.filter((r) => r.stale),
  ...rows.filter((r) => !r.stale && r.site === "draft"),
  ...rows.filter((r) => r.memo && !r.site),
  ...rows.filter((r) => !r.memo),
];
console.log(next.length ? `次: ${next.map((r) => r.id).join(" ")}` : "次: なし（すべて完成）");
