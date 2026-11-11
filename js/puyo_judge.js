/* ==========================================================================
   puyo_judge.js  ―  ぷよ画像の判定だけを担当するファイル（puyokakuninn.html から読み込む）
   --------------------------------------------------------------------------
   やること: 写真 → 盤面を切り出し → 6段×8列(＋NEXT1段)の各マスから特徴量を作る
             → 「分け方1」のルール文章(js/puyo_rules.js の PUYO_RULE_TEXT)で
               色(0〜8)とプラスを判定する。
   ルールは文章をそのまま読み込んで使う（数値をこのファイルに写していない）ので、
   index.html で作り直した文章を puyo_rules.js に貼り替えるだけで判定が入れ替わる。

   使い方:
     const r = PuyoJudge.analyzeImage(img);      // img: 読み込み済みの Image
     r.error                                       // 失敗時のメッセージ（成功なら無し）
     r.board  = {left, top, w, h}                  // 切り出した盤面の位置（元画像上）
     r.colors = [48]  0=♡ 1=赤 2=青 3=緑 4=黄 5=紫 6=プリズム 7=お邪魔 8=かたぷよ
     r.plus   = [48]  0/1      r.bonus = [48] 0/1      r.next = "12345123"（NEXT段の色）
   ========================================================================== */
(function (root) {
"use strict";

/* ---------- 種類・特徴量の名前（index.html の教師データ作成ツールと同じ） ---------- */
const LABELS = [
  { id: "0", n: "ハート" }, { id: "1", n: "赤" }, { id: "2", n: "青" }, { id: "3", n: "緑" }, { id: "4", n: "黄" },
  { id: "5", n: "紫" }, { id: "6", n: "プリズム" }, { id: "7", n: "お邪魔" }, { id: "8", n: "かたぷよ" }
];
const LNINV = {}; LABELS.forEach(l => LNINV[l.n] = l.id);

const FEATS = ["avg_all", "r_max5", "g_max5", "b_max5", "r_min5", "g_min5", "b_min5", "mid5", "corner4"];
const DEC = Array.from({ length: 10 }, (_, i) => "dec" + (i + 1));
const QG = [["qs", "R+G+B順"], ["qr", "R順"], ["qg", "G順"], ["qb", "B順"]];
const QALL = []; QG.forEach(([p]) => { for (let i = 1; i <= 10; i++) QALL.push(p + i); });
const FN = {
  avg_all: "全体平均", r_max5: "R大きい上位5px平均", g_max5: "G大きい上位5px平均", b_max5: "B大きい上位5px平均",
  r_min5: "R小さい下位5px平均", g_min5: "G小さい下位5px平均", b_min5: "B小さい下位5px平均",
  mid5: "R+G+B中央値付近5%の平均", corner4: "マス四隅(4px内側)の平均", ratio: "ratio"
};
DEC.forEach((k, i) => FN[k] = "R+G+B順 " + (i * 10) + "〜" + (i * 10 + 10) + "%の平均");
QG.forEach(([p, n]) => { for (let i = 1; i <= 10; i++) FN[p + i] = "右下 " + n + " " + ((i - 1) * 10) + "〜" + (i * 10) + "%の平均"; });
const FNINV = {}; Object.keys(FN).forEach(k => FNINV[FN[k]] = k);

/* 平面の軸: キー → [xの名前, yの名前, xの添字, yの添字]。判定は「y と a*x+b を比べる」 */
const AX = {
  rg: ["R", "G", 0, 1], gr: ["G", "R", 1, 0], gb: ["G", "B", 1, 2],
  bg: ["B", "G", 2, 1], rb: ["R", "B", 0, 2], br: ["B", "R", 2, 0]
};
// ※ index.html の AX と同じ並び
const axKey = (x, y) => Object.keys(AX).find(k => AX[k][0] === x && AX[k][1] === y);

/* ---------- BE（ボーナスエリア）判定: ルール文章の対象外なので今までのまま ---------- */
const BONUS_RULE = { off: 4, r: 200, g: 150 };   // 四隅(4px内側)の平均が R>=200 かつ G>=150

/* NEXT段（一番上の細い段）は教師データに無いので、今までどおり代表色との近さで決める */
const NEXT_PALETTE = {
  "1": [210, 50, 50], "2": [50, 100, 210], "3": [50, 160, 50], "4": [220, 200, 50], "5": [150, 50, 180]
};

/* ==========================================================================
   ルール文章の読み込み（index.html の parseRuleText と同じ読み方）
   ========================================================================== */
function parseCond(feat, tok) {
  const N = "-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?", SN = "[+-]\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?";
  const m = tok.trim().match(/^([RGB])([<>])(.+)$/); if (!m) return null;
  const y = m[1], side = m[2] === "<" ? "lt" : "gt", poly = m[3];
  let q = poly.match(new RegExp("^(" + N + ")\\*([RGB])\\^2(" + SN + ")\\*\\2(" + SN + ")$"));
  if (q) { const k = axKey(q[2], y); return k ? { feat, axes: k, c: [+q[1], +q[3], +q[4]], side } : null; }
  q = poly.match(new RegExp("^(" + N + ")\\*([RGB])(" + SN + ")$"));
  if (q) { const k = axKey(q[2], y); return k ? { feat, axes: k, c: [0, +q[1], +q[3]], side } : null; }
  return null;
}

function parseRuleText(t) {
  const rs = { name: "取込", steps: [], fallback: "2", bad: 0 };
  let cur = null, bad = 0;
  const nm = t.match(/分け方「(.+?)」/); if (nm) rs.name = nm[1];
  t.split(/\r?\n/).forEach(line => {
    // [+赤] / [-赤]  プラス判定の領域
    let m = line.match(/^\[([+-])(\S+?)\] プラス(?:でない)?: /);
    if (m && LNINV[m[2]] !== undefined) { cur = { label: LNINV[m[2]], plusKind: m[1], conds: [] }; rs.steps.push(cur); return; }
    // [1] プリズム  色の判定ステップ
    m = line.match(/^\[(\d+)\] (\S+?): /);
    if (m && LNINV[m[1]] === undefined && LNINV[m[2]] !== undefined) { cur = { label: LNINV[m[2]], conds: [] }; rs.steps.push(cur); return; }
    // [その他] お邪魔
    m = line.match(/^\[その他\] (\S+)/);
    if (m && LNINV[m[1]] !== undefined) { rs.fallback = LNINV[m[1]]; cur = null; return; }
    // ratio<0.01
    m = line.match(/^\s+- 特徴量「ratio」: (.+)$/);
    if (m && cur) {
      m[1].split(" ; ").forEach(tk => {
        const q = tk.trim().match(/^ratio<([\d.eE+-]+)$/);
        if (q) cur.conds.push({ feat: "ratio", axes: "gr", c: [0, 0, +q[1]], side: "lt" }); else bad++;
      });
      return;
    }
    // 特徴量「全体平均」 平面R-G: R>… ; G>…
    m = line.match(/^\s+- 特徴量「(.+?)」 平面[RGB]-[RGB]: (.+)$/);
    if (m && cur && FNINV[m[1]]) {
      m[2].split(" ; ").forEach(tk => { const c = parseCond(FNINV[m[1]], tk); if (c) cur.conds.push(c); else bad++; });
    } else if (m && cur) { bad++; }
  });
  const steps = [], plus = {}, non = {};
  rs.steps.forEach(s => {
    if (!s.conds.length) return;
    const o = { label: s.label, conds: s.conds };
    if (s.plusKind === "+") plus[s.label] = o; else if (s.plusKind === "-") non[s.label] = o; else steps.push(o);
  });
  Object.keys(non).forEach(l => { if (plus[l]) plus[l].non = non[l]; });
  rs.steps = steps; rs.plus = plus; rs.bad = bad;
  return steps.length ? rs : null;
}

/* ---------- 判定の評価 ---------- */
function evalCond(c, f) {
  const v = f[c.feat]; if (!v) return false;
  const a = AX[c.axes], x = v[a[2]], y = v[a[3]];
  const lim = c.c[0] * x * x + c.c[1] * x + c.c[2];
  return c.side === "lt" ? y < lim : y > lim;
}
const evalAll = (st, f) => { for (const c of st.conds) if (!evalCond(c, f)) return false; return true; };

function classify(rs, f) {
  for (const st of rs.steps) if (evalAll(st, f)) return st.label;
  return rs.fallback;
}
// プラス判定: 「プラスでない側」の全条件に入れば0、入らない残りはすべてプラス（色が赤青緑黄紫のとき）
function plusOf(rs, label, f) {
  if (!"12345".includes(label)) return 0;
  const st = rs.plus && rs.plus[label]; if (!st) return 0;
  if (!st.non) return evalAll(st, f) ? 1 : 0;   // プラスでない側が無い色だけ、プラス側の領域で判定
  return evalAll(st.non, f) ? 0 : 1;            // 残りがプラス: プラスでない側に入らなければプラス
}

/* ---------- ルールの準備（puyo_rules.js が置く PUYO_RULE_TEXT を使う） ---------- */
let RULES = null, RULES_NEXT = null, RULE_INFO = "ルール未読み込み", RULE_INFO_NEXT = "NEXT用ルール未読み込み（NEXT段は代表色との近さで判定）";
const ruleInfo = rs => {
  const nm = id => LABELS[+id].n;
  return "ルール「" + rs.name + "」: 色 " + rs.steps.map(s => nm(s.label) + "(" + s.conds.length + "条件)").join(" → ") +
    " → その他=" + nm(rs.fallback) + " ／ プラス判定 " + (Object.keys(rs.plus).map(nm).join("・") || "なし") +
    (rs.bad ? " ／ 読めなかった条件 " + rs.bad + "個" : "");
};
// 盤面用ルール（puyo_rules.js の PUYO_RULE_TEXT）
function setRules(text) {
  const rs = parseRuleText(String(text || ""));
  if (!rs) { RULES = null; RULE_INFO = "ルール文章を読めませんでした（puyo_rules.js に「分け方」の文章を貼ってください）"; return false; }
  RULES = rs; RULE_INFO = ruleInfo(rs);
  return true;
}
// NEXT段用ルール（puyo_rules_next.js の PUYO_RULE_TEXT_NEXT）。無ければNEXT段は代表色との近さで決める
function setRulesNext(text) {
  const rs = parseRuleText(String(text || ""));
  if (!rs) { RULES_NEXT = null; RULE_INFO_NEXT = "NEXT用ルール文章を読めませんでした（NEXT段は代表色との近さで判定）"; return false; }
  RULES_NEXT = rs; RULE_INFO_NEXT = "NEXT用 " + ruleInfo(rs);
  return true;
}
function ensureRules() {
  if (!RULES && !root.PUYO_RULE_TEXT) RULE_INFO = "ルール未読み込み: puyo_rules.js が読み込まれていません（HTMLと同じ場所の js/ フォルダに puyo_rules.js / puyo_rules_next.js / puyo_judge.js を置いてあるか確認）";
  if (!RULES && root.PUYO_RULE_TEXT) setRules(root.PUYO_RULE_TEXT);
  if (!RULES_NEXT && root.PUYO_RULE_TEXT_NEXT) setRulesNext(root.PUYO_RULE_TEXT_NEXT);
  return !!RULES;
}

/* ==========================================================================
   画像 → 特徴量（index.html の extractCells と同じ計算）
   ========================================================================== */
function mid5(px) {
  const n = px.length; if (!n) return [0, 0, 0];
  const a = px.slice().sort((p, q) => (p.r + p.g + p.b) - (q.r + q.g + q.b));
  const w = Math.max(1, Math.round(n * 0.05)), st = Math.max(0, Math.min(n - w, Math.round(n / 2 - w / 2)));
  let r = 0, g = 0, b = 0; for (let i = st; i < st + w; i++) { r += a[i].r; g += a[i].g; b += a[i].b; }
  return [r / w, g / w, b / w];
}
function topAvg(px, key, asc) {
  const a = px.slice().sort((p, q) => asc ? p[key] - q[key] : q[key] - p[key]).slice(0, Math.min(5, px.length));
  let r = 0, g = 0, b = 0; a.forEach(p => { r += p.r; g += p.g; b += p.b; });
  return [r / a.length, g / a.length, b / a.length];
}
function bandAvgs(px, keyFn, names, f) {   // 小さい順に並べて10%ずつの平均RGB
  const a = px.slice().sort((p, q) => keyFn(p) - keyFn(q)), n = a.length;
  names.forEach((k, i) => {
    let lo = Math.floor(n * i / 10), hi = Math.floor(n * (i + 1) / 10);
    if (hi <= lo) { lo = Math.min(n - 1, lo); hi = lo + 1; }
    let r = 0, g = 0, b = 0; for (let j = lo; j < hi; j++) { r += a[j].r; g += a[j].g; b += a[j].b; }
    const c = hi - lo; f[k] = [r / c, g / c, b / c];
  });
}
function extractFeatures(px, raw, pxRB) {
  let r = 0, g = 0, b = 0; px.forEach(p => { r += p.r; g += p.g; b += p.b; });
  const f = {
    avg_all: [r / px.length, g / px.length, b / px.length],
    r_max5: topAvg(px, "r", false), g_max5: topAvg(px, "g", false), b_max5: topAvg(px, "b", false),
    r_min5: topAvg(px, "r", true), g_min5: topAvg(px, "g", true), b_min5: topAvg(px, "b", true), mid5: mid5(px)
  };
  bandAvgs(px, p => p.r + p.g + p.b, DEC, f);
  // 右下（判定エリアの右半分・下半分）だけで、並べ方ごとの10%区切り
  const rb = pxRB && pxRB.length ? pxRB : px;
  const keys = { qs: p => p.r + p.g + p.b, qr: p => p.r, qg: p => p.g, qb: p => p.b };
  QG.forEach(([pre]) => bandAvgs(rb, keys[pre], Array.from({ length: 10 }, (_, i) => pre + (i + 1)), f));
  let m = 0; raw.forEach(p => { if (p.r > 235 && p.g > 145 && p.b < 50) m++; });
  f.ratio = [raw.length ? m / raw.length : 0, 0, 0];
  return f;
}

/* ---------- 盤面の切り出し（今までと同じ: 色数が少ない行・列を目印にする） ---------- */
function cutBoard(data, W, H) {
  const rowC = new Array(H);
  for (let y = 0; y < H; y++) { const u = new Set(); for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; u.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]); } rowC[y] = u.size; }
  let top = 0, bot = H, plateau = false, low = 0;
  const s0 = Math.floor(H * 0.5), lim = Math.floor(H * 0.8);
  for (let y = s0; y < H; y++) {
    if (!plateau) { if (rowC[y] <= 40) { if (++low >= 3) plateau = true; } else low = 0; }
    else if (top === 0) { if (rowC[y] >= 70) top = y; }
    if (y >= lim && rowC[y] <= 40) { bot = y; break; }
  }
  const fh = bot - top, aT = Math.floor(top + fh * 0.25), aB = Math.floor(bot - fh * 0.25);
  const colC = new Array(W);
  for (let x = 0; x < W; x++) { const u = new Set(); for (let y = aT; y < aB; y++) { const i = (y * W + x) * 4; u.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]); } colC[x] = u.size; }
  let left = 0, gap = false, ll = 0;
  for (let x = 0; x < W; x++) { if (!gap) { if (colC[x] <= 10) { if (++ll >= 3) gap = true; } else ll = 0; } else if (colC[x] >= 40) { left = x; break; } }
  let right = W, rl = 0;
  for (let x = Math.floor(W * 0.7); x < W; x++) { if (colC[x] <= 10) { if (++rl >= 3) { right = x - 1; break; } } else rl = 0; }
  return { left, top, w: right - left, h: fh };
}

