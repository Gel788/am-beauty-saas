"use client";

import { CalendarCheck, Lightbulb, MoreHorizontal, Send } from "lucide-react";
import { portraitFor } from "./portraits";

export function AiPanel() {
  return (
    <aside className="ai-aside w-[356px] shrink-0 p-4 flex flex-col gap-3 relative z-10 min-h-0" id="ai-panel" aria-label="AI-ассистент">
      <div className="glass rounded-[28px] p-4 flex flex-col min-h-0">
        <div className="flex items-center gap-3">
          <span className="orb inline-block shrink-0" style={{ width: 40, height: 40 }} />
          <div className="flex-1 min-w-0">
            <div className="font-display font-semibold text-[15px]">AI-ассистент</div>
            <div className="text-[11px] text-emerald-700 flex items-center gap-1.5 font-medium whitespace-nowrap">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 ring-4 ring-emerald-500/20" />
              Онлайн · Telegram и WhatsApp
            </div>
          </div>
          <span className="text-muted"><MoreHorizontal className="ic" strokeWidth={1.8} /></span>
        </div>
        <div className="mt-4 flex items-center gap-2 px-2.5 py-2 rounded-xl bg-white/70 border border-white">
          <img src={portraitFor("Виктория Павлова") ?? "/staff/vika.jpg"} alt="" className="w-8 h-8 rounded-full object-cover border-2 border-white" />
          <div className="leading-tight flex-1 min-w-0">
            <div className="text-[12px] font-semibold">Виктория Павлова</div>
            <div className="text-[11px] text-muted whitespace-nowrap">постоянный клиент · 7 визитов</div>
          </div>
          <span className="w-6 h-6 rounded-full bg-sky-500 grid place-items-center text-white shrink-0">
            <Send className="w-3 h-3" strokeWidth={1.8} />
          </span>
        </div>
        <div className="mt-3 space-y-2 text-[13px] leading-snug">
          <div className="max-w-[84%] rounded-2xl rounded-tl-md bg-white px-3 py-2 solid">
            Здравствуйте! Можно на маникюр с дизайном сегодня днём?
            <div className="text-[10px] text-muted mt-1">13:31</div>
          </div>
          <div className="max-w-[86%] ml-auto rounded-2xl rounded-tr-md grad text-white px-3 py-2 bubble-shadow">
            Добрый день, Виктория! У Алины свободно в 13:00 и 15:00. Как удобнее?
            <div className="text-[10px] text-white/70 mt-1 text-right">13:31 · AI</div>
          </div>
          <div className="max-w-[84%] rounded-2xl rounded-tl-md bg-white px-3 py-2 solid">
            Давайте в 13:00 🙌
            <div className="text-[10px] text-muted mt-1">13:32</div>
          </div>
          <div className="max-w-[86%] ml-auto rounded-2xl rounded-tr-md grad text-white px-3 py-2 bubble-shadow">
            Готово! Записала вас к Алине на 13:00, 3 200 ₽. Напомню за 2 часа ✨
            <div className="text-[10px] text-white/70 mt-1 text-right">13:32 · AI</div>
          </div>
        </div>
        <div className="mt-3 rounded-2xl bg-emerald-50 border border-emerald-200 px-3 py-2.5 flex items-center gap-2.5">
          <span className="w-7 h-7 rounded-full bg-emerald-500 text-white grid place-items-center shrink-0">
            <CalendarCheck className="w-4 h-4" strokeWidth={1.8} />
          </span>
          <div className="leading-tight min-w-0">
            <div className="text-[12px] font-semibold text-emerald-900">Запись создана автоматически</div>
            <div className="text-[11px] text-emerald-800/70 whitespace-nowrap">Алина · 13:00–14:30 · 3 200 ₽</div>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 text-[12px] text-muted">
          <span className="orb inline-block shrink-0" style={{ width: 14, height: 14 }} />
          <span className="flex gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-400" />
            <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-400/60" />
            <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-400/30" />
          </span>
          <span className="whitespace-nowrap">AI отвечает Игорю в WhatsApp…</span>
        </div>
      </div>
      <div className="glass rounded-[24px] p-4 relative overflow-hidden shrink-0">
        <div className="blob" style={{ width: 180, height: 180, background: "#FFD6C0", bottom: -90, right: -50, filter: "blur(40px)" }} />
        <div className="relative flex items-center gap-2 text-[13px] font-semibold">
          <Lightbulb className="w-4 h-4 text-amber-500" strokeWidth={1.8} />
          У Алины окно 15:00–17:00
        </div>
        <div className="relative text-[12px] text-muted mt-1">5 клиенток в листе ожидания. Предложить окно? ≈ +4 800 ₽</div>
        <div className="relative flex gap-2 mt-3">
          <span className="px-3.5 py-2 rounded-xl bg-ink text-white font-semibold text-[12px]">Отправить</span>
          <span className="px-3.5 py-2 rounded-xl solid text-[12px] font-medium">Позже</span>
        </div>
      </div>
    </aside>
  );
}
