#!/usr/bin/env python3
# 今の方式だけ（本体の今の既定。piecesBench の PB_METHOD=old の行）と、ピース方式 → 今の方式（islandBound の今の流れ）を同じ材料で並べる
#   python3 islandold.py rows.jsonl old.jsonl
import json
import sys

rows = {r["name"]: r for r in (json.loads(l) for l in open(sys.argv[1]) if l.strip())}
old = {r["name"]: r for r in (json.loads(l) for l in open(sys.argv[2]) if l.strip())}
pct = lambda a, b: f"{100 * a / b:.0f}%" if b else "-"
print("| 画質 | 本 | 今の方式だけ: 完成 | 確定 | 確定の間違い（まとめた形 / 状態） | 推定 | 時間 中央 / 最大 | ピース方式 → 今の方式: 完成 | 確定 | 確定の間違い | 推定 | 時間 中央 / 最大 |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|")
for q, qn in [("orig", "原画質"), ("5000k", "5Mbps"), ("2500k", "2.5Mbps"), ("1500k", "1.5Mbps")]:
    ns = [n for n, r in rows.items() if r["q"] == q and n in old]
    N = sum(rows[n]["n"] for n in ns)
    o = [old[n] for n in ns]
    f = [rows[n]["flow"] for n in ns]
    ms = sorted(x["ms"] for x in o)
    fm = sorted(x["ms"] for x in f)
    print(
        f"| {qn} | {len(ns)} | {sum(x['solved'] for x in o)} | {pct(sum(x['okSure'] for x in o), N)} | {sum(x['wrongSure'] for x in o)} / {sum(x['wrongByState'] for x in o)} | {sum(x['inferred'] for x in o if x['solved'])} | {ms[len(ms) // 2] / 1000:.1f} / {ms[-1] / 1000:.1f} 秒 | {sum(x['solved'] for x in f)} | {pct(sum(x['ok'] for x in f), N)} | {sum(x['wrong'] for x in f)} / {sum(x['wrongByState'] for x in f)} | {sum(x['inferred'] for x in f)} | {fm[len(fm) // 2] / 1000:.1f} / {fm[-1] / 1000:.1f} 秒 |"
    )
