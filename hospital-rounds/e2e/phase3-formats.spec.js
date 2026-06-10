import { test, expect } from "@playwright/test";
import { boot, goToHome, goToSettings, openPatient, startInlineEdit, inlineEditSave } from "./helpers.js";

// Phase 3 follow-up: ワンタップ診察入力。各パネルに展開フォーマットカードが常設され、
// 値セルをタップすると「その場 (inline)」で編集する (ポップアップは開かない)。自由記述欄は
// 撤去 (互換はデータ層のみ)。titleWrap が患者カード見出しに連動。展開フォーマットの不変条件
// (各パネル最低 1 つ) はセット編集・フォーマット削除でブロックされる。

async function openQrPreview(page) {
  await page.locator("#qrToggleBtn").click();
  await expect(page.locator("#detailQrOverlay")).toHaveClass(/active/);
}

test("新規患者で S/O/A/P 各欄に展開フォーマットカードが表示される", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  for (const host of ["#sExpanded", "#oExpanded", "#aExpanded", "#pExpanded"]) {
    await expect(page.locator(`${host} .formatExpanded`).first()).toBeVisible();
  }
});

test("O 欄にも S/A/P 相当のシンプルな展開フォーマットが存在する", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToSettings(page);

  const oFormats = page.locator("#setFormats_O .formatListRow");
  await expect(oFormats).toHaveCount(3);
  await expect(oFormats.locator(".formatListName").filter({ hasText: /^所見$/ })).toHaveCount(1);

  await goToHome(page);
  await openPatient(page, 0);
  await expect(page.locator("#oExpanded .formatExpanded")).toHaveCount(3);
});

test("展開カードの正常チェックは入力欄の左側に出る", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);

  const phys = page.locator("#oExpanded .formatExpanded", { hasText: "身体所見" });
  const firstRow = phys.locator(".formatCardItem").first();
  await expect(firstRow.locator(".formatCardNormalBtn")).toBeVisible();
  await expect(firstRow.locator(".formatCardValue")).toBeVisible();

  const order = await firstRow.locator(":scope > *").evaluateAll(nodes =>
    nodes.map(node => node.classList.contains("formatCardItemLabel") ? "label"
      : node.classList.contains("formatCardNormalBtn") ? "normal"
      : node.classList.contains("formatCardValue") ? "value"
      : "other")
  );
  expect(order).toEqual(["label", "normal", "value"]);
});

test("身体所見カードはラベル幅が違ってもチェック列/値列が縦に揃う", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);

  const phys = page.locator("#oExpanded .formatExpanded", { hasText: "身体所見" });
  // General(7字) と 肺音(2字) などラベル幅が違う複数行で、チェック列・値列の x が揃うこと。
  const normalBtns = phys.locator(".formatCardNormalBtn");
  const valueBtns = phys.locator(".formatCardValue");
  const n = await normalBtns.count();
  expect(n).toBeGreaterThan(2);

  const xOf = async (loc, idx) => (await loc.nth(idx).boundingBox()).x;
  const baseNormalX = await xOf(normalBtns, 0);
  const baseValueX = await xOf(valueBtns, 0);
  for (let i = 1; i < n; i++) {
    expect(Math.abs((await xOf(normalBtns, i)) - baseNormalX)).toBeLessThan(1.5);
    expect(Math.abs((await xOf(valueBtns, i)) - baseValueX)).toBeLessThan(1.5);
  }
});

test("空欄→チェックで正常文、再チェックで空欄に戻る (General)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);

  const phys = page.locator("#oExpanded .formatExpanded", { hasText: "身体所見" });
  const firstRow = phys.locator(".formatCardItem").first(); // General (normal=良好)
  const btn = firstRow.locator(".formatCardNormalBtn");
  const val = firstRow.locator(".formatCardValue");

  await expect(btn).toHaveAttribute("aria-pressed", "false");
  await btn.click();
  await expect(val).toHaveText("良好");
  await expect(btn).toHaveAttribute("aria-pressed", "true");

  await btn.click(); // 再タップ → 空欄
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  await expect(val).toHaveClass(/empty/);

  // QR にもクリア済みの General は出ない
  await openQrPreview(page);
  expect(await page.locator("#qrTextPreview").textContent()).not.toContain("良好");
});

