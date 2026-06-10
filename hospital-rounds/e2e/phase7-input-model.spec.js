import { test, expect } from "@playwright/test";
import { boot, goToHome, goToMemo, goToShared, openPatient } from "./helpers.js";

// Phase 7: 患者入力モデル6パネル化。プロブレムリスト (problem) と共有 (shared) も
// settings.formats + formatValues に集約。患者画面QR は problem/S/O/A/P を出し shared は出さない。
// プロブレム/共有の一覧画面は読み取り表示 + タップで患者画面へ。number/fraction の注記は
// 改行可能な textarea。

const MOBILE = { width: 390, height: 844 };

async function openQrPreview(page) {
  await page.locator("#qrToggleBtn").click();
  await expect(page.locator("#detailQrOverlay")).toHaveClass(/active/);
}

// problem カードの先頭 # 番号セルをタップ → 入力シートで value/note を入れて保存。
async function enterProblem(page, value, note) {
  const card = page.locator("#problemExpanded .formatExpanded").first();
  await card.locator(".formatCardValue").first().click();
  await expect(page.locator("#formatInputOverlay")).toHaveClass(/active/);
  const row0 = page.locator("#formatInputBody .formatInputRow").first();
  await row0.locator(".formatInputValue").fill(value);
  await row0.locator(".formatInputMemo").fill(note);
  await page.locator("#formatInputApplyBtn").click();
  await expect(page.locator("#formatInputOverlay")).not.toHaveClass(/active/);
}

// shared カードのテキストセルをタップ → 入力シートで本文を入れて保存。
async function enterShared(page, text) {
  const card = page.locator("#sharedExpanded .formatExpanded").first();
  await card.locator(".formatCardValue").first().click();
  await expect(page.locator("#formatInputOverlay")).toHaveClass(/active/);
  await page.locator("#formatInputBody .formatInputRow .formatInputText").first().fill(text);
  await page.locator("#formatInputApplyBtn").click();
  await expect(page.locator("#formatInputOverlay")).not.toHaveClass(/active/);
}

test("患者画面に problem/S/O/A/P/shared の6パネルカードが出る", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  for (const host of ["#problemExpanded", "#sExpanded", "#oExpanded", "#aExpanded", "#pExpanded", "#sharedExpanded"]) {
    await expect(page.locator(`${host} .formatExpanded`).first()).toBeVisible();
  }
});

test("プロブレムに #1 HF を入力すると患者画面QRに出る", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await enterProblem(page, "1", "HF");
  // カード表示に反映
  await expect(page.locator("#problemExpanded .formatExpanded").first().locator(".formatCardValue").first())
    .toContainText("1 HF");
  // 患者画面QR平文に #1 HF が出る
  await openQrPreview(page);
  expect(await page.locator("#qrTextPreview").textContent()).toContain("#1 HF");
});

test("共有に入力しても患者画面QRには出ない (shared は共有QR専用)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await enterShared(page, "院外申し送り事項");
  // shared カードに反映
  await expect(page.locator("#sharedExpanded .formatExpanded").first().locator(".formatCardValue").first())
    .toContainText("院外申し送り事項");
  // 患者画面QRには出ない
  await openQrPreview(page);
  expect(await page.locator("#qrTextPreview").textContent()).not.toContain("院外申し送り事項");
});

test("プロブレム/共有の一覧は読み取り表示 + タップで患者画面へ", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // 複数行 note を入れて改行表示を確認する
  await enterProblem(page, "1", "HF\n増悪傾向");
  // プロブレムリスト一覧へ: 読み取り本文に #1 HF と 2 行目が出る (改行表示が崩れない)
  await goToMemo(page);
  const body = page.locator("#memoListHost .memoRow.read .memoRowBody").first();
  await expect(body).toContainText("#1 HF");
  await expect(body).toContainText("増悪傾向");
  // 本文タップで患者画面へ遷移
  await body.click();
  await expect(page.locator("#detailView")).toHaveClass(/active/);
});

test("共有一覧も読み取り表示で本文が出る", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await enterShared(page, "リハ継続で申し送り");
  await goToShared(page);
  const body = page.locator("#sharedListHost .memoRow.read .memoRowBody").first();
  await expect(body).toContainText("リハ継続で申し送り");
});

test("注記欄 (note) は textarea で改行でき、内容に応じて縦に伸びる", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // O「バイタル」(1枚目) の SpO2 セル (3番目) をタップ → シート
  const vitals = page.locator("#oExpanded .formatExpanded").first();
  await vitals.locator(".formatCardValue").nth(2).click();
  await expect(page.locator("#formatInputOverlay")).toHaveClass(/active/);
  const note = page.locator("#formatInputBody .formatInputRow").nth(2).locator(".formatInputMemo");
  // note は textarea (旧 input ではない)
  await expect(note).toHaveJSProperty("tagName", "TEXTAREA");
  // 1 行のときの高さ
  await note.fill("O2 2L");
  const h1 = (await note.boundingBox()).height;
  // 複数行にすると縦に伸びる (field-sizing:content)
  await note.fill("O2 2L\nマスク\nネブライザ併用");
  const h3 = (await note.boundingBox()).height;
  expect(h3).toBeGreaterThan(h1);
  // 改行が保持されている
  expect(await note.inputValue()).toContain("\n");
});