/* ==========================================================================
   本体: ピクセル配列(RGBA)から判定。opts.board を渡すと盤面の自動切り出しを省く（テスト用）
   ========================================================================== */
function analyzePixels(data, W, H, opts) {
  opts = opts || {};
  if (!ensureRules()) return { error: RULE_INFO };
  const b = opts.board || cutBoard(data, W, H);
  if (!(b.w > 0 && b.h > 0)) return { error: "盤面を見つけられませんでした" };

  const yR = [1, 2, 2, 2, 2, 2, 2], uH = b.h / 13, uW = b.w / 8;
  const colors = new Array(48).fill(0), plus = new Array(48).fill(0), bonus = new Array(48).fill(0);
  const cells = []; let next = "", cy = 0;

  for (let row = 0; row < 7; row++) {
    const rh = yR[row] * uH;
    for (let col = 0; col < 8; col++) {
      const cl = b.left + col * uW, cr = cl + uW, ct = b.top + cy, cb = ct + rh;
      let sX, eX, sY, eY;
      if (row === 0) { sX = cl + uW * 0.33; eX = cl + uW * 0.48; sY = ct + rh * 0.33; eY = ct + rh * 0.55; }
      else { sX = cl + uW * 0.25; eX = cl + uW * 0.75; sY = ct + rh * 0.25; eY = ct + rh * 0.75; }

      const px = [], raw = [], pxRB = [], mX = (sX + eX) / 2, mY = (sY + eY) / 2;
      for (let y = Math.floor(sY); y < Math.floor(eY); y++) for (let x = Math.floor(sX); x < Math.floor(eX); x++) {
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const i = (y * W + x) * 4, r = data[i], g = data[i + 1], bl = data[i + 2];
        raw.push({ r, g, b: bl });
        if (r > 240 && g > 240 && bl > 240) continue;          // 白飛びは判定に使わない
        px.push({ r, g, b: bl });
        if (x >= mX && y >= mY) pxRB.push({ r, g, b: bl });
      }
      if (!px.length) {
        const mx = Math.min(W - 1, Math.max(0, Math.floor((sX + eX) / 2))), my = Math.min(H - 1, Math.max(0, Math.floor((sY + eY) / 2)));
        const mi = (my * W + mx) * 4, p = { r: data[mi], g: data[mi + 1], b: data[mi + 2] };
        px.push(p); raw.push(p);
      }
      const f = extractFeatures(px, raw, pxRB);

      if (row === 0) {                                        // NEXT段: NEXT用ルール（無ければ代表色との近さ）
        if (RULES_NEXT) { next += classify(RULES_NEXT, f); continue; }
        let best = Infinity, id = "1";
        for (const k in NEXT_PALETTE) {
          const t = NEXT_PALETTE[k], a = f.avg_all, d = Math.hypot(a[0] - t[0], a[1] - t[1], a[2] - t[2]);
          if (d < best) { best = d; id = k; }
        }
        next += id; continue;
      }
      const idx = (row - 1) * 8 + col;
      // BE: マス四隅(4px内側)の平均
      let sr = 0, sg = 0, n = 0;
      [[cl + BONUS_RULE.off, ct + BONUS_RULE.off], [cr - BONUS_RULE.off, ct + BONUS_RULE.off],
       [cl + BONUS_RULE.off, cb - BONUS_RULE.off], [cr - BONUS_RULE.off, cb - BONUS_RULE.off]].forEach(([x, y]) => {
        const X = Math.floor(x), Y = Math.floor(y);
        if (X >= 0 && X < W && Y >= 0 && Y < H) { const i = (Y * W + X) * 4; sr += data[i]; sg += data[i + 1]; n++; }
      });
      if (n && sr / n >= BONUS_RULE.r && sg / n >= BONUS_RULE.g) bonus[idx] = 1;

      const label = classify(RULES, f);
      colors[idx] = parseInt(label, 10);
      plus[idx] = plusOf(RULES, label, f);
      if (opts.debug) cells.push({ idx, label, plus: plus[idx], ratio: f.ratio[0] });
    }
    cy += rh;
  }
  return { board: b, colors, plus, bonus, next, cells };
}

/* Image → analyzePixels */
function analyzeImage(img, opts) {
  const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
  const cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(img, 0, 0);
  return analyzePixels(cx.getImageData(0, 0, img.width, img.height).data, img.width, img.height, opts);
}

root.PuyoJudge = {
  analyzeImage, analyzePixels, setRules, setRulesNext, parseRuleText, classify, plusOf, extractFeatures,
  info: () => { ensureRules(); return RULE_INFO + " ／ " + RULE_INFO_NEXT; },
  ready: () => ensureRules()
};
if (typeof module !== "undefined" && module.exports) module.exports = root.PuyoJudge;
})(typeof window !== "undefined" ? window : globalThis);
