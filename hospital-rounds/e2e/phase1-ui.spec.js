import { test, expect } from "@playwright/test";
import { boot, goToHome, goToMemo, goToShared } from "./helpers.js";

// Phase 1: 老眼・スマホ不慣れ対応 UI の E2E。
// - スマホ幅でホームの患者ボタンが1列で並ぶ
// - 「患者を追加する」を押すと患者シートが開く / 部屋・氏名を入れて閉じると一覧に残る
// - プロブレムリスト/共有の末尾にも追加ボタンがある
// - プロブレムリスト/共有のスマホ幅で患者ボタンと本文が上下2段に並ぶ
// - 追加直後に部屋番号を入れても別患者に氏名・タグ・ステータスが書かれない (index 安全)

const MOBILE = { width: 390, height: 844 };

// モバイル幅で起動 → ホームまで。各テストはまっさらな context。
async function bootMobileHome(page) {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
}

test("スマホ幅: ホームの患者ボタンが1列で並ぶ", async ({ page }) => {
  await bootMobileHome(page);
  const btns = page.locator("#homeGrid .patientBtn");
  await expect(btns.first()).toBeVisible();
  const b0 = await btns.nth(0).boundingBox();
  const b1 = await btns.nth(1).boundingBox();
  // 1列 = 先頭2つの左端が揃い (同じ列)、2つ目は1つ目の下に積まれる。
  expect(Math.abs(b0.x - b1.x)).toBeLessThan(2);
  expect(b1.y).toBeGreaterThan(b0.y + b0.height - 2);
  // ボタンは老眼向けに十分大きい (min-height 76px 設計)。
  expect(b0.height).toBeGreaterThanOrEqual(72);
});

test("ホーム: 患者を追加する を押すと患者シートが開く", async ({ page }) => {
  await bootMobileHome(page);
  const addBtn = page.locator("#homeGrid .addPatientBtn");
  await expect(addBtn).toBeVisible();
  await addBtn.click();
  await expect(page.locator("#patientMetaOverlay")).toHaveClass(/active/);
  // シート内に部屋・氏名の入力欄が出る。
  await expect(page.locator("#patientMetaOverlay .patientSheetRoomInput")).toBeVisible();
  await expect(page.locator("#patientMetaOverlay .patientSheetNameInput")).toBeVisible();
});

test("ホーム: 追加→部屋番号と氏名を入れて閉じると一覧に残る", async ({ page }) => {
  await bootMobileHome(page);
  await page.locator("#homeGrid .addPatientBtn").click();
  await expect(page.locator("#patientMetaOverlay")).toHaveClass(/active/);
  await page.locator("#patientMetaOverlay .patientSheetRoomInput").fill("305");
  await page.locator("#patientMetaOverlay .patientSheetNameInput").fill("テスト患者");
  await page.locator("#patientMetaOverlay .popupCloseX").click();
  await expect(page.locator("#patientMetaOverlay")).not.toHaveClass(/active/);
  // 一覧に "305 テスト患者" のボタンが1つだけ存在する。
  const named = page.locator("#homeGrid .patientBtn", { hasText: "テスト患者" });
  await expect(named).toHaveCount(1);
  await expect(named).toContainText("305");
});

test("追加直後に部屋番号を入れても別患者に書かれない (index 安全)", async ({ page }) => {
  await bootMobileHome(page);
  await page.locator("#homeGrid .addPatientBtn").click();
  await expect(page.locator("#patientMetaOverlay")).toHaveClass(/active/);
  // 部屋番号を入れるとホームが裏で部屋番号順に再ソートされる (患者は末尾→先頭へ移動)。
  // index 束縛だと以降の氏名・ステータスが別患者へ流れる。シートはオブジェクト参照
  // 束縛なので、同じ患者に部屋・氏名・ステータスがまとまるはず。
  await page.locator("#patientMetaOverlay .patientSheetRoomInput").fill("210");
  await page.locator("#patientMetaOverlay .patientSheetNameInput").fill("一括検証");
  // ステータス (黄 ▲) を付ける。
  await page.locator("#patientMetaOverlay .statusPickerBox", { hasText: "▲" }).click();
  await page.locator("#patientMetaOverlay .popupCloseX").click();
  await expect(page.locator("#patientMetaOverlay")).not.toHaveClass(/active/);

  // 氏名 "一括検証" は1人だけ。
  const named = page.locator("#homeGrid .patientBtn", { hasText: "一括検証" });
  await expect(named).toHaveCount(1);
  // 同じボタンに部屋番号 210 とステータス色 (黄) が乗っている = 取り違えていない。
  await expect(named).toContainText("210");
  await expect(named).toHaveClass(/status-yellow/);
  // 黄ステータスは全体で1人だけ (別患者へ漏れていない)。
  await expect(page.locator("#homeGrid .patientBtn.status-yellow")).toHaveCount(1);
});

test("プロブレムリスト/共有: 末尾に追加ボタンがある", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToMemo(page);
  await expect(page.locator("#memoListHost .addPatientBtn")).toBeVisible();
  await goToShared(page);
  await expect(page.locator("#sharedListHost")).toBeVisible();
  await expect(page.locator("#sharedListHost .addPatientBtn")).toBeVisible();
});

// 2段表示は memo / shared とも本文が textarea (P5 で memo も input→textarea)。両方を実測する。
async function assert2RowStacked(page, hostSel, bodySel) {
  const row = page.locator(`${hostSel} .memoRow.read`).first();
  await expect(row).toBeVisible();
  const btn = row.locator(".memoNoBtn");
  const body = row.locator(bodySel);
  const rb = await row.boundingBox();
  const bb = await btn.boundingBox();
  const ib = await body.boundingBox();
  // 本文が患者ボタンの下に積まれている。
  expect(ib.y).toBeGreaterThan(bb.y + bb.height - 2);
  // 患者ボタンは行幅いっぱい (2段化で横並びでない)。
  expect(bb.width).toBeGreaterThan(rb.width * 0.8);
  // 本文も行幅いっぱい (老眼で読めるよう横を使い切る)。
  expect(ib.width).toBeGreaterThan(rb.width * 0.8);
}

test("スマホ幅: プロブレムリストで患者ボタンと本文が2段に並ぶ", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToMemo(page);
  await assert2RowStacked(page, "#memoListHost", "textarea");
});

test("スマホ幅: 共有で患者ボタンと本文が2段に並ぶ", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToShared(page);
  await assert2RowStacked(page, "#sharedListHost", "textarea");
});
