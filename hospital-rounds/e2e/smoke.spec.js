import { test, expect } from "@playwright/test";

// 起動 → 免責ダイアログを閉じる の共通前処理。
// 各テストはまっさらな context で走るので、毎回 backfill で初期ユーザー「ユーザー1」ができる。
async function boot(page) {
  await page.goto("/");
  const ok = page.locator("#disclaimerCloseBtn");
  await ok.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  if (await ok.isVisible().catch(() => false)) await ok.click();
}

test("起動するとヘッダーに初期ユーザー「ユーザー1」が表示される", async ({ page }) => {
  await boot(page);
  await expect(page.locator("#appTitleInput")).toHaveValue("ユーザー1");
  await expect(page.locator("#appUserChevron")).toBeVisible();
});
