import os
CSS = """
:root{--paper:#F3F6F5;--surface:#fff;--ink:#1E2A2F;--ink-2:#55656B;--line:#D5DEDB;--line-2:#E6ECEA;--juniper:#2F6B57;--jw:#E3EFEA;--ochre:#C9952F;--ow:#F7EBCF;--oink:#5E4410;--sky:#4F7FA8;--rust:#B1452C;--rw:#F8E4DE}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Barlow,system-ui,sans-serif;font-size:16px;line-height:1.45}
h1{font-size:1.9rem;margin:0;font-weight:600;line-height:1.15}h2{font-size:1.15rem;margin:0 0 .6rem;font-weight:600}h3{margin:0;font-size:1rem}p{margin:0}
.muted{color:var(--ink-2)}.small{font-size:.88rem}
.shell{display:grid;grid-template-columns:216px 1fr;min-height:100vh}
.rail{background:#fff;border-right:1px solid var(--line);padding:1.25rem .75rem;display:flex;flex-direction:column;gap:.25rem}
.brand{font-weight:700;font-size:1.1rem;padding:0 .6rem 1.25rem}.brand b{color:var(--juniper)}
.rl{padding:.55rem .7rem;border-radius:6px;color:var(--ink-2);font-weight:500;min-height:44px;display:flex;align-items:center}.rl.on{color:var(--juniper);background:var(--jw);font-weight:600}
.main{padding:2rem 2.5rem 4rem;min-width:0}.page{max-width:1180px;margin:0 auto}
.head{display:flex;justify-content:space-between;align-items:flex-end;gap:1rem;margin-bottom:1.25rem;flex-wrap:wrap}.head p{margin-top:.25rem}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 1rem;border-radius:6px;border:1px solid var(--juniper);background:var(--juniper);color:#fff;font-weight:600;font-size:1rem;font-family:inherit}
.btn.q{background:#fff;color:var(--ink);border-color:var(--line)}
.chip{display:inline-flex;align-items:center;gap:.4rem;min-height:44px;padding:0 .9rem;border:1px solid var(--line);background:#fff;border-radius:999px;font-size:.95rem}
.chip.on{background:var(--jw);border-color:var(--juniper);color:var(--juniper);font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem}
.tw{background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:.82rem;color:var(--ink-2);font-weight:600;padding:.7rem .9rem;border-bottom:1px solid var(--line);background:#FAFCFB}
td{padding:.75rem .9rem;border-bottom:1px solid var(--line-2);vertical-align:top}td.n{font-variant-numeric:tabular-nums}
.name{font-weight:600;overflow-wrap:anywhere;white-space:normal}
.pill{display:inline-block;padding:.12rem .55rem;border-radius:999px;font-size:.82rem;font-weight:600;background:var(--line-2);color:var(--ink-2)}
.st-active{background:var(--jw);color:var(--juniper)}.st-paused{background:var(--ow);color:var(--oink)}.st-ended{background:var(--line-2);color:var(--ink-2)}.st-draft{background:#E2ECF5;color:#2D5577}
.sample{display:inline-block;padding:.05rem .45rem;border-radius:4px;font-size:.75rem;font-weight:700;background:var(--ow);color:var(--oink);border:1px solid var(--ochre);margin-left:.3rem;vertical-align:middle}
.rate b{font-size:1.05rem}.rate .of{display:block;font-size:.85rem;color:var(--ink-2)}
.dir{display:inline-block;margin-top:.2rem;font-size:.78rem;font-weight:600;color:var(--oink);background:var(--ow);border-left:3px solid var(--ochre);padding:.05rem .4rem;border-radius:3px}
.cards{display:none}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:.9rem;margin-bottom:.75rem}
.card .top{display:flex;justify-content:space-between;gap:.5rem;align-items:flex-start}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem;margin-top:.7rem}
.tile{background:var(--paper);border-radius:8px;padding:.55rem .6rem}.tile .k{font-size:.8rem;color:var(--ink-2);font-weight:600}.tile .v{font-size:1.35rem;font-weight:700}.tile .of{font-size:.85rem;color:var(--ink-2)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.75rem;margin-bottom:1.25rem}
.tiles .tile{background:#fff;border:1px solid var(--line);padding:.8rem .9rem}
.sec{margin:1.5rem 0 .6rem}
.vars{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
.var{background:#fff;border:1px solid var(--line);border-radius:10px;padding:.9rem}
.var h3{display:flex;gap:.5rem;align-items:center}.badge{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:6px;background:var(--juniper);color:#fff;font-weight:700}
.row{display:flex;justify-content:space-between;gap:.75rem;padding:.5rem 0;border-top:1px solid var(--line-2)}.row:first-of-type{border-top:0}
.note{background:#fff;border:1px solid var(--line);border-left:4px solid var(--ochre);border-radius:6px;padding:.7rem .9rem;margin:.75rem 0}
.funnel{display:flex;flex-direction:column;gap:.45rem}.fbar{display:flex;align-items:center;gap:.6rem}.fbar .lbl{width:150px;flex:none}.fbar .bar{height:14px;background:var(--juniper);border-radius:3px}.fbar .bar.z{background:var(--line);width:4px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#fff}.seg span{min-height:44px;display:flex;align-items:center;padding:0 1rem;font-weight:600}.seg .on{background:var(--juniper);color:#fff}
.states{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-top:2rem}
.state{background:#fff;border:1px dashed var(--line);border-radius:10px;padding:1rem}.state .cap{font-size:.75rem;font-weight:700;letter-spacing:.06em;color:var(--ink-2);text-transform:uppercase;margin-bottom:.5rem}
.sk{height:14px;border-radius:4px;background:var(--line-2);margin:.45rem 0}
.err{background:var(--rw);color:var(--rust);border-radius:6px;padding:.7rem .9rem;display:flex;justify-content:space-between;gap:.75rem;align-items:center;flex-wrap:wrap}
.err .btn{background:#fff;color:var(--rust);border-color:var(--rust)}
.input{min-height:44px;padding:.45rem .7rem;border:1px solid var(--line);border-radius:6px;background:#fff;width:100%;font:inherit;display:flex;align-items:center;justify-content:space-between}
.field{margin-bottom:1rem}.field label{display:block;font-weight:600;margin-bottom:.3rem}.hint{font-size:.85rem;color:var(--ink-2);margin-top:.25rem}
.field.bad .input{border-color:var(--rust);border-width:2px}.ferr{color:var(--rust);font-size:.88rem;font-weight:600;margin-top:.25rem}
.types{display:flex;flex-wrap:wrap;gap:.5rem}
.toast{position:fixed;left:50%;bottom:1.5rem;transform:translateX(-50%);background:var(--ink);color:var(--paper);padding:.8rem 1.1rem;border-radius:6px;max-width:calc(100vw - 2rem);width:max-content;box-shadow:0 10px 30px rgba(30,42,47,.25);z-index:90}
.overlay{position:fixed;inset:0;background:rgba(20,28,31,.35);z-index:50;display:flex;justify-content:flex-end}
.drawer{width:520px;background:var(--paper);height:100%;overflow:auto;padding:1.4rem}
.sheet{background:#fff;border-radius:14px 14px 0 0;padding:.6rem 1rem 1.2rem;width:100%}
.grab{width:36px;height:4px;border-radius:999px;background:var(--line);margin:.35rem auto .7rem}
.opt{min-height:52px;display:flex;justify-content:space-between;align-items:center;gap:.75rem;padding:.5rem .2rem;border-bottom:1px solid var(--line-2)}.opt.on{color:var(--juniper);font-weight:600}
.radio{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);flex:none}.opt.on .radio{border:7px solid var(--juniper)}
.tabbar{display:none}
.lead{display:flex;justify-content:space-between;gap:.5rem}
@media (max-width:600px){
 .shell{display:block}.rail{display:none}.main{padding:1rem 1rem 6rem}h1{font-size:1.6rem}
 .tw.wide{display:none}.cards{display:block}
 .tiles{grid-template-columns:1fr 1fr;gap:.5rem}.vars{grid-template-columns:1fr 1fr;gap:.5rem}.var{padding:.7rem}
 .states{grid-template-columns:1fr}
 .tabbar{display:flex;position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid var(--line);z-index:40}
 .tabbar span{flex:1;min-height:56px;display:grid;place-items:center;font-size:.8rem;color:var(--ink-2)}.tabbar .on{color:var(--juniper);font-weight:600}
 .overlay{align-items:flex-end}.drawer{width:100%;height:auto;max-height:100%;border-radius:14px 14px 0 0}
 .fbar .lbl{width:118px}
 .head .btn{width:100%}
}
@media (min-width:601px){.overlay.m-only{display:none}.toast{left:240px;transform:none;max-width:calc(100% - 520px - 260px)}}
"""
RAIL='<nav class="rail"><div class="brand">Flow<b>Forward</b></div>'+''.join(f'<div class="rl{" on" if x==ON else ""}">{x}</div>' for x in [])+'%s</nav>'
def rail(on): return '<nav class="rail"><div class="brand">Flow<b>Forward</b></div>'+''.join(f'<div class="rl{" on" if x==on else ""}">{x}</div>' for x in ["Today","Leads","Pipeline","Campaigns","Proposals","Projects","Settings"])+'</nav>'
def tab(on): return '<nav class="tabbar">'+''.join(f'<span class="{"on" if x==on else ""}">{x}</span>' for x in ["Today","Leads","Pipeline","Campaigns","More"])+'</nav>'
def page(on,body,extra=""): return f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>{CSS}</style></head><body><div class="shell">{rail(on)}<main class="main"><div class="page">{body}</div></main></div>{tab(on)}{extra}</body></html>'
def rate(k,n,d,small=True):
    pct = f"{k/d*100:.1f}".rstrip('0').rstrip('.')+'%' if d else '—'
    s = f'<div class="rate"><b>{pct}</b><span class="of">{k} of {d} {n}</span>'
    if d<30 and small: s+='<span class="dir">Directional (n&lt;30)</span>'
    return s+'</div>'
