/**
 * 章立てと事実メモの検証。`npm run check:notes [-- 04 05-slug ...]`（site/ で実行する）。
 *
 * 事実メモ（workspace/notes/NN-slug.md）は「主張の箇条書き + その下に根拠」でできている。
 * ここでは、根拠がすべて基準コミットの実物を指しているかを確かめる。
 * 主張の中身が根拠と合っているかは、機械では分からない（notes-reviewer が読む）。
 *
 *   章立て    … workspace/notes/plan.md の表が読めるか、読むコードが基準コミットにあるか
 *   形        … frontmatter（role・files）、`# NN 題` が章立てと一致、問いが3つ、
 *               節の中は箇条書きと ```text の図だけ
 *   根拠      … 主張ごとに1つ以上。種類は4つ
 *                 code `path` `アンカー` [〜 `終わりの行の先頭`]  … ちょうど1行に一致する（〜 は ～ や ~ でもよい）
 *                 doc  `path` `アンカー` [〜 `…`]                  … 文書（README・設計文書・ADR）。同じ規則
 *                 commit `SHA` 一言                                … 16進の ID で、基準コミットの祖先にある。一言は必須
 *                 推測 理由                                         … 裏づけが無いと明示する（数を報告する）
 *   判断の ID … 主張に書いた ID（ADR-0003 など）が判断の記録にあるか（設定の decisions があるときだけ）
 *
 * ✗ が1つでもあれば終了コード 1。! は要確認の知らせで、失敗にはしない。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  QUESTIONS_HEADING,
  assertCommit,
  decisionIds,
  gitShow,
  listTargetFiles,
  loadConfig,
  loadPlan,
  readText,
  splitLines,
  workspaceDir,
} from "./config.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const NOTES = join(workspaceDir(ROOT), "notes");

const errors = [];
const warns = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

const stopNow = (msg) => {
  console.log(`✗ ${msg}`);
  process.exit(1);
};
let config;
try {
  config = loadConfig(ROOT);
} catch (e) {
  stopNow(e.message);
}
if (!config) stopNow("workspace/codewalk.config.json がありません。/codewalk <パス> で始めます");
try {
  assertCommit(config);
} catch (e) {
  stopNow(e.message);
}

let plan;
try {
  plan = loadPlan(ROOT);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(1);
}
if (!plan) {
  console.log("✗ workspace/notes/plan.md がありません。/codewalk <パス> で始めます");
  process.exit(1);
}

// ── 基準コミットの読み取り（キャッシュつき） ─────────────
const files = new Set(listTargetFiles(config));
const cache = new Map();
function linesOf(path) {
  if (!cache.has(path)) cache.set(path, splitLines(gitShow(config, path)));
  return cache.get(path);
}
let known = null;
try {
  known = decisionIds(config);
} catch (e) {
  stopNow(e.message);
}

// ── 章立て ─────────────────────────────────────────────
for (const c of plan.chapters)
  for (const f of c.files) if (!files.has(f)) fail("workspace/notes/plan.md", `${c.n}章の読むコード ${f} が基準コミットにありません`);

// ── 対象のメモ ─────────────────────────────────────────
const args = [...new Set(process.argv.slice(2))];
const wanted = args.length
  ? plan.chapters.filter((c) => args.some((a) => a === c.n || a === c.id))
  : plan.chapters.filter((c) => existsSync(join(NOTES, `${c.id}.md`)));
const unknown = args.filter((a) => !plan.chapters.some((c) => a === c.n || a === c.id));
if (unknown.length) fail("引数", `章立てに無い章があります: ${unknown.join(" ")}`);
for (const f of existsSync(NOTES) ? readdirSync(NOTES) : [])
  if (/^\d{2}-.*\.md$/.test(f) && !plan.chapters.some((c) => `${c.id}.md` === f))
    fail(`workspace/notes/${f}`, "章立て（plan.md）に無いメモです");

/** `` `a` `` や ``` `` a`b `` ``` のコードスパンを1つ読む。返り値は [中身, 続きの位置] */
function codeSpan(text, at) {
  const open = text.slice(at).match(/^`+/);
  if (!open) return null;
  const n = open[0].length;
  const start = at + n;
  for (let i = start; i < text.length; i++) {
    if (text[i] !== "`") continue;
    let j = i;
    while (text[j] === "`") j++;
    if (j - i === n) {
      let body = text.slice(start, i);
      if (body.length > 1 && body.startsWith(" ") && body.endsWith(" ")) body = body.slice(1, -1);
      return [body, j];
    }
    i = j;
  }
  return null;
}

