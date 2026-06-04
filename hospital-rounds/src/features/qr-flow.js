"use strict";

import { qrcodegen } from "../libs/qrcodegen.js";
import { scanQRStream, isScannerSupported } from "./qr-scan.js";
import { encodePages, decodePage, newBatchId } from "./qr-protocol.js";
import { packPayload, unpackPayload } from "./crypto-payload.js";
import { registerReceiver } from "./qr-receive.js";
import { logEvent, EVENT } from "./eventlog.js";
import { t } from "../i18n.js";

// 表示ボタン id → QR 種別ラベル (研究ログ用)。将来「カルテ記載/共有」の区別に使う。
function qrKindFromBtnId(btnId) {
  const map = {
    homeShowQrBtn: "home", sharedShowQrBtn: "shared", memoShowQrBtn: "memo",
    settingsShowQrBtn: "settings", qrFormatShowBtn: "format",
  };
  return map[btnId] || "other";
}

// ============================
// QR フロー共通ファクトリ
//
// 4 種 (HM/MM/SH/ST) すべてが「送信側 QR カードのレンダリング + 連続スキャン
// 受信 + バッチID ベースの多ページ集合 + 全ページ揃った瞬間の auto-apply」
// という同じライフサイクルを持つ。ここに集約してターゲット固有の差は cfg
// に閉じる:
//
//   - kind / kindLabel       : 種別タグと表示名（スキャナ警告に使う）
//   - ids                    : DOM ID 一式（wrap/canvas/meta/prev/next/show/scan）
//   - encodePayload()        : in-memory → 文字列ペイロード
//   - decodePayload(string)  : ペイロード → 任意の decoded データ
//   - onApply(decoded, ctrl) : N/N 揃った瞬間に呼ばれる。ctrl.close で送信
//                              カードを閉じられる
//
// 受信ヘッダー解析と多ページ集合は qr-protocol.js に任せ、ここはフロー制御
// と DOM 配線だけを担当する。
// ============================

// qr-protocol.js の MAX_BYTES (750) と整合。各 kind 個別 override は撤去
// (v7.2.0 で 5 種統一)。1 ページに収まらない場合は複数ページに分割される。
const MAX_BYTES = 750;

function drawQrToCanvas(canvasId, text) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  try {
    const ecl = qrcodegen.QrCode.Ecc.LOW;
    const qr = qrcodegen.QrCode.encodeText(text, ecl);
    const border = 4;
    const modules = qr.size + border * 2;
    const parentW = (canvas.parentElement && canvas.parentElement.clientWidth) ? canvas.parentElement.clientWidth : 800;
    const cssW = Math.max(240, Math.min(parentW, 980));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const scale = Math.max(2, Math.floor((cssW * dpr) / modules));
    const sizePx = modules * scale;
    canvas.width = sizePx;
    canvas.height = sizePx;
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    canvas.style.maxWidth = cssW + "px";
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sizePx, sizePx);
    ctx.fillStyle = "#000000";
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) {
          ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
        }
      }
    }
  } catch (err) {
    console.error(`QR generation failed (${canvasId})`, err);
  }
}

