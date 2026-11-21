# 1b の表: 画面全体 / 1280 から切り出し / 元の解像度から切り出し × 5・2.5・1.5Mbps、方式ごと。3 通りの圧縮（ずらし 0・1・2）の多数決と平均
import json, statistics, sys
rows=[json.loads(l) for l in open('' + (__import__('os').environ.get('BENCH','/home/user/bench') + '/cropmat/rows.jsonl') + '')]
by={}
for r in rows:
    v,mode,b,s=r['name'].split('_')[0]+'_'+r['name'].split('_')[1], r['name'].split('_')[2], r['name'].split('_')[3], r['name'].split('_')[4]
    by.setdefault((mode,b,r['method']),{}).setdefault(v,[]).append(r)
ML={'full':'画面全体 1280','crop1280':'1280 から切り出し','croporig':'元の解像度から切り出し'}
BL={'5000k':'5Mbps','2500k':'2.5Mbps','1500k':'1.5Mbps'}
XL={'old':'今の方式','and':'表の AND 版'}
print("| 方式 | 画質 | 録り方 | 完成（多数決 / 3 通りの合計） | 正解と同じ（多数決 / 合計） | 確定の間違い 平均（まとめた形 / 状態で照らす） | 推定 平均 | 解き直し 中央 / 最大 |")
print("|---|---|---|---|---|---|---|---|")
for m in ['old','and']:
  for b in ['5000k','2500k','1500k']:
    for mode in ['full','crop1280','croporig']:
      d=by.get((mode,b,m),{})
      if not d: continue
      allr=[r for v in d.values() for r in v]
      maj=lambda key: sum(1 for v in d.values() if sum(r[key] for r in v)*2>len(v))
      ms=[r['ms']/1000 for r in allr]
      print(f"| {XL[m]} | {BL[b]} | {ML[mode]} | {maj('solved')}/{len(d)}（{sum(r['solved'] for r in allr)}/{len(allr)}） | {maj('same')}/{len(d)}（{sum(r['same'] for r in allr)}/{len(allr)}） | {sum(r['wrongSure'] for r in allr)/3:.1f} / {sum(r['wrongByState'] for r in allr)/3:.1f} | {sum(r['inferred'] for r in allr)/3:.1f} | {statistics.median(ms):.1f} / {max(ms):.1f} 秒 |")
if len(sys.argv)>1:
  print()
  print("| 動画 | 画質 | 方式 | 画面全体（3 通り） | 1280 から切り出し | 元の解像度から切り出し |")
  print("|---|---|---|---|---|---|")
  vids=sorted({v for d in by.values() for v in d})
  for v in vids:
    for b in ['5000k','2500k','1500k']:
      for m in ['old','and']:
        cells=[]
        for mode in ['full','crop1280','croporig']:
          rs=sorted(by.get((mode,b,m),{}).get(v,[]), key=lambda r:r['name'])
          cells.append(' '.join(('○' if r['same'] else ('△' if r['solved'] else '×'))+(f"{r['wrongSure']}" if r['wrongSure'] else '') for r in rs))
        print(f"| {v} | {BL[b]} | {XL[m]} | "+" | ".join(cells)+" |")
