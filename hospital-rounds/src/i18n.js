"use strict";

// ============================
// 単純な i18n: 文字列をキーで引く + プレースホルダ展開
//
// 仕組み:
//   - strings.ja.json: { id: "テキスト", id2: "...{name}..." }
//   - t("id")            → "テキスト"
//   - t("id2", {name:"山田"}) → "...山田..."
//   - 未知 id を渡すと開発時はコンソール警告 + id 自体を返す (フェイルセーフ)
//
// HTML 静的属性 (title / aria-label) は data-i18n-* で記述して applyI18n() で埋める:
//   <button data-i18n-title="patient.delete" data-i18n-aria="patient.delete"></button>
// → applyI18n() が起動時に title=t("patient.delete") を反映。
//
// 将来 strings.en.json を足すときは、ロケール判定で読み込み先を切り替えるだけ。
// ============================

import dict from "./strings.ja.json" with { type: "json" };

const _missing = new Set();

export function t(key, params) {
  let s = dict[key];
  if (s == null) {
    if (!_missing.has(key)) {
      _missing.add(key);
      // 開発時の早期検出用。本番でも残しておくが console を見ないユーザーには無害
      console.warn("[i18n] missing key:", key);
    }
    s = key;
  }
  if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) {
      // replaceAll で 1 パス置換。split().join() 連鎖は値に "{x}" を含む時に
      // 後続パスが誤展開する (例: replace "{name}" → "山田{age}" → さらに {age} 展開) ため避ける
      s = s.replaceAll("{" + k + "}", String(v));
    }
  }
  return s;
}

// HTML 内の data-i18n-* 属性を t() で展開する。
//
// 呼び出し規約:
//   - 起動時に 1 回 main.js から applyI18n() (= document 全体) を呼ぶ
//   - 動的に DOM を作る各 render 関数では、生成した root に対して applyI18n(root)
//     を末尾で呼ぶ。動的部分には textContent などに t() を直接渡しても良い
//   - 動的 DOM が data-i18n を持たない (= 全部 t() 直接呼出) なら applyI18n(root) は不要
//
// サポート属性:
//   data-i18n             → element.textContent
//   data-i18n-title       → element.title
//   data-i18n-aria        → element.setAttribute("aria-label", ...)
//   data-i18n-placeholder → input.placeholder
export function applyI18n(root) {
  const host = root || document;
  host.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  host.querySelectorAll("[data-i18n-title]").forEach(el => {
    el.title = t(el.getAttribute("data-i18n-title"));
  });
  host.querySelectorAll("[data-i18n-aria]").forEach(el => {
    el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
  });
  host.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });
}

// 開発デバッグ用: t() を未知キーで呼んだ履歴を取得
export function getMissingI18nKeys() {
  return Array.from(_missing);
}
