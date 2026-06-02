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
  assert.equal(vital.pinned, true);
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
  assert.deepEqual([...p.KIND_BY_INDEX], ["text", "number", "fraction", "date"]);
  // v7.7+: MODE_BY_INDEX (タグ・カテゴリ用) は撤去
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
  assert.equal(wire.pn, 1);
  assert.equal(wire.d, undefined, "isDefault=false is omitted");
  assert.equal(wire.i[0].k, 2, "kind fraction = index 2");
  assert.equal(wire.i[1].k, 1, "kind number = index 1");
  assert.equal(wire.i[2].k, 0, "kind text = index 0");

  // round-trip
  const restored = p.formatFromWire(wire, dict);
  assert.equal(restored.name, fmt.name);
  assert.equal(restored.panel, "O");
  assert.deepEqual(restored.tags, fmt.tags);
  assert.equal(restored.pinned, true);
  assert.equal(restored.isDefault, false);
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
// Summary
// ============================
console.log("");
if (failed > 0) {
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} passed`);
