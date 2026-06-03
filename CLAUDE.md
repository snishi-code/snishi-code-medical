# CLAUDE.md — snishi-code-medical（医療カテゴリ）

<!-- ===== サイト憲法（全リポ共通）ここから =====
  正本は apex リポ（snishi-code.com）。3リポに同一コピー。
  変更は apex で直し medical / personal へ反映する
  （別 origin のため物理コピーが必要。site-links.js と同じ運用）。 -->

## サイト憲法（全リポ共通・正本=apex）

### origin 分離
アプリは別サブドメイン（= 別 origin）に分離。各リポは自分のカテゴリだけを管理する。

| origin | repo | 内容 |
|---|---|---|
| `snishi-code.com`（apex） | `snishi-code.com` | カテゴリ入口（静的のみ） |
| `medical(-dev).snishi-code.com` | `snishi-code-medical` | 医療アプリ（回診ほか） |
| `personal(-dev).snishi-code.com` | `snishi-code-personal` | 個人アプリ |

main=本番 / dev=テスト。env はホスト名規約で判定（`-dev.` / `*.pages.dev` / `localhost` を test、他を prod）。特定ドメインを直書きしない。

### 外部送信ゼロ（絶対・例外なし）
ユーザー入力データは端末内のみ。`fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `navigator.sendBeacon` での外部送信は実装しない。GA / Sentry 等のトラッキングも入れない。**personal を含む全カテゴリで例外なし**（「送信可」の例外文を作らない＝例外文の存在自体が CLAUDE.md / メモリ経由の漏洩源になる）。
- **機械ガードで担保**: `tools/no-exfil-guard.sh` が pre-commit（`git config core.hooksPath .githooks`）と GitHub Action（`.github/workflows/no-exfil.yml`）の両方で走る。正規の同一オリジン通信（service worker のキャッシュ等）のみ該当行に `// network-ok: <理由>` を付けて承認する。
- **オフライン動作前提**。外部 CDN 読み込み禁止（ライブラリはバンドルに含め、ライセンス表記をファイル先頭に残す）。

### サイト横断リンク
apex ↔ medical ↔ personal の絶対 URL は `site-links.js` の1箇所で管理（**正本=apex**、各リポにコピー）。HTML は href を直書きせず `data-link="medical"` 属性で参照する。

### カラー / デザイン（共通）
- カラー変数は各リポ `shared.css` の `:root` が正本（`--blue` / `--green`（実値 teal） / `--neutral` + `-light` / `-border`）。ハードコード禁止。背景 `--bg: #f8fafc`、サーフェスは白。
- カテゴリ色: **apex=neutral `#475569` / 医療=blue `#2563eb` / 個人=teal `#14b8a6`**。**入口（apex）では青・緑を使わない**（neutral）。ビビッド系（黄・赤）・癖の強い紫は共通色に採用しない。
- カテゴリ代表アイコン: 医療=心電図波形、個人=芽（sprout）。サイトロゴ=`</>`。**十字・宗教的シンボルは避ける**。
- UIアイコンは Lucide。概念→グリフの正本は `shared/icons.js`（apex）で各アプリへコピー。**意味で参照**（`icon("share")` 等）し、新概念は既存トークン再利用／無ければ追加。固有ブランドロゴは別途ベクター（Lucide に無いものは手描き起こしに頼らない）。

### ドキュメント原則
**正本が別にあるものは CLAUDE.md にコピーせずポインタにする**（例: QR=`qr-protocol.js` 冒頭、色値=`shared.css :root`、撤去機能=git tag、UI/デザイン詳細=`docs/dev/`）。CLAUDE.md は「毎回必要な不変条件」だけに保つ。

<!-- ===== サイト憲法 ここまで ===== -->

---

## このリポジトリ固有

医療カテゴリのアプリを開発・配信（現行: `hospital-rounds/` 回診管理）。配信形態は **PWA** または **Vite + vite-plugin-singlefile の単一HTML**（CSS / JS を全インライン、1ファイルで動作）。`dist/` はコミットしない（Cloudflare Pages がビルド）。

- **ストレージ**: アプリデータ本体は **IndexedDB**。数バイトのポインタ・初回起動マーカー等のみ `localStorage` 可（同期 API で読みたい用途）。外部DB・クラウド同期は使わない。
- **データ互換性**: 開発初期（パイロット運用前）は **「最新版以降のみ対応」**。後方互換マイグレーションは持たず、`normalize*()` は最新スキーマ前提で書く。正式リリース後に実データが出たら段階的に後方互換を追加。

## 状態更新後の再描画（重要・繰り返しバグの元）

`appState` / `settings` を変更したら、**必ず中央の `refreshPatientUI()`**（`features/renderers.js`）を通して再描画する。これは現在アクティブな view（home / detail / memo / shared）を判定して該当 renderer を走らせ、各 QR も再生成する唯一のディスパッチャ。

- ミューテーション箇所で `doRenderHome()` / `doRenderDetail()` 等を**個別に列挙しない**。列挙すると detail など特定 view が漏れ、「操作したのに画面が自動更新されず、別ページに移動して戻ると直る」バグが繰り返し発生する（実際 `_onDataChange` が detail を列挙し忘れていたのが患者移動の自動更新バグの原因だった）。
- 永続化（`saveNow` / `scheduleSave` / `saveSettings` / `markUpdated`）は再描画を**しない**。保存と描画は別。変更したら「保存」と「`refreshPatientUI()`」の両方を呼ぶ。
- データ変化の汎用フックは `setDataChangeHandler`（= `_onDataChange`）。これ自体が `refreshPatientUI()` を呼ぶので、ドラッグ並び替え・移動・削除など home 経由のフローはこのフック経由にすれば自動で全 view が更新される。

