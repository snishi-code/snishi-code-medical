"use strict";

// ============================
// フォーマット値ヘルパ (DOM 非依存)
//
// 展開(A)フォーマットの患者入力値は patient.formatValues に構造保存される:
//   formatValues[formatId] = { [itemIndex]: 値 }
//
// 各 item の保存形:
//   text     : 文字列 (規定文・所見)
//   number   : 旧 = 文字列 "96" / 新 = { value:"96", note:"O2 2L" }
//   fraction : 旧 = 文字列 "120/53" / 新 = { value:"120/53", note:"…" }
//
// note は「フォーマット定義」ではなく「患者ごとの入力値」(SpO2 の酸素投与量など短文
// 注記)。number/fraction だけが note を持つ。旧文字列値は note="" として読む
// (後方互換)。このモジュールは store.js / formats.js / payload.js が共有する
// 純データロジックを置く (DOM・store に依存しないので Node テストで直接検査できる)。
// ============================

import { DEFAULT_ITEM_KIND, DEFAULT_LABEL_SEP_OTHER, FORMAT_PANELS } from "../constants.js";

// ============================
// text item の provenance (Phase 6)
//
// text item の保存値は「正常文由来 (preset)」か「手入力由来 (manual)」かを区別する。
// これにより、ワンタップ正常チェックが手入力した臨床メモを誤って上書き/消去しない。
//   保存形 (text):
//     非空 = { value, source }  source ∈ "preset" | "manual"
//     空   = ""  (= 未入力。source は持たない)
//   legacy = 素の文字列 (旧 bundle のデータ)。読み取り時に現在の正常文と比較して推論する。
// 正常文の基準は「呼び出し側が渡す現在の format/item の normal」= settings.formats が正本
// (初期値 JSON や i18n 文字列は基準にしない)。
// QR 平文出力 (composeFormatFromValues) は value だけを出すので source は wire に出ない。
// ============================

// text 保存値から「現在の値文字列」を取り出す (object なら .value、文字列ならそのまま)。
export function readTextValue(stored) {
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    return String(stored.value ?? "");
  }
  return String(stored ?? "");
}

// text 保存値を { value, source } に正規化する。明示 source を持つ object は信頼し、
// legacy 文字列は現在の正常文と比較して source を推論する (空→empty / =normal→preset /
// それ以外→manual)。source は "empty" | "preset" | "manual"。
export function normalizeTextEntry(stored, currentNormal) {
  const normal = String(currentNormal ?? "");
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const value = String(stored.value ?? "");
    const src = stored.source;
    if (src === "preset" || src === "manual") return { value, source: value === "" ? "empty" : src };
    // source 欠落の object は legacy 同様に推論
    return { value, source: value === "" ? "empty" : (value === normal ? "preset" : "manual") };
  }
  const value = String(stored ?? "");
  return { value, source: value === "" ? "empty" : (value === normal ? "preset" : "manual") };
}

// ワンタップ正常チェックの判定 (純関数・ミューテーションしない)。呼び出し側 (formats.js)
// が戻り値の action に従って書き込み/編集起動する。
//   empty                         → write  (正常文を preset として入れる)
//   preset かつ値が現在の正常文     → clear  (空欄に戻す)
//   それ以外 (manual / 正常文以外)  → openEditor (上書きせず入力ポップアップを開く)
// 「設定で正常文を変更し、保存済み preset の値が現 normal と一致しない」場合も openEditor
// (黙って上書き/消去せず、明示編集に委ねる = fail-safe)。
export function decidePresetToggle(stored, currentNormal) {
  const normal = String(currentNormal ?? "");
  const { value, source } = normalizeTextEntry(stored, normal);
  if (source === "empty") return { action: "write", value: { value: normal, source: "preset" } };
  if (source === "preset" && value === normal) return { action: "clear", value: "" };
  return { action: "openEditor" };
}

// ポップアップ/インライン編集の保存時に text item の確定値を作る。draft 値が prev と
// 変わった item だけ manual entry 化し、未変更は既存 entry を保持する (ポップアップを開いて
// 別 item だけ編集 → 未タッチの preset を manual に降格させない)。空は "" (未入力)。
export function commitDraftTextEntry(prevStored, draftValue) {
  // draftValue は編集後の文字列 / 未編集なら元 entry のことがあるので readTextValue で正規化。
  const next = readTextValue(draftValue);
  if (next === "") return "";
  if (next === readTextValue(prevStored)) return prevStored; // 未変更は出所を保持
  return { value: next, source: "manual" };
}

