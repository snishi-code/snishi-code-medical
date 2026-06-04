"use strict";

import {
  DEFAULT_PATIENT_COUNT, STATUS,
  DEFAULT_FORMATS, DEFAULT_FORMAT_GROUPS, FORMAT_PANELS,
  FORMAT_ITEM_KINDS, DEFAULT_ITEM_KIND,
  DEFAULT_LABEL_SEP_TEXT, DEFAULT_LABEL_SEP_OTHER,
  DEFAULT_CLEAR_TARGETS, DEFAULT_TAGS,
  QR_KINDS, DEFAULT_QR_ENCRYPTION, DEFAULT_QR_REDISTRIBUTION,
  clone,
} from "./constants.js";
import { projectBundle, parseBundle, getSection, SECTION } from "./bundle.js";
import { t } from "./i18n.js";
import { showToast } from "./toast.js";
import {
  loadBundle as storageLoad,
  saveBundle as storageSave,
  createWorkspaceRecord,
  listBundles,
  listAllWorkspaces,
  getActiveWorkspaceId, setActiveWorkspaceId,
  loadGlobalSettings, saveGlobalSettings,
  isStorageAvailable,
  ensureUsersInitialized,
  getCurrentUserId, setCurrentUserId,
  loadUsers, listUsers,
  createUser, renameUser,
  setUserActiveWorkspaceId, getUserActiveWorkspaceId,
  getDefaultUserName, userNameExists,
} from "./storage.js";

// ============================
// Settings defaults & normalization
// ============================

// 受信 (qr-settings / qr-set) でも ID 採番を共有するため export。
export function newFormatId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return "fmt_" + crypto.randomUUID();
  return "fmt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function newGroupId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return "grp_" + crypto.randomUUID().slice(0, 8);
  return "grp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function makeDefaultFormats() {
  return DEFAULT_FORMATS.map(f => ({
    id: newFormatId(),
    name: f.name,
    panel: f.panel,
    joiner: f.joiner,
    labelSep: typeof f.labelSep === "string" ? f.labelSep : DEFAULT_LABEL_SEP_OTHER,
    titleWrap: typeof f.titleWrap === "string" ? f.titleWrap : "",
    tags: Array.isArray(f.tags) ? f.tags.slice() : [],
    items: f.items.map(it => ({ ...it })),
  }));
}

// 既定フォーマットグループを、生成済み formats 配列の ID で組み立てる。
// defaults.json は formatIndexes / defaultFormatIndexes で formats を index 参照
// しているので (ID は実行時生成)、ここで index → 生成 ID に解決する。
export function makeDefaultFormatGroups(formats) {
  const seeds = Array.isArray(DEFAULT_FORMAT_GROUPS) ? DEFAULT_FORMAT_GROUPS : [];
  const groups = seeds.map(g => {
    const idxToId = (i) => (formats[i] ? formats[i].id : null);
    const formatIds = (Array.isArray(g.formatIndexes) ? g.formatIndexes : [])
      .map(idxToId).filter(Boolean);
    const defaultFormatIds = (Array.isArray(g.defaultFormatIndexes) ? g.defaultFormatIndexes : [])
      .map(idxToId).filter(id => formatIds.includes(id));
    // expandFormatIds = グループ内で「展開(A)」にするフォーマット。残りは「クイックアクセス(B)」
    const expandFormatIds = (Array.isArray(g.expandFormatIndexes) ? g.expandFormatIndexes : [])
      .map(idxToId).filter(id => formatIds.includes(id));
    return { id: newGroupId(), name: String(g.name || ""), isDefault: !!g.isDefault, formatIds, defaultFormatIds, expandFormatIds };
  });
  return ensureOneDefaultGroup(groups);
}

// formatGroups の不変条件: 1 つ以上あるなら「ちょうど 1 つ」が isDefault=true。
// 0 個 / 複数 true なら先頭を default に昇格 (残りは false)。空配列はそのまま返す。
export function ensureOneDefaultGroup(groups) {
  if (!Array.isArray(groups) || !groups.length) return groups || [];
  const firstDefault = groups.findIndex(g => g.isDefault);
  const keep = firstDefault >= 0 ? firstDefault : 0;
  groups.forEach((g, i) => { g.isDefault = (i === keep); });
  return groups;
}

export function defaultSettings() {
  const formats = makeDefaultFormats();
  return {
    v: 1,
    formats,
    // フォーマットの「束」。患者ごとに 1 つ active group を設定すると、各パネルの
    // strip チップがそのグループに属するフォーマットだけに切り替わる。active 未指定の
    // 患者は isDefault=true のグループ (= デフォルトグループ) に解決される。
    // デフォルトグループは起動時に必ず 1 つ存在する (defaults.json の formatGroups)。
    formatGroups: makeDefaultFormatGroups(formats),
    clearTargets: clone(DEFAULT_CLEAR_TARGETS),
    tags: clone(DEFAULT_TAGS),
    deviceId: "",
    // v7.7+: tagGroupingEnabled / tagGroups / tagGroupAssign は撤去。
    // 旧 bundle に含まれる場合は normalizeSettings の未知フィールド温存で
    // 保持されるが、UI からは触れない
    // QR セキュリティ: kind 別の暗号化フラグ ("HM" → true/false)
    qrEncryption: clone(DEFAULT_QR_ENCRYPTION),
    // QR 受信したデータの再配布制限: kind 別 ("restricted" | "free")
    qrRedistribution: clone(DEFAULT_QR_REDISTRIBUTION),
  };
}

