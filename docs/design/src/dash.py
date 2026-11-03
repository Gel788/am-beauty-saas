h=open('head.inc').read(); side=open('side2.inc').read()
vals=[62,58,71,66,74,80,69,77,84,79,88,92,85,85]
W,H=620,190; mx=110
pts=[(i*W/(len(vals)-1), H-(v/mx)*H) for i,v in enumerate(vals)]
line=' '.join(f'{x:.1f},{y:.1f}' for x,y in pts)
area=f'M0,{H} L'+' L'.join(f'{x:.1f},{y:.1f}' for x,y in pts)+f' L{W},{H} Z'
prev=[48,52,55,50,57,60,54,62,58,61,64,66,63,68]
pl=' '.join(f'{i*W/(len(prev)-1):.1f},{H-(v/mx)*H:.1f}' for i,v in enumerate(prev))
lx,ly=pts[-1]
days=['28 окт','','','31 окт','','','3 ноя','','','6 ноя','','','','10 ноя']
dl=''.join(f'<span>{d}</span>' for d in ['28 окт','31 окт','3 ноя','6 ноя','10 ноя'])
grid=''.join(f'<line x1="0" x2="{W}" y1="{H*k/4}" y2="{H*k/4}" stroke="#24242F" stroke-dasharray="3 5"/>' for k in range(4))
masters=[('АК','Алина Ковалёва','from-rose-300 to-pink-600',86,'31 200 ₽'),('ДВ','Денис Волков','from-sky-300 to-indigo-600',91,'24 800 ₽'),('МС','Марина Соколова','from-amber-300 to-orange-600',72,'18 400 ₽'),('ЕЛ','Елена Лебедева','from-emerald-300 to-teal-600',58,'10 200 ₽')]
ml=''.join(f'''<div class="flex items-center gap-3"><div class="w-9 h-9 rounded-full bg-gradient-to-br {g} grid place-items-center text-[12px] font-semibold shrink-0">{i}</div><div class="flex-1 min-w-0"><div class="flex justify-between text-[13px]"><span class="font-medium">{n}</span><span class="text-muted">{r}</span></div><div class="h-2 rounded-full bg-line mt-2"><div class="h-full rounded-full {"accbg" if l>=80 else "bg-white/30"}" style="width:{l}%"></div></div></div><div class="w-10 text-right text-[13px] font-semibold">{l}%</div></div>''' for i,n,g,l,r in masters)
def kpi(t,v,d,sub,up=True):
    return f'<div class="glass rounded-2xl p-5"><div class="text-[13px] text-muted">{t}</div><div class="text-[28px] font-semibold tracking-tight mt-2">{v}</div><div class="flex items-center gap-2 mt-2 text-[12px]"><span class="px-1.5 py-0.5 rounded-md {"bg-emerald-500/15 text-emerald-400" if up else "bg-rose-500/15 text-rose-400"} font-semibold">{d}</span><span class="text-muted">{sub}</span></div></div>'