camps=[("TEST: HVAC-Oct","Email","active","Sep 24 – Oct 31",8,8,3,2,1),
       ("TEST: Proto-Oct furnace-tune-up estimate follow-up demo link","Prototype link","active","Oct 3 – Nov 15",1,1,0,0,0),
       ("TEST: Plumbing-Sep walk-ins","In person","ended","Sep 2 – Sep 30",0,0,0,0,0),
       ("TEST: HVAC-Nov","Email","draft","Nov 3 – not set",0,0,0,0,0)]
def lst():
    rows=''.join(f'<tr><td><div class="name">{c[0]}</div><span class="sample">Sample</span></td><td>{c[1]}</td><td><span class="pill st-{c[2]}">{c[2].title()}</span></td><td class="small">{c[3]}</td><td class="n">{c[4]}</td><td class="n">{c[5]}</td>'+(''.join(f'<td>{rate(k,w,c[5])}</td>' for k,w in [(c[6],"replied"),(c[7],"booked"),(c[8],"won")]) if c[5] else '<td colspan="3" class="muted small">No touches logged</td>')+'</tr>' for c in camps)
    cards=''.join(f'<div class="card"><div class="top"><div><div class="name">{c[0]}</div><span class="sample">Sample</span></div><span class="pill st-{c[2]}">{c[2].title()}</span></div><p class="muted small" style="margin-top:.3rem">{c[1]} · {c[3]} · {c[4]} enrolled · {c[5]} touched</p>'+(f'<div class="grid3">'+''.join(f'<div class="tile"><div class="k">{w.title()}</div>{rate(k,w,c[5])}</div>' for k,w in [(c[6],"replied"),(c[7],"booked"),(c[8],"won")])+'</div>' if c[5] else '<p class="muted small" style="margin-top:.5rem">No touches logged</p>')+'</div>' for c in camps)
    b=f'''<header class="head"><div><h1>Campaigns</h1><p class="muted">Observed results of your own outreach. FlowForward never sends from here.</p></div><button class="btn">New campaign</button></header>
<div class="chips"><span class="chip on">All</span><span class="chip">Active</span><span class="chip">Paused</span><span class="chip">Ended</span><span class="chip">Draft</span><span class="chip">Sep 24 – Oct 16 ▾</span></div>
<div class="tw wide"><table><tr><th>Campaign</th><th>Channel</th><th>Status</th><th>Dates</th><th>Enrolled</th><th>Touched</th><th>Replied</th><th>Booked</th><th>Won</th></tr>{rows}</table></div>
<div class="cards">{cards}</div>
<p class="muted small" style="margin-top:.75rem">Rates use leads touched as the denominator. Booked and won use last-touch attribution, 90-day window.</p>
<div class="states"><div class="state"><div class="cap">Empty state</div><h3>No campaigns yet</h3><p class="muted small" style="margin:.3rem 0 .7rem">Create one to start tracking replies and booked calls from your outreach.</p><button class="btn">New campaign</button></div>
<div class="state"><div class="cap">Loading state</div><div class="sk" style="width:70%"></div><div class="sk"></div><div class="sk" style="width:85%"></div><div class="sk" style="width:60%"></div><p class="muted small">Loading campaigns…</p></div>
<div class="state"><div class="cap">Error state</div><div class="err"><span>Couldn't load campaigns. Check your connection.</span><button class="btn">Retry</button></div></div></div>'''
    return page("Campaigns",b)
