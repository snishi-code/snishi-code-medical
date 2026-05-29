import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// base パス:
//   - dev (vite serve):  "/"                 ← ローカル開発
//   - build (prod/test): "/hospital-rounds/" ← medical.snishi-code.com/hospital-rounds/
//                                               および medical-dev.snishi-code.com/hospital-rounds/
//   Origin 分離後はカテゴリ origin 配下の /hospital-rounds/ で配信されるため本番・テストとも
//   base は同じ。旧 mode=test→"/" 分岐 (hospital-rounds.snishi-code.com ルート配信) は不要になった。
export default defineConfig(({ command }) => ({
  base: command === "serve" ? "/" : "/hospital-rounds/",
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
}));
