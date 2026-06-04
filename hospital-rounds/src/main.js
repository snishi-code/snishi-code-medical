"use strict";

import "./style.css";

import { STATUS } from "./constants.js";
import { STORAGE_KEYS } from "./storage.js";
import {
  appState, settings, selectedNo,
  setAppState, setSelectedNo,
  saveNow, saveSettings, saveSettingsOrThrow,
  normalizeLoaded,
  requestStoragePersistence,
  initStore, flushSavePending, setOnWorkspaceChanged, setOnUserChanged,
  setMarkUpdatedHandler, setRecvContent,
} from "./store.js";

import { renderHome, updateCountChip } from "./views/home.js";
import { renderDetail, renderQrIfNeeded, initDetailEvents, initStatusButtons, initQrNavButtons } from "./views/detail.js";
import { renderMemoScreen, setMemoEditMode } from "./views/memo.js";
import { renderSharedScreen, setSharedEditMode } from "./views/shared-list.js";
import { renderSettings, initSettingsView } from "./views/settings-view.js";

import { showView, syncDetailMemoDisplay, createNavigators, createDocsOpener } from "./features/navigation.js";
import { createRenderers } from "./features/renderers.js";
// header-menu.js (ハンバーガー) は v8.6 で廃止。import 削除済み。
import { initAppTitle, refreshAppWsLabel, refreshAppUserName } from "./features/app-title.js";
import { initWsPicker } from "./features/ws-picker.js";
import { initUserPicker } from "./features/user-picker.js";
import { initEventLog, logEvent, EVENT } from "./features/eventlog.js";
import { initSnapshots, captureSnapshot, REASON } from "./features/snapshots.js";
import { DOCS_BUNDLE } from "./docs-bundle.js";
import { setDataChangeHandler, initActionMenu } from "./features/drag.js";
import { initFormats, setOnTextChanged as setOnFormatTextChanged, setOnExpandedInput, setFormatStoreAdapter } from "./features/formats.js";
import { initMovePatient } from "./features/move-patient.js";
import { initQrFormat, closeQrFormatOverlay, setOnFormatApplied, setFormatStoreAdapter as setQrFormatStoreAdapter } from "./features/qr-format.js";
import { initQrSet, closeQrSetOverlay, setOnSetApplied } from "./features/qr-set.js";
import { initQrReceive, openQrReceiveOverlay } from "./features/qr-receive.js";
import { getAllTags as _getAllTagsForQr } from "./features/tags.js";
import { initFormatGroups } from "./features/format-groups.js";
import { t, applyI18n } from "./i18n.js";
import { initImportExport } from "./features/import-export.js";
import { initSharedQr, refreshSharedQrIfActive, initMemoQr, refreshMemoQrIfActive } from "./features/qr-shared.js";
import { initHomeQr, refreshHomeQrIfActive } from "./features/qr-home.js";
import { initSettingsQr, refreshSettingsQrIfActive, setOnSettingsApplied } from "./features/qr-settings.js";
import { createEditToggle } from "./features/edit-toggle.js";
// room.js の手動ソート (sortPatientsByRoom/invalidateSortSnapshot) は v8.7 で廃止 (自動ソート化)
import { wireScanButton } from "./features/qr-scan.js";
// docs-demo.js (説明書のインタラクティブデモ) は v8.9.4 で撤去
import { initNoAutofill } from "./features/no-autofill.js";
import { maybeShowPwaInitDialog } from "./features/pwa-init.js";
import { dropAllAppIndexedDbs } from "./features/idb-wipe.js";
import { maybeShowDisclaimer } from "./features/splash-disclaimer.js";
import { runBootGate } from "./features/boot-gate.js";

// ============================
// Boot 0: PWA 初回起動チェック + IDB hydration
// ============================
// 初回 PWA 起動 (= Safari でテスト入力したデータが PWA 側に共有されている状態)
// に限り、ユーザに「テスト用データを削除して開始するか」を確認する。
await maybeShowPwaInitDialog();

// store.js は module-init 時に state を読み込まなくなったので、ここで明示的に
// 待つ。以降のすべての top-level コードは hydration 完了後に実行される。
await initStore();

