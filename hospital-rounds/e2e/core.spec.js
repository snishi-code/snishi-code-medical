import { test, expect } from "@playwright/test";
import { boot, addUser, goToMemo, goToSettings, goToHome, openPatient, setPatientStatus } from "./helpers.js";

// 主要動線の E2E。各テストはまっさらな context (IDB/localStorage 持ち越しなし) で走る。
// 起動ごとに backfill で初期ユーザー「ユーザー1」ができる。
// 画面遷移・ステータス付与などの操作契約は helpers.js に集約 (UI 導線変更に追随しやすく)。

test("ユーザーを作成・切替できる／同名は拒否される", async ({ page }) => {
  await boot(page);
  await addUser(page, "田中");
  await expect(page.locator("#appTitleInput")).toHaveValue("田中");

  // 同名で作ろうとするとアラートで拒否され、ヘッダーは田中のまま
  let dialogMsg = "";
  page.once("dialog", (d) => { dialogMsg = d.message(); d.accept(); });
  await addUser(page, "田中");
  await expect.poll(() => dialogMsg).toContain("同じ名前");
  await expect(page.locator("#appTitleInput")).toHaveValue("田中");
});

test("受信ボックスはユーザーごとに分離され、リロードしても残る", async ({ page }) => {
  await boot(page);
  await addUser(page, "田中");
  await expect(page.locator("#appTitleInput")).toHaveValue("田中");

  // プロブレムリスト画面で受信ボックスを表に出して入力 (入力→保存の実経路を通す)
  await goToMemo(page);
  await page.evaluate(() => document.getElementById("memoPasteCard").classList.add("active"));
  await page.locator("#memoPasteArea").fill("受信テストA");
  await page.locator("#memoPasteArea").blur();

  // リロードしても田中の受信ボックスは残る
  await page.reload();
  const ok = page.locator("#disclaimerCloseBtn");
  if (await ok.isVisible().catch(() => false)) await ok.click();
  await goToMemo(page);
  await expect(page.locator("#memoPasteArea")).toHaveValue("受信テストA");

  // 最初のユーザー(テスト医師)へ切替えると受信ボックスは空 (分離)
  await page.locator("#appUserChevron").click();
  await page.locator("#userPickerList .wsPickerRow", { hasText: "テスト医師" })
    .locator(".wsPickerMain").click();
  await expect(page.locator("#appTitleInput")).toHaveValue("テスト医師");
  await goToMemo(page);
  await expect(page.locator("#memoPasteArea")).toHaveValue("");
});

test("病棟を新規作成するとヘッダーがその病棟に切替わる", async ({ page }) => {
  await boot(page);
  await page.locator("#appWsChevron").click();
  await expect(page.locator("#wsPickerOverlay")).toHaveClass(/active/);
  await page.locator("#wsPickerAdd .ioWsAddBtn").click();
  const inp = page.locator("#wsPickerAdd .ioWsAddInput");
  await inp.fill("病棟B");
  await inp.press("Enter");
  await expect(page.locator("#appWsLabelInput")).toHaveValue("病棟B");
});

test("設定画面にユーザー管理・巻き戻し・研究ログのセクションが出る", async ({ page }) => {
  await boot(page);
  await goToSettings(page);
  await expect(page.locator('[data-i18n="settings.user.section"]')).toBeVisible();
  await expect(page.locator('[data-i18n="settings.restore.section"]')).toBeVisible();
  await expect(page.locator('[data-i18n="settings.log.section"]')).toBeVisible();
  await expect(page.locator("#ioDeviceSaveBtn")).toBeVisible();
});

test("診察開始すると巻き戻しに復元ポイントが現れる", async ({ page }) => {
  await boot(page);
  page.on("dialog", (d) => d.accept()); // 確認ダイアログは承認
  await page.locator("#clearAllBtn").click();
  await goToSettings(page);
  await expect(page.locator("#settingsRestoreList .ioDbRow").first()).toBeVisible();
  await expect(page.locator("#settingsRestoreList").getByText("戻す").first()).toBeVisible();
});

test("研究ログは患者名を含まない（無記名）", async ({ page }) => {
  await boot(page);
  await goToMemo(page);
  await goToHome(page);
  await page.waitForTimeout(300);
  const events = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("hospital-rounds-eventlog");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return await new Promise((res) => {
      const tx = db.transaction("events", "readonly");
      const q = tx.objectStore("events").getAll();
      q.onsuccess = () => res(q.result);
    });
  });
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) {
    expect("name" in e).toBeFalsy();
    expect("pid" in e).toBeFalsy();
    expect(typeof e.k).toBe("string"); // 種別はある
  }
});

test("2人以上いて1日経つと、起動時にユーザー選択が出る", async ({ page }) => {
  await boot(page, "テスト医師");
  await addUser(page, "田中"); // 2人目（切替わる）
  // 「最後の確認は2日前」にして再読込
  await page.evaluate(() =>
    localStorage.setItem("hospital_rounds_last_user_confirm_at", String(Date.now() - 2 * 24 * 60 * 60 * 1000)));
  await page.reload();
  const sel = page.locator("#userSelectOverlay");
  await expect(sel).toHaveClass(/active/);
  await page.locator("#userSelectList .userSelectRow", { hasText: "テスト医師" }).click();
  await expect(sel).not.toHaveClass(/active/);
  await expect(page.locator("#appTitleInput")).toHaveValue("テスト医師");
});

test("ステータス色の患者ボタンには形マークが出る（色盲対応）", async ({ page }) => {
  await boot(page);
  // 患者1を黄(▲)にする: 患者を開く → 患者シート → 黄(▲)を選ぶ
  await openPatient(page, 0);
  await setPatientStatus(page, "▲");
  await goToHome(page);
  // ホームの先頭ボタンに ▲ マークが重なっている
  const first = page.locator("#homeGrid .patientBtn").first();
  await expect(first).toHaveClass(/status-yellow/);
  await expect(first.locator(".patientBtnMark")).toHaveText("▲");
});

test("ユーザーが1人なら1日経っても選択画面は出ない", async ({ page }) => {
  await boot(page, "テスト医師");
  await page.evaluate(() =>
    localStorage.setItem("hospital_rounds_last_user_confirm_at", String(Date.now() - 2 * 24 * 60 * 60 * 1000)));
  await page.reload();
  await expect(page.locator("#userSelectOverlay")).not.toHaveClass(/active/);
  await expect(page.locator("#onboardingOverlay")).not.toHaveClass(/active/);
  await expect(page.locator("#appTitleInput")).toHaveValue("テスト医師");
});
