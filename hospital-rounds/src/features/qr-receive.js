"use strict";

// ============================
// 統一 QR 受信ルーター
//
// 設定の「QR から追加」1 箇所で、カメラ / 貼り付け のいずれでも QR を受け取り、
// 読み取った kind (ST/FS/FMT) を見て該当フローの受信処理へ自動で振り分ける。
// 各フロー (createQrFlow) が init 時に registerReceiver で自分の kind を登録する。
//
// テキスト受信はブラウザの専用 API ではなく「視認できる入力欄に QR の中身を
// 貼り付ける」方式で受ける (隠し input への focus 固定=案B は不採用)。カメラが
// 使えない端末や、別端末で読み取った QR の中身を渡したいときの受信口。
//
// 単ページは即適用、多ページは順に読み込み (進捗は各フローの ingest 表示を流用)。
// ============================

import { scanQRStream, isScannerSupported } from "./qr-scan.js";
import { decodePage } from "./qr-protocol.js";
import { t } from "../i18n.js";

// kind → { kindLabel, receivePage(text, ctrl) }
const _receivers = new Map();

export function registerReceiver(kind, handler) {
  if (!kind || !handler || typeof handler.receivePage !== "function") return;
  _receivers.set(kind, handler);
}

export function getReceiver(kind) {
  return _receivers.get(kind) || null;
}

// この入口で受け付ける kind。設定・セット・フォーマットのみ (患者系 HM/MM/SH は
// 各画面の受信導線が担う)。
const ALLOWED_KINDS = Object.freeze(["ST", "FS", "FMT"]);

// 生 QR テキスト 1 ページを kind 判定して該当 receiver へ。
// 戻り値は receivePage の結果 ({ done, consumed, payload, apply } 等)。
// 形式不正・対象外 kind は { done:false, consumed:false } を返し status を出す。
function routePage(text, ctrl) {
  const decoded = decodePage(text);
  if (!decoded) {
    ctrl.setStatus(t("qr.recv.unknownFormat"));
    return { done: false, consumed: false };
  }
  if (!ALLOWED_KINDS.includes(decoded.kind)) {
    ctrl.setStatus(t("qr.recv.router.notAllowed", { got: decoded.kind }));
    return { done: false, consumed: false };
  }
  const receiver = getReceiver(decoded.kind);
  if (!receiver) {
    ctrl.setStatus(t("qr.recv.router.noReceiver", { got: decoded.kind }));
    return { done: false, consumed: false };
  }
  return receiver.receivePage(text, ctrl);
}

// ============================
// オーバーレイ制御 (HTML: #qrReceiveOverlay)
// ============================

function el(id) { return document.getElementById(id); }

export function openQrReceiveOverlay() {
  const overlay = el("qrReceiveOverlay");
  if (!overlay) return;
  overlay.classList.add("active");
  const area = el("qrReceiveArea");
  if (area) area.value = "";
  const status = el("qrReceiveStatus");
  if (status) status.textContent = "";
  area?.focus();
}

export function closeQrReceiveOverlay() {
  const overlay = el("qrReceiveOverlay");
  if (overlay) overlay.classList.remove("active");
}

export function initQrReceive() {
  const overlay = el("qrReceiveOverlay");
  if (!overlay) return;

  const status = el("qrReceiveStatus");
  // apply 後に閉じる対象は受信オーバーレイ。各 onApply は ctrl.close() を呼ぶ。
  const baseCtrl = {
    setStatus: (s) => { if (status) status.textContent = String(s || ""); },
    close: closeQrReceiveOverlay,
  };

  // テキスト貼り付け入力
  const area = el("qrReceiveArea");
  const readBtn = el("qrReceiveReadBtn");
  if (readBtn) readBtn.addEventListener("click", () => {
    const raw = (area?.value || "").trim();
    if (!raw) { baseCtrl.setStatus(t("qr.recv.text.empty")); return; }
    const r = routePage(raw, baseCtrl);
    if (r.consumed && area) area.value = "";
    if (r.done) r.apply();
    else area?.focus();
  });

  // カメラ
  const scanBtn = el("qrReceiveScanBtn");
  if (scanBtn) {
    if (!isScannerSupported()) {
      scanBtn.disabled = true;
      scanBtn.title = t("qr.scanner.unsupported");
    } else {
      scanBtn.addEventListener("click", () => {
        const session = scanQRStream({
          onScan: (text, scanCtrl) => {
            // 進捗はスキャナの status に、apply 後の close は受信オーバーレイに向ける
            const r = routePage(text, { setStatus: scanCtrl.setStatus, close: closeQrReceiveOverlay });
            if (r.done) {
              setTimeout(r.apply, 100); // スキャナを閉じてから apply (alert が隠れない)
              return { stop: true };
            }
          },
        });
        if (!session) alert(t("qr.scanner.open.failed"));
      });
    }
  }
}
