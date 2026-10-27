/**
 * 検証用の目録（dist/meta.json）。check/ のスクリプトが、章の対応表と基準コミットを読む。
 */
import { behindChapters, builtChapters } from "../lib/curriculum";
import { config } from "../lib/target";

export async function GET() {
  const entries = await builtChapters();
  return new Response(
    JSON.stringify(
      {
        commit: config?.commit ?? null,
        chapters: entries.map((e) => ({ id: e.id, ...e.data })),
        /** メモが基準コミットに追いついていないので、ビルドしなかった章 */
        behind: behindChapters(),
      },
      null,
      2,
    ),
  );
}
