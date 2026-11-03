h=open('head.inc').read()
def side(active):
    items=[('◷','Календарь'),('▦','Дашборд'),('☺','Клиенты'),('✦','AI-ассистент'),('✂','Услуги'),('♟','Мастера'),('₽','Финансы'),('⚙','Настройки')]
    li=''.join(f'<div class="flex items-center gap-3 px-3 h-10 rounded-xl text-[14px] {"bg-white/[.06] text-white font-medium" if n==active else "text-muted"}"><span class="w-5 text-center {"text-acc" if n==active else ""}">{i}</span>{n}{"<span class=\"ml-auto text-[11px] px-1.5 rounded-md bg-acc/20 text-acc\">3</span>" if n=="AI-ассистент" else ""}</div>' for i,n in items)
    return f'''<aside class="w-[232px] shrink-0 border-r border-line p-4 flex flex-col">
<div class="flex items-center gap-2.5 px-2 h-10"><div class="w-8 h-8 rounded-xl accbg glow grid place-items-center font-extrabold">G</div><span class="font-bold text-[18px] tracking-tight">Glow</span></div>
<div class="mt-5 glass rounded-xl px-3 py-2.5 flex items-center gap-2.5"><div class="w-7 h-7 rounded-lg bg-gradient-to-br from-rose-300 to-pink-600 grid place-items-center text-[12px] font-semibold">Л</div><div class="leading-tight min-w-0"><div class="text-[13px] font-medium whitespace-nowrap">Студия «Лаванда»</div><div class="text-[11px] text-muted">ул. Садовая, 14</div></div><span class="ml-auto text-muted text-xs">⌄</span></div>
<nav class="mt-5 space-y-1">{li}</nav>
<div class="mt-auto rounded-2xl p-4 border border-acc/30 bg-acc/10"><div class="text-[13px] font-semibold">Тариф «Про»</div><div class="text-[12px] text-muted mt-1">AI ответил на 142 сообщения за неделю</div><div class="h-1.5 rounded-full bg-line mt-3"><div class="h-full w-2/3 rounded-full accbg"></div></div></div>
<div class="flex items-center gap-2.5 mt-4 px-1"><div class="w-8 h-8 rounded-full bg-gradient-to-br from-amber-300 to-orange-600 grid place-items-center text-[12px] font-semibold">ОВ</div><div class="leading-tight"><div class="text-[13px] font-medium">Ольга Воронова</div><div class="text-[11px] text-muted">Владелец</div></div></div>
</aside>'''
open('side.inc','w').write(side('Календарь')); open('side2.inc','w').write(side('Дашборд'))
