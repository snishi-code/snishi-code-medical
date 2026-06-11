import { test, expect } from "@playwright/test";
import {
  boot, goToHome, openPatient,
  startInlineEdit, inlineEditSet, endInlineEdit,
  createHamburgerFormat, openFormatSheetViaHamburger,
} from "./helpers.js";

// 展開カードの inline 編集 (ポップアップ入力シートの代替・自動保存):
//  - 値セルをタップすると、その行が「その場」で編集状態になる (#formatInputOverlay は開かない)。
//  - 保存/キャンセルボタンは無く、input ごとに患者データへ自動保存される。
//    戻る・外側タップ・リロードでも入力済みの内容は失われない。
//  - クイック/ハンバーガー経由のフォーマット入力は従来どおりポップアップ (明示保存/キャンセル)。

const MOBILE = { width: 390, height: 844 };

async function openQrPreview(page) {
  await page.locator("#qrToggleBtn").click();
  await expect(page.locator("#detailQrOverlay")).toHaveClass(/active/);
}

test("展開フォーマットの値セルをタップしても #formatInputOverlay が開かない (inline・ボタン無し)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  const cell = page.locator("#sExpanded .formatExpanded .formatCardValue").first();
  await cell.click();
  // ポップアップ入力シートは開かず、その行が編集状態になる
  await expect(page.locator("#formatInputOverlay")).not.toHaveClass(/active/);
  await expect(page.locator("#sExpanded .formatCardItem.editing")).toHaveCount(1);
  await expect(page.locator("#sExpanded .formatCardItem.editing .formatCardEditInput").first()).toBeVisible();
  // 自動保存なので保存/キャンセルボタンは出ない
  await expect(page.locator(".formatCardEditSave, .formatCardEditCancel")).toHaveCount(0);
});

test("inline 編集の入力は自動保存され、患者画面表示と QR 本文に反映される", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // S「自覚症状」の本文を inline 編集 (保存ボタンは押さない = 外側タップで終了)
  const cell = page.locator("#sExpanded .formatExpanded .formatCardValue").first();
  await inlineEditSet(page, cell, { value: "咳嗽が改善" });
  await expect(cell).toHaveText("咳嗽が改善");
  // 患者画面QR 平文にも反映
  await openQrPreview(page);
  expect(await page.locator("#qrTextPreview").textContent()).toContain("咳嗽が改善");
});

test("inline 編集中に戻る操作をしても入力済みの値が残る (自動保存)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  const cell = page.locator("#sExpanded .formatExpanded .formatCardValue").first();
  await inlineEditSet(page, cell, { value: "申し送り A" });
  await expect(cell).toHaveText("申し送り A");
  // もう一度開いて書き換え → 戻る → 編集だけ閉じ、書き換えた値が残る (破棄されない)
  const editing = await startInlineEdit(page, cell);
  await editing.locator(".formatCardEditInput").first().fill("書き換えた");
  await page.goBack();
  await expect(page.locator(".formatCardItem.editing")).toHaveCount(0);
  await expect(page.locator("#detailView")).toHaveClass(/active/);
  await expect(cell).toHaveText("書き換えた");
});

test("inline 編集中にリロードしても入力済みの値が残る (自動保存 + 永続化)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  const cell = page.locator("#sExpanded .formatExpanded .formatCardValue").first();
  const editing = await startInlineEdit(page, cell);
  await editing.locator(".formatCardEditInput").first().fill("リロード前の入力");
  // 編集を閉じずにリロード (debounce 180ms の保存完了を待ってから)
  await page.waitForTimeout(400);
  await page.reload();
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  await expect(page.locator("#sExpanded .formatExpanded .formatCardValue").first())
    .toHaveText("リロード前の入力");
});

test("別カードの値セルをタップすると編集は 1 箇所だけに移る (古いエディタが残らない)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // S カードで編集開始
  await page.locator("#sExpanded .formatExpanded .formatCardValue").first().click();
  await expect(page.locator("#sExpanded .formatCardItem.editing")).toHaveCount(1);
  // O カードの値セルをタップ → 編集は O に移り、S のエディタは消える (編集行は常に 1 つ)
  await page.locator("#oExpanded .formatExpanded .formatCardValue").first().click();
  await expect(page.locator(".formatCardItem.editing")).toHaveCount(1);
  await expect(page.locator("#oExpanded .formatCardItem.editing")).toHaveCount(1);
  await expect(page.locator("#sExpanded .formatCardItem.editing")).toHaveCount(0);
});