// 研究用テレメトリ + スナップショットの起動処理 (独立モジュール・端末内のみ)。
// initEventLog: 古いイベント間引き + app_open 記録 + ライフサイクル配線。
// initSnapshots: 期限切れスナップショット間引き。
initEventLog();
initSnapshots();

// ============================
// Boot 1: Renderers + Navigators (組み立てだけ)
// ============================
// 各画面の render 関数群と nav ボタンの handler 群を factory で生成する。
// 相互参照 (doRenderMemo → navigateToPatient → doRenderDetail 等) は
// renderers.js 内のクロージャで完結する。
const renderers = createRenderers({
  renderHome,
  renderDetail,
  renderMemoScreen,
  renderSharedScreen,
  setSelectedNo,
  showView,
  syncDetailMemoDisplay,
  refreshSharedQrIfActive,
  refreshMemoQrIfActive,
  refreshHomeQrIfActive,
  refreshSettingsQrIfActive,
});
const { doRenderHome, doRenderDetail, doRenderMemo, doRenderShared, navigateToPatient, refreshPatientUI } = renderers;

const { navToHome, navToMemo, navToShared, navToSettings } = createNavigators({
  doRenderHome, doRenderMemo, doRenderShared, renderSettings,
});

const openDocsPage = createDocsOpener({ docsBundle: DOCS_BUNDLE });

// ============================
// Boot 2: Settings / Detail wiring
// ============================
initSettingsView(doRenderDetail, refreshPatientUI, refreshAppWsLabel);
initDetailEvents(doRenderHome);
initStatusButtons(doRenderHome);
initQrNavButtons();

// finishDataChange handler: ドラッグ並び替え・患者移動・削除などデータ変化のたびに
// 呼ばれる。中央の refreshPatientUI() に集約する (detail を含む全 view を再描画 +
// 各 QR を再生成)。個別に view を列挙すると detail 等が漏れて「ミューテーション後に
// 画面が自動更新されない」バグの温床になるため、必ずこれを通す。
setDataChangeHandler(() => {
  refreshPatientUI();
  updateCountChip();
});

// ============================
// Boot 3: History / nav buttons
// ============================
history.replaceState({ view: "home" }, "", "");

window.addEventListener("popstate", (e) => {
  const v = (e.state && e.state.view) || "home";
  showView(v, false);
  if (v === "home") doRenderHome();
  else if (v === "memo") doRenderMemo();
  else if (v === "shared") doRenderShared();
  else if (v === "detail") doRenderDetail();
});

// ヘッダー右は ≡ メニュー1つに集約 (誤タップ削減・場所固定)。タップで
// メモ/共有/設定/説明 の一覧を開き、選んだら遷移してメニューを閉じる (単一選択)。
// 背景タップ / × は main.js のグローバルハンドラ (data-close-popup) が閉じる。
document.getElementById("mainMenuBtn")?.addEventListener("click", () => {
  document.getElementById("mainMenuOverlay")?.classList.add("active");
});
function closeMainMenu() {
  document.getElementById("mainMenuOverlay")?.classList.remove("active");
}
document.getElementById("mainMenuMemoBtn")?.addEventListener("click", () => { closeMainMenu(); navToMemo(); });
document.getElementById("mainMenuSharedBtn")?.addEventListener("click", () => { closeMainMenu(); navToShared(); });
document.getElementById("mainMenuSettingsBtn")?.addEventListener("click", () => { closeMainMenu(); navToSettings(); });
// 説明: アプリ内ヘルプの総目次を開く (各画面の ? を撤去し、説明はここに集約)。
document.getElementById("mainMenuHelpBtn")?.addEventListener("click", () => { closeMainMenu(); openDocsPage("index"); });

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".helpLinkBtn");
  if (!btn) return;
  const page = btn.dataset.helpPage;
  if (!page) return;
  openDocsPage(page);
});
// Intra-docs navigation requested from the iframe (prev/next/breadcrumb links)
window.addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "docs-nav") return;
  if (typeof e.data.page !== "string") return;
  openDocsPage(e.data.page);
});