test("手入力済みのチェックは上書きせず inline 編集を開き手入力を保持 (General)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);

  const phys = page.locator("#oExpanded .formatExpanded", { hasText: "身体所見" });
  const firstRow = phys.locator(".formatCardItem").first(); // General
  // まず General に手入力 (正常文「良好」とは別の値) を inline 編集で入れる
  await inlineEditSave(page, firstRow.locator(".formatCardValue"), { value: "やや倦怠感あり" });
  await expect(firstRow.locator(".formatCardValue")).toHaveText("やや倦怠感あり");

  // チェックを押す → 良好で上書きせず、inline 編集が開き手入力が残る
  await firstRow.locator(".formatCardNormalBtn").click();
  await expect(page.locator("#formatInputOverlay")).not.toHaveClass(/active/);
  const editing = phys.locator(".formatCardItem.editing");
  await expect(editing.locator(".formatCardEditInput").first()).toHaveValue("やや倦怠感あり");
  // キャンセルしてもカード側は上書きされていない
  await editing.locator(".formatCardEditCancel").click();
  await expect(firstRow.locator(".formatCardValue")).toHaveText("やや倦怠感あり");
});

test("手入力で正常文と同一文字列にしてもタップで消えず inline 編集が開く (Phase6 provenance)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);

  const phys = page.locator("#oExpanded .formatExpanded", { hasText: "身体所見" });
  const firstRow = phys.locator(".formatCardItem").first(); // General (normal=良好)
  // inline 編集で「良好」(=正常文と同一文字列) を手入力して保存 → source=manual
  await inlineEditSave(page, firstRow.locator(".formatCardValue"), { value: "良好" });

  // 値は「良好」だが手入力由来なのでチェックは緑にならない (aria-pressed=false)
  await expect(firstRow.locator(".formatCardValue")).toHaveText("良好");
  await expect(firstRow.locator(".formatCardNormalBtn")).toHaveAttribute("aria-pressed", "false");

  // チェックをタップ → 文字列一致でも消さず、inline 編集が開き「良好」が残る
  await firstRow.locator(".formatCardNormalBtn").click();
  await expect(page.locator("#formatInputOverlay")).not.toHaveClass(/active/);
  const editing = phys.locator(".formatCardItem.editing");
  await expect(editing.locator(".formatCardEditInput").first()).toHaveValue("良好");
  await editing.locator(".formatCardEditCancel").click();
  await expect(firstRow.locator(".formatCardValue")).toHaveText("良好");

  // QR 平文に provenance メタ (source/preset/manual) が混ざらない
  await openQrPreview(page);
  const qr = await page.locator("#qrTextPreview").textContent();
  expect(qr).toContain("良好");
  expect(qr).not.toMatch(/source|preset|manual/);
});

test("自由記述欄『補足・メモ（任意）』が患者画面に存在しない (修正2)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // ラベルも textarea も消えていること
  await expect(page.getByText("補足・メモ")).toHaveCount(0);
  for (const id of ["#sText", "#oFreeText", "#aText", "#pText"]) {
    await expect(page.locator(id)).toHaveCount(0);
  }
  // パネル本文に直接フォーカスできる textarea が無い (展開カードのみ)
  await expect(page.locator("#sExpanded textarea")).toHaveCount(0);
});

test("titleWrap ON/OFF が患者カードの見出しに反映される (修正4)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // O「バイタル」は titleWrap "（）" → 見出し (.formatExpandedName) が出る
  await expect(page.locator("#oExpanded .formatExpanded .formatExpandedName", { hasText: "バイタル" }))
    .toHaveCount(1);
  // S「自覚症状」は titleWrap "" → 見出しは出ない
  await expect(page.locator("#sExpanded .formatExpanded .formatExpandedName")).toHaveCount(0);
});

