"use strict";

// ============================
// 編集トグル共通仕様
//
// アプリ内のあらゆる「鉛筆タップで編集モードへ」を一箇所に集約する。
//
// 共通挙動:
//   - 鉛筆 (triggerBtn) をタップで enter
//   - container 外をタップで exit
//   - 別ビューに遷移したら exit（navigation.js の showView() が exitAllEdits() を呼ぶ）
//   - 編集中は triggerBtn に `.editActive` クラスを付ける（青ハイライト）
//   - 「編集完了」専用ボタンは存在しない。鉛筆を再タップしても exit する
//
// ターゲット固有の処理は cfg に閉じる:
//   - container: 外側クリック判定の境界 (DOM 要素)
//   - onEnter:   編集モードに入った直後（フォーカス・再描画など）
//   - onExit:    編集モードを抜ける直前。false を返すと中断（編集継続）
// ============================

const activeToggles = new Set();

export function createEditToggle({ triggerBtn, container, onEnter, onExit }) {
  let editing = false;

  const api = {
    enter() {
      if (editing) return;
      editing = true;
      if (triggerBtn) triggerBtn.classList.add("editActive");
      activeToggles.add(api);
      if (onEnter) onEnter();
    },
    exit() {
      if (!editing) return;
      if (onExit && onExit() === false) return; // 中断
      editing = false;
      if (triggerBtn) triggerBtn.classList.remove("editActive");
      activeToggles.delete(api);
    },
    isEditing: () => editing,
    container: container || null,
  };

  if (triggerBtn) {
    triggerBtn.addEventListener("click", (e) => {
      // 鉛筆クリックが「外側」と判定されないように伝播を止める
      e.stopPropagation();
      if (editing) api.exit();
      else api.enter();
    });
  }

  return api;
}

// 全アクティブな編集モードを終了。ビュー遷移時などに呼ぶ。
export function exitAllEdits() {
  for (const t of [...activeToggles]) t.exit();
}

// memo/shared 鉛筆編集など、いずれかの編集トグルが編集中か。
// 戻る操作で「まず編集解除し、画面遷移はしない」を判定するために使う (app-history)。
export function isAnyEditing() {
  return activeToggles.size > 0;
}

// 文書全体で「コンテナ外クリック」を監視。
// バブル後に評価することで、対象要素のハンドラ（navTo* など）が先に動作する。
document.addEventListener("click", (e) => {
  for (const t of [...activeToggles]) {
    if (t.container && t.container.contains(e.target)) continue;
    t.exit();
  }
});
