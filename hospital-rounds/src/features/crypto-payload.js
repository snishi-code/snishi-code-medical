"use strict";

// ============================
// QR payload 暗号化 (AES-GCM, アプリ固定鍵) + DEFLATE 圧縮
//
// 目的: 第三者が普通の QR スキャナで読み取った時に医療情報が即座に流出するのを防ぐ。
// 厳密な秘匿性は確保できない (バンドル化された JS から鍵抽出可能) が、
// "脅威モデル = QR スキャナでの偶発的読み取り" には十分。
//
// wire format (versioned prefix):
//   平文:   "RND_HM #abc 1/1\n<payload-text>"                              ... 患者画面のみ
//   E1:     "RND_HM #abc 1/1\nE1:<base64url(iv ‖ AES-GCM(plain))>"          ... v7.1.x (圧縮なし)
//   E2:     "RND_HM #abc 1/1\nE2:<base64url(iv ‖ AES-GCM(deflate-raw(plain)))>"  ... v7.2.0+ (圧縮あり)
//
// 暗号化アルゴリズム: AES-GCM 256bit (Web Crypto API)
//   iv:   12 byte (96 bit)、メッセージごとに crypto.getRandomValues
//   tag:  16 byte (認証付き暗号、改ざん検知)
//
// 圧縮アルゴリズム: DEFLATE (raw、ヘッダなし) via CompressionStream API
//   - LZ77 + Huffman 符号
//   - CompressionStream は iPad Safari 16.4+ で対応
//   - 未対応環境では try/catch で E1 (圧縮なし) にフォールバック
//
// 送信側は常に E2 (CompressionStream 利用可能時)。受信側は E1/E2 両方を読める。
// ============================

// アプリ固定鍵 (32 byte = 256 bit)。
const APP_KEY_BYTES = new Uint8Array([
  0x47, 0xa5, 0x1c, 0x9b, 0x38, 0x6d, 0x2e, 0x71,
  0xf4, 0x83, 0x05, 0xcc, 0x9a, 0x4d, 0x62, 0x18,
  0xb7, 0x29, 0x5a, 0xe0, 0x3c, 0x91, 0x8f, 0x46,
  0xd2, 0x57, 0x6a, 0x0b, 0xfd, 0xe5, 0x18, 0x73,
]);

const PREFIX_E1 = "E1:";  // v7.1.x: AES-GCM のみ
const PREFIX_E2 = "E2:";  // v7.2.0+: AES-GCM(deflate-raw(plain))

let _cachedKeyPromise = null;
function getKey() {
  if (!_cachedKeyPromise) {
    _cachedKeyPromise = crypto.subtle.importKey(
      "raw", APP_KEY_BYTES,
      { name: "AES-GCM" }, false, ["encrypt", "decrypt"]
    );
  }
  return _cachedKeyPromise;
}

// base64url (RFC 4648 §5)
function bytesToB64Url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToBytes(str) {
  let s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// CompressionStream / DecompressionStream による DEFLATE (raw)。
// 未対応環境 (古い Safari) では throw、呼び出し側で fallback。
async function deflateRaw(plainBytes) {
  if (typeof CompressionStream === "undefined") {
    throw new Error("CompressionStream unavailable");
  }
  const stream = new Blob([plainBytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function inflateRaw(compressedBytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream unavailable");
  }
  const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 共通: AES-GCM 暗号化 → "<prefix><base64url(iv ‖ ct)>"
async function aesGcmEncryptToPrefixed(prefix, plainBytes) {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes);
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return prefix + bytesToB64Url(combined);
}

// 共通: prefix 剥がして AES-GCM 復号 → plainBytes
async function aesGcmDecryptFromPrefixed(prefix, ciphertext) {
  const blob = b64UrlToBytes(ciphertext.slice(prefix.length));
  if (blob.length < 12 + 16) throw new Error("encrypted payload too short");
  const iv = blob.slice(0, 12);
  const ct = blob.slice(12);
  const key = await getKey();
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new Uint8Array(pt);
}

// 任意の文字列を暗号化。CompressionStream が使えるなら E2 (圧縮+暗号)、
// 使えない環境では E1 (暗号のみ) に自動 fallback。
export async function encryptPayload(plain) {
  if (plain == null) return "";
  const plainBytes = new TextEncoder().encode(String(plain));
  try {
    const compressed = await deflateRaw(plainBytes);
    return aesGcmEncryptToPrefixed(PREFIX_E2, compressed);
  } catch (_) {
    // CompressionStream 未対応 or 何らかの失敗 → E1 fallback
    return aesGcmEncryptToPrefixed(PREFIX_E1, plainBytes);
  }
}

// "E1:" / "E2:" 形式なら復号、それ以外はそのまま返す (平文の透過処理)。
export async function decryptPayload(text) {
  const s = String(text || "");
  if (s.startsWith(PREFIX_E2)) {
    const compressed = await aesGcmDecryptFromPrefixed(PREFIX_E2, s);
    const plainBytes = await inflateRaw(compressed);
    return new TextDecoder().decode(plainBytes);
  }
  if (s.startsWith(PREFIX_E1)) {
    const plainBytes = await aesGcmDecryptFromPrefixed(PREFIX_E1, s);
    return new TextDecoder().decode(plainBytes);
  }
  return s;
}

export function isEncrypted(text) {
  if (typeof text !== "string") return false;
  return text.startsWith(PREFIX_E1) || text.startsWith(PREFIX_E2);
}
