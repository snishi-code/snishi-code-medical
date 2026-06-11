<!--
Canonical source: Workspace/_workspace-management/agent-files/CLAUDE.md
This file is a copied distribution file. Do not edit it directly in this repo.
Update the canonical workspace file first, then sync copies to each repo.
-->

# CLAUDE.md — Claude Code 運用ルール

まず同じ repo の `AGENTS.md`(全 AI 共通の不変条件)を読むこと。本ファイルは Claude Code 固有の運用のみを定める。

## モデル運用

- main conversation のモデルはこのファイルでは指定しない。セッション側でユーザーが選ぶ。
- subagent には `sonnet` / `opus` のみ使う。Sonnet 未満のモデルは使わない。
- main conversation 用の高性能モデル名を subagent に固定指定しない。

## subagent への委任

単純・独立・大量出力になりやすい作業は main conversation で行わず、`.claude/agents/` の subagent に委任する。

- `sonnet-codebase-search` — grep、関連ファイル列挙、該当行調査(読み取り専用)
- `sonnet-log-summarizer` — test / build / lint / no-exfil ガードのログ整理
- `sonnet-mechanical-checker` — i18n、data-ui、CSS token、hardcoded color、生成物整合性などの機械的確認
- `opus-risk-reviewer` — 仕様影響、データ保全、local-first、fail-closed、移行リスクの限定レビュー

subagent の戻り値は短い要約(要点・該当ファイル・判断材料)に限定する。長いログ全文を main conversation に持ち帰らない。

## ブランチ / worktree

- Claude は指定された worktree だけを編集する。
- `dev` / `main` に直接 commit / push しない。作業は `claude/*` ブランチで行う。

## 配布ファイルの扱い

- 本ファイル、`AGENTS.md`、`.claude/agents/` 配下は `Workspace/_workspace-management/agent-files/` からの配布コピー。repo 側で直接編集しない。
