<!--
Canonical source: Workspace/_workspace-management/agent-files/AGENTS.md
This file is a copied distribution file. Do not edit it directly in this repo.
Update the canonical workspace file first, then sync copies to each repo.
-->

# AGENTS.md — 全 AI 共通の不変条件

この repo は Workspace 配下の関連 4 repo(apex / personal / medical / foundation)の一つ。
AI 運用ルールの正本は `Workspace/_workspace-management/agent-files/` にあり、本ファイルはその配布コピーである。

## サイト憲法(全 repo 共通の不変条件)

- **外部送信ゼロ (no-exfil)**: ユーザー入力データは端末内のみ。`fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `navigator.sendBeacon` での外部送信は実装しない。GA / Sentry 等のトラッキングも入れない。全カテゴリで例外なし(「送信可」の例外文を作らない。例外文の存在自体が漏洩源になる)。
- **local-first**: データは IndexedDB 等の端末内ストレージ主体。クラウド同期は JSON 書き出し + ユーザー自身の外部手段に限る。
- **fail-closed**: データの保存・削除・移動など、壊れたら実害になる操作は失敗時に中断して明示通知する。成功扱いで先へ進めない(fail-open 禁止)。catch で握りつぶして続行しない。可視状態を durable 状態より先に進めない(多段操作は atomic か補償付き)。
- **中央ディスパッチャ**: 状態(app state / settings)を変更したら、必ず中央の再描画・更新経路を通す。ミューテーション箇所で個別 view の更新関数を列挙しない(特定 view の更新漏れバグの元)。
- **wire format の正本一元化**: QR 等のデータ交換フォーマットは正本モジュールを唯一の authority とし、別実装・重複定義を作らない。互換性を壊す変更をしない。
- **repo / origin 分離**: apex / personal / medical は別 repo・別 origin。横断 URL は正本ファイル経由で管理し、ハードコードしない。v2(foundation)は旧版と storage / Service Worker scope / appId を完全分離し、既存公開版を置き換えない。
- **build output と source**: 配信成果物(build output)は手で編集しない。source を修正してビルドで再生成する。逆に、タスクで指示されない限り build output の再生成も行わない。
- **アクセシビリティ / アイコン**: タップ領域は最小 44×44px。十字形・宗教シンボルのアイコンは使わない。UI 文言は i18n 経由とし、ハードコードしない。

## 作業管理

- 作業管理の正本は `Workspace/_workspace-management/`。
- Notion / Handoff / `_agent-handoff/` は使わない(廃止済み)。作業正本をこれらに戻さない。
- 実装指示の正本はユーザーとの会話本文。

## 役割分担

- Codex: 設計・監査・指示書支援
- Claude: 主実装担当
- 人間: 最終判断者

## 公開 repo に書いてはいけないもの

- 個人のローカル絶対パス、ローカルユーザー名、ホームディレクトリ
- パス表記は必ず `Workspace/...` の形に抽象化する。

## 配布ファイルの扱い

- 本ファイル、`CLAUDE.md`、`.claude/agents/` 配下は正本からの配布コピー。repo 側で直接編集しない。修正は正本を更新してから sync する。
