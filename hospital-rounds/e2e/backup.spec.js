import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 端末まるごとバックアップの「書出 → 別端末で取込」往復を検証する。
// 取込は隠し file input (#settingsImportFile) に setInputFiles、書出は download イベントで捕捉。

const SAMPLE = fileURLToPath(new URL("../test/sample-data/comprehensive.device-archive.json", import.meta.url));
const BASE = "http://localhost:5173";

async function boot(page, name) {
  await page.goto("/");
  const ob = page.locator("#onboardingOverlay");
  await ob.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  if (await ob.isVisible().catch(() => false)) {
    await page.locator("#onboardingNameInput").fill(name);
    await page.locator("#onboardingStartBtn").click();
  }
  const disc = page.locator("#disclaimerCloseBtn");
  if (await disc.isVisible().catch(() => false)) await disc.click();
  await expect(page.locator("#appTitleInput")).toHaveValue(name);
}

// __users__ レコードのユーザー数が count 以上になるまで待つ (取込完了の確実な目印)。
async function waitUserCount(page, count) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const db = await new Promise((res) => {
            const r = indexedDB.open("hospital-rounds");
            r.onsuccess = () => res(r.result);
            r.onerror = () => res(null);
          });
          if (!db) return 0;
          return await new Promise((res) => {
            const tx = db.transaction("bundles", "readonly");
            const q = tx.objectStore("bundles").get("__users__");
            q.onsuccess = () => res((q.result && q.result.users && q.result.users.length) || 0);
            q.onerror = () => res(0);
          });
        }),
      { timeout: 6000 },
    )
    .toBeGreaterThanOrEqual(count);
}

test("端末まるごと: 書出 → 別端末で取込 でユーザー・患者が往復する", async ({ page, browser }) => {
  page.on("dialog", (d) => d.accept()); // 取込の確認は承認

  // --- 端末1: サンプルを取り込み → 書き出す ---
  await boot(page, "テスト医師");
  await page.locator("#headerSettingsBtn").click();
  await page.setInputFiles("#settingsImportFile", SAMPLE);
  await waitUserCount(page, 3); // テスト医師 + テスト太郎 + テスト花子

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#ioDeviceSaveBtn").click(),
  ]);
  const savedPath = await download.path();

  // 書き出したファイルの中身を検証 (形式・全ユーザー・患者データ)
  const archive = JSON.parse(readFileSync(savedPath, "utf8"));
  expect(archive.format).toBe("hospital-rounds-device-archive");
  const names = archive.users.map((u) => u.name);
  for (const n of ["テスト医師", "テスト太郎", "テスト花子"]) expect(names).toContain(n);
  const patients = archive.users.flatMap((u) => u.workspaces.flatMap((w) => w.patients));
  expect(patients.some((p) => p.name === "田中 一郎")).toBeTruthy();

  // --- 端末2 (まっさらな別 context): 書き出したファイルから復元 ---
  const ctx2 = await browser.newContext({ baseURL: BASE, serviceWorkers: "block" });
  const p2 = await ctx2.newPage();
  p2.on("dialog", (d) => d.accept());
  await boot(p2, "別端末担当");
  await p2.locator("#headerSettingsBtn").click();
  await p2.setInputFiles("#settingsImportFile", savedPath);
  await waitUserCount(p2, 4); // 別端末担当 + 取り込んだ3人

  // ユーザーピッカーに取り込んだユーザーが戻っている
  await p2.locator("#appUserChevron").click();
  await expect(p2.locator("#userPickerList")).toContainText("テスト太郎");
  await expect(p2.locator("#userPickerList")).toContainText("テスト花子");

  await ctx2.close();
});