// ============================
// Boot 4: Edit toggles (home / memo / shared)
// ============================
// 鉛筆 → 編集モード / 外側クリック or ビュー遷移で表示モードに戻る。
// home はステータス一括編集 (色パレット) を v8.7 で撤去したため編集トグルなし。
// クリアは clearAllBtn (Boot 9) が担う。
createEditToggle({
  triggerBtn: document.getElementById("memoEditBtn"),
  container: document.getElementById("memoView"),
  onEnter: () => { setMemoEditMode(true); doRenderMemo(); },
  onExit: () => { setMemoEditMode(false); doRenderMemo(); },
});
createEditToggle({
  triggerBtn: document.getElementById("sharedEditBtn"),
  container: document.getElementById("sharedView"),
  onEnter: () => { setSharedEditMode(true); doRenderShared(); },
  onExit: () => { setSharedEditMode(false); doRenderShared(); },
});

// ============================
// Boot 5: Import / Export / autofill / action menu
// ============================
initImportExport({
  renderHome: doRenderHome,
  renderDetail: doRenderDetail,
  renderSettings,
  renderMemoScreen: doRenderMemo,
  renderSharedScreen: doRenderShared,
  showView,
});
initNoAutofill();
initActionMenu();

// ============================
// Boot 6: Formats / QR adapters
// ============================
// formats.js / qr-format.js は移植性のため store を直接触らず adapter 経由で書き込む。
// ここで store の実体に紐付ける ("hospital-rounds 内で動かす時の adapter")。
setFormatStoreAdapter({
  saveFormat: (target, { isNew }) => {
    if (!Array.isArray(settings.formats)) settings.formats = [];
    if (isNew) {
      settings.formats.push(target);
    } else {
      const idx = settings.formats.findIndex(f => f.id === target.id);
      if (idx >= 0) settings.formats[idx] = target;
      else settings.formats.push(target);
    }
    saveSettings();
  },
  deleteFormat: (id) => {
    if (!Array.isArray(settings.formats)) return;
    const idx = settings.formats.findIndex(f => f.id === id);
    if (idx < 0) return;
    settings.formats.splice(idx, 1);
    saveSettings();
  },
});

setQrFormatStoreAdapter({
  getExistingFormats: () => Array.isArray(settings.formats) ? settings.formats : [],
  getKnownTags: () => _getAllTagsForQr(),
  // fail-closed: 追加 → 保存を await し、失敗時は追加分を戻して throw (呼び出し側で中断)。
  addFormat: async (newFmt) => {
    if (!Array.isArray(settings.formats)) settings.formats = [];
    settings.formats.push(newFmt);
    try {
      await saveSettingsOrThrow();
    } catch (e) {
      settings.formats = settings.formats.filter(f => f !== newFmt);
      throw e;
    }
  },
  shouldEncrypt: () => !!settings.qrEncryption?.FMT,
});

initFormats();
setOnFormatTextChanged(() => {
  doRenderDetail();
  if (typeof renderQrIfNeeded === "function") renderQrIfNeeded();
});
// 展開(A)欄の入力毎: 再描画せず QR プレビューだけ軽く更新 (フォーカス維持のため)
setOnExpandedInput(() => {
  if (typeof renderQrIfNeeded === "function") renderQrIfNeeded();
});

initMovePatient({
  renderHome: doRenderHome,
  renderDetail: doRenderDetail,
});

initQrFormat();
setOnFormatApplied(() => {
  renderSettings();
  doRenderDetail();
});

// セット QR (FS): 送信フロー初期化 + 受信適用後の再描画 (セットは strip チップに影響)。
initQrSet();
setOnSetApplied(() => {
  renderSettings();
  refreshPatientUI();
});

// 統一 QR 受信ルーター: 各 createQrFlow が init で receiver を登録済みなので、
// ここでオーバーレイを配線するだけ。設定「QR から追加」で開く。
initQrReceive();
document.getElementById("qrReceiveOpenBtn")?.addEventListener("click", openQrReceiveOverlay);

initFormatGroups({
  renderDetail: doRenderDetail,
});

// QR 送信オーバーレイ (フォーマット / セット) の close 配線。
// × には data-close-popup も付くのでグローバルハンドラが overlay を閉じるが、
// closeQrFormatOverlay / closeQrSetOverlay は flow.close() 等の追加 cleanup が要るので
// 個別 listener も残す (両 listener は冪等)。
document.getElementById("qrFormatCloseBtn")?.addEventListener("click", closeQrFormatOverlay);
document.getElementById("qrFormatOverlay")?.addEventListener("click", (e) => {
  if (e.target.id === "qrFormatOverlay") closeQrFormatOverlay();
});
document.getElementById("qrSetCloseBtn")?.addEventListener("click", closeQrSetOverlay);
document.getElementById("qrSetOverlay")?.addEventListener("click", (e) => {
  if (e.target.id === "qrSetOverlay") closeQrSetOverlay();
});