k=kpi('Выручка сегодня','84 600 ₽','↑ 12%','vs прошлый вторник')+kpi('Выручка за ноябрь','812 400 ₽','↑ 18%','прогноз 2,4 млн ₽')+kpi('Записей сегодня','19','↑ 4','из них 3 через AI')+kpi('Отмены и неявки','2,1%','↓ 3,4 п.п.','AI-напоминания')
# retention donut
r=46; c=2*3.14159*r; ret=0.68
body=f'''<!doctype html><html><head>{h}</head><body class="bg-bg text-white"><div class="w-[1440px] h-[900px] flex overflow-hidden">{side}
<main class="flex-1 p-8 flex flex-col gap-6 min-w-0 relative">
<div class="absolute -top-32 right-40 w-96 h-96 rounded-full bg-acc2/15 blur-3xl pointer-events-none"></div>
<header class="flex items-center relative"><div><div class="text-[13px] text-muted">Добрый день, Ольга 👋</div><div class="text-[26px] font-semibold tracking-tight mt-0.5">Обзор студии</div></div>
<div class="ml-auto flex items-center gap-3"><div class="flex p-1 rounded-xl glass text-[13px]"><span class="px-3 py-1 text-muted">Сегодня</span><span class="px-3 py-1 text-muted">Неделя</span><span class="px-3 py-1 rounded-lg bg-white/10 font-medium">Месяц</span><span class="px-3 py-1 text-muted">Год</span></div><button class="h-9 px-4 rounded-xl glass text-[13px] font-medium">Экспорт</button></div></header>
<div class="grid grid-cols-4 gap-4 relative">{k}</div>
<div class="grid grid-cols-[1fr_380px] gap-4 flex-1 min-h-0 relative">
<div class="glass rounded-2xl p-6 flex flex-col">
<div class="flex items-start"><div><div class="text-[15px] font-semibold">Выручка по дням</div><div class="text-[12px] text-muted mt-1">Последние 14 дней, тыс. ₽</div></div>
<div class="ml-auto flex gap-4 text-[12px] text-muted"><span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-acc"></span>Этот период</span><span class="flex items-center gap-1.5"><span class="w-2.5 h-0.5 bg-white/30"></span>Прошлый</span></div></div>
<div class="mt-5 relative flex-1">
<svg viewBox="0 -10 {W} {H+10}" class="w-full h-[210px]" preserveAspectRatio="none">
<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8B5CF6" stop-opacity=".45"/><stop offset="1" stop-color="#8B5CF6" stop-opacity="0"/></linearGradient></defs>
{grid}<path d="{area}" fill="url(#g)"/><polyline points="{pl}" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2" stroke-dasharray="5 5" vector-effect="non-scaling-stroke"/>
<polyline points="{line}" fill="none" stroke="#A78BFA" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>
<div class="absolute right-0 top-0 -translate-y-2 rounded-xl bg-card2 border border-line px-3 py-2 text-[12px] shadow-xl"><div class="text-muted">10 ноября</div><div class="font-semibold text-[14px]">84 600 ₽</div></div>
<div class="flex justify-between text-[11px] text-muted mt-2">{dl}</div></div></div>
<div class="glass rounded-2xl p-6"><div class="flex items-center"><div class="text-[15px] font-semibold">Загрузка мастеров</div><span class="ml-auto text-[12px] text-muted">сегодня</span></div><div class="mt-5 space-y-5">{ml}</div></div>
</div>
<div class="grid grid-cols-[1fr_1fr_380px] gap-4 relative">
<div class="glass rounded-2xl p-6 flex items-center gap-5">
<svg width="112" height="112" viewBox="0 0 112 112"><circle cx="56" cy="56" r="{r}" stroke="#24242F" stroke-width="12" fill="none"/><circle cx="56" cy="56" r="{r}" stroke="url(#rg)" stroke-width="12" fill="none" stroke-linecap="round" stroke-dasharray="{c*ret:.1f} {c:.1f}" transform="rotate(-90 56 56)"/><defs><linearGradient id="rg"><stop offset="0" stop-color="#A78BFA"/><stop offset="1" stop-color="#7C5CF0"/></linearGradient></defs><text x="56" y="62" text-anchor="middle" fill="white" font-size="20" font-weight="600" font-family="Inter">68%</text></svg>
<div><div class="text-[15px] font-semibold">Возвращаемость</div><div class="text-[12px] text-muted mt-1 leading-relaxed">Пришли повторно за 60 дней</div><div class="text-[12px] mt-2"><span class="px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400 font-semibold">↑ 6%</span> <span class="text-muted">за месяц</span></div></div></div>
<div class="glass rounded-2xl p-6"><div class="text-[15px] font-semibold">Топ услуг</div><div class="mt-3 space-y-2.5 text-[13px]">
<div class="flex justify-between"><span>Маникюр с гель-лаком</span><span class="text-muted">142 · 340 тыс. ₽</span></div>
<div class="flex justify-between"><span>Мужская стрижка</span><span class="text-muted">118 · 212 тыс. ₽</span></div>
<div class="flex justify-between"><span>Брови «под ключ»</span><span class="text-muted">64 · 128 тыс. ₽</span></div></div></div>
<div class="rounded-2xl p-6 border border-acc/40 bg-gradient-to-br from-acc2/25 to-acc/5 relative overflow-hidden">
<div class="flex items-center gap-2"><span class="w-7 h-7 rounded-lg accbg grid place-items-center text-[13px]">✦</span><span class="text-[15px] font-semibold">AI-инсайты</span></div>
<div class="mt-3 space-y-2 text-[13px] text-white/85">
<div>• 23 клиентки не были больше 45 дней — запустить рассылку со скидкой 10%?</div>
<div>• В четверг 14:00–17:00 загрузка 34%. Поставьте «счастливые часы».</div></div>
<div class="flex gap-2 mt-3"><span class="px-3 py-1.5 rounded-lg accbg font-semibold text-[12px]">Запустить</span><span class="px-3 py-1.5 rounded-lg glass text-[12px]">Подробнее</span></div></div>
</div>
</main></div></body></html>'''
open('dashboard.html','w').write(body)
