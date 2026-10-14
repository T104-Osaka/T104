// tokubetu_rule_worker.js — 親Worker。子Worker（tokubetu_rule_sub_worker.js）を複数立てて、結果を1つにまとめて画面へ返す
// (論理スレッド - 4) と 8 のうち、小さい方を選択（最低 1 は確保）。puyodamage_worker.js と同じ数え方
const logicalThreads = navigator.hardwareConcurrency || 4;
const numSubWorkers = Math.max(1, Math.min(logicalThreads - 4, 8));

const subs = [];
const evals = new Array(numSubWorkers).fill(0);
const tops = new Array(numSubWorkers).fill(null);
let readyCount = 0, doneCount = 0, loadFailed = false, job = null;

// 各子Workerの上位30件を、「塗りの結果が同じもの」を1つにまとめて、ダメージの大きい順に30件
function merge() {
    const best = new Map();
    for (const list of tops) {
        if (!list) continue;
        for (const t of list) {
            const eff = job ? t.cells.filter(c => job.orig[c] !== job.X).join(',') : t.cells.join(',');
            const old = best.get(eff);
            if (!old || t.sc > old.sc + 1e-9 || (Math.abs(t.sc - old.sc) < 1e-9 && t.cells.length < old.cells.length)) best.set(eff, t);
        }
    }
    return [...best.values()].sort((a, b) => b.sc - a.sc || a.cells.length - b.cells.length).slice(0, 30);
}

for (let i = 0; i < numSubWorkers; i++) {
    const sw = new Worker('tokubetu_rule_sub_worker.js');
    sw.onmessage = function (e) {
        const m = e.data;
        if (m.type === 'READY') {
            if (++readyCount === numSubWorkers) self.postMessage({ type: 'READY', workers: numSubWorkers });
            return;
        }
        evals[m.id] = m.evals; tops[m.id] = m.top;
        if (m.type === 'done') doneCount++;
        const all = doneCount === numSubWorkers;
        self.postMessage({ type: all ? 'done' : 'prog', id: 0, evals: evals.reduce((a, b) => a + b, 0), top: merge() });
    };
    sw.onerror = function (err) {                       // wasm が見つからない等。画面側が JavaScript 版に切り替える
        if (readyCount < numSubWorkers && !loadFailed) { loadFailed = true; self.postMessage({ type: 'LOAD_ERROR', message: err.message || 'wasm を読み込めません' }); }
    };
    subs.push(sw);
}

onmessage = function (e) {
    job = e.data;
    doneCount = 0; evals.fill(0); tops.fill(null);
    subs.forEach((sw, i) => {
        const f = job.csv.split(',');                   // 乱数の種(32番目)を子Workerごとに変える
        f[32] = String((((Number(f[32]) ^ (i * 7919)) >>> 0)) || 1);
        sw.postMessage(Object.assign({}, job, { id: i, csv: f.join(',') }));
    });
};
