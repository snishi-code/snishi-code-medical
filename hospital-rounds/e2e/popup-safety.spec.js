import { test, expect } from "@playwright/test";
import { boot, goToHome, goToSettings, openPatient } from "./helpers.js";

// ポップアップ / inline 編集 ライフサイクル安全化:
//  - 戻る操作はまず開いている一時ポップアップ / 展開カードの inline 編集を閉じ、画面遷移しない
//    (患者入力が画面/患者をまたがない)。
//  - 患者画面に入場した「同じタップ」のゴーストクリックでは inline 編集に入らない (誤タップ防止)。
//  - ポップアップ (複数欄) は開いた瞬間に自動フォーカスしない (触っていない欄にキーボードが
//    飛び出さない)。

const MOBILE = { width: 390, height: 844 };

// S カードの値セルを明示タップして inline 編集に入る (pointerdown を伴う正規クリック)。
async function openSInlineEdit(page) {
  await page.locator("#sExpanded .formatExpanded .formatCardValue").first().click();
  await expect(page.locator("#sExpanded .formatCardItem.editing")).toHaveCount(1);
}

test("inline 編集を開く→端末戻る→編集だけ閉じ、detail のまま", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await openSInlineEdit(page);
  // 端末戻る → inline 編集だけ閉じ、画面遷移しない
  await page.goBack();
  await expect(page.locator(".formatCardItem.editing")).toHaveCount(0);
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

test("患者画面入場直後のゴーストクリックでは inline 編集に入らない (明示タップでは入る)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  const card = page.locator("#sExpanded .formatExpanded .formatCardValue").first();
  // pointerdown を伴わない合成 click (= 遷移ジェスチャーのゴーストクリック相当) → 編集に入らない
  await card.dispatchEvent("click");
  await expect(page.locator(".formatCardItem.editing")).toHaveCount(0);
  // 明示タップ (pointerdown を伴う正規クリック) → 編集に入る
  await card.click();
  await expect(page.locator("#sExpanded .formatCardItem.editing")).toHaveCount(1);
});

test("ポップアップを開いても自動フォーカスされない (フォーマット編集モーダル)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToSettings(page);
  // O「バイタル」フォーマットを編集で開く (名前/区切り/項目/タグ を持つ複数欄ポップアップ)
  const row = page.locator("#setFormats_O .formatListRow", { hasText: "バイタル" });
  await row.locator(".iconBtn").first().click(); // 編集ボタン (先頭の iconBtn)
  await expect(page.locator("#formatEditOverlay")).toHaveClass(/active/);
  // 開いただけでは入力欄に focus が入らない (active 要素は input/textarea でない)
  const activeTag = await page.evaluate(() => (document.activeElement && document.activeElement.tagName) || "");
  expect(["INPUT", "TEXTAREA"]).not.toContain(activeTag);
});
