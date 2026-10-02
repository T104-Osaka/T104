/* hill_search.h — 山登り法（反復局所探索）による塗り替え探索
   既存コードの関数をそのまま使う: bouhatsukakuninn / check_composite_bouhatsu_1,2 / score_keisan
   ・乱数は既存の xorshift128 を使う
   ・時間切れ判定は stop コールバックで渡す（CLIでもWASMでも使える） */
#ifndef HILL_SEARCH_H
#define HILL_SEARCH_H

/* 乱数: 既定は xorshift128。WASM版(xorshift32)では include の前に次を定義する
     #define HS_RNG_T unsigned int
     #define HS_RAND(s, m) xor_rand((s), (m))                                   */
#ifndef HS_RNG_T
#define HS_RNG_T xorshift128_state
#define HS_RAND(s, m) (xorshift128(s) % (m))
#endif
/* スコア計算の呼び出し。既定はWASM版(max_chains付き)。CLI版(引数が1つ少ない)では
     #define HS_SCORE(h, w, t) score_keisan((w), (h)->plus, (h)->bonus, (h)->n_color, (h)->n_plus, (t)) */
#ifndef HS_SCORE
#define HS_SCORE(h, w, t) score_keisan((w), (h)->plus, (h)->bonus, (h)->n_color, (h)->n_plus, (t), (h)->max_chains)
#endif

typedef int  (*hs_stop_fn)(void *user);                                   /* 1を返したら終了 */
typedef void (*hs_report_fn)(int score, int tap, const signed char color[48], void *user); /* 最高得点が更新されたとき */

typedef struct {
    signed char *orig, *plus, *bonus, *n_color, *n_plus;   /* 入力盤面 */
    int n1, n2;            /* 色1・色2の塗り替え個数の上限 */
    int stall_max;         /* この回数だけ改善しなければ別の出発点へ（目安 300） */
    int max_chains;        /* NEXT落下後の連鎖回数の上限（WASM版の max_chains） */
    long valid_evals;      /* 出力: 点数まで計算した盤面の数 */
    long tried;            /* 出力: 試した案の数（暴発で捨てたものを含む） */
    int best_score;        /* 出力: これまでの最高得点（見つかるまで -1）。初期値は -1 にする */
} hs_ctx;

static unsigned hs_rand(HS_RNG_T *s, unsigned m) { return HS_RAND(s, m); }

/* 案 asg[48]（0=そのまま,1=色1に塗る,2=色2に塗る）を評価。暴発なら -1、それ以外は最高得点 */
static int hs_eval(hs_ctx *h, const signed char asg[48], signed char work[48], int *best_tap) {
    for (int i = 0; i < 48; i++) work[i] = asg[i] ? asg[i] : h->orig[i];
    if (bouhatsukakuninn(work) == -1) return -1;
    if (check_composite_bouhatsu_1(h->orig, work) != 0 && check_composite_bouhatsu_2(h->orig, work) != 0) return -1;
    h->valid_evals++;
    int best = -1, bt = -1;
    for (int t = 8; t < 48; t++) {
        int s = HS_SCORE(h, work, t);
        if (s > best) { best = s; bt = t; }
    }
    *best_tap = bt;
    return best;
}

static int hs_can(hs_ctx *h, int cell, int v) { return h->orig[cell] != v; }

/* 暴発しない出発点を作る（1つずつ足して、暴発したらやり直す） */
static int hs_start(hs_ctx *h, HS_RNG_T *rng, signed char asg[48], signed char work[48]) {
    for (int attempt = 0; attempt < 200; attempt++) {
        memset(asg, 0, 48);
        int c1 = 0, c2 = 0, fail = 0;
        while ((c1 < h->n1 || c2 < h->n2) && fail < 300) {
            int x = hs_rand(rng, 48);
            int v = (c1 < h->n1 && (c2 >= h->n2 || hs_rand(rng, 2))) ? 1 : 2;
            if (asg[x] || !hs_can(h, x, v)) { fail++; continue; }
            asg[x] = v;
            for (int i = 0; i < 48; i++) work[i] = asg[i] ? asg[i] : h->orig[i];
            if (bouhatsukakuninn(work) == -1) { asg[x] = 0; fail++; continue; }
            if (v == 1) c1++; else c2++;
        }
        int t; h->tried++;
        if (hs_eval(h, asg, work, &t) >= 0) return 1;
    }
    return 0;
}