// item は kind ごとに必要なフィールドだけ持つ:
//   text     : { label, kind:"text",     normal }
//   number   : { label, kind:"number",   unit   }
//   fraction : { label, kind:"fraction", unit   }   // 日付 "5/20" もこれで入力
function normalizeFormatItem(item) {
  if (!item || typeof item !== "object") return null;
  const label = String(item.label ?? "").trim();
  const rawKind = typeof item.kind === "string" ? item.kind : "";
  // 旧 "date" (カレンダー) は fraction に移行統合
  let kind;
  if (rawKind === "date") kind = "fraction";
  else kind = FORMAT_ITEM_KINDS.includes(rawKind) ? rawKind : DEFAULT_ITEM_KIND;
  // text / fraction は label 任意 (text=規定文、fraction=日付 "5/20" 等)。number のみ必須。
  if (!label && kind === "number") return null;
  const out = { label, kind };
  if (kind === "number" || kind === "fraction") {
    out.unit = String(item.unit ?? "");
  } else {
    // text / date は normal を持つ
    out.normal = String(item.normal ?? "");
  }
  return out;
}

function inferLabelSepFromItems(items) {
  if (!items || !items.length) return DEFAULT_LABEL_SEP_OTHER;
  const allText = items.every(it => it && it.kind === "text");
  return allText ? DEFAULT_LABEL_SEP_TEXT : DEFAULT_LABEL_SEP_OTHER;
}

function normalizeFormat(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name ?? "").trim();
  if (!name) return null;
  const panel = FORMAT_PANELS.includes(raw.panel) ? raw.panel : "O";
  const id = (typeof raw.id === "string" && raw.id) ? raw.id : newFormatId();
  const items = Array.isArray(raw.items)
    ? raw.items.map(normalizeFormatItem).filter(Boolean)
    : [];
  const joiner = typeof raw.joiner === "string" ? raw.joiner : ", ";
  // labelSep: 明示指定優先、なければ items から推定
  const labelSep = typeof raw.labelSep === "string" ? raw.labelSep : inferLabelSepFromItems(items);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter(t => typeof t === "string" && t.trim()).map(t => String(t))
    : [];
  // titleWrap: 患者画面へ展開する時にフォーマット名を囲む括弧ペア (例 "（）")。
  // 空文字 = タイトル行を出さない。1 文字目=左括弧 / 2 文字目=右括弧。
  const titleWrap = typeof raw.titleWrap === "string" ? raw.titleWrap : "";
  return { id, name, panel, joiner, labelSep, titleWrap, tags, items };
}

