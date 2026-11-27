#!/usr/bin/env python3
# 島に分けて解く上限: ピース方式がつながらずに今の方式に戻った本だけで比べる（python3 islandfb.py rows.jsonl）。
# 「島の流れ」= ピース方式が完成した本はそのまま、戻った本は上限 B2（島の両端を正解から与えた解き直し）に置き換えたもの
import json
import sys

rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
pct = lambda a, b: f"{100 * a / b:.0f}%" if b else "-"
print("| 画質 | 戻った本 | その手 | 今の流れ 確定 | 間違い（まとめた形 / 状態） | 上限 A | 上限 B1 確定・間違い | 上限 B2 確定・間違い | 全体: 今の流れ → 島の流れ（間違い） |")
print("|---|---|---|---|---|---|---|---|---|")
for q, qn in [("5000k", "5Mbps"), ("2500k", "2.5Mbps"), ("1500k", "1.5Mbps")]:
    rs = [r for r in rows if r["q"] == q]
    N = sum(r["n"] for r in rs)
    fb = [r for r in rs if not r["flow"]["andSolved"]]
    Nf = sum(r["n"] for r in fb)
    s = lambda k, f, xs=fb: sum(r[k][f] for r in xs)
    whole = sum(r["flow"]["ok"] for r in rs)
    isl = sum(r["flow"]["ok"] if r["flow"]["andSolved"] else r["B2"]["ok"] for r in rs)
    iw = sum(r["flow"]["wrong"] if r["flow"]["andSolved"] else r["B2"]["wrong"] for r in rs)
    ib = sum(r["flow"]["wrongByState"] if r["flow"]["andSolved"] else r["B2"]["byState"] for r in rs)
    print(f"| {qn} | {len(fb)} | {Nf} | {pct(s('flow', 'ok'), Nf)} | {s('flow', 'wrong')} / {s('flow', 'wrongByState')} | {pct(s('A', 'ok'), Nf)} | {pct(s('B1', 'ok'), Nf)}・{s('B1', 'wrong')} / {s('B1', 'byState')} | {pct(s('B2', 'ok'), Nf)}・{s('B2', 'wrong')} / {s('B2', 'byState')} | {pct(whole, N)} → {pct(isl, N)}（{s('flow', 'wrong', rs)} / {s('flow', 'wrongByState', rs)} → {iw} / {ib}） |")
print()
for r in rows:
    if r["q"] != "orig" and not r["flow"]["andSolved"]:
        f = r["flow"]
        print(f"  {r['name']}: 今の方式 {'完成' if f['solved'] else '届かない'} 確定 {f['ok']}/{r['n']} 間違い {f['wrong']}/{f['wrongByState']}・A {r['A']['ok']}・B2 確定 {r['B2']['ok']} 間違い {r['B2']['wrong']}/{r['B2']['byState']} 推定 {r['B2']['inferred']} つながらない島 {r['B2']['failed']}/{r['B2']['islands']}")