## 個別アプリのアイコン

- 各アプリは**カテゴリ色 + 固有の形**で識別（カテゴリ色だけの汎用アイコンは禁止。複数アプリで見分けがつかなくなる）。
  - 回診アプリの実アイコン（PWA）は「円弧矢印（巡回）＋心電図」のラスター（正本 `hospital-rounds/scripts/icon-source.png` →`generate-icons.py`で生成）。Chrome 風に白背景へ浮かせる。
  - 医療カテゴリページ（`/index.html`）のカードは暫定でクリップボードの線画アイコンを使用（実アイコンとは未統一。ベクター化は保留）。
- **十字（+形）アイコンは使わない**: 赤十字・赤新月はジュネーブ条約で保護されている。十字はキリスト教を強く連想しイスラム教圏で違和感。医療らしさは心電図・聴診器・薬剤などのシンボルで出す。

## i18n（新規 UI 追加時は必ず適用）

ユーザの目に触れる文字列を直接ハードコードしない。基盤は `src/strings.<lang>.json`（例 `strings.ja.json`）+ `src/i18n.js`。

- **静的 HTML**: `data-i18n` / `data-i18n-title` / `data-i18n-aria` / `data-i18n-placeholder` 属性で書く（起動時 `applyI18n()` が `t()` で展開）。
- **動的 JS で生成する DOM**: `import { t } from "../i18n.js"` して `t("key")` を直接呼ぶ。プレースホルダは `{name}` 形式（`t("format.delete.confirm", { name: fmt.name })`）。
- 既存 `common.*`（save / cancel / close / delete / edit / add / apply / normal …）を最初に確認・再利用。同義キーを増やさない。
- **禁止**: `alert/confirm/prompt` への日本語リテラル直書き、`textContent` / `title` / `setAttribute("aria-label", …)` への UI 用語直書き、CSS `content:` への翻訳対象テキスト。
- **例外（i18n 不要）**: console ログ、データ層のフィールド名・定数キー（`STATUS.YELLOW = "yellow"`）、形マーク（`★ + −`）と SVG path。
- 新機能 PR の最後に `grep -n '"[ぁ-んァ-ヶ一-龯]"' src/` で漏れ確認。

## ポップアップUIの基盤

- 背景タップ / × 閉じは `main.js` のグローバルハンドラが担当。**個別 popup で閉じる listener を新規配線しない**（背景タップで閉じたくない popup は overlay に `data-no-backdrop-close`）。閉じる専用 popup は横幅ボタンでなく右上 `.popupCloseX`（× アイコン）。
- 閉じ方の基準: **単一選択=選んだら即閉じる / 複数選択=開いたまま**（背景タップ・× で閉じる）。
- **詳細レシピ（HTML 雛形・例外運用）は [`docs/dev/ui-conventions.md`](docs/dev/ui-conventions.md)**。

## ステータス色・記号

- D/P型（赤緑色盲）対応パレット（ペール背景 + 濃枠 + 濃文字の3層）+ **形マーク併用**で色だけに依存しない。
- 色↔記号は全UIで 1:1。`tags.js` の `STATUS_TAG_MARK` が単一ソース。青に `+`（十字）は使わず `★`。
- **厳密な hex 値・記号表は [`docs/dev/design-system.md`](docs/dev/design-system.md)**（値の正本は `shared.css :root` と `tags.js`）。

## QR Wire Format（端末間データ交換）

複数端末間で QR を介してデータをやり取りするアプリ（`hospital-rounds` 等）では、wire format を扱う処理は **必ず `src/features/qr-protocol.js` が export するヘルパー経由**。各 `qr-*.js`（qr-home / qr-shared / qr-settings / qr-format 等）で独自 format を新規定義しない。

新規フィールド追加・enum 拡張・短キー rename 時は、**必ず `qr-protocol.js` 冒頭の「QR Wire Format Authority」コメント（互換性ルール一覧）と各 kind の `WIRE_V` 定数を読んでから**対応する（互換ルールの正本はそのコメント）。設計2原則: 可変領域は冒頭辞書 + index 参照 / コード固定値は wire に含めない。

## アクセシビリティ

- ステータス・選択状態を色だけで示さない（形・アイコン・テキスト併用）。
- タッチ操作ターゲットは最小 **44×44px**（`.iconBtn` 等の汎用ボタン CSS で確保。意図的に小さくする狭幅 UI のみ専用クラスで `min-width:0 !important` 等を明示 override）。
- 長押し・ドラッグなど発見しづらい操作には、別の明示入口（ボタン等）も用意する。

## 撤去された機能の復元

過去に撤去した機能の参考実装は **git tag から diff で取得**できる（forward-compat により旧 bundle のデータは温存されるので再導入時のデータ移行は不要）:

- **タグ・カテゴリ機能（グループタグ）/ roster.js（Git-like ops 履歴）** … `hospital-rounds-v7.6.1` を base に diff。
- **ホームのステータス一括編集（色パレット）** … v8.7.0 直前。再実装時はピッカー由来クリックを edit-toggle.js の「外側タップで編集解除」判定から除外する必要あり（撤去時の既知バグ）。
