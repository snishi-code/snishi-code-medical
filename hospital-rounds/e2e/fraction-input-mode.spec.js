import { test, expect } from "@playwright/test";
import { boot, goToHome, openPatient } from "./helpers.js";

// 分数(fraction)入力モード: item ごとに数字/文字キーボードを選べる。
// 既定バイタルの BP は数字入力(fracMode=numeric)、抗菌薬等の英字混在は文字入力。

const MOBILE = { width: 390, height: 844 };

test("既定 BP の分数入力は数字キーボード (inputmode=numeric)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // O「バイタル」カードの BP セル(1番目) をタップ → 入力シート
  const vitals = page.locator("#oExpanded .formatExpanded").first();
  await vitals.locator(".formatCardValue").first().click();
  await expect(page.locator("#formatInputOverlay")).toHaveClass(/active/);
  // 分数行の左右 input が数字キーボード (setupNumericInput → inputmode=numeric)
  const frac = page.locator("#formatInputBody .formatInputRow.fraction").first();
  await expect(frac.locator(".formatInputFracNumer")).toHaveAttribute("inputmode", "numeric");
  await expect(frac.locator(".formatInputFracDenom")).toHaveAttribute("inputmode", "numeric");
  // 数値を入れて保存 → 従来どおり "左/右 単位" 形式で QR に出る (出力は不変)
  await frac.locator(".formatInputFracNumer").fill("120");
  await frac.locator(".formatInputFracDenom").fill("80");
  await page.locator("#formatInputApplyBtn").click();
  await page.locator("#qrToggleBtn").click();
  await expect(page.locator("#qrWrap")).toHaveClass(/active/);
  expect(await page.locator("#qrTextPreview").textContent()).toContain("BP 120/80mmHg");
});
