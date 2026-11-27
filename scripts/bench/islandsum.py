#!/usr/bin/env python3
# 島に分けて解く上限（tests/debug/islandBound.debug.test.ts の IB_OUT）をまとめる: python3 islandsum.py rows.jsonl
import json
import sys
from collections import defaultdict

rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
QS = ["orig", "5000k", "2500k", "1500k"]
QN = {"orig": "原画質", "5000k": "5Mbps", "2500k": "2.5Mbps", "1500k": "1.5Mbps"}


def pct(a, b):
    return f"{100 * a / b:.0f}%" if b else "-"


by = defaultdict(list)
for r in rows:
    by[(r["name"][:8], r["q"])].append(r)

print("本ごと（3 通りの圧縮の合計。今の流れの方式は ずらし 0・1・2 の順、a = 表の AND 版で完成・o = 今の方式に戻って完成・x = どちらも届かない）")
print()
print("| 動画 | 画質 | 今の流れ | 確定 | 確定の間違い（まとめた形 / 状態） | 上限 A（短い隙間でも切る） | 上限 B1 前向き 確定・間違い | 上限 B2 両端 確定・間違い | B3 始まりなし | 隙間 1 秒以上（中央 / 最大 秒） |")
print("|---|---|---|---|---|---|---|---|---|---|")
for q in QS:
    for v in sorted({k[0] for k in by}):
        rs = sorted(by.get((v, q), []), key=lambda r: r["shift"])
        if not rs:
            continue
        N = sum(r["n"] for r in rs)
        fl = [r.get("flow") for r in rs]
        meth = "".join("a" if f["method"] == "and" else ("o" if f["solved"] else "x") for f in fl if f)
        fok = sum(f["ok"] for f in fl if f)
        fw = sum(f["wrong"] for f in fl if f)
        fb = sum(f["wrongByState"] for f in fl if f)
        if "A" not in rs[0]:
            print(f"| {v} | {QN[q]} | {meth} | {pct(fok, N)} | {fw} / {fb} | - | - | - | - | - |")
            continue
        A = sum(r["A"]["ok"] for r in rs)
        As = sum(r["A"]["strict"] for r in rs)
        b1 = sum(r["B1"]["ok"] for r in rs)
        b1w = sum(r["B1"]["wrong"] for r in rs)
        b1b = sum(r["B1"]["byState"] for r in rs)
        b2 = sum(r["B2"]["ok"] for r in rs)
        b2w = sum(r["B2"]["wrong"] for r in rs)
        b2b = sum(r["B2"]["byState"] for r in rs)
        b3 = sum(r["B3"]["ok"] for r in rs)
        b3w = sum(r["B3"]["wrong"] for r in rs)
        gl = sum(r["gaps"]["long"] for r in rs) / len(rs)
        med = sorted(x for r in rs for x in r["gaps"]["lens"] if x >= 1000)
        md = f"{med[len(med) // 2] / 1000:.1f} / {med[-1] / 1000:.1f}" if med else "-"
        print(f"| {v} | {QN[q]} | {meth} | {pct(fok, N)} | {fw} / {fb} | {pct(A, N)}（{pct(As, N)}） | {pct(b1, N)}・{b1w} / {b1b} | {pct(b2, N)}・{b2w} / {b2b} | {pct(b3, N)}・{b3w} | {gl:.1f} 本（{md}） |")
print()
print("ビットレートごとの合計（7 本 × 3 通り）")
print()
print("| 画質 | 本 | ピース方式で完成 | 今の方式に戻った（うち完成） | 今の流れ 確定 | 確定の間違い（まとめた形 / 状態） | うち今の方式に戻った本から | 上限 A（短い隙間でも切る） | 上限 B1 前向き | B1 間違い | 上限 B2 両端 | B2 間違い | B3 始まりなし（間違って決まる） |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for q in QS:
    rs = [r for r in rows if r["q"] == q]
    if not rs:
        continue
    N = sum(r["n"] for r in rs)
    fl = [r["flow"] for r in rs if r.get("flow")]
    nand = sum(1 for f in fl if f["method"] == "and")
    nold = sum(1 for f in fl if f["method"] == "old")
    nolds = sum(1 for f in fl if f["method"] == "old" and f["solved"])
    fok = sum(f["ok"] for f in fl)
    fw = sum(f["wrong"] for f in fl)
    fb = sum(f["wrongByState"] for f in fl)
    ow = sum(f["wrong"] for f in fl if f["method"] == "old")
    ob = sum(f["wrongByState"] for f in fl if f["method"] == "old")
    ra = [r for r in rs if "A" in r]
    Na = sum(r["n"] for r in ra)
    s = lambda k, f: sum(r[k][f] for r in ra)
    print(f"| {QN[q]} | {len(rs)} | {nand} | {nold}（{nolds}） | {pct(fok, N)}（{fok}/{N}） | {fw} / {fb} | {ow} / {ob} | {pct(s('A', 'ok'), Na)}（{pct(s('A', 'strict'), Na)}） | {pct(s('B1', 'ok'), Na)} | {s('B1', 'wrong')} / {s('B1', 'byState')} | {pct(s('B2', 'ok'), Na)} | {s('B2', 'wrong')} / {s('B2', 'byState')} | {pct(s('B3', 'ok'), Na)}（{s('B3', 'wrong')}） |")
print()
print("隙間（ソルブの間で確かな見え方のない 0.3 秒より長い間。1 本あたり）")
print()
print("| 画質 | 隙間の数 | うち 1 秒以上 | 長さ 中央 / 最大（秒） | 1 秒以上の合計 / ソルブ（秒） | 原因（秒、1 本あたり）: 圧縮・回している・指・角度・画面の外 |")
print("|---|---|---|---|---|---|")
for q in QS:
    ra = [r for r in rows if r["q"] == q and "gaps" in r]
    if not ra:
        continue
    lens = sorted(x for r in ra for x in r["gaps"]["lens"])
    n = len(ra)
    cs = [r["cause"] for r in ra if "cause" in r]
    cause = "・".join(f"{sum(c[k] for c in cs) / max(1, len(cs)) / 1000:.1f}" for k in ["compress", "motion", "finger", "outside"]) if cs else "-"
    print(f"| {QN[q]} | {len(lens) / n:.1f} | {sum(r['gaps']['long'] for r in ra) / n:.1f} | {lens[len(lens) // 2] / 1000:.2f} / {lens[-1] / 1000:.2f} | {sum(r['gaps']['sumLong'] for r in ra) / n / 1000:.1f} / {sum(r['gaps']['solveMs'] for r in ra) / n / 1000:.1f} | {cause} |")
