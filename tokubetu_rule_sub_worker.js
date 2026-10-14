// tokubetu_rule_sub_worker.js — 探索を1本分実行する子Worker（C言語→WebAssembly 版）。親は tokubetu_rule_worker.js
// 先に tokubetu_rule.c を emcc でビルドして tokubetu_rule.js / tokubetu_rule.wasm を同じ場所に置いておく
importScripts("tokubetu_rule.js");

let curId = 0;
Module.onRuntimeInitialized = () => {
    self.postMessage({ type: 'READY' });
};

onmessage = function (e) {
    curId = e.data.id;
    Module.ccall('run_tokubetu', null, ['string'], [e.data.csv]);
};

// C言語の EM_ASM から呼ばれる: 上位30件（途中経過は final=0、最後は final=1）
self.reportTop = function (final, evals, list) {
    self.postMessage({ type: final ? 'done' : 'prog', id: curId, evals, top: list });
};
