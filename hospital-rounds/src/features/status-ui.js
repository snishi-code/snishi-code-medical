"use strict";

// ステータス → CSS クラス名の共通マッピング。
//
// home / detail / memo / shared が患者ボタンの色付けに使う。以前は home.js が定義し
// detail.js から import していたため detail.js ↔ home.js の循環 import になっていた
// (bindTapOrLongPress は逆向き)。定数依存だけなのでここへ切り出して循環を断つ。
//
// 色値の正本は shared.css / style.css の :root と各 .status-* クラス。ここはクラス名のみ。

import { STATUS } from "../constants.js";

export function statusClass(status) {
  if (status === STATUS.YELLOW) return "status-yellow";
  if (status === STATUS.GREEN) return "status-green";
  if (status === STATUS.GRAY) return "status-gray";
  if (status === STATUS.BLUE) return "status-blue";
  return "";
}