// ============================
// フォーマット自動付与タグの delta (Phase 6 / Undo 対応)
//
// フォーマット入力時に format.tags を患者タグへ merge する (applyFormatTags)。Undo で
// 「入力は戻したのにタグだけ残る」を防ぐため、その操作で **新規に付くタグだけ** を delta と
// して扱い、Undo で除去 / Redo で再付与する。タグ列全体を巻き戻すと、間に手編集したタグを
// 失う (= 識別情報のサイレント巻き戻り) ため、必ず delta 単位で扱う。以下は純関数。
// ============================

// fmtTags のうち、known に存在し existing にまだ無いもの = この操作で新規に付くタグ。
// 入力順を保持し重複は除く。
export function computeFormatTagsToAdd(fmtTags, knownTags, existingTags) {
  const known = new Set(Array.isArray(knownTags) ? knownTags : []);
  const existing = new Set(Array.isArray(existingTags) ? existingTags : []);
  const out = [];
  const seen = new Set();
  for (const tg of (Array.isArray(fmtTags) ? fmtTags : [])) {
    if (!known.has(tg) || existing.has(tg) || seen.has(tg)) continue;
    seen.add(tg);
    out.push(tg);
  }
  return out;
}

// tags に toAdd を追加 (既存はスキップ・順序保持)。新しい配列を返す。
export function mergeTagsAdd(tags, toAdd) {
  const out = Array.isArray(tags) ? tags.slice() : [];
  const set = new Set(out);
  for (const tg of (Array.isArray(toAdd) ? toAdd : [])) {
    if (!set.has(tg)) { set.add(tg); out.push(tg); }
  }
  return out;
}

// tags から toRemove を除く。新しい配列を返す。
export function mergeTagsRemove(tags, toRemove) {
  const drop = new Set(Array.isArray(toRemove) ? toRemove : []);
  return (Array.isArray(tags) ? tags : []).filter(tg => !drop.has(tg));
}

// number/fraction の保存値を { value, note } に正規化する。旧文字列値も読める。
export function readNumericEntry(stored) {
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    return { value: String(stored.value ?? ""), note: String(stored.note ?? "") };
  }
  return { value: String(stored ?? ""), note: "" };
}

// 1 つの保存値に「入力がある」か判定する (空患者判定・サニタイズ用)。
//   number/fraction (object): value (スラッシュ除去後) か note のどちらかに文字があれば true
//   文字列 (text / 旧 number / 旧 fraction): スラッシュ除去後に文字があれば true
export function formatValueHasInput(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return !!(String(v.value ?? "").replace("/", "").trim() || String(v.note ?? "").trim());
  }
  return !!String(v ?? "").replace("/", "").trim();
}

// ============================
// 設定編集 (フォーマット item の削除/並び替え/種類変更) の破壊防止判定
//
// 患者の formatValues は item index に紐づくため、入力済みデータがある format の
// item を削除・並び替えすると、既存入力の意味ずれ (別項目へのずれ) や消失が起きる。
// ここは「どの index に入力があるか」の収集と、操作可否の純判定を置く (DOM/store 非依存)。
// dataIndices = Set<number> | null。null は「不明 (収集中 / 収集失敗)」= fail-closed で
// 全ブロック扱い (壊れる可能性がある間は破壊操作を通さない)。
// ============================

// patients[].formatValues[formatId] のうち入力がある item index の集合を into に集める。
// (note のみ入力も formatValueHasInput が「入力あり」と判定する)
export function collectFormatItemIndicesWithData(patients, formatId, into = new Set()) {
  for (const p of (Array.isArray(patients) ? patients : [])) {
    const vals = p?.formatValues?.[formatId];
    if (!vals || typeof vals !== "object") continue;
    for (const k of Object.keys(vals)) {
      const idx = Number(k);
      if (!Number.isInteger(idx) || idx < 0) continue;
      if (formatValueHasInput(vals[k])) into.add(idx);
    }
  }
  return into;
}

// item i の削除可否: "data" = その index に入力あり / "shift" = それより後の index に
// 入力があり、削除すると並びがずれる / null = 削除可。
export function formatItemDeleteBlocked(dataIndices, i) {
  if (!(dataIndices instanceof Set)) return "data"; // 不明は fail-closed
  if (dataIndices.has(i)) return "data";
  for (const idx of dataIndices) { if (idx > i) return "shift"; }
  return null;
}

