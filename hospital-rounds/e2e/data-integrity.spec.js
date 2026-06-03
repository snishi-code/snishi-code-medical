import { test, expect } from "@playwright/test";

// データ整合性の回帰 E2E。各テストはまっさらな context で走る。

async function boot(page, name = "テスト医師") {
  await page.goto("/");
  const ob = page.locator("#onboardingOverlay");
  await ob.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  if (await ob.isVisible().catch(() => false)) {
    await page.locator("#onboardingNameInput").fill(name);
    await page.locator("#onboardingStartBtn").click();
  }
  const disc = page.locator("#disclaimerCloseBtn");
  if (await disc.isVisible().catch(() => false)) await disc.click();
  await expect(page.locator("#appTitleInput")).toHaveValue(name);
}

// #1 回帰: プロブレムリストのインライン編集中に、部屋番号を「並び順が変わる値」へ
// 1 文字ずつ打ち込んでも、編集対象がすり替わらない (= 患者取り違えが起きない)。
//
// 旧バグ: 入力欄が患者を index で固定捕捉し、1 打鍵ごとに renderHome→ensureRoomOrder が
// appState.patients を in-place ソートしていたため、最初の打鍵でソートが起きた後の打鍵が
// 別患者へ書き込まれていた。修正: 編集中はソートを止める + 入力欄は患者オブジェクト参照で捕捉。
test("#1 プロブレムリスト編集中に部屋番号を打鍵しても患者が取り違わらない", async ({ page }) => {
  await boot(page);

  // プロブレムリスト (memo) へ → 編集モードへ
  await page.locator("#headerMemoBtn").click();
  await page.locator("#memoEditBtn").click();

  const rooms = page.locator("#memoListHost .roomInput");
  const names = page.locator("#memoListHost .memoNoInp");

  // 患者0 = A/200, 患者1 = B/300 を編集モード中に入力 (この時点ではソートは止まっている)
  await names.nth(0).fill("A");
  await rooms.nth(0).fill("200");
  await names.nth(1).fill("B");
  await rooms.nth(1).fill("300");

  // 患者1 (B) の部屋を、200 より前に来る "030" へ 1 文字ずつ打鍵し直す。
  // 旧バグなら最初の "0" でソートが走り、続く打鍵が患者0 (A) 側へ漏れていた。
  await rooms.nth(1).fill("");
  await rooms.nth(1).pressSequentially("030", { delay: 60 });

  // 編集モードを抜ける (鉛筆再タップ)。ここで初めて部屋番号順ソートが走る → B(030) が先頭へ。
  await page.locator("#memoEditBtn").click();

  // 表示ボタンは "部屋 名前"。取り違えが起きていなければ:
  //   先頭 = "030 B" / 次 = "200 A" (A の部屋は 200 のまま、B の打鍵が漏れていない)
  const btns = page.locator("#memoListHost .memoNoBtn");
  await expect(btns.nth(0)).toContainText("030");
  await expect(btns.nth(0)).toContainText("B");
  await expect(btns.nth(1)).toContainText("200");
  await expect(btns.nth(1)).toContainText("A");
  // 念のため: A の行に B の部屋打鍵 (0/3) が漏れていない
  await expect(btns.nth(1)).not.toContainText("030");
});