/* 近傍（1手の変更）を作る。作れなければ 0 */
static int hs_move(hs_ctx *h, HS_RNG_T *rng, signed char a[48]) {
    int c1 = 0, c2 = 0;
    for (int i = 0; i < 48; i++) { c1 += a[i] == 1; c2 += a[i] == 2; }
    unsigned m = hs_rand(rng, 100);
    int y, x, z;
    if (m < 70) {                                   /* 塗るマスを1つ別の場所へ動かす */
        int k = 0; do { y = hs_rand(rng, 48); } while (!a[y] && ++k < 200);
        if (!a[y]) return 0;
        int v = a[y]; k = 0;
        do { x = hs_rand(rng, 48); } while ((a[x] || !hs_can(h, x, v)) && ++k < 200);
        if (k >= 200) return 0;
        a[x] = v; a[y] = 0;
    } else if (m < 85) {                            /* 色1と色2の塗りを入れ替える */
        int k = 0; do { y = hs_rand(rng, 48); } while (a[y] != 1 && ++k < 200);
        do { z = hs_rand(rng, 48); } while (a[z] != 2 && ++k < 400);
        if (a[y] != 1 || a[z] != 2 || !hs_can(h, y, 2) || !hs_can(h, z, 1)) return 0;
        a[y] = 2; a[z] = 1;
    } else if (m < 92) {                            /* 塗りを1つ外す */
        int k = 0; do { y = hs_rand(rng, 48); } while (!a[y] && ++k < 200);
        if (!a[y]) return 0;
        a[y] = 0;
    } else {                                        /* 塗りを1つ足す（上限まで） */
        int v = 1 + hs_rand(rng, 2);
        if ((v == 1 && c1 >= h->n1) || (v == 2 && c2 >= h->n2)) return 0;
        int k = 0; do { x = hs_rand(rng, 48); } while ((a[x] || !hs_can(h, x, v)) && ++k < 200);
        if (k >= 200) return 0;
        a[x] = v;
    }
    return 1;
}

/* 山登り法の本体。戻り値は見つけた最高得点（見つからなければ -1） */
static int hill_search(hs_ctx *h, HS_RNG_T *rng, hs_stop_fn stop, void *user,
                       hs_report_fn report, void *ruser) {
    signed char cur[48], cand[48], best[48], work[48];
    int cs = -1, ct, gbest = -1, stall = 0, cnt = 0;
    int have = hs_start(h, rng, cur, work) ? 1 : 0;
    if (have) cs = hs_eval(h, cur, work, &ct);
    while (1) {
        if ((++cnt & 255) == 0 && stop(user)) break;
        if (!have || stall >= h->stall_max) {                 /* 別の出発点へ */
            if (gbest >= 0 && hs_rand(rng, 2)) {              /* 半分は最良案を少し崩して再出発 */
                memcpy(cur, best, 48);
                for (int k = 0; k < 4; k++) { memcpy(cand, cur, 48); if (hs_move(h, rng, cand)) memcpy(cur, cand, 48); }
                int t; cs = hs_eval(h, cur, work, &t);
                if (cs < 0) { memcpy(cur, best, 48); cs = gbest; }
            } else if (hs_start(h, rng, cur, work)) { int t; cs = hs_eval(h, cur, work, &t); }
            else { if (stop(user)) break; continue; }
            have = 1; stall = 0;
        }
        memcpy(cand, cur, 48);
        h->tried++;
        if (!hs_move(h, rng, cand)) { stall++; continue; }
        int t, s = hs_eval(h, cand, work, &t);
        if (s < 0) { stall++; continue; }                    /* 暴発する案は採用しない */
        if (s >= cs) {
            if (s > cs) stall = 0; else stall++;
            cs = s; memcpy(cur, cand, 48);
            if (s > gbest) { gbest = s; h->best_score = gbest; memcpy(best, cand, 48);
                if (report) { signed char col[48]; for (int i = 0; i < 48; i++) col[i] = cand[i] ? cand[i] : h->orig[i]; report(s, t, col, ruser); } }
        } else stall++;
    }
    return gbest;
}
#endif
