"use client";

import { portraitFor } from "./portraits";

export function AiPanel() {
  return (
    <aside className="ai-panel" id="ai-panel" aria-label="AI-ассистент">
      <div className="ai-head">
        <div className="ai-orb" />
        <div>
          <strong>AI-ассистент</strong>
          <span>Онлайн · Telegram и WhatsApp</span>
        </div>
      </div>
      <div className="chat-person">
        <img className="face" src={portraitFor("Виктория Павлова") ?? "/staff/victoria.jpg"} alt="" />
        <div>
          <strong>Виктория Павлова</strong>
          <span className="muted"> постоянный клиент · 7 визитов</span>
        </div>
      </div>
      <div className="bubble guest">
        Здравствуйте! Можно на маникюр с дизайном сегодня днём?
        <span className="time">13:31</span>
      </div>
      <div className="bubble ai">
        Добрый день, Виктория! У Алины свободно в 13:00 и 15:00. Как удобнее?
        <span className="time">13:31 · AI</span>
      </div>
      <div className="bubble guest">
        Давайте в 13:00
        <span className="time">13:32</span>
      </div>
      <div className="bubble ai">
        Готово! Записала вас к Алине на 13:00, 3 200 ₽. Напомню за 2 часа
        <span className="time">13:32 · AI</span>
      </div>
      <div className="sys-card">Запись создана автоматически · Алина · 13:00–14:30 · 3 200 ₽</div>
      <div className="suggest-card">
        У Алины окно 15:00–17:00
        <div>5 клиентов в листе ожидания. Предложить окно? ≈ +4 800 ₽</div>
        <div className="row">
          <button className="btn" type="button" style={{ background: "#1c1428", color: "white" }}>Отправить</button>
          <button className="btn-ghost" type="button">Позже</button>
        </div>
      </div>
    </aside>
  );
}
