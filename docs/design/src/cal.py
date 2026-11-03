h=open('head.inc').read(); side=open('side.inc').read()
R=70; START=10; HOURS=list(range(10,20))
masters=[('АК','Алина Ковалёва','Маникюр','from-rose-300 to-pink-600','86%'),('МС','Марина Соколова','Брови и ресницы','from-amber-300 to-orange-600','72%'),('ДВ','Денис Волков','Барбер','from-sky-300 to-indigo-600','91%'),('ЕЛ','Елена Лебедева','Массаж','from-emerald-300 to-teal-600','58%')]
C={'v':'bg-violet-500/15 border-violet-400 text-violet-100','r':'bg-rose-500/15 border-rose-400 text-rose-100','s':'bg-sky-500/15 border-sky-400 text-sky-100','e':'bg-emerald-500/15 border-emerald-400 text-emerald-100','a':'bg-amber-500/15 border-amber-400 text-amber-100'}
appts=[[(10,1.5,'Анна Смирнова','Маникюр + гель-лак','r',''),(12,1,'Ксения Орлова','Снятие + укрепление','r',''),(13,1.5,'Виктория Павлова','Маникюр с дизайном','v','AI'),(17,1,'Юлия Морозова','Коррекция покрытия','r',''),(18,1,'Ольга Белова','Покрытие гель-лак','r','')],
[(10.5,1,'Мария Кузнецова','Коррекция бровей','a',''),(12,1.5,'Полина Зайцева','Ламинирование ресниц','a',''),(14.5,1,'Дарья Фёдорова','Окрашивание бровей','a','AI'),(16,1.5,'Алёна Егорова','Брови «под ключ»','a','')],
[(10,1,'Игорь Петров','Мужская стрижка','s',''),(11,1,'Артём Новиков','Стрижка + борода','s',''),(12.5,0.75,'Максим Ильин','Оформление бороды','s',''),(14,1,'Сергей Лебедев','Мужская стрижка','s','AI'),(15,1,'Никита Попов','Стрижка машинкой','s',''),(16.5,1.5,'Роман Козлов','Камуфляж седины','s',''),(18.5,1,'Олег Семёнов','Стрижка + борода','s','')],
[(11,1.5,'Татьяна Волкова','Классический массаж','e',''),(14,2,'Наталья Соловьёва','SPA-программа','e',''),(17,1,'Ирина Васильева','Массаж спины','e','')]]
def fmt(t): return f"{int(t)}:{int(round((t%1)*60)):02d}"
cols=''
for (ini,name,role,g,load),ap in zip(masters,appts):
    blocks=''
    for st,d,cl,sv,c,tag in ap:
        top=(st-START)*R+2; hh=d*R-4
        ai='<span class="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-md accbg">✦ AI</span>' if tag else ''
        extra=f'<div class="text-[11px] opacity-70 mt-0.5 truncate">{sv}</div>' if d>=1 else ''
        ring=' ring-2 ring-acc/70 glow' if tag and ini=='АК' else ''
        blocks+=f'<div class="absolute left-1.5 right-1.5 rounded-xl border-l-[3px] px-2.5 py-1.5 overflow-hidden {C[c]}{ring}" style="top:{top}px;height:{hh}px"><div class="flex items-center gap-1 text-[11px] opacity-70">{fmt(st)}–{fmt(st+d)}{ai}</div><div class="text-[13px] font-semibold truncate">{cl}</div>{extra}</div>'
    cols+=f'<div class="flex-1 border-l border-line relative">{blocks}</div>'
