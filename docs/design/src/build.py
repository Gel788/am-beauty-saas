HEAD='''<meta charset="utf-8">
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Unbounded:wght@400;500;600;700&family=Playfair+Display:ital,wght@1,500;1,600;1,700&display=swap" rel="stylesheet">
<script>tailwind.config={theme:{extend:{fontFamily:{sans:['Inter','sans-serif'],display:['Unbounded','sans-serif'],serif:['Playfair Display','serif']},colors:{bg:'#FBF8F6',ink:'#1A1523',muted:'#7B7385',line:'#EEE7E3',acc:'#7C3AED'}}}}</script>
<style>
body{font-family:Inter,sans-serif;-webkit-font-smoothing:antialiased;color:#1A1523;background:#FBF8F6}
.font-display{letter-spacing:-.02em}
.glass{background:rgba(255,255,255,.62);backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%);border:1px solid rgba(255,255,255,.85);box-shadow:0 1px 1px rgba(60,30,90,.03),0 4px 10px -4px rgba(60,30,90,.06),0 24px 48px -24px rgba(90,40,140,.18)}
.solid{background:#fff;border:1px solid #F1EAE6;box-shadow:0 1px 2px rgba(60,30,90,.04),0 12px 32px -16px rgba(90,40,140,.16)}
.grad{background:linear-gradient(120deg,#7C3AED 0%,#C026D3 55%,#F472B6 100%)}
.gradtext{background:linear-gradient(100deg,#6D28D9,#DB2777 60%,#F97316);-webkit-background-clip:text;background-clip:text;color:transparent}
.cta{box-shadow:0 14px 30px -10px rgba(192,38,211,.55),inset 0 1px 0 rgba(255,255,255,.35)}
.blob{position:absolute;border-radius:9999px;filter:blur(70px);pointer-events:none}
.ic{width:18px;height:18px;stroke-width:1.8}
.orb{border-radius:9999px;background:radial-gradient(circle at 32% 28%,#fff 0,#FBCFE8 14%,#E879F9 34%,#A855F7 58%,#6D28D9 82%,#4C1D95 100%);box-shadow:0 0 0 1px rgba(255,255,255,.6) inset,0 6px 18px -4px rgba(192,38,211,.55),0 0 28px -6px rgba(244,114,182,.7)}
.mono{background:linear-gradient(145deg,#2A1B3D,#1A1523);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 10px 24px -10px rgba(76,29,149,.6)}
.mono span{background:linear-gradient(100deg,#E9D5FF,#F9A8D4 50%,#FDBA74);-webkit-background-clip:text;background-clip:text;color:transparent}
.grain{position:absolute;inset:0;pointer-events:none;z-index:60;opacity:.07;mix-blend-mode:multiply;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .55 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")}
</style>'''
AUR='''<div class="blob" style="width:520px;height:520px;background:#DDD0FF;top:-180px;left:-120px;opacity:.9"></div>
<div class="blob" style="width:480px;height:480px;background:#FFD3E6;top:-140px;right:-80px;opacity:.9"></div>
<div class="blob" style="width:520px;height:420px;background:#FFE1C7;bottom:-200px;right:220px;opacity:.85"></div>
<div class="blob" style="width:360px;height:360px;background:#E9DDFF;bottom:-140px;left:200px;opacity:.7"></div>'''
END='<div class="grain"></div><script>lucide.createIcons({attrs:{"stroke-width":1.8}});</script></body></html>'
def MONO(sz=36,fs=17,r=12): return f'<div class="mono grid place-items-center shrink-0" style="width:{sz}px;height:{sz}px;border-radius:{r}px"><span class="font-serif italic font-semibold leading-none" style="font-size:{fs}px;margin-top:-2px">Am</span></div>'
def WORD(fs=19,col='text-ink'): return f'<div class="flex items-baseline gap-1.5 {col} leading-none"><span class="font-serif italic font-semibold" style="font-size:{fs*1.25:.0f}px">Am</span><span class="font-display font-medium uppercase" style="font-size:{fs*.62:.0f}px;letter-spacing:.32em">Beauty</span></div>'
def ORB(sz=28): return f'<span class="orb inline-block shrink-0" style="width:{sz}px;height:{sz}px"></span>'
def I(n,c='ic'): return f'<i data-lucide="{n}" class="{c}"></i>'
M=[('img/alina.jpg','Алина Ковалёва','Алина','Маникюр',86,'31 200 ₽','5.0'),('img/marina.jpg','Марина Соколова','Марина','Брови и ресницы',72,'18 400 ₽','4.9'),('img/denis.jpg','Денис Волков','Денис','Барбер',91,'24 800 ₽','4.9'),('img/elena.jpg','Елена Лебедева','Елена','Массаж',58,'10 200 ₽','4.8')]
OWNER='img/olga.jpg'

