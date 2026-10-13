/**
 * 「要見直し」の章を、ビルドせずに挙げる。`npm --prefix site run check:stale`。
 *
 * 対象が更新されて基準コミットを上げると、サイトの章のアンカーがずれてビルド（npm run check）が
 * 通らなくなることがある。そのときでも、どの章を作り直せばよいか（メモが書き起こした後に
 * 変わった章）と、メモの差分の見方を出す。/codewalk-site stale が対象を決めるのに使う。
 *
 * 出すコマンドは、キットのルートで実行する形にする。✗ は workspace/ が読めないときだけ。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { chapterBases, workspaceDir } from "./config.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const WS = workspaceDir(ROOT);
if (!existsSync(join(WS, ".git"))) {
  console.log("✗ workspace/ が Git のリポジトリではありません。/codewalk <パス> で始めます");
  process.exit(1);
}
const git = (...args) => execFileSync("git", ["-C", WS, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const chapters = chapterBases(ROOT);
const stale = [];
const broken = [];
for (const ch of chapters) {
  const memo = `notes/${ch.id}.md`;
  if (!ch.basedOn) {
    broken.push(`${ch.id}: frontmatter の basedOn が読めません（basedOn: "<コミット>" の形）`);
    continue;
  }
  let log;
  try {
    log = git("log", "--format=%h %s", `${ch.basedOn}..HEAD`, "--", memo);
  } catch {
    broken.push(`${ch.id}: basedOn ${ch.basedOn} が workspace/ の Git にありません`);
    continue;
  }
  const dirty = git("status", "--porcelain", "--", memo);
  if (log || dirty) stale.push({ ...ch, memo, log, dirty });
}

console.log(`サイトの章 ${chapters.length} / 要見直し ${stale.length}`);
for (const s of stale) {
  console.log(`  ${s.id}（書き起こしたときのメモ ${s.basedOn}）`);
  if (s.log) console.log(`    ${s.log.replace(/\n/g, "\n    ")}`);
  if (s.dirty) console.log("    （メモに未コミットの変更があります。先にコミットする）");
  console.log(`    差分：git -C workspace diff ${s.basedOn} -- ${s.memo}`);
}
for (const b of broken) console.log(`! ${b}`);
