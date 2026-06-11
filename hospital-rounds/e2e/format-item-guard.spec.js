import { test, expect } from "@playwright/test";
import { boot, goToHome, goToSettings, openPatient, inlineEditSet } from "./helpers.js";

// 設定側のフォーマット項目編集ガード (患者データの index ずれ・消失防止):
//  - 入力済みデータがある item index は削除できない / 種類 (kind) を変更できない。
//  - 入力済み index より前の item も削除できない (splice で後方の入力がずれるため)。
//  - 入力済みデータがある format は項目の並び替えもできない。
//  - ラベル名の変更だけは許可される (データは index 紐付けなのでずれない)。
// 既定バイタル (O) の items: [BP, P, SpO2, RR, T] — SpO2 = index 2 に入力して検査する。

const MOBILE = { width: 390, height: 844 };

// SpO2 (バイタル 3 番目の item) に値を入れて入力済みデータを作る。
async function fillSpO2(page) {
  await goToHome(page);
  await openPatient(page, 0);
  const vitals = page.locator("#oExpanded .formatExpanded").first();
  await inlineEditSet(page, vitals.locator(".formatCardValue").nth(2), { value: "96" });
  await expect(vitals.locator(".formatCardValue").nth(2)).toContainText("96");
}

// 設定からバイタルの編集モーダルを開く。入力済み index の横断収集 (async) が
// fail-closed を解くまで一拍待つ (収集完了前は全操作ブロック)。
async function openVitalsEdit(page) {
  await goToSettings(page);
  const row = page.locator("#setFormats_O .formatListRow", { hasText: "バイタル" });
  await row.locator(".iconBtn").first().click();
  await expect(page.locator("#formatEditOverlay")).toHaveClass(/active/);
  await page.waitForTimeout(300);
  return page.locator("#formatEditItems .formatEditItemRow");
}

test("入力済み item は削除/種類変更できず、前方の item も削除できない (index ずれ防止)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await fillSpO2(page);
  const rows = await openVitalsEdit(page);
  await expect(rows).toHaveCount(5);

  // SpO2 (index 2 = 入力あり) の削除 → ブロック (行数は変わらない)
  await rows.nth(2).locator(".formatEditItemDel").click();
  await expect(page.locator(".appToast.show")).toContainText("入力済みデータがあるため削除できません");
  await expect(rows).toHaveCount(5);

  // BP (index 0 = 入力なしだが SpO2 より前) の削除 → 並びがずれるのでブロック
  await rows.nth(0).locator(".formatEditItemDel").click();
  await expect(page.locator(".appToast.show")).toContainText("並び順がずれます");
  await expect(rows).toHaveCount(5);

  // SpO2 の種類変更 → ブロック (select は元の kind に戻る)
  await rows.nth(2).locator(".formatEditItemKind").selectOption("text");
  await expect(page.locator(".appToast.show")).toContainText("種類を変更できません");
  await expect(rows.nth(2).locator(".formatEditItemKind")).toHaveValue("number");

  // T (index 4 = 入力済み index より後ろ) の削除は許可される
  await rows.nth(4).locator(".formatEditItemDel").click();
  await expect(rows).toHaveCount(4);
});

test("入力済みデータがあってもラベル名の変更は許可され、患者の値は残る", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await fillSpO2(page);
  const rows = await openVitalsEdit(page);
  await rows.nth(2).locator(".formatEditItemLabel").fill("SpO2室内気");
  await page.locator("#formatEditSaveBtn").click();
  await expect(page.locator("#formatEditOverlay")).not.toHaveClass(/active/);
  // 患者画面: ラベルが変わり、入力済みの値 96 はそのまま (index 紐付けなのでずれない)
  await goToHome(page);
  await openPatient(page, 0);
  const vitals = page.locator("#oExpanded .formatExpanded").first();
  await expect(vitals.locator(".formatCardItemLabel").nth(2)).toHaveText("SpO2室内気");
  await expect(vitals.locator(".formatCardValue").nth(2)).toContainText("96");
});

test("入力済み number item のラベルを空にして保存しても項目は脱落しない (保存ブロック)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await fillSpO2(page);
  const rows = await openVitalsEdit(page);
  // SpO2 のラベルを空に → 保存時の自動除外 (number はラベル必須) が index ずれになるため保存を中断
  await rows.nth(2).locator(".formatEditItemLabel").fill("");
  await page.locator("#formatEditSaveBtn").click();
  await expect(page.locator(".appToast.show")).toContainText("削除できません");
  await expect(page.locator("#formatEditOverlay")).toHaveClass(/active/); // モーダルは開いたまま
  // ラベルを戻せば保存できる
  await rows.nth(2).locator(".formatEditItemLabel").fill("SpO2");
  await page.locator("#formatEditSaveBtn").click();
  await expect(page.locator("#formatEditOverlay")).not.toHaveClass(/active/);
});

test("入力済みデータがあるフォーマットは項目をドラッグしても並び替わらない", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await fillSpO2(page);
  const rows = await openVitalsEdit(page);
  // SpO2 (index 2) のハンドルを BP (index 0) の位置へドラッグ
  const handle = rows.nth(2).locator(".formatEditItemHandle");
  const hb = await handle.boundingBox();
  const tb = await rows.nth(0).boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 8 });
  await page.mouse.up();
  // ブロック通知が出て、順序は変わらない (BP が先頭・SpO2 が 3 番目のまま)
  await expect(page.locator(".appToast.show")).toContainText("並び替えはできません");
  await expect(rows.nth(0).locator(".formatEditItemLabel")).toHaveValue("BP");
  await expect(rows.nth(2).locator(".formatEditItemLabel")).toHaveValue("SpO2");
});

test("入力データが無ければ削除・種類変更は従来どおり可能", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  const rows = await openVitalsEdit(page);
  await expect(rows).toHaveCount(5);
  // 種類変更 OK (toast は出ず select が変わる)
  await rows.nth(2).locator(".formatEditItemKind").selectOption("text");
  await expect(rows.nth(2).locator(".formatEditItemKind")).toHaveValue("text");
  // 削除 OK
  await rows.nth(2).locator(".formatEditItemDel").click();
  await expect(rows).toHaveCount(4);
});