def detail():
    t=lambda k,v,of: f'<div class="tile"><div class="k">{k}</div><div class="v">{v}</div><div class="of">{of}</div></div>'
    var=lambda L,hook,r,b,w: f'<div class="var"><h3><span class="badge">{L}</span>Variant {L}</h3><p class="muted small" style="margin:.3rem 0 .5rem">{hook}</p><div class="row"><span>Touched</span><b>4</b></div><div class="row"><span>Replied</span>{rate(r,"replied",4,False)}</div><div class="row"><span>Booked</span>{rate(b,"booked",4,False)}</div><div class="row"><span>Won</span>{rate(w,"won",4,False)}</div><span class="dir">Directional (n&lt;30)</span></div>'
    fb=lambda l,n,mx: f'<div class="fbar"><span class="lbl">{l}</span>'+(f'<span class="bar" style="width:{n/mx*55}%"></span>' if n else '<span class="bar z"></span>')+f'<b>{n}</b></div>'
    leads=[("TEST: Cedar Lane HVAC","A","Won · Oct 14"),("TEST: Juniper Ridge Heating & Air","A","Replied · Sep 28"),("TEST: Bonneville Furnace and Air Conditioning Service Co.","B","Call booked · Oct 2"),("TEST: Wasatch Comfort HVAC","B","Sent · Sep 24")]
    ll=''.join(f'<div class="opt"><div><div class="name">{n}</div><span class="sample">Sample</span> <span class="muted small">Variant {v}</span></div><span class="muted small" style="text-align:right">{s}</span></div>' for n,v,s in leads)
    b=f'''<p class="muted small" style="min-height:44px;display:flex;align-items:center">‹ Campaigns</p>
<header class="head"><div><h1 style="overflow-wrap:anywhere">TEST: HVAC-Oct <span class="sample">Sample</span></h1><p class="muted">Email · <span class="pill st-active">Active</span> · Sep 24 – Oct 31 · Segment hvac</p></div><button class="btn q">Edit</button></header>
<div class="tiles">{t("Enrolled","8","leads")}{t("Touched","8","leads")}{t("Reply rate","37.5%","3 of 8 replied")}{t("Booked rate","25%","2 of 8 booked")}{t("Win rate","12.5%","1 of 8 won")}{t("Median time to first reply","4 days","96 h, n = 3 replied")}{t("Cost per lead","$7.50","$60 of 8 enrolled")}{t("Cost per booked call","$30","$60 of 2 booked")}{t("Recorded revenue","$1,500","1 won deal, recorded")}</div>
<div class="note"><b>Small sample.</b> Every rate here has fewer than 30 touched leads, so it's directional. No winner is shown until each variant reaches 30.</div>
<h2 class="sec">Variants</h2><div class="vars">{var("A","Hook: “Free estimate follow-up, 3 emails”",2,1,1)}{var("B","Hook: “Missed-call text-back demo”",1,1,0)}</div>
<h2 class="sec">Funnel</h2><div class="var funnel">{fb("Sent",8,8)}{fb("Replied",3,8)}{fb("Call booked",2,8)}{fb("Won",1,8)}<p class="muted small">Counts of leads, observed.</p></div>
<h2 class="sec">Leads (8)</h2><div class="var">{ll}<p class="muted small" style="padding-top:.5rem">Showing 4 of 8 · Show all</p></div>'''
    return page("Campaigns",b)
