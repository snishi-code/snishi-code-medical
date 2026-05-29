# Hospital Rounds

現在のバージョン: 7.7.0

## バージョニング方針

[セマンティックバージョニング](https://semver.org/lang/ja/) (`MAJOR.MINOR.PATCH`) に従う:

- MAJOR: 破壊的変更（Bundle schema の bump や QR wire 形式変更など、旧データや旧バージョンとの相互運用が崩れる変更）
- MINOR: 互換性を保った機能追加
- PATCH: バグ修正

git tag は `hospital-rounds-v<MAJOR>.<MINOR>.<PATCH>` で打つ。

## リリース履歴

- **7.7.0** (**breaking**): タグ・カテゴリ機能と roster.js (Git ops 履歴) を撤去
  - **タグ・カテゴリ機能 (グループタグ) を撤去**:
    - tags.js §3 (TAG GROUPING) 約 130 行 + buildGroupSection ヘルパー
    - settings-view.js の renderTagGroups / renderTagGroupingToggleIcon /
      openGroupMembershipPicker + tagGroupingEnableBtn 配線
    - index.html の グループタグ機能 ON/OFF トグル + tagGroupsHost
    - constants.js の DEFAULT_TAG_GROUPING_ENABLED / GROUP_MODE_SINGLE /
      GROUP_MODE_MULTI / STATUS_GROUP_ID
    - defaults.json の tagGroupingEnabled / tagGroups / tagGroupAssign
    - qr-protocol.js の MODE_BY_INDEX / tagGroupToWire / tagGroupFromWire /
      tagGroupAssignToWire / tagGroupAssignFromWire
    - qr-settings.js の wire format から tge / tgs / tga (WIRE_V は 4 のまま、
      旧版 QR は forward compat で読める)
    - style/tags.css の .tagPickerSection* / .tagGroupCard* 等
    - 28 個の i18n キー (`tag.group.*` / `settings.tagGroup.*` /
      `qrSettings.summary.tagGroups` / `tag.statusGroup.name` /
      `settings.title.tagGroups` / `settings.help.tagsGroupsHidden`)
  - **roster.js (Git-like ops 履歴) を撤去** (admin 撤去以降 dormant):
    - features/roster.js (325 行) を削除
    - store.js の rosterState / setRosterState / normalizeRosterMeta
    - bundle.js の history section handling + FULL_BACKUP_SECTIONS から
      HISTORY を除外 + SECTION.HISTORY enum を撤去
    - constants.js の ROSTER_DIFF_WINDOW_DAYS
    - defaults.json の `_app.rosterDiffWindowDays`
    - main.js の compactHistory / flushCommit 呼び出し
    - 全 feature/view から recordOp 呼び出し (drag.js / room.js / tags.js /
      detail.js / memo.js / shared-list.js / settings-view.js /
      import-export.js / qr-home.js) 計 13 箇所
    - 関連テスト 2 件 (compactHistory フォールド + 冪等性)
  - **forward compat**: 旧 bundle に tagGroups / tagGroupAssign /
    tagGroupingEnabled / rosterState 等のフィールドが残っていても、
    `normalizeSettings` の未知フィールド温存ループで保持される。データ消失なし
  - **再実装ガイド**: CLAUDE.md に「撤去された機能 (再実装したい時の参照点)」
    セクションを追加。`git tag hospital-rounds-v7.6.1` を base に diff を取れ
    ば参考実装が手に入る
  - **結果**: ビルド 599 → **579 KB** (-20 KB)。テスト 57 → 53 件
- **7.6.1**: WS 名のヘッダー編集を復活 + 設定画面のラベルを DB アイコン化
  - **タイトル編集モード時に WS 名も editable に**: 鉛筆をタップ → タイトル・WS 名
    の両方が編集可能。blur / Enter で renameBundle を発火。設定画面の rename と
    二系統並立 (設定画面側は複数 WS をまとめて編集する用途に維持)
  - **設定画面「ワークスペース管理」カードのラベルを DB アイコンに**: 他のカード
    (タグ・クリア対象 等) と同じく文字ではなく SVG アイコンで統一。i18n キーは
    title/aria-label として保持
- **7.6.0**: HM 受信を新規 WS 化 + ヘッダー UI 再構成 + DB chooser 撤去
  - **HM 受信は常に新規ワークスペースに作成 + 切替** (qr-home.js)
    - 旧 reflect / append モード約 100 行を削除
    - 受信した名簿は「受信 YYYY-MM-DD HH:MM」というラベルで新規 WS として保存され、
      自動的に切り替わる。現在の WS は無傷
    - データ上書き事故ゼロ、WS 一覧が「データ来歴」になる
  - **ヘッダーの WS 名タップで WS picker (切替 + 新規作成のみ) を開く**
    - 新規 `features/ws-picker.js` + `wsPickerOverlay` HTML
    - appWsLabelInput を常時 readonly に降格 (rename は設定画面へ)
    - 鉛筆は端末タイトルの編集のみを担当
  - **設定画面に「ワークスペース管理」セクションを追加**
    - WS 一覧 (rename inline + delete per row)
    - JSON 取込 / 保存ボタンもここへ移植
    - 設定の最下部に配置 (頻繁には触らない設定操作)
  - **ヘッダーから Settings ボタンを撤去 → ハンバーガー内へ移動**
    - ハンバーガー: Settings + 全クリア + 全消去 (旧 DB アイコンは撤去)
    - ヘッダー右側: メモ / 共有 / ハンバーガー (3 ボタンに整理)
  - **DB chooser (ioChooserOverlay) を完全撤去**
    - HTML / CSS / JS の chooser 専用コードを削除
    - import-export.js は JSON ファイル I/O の責務だけに集中
    - WS rename / delete は settings-view.js に移植 (renderWorkspaceList)
  - i18n: `home.qrImport.newWs.*` 3 個追加 / `wsPicker.title` / `settings.title.workspaces` /
    `settings.workspace.hint` 追加 / `home.qrImport.reflected.*` / `.appended.*` /
    `.tagsAdded.*` / `io.title` / `io.db.title` 計 8 個削除
- **7.5.0**: style.css を 9 ファイルに分割 (DX 改善)
  - 2804 行の単一 style.css を `src/style/{base,header,views,detail,formats,memo-shared,tags,settings,popups}.css` の 9 ファイルに分割
  - **src/style.css は manifest のみ** (9 個の `@import` 文と分割方針のコメント)
  - vite-plugin-singlefile が build 時に全 css を 1 つの `<style>` として
    index.html に inline 化するので、**本番出力は分割前と同じ** (599 KB)
  - 分割の目的は開発体験 (DX) の改善のみ
    - PR diff が小さくなる (formatStrip だけ触る変更で 644 行ファイルだけ開けば良い)
    - grep / IDE 検索が浅くなる
    - git blame が意味のある粒度になる
  - 全 164 selector が分割後も保持されていることを `comm` で検証
  - テスト 57 件パス、build 成功、本番サイズほぼ不変
- **7.4.0**: main.js 解体 + i18n 漏れ全件修正
  - **main.js を「組み立て役」に戻した**: 729 行 → 472 行 (-35%)、inline 関数 19 個 → 1 個。
    本来 features/views に居るべきロジックを切り出し:
    - `features/renderers.js` (新設): `createRenderers(deps)` factory で
      `doRenderHome / doRenderDetail / doRenderMemo / doRenderShared / navigateToPatient / refreshPatientUI`
      を相互参照可能な closure として返す
    - `features/navigation.js` (拡張): `createNavigators(deps)` で
      `navToHome / navToMemo / navToShared / navToSettings` を追加。
      docs ナビゲーションも `createDocsOpener(deps)` で抽出
    - `features/header-menu.js` (新設): `initHeaderMenu()` + `closeHeaderMenu()` /
      `openHeaderMenu()`。ハンバーガーメニューの開閉と settingsDbBtn の menu
      閉じ配線をここに集約
    - `features/app-title.js` (新設): タイトル / WS 名 入力欄の配線を集約。
      `initAppTitle({getTitleToggle, navToHome})` でセットアップ、
      `refreshAppWsLabel()` / `updateAppTitle()` / `syncInputSize()` を export
    - `features/qr-scan.js` (拡張): `wireScanButton(btnId, areaId)` を public export
    - 死コード `updateMemoEditBtnVisibility` / `updateSharedEditBtnVisibility`
      (admin 撤去の no-op 残骸) を削除
    - 未使用 `features/crypto.js` (admin 撤去で誰も import していない) を完全削除
  - **i18n 漏れを 35 → 0 件**: 規約に違反していた直書き日本語を全て `t()` に。
    - `settings-view.js` 14 箇所 (編集 / 削除 / 単選択 / 複数選択 / グループ削除 /
      未分類 / グループ追加 / タグ名 / 閉じる / 別グループ / 未入力 / メモ / 共有 /
      ステータス：黄〜青 / 未登録メッセージ 等)
    - `views/home.js` の「緑: N / total」count chip
    - `views/detail.js` の QR 上限エラー + カメラ非対応 tooltip
    - `store.js` / `bundle.js` / `import-export.js` / `qr-protocol.js` の
      `"回診"` フォールバック → `t("app.title")`
    - `storage.js` の `DEFAULT_WORKSPACE_LABEL = "メイン"` → `getDefaultWorkspaceLabel()`
      関数化 (module 評価時の i18n 順序問題回避)
  - **新 i18n キー 23 個追加** (`settings.format.list.empty` / `settings.clear.*` /
    `settings.tagGroup.*` / `settings.tag.placeholder` / `ws.default.label` /
    `home.countChip` / `detail.qr.tooLong` 等)
  - テスト 57 件 / ビルド 599 KB
- **7.3.0**: フォーマットグループ ピッカーの簡素化 + ポップアップ × ボタン共通化
  - **フォーマットグループ ピッカー**: 「この患者の pin 表示を…」ヒント文を撤去。
    「通常 (全 pin 表示)」ボタンを廃止し、登録済みグループだけを並べる単選択トグルに。
    選択中のグループを再タップすると解除されて通常状態 (activeFormatGroupId="") に
    戻る。「通常」を選ぶ専用エントリは不要 (= 何も選んでいない状態が通常)
  - **共通 × アイコン (`.popupCloseX`)**: 「閉じるだけ」の 4 ポップアップ
    (formatGroupPicker / qrFormat / movePatient / ioChooser) で、横幅いっぱいの
    「閉じる」ボタンを撤去し、右上隅の × アイコンに統一。タッチ領域は 44x44 を
    維持しつつ視覚は 20px の控えめサイズ
  - **`data-close-popup` event delegation**: main.js にグローバルハンドラを 1 つだけ
    追加し、`data-close-popup` 属性が付いた要素のクリックで親 `.popupMenuOverlay`
    を閉じる。新規 popup を追加しても配線不要。追加クリーンアップが要る popup は
    既存の id 経由 listener と加算的に動く (冪等)
  - **未使用 i18n キー削除**: `formatGroup.picker.hint`, `formatGroup.option.none`,
    `formatGroup.option.none.sub`
  - **未使用 CSS 削除**: `.formatGroupHint`
  - **CLAUDE.md 更新**: 「ポップアップの共通基盤」セクションを追加 (× アイコンの
    使い分け、`data-close-popup` 規約、44x44 タッチ領域の維持方針)
- **7.2.0**: QR Wire Format Authority + DEFLATE 圧縮で 5 種統一
  - **背景**: ユーザ提案で QR 生成ロジックを「平文 (PT のみ)」「圧縮+暗号 (HM/MM/SH/ST/FMT)」の 2 パターンに整理。設計 2 原則を明文化:
    - 原則 ①「可変領域は冒頭辞書 + index 参照」(ユーザが順序を変えても壊れない)
    - 原則 ②「コード固定値は wire に含めない」(enum 許容値・デフォルト値は受信側コードで復元)
  - **`qr-protocol.js` を Wire Format Authority に拡張**: 冒頭に長文コメントで設計原則・短キー命名規約・enum 表・互換性ルール (WIRE_V bump 条件)・圧縮 prefix 互換性を一元定義。各 kind ファイルは必ず本ファイルが export するヘルパーを経由するルールに。`PANEL_BY_INDEX` / `KIND_BY_INDEX` / `MODE_BY_INDEX` を export し、`formatToWire` / `formatFromWire` / `patientToWire` / `patientFromWire` / `tagGroupToWire` / `tagGroupFromWire` / `tagGroupAssignToWire` / `tagGroupAssignFromWire` / `buildTagDict` で wire ↔ domain 変換を共通化
  - **enum を数値 index 化** (原則 ②): `panel` (S/O/A/P → 0/1/2/3)、`kind` (text/number/fraction/date → 0/1/2/3)、`tagGroup.mode` (multi/single → 0/1) を全 kind で index 化。デフォルト値 (joiner `, `、pinned/isDefault の false 等) は wire から省略
  - **タグ辞書共有化** (原則 ①): HM/MM/SH の top-level キーを `tags` → `td` に統一。ST 内の `format.tags` も settings.tags 辞書を共有して数値 index に。`tagGroupAssign` を `{タグ名:groupId}` → `[[tag_idx, group_idx]]` のペア配列に。tagGroups の `id` を wire から除外 (受信側で新発番)
  - **FMT QR (単独フォーマット) を共通ヘルパー化**: 短キー化 + enum 数値化が自動適用。tags は dict なしの inline 文字列 (FMT は単独なので辞書化のオーバーヘッドを避ける)
  - **`crypto-payload.js` に DEFLATE 圧縮層を追加**: 新 wire prefix `E2:` = `base64url(iv ‖ AES-GCM(deflate-raw(plain)))`。CompressionStream API (iPad Safari 16.4+) を使用、未対応端末は try/catch で `E1:` (圧縮なし) に自動 fallback。受信側は `E1:` / `E2:` 両方を読める (forward compat: 旧 v7.1.x で生成された QR も新版で読める)
  - **`maxBytes` を 750 で 5 kind 統一**: PT (800) / HM-SH (800) / ST (1100) / FMT (800) のバラバラだった上限を、QR version ~20 (~97 modules) で iPad camera で確実にスキャンできる 750 に統一。圧縮層が入ったことで ST も 1 ページに収まる
  - **WIRE_V bump**: HM/MM/SH v2→v3、ST v3→v4、FMT v1→v2
  - **実測 (defaults + 30 患者 + メモ込み)**:
    - HM (25 患者 + タグ): plain 702 chars → E2 暗号 283 chars (**59.7% 圧縮**)、2 ページ → **1 ページ**
    - MM (30 患者 + メモ): plain 1992 → E2 458 chars (**77% 圧縮**、LZ77 がメモ繰り返しを大幅潰し)、3 ページ → **1 ページ**
    - ST (defaults): plain 564 → E2 526 chars (**7% 圧縮**、データ小で deflate オーバーヘッドあり)、1 ページ
  - **CLAUDE.md 更新**: 「QR Wire Format」セクションを追加。新規 feature 開発者向けに「qr-protocol.js を必ず経由」「2 原則」「WIRE_V bump 条件は qr-protocol.js 冒頭参照」を明示
  - **テスト**: 46 → 57 件。enum 表の安定性 (歩哨テスト)、formatToWire / formatFromWire round-trip (tag dict あり/なし両方)、patientToWire / patientFromWire、tagGroup wire、tagGroupAssign の [[tag_idx, group_idx]] 形式 round-trip、ST 全体 round-trip、HM/MM v3 round-trip、E2 (deflate) 生成、E1 (legacy v7.1.x) 復号互換、平文パススルーを追加
- **7.1.1**: QR セキュリティ UI 非表示化 + 設定 QR の wire 短縮
  - **QR セキュリティ UI を非表示**: `qrSecurityCard` HTML を index.html から撤去、`renderQrSecurity` 関数 (約 60 行) を settings-view.js から削除。`settings.qrEncryption` / `settings.qrRedistribution` の設定モデル自体は維持しており、defaults (HM/MM/SH/ST/FMT 全暗号化 ON、HM/MM のみ再配布制限) が引き続きアクティブ。将来管理機能で再露出する想定で「現時点ではユーザに見えないバック設定」に格下げ。i18n キー 11 個 (`settings.title.qrSecurity` / `qrSecurity.*` 系 + `qrSettings.summary.defaults`) を strings.ja.json から削除
  - **設定 QR の wire format v3 (短キー化)**: 同一情報を保ったまま `formatToWire` / `itemToWire` で短キーに圧縮。formats → "f" / clearTargets → "ct" / tags → "tg" / tagGroups → "tgs" / tagGroupingEnabled → "tge" / tagGroupAssign → "tga"、format 内は name→n / panel→p / joiner→j / labelSep→ls / tags→t / pinned→pn / isDefault→d / items→i、item 内は label→l / kind→k / unit→u / normal→nm。空配列 / `false` 等の default 値は省略してさらに圧縮。format `id` は wire に載せない (受信側で新発番)。WIRE_V を 2 → 3 に bump
  - **`maxBytes: 1100` を ST flow に設定**: 設定 QR は一括書き出し 1 ショット用途であり HM/MM のような頻繁な更新ではないので、1 QR にできるだけ収まる密度に。QR ver ~26 (~117 modules) で iPad camera で十分読める範囲。デフォルト (800B) の 1.4 倍
  - **結果**: defaults の状態で plaintext 992 → 644 chars、暗号化後 1507 → 1043 bytes、ページ数 **3 → 1** ページに
  - テスト 46 件 / ビルド 595 KB 維持
- **7.1.0**: QR セキュリティ (暗号化 + 再配布制限) を kind 別の設定として導入
  - **暗号化**: `features/crypto-payload.js` 新設。Web Crypto API (AES-GCM 256bit、IV 12B、認証 tag 16B) でアプリ固定鍵 (32B、ビルドに埋め込み) を使った encrypt/decrypt。wire format は `E1:<base64url(iv ‖ ciphertext)>`。バージョン prefix `E1:` で将来更新に備える
  - **qr-flow.js**: `cfg.shouldEncrypt: () => boolean` を追加。送信時 encryptPayload で包む。受信時 `isEncrypted` 判定で自動 decrypt → cfg.decodePayload へ。patient detail QR (clinical → 電子カルテ貼付) は元から外部読取前提なので encrypt 対象外
  - **設定モデル**: `settings.qrEncryption: { HM, MM, SH, ST, FMT }` (boolean) + `settings.qrRedistribution: { HM, MM, SH, ST, FMT }` ("restricted" | "free")。defaults は HM/MM/SH/ST/FMT 全部暗号化 ON、再配布制限は HM/MM のみ ON
  - **`patient.origin: "" | "external"`**: 受信した患者は `origin="external"` でマーク (qr-home.js の reflect/append 両モード)。`encodePatientList` で `cfg.kind` ベースの再配布判定。restricted な kind で external 患者を除外
  - **設定画面**: 「QR セキュリティ」セクション (`qrSecurityCard`) 追加。5 kinds × 2 toggle (暗号化 / 再配布制限) のテーブル UI。各 toggle は即時 saveSettings
  - **i18n**: `settings.title.qrSecurity` / `qrSecurity.{hint,col.*,kind.*}` / `qr.recv.decrypt.failed` 追加
  - **テスト**: encrypt/decrypt round-trip、平文パススルー、defaults 検証、redistribution フィルタ動作の 4 件追加 (42 → 46 件)。tags.js の top-level `document.addEventListener` を `typeof document !== "undefined"` でガードし Node テスト環境で import 可能に
- **7.0.0** (**breaking**): 機能整理 + 患者移動を home メニューに統合
  - **印刷機能を完全削除**: `features/print.js` / `views/overview.js` / `createPrintFlow` / 各 view の Print ボタン / ハンバーガーの印刷ボタン / `.overviewPrintHead` / `.overviewTbl*` CSS / `overview.printHead` i18n を撤去。将来必要になった時は再設計予定 (今の電子カルテ普及状況では優先度低)
  - **管理機能を完全削除 (Git 基盤の roster.js は温存)**: `features/admin.js` / `admin-ui.js` / `passphrase-strength.js` を削除。`adminPanelWrap` HTML / 設定画面の管理セクション / `isAdmin*` 呼び出し全て撤去。`settings.adminEnabled` / `adminTerminal` / `rosterPassphrase` を defaultSettings / normalizeSettings から外し、関連 i18n キー 40 個 + `validateAdminTerminal` 関数を削除。**`roster.js` は温存** (Git-like commit history 基盤は将来の sync 機能で再利用)。`recordOp` のゲートを `if (!settings.adminEnabled)` から `if (!FEATURE_ROSTER_OPS)` (現在 false) に変更してドメインから admin を完全切り離し
  - **患者移動を home 長押しメニューに統合**: action menu を 2×2 → 3×2 に拡張、移動 ×1 / 移動 ×5 を追加 (青系、矢印アイコン)。`move-patient.js#movePatients(indices, destId, label)` で複数患者一括対応 (atomicity: 移動先 save 成功後に元 ws をマーク、失敗時は全くロールバック)。`openMovePatientModal` は単数/複数兼用、空患者は自動スキップ。患者画面ヘッダーの `detailMovePatientBtn` を撤去 (操作場所が「ホーム長押し」に統一)
  - **i18n**: `patientButton.action.move{1,5}.{title,aria}` / `move.confirm.bulk` 追加
  - **LOC 削減**: JS 9,649 → **8,912 行** (ネット **-737 行**)。ビルド 619 KB → **590 KB**
  - **テスト**: 45 → 42 件 (passphrase strength 3 件削除、roster 2 件は admin gate なしに改修して維持)
- **6.10.0**: フォーマット入力 UI のシンプル化 + グループトグルの視認性向上
  - **数字系フォーマットの備考欄を撤去**: `buildNumberRow` / `buildFractionRow` から memo input を削除。反映後に textarea で直接編集する想定。`applyFormatInput` の number / fraction 分岐から memo 連結を除去。`body.mixed` 4 列 grid は維持しつつ、memo 列は空 placeholder (`formatInputMemoPlaceholder`) で埋めて行間整合を保つ。date は memo を温存 (Labo/CT prefill 用)
  - **グループフォーマット トグルの刷新**: 旧 アイコンのみの `detailFormatGroupBtn` → テキスト + アイコン + chevron の `formatGroupToggleBtn` に。通常時は「通常」、active 時はグループ名 (例「発熱対応」) + 青ハイライトで適用状態が一目で分かる。`refreshFormatGroupToggle()` を `renderDetail` から呼んで患者切替時も即時更新
  - **ヘッダーアイコン順を統一**: 旧 `move / group / QR / ?` → 新 `move / group / ? / QR` (他画面の「? 左 / QR 右」と整合)
  - i18n: `formatGroup.toggle.active.title` / `formatGroup.option.none.label` 追加
- **6.9.0**: アーキテクチャ整理 (forward compat + 移植性の store adapter 化)
  - **forward compatibility**: `normalizePatientArray` と `normalizeSettings` を「未知フィールド温存型」に変更。new バージョンで追加されたフィールドを old バージョンが読み戻し → 再保存しても未知フィールドが失われない。`{ ...rawIfObject, ...validatedKnownFields }` パターン
  - **qr-format.js を store-agnostic 化**: `setFormatStoreAdapter({getExistingFormats, getKnownTags, addFormat})` で外部から read/write を注入。`settings` / `saveSettings` / `getAllTags` への直接 import を撤去。これにより他アプリへの移植 / Preact 化時の差し替えが容易に
  - **formats.js の save/delete を adapter 化**: `setFormatStoreAdapter({saveFormat, deleteFormat})` を追加。`saveFormatEdit` と `deleteFormatById` は adapter 経由で書き込む。adapter 未注入時は store 直接 mutate の fallback あり (単独 testing 用)
  - **main.js**: 上記 2 つの adapter に store の実体を結線。「hospital-rounds アプリ内で動かす時の adapter」が明示的に
  - **テスト**: forward compat の挙動を 2 件追加 (patient / settings 両方で未知フィールド温存)。43 → 45 件
- **6.8.0**: コードクリーンナップ (規約遵守 + レガシー撤去)
  - **レガシー後方互換コード撤去** (CLAUDE.md「データ互換性の方針」に従いパイロット前は最新版のみ対応): `LEGACY_O_RULES` / `migrateLegacyOandVitalsToText` / `_migrationORulesContext` / `rememberMigrationContext` / `ensurePatientsHaveAllOKeys` を撤去。`normalizeSettings` から旧 `defaults.{s,a,p}` / `doctors` / `adminImportOnly` / `oRules` の取り込みを削除。`normalizeFormat` から旧 `format.type` フォールバックを削除。`normalizePatientArray` から旧 `doctor` / `vitals` / `o` の流し込みを削除。`storage.js` から localStorage legacy fallback (`LEGACY_BUNDLE_KEY` 等) と `migrateLegacyTitleIfNeeded` を削除。`bundle.js` から `legacyToBundle` (旧 `{appState, settings}` 形式) を削除。`defaults.json` から `_migration_legacy_o_rules` を削除。これに合わせて test 側の legacy fixture / legacy migration テストも撤去 (53 → 43 件、品質低下なし)。**ネット -236 JS LOC**
  - **H2: タッチターゲット 44x44**: `.iconBtn` に `min-width/min-height: 44px` を設定 (CLAUDE.md 規約徹底)。リスト行の compact iconBtn (`.ioDbRowEdit` / `.ioDbRowDel` / `.ioJsonIconBtn` / `.formatEditQrBtn`) は `min-width: 0 !important; min-height: 0` で個別オーバーライド
  - **H1 + M3: HTML 日本語ベタ書きの i18n 化**: 8 個の `<div class="label">`/`.qrHint` 等に `data-i18n` を付与。ヘッダー / view header / QR ナビ / docs demo / admin の主要 35 個の `iconBtn` に `data-i18n-title` / `data-i18n-aria` を一括付与
  - **M5: CSS 色変数の整理**: `:root` に `--blue` / `--blue-light` / `--blue-border` を追加。`#2563eb` / `#eff6ff` / `#bfdbfe` / `#1e3a8a` の直書き 12+ 箇所を全部 `var(--...)` に置換 (フォールバック付き `var(--xxx, #yyy)` を除く)
  - **M4: import-export saveSettings 整理**: `unionImportedTags` / `applyImportedSettings` の中の `saveSettings()` 呼び出しを撤去し、呼び出し側 (`importFromBundle`) の `saveNow()` に集約。race の温床を解消
  - **CLAUDE.md 更新**: 「データ互換性の方針」セクション追加 (パイロット前は最新版のみ対応)、44x44 タッチターゲット規約を強調 (compact 例外パターン明示)
- **6.7.0**: フォーマットグループ + 患者画面ヘルプボタン追加
  - **データモデル**: `settings.formatGroups = [{id, name, formatIds: []}]` 追加。`patient.activeFormatGroupId` (空文字 = 通常モード) を追加
  - **挙動**: 患者画面のヘッダー「束」アイコン (`detailFormatGroupBtn`) → 単選択ピッカー → 選んだグループが `patient.activeFormatGroupId` に保存される。active なグループがあると、各パネルの strip の pin チップが「グループに含まれるフォーマットを panel フィルタした集合」に置き換わる (= お気に入りの動的切替)。グループモード中はチップが薄青色で視覚的に区別
  - **設定 UI**: 設定画面に「フォーマットグループ」セクション追加。+ ボタンで新規作成 → グループ編集モーダル (名前 + S/O/A/P 別のフォーマットチェックリスト)。各行に編集/削除アイコン
  - **? ヘルプボタン追加**: 患者画面のヘッダー右にも `helpLinkBtn` (`03_患者画面.html` へジャンプ) を追加 (他画面に倣う)
  - **module**: `src/features/format-groups.js` 新設 (CRUD + ピッカー + 編集モーダル)。`features/formats.js#groupFormatsForPanel` を export して strip 描画に活用
  - i18n: `formatGroup.*` (一連) を追加
- **6.6.0**: フォーマット 1 つを QR で共有する機能 (FMT wire kind)
  - `src/features/qr-format.js` 新設。`createQrFlow` を kind=FMT で利用。送受信ライフサイクルは既存 QR インフラ (qr-protocol / qr-flow / qr-scan) を流用
  - **送信**: フォーマット編集モーダル左下に QR アイコンボタン (`formatEditQrShareBtn`)。タップで `qrFormatOverlay` を開き編集中のフォーマット (= 未保存の状態でも OK) を QR エンコード表示
  - **受信ポリシー** (前回合意):
    - ID: 常に新発番 (上書きせず別物として追加)
    - 同名: `(2)`, `(3)`... 自動 rename
    - tags: 受信側に未登録のタグは無視
    - isDefault: 受信時は強制 false (元端末の運用設定を勝手に押し付けない)
  - i18n: `qrFormat.*`, `qr.kind.format` 追加
  - HTML: `qrFormatOverlay` + `qrFormatWrap` + scan/prev/next ボタン
- **6.5.0**: タイトル端末固定化 + ヘッダーに WS 名表示 + 画面更新バグ修正
  - **タイトル端末固定化**: 旧 `appState.title` (= per-workspace の `bundle.sections.meta.title`) を localStorage `hospital_rounds_device_app_title` に移行。workspace 切替や新規作成で title が「回診」に reset される不具合を解消。`storage.js#{getDeviceAppTitle,setDeviceAppTitle,migrateLegacyTitleIfNeeded}` を追加。初回起動時のみ旧 meta.title を localStorage へ 1 回マイグレート
  - **ヘッダーに WS 名表示**: `appWsLabelInput` をタイトル input の右に追加 (`/` セパレータ付き)。鉛筆編集モードで両方とも編集可能、Enter / blur で確定 (title は `updateDeviceTitle`、ws name は `renameBundle`)。DB モーダルから rename した時にもヘッダー表示が更新される (`refreshHeaderWsLabel` callback)
  - **画面更新バグ修正**:
    - workspace 切替時に `setSelectedNo(1)` を再描画より前にリセット (旧: 前 ws の slot 51 を新 ws で開こうとして空患者が描画されるバグ)
    - フォーマット反映時のタグ merge を `appendToPanel` より前に移動 (旧: 再描画が先に走り inline タグ表示が一拍遅れていた)
  - **i18n**: `header.{title.tooltip,ws.tooltip,ws.placeholder,edit.tooltip}` 追加
- **6.4.0**: 患者の他ワークスペース移動機能 (案 3: 元データ無傷 + マーカー方式)
  - **データモデル**: `patient.transferredAt: number` (0 = 未移動 / 移動時刻 ms) + `patient.transferredTo: string` (移動先 ws の label) を追加。元の name / room は触らない。`isPatientEmpty` は transferredAt が立っていたら false (履歴として残す)
  - **`features/move-patient.js`**: 新規モジュール。`listOtherWorkspaces` / `appendPatientToWorkspace` / `movePatient` / `openMovePatientModal` / `initMovePatient` を export
  - **移動の挙動**: 移動先 ws の bundle を IDB から load → patients 末尾に append (新 pid + status=BLUE + transferredAt クリア) → save。元 ws の患者を transferredAt/transferredTo 設定 + status=GRAY (物理 delete はしない、admin sync 連携時の誤データ消失を防ぐ)
  - **表示装飾**: `formatPatientLabel` で transferredAt > 0 なら名前に `(移)` prefix。`patientRoomCompare` ソートで transferredAt > 0 を末尾グループに押し出す。患者詳細画面ヘッダ直下に「{dest} へ転棟済 ({date})」のグレーバナー
  - **UI 入口**: 患者詳細画面の QR ボタン左に move-right アイコンボタン (`detailMovePatientBtn`)。タップで移動先ピッカー (現アクティブ以外の ws 一覧) → 確認 → 実行
  - **バグ修正**: `normalizePatientArray` の status whitelist に `STATUS.BLUE` が漏れており、BLUE 患者が次回ロードで NONE にリセットされていた問題を併せて修正
  - **i18n**: `move.{title,hint,confirm,list.empty,failed,banner,namePrefix}` を追加
  - **テスト**: `transferredAt が立っていれば空患者扱いしない` を追加 (53 件全通過)
  - **注意 (admin sync との関係)**: 現在 admin 機能は未実装。移動操作は物理 delete op を発火しないため、将来 admin が入っても他端末でデータが消えるリスクはない設計。admin 実装時に「移動先 ws を持たない端末向け」の表示ルール (= 元 ws のマーカーが信頼できる) を整える想定
- **6.3.2**: フォーマット入力モーダルの仕上げ
  - **iOS sticky inputMode 対策強化**: `setupNumericInput()` / `setupTextInput()` ヘルパを導入。IDL プロパティと HTML 属性 (`inputmode`) の両方を設定し、`pattern` / `autocomplete=off` / `autocapitalize=off` / `spellcheck=false` を付与、`focus` イベントで再アサート。fraction の数値入力でアルファベットキーボードが出るバグと、フィールド移動後にキーボード種別が残るバグを抑制
  - **入力欄の縦揃え**: `body.mixed` を flex → CSS grid 4 列 (`label / value / unit / memo`) に変更。fraction の `numer / "/" / denom` は `formatInputFracGroup` でラップして value セルに収め、date は空 unit span を出して列を保つ。これで BP / P / SpO2 / RR / T などで unit と memo の先頭が縦に揃う
  - **正常ボタンを小アイコン化**: `body.text` の `formatInputNormalBtn` を `flex-wrap` で 2 行に流れる大ボタンから、行内右端の 32×32 px チェックアイコン (緑) に戻す (旧 v6.0.0 と同等のサイズ感)
  - `.formatInputText` の `flex-basis: 100%` を撤去 (これが折り返しの原因だった)
- **6.3.1**: データ管理ポップアップの微調整
  - **横幅**: `.popupMenu.ioChooserMenu` を `min(92vw, 420px)` → `min(92vw, 360px)` に。レスポンシブのまま視覚的に締まる
  - **JSON 見出し**: 「JSON ファイル」→「JSON」 (`io.json.heading`)
  - **JSON ボタン**: テキスト 2 ボタン → 旧ヘッダーで使っていた下/上矢印アイコン (`.ioJsonIconBtn`) に戻す。aria-label / title は i18n キーで日本語を維持
- **6.3.0**: データ管理 UI をシンプル化 (★ 撤去 + 行内 rename + 「+」アイコン追加)
  - **★ マーカー撤去**: active workspace は青背景 + 太枠だけで識別。`ioDbRowActiveMark` クラスと SVG を削除
  - **行内 rename**: 各行に鉛筆アイコン (`ioDbRowEdit`) を追加。タップで label が input に差し替わり、Enter / blur で `renameBundle()` 実行、Escape で取消。挙動はタイトル編集パターンと同様
  - **「+」アイコン追加**: 旧「新規ワークスペース (空)」のヒント文 + 名前入力欄 + `新規作成して切替え` ボタンを撤去し、`+` アイコンのみの薄ボーダーボタン (`ioWsAddBtn`) に集約。タップで input に展開、Enter / blur で `createWorkspace()` 実行、Escape で取消 (タグ追加ウィジェットと同じパターン)
  - **ヒント文撤去**: 「タップで切替。★ が現在のワークスペース。」(`io.ws.list.hint`) を削除。視覚で十分わかるため
  - **storage.js**: `renameBundle(id, newLabel)` を新規 export。label のみを書き換え、bundle / updatedAt / title は触らない
  - **i18n**: `io.ws.rename.{title,failed}` 追加。旧 `io.ws.{list.hint,active.tooltip,create.hint,name.required}` を削除。`io.ws.create.action` の文言を「ワークスペースを追加」に変更
- **6.2.0**: ヘッダーの取込/保存アイコンを DB アイコン 1 つに集約 + JSON を脇役化
  - **ヘッダー UI**: 旧 `settingsImportBtn` (↓ 取込) と `settingsExportBtn` (↑ 保存) アイコンを撤去し、`settingsDbBtn` (lucide `database` シリンダー) 1 つに統合
  - **チューザ**: 旧 ワークスペース ↔ 端末ファイル のタブ切替 (`ioSourceToggle*`) を撤去。ワークスペース UI (一覧 + 切替 + 新規作成) が常時メイン領域に表示される構成に
  - **JSON 取込/保存**: `新規作成して切替え` ボタンの下に区切り線 + 「JSON ファイル」見出し + `[JSON 取込] [JSON 保存]` の小ぶり secondary ボタン 2 つを配置。アイコンではなく文字 (i18n キー `io.json.{heading,import,export}`)
  - **コード簡素化**: `import-export.js` の `_ioMode` / `_ioSource` ステート, `applyIoMode` / `applyIoSource` 関数, トグルボタン配線を撤去。`openIoChooser()` は引数なしで常に同じ UI を開く
  - i18n: `io.db.title` / `io.json.{heading,import,export}` 追加。旧 `io.tab.*` / `io.file.*` キーを削除
- **6.1.0**: フォーマット機能の拡張 (項目ごとの様式 + ラベル区切り + タグ連携 + fraction/date)
  - **項目ごとの kind 化**: 旧 `format.type === "numeric" | "text"` を撤廃し、`item.kind` (`"text" | "number" | "fraction" | "date"`) に。1 つのフォーマット内で混在可。`fraction` は BP のような `120/53` 形式 (数値2つ + 単位)、`date` は native `<input type="date">` で月/日のみ出力 (年は捨てる)。読み込み時に旧 `format.type` を全 item の kind に展開する 1 回マイグレーション
  - **ラベル区切り (`labelSep`)**: ラベルと値の間の区切り文字をフォーマット単位で指定可能に。既定は全 item が `text` なら `"："`、それ以外は半角スペース (`" "`)。`buildSoapParts` の fallback 出力にも反映
  - **タグ連携**: `format.tags[]` を追加。フォーマット編集モーダルの名前欄の右にタグピッカーを置き、反映時に対象患者のタグへ merge (重複追加なし、外す処理は無し)。設定上に存在しないタグは追加しない
  - **編集モーダル**: 「種類」select を削除し、各項目行に kind セレクタを設置。「項目追加」時は直前の item の kind を引き継ぐ。`labelSep` 入力欄を「区切り」の隣に追加
  - **入力モーダル**: kind 別に行レイアウトを切替。`fraction` は `[__]/[__] 単位 memo`、`date` は `<input type="date"> memo (normal が prefill)`
  - **i18n**: `format.field.{name,tags,joiner,labelSep,items}` / `format.itemKind.{text,number,fraction,date}` / `format.placeholder.{labelSep,dateMemo}` 等を追加
  - **テスト**: 既定 format の kind 構成 / 旧 `type` からの kind マイグレーションを検査 (52 件全通過)
- **6.0.0** (**breaking**): 院内パイロット向けセキュリティ強化 (PBKDF2 600k / CSP / SW 自動更新無効化 / 合言葉 12 文字制限 / 月次注意スプラッシュ)
  - **PBKDF2 iteration 100,000 → 600,000** (OWASP 2023 推奨値)。`src/features/crypto.js` の `PBKDF2_ITER` 定数のみ変更。E1 wire 形式は据え置きだが、旧 100k で作られた payload は復号できないため **breaking** (旧バージョンの端末と QR で相互運用しない前提)
  - **CSP メタタグ**: `index.html` の `<head>` に `Content-Security-Policy` meta タグを追加。`default-src 'self'` で外部送信を遮断、`connect-src 'self'` で fetch/XHR/WebSocket も同一オリジンに限定。inline script/style は単一HTML構成の都合上 `'unsafe-inline'` を許容、QR canvas のため `img-src` に `data:` / `blob:` を追加。`frame-ancestors` 等の HTTP-header-only ディレクティブは含めない
  - **Service Worker 自動更新の無効化**: `public/sw.js` から `skipWaiting()` と `clients.claim()` を撤去。新しい SW は `waiting` 状態に留まり、ユーザが PWA を完全に閉じて開き直すまで適用されない。院内運用は「ホーム画面から削除 → 再追加」での更新を前提に。SW キャッシュバージョンを v11 に bump
  - **合言葉 12 文字以上 + 強度メーター**: `src/features/passphrase-strength.js` を新設。長さ + 文字種多様性 (lower / upper / digit / symbol / 非 ASCII) で 4 段階スコア。設定画面の合言葉入力欄下にバー型メーターを表示 (D/P 型でも識別可能な amber/blue/green の3層パレット)。管理機能ON時の `prompt()` フローも 12 文字未満なら再入力を促すループに変更。`PASSPHRASE_MIN_LEN = 12` 定数で集中管理
  - **月次の利用注意スプラッシュ**: `src/features/splash-disclaimer.js` を新設。`hospital_rounds_disclaimer_last_shown_ms` を localStorage に保存し、30 日経過したら「これは個人メモであり正式な医療記録ではない / 入力不可項目」のダイアログを表示。home 描画後に await で 1 回呼ぶ
  - **テスト**: 合言葉強度関数のスモークテストを追加 (51 件全通過)
- **5.1.0**: PWA 初回起動時のデータ整理ダイアログ + Web 版警告バナー + ワークスペース UI の i18n 整備
  - `src/features/pwa-init.js` を新設。`display-mode: standalone` / `navigator.standalone` で PWA 起動を判定し、localStorage の MARKER が未設定なら overlay で「削除して開始 / 続きから使う」を提示。「削除」を選んだ場合は `indexedDB.deleteDatabase` + アプリ関連 localStorage キー全消去 + リロード
  - Web 版警告バナー: `<div id="webWarningBanner">` を header 直前に配置 (sticky)、PWA でない時のみ表示。「⚠ Web 版です。実データの入力は PWA (ホーム画面に追加) からどうぞ」
  - v5.0 で追加した workspace UI の動的文字列を `t()` 化、index.html の静的文字列を `data-i18n` / `data-i18n-placeholder` に置き換え。`strings.ja.json` に `io.*` / `pwa.init.*` / `web.warning.banner` のキーを追加
  - 空一覧の表示を CSS `:empty::before` から JS 駆動 (`.ioDbListEmpty` + `t("io.ws.list.empty")`) に変更して i18n 対応
- **5.0.0** (**breaking**): DB をワークスペースモデルに刷新 + roster は 30 日ローリング baseSnapshot で Git 管理 + SOAP/メモ/共有/設定はスナップショット
  - **データモデル**: IDB の `bundles` object store は「ワークスペース = 病棟・運用単位」のレコード集合。アクティブワークスペース ID は `localStorage["hospital_rounds_active_workspace_id"]` に保存 (= 同期 API で読みたい・ サイズ小)。既存 `default` レコードはそのままアクティブとして引き継ぐ
  - **切替 UX**: ワークスペース一覧でタップ → store が現アクティブを保存 → ポインタ更新 → 新ワークスペースを IDB から読み込み → live state 差し替え → `setOnWorkspaceChanged` ハンドラで全画面 re-render。「ぱっと入れ替わる」体験
  - **新規ワークスペース**: 入力欄の名前で `ws_<ts>_<rand>` の ID を発番し、空の bundle (default 50 患者 + 既定 settings) を作成、自動切替
  - **roster の 30 日ローリング**: `compactHistory(maxAgeDays)` を新設。`commits[]` のうち cutoff より古いものを baseSnapshot に折りたたみ、commits[] から落とす。アプリ起動直後に 1 回呼ぶだけで idempotent。個人情報の長期保持を回避する設計
  - **データ分類**:
    - Git 管理 (commit log + 30 日 baseSnapshot): roster identity (患者の名前・部屋・タグ・追加/削除/移動・タグリスト)
    - スナップショット (latest only): patients[].s / o / a / p / oFree / memo / shared / settings / meta
    - 切替はスナップショットを丸ごと入れ替え。SOAP は私物として保持されるが、別ワークスペースに切替えると当然見えなくなる (各ワークスペースは独立した bundle)
  - **UI 変更**: 入出力 chooser のタブを「ワークスペース」「端末ファイル」に再構成。`snap_*` の概念は撤廃 (既存の `snap_*` レコードはそのままワークスペースとして昇格して残る)。アクティブ workspace の行に ★ マークと色枠
  - **storage.js API**: `getActiveWorkspaceId()` / `setActiveWorkspaceId(id)` / `newWorkspaceId()` / `createWorkspaceRecord(label, bundle)` を新規 export。旧 `ACTIVE_BUNDLE_ID` / `newSnapshotId` は撤去
  - **store.js API**: `switchWorkspace(id)` / `createWorkspace(label)` / `setOnWorkspaceChanged(fn)` を新規 export
  - **テスト**: roster compactHistory のスモークテスト、storage workspace API のテストを追加 (48 件全通過)
- **4.1.1**: iOS でフォーマット入力モーダルの数値→備考/テキスト欄に移った時にテンキーが残るバグを修正
  - `buildNumericRow` の memo (`<input type=text>`) と `buildTextRow` の textarea に `inputMode = "text"` を明示的に指定。iOS Safari が直前 input の inputMode を引きずる既知バグへの対処
- **4.1.0**: ヘッダーメニューの入出力に「端末ファイル / DB スナップショット」トグル UI を追加
  - 取込・保存いずれも `ioChooserOverlay` を経由するように変更。トグルで「端末ファイル」「DB スナップショット」を切替
  - 取込: DB タブで保存済みスナップショット一覧を表示、行タップで取込 (取込後は既存の「設定込み / 患者のみ」ダイアログに合流)。各行に削除ボタン
  - 保存: DB タブでラベル入力欄 + 保存ボタン。`snap_<timestamp>_<rand>` の ID で新規エントリを作成。アクティブ bundle (`"default"`) とは分離して保管。下に既存スナップショット一覧 (削除可) も併設
  - `storage.js` を拡張: `saveBundle(bundle, id, label)` で第 3 引数 label を受けるように、`listBundles()` が label を含めて返すように、新規 `deleteBundle(id)` (active bundle は誤削除防止)、`newSnapshotId()` を追加
  - ファイル import 経路と DB import 経路は内部 `importFromBundle()` を共有。挙動は完全に同一 (空なら全置換、データありなら askImportAction で patients-only / include-settings 選択)
- **4.0.0** (**breaking**): 永続化バックエンドを localStorage から IndexedDB に移行 + 起動を async 化
  - `storage.js` を全面書き換え。`hospital-rounds` DB の `bundles` object store に bundle を 1 件 (id="default") として保存。`createIndex("updatedAt")` も先に貼って将来の multi-bundle / 並べ替えに備える
  - 初回起動時のみ localStorage の旧キー (`rounds_v2_soap_ryoyo_ward_bundle_v1` 他) を read-once フォールバックとして取り込む。次回 save で自動的に IDB に乗り換わる。localStorage 側は削除せず rollback hatch として残す
  - `loadBundle / saveBundle / listBundles` を Promise ベースに統一。`saveNow / saveSettings` も async に
  - `store.js`: module-init 時の同期 hydrate を撤去し、`initStore({bundle?})` を export。テストは `bundle` を直接渡せばストレージを経由しない (fake-indexeddb 等の依存追加なしで Node 上で動かせる)
  - `main.js`: 起動冒頭に `await initStore()` を追加 (top-level await)。これ以降のすべての top-level 処理は hydration 完了後に走る
  - `flushSavePending()` を追加。`beforeunload` / `visibilitychange="hidden"` で debounce 中の save を即時 transaction 開始に切替え、データ取りこぼしを抑制
  - 設定画面の「保存キー: ...」表示を「保存先 (IndexedDB): hospital-rounds.bundles」に変更
  - JSON ファイル import/export 機能は内部実装そのままで温存 (端末間移行・バックアップ用途)
- **3.5.0**: フォーマット picker で「checkbox = お気に入り / 名前タップ = 呼び出し」と役割分離 + 数値型入力モーダルを grid で縦揃え
  - `makeTagPicker` に `onItemClick(entry)` オプションを追加。指定時は行を `<label>` から `<div>` に切り替え、checkbox は従来通り選択トグル、名前部 `.tagPickerOptName` を独立クリック領域にする。フォーマット picker でこれを使い、お気に入り未登録のフォーマットも一度のタップで入力モーダルを開けるように
  - 副次バグ修正: `makeTagPicker` 非グループ経路の末尾 `+` ボタンが `addWidget` 上書きを無視して `makeAddTagWidget` 固定だった (= フォーマット picker でも `+` がタグ追加 UI を出してしまうケース)。`buildAddWidget` に統一
  - 数値型 (`format.type === "numeric"`) の入力モーダル本体を `display: grid` 化し、`label / value / unit / memo` の 4 列で行間縦揃え。`.formatInputRow` は `display: contents` で grid に直接展開
  - value 入力欄は `minmax(72px, 96px)` で「実数値より極端に広くならない」幅を強制。狭幅 (~480px 未満) では `minmax(64px, 1fr)` に切り替えてタッチしやすく
  - unit セルは値が無くても常に出して列を揃える (RR のような単位なしの行で memo の位置がズレないように)
- **3.4.0**: タグ・フォーマット strip のはみ出し挙動を `…` → 横スクロールに変更 + フォーマット strip をハンバーガー 1 個に集約
  - `inlineTagsRow` (患者ヘッダのタグ表示) を `overflow: hidden` + `::after "…"` から `overflow-x: auto` に変更。`recomputeInlineTagsOverflow` / ResizeObserver も撤去 (CSS のみで完結)
  - `formatStrip` を `[左 picker-icon][pinned chips][右 ≡]` から `[pinned chips (横スクロール)][右 ハンバーガー picker]` に再構成。左右の picker icon と `≡` が同じ「全フォーマット一覧」機能で重複していたのを 1 個に集約
  - ハンバーガー = `makeTagPicker` (iconOnly + ハンバーガー SVG) の薄いラッパで、popup 内のチェックボックスがお気に入りトグル、末尾 `+` で新規作成。チェックボックスなしの旧 `formatPickerOverlay` モーダルとその HTML / CSS / i18n キー (`format.picker.*`) を削除
  - `formatStrip > .tagPicker` は flex-shrink: 0 で右端固定。popup は `left: auto; right: 0` で右寄せして画面端からはみ出さないように
- **3.3.1**: フォーマット編集モーダルの項目追加・既存編集が無反応になるバグ修正
  - `features/formats.js` の `renderFormatEditForm` / `renderFormatEditItems` / `saveFormatEdit` / `addFormatItem` で `const t = _currentEdit.target` がインポート済み i18n `t()` をシャドウし、項目行描画時の `t("format.placeholder.label")` 等で TypeError が発生していた。局所変数を `target` にリネームして衝突を解消
- **3.3.0**: 既定値の JSON 分離 + i18n 基盤導入 + 取りこぼし回収
  - `src/defaults.json` を新設。`DEFAULT_FORMATS` / `DEFAULT_CLEAR_TARGETS` / アプリ内定数等の初期値を 1 ファイルに集約。`constants.js` は JSON を import して名前付き re-export するだけになり、「何を変更すれば既定が変わるか」が明示
  - `src/strings.ja.json` + `src/i18n.js` で多言語化基盤を導入。`t(key, params)` ヘルパでプレースホルダ展開、`applyI18n()` で HTML 内 `data-i18n-{title,aria,placeholder}` 属性を起動時に展開。未知 key は console.warn + key 自身を返すフェイルセーフ
  - JS 側のユーザー向け文字列を全て `t()` 化: 全 alert/confirm/prompt、フォーマット関連 UI (placeholder/tooltip/モーダルタイトル/同名 reject)、QR フロー (status/scanner overlay/import 結果)、管理パネル 12 箇所、admin.js の 7 種 error、tags.js の AND/OR/未分類/単選択/白黄緑灰青、設定タグ CRUD と管理機能 toggle
  - `STATUS_TAG_DEFS` と `STATUS_GROUP.name` を getter にして lazy 評価し、将来 locale 切替で再評価される構造に
  - app タイトル fallback "回診管理" → "回診" で統一 (`app.title` キー / index.html の value と整合)
  - `docs-demo.js` を `src/features/` → `src/docs/` に移動 (本体機能とドキュメント専用を分離)
  - HTML 静的 `title=` / `aria-label=` (88 箇所) の i18n 化はインフラのみ実装、属性付与は次フェーズに繰越
- **3.2.0**: 患者画面 strip をタグピッカー流に統一、設定一覧を行色化
  - 患者画面の format strip を `[format-icon] [pinned chips] [≡]` 構成に変更。format-icon は `makeTagPicker` を共通利用し、popup の checkbox = お気に入り (pinned) のトグル、末尾 `+` で新規作成モーダル
  - `makeTagPicker` をジェネリック化: `iconHtml` で iconOnly トリガーのアイコン差替、`addWidget` で popup 末尾の追加ウィジェット差替 (タグはインライン入力、フォーマットはモーダル起動)
  - 設定一覧の状態表示を ★/規定 チップ → 行背景色 + 左ストライプに変更 (お気に入り=緑、規定文=青、両方=上半分青/下半分緑のストライプ + 混色グラデ)
  - フォーマット編集モーダルの横スクロール解消: `width: min(92vw, NNNpx)` + `box-sizing: border-box` + 全要素 `min-width: 0` で完全レスポンシブに
  - バグ修正: 設定からの新規作成で入力モーダルが暴発するバグを撤去 (`_justCreated` 自動遷移フラグを削除)
  - バグ修正: ラベルなし規定文 (例: A 欄「著変なし」) を保存できなかった問題を修正 (text 型は label/normal どちらか有れば保持)
- **3.1.0**: フォーマットを SOAP の下に構造変更、デフォルト文を isDefault フラグに統合
  - 設定画面を S/O/A/P の 4 セクションに分割。各セクション配下にフォーマットが並ぶ構造に変更 (panel フィールドは内部に残置するが UI からは撤去)
  - 患者画面の S 欄にも format strip を追加
  - `settings.defaults.{s,a,p}` を撤去し、isDefault フラグ付きフォーマットに統合。編集モーダルに「規定文にする」チェック追加 (text 型のみ)、同一パネルで isDefault は 1 つだけ
  - 1 回マイグレーション: 旧 `settings.defaults.a/p` を panel="A"/"P" の isDefault text format に自動変換
  - 出力時、パネルが空欄なら isDefault フォーマットの `${label}：${normal}` 連結を fallback として使用
- **3.0.0** (**breaking**): O 欄をフォーマット概念に置換、構造化バイタル/所見を撤去
  - 患者画面の O 欄を「自由記述 textarea + フォーマットボタン」の構造に刷新。バイタル入力グリッド (SpO2/RR/BP/P/BT) と所見セクション (頭頸/肺音/腸音/腹部/食事/排泄) を撤去
  - 新しい `settings.formats[]` データモデルを導入: `{ id, name, panel, type:"numeric"|"text", joiner, pinned, items }`。numeric items は `{label,unit}`、text items は `{label,normal}`
  - 既定 2 件配布: バイタル (numeric/O/pinned) + 身体所見 (text/O/pinned)
  - 旧 `patient.vitals` と `patient.o[key].{normal,note}` を撤去。バンドル読込時に 1 回だけマイグレーション (旧構造化値を `${label}：${value}` テキスト化して `oFree` 末尾に流し込む)
  - 設定画面の oRules セクションを撤去、フォーマット一覧 + 編集モーダル + 同名 reject (タグと同挙動) に置換
  - フォーマット入力モーダル: numeric は label/数値/単位/備考、text は label/正常ボタン/textarea。反映で対象パネル textarea 末尾に追記
  - QR 設定共有 (qr-settings.js) のペイロードを oRules → formats に置換
- **2.10.0**: ホーム長押しメニュー再設計 (±1/±5 + 規定文ボタン化) + テスト書出ファイル名に test_ プレフィックス
  - 患者ボタン長押しのアクションメニューを「+1 / +5 / −1 / −5 + バツ」の 2×2 アイコングリッド構成に刷新。「空ボタンをまとめて削除」「キャンセル」ボタンは廃止
  - +1 / +5: 確認なしで挿入。−1: 対象患者が空ならポップアップなしで削除、データありなら confirm。−5: 長押し位置から後ろ 5 件 (末尾なら最大 5) を判定、全部空ならポップアップなし、1 つでもデータありなら confirm
  - レイアウト: 左列 = 追加 (+) 青、右列 = 削除 (−) 赤、下に閉じる X アイコン。形 + 色の二重識別 (D/P 型色覚配慮)、ポップアップの幅は `width: min(92vw, NNNpx)` でレスポンシブ
  - 患者操作モーダルのタイトル: `${name} の操作` → `formatPatientLabel(p, idx)` でホーム患者ボタンと同じ表記に統一
  - エクスポート JSON ファイル名: 本番以外 (test サブドメイン / localhost dev) の書き出しは `test_` プレフィックスを付与し、本番書出と区別可能に
- **2.9.0**: 未使用ボタンまとめ削除、灰ステータスを濃色化
  - ホーム画面の長押しメニューに「空ボタンをまとめて削除」を追加。`isPatientEmpty` (status = NONE (白) かつ 名前・部屋・タグ・SOAP・vitals・o 所見すべて初期値) を満たす「アプリを開いた直後から何も触っていない未使用スロット」を抽出し、件数を確認した上で一括削除して順序を詰める。YELLOW/GREEN/BLUE/GRAY はユーザーが明示的に状態を付けたボタンと見なし対象外（特に GRAY は「診察・カルテ記載終了」マークなので消さない）。`recordOp({type:"delete"})` を全削除分発火するため roster diff 同期も整合
  - 灰ステータスの bg を `#e5e7eb` (gray-200) → `#9ca3af` (gray-400) に一段濃く、文字を `#1f2937` → `#111827` に。「診察・カルテ記載が終わった患者」が一覧上で目立たないように沈ませる用途。色覚配慮の3層構造 (淡背景+濃枠+濃文字) は維持
- **2.8.0**: 配色刷新と sticky 額縁、QR カード整合、PWA アイコン Chrome 化
  - ステータスパレットを「淡背景 + 濃枠 + 濃文字」の上品なペール統一に変更。緑はペールティールから純グリーン (`#dcfce7` / `#16a34a` / `#166534`) に寄せ、D/P 型でも青と明確に分離。灰は背景を `#e5e7eb` に一段濃く
  - ヘッダーを白基調に。環境色はロゴ円バッジだけに残し (本番=青 / テスト=スレート)、PWA `theme-color` も白に統一してステータスバーとの段差を解消
  - `.detailTop` (額縁) に slate-50 背景 + 角丸、`position: sticky` でヘッダー下に貼り付け。`--headerH` を JS の `ResizeObserver` で実測してモバイル wrap でも揺れない
  - QR カードを home/memo/shared/settings/患者画面で同形式に統一。患者画面の「QRコード」ラベル・「N bytes」・「複数QR の場合は…」を削除、prev/next を cardHead に移動。テキストプレビューは患者画面のみ canvas 上に残し「内容確認 → スキャン」の自然な順序に。1/1 のときもページメタと prev/next は常時表示 (複数 QR の可能性を予期させるため)
  - PWA アイコンを Chrome アイコン風の「白いカード地 + 中央に色付き円 + 白ロゴ」に刷新。`scripts/generate-icons.py` を簡素化し、`manifest.json` の全アイコンに `purpose: "any maskable"` を付与してランチャー側で adaptive icon として扱われるよう明示
- **2.7.0**: 説明書ビューにインタラクティブデモバーを追加
  - すべての説明書ページの最上部に sticky なデモバーを表示。実際のホーム画面と同等の操作 (タップ・長押し・ドラッグ・編集・タグ・ソート) を読みながら触って体感できる
  - 患者ボタン操作: 短タップ = ステータスサイクル / 長押し = 追加・削除メニュー / ドラッグ = 並べ替え
  - 編集モード: 鉛筆タップで部屋・名前・タグの入力行に切替。外側タップで自動 exit (`createEditToggle` 流用)
  - タグピッカー: 本番と同じ AND/OR モード切替 + ステータス仮想タグ (黄/緑/灰/青) + 「+ 新規タグ」追加入力
  - 並べ替えボタンで部屋番号順 ON/OFF、リロードボタンで `defaultDemoState()` に巻き戻し
  - 追加は `DEMO_PATIENT_COUNT (=3)` まで。上限到達時は専用 popup で「先に削除してください」と案内
  - state は `features/docs-demo.js` 内のメモリ変数のみ。`localStorage` には一切書き込まず、`appState` / `settings` / `rosterState` から完全に分離 (実患者データ・実 settings に影響ゼロ)
  - 説明書ビューを抜けた瞬間に `html[data-view]` の MutationObserver で検知して `resetDocsDemo()`、自動でデフォルトに戻る
  - `features/drag.js` の `bindLongPressAndDrag` に optional `dragSelector` を追加 (本番呼び出し 4 箇所は無改造)
- **2.6.0**: ヘッダー刷新と取込挙動の QR 整合化
  - ヘッダー右側の `?` を撤去 (各画面右上の `?` で代替)、ハンバーガー内の「設定」をヘッダーに昇格し共有とハンバーガーの間に配置
  - 本番ヘッダーを `#2563eb` ソリッド背景に変更し、テストの `#475569` と同じ視認性。テキスト・アイコンは両環境とも白で統一
  - ヘッダー左の `<>` 環境バッジを「回転矢印 + 中央 ECG」のアプリロゴ (.appLogo) に差替え、両環境で常時表示
  - 現在ビューのハイライトを青系から白半透明 (`rgba(255,255,255,0.22)`) に変更し、青ヘッダー上でも視認可能に
  - JSON 取込フローを QR と整合化: 真っさら状態は popup/alert なしで全部取込 + 振動 80ms、データありは「設定も取込 / 患者のみ / キャンセル」popup に。**上書きモードは廃止**
  - 取込患者は常に末尾追加・`status=BLUE` で新着可視化。旧 `applyAppend` のスロット単位マージ・取込メモ集約は撤去
  - 「設定も取込」では `adminEnabled` / `adminTerminal` / `rosterPassphrase` のみ現端末の状態を維持 (管理機能は引き継がない)
  - 患者ステータスの長押しを「白 → 青」に拡張 (青 / 黄 / 緑 / 灰 → 白 は従来通り)。`statusOnLongPress()` を `detail.js` から export してホーム編集モードと共有
- **2.5.0**: ヘルプボタンと管理機能 UI の簡素化
  - ホーム / メモ / 共有 / 設定 の各画面右上に画面別の「?」ヘルプボタンを追加し、対応する説明書ページへ直接ジャンプ
  - 設定の管理機能カードを親トグルだけに簡素化（「この端末を管理端末に」「名簿取込のみ有効化」のサブトグルと下部説明文を撤去）
  - 管理機能トグル ON で `adminEnabled=true / adminTerminal=true`（合言葉 prompt 連動）。`adminImportOnly` は廃止
  - 管理端末から名簿コピーを受け取ると、受信側を `applyFullPayload` 内で自動的に被管理端末（`adminEnabled=true / adminTerminal=false`）に固定。脱出不可。トグルオフを試みると alert で拒否
  - 共有画面右上の順序を「管理 → ? → QR」に並び替え
- **2.4.0**: PWA インストール対応とアイコン刷新
  - ホーム画面に編集モード追加（鉛筆タップで患者ボタンを直接タップ・長押しでステータス変更）
  - ホーム / メモ / 共有 のフィルタ用タグピッカー、ホームの全消去 (`.dangerIcon`)、ヘッダー右側アイコン群の常時表示の枠/背景を撤去。普段は囲み無し、ホバー時と選択中ページのハイライトでだけ枠を出す
  - クリア／全削除 のアイコンを × の色違いから lucide `eraser` / `trash-2` に差替（形 + 色の二重識別、色覚多様性ガイドに準拠）
  - 設定のグループタグ機能ラベルアイコンを lucide `folder-tree` に
  - PWA アプリアイコンを作者作成の「回転矢印 ×2 + 中央 ECG 波形」デザインへ更新。`scripts/icon-source.png` を Pillow で読み、本番カラー (#2563eb) / テストカラー (#475569) に再合成して 192/512/180 を生成
  - PWA install 要件に合わせて maskable icon の透明角を target_color で塗り潰し（Android Chrome のインストールボタンが出るように）
  - SW キャッシュバージョンを v10 に bump
  - ホーム画面の クリア / 全削除 ボタンをハンバーガーメニュー末尾へ移動（誤タップしづらく）
  - ホーム画面のツールバーを `.detailTop` 構造に統一し、メモ / 共有 / 設定 と QR ボタンの垂直位置を揃えた
- **2.3.0**: 編集 UX 統一とインラインタグ
  - 編集トグルを共通ヘルパ `createEditToggle` に集約（タイトル / メモ / 共有 / 患者画面で同じ挙動。鉛筆で開始、外側タップ・別ビュー遷移で自動完了、完了ボタン廃止）
  - 詳細画面ヘッダーをコンパクト化し、患者名ボタンのタップでステータスを `白→黄→緑→灰→白` 巡回、長押しで白へリセット
  - 詳細画面ヘッダー右にタグをインライン表示。長押しで個別に外せる
  - `field-sizing: content` でアプリタイトル入力欄が文字数に自動追従
  - 「+ 新規タグ」UI を `makeAddTagWidget` で settings/患者/メモ/共有 全てで共通化（タップで入力欄、Enter / blur で確定、Escape でキャンセル）
  - 患者ボタンの英文長文オーバーフローを `overflow-wrap` で解消
- **2.2.0**: 詳細画面ヘッダー compact 化
  - 横並びの 3 ボタン式ステータスを廃止し、患者名ボタンに統合
  - ホーム/詳細/設定でも `sticky` 上部バー + 本体スクロール構造（メモ・共有と統一）
- **2.1.0**: UI polish
  - 現在ビューに応じてヘッダーアイコンを青枠ハイライト
  - 各画面の見出しテキスト（メモ/共有/設定）と QR カードのラベル・ヒント文を撤去
  - ページ表示を `(N/M)` のみに（byte 数表示廃止）
- **2.0.0**: QR wire 形式を 2 系統に統一（**breaking**）
  - 患者リスト系 (HM/MM/SH) を `{v,tags,p:[{r,n,t,c?}]}` の JSON+短縮キーに統一
  - 設定 (ST) を key-based JSON に書き直し（位置依存配列とスキーマ宣言 `ks` を廃止）
  - 共通フロー `createQrFlow` ファクトリと `qr-patient-list` モジュールに集約
  - 旧 V1 / 旧 V2 wire は受信不可（同じ dev branch 同士でしか相互運用しない前提）
- **1.3.0**: ホーム/メモ/共有/設定 全種 QR を導入
  - ホーム QR (名簿): 部屋+名前+タグ + タグ辞書、空状態で reflect / 既存で append（同名タグ衝突は `A(1)` 形式）
  - メモ QR / 共有 QR: name+room+tags+content マッチング反映、空でなければ受信メモ欄に dump
  - 設定 QR: 管理機能・端末固有値は持ち出さず、上書き confirm の上で安全フィールドだけ反映
  - 多ページバッチプロトコル (`RND_<KIND> #<batchId> N/M`)、連続スキャン、自動 apply
  - 設定 wire にスキーマ宣言 `ks` を追加（順序変更耐性）
- **1.2.0**: ヘッダー整理 + ハンバーガー
  - アプリタイトルを `普段はホーム遷移ボタン / 鉛筆で編集` に変更（メモ・共有と同じ編集パターン）
  - ヘッダーから「ホーム」「設定」ボタンを撤去し、☰ ハンバーガーに集約（設定・印刷・取込・保存）
  - 印刷ロジックを `createPrintFlow` ファクトリに集約
  - 各画面の印刷ボタン・総覧ボタンを廃止
- **1.1.0**: QR 受信 UX を全画面で共通化
  - 患者画面・メモ画面・共有画面に QR 受信カメラを追加
  - メモ画面に「受信メモ」スクラッチカードを新設（共有画面と同じパターン）
  - 受信時にタイムスタンプを付加
- **1.0.0**: データ構造リファクタ完了。正式リリース基準点
  - Bundle 形式（`format` / `schema` / `sections`）導入で前後互換を確保
  - `storage.js` で永続化を抽象化（IndexedDB 等への将来移行に対応）
  - `appState` から rosterState を分離（管理機能OFF時に名簿系メタを生成しない）
  - 管理機能QRペイロードを Bundle セクションで構築
  - 共有QRのタグピッカーを共有一覧と統一、状態を共有
  - 共有QRの受信フローを QR ボタン+カメラに集約
- **0.1.0**: snishi-code.com から hospital-rounds リポへ分割