export function createQrFlow(cfg) {
  let qrPages = [];
  let qrPageIndex = 0;

  let recvBatchId = null;
  let recvTotal = 0;
  const recvPages = new Map();
  function resetRecv() {
    recvBatchId = null;
    recvTotal = 0;
    recvPages.clear();
  }

  function renderQrPage() {
    const meta = document.getElementById(cfg.ids.pageMetaId);
    const prevBtn = document.getElementById(cfg.ids.prevBtnId);
    const nextBtn = document.getElementById(cfg.ids.nextBtnId);
    const canvas = document.getElementById(cfg.ids.canvasId);

    if (!qrPages || qrPages.length === 0) {
      if (meta) meta.textContent = cfg.emptyMessage || t("qr.empty.contentless");
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      if (canvas) {
        canvas.width = 1; canvas.height = 1;
        canvas.style.width = "0";
      }
      return;
    }

    const i = Math.max(0, Math.min(qrPageIndex, qrPages.length - 1));
    qrPageIndex = i;
    const total = qrPages.length;
    const text = qrPages[i];
    if (meta) meta.textContent = `(${i + 1}/${total})`;
    if (prevBtn) prevBtn.disabled = (i === 0);
    if (nextBtn) nextBtn.disabled = (i === total - 1);
    drawQrToCanvas(cfg.ids.canvasId, text);
  }

  async function regenerateAndRender() {
    let payload = cfg.encodePayload();
    if (payload) {
      const encrypt = typeof cfg.shouldEncrypt === "function" && cfg.shouldEncrypt();
      try {
        // transport 層: 暗号化 ON → E2 / OFF でも cfg.compress なら C1 / それ以外 plain
        payload = await packPayload(payload, { encrypt, compress: !!cfg.compress });
      } catch (e) {
        console.error("packPayload failed:", e);
        // 暗号化が要るのに失敗した時は安全側に倒し payload を破棄 (= QR を出さない)。
        // 圧縮失敗は packPayload 内で plain fallback 済みなのでここには来ない。
        if (encrypt) payload = "";
      }
    }
    qrPages = payload
      ? encodePages({ kind: cfg.kind, payload, batchId: newBatchId(), maxBytes: cfg.maxBytes || MAX_BYTES })
      : [];
    qrPageIndex = 0;
    renderQrPage();
  }

  function open() {
    const wrap = document.getElementById(cfg.ids.wrapId);
    if (!wrap) return;
    wrap.classList.add("active");
    regenerateAndRender();
  }
  function close() {
    const wrap = document.getElementById(cfg.ids.wrapId);
    if (!wrap) return;
    wrap.classList.remove("active");
  }
  function isActive() {
    const wrap = document.getElementById(cfg.ids.wrapId);
    return !!(wrap && wrap.classList.contains("active"));
  }
  function refresh() {
    if (!isActive()) return;
    regenerateAndRender();
  }

  // ============================
  // 受信解析 (カメラ・テキスト共通)
  //
  // 1 ページ分の生 QR テキストを 1 つ取り込む。decodePage → kind 判定 →
  // バッチ集約までを担い、status は ctrl.setStatus(text) で呼び出し側
  // (カメラ overlay / テキスト欄) に出す。全ページ揃ったら payload を
  // 組み立てて返す (復号・decodePayload・onApply は applyPayload が担当)。
  //
  // 戻り値 { done, payload, consumed }:
  //   done     … 全ページ揃った (payload に連結結果)
  //   consumed … 正規の 1 ページとして取り込んだ (= 入力欄をクリアしてよい)。
  //              形式不一致・kind 違いは consumed=false で入力を残す。
  // ============================
  function ingestPage(text, ctrl) {
    const decoded = decodePage(text);
    if (!decoded) {
      ctrl.setStatus(t("qr.recv.unknownFormat"));
      return { done: false, consumed: false };
    }
    if (decoded.kind !== cfg.kind) {
      ctrl.setStatus(t("qr.recv.wrongKind", { label: cfg.kindLabel, got: decoded.kind }));
      return { done: false, consumed: false };
    }
    if (recvBatchId && recvBatchId !== decoded.batchId) {
      resetRecv();
      ctrl.setStatus(t("qr.recv.newBatch"));
    }
    if (!recvBatchId) {
      recvBatchId = decoded.batchId;
      recvTotal = decoded.totalPages;
    }
    if (recvPages.has(decoded.pageNum)) {
      ctrl.setStatus(t("qr.recv.duplicate", { got: recvPages.size, total: recvTotal }));
      return { done: false, consumed: true };
    }
    recvPages.set(decoded.pageNum, decoded.content);
    try { navigator.vibrate?.(80); } catch (_) {}
    if (recvPages.size === recvTotal) {
      const total = recvTotal;
      const full = [];
      for (let i = 1; i <= total; i++) full.push(recvPages.get(i));
      const payload = full.join("");
      resetRecv();
      ctrl.setStatus(t("qr.recv.complete", { total }));
      return { done: true, consumed: true, payload };
    }
    ctrl.setStatus(t("qr.recv.progress", { got: recvPages.size, total: recvTotal }));
    return { done: false, consumed: true };
  }

  // 揃った payload を unpack (復号/展開) → decodePayload → onApply。失敗時は alert
  // で中断 (fail-closed: 握って成功扱いにしない)。
  async function applyPayload(payload, ctrl) {
    let plain;
    try {
      plain = await unpackPayload(payload);
    } catch (e) {
      alert(t("qr.recv.decrypt.failed", { message: e.message || e }));
      return;
    }
    let decodedPayload;
    try {
      decodedPayload = cfg.decodePayload(plain);
    } catch (e) {
      alert(t("qr.recv.parse.failed", { message: e.message || e }));
      return;
    }
    cfg.onApply(decodedPayload, ctrl);
  }

  // 受信レジストリ用: 1 ページ取り込む。揃ったら apply 用の thunk を同梱して返す
  // (apply を即実行しないのは、カメラ経路でスキャナを閉じてから alert を出すため)。
  // 統一受信ルーター (qr-receive.js)・カード内テキスト欄・カメラの全経路が通る。
  function receivePage(text, ctrl) {
    const r = ingestPage(text, ctrl);
    if (r.done) return { ...r, apply: () => applyPayload(r.payload, ctrl) };
    return r;
  }

  function startScan() {
    const session = scanQRStream({
      onScan: (text, ctrl) => {
        const r = receivePage(text, { setStatus: ctrl.setStatus, close });
        if (r.done) {
          // スキャナが閉じてから apply（alert がスキャナの裏に隠れないように）
          setTimeout(r.apply, 100);
          return { stop: true };
        }
      },
    });
    if (!session) alert(t("qr.scanner.open.failed"));
  }

  // ============================
  // テキスト受信パネル (カメラ非対応端末 / HID キーボードウェッジ型リーダー
  // / 手貼り付け用)。createQrFlow が動的に注入する。生 QR テキストを 1 ページ
  // ずつ取り込み、多ページは順に貼り付けて読ませる (進捗は ingestPage の status
  // をそのまま流用)。永続受信ボックス (recvMemo/recvShared) とは別物で、ここは
  // 「生 QR の一時入力欄」。
  // ============================
  function wireTextRecv() {
    const wrap = document.getElementById(cfg.ids.wrapId);
    if (!wrap || wrap.querySelector(".qrTextRecv")) return;

    const panel = document.createElement("div");
    panel.className = "qrTextRecv";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary qrTextRecvToggle";
    toggle.textContent = t("qr.recv.text.toggle");

    const body = document.createElement("div");
    body.className = "qrTextRecvBody";
    body.hidden = true;

    const hint = document.createElement("div");
    hint.className = "qrTextRecvHint";
    hint.textContent = t("qr.recv.text.hint");

    const area = document.createElement("textarea");
    area.className = "qrTextRecvArea";
    area.rows = 3;
    area.placeholder = t("qr.recv.text.placeholder");

    const actions = document.createElement("div");
    actions.className = "qrTextRecvActions";

    const status = document.createElement("span");
    status.className = "qrTextRecvStatus";
    status.setAttribute("aria-live", "polite");

    const readBtn = document.createElement("button");
    readBtn.type = "button";
    readBtn.className = "primary qrTextRecvRead";
    readBtn.textContent = t("qr.recv.text.read");

    actions.appendChild(status);
    actions.appendChild(readBtn);
    body.appendChild(hint);
    body.appendChild(area);
    body.appendChild(actions);
    panel.appendChild(toggle);
    panel.appendChild(body);
    wrap.appendChild(panel);

    const ctrl = { setStatus: (s) => { status.textContent = String(s || ""); }, close };

    toggle.addEventListener("click", () => {
      const opening = body.hidden;
      body.hidden = !opening;
      toggle.classList.toggle("open", opening);
      if (opening) {
        // 開いたら現在の受信進捗を反映 (カメラと state を共有)
        if (recvBatchId) ctrl.setStatus(t("qr.recv.progress", { got: recvPages.size, total: recvTotal }));
        else ctrl.setStatus("");
        area.focus();
      }
    });

    function readOnce() {
      const raw = (area.value || "").trim();
      if (!raw) { ctrl.setStatus(t("qr.recv.text.empty")); return; }
      const r = receivePage(raw, ctrl);
      if (r.consumed) area.value = "";
      if (r.done) r.apply();
      else area.focus();
    }

    readBtn.addEventListener("click", readOnce);
  }

  function init() {
    const showBtn = document.getElementById(cfg.ids.showBtnId);
    if (showBtn) showBtn.addEventListener("click", () => {
      if (isActive()) close();
      else { open(); logEvent(EVENT.QR_SHOW, { kind: qrKindFromBtnId(cfg.ids.showBtnId) }); }
    });

    const prevBtn = document.getElementById(cfg.ids.prevBtnId);
    const nextBtn = document.getElementById(cfg.ids.nextBtnId);
    if (prevBtn) prevBtn.addEventListener("click", () => {
      if (qrPageIndex > 0) { qrPageIndex--; renderQrPage(); }
    });
    if (nextBtn) nextBtn.addEventListener("click", () => {
      if (qrPageIndex < qrPages.length - 1) { qrPageIndex++; renderQrPage(); }
    });

    // inlineReceive=false (ST/FS/FMT) はカード内の受信 UI を出さない。受信は統一
    // ルーター (qr-receive.js) に集約。送信カードは「表示専用」になる。
    // 既定 (HM/MM/SH) は従来どおりカード内にカメラ + テキスト受信欄を持つ。
    const inlineReceive = cfg.inlineReceive !== false;
    const scanBtn = document.getElementById(cfg.ids.scanBtnId);
    if (scanBtn) {
      if (!inlineReceive) {
        scanBtn.style.display = "none";
      } else {
        if (!isScannerSupported()) {
          scanBtn.disabled = true;
          scanBtn.title = t("qr.scanner.unsupported");
        }
        scanBtn.addEventListener("click", startScan);
      }
    }
    if (inlineReceive) {
      // カメラの有無に関わらずテキスト受信欄を用意 (リーダー / 貼り付け / カメラ非対応端末)
      wireTextRecv();
    }

    // 受信レジストリへ登録 (統一ルーター・カード内テキスト欄が共通で使う)
    registerReceiver(cfg.kind, { kindLabel: cfg.kindLabel, receivePage });
  }

  return { init, isActive, refresh, close, open };
}