function normalizeSettings(raw) {
  const out = defaultSettings();
  if (!raw || typeof raw !== "object") return out;
  // 未知フィールド温存 (forward compatibility): 旧バージョンが新版で追加された
  // フィールドを読んだ時に消失しないように、out に無いキーは raw からそのまま持ち越す。
  // 既知フィールドは下で validation + デフォルト補完されて上書きされる。
  for (const k of Object.keys(raw)) {
    if (!(k in out)) out[k] = raw[k];
  }
  // formats: 新規登録された設定。空または欠落ならデフォルトを採用。
  if (Array.isArray(raw.formats)) {
    const cleaned = raw.formats.map(normalizeFormat).filter(Boolean);
    if (cleaned.length) out.formats = cleaned;
  }
  if (raw.clearTargets && typeof raw.clearTargets === "object") {
    const ct = raw.clearTargets;
    out.clearTargets = {
      memo:   typeof ct.memo   === "boolean" ? ct.memo   : DEFAULT_CLEAR_TARGETS.memo,
      s:      typeof ct.s      === "boolean" ? ct.s      : DEFAULT_CLEAR_TARGETS.s,
      o:      typeof ct.o      === "boolean" ? ct.o      : DEFAULT_CLEAR_TARGETS.o,
      a:      typeof ct.a      === "boolean" ? ct.a      : DEFAULT_CLEAR_TARGETS.a,
      p:      typeof ct.p      === "boolean" ? ct.p      : DEFAULT_CLEAR_TARGETS.p,
      shared: typeof ct.shared === "boolean" ? ct.shared : DEFAULT_CLEAR_TARGETS.shared,
      statusYellow: typeof ct.statusYellow === "boolean" ? ct.statusYellow : DEFAULT_CLEAR_TARGETS.statusYellow,
      statusGreen:  typeof ct.statusGreen  === "boolean" ? ct.statusGreen  : DEFAULT_CLEAR_TARGETS.statusGreen,
      statusGray:   typeof ct.statusGray   === "boolean" ? ct.statusGray   : DEFAULT_CLEAR_TARGETS.statusGray,
      statusBlue:   typeof ct.statusBlue   === "boolean" ? ct.statusBlue   : DEFAULT_CLEAR_TARGETS.statusBlue,
    };
  }
  if (Array.isArray(raw.tags)) {
    out.tags = raw.tags.filter(d => typeof d === "string").map(d => String(d));
  }
  if (typeof raw.deviceId === "string") out.deviceId = raw.deviceId;
  // v7.7+: tagGroupingEnabled / tagGroups / tagGroupAssign は撤去。
  // 旧 bundle のフィールドは forward compat の未知フィールド温存ループ (loop の
  // 先頭で out に無いキーは raw からコピー) で残るので、ここでは validation 不要
  if (Array.isArray(raw.formatGroups) && raw.formatGroups.length) {
    const groups = raw.formatGroups
      .filter(g => g && typeof g === "object" && typeof g.id === "string")
      .map(g => {
        const formatIds = Array.isArray(g.formatIds)
          ? g.formatIds.filter(x => typeof x === "string").map(String)
          : [];
        // defaultFormatIds (規定文) / expandFormatIds (展開=A) は formatIds の部分集合に正規化
        const defaultFormatIds = Array.isArray(g.defaultFormatIds)
          ? g.defaultFormatIds.filter(x => typeof x === "string" && formatIds.includes(x)).map(String)
          : [];
        const expandFormatIds = Array.isArray(g.expandFormatIds)
          ? g.expandFormatIds.filter(x => typeof x === "string" && formatIds.includes(x)).map(String)
          : [];
        return { id: String(g.id), name: String(g.name || ""), isDefault: !!g.isDefault, formatIds, defaultFormatIds, expandFormatIds };
      });
    // 「ちょうど 1 つ」が default の不変条件を担保。全件 malformed で空になったら再投入
    const fixed = ensureOneDefaultGroup(groups);
    out.formatGroups = fixed.length ? fixed : makeDefaultFormatGroups(out.formats);
  } else {
    // raw に formatGroups が無い / 空 → 正規化済みの out.formats に対して
    // デフォルトグループを再構築 (= 必ず 1 つ存在の不変条件)。
    out.formatGroups = makeDefaultFormatGroups(out.formats);
  }
  // QR セキュリティ: known kind だけ拾い、未指定はデフォルト維持
  if (raw.qrEncryption && typeof raw.qrEncryption === "object") {
    for (const k of QR_KINDS) {
      if (typeof raw.qrEncryption[k] === "boolean") out.qrEncryption[k] = raw.qrEncryption[k];
    }
  }
  if (raw.qrRedistribution && typeof raw.qrRedistribution === "object") {
    for (const k of QR_KINDS) {
      const v = raw.qrRedistribution[k];
      if (v === "restricted" || v === "free") out.qrRedistribution[k] = v;
    }
  }
  return out;
}

// ============================
// Patient helpers
// ============================

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function makeDefaultPatient() {
  return {
    pid: newId(),
    status: STATUS.NONE,
    name: "",
    room: "",
    tags: [],
    s: "",
    memo: "",
    shared: "",
    oFree: "",
    a: { text: "" },
    p: { text: "" },
    updatedAt: 0,
    // 他ワークスペースへ移動した時に立つマーカー。元データ (name / room) は触らず、
    // 表示・ソート時のみ装飾する。
    //   transferredAt: 移動した時刻 (ms epoch)。0 = 未移動。
    //   transferredTo: 移動先ワークスペースの label (表示用)。
    transferredAt: 0,
    transferredTo: "",
    // この患者で active なフォーマットグループ ID。null = 通常 (= 全 pin チップ
    // が見える)。設定されている場合、各パネルの strip はそのグループに属する
    // フォーマットだけを表示する (= 患者固有の「お気に入り切替」)。
    activeFormatGroupId: "",
    // 展開(A)フォーマットの入力値。{ [formatId]: { [itemIndex]: 値文字列 } }。
    // fraction は "numer/denom" の文字列で保持。非揮発 (欄に出しっぱなしで再編集可)。
    // グループ切替時に各欄の自由記述へ流し込んでクリアする。
    formatValues: {},
    // 患者識別データの出所マーカー。"external" = 他端末から QR で受信 = 再配布禁止。
    // 空文字 = この端末で作成された = 再配布可。settings.qrRedistribution.HM/MM が
    // "restricted" の時、QR 送信時に external 患者を除外する判定に使う。
    origin: "",
  };
}

// 「空患者」= 開いた直後の未使用スロット相当: ステータスが NONE (白) で、かつ name/room/
// tags/SOAP/memo/shared/oFree がすべて初期値（pid と updatedAt は無視）。
// YELLOW/GREEN/BLUE/GRAY はユーザーが明示的にステータスを付けた状態なので、たとえ他の
// フィールドが空でも「触れたボタン」と見なし削除対象外（特に GRAY は「診察・カルテ記載
// 終了」の重要マーカーなので消してはならない）。
export function isPatientEmpty(p) {
  if (!p) return false;
  if (p.status !== STATUS.NONE) return false;
  if (p.name) return false;
  if (p.room) return false;
  if (Array.isArray(p.tags) && p.tags.length > 0) return false;
  if (p.s) return false;
  if (p.memo) return false;
  if (p.shared) return false;
  if (p.oFree) return false;
  if (p.a && p.a.text) return false;
  if (p.p && p.p.text) return false;
  // 展開(A)フォーマットに入力値があれば空ではない
  if (p.formatValues && typeof p.formatValues === "object") {
    for (const fid of Object.keys(p.formatValues)) {
      const vals = p.formatValues[fid];
      if (vals && typeof vals === "object" && Object.values(vals).some(v => String(v ?? "").replace("/", "").trim())) return false;
    }
  }
  // 「移動済」マーカーが立っているスロットは履歴として残してあるので空ではない
  if (p.transferredAt) return false;
  return true;
}

