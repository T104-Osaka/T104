// sub_worker.js
importScripts('puyosim.js');

Module.onRuntimeInitialized = () => {
    self.postMessage({ type: 'READY' });
};

onmessage = function(e) {
    // combinedData のみを受け取って実行
    Module.ccall('run_puyo_analysis', null, ['string'], [e.data]);
};

// C言語の EM_ASM から呼ばれる関数
self.reportResultToMain = function(score, tap, colorArray, originalColorArray, priority, plusArray, bonusArray) {
    self.postMessage({
        type: 'RESULT', score, tap, colorArray, originalColorArray, priority, plusArray, bonusArray
    });
};

self.reportPatterns = function(count) {
    self.postMessage({ type: 'PATTERNS', count });
};

// 山登り法の推移（5秒ごとの最高点）: times=[5,10,...], scores=[...]
self.reportHistory = function(times, scores) {
    self.postMessage({ type: 'HISTORY', times, scores });
};
