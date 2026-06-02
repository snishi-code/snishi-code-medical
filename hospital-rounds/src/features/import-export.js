"use strict";

// ============================================================================
// 取込 / 書出 (JSON ファイル経由)
//
// v7.6+ で UI が大幅刷新:
//   - WS 切替・新規作成は features/ws-picker.js (ヘッダー WS 名タップ) が担当
//   - WS rename・delete は views/settings-view.js の「ワークスペース管理」セクション
//   - 当ファイルは JSON 取込・書出のロジックと、それを呼ぶための DOM 配線 (ioFilePickBtn /
//     ioFileSaveBtn / settingsImportFile) だけを残す
//
// 外部 API:
//   initImportExport(callbacks) ... DOM 配線。callbacks に各 view の renderer を渡す
// ============================================================================

import {
  appState, settings,
  setAppState, setSettings,
  saveNow, normalizeLoaded,
  exportArchive, importArchive, isArchive,
  exportDeviceArchive, importDeviceArchive, isDeviceArchive,
} from "../store.js";
import { STATUS } from "../constants.js";
import {
  parseBundle, getSection, SECTION,
} from "../bundle.js";
import { captureSnapshot, REASON } from "./snapshots.js";
import { exportEventLog, clearEventLog } from "./eventlog.js";
import { t } from "../i18n.js";
import { showToast } from "../toast.js";

// 「設定も取込」「患者のみ」「キャンセル」を返す。データありの時だけ表示する。
function askImportAction() {
  return new Promise(resolve => {
    const overlay = document.getElementById("importActionOverlay");
    const btnInc = document.getElementById("importIncludeSettingsBtn");
    const btnPat = document.getElementById("importPatientsOnlyBtn");
    const btnCan = document.getElementById("importCancelBtn");

    const cleanup = () => {
      overlay.classList.remove("active");
      btnInc.removeEventListener("click", onInc);
      btnPat.removeEventListener("click", onPat);
      btnCan.removeEventListener("click", onCan);
    };
    const onInc = () => { cleanup(); resolve("include-settings"); };
    const onPat = () => { cleanup(); resolve("patients-only"); };
    const onCan = () => { cleanup(); resolve("cancel"); };

    btnInc.addEventListener("click", onInc);
    btnPat.addEventListener("click", onPat);
    btnCan.addEventListener("click", onCan);

    overlay.classList.add("active");
  });
}

function vibrate() {
  try { navigator.vibrate?.(80); } catch (_) { }
}

function isAppStateEmpty() {
  for (const p of appState.patients) {
    if (p.name || p.room || p.s || p.a?.text || p.p?.text || p.memo || p.shared || p.oFree) return false;
    if (Array.isArray(p.tags) && p.tags.length > 0) return false;
  }
  return true;
}

function isImportedPatientEmpty(p) {
  if (!p) return true;
  if (p.name || p.room || p.s || p.a?.text || p.p?.text || p.memo || p.shared || p.oFree) return false;
  if (Array.isArray(p.tags) && p.tags.length > 0) return false;
  return true;
}

// 取込側の患者が参照しているタグ名のうち、現行 settings.tags に無いものを末尾に追加。
// 名前ベースなので衝突リネームは不要 (同名タグは同タグとして扱う)。
function unionImportedTags(importedPatients) {
  if (!Array.isArray(settings.tags)) settings.tags = [];
  const currentSet = new Set(settings.tags);
  for (const p of importedPatients) {
    if (!Array.isArray(p?.tags)) continue;
    for (const tg of p.tags) {
      if (!tg || currentSet.has(tg)) continue;
      settings.tags.push(tg);
      currentSet.add(tg);
    }
  }
}

// 新規患者として末尾に追加 (status=BLUE で「新着」を可視化)。
function appendNewPatients(importedPatients) {
  let count = 0;
  for (const src of importedPatients) {
    if (isImportedPatientEmpty(src)) continue;
    const p = { ...src };
    p.status = STATUS.BLUE;
    p.updatedAt = Date.now();
    p.tags = Array.isArray(src.tags) ? src.tags.slice() : [];
    p.a = { text: String(src.a?.text ?? "") };
    p.p = { text: String(src.p?.text ?? "") };
    delete p.vitals;
    delete p.o;
    appState.patients.push(p);
    count++;
  }
  return count;
}

// 受信した settings を反映。
function applyImportedSettings(sSettings) {
  setSettings({ ...sSettings });
}

function importedAppStateFromBundle(bundle) {
  const sPatients = getSection(bundle, SECTION.PATIENTS);
  const sMeta = getSection(bundle, SECTION.META);
  return normalizeLoaded({
    title: sMeta && typeof sMeta.title === "string" ? sMeta.title : t("app.title"),
    patients: Array.isArray(sPatients) ? sPatients : null,
  });
}

