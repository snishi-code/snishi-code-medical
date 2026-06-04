"use strict";

// ============================================================================
// アイコン登録簿 (Lucide ベース) — UI アイコンの「概念 → グリフ」正本
//
// 正本は apex リポの shared/icons.js。各アプリへ同一コピー（別 origin +
// 完全オフラインのため参照不可。site-links.js / サイト憲法と同じコピー運用）。
//
// 使い方: アイコンは「意味」で参照する（形名ではなく概念名）:
//   icon("share")            -> <svg ...>…</svg> 文字列 (既定 18px)  ← 推奨
//   icon("settings", 16)     -> サイズ指定
//   形名 (people/gear…) も後方互換で使えるが、新規コードは概念名を使う。
//
// 方針: 同じアイコンが複数箇所に drift するのを防ぐためグリフはここに 1 か所だけ定義。
//   新しい概念は勝手にグリフを足さず、まず既存トークンを再利用。無ければ Lucide から
//   選んで CONCEPT に概念名を足す。十字 (+) は使わない。
//   形マーク (ステータスの ▲✓✕★−) は tags.js の STATUS_TAG_MARK が単一ソース。
// ============================================================================

const PATHS = {
  // 人々 (共有 = チームへの申し送り)
  people: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  // 書類 (メモ)
  memo: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  // QR コード
  qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  // 家 (ホーム)
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  // 鉛筆 (編集)
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  // ゴミ箱 (削除)
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  // プラス (追加)
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  // × (閉じる)
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  // 歯車 (設定)
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  // ？ (ヘルプ)
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  // タグ
  tag: '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  // カメラ (QR スキャン)
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  // シェブロン (下)
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  // グリップ (ドラッグハンドル: 並び替え。Lucide grip-vertical)
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
};

// 概念 → グリフ（セマンティック・トークン）。UI はこの「意味」で参照する。
// 同じ意味で複数グリフを増やさない。新概念はここに 1 行足す。
const CONCEPT = {
  share: "people",        // チームへの申し送り / 共有
  problemList: "memo",    // プロブレムリスト / メモ
  scan: "camera",         // QR スキャン
  qr: "qr",               // QR 表示
  home: "home",           // ホーム
  edit: "pencil",         // 編集
  delete: "trash",        // 削除
  add: "plus",            // 追加
  close: "close",         // 閉じる
  settings: "gear",       // 設定
  help: "help",           // ヘルプ
  tag: "tag",             // タグ
  expand: "chevronDown",  // 展開 / シェブロン
  reorder: "grip",        // ドラッグ並び替えハンドル
};

export function icon(name, size = 18) {
  const key = CONCEPT[name] || name;   // 概念名なら解決、形名ならそのまま (後方互換)
  const p = PATHS[key] || "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
