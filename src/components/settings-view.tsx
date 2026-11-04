"use client";

import { useEffect, useState } from "react";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";
import { MessagingSettings } from "./messaging-settings";

type Branch = {
  id: string;
  name: string;
  address: string;
  timezone: string;
  requireOpenShift: boolean;
  masterSeesAllColumns: boolean;
  masterCanCreateOwn: boolean;
  masterCanDragOwn: boolean;
  masterCanCancelOwnFuture: boolean;
  arrivalWindowHours: number;
  noShowGraceMin: number;
  gridLabelMin: number;
  requirePaymentOnComplete: boolean;
  shiftVarianceThresholdMinor: number;
  tenantSlug: string | null;
  slug: string;
  onlineEnabled: boolean;
  onlineStepMin: number;
  onlineMinNoticeMin: number;
  onlineMaxAdvanceDays: number;
  onlineHoldMin: number;
  onlineCancelHours: number;
  onlineMaxActivePerPhone: number;
  onlineAccent: string;
  reminderEnabled: boolean;
  reminderHours: number;
  bookingMessageEnabled: boolean;
  consumePolicy: "warn" | "block";
  allowNegativeStock: boolean;
  fiscalEnabled: boolean;
  externalReceipts: boolean;
  fiscalProvider: string;
  fiscalInn: string;
  fiscalTaxation: string;
  fiscalVat: string;
  fiscalPlace: string;
  acquiringEnabled: boolean;
  acquiringProvider: string;
  acquiringLinkHours: number;
};

export function SettingsView() {
  const toast = useToast();
  const [branch, setBranch] = useState<Branch | null>(null);
  const [role, setRole] = useState("admin");
  useEffect(() => {
    api<{ branches: Branch[]; actor: { role: string } }>("/api/auth/me").then((me) => { setBranch(me.branches[0] ?? null); setRole(me.actor.role); }).catch((error: ApiError) => toast(error.message, "error"));
  }, [toast]);
  if (!branch) return <div className="skeleton" />;
  const set = <K extends keyof Branch>(key: K, value: Branch[K]) => setBranch({ ...branch, [key]: value });
  return (
    <>
      <div><div className="page-kicker">Филиал</div><h1>Настройки</h1></div>
      <form className="panel list" onSubmit={async (event) => {
        event.preventDefault();
        try {
          const saved = await api<Branch>(`/api/branches/${branch.id}`, { method: "PATCH", body: JSON.stringify(branch) });
          setBranch(saved);
          toast("Сохранено");
        } catch (error) {
          toast((error as ApiError).message, "error");
        }
      }}>
        <div className="field"><label>Название</label><input value={branch.name} onChange={(event) => set("name", event.target.value)} /></div>
        <div className="field"><label>Адрес</label><input value={branch.address} onChange={(event) => set("address", event.target.value)} /></div>
        <div className="field"><label>Часовой пояс</label><input value={branch.timezone} onChange={(event) => set("timezone", event.target.value)} /></div>
        <label className="row"><input type="checkbox" checked={branch.requireOpenShift} onChange={(event) => set("requireOpenShift", event.target.checked)} /> Требовать открытую смену для оплаты</label>
        <label className="row"><input type="checkbox" checked={branch.masterSeesAllColumns} onChange={(event) => set("masterSeesAllColumns", event.target.checked)} /> Мастер видит все колонки</label>
        <label className="row"><input type="checkbox" checked={branch.masterCanCreateOwn} onChange={(event) => set("masterCanCreateOwn", event.target.checked)} /> Мастер создаёт свои записи</label>
        <label className="row"><input type="checkbox" checked={branch.masterCanDragOwn} onChange={(event) => set("masterCanDragOwn", event.target.checked)} /> Мастер перетаскивает свои записи</label>
        <label className="row"><input type="checkbox" checked={branch.requirePaymentOnComplete} onChange={(event) => set("requirePaymentOnComplete", event.target.checked)} /> Предлагать оплату при завершении</label>
        <div className="field"><label>Окно «пришёл», часы</label><input type="number" value={branch.arrivalWindowHours} onChange={(event) => set("arrivalWindowHours", Number(event.target.value))} /></div>
        <div className="field">
          <label>Допустимое расхождение при закрытии смены, ₽</label>
          <input type="number" min={0} step="0.01" value={branch.shiftVarianceThresholdMinor / 100} onChange={(event) => set("shiftVarianceThresholdMinor", Math.max(0, Math.round(Number(event.target.value) * 100)))} />
          <span className="muted" style={{ fontSize: 12 }}>Если расхождение больше — кассир обязан указать причину. 0 — причина нужна при любом расхождении.</span>
        </div>
        <div className="field"><label>Неявка после, минут</label><input type="number" value={branch.noShowGraceMin} onChange={(event) => set("noShowGraceMin", Number(event.target.value))} /></div>
        <button className="btn-gradient" type="submit">Сохранить</button>
      </form>
      <FiscalSettings branch={branch} onSaved={setBranch} />
      <OnlineBookingSettings branch={branch} onSaved={setBranch} />
      <MessagingSettings branch={branch} role={role} onSaved={setBranch} />
      <StockSettings branch={branch} onSaved={setBranch} />
    </>
  );
}

