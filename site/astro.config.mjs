import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";

// Astro の使用状況の送信（テレメトリ）を切る。中身は送らないが、手元だけで使う方針なので
// 外への通信を出さない。環境変数で切るので、各自の端末の設定は変えない
process.env.ASTRO_TELEMETRY_DISABLED = "1";

const kitSrc = fileURLToPath(new URL("./src", import.meta.url));
const siteRoot = fileURLToPath(new URL(".", import.meta.url));
const workspace = fileURLToPath(new URL("../workspace", import.meta.url));

// 手元で見るだけのサイト。公開しない（README の「公開しない」）ので site / base は持たない。
// 対象のコードを全文表示するため、開発サーバーもこの端末からしか開けないようにする。
//
// 章と図は ../workspace/（利用者の中身。キットの Git の外）にある。
// そこからキットの部品は `@kit/…`（= site/src/…）で参照する。
export default defineConfig({
  integrations: [mdx()],
  devToolbar: { enabled: false },
  server: { host: "localhost" },
  vite: {
    resolve: { alias: { "@kit": kitSrc } },
    // 開発サーバーが配ってよいのは、サイトと workspace/ の図だけ
    server: { fs: { allow: [siteRoot, workspace] } },
  },
});
