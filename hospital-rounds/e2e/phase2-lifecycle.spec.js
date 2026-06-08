import { test, expect } from "@playwright/test";
import { boot, goToHome, openPatient, openPatientSheet, closePatientSheet } from "./helpers.js";

// Phase 2: 患者ライフサイクル (転棟/削除/削除済み病棟/復元/完全削除) の E2E。
// 長押しに頼らず患者詳細下部の見える導線から到達できることを確認する。

// ヘッダーの病棟名タップ → ws ピッカー → label の病棟へ切替。
async function switchWard(page, label) {
  await page.locator("#appWsLabelInput").click();
  await expect(page.locator("#wsPickerOverlay")).toHaveClass(/active/);
  await page.locator("#wsPickerList .wsPickerMain", { hasText: label }).click();
  await expect(page.locator("#wsPickerOverlay")).not.toHaveClass(/active/);
}

// 「削除済み」以外の有効な病棟へ切替 (= 元の通常病棟へ戻る)。現在の病棟 (= 削除済み)
// の行は disabled なので、:not([disabled]) の最初の行が戻り先になる (auto-wait で描画を待つ)。
async function switchToNonTrashWard(page) {
  await page.locator("#appWsLabelInput").click();
  await expect(page.locator("#wsPickerOverlay")).toHaveClass(/active/);
  await page.locator("#wsPickerList .wsPickerMain:not([disabled])").first().click();
  await expect(page.locator("#wsPickerOverlay")).not.toHaveClass(/active/);
}

// 患者に名前を付ける (Trash 内などで識別しやすくする)。
async function nameCurrentPatient(page, name) {
  await openPatientSheet(page);
  await page.locator("#patientMetaOverlay .patientSheetNameInput").fill(name);
  await closePatientSheet(page);
}

test("詳細下部に 転棟 / 削除 が見える (実在患者)", async ({ page }) => {
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await nameCurrentPatient(page, "在棟太郎"); // 空スロットは転棟が出ないので実在にする
  const host = page.locator("#detailLifecycleActions");
  await expect(host).toBeVisible();
  await expect(host.getByText("転棟", { exact: true })).toBeVisible();
  await expect(host.getByText("削除", { exact: true })).toBeVisible();
});

test("空スロットは転棟ボタンが出ず、削除してもTrashに入らない", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0); // 初期の空スロット
  const host = page.locator("#detailLifecycleActions");
  await expect(host.getByText("転棟", { exact: true })).toHaveCount(0);
  await expect(host.locator(".lifecycleDelete")).toBeVisible();
  // 削除 → 空スロットは完全除去 (Trash へ行かない = 削除済み病棟は作られない)
  await host.locator(".lifecycleDelete").click();
  await expect(page.locator("#homeView")).toHaveClass(/active/);
  await page.locator("#appWsLabelInput").click();
  await expect(page.locator("#wsPickerOverlay")).toHaveClass(/active/);
  await expect(page.locator("#wsPickerList .wsPickerMain", { hasText: "削除済み" })).toHaveCount(0);
});

test("削除すると削除済み病棟へ移り、元病棟から消える / 30日注意書きが出る", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await nameCurrentPatient(page, "削除対象");
  await page.locator("#detailLifecycleActions .lifecycleDelete").click();
  await expect(page.locator("#homeView")).toHaveClass(/active/);
  // 元病棟からは消える
  await expect(page.locator("#homeGrid .patientBtn", { hasText: "削除対象" })).toHaveCount(0);
  // 削除済み病棟に移っている + 30日注意書き + 追加ボタンは出ない
  await switchWard(page, "削除済み");
  await expect(page.locator("#homeView")).toHaveClass(/active/);
  await expect(page.locator(".trashBanner")).toBeVisible();
  await expect(page.locator("#homeGrid .patientBtn", { hasText: "削除対象" })).toHaveCount(1);
  await expect(page.locator("#homeGrid .addPatientBtn")).toHaveCount(0);
});

test("削除済みの患者詳細は 転棟して復元 / 完全削除。完全削除は確認ダイアログを挟む", async ({ page }) => {
  let lastDialog = "";
  page.on("dialog", (d) => { lastDialog = d.message(); d.accept(); });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await nameCurrentPatient(page, "削除対象A"); // 実在患者にして Trash 退避させる
  await page.locator("#detailLifecycleActions .lifecycleDelete").click();
  await expect(page.locator("#homeView")).toHaveClass(/active/);
  await switchWard(page, "削除済み");
  await openPatient(page, 0);
  const host = page.locator("#detailLifecycleActions");
  await expect(host.getByText("転棟して復元", { exact: true })).toBeVisible();
  await expect(host.getByText("完全削除", { exact: true })).toBeVisible();
  await expect(host.locator(".lifecycleNote")).toBeVisible();
  // 完全削除 → confirm ダイアログ
  lastDialog = "";
  await host.locator(".lifecycleDelete").click();
  await expect(page.locator("#homeView")).toHaveClass(/active/);
  expect(lastDialog).toContain("完全に削除");
});

test("削除済みから転棟復元すると元病棟へ戻り、Trashから消える", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await nameCurrentPatient(page, "復元対象");
  await page.locator("#detailLifecycleActions .lifecycleDelete").click();
  await expect(page.locator("#homeView")).toHaveClass(/active/);
  await switchWard(page, "削除済み");
  await openPatient(page, 0);
  // 転棟して復元 → 復元先 (元の通常病棟) を選ぶ
  await page.locator("#detailLifecycleActions .lifecycleRestore").click();
  await expect(page.locator("#movePatientOverlay")).toHaveClass(/active/);
  await page.locator("#movePatientList .ioDbRow").first().click();
  await expect(page.locator("#movePatientOverlay")).not.toHaveClass(/active/);
  await expect(page.locator("#homeView")).toHaveClass(/active/);
  // Trash は空 (削除済みはいません)
  await expect(page.locator("#homeGrid .patientBtn", { hasText: "復元対象" })).toHaveCount(0);
  await expect(page.locator(".trashEmpty")).toBeVisible();
  // 元病棟 (削除済み以外) へ戻ると患者が居る
  await switchToNonTrashWard(page);
  await expect(page.locator("#homeGrid .patientBtn", { hasText: "復元対象" })).toHaveCount(1);
});

test("長押しアクションメニューは廃止されている (overlay が存在しない)", async ({ page }) => {
  await boot(page);
  await goToHome(page);
  await expect(page.locator("#actionMenuOverlay")).toHaveCount(0);
});