# ---------------- BOOKING ----------------
masters=''
for i,(img,full,n,role,l,r,rt) in enumerate(M):
    sel=i==0
    masters+=f'''<div class="w-[76px] text-center shrink-0"><div class="relative w-[54px] h-[54px] mx-auto rounded-full {'p-[2.5px] grad' if sel else 'p-[2.5px] bg-white'}" style="box-shadow:0 8px 18px -8px rgba(90,40,140,.35)"><img src="{img}" class="w-full h-full rounded-full object-cover border-2 border-white">{'<span class="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full grad grid place-items-center border-2 border-white text-white">'+I('check','w-3 h-3')+'</span>' if sel else ''}</div>
<div class="text-[13px] mt-1.5 {'font-semibold' if sel else 'font-medium text-ink/75'}">{n}</div><div class="text-[11px] text-muted flex items-center justify-center gap-0.5">{I('star','w-3 h-3 fill-amber-400 text-amber-400')}{rt}</div></div>'''
days=[('Пн','9',''),('Вт','10','sel'),('Ср','11',''),('Чт','12',''),('Пт','13',''),('Сб','14','off')]
dh=''.join(f'''<div class="rounded-2xl py-2 text-center {'grad text-white cta' if s=='sel' else ('opacity-40' if s=='off' else 'solid')}"><div class="text-[11px] {'text-white/80' if s=='sel' else 'text-muted'}">{a}</div><div class="font-display text-[16px] font-semibold mt-0.5 {'line-through' if s=='off' else ''}">{b}</div></div>''' for a,b,s in days)
slots=[('11:30',''),('13:00','sel'),('14:30',''),('16:00','')]
sh=''.join(f'''<div class="rounded-xl py-2.5 text-center text-[14px] {'bg-ink text-white font-semibold' if s=='sel' else ('text-ink/30 line-through bg-white/50 border border-white' if s=='off' else 'solid font-medium')}">{t}</div>''' for t,s in slots)
booking=f'''<!doctype html><html><head>{HEAD}</head><body>
<div class="w-[390px] h-[844px] overflow-hidden relative bg-bg">
<div class="blob" style="width:300px;height:300px;background:#FFE1C7;bottom:60px;right:-120px;opacity:.8"></div>
<div class="blob" style="width:280px;height:280px;background:#E5D9FF;top:330px;left:-140px;opacity:.9"></div>
<div class="relative h-[244px]">
 <img src="img/salon.jpg" class="absolute inset-0 w-full h-full object-cover" style="object-position:50% 60%">
 <div class="absolute inset-0" style="background:linear-gradient(180deg,rgba(26,21,35,.35) 0%,rgba(26,21,35,.05) 30%,rgba(60,20,90,.55) 70%,rgba(26,21,35,.85) 100%)"></div>
 <div class="relative px-5 pt-3.5 flex justify-between text-[14px] font-semibold text-white"><span>9:41</span><span class="flex gap-1.5 items-center">{I('signal','w-4 h-4')}{I('wifi','w-4 h-4')}{I('battery-full','w-5 h-5')}</span></div>
 <div class="relative px-5 mt-3 flex justify-between">
  <span class="w-10 h-10 rounded-full bg-white/25 backdrop-blur-md border border-white/40 grid place-items-center text-white">{I('chevron-left')}</span>
  <div class="flex gap-2"><span class="w-10 h-10 rounded-full bg-white/25 backdrop-blur-md border border-white/40 grid place-items-center text-white">{I('share')}</span><span class="w-10 h-10 rounded-full bg-white/25 backdrop-blur-md border border-white/40 grid place-items-center text-white">{I('heart')}</span></div>
 </div>
 <div class="absolute left-5 right-5 bottom-8 text-white">
  <div class="flex items-center gap-3">{MONO(48,22,15)}<div>{WORD(26,'text-white')}<div class="text-[11px] text-white/75 mt-1.5 uppercase tracking-[.22em] font-medium">Бьюти-студия · с 2019</div></div></div>
  <div class="flex items-center gap-2 mt-3.5 text-[12px]">
   <span class="flex items-center gap-1 px-2 py-1 rounded-full bg-white/25 backdrop-blur-md border border-white/30 font-semibold">{I('star','w-3.5 h-3.5 fill-amber-300 text-amber-300')}4.9</span>
   <span class="flex -space-x-1.5"><img src="img/vika.jpg" class="w-5 h-5 rounded-full border border-white object-cover"><img src="img/igor.jpg" class="w-5 h-5 rounded-full border border-white object-cover"><img src="img/marina.jpg" class="w-5 h-5 rounded-full border border-white object-cover"></span>
   <span class="text-white/90">312 отзывов</span><span class="text-white/60">·</span><span class="text-white/90 flex items-center gap-1">{I('map-pin','w-3.5 h-3.5')}Садовая, 14</span>
  </div>
 </div>
</div>
<div class="relative -mt-6 rounded-t-[28px] bg-bg/70 backdrop-blur-xl px-5 pt-4">
 <div class="relative rounded-[22px] p-[1.5px] grad cta">
  <div class="rounded-[21px] bg-white/95 p-3 flex items-center gap-3">
   <img src="img/alina.jpg" class="w-12 h-12 rounded-2xl object-cover">
   <div class="flex-1 min-w-0"><div class="text-[11px] font-semibold gradtext flex items-center gap-1">{ORB(13)}AI подобрал для вас</div>
   <div class="text-[14px] font-semibold mt-0.5">Алина · Вт, 13:00</div><div class="text-[12px] text-muted">Как в прошлый раз</div></div>
   <span class="px-3.5 h-9 rounded-xl bg-ink text-white text-[13px] font-semibold grid place-items-center">Выбрать</span>
  </div>
 </div>
 <div class="flex gap-2 mt-4 text-[13px] font-medium">
  <span class="px-3.5 py-1.5 rounded-full bg-ink text-white">Маникюр</span><span class="px-3.5 py-1.5 rounded-full solid text-ink/70">Брови</span><span class="px-3.5 py-1.5 rounded-full solid text-ink/70">Стрижка</span><span class="px-3.5 py-1.5 rounded-full solid text-ink/70">Массаж</span>
 </div>
 <div class="mt-2.5 rounded-2xl solid px-3 py-2.5 flex items-center gap-3" style="border-color:#D9C8FF">
  <span class="w-10 h-10 rounded-xl bg-violet-50 grid place-items-center text-acc">{I('hand')}</span>
  <div class="flex-1"><div class="font-semibold text-[14px]">Маникюр с гель-лаком</div><div class="text-[12px] text-muted flex items-center gap-1">{I('clock','w-3 h-3')}1 ч 30 мин</div></div>
  <span class="font-display font-semibold text-[15px] whitespace-nowrap">2 400 ₽</span>
 </div>
 <div class="mt-3.5 flex items-center justify-between"><div class="font-display text-[15px] font-semibold">Мастер</div><div class="text-[12px] text-acc font-medium">Любой свободный</div></div>
 <div class="flex justify-between mt-2.5">{masters}</div>
 <div class="grid grid-cols-6 gap-2 mt-3">{dh}</div>
 <div class="grid grid-cols-4 gap-2 mt-2">{sh}</div>
</div>
<div class="absolute bottom-0 inset-x-0 px-5 pb-6 pt-3 bg-white/70 backdrop-blur-2xl border-t border-white" style="box-shadow:0 -12px 30px -18px rgba(90,40,140,.25)">
 <button class="w-full h-[58px] rounded-2xl grad cta text-white flex items-center px-5">
  <div class="text-left"><div class="text-[11px] text-white/80">Вт, 10 ноября · 13:00 · Алина</div><div class="font-semibold text-[16px]">Записаться</div></div>
  <span class="ml-auto font-display font-semibold text-[16px]">2 400 ₽</span><span class="ml-3 w-8 h-8 rounded-full bg-white/20 grid place-items-center">{I('arrow-right','w-4 h-4')}</span></button>
 <div class="text-center text-[11px] text-muted mt-2 flex items-center justify-center gap-1">{I('send','w-3 h-3')}Напомним в Telegram за 2 часа</div>
</div>
</div>{END}'''
open('booking.html','w').write(booking)

