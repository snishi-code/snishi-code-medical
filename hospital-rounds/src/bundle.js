"use strict";

import { t } from "./i18n.js";

// ============================
// Bundle format
//
// The Bundle is the canonical serialization shape for the app: it's used by
// JSON file exports, the localStorage snapshot, and (after encryption) the
// admin QR payload. The bundle is content-addressed by section so the same
// parser handles a full backup or a single-section transfer (memo-only,
// roster-only, etc.) — the UI only emits "full" today, but the structure is
// already in place for partial transfers.
//
// {
//   "format":     "hospital-rounds-bundle",
//   "schema":     1,
//   "appVersion": "1.0.0",
//   "exportedAt": "2026-05-20T09:24:00.000Z",
//   "owner":      { "deviceId": "...", "label": "" },
//   "rosterId":   "...",
//   "sections": {
//     "meta":     { "title": "..." },
//     "settings": { ... },
//     "patients": [ ...full clinical records... ],
//     "roster":   { patients: [{pid,name,room,tags}], tags: [...] },
//     "memo":     [ {pid, memo} ],
//     "shared":   [ {pid, shared} ],
//     "history":  { baseSnapshot, commits, head }
//   }
// }
// ============================

export const BUNDLE_FORMAT = "hospital-rounds-bundle";
export const BUNDLE_SCHEMA = 1;
export const BUNDLE_APP_VERSION = "1.0.0";

export const SECTION = Object.freeze({
  META: "meta",
  SETTINGS: "settings",
  PATIENTS: "patients",
  ROSTER: "roster",
  MEMO: "memo",
  SHARED: "shared",
  // v7.7+: HISTORY section (roster commits) は撤去。section 値自体は parseBundle
  // が旧 bundle を読んだ時に未知フィールドとして温存される (forward compat)
});

// Default sections written by the "save everything" preset (file export +
// localStorage snapshot). Derived sections (roster/memo/shared) は projection
// なので除外。
export const FULL_BACKUP_SECTIONS = Object.freeze([
  SECTION.META, SECTION.SETTINGS, SECTION.PATIENTS,
]);

function nowIso() {
  try { return new Date().toISOString(); } catch (_) { return ""; }
}

function projectRosterView(patients, tags) {
  return {
    patients: (patients || []).map(p => ({
      pid: String(p.pid || ""),
      name: String(p.name || ""),
      room: String(p.room || ""),
      tags: Array.isArray(p.tags) ? p.tags.slice() : [],
    })),
    tags: Array.isArray(tags) ? tags.slice() : [],
  };
}

// ============================
// Project: in-memory state -> bundle
// ============================

export function projectBundle({
  appState,
  settings,
  sections = FULL_BACKUP_SECTIONS,
  owner,
  exportedAt,
}) {
  const want = new Set(sections);
  const out = {
    format: BUNDLE_FORMAT,
    schema: BUNDLE_SCHEMA,
    appVersion: BUNDLE_APP_VERSION,
    exportedAt: exportedAt != null ? exportedAt : nowIso(),
    owner: owner || { deviceId: settings?.deviceId || "", label: "" },
    sections: {},
  };

  if (want.has(SECTION.META)) {
    // recvMemo / recvShared = 受信ボックス (他端末から受け取った内容)。病棟単位で
    // 永続化し、消去するまで残す (医師が後で転記する運用)。患者データではないが
    // 同じ病棟スナップショットに含めて保存・復元する。
    out.sections.meta = {
      title: String(appState?.title || t("app.title")),
      recvMemo: String(appState?.recvMemo || ""),
      recvShared: String(appState?.recvShared || ""),
    };
  }
  if (want.has(SECTION.SETTINGS) && settings) {
    out.sections.settings = settings;
  }
  if (want.has(SECTION.PATIENTS) && appState?.patients) {
    out.sections.patients = appState.patients;
  }
  if (want.has(SECTION.ROSTER) && appState?.patients) {
    out.sections.roster = projectRosterView(appState.patients, settings?.tags);
  }
  if (want.has(SECTION.MEMO) && appState?.patients) {
    out.sections.memo = appState.patients
      .filter(p => p && p.pid && p.memo)
      .map(p => ({ pid: p.pid, memo: p.memo }));
  }
  if (want.has(SECTION.SHARED) && appState?.patients) {
    out.sections.shared = appState.patients
      .filter(p => p && p.pid && p.shared)
      .map(p => ({ pid: p.pid, shared: p.shared }));
  }
  // v7.7+: HISTORY section (roster commits) は撤去。bundle に rosterId / history
  // 含まないが、未知フィールドとして残っている旧 bundle を読んでも parseBundle
  // 側で無視される。再実装時は v7.6.1 タグを参照
  return out;
}

// ============================
// Parse: raw -> bundle
// ============================

export function parseBundle(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid bundle: not an object");
  }
  if (raw.format !== BUNDLE_FORMAT || !raw.sections || typeof raw.sections !== "object") {
    throw new Error("unknown file format");
  }
  return normalizeBundle(raw);
}

function normalizeBundle(b) {
  return {
    format: BUNDLE_FORMAT,
    schema: typeof b.schema === "number" ? b.schema : BUNDLE_SCHEMA,
    appVersion: typeof b.appVersion === "string" ? b.appVersion : "",
    exportedAt: typeof b.exportedAt === "string" ? b.exportedAt : "",
    owner: (b.owner && typeof b.owner === "object")
      ? { deviceId: String(b.owner.deviceId || ""), label: String(b.owner.label || "") }
      : { deviceId: "", label: "" },
    rosterId: typeof b.rosterId === "string" ? b.rosterId : "",
    sections: { ...b.sections },
  };
}

// ============================
// Section accessors
// ============================

export function getSection(bundle, key) {
  return bundle && bundle.sections ? bundle.sections[key] : undefined;
}

export function hasSection(bundle, key) {
  return !!(bundle && bundle.sections && Object.prototype.hasOwnProperty.call(bundle.sections, key));
}
