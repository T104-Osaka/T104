// (論理スレッド - 4) と 15 のうち、小さい方を選択（最低 1 は確保）
const logicalThreads = navigator.hardwareConcurrency || 4; 
const numSubWorkers = Math.max(1, Math.min(logicalThreads - 4, 100));

console.log(`System Logical Threads: ${logicalThreads}`);
console.log(`Worker Pool Size: ${numSubWorkers}`);

const subWorkers = [];
let bestScoreTotal = 0;

// 🚀 2. 算出した数だけ子Workerを生成
for (let i = 0; i < numSubWorkers; i++) {
    const workerNo = i + 1; // 画面に出す Worker 番号（1始まり）
    const sw = new Worker('sub_worker.js');
    sw.onmessage = function(e) {
        if (e.data.type === 'RESULT') {
            if (e.data.score > bestScoreTotal) {
                bestScoreTotal = e.data.score;
                self.postMessage(e.data);
            }
        } else if (e.data.type === 'PATTERNS') {
            self.postMessage(e.data);
        } else if (e.data.type === 'HISTORY') {
            // 山登り法の推移（5秒ごとの最高点）。Worker番号を付けて画面側へ
            self.postMessage({ type: 'HISTORY', worker: workerNo, times: e.data.times, scores: e.data.scores });
        }
    };
    subWorkers.push(sw);
}

// 画面側へ Worker 数を知らせる
self.postMessage({ type: 'INFO', workers: numSubWorkers });

onmessage = function(e) {
    bestScoreTotal = 0;
    subWorkers.forEach(sw => sw.postMessage(e.data));
};
