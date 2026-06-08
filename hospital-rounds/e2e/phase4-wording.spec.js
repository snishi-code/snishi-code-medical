import { test, expect } from "@playwright/test";
import { boot, goToHome, goToSettings, openPatient } from "./helpers.js";

// Phase 4: QR 受信導線の文言が「カメラ / 貼り付け」前提になっていること、患者画面 QR が
// 平文 (電子カルテ貼付用) であることを画面側でも確認する。

test("QR から追加の受信オーバーレイは カメラ + 貼り付け を案内し、リーダー を出さない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToSettings(page);
  await page.locator("#qrReceiveOpenBtn").click();
  await expect(page.locator("#qrReceiveOverlay")).toHaveClass(/active/);
  const hint = page.locator("#qrReceiveOverlay .qrTextRecvHint");
  await expect(hint).toContainText("カメラ");
  await expect(hint).toContainText("貼り付け");
  await expect(hint).not.toContainText("リーダー");
});

test("患者画面 QR プレビューは平文 (SOAP テキスト、暗号化 prefix なし)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await page.locator("#qrToggleBtn").click();
  await expect(page.locator("#qrWrap")).toHaveClass(/active/);
  const preview = (await page.locator("#qrTextPreview").textContent()) || "";
  // 平文 = SOAP マーカーがそのまま見える
  expect(preview).toContain("(S)");
  expect(preview).toContain("(P)");
  // 暗号化/圧縮 transport prefix (E1/E2/C1) が付いていない
  expect(preview.startsWith("E1:")).toBe(false);
  expect(preview.startsWith("E2:")).toBe(false);
  expect(preview.startsWith("C1:")).toBe(false);
});