def channels():
    ch=[("Email","1 campaign",8,3,2,1),("Prototype link","1 campaign",1,0,0,0),("Phone","0 campaigns",0,0,0,0)]
    rows=''.join(f'<tr><td class="name">{c[0]}<div class="muted small" style="font-weight:400">{c[1]}</div></td><td class="n">{c[2]}</td>'+(''.join(f'<td>{rate(k,w,c[2])}</td>' for k,w in [(c[3],"replied"),(c[4],"booked"),(c[5],"won")]) if c[2] else '<td colspan="3" class="muted small">No touches logged</td>')+'</tr>' for c in ch)
    cards=''.join(f'<div class="card"><div class="top"><div class="name">{c[0]}</div><span class="muted small">{c[2]} touched</span></div><p class="muted small">{c[1]}</p>'+(f'<div class="grid3">'+''.join(f'<div class="tile"><div class="k">{w.title()}</div>{rate(k,w,c[2])}</div>' for k,w in [(c[3],"replied"),(c[4],"booked"),(c[5],"won")])+'</div>' if c[2] else '<p class="muted small" style="margin-top:.4rem">No touches logged</p>')+'</div>' for c in ch)
    b=f'''<header class="head"><div><h1>Channels</h1><p class="muted">Which channel the conversion credit went to. One channel per conversion.</p></div></header>
<div class="chips" style="align-items:center"><div class="seg" role="radiogroup" aria-label="Attribution model"><span class="on">Last touch</span><span>First touch</span></div><span class="chip">Sep 24 – Oct 16 ▾</span></div>
<div class="tw wide"><table><tr><th>Channel</th><th>Touched</th><th>Replied</th><th>Booked</th><th>Won</th></tr>{rows}<tr><td class="name">Unattributed<div class="muted small" style="font-weight:400">no single campaign match</div></td><td class="n">—</td><td class="muted">—</td><td>0 booked</td><td>0 won</td></tr></table></div>
<div class="cards">{cards}<div class="card"><div class="name">Unattributed</div><p class="muted small">0 booked · 0 won</p></div></div>
<p class="muted small" style="margin-top:.75rem">Touched counts every channel a lead was touched on, so a lead can appear in two rows. Booked and won credit exactly one channel, chosen by the model above, within 90 days.</p>'''
    return page("Campaigns",b)
