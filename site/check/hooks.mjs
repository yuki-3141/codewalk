/**
 * workspace/ に push の守り（pre-push フック）を入れる。`npm --prefix site run hooks`。
 *
 * フックは .git/ の中に置くので clone では渡らない。/codewalk-setup が workspace/ を作るときに入れ、
 * キットを更新してフックが変わったときは、これで入れ直す。`npm run check` は入っているかを確かめる。
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { workspaceDir } from "./config.mjs";

export const HOOK_SOURCE = join(import.meta.dirname, "hooks", "pre-push");

/** フックの置き場所（core.hooksPath が設定されていればそちら） */
export function hookTarget(ws) {
  const p = execFileSync("git", ["-C", ws, "rev-parse", "--git-path", "hooks/pre-push"], { encoding: "utf8" }).trim();
  return isAbsolute(p) ? p : join(ws, p);
}

export function installHook(ws) {
  const target = hookTarget(ws);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(HOOK_SOURCE, target);
  chmodSync(target, 0o755);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ws = workspaceDir(resolve(import.meta.dirname, "../.."));
  if (!existsSync(join(ws, ".git"))) {
    console.log("✗ workspace/ が Git のリポジトリではありません。先に /codewalk <パス> を実行します");
    process.exit(1);
  }
  console.log(`✓ pre-push フックを入れました: ${installHook(ws)}`);
}