test("fracMode=text の fraction は inline 編集でも文字入力 (inputmode=text)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // S パネルに「文字入力の分数」フォーマットを作る (kind=fraction, fracMode=text)
  await page.locator("#sFormatStrip .tagPickerTrigger").click();
  await page.locator("#sFormatStrip .tagSettingAdd").click();
  await expect(page.locator("#formatEditOverlay")).toHaveClass(/active/);
  await page.locator("#formatEditName").fill("抗菌薬");
  await page.locator("#formatEditAddItemBtn").click();
  const itemRow = page.locator("#formatEditItems .formatEditItemRow").first();
  await itemRow.locator(".formatEditItemLabel").fill("CTRX");
  await itemRow.locator(".formatEditItemKind").selectOption("fraction");
  await itemRow.locator(".formatEditItemFracMode").selectOption("text");
  await page.locator("#formatEditSaveBtn").click();
  await expect(page.locator("#formatEditOverlay")).not.toHaveClass(/active/);
  // ☰ から開いて値を入れる → カードとして患者画面に出る
  await openFormatSheetViaHamburger(page, { strip: "#sFormatStrip", name: "抗菌薬" });
  const sheetFrac = page.locator("#formatInputBody .formatInputRow.fraction").first();
  await expect(sheetFrac.locator(".formatInputFracNumer")).toHaveAttribute("inputmode", "text");
  await sheetFrac.locator(".formatInputFracNumer").fill("CTRX");
  await sheetFrac.locator(".formatInputFracDenom").fill("1");
  await page.locator("#formatInputApplyBtn").click();
  await expect(page.locator("#formatInputOverlay")).not.toHaveClass(/active/);
  // カードになった「抗菌薬」(ラベル CTRX) を inline 編集 → 分数入力欄が文字キーボード
  const card = page.locator("#sExpanded .formatExpanded").filter({ hasText: "CTRX" });
  await card.locator(".formatCardValue").first().click();
  const editing = page.locator("#sExpanded .formatCardItem.editing");
  await expect(editing.locator(".formatInputFracNumer")).toHaveAttribute("inputmode", "text");
  await expect(editing.locator(".formatInputFracDenom")).toHaveAttribute("inputmode", "text");
});

test("クイック/ハンバーガー経由の入力はポップアップを維持し、開いても自動フォーカスしない", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await boot(page);
  await goToHome(page);
  await openPatient(page, 0);
  // 既定は全フォーマットが展開カードなので、ポップアップ経路用の非展開フォーマットを作る
  await createHamburgerFormat(page, { strip: "#sFormatStrip", name: "申し送り定型", label: "所見" });
  // ☰ ランチャーから開く → 従来どおりポップアップ入力シート (#formatInputOverlay) が開く
  await openFormatSheetViaHamburger(page, { strip: "#sFormatStrip", name: "申し送り定型" });
  // 開いただけでは入力欄に focus が入らない (中央ルール)
  const activeTag = await page.evaluate(() => (document.activeElement && document.activeElement.tagName) || "");
  expect(["INPUT", "TEXTAREA"]).not.toContain(activeTag);
  // 入力 → 消去 → 再入力 → 保存で再入力が残る (clearFormatSheet ドラフト回帰)
  const valRow = page.locator("#formatInputBody .formatInputRow").first();
  await valRow.locator(".formatInputValue").fill("初回入力");
  await page.locator("#formatInputClearBtn").click();
  await valRow.locator(".formatInputValue").fill("再入力");
  await page.locator("#formatInputApplyBtn").click();
  await expect(page.locator("#formatInputOverlay")).not.toHaveClass(/active/);
  // カードとして出て値が反映 ("再入力")
  await expect(page.locator("#sExpanded .formatExpanded .formatCardValue").filter({ hasText: "再入力" }))
    .toHaveCount(1);
});