leadsd=[("TEST: Cedar Lane HVAC","Salt Lake City","801-555-0101","TEST: HVAC-Oct · A","Won"),("TEST: Juniper Ridge Heating & Air","Provo","801-555-0102","TEST: HVAC-Oct · A","Responded"),("TEST: Bonneville Furnace and Air Conditioning Service Co.","Ogden","801-555-0105","TEST: HVAC-Oct · B","Qualified"),("TEST: Wasatch Comfort HVAC","Sandy","801-555-0108","TEST: HVAC-Oct · B","Contacted")]
def leads():
    rows=''.join(f'<tr><td><div class="name">{n}</div><span class="sample">Sample</span></td><td>{c}</td><td>{p}</td><td class="small">{cp}</td><td><span class="pill">{s}</span></td></tr>' for n,c,p,cp,s in leadsd)
    cards=''.join(f'<div class="card"><div class="name">{n}</div><span class="sample">Sample</span><p class="muted small" style="margin-top:.25rem">{c} · {p} · {s}</p><p class="small" style="margin-top:.2rem">Campaign: {cp}</p></div>' for n,c,p,cp,s in leadsd)
    b=f'''<header class="head"><div><h1>Leads</h1><p class="muted">4 match, ranked by fit for your business</p></div></header>
<div class="chips"><span class="input" style="flex:1 1 260px;color:var(--ink-2)">Search company, contact or phone</span></div>
<div class="chips"><span class="chip on">Campaign: TEST: HVAC-Oct ✕</span><span class="chip">Filters · 1</span><span class="chip q wide-only">All open ▾</span></div>
<div class="tw wide"><table><tr><th>Company</th><th>City</th><th>Phone</th><th>Campaign</th><th>Stage</th></tr>{rows}</table></div>
<div class="cards">{cards}</div>
<p class="muted small" style="margin-top:.75rem">Pipeline uses the same Campaign chip and sheet; cards show the campaign line under the company name.</p>'''
    sheet='''<div class="overlay m-only"><div class="sheet"><div class="grab"></div><div class="lead"><h2>Campaign</h2><span class="btn q" style="min-height:44px">Done</span></div>
<div class="opt"><span>Any campaign</span><span class="radio"></span></div>
<div class="opt on"><span class="name">TEST: HVAC-Oct</span><span class="radio"></span></div>
<div class="opt"><span class="name">TEST: Proto-Oct furnace-tune-up estimate follow-up demo link</span><span class="radio"></span></div>
<div class="opt"><span class="name">TEST: Plumbing-Sep walk-ins</span><span class="radio"></span></div>
<div class="opt"><span>Not in any campaign</span><span class="radio"></span></div></div></div>'''
    return page("Leads",b,sheet)
def logtouch():
    types=["Sent","Opened","Replied","Call logged","Call booked","Proposal sent","Won","Lost","MVP sold","Estimate recovered"]
    tb=''.join(f'<span class="chip{" on" if x=="Replied" else ""}">{x}</span>' for x in types)
    bg='<header class="head"><div><h1>Leads</h1></div></header>'+''.join(f'<div class="card"><div class="name">{n}</div></div>' for n,*_ in leadsd)
    d=f'''<div class="overlay"><div class="drawer"><div class="lead"><div><p class="muted small">Log touch for</p><h2 style="overflow-wrap:anywhere">TEST: Juniper Ridge Heating &amp; Air <span class="sample">Sample</span></h2></div><span class="btn q" style="width:44px;padding:0">✕</span></div>
<p class="small" style="background:#fff;border:1px solid var(--line);border-radius:6px;padding:.6rem .8rem;margin-bottom:1rem">Records what you already did. Nothing is sent.</p>
<div class="field"><label>Type *</label><div class="types">{tb}</div></div>
<div class="field"><label>Campaign</label><div class="input"><span>TEST: HVAC-Oct</span>▾</div><div class="hint">Enrolled campaigns first. “No campaign” is allowed.</div></div>
<div class="field"><label>Variant</label><div class="input"><span>A · Free estimate follow-up</span>▾</div><div class="hint">Pre-filled from enrollment.</div></div>
<div class="field"><label>Channel</label><div class="input"><span>Email (campaign default)</span>▾</div><div class="hint">Opened is offered only when Channel is Email.</div></div>
<div class="field"><label>When *</label><div class="input"><span>Oct 16, 2026 11:18 AM</span></div><div class="hint">Defaults to now. Change it if you're logging later.</div></div>
<p class="muted small" style="margin-bottom:1rem">Notes go in Activity, not here.</p>
<div class="state" style="margin-bottom:1rem"><div class="cap">Validation example</div><div class="field bad" style="margin:0"><label>When *</label><div class="input"><span>Oct 17, 2026 9:30 AM</span></div><div class="ferr">Can't be in the future.</div></div></div>
<div style="display:flex;gap:.5rem"><span class="btn" style="flex:1">Log touch</span><span class="btn q">Cancel</span></div></div></div>
<div class="toast" style="top:1rem;bottom:auto"><b>After save, drawer closes:</b> Logged: Replied · TEST: HVAC-Oct · A. Nothing was sent. <u>Undo</u></div>'''
    return page("Leads",bg,d)
