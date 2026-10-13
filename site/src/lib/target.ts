/**
 * 解説対象のコードを、基準コミットから取り出す。
 *
 * 作業ツリーは読まない。`git show <commit>:<path>` だけを使うので、対象のリポジトリの
 * HEAD がどこにあっても同じ内容が返り、作業ツリーを動かすこともない。
 *
 * コードの位置は行番号ではなく**アンカー**（その行に含まれる文字列）で指す。
 * 基準コミットを上げて位置がずれたら、見つからない・2箇所で見つかる、のどちらかで
 * ビルドが失敗し、直すべき箇所が名指しされる。
 */
import { resolve as resolvePath } from "node:path";
// @ts-ignore 検証スクリプトと共有する素の JS
import { gitShow, listTargetFiles, loadConfig, splitLines } from "../../check/config.mjs";

/** このリポジトリのルート。npm スクリプトは site/ で動く */
export const ROOT = resolvePath(process.cwd(), "..");

type Config = {
  title: string;
  description: string;
  repo: string;
  commit: string;
  short: string;
  decisions: { path: string; heading: RegExp; token: RegExp } | null;
};

export const config: Config | null = loadConfig(ROOT);

function need(): Config {
  if (!config) throw new Error("[target] workspace/codewalk.config.json がありません。/codewalk <パス> で始めます");
  return config;
}

const cache = new Map<string, string>();

/** ファイル全文。 */
export function source(path: string): string {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  const text: string = gitShow(need(), path);
  cache.set(path, text);
  return text;
}

/** 行の配列。末尾の改行で空行が1つ増えないようにする。CRLF も LF と同じに扱う（Shiki の表示と行をそろえる） */
export function lines(path: string): string[] {
  return splitLines(source(path));
}

export type Anchor = {
  /** 開始行に含まれる文字列。ファイル内でちょうど1行に一致しなければならない */
  from: string;
  /** 終了行の先頭（インデント込み）。開始行以降で最初に一致した行で終わる */
  to?: string;
  /** `to` の代わりに行数で終わりを決める */
  count?: number;
};

export type LineRange = { start: number; end: number };

/** アンカーを 1 始まりの行範囲に解決する。 */
export function resolve(path: string, anchor: Anchor): LineRange {
  const all = lines(path);
  const hits = all.flatMap((line, i) => (line.includes(anchor.from) ? [i] : []));
  if (hits.length !== 1) {
    throw new Error(
      `[target] ${path} のアンカー ${JSON.stringify(anchor.from)} が ${hits.length} 箇所で見つかりました（ちょうど1箇所である必要があります）`,
    );
  }
  const start = hits[0];
  let end = start;
  if (anchor.to !== undefined) {
    const to = anchor.to;
    const found = all.findIndex((line, i) => i >= start && line.startsWith(to));
    if (found === -1) {
      throw new Error(`[target] ${path} の ${start + 1} 行目以降に ${JSON.stringify(to)} で始まる行がありません`);
    }
    end = found;
  } else if (anchor.count !== undefined) {
    if (!Number.isInteger(anchor.count) || anchor.count < 1)
      throw new Error(`[target] ${path} のアンカー ${JSON.stringify(anchor.from)} の count は1以上の整数にします: ${anchor.count}`);
    end = start + anchor.count - 1;
    if (end >= all.length) throw new Error(`[target] ${path} の ${start + 1} 行目から ${anchor.count} 行はファイルを越えます`);
  }
  return { start: start + 1, end: end + 1 };
}

/**
 * `const NAME = <数値か文字列>;` の値を読む。図に出す数字を手で書き写さないため。
 * 数値は整数・小数・負の数・16進（`0x10`）・区切り（`1_000`）、文字列は "…" か '…'。
 * 型注釈・`as const`・行末のコメントは許す。式（`64 * 1024` など）は読まない。読めなければ失敗させる。
 * TypeScript / JavaScript 以外の言語では firstMatch を使う。
 */
export function constant(path: string, name: string): string | number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const decl = new RegExp(`^\\s*(?:export\\s+)?const\\s+${escaped}\\s*(?::[^=]+)?=\\s*(.*)$`);
  const found = lines(path)
    .map((line) => line.match(decl))
    .filter(Boolean);
  if (found.length === 0) throw new Error(`[target] ${path} に const ${name} = …; の行がありません`);
  if (found.length > 1) throw new Error(`[target] ${path} に const ${name} が ${found.length} 行あります`);
  const rest = found[0]![1];
  // 値は「文字列」か「数値の1語」だけ。その後ろに許すのは as const・; ・行末のコメント
  const value = rest.match(/^("[^"\\]*"|'[^'\\]*'|-?[0-9a-fA-Fx_.]+)(?:\s+as\s+const)?\s*;?\s*(?:\/\/.*)?$/);
  if (value) {
    const raw = value[1];
    if (/^["']/.test(raw)) return raw.slice(1, -1);
    const neg = raw.startsWith("-");
    const body = (neg ? raw.slice(1) : raw).replaceAll("_", "");
    if (/^(?:0x[0-9a-f]+|[0-9]+(?:\.[0-9]+)?)$/i.test(body)) return (neg ? -1 : 1) * Number(body);
  }
  throw new Error(`[target] ${path} の ${name} は数値でも文字列でもありません（式は読まない）: ${rest}`);
}

/** 基準コミットにあるファイルの一覧（prefix を省くと全部）。日本語などのパスもそのまま返す */
export function listFiles(prefix = ""): string[] {
  return listTargetFiles(need(), prefix);
}

/** 正規表現の最初のキャプチャ（例：画面に出す文言）。見つからなければ失敗させる。 */
export function firstMatch(path: string, pattern: RegExp): string {
  const m = source(path).match(pattern);
  if (!m?.[1]) throw new Error(`[target] ${path} に ${pattern} が見つかりません`);
  return m[1];
}

/** 正規表現に一致する行の数（例：一覧の件数）。 */
export function countLines(path: string, pattern: RegExp): number {
  return lines(path).filter((line) => pattern.test(line)).length;
}

/** 拡張子から、コードの色付けに使う言語を決める */
export function langOf(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  if (name === "Dockerfile") return "docker";
  if (name === "Makefile") return "make";
  const ext = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", mts: "ts", cts: "ts", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", scala: "scala", dart: "dart",
    sh: "bash", bash: "bash", zsh: "bash", sql: "sql", css: "css", scss: "scss", html: "html",
    vue: "vue", svelte: "svelte", astro: "astro", json: "json", yaml: "yaml", yml: "yaml",
    toml: "toml", md: "markdown", mdx: "mdx", xml: "xml", graphql: "graphql", proto: "proto",
  };
  return map[ext] ?? "text";
}

/**
 * HTML に入れる前のエスケープ。対象のコードから読んだ文字列を、図の説明（StepFlow の note など、
 * HTML として入る所）に使うときは必ずこれを通す。対象の中の HTML が動かないようにする。
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const COMMIT_SHORT = config?.short ?? "";