const VALID_STATUSES = [STATUS.NONE, STATUS.YELLOW, STATUS.GREEN, STATUS.GRAY, STATUS.BLUE];

function normalizePatientArray(arr) {
  const len = (arr && arr.length) ? arr.length : DEFAULT_PATIENT_COUNT;
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    const r = arr ? arr[i] : null;
    const d = makeDefaultPatient();
    // 未知フィールド温存 (forward compatibility): 旧バージョンが新版で追加された
    // フィールドを読み戻し → 再保存する経路で、未知フィールドが消失しないようにする。
    // r をまず spread し、その後 known フィールドを validation 付きで上書きする。
    // (未知フィールドの妥当性は保証しないので、誤フィールドや混入データもそのまま
    //  保持されることに留意。パイロット前は許容範囲)
    const base = (r && typeof r === "object") ? { ...r } : {};
    out[i] = {
      ...base,
      pid: (r && typeof r.pid === "string" && r.pid) ? r.pid : d.pid,
      status: (r && typeof r.status === "string" && VALID_STATUSES.includes(r.status)) ? r.status : d.status,
      name: (r && typeof r.name === "string") ? r.name : d.name,
      room: (r && typeof r.room === "string") ? r.room : d.room,
      tags: (r && Array.isArray(r.tags))
        ? r.tags.filter(t => typeof t === "string" && t.trim()).map(t => String(t))
        : [],
      s: (r && typeof r.s === "string") ? r.s : d.s,
      memo: (r && typeof r.memo === "string") ? r.memo : d.memo,
      shared: (r && typeof r.shared === "string") ? r.shared : d.shared,
      oFree: (r && typeof r.oFree === "string") ? r.oFree : d.oFree,
      a: { text: (r && r.a && typeof r.a.text === "string") ? r.a.text : d.a.text },
      p: { text: (r && r.p && typeof r.p.text === "string") ? r.p.text : d.p.text },
      updatedAt: (r && typeof r.updatedAt === "number") ? r.updatedAt : 0,
      transferredAt: (r && typeof r.transferredAt === "number") ? r.transferredAt : 0,
      transferredTo: (r && typeof r.transferredTo === "string") ? r.transferredTo : "",
      activeFormatGroupId: (r && typeof r.activeFormatGroupId === "string") ? r.activeFormatGroupId : "",
      formatValues: (r && r.formatValues && typeof r.formatValues === "object") ? r.formatValues : {},
      origin: (r && r.origin === "external") ? "external" : "",
    };
  }
  return out;
}

// import-export.js から呼ばれる。bundle 形式 / 配列 / { patients: [...] } の
// いずれかを appState 形に正規化する薄いラッパ。
export function normalizeLoaded(raw) {
  const arr = raw && raw.patients && Array.isArray(raw.patients) ? raw.patients : (Array.isArray(raw) ? raw : null);
  return {
    v: 3,
    title: (raw && typeof raw.title === "string") ? raw.title : t("app.title"),
    patients: normalizePatientArray(arr),
    recvMemo: (raw && typeof raw.recvMemo === "string") ? raw.recvMemo : "",
    recvShared: (raw && typeof raw.recvShared === "string") ? raw.recvShared : "",
  };
}

// ============================
// Live bindings
// (ES module live bindings — setters allow reassignment)
// ============================

export let settings = defaultSettings();
export let appState = { v: 3, title: t("app.title"), patients: normalizePatientArray(null), recvMemo: "", recvShared: "" };
export let selectedNo = 1;

export function setAppState(s) { appState = s; }
export function setSettings(s) { settings = s; }
export function setSelectedNo(n) { selectedNo = n; }

// ============================
// Persistence
// ============================

// ヘッダーのタイトル枠は「現ユーザー名」を表示する (ユーザー機能, 案B)。
// 同期で参照したいので、initStore / switchUser で取得した名前をここにキャッシュする。
let _currentUserName = "";
export function getCurrentUserName() { return _currentUserName; }

// settings はユーザーごと管理になったため、ここでは patients / title (= ワークスペース
// 固有 + 現ユーザー名) だけを live state へ反映する。settings は initStore() / switchUser()
// がユーザーストアから読み込む。bundle の settings section は無視。
function applyBundleToLive(bundle) {
  const sPatients = bundle ? getSection(bundle, SECTION.PATIENTS) : null;
  const meta = bundle ? getSection(bundle, SECTION.META) : null;
  // title = 現ユーザー名。bundle.sections.meta.title は出力時の体裁のためだけに保持。
  appState = {
    v: 3,
    title: _currentUserName || t("app.title"),
    patients: normalizePatientArray(Array.isArray(sPatients) ? sPatients : null),
    // 受信ボックス (病棟単位で永続化)
    recvMemo: (meta && typeof meta.recvMemo === "string") ? meta.recvMemo : "",
    recvShared: (meta && typeof meta.recvShared === "string") ? meta.recvShared : "",
  };
}