CSS2 = """
.approx{display:inline-block;font-size:.75rem;font-weight:700;color:#2D5577;background:#E2ECF5;border-radius:4px;padding:.05rem .4rem;margin-left:.25rem;vertical-align:middle}
.info{display:inline-grid;place-items:center;width:44px;height:44px;margin:-12px -10px -12px -6px;border:0;background:none;color:#2D5577;font-weight:700;font-size:1rem;vertical-align:middle}
.info span{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;border:1.5px solid #2D5577;font-size:.8rem}
.hl{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-bottom:1rem}
.hl .tile{background:#fff;border:1px solid var(--line);padding:.8rem .9rem;border-top:3px solid var(--juniper)}
.hl .tile.op{border-top-color:#4F7FA8}
.tog{display:inline-flex;align-items:center;gap:.6rem;min-height:44px;padding:0 .9rem;border:1px solid var(--line);border-radius:999px;background:#fff;font-size:.95rem}
.sw{width:40px;height:24px;border-radius:999px;background:#8A989C;position:relative;flex:none}.sw:after{content:"";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#fff}
.tip{background:var(--ink);color:var(--paper);border-radius:8px;padding:.8rem .95rem;font-size:.88rem;line-height:1.4;margin:.25rem 0 1rem;max-width:560px}
.tip b{color:#fff}.tip ul{margin:.35rem 0 0;padding-left:1.1rem}
.foot{margin-top:.75rem}th.cn{min-width:210px}td.dt{min-width:96px}
.sub{font-size:.85rem;color:var(--ink-2);font-weight:600;margin:1.25rem 0 .5rem}
@media (max-width:600px){.hl{grid-template-columns:1fr}.tog{width:100%;justify-content:space-between}}
"""
CSS += CSS2
OPLBL='Opened, no response<span class="approx">Approximate</span><button class="info" aria-label="About open counts"><span>i</span></button>'
TIP='''<div class="tip" role="tooltip"><b>Approximate, unreliable (Apple MPP).</b> Opens are a soft signal and never count toward attribution or conversion.<ul><li>Apple Mail Privacy Protection prefetches images, so opens are inflated. Those are flagged as machine opens and excluded by default.</li><li>Gmail's image proxy usually shows only the first open.</li><li>Blocked images and plain-text clients undercount opens.</li></ul></div>'''
TOG='<span class="tog"><span>Include machine opens</span><span class="sw" role="switch" aria-checked="false"></span></span>'
BASE='Touched = leads with at least one Sent or Call logged touch in the range.'
def foot(model=True):
    s=f'<p class="muted small foot">{BASE} Opens: likely-human only (machine opens excluded). Opens are display-only and never used in attribution or conversion.'
    if model: s+=' Booked uses last-touch attribution, 90-day window.'
    return s+'</p>'
# (name, channel, status, dates, enrolled, touched, responded, converted, opened_no_resp, booked)
camps2=[("TEST: HVAC-Oct","Email","active","Sep 24 – Oct 31",8,8,3,1,1,2),
       ("TEST: Proto-Oct furnace-tune-up estimate follow-up demo link","Prototype link","active","Oct 3 – Nov 15",1,0,0,0,0,0),
       ("TEST: Plumbing-Sep walk-ins","In person","ended","Sep 2 – Sep 30",0,0,0,0,0,0),
       ("TEST: HVAC-Nov","Email","draft","Nov 3 – not set",0,0,0,0,0,0)]
