import type { Metadata } from "next";

export const metadata: Metadata = { title: "API · Am Beauty CRM" };

const ENDPOINTS: [string, string, string, string][] = [
  ["GET", "/api/v1/branches", "read", "Филиалы: id, название, адрес, часовой пояс, ссылка онлайн-записи"],
  ["GET", "/api/v1/services", "read", "Услуги: длительность, цена в копейках, категория"],
  ["GET", "/api/v1/staff", "read", "Мастера: филиалы и услуги каждого"],
  ["GET", "/api/v1/slots?branchId&serviceId&staffId&from&days", "read", "Свободные окна по правилам онлайн-записи"],
  ["GET", "/api/v1/clients?phone|q|updatedSince&limit", "read", "Клиенты: поиск по телефону или имени, выгрузка изменений"],
  ["GET", "/api/v1/clients/{id}", "read", "Один клиент"],
  ["POST", "/api/v1/clients", "write", "Создать клиента: name, phone, email, birthDate, notes"],
  ["GET", "/api/v1/appointments?from&to|updatedSince&branchId&staffId&clientId&status", "read", "Записи за период до 31 дня или изменённые с момента"],
  ["GET", "/api/v1/appointments/{id}", "read", "Одна запись"],
  ["POST", "/api/v1/appointments", "write", "Создать запись: branchId, staffId, startsAt, services[] и clientId или client {name, phone}"],
  ["POST", "/api/v1/appointments/{id}/cancel", "write", "Отменить запись: reason"],
];

const EVENTS: [string, string][] = [
  ["appointment.created", "Новая запись (админ, онлайн, API)"],
  ["appointment.updated", "Перенос, изменение, подтверждение, смена статуса"],
  ["appointment.cancelled", "Отмена"],
  ["client.created / client.updated", "Новый или изменённый клиент"],
  ["payment.posted / payment.refunded", "Оплата и возврат"],
];

/** API-DOCS-01: public reference for the salon's developers. */
export default function DevelopersPage() {
  return (
    <div className="aurora" style={{ minHeight: "100vh", overflow: "auto" }}>
      <main className="dev-page">
        <div className="wordmark"><span className="am">Am</span><span className="beauty">BEAUTY</span></div>
        <div><div className="page-kicker">Для разработчиков</div><h1>API v1</h1></div>
        <section className="panel list">
          <h2 style={{ margin: 0 }}>Доступ</h2>
          <p style={{ margin: 0 }}>Ключ выдаёт владелец салона: «Настройки → API и вебхуки». Ключ бывает «только чтение» или «чтение и запись», для всей сети или одного филиала. Передавайте его в заголовке:</p>
          <pre><code>Authorization: Bearer ab_live_…</code></pre>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            <li>Ответы в JSON: <code>{"{ data: … }"}</code>, ошибки: <code>{"{ error: { code, message, details } }"}</code>.</li>
            <li>Деньги в копейках (<code>priceMinor</code>), время в ISO 8601 UTC.</li>
            <li>Лимит: 120 запросов в минуту на ключ (ответ 429). Остаток в заголовке <code>x-ratelimit-remaining</code>.</li>
            <li>Коды: 400 ошибка в данных, 403 нет доступа или ключа, 404 не найдено, 409 время занято.</li>
          </ul>
        </section>
        <section className="panel list">
          <h2 style={{ margin: 0 }}>Методы</h2>
          <table>
            <thead><tr><th>Метод</th><th>Права</th><th>Что делает</th></tr></thead>
            <tbody>
              {ENDPOINTS.map(([method, path, scope, text]) => (
                <tr key={method + path}><td><span className={`method ${method === "POST" ? "post" : ""}`}>{method}</span><code>{path}</code></td><td>{scope === "write" ? "запись" : "чтение"}</td><td>{text}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel list">
          <h2 style={{ margin: 0 }}>Пример: записать клиента с сайта</h2>
          <pre><code>{`curl -X POST https://crm.example.ru/api/v1/appointments \\
  -H "Authorization: Bearer ab_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "branchId": "…",
    "staffId": "…",
    "startsAt": "2026-11-20T09:00:00Z",
    "services": [{ "serviceId": "…" }],
    "client": { "name": "Анна", "phone": "+79001234567" },
    "comment": "с сайта"
  }'`}</code></pre>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Проверки те же, что у администратора: рабочие часы мастера, пересечения, услуги мастера. Занятое время даёт 409 CONFLICT_SLOT.</p>
        </section>
        <section className="panel list">
          <h2 style={{ margin: 0 }}>Вебхуки</h2>
          <p style={{ margin: 0 }}>CRM шлёт POST на адрес из настроек. В теле только идентификаторы, подробности читайте через API:</p>
          <pre><code>{`{ "id": "…", "event": "appointment.created", "occurredAt": "2026-11-04T10:00:00.000Z",
  "data": { "appointmentId": "…", "branchId": "…", "action": "appointment.online_booked" } }`}</code></pre>
          <table>
            <tbody>{EVENTS.map(([event, text]) => <tr key={event}><td><code>{event}</code></td><td>{text}</td></tr>)}</tbody>
          </table>
          <p style={{ margin: 0 }}>Подпись: <code>X-AmBeauty-Signature: sha256=HMAC_SHA256(секрет, тело)</code>. Ответьте 2xx за 5 секунд, иначе повторим через 1, 5, 30, 120 и 360 минут.</p>
        </section>
      </main>
    </div>
  );
}