# ---------------- SIDEBAR ----------------
def side(active):
    items=[('calendar-days','Календарь'),('layout-dashboard','Дашборд'),('users','Клиенты'),('sparkles','AI-ассистент'),('scissors','Услуги'),('contact','Мастера'),('wallet','Финансы'),('settings','Настройки')]
    li=''
    for ic,n in items:
        a=n==active
        badge='<span class="ml-auto flex items-center gap-1.5 text-[11px] font-semibold text-acc"><span class="orb" style="width:8px;height:8px"></span>3</span>' if n=='AI-ассистент' else ''
        li+=f'<div class="flex items-center gap-3 px-3 h-10 rounded-xl text-[14px] {"bg-white solid font-semibold text-ink" if a else "text-ink/60"}">{I(ic,"ic "+("text-acc" if a else ""))}{n}{badge}</div>'
    return f'''<aside class="w-[236px] shrink-0 p-4 flex flex-col relative z-10">
<div class="flex items-center gap-3 px-2 h-11">{MONO(38,18,12)}{WORD(17)}</div>
<div class="mt-5 glass rounded-2xl p-2.5 flex items-center gap-2.5"><img src="img/salon.jpg" class="w-9 h-9 rounded-xl object-cover"><div class="leading-tight min-w-0"><div class="text-[13px] font-semibold whitespace-nowrap">Am Beauty · Садовая</div><div class="text-[11px] text-muted">Филиал 1 из 2</div></div><span class="ml-auto text-muted">{I('chevrons-up-down','w-4 h-4')}</span></div>
<nav class="mt-5 space-y-1">{li}</nav>
<div class="mt-auto rounded-2xl p-4 relative overflow-hidden glass"><div class="blob" style="width:160px;height:160px;background:#F9C9E3;top:-60px;right:-60px;filter:blur(40px)"></div><div class="relative flex items-center gap-2 text-[13px] font-semibold">{ORB(16)}AI на этой неделе</div><div class="relative font-display text-[22px] font-semibold mt-1.5">142 <span class="text-[12px] font-sans font-medium text-muted">ответа</span></div><div class="relative text-[12px] text-muted">≈ 11 часов администратора</div></div>
<div class="flex items-center gap-2.5 mt-4 px-1"><img src="{OWNER}" class="w-9 h-9 rounded-full object-cover border-2 border-white"><div class="leading-tight"><div class="text-[13px] font-semibold">Ольга Воронова</div><div class="text-[11px] text-muted">Владелец</div></div><span class="ml-auto text-muted">{I('log-out','w-4 h-4')}</span></div>
</aside>'''

