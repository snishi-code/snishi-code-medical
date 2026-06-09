import { test, expect } from "@playwright/test";
import { boot, goToHome, openPatient, openPatientSheet, closePatientSheet } from "./helpers.js";

// Phase 6 P2: 患者画面ヘッダーの戻す/進む (患者ごと・操作単位) と、フォーマットセット選択の
// 患者シートへの移設。Undo は「今開いている患者の入力」だけを 1 操作ずつ戻す/進む。

test("ヘッダーからセット切替が消え、戻す/進むボタンがある (初期は disabled)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);

  // 旧セット切替トグルは撤去
  await expect(page.locator("#detailFormatGroupBtn")).toHaveCount(0);
  // 戻す/進むボタンがあり、履歴が無いので disabled
  await expect(page.locator("#detailUndoBtn")).toBeVisible();
  await expect(page.locator("#detailRedoBtn")).toBeVisible();
  await expect(page.locator("#detailUndoBtn")).toBeDisabled();
  await expect(page.locator("#detailRedoBtn")).toBeDisabled();
});

test("フォーマットセット選択が患者シート内に移設されている", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);

  await openPatientSheet(page);
  const setBtn = page.locator("#patientMetaOverlay .patientSheetSetBtn");
  await expect(setBtn).toBeVisible();
  // タップで患者シートは閉じ、フォーマットグループピッカーが開く (重なり回避)
  await setBtn.click();
  await expect(page.locator("#patientMetaOverlay")).not.toHaveClass(/active/);
  await expect(page.locator("#formatGroupPickerOverlay")).toHaveClass(/active/);
  // 行を選ぶとピッカーは閉じる (単一選択)
  await page.locator("#formatGroupPickerList .formatGroupPickerRow").first().click();
  await expect(page.locator("#formatGroupPickerOverlay")).not.toHaveClass(/active/);
});

test("戻す/進むがフォーマット入力を 1 操作ずつ戻す・やり直す", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);

  const phys = page.locator("#oExpanded .formatExpanded", { hasText: "身体所見" });
  const firstRow = phys.locator(".formatCardItem").first(); // General (normal=良好)
  const val = firstRow.locator(".formatCardValue");

  // 空欄 → ワンタップ正常文入力
  await firstRow.locator(".formatCardNormalBtn").click();
  await expect(val).toHaveText("良好");
  await expect(page.locator("#detailUndoBtn")).toBeEnabled();

  // 戻す → 空欄に戻り、進むが有効・戻すが無効
  await page.locator("#detailUndoBtn").click();
  await expect(val).toHaveClass(/empty/);
  await expect(page.locator("#detailUndoBtn")).toBeDisabled();
  await expect(page.locator("#detailRedoBtn")).toBeEnabled();

  // 進む → 再び「良好」、戻すが有効
  await page.locator("#detailRedoBtn").click();
  await expect(val).toHaveText("良好");
  await expect(page.locator("#detailUndoBtn")).toBeEnabled();
});

test("Undoはフォーマット入力だけ戻し、患者識別情報(氏名)は巻き戻さない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);

  const phys = page.locator("#oExpanded .formatExpanded", { hasText: "身体所見" });
  const firstRow = phys.locator(".formatCardItem").first(); // General
  const val = firstRow.locator(".formatCardValue");

  // フォーマット入力 (Undo 起点) を作る
  await firstRow.locator(".formatCardNormalBtn").click();
  await expect(val).toHaveText("良好");

  // その後、患者シートで氏名を変更 (これは Undo 履歴に積まれない)
  await openPatientSheet(page);
  await page.locator("#patientMetaOverlay .patientSheetNameInput").fill("山田太郎");
  await closePatientSheet(page);
  await expect(page.locator("#detailPatientMetaBtn")).toContainText("山田太郎");

  // Undo → フォーマットは空欄へ戻るが、氏名はそのまま (PII を巻き戻さない)
  await page.locator("#detailUndoBtn").click();
  await expect(val).toHaveClass(/empty/);
  await expect(page.locator("#detailPatientMetaBtn")).toContainText("山田太郎");
});

test("戻す履歴は患者ごとに独立 (別患者を開くと履歴は届かない)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);

  // 患者0を編集 (戻すが有効になる)
  await openPatient(page, 0);
  await page.locator("#oExpanded .formatExpanded", { hasText: "身体所見" })
    .locator(".formatCardItem").first().locator(".formatCardNormalBtn").click();
  await expect(page.locator("#detailUndoBtn")).toBeEnabled();

  // 患者1へ切替 → その患者は未編集なので戻すは無効 (患者0の入力は裏で戻らない)
  await goToHome(page);
  await openPatient(page, 1);
  await expect(page.locator("#detailUndoBtn")).toBeDisabled();
  await expect(page.locator("#detailRedoBtn")).toBeDisabled();

  // 患者0へ戻ると履歴は保持されていて、引き続き戻せる
  await goToHome(page);
  await openPatient(page, 0);
  await expect(page.locator("#detailUndoBtn")).toBeEnabled();
});
