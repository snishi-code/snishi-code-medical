import { test, expect } from "@playwright/test";

// 主要動線の E2E。各テストはまっさらな context (IDB/localStorage 持ち越しなし) で走る。
// 起動ごとに backfill で初期ユーザー「ユーザー1」ができる。

async function boot(page) {
  await page.goto("/");
  const ok = page.locator("#disclaimerCloseBtn");
  await ok.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  if (await ok.isVisible().catch(() => false)) await ok.click();
  await expect(page.locator("#appTitleInput")).toHaveValue("ユーザー1");
}

async function addUser(page, name) {
  await page.locator("#appUserChevron").click();
  await expect(page.locator("#userPickerOverlay")).toHaveClass(/active/);
  // 追加ウィジェットは「＋ボタン」か「入力欄」のどちらかの状態 (作成成功後は入力欄のまま)
  const addBtn = page.locator("#userPickerAdd .ioWsAddBtn");
  if (await addBtn.isVisible().catch(() => false)) await addBtn.click();
  const inp = page.locator("#userPickerAdd .ioWsAddInput");
  await inp.fill(name);
  await inp.press("Enter");
}

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
  await page.locator("#headerMemoBtn").click();
  await page.evaluate(() => document.getElementById("memoPasteCard").classList.add("active"));
  await page.locator("#memoPasteArea").fill("受信テストA");
  await page.locator("#memoPasteArea").blur();

  // リロードしても田中の受信ボックスは残る
  await page.reload();
  const ok = page.locator("#disclaimerCloseBtn");
  if (await ok.isVisible().catch(() => false)) await ok.click();
  await page.locator("#headerMemoBtn").click();
  await expect(page.locator("#memoPasteArea")).toHaveValue("受信テストA");

  // ユーザー1へ切替えると受信ボックスは空 (分離)
  await page.locator("#appUserChevron").click();
  await page.locator("#userPickerList .wsPickerRow", { hasText: "ユーザー1" })
    .locator(".wsPickerMain").click();
  await expect(page.locator("#appTitleInput")).toHaveValue("ユーザー1");
  await page.locator("#headerMemoBtn").click();
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
  await page.locator("#headerSettingsBtn").click();
  await expect(page.locator('[data-i18n="settings.user.section"]')).toBeVisible();
  await expect(page.locator('[data-i18n="settings.restore.section"]')).toBeVisible();
  await expect(page.locator('[data-i18n="settings.log.section"]')).toBeVisible();
  await expect(page.locator("#ioDeviceSaveBtn")).toBeVisible();
});

test("診察開始すると巻き戻しに復元ポイントが現れる", async ({ page }) => {
  await boot(page);
  page.on("dialog", (d) => d.accept()); // 確認ダイアログは承認
  await page.locator("#clearAllBtn").click();
  await page.locator("#headerSettingsBtn").click();
  await expect(page.locator("#settingsRestoreList .ioDbRow").first()).toBeVisible();
  await expect(page.locator("#settingsRestoreList").getByText("戻す").first()).toBeVisible();
});

test("研究ログは患者名を含まない（無記名）", async ({ page }) => {
  await boot(page);
  await page.locator("#headerMemoBtn").click();
  await page.locator("#homeNavBtn").click();
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