# List sort (campaigns.md §2): Active first, then newest start date; same rule inside the non-active group.
_MON={m:i for i,m in enumerate(["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],1)}
def _start(c):
    mon,day=c[3].split(" – ")[0].split()
    return (_MON[mon],int(day))
camps2=sorted(camps2,key=lambda c:(c[2]!="active",tuple(-x for x in _start(c))))
NT=lambda c: 'No sent or call-logged touches yet. 1 prototype view is tracked but isn\'t a touch for these rates.' if c[4] else 'No touches logged'
def hcells(c,d,email=True):
    return [(c[0],"responded"),(c[1],"converted"),(c[2] if email else None,"opened, no reply"),(c[3],"booked")]
def lst():
    hc=lambda a,b,e: hcells(a,b,e)[:3]
    def cell(k,w,d): return '<td class="muted small">Email only</td>' if k is None else f'<td>{rate(k,w,d)}</td>'
    rows=''
    for c in camps2:
        em=c[1]=="Email"
        rows+=f'<tr><td><div class="name">{c[0]}</div><span class="sample">Sample</span></td><td>{c[1]}</td><td><span class="pill st-{c[2]}">{c[2].title()}</span></td><td class="small dt">{c[3]}</td><td class="n">{c[4]}</td><td class="n">{c[5]}</td>'
        rows+=(''.join(cell(k,w,c[5]) for k,w in hc(c[6:],c[5],em)) if c[5] else f'<td colspan="3" class="muted small">{NT(c)}</td>')+'</tr>'
    cards=''
    for c in camps2:
        em=c[1]=="Email"
        cards+=f'<div class="card"><div class="top"><div><div class="name">{c[0]}</div><span class="sample">Sample</span></div><span class="pill st-{c[2]}">{c[2].title()}</span></div><p class="muted small" style="margin-top:.3rem">{c[1]} · {c[3]} · {c[4]} enrolled · {c[5]} touched</p>'
        if c[5]:
            cards+='<div class="grid3" style="grid-template-columns:1fr 1fr">'+''.join(f'<div class="tile"><div class="k">{lbl}</div>{rate(k,w,c[5])}</div>' for (k,w),lbl in zip(hc(c[6:],c[5],em),["Responded","Converted to project",'Opened, no response <span class="approx">Approximate</span><button class="info" aria-label="About open counts"><span>i</span></button>',"Booked"]) if k is not None)+'</div>'
        else: cards+=f'<p class="muted small" style="margin-top:.5rem">{NT(c)}</p>'
        cards+='</div>'
    b=f'''<header class="head"><div><h1>Campaigns</h1><p class="muted">Observed results of your own outreach. FlowForward never sends from here.</p></div><button class="btn">New campaign</button></header>
<div class="chips"><span class="chip on">All</span><span class="chip">Active</span><span class="chip">Paused</span><span class="chip">Ended</span><span class="chip">Draft</span><span class="chip">Sep 24 – Oct 16 ▾</span>{TOG}</div>
<div class="tw wide"><table><tr><th class="cn">Campaign</th><th>Channel</th><th>Status</th><th>Dates</th><th>Enrolled</th><th>Touched</th><th>Responded</th><th>Converted to project</th><th>{OPLBL}</th></tr>{rows}</table></div>
<div class="cards">{cards}</div>
{foot(False)}
<div class="states"><div class="state"><div class="cap">Empty state</div><h3>No campaigns yet</h3><p class="muted small" style="margin:.3rem 0 .7rem">Create one to start tracking replies and booked calls from your outreach.</p><button class="btn">New campaign</button></div>
<div class="state"><div class="cap">Loading state</div><div class="sk" style="width:70%"></div><div class="sk"></div><div class="sk" style="width:85%"></div><div class="sk" style="width:60%"></div><p class="muted small">Loading campaigns…</p></div>
<div class="state"><div class="cap">Error state</div><div class="err"><span>Couldn't load campaigns. Check your connection.</span><button class="btn">Retry</button></div></div></div>'''
    return page("Campaigns",b)
def detail():
    t=lambda k,v,of: f'<div class="tile"><div class="k">{k}</div><div class="v">{v}</div><div class="of">{of}</div></div>'
    h=lambda k,kk,d,noun,cls="": f'<div class="tile {cls}"><div class="k">{k}</div>{rate(kk,noun,d)}</div>'
    def var(L,hook,r,c,o,b):
        return f'''<div class="var"><h3><span class="badge">{L}</span>Variant {L}</h3><p class="muted small" style="margin:.3rem 0 .5rem">{hook}</p><div class="row"><span>Touched</span><b>4</b></div><div class="row"><span>Responded</span>{rate(r,"responded",4,False)}</div><div class="row"><span>Converted to project</span>{rate(c,"converted",4,False)}</div><div class="row"><span>Opened, no response <span class="approx">Approximate</span></span>{rate(o,"opened, no reply",4,False)}</div><div class="row"><span>Booked</span>{rate(b,"booked",4,False)}</div><span class="dir">Directional (n&lt;30)</span></div>'''
    fb=lambda l,n,mx: f'<div class="fbar"><span class="lbl">{l}</span>'+(f'<span class="bar" style="width:{n/mx*55}%"></span>' if n else '<span class="bar z"></span>')+f'<b>{n}</b></div>'
    leads=[("TEST: Cedar Lane HVAC","A","MVP sold · Oct 14"),("TEST: Juniper Ridge Heating & Air","A","Replied · Sep 28"),("TEST: Bonneville Furnace and Air Conditioning Service Co.","B","Call booked · Oct 2"),("TEST: Wasatch Comfort HVAC","B","Sent · Sep 24")]
    ll=''.join(f'<div class="opt"><div><div class="name">{n}</div><span class="sample">Sample</span> <span class="muted small">Variant {v}</span></div><span class="muted small" style="text-align:right">{s}</span></div>' for n,v,s in leads)
    b=f'''<p class="muted small" style="min-height:44px;display:flex;align-items:center">‹ Campaigns</p>
<header class="head"><div><h1 style="overflow-wrap:anywhere">TEST: HVAC-Oct <span class="sample">Sample</span></h1><p class="muted">Email · <span class="pill st-active">Active</span> · Sep 24 – Oct 31 · Segment hvac</p></div><button class="btn q">Edit</button></header>
<div class="chips" style="align-items:center"><span class="chip">Sep 24 – Oct 16 ▾</span>{TOG}</div>
<div class="hl">{h("Responded",3,8,"responded")}{h("Converted to project",1,8,"converted")}<div class="tile op"><div class="k">{OPLBL}</div>{rate(1,"opened, no reply",8)}</div></div>
{TIP}
<div class="note"><b>Small sample.</b> Every rate here has fewer than 30 touched leads, so it's directional. No winner is shown until each variant reaches 30.</div>
<h2 class="sec">Variants</h2><div class="vars">{var("A","Hook: “Free estimate follow-up, 3 emails”",2,1,1,1)}{var("B","Hook: “Missed-call text-back demo”",1,0,0,1)}</div>
<p class="sub">More metrics</p>
<div class="tiles">{t("Enrolled","8","leads")}{t("Touched","8","sent or call logged")}{t("Booked rate","25%","2 of 8 booked")}{t("Median time to first reply","4 days","96 h, n = 3 replied")}{t("Cost per lead","$7.50","$60 of 8 enrolled")}{t("Cost per booked call","$30","$60 of 2 booked")}{t("Recorded revenue","$1,500","1 MVP sale, recorded")}</div>
<h2 class="sec">Funnel</h2><div class="var funnel">{fb("Sent",8,8)}{fb("Responded",3,8)}{fb("Call booked",2,8)}{fb("Converted",1,8)}<p class="muted small">Counts of leads, observed. Opens aren't a funnel step.</p></div>
<h2 class="sec">Leads (8)</h2><div class="var">{ll}<p class="muted small" style="padding-top:.5rem">Showing 4 of 8 · Show all</p></div>
{foot()}'''
    return page("Campaigns",b)
def channels():
    ch=[("Email","1 campaign",8,3,1,1,2,True),("Prototype link","1 campaign · 1 lead viewed (not a touch for these rates)",0,0,0,0,0,False),("Phone","0 campaigns",0,0,0,0,0,False)]
    def cells(c):
        out=[(c[3],"responded"),(c[4],"converted"),(c[5] if c[7] else None,"opened, no reply"),(c[6],"booked")]
        return out
    rows=''
    for c in ch:
        rows+=f'<tr><td class="name">{c[0]}<div class="muted small" style="font-weight:400">{c[1]}</div></td><td class="n">{c[2]}</td>'
        rows+=(''.join(('<td class="muted small">Email only</td>' if k is None else f'<td>{rate(k,w,c[2])}</td>') for k,w in cells(c)) if c[2] else '<td colspan="4" class="muted small">No touches logged</td>')+'</tr>'
    cards=''
    for c in ch:
        cards+=f'<div class="card"><div class="top"><div class="name">{c[0]}</div><span class="muted small">{c[2]} touched</span></div><p class="muted small">{c[1]}</p>'
        cards+=('<div class="grid3" style="grid-template-columns:1fr 1fr">'+''.join(f'<div class="tile"><div class="k">{l}</div>{rate(k,w,c[2])}</div>' for (k,w),l in zip(cells(c),["Responded","Converted to project",'Opened, no response <span class="approx">Approximate</span><button class="info" aria-label="About open counts"><span>i</span></button>',"Booked"]) if k is not None)+'</div>') if c[2] else '<p class="muted small" style="margin-top:.4rem">No touches logged</p>'
        cards+='</div>'
    b=f'''<header class="head"><div><h1>Channels</h1><p class="muted">Observed results per channel. Converted and booked credit one channel per conversion.</p></div></header>
<div class="chips" style="align-items:center"><div class="seg" role="radiogroup" aria-label="Attribution model"><span class="on">Last touch</span><span>First touch</span></div><span class="chip">Sep 24 – Oct 16 ▾</span>{TOG}</div>
<p class="muted small" style="margin:-.4rem 0 .9rem">Attribution uses sent, calls, replies, bookings, prototype views and clicks, and proposals. Opens are never used.</p>
<div class="tw wide"><table><tr><th>Channel</th><th>Touched</th><th>Responded</th><th>Converted to project</th><th>{OPLBL}</th><th>Booked</th></tr>{rows}<tr><td class="name">Unattributed<div class="muted small" style="font-weight:400">no single campaign match</div></td><td class="n">—</td><td class="muted">—</td><td>0 converted</td><td class="muted">—</td><td>0 booked</td></tr></table></div>
<div class="cards">{cards}<div class="card"><div class="name">Unattributed</div><p class="muted small">0 converted · 0 booked</p></div></div>
<p class="muted small foot">Responded credits the channel the reply came on; a lead touched on two channels can appear in two rows. Converted and booked credit exactly one channel, chosen by the model above, within 90 days.</p>
{foot(False)}'''
    return page("Campaigns",b)
for k,f in [("list",lst),("detail",detail),("channels",channels),("leads-filter",leads),("log-touch",logtouch)]:
    open(f"{k}.html","w").write(f())
