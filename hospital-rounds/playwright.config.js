import { defineConfig, devices } from "@playwright/test";

// 実ブラウザ E2E (v8.10.0〜)。
// - PC にインストール済みの Google Chrome を使う (channel:"chrome")。
//   → Playwright 専用ブラウザの追加ダウンロード不要。ディスクをほぼ食わない。
// - serviceWorkers:"block" で SW を登録させない (キャッシュ汚染を構造的に回避)。
// - 各テストは Playwright の既定どおり「まっさらな context」で走る (IDB/localStorage を持ち越さない)。
// - webServer は既存の vite dev (:5173) を再利用。無ければ自動で起動。
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    serviceWorkers: "block",
    trace: "off",
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome", headless: true },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