// 受信ボックスの内容を更新して永続化する (caller は UI 同期の責務)。
export function setRecvContent(key, value) {
  if (key !== "recvMemo" && key !== "recvShared") return;
  appState[key] = String(value || "");
  scheduleSave();
}

// 現ユーザー名を IDB / キャッシュから最新化する。
async function refreshCurrentUserName() {
  try {
    const users = await loadUsers();
    const me = users.find(u => u.id === getCurrentUserId());
    _currentUserName = me ? (me.name || "") : "";
  } catch (_) { _currentUserName = ""; }
  return _currentUserName;
}

// Async hydration. main.js must `await initStore()` before rendering anything
// that reads state. Subsequent calls are idempotent (the promise is memoized).
//
// Tests can pass `{ bundle: rawFixture }` to inject state directly without
// touching the storage backend. `parseBundle` runs on raw input so both bundle
// format and legacy {appState, settings} shapes are accepted.
let _initPromise = null;

export function initStore(opts) {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    // ユーザー機能 (案B): 既存データを default ユーザー配下へ一度だけ backfill し、
    // currentUser ポインタを確定させる (冪等)。以降の storageLoad / listBundles /
    // loadGlobalSettings はすべて現ユーザー解決済みになる。
    try { await ensureUsersInitialized(); }
    catch (e) { console.warn("initStore: ensureUsersInitialized failed:", e); }
    await refreshCurrentUserName();

    let bundle = null;
    if (opts && opts.bundle) {
      try { bundle = parseBundle(opts.bundle); }
      catch (e) { console.warn("initStore: seed parse failed:", e); }
    } else {
      try { bundle = await storageLoad(); }
      catch (e) { console.warn("initStore: storage load failed:", e); }
    }
    // patients / title (ws 固有 + 現ユーザー名) を適用
    applyBundleToLive(bundle);
    // settings はグローバル。未保存なら現バンドルの settings から 1 度だけ seed する
    // (= 既存ユーザーのアクティブ ws 設定をグローバルへ引き継ぐ移行)。
    let gs = null;
    try { gs = await loadGlobalSettings(); }
    catch (e) { console.warn("initStore: load global settings failed:", e); }
    if (gs) {
      settings = normalizeSettings(gs);
    } else {
      const seed = bundle ? getSection(bundle, SECTION.SETTINGS) : null;
      settings = normalizeSettings(seed || {});
      try { await saveGlobalSettings(settings); }
      catch (e) { console.warn("initStore: seed global settings failed:", e); }
    }
  })();
  return _initPromise;
}

// テスト用: 次の initStore() を再実行できるよう内部状態をリセットする。
// 通常コードからは呼ばない。
export function _resetInitForTests() {
  _initPromise = null;
}

let saveTimer = null;

export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNow(); }, 180);
}

// アクティブ ws の患者データ (bundle) とグローバル設定の両方を永続化する共通処理。
// v8.2+: settings は ws bundle ではなくグローバルレコードに保存する。ws bundle には
// 患者 + meta だけを書く (settings section は出さない)。
async function persistActive() {
  await storageSave(projectBundle({ appState, settings, sections: [SECTION.META, SECTION.PATIENTS] }));
  await saveGlobalSettings(settings);
}

// fail-closed な保存経路。病棟切替・ユーザー切替・患者移動など「保存できていないのに
// 先へ進むと臨床被害 (取り違え・重複・消失) になる」操作が使う。saveNow() (toast のみ・
// 例外を投げない) とは違い、失敗は必ず throw して呼び出し側に中断させる。
//   - db=null (IDB 不可) の no-op 保存は「保存できていない事実」として失敗扱いにする
//     (本番でここに来るのはストレージが本当に使えない時なので、黙って成功にしない)。
export async function persistActiveOrThrow() {
  if (!(await isStorageAvailable())) {
    throw new Error("persistActiveOrThrow: storage unavailable (IDB not usable)");
  }
  await persistActive();
}

// async になったが「fire and forget」呼び出しが多いので返り値を await する
// 義務はない。内部 try/catch で失敗は console に出すだけ。
export async function saveNow() {
  saveTimer = null;
  try {
    await persistActive();
  } catch (e) {
    console.error("save failed:", e);
    // 保存失敗をユーザーに可視化する。IDB 不可環境 (db=null) は saveBundle が
    // 例外を投げず no-op するためここには来ない。ここに来るのは容量超過など
    // 「本当に書けなかった」失敗だけなので、黙って握り潰さず通知する。
    showToast(t("save.failed"), { ms: 4000 });
  }
}

// beforeunload / visibilitychange="hidden" で呼ぶ用。debounce 中のセーブを
// 即時実行に切り替える。IDB トランザクションは microtask レベルで開始すれば
// page hide 中も完了することが多い (Chrome / Safari)。
export function flushSavePending() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    // 戻り値は捨てる。unload 経路で await できないため fire and forget
    saveNow();
  }
}

