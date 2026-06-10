import { test, expect } from "@playwright/test";
import { boot, goToHome, openPatient } from "./helpers.js";

// ポップアップ ライフサイクル安全化:
//  - 戻る操作はまず開いているポップアップを閉じ、画面遷移しない (患者入力が画面/患者をまたがない)。
//  - 患者画面に入場した「同じタップ」のゴーストクリックでは入力シートを開かない (誤タップ防止)。

const MOBILE = { width: 390, height: 844 };

// S カードの値セルを明示タップして入力シートを開く (pointerdown を伴う正規クリック)。
async function openSSheet(page) {
  await page.locator("#sExpanded .formatExpanded .formatCardValue").first().click();
  await expect(page.locator("#formatInputOverlay")).toHaveClass(/active/);
}

test("入力シートを開く→端末戻る→シートだけ閉じ、detail のまま", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await openSSheet(page);
  // 端末戻る → 入力シートだけ閉じ、画面遷移しない
  await page.goBack();
  await expect(page.locator("#formatInputOverlay")).not.toHaveClass(/active/);
  await expect(page.locator("#detailView")).toHaveClass(/active/);
  // もう一度戻る → 通常の戻る (ホームへ)
  await page.goBack();
  await expect(page.locator("#homeView")).toHaveClass(/active/);
});

test("QRポップアップを開く→端末戻る→QRだけ閉じ、detail のまま", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await page.locator("#qrToggleBtn").click();
  await expect(page.locator("#detailQrOverlay")).toHaveClass(/active/);
  await page.goBack();
  await expect(page.locator("#detailQrOverlay")).not.toHaveClass(/active/);
  await expect(page.locator("#detailView")).toHaveClass(/active/);
});

test("患者画面入場直後のゴーストクリックでは入力シートが開かない (明示タップでは開く)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  const card = page.locator("#sExpanded .formatExpanded .formatCardValue").first();
  // pointerdown を伴わない合成 click (= 遷移ジェスチャーのゴーストクリック相当) → 開かない
  await card.dispatchEvent("click");
  await expect(page.locator("#formatInputOverlay")).not.toHaveClass(/active/);
  // 明示タップ (pointerdown を伴う正規クリック) → 開く
  await card.click();
  await expect(page.locator("#formatInputOverlay")).toHaveClass(/active/);
});

test("自動フォーカスしない (入力シートを開いてもキーボード入力欄に focus が入らない)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await openSSheet(page);
  // 開いただけでは入力欄に focus が入らない (active 要素は input/textarea でない)
  const activeTag = await page.evaluate(() => (document.activeElement && document.activeElement.tagName) || "");
  expect(["INPUT", "TEXTAREA"]).not.toContain(activeTag);
});
