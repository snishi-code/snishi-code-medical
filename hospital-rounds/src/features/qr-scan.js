"use strict";

import jsQR from "jsqr";
import { t } from "../i18n.js";

// カメラ＋jsQR ライブスキャナ。
//   scanQR()           : 1回読んで閉じる（既存）
//   scanQRStream({...}): 連続モード。ハンドラから { stop: true } を返すまで開きっぱなし
//
// ライブ tick の最中に同じ文字列を連続検出するので、2 秒のデデュプ窓を入れて
// 同一テキストの多重発火を抑える。完全オフラインで動作。

let activeSession = null;
const DEDUP_MS = 2000;

// カメラ QR スキャナを起動 → 読み取り結果を該当 textarea に追記してから
// input イベントを発火するボタンの汎用ワイヤリング。
// scratch/paste 系 UI (sharedPasteCard / memoPasteCard 等) で使う想定。
// scanner 非対応端末ではボタンを disabled にする。
export function wireScanButton(btnId, areaId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (!isScannerSupported()) {
    btn.disabled = true;
    btn.title = t("qr.scanner.unsupported");
  }
  btn.addEventListener("click", async () => {
    const text = await scanQR();
    if (text == null) return;
    const area = document.getElementById(areaId);
    if (!area) return;
    const cur = area.value || "";
    const sep = cur && !cur.endsWith("\n") ? "\n" : "";
    area.value = cur + sep + text;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function isScannerSupported() {
  return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function");
}

export function scanQR() {
  return new Promise((resolve) => {
    if (activeSession) { resolve(null); return; }
    const session = openScanner({
      continuous: false,
      onScan: (text) => { resolve(text); return { stop: true }; },
      onCancel: () => resolve(null),
    });
    if (!session) resolve(null);
  });
}

// 連続スキャン。{ close(), setStatus(text), promise } を返す。
// onScan(text, ctrl) の戻り値が { stop: true } なら自動 close。
// promise はスキャナが閉じた時点で resolve（成功・キャンセル問わず）。
export function scanQRStream({ onScan, onCancel } = {}) {
  if (activeSession) return null;
  return openScanner({ continuous: true, onScan, onCancel });
}

function openScanner({ continuous, onScan, onCancel }) {
  if (!isScannerSupported()) {
    alert(t("qr.scanner.unavailable"));
    return null;
  }

  const overlay = buildOverlay();
  document.body.appendChild(overlay.root);

  let cleaned = false;
  let stream = null;
  let rafId = 0;
  let lastText = null;
  let lastTime = 0;
  let resolveDone = null;
  const donePromise = new Promise((r) => { resolveDone = r; });

  function cleanup(reason) {
    if (cleaned) return;
    cleaned = true;
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    overlay.root.remove();
    activeSession = null;
    if (reason === "cancel" && onCancel) onCancel();
    resolveDone();
  }

  const sessionApi = {
    close: () => cleanup("done"),
    setStatus: (text) => { overlay.status.textContent = String(text || ""); },
    promise: donePromise,
  };

  overlay.cancelBtn.addEventListener("click", () => cleanup("cancel"));
  overlay.root.addEventListener("click", (e) => {
    if (e.target === overlay.root) cleanup("cancel");
  });

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      overlay.video.srcObject = stream;
      await overlay.video.play();
      overlay.status.textContent = continuous
        ? t("qr.scan.hint.stream")
        : t("qr.scan.hint.once");
      tick();
    } catch (err) {
      overlay.status.textContent = t("qr.scan.startFailed", { message: (err && err.message) ? err.message : err });
      overlay.status.classList.add("scanErr");
    }
  })();

  function tick() {
    if (cleaned) return;
    const { video, canvas } = overlay;
    if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      let imageData;
      try {
        imageData = ctx.getImageData(0, 0, w, h);
      } catch (_) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      const found = jsQR(imageData.data, w, h, { inversionAttempts: "dontInvert" });
      if (found && found.data) {
        const text = found.data;
        const now = Date.now();
        const isDup = text === lastText && now - lastTime < DEDUP_MS;
        if (!isDup) {
          lastText = text;
          lastTime = now;
          let result;
          try { result = onScan ? onScan(text, sessionApi) : null; }
          catch (e) { console.error("scan handler error", e); }
          if (result && result.stop) { cleanup("done"); return; }
        }
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  activeSession = sessionApi;
  return sessionApi;
}

function buildOverlay() {
  const root = document.createElement("div");
  root.className = "qrScanOverlay";

  const panel = document.createElement("div");
  panel.className = "qrScanPanel";

  const head = document.createElement("div");
  head.className = "qrScanHead";
  head.textContent = t("qr.scan.head");

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "iconBtn";
  cancelBtn.setAttribute("aria-label", t("common.close"));
  cancelBtn.title = t("common.close");
  cancelBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  head.appendChild(cancelBtn);

  const videoWrap = document.createElement("div");
  videoWrap.className = "qrScanVideoWrap";
  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  video.muted = true;
  video.autoplay = true;
  videoWrap.appendChild(video);

  const reticle = document.createElement("div");
  reticle.className = "qrScanReticle";
  videoWrap.appendChild(reticle);

  const canvas = document.createElement("canvas");
  canvas.style.display = "none";

  const status = document.createElement("div");
  status.className = "qrScanStatus";
  status.textContent = t("qr.scan.starting");

  panel.appendChild(head);
  panel.appendChild(videoWrap);
  panel.appendChild(canvas);
  panel.appendChild(status);
  root.appendChild(panel);

  return { root, panel, video, canvas, status, cancelBtn };
}