// 並び替え可否: その format に 1 つでも入力があれば不可 (緊急修正では override 無し)。
export function formatItemReorderBlocked(dataIndices) {
  if (!(dataIndices instanceof Set)) return true; // 不明は fail-closed
  return dataIndices.size > 0;
}

// kind (種類) 変更可否: その index に入力があれば不可 (保存形が kind に依存するため)。
export function formatItemKindChangeBlocked(dataIndices, i) {
  if (!(dataIndices instanceof Set)) return true; // 不明は fail-closed
  return dataIndices.has(i);
}

// 値 + memo(注記) を組み合わせて「ラベル <labelSep> 値」を作る。
// 注記がある場合だけ末尾に半角スペース + 注記を付ける (例: "SpO2 96% O2 2L")。
export function combineLabelValueMemo(label, labelSep, value, memo) {
  const lab = String(label || "").trim();
  const val = String(value || "").trim();
  const m = String(memo || "").trim();
  // label が空なら値だけ出す (規定文「著変なし」など)
  let body;
  if (lab) body = `${lab}${labelSep}${val}`;
  else body = val;
  if (m) body += ` ${m}`;
  return body;
}

// 保存値 (formatValues[fid] = { itemIndex: 値 }) からフォーマット出力テキストを組み立てる。
// 展開(A)フォーマットの出力・流し込みで使う。fraction 値は "a/b" 文字列。
// number/fraction は note を末尾に付ける。戻り値: { text, hasValue }。
export function composeFormatFromValues(format, values) {
  const vals = (values && typeof values === "object") ? values : {};
  const labelSep = typeof format.labelSep === "string" ? format.labelSep : DEFAULT_LABEL_SEP_OTHER;
  const parts = [];
  (format.items || []).forEach((item, i) => {
    const kind = item.kind || DEFAULT_ITEM_KIND;
    const rawEntry = vals[i];
    if (kind === "number") {
      const { value, note } = readNumericEntry(rawEntry);
      const v = value.trim();
      if (!v) return; // 値なし注記だけは出力しない (文脈不明になるため)
      parts.push(combineLabelValueMemo(item.label, labelSep, `${v}${item.unit || ""}`, note));
    } else if (kind === "fraction") {
      const { value, note } = readNumericEntry(rawEntry);
      // "a/b" 両側空 ("" or "/") はスキップ
      if (!value.replace("/", "").trim()) return;
      parts.push(combineLabelValueMemo(item.label, labelSep, `${value}${item.unit || ""}`, note));
    } else {
      // text: provenance (preset/manual) は内部判定専用。出力は value だけ (source は wire に出さない)。
      const value = readTextValue(rawEntry).trim();
      if (!value) return;
      const lab = String(item.label || "").trim();
      parts.push(lab ? `${lab}${labelSep}${value}` : value);
    }
  });
  const body = parts.join(format.joiner || ", ");
  const titleWrap = typeof format.titleWrap === "string" ? format.titleWrap : "";
  let text = body;
  if (titleWrap) {
    const L = titleWrap[0] || "";
    const R = titleWrap[1] || "";
    const titleLine = `${L}${format.name}${R}`;
    text = body ? `${titleLine}\n${body}` : titleLine;
  }
  return { text, hasValue: parts.length > 0 };
}

// ============================
// パネル単位クリア (診察開始) — settings.formats[].panel を正本に formatId を解決する。
// Phase 7: 臨床入力本文は全て formatValues に集約 (旧自由記述フィールドは撤去) なので、
// 各パネルの展開フォーマット値を panel 単位で一括クリアする。
// ============================

// settings.formats のうち panel に属する formatId 一覧 (panel が正本)。
export function formatIdsForPanel(panel, formats) {
  if (!Array.isArray(formats)) return [];
  return formats.filter(f => f && f.panel === panel).map(f => f.id);
}

// panel に属する展開フォーマット値だけを患者から削除する (他 panel の値は触らない)。
export function clearPanelFormatValues(patient, panel, formats) {
  if (!patient || !patient.formatValues || typeof patient.formatValues !== "object") return;
  for (const fid of formatIdsForPanel(panel, formats)) {
    delete patient.formatValues[fid];
  }
}

// panel に所属する展開フォーマット値を一括クリアする (診察開始)。
// 6パネル (problem/S/O/A/P/shared) すべてが同じ仕組みを使うための単一ソース。
export function clearPanelClinicalInput(patient, panel, formats) {
  if (!patient) return;
  clearPanelFormatValues(patient, panel, formats);
}

