/* ============================================================================
 * site-links.js — サイト横断リンクの「単一ソース」
 *
 * Origin 分離後、カテゴリ間 (apex ↔ medical ↔ personal) のリンクはサブドメインを
 * またぐ絶対 URL になる。これを各 HTML に直書きすると変更時に追い切れないため、
 * URL はこのファイル 1 箇所だけで管理する。
 *
 * 使い方: HTML 側は href を書かず data-link 属性で参照する。
 *   <a class="nav-link" data-link="medical">医療</a>
 *   <script src="/site-links.js"></script>   ← </body> 直前で読み込む
 * 読み込み時に data-link を持つ全要素へ href を流し込む。
 *
 * ※ 同一カテゴリ内のアプリ (例 /hospital-rounds/) は origin 相対のまま書く
 *   (prod/test どちらの origin でもそのまま動くため、ここには含めない)。
 *
 * このファイルは全リポ (snishi-code.com / -medical / -personal) で同一内容を持つ。
 * URL を変えるときは全リポのこのファイルを揃えて直すこと。
 * ========================================================================== */
window.SITE_LINKS = {
  apex:        "https://snishi-code.com",
  medical:     "https://medical.snishi-code.com",
  medicalDev:  "https://medical-dev.snishi-code.com",
  personal:    "https://personal.snishi-code.com",
  personalDev: "https://personal-dev.snishi-code.com",
  github:      "https://github.com/snishi-code",
};

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-link]").forEach((el) => {
    const url = window.SITE_LINKS[el.dataset.link];
    if (url) el.setAttribute("href", url);
  });
});