# ---------------- CALENDAR ----------------
R=70; START=10
G={'r':('from-rose-100 to-pink-50','border-rose-400','text-rose-950','text-rose-700/70'),'a':('from-amber-100 to-orange-50','border-amber-400','text-amber-950','text-amber-800/70'),'s':('from-sky-100 to-indigo-50','border-sky-400','text-sky-950','text-sky-800/70'),'e':('from-emerald-100 to-teal-50','border-emerald-400','text-emerald-950','text-emerald-800/70')}
appts=[[(10,1.5,'Анна Смирнова','Маникюр + гель-лак','r',0),(12,1,'Ксения Орлова','Снятие + укрепление','r',0),(13,1.5,'Виктория Павлова','Маникюр с дизайном','r',1),(17,1,'Юлия Морозова','Коррекция покрытия','r',0),(18,1,'Ольга Белова','Покрытие гель-лак','r',0)],
[(10.5,1,'Мария Кузнецова','Коррекция бровей','a',0),(12,1.5,'Полина Зайцева','Ламинирование ресниц','a',0),(14.5,1,'Дарья Фёдорова','Окрашивание бровей','a',1),(16,1.5,'Алёна Егорова','Брови «под ключ»','a',0)],
[(10,1,'Игорь Петров','Мужская стрижка','s',0),(11,1,'Артём Новиков','Стрижка + борода','s',0),(12.5,0.75,'Максим Ильин','Оформление бороды','s',0),(14,1,'Сергей Лебедев','Мужская стрижка','s',1),(15,1,'Никита Попов','Стрижка машинкой','s',0),(16.5,1.5,'Роман Козлов','Камуфляж седины','s',0),(18.5,1,'Олег Семёнов','Стрижка + борода','s',0)],
[(11,1.5,'Татьяна Волкова','Классический массаж','e',0),(14,2,'Наталья Соловьёва','SPA-программа','e',0),(17,1,'Ирина Васильева','Массаж спины','e',0)]]
def fm(t): return f"{int(t)}:{int(round((t%1)*60)):02d}"
cols=''
for ap in appts:
    b=''
    for st,d,cl,sv,c,ai in ap:
        g,bd,tx,sub=G[c]; top=(st-START)*R+3; hh=d*R-6
        badge=f'<span class="ml-auto flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-md grad text-white">{I("sparkles","w-2.5 h-2.5")}AI</span>' if ai else ''
        ex=f'<div class="text-[11px] {sub} mt-0.5 truncate">{sv}</div>' if d>=1 else ''
        hl=' ring-2 ring-fuchsia-400/60' if ai and c=='r' else ''
        b+=f'<div class="absolute left-1.5 right-1.5 rounded-2xl border-l-[3px] {bd} bg-gradient-to-br {g} px-3 py-2 overflow-hidden{hl}" style="top:{top}px;height:{hh}px;box-shadow:0 6px 16px -10px rgba(90,40,140,.25)"><div class="flex items-center text-[11px] {sub} font-medium">{fm(st)}–{fm(st+d)}{badge}</div><div class="text-[13px] font-semibold {tx} truncate">{cl}</div>{ex}</div>'
    cols+=f'<div class="flex-1 border-l border-ink/[.06] relative">{b}</div>'
