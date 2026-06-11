"use strict";

// ============================================================================
// TEMP: remove after initial-user data migration
//
// Phase 7 一回限り入力モデル移行。旧 patient.{memo,shared,s,oFree,a,p} を新
// formatValues (problem / shared panel) へ移し、旧フィールドを delete する。
//
// 方針:
//   - 全変換ロジックをこの1ファイルに閉じ込める (store / render 本体に散らさない)。
//   - 冪等: 旧キーが患者に無ければ no-op。何度読み込んでも壊れない。
//   - データを失わない: memo の各行を problem の # 番号 + 備考へ移し、パース不能な行や
//     番号項目を使い切った分は problem 末尾の自由記述 text 項目 (救済) へ原文保存する。
//   - dormant な旧自由記述 (s/oFree/a.text/p.text) は非空なら console.warn (PII 無し)
//     してから削除 (サイレントに捨てない)。
//
// 削除手順: 初期ユーザーが新形式で JSON を書き出して内容を確認したら、このファイルと
//   呼出箇所 (リポジトリを `TEMP: remove after initial-user data migration` で grep) を
//   まとめて削除できる。
// ============================================================================

// problem パネルの既定フォーマットと、number 項目 index 群・救済 text 項目 index を解決。
function resolveProblemTarget(settings) {
  const fmts = Array.isArray(settings?.formats) ? settings.formats : [];
  const fmt = fmts.find(f => f && f.panel === "problem");
  if (!fmt) return null;
  const items = Array.isArray(fmt.items) ? fmt.items : [];
  const numberIdxs = [];
  let salvageIdx = -1; // 救済 = 最後の text 項目 (problem 既定では末尾の自由記述受け皿)
  items.forEach((it, i) => {
    const kind = (it && it.kind) || "text";
    if (kind === "number") numberIdxs.push(i);
    else if (kind === "text") salvageIdx = i;
  });
  return { fmt, numberIdxs, salvageIdx };
}

// shared パネルの既定フォーマットと text 項目 index を解決。text 受け皿が無い形なら null
// (= 移行不能。number 等 index 0 に無理に入れる fallback はしない。fail-safe で旧 shared を保持)。
function resolveSharedTarget(settings) {
  const fmts = Array.isArray(settings?.formats) ? settings.formats : [];
  const fmt = fmts.find(f => f && f.panel === "shared");
  if (!fmt) return null;
  const items = Array.isArray(fmt.items) ? fmt.items : [];
  const textIdx = items.findIndex(it => ((it && it.kind) || "text") === "text");
  if (textIdx < 0) return null; // text 項目が無い → 受け皿が無いので移行できない
  return { fmt, textIdx };
}

