import { test, expect } from "@playwright/test";
import { boot, goToHome, openPatient } from "./helpers.js";

// 分数(fraction)入力モード: item ごとに数字/文字キーボードを選べる。
// 既定バイタルの BP は数字入力(fracMode=numeric)、抗菌薬等の英字混在は文字入力。
// 展開カードは値セルをタップして「その場 (inline)」で編集する (ポップアップは開かない)。

const MOBILE = { width: 390, height: 844 };

test("既定 BP の分数入力は数字キーボード (inline 編集でも inputmode=numeric)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // O「バイタル」カードの BP セル(1番目) をタップ → その行が inline 編集状態に
  const vitals = page.locator("#oExpanded .formatExpanded").first();
  await vitals.locator(".formatCardValue").first().click();
  // ポップアップ入力シートは開かない (inline 編集)
  await expect(page.locator("#formatInputOverlay")).not.toHaveClass(/active/);
  const editing = vitals.locator(".formatCardItem.editing");
  // 分数の左右 input が数字キーボード (setupNumericInput → inputmode=numeric)
  await expect(editing.locator(".formatInputFracNumer")).toHaveAttribute("inputmode", "numeric");
  await expect(editing.locator(".formatInputFracDenom")).toHaveAttribute("inputmode", "numeric");
  // 数値を入れて保存 → 従来どおり "左/右 単位" 形式で QR に出る (出力は不変)
  await editing.locator(".formatInputFracNumer").fill("120");
  await editing.locator(".formatInputFracDenom").fill("80");
  await editing.locator(".formatCardEditSave").click();
  await page.locator("#qrToggleBtn").click();
  await expect(page.locator("#detailQrOverlay")).toHaveClass(/active/);
  expect(await page.locator("#qrTextPreview").textContent()).toContain("BP 120/80mmHg");
});