// ============================
// Boot 7: Global popup close handler (data-close-popup)
// ============================
// 「閉じるだけ」のポップアップ用の event delegation。HTML 側で
//   <button class="popupCloseX" data-close-popup ...> × </button>
// を置けば、追加 JS なしで「外側 overlay を閉じる」挙動が手に入る。
// 追加クリーンアップが必要な popup は既存の id 経由 listener と併用する。
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-close-popup]");
  if (!btn) return;
  btn.closest(".popupMenuOverlay")?.classList.remove("active");
});

// 背景タップで閉じる (グローバル・メタ動作)。.popupMenuOverlay の「背景そのもの」を
// クリックしたら閉じる。これで個別 popup ごとに配線しなくても全 popup が背景タップで
// 閉じる (今回のステータス選択や将来の popup も自動対応)。
//   - 中身 (.popupMenu 配下) のクリックは e.target が overlay でないので閉じない。
//   - 明示確認が要る popup (免責・PWA 初期化・取込選択など) は overlay に
//     data-no-backdrop-close を付けて除外する。
//   - 追加 cleanup が要る popup (例 QR カメラ) は従来の個別 listener を併用 (二重に
//     active を外しても冪等)。
document.addEventListener("click", (e) => {
  const ov = e.target;
  if (ov.classList && ov.classList.contains("popupMenuOverlay") &&
      !ov.hasAttribute("data-no-backdrop-close")) {
    ov.classList.remove("active");
  }
});

// ============================
// Boot 8: Shared/Memo/Home/Settings QR + paste cards
// ============================
initSharedQr();
initMemoQr();
initHomeQr();
initSettingsQr();
// ST 受信適用後: 設定画面 (フォーマット/セット一覧) と患者 UI の両方を再描画。
setOnSettingsApplied(() => { renderSettings(); refreshPatientUI(); });

// v8.7+: 部屋番号順は自動 (各 view の描画時に ensureRoomOrder)。手動ソートボタンは撤去。

// 受信ボックス (プロブレムリスト/共有) の共通配線。挙動を両画面で統一する:
//   閉じる = 隠すだけ (内容は保持。誤タップで受信結果を失わない)
//   消去   = 確認の上で内容を空に (永続データなので「消去」)
//   開く   = 再表示 (閉じたあと中身が残っているときだけ「受信ボックスを開く」が出る)
// 受信ボックスは病棟単位で永続化 (appState.recvMemo / recvShared)。医師が後で
// 転記する運用に合わせ、消去するまで残す。受信(dump)も input イベント経由で保存される。
const _recvCards = [];
function wireRecvCard({ cardId, areaId, closeBtnId, clearBtnId, openBtnId, stateKey }) {
  const card = document.getElementById(cardId);
  const area = document.getElementById(areaId);
  const openBtn = document.getElementById(openBtnId);
  const syncOpenBtn = () => {
    if (!openBtn) return;
    const closed = !card?.classList.contains("active");
    const hasContent = !!(area && String(area.value || "").trim());
    openBtn.style.display = (closed && hasContent) ? "" : "none";
  };
  // 永続値を textarea へ反映 (起動時・病棟/ユーザー切替時)。カードは自動で開かない。
  const reload = () => {
    if (area) area.value = appState[stateKey] || "";
    card?.classList.remove("active");
    syncOpenBtn();
  };
  document.getElementById(closeBtnId)?.addEventListener("click", () => {
    card?.classList.remove("active");
    syncOpenBtn();
  });
  document.getElementById(clearBtnId)?.addEventListener("click", () => {
    if (area && String(area.value || "").trim() && !confirm(t("recv.clear.confirm"))) return;
    if (area) area.value = "";
    setRecvContent(stateKey, "");
    syncOpenBtn();
  });
  openBtn?.addEventListener("click", () => {
    card?.classList.add("active");
    syncOpenBtn();
    area?.focus();
  });
  // 入力 / 受信(dump) のたびに永続化 + 開くボタン同期
  area?.addEventListener("input", () => {
    setRecvContent(stateKey, area.value);
    syncOpenBtn();
  });
  reload();
  _recvCards.push({ reload });
}
function reloadRecvCards() { for (const c of _recvCards) c.reload(); }
wireRecvCard({ cardId: "memoPasteCard", areaId: "memoPasteArea", closeBtnId: "memoPasteCloseBtn", clearBtnId: "memoPasteClearBtn", openBtnId: "memoRecvOpenBtn", stateKey: "recvMemo" });
wireRecvCard({ cardId: "sharedPasteCard", areaId: "sharedPasteArea", closeBtnId: "sharedPasteCloseBtn", clearBtnId: "sharedPasteClearBtn", openBtnId: "sharedRecvOpenBtn", stateKey: "recvShared" });