// ============================
// 展開(expand)フォーマットの不変条件 (Phase 3 follow-up / 修正1)
//
// 「ワンタップ診察入力」を成立させるため、患者に適用しうる formatGroup は、各パネル
// (S/O/A/P) に最低 1 つの「展開(expand)フォーマット」= 常時タップ可能な入力カードを
// 持つ必要がある。ここではグループ + formats だけに依存する純データ判定を置く
// (DOM/store 非依存なので Node テストで直接検査できる)。format-groups.js が UI 配線
// (編集ブロック / 削除ブロック / 取込補修) からこれらを使う。
//
// 適用範囲: 「そのパネルのフォーマットを 1 つ以上含むグループ」のみを対象にする。
// あるパネルのフォーマットを 1 つも含まないグループ (例: O だけのカスタムセット) は
// 対象外 — 患者画面では effective group が当該パネルの expand を持たない時に
// デフォルトグループの expand へフォールバックするため (formats.js)。
// デフォルトグループは backfill で全パネルのフォーマットを必ず含むので全パネルが対象。
// ============================

// group の formatIds のうち、指定 panel に属するフォーマット一覧 (formats が正本)。
export function panelFormatsInGroup(group, formats, panel) {
  const ids = new Set(Array.isArray(group?.formatIds) ? group.formatIds : []);
  return (Array.isArray(formats) ? formats : []).filter(f => f && f.panel === panel && ids.has(f.id));
}

// group が指定 panel で「展開(expand)」フォーマットを 1 つ以上持つか。
export function groupHasExpandForPanel(group, formats, panel) {
  const expand = new Set(Array.isArray(group?.expandFormatIds) ? group.expandFormatIds : []);
  return panelFormatsInGroup(group, formats, panel).some(f => expand.has(f.id));
}

// group が「含むパネル」のうち、展開フォーマットが欠けているパネル一覧。
export function missingExpandPanelsForGroup(group, formats) {
  const out = [];
  for (const panel of FORMAT_PANELS) {
    const inPanel = panelFormatsInGroup(group, formats, panel);
    if (inPanel.length && !groupHasExpandForPanel(group, formats, panel)) out.push(panel);
  }
  return out;
}

// group が「含む全パネル」で展開フォーマットを持つか (= 不変条件を満たすか)。
export function validateGroupHasExpandedFormatForEveryPanel(group, formats) {
  return missingExpandPanelsForGroup(group, formats).length === 0;
}

// group 内で「ある panel の最後の展開フォーマット」が formatId かどうか
// (= これを expand から外すとその panel の expand が 0 になる)。編集UIのブロック判定。
export function isLastExpandInPanel(group, formats, formatId, panel) {
  const byId = new Map((Array.isArray(formats) ? formats : []).map(f => [f.id, f]));
  const expandInPanel = (Array.isArray(group?.expandFormatIds) ? group.expandFormatIds : [])
    .filter(id => byId.get(id)?.panel === panel);
  return expandInPanel.length === 1 && expandInPanel[0] === formatId;
}

// format を削除すると、いずれかのグループのいずれかのパネルで「最後の展開フォーマット」が
// 失われる (= expand が 0 になる) なら true。設定画面の削除ブロック / adapter 防御に使う。
export function formatRemovalBreaksAnyGroupExpand(formatId, formats, groups) {
  const fmt = (Array.isArray(formats) ? formats : []).find(f => f && f.id === formatId);
  if (!fmt) return false;
  for (const g of (Array.isArray(groups) ? groups : [])) {
    if (isLastExpandInPanel(g, formats, formatId, fmt.panel)) return true;
  }
  return false;
}

// group の各パネルで展開フォーマットが欠けている場合、そのパネルに属する formatIds の
// 先頭を expand に昇格して補修する (壊れた外部QR/旧データの救済)。group を in-place で
// 直して返す。formats が正本。取込パスから呼ぶ。
export function repairGroupExpandInvariant(group, formats) {
  if (!group) return group;
  if (!Array.isArray(group.expandFormatIds)) group.expandFormatIds = [];
  const byId = new Map((Array.isArray(formats) ? formats : []).map(f => [f.id, f]));
  for (const panel of FORMAT_PANELS) {
    const inPanel = (Array.isArray(group.formatIds) ? group.formatIds : [])
      .filter(id => byId.get(id)?.panel === panel);
    if (!inPanel.length) continue;
    if (inPanel.some(id => group.expandFormatIds.includes(id))) continue;
    group.expandFormatIds.push(inPanel[0]); // そのパネルの先頭フォーマットを展開に昇格
  }
  return group;
}