// memo 1行を { num, note } にパース。"#1 HF" / "1 HF" / "1. HF" / "#1) HF" 等。
// 数字で始まらない行は null (= 救済へ)。
function parseProblemLine(line) {
  const m = String(line).match(/^\s*#?\s*(\d+)\s*[.)、：:]?\s*(.*)$/);
  if (!m) return null;
  return { num: m[1], note: String(m[2] || "").trim() };
}

const LEGACY_KEYS = ["memo", "shared", "s", "oFree", "a", "p"];
function hasLegacy(p) {
  for (const k of LEGACY_KEYS) if (k in p) return true;
  return false;
}

function migrateOne(p, problemT, sharedT, log, failures, idx) {
  if (!p || typeof p !== "object") return false;
  if (!hasLegacy(p)) return false;
  if (!p.formatValues || typeof p.formatValues !== "object") p.formatValues = {};

  // fail-safe: 「空 or 移行に成功したキー」だけを削除する。対象フォーマットが無く移行できない
  // 非空の memo/shared は **消さずに保持** する (一時移行は現データを守る境界。データを失わない)。
  const deletable = new Set();
  let mutated = false;

  // --- memo → problem ---
  const memo = (typeof p.memo === "string") ? p.memo : "";
  if (!memo.trim()) {
    deletable.add("memo"); // 空は安全に除去
  } else if (problemT) {
    const lines = memo.replace(/\r\n/g, "\n").split("\n");
    const slot = {};
    const salvage = [];
    let ni = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseProblemLine(line);
      if (parsed && ni < problemT.numberIdxs.length) {
        slot[problemT.numberIdxs[ni]] = { value: parsed.num, note: parsed.note };
        ni++;
      } else {
        // パース不能 or number 項目を使い切った → 救済テキストへ原文保存 (データを失わない)
        salvage.push(line);
      }
    }
    // 救済が必要なのに受け皿 (自由記述 text 項目) が無い → 全文を移しきれない。all-or-nothing で
    // memo を保持し失敗記録する (number スロットだけ入れて memo を消すと救済行が消失するため)。
    if (salvage.length && problemT.salvageIdx < 0) {
      failures.push(`patient[${idx}]: problem に自由記述(救済)欄が無く memo を完全に移行できません (保持)`);
    } else {
      if (salvage.length) {
        slot[problemT.salvageIdx] = { value: salvage.join("\n"), source: "manual" };
        log.push(`patient[${idx}]: problem 救済 ${salvage.length} 行`);
      }
      if (Object.keys(slot).length) {
        const prev = (p.formatValues[problemT.fmt.id] && typeof p.formatValues[problemT.fmt.id] === "object")
          ? p.formatValues[problemT.fmt.id] : {};
        p.formatValues[problemT.fmt.id] = { ...prev, ...slot };
        mutated = true;
      }
      deletable.add("memo"); // 全行を移せたので除去
    }
  } else {
    // problem フォーマットが無く移行できない → memo を消さずに保持 (fail-safe)
    failures.push(`patient[${idx}]: problem フォーマットが無く memo を移行できません (保持)`);
  }

  // --- shared → shared panel ---
  const shared = (typeof p.shared === "string") ? p.shared : "";
  if (!shared.trim()) {
    deletable.add("shared");
  } else if (sharedT) {
    const prev = (p.formatValues[sharedT.fmt.id] && typeof p.formatValues[sharedT.fmt.id] === "object")
      ? p.formatValues[sharedT.fmt.id] : {};
    p.formatValues[sharedT.fmt.id] = { ...prev, [sharedT.textIdx]: { value: shared, source: "manual" } };
    mutated = true;
    deletable.add("shared");
  } else {
    // shared フォーマットが無い or text 受け皿が無い → 移行できない → 消さずに保持 (fail-safe)
    failures.push(`patient[${idx}]: shared の text 受け皿が無く shared を移行できません (保持)`);
  }

  // --- dormant 旧自由記述 s/oFree/a.text/p.text: 非空なら log して削除 (Phase 3 以降 dormant・
  //     画面にも QR にも出ない。原則削除だがサイレントに捨てず log で気づけるようにする) ---
  const dormant = {
    s: typeof p.s === "string" ? p.s : "",
    oFree: typeof p.oFree === "string" ? p.oFree : "",
    "a.text": (p.a && typeof p.a.text === "string") ? p.a.text : "",
    "p.text": (p.p && typeof p.p.text === "string") ? p.p.text : "",
  };
  for (const [k, v] of Object.entries(dormant)) {
    if (v && v.trim()) log.push(`patient[${idx}]: dormant ${k} を削除 (${v.length}字)`);
  }
  for (const k of ["s", "oFree", "a", "p"]) deletable.add(k);

  // --- 旧キー削除 (空 or 移行成功したものだけ) ---
  for (const k of LEGACY_KEYS) {
    if (deletable.has(k) && (k in p)) { delete p[k]; mutated = true; }
  }
  return mutated;
}

// patients (in-place) を新入力モデルへ移行する。settings は problem/shared 既定フォーマットの
// ID 解決に使う (= そのストアの実 ID で formatValues を書く)。
// 戻り値: { changed, migrated, salvageLog, failures }。
//   failures = 対象フォーマットが無く移行できず **保持した** 非空 memo/shared の記録 (データは
//   失っていない)。呼び出し側はこれを見てユーザーに通知・再試行を促せる (fail-closed)。
export function migratePatientsInputModel(patients, settings) {
  const arr = Array.isArray(patients) ? patients : [];
  const problemT = resolveProblemTarget(settings);
  const sharedT = resolveSharedTarget(settings);
  const log = [];
  const failures = [];
  let migrated = 0;
  arr.forEach((p, i) => {
    if (migrateOne(p, problemT, sharedT, log, failures, i)) migrated++;
  });
  if (log.length) {
    console.warn(`[input-model-migration] 移行ログ (${log.length}件):`, log);
  }
  if (failures.length) {
    // 対象フォーマット欠落で移行できなかった (= データは保持済み・消していない)。loud に出す。
    console.error(`[input-model-migration] 移行できなかった項目 ${failures.length}件 (旧データは保持):`, failures);
  }
  return { changed: migrated > 0, migrated, salvageLog: log, failures };
}