function OnlineBookingSettings({ branch, onSaved }: { branch: Branch; onSaved: (branch: Branch) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState(branch);
  const [tenantSlug, setTenantSlug] = useState(branch.tenantSlug ?? "");
  useEffect(() => {
    setDraft(branch);
    setTenantSlug(branch.tenantSlug ?? "");
  }, [branch]);
  const set = <K extends keyof Branch>(key: K, value: Branch[K]) => setDraft({ ...draft, [key]: value });
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const link = `${origin}/b/${branch.tenantSlug ?? ""}/${branch.slug}`;
  return (
    <form
      className="panel list"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          if (tenantSlug !== branch.tenantSlug) {
            await api<{ tenantSlug: string }>("/api/tenant", { method: "PATCH", body: JSON.stringify({ slug: tenantSlug }) });
          }
          const saved = await api<Branch>(`/api/branches/${branch.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              slug: draft.slug,
              onlineEnabled: draft.onlineEnabled,
              onlineStepMin: draft.onlineStepMin,
              onlineMinNoticeMin: draft.onlineMinNoticeMin,
              onlineMaxAdvanceDays: draft.onlineMaxAdvanceDays,
              onlineHoldMin: draft.onlineHoldMin,
              onlineCancelHours: draft.onlineCancelHours,
              onlineMaxActivePerPhone: draft.onlineMaxActivePerPhone,
              onlineAccent: draft.onlineAccent,
            }),
          });
          onSaved(saved);
          toast("Онлайн-запись сохранена");
        } catch (error) {
          toast((error as ApiError).message, "error");
        }
      }}
    >
      <h2 style={{ margin: 0 }}>Онлайн-запись</h2>
      <label className="row"><input type="checkbox" checked={draft.onlineEnabled} onChange={(event) => set("onlineEnabled", event.target.checked)} /> Принимать онлайн-записи</label>
      <div className="field">
        <label>Ссылка для клиентов</label>
        <div className="row" style={{ gap: 8 }}>
          <input readOnly value={link} onFocus={(event) => event.target.select()} />
          <button type="button" className="btn-ghost" onClick={() => navigator.clipboard?.writeText(link).then(() => toast("Ссылка скопирована"))}>Копировать</button>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          Для сайта: {`<iframe src="${link}" width="100%" height="720" style="border:0"></iframe>`}
        </span>
      </div>
      <div className="field"><label>Адрес салона в ссылке</label><input value={tenantSlug} onChange={(event) => setTenantSlug(event.target.value)} /></div>
      <div className="field"><label>Адрес филиала в ссылке</label><input value={draft.slug} onChange={(event) => set("slug", event.target.value)} /></div>
      <div className="field">
        <label>Шаг слотов</label>
        <select value={draft.onlineStepMin} onChange={(event) => set("onlineStepMin", Number(event.target.value))}>
          {[5, 10, 15, 30].map((value) => <option key={value} value={value}>{value} минут</option>)}
        </select>
      </div>
      <div className="field"><label>Не раньше чем через, минут</label><input type="number" min={0} value={draft.onlineMinNoticeMin} onChange={(event) => set("onlineMinNoticeMin", Number(event.target.value))} /></div>
      <div className="field"><label>Запись вперёд, дней</label><input type="number" min={1} max={365} value={draft.onlineMaxAdvanceDays} onChange={(event) => set("onlineMaxAdvanceDays", Number(event.target.value))} /></div>
      <div className="field"><label>Бронь слота пока клиент заполняет контакты, минут</label><input type="number" min={5} max={10} value={draft.onlineHoldMin} onChange={(event) => set("onlineHoldMin", Number(event.target.value))} /></div>
      <div className="field"><label>Клиент может отменить не позже чем за, часов</label><input type="number" min={0} value={draft.onlineCancelHours} onChange={(event) => set("onlineCancelHours", Number(event.target.value))} /></div>
      <div className="field"><label>Будущих онлайн-записей на один телефон</label><input type="number" min={1} value={draft.onlineMaxActivePerPhone} onChange={(event) => set("onlineMaxActivePerPhone", Number(event.target.value))} /></div>
      <div className="field"><label>Цвет страницы записи</label><input type="color" style={{ width: 64, height: 36, padding: 2 }} value={draft.onlineAccent} onChange={(event) => set("onlineAccent", event.target.value)} /></div>
      <button className="btn-gradient" type="submit">Сохранить онлайн-запись</button>
    </form>
  );
}

type Provider = { name: string; label: string };
const TAXATION: [string, string][] = [
  ["usn_income", "УСН «доходы»"],
  ["usn_income_outcome", "УСН «доходы минус расходы»"],
  ["patent", "Патент"],
  ["osn", "ОСН"],
  ["esn", "ЕСХН"],
];
const VAT: [string, string][] = [
  ["none", "Без НДС"],
  ["vat0", "0 %"],
  ["vat5", "5 %"],
  ["vat7", "7 %"],
  ["vat10", "10 %"],
  ["vat20", "20 %"],
];

function FiscalSettings({ branch, onSaved }: { branch: Branch; onSaved: (branch: Branch) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState(branch);
  const [providers, setProviders] = useState<{ fiscal: Provider[]; acquiring: Provider[] }>({ fiscal: [], acquiring: [] });
  useEffect(() => setDraft(branch), [branch]);
  useEffect(() => {
    api<{ fiscal: Provider[]; acquiring: Provider[] }>("/api/fiscal/providers").then(setProviders).catch(() => undefined);
  }, []);
  const set = <K extends keyof Branch>(key: K, value: Branch[K]) => setDraft({ ...draft, [key]: value });
  const sandbox = draft.fiscalProvider === "test" || draft.acquiringProvider === "test";
  return (
    <form
      className="panel list"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          const saved = await api<Branch>(`/api/branches/${branch.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              fiscalEnabled: draft.fiscalEnabled,
              externalReceipts: draft.externalReceipts,
              fiscalProvider: draft.fiscalProvider,
              fiscalInn: draft.fiscalInn,
              fiscalTaxation: draft.fiscalTaxation,
              fiscalVat: draft.fiscalVat,
              fiscalPlace: draft.fiscalPlace,
              acquiringEnabled: draft.acquiringEnabled,
              acquiringProvider: draft.acquiringProvider,
              acquiringLinkHours: draft.acquiringLinkHours,
            }),
          });
          onSaved(saved);
          toast("Касса и онлайн-оплата сохранены");
        } catch (error) {
          toast((error as ApiError).message, "error");
        }
      }}
    >
      <h2 style={{ margin: 0 }}>Чеки и онлайн-оплата</h2>
      <span className="muted" style={{ fontSize: 13 }}>
        Каждая оплата и возврат превращаются в кассовый чек по 54-ФЗ и уходят в онлайн-кассу. Чаевые в чек не попадают, бонусы уменьшают цену, сертификат и абонемент идут как зачёт предоплаты. Меняет владелец.
      </span>
      <div className="list" style={{ gap: 6 }}>
        <b style={{ fontSize: 14 }}>Как пробиваете чеки</b>
        {[
          ["off", "Не пробиваем через CRM", "Оплаты просто записываются в кассу CRM."],
          ["external", "На своей кассе и терминале", "Клиент платит на вашем терминале, администратор вносит оплату вручную. Номер чека и код операции можно указать сразу или позже."],
          ["online", "Онлайн-касса через CRM", "CRM сама отправляет чек по каждой оплате и возврату."],
        ].map(([value, label, hint]) => {
          const current = draft.fiscalEnabled ? "online" : draft.externalReceipts ? "external" : "off";
          return (
            <label key={value} className="row" style={{ alignItems: "flex-start", gap: 8 }}>
              <input
                type="radio"
                name="receipt-mode"
                checked={current === value}
                onChange={() => setDraft({ ...draft, fiscalEnabled: value === "online", externalReceipts: value === "external" })}
                style={{ marginTop: 3 }}
              />
              <span><span>{label}</span><br /><span className="muted" style={{ fontSize: 12 }}>{hint}</span></span>
            </label>
          );
        })}
      </div>
      {draft.fiscalEnabled && sandbox && (
        <div className="tag tag-warn" style={{ alignSelf: "flex-start", whiteSpace: "normal" }}>
          Подключён тестовый режим: чеки не уходят в ФНС, деньги не списываются. Боевой провайдер подключается, когда будут договор и ключи.
        </div>
      )}
      {draft.fiscalEnabled && (<>
      <div className="form-grid">
        <div className="field">
          <label>Онлайн-касса</label>
          <select value={draft.fiscalProvider} onChange={(event) => set("fiscalProvider", event.target.value)}>
            {providers.fiscal.map((provider) => <option key={provider.name} value={provider.name}>{provider.label}</option>)}
          </select>
        </div>
        <div className="field"><label>ИНН</label><input inputMode="numeric" placeholder="10 или 12 цифр" value={draft.fiscalInn} onChange={(event) => set("fiscalInn", event.target.value)} /></div>
        <div className="field">
          <label>Налогообложение</label>
          <select value={draft.fiscalTaxation} onChange={(event) => set("fiscalTaxation", event.target.value)}>
            {TAXATION.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className="field">
          <label>НДС</label>
          <select value={draft.fiscalVat} onChange={(event) => set("fiscalVat", event.target.value)}>
            {VAT.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      </div>
      <div className="field"><label>Адрес расчётов (печатается в чеке)</label><input placeholder="г. Москва, ул. Садовая, 1" value={draft.fiscalPlace} onChange={(event) => set("fiscalPlace", event.target.value)} /></div>
      </>)}
      <label className="row"><input type="checkbox" checked={draft.acquiringEnabled} onChange={(event) => set("acquiringEnabled", event.target.checked)} /> Принимать оплату по ссылке: карта и СБП</label>
      <div className="form-grid">
        <div className="field">
          <label>Провайдер оплаты</label>
          <select value={draft.acquiringProvider} onChange={(event) => set("acquiringProvider", event.target.value)}>
            {providers.acquiring.map((provider) => <option key={provider.name} value={provider.name}>{provider.label}</option>)}
          </select>
        </div>
        <div className="field"><label>Ссылка действует, часов</label><input type="number" min={1} max={168} value={draft.acquiringLinkHours} onChange={(event) => set("acquiringLinkHours", Number(event.target.value))} /></div>
      </div>
      <button className="btn-gradient" type="submit">Сохранить кассу</button>
    </form>
  );
}