// ============================
// Workspace 切替・作成
// ============================
//
// switchWorkspace(targetId):
//   1) 現在のアクティブを debounce 中のものも含めて確実に保存
//   2) アクティブポインタを切替
//   3) 新しいワークスペースを IDB から読み込み live state に適用
//   4) re-render は caller の責務 (= main.js が wire したコールバック経由)
//
// 切替自体は async で 100ms 程度。ユーザ視点では「タップしたらぱっと中身が
// 入れ替わる」体験になる。
export async function switchWorkspace(targetId) {
  if (!targetId) throw new Error("switchWorkspace: targetId required");
  // 1) 現アクティブを必ず保存 (患者 + グローバル設定)。fail-closed: 保存できなければ
  //    切替を中断して throw する (ポインタを動かす前に止めるので現データは無傷。
  //    握って先へ進むと直前の編集がサイレントに失われる)。caller が通知する。
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await persistActiveOrThrow();
  // 2) ポインタ切替
  setActiveWorkspaceId(targetId);
  // 3) ロード + 適用
  let bundle = null;
  try { bundle = await storageLoad(targetId); }
  catch (e) { console.warn("load after switch failed:", e); }
  applyBundleToLive(bundle);
  // 切替で notify
  if (_onWorkspaceChanged) {
    try { _onWorkspaceChanged(targetId); } catch (_) {}
  }
}

// 空の新規ワークスペースを作成し、そのワークスペースに切替える。
// label はユーザが画面で入力した名前。
export async function createWorkspace(label) {
  // 1) 現アクティブを保存 (患者 + グローバル設定)。fail-closed: 保存できなければ新規
  //    作成・切替を中断して throw (現データを失わない)。caller が通知する。
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await persistActiveOrThrow();
  // 2) 空の bundle を構築 (default 50 患者)。settings はグローバル共通なので bundle
  //    には含めない。新 ws は現在のグローバル設定をそのまま継承する。
  const emptyAppState = { v: 3, title: t("app.title"), patients: normalizePatientArray(null) };
  const emptyBundle = projectBundle({
    appState: emptyAppState,
    settings,
    sections: [SECTION.META, SECTION.PATIENTS],
  });
  // 3) IDB に新規エントリを作成
  const newId = await createWorkspaceRecord(label, emptyBundle);
  // 4) アクティブを切替えて live state に適用
  setActiveWorkspaceId(newId);
  applyBundleToLive(parseBundle(emptyBundle));
  if (_onWorkspaceChanged) {
    try { _onWorkspaceChanged(newId); } catch (_) {}
  }
  return newId;
}

// 指定患者だけを含む新規ワークスペースを作成して保存する (switch はしない)。
// 患者移動の「＋ 新規ワークスペースへ」用。空の 50 患者を作らず、渡した患者のみを
// 入れる (= 移動先で不要な空スロットを消す手間を無くす)。戻り値: 新 workspace id。
export async function createWorkspaceWithPatients(label, patients) {
  const appStateForBundle = {
    v: 3,
    title: appState.title || t("app.title"),
    patients: Array.isArray(patients) ? patients : [],
  };
  // settings はグローバル共通なので bundle には含めない (META + PATIENTS のみ)
  const bundle = projectBundle({ appState: appStateForBundle, settings, sections: [SECTION.META, SECTION.PATIENTS] });
  return await createWorkspaceRecord(label, bundle);
}

// ============================
// ユーザー切替・作成 (案B)
// ============================
//
// switchUser(targetUserId):
//   1) 現状 (現病棟 + 現ユーザー設定) を保存
//   2) 退出ユーザーの「最後の病棟」を登録簿に記録
//   3) currentUser ポインタ + 名前キャッシュを切替
//   4) target の設定をロード (無ければ default を作成)
//   5) target の最後の病棟を解決 (無ければ先頭 / それも無ければ空病棟を新規作成)
//   6) その病棟をロードして live state へ
//   7) _onUserChanged 通知 (main.js が全 view 再描画 + ヘッダー更新を配線)
export async function switchUser(targetUserId) {
  if (!targetUserId) throw new Error("switchUser: targetUserId required");
  const fromUserId = getCurrentUserId();
  if (targetUserId === fromUserId) return;

  // 1) 現状を保存。fail-closed: 保存できなければ throw してユーザー切替を中断する
  //    (現ユーザーの直前編集をサイレントに失わない)。caller が通知する。
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await persistActiveOrThrow();
  // 2) 退出ユーザーの activeWorkspaceId を記録
  try { await setUserActiveWorkspaceId(fromUserId, getActiveWorkspaceId()); } catch (_) {}

  // 3) ポインタ切替
  setCurrentUserId(targetUserId);
  await refreshCurrentUserName();

  // 4) target の設定をロード (無ければ default を作成して保存)
  let gs = null;
  try { gs = await loadGlobalSettings(); } catch (_) {} // current=target に解決済み
  if (gs) {
    settings = normalizeSettings(gs);
  } else {
    settings = defaultSettings();
    try { await saveGlobalSettings(settings); } catch (e) { console.warn("switchUser: seed settings failed:", e); }
  }

  // 5) target の病棟を解決
  const users = await loadUsers();
  let wsId = getUserActiveWorkspaceId(users, targetUserId);
  const owned = (await listAllWorkspaces()).filter(w => w.userId === targetUserId);
  const valid = wsId && owned.some(w => w.id === wsId);
  if (!valid) {
    if (owned.length) {
      wsId = owned.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0].id;
    } else {
      // 病棟が無い (新規ユーザー等) → 空病棟を作成。current=target なので target に属す。
      const emptyAppState = { v: 3, title: t("app.title"), patients: normalizePatientArray(null) };
      const emptyBundle = projectBundle({ appState: emptyAppState, settings, sections: [SECTION.META, SECTION.PATIENTS] });
      wsId = await createWorkspaceRecord(t("ws.default.label"), emptyBundle);
    }
  }
  setActiveWorkspaceId(wsId);
  try { await setUserActiveWorkspaceId(targetUserId, wsId); } catch (_) {}

  // 6) ロード + 適用
  let bundle = null;
  try { bundle = await storageLoad(wsId); } catch (e) { console.warn("load after user switch failed:", e); }
  applyBundleToLive(bundle);

  // 7) 通知
  if (_onUserChanged) { try { _onUserChanged(targetUserId); } catch (_) {} }
}