heads=''.join(f'<div class="flex-1 flex items-center gap-2.5 px-3 border-l border-line"><div class="w-9 h-9 rounded-full bg-gradient-to-br {g} grid place-items-center text-[12px] font-semibold">{i}</div><div class="leading-tight min-w-0"><div class="text-[13px] font-semibold truncate">{n}</div><div class="text-[11px] text-muted">{r} · {l}</div></div></div>' for i,n,r,g,l in masters)
grid=''.join(f'<div class="absolute inset-x-0 border-t border-line/70" style="top:{(x-START)*R}px"></div>' for x in HOURS)
times=''.join(f'<div class="absolute right-2 text-[11px] text-muted -translate-y-1/2" style="top:{(x-START)*R}px">{x}:00</div>' for x in HOURS if x>START)
now=(13.6-START)*R
body=f'''<!doctype html><html><head>{h}</head><body class="bg-bg text-white"><div class="w-[1440px] h-[900px] flex overflow-hidden">{side}
<main class="flex-1 flex flex-col min-w-0">
<header class="h-16 border-b border-line flex items-center px-6 gap-3">
<div class="text-[20px] font-semibold tracking-tight whitespace-nowrap">Вторник, 10 ноября</div>
<div class="flex gap-1 ml-1"><span class="w-8 h-8 rounded-lg glass grid place-items-center text-muted">‹</span><span class="w-8 h-8 rounded-lg glass grid place-items-center text-muted">›</span></div>
<span class="px-3 h-8 rounded-lg glass grid place-items-center text-[13px] whitespace-nowrap">Сегодня</span>
<div class="ml-auto flex p-1 rounded-xl glass text-[13px]"><span class="px-3 py-1 rounded-lg bg-white/10 font-medium">День</span><span class="px-3 py-1 text-muted">Неделя</span><span class="px-3 py-1 text-muted">Месяц</span></div>
<div class="w-9 h-9 rounded-xl glass grid place-items-center text-muted">⌕</div>
<button class="h-9 px-4 rounded-xl accbg glow text-[13px] font-semibold whitespace-nowrap">+ Запись</button>
</header>
<div class="flex items-center gap-6 px-6 h-12 text-[13px] text-muted border-b border-line">
<span><b class="text-white font-semibold">19</b> записей</span><span><b class="text-white font-semibold">84 600 ₽</b> ожидаемая выручка</span><span><b class="text-white font-semibold">77%</b> загрузка</span><span class="flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-acc"></span><b class="text-white font-semibold">3</b> записи сделал AI</span></div>
<div class="flex h-14 border-b border-line"><div class="w-14 shrink-0"></div>{heads}</div>
<div class="flex flex-1 relative overflow-hidden">
<div class="w-14 shrink-0 relative">{times}</div>
<div class="flex flex-1 relative">{grid}{cols}
<div class="absolute inset-x-0 z-10" style="top:{now}px"><div class="h-px bg-acc"></div><div class="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-acc"></div></div></div>
<div class="absolute left-1 z-10 text-[10px] font-semibold text-acc -translate-y-1/2" style="top:{now}px">13:36</div>
</div></main>
<aside class="w-[340px] shrink-0 border-l border-line p-5 flex flex-col gap-4 bg-card/40">
<div class="flex items-center gap-2.5"><div class="w-8 h-8 rounded-xl accbg glow grid place-items-center">✦</div><div><div class="font-semibold text-[15px]">AI-ассистент</div><div class="text-[11px] text-emerald-400 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>Отвечает в Telegram и WhatsApp</div></div></div>
<div class="glass rounded-2xl p-4">
<div class="flex items-center gap-2 text-[12px] text-muted"><span class="w-5 h-5 rounded-full bg-sky-500 grid place-items-center text-[10px] text-white">✈</span>Telegram · Виктория Павлова · 2 мин назад</div>
<div class="mt-3 space-y-2 text-[13px]">
<div class="max-w-[85%] rounded-2xl rounded-tl-md bg-white/[.06] px-3 py-2">Здравствуйте! Можно на маникюр с дизайном сегодня днём?</div>
<div class="max-w-[88%] ml-auto rounded-2xl rounded-tr-md bg-acc/20 border border-acc/30 px-3 py-2">Добрый день, Виктория! У Алины свободно в 13:00 и 15:00. Как вам удобнее?</div>
<div class="max-w-[85%] rounded-2xl rounded-tl-md bg-white/[.06] px-3 py-2">Давайте в 13:00 🙌</div>
<div class="max-w-[88%] ml-auto rounded-2xl rounded-tr-md bg-acc/20 border border-acc/30 px-3 py-2">Готово! Записала вас к Алине на 13:00, 3 200 ₽. Напомню за 2 часа ✨</div>
</div>
<div class="mt-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 text-[12px] text-emerald-300 flex items-center gap-2">✓ Запись создана · Алина · 13:00–14:30</div>
</div>
<div class="glass rounded-2xl p-4">
<div class="text-[12px] uppercase tracking-[.12em] text-muted font-semibold">Сегодня AI</div>
<div class="grid grid-cols-3 gap-2 mt-3 text-center"><div><div class="text-[20px] font-semibold">27</div><div class="text-[11px] text-muted">диалогов</div></div><div><div class="text-[20px] font-semibold">3</div><div class="text-[11px] text-muted">записи</div></div><div><div class="text-[20px] font-semibold">1</div><div class="text-[11px] text-muted">перенос</div></div></div>
</div>
<div class="rounded-2xl p-4 border border-acc/30 bg-acc/10 text-[13px]"><div class="font-semibold">💡 У Алины свободно 15:00–17:00</div><div class="text-muted mt-1">Предложить его 5 клиенткам из листа ожидания?</div><div class="flex gap-2 mt-3"><span class="px-3 py-1.5 rounded-lg accbg font-semibold text-[12px]">Отправить</span><span class="px-3 py-1.5 rounded-lg glass text-[12px]">Позже</span></div></div>
</aside></div></body></html>'''
open('calendar.html','w').write(body)