function StockSettings({ branch, onSaved }: { branch: Branch; onSaved: (branch: Branch) => void }) {
  const toast = useToast();
  const [policy, setPolicy] = useState(branch.consumePolicy);
  const [negative, setNegative] = useState(branch.allowNegativeStock);
  useEffect(() => {
    setPolicy(branch.consumePolicy);
    setNegative(branch.allowNegativeStock);
  }, [branch]);
  return (
    <form
      className="panel list"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          onSaved(await api<Branch>(`/api/branches/${branch.id}`, { method: "PATCH", body: JSON.stringify({ consumePolicy: policy, allowNegativeStock: negative }) }));
          toast("Настройки склада сохранены");
        } catch (error) {
          toast((error as ApiError).message, "error");
        }
      }}
    >
      <h2 style={{ margin: 0 }}>Склад</h2>
      <div className="field">
        <label>Если на завершение визита не хватает материалов</label>
        <select value={policy} onChange={(event) => setPolicy(event.target.value as Branch["consumePolicy"])}>
          <option value="warn">Завершить и предупредить (остаток уйдёт в минус)</option>
          <option value="block">Не давать завершить визит</option>
        </select>
      </div>
      <label className="row"><input type="checkbox" checked={negative} onChange={(event) => setNegative(event.target.checked)} /> Разрешить списание, продажу и перемещение в минус</label>
      <button className="btn-gradient" type="submit">Сохранить склад</button>
    </form>
  );
}

