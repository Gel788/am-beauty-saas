"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/domain/money";
import { formatPhone } from "@/domain/phone";
import { api, type ApiError } from "./api";
import { initials, useToast } from "./ui";

type Group = {
  reason: "name" | "email" | "phone";
  label: string;
  clients: { id: string; name: string; phones: string[]; email: string | null; visits: number; lastVisitAt: string | null; balanceMinor: number; createdAt: string }[];
};
const REASON = { phone: "Похожий телефон", email: "Одинаковый email", name: "Одинаковое имя" };

/** CL-MERGE-01: suspected duplicates; the card with most visits is suggested to stay. */
export function DuplicatesView() {
  const toast = useToast();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [keep, setKeep] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Group[]>("/api/clients/duplicates")
      .then((data) => {
        setGroups(data);
        setKeep({});
      })
      .catch((error: ApiError) => toast(error.message, "error"));
  }, [toast]);
  useEffect(() => load(), [load]);

  async function merge(index: number, group: Group) {
    const primaryId = keep[index] ?? group.clients[0].id;
    const others = group.clients.filter((client) => client.id !== primaryId);
    setBusy(true);
    try {
      for (const other of others) await api("/api/clients/merge", { method: "POST", body: JSON.stringify({ primaryId, secondaryId: other.id }) });
      toast(`Объединено: ${group.clients.find((client) => client.id === primaryId)?.name}`);
      load();
    } catch (error) {
      toast((error as ApiError).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function different(group: Group) {
    try {
      await api("/api/clients/not-duplicates", { method: "POST", body: JSON.stringify({ ids: group.clients.map((client) => client.id) }) });
      load();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  return (
    <>
      <div className="spread">
        <div>
          <div className="page-kicker"><Link href="/clients">Клиенты</Link> · порядок в базе</div>
          <h1>Возможные дубли</h1>
        </div>
        <Link className="btn" href="/clients/import">Импорт</Link>
      </div>
      <div className="import-grid">
        <div className="panel list">
          <span className="muted" style={{ fontSize: 13 }}>
            Отметьте карточку, которая останется. В неё перейдут визиты, оплаты, долг, бонусы, сертификаты, абонементы, сообщения, телефоны и метки; вторая карточка скроется. Это видно в журнале изменений.
          </span>
          {!groups && <div className="skeleton" />}
          {groups?.length === 0 && <div className="empty">Дублей не нашли. База в порядке.</div>}
          {groups?.map((group, index) => {
            const primary = keep[index] ?? group.clients[0].id;
            return (
              <div key={group.clients.map((client) => client.id).join()} className="dup-group">
                <div className="spread">
                  <span className="tag">{REASON[group.reason]}: {group.reason === "phone" ? formatPhone(group.label) : group.label}</span>
                </div>
                {group.clients.map((client) => (
                  <label key={client.id} className={`dup-card ${primary === client.id ? "on" : ""}`}>
                    <input type="radio" name={`keep-${index}`} checked={primary === client.id} onChange={() => setKeep({ ...keep, [index]: client.id })} />
                    <div className="avatar">{initials(client.name)}</div>
                    <div style={{ flex: 1 }}>
                      <b>{client.name}</b>
                      <small>
                        {client.phones.map(formatPhone).join(", ") || "без телефона"}{client.email ? ` · ${client.email}` : ""} · визитов {client.visits}
                        {client.lastVisitAt ? ` · последний ${new Date(client.lastVisitAt).toLocaleDateString("ru-RU")}` : ""}
                        {client.balanceMinor > 0 ? ` · долг ${formatMoney(client.balanceMinor)}` : ""}
                      </small>
                    </div>
                    {primary === client.id && <span className="tag tag-ok">останется</span>}
                  </label>
                ))}
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn-gradient" type="button" disabled={busy} onClick={() => merge(index, group)}>Объединить</button>
                  <button className="btn-ghost" type="button" onClick={() => different(group)}>Это разные люди</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