function checkAnchor(where, path, from, to) {
  if (!files.has(path)) return fail(where, `${path} が基準コミットにありません`);
  const all = linesOf(path);
  const hits = all.flatMap((l, i) => (l.includes(from) ? [i] : []));
  if (hits.length !== 1)
    return fail(where, `${path} のアンカー ${JSON.stringify(from)} が ${hits.length} 箇所で見つかりました（ちょうど1箇所に）`);
  if (to !== undefined && !all.some((l, i) => i >= hits[0] && l.startsWith(to)))
    fail(where, `${path} の ${hits[0] + 1} 行目以降に ${JSON.stringify(to)} で始まる行がありません`);
}

function checkEvidence(where, text) {
  const m = text.match(/^(code|doc|commit|推測)\s+(.*)$/);
  if (!m) {
    fail(where, `根拠の書式が違います（code / doc / commit / 推測 で始める）: ${text}`);
    return null;
  }
  const [, kind, rest] = m;
  if (kind === "code" || kind === "doc") {
    const p = codeSpan(rest, 0);
    if (!p) return fail(where, `${kind} の後にパスを \`…\` で書きます`), null;
    const after = rest.slice(p[1]).trimStart();
    const a = codeSpan(after, 0);
    if (!a) return fail(where, `${kind} \`${p[0]}\` の後にアンカーを \`…\` で書きます`), null;
    let to;
    const tail = after.slice(a[1]).trim();
    // 範囲の記号は 〜（U+301C）。IME によって出る ～（U+FF5E）と半角の ~ も同じに扱う
    if (/^[〜～~]/.test(tail)) {
      const rest2 = tail.slice(1).trimStart();
      const t = codeSpan(rest2, 0);
      if (!t) return fail(where, "〜 の後に終わりの行の先頭を `…` で書きます"), null;
      to = t[0];
      if (rest2.slice(t[1]).trim()) return fail(where, `終わりの行の後ろに余計な文字があります: ${rest2.slice(t[1]).trim()}`), null;
    } else if (tail) {
      return fail(where, `アンカーの後ろに余計な文字があります（範囲なら 〜 \`終わりの行の先頭\`）: ${tail}`), null;
    }
    if (a[0].trim() === "") return fail(where, "アンカーが空です"), null;
    checkAnchor(where, p[0], a[0], to);
    return { kind, path: p[0] };
  }
  if (kind === "commit") {
    const s = codeSpan(rest, 0);
    const sha = s ? s[0] : rest.split(/\s/)[0];
    const summary = (s ? rest.slice(s[1]) : rest.slice(sha.length)).trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return fail(where, `commit にはコミットの ID（16進の7〜40桁）を書きます。ブランチ名や HEAD~ は後で動くので使わない: ${sha}`), null;
    if (!summary) fail(where, `commit \`${sha}\` の後に、そのコミットが何をしたかを一言書きます`);
    try {
      execFileSync("git", ["-C", config.repo, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
      execFileSync("git", ["-C", config.repo, "merge-base", "--is-ancestor", sha, config.commit], { stdio: "ignore" });
    } catch {
      fail(where, `コミット ${sha} が基準コミット ${config.short} の祖先にありません`);
    }
    return { kind };
  }
  if (rest.trim().length < 4) fail(where, "推測には理由を書きます（なぜ裏づけが無いのか、何から推したのか）");
  return { kind };
}

function parseFrontmatter(where, text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return fail(where, "先頭に frontmatter（--- で囲む）がありません"), null;
  const fm = { role: "", files: [] };
  let inFiles = false;
  for (const line of m[1].split("\n")) {
    if (/^role:\s*/.test(line)) (fm.role = line.replace(/^role:\s*/, "").trim()), (inFiles = false);
    else if (/^files:\s*$/.test(line)) inFiles = true;
    else if (/^files:\s*\S/.test(line)) fail(where, "frontmatter の files は1行に1つ、「  - パス」の形で書きます（[a, b] の形は読まない）");
    else if (inFiles && /^\s+- /.test(line)) fm.files.push(line.replace(/^\s+- /, "").trim().replace(/^["']|["']$/g, ""));
    else if (inFiles && /^- /.test(line)) fail(where, "frontmatter の files の項目は2字下げて「  - パス」にします");
    else if (line.trim()) inFiles = false;
  }
  return { fm, body: text.slice(m[0].length), offset: m[0].split("\n").length - 1 };
}

const results = [];
const guesses = [];
for (const c of wanted) {
  const rel = `workspace/notes/${c.id}.md`;
  const file = join(ROOT, rel);
  if (!existsSync(file)) {
    fail(rel, "メモがありません");
    continue;
  }
  const parsed = parseFrontmatter(rel, readText(file));
  if (!parsed) continue;
  const { fm, body, offset } = parsed;
  if (!fm.role) fail(rel, "frontmatter に role（役割の1行）がありません");
  const planFiles = [...c.files].sort().join(", ");
  if ([...fm.files].sort().join(", ") !== planFiles)
    fail(rel, `frontmatter の files が章立ての「読むコード」と違います（メモ: ${fm.files.join(", ") || "なし"} / 章立て: ${planFiles || "なし"}）`);

  const lines = body.split("\n");
  const at = (i) => `${rel}:${i + offset + 1}`;
  const h1 = lines.findIndex((l) => l.startsWith("# "));
  if (h1 === -1 || lines[h1] !== `# ${c.n} ${c.title}`)
    fail(h1 === -1 ? rel : at(h1), `見出しは「# ${c.n} ${c.title}」にします（章立てと同じ）`);

  let sectionName = null;
  let inFence = false;
  let claim = null;
  const claims = [];
  const sections = [];
  const questions = [];
  const counts = { code: 0, doc: 0, commit: 0, 推測: 0 };
  const citedFiles = new Set();

  lines.forEach((line, i) => {
    if (line.startsWith("```")) {
      if (!inFence && sectionName !== null && line !== "```text") fail(at(i), "メモに置けるフェンスは ```text（図）だけです。コードは根拠のアンカーで指します");
      inFence = !inFence;
      claim = null;
      return;
    }
    if (inFence) return;
    if (line.startsWith("### ")) return fail(at(i), "見出しは `##` までにします");
    if (line.startsWith("## ")) {
      sectionName = line.slice(3).trim();
      if (sectionName !== QUESTIONS_HEADING) sections.push({ name: sectionName, line: i, claims: 0 });
      claim = null;
      return;
    }
    if (sectionName === null || line.trim() === "") return;

    if (sectionName === QUESTIONS_HEADING) {
      const q = line.match(/^\d+\. (.+)$/);
      if (q) questions.push(q[1]);
      else fail(at(i), "問いは番号つきの1行（1. …）で書きます");
      return;
    }
    if (line.startsWith("- ")) {
      claim = { line: i, text: line.slice(2), evidence: [] };
      claims.push(claim);
      sections.at(-1).claims++;
      return;
    }
    if (line.startsWith("  - ")) {
      if (!claim) return fail(at(i), "根拠の前に主張がありません");
      const ev = checkEvidence(at(i), line.slice(4).trim());
      if (ev) {
        claim.evidence.push(ev);
        counts[ev.kind]++;
        if (ev.kind === "code") citedFiles.add(ev.path);
        if (ev.kind === "推測") guesses.push(`${at(claim.line)}  ${claim.text}`);
      }
      return;
    }
    if (/^ {2}\S/.test(line) && claim && claim.evidence.length === 0) {
      claim.text += line.trim();
      return;
    }
    fail(at(i), "節の中は「- 主張」と「  - 根拠」、```text の図だけにします");
  });

  if (inFence) fail(rel, "フェンスが閉じていません");
  for (const cl of claims) {
    if (cl.evidence.length === 0) fail(at(cl.line), `主張に根拠がありません: ${cl.text}`);
    if (known)
      for (const m of cl.text.matchAll(config.decisions.token))
        if (!known.has(m[0])) fail(at(cl.line), `${m[0]} が ${config.decisions.path} にありません`);
  }
  if (!lines.some((l) => l.trim() === `## ${QUESTIONS_HEADING}`)) fail(rel, `「## ${QUESTIONS_HEADING}」がありません`);
  else if (questions.length !== 3) fail(rel, `問いは3つにします（いま ${questions.length}）`);
  if (sections.length === 0) fail(rel, "節（##）がありません");
  for (const sec of sections) if (sec.claims === 0) fail(at(sec.line), `節「${sec.name}」に主張がありません`);
  for (const f of fm.files) if (!citedFiles.has(f)) warns.push(`${rel}: 読むコード ${f} を code の根拠で1度も指していません`);

  results.push(
    `${c.id}  節 ${sections.length} / 主張 ${claims.length}（code ${counts.code} · doc ${counts.doc} · commit ${counts.commit} · 推測 ${counts.推測}）`,
  );
}

// ── 結果 ───────────────────────────────────────────────
const done = plan.chapters.filter((c) => existsSync(join(NOTES, `${c.id}.md`))).length;
console.log(`基準コミット ${config.short} / 章立て ${plan.chapters.length}章・区分 ${plan.groups.length} / メモ ${done}/${plan.chapters.length}`);
for (const r of results) console.log(`  ${r}`);
if (guesses.length) {
  console.log(`! 推測 ${guesses.length} 件（裏づけが無い主張。サイトでは「推測」と分かる書き方にする）`);
  for (const g of guesses) console.log(`    ${g}`);
}
for (const w of warns) console.log(`! ${w}`);
if (errors.length) {
  console.log("");
  for (const e of errors) console.log(`✗ ${e}`);
  process.exit(1);
}
console.log("\nすべて通りました。");
