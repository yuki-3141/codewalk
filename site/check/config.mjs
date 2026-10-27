/**
 * 設定（workspace/codewalk.config.json）と章立て（workspace/notes/plan.md）を読む。
 *
 * サイトのビルド（src/lib/*.ts）と検証のスクリプト（check/*.mjs）の両方がここを使う。
 * 解説対象のリポジトリの場所・基準コミット・章の並びを、ここ以外に書き写さない。
 *
 * 利用者の中身はすべて workspace/ にある。workspace/ はキットの Git には入れず
 * （.gitignore）、それ自体が独立した Git のリポジトリになる（/codewalk-setup が作る）。
 *
 * 形が崩れて読めないときは、黙って空にせず、どこが読めないかを名指しして失敗させる。
 * ただし設定や章立てがまだ無いこと自体は失敗にしない（clone した直後の状態）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** 利用者の中身の置き場所。キットのルートを受け取る */
export function workspaceDir(root) {
  return join(root, "workspace");
}

/** 改行を LF にそろえて読む（Windows で作ったファイルも同じに扱う） */
export function readText(file) {
  return readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
}

/** 行に分ける。末尾の改行1つで空行が増えないようにする。CRLF も LF と同じに扱う */
export function splitLines(text) {
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

/** 正規表現のキャプチャの数 */
function captureCount(source) {
  return new RegExp(`(?:${source})|`).exec("").length - 1;
}

function compile(key, source, flags, needCapture) {
  let re;
  try {
    re = new RegExp(source, flags);
  } catch (e) {
    throw new Error(`[config] "decisions.${key}" が正規表現として読めません: ${e.message}`);
  }
  if (needCapture && captureCount(source) < 1)
    throw new Error(`[config] "decisions.${key}" には、ID を取り出す ( ) が1つ要ります: ${source}`);
  return re;
}

/** キットのルートを受け取って、設定を読む。無ければ null。 */
export function loadConfig(root) {
  const file = join(workspaceDir(root), "codewalk.config.json");
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readText(file));
  } catch (e) {
    throw new Error(`[config] workspace/codewalk.config.json が JSON として読めません: ${e.message}`);
  }
  for (const key of ["title", "repo", "commit"]) {
    if (typeof raw[key] !== "string" || raw[key] === "")
      throw new Error(`[config] workspace/codewalk.config.json に "${key}" がありません`);
  }
  if (!/^[0-9a-f]{40}$/.test(raw.commit)) throw new Error(`[config] "commit" は 40 桁の SHA で書きます: ${raw.commit}`);

  // 環境変数で上書きできる（clone した場所が設定と違う人のため）
  const given = process.env.CODEWALK_REPO || raw.repo;
  const expanded = given.startsWith("~/") ? join(homedir(), given.slice(2)) : given;
  const repo = isAbsolute(expanded) ? expanded : resolve(workspaceDir(root), expanded);

  const decisions = raw.decisions ?? null;
  if (decisions) {
    for (const key of ["path", "heading", "token"])
      if (typeof decisions[key] !== "string" || decisions[key] === "")
        throw new Error(`[config] "decisions.${key}" がありません`);
  }
  return {
    title: raw.title,
    description: raw.description ?? "",
    repo,
    commit: raw.commit,
    short: raw.commit.slice(0, 7),
    /** 判断の記録（ADR など）。ID 付きの見出しを持つ文書（またはその置き場所のディレクトリ）があるときだけ */
    decisions: decisions && {
      path: decisions.path.replace(/\/+$/, ""),
      heading: compile("heading", decisions.heading, "gm", true),
      token: compile("token", decisions.token, "g", false),
    },
  };
}

