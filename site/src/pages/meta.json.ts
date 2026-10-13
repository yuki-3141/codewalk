/**
 * 検証用の目録（dist/meta.json）。check/ のスクリプトが、章の対応表と基準コミットを読む。
 */
import { getCollection } from "astro:content";
import { config } from "../lib/target";

export async function GET() {
  const entries = await getCollection("chapters");
  return new Response(
    JSON.stringify(
      {
        commit: config?.commit ?? null,
        chapters: entries.map((e) => ({ id: e.id, ...e.data })),
      },
      null,
      2,
    ),
  );
}
