"use client";

import { useEffect, useState } from "react";

type Info = { salon: string; operator: string; inn: string; email: string; branch: string; address: string };

/** MSG-CONSENT-01: the policy the online booking consent points to (152-ФЗ, ст. 18.1). */
export function PrivacyPage({ tenantSlug, branchSlug }: { tenantSlug: string; branchSlug: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch(`/api/public/b/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(branchSlug)}/privacy`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error?.message ?? "Не найдено");
        setInfo(body);
      })
      .catch((failure: Error) => setError(failure.message));
  }, [tenantSlug, branchSlug]);
  if (error) return <div className="bk-page"><div className="bk-card bk-empty"><h1>Страница не найдена</h1><p>{error}</p></div></div>;
  if (!info) return <div className="bk-page"><div className="bk-card bk-loading">Загружаем…</div></div>;
  const contact = info.email || "администратору салона";
  return (
    <div className="bk-page">
      <article className="bk-card bk-privacy">
        <h1 style={{ fontSize: 22, margin: 0 }}>Политика обработки персональных данных</h1>
        <p className="bk-muted">{info.salon} · {info.branch}{info.address ? `, ${info.address}` : ""}</p>
        <h2>Кто обрабатывает данные</h2>
        <p>Оператор: {info.operator}{info.inn ? `, ИНН ${info.inn}` : ""}.</p>
        <h2>Какие данные и зачем</h2>
        <ul>
          <li>Имя и телефон: чтобы записать вас, напомнить о визите и связаться при изменениях.</li>
          <li>История визитов и оплат: для учёта услуг, чеков и бонусов.</li>
          <li>Telegram-чат, если вы подключили бота: для напоминаний и подтверждения визита.</li>
        </ul>
        <h2>Сроки и передача</h2>
        <p>Данные хранятся, пока вы пользуетесь услугами салона, и удаляются по вашему запросу, если закон не требует хранить их дольше (например, данные чеков). Данные хранятся на серверах в России и не передаются третьим лицам, кроме операторов связи и платёжных сервисов, через которые салон отправляет сообщения и принимает оплату.</p>
        <h2>Рекламные сообщения</h2>
        <p>Акции и новости салон присылает только тем, кто дал отдельное согласие. Отказаться можно в любой момент: напишите салону или отправьте /stop боту.</p>
        <h2>Ваши права</h2>
        <p>Вы можете узнать, какие данные о вас хранятся, исправить их или отозвать согласие. Напишите: {contact}.</p>
      </article>
    </div>
  );
}
