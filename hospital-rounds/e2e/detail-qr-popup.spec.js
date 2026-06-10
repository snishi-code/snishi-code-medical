import { test, expect } from "@playwright/test";
import { boot, goToHome, openPatient } from "./helpers.js";

// 患者画面QR (電子カルテ転記用) はインライン展開ではなくポップアップで表示する。
// 本文プレビューは折りたたみ (初期はQR本体が主役)。× / 背景タップで閉じる。

const MOBILE = { width: 390, height: 844 };

test("QRボタンでポップアップが開き、本文プレビューは折りたたみ・×で閉じる", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // S に正常を入れる (QR 本文に出る)
  await page.locator("#sExpanded .formatExpanded .formatCardNormalBtn").first().click();

  const overlay = page.locator("#detailQrOverlay");
  await expect(overlay).not.toHaveClass(/active/);

  // ボタンで開く → ポップアップが active・QR canvas が見える
  await page.locator("#qrToggleBtn").click();
  await expect(overlay).toHaveClass(/active/);
  await expect(page.locator("#detailQrOverlay #qrCanvas")).toBeVisible();

  // 本文プレビューは折りたたみ (details 閉) → 本文は初期非表示だが内容は最新
  await expect(page.locator("#detailQrOverlay .qrPreviewDetails")).toBeVisible();
  await expect(page.locator("#qrTextPreview")).not.toBeVisible();
  expect(await page.locator("#qrTextPreview").textContent()).toContain("特に新しい訴えなし");

  // 折りたたみを開くと本文が見える
  await page.locator("#detailQrOverlay .qrPreviewDetails > summary").click();
  await expect(page.locator("#qrTextPreview")).toBeVisible();

  // × で閉じる
  await page.locator("#detailQrOverlay .popupCloseX").click();
  await expect(overlay).not.toHaveClass(/active/);
});

test("QRを閉じて再度開くと最新内容で再描画される", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);

  // 1回目: S 正常 → 開く
  await page.locator("#sExpanded .formatExpanded .formatCardNormalBtn").first().click();
  await page.locator("#qrToggleBtn").click();
  await expect(page.locator("#detailQrOverlay")).toHaveClass(/active/);
  expect(await page.locator("#qrTextPreview").textContent()).toContain("特に新しい訴えなし");

  // 閉じる (背景の患者画面を操作するため)
  await page.locator("#detailQrOverlay .popupCloseX").click();
  await expect(page.locator("#detailQrOverlay")).not.toHaveClass(/active/);

  // A 正常を追加
  await page.locator("#aExpanded .formatExpanded .formatCardNormalBtn").first().click();

  // 再度開く → 最新 (S + A)
  await page.locator("#qrToggleBtn").click();
  await expect(page.locator("#detailQrOverlay")).toHaveClass(/active/);
  const txt = await page.locator("#qrTextPreview").textContent();
  expect(txt).toContain("特に新しい訴えなし");
  expect(txt).toContain("全身状態は安定");
});

test("背景タップでQRポップアップが閉じる (グローバルハンドラ)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await page.locator("#qrToggleBtn").click();
  await expect(page.locator("#detailQrOverlay")).toHaveClass(/active/);
  // overlay の背景 (左上隅 = .popupMenu の外) をタップ → 閉じる
  await page.locator("#detailQrOverlay").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#detailQrOverlay")).not.toHaveClass(/active/);
});
