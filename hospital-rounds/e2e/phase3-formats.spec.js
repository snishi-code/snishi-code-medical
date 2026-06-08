import { test, expect } from "@playwright/test";
import { boot, goToHome, openPatient } from "./helpers.js";

// Phase 3: タップ中心の S/O/A/P 入力。各パネルに既定フォーマットカードが出て、タップした
// normal 文が QR 平文へ入る。未タップ欄は空 (fallback 撤去)。既存自由記述は互換で残る。

async function openQrPreview(page) {
  await page.locator("#qrToggleBtn").click();
  await expect(page.locator("#qrWrap")).toHaveClass(/active/);
}

test("新規患者で S/O/A/P 各欄に既定フォーマットカードが表示される", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  for (const host of ["#sExpanded", "#oExpanded", "#aExpanded", "#pExpanded"]) {
    await expect(page.locator(`${host} .formatExpanded`).first()).toBeVisible();
  }
});

test("S の正常をタップすると QR 平文に入り、未タップ P は入らない (fallback 撤去)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // S の既定カード「自覚症状」の正常ボタンをタップ
  await page.locator("#sExpanded .formatExpanded .formatInputNormalBtn").first().click();
  await openQrPreview(page);
  const qr = await page.locator("#qrTextPreview").textContent();
  expect(qr).toContain("特に新しい訴えなし");      // タップした S は出る
  expect(qr).not.toContain("現治療を継続");          // 未タップ P の既定文は出ない
});

test("既存自由記述 (補足メモ) は QR 平文に残る (互換)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await page.locator("#sText").fill("既存メモ互換テスト");
  await openQrPreview(page);
  const qr = await page.locator("#qrTextPreview").textContent();
  expect(qr).toContain("既存メモ互換テスト");
});

test("ラベルなし text item は左詰め (ラベル列が畳まれる)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // S 既定「自覚症状」は label 空 → ラベル要素は formatInputLabelEmpty で非表示
  const emptyLabel = page.locator("#sExpanded .formatExpanded .formatInputLabelEmpty").first();
  await expect(emptyLabel).toHaveCount(1);
  await expect(emptyLabel).toBeHidden();
});