// 新規ユーザーを作成して切替える。重複名は拒否。
// 戻り値: { ok:true, id } | { ok:false, reason:"empty"|"duplicate" }
export async function createUserAndSwitch(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (await userNameExists(trimmed)) return { ok: false, reason: "duplicate" };
  const newId = await createUser(trimmed);
  await switchUser(newId); // 空病棟を 1 つ作って切替
  return { ok: true, id: newId };
}

// 現ユーザーの名前を変更し、live state (キャッシュ名 + appState.title) にも反映する。
// オンボーディング (初回の名前設定) と設定画面の現ユーザーリネームの両方で使う。
// 重複名は拒否。caller はヘッダー再描画 (refreshAppUserName) の責務。
export async function renameCurrentUser(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  const uid = getCurrentUserId();
  if (await userNameExists(trimmed, uid)) return { ok: false, reason: "duplicate" };
  await renameUser(uid, trimmed);
  _currentUserName = trimmed;
  appState.title = trimmed;
  return { ok: true };
}

// ============================
// 全ワークスペース JSON 入出力 (v8.2+)
// ============================
//
// JSON ファイルは「アーカイブ」= グローバル設定 + 全 ws の患者 を 1 ファイルに束ねる。
// 旧来の単一 ws バンドル (hospital-rounds-bundle) も import では引き続き受け付ける
// (import-export.js 側で判定)。
const ARCHIVE_FORMAT = "hospital-rounds-archive";
const ARCHIVE_SCHEMA = 1;

export function isArchive(obj) {
  return !!(obj && typeof obj === "object" && obj.format === ARCHIVE_FORMAT && Array.isArray(obj.workspaces));
}

// 全 ws + グローバル設定をアーカイブオブジェクトとして返す。
export async function exportArchive() {
  // 現在の状態を確実に保存してから全 ws を読み出す。fail-closed: 保存できなければ中断
  //    して throw する (握って続行すると、直前編集を欠いた古い IDB 内容を「最新バック
  //    アップ」として書き出し、それを信じて運用すると編集が失われる)。caller が通知する。
  await persistActiveOrThrow();
  const list = await listBundles();
  const workspaces = [];
  for (const w of list) {
    let b = null;
    try { b = await storageLoad(w.id); } catch (_) { /* skip broken */ }
    const patients = b ? (getSection(b, SECTION.PATIENTS) || []) : [];
    const meta = b ? (getSection(b, SECTION.META) || {}) : {};
    workspaces.push({
      label: w.label || "",
      title: (meta && typeof meta.title === "string") ? meta.title : (w.title || ""),
      patients: Array.isArray(patients) ? patients : [],
    });
  }
  return {
    format: ARCHIVE_FORMAT,
    schema: ARCHIVE_SCHEMA,
    exportedAt: new Date().toISOString(),
    settings,
    workspaces,
  };
}

// アーカイブを取り込む (非破壊)。各 ws を新規作成し、includeSettings ならグローバル
// 設定を置換する。既存 ws は消さない (= 再取込で重複し得るが、データ消失は避ける)。
// 戻り値: 作成した ws 数。
export async function importArchive(archive, opts) {
  const includeSettings = !!(opts && opts.includeSettings);
  const wss = Array.isArray(archive && archive.workspaces) ? archive.workspaces : [];
  let created = 0;
  for (const w of wss) {
    const patients = Array.isArray(w && w.patients) ? w.patients : [];
    // 中身のない (全スロット空) ws はスキップ
    if (!patients.some(p => !isPatientEmpty(p))) continue;
    const norm = normalizeLoaded({ title: (w && w.title) || t("app.title"), patients });
    const bundle = projectBundle({ appState: norm, settings, sections: [SECTION.META, SECTION.PATIENTS] });
    await createWorkspaceRecord(String((w && w.label) || ""), bundle);
    created++;
  }
  if (includeSettings && archive && archive.settings && typeof archive.settings === "object") {
    settings = normalizeSettings(archive.settings);
    try { await saveGlobalSettings(settings); } catch (e) { console.warn("importArchive: settings save failed:", e); }
  }
  return created;
}

// ============================
// 端末まるごと (全ユーザー) JSON 入出力
// ============================
//
// 「端末まるごと」アーカイブ = 全ユーザー × (そのユーザーの設定 + 全病棟の患者)。
// 研究用に端末交換・バックアップする用途。現ユーザー単位アーカイブ (ARCHIVE_FORMAT)
// とは別フォーマットで判別する。
const DEVICE_ARCHIVE_FORMAT = "hospital-rounds-device-archive";
const DEVICE_ARCHIVE_SCHEMA = 1;

