// データ層の回帰検査。
//
// Vite ビルドは構文・import チェックしかしないので、モジュール初期化中の
// 実行時バグ（TDZ など）や、Bundle 形式のパース／射影の互換性は素通りする。
// このスクリプトは fixtures/*.json を順に読ませて、parseBundle・projectBundle・
// store.js のコールド／ウォームブートまで一通り走らせ、main の挙動に近い経路で
// データ層が壊れていないかを確認する。
//
// v4 以降: 永続化は IndexedDB だが Node には indexedDB が無いため、
// テストは「fixture を初期 bundle として直接 initStore に渡す」方式で
// 状態を仕込む (storage.js には触らない)。
//
// 使い方:   npm test

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ============================
// Browser API stubs
// ============================
// localStorage stub は legacy fallback 経路を含めて検査するため残す
// (IDB が空でかつ legacy localStorage に bundle がある時の挙動)
class LocalStorageStub {
  constructor() { this._data = {}; }
  getItem(k) { return this._data[k] ?? null; }
  setItem(k, v) { this._data[k] = String(v); }
  removeItem(k) { delete this._data[k]; }
  clear() { this._data = {}; }
}
globalThis.localStorage = new LocalStorageStub();
if (!globalThis.crypto) {
  globalThis.crypto = (await import("node:crypto")).webcrypto;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");
const srcDir = resolve(__dirname, "..", "src");
const storeUrl = pathToFileURL(join(srcDir, "store.js")).href;
const bundleUrl = pathToFileURL(join(srcDir, "bundle.js")).href;

const {
  parseBundle, projectBundle,
  SECTION, getSection, BUNDLE_FORMAT,
} = await import(bundleUrl);

// store.js を「同じインスタンスで再初期化」するヘルパ。
// - opts.bundle: 直接渡せば storage を経由せず initStore がそれを採用
//
// 注意: 以前は import URL に query string を付けてキャッシュバスティングしていたが、
// store.js と roster.js が別 module instance になると `rosterState` が共有されず
// テスト失敗するため、同じインスタンスを共有して _resetInitForTests で
// 内部状態だけリセットする方式に変更。
let _storeMod = null;
async function freshStore({ bundle = null } = {}) {
  if (!_storeMod) _storeMod = await import(storeUrl);
  _storeMod._resetInitForTests();
  localStorage.clear();
  await _storeMod.initStore(bundle ? { bundle } : undefined);
  return _storeMod;
}

// ============================
// Tiny test harness
// ============================
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message || e}`);
    if (e.stack) console.error(`    ${e.stack.split("\n").slice(1, 3).join("\n    ")}`);
    failed++;
  }
}

function section(label) {
  console.log(`\n${label}`);
}

// ============================
// 1) Cold boot
// ============================
section("cold boot");

await test("empty storage → defaults populated", async () => {
  const store = await freshStore();
  assert.equal(store.appState.patients.length, 50, "50 default patient slots");
  assert.equal(store.appState.title, "回診");
  assert.ok(Array.isArray(store.settings.formats) && store.settings.formats.length > 0, "default formats populated");
  assert.ok(store.appState.patients.every(p => typeof p.pid === "string" && p.pid.length > 0), "every default patient has a pid");
});

// ============================
// 2) parseBundle on each fixture
// ============================
section("parseBundle");

const fixtureFiles = readdirSync(fixturesDir).filter(f => f.endsWith(".json"));
const fixtures = {};
for (const f of fixtureFiles) {
  fixtures[f] = JSON.parse(readFileSync(join(fixturesDir, f), "utf8"));
}

for (const [name, raw] of Object.entries(fixtures)) {
  await test(`${name} parses to a bundle`, () => {
    const b = parseBundle(raw);
    assert.equal(b.format, BUNDLE_FORMAT);
    assert.equal(b.schema, 1);
    assert.ok(b.sections && typeof b.sections === "object");
  });
}

await test("null input is rejected", () => {
  assert.throws(() => parseBundle(null));
});
await test("non-object input is rejected", () => {
  assert.throws(() => parseBundle("not-a-bundle"));
});
await test("unknown shape is rejected", () => {
  assert.throws(() => parseBundle({ random: "object" }));
});

// ============================
// 3) projectBundle round-trip
// ============================
section("round-trip");

for (const [name, raw] of Object.entries(fixtures)) {
  await test(`${name} round-trips preserving pids and section keys`, () => {
    const b = parseBundle(raw);
    const patients = getSection(b, SECTION.PATIENTS) || [];
    const settings = getSection(b, SECTION.SETTINGS) || { deviceId: "", oRules: [], tags: [] };
    const meta = getSection(b, SECTION.META) || {};

    const projected = projectBundle({
      appState: { title: meta.title, patients },
      settings,
    });
    const reparsed = parseBundle(projected);

    // Patient pids preserved through serialization
    const origPids = patients.map(p => p.pid);
    const newPids = (getSection(reparsed, SECTION.PATIENTS) || []).map(p => p.pid);
    assert.deepEqual(newPids, origPids);

    // Meta section survives projection
    if (getSection(b, SECTION.META)?.title) {
      assert.ok(getSection(reparsed, SECTION.META), "meta section retained");
    }
  });
}

// ============================
// 4) Warm boot: fixture as initStore seed
// ============================
section("warm boot from fixture");

for (const [name, raw] of Object.entries(fixtures)) {
  await test(`${name} hydrates store.js`, async () => {
    const store = await freshStore({ bundle: raw });

    // v6.5+ では title は端末固定 (localStorage) なので bundle.meta.title からは
    // 読まない。localStorage が空のテスト環境ではフォールバック "回診" になる。
    assert.equal(store.appState.title, "回診");

    // Patients are normalized to objects with all expected fields
    const samplePid = raw.sections?.patients?.[0]?.pid;
    if (samplePid) {
      const found = store.appState.patients.find(p => p.pid === samplePid);
      assert.ok(found, `patient ${samplePid} present after hydration`);
      assert.equal(typeof found.oFree, "string", "patient has oFree string");
    }
  });
}

// ============================
// 5) isPatientEmpty
// ============================
section("isPatientEmpty");

await test("default patient (status NONE, all empty) IS empty", async () => {
  const store = await freshStore();
  const p = store.makeDefaultPatient();
  assert.equal(store.isPatientEmpty(p), true);
});

await test("status NONE + name set is NOT empty", async () => {
  const store = await freshStore();
  const p = store.makeDefaultPatient();
  p.name = "山田";
  assert.equal(store.isPatientEmpty(p), false);
});

await test("status NONE + room set is NOT empty", async () => {
  const store = await freshStore();
  const p = store.makeDefaultPatient();
  p.room = "301";
  assert.equal(store.isPatientEmpty(p), false);
});

await test("status NONE + tag set is NOT empty", async () => {
  const store = await freshStore();
  const p = store.makeDefaultPatient();
  p.tags = ["A"];
  assert.equal(store.isPatientEmpty(p), false);
});

await test("status NONE + SOAP s is NOT empty", async () => {
  const store = await freshStore();
  const p = store.makeDefaultPatient();
  p.s = "発熱あり";
  assert.equal(store.isPatientEmpty(p), false);
});

await test("status NONE + memo is NOT empty", async () => {
  const store = await freshStore();
  const p = store.makeDefaultPatient();
  p.memo = "メモ";
  assert.equal(store.isPatientEmpty(p), false);
});

await test("status NONE + shared is NOT empty", async () => {
  const store = await freshStore();
  const p = store.makeDefaultPatient();
  p.shared = "共有";
  assert.equal(store.isPatientEmpty(p), false);
});

await test("status NONE + oFree text is NOT empty", async () => {
  const store = await freshStore();
  const p = store.makeDefaultPatient();
  p.oFree = "BP 128/76";
  assert.equal(store.isPatientEmpty(p), false);
});

await test("forward compat: unknown patient fields are preserved through normalize", async () => {
  // 将来追加されるかもしれないフィールド (例: priority) を仕込んだ bundle を
  // 読み込み、normalize 後も残っていることを確認 (現在の最新版が読んだ未知
  // フィールドが drop されると、再保存時にデータ消失する)
  const bundle = {
    format: BUNDLE_FORMAT,
    schema: 1,
    sections: {
      meta: { title: "回診" },
      settings: {},
      patients: [{
        pid: "p_fwd",
        status: "none",
        name: "山田",
        room: "101",
        priority: "high",         // 未知フィールド (将来想定)
        customFlags: { x: 1 },    // 未知フィールド (object)
      }],
    },
  };
  const store = await freshStore({ bundle });
  const found = store.appState.patients.find(p => p.pid === "p_fwd");
  assert.ok(found, "patient hydrated");
  assert.equal(found.priority, "high", "unknown string field preserved");
  assert.deepEqual(found.customFlags, { x: 1 }, "unknown object field preserved");
  // 既知フィールドの validation は引き続き効くこと
  assert.equal(found.name, "山田");
  assert.equal(found.status, "none");
});

await test("forward compat: unknown settings fields are preserved", async () => {
  const bundle = {
    format: BUNDLE_FORMAT,
    schema: 1,
    sections: {
      meta: { title: "回診" },
      settings: {
        futureFeature: { enabled: true },  // 未知フィールド
        anotherFutureKey: [1, 2, 3],
      },
      patients: [],
    },
  };
  const store = await freshStore({ bundle });
  assert.deepEqual(store.settings.futureFeature, { enabled: true });
  assert.deepEqual(store.settings.anotherFutureKey, [1, 2, 3]);
});

await test("status NONE + transferredAt set is NOT empty (移動済マーカー)", async () => {
  const store = await freshStore();
  const p = store.makeDefaultPatient();
  p.transferredAt = Date.now();
  p.transferredTo = "3階病棟";
  assert.equal(store.isPatientEmpty(p), false);
});

await test("status GRAY (終了マーク) with empty fields is NOT empty", async () => {
  const store = await freshStore();
  const p = store.makeDefaultPatient();
  p.status = "gray";
  assert.equal(store.isPatientEmpty(p), false);
});

await test("status YELLOW with empty fields is NOT empty", async () => {
  const store = await freshStore();
  const p = store.makeDefaultPatient();
  p.status = "yellow";
  assert.equal(store.isPatientEmpty(p), false);
});

await test("status GREEN with empty fields is NOT empty", async () => {
  const store = await freshStore();
  const p = store.makeDefaultPatient();
  p.status = "green";
  assert.equal(store.isPatientEmpty(p), false);
});

await test("status BLUE with empty fields is NOT empty", async () => {
  const store = await freshStore();
  const p = store.makeDefaultPatient();
  p.status = "blue";
  assert.equal(store.isPatientEmpty(p), false);
});

// ============================
// 7) フォーマット (formats[]) 設計サニティ
// ============================
section("formats");

await test("default formats include バイタル (number/fraction items) and 身体所見 (all text items)", async () => {
  const store = await freshStore();
  const fmts = store.settings.formats;
  assert.ok(Array.isArray(fmts) && fmts.length >= 2, "at least 2 default formats");
  const vital = fmts.find(f => f.name === "バイタル");
  const phys = fmts.find(f => f.name === "身体所見");
  assert.ok(vital, "バイタル exists");
  assert.equal(vital.panel, "O");
  // (v8: フォーマットの pinned/isDefault は撤去。展開/規定文はグループ側で管理)
  // バイタル は kind=number / fraction (BP) で構成され、text はゼロのはず
  assert.ok(vital.items.length >= 5, "vital has >=5 items");
  assert.ok(vital.items.some(it => it.kind === "fraction"), "vital has a fraction item (BP)");
  assert.ok(vital.items.every(it => it.kind === "number" || it.kind === "fraction"), "vital items are numeric kinds");
  assert.equal(vital.labelSep, " ");
  assert.ok(Array.isArray(vital.tags) && vital.tags.length === 0);

  assert.ok(phys, "身体所見 exists");
  assert.equal(phys.panel, "O");
  assert.ok(phys.items.every(it => it.kind === "text"), "phys items are all text");
  assert.equal(phys.labelSep, "：");
});

// ============================
// 8) storage.loadBundle のクリーンステート挙動
// ============================
section("storage cold start");

await test("storage.loadBundle returns null on clean state", async () => {
  const storageUrl = pathToFileURL(join(srcDir, "storage.js")).href;
  const storage = await import(storageUrl + `?t=${Math.random()}`);
  localStorage.clear();
  const loaded = await storage.loadBundle();
  assert.equal(loaded, null);
});

// ============================
// 9) storage workspace API: createWorkspaceRecord / getActiveWorkspaceId
// ============================
section("storage workspace API");

await test("getActiveWorkspaceId returns 'default' when unset", async () => {
  const storageUrl = pathToFileURL(join(srcDir, "storage.js")).href;
  localStorage.clear();
  const storage = await import(storageUrl + `?t=${Math.random()}`);
  assert.equal(storage.getActiveWorkspaceId(), "default");
});

await test("setActiveWorkspaceId persists via localStorage", async () => {
  const storageUrl = pathToFileURL(join(srcDir, "storage.js")).href;
  localStorage.clear();
  const storage = await import(storageUrl + `?t=${Math.random()}`);
  storage.setActiveWorkspaceId("ws_test123");
  assert.equal(storage.getActiveWorkspaceId(), "ws_test123");
});

await test("newWorkspaceId is unique and prefixed 'ws_'", async () => {
  const storageUrl = pathToFileURL(join(srcDir, "storage.js")).href;
  const storage = await import(storageUrl + `?t=${Math.random()}`);
  const a = storage.newWorkspaceId();
  const b = storage.newWorkspaceId();
  assert.ok(a.startsWith("ws_"));
  assert.ok(b.startsWith("ws_"));
  assert.notEqual(a, b);
});

// ============================
// 11) i18n: t() ヘルパが strings.ja.json を引けること
// ============================
section("i18n");

await test("t() resolves known key", async () => {
  const { t } = await import("../src/i18n.js");
  assert.equal(t("common.save"), "保存");
  assert.equal(t("common.cancel"), "キャンセル");
});

await test("t() interpolates {placeholder} params", async () => {
  const { t } = await import("../src/i18n.js");
  const s = t("format.delete.confirm", { name: "バイタル" });
  assert.ok(s.includes("バイタル"), "name placeholder filled");
});

await test("t() returns key on missing entry", async () => {
  const { t } = await import("../src/i18n.js");
  const out = t("totally.unknown.key.xyz");
  assert.equal(out, "totally.unknown.key.xyz");
});

// ============================
// 10) defaults.json: 既定値が JSON 由来で読み込めること
// ============================
section("defaults.json");

await test("DEFAULT_FORMATS comes from defaults.json", async () => {
  const c = await import("../src/constants.js");
  assert.ok(Array.isArray(c.DEFAULT_FORMATS));
  assert.equal(c.DEFAULT_FORMATS.length, 2);
  assert.equal(c.DEFAULT_FORMATS[0].name, "バイタル");
  assert.equal(c.DEFAULT_PATIENT_COUNT, 50);
});

// ============================
// 11) QR セキュリティ: 暗号化 round-trip + redistribution フィルタ
// ============================
section("QR security (encryption + redistribution)");

await test("encryptPayload + decryptPayload round-trip", async () => {
  // Node 18+ には globalThis.crypto.subtle がある (Web Crypto API)
  // Node 17+ には CompressionStream がある (deflate-raw 含む)
  const m = await import("../src/features/crypto-payload.js");
  const plain = "RND_HM #abc 1/1\n{\"v\":3,\"p\":[{\"r\":\"203\",\"n\":\"テスト太郎\"}]}";
  const enc = await m.encryptPayload(plain);
  assert.ok(m.isEncrypted(enc), "encrypted payload has E1 or E2 prefix");
  assert.notEqual(enc, plain, "ciphertext differs from plaintext");
  const dec = await m.decryptPayload(enc);
  assert.equal(dec, plain, "round-trip recovers exact plaintext");
});

await test("encryptPayload generates E2 (deflate) when CompressionStream is available", async () => {
  // Node 17+ で CompressionStream が使えるので、デフォルトでは E2 が生成される。
  // E1 fallback は CompressionStream 未対応端末でのみ起きる挙動
  const m = await import("../src/features/crypto-payload.js");
  // 圧縮で確実に縮む繰り返しデータ
  const plain = "abcdef".repeat(50);
  const enc = await m.encryptPayload(plain);
  assert.ok(enc.startsWith("E2:"), "should be E2 when CompressionStream is available");
  // 圧縮後は明らかに短くなっている (元データ 300B → 暗号化後でも 100 chars 未満が期待)
  assert.ok(enc.length < plain.length, `compressed+encrypted (${enc.length}) shorter than plain (${plain.length})`);
});

await test("decryptPayload can read legacy E1 (no deflate) format", async () => {
  // v7.1.x で生成された E1 形式 (AES-GCM のみ、deflate なし) が読めることを確認
  // E1 を直接生成 (内部関数を呼べないので、deflate を bypass した固定値で検証)
  const m = await import("../src/features/crypto-payload.js");
  const plain = "this is a v7.1.x style plaintext";

  // E1 を artificially 作る: APP_KEY と同じ鍵で AES-GCM 暗号化
  const APP_KEY_BYTES = new Uint8Array([
    0x47, 0xa5, 0x1c, 0x9b, 0x38, 0x6d, 0x2e, 0x71,
    0xf4, 0x83, 0x05, 0xcc, 0x9a, 0x4d, 0x62, 0x18,
    0xb7, 0x29, 0x5a, 0xe0, 0x3c, 0x91, 0x8f, 0x46,
    0xd2, 0x57, 0x6a, 0x0b, 0xfd, 0xe5, 0x18, 0x73,
  ]);
  const key = await crypto.subtle.importKey("raw", APP_KEY_BYTES, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  let s = "";
  for (let i = 0; i < combined.length; i++) s += String.fromCharCode(combined[i]);
  const b64url = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const e1 = "E1:" + b64url;

  assert.ok(m.isEncrypted(e1), "E1 is recognized as encrypted");
  const dec = await m.decryptPayload(e1);
  assert.equal(dec, plain, "v7.2.0 decryptPayload reads v7.1.x E1 format");
});

await test("decryptPayload passes plain text through", async () => {
  const m = await import("../src/features/crypto-payload.js");
  const result = await m.decryptPayload("not encrypted");
  assert.equal(result, "not encrypted");
});

await test("defaultSettings has qrEncryption + qrRedistribution with expected defaults", async () => {
  const store = await freshStore();
  assert.equal(store.settings.qrEncryption.HM, true, "HM encrypted by default");
  assert.equal(store.settings.qrEncryption.ST, true, "ST encrypted by default");
  assert.equal(store.settings.qrRedistribution.HM, "restricted", "HM restricted by default");
  assert.equal(store.settings.qrRedistribution.SH, "free", "SH free by default");
  assert.equal(store.settings.qrRedistribution.ST, "free");
  assert.equal(store.settings.qrRedistribution.FMT, "free");
});

await test("encodePatientList excludes external patients when redistribution=restricted", async () => {
  const store = await freshStore();
  // 2 人配置: 1 人 origin="external" + 1 人 origin=""
  store.appState.patients[0].name = "外部受信さん";
  store.appState.patients[0].room = "101";
  store.appState.patients[0].origin = "external";
  store.appState.patients[1].name = "ローカルさん";
  store.appState.patients[1].room = "102";
  store.appState.patients[1].origin = "";

  const m = await import("../src/features/qr-patient-list.js");
  // HM = restricted by default → external 患者は除外
  const restrictedJson = m.encodePatientList({ fieldName: null, includeEmpty: true, kind: "HM" });
  const restrictedParsed = JSON.parse(restrictedJson);
  // patientArr[0] は external だったので空 slot、[1] はローカルなので残る
  const hasLocal = restrictedParsed.p.some(o => o.n === "ローカルさん");
  const hasExternal = restrictedParsed.p.some(o => o.n === "外部受信さん");
  assert.ok(hasLocal, "local patient kept in restricted HM");
  assert.ok(!hasExternal, "external patient excluded in restricted HM");

  // restriction OFF にすれば両方含まれる
  store.settings.qrRedistribution.HM = "free";
  const freeJson = m.encodePatientList({ fieldName: null, includeEmpty: true, kind: "HM" });
  const freeParsed = JSON.parse(freeJson);
  assert.ok(freeParsed.p.some(o => o.n === "外部受信さん"), "external also included when free");
});

// ============================
// 12) QR Wire Format Authority (qr-protocol.js)
// ============================
section("QR wire format (qr-protocol.js)");

await test("PANEL/KIND/MODE enum tables are stable (bump WIRE_V if you add to these)", async () => {
  const p = await import("../src/features/qr-protocol.js");
  // 順序を変えると旧 wire の index が破壊される。本テストは「うっかり順序を
  // 変えないための歩哨」。enum を増やす時は WIRE_V を bump する必要がある。
  assert.deepEqual([...p.PANEL_BY_INDEX], ["S", "O", "A", "P"]);
  // v8: "date" kind は撤去 (fraction に統合)。MODE_BY_INDEX (タグ・カテゴリ用) も撤去 (v7.7)
  assert.deepEqual([...p.KIND_BY_INDEX], ["text", "number", "fraction"]);
});

await test("formatToWire / formatFromWire round-trip with tag dict", async () => {
  const p = await import("../src/features/qr-protocol.js");
  const fmt = {
    name: "バイタル",
    panel: "O",
    joiner: ", ",
    labelSep: " ",
    tags: ["内科", "救急"],
    pinned: true,
    isDefault: false,
    items: [
      { label: "BP", kind: "fraction", unit: "mmHg" },
      { label: "P", kind: "number", unit: "bpm" },
      { label: "発熱", kind: "text", normal: "なし" },
    ],
  };
  const dict = ["内科", "外科", "救急"];
  const wire = p.formatToWire(fmt, dict);

  // 短キーと enum 数値化の確認
  assert.equal(wire.n, "バイタル");
  assert.equal(wire.p, 1, "panel O = index 1");
  assert.deepEqual(wire.t, [1, 3], "tags use 1-based dict indices");
  // v8: pn(pinned) / d(isDefault) は wire から撤去 (グループ側で管理)
  assert.equal(wire.pn, undefined, "pinned is no longer emitted");
  assert.equal(wire.d, undefined, "isDefault is no longer emitted");
  assert.equal(wire.i[0].k, 2, "kind fraction = index 2");
  assert.equal(wire.i[1].k, 1, "kind number = index 1");
  assert.equal(wire.i[2].k, 0, "kind text = index 0");

  // round-trip
  const restored = p.formatFromWire(wire, dict);
  assert.equal(restored.name, fmt.name);
  assert.equal(restored.panel, "O");
  assert.deepEqual(restored.tags, fmt.tags);
  // v8: pinned / isDefault は撤去済みなので復元されない
  assert.equal(restored.items.length, 3);
  assert.equal(restored.items[0].kind, "fraction");
  assert.equal(restored.items[1].kind, "number");
  assert.equal(restored.items[2].kind, "text");
});

await test("formatToWire with null dict embeds tag strings (for FMT QR)", async () => {
  const p = await import("../src/features/qr-protocol.js");
  const fmt = { name: "X", panel: "S", tags: ["内科", "外科"], items: [] };
  const wire = p.formatToWire(fmt, null);
  assert.deepEqual(wire.t, ["内科", "外科"], "with null dict, tags are inline strings");
  const restored = p.formatFromWire(wire, null);
  assert.deepEqual(restored.tags, ["内科", "外科"]);
});

await test("patientToWire / patientFromWire round-trip", async () => {
  const p = await import("../src/features/qr-protocol.js");
  const dict = ["内科", "外科"];
  const wire = p.patientToWire(
    { room: "201", name: "テスト", tags: ["外科"], memo: "メモ本体" },
    dict,
    "memo",
  );
  assert.equal(wire.r, "201");
  assert.equal(wire.n, "テスト");
  assert.deepEqual(wire.t, [2], "外科 = index 2");
  assert.equal(wire.c, "メモ本体");

  const restored = p.patientFromWire(wire, dict);
  assert.equal(restored.room, "201");
  assert.equal(restored.name, "テスト");
  assert.deepEqual(restored.tags, ["外科"]);
  assert.equal(restored.content, "メモ本体");
});

await test("patientToWire returns empty {} when all fields blank", async () => {
  const p = await import("../src/features/qr-protocol.js");
  const wire = p.patientToWire({ room: "", name: "", tags: [], memo: "" }, [], "memo");
  assert.deepEqual(wire, {});
});

// v7.7+: tagGroup wire 変換テストは撤去 (タグ・カテゴリ機能撤去のため)

await test("qr-settings encode/decode round-trip with formats", async () => {
  const store = await freshStore();
  store.settings.tags = ["内科", "外科", "救急"];

  // qr-settings.js は flow に encodePayload/decodePayload を渡しているだけで
  // export していない。 同じ振る舞いを再現するため、qr-protocol の helper を
  // 直接呼んでテスト。
  const proto = await import("../src/features/qr-protocol.js");
  const tagDict = store.settings.tags.slice();
  const wireFormats = store.settings.formats.map(f => proto.formatToWire(f, tagDict));

  // 復号
  const restoredFormats = wireFormats.map(w => proto.formatFromWire(w, tagDict));

  // panel/kind enum が文字列に戻っている
  assert.equal(restoredFormats[0].panel, store.settings.formats[0].panel);
  assert.equal(restoredFormats[0].items[0].kind, store.settings.formats[0].items[0].kind);
  // tags も dict 経由で正しく復元
  assert.deepEqual(restoredFormats[0].tags, store.settings.formats[0].tags);
});

await test("qr-patient-list v3 round-trip via encodePatientList + decodePatientList", async () => {
  const store = await freshStore();
  store.appState.patients[0].name = "山田";
  store.appState.patients[0].room = "301";
  store.appState.patients[0].tags = ["内科"];
  store.appState.patients[0].memo = "経過良好";
  store.settings.qrRedistribution.MM = "free";

  const m = await import("../src/features/qr-patient-list.js");
  const json = m.encodePatientList({ fieldName: "memo", includeEmpty: false, kind: "MM" });
  const parsed = JSON.parse(json);
  assert.equal(parsed.v, 3, "WIRE_V is 3");
  assert.ok(Array.isArray(parsed.td), "tag dict is present");
  assert.ok(parsed.p.length > 0, "patient array non-empty");

  const decoded = m.decodePatientList(json);
  assert.deepEqual(decoded.tagNames, parsed.td);
  const found = decoded.patients.find(x => x.name === "山田");
  assert.ok(found, "patient round-trips");
  assert.equal(found.room, "301");
  assert.equal(found.content, "経過良好");
});

// ============================
// 受信ボックス (recvMemo / recvShared) の永続化 — bundle meta 経由
// v8.10.0 で追加。IDB 非依存の経路だけを検査する (storage は no-op)。
// ============================
section("recv box persistence (bundle meta)");

await test("projectBundle carries recvMemo / recvShared in meta; parseBundle preserves", () => {
  const appState = { title: "x", patients: [], recvMemo: "受信A", recvShared: "受信B" };
  const projected = projectBundle({ appState, settings: { deviceId: "", tags: [] }, sections: [SECTION.META, SECTION.PATIENTS] });
  const meta = getSection(parseBundle(projected), SECTION.META) || {};
  assert.equal(meta.recvMemo, "受信A");
  assert.equal(meta.recvShared, "受信B");
});

await test("projectBundle defaults recv fields to empty string when absent", () => {
  const projected = projectBundle({ appState: { title: "x", patients: [] }, settings: { deviceId: "", tags: [] }, sections: [SECTION.META] });
  const meta = getSection(parseBundle(projected), SECTION.META) || {};
  assert.equal(meta.recvMemo, "");
  assert.equal(meta.recvShared, "");
});

await test("normalizeLoaded reads recv fields from raw, defaults to empty", async () => {
  const store = await freshStore();
  const withVals = store.normalizeLoaded({ title: "t", patients: [], recvMemo: "M", recvShared: "S" });
  assert.equal(withVals.recvMemo, "M");
  assert.equal(withVals.recvShared, "S");
  const without = store.normalizeLoaded({ patients: [] });
  assert.equal(without.recvMemo, "");
  assert.equal(without.recvShared, "");
});

await test("warm boot: recvMemo in seed bundle meta hydrates appState", async () => {
  const bundle = projectBundle({ appState: { title: "t", patients: [], recvMemo: "持ち越し", recvShared: "" }, settings: { deviceId: "", tags: [] } });
  const store = await freshStore({ bundle });
  assert.equal(store.appState.recvMemo, "持ち越し");
  assert.equal(store.appState.recvShared, "");
});

await test("setRecvContent updates appState; ignores unknown key", async () => {
  const store = await freshStore();
  store.setRecvContent("recvMemo", "hello");
  assert.equal(store.appState.recvMemo, "hello");
  store.setRecvContent("bogus", "x");
  assert.equal(store.appState.bogus, undefined);
});

// ============================
// サンプルデータ (手動テスト用の網羅的アーカイブ) の妥当性
// ============================
section("sample data");

await test("comprehensive.device-archive.json は妥当な端末アーカイブで、患者が正しく正規化される", async () => {
  const store = await freshStore();
  const raw = JSON.parse(readFileSync(join(__dirname, "sample-data", "comprehensive.device-archive.json"), "utf8"));
  assert.ok(store.isDeviceArchive(raw), "device archive として認識される");
  assert.equal(raw.users.length, 2, "2 ユーザー");

  const w = raw.users[0].workspaces[0];
  const norm = store.normalizeLoaded({ title: w.title, patients: w.patients });
  const statuses = new Set(norm.patients.map((p) => p.status));
  for (const s of ["none", "yellow", "green", "gray", "blue"]) {
    assert.ok(statuses.has(s), `全ステータスを網羅: ${s} がある`);
  }
  assert.ok(norm.patients.some((p) => p.transferredAt > 0), "移動済マーカーの患者がいる");
  assert.ok(norm.patients.some((p) => p.origin === "external"), "外部受信(external)の患者がいる");
  assert.ok(norm.patients.some((p) => p.memo && p.s && p.a.text && p.shared), "SOAP+プロブレムリスト+共有が揃った患者がいる");
});

// ============================
// 保存失敗の可視化 (saveNow → showToast)
// ============================
// saveNow() は失敗を console.error で握り潰していたが、容量超過などで本当に
// 書けなかった時にユーザーへトーストで知らせるようにした。データ層 (store.js)
// から呼ぶため、(1) 文言キーが存在し t() で引けること、(2) DOM 不在環境でも
// showToast が例外を投げないこと、を回帰として固定する。
section("save failure visibility");

await test("save.failed の i18n キーが存在し t() で引ける (ハードコード防止)", async () => {
  const { t } = await import("../src/i18n.js");
  const msg = t("save.failed");
  assert.ok(typeof msg === "string" && msg.length > 0, "save.failed が文言を返す");
  assert.notEqual(msg, "save.failed", "キー名そのままでなく訳文が返る");
});

await test("showToast は DOM 不在環境 (テスト/データ層) でも例外を投げない", async () => {
  assert.equal(typeof document, "undefined", "この環境に document は無い");
  const { showToast } = await import("../src/toast.js");
  // store.js の saveNow catch から呼ばれる経路。落ちないことが保証されれば
  // 保存失敗通知でアプリ全体がクラッシュしない。
  assert.doesNotThrow(() => showToast("保存に失敗しました", { ms: 4000 }));
});

// ============================
// snapshots purge & TTL (fake-indexeddb)
// ============================
// 既存テストは indexedDB 不在 (db=null 経路) のまま走らせ、ここから先だけ
// fake-indexeddb を有効化する。グローバルに先付けすると ensureUsersInitialized が
// 走って cold/warm boot の title 等の既存アサーションが変わってしまうため。
section("snapshots purge & TTL (fake-indexeddb)");

const { IDBFactory: FakeIDBFactory, IDBKeyRange: FakeIDBKeyRange } = await import("fake-indexeddb");
globalThis.indexedDB = new FakeIDBFactory();
globalThis.IDBKeyRange = FakeIDBKeyRange;

const storageMod = await import(pathToFileURL(join(srcDir, "storage.js")).href);
const snapshotsMod = await import(pathToFileURL(join(srcDir, "features", "snapshots.js")).href);
const storeForIdb = await import(storeUrl);
// 既存テストで memoize された db=null promise を破棄し、fake IDB を開かせる。
storageMod._resetDbForTests();
snapshotsMod._resetSnapshotsDbForTests();

const DAY_MS = 24 * 60 * 60 * 1000;

// 任意の t を持つスナップショットを DB へ直接投入する (TTL 失効の再現用)。
function rawAddSnapshot(rec) {
  return new Promise((res, rej) => {
    const open = indexedDB.open("hospital-rounds-snapshots", 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("snapshots")) {
        const st = db.createObjectStore("snapshots", { keyPath: "id", autoIncrement: true });
        st.createIndex("wsId", "wsId", { unique: false });
        st.createIndex("t", "t", { unique: false });
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("snapshots", "readwrite");
      const r = tx.objectStore("snapshots").add(rec);
      tx.oncomplete = () => res(r.result);
      tx.onerror = () => rej(tx.error);
    };
    open.onerror = () => rej(open.error);
  });
}

await test("deleteUser がそのユーザーの病棟スナップショットを purge できる (PII 残留防止)", async () => {
  const uid = await storageMod.createUser("PurgeUser");
  const wsId = storageMod.newWorkspaceId();
  storageMod.setCurrentUserId(uid);
  storageMod.setActiveWorkspaceId(wsId);
  // 本体 DB に病棟レコードを作る (deleteUser が userId で拾えるように)
  await storageMod.saveBundle(
    { format: "hospital-rounds-bundle", sections: { meta: { title: "" }, patients: [] } },
    wsId, "Ward A", uid,
  );
  // この病棟のスナップショットを 1 枚撮る (患者 PII を含む)
  storeForIdb.setAppState({ v: 3, title: "", patients: [{ ...storeForIdb.makeDefaultPatient(), name: "PII太郎", status: "yellow" }] });
  await snapshotsMod.captureSnapshot(snapshotsMod.REASON.CLEAR);
  let rp = await snapshotsMod.listRestorePoints(wsId);
  assert.equal(rp.length, 1, "撮影直後はスナップショットが 1 枚ある");

  // ユーザー削除 → 返ってきた wsId で purge (settings-view と同じ流れ)
  const res = await storageMod.deleteUser(uid);
  assert.ok(Array.isArray(res.workspaceIds) && res.workspaceIds.includes(wsId), "deleteUser が削除した病棟 ID を返す");
  const purged = await snapshotsMod.purgeSnapshotsForWorkspaces(res.workspaceIds);
  assert.ok(purged >= 1, "purge が 1 件以上削除する");
  rp = await snapshotsMod.listRestorePoints(wsId);
  assert.equal(rp.length, 0, "purge 後はスナップショットが残らない");
});

await test("失効 (TTL 超過) スナップショットは候補に出ず・復元もされない (読み出し時 TTL 防御)", async () => {
  const wsId = storageMod.newWorkspaceId();
  storageMod.setActiveWorkspaceId(wsId);
  // 間引き (pruneWs/initSnapshots) を介さず DB へ直接投入する。captureSnapshot 経由だと
  // 撮影時の prune が失効分を先に消してしまい「読み出し時防御」単体を検証できないため。
  const oldId = await rawAddSnapshot({ wsId, t: Date.now() - 15 * DAY_MS, reason: "clear", title: "", patients: [{ name: "古いPII" }], sig: 0 });
  const freshId = await rawAddSnapshot({ wsId, t: Date.now(), reason: "clear", title: "", patients: [{ name: "新" }], sig: 1 });

  const rps = await snapshotsMod.listRestorePoints(wsId);
  assert.ok(rps.every(r => r.id !== oldId), "失効スナップショットは一覧に出ない");
  assert.ok(rps.some(r => r.id === freshId), "新鮮なスナップショットは一覧に出る");

  const restore = await snapshotsMod.restoreSnapshot(oldId);
  assert.equal(restore.ok, false, "失効スナップショットは復元されない");
  assert.equal(restore.reason, "expired", "復元拒否の理由は expired");
});

await test("purgeSnapshotsForWorkspaces は空配列・未知 ID で安全に 0 を返す", async () => {
  assert.equal(await snapshotsMod.purgeSnapshotsForWorkspaces([]), 0);
  assert.equal(await snapshotsMod.purgeSnapshotsForWorkspaces(["ws_does_not_exist"]), 0);
  assert.equal(await snapshotsMod.purgeSnapshotsForWorkspaces(null), 0);
});

// ============================
// patient move (fake-indexeddb)
// ============================
section("patient move (fake-indexeddb)");

const moveMod = await import(pathToFileURL(join(srcDir, "features", "move-patient.js")).href);

// 有効な (parseBundle が通る) 空病棟を作って id を返すヘルパ。
async function makeEmptyWorkspace(label) {
  const id = storageMod.newWorkspaceId();
  const bundle = projectBundle({ appState: { v: 3, title: "", patients: [] }, settings: storeForIdb.settings, sections: [SECTION.META, SECTION.PATIENTS] });
  await storageMod.saveBundle(bundle, id, label);
  return id;
}

await test("movePatient: 元はGRAY+transferredマーカー / 移動先は新pid+BLUEコピー", async () => {
  const srcWs = storageMod.newWorkspaceId();
  storageMod.setActiveWorkspaceId(srcWs);
  const destId = await makeEmptyWorkspace("Dest Ward");
  storeForIdb.setAppState({ v: 3, title: "Doc", patients: [
    { ...storeForIdb.makeDefaultPatient(), name: "移動太郎", room: "301", status: "yellow", s: "主訴あり" },
    { ...storeForIdb.makeDefaultPatient(), name: "残留花子", room: "302" },
  ] });
  const srcPidBefore = storeForIdb.appState.patients[0].pid;

  const moved = await moveMod.movePatients([0], destId, "Dest Ward");
  assert.equal(moved, 1, "1 件移動");

  // 元: マーカー + GRAY、name/room は無傷
  const src0 = storeForIdb.appState.patients[0];
  assert.ok(src0.transferredAt > 0, "元患者に transferredAt が立つ");
  assert.equal(src0.transferredTo, "Dest Ward", "移動先 label を記録");
  assert.equal(src0.status, "gray", "元患者は GRAY");
  assert.equal(src0.name, "移動太郎", "元の name は無傷");
  // 隣の患者は無関係
  assert.equal(storeForIdb.appState.patients[1].transferredAt, 0, "別患者は触らない");

  // 移動先: 新 pid + BLUE + マーカー無し + 内容コピー
  const destB = await storageMod.loadBundle(destId);
  const destPatients = getSection(destB, SECTION.PATIENTS);
  const copy = destPatients.find(p => p.name === "移動太郎");
  assert.ok(copy, "移動先に患者がコピーされる");
  assert.equal(copy.status, "blue", "移動先コピーは BLUE");
  assert.equal(copy.transferredAt, 0, "移動先コピーにマーカーは無い");
  assert.notEqual(copy.pid, srcPidBefore, "移動先コピーは新 pid");
  assert.equal(copy.s, "主訴あり", "臨床内容がコピーされる");
});

await test("movePatients: 移動済み患者は再移動されない (増殖防止)", async () => {
  const srcWs = storageMod.newWorkspaceId();
  storageMod.setActiveWorkspaceId(srcWs);
  const destId = await makeEmptyWorkspace("Dest2");
  storeForIdb.setAppState({ v: 3, title: "Doc", patients: [
    { ...storeForIdb.makeDefaultPatient(), name: "一度だけ", status: "yellow" },
  ] });
  assert.equal(await moveMod.movePatients([0], destId, "Dest2"), 1, "初回は移動できる");
  // 2 回目: 既に transferred なのでスキップ → 0 件
  assert.equal(await moveMod.movePatients([0], destId, "Dest2"), 0, "移動済みは再移動されない");
  const destPatients = getSection(await storageMod.loadBundle(destId), SECTION.PATIENTS);
  assert.equal(destPatients.filter(p => p.name === "一度だけ").length, 1, "移動先で増殖しない");
});

await test("movePatients: 同一ワークスペースへの移動は拒否", async () => {
  const srcWs = storageMod.newWorkspaceId();
  storageMod.setActiveWorkspaceId(srcWs);
  storeForIdb.setAppState({ v: 3, title: "", patients: [{ ...storeForIdb.makeDefaultPatient(), name: "x", status: "yellow" }] });
  await assert.rejects(() => moveMod.movePatients([0], srcWs, "self"), /same workspace/);
});

await test("moveToNewWorkspace: コピーだけの新規病棟を作り元を移動済みにする", async () => {
  const srcWs = storageMod.newWorkspaceId();
  storageMod.setActiveWorkspaceId(srcWs);
  storageMod.setCurrentUserId("usr_move_test");
  storeForIdb.setAppState({ v: 3, title: "", patients: [{ ...storeForIdb.makeDefaultPatient(), name: "新棟太郎", status: "yellow" }] });
  const n = await moveMod.moveToNewWorkspace([0], "新病棟");
  assert.equal(n, 1);
  assert.ok(storeForIdb.appState.patients[0].transferredAt > 0, "元患者は移動済み");
  // 作成された新病棟を探す
  const all = await storageMod.listAllWorkspaces();
  const created = all.find(w => w.label === "新病棟");
  assert.ok(created, "新病棟が作成される");
  const pts = getSection(await storageMod.loadBundle(created.id), SECTION.PATIENTS);
  assert.equal(pts.length, 1, "新病棟にはコピーのみ (空 50 患者は作らない)");
  assert.equal(pts[0].name, "新棟太郎");
  assert.equal(pts[0].status, "blue");
});

await test("isPatientTransferred / decorateTransferredName (純粋関数)", async () => {
  assert.equal(moveMod.isPatientTransferred({ transferredAt: 0 }), false);
  assert.equal(moveMod.isPatientTransferred({ transferredAt: 123 }), true);
  assert.equal(moveMod.decorateTransferredName("田中", { transferredAt: 0 }), "田中", "未移動は素通し");
  const decorated = moveMod.decorateTransferredName("田中", { transferredAt: 123 });
  assert.ok(decorated.includes("田中") && decorated.length > "田中".length, "移動済みは prefix が付く");
});

// ============================
// snapshot restore (fake-indexeddb)
// ============================
section("snapshot restore (fake-indexeddb)");

await test("restoreSnapshot: 患者を撮影時点へ戻し、取り消し用スナップショットも残す", async () => {
  const wsR = storageMod.newWorkspaceId();
  storageMod.setActiveWorkspaceId(wsR);
  // 状態 A を撮る
  storeForIdb.setAppState({ v: 3, title: "Doc", patients: [{ ...storeForIdb.makeDefaultPatient(), name: "復元太郎", status: "yellow" }] });
  await snapshotsMod.captureSnapshot(snapshotsMod.REASON.CLEAR);
  const points = await snapshotsMod.listRestorePoints(wsR);
  assert.ok(points.length >= 1, "復元候補がある");
  const snapId = points[0].id;

  // 状態 B に変更 (クリア相当)
  storeForIdb.setAppState({ v: 3, title: "Doc", patients: [{ ...storeForIdb.makeDefaultPatient(), name: "", status: "none" }] });
  assert.equal(storeForIdb.appState.patients[0].name, "", "変更後は空");

  // 復元
  const res = await snapshotsMod.restoreSnapshot(snapId);
  assert.equal(res.ok, true, "復元成功");
  assert.equal(storeForIdb.appState.patients[0].name, "復元太郎", "撮影時点の患者へ戻る");
  assert.equal(storeForIdb.appState.patients[0].status, "yellow", "ステータスも戻る");

  // 復元の取り消し用スナップショット (restore_undo) が残る = 復元自体も巻き戻せる
  const after = await snapshotsMod.listRestorePoints(wsR);
  assert.ok(after.some(p => p.reason === "restore_undo"), "restore_undo スナップショットが作られる");
});

await test("restoreSnapshot: 存在しない id は notfound", async () => {
  storageMod.setActiveWorkspaceId(storageMod.newWorkspaceId());
  const res = await snapshotsMod.restoreSnapshot(99999999);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "notfound");
});

// ============================
// Summary
// ============================
console.log("");
if (failed > 0) {
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} passed`);