heads=''.join(f'<div class="flex-1 flex items-center gap-2.5 px-3"><div class="relative"><img src="{img}" class="w-9 h-9 rounded-full object-cover border-2 border-white" style="box-shadow:0 4px 10px -4px rgba(90,40,140,.35)"><span class="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-white"></span></div><div class="leading-tight min-w-0 flex-1"><div class="text-[13px] font-semibold truncate">{full}</div><div class="flex items-center gap-1.5 mt-1"><div class="h-1 w-12 rounded-full bg-ink/10"><div class="h-full rounded-full grad" style="width:{l}%"></div></div><span class="text-[11px] text-muted">{l}%</span></div></div></div>' for img,full,n,role,l,r,rt in M)
grid=''.join(f'<div class="absolute inset-x-0 border-t border-ink/[.06]" style="top:{(x-START)*R}px"></div>' for x in range(10,20))
times=''.join(f'<div class="absolute right-3 text-[11px] text-muted font-medium -translate-y-1/2" style="top:{(x-START)*R}px">{x}:00</div>' for x in range(11,20))
now=(13.6-START)*R
def stat(ic,v,l): return f'<div class="flex items-center gap-2.5"><span class="w-8 h-8 rounded-xl bg-white solid grid place-items-center text-acc">{I(ic,"w-4 h-4")}</span><div class="leading-tight"><div class="text-[14px] font-semibold">{v}</div><div class="text-[11px] text-muted">{l}</div></div></div>'
calendar=f'''<!doctype html><html><head>{HEAD}</head><body><div class="w-[1440px] h-[900px] flex overflow-hidden relative">{AUR}{side('Календарь')}
<main class="flex-1 flex flex-col min-w-0 py-4 pr-0 relative z-10">
<div class="glass rounded-[28px] flex-1 flex flex-col overflow-hidden">
<header class="flex items-center px-6 pt-5 gap-3">
<div><div class="text-[12px] text-muted font-medium">Сегодня · 19 записей</div><div class="font-display text-[24px] font-semibold leading-tight mt-0.5 whitespace-nowrap">Вторник, 10 ноября</div></div>
<div class="flex gap-1 ml-2 self-end mb-1"><span class="w-8 h-8 rounded-lg solid grid place-items-center text-muted">{I('chevron-left','w-4 h-4')}</span><span class="w-8 h-8 rounded-lg solid grid place-items-center text-muted">{I('chevron-right','w-4 h-4')}</span></div>
<div class="ml-auto flex p-1 rounded-xl bg-ink/[.05] text-[13px]"><span class="px-3 py-1.5 rounded-lg bg-white shadow-sm font-semibold">День</span><span class="px-3 py-1.5 text-muted">Неделя</span><span class="px-3 py-1.5 text-muted">Месяц</span></div>
<span class="w-10 h-10 rounded-xl solid grid place-items-center text-ink/70">{I('search')}</span>
<button class="h-10 px-4 rounded-xl grad cta text-white text-[13px] font-semibold flex items-center gap-1.5 whitespace-nowrap">{I('plus','w-4 h-4')}Запись</button>
</header>
<div class="flex items-center gap-8 px-6 mt-4">{stat('wallet','84 600 ₽','ожидаемая выручка')}{stat('gauge','77%','загрузка дня')}{stat('sparkles','3 записи','сделал AI')}{stat('user-plus','4','новых клиента')}</div>
<div class="flex h-14 mt-4 border-y border-ink/[.06] bg-white/40"><div class="w-14 shrink-0"></div>{heads}</div>
<div class="flex flex-1 relative overflow-hidden">
<div class="w-14 shrink-0 relative">{times}</div>
<div class="flex flex-1 relative">{grid}{cols}
<div class="absolute inset-x-0 z-10" style="top:{now}px"><div class="h-[2px] grad"></div><div class="absolute -left-1.5 -top-[5px] w-3 h-3 rounded-full grad border-2 border-white"></div></div></div>
<div class="absolute left-1 z-10 text-[10px] font-bold text-white grad rounded-md px-1 py-0.5 -translate-y-1/2" style="top:{now}px">13:36</div>
</div></div></main>
<aside class="w-[356px] shrink-0 p-4 flex flex-col gap-3 relative z-10">
<div class="glass rounded-[28px] p-4 flex flex-col">
<div class="flex items-center gap-3">{ORB(40)}<div class="flex-1"><div class="font-display font-semibold text-[15px]">AI-ассистент</div><div class="text-[11px] text-emerald-700 flex items-center gap-1.5 font-medium"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 ring-4 ring-emerald-500/20"></span>Онлайн · Telegram и WhatsApp</div></div><span class="text-muted">{I('more-horizontal')}</span></div>
<div class="mt-4 flex items-center gap-2 px-2.5 py-2 rounded-xl bg-white/70 border border-white"><img src="img/vika.jpg" class="w-8 h-8 rounded-full object-cover border-2 border-white"><div class="leading-tight flex-1"><div class="text-[12px] font-semibold">Виктория Павлова</div><div class="text-[11px] text-muted">постоянный клиент · 7 визитов</div></div><span class="w-6 h-6 rounded-full bg-sky-500 grid place-items-center text-white">{I('send','w-3 h-3')}</span></div>
<div class="mt-3 space-y-2 text-[13px] leading-snug">
<div class="max-w-[84%] rounded-2xl rounded-tl-md bg-white px-3 py-2 solid">Здравствуйте! Можно на маникюр с дизайном сегодня днём?<div class="text-[10px] text-muted mt-1">13:31</div></div>
<div class="max-w-[86%] ml-auto rounded-2xl rounded-tr-md grad text-white px-3 py-2" style="box-shadow:0 8px 20px -10px rgba(192,38,211,.6)">Добрый день, Виктория! У Алины свободно в 13:00 и 15:00. Как удобнее?<div class="text-[10px] text-white/70 mt-1 text-right">13:31 · AI</div></div>
<div class="max-w-[84%] rounded-2xl rounded-tl-md bg-white px-3 py-2 solid">Давайте в 13:00 🙌<div class="text-[10px] text-muted mt-1">13:32</div></div>
<div class="max-w-[86%] ml-auto rounded-2xl rounded-tr-md grad text-white px-3 py-2" style="box-shadow:0 8px 20px -10px rgba(192,38,211,.6)">Готово! Записала вас к Алине на 13:00, 3 200 ₽. Напомню за 2 часа ✨<div class="text-[10px] text-white/70 mt-1 text-right">13:32 · AI</div></div>
</div>
<div class="mt-3 rounded-2xl bg-emerald-50 border border-emerald-200 px-3 py-2.5 flex items-center gap-2.5"><span class="w-7 h-7 rounded-full bg-emerald-500 text-white grid place-items-center">{I('calendar-check','w-4 h-4')}</span><div class="leading-tight"><div class="text-[12px] font-semibold text-emerald-900">Запись создана автоматически</div><div class="text-[11px] text-emerald-800/70">Алина · 13:00–14:30 · 3 200 ₽</div></div></div>
<div class="mt-3 flex items-center gap-2 text-[12px] text-muted">{ORB(14)}<span class="flex gap-1"><span class="w-1.5 h-1.5 rounded-full bg-fuchsia-400"></span><span class="w-1.5 h-1.5 rounded-full bg-fuchsia-400/60"></span><span class="w-1.5 h-1.5 rounded-full bg-fuchsia-400/30"></span></span>AI отвечает Игорю в WhatsApp…</div>
</div>
<div class="glass rounded-[24px] p-4 relative overflow-hidden"><div class="blob" style="width:180px;height:180px;background:#FFD6C0;bottom:-90px;right:-50px;filter:blur(40px)"></div>
<div class="relative flex items-center gap-2 text-[13px] font-semibold">{I('lightbulb','w-4 h-4 text-amber-500')}У Алины окно 15:00–17:00</div><div class="relative text-[12px] text-muted mt-1">5 клиенток в листе ожидания. Предложить окно? ≈ +4 800 ₽</div>
<div class="relative flex gap-2 mt-3"><span class="px-3.5 py-2 rounded-xl bg-ink text-white font-semibold text-[12px]">Отправить</span><span class="px-3.5 py-2 rounded-xl solid text-[12px] font-medium">Позже</span></div></div>
</aside></div>{END}'''
open('calendar.html','w').write(calendar)

