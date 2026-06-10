import { test, expect } from "@playwright/test";
import {
  boot, goToHome, goToMemo, goToShared, goToSettings,
  openMainMenu, openPatient, createHamburgerFormat, openFormatSheetViaHamburger,
} from "./helpers.js";

// 戻る操作・履歴の中央化 (features/app-history.js):
//   端末の「戻る」を、一時ポップアップ → 患者画面 inline 編集 → memo/shared 鉛筆編集 →
//   通常 view 遷移 → home での終了確認、の優先順位で一貫処理する。
//   特に、やり直しで必須の 2 点を検証する:
//     #2 終了確認は Back 連打で bypass できない (OK 無しでアプリ外へ抜けない)。
//     #3 患者画面 inline 編集中の Back は inline だけ閉じ、画面遷移しない。

const MOBILE = { width: 390, height: 844 };

// S カードの値セルを明示タップして inline 編集に入る。
async function openSInlineEdit(page) {
  await page.locator("#sExpanded .formatExpanded .formatCardValue").first().click();
  await expect(page.locator("#sExpanded .formatCardItem.editing")).toHaveCount(1);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
});

// ---- 通常 view 遷移: 一段の戻るで home へ -----------------------------------
test("settings → 戻る → home", async ({ page }) => {
  await goToSettings(page);
  await page.goBack();
  await expect(page.locator("#homeView")).toHaveClass(/active/);
});

test("memo → 戻る → home", async ({ page }) => {
  await goToMemo(page);
  await page.goBack();
  await expect(page.locator("#homeView")).toHaveClass(/active/);
});

test("shared → 戻る → home", async ({ page }) => {
  await goToShared(page);
  await page.goBack();
  await expect(page.locator("#homeView")).toHaveClass(/active/);
});

// detail を開いて戻ると 1 段で home (同一 view を重ねて積まない dedupe の観測)。
test("detail → 戻る → home (1 段で戻る)", async ({ page }) => {
  await openPatient(page, 0);
  await page.goBack();
  await expect(page.locator("#homeView")).toHaveClass(/active/);
});

// ---- 一時ポップアップ: 戻るでまず閉じ、画面遷移しない ------------------------
test("≡ メインメニュー → 戻る → メニューだけ閉じ home のまま", async ({ page }) => {
  await openMainMenu(page);
  await page.goBack();
  await expect(page.locator("#mainMenuOverlay")).not.toHaveClass(/active/);
  await expect(page.locator("#homeView")).toHaveClass(/active/);
});

test("入力シート (☰ ランチャー) → 戻る → シートだけ閉じ detail のまま", async ({ page }) => {
  await openPatient(page, 0);
  await createHamburgerFormat(page, { strip: "#sFormatStrip", name: "追加メモ", label: "メモ" });
  await openFormatSheetViaHamburger(page, { strip: "#sFormatStrip", name: "追加メモ" });
  await page.goBack();
  await expect(page.locator("#formatInputOverlay")).not.toHaveClass(/active/);
  await expect(page.locator("#detailView")).toHaveClass(/active/);
});

// ---- #3 患者画面 inline 編集中の Back は inline だけ閉じる -------------------
test("#3 inline 編集 → 戻る → 編集だけ閉じ detail のまま → 次の戻るで home", async ({ page }) => {
  await openPatient(page, 0);
  await openSInlineEdit(page);
  await page.goBack();
  await expect(page.locator(".formatCardItem.editing")).toHaveCount(0);
  await expect(page.locator("#detailView")).toHaveClass(/active/);
  await page.goBack();
  await expect(page.locator("#homeView")).toHaveClass(/active/);
});

// ---- memo 鉛筆編集中の Back は編集だけ解除し、画面遷移しない -----------------
test("memo 鉛筆編集 → 戻る → 編集だけ解除し memo のまま", async ({ page }) => {
  await goToMemo(page);
  await page.locator("#memoEditBtn").click();
  await expect(page.locator("#memoEditBtn")).toHaveClass(/editActive/);
  await page.goBack();
  await expect(page.locator("#memoEditBtn")).not.toHaveClass(/editActive/);
  await expect(page.locator("#memoView")).toHaveClass(/active/);
});

// ---- home での終了確認: キャンセルで home に残る --------------------------------
test("home → 戻る → 終了確認 → キャンセル → home に残る", async ({ page }) => {
  await page.goBack();
  await expect(page.locator("#exitConfirmOverlay")).toHaveClass(/active/);
  await page.locator("#exitConfirmCancelBtn").click();
  await expect(page.locator("#exitConfirmOverlay")).not.toHaveClass(/active/);
  await expect(page.locator("#homeView")).toHaveClass(/active/);
});

// ---- #2 終了確認は Back 連打で bypass できない --------------------------------
test("#2 終了確認表示中に再び戻る → まだ終了せず確認は維持 (bypass 不可)", async ({ page }) => {
  await page.goBack();
  await expect(page.locator("#exitConfirmOverlay")).toHaveClass(/active/);
  // 確認表示中にもう一度戻る → OK 無しでは抜けない。確認は出たまま、ページは離脱しない。
  await page.goBack();
  await expect(page.locator("#exitConfirmOverlay")).toHaveClass(/active/);
  await expect(page.locator("#homeView")).toHaveClass(/active/);
  // 後始末: キャンセルで閉じる。
  await page.locator("#exitConfirmCancelBtn").click();
  await expect(page.locator("#exitConfirmOverlay")).not.toHaveClass(/active/);
});