// 受信ボックスは「復号済みの整形テキスト」の保管場所。生 QR を読む導線は
// 各 QR カードのテキスト受信パネル (createQrFlow) に一本化したので、受信ボックス
// 直下の生 QR カメラ (旧 sharedPasteScanBtn) は撤去した。
wireScanButton("adminImportScanBtn", "adminImportArea");

// ============================
// Boot 9: Reset / Clear actions
// resetBtn = 設定画面最下部「全データを消去する」= このOriginのLocalStorage + IndexedDB 全削除。
// clearAllBtn = ホーム画面のクリアボタン = アクティブWSの患者データのみクリア (他WSは無関係)。
// ============================
document.getElementById("resetBtn")?.addEventListener("click", async () => {
  if (!confirm(t("settings.fullReset.confirm"))) return;
  // 全消去: IndexedDB (本体 + イベントログ + スナップショット) を fail-closed で全削除してから
  // LocalStorage を消して reload。順序が重要: 先に IDB(患者 PII) の削除確認を取り、確認できた
  // 時だけ LS 消去 + reload へ進む。別タブが接続を握って blocked になった等で消えていないのに
  // reload すると PII が残ったまま「消えた」ように見える (fail-open)。失敗時は中断して通知する。
  // 削除ロジックは PWA 初回ダイアログと同一ソース (features/idb-wipe.js)。
  try {
    await dropAllAppIndexedDbs();
  } catch (e) {
    console.error("full reset: idb wipe failed:", e);
    alert(t("pwa.init.wipeFailed")); // 「他のタブ/ウィンドウを閉じて再試行」
    return; // LS 消去も reload もしない
  }
  try { localStorage.clear(); } catch (_) {}
  location.reload();
});

document.getElementById("clearAllBtn")?.addEventListener("click", async () => {
  if (!confirm(t("home.start.confirm"))) return;
  // 破壊操作の直前: 現状を 1 枚スナップショット (await して clear 前の状態を確実に撮る)
  await captureSnapshot(REASON.CLEAR);
  logEvent(EVENT.CLEAR);
  const ct = settings.clearTargets;
  const now = Date.now();
  for (const p of appState.patients) {
    if (ct.memo) p.memo = "";
    if (ct.s) p.s = "";
    if (ct.o) p.oFree = "";
    if (ct.a) p.a = { text: "" };
    if (ct.p) p.p = { text: "" };
    if (ct.shared) p.shared = "";
    if (p.status === STATUS.YELLOW && ct.statusYellow) p.status = STATUS.NONE;
    else if (p.status === STATUS.GREEN && ct.statusGreen) p.status = STATUS.NONE;
    else if (p.status === STATUS.GRAY && ct.statusGray) p.status = STATUS.NONE;
    else if (p.status === STATUS.BLUE && ct.statusBlue) p.status = STATUS.NONE;
    p.updatedAt = now;
  }
  saveNow();
  // 個別 view を列挙すると memo/shared を開いた状態で更新が漏れる。中央の
  // refreshPatientUI() に集約する (CLAUDE.md「状態更新後の再描画」)。
  refreshPatientUI();
});

// ============================
// Boot 10: Lifecycle hooks (save flush / workspace switch)
// ページ離脱・バックグラウンド化時に op-batch + 保存待ちを即時フラッシュ
window.addEventListener("beforeunload", () => {
  try { flushSavePending(); } catch (_) {}
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    try { flushSavePending(); } catch (_) {}
  }
});

