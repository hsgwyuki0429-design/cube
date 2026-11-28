import json,sys,statistics as st
rows=[json.loads(l) for l in open(sys.argv[1])]
Q=['orig','5000k','2500k','1500k']
QN={'orig':'原画質','5000k':'5Mbps','2500k':'2.5Mbps','1500k':'1.5Mbps'}
def agg(rs):
  n=len(rs); solved=sum(r['solved'] for r in rs); same=sum(r['same'] for r in rs)
  ok=sum(r['okSure'] for r in rs); want=sum(r['n'] for r in rs)
  ws=sum(r['wrongSure'] for r in rs); wb=sum(r['wrongByState'] for r in rs); inf=sum(r['inferred'] for r in rs if r['solved'])
  an={k:sum(r['analysis']==k for r in rs) for k in ['done','partial','failed']}
  te=[abs(r['timeErr']) for r in rs if r['timeErr'] is not None]
  ms=[r['ms'] for r in rs]
  fb=sum(1 for r in rs if r['method']=='and' and r['used']!='pieces')
  return dict(n=n,solved=solved,same=same,sure=100*ok/want if want else 0,ok=ok,want=want,ws=ws,wb=wb,inf=inf,an=an,
    te_med=st.median(te) if te else None, te_max=max(te) if te else None, te_over=sum(1 for x in te if x>100),
    ms_med=st.median(ms)/1000, ms_max=max(ms)/1000, fb=fb)
def line(label,m,a):
  ten='-' if a['te_med'] is None else f"{a['te_med']:.0f} / {a['te_max']:.0f}ms（100ms 超 {a['te_over']}）"
  return f"| {label} | {m} | {a['n']} | {a['solved']} | {a['same']} | {a['sure']:.0f}%（{a['ok']}/{a['want']}） | {a['ws']} / {a['wb']} | {a['inf']} | {a['an']['done']} / {a['an']['partial']} / {a['an']['failed']} | {ten} | {a['ms_med']:.1f} / {a['ms_max']:.1f} 秒 |" + (f" {a['fb']} |" if m=='and' else " - |")
print("| 画質 | 方法 | 本 | 完成 | 正解と同じ | 確定 | 確定の間違い（まとめた形 / 状態） | 推定 | done / 一部推定 / 速報値 | タイムの誤差 中央 / 最大（done） | 解き直し 中央 / 最大 | 今の方式に戻った |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|")
for q in Q+['計']:
  for m in ['old','and']:
    rs=[r for r in rows if r['method']==m and (q=='計' or r['quality']==q)]
    if rs: print(line(QN.get(q,q),m,agg(rs)))
print()
# 本ごとに違うところ
by={}
for r in rows: by.setdefault(r['name'],{})[r['method']]=r
for nm,d in sorted(by.items()):
  if 'old' not in d or 'and' not in d: continue
  o,a=d['old'],d['and']
  def s(r): return f"{'○' if r['solved'] else '×'}{'○' if r['same'] else '×'} {r['wrongSure']}/{r['wrongByState']} 推定{r['inferred']} {r['analysis']} {r['timeErr'] if r['timeErr'] is not None else '-'}ms {r['ms']/1000:.1f}s"
  print(f"{nm:26s} old: {s(o):40s} and({a['used']}): {s(a)}")
