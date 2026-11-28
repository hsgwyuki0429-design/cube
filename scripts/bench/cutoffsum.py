import json,os,sys,statistics as st
BENCH=os.environ.get('BENCH','/home/user/bench')
def q(n): return 'real' if n.startswith('rec') else ('orig' if 'orig' in n else n.split('_')[3])
base={r['name']:r for r in map(json.loads,open(BENCH+'/pb/base.jsonl'))}
print("| 案 | 画質 | つながった | 正解と同じ | 確定の間違い（まとめた形 / 状態） | 推定 | つながった本の時間 中央 / 最大 | つながらない本の時間（戻る場合の上乗せ）中央 / 最大 | ベースからつながらなくなった |")
print("|---|---|---|---|---|---|---|---|---|")
for lab in sys.argv[1:]:
  rows=[json.loads(l) for l in open(f'{BENCH}/pb/{lab}.jsonl')]
  for qq in ['orig','5000k','2500k','1500k','real']:
    rs=[r for r in rows if q(r['name'])==qq]
    ok=[r for r in rs if r['solved']]; ng=[r for r in rs if not r['solved']]
    lost=[r['name'] for r in rs if base[r['name']]['solved'] and not r['solved']]
    f=lambda xs: f"{st.median(xs)/1000:.2f} / {max(xs)/1000:.2f} 秒" if xs else '-'
    print(f"| {lab} | {qq} | {len(ok)}/{len(rs)} | {sum(r['same'] for r in rs)} | {sum(r['wrongSure'] for r in ok)} / {sum(r['wrongByState'] for r in ok)} | {sum(r['inferred'] for r in ok)} | {f([r['ms'] for r in ok])} | {f([r['ms'] for r in ng])} | {', '.join(lost) or '-'} |")
