"use strict";

// ============================================================================
// 起動ゲート (boot-gate)
//
// initStore() のあと、アプリを触れるようにする前に挟む「関門」:
//   1) 初回起動 (onboardedAt 未設定) → オンボーディング (名前 + 同意) を出す。
//      完了で現ユーザー (backfill 済みの既定ユーザー) を入力名にリネーム。
//      → このとき月次の免責は出さない (同意はオンボーディングに含む)。
//   2) ユーザーが 2 人以上 かつ 最後の確認から一定期間 (既定 1 日) 経過
//      → ユーザー選択画面を出す (別ユーザーに誤って書くのを防ぐ)。
//      ※ 1 人だけの端末では出さない (選ぶ意味がないため)。
//
// 戻り値: { onboarded } — onboarded=true なら caller は免責 (maybeShowDisclaimer) を出さない。
//
// 選択頻度のインターバルは storage 側に「将来 UI から変えられる器」だけ用意済み
// (getUserReselectIntervalMs / setUserReselectIntervalMs)。現状は設定 UI なし・既定 1 日。
// ============================================================================

import {
  listUsers, getCurrentUserId,
  getOnboardedAt, setOnboardedAt, setLastUserConfirmAt, isUserReselectDue,
} from "../storage.js";
import { renameCurrentUser, switchUser, createUserAndSwitch, getCurrentUserName } from "../store.js";
import { refreshAppUserName, refreshAppWsLabel } from "./app-title.js";
import { markDisclaimerShown } from "./splash-disclaimer.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { openPopup, focusPopupInput } from "./popup-behavior.js";

function vibrate() { try { navigator.vibrate?.(60); } catch (_) {} }

export async function runBootGate() {
  if (!getOnboardedAt()) {
    await showOnboarding();
    return { onboarded: true };
  }
  let users = [];
  try { users = await listUsers(); } catch (_) { /* ignore */ }
  if (users.length >= 2 && isUserReselectDue()) {
    await showUserSelection(users);
  }
  return { onboarded: false };
}

// --- 初回オンボーディング ---
function showOnboarding() {
  const overlay = document.getElementById("onboardingOverlay");
  const body = document.getElementById("onboardingBody");
  const input = document.getElementById("onboardingNameInput");
  const err = document.getElementById("onboardingNameError");
  const startBtn = document.getElementById("onboardingStartBtn");
  if (!overlay || !startBtn) return Promise.resolve();

  if (body) body.textContent = t("onboarding.body");
  if (err) { err.style.display = "none"; }
  if (input) input.value = "";

  return new Promise((resolve) => {
    async function finish() {
      const name = String(input?.value || "").trim();
      if (!name) {
        if (err) { err.textContent = t("onboarding.name.required"); err.style.display = ""; }
        focusPopupInput(input); // 入力エラー → 訂正できるよう入力欄へ戻す (中央ヘルパ経由)
        return;
      }
      const res = await renameCurrentUser(name);
      if (!res.ok) {
        if (err) { err.textContent = t("onboarding.name.required"); err.style.display = ""; }
        return;
      }
      refreshAppUserName();
      refreshAppWsLabel();
      setOnboardedAt(Date.now());
      setLastUserConfirmAt(Date.now());
      markDisclaimerShown(); // 直後に月次免責が出ないように (同意はここで取得済み)
      vibrate();
      cleanup();
      overlay.classList.remove("active");
      resolve();
    }
    function onKey(e) { if (e.key === "Enter") { e.preventDefault(); finish(); } }
    function cleanup() {
      startBtn.removeEventListener("click", finish);
      input?.removeEventListener("keydown", onKey);
    }
    startBtn.addEventListener("click", finish);
    input?.addEventListener("keydown", onKey);
    // 初回オンボーディングは「名前を入力する」単一目的のポップアップ。中央ルールの明示的な
    // 例外として、開いた時に名前欄へフォーカスする (触っていない他の欄が無い単一入力系)。
    openPopup(overlay, { autoFocus: true, focusTarget: input });
  });
}

// --- ユーザー選択 (2 人以上・再選択期限切れ) ---
function showUserSelection(users) {
  const overlay = document.getElementById("userSelectOverlay");
  const list = document.getElementById("userSelectList");
  const addHost = document.getElementById("userSelectAdd");
  if (!overlay || !list) return Promise.resolve();

  return new Promise((resolve) => {
    const currentId = getCurrentUserId();
    const currentName = getCurrentUserName();

    function close() {
      setLastUserConfirmAt(Date.now());
      overlay.classList.remove("active");
      resolve();
    }

    list.textContent = "";
    // 現ユーザーを先頭に
    const sorted = users.slice().sort((a, b) => (a.id === currentId ? -1 : b.id === currentId ? 1 : 0));
    for (const u of sorted) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ioDbRowMain userSelectRow" + (u.id === currentId ? " selected" : "");
      const label = document.createElement("div");
      label.className = "ioDbRowLabel";
      label.textContent = u.name || t("user.default.name");
      btn.appendChild(label);
      if (u.id === currentId) {
        const meta = document.createElement("div");
        meta.className = "ioDbRowMeta";
        meta.textContent = t("userSelect.current");
        btn.appendChild(meta);
      }
      btn.addEventListener("click", async () => {
        if (u.id === currentId) { vibrate(); close(); return; }
        try {
          await switchUser(u.id); // _onUserChanged がヘッダー/本文を更新
          vibrate();
          close();
        } catch (e) { console.error("user select switch failed:", e); }
      });
      list.appendChild(btn);
    }

    // 新規ユーザー
    if (addHost) {
      addHost.textContent = "";
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "ioWsAddBtn";
      addBtn.title = t("io.user.create.action");
      addBtn.setAttribute("aria-label", t("io.user.create.action"));
      addBtn.innerHTML = icon("plus", 18);
      addBtn.addEventListener("click", () => {
        addHost.textContent = "";
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "ioWsAddInput";
        inp.placeholder = t("io.user.create.placeholder");
        addHost.appendChild(inp);
        let done = false;
        async function commit() {
          if (done) return;
          const name = String(inp.value || "").trim();
          if (!name) return;
          done = true;
          let res;
          try {
            res = await createUserAndSwitch(name);
          } catch (e) {
            // createUserAndSwitch は内部で switchUser → 現状を fail-closed 保存する。
            // 保存できなければ throw されるので作成/切替を中断して通知する。
            console.error("create user (boot-gate) failed:", e);
            done = false;
            alert(t("io.user.create.failed"));
            focusPopupInput(inp); // 失敗 → 訂正できるよう入力欄へ戻す (中央ヘルパ経由)
            return;
          }
          if (!res.ok) {
            done = false;
            if (res.reason === "duplicate") alert(t("io.user.name.duplicate"));
            focusPopupInput(inp); // 重複名 → 訂正できるよう入力欄へ戻す (中央ヘルパ経由)
            return;
          }
          vibrate();
          close();
        }
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
        inp.addEventListener("blur", commit);
        // 明示的な「+ 追加」クリックで現れた単一入力 → 中央ヘルパ経由でフォーカス。
        focusPopupInput(inp);
      });
      addHost.appendChild(addBtn);
    }

    overlay.classList.add("active");
  });
}
