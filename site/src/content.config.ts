/**
 * サイトの章。workspace/chapters/ に、事実メモと同じ名前（04-client.mdx）で置き、URL も /04-client/ になる。
 *
 * 章の番号と題は workspace/notes/plan.md の表から引くので、ここには持たない（src/lib/curriculum.ts）。
 * 持つのは、サイトにしか無い情報と、事実メモとの対応だけ。
 */
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const chapters = defineCollection({
  loader: glob({ base: "../workspace/chapters", pattern: "[0-9][0-9]-*.mdx" }),
  schema: z.object({
    /** 役割の1行 */
    role: z.string(),
    /** この章で読む、解説対象のファイル（リポジトリのルートから） */
    files: z.array(z.string()).default([]),
    /** draft は書きかけ。done になると、メモの見出しの抜けを検証で失敗扱いにする */
    status: z.enum(["draft", "done"]),
    /**
     * 書き起こしたときの事実メモのコミット（workspace/ の Git）。これ以降にメモが変わると「要見直し」に出る。
     * 数字だけの ID（0123456）や 1234e56 は YAML が数値として読むので、必ず引用符で囲む
     */
    basedOn: z
      .string({ error: 'basedOn は引用符で囲んで書きます（例：basedOn: "0123456"）。数字だけの ID が数値として読まれるため' })
      .regex(/^[0-9a-f]{7,40}$/, { error: "basedOn は workspace/ のコミットの ID（16進の7〜40桁）です" }),
    /**
     * 事実メモの `##` 見出しを、サイトのどこで扱ったか。
     * 値は扱った節の題か、`省略：理由`。検証がメモの見出しと突き合わせる。
     */
    covers: z.record(z.string(), z.string()).default({}),
    /** 章の締めの問い（3つ） */
    questions: z.array(z.string()).length(3).optional(),
  }),
});

export const collections = { chapters };
