// (論理スレッド - 4) と 15 のうち、小さい方を選択（最低 1 は確保）
const logicalThreads = navigator.hardwareConcurrency || 4; 
const numSubWorkers = Math.max(1, Math.min(logicalThreads - 4, 8));

console.log(`System Logical Threads: ${logicalThreads}`);
console.log(`Worker Pool Size: ${numSubWorkers}`);

const subWorkers = [];
let bestScoreTotal = 0;

// 🚀 2. 算出した数だけ子Workerを生成
for (let i = 0; i < numSubWorkers; i++) {
    const sw = new Worker('sub_worker.js');
    sw.onmessage = function(e) {
        if (e.data.type === 'RESULT') {
            if (e.data.score > bestScoreTotal) {
                bestScoreTotal = e.data.score;
                self.postMessage(e.data);
            }
        } else if (e.data.type === 'PATTERNS') {
            self.postMessage(e.data);
        }
    };
    subWorkers.push(sw);
}

onmessage = function(e) {
    bestScoreTotal = 0;
    subWorkers.forEach(sw => sw.postMessage(e.data));
};