function refreshTitleUI() {
  const appTitleInput = document.getElementById("appTitleInput");
  if (appTitleInput) appTitleInput.value = appState.title;
  document.title = appState.title;
}

export function initImportExport(callbacks) {
  const { renderHome, renderDetail, renderSettings, renderMemoScreen, renderSharedScreen } = callbacks;

  const settingsImportFile = document.getElementById("settingsImportFile");
  const ioFilePickBtn = document.getElementById("ioFilePickBtn");
  const ioFileSaveBtn = document.getElementById("ioFileSaveBtn");
  const ioDeviceImportBtn = document.getElementById("ioDeviceImportBtn");
  const ioDeviceSaveBtn = document.getElementById("ioDeviceSaveBtn");
  const ioLogExportBtn = document.getElementById("ioLogExportBtn");
  const ioLogClearBtn = document.getElementById("ioLogClearBtn");

  let lastExportUrl = null;

  function rerenderCurrentView() {
    renderHome();
    const settingsView = document.getElementById("settingsView");
    const detailView = document.getElementById("detailView");
    const memoView = document.getElementById("memoView");
    const sharedView = document.getElementById("sharedView");
    if (settingsView && settingsView.classList.contains("active")) renderSettings();
    if (detailView && detailView.classList.contains("active")) renderDetail();
    if (memoView && memoView.classList.contains("active")) renderMemoScreen();
    if (sharedView && sharedView.classList.contains("active")) renderSharedScreen();
  }

  async function downloadCurrentAsJson() {
    try {
      if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
      // v8.2+: 全ワークスペース + グローバル設定をまとめたアーカイブを書き出す
      const archive = await exportArchive();
      const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      lastExportUrl = url;

      let a = document.getElementById("hiddenDownloadLink");
      if (!a) {
        a = document.createElement("a");
        a.id = "hiddenDownloadLink";
        a.style.display = "none";
        document.body.appendChild(a);
      }
      a.href = url;
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const hh = String(now.getHours()).padStart(2, "0");
      const min = String(now.getMinutes()).padStart(2, "0");
      const titleSafe = (appState.title || t("app.title")).replace(/[\\/:*?"<>|]/g, "_");
      const envPrefix = document.documentElement.dataset.env === "test" ? "test_" : "";
      a.download = `${envPrefix}${titleSafe}_${yyyy}_${mm}${dd}_${hh}${min}.json`;
      a.click();
      // ダウンロードはバックグラウンドで進むため、保存したことを控えめに通知する
      showToast(t("export.saved"));
    } catch (err) {
      console.error("Export failed:", err);
      alert(t("export.failed"));
    }
  }

  // 端末まるごと (全ユーザー) アーカイブを書き出す。
  async function downloadDeviceArchive() {
    try {
      if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
      const archive = await exportDeviceArchive();
      const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      lastExportUrl = url;

      let a = document.getElementById("hiddenDownloadLink");
      if (!a) {
        a = document.createElement("a");
        a.id = "hiddenDownloadLink";
        a.style.display = "none";
        document.body.appendChild(a);
      }
      a.href = url;
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const hh = String(now.getHours()).padStart(2, "0");
      const min = String(now.getMinutes()).padStart(2, "0");
      const envPrefix = document.documentElement.dataset.env === "test" ? "test_" : "";
      a.download = `${envPrefix}device_${yyyy}_${mm}${dd}_${hh}${min}.json`;
      a.click();
      showToast(t("export.saved"));
    } catch (err) {
      console.error("Device export failed:", err);
      alert(t("export.failed"));
    }
  }

  // 研究ログ (無記名イベント) を JSON で書き出す。
  async function downloadEventLog() {
    try {
      if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
      const log = await exportEventLog();
      const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      lastExportUrl = url;
      let a = document.getElementById("hiddenDownloadLink");
      if (!a) { a = document.createElement("a"); a.id = "hiddenDownloadLink"; a.style.display = "none"; document.body.appendChild(a); }
      a.href = url;
      const now = new Date();
      const ymd = `${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
      const envPrefix = document.documentElement.dataset.env === "test" ? "test_" : "";
      a.download = `${envPrefix}log_${ymd}.json`;
      a.click();
      showToast(t("export.saved"));
    } catch (err) {
      console.error("Log export failed:", err);
      alert(t("export.failed"));
    }
  }

  // 端末まるごとアーカイブを取り込む。非破壊: 同名ユーザーは合流、無ければ新規作成。
  async function importDeviceArchiveFlow(archive) {
    const userCount = Array.isArray(archive.users) ? archive.users.length : 0;
    if (!confirm(t("import.device.confirm", { n: userCount }))) return;
    let res = { users: 0, workspaces: 0 };
    try {
      res = await importDeviceArchive(archive);
    } catch (err) {
      console.error("device archive import failed:", err);
      alert(t("import.read.failed"));
      return;
    }
    vibrate();
    rerenderCurrentView();
    showToast(t("import.device.done", { users: res.users, n: res.workspaces }));
  }

  // アーカイブ (全 ws + グローバル設定) を取り込む。非破壊: 各 ws を新規作成し、
  // グローバル設定はアーカイブのもので置換する (= フルバックアップ復元の体)。
  async function importArchiveFlow(archive) {
    const wsCount = Array.isArray(archive.workspaces) ? archive.workspaces.length : 0;
    if (!confirm(t("import.archive.confirm", { n: wsCount }))) return;
    let created = 0;
    try {
      created = await importArchive(archive, { includeSettings: true });
    } catch (err) {
      console.error("archive import failed:", err);
      alert(t("import.read.failed"));
      return;
    }
    vibrate();
    rerenderCurrentView();
    showToast(t("import.archive.done", { n: created }));
  }

  // parsed bundle を取り込む。空ならまるごと差替、データありなら「設定も含めるか?」を聞く。
  async function importFromBundle(bundle) {
    const sPatients = getSection(bundle, SECTION.PATIENTS);
    const sSettings = getSection(bundle, SECTION.SETTINGS);

    if (!Array.isArray(sPatients)) {
      if (sSettings) {
        applyImportedSettings(sSettings);
        saveNow();
      }
      vibrate();
      rerenderCurrentView();
      return;
    }

    const importedState = importedAppStateFromBundle(bundle);

    if (isAppStateEmpty()) {
      // title はヘッダーのユーザー名なので、取り込んだ bundle の meta.title で
      // 上書きしない (患者だけ差し替える)。
      importedState.title = appState.title;
      setAppState(importedState);
      refreshTitleUI();
      if (sSettings) applyImportedSettings(sSettings);
      saveNow();
      vibrate();
      rerenderCurrentView();
      return;
    }

    const action = await askImportAction();
    if (action === "cancel") return;

    if (action === "patients-only") {
      unionImportedTags(importedState.patients);
    } else if (action === "include-settings" && sSettings) {
      applyImportedSettings(sSettings);
    }
    // 破壊操作の直前: 現病棟に追記する前に状態を 1 枚スナップショット
    await captureSnapshot(REASON.IMPORT);
    appendNewPatients(importedState.patients);
    saveNow();
    vibrate();
    rerenderCurrentView();
  }

  // ============================
  // DOM 配線: JSON 取込/保存ボタン (設定画面の「ワークスペース管理」内)
  // ============================
  if (ioFilePickBtn && settingsImportFile) {
    ioFilePickBtn.addEventListener("click", () => settingsImportFile.click());
  }
  if (ioFileSaveBtn) {
    ioFileSaveBtn.addEventListener("click", downloadCurrentAsJson);
  }
  // 端末まるごと: 取込は同じファイル入力を使い、フォーマットで自動判別する。
  if (ioDeviceImportBtn && settingsImportFile) {
    ioDeviceImportBtn.addEventListener("click", () => settingsImportFile.click());
  }
  if (ioDeviceSaveBtn) {
    ioDeviceSaveBtn.addEventListener("click", downloadDeviceArchive);
  }
  // 研究ログ: 書出 / 消去
  if (ioLogExportBtn) {
    ioLogExportBtn.addEventListener("click", downloadEventLog);
  }
  if (ioLogClearBtn) {
    ioLogClearBtn.addEventListener("click", async () => {
      if (!confirm(t("io.log.clear.confirm"))) return;
      await clearEventLog();
      showToast(t("io.log.clear.done"));
    });
  }

  if (settingsImportFile) {
    settingsImportFile.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const parsedRaw = JSON.parse(ev.target.result);
          // 端末まるごと (全ユーザー) アーカイブを最優先で判定。
          if (isDeviceArchive(parsedRaw)) {
            await importDeviceArchiveFlow(parsedRaw);
            settingsImportFile.value = "";
            return;
          }
          // v8.2+: アーカイブ (全 ws) 形式なら専用フローへ。旧来の単一バンドルも互換受付。
          if (isArchive(parsedRaw)) {
            await importArchiveFlow(parsedRaw);
            settingsImportFile.value = "";
            return;
          }
          let bundle;
          try {
            bundle = parseBundle(parsedRaw);
          } catch (err) {
            alert(t("import.parse.failed"));
            console.error("parse failed:", err);
            settingsImportFile.value = "";
            return;
          }
          await importFromBundle(bundle);
        } catch (err) {
          alert(t("import.read.failed"));
          console.error("Import failed:", err);
        }
        settingsImportFile.value = "";
      };
      reader.readAsText(file);
    });
  }
}
