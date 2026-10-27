/**
 * 章の並びと区分を、章立て（workspace/notes/plan.md）から読む。サイト側に章の一覧を書き写さない。
 *
 * 章を足すときは plan.md の表を直せば、地図と前後のリンクが追従する。
 * plan.md がまだ無いとき（clone した直後）は空として扱う。
 *
 * 基準コミットを上げたあと、メモが追いついていない章（check/config.mjs の notesBehind）は、
 * 直るまでビルドせず、準備中として出す。章の一覧は builtChapters() から取る（getCollection を直接呼ばない）。
 */
import { getCollection } from "astro:content";
// @ts-ignore 検証スクリプトと共有する素の JS
import { loadPlan, memoHeadings, notesBehind } from "../../check/config.mjs";
import { ROOT, config } from "./target";

export type Chapter = {
  /** "04" */
  n: string;
  /** "04-client"。メモのファイル名とサイトの URL に使う */
  id: string;
  title: string;
  group: string;
  /** plan.md の「読むコード」の欄（バッククォートを含む生の文字列） */
  code: string;
  files: string[];
};

export type Group = {
  name: string;
  /** 読み終えると何が分かるか */
  outcome: string;
  chapters: string[];
};

export type LegendItem = { kind: "a" | "b" | "c" | "d"; name: string; note: string };

const plan: { intro: string; chapters: Chapter[]; groups: Group[]; legend: LegendItem[] } | null = loadPlan(ROOT);

/** メモが基準コミットに追いついていない章の id */
const behind: Set<string> = new Set(notesBehind(ROOT, config, plan).keys());

export function behindChapters(): string[] {
  return [...behind];
}

/** ビルドする章（作成済みで、メモが基準コミットに追いついているもの） */
export async function builtChapters() {
  return getCollection("chapters", (e) => !behind.has(e.id));
}

export function hasPlan() {
  return plan !== null;
}

export function planIntro() {
  return plan?.intro ?? "";
}

export function allChapters(): Chapter[] {
  return plan?.chapters ?? [];
}

export function allGroups(): Group[] {
  return plan?.groups ?? [];
}

export function legend(): LegendItem[] {
  return plan?.legend ?? [];
}

export function chapterById(id: string) {
  const c = allChapters().find((x) => x.id === id);
  if (!c) throw new Error(`[curriculum] workspace/notes/plan.md の表に ${id} がありません`);
  return c;
}

/** 前後の章（未作成の章も含めた、章立てどおりの並び） */
export function neighbors(id: string) {
  const chapters = allChapters();
  const i = chapters.findIndex((x) => x.id === id);
  return { prev: chapters[i - 1], next: chapters[i + 1] };
}

/** 事実メモの `##` 見出し。メモが無ければ null */
export function headingsOf(id: string): string[] | null {
  return memoHeadings(ROOT, id);
}
