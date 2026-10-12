// puyodamage_worker.js — 親ワーカー（HTML と サブワーカーの間をつなぐ）
//
// HTML → 親 : カンマ区切り54個の文字列（puyoWorker.postMessage(combinedData) と同じ）
// 親 → HTML : { type: 'INFO',      workers }                                  使うサブワーカーの数
//             { type: 'HISTORY',   worker, times, scores, resets }            山登りの推移（サブワーカーごと。山登り0のときは無し）
//             { type: 'PATTERNS',  count }                                    試したパターン数の合計
//             { type: 'RESULT',    score, tap, colorArray, originalColorArray, priority, plusArray, bonusArray }   最良の結果
//             { type: 'NO_RESULT' }                                           どのサブワーカーも見つけられなかった
//
// 流れ: 全サブワーカーに同じ入力を渡して並列に探索 → 全員の結果がそろったら、一番点数が高いものを HTML に返す。
// 探索中に新しい入力が来たら、実行中のサブワーカーを止めて（terminate）、最初からやり直す。

const SUB_URL = 'puyodamage_subworker.js';
const MAX_WORKERS = 16;   // サブワーカー数の上限。減らしたいときはここ（例: hardwareConcurrency - 1 にすると1コア空く）

const cores = (self.navigator && self.navigator.hardwareConcurrency) || 4;
const WORKERS = Math.max(1, Math.min(cores, MAX_WORKERS));

let subs = [];      // サブワーカー（探索が終わっても使い回す。wasm の読み込みを毎回しないため）
let job = null;     // 実行中の探索 { id, items[], finished[], left }
let jobId = 0;

// ---- サブワーカーの管理 ----
function spawn(k) {
    const w = new Worker(SUB_URL);
    w.onmessage = function (e) {
        const m = e.data;
        if (m && m.type === 'DONE') onDone(k, w, m);
    };
    w.onerror = function (e) {   // 読み込み失敗・途中で落ちたとき: そのサブワーカーは「結果なし」として扱い、次回作り直す
        if (e && e.preventDefault) e.preventDefault();
        console.error('サブワーカー' + (k + 1) + ' でエラー: ' + (e && e.message ? e.message : e));
        const dead = w;
        try { dead.terminate(); } catch (_) {}
        if (subs[k] === dead) subs[k] = null;
        if (job) onDone(k, dead, { id: job.id, result: null, patterns: 0, history: null, error: 'worker error' }, true);
    };
    return w;
}

function ensurePool() {
    for (let k = 0; k < WORKERS; k++) if (!subs[k]) subs[k] = spawn(k);
}

function stopAll() {   // 実行中の探索を止める（サブワーカーは計算中だとメッセージを受け取れないので、作り直すしかない）
    subs.forEach(function (w) { if (w) { try { w.terminate(); } catch (_) {} } });
    subs = [];
    job = null;
}

// ---- 結果の集計 ----
function onDone(k, w, m, fromError) {
    if (!job || m.id !== job.id || job.finished[k]) return;
    if (!fromError && subs[k] !== w) return;   // 止めたあとに届いた古い結果は捨てる
    job.finished[k] = true;
    job.items[k] = m;
    if (m.error) console.warn('サブワーカー' + (k + 1) + ': ' + m.error);
    if (--job.left === 0) finish();
}

function finish() {
    const items = job.items;
    job = null;

    let patterns = 0, best = null;
    items.forEach(function (it, k) {
        if (!it) return;
        if (it.history) {
            postMessage({ type: 'HISTORY', worker: k + 1, times: it.history.times, scores: it.history.scores, resets: it.history.resets });
        }
        patterns += it.patterns || 0;
        if (it.result && (!best || it.result.score > best.score)) best = it.result;
    });

    if (patterns > 0) postMessage({ type: 'PATTERNS', count: patterns });
    if (best) {
        postMessage({
            type: 'RESULT',
            score: best.score,
            tap: best.tap,
            colorArray: best.colorArray,
            originalColorArray: best.originalColorArray,
            priority: best.priority,
            plusArray: best.plusArray,
            bonusArray: best.bonusArray
        });
    } else {
        postMessage({ type: 'NO_RESULT' });
    }
}

// ---- HTML からの入力 ----
self.onmessage = function (e) {
    const data = e.data;
    if (typeof data !== 'string') return;

    if (typeof Worker === 'undefined') {   // サブワーカーが作れない環境（古いブラウザ）
        console.error('このブラウザは Worker の中から Worker を作れません');
        postMessage({ type: 'NO_RESULT' });
        return;
    }

    if (job) stopAll();   // 実行中なら、止めて最初から
    ensurePool();

    job = { id: ++jobId, items: new Array(WORKERS).fill(null), finished: new Array(WORKERS).fill(false), left: WORKERS };
    postMessage({ type: 'INFO', workers: WORKERS });
    subs.forEach(function (w) { w.postMessage({ type: 'RUN', id: job.id, data: data }); });
};

// ページを開いた直後にサブワーカーを作っておく（wasm の読み込みを、最初の探索開始より前に済ませる）
if (typeof Worker !== 'undefined') ensurePool();