export function isDeviceArchive(obj) {
  return !!(obj && typeof obj === "object" && obj.format === DEVICE_ARCHIVE_FORMAT && Array.isArray(obj.users));
}

export async function exportDeviceArchive() {
  // fail-closed: 保存できなければ中断 (古い IDB 内容を最新バックアップと誤認させない)。
  await persistActiveOrThrow();
  const users = await listUsers();
  const allWs = await listAllWorkspaces();
  const outUsers = [];
  for (const u of users) {
    let s = null;
    try { s = await loadGlobalSettings(u.id); } catch (_) { /* ignore */ }
    const workspaces = [];
    for (const w of allWs.filter(x => x.userId === u.id)) {
      let b = null;
      try { b = await storageLoad(w.id); } catch (_) { /* skip broken */ }
      const patients = b ? (getSection(b, SECTION.PATIENTS) || []) : [];
      const meta = b ? (getSection(b, SECTION.META) || {}) : {};
      workspaces.push({
        label: w.label || "",
        title: (meta && typeof meta.title === "string") ? meta.title : (w.title || ""),
        patients: Array.isArray(patients) ? patients : [],
      });
    }
    outUsers.push({
      name: u.name || "",
      settings: s ? normalizeSettings(s) : defaultSettings(),
      workspaces,
    });
  }
  return {
    format: DEVICE_ARCHIVE_FORMAT,
    schema: DEVICE_ARCHIVE_SCHEMA,
    exportedAt: new Date().toISOString(),
    users: outUsers,
  };
}

// 端末まるごとアーカイブを取り込む (非破壊)。同名ユーザーは既存に合流、無ければ新規作成。
// 各ユーザーの病棟・設定をそのユーザー配下へ流し込む。戻り値: { users, workspaces } 作成数。
export async function importDeviceArchive(archive) {
  const arr = Array.isArray(archive && archive.users) ? archive.users : [];
  let createdUsers = 0, createdWs = 0;
  let registry = await loadUsers();
  for (const au of arr) {
    const name = String((au && au.name) || "").trim();
    const wss = Array.isArray(au && au.workspaces) ? au.workspaces : [];
    // 名前も病棟も無いユーザーはスキップ
    if (!name && !wss.length) continue;
    // 同名ユーザーは合流、無ければ新規作成
    let target = registry.find(u => (u.name || "").trim() === name && name);
    let uid;
    if (target) {
      uid = target.id;
    } else {
      uid = await createUser(name || getDefaultUserName());
      registry = await loadUsers();
      createdUsers++;
    }
    // 設定をそのユーザーへ
    if (au && au.settings && typeof au.settings === "object") {
      try { await saveGlobalSettings(normalizeSettings(au.settings), uid); }
      catch (e) { console.warn("importDeviceArchive: settings save failed:", e); }
    }
    // 病棟をそのユーザーへ (空 ws はスキップ)
    for (const w of wss) {
      const patients = Array.isArray(w && w.patients) ? w.patients : [];
      if (!patients.some(p => !isPatientEmpty(p))) continue;
      const norm = normalizeLoaded({ title: (w && w.title) || t("app.title"), patients });
      const bundle = projectBundle({ appState: norm, settings: defaultSettings(), sections: [SECTION.META, SECTION.PATIENTS] });
      await createWorkspaceRecord(String((w && w.label) || ""), bundle, uid);
      createdWs++;
    }
  }
  return { users: createdUsers, workspaces: createdWs };
}

let _onWorkspaceChanged = null;
export function setOnWorkspaceChanged(fn) { _onWorkspaceChanged = fn; }

let _onUserChanged = null;
export function setOnUserChanged(fn) { _onUserChanged = fn; }

// Settings is part of the same bundle now, so saving settings rewrites the
// whole snapshot. The function name is kept so existing call sites don't have
// to change.
export async function saveSettings() {
  return saveNow();
}

// fail-closed 版の saveSettings。QR 取込 (設定/フォーマット/セットの追加・上書き) など
// 「保存できていないのに成功表示すると設定の取り違え/消失になる」操作が使う。
// saveSettings() (= saveNow、toast のみで例外を握る) と違い、失敗は throw して
// 呼び出し側に中断 + ロールバックさせる。IDB 不可 (db=null) の no-op も失敗扱い。
export async function saveSettingsOrThrow() {
  return persistActiveOrThrow();
}

// Legacy compat: returns the clinical-only appState. Roster meta and settings
// have already been loaded into their own live bindings during module init.
export function load() {
  return appState;
}

// iOS Safari 等の eviction を抑制（PWA インストール時に true を返すことが多い）。
// 失敗しても挙動には影響しないので best-effort で呼ぶだけ。
export function requestStoragePersistence() {
  if (navigator.storage && typeof navigator.storage.persist === "function") {
    navigator.storage.persist().catch(() => {});
  }
}

let _onMarkUpdated = null;
export function setMarkUpdatedHandler(fn) { _onMarkUpdated = fn; }

export function markUpdated(no) {
  const p = appState.patients[no - 1];
  if (!p) return;
  p.updatedAt = Date.now();
  if (_onMarkUpdated) _onMarkUpdated(no);
}
