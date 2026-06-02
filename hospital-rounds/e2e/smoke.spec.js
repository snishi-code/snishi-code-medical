import { test, expect } from "@playwright/test";

// 起動 → 初回オンボーディング(名前+同意)を完了 の共通前処理。
// 各テストはまっさらな context で走るので、毎回オンボーディングから始まる。
async function boot(page, name = "テスト医師") {
  await page.goto("/");
  const ob = page.locator("#onboardingOverlay");
  await ob.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  if (await ob.isVisible().catch(() => false)) {
    await page.locator("#onboardingNameInput").fill(name);
    await page.locator("#onboardingStartBtn").click();
  }
  // 免責はオンボーディングで抑止されるが、念のため
  const disc = page.locator("#disclaimerCloseBtn");
  if (await disc.isVisible().catch(() => false)) await disc.click();
  await expect(page.locator("#appTitleInput")).toHaveValue(name);
}

test("初回オンボーディングで名前を登録するとヘッダーに反映される", async ({ page }) => {
  await boot(page, "テスト医師");
  await expect(page.locator("#appUserChevron")).toBeVisible();
  // 再読込してもオンボーディングは出ない（登録済み）
  await page.reload();
  await expect(page.locator("#onboardingOverlay")).not.toHaveClass(/active/);
  await expect(page.locator("#appTitleInput")).toHaveValue("テスト医師");
});
