// puyodamage_subworker.js — サブワーカー
// 親ワーカー(puyodamage_worker.js)から指示を受けて、puyodamage.js / puyodamage.wasm（C言語をemccでビルドしたもの）で
// 探索を1回実行し、結果を親に1回だけ返す。
//
// 親 → サブ : { type: 'RUN', id, data }      data = HTMLが作ったカンマ区切り54個の文字列
// サブ → 親 : { type: 'DONE', id, result, patterns, history, error }
//   result   : { score, tap, colorArray, originalColorArray, priority, plusArray, bonusArray } または null（見つからず）
//   patterns : 試したパターン数（Cの reportPatterns）
//   history  : { times, scores, resets } または null（山登り0のときは無し）
//   error    : 失敗したときのメッセージ（なければ null）
//
// ※ run_puyo_analysis は終わるまで戻らないので、実行中はこのサブワーカーはメッセージを受け取れない。
//    探索の中止は、親が terminate() して作り直すことで行う。

// ---- Cの EM_ASM から呼ばれる関数（グローバルに置く）。ここでは貯めるだけで、終わってから親にまとめて送る ----
let acc = null;
function reportResultToMain(score, tap, colorArray, originalColorArray, priority, plusArray, bonusArray) {
    if (acc) acc.result = { score, tap, colorArray, originalColorArray, priority, plusArray, bonusArray };
}
function reportPatterns(count) { if (acc) acc.patterns = count; }
function reportHistory(times, scores, resets) { if (acc) acc.history = { times, scores, resets }; }
function reportNoResult() { if (acc) acc.result = null; }

// ---- wasm の読み込み ----
let ready = false;        // wasm の準備ができたか
let pending = null;       // 準備前に届いた指示（準備ができたら実行する）
let loadError = null;     // puyodamage.js の読み込みに失敗したときの理由

// emscripten が最初に見る設定。puyodamage.js を読む「前」に Module を用意しておく
var Module = {
    onRuntimeInitialized: function () {
        ready = true;
        if (pending) { const job = pending; pending = null; run(job); }
    },
    print: function (text) { console.log(text); },
    printErr: function (text) { console.warn(text); }
};

try {
    importScripts('puyodamage.js');   // 同じフォルダの puyodamage.js（puyodamage.wasm も同じ場所から読まれる）
} catch (err) {
    loadError = 'puyodamage.js を読み込めません: ' + (err && err.message ? err.message : err);
}

// ---- 1回ぶんの探索 ----
function run(job) {
    acc = { result: null, patterns: 0, history: null };
    let error = loadError;
    if (!error) {
        try {
            Module.ccall('run_puyo_analysis', null, ['string'], [job.data]);
        } catch (err) {
            error = 'run_puyo_analysis が失敗しました: ' + (err && err.message ? err.message : err);
        }
    }
    const out = acc;
    acc = null;
    postMessage({ type: 'DONE', id: job.id, result: out.result, patterns: out.patterns, history: out.history, error: error || null });
}

self.onmessage = function (e) {
    const msg = e.data;
    if (!msg || msg.type !== 'RUN') return;
    if (loadError || ready) run(msg);   // 読み込み失敗なら、すぐにエラーを返す
    else pending = msg;                 // wasm の準備待ち
};
