# UI 規約詳細（ポップアップ共通基盤）

> CLAUDE.md「ポップアップUIの基盤」から退避した詳細レシピ。
> load-bearing な要点（グローバル配線を再実装しない／単一・複数選択の閉じ方）は CLAUDE.md 側に残してある。

## ポップアップの共通基盤

`.popupMenuOverlay` / `.popupMenu` を使ったモーダル UI の規約。

```html
<div class="popupMenuOverlay" id="someOverlay">
  <div class="popupMenu someMenu">
    <button class="popupCloseX" type="button" data-close-popup
            data-i18n-aria="common.close" aria-label="閉じる">
      <svg width="20" height="20" viewBox="0 0 24 24" ...><line .../><line .../></svg>
    </button>
    <div class="popupTitle">タイトル</div>
    <!-- 本文 -->
  </div>
</div>
```

- `data-close-popup` 属性により `main.js` のグローバルハンドラが overlay を閉じる（event delegation。新しい popup を追加しても配線不要）。
- **背景タップで閉じるのもグローバル**: `.popupMenuOverlay` の背景タップで `main.js` のグローバルハンドラが閉じる。**個別 popup で `overlay.addEventListener('click', e=>e.target===overlay && close())` を新規配線しない**。明示確認が必須な popup（免責・PWA 初期化・取込選択など、背景タップで閉じてほしくないもの）は overlay に `data-no-backdrop-close` を付けて除外する。
- **閉じる専用 popup は横幅いっぱいの「閉じる」ボタンではなく、右上の `.popupCloseX`（× アイコン）を使う**。
- **「選んだら閉じる」か「開いたまま」かの基準**（popup の種類で決める）:
  - **単一選択 (close-on-select)**: 1 つ選んだら即閉じる。選択ハンドラ内で overlay を閉じる。例: ステータス選択ポップアップ。
  - **複数選択 (stay-open)**: 選んでも開いたまま。背景タップ / × で閉じる。例: タグ選択フィルタ。
  - 迷ったら「1回の操作で1つだけ決める = 単一 = 閉じる」「複数まとめて選ぶ = 開いたまま」。
- タッチ領域は 44×44 を維持（CSS で確保）、視覚的な × アイコンは 20px の控えめサイズ。
- 「保存」「キャンセル」「適用」など意味のあるアクションを持つ popup は従来通り横幅ボタン（× は使わない）。「確認しました」など単一アクションの確認系も従来通り（× ではなく大きなボタンが metaphor 的に正しい）。
- 追加クリーンアップ（state リセット・関連 flow の close 等）が要る popup は、× ボタンに id を併用して個別 listener を attach する（グローバルハンドラと加算的に動く）。
