import { test, expect } from "@playwright/test";
import { boot, goToHome, goToSettings, openPatient, createHamburgerFormat } from "./helpers.js";

// ポップアップの高さ・スクロール・下部アクション到達性 (.popupMenu 共通基盤):
//  - .popupMenu は viewport を超えず (max-height: calc(100dvh - 24px))、内容は内部スクロール。
//  - 編集系の .formatEditActions は sticky footer で、登録フォーマット/項目が増えても
//    QR共有/キャンセル/保存が見切れず常に押せる。

// S パネルにフォーマットを n 個作って、セット編集の一覧を viewport より長くする。
async function seedManyFormats(page, n) {
  await goToHome(page);
  await openPatient(page, 0);
  for (let i = 1; i <= n; i++) {
    await createHamburgerFormat(page, { strip: "#sFormatStrip", name: `多数${i}`, label: `項目${i}` });
  }
}

// 設定画面からデフォルトセットの編集モーダルを開く。
async function openGroupEdit(page) {
  await goToSettings(page);
  await page.locator("#setFormatGroups .formatListRow").first().locator(".iconBtn").first().click();
  await expect(page.locator("#formatGroupEditOverlay")).toHaveClass(/active/);
}

for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 640 }]) {
  test(`セット編集: フォーマット多数でも保存/キャンセルが見切れず押せる (${vp.width}x${vp.height})`, async ({ page }) => {
    await page.setViewportSize(vp);
    await boot(page);
    await seedManyFormats(page, 12);
    await openGroupEdit(page);
    const menu = page.locator("#formatGroupEditOverlay .formatGroupEditMenu");
    // メニュー自体は viewport に収まり、中身は内部スクロールになっている
    const m = await menu.boundingBox();
    expect(m.height).toBeLessThanOrEqual(vp.height);
    expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    // sticky footer: スクロールしなくても保存/キャンセルが viewport 内に見えている
    for (const id of ["#formatGroupEditSaveBtn", "#formatGroupEditCancelBtn"]) {
      await expect(page.locator(id)).toBeVisible();
      const bb = await page.locator(id).boundingBox();
      expect(bb.y).toBeGreaterThanOrEqual(0);
      expect(bb.y + bb.height).toBeLessThanOrEqual(vp.height + 1);
    }
    // 本文は下端 (最後のフォーマット行) までスクロールで到達できる
    const lastRow = page.locator("#formatGroupEditFormats .formatGroupEditRow, #formatGroupEditFormats > *").last();
    await lastRow.scrollIntoViewIfNeeded();
    await expect(lastRow).toBeVisible();
    // 実際に保存できる (overlay が閉じる)
    await page.locator("#formatGroupEditSaveBtn").click();
    await expect(page.locator("#formatGroupEditOverlay")).not.toHaveClass(/active/);
  });
}

test("セット編集: キャンセルも到達でき、背景タップ閉じは従来どおり (390x844)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await seedManyFormats(page, 12);
  await openGroupEdit(page);
  await page.locator("#formatGroupEditCancelBtn").click();
  await expect(page.locator("#formatGroupEditOverlay")).not.toHaveClass(/active/);
  // 背景タップ閉じ (既存挙動の不変確認)
  await openGroupEdit(page);
  await page.locator("#formatGroupEditOverlay").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#formatGroupEditOverlay")).not.toHaveClass(/active/);
});

test("フォーマット編集: 項目を大量追加しても保存ボタンに到達してそのまま保存できる (360x640)", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await boot(page);
  await goToSettings(page);
  const row = page.locator("#setFormats_O .formatListRow", { hasText: "身体所見" });
  await row.locator(".iconBtn").first().click();
  await expect(page.locator("#formatEditOverlay")).toHaveClass(/active/);
  for (let i = 0; i < 12; i++) await page.locator("#formatEditAddItemBtn").click();
  // sticky footer で保存が viewport 内に見えている
  const bb = await page.locator("#formatEditSaveBtn").boundingBox();
  expect(bb.y + bb.height).toBeLessThanOrEqual(641);
  // 入力済みデータ index の収集 (async fail-closed) を待ってから保存
  // (空 text 項目は保存時に自動除外される = 削除扱いの判定が走るため)。
  await page.waitForTimeout(300);
  await page.locator("#formatEditSaveBtn").click();
  await expect(page.locator("#formatEditOverlay")).not.toHaveClass(/active/);
});
