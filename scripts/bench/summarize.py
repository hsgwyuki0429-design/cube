import json, sys, statistics
rows=[json.loads(l) for l in open(sys.argv[1])]
M=['old','new','and','prop']
LBL={'old':'今の解き直し','new':'v1','and':'表の AND 版','prop':'伝搬版'}
def cond(n): return n.split('_')[2]
CL={'orig':'原画質','5000k':'5Mbps','2500k':'2.5Mbps','1500k':'1.5Mbps'}
by={(r['name'],r['method']):r for r in rows}
names=sorted({r['name'] for r in rows}, key=lambda n:(n[:8],['orig','5000k','2500k','1500k'].index(cond(n))))
print("| 条件 | 方式（版） | 完成 | 正解と同じ | 確定で間違い（まとめた形 / 状態で照らす） | 推定 | 解き直し 最大 / 中央 | 最大メモリ |")
print("|---|---|---|---|---|---|---|---|")
for c in ['orig','5000k','2500k','1500k','all']:
  for m in M:
    rs=[by[(n,m)] for n in names if (n,m) in by and (c=='all' or cond(n)==c)]
    if not rs: continue
    ms=[r['ms']/1000 for r in rs]
    ver=rs[0].get('ver','')
    print(f"| {'計' if c=='all' else CL[c]} | {LBL[m]}（{ver}） | {sum(r['solved'] for r in rs)}/{len(rs)} | {sum(r['same'] for r in rs)}/{len(rs)} | {sum(r['wrongSure'] for r in rs)} / {sum(r['wrongByState'] for r in rs)} | {sum(r['inferred'] for r in rs)} | {max(ms):.1f} / {statistics.median(ms):.1f} 秒 | {max(r['memMB'] for r in rs)}MB |")
print()
print("| 動画 | 条件 | "+" | ".join(LBL[m] for m in M)+" |")
print("|---|---|"+"---|"*len(M))
def cell(r):
  if not r: return "-"
  s="○" if r['solved'] else "×"
  same="○" if r['same'] else (f"×({r['dist']})" if r['solved'] else "-")
  return f"{s} {same} {r['wrongSure']}/{r['wrongByState']} {r['inferred']} {r['ms']/1000:.1f}s {r['memMB']}MB"
for n in names:
  print(f"| {n[:8]} | {CL[cond(n)]} | "+" | ".join(cell(by.get((n,m))) for m in M)+" |")
print()
# 悪くなった本（伝搬版 vs 表の AND 版）
worse=[]
for n in names:
  a=by.get((n,'and')); p=by.get((n,'prop'))
  if not a or not p: continue
  bad=[]
  if a['solved'] and not p['solved']: bad.append('完成しなくなった')
  if a['same'] and not p['same']: bad.append('正解と違う')
  if p['wrongByState']>a['wrongByState']: bad.append(f"状態で照らす確定の間違い {a['wrongByState']}→{p['wrongByState']}")
  if p['wrongSure']>a['wrongSure']: bad.append(f"確定の間違い {a['wrongSure']}→{p['wrongSure']}")
  if p['inferred']>a['inferred']: bad.append(f"推定 {a['inferred']}→{p['inferred']}")
  if p['ms']>max(3000, 1.5*a['ms']): bad.append(f"時間 {a['ms']/1000:.1f}→{p['ms']/1000:.1f}s")
  if bad: worse.append(f"- {n}: "+"・".join(bad))
print("\n".join(worse) or "- なし")
print()
# 区間をまたぐ式
tot={'cross':0,'removed':0,'intervals':0,'sparse':0,'free':0,'capped_prop':0,'capped_and':0,'pruned':0, 'propms':[]}
for n in names:
  p=by.get((n,'prop')); a=by.get((n,'and'))
  if p and p.get('stats'):
    st=p['stats']; pr=st.get('prop',{})
    tot['cross']+=pr.get('crossNarrowed',0); tot['removed']+=pr.get('crossRemoved',0); tot['intervals']+=pr.get('intervals',0); tot['sparse']+=pr.get('sparse',0); tot['free']+=pr.get('free',0)
    tot['capped_prop']+=st.get('capped',0); tot['pruned']+=st.get('pruned',0); tot['propms'].append(pr.get('ms',0))
  if a and a.get('stats'): tot['capped_and']+=a['stats'].get('capped',0)
pm=tot.pop('propms')
print(json.dumps(tot, ensure_ascii=False), "伝搬の時間 中央", round(statistics.median(pm)) if pm else None, "最大", round(max(pm)) if pm else None)