test("S の正常をワンタップすると QR 平文に入り、未タップ P は入らない (fallback 撤去)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // S 既定カード「自覚症状」のワンタップ正常チェック
  await page.locator("#sExpanded .formatExpanded .formatCardNormalBtn").first().click();
  await openQrPreview(page);
  const qr = await page.locator("#qrTextPreview").textContent();
  expect(qr).toContain("特に新しい訴えなし");      // タップした S は出る
  expect(qr).not.toContain("現治療を継続");          // 未タップ P の既定文は出ない
});

test("値セルをタップすると inline 編集が開き、保存で患者画面/QRに反映 (修正3)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // O「バイタル」(1枚目) の SpO2 セル (3番目の item) を inline 編集 → 保存
  const vitals = page.locator("#oExpanded .formatExpanded").first();
  await inlineEditSave(page, vitals.locator(".formatCardValue").nth(2), { value: "96" });
  // ポップアップ入力シートは開かない (inline で完結)
  await expect(page.locator("#formatInputOverlay")).not.toHaveClass(/active/);
  // カードの値表示に反映 (未入力でなくなる)
  await expect(vitals.locator(".formatCardValue").nth(2)).toContainText("96");
  // QR 平文にも反映
  await openQrPreview(page);
  expect(await page.locator("#qrTextPreview").textContent()).toContain("SpO2 96%");
});

test("inline 編集: 既存値を別の値に変えて保存すると新しい値が残る (P1 回帰)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  const vitals = page.locator("#oExpanded .formatExpanded").first();
  // まず SpO2=88 を inline 編集で入れて保存
  await inlineEditSave(page, vitals.locator(".formatCardValue").nth(2), { value: "88" });
  await expect(vitals.locator(".formatCardValue").nth(2)).toContainText("88");
  // もう一度 inline 編集で 96 に変更して保存 → 96 が残る (古い値 88 や空にならない)
  await inlineEditSave(page, vitals.locator(".formatCardValue").nth(2), { value: "96" });
  await expect(vitals.locator(".formatCardValue").nth(2)).toContainText("96");
  await openQrPreview(page);
  expect(await page.locator("#qrTextPreview").textContent()).toContain("SpO2 96%");
});

test("フォーマット削除: あるパネルの最後の展開フォーマットは削除できない (修正1)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToSettings(page);
  // S は既定フォーマット「自覚症状」1 つだけ = デフォルトセットの唯一の S 展開 → 削除不可
  const row = page.locator("#setFormats_S .formatListRow", { hasText: "自覚症状" });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".iconBtn").last()).toBeDisabled();
  // O は バイタル/身体所見 の 2 枚あるので、片方は削除可能 (= 過剰ブロックしていない)
  const oRow = page.locator("#setFormats_O .formatListRow", { hasText: "バイタル" });
  await expect(oRow.locator(".iconBtn").last()).toBeEnabled();
});

test("セット編集: あるパネルの最後の展開フォーマットを外せない (修正1)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await goToSettings(page);
  // 「外せません」alert を自動で閉じる
  page.on("dialog", (d) => d.accept());
  // デフォルトセットの編集を開く
  await page.locator("#setFormatGroups .formatListRow.formatGroupDefaultRow .iconBtn").first().click();
  await expect(page.locator("#formatGroupEditOverlay")).toHaveClass(/active/);
  // S「自覚症状」行の表示方法セグメント: [展開][クイック] (規定文は P5 で撤去)
  const sRow = page.locator("#formatGroupEditFormats .formatGroupEditOpt", { hasText: "自覚症状" });
  const expandBtn = sRow.locator(".formatGroupModeBtn").nth(0);
  const quickBtn = sRow.locator(".formatGroupModeBtn").nth(1);
  await expect(expandBtn).toHaveClass(/active/);   // 初期は展開
  await quickBtn.click();                            // → 最後の展開なのでブロック
  await expect(expandBtn).toHaveClass(/active/);    // まだ展開 (外せていない)
  await expect(quickBtn).not.toHaveClass(/active/);
});
