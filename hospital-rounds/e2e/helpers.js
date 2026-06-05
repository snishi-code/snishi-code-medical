import { expect } from "@playwright/test";

// ============================
// E2E 操作契約ヘルパ (単一ソース)
//
// 各 spec が DOM ID を直接叩くと、UI 導線が変わるたびに全 spec が同じ壊れ方をする
// (実際 v8.6 でヘッダーの memo/設定ボタンが ≡ メニューへ集約され、旧
//  #headerMemoBtn / #headerSettingsBtn を待つ E2E が全滅 timeout した)。
// 「ホームへ行く」「メモへ行く」「ステータスを付ける」といった"動作"をここに集約し、
// spec はこの動作 API だけを呼ぶ。導線が変わってもこのファイルだけ直せば済む。
//
// 待ち方針: 起動ゲート (オンボーディング / ユーザー選択 / 免責) が async で走るので、
// 「クリック → 期待する view が active になる / 固有要素が visible になる」まで明示的に
// 待つ。要素の存在だけでなく "操作可能になった" ことを契約にする。
// ============================

// 起動 → 初回オンボーディング (名前+同意) を完了 → ヘッダーに名前が出るまで待つ。
// まっさらな context で走る前提 (各テストは IDB/localStorage を持ち越さない)。
export async function boot(page, name = "テスト医師") {
  await page.goto("/");
  // オンボーディングは home 描画後に async で出る。出れば名前を入れて開始。
  const ob = page.locator("#onboardingOverlay");
  await ob.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  if (await ob.isVisible().catch(() => false)) {
    await page.locator("#onboardingNameInput").fill(name);
    await page.locator("#onboardingStartBtn").click();
  }
  // 免責はオンボーディング完了時は抑止されるが、リロード経路などで出ることがあるので close。
  const disc = page.locator("#disclaimerCloseBtn");
  if (await disc.isVisible().catch(() => false)) await disc.click();
  // 起動完了の確実な目印: ヘッダーのユーザー名 (= タイトル枠) が入力名になる。
  await expect(page.locator("#appTitleInput")).toHaveValue(name);
}

// ≡ メインメニューを開く (memo/共有/設定/説明 の入口)。
export async function openMainMenu(page) {
  await page.locator("#mainMenuBtn").click();
  await expect(page.locator("#mainMenuOverlay")).toHaveClass(/active/);
}

// プロブレムリスト (メモ) 画面へ。≡ → メモ。選択でメニューは閉じ memoView が active になる。
export async function goToMemo(page) {
  await openMainMenu(page);
  await page.locator("#mainMenuMemoBtn").click();
  await expect(page.locator("#memoView")).toHaveClass(/active/);
  await expect(page.locator("#memoEditBtn")).toBeVisible();
}

// 共有一覧画面へ。≡ → 共有。
export async function goToShared(page) {
  await openMainMenu(page);
  await page.locator("#mainMenuSharedBtn").click();
  await expect(page.locator("#sharedView")).toHaveClass(/active/);
}

// 設定画面へ。≡ → 設定。
export async function goToSettings(page) {
  await openMainMenu(page);
  await page.locator("#mainMenuSettingsBtn").click();
  await expect(page.locator("#settingsView")).toHaveClass(/active/);
}

// ホーム画面へ。ヘッダー左の家ボタン。
export async function goToHome(page) {
  await page.locator("#homeNavBtn").click();
  await expect(page.locator("#homeView")).toHaveClass(/active/);
  await expect(page.locator("#homeGrid")).toBeVisible();
}

// ホームの patientIdx 番目 (0-based) の患者を開く (詳細画面へ)。
export async function openPatient(page, patientIdx = 0) {
  await page.locator("#homeGrid .patientBtn").nth(patientIdx).click();
  await expect(page.locator("#detailView")).toHaveClass(/active/);
  await expect(page.locator("#detailPatientMetaBtn")).toBeVisible();
}

// 詳細画面で患者シート (ステータス/部屋/氏名/タグ) を開く。
// v8.x: ステータスはヘッダーの小さなスウォッチ (#detailStatusBtn) を廃し、患者メタ
// ボタン → シート内に常時表示の statusPickerBox へ集約された。
export async function openPatientSheet(page) {
  await page.locator("#detailPatientMetaBtn").click();
  await expect(page.locator("#patientMetaOverlay")).toHaveClass(/active/);
}

// 患者シートの × で閉じる (背景タップ / × は main.js のグローバルハンドラが担当)。
export async function closePatientSheet(page) {
  await page.locator("#patientMetaOverlay .popupCloseX").click();
  await expect(page.locator("#patientMetaOverlay")).not.toHaveClass(/active/);
}

// 詳細画面の患者に形マーク mark のステータスを付ける (例: "▲"=黄 / "✓"=緑 / "★"=青 /
// "✕"=灰 / "−"=無印)。シートを開く → 該当ボックスを選ぶ → シートを閉じる、まで行う
// (シートは単一選択でも自動で閉じない設計なので、後続のナビが届くよう明示的に閉じる)。
export async function setPatientStatus(page, mark) {
  await openPatientSheet(page);
  await page.locator("#patientMetaOverlay .statusPickerBox", { hasText: mark }).click();
  await closePatientSheet(page);
}

// ヘッダーのユーザーピッカーから新規ユーザーを作成して切替える。
// 追加ウィジェットは「＋ボタン」か「入力欄」のどちらかの状態 (作成成功後は入力欄のまま)。
export async function addUser(page, name) {
  await page.locator("#appUserChevron").click();
  await expect(page.locator("#userPickerOverlay")).toHaveClass(/active/);
  const addBtn = page.locator("#userPickerAdd .ioWsAddBtn");
  if (await addBtn.isVisible().catch(() => false)) await addBtn.click();
  const inp = page.locator("#userPickerAdd .ioWsAddInput");
  await inp.fill(name);
  await inp.press("Enter");
}

// __users__ レコードのユーザー数が count 以上になるまで待つ (取込完了の確実な目印)。
export async function waitUserCount(page, count, timeout = 6000) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const db = await new Promise((res) => {
            const r = indexedDB.open("hospital-rounds");
            r.onsuccess = () => res(r.result);
            r.onerror = () => res(null);
          });
          if (!db) return 0;
          return await new Promise((res) => {
            const tx = db.transaction("bundles", "readonly");
            const q = tx.objectStore("bundles").get("__users__");
            q.onsuccess = () => res((q.result && q.result.users && q.result.users.length) || 0);
            q.onerror = () => res(0);
          });
        }),
      { timeout },
    )
    .toBeGreaterThanOrEqual(count);
}