# ---------------- DASHBOARD ----------------
vals=[52,58,55,63,61,70,66,74,71,79,76,84,88,93,90,98,95,104,101,108,112,106,115,119,117,124,128,122,131,138]
W,H=760,170; mx=150
pts=[(i*W/(len(vals)-1),H-(v/mx)*H) for i,v in enumerate(vals)]
def smooth(p):
    d=f'M{p[0][0]:.1f},{p[0][1]:.1f}'
    for i in range(1,len(p)):
        x0,y0=p[i-1];x1,y1=p[i];cx=(x0+x1)/2
        d+=f' C{cx:.1f},{y0:.1f} {cx:.1f},{y1:.1f} {x1:.1f},{y1:.1f}'
    return d
ln=smooth(pts); area=ln+f' L{W},{H} L0,{H} Z'
lx,ly=pts[-1]
def spark(v,col,w=76,h=34):
    m=max(v);n=min(v);p=[(i*w/(len(v)-1),h-2-(x-n)/(m-n)*(h-6)) for i,x in enumerate(v)]
    s=smooth(p);gid='s'+col.strip('#')
    return f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}"><defs><linearGradient id="{gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="{col}" stop-opacity=".3"/><stop offset="1" stop-color="{col}" stop-opacity="0"/></linearGradient></defs><path d="{s} L{w},{h} L0,{h} Z" fill="url(#{gid})"/><path d="{s}" fill="none" stroke="{col}" stroke-width="2" stroke-linecap="round"/></svg>'
def kpi(ic,t,v,d,sub,sp,col,up=True):
    return f'''<div class="glass rounded-[24px] px-5 py-4"><div class="flex items-center gap-2 text-[13px] text-muted font-medium"><span class="w-7 h-7 rounded-lg bg-white solid grid place-items-center" style="color:{col}">{I(ic,"w-3.5 h-3.5")}</span>{t}</div>
<div class="flex items-end justify-between mt-3"><div><div class="font-display text-[24px] font-semibold leading-none whitespace-nowrap">{v}</div><div class="flex items-center gap-1.5 mt-2.5 text-[12px]"><span class="px-1.5 py-0.5 rounded-md {'bg-emerald-100 text-emerald-700' if up else 'bg-rose-100 text-rose-700'} font-semibold whitespace-nowrap">{d}</span><span class="text-muted whitespace-nowrap">{sub}</span></div></div>{spark(sp,col)}</div></div>'''
k=kpi('wallet','Сегодня','84 600 ₽','↑ 12%','к вторнику',[40,48,45,60,58,66,72,70,84],'#7C3AED')+kpi('calendar-check','Записей','19','↑ 4','3 через AI',[10,12,11,14,13,15,17,16,19],'#DB2777')+kpi('user-check','Средний чек','2 870 ₽','↑ 6%','за месяц',[24,25,25,26,27,26,28,28,29],'#F97316')+kpi('calendar-x','Неявки','2,1%','↓ 3,4 п.п.','с AI',[9,8,8,7,6,5,4,3,2],'#059669')
ml=''.join(f'''<div class="flex items-center gap-3"><img src="{img}" class="w-9 h-9 rounded-full object-cover border-2 border-white" style="box-shadow:0 4px 10px -4px rgba(90,40,140,.35)"><div class="flex-1 min-w-0"><div class="flex justify-between text-[13px]"><span class="font-semibold">{full}</span><span class="text-muted">{r}</span></div><div class="h-2 rounded-full bg-ink/[.06] mt-2"><div class="h-full rounded-full {'grad' if l>=80 else 'bg-gradient-to-r from-violet-300 to-pink-300'}" style="width:{l}%"></div></div></div><div class="w-10 text-right font-display text-[13px] font-semibold">{l}%</div></div>''' for img,full,n,role,l,r,rt in M)
xl=''.join(f'<span>{d}</span>' for d in ['1 ноя','5 ноя','10 ноя','15 ноя','20 ноя','25 ноя','30 ноя'])
rr=40; cc=2*3.14159*rr
dashboard=f'''<!doctype html><html><head>{HEAD}</head><body><div class="w-[1440px] h-[900px] flex overflow-hidden relative">{AUR}{side('Дашборд')}
<main class="flex-1 py-4 pr-5 pl-1 flex flex-col gap-3.5 min-w-0 relative z-10">
<header class="flex items-center"><div><div class="text-[13px] text-muted font-medium">Добрый день, Ольга 👋</div><div class="font-display text-[26px] font-semibold mt-0.5">Обзор студии</div></div>
<div class="ml-auto flex items-center gap-3"><div class="flex p-1 rounded-xl glass text-[13px]"><span class="px-3 py-1.5 text-muted">Сегодня</span><span class="px-3 py-1.5 text-muted">Неделя</span><span class="px-3 py-1.5 rounded-lg bg-white shadow-sm font-semibold">Месяц</span><span class="px-3 py-1.5 text-muted">Год</span></div><button class="h-10 px-4 rounded-xl glass text-[13px] font-medium flex items-center gap-1.5">{I('download','w-4 h-4')}Экспорт</button></div></header>
<div class="grid grid-cols-[1fr_360px] gap-4">
<div class="glass rounded-[28px] p-6 pb-4 relative overflow-hidden">
<div class="flex items-start"><div><div class="text-[13px] text-muted font-medium flex items-center gap-1.5">{I('trending-up','w-4 h-4 text-acc')}Выручка за ноябрь</div>
<div class="relative font-display text-[48px] font-semibold leading-none mt-2"><div class="blob" style="width:300px;height:90px;background:#F0ABFC;left:0;top:0;opacity:.45;filter:blur(36px)"></div><span class="gradtext relative">812 400</span> <span class="text-[30px] text-ink/40">₽</span></div>
<div class="flex items-center gap-2 mt-3 text-[13px]"><span class="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700 font-semibold">↑ 18%</span><span class="text-muted">к октябрю · прогноз на месяц</span><span class="font-semibold">2,4 млн ₽</span></div></div>
<div class="ml-auto text-right"><div class="text-[12px] text-muted">10 ноября</div><div class="font-display text-[18px] font-semibold">84 600 ₽</div></div></div>
<div class="relative mt-3">
<svg viewBox="0 -12 {W} {H+12}" class="w-full h-[164px]" preserveAspectRatio="none">
<defs><linearGradient id="ga" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#C026D3" stop-opacity=".28"/><stop offset=".6" stop-color="#F472B6" stop-opacity=".08"/><stop offset="1" stop-color="#FB923C" stop-opacity="0"/></linearGradient>
<linearGradient id="gl" x1="0" x2="1"><stop offset="0" stop-color="#7C3AED"/><stop offset=".6" stop-color="#DB2777"/><stop offset="1" stop-color="#F97316"/></linearGradient></defs>
{''.join(f'<line x1="0" x2="{W}" y1="{H*k/3:.0f}" y2="{H*k/3:.0f}" stroke="rgba(26,21,35,.07)" stroke-dasharray="4 6"/>' for k in range(3))}
<path d="{area}" fill="url(#ga)"/><path d="{ln}" fill="none" stroke="url(#gl)" stroke-width="3" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>
<div class="absolute w-4 h-4 rounded-full bg-white border-[3px] border-orange-400" style="right:-6px;top:{(ly+12)/(H+12)*164-8:.0f}px;box-shadow:0 0 0 6px rgba(251,146,60,.2)"></div>
<div class="flex justify-between text-[11px] text-muted mt-1.5">{xl}</div></div></div>
<div class="glass rounded-[28px] p-5 relative overflow-hidden flex flex-col">
<div class="blob" style="width:240px;height:240px;background:#F8C8E8;top:-80px;right:-80px;filter:blur(50px)"></div>
<div class="relative flex items-center gap-2">{ORB(32)}<span class="font-display font-semibold text-[15px]">AI-инсайты</span><span class="ml-auto text-[11px] font-semibold text-acc bg-violet-100 px-2 py-0.5 rounded-md">3 новых</span></div>
<div class="relative mt-3 space-y-1.5">
<div class="rounded-2xl bg-white/80 border border-white px-3 py-2"><div class="text-[13px] font-semibold leading-snug">23 клиентки не были больше 45 дней</div><div class="text-[12px] text-muted mt-0.5">Отправить персональную скидку 10%</div><div class="flex items-center mt-1.5"><span class="text-[12px] font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-md">≈ +48 000 ₽/мес</span><span class="ml-auto px-3 py-1.5 rounded-lg bg-ink text-white text-[12px] font-semibold">Запустить</span></div></div>
<div class="rounded-2xl bg-white/80 border border-white px-3 py-2"><div class="text-[13px] font-semibold leading-snug">Четверг 14–17 ч загружен на 34%</div><div class="text-[12px] text-muted mt-0.5">Включить «счастливые часы» −15%</div><div class="flex items-center mt-1.5"><span class="text-[12px] font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-md">≈ +21 000 ₽/мес</span><span class="ml-auto px-3 py-1.5 rounded-lg solid text-[12px] font-semibold">Включить</span></div></div>
<div class="rounded-2xl bg-white/80 border border-white px-3 py-2"><div class="text-[13px] font-semibold leading-snug">Денис загружен на 91%</div><div class="text-[12px] text-muted mt-0.5">Поднять цену стрижки на 200 ₽</div><div class="flex items-center mt-1.5"><span class="text-[12px] font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-md">≈ +16 000 ₽/мес</span><span class="ml-auto px-3 py-1.5 rounded-lg solid text-[12px] font-semibold">Подробнее</span></div></div>
</div></div></div>
<div class="grid grid-cols-4 gap-4">{k}</div>
<div class="grid grid-cols-[1fr_1fr_360px] gap-4 flex-1 min-h-0">
<div class="glass rounded-[28px] p-5"><div class="flex items-center"><div class="font-display font-semibold text-[15px]">Загрузка мастеров</div><span class="ml-auto text-[12px] text-muted">сегодня</span></div><div class="mt-3.5 space-y-3">{ml}</div></div>
<div class="glass rounded-[28px] p-5"><div class="font-display font-semibold text-[15px]">Топ услуг</div><div class="mt-4 space-y-3 text-[13px]">
<div class="flex items-center gap-3"><span class="w-9 h-9 rounded-xl bg-rose-100 text-rose-600 grid place-items-center">{I('hand','w-4 h-4')}</span><div class="flex-1"><div class="font-semibold">Маникюр с гель-лаком</div><div class="text-[11px] text-muted">142 записи</div></div><span class="font-display font-semibold">340 тыс. ₽</span></div>
<div class="flex items-center gap-3"><span class="w-9 h-9 rounded-xl bg-sky-100 text-sky-600 grid place-items-center">{I('scissors','w-4 h-4')}</span><div class="flex-1"><div class="font-semibold">Мужская стрижка</div><div class="text-[11px] text-muted">118 записей</div></div><span class="font-display font-semibold">212 тыс. ₽</span></div>
<div class="flex items-center gap-3"><span class="w-9 h-9 rounded-xl bg-amber-100 text-amber-600 grid place-items-center">{I('eye','w-4 h-4')}</span><div class="flex-1"><div class="font-semibold">Брови «под ключ»</div><div class="text-[11px] text-muted">64 записи</div></div><span class="font-display font-semibold">128 тыс. ₽</span></div>
<div class="flex items-center gap-3"><span class="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-600 grid place-items-center">{I('flower-2','w-4 h-4')}</span><div class="flex-1"><div class="font-semibold">SPA-программа</div><div class="text-[11px] text-muted">41 запись</div></div><span class="font-display font-semibold">132 тыс. ₽</span></div>
</div></div>
<div class="glass rounded-[28px] p-5 flex items-center gap-5">
<svg width="120" height="120" viewBox="0 0 100 100" class="shrink-0"><defs><linearGradient id="rg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#7C3AED"/><stop offset=".6" stop-color="#DB2777"/><stop offset="1" stop-color="#F97316"/></linearGradient></defs><circle cx="50" cy="50" r="{rr}" stroke="rgba(26,21,35,.06)" stroke-width="10" fill="none"/><circle cx="50" cy="50" r="{rr}" stroke="url(#rg)" stroke-width="10" fill="none" stroke-linecap="round" stroke-dasharray="{cc*.68:.1f} {cc:.1f}" transform="rotate(-90 50 50)"/><text x="50" y="56" text-anchor="middle" fill="#1A1523" font-size="18" font-weight="600" font-family="Unbounded">68%</text></svg>
<div><div class="font-display font-semibold text-[15px]">Возвращаемость</div><div class="text-[12px] text-muted mt-1">Пришли повторно за 60 дней</div><div class="text-[12px] mt-2.5"><span class="px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-700 font-semibold">↑ 6%</span> <span class="text-muted">за месяц</span></div><div class="flex -space-x-2 mt-3"><img src="img/olga.jpg" class="w-7 h-7 rounded-full border-2 border-white object-cover"><img src="img/igor.jpg" class="w-7 h-7 rounded-full border-2 border-white object-cover"><img src="img/elena.jpg" class="w-7 h-7 rounded-full border-2 border-white object-cover"><span class="w-7 h-7 rounded-full border-2 border-white bg-violet-100 text-acc text-[10px] font-semibold grid place-items-center">+412</span></div></div></div>
</div></main></div>{END}'''
open('dashboard.html','w').write(dashboard)