function git(config, args) {
  return execFileSync("git", ["-C", config.repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** 基準コミットが対象のリポジトリにあるか（無ければ、場所か fetch の問題） */
export function assertCommit(config) {
  try {
    git(config, ["cat-file", "-e", `${config.commit}^{commit}`]);
  } catch {
    throw new Error(
      `[target] ${config.repo} に基準コミット ${config.short} がありません（repo の場所が違うか、そのコミットをまだ取得していない）`,
    );
  }
}

let checkedCommit = null;

/** 基準コミットからファイルを読む。作業ツリーは読まない。 */
export function gitShow(config, path) {
  if (checkedCommit !== config.commit) {
    assertCommit(config);
    checkedCommit = config.commit;
  }
  try {
    return git(config, ["show", `${config.commit}:${path}`]);
  } catch {
    throw new Error(`[target] ${config.short} に ${path} がありません（repo=${config.repo}）`);
  }
}

/**
 * 基準コミットにあるファイルの一覧（prefix を省くと全部）。
 * 日本語などのパスが "\346…" の形に化けないよう、quotePath を切って NUL で区切る。
 */
export function listTargetFiles(config, prefix = "") {
  const args = ["-c", "core.quotePath=false", "ls-tree", "-r", "-z", "--name-only", config.commit];
  if (prefix) args.push("--", prefix);
  return git(config, args).split("\0").filter(Boolean);
}

/** 判断の記録にある ID の集合。設定が無ければ null。path がディレクトリなら、その下の文書をすべて読む */
export function decisionIds(config) {
  if (!config.decisions) return null;
  const { path, heading } = config.decisions;
  let type;
  try {
    type = git(config, ["cat-file", "-t", `${config.commit}:${path}`]).trim();
  } catch {
    throw new Error(`[config] "decisions.path" の ${path} が基準コミット ${config.short} にありません`);
  }
  const files = type === "tree" ? listTargetFiles(config, `${path}/`).filter((f) => /\.(md|mdx|markdown|txt|rst|adoc)$/i.test(f)) : [path];
  const ids = new Set();
  for (const f of files) for (const m of gitShow(config, f).replace(/\r\n?/g, "\n").matchAll(heading)) ids.add(m[1]);
  return ids;
}

// ── 章立て（workspace/notes/plan.md） ───────────────────

const CHAPTER_ROW = /^\| (\d{2}) \| \[(.+?)\]\((\d{2}-[a-z0-9-]+)\.md\) \| (.+?) \| (.+?) \|$/;
const TWO_COL_ROW = /^\| (.+?) \| (.+?) \|$/;
const LEGEND_ROW = /^\| ([a-d]) \| (.+?) \| (.+?) \|$/;
/** 表の区切り行（| --- | :--: | など） */
const SEPARATOR_ROW = /^\|(?:\s*:?-+:?\s*\|)+$/;

function section(md, title) {
  const s = md.split(/^## /m).find((x) => x.split("\n")[0].trim() === title);
  return s ? s.slice(s.indexOf("\n") + 1) : null;
}

/**
 * 表の本体の行を読む。見出しの行と区切りの行は飛ばし、形に合わない行は名指しで失敗させる
 * （行末の空白1つで行が黙って消える、ということを起こさないため）。
 */
function tableRows(sec, title, re, shape) {
  const rows = [];
  let seenHeader = false;
  for (const raw of sec.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    if (SEPARATOR_ROW.test(line)) continue;
    if (!seenHeader) {
      seenHeader = true;
      continue;
    }
    const m = line.match(re);
    if (!m) throw new Error(`[plan] 「## ${title}」の表に読めない行があります（${shape} の形）: ${line}`);
    rows.push(m);
  }
  return rows;
}

/**
 * 章立てを読む。無ければ null。
 *
 * - `## 章`     … | 章 | [題](NN-slug.md) | 区分 | 読むコード |
 * - `## 区分`   … | 区分 | 読み終えると分かること |
 * - `## 色の意味` … | a〜d | 名前 | 何を表すか |（図の色。無くてもよい）
 */
export function loadPlan(root) {
  const file = join(workspaceDir(root), "notes", "plan.md");
  if (!existsSync(file)) return null;
  const md = readText(file);
  const intro = md.split(/^## /m)[0].replace(/^# .*\n/, "").trim();

  const chSec = section(md, "章");
  if (!chSec) throw new Error("[plan] workspace/notes/plan.md に「## 章」がありません");
  const chapters = tableRows(chSec, "章", CHAPTER_ROW, "| 01 | [題](01-slug.md) | 区分 | 読むコード |").map(
    ([, n, title, id, group, code]) => ({
      n,
      id,
      title,
      group,
      code: code === "—" ? "" : code,
      files: [...code.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
    }),
  );
  if (chapters.length === 0) throw new Error("[plan] 「## 章」の表に章がありません（| 01 | [題](01-slug.md) | 区分 | 読むコード | の形）");
  chapters.forEach((c, i) => {
    const want = String(i + 1).padStart(2, "0");
    if (c.n !== want) throw new Error(`[plan] 章の番号が飛んでいます: ${want} のはずが ${c.n}`);
    if (!c.id.startsWith(`${c.n}-`)) throw new Error(`[plan] ${c.n}章のファイル名が番号と合いません: ${c.id}.md`);
  });

  const grSec = section(md, "区分");
  if (!grSec) throw new Error("[plan] workspace/notes/plan.md に「## 区分」がありません");
  const groups = tableRows(grSec, "区分", TWO_COL_ROW, "| 区分 | 読み終えると分かること |").map(([, name, outcome]) => ({
    name,
    outcome: outcome.replaceAll("**", ""),
    chapters: chapters.filter((c) => c.group === name).map((c) => c.n),
  }));
  for (const c of chapters)
    if (!groups.some((g) => g.name === c.group)) throw new Error(`[plan] ${c.n}章の区分「${c.group}」が「## 区分」の表にありません`);
  for (const g of groups) if (g.chapters.length === 0) throw new Error(`[plan] 区分「${g.name}」に章がありません`);

  const lgSec = section(md, "色の意味");
  const legend = lgSec
    ? tableRows(lgSec, "色の意味", LEGEND_ROW, "| a〜d | 名前 | 何を表すか |").map(([, kind, name, note]) => ({ kind, name, note }))
    : [];

  return { intro, chapters, groups, legend };
}

/** 事実メモの `##` 見出し（締めの「確かめる問い」と、フェンスの中を除く）。サイトの covers と突き合わせる */
export const QUESTIONS_HEADING = "確かめる問い";
export function memoHeadings(root, id) {
  const file = join(workspaceDir(root), "notes", `${id}.md`);
  if (!existsSync(file)) return null;
  const headings = [];
  let inFence = false;
  for (const line of readText(file).split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    else if (!inFence && line.startsWith("## ")) headings.push(line.slice(3).trim());
  }
  return headings.filter((h) => h !== QUESTIONS_HEADING);
}

/** 事実メモの根拠（code・doc）が指すファイル。メモが無ければ空 */
export function citedFiles(root, id) {
  const file = join(workspaceDir(root), "notes", `${id}.md`);
  if (!existsSync(file)) return [];
  return [...new Set([...readText(file).matchAll(/^\s+- (?:code|doc) `([^`]+)`/gm)].map((m) => m[1]))];
}

/** 事実メモの frontmatter の files と commit（メモを確かめた基準コミット。無ければ null） */
function memoFrontmatter(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  const files = [...(fm.match(/^files:\s*\n((?:\s+- .*(?:\n|$))*)/m)?.[1] ?? "").matchAll(/- (.+)/g)].map((m) =>
    m[1].trim().replace(/^["']|["']$/g, ""),
  );
  const commit = fm.match(/^commit:\s*["']?([0-9a-f]{7,40})["']?\s*$/m)?.[1] ?? null;
  return { files, commit };
}

/**
 * 基準コミットに追いついていない事実メモ（章の id → 理由）。
 *
 * 基準コミットを上げたあと、/codewalk がこの章を1章ずつ直す。直るまで、サイトはこの章を
 * 準備中として出し、ビルドしない（アンカーがずれた章があっても、ほかの章を確かめられるように）。
 *
 * メモを確かめた基準コミットは、frontmatter の commit。無ければ、メモを最後にコミットしたときの
 * 設定の commit。それが今の基準コミットと違い、そのあいだに読むコードかメモの根拠が指すファイルが
 * 変わっていれば、追いついていない。章立ての「読むコード」とメモの files が違うときも（章立てを合わせた直後）。
 */
export function notesBehind(root, config, plan) {
  const behind = new Map();
  if (!config || !plan) return behind;
  const ws = workspaceDir(root);
  const wsIsGit = existsSync(join(ws, ".git"));
  const wsGit = (...args) => execFileSync("git", ["-C", ws, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  for (const c of plan.chapters) {
    const file = join(ws, "notes", `${c.id}.md`);
    if (!existsSync(file)) continue;
    const fm = memoFrontmatter(readText(file));
    if ([...fm.files].sort().join("\n") !== [...c.files].sort().join("\n")) {
      behind.set(c.id, { base: fm.commit, changed: [], reason: "章立ての「読むコード」とメモの files が違う" });
      continue;
    }
    let base = fm.commit;
    if (!base && wsIsGit) {
      try {
        const last = wsGit("log", "-1", "--format=%H", "--", `notes/${c.id}.md`);
        if (last) base = JSON.parse(wsGit("show", `${last}:codewalk.config.json`)).commit ?? null;
      } catch {
        base = null;
      }
    }
    // まだコミットしていないメモ（書いている途中）は、今の基準コミットで書いているとみなす
    if (!base || config.commit.startsWith(base)) continue;
    const paths = [...new Set([...c.files, ...citedFiles(root, c.id)])];
    if (paths.length === 0) continue;
    let changed;
    try {
      changed = git(config, [
        "--literal-pathspecs",
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-textconv",
        "--no-ext-diff",
        "--no-renames",
        "--name-only",
        base,
        config.commit,
        "--",
        ...paths,
      ]).trim();
    } catch {
      behind.set(c.id, { base, changed: [], reason: `確かめた基準コミット ${base.slice(0, 7)} が対象のリポジトリにありません` });
      continue;
    }
    if (changed) behind.set(c.id, { base, changed: changed.split("\n"), reason: `${base.slice(0, 7)} から変わった: ${changed.split("\n").join(", ")}` });
  }
  return behind;
}

/**
 * サイトの章（workspace/chapters/*.mdx）の basedOn を、ビルドせずに読む。
 * アンカーがずれてビルドが通らないときでも、「要見直し」の章を挙げられるように。
 */
export function chapterBases(root) {
  const dir = join(workspaceDir(root), "chapters");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{2}-.*\.mdx$/.test(f))
    .sort()
    .map((f) => {
      const fm = readText(join(dir, f)).match(/^---\n([\s\S]*?)\n---\n/);
      const based = fm?.[1].match(/^basedOn:\s*["']?([0-9a-f]{7,40})["']?\s*$/m);
      return { id: f.replace(/\.mdx$/, ""), basedOn: based ? based[1] : null };
    });
}