// Workspace 切替時に画面全体を再描画する。
setOnWorkspaceChanged(() => {
  // 患者 index を前 ws から引きずらないように、再描画前に必ずリセット
  setSelectedNo(1);
  refreshPatientUI();
  // タイトル (= 現ユーザー名、ws 切替では不変) の表示同期 + ws label を更新
  refreshAppUserName();
  refreshAppWsLabel();
  reloadRecvCards(); // 受信ボックスは病棟単位なので切替で再読込
  logEvent(EVENT.WS_SWITCH);
});

// ユーザー切替時に画面全体 + ヘッダー (ユーザー名/病棟) を再描画する (案B)。
setOnUserChanged(() => {
  setSelectedNo(1);
  refreshPatientUI();
  refreshAppUserName();
  refreshAppWsLabel();
  reloadRecvCards(); // 受信ボックスはユーザー/病棟単位なので切替で再読込
  logEvent(EVENT.USER_SWITCH);
});

// 患者編集 (ステータス変更・SOAP 等) の研究ログ。markUpdated は編集サイトから
// 高頻度に呼ばれるので、5 秒に 1 件へ debounce し「編集していた」だけを無記名で残す
// (キーごとには取らない)。_onMarkUpdated は他に未配線なので追加配線は安全。
let _editLogPending = false;
setMarkUpdatedHandler(() => {
  if (_editLogPending) return;
  _editLogPending = true;
  logEvent(EVENT.PATIENT_EDIT);
  setTimeout(() => { _editLogPending = false; }, 5000);
});

// ============================
// Boot 11: タイトル + WS 名 (header)
// ============================
// タイトル: 普段は readonly。タップ → ホーム遷移、鉛筆で編集可。
// WS 名: readonly でタップ → WS picker (切替/新規作成/リネーム)。
// タイトル: ただのラベル (編集は設定画面)。
initAppTitle();
// 案B: ヘッダーのタイトル枠はユーザー名。タップ → ユーザーピッカー (user-picker.js が配線)。
// WS リネームは WS ピッカー内。ホームへはヘッダー左の家ボタンで戻る。
document.getElementById("homeNavBtn")?.addEventListener("click", navToHome);
initUserPicker();
initWsPicker();

// ============================
// Boot 12: storage label (ハンバーガーメニューは v8.6 で廃止)
// ============================
const storageKeyLabel = document.getElementById("storageKeyLabel");
if (storageKeyLabel) storageKeyLabel.textContent = `${STORAGE_KEYS.db}.${STORAGE_KEYS.store}`;

requestStoragePersistence();

// ============================
// Boot 13: Web 版警告バナー (PWA でない場合のみ表示)
// ============================
{
  const banner = document.getElementById("webWarningBanner");
  const isStandalone =
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
    || window.navigator.standalone === true;
  if (banner) banner.style.display = isStandalone ? "none" : "";
}

// ============================
// Boot 14: ヘッダー高さ measurement
// ============================
// (説明書のインタラクティブデモ docs-demo.js は v8.9.4 で撤去。説明書は純粋な
//  HTML を iframe 表示するのみ)

// ヘッダー高さを CSS 変数化。.detailTop の sticky 用 top オフセットに使う。
{
  const header = document.querySelector("header");
  if (header) {
    const updateHeaderH = () => {
      const h = header.getBoundingClientRect().height;
      document.documentElement.style.setProperty("--headerH", h + "px");
    };
    updateHeaderH();
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(updateHeaderH).observe(header);
    } else {
      window.addEventListener("resize", updateHeaderH);
    }
  }
}

// ============================
// Boot 15: 初回描画 + スプラッシュ
// ============================
// HTML 内の data-i18n* をすべて t() で埋める。動的 DOM は各 renderer で t() を使う。
applyI18n();
doRenderHome();
setSelectedNo(1);
doRenderDetail();
showView("home");

// 起動ゲート: 初回はオンボーディング (名前+同意)、2人以上は日次のユーザー選択。
// home 描画後に出すので、閉じた瞬間にホーム画面へ戻れる。オンボーディングを出した
// 場合は同意取得済みなので月次免責は出さない。
(async () => {
  let onboarded = false;
  try { ({ onboarded } = await runBootGate()); }
  catch (e) { console.error("boot gate failed:", e); }
  if (!onboarded) maybeShowDisclaimer();
})();
