"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney, rublesToMinor } from "@/domain/money";
import { api, type ApiError } from "./api";
import { Modal, useToast } from "./ui";

type Unit = "pcs" | "ml" | "g" | "pack";
type Item = {
  id: string;
  sku: string;
  title: string;
  unit: Unit;
  trackStock: boolean;
  costMinor: number;
  sellPriceMinor: number;
  forSale: boolean;
  active: boolean;
  qty: number;
  totalQty: number;
};
type Movement = {
  id: string;
  type: string;
  qty: number;
  costMinor: number;
  negative: boolean;
  itemTitle: string;
  unit: Unit;
  reversal: boolean;
  supplier: string | null;
  document: string | null;
  reason: string | null;
  createdAt: string;
  userName: string | null;
};
type CountSummary = { id: string; status: string; createdAt: string; appliedAt: string | null; lines: number; counted: number; varianceCostMinor: number };
type CountSheet = {
  id: string;
  status: string;
  createdAt: string;
  lines: { itemId: string; sku: string; title: string; unit: Unit; expectedQty: number; countedQty: number | null; diffQty: number | null; diffCostMinor: number | null }[];
  summary: { counted: number; total: number; shortageCostMinor: number; surplusCostMinor: number };
};
type Branch = { id: string; name: string; timezone: string };
type Me = { actor: { role: string }; branches: Branch[] };

const UNITS: Record<Unit, string> = { pcs: "шт", ml: "мл", g: "г", pack: "уп" };
const TYPES: Record<string, string> = {
  receipt: "Приход",
  write_off: "Списание",
  sale: "Продажа",
  consume: "Расход на услугу",
  transfer: "Перемещение",
  inventory_adjust: "Инвентаризация",
};
const WRITE = ["owner", "admin", "accountant", "super"];

const fmtQty = (n: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(n);
const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const rub = (value: string) => rublesToMinor(Number(value.replace(",", ".")) || 0);

export function InventoryView() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<"stock" | "moves" | "counts" | "services">("stock");
  const [error, setError] = useState("");
  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe).catch((err: ApiError) => setError(err.message));
  }, []);
  const branch = me?.branches[0];
  if (!me || !branch) return <div className="reports-page">{error ? <div className="banner">{error}</div> : <div className="skeleton" />}</div>;
  const canWrite = WRITE.includes(me.actor.role);

  return (
    <div className="reports-page">
      <div className="journal-top">
        <div>
          <div className="page-kicker">{branch.name}</div>
          <h1 className="date-title">Склад</h1>
        </div>
        <div className="segment">
          <button className={tab === "stock" ? "on" : ""} onClick={() => setTab("stock")}>Остатки</button>
          <button className={tab === "moves" ? "on" : ""} onClick={() => setTab("moves")}>Движения</button>
          {canWrite && <button className={tab === "counts" ? "on" : ""} onClick={() => setTab("counts")}>Инвентаризация</button>}
          {canWrite && <button className={tab === "services" ? "on" : ""} onClick={() => setTab("services")}>Расход на услуги</button>}
        </div>
      </div>
      {error && <div className="banner">{error}</div>}
      {tab === "stock" && <Stock branch={branch} branches={me.branches} canWrite={canWrite} />}
      {tab === "moves" && <Moves branchId={branch.id} />}
      {tab === "counts" && <Counts branchId={branch.id} />}
      {tab === "services" && <ServiceConsumables branchId={branch.id} />}
    </div>
  );
}

function useItems(branchId: string, archived = false) {
  const [items, setItems] = useState<Item[] | null>(null);
  const load = useCallback(() => {
    api<Item[]>(`/api/inventory/items?branchId=${branchId}${archived ? "&archived=1" : ""}`).then(setItems).catch(() => setItems([]));
  }, [branchId, archived]);
  useEffect(load, [load]);
  return { items, reload: load };
}

function Stock({ branch, branches, canWrite }: { branch: Branch; branches: Branch[]; canWrite: boolean }) {
  const toast = useToast();
  const [archived, setArchived] = useState(false);
  const { items, reload } = useItems(branch.id, archived);
  const [modal, setModal] = useState<null | "item" | "receipt" | "writeoff" | "transfer">(null);
  const [preset, setPreset] = useState<string>("");
  const tracked = (items ?? []).filter((item) => item.trackStock && item.active);
  const stockValue = tracked.reduce((sum, item) => sum + Math.max(0, item.qty) * item.costMinor, 0);
  const negatives = tracked.filter((item) => item.qty < 0).length;

  function open(kind: typeof modal, itemId = "") {
    setPreset(itemId);
    setModal(kind);
  }

  async function remove(item: Item) {
    try {
      const result = await api<{ outcome: string }>(`/api/inventory/items/${item.id}`, { method: "DELETE" });
      toast(result.outcome === "archived" ? "Позиция в архиве: по ней есть движения" : "Позиция удалена");
      reload();
    } catch (err) {
      toast((err as ApiError).message, "error");
    }
  }

  async function restore(item: Item) {
    try {
      await api(`/api/inventory/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ active: true }) });
      reload();
    } catch (err) {
      toast((err as ApiError).message, "error");
    }
  }

  return (
    <>
      <div className="report-tiles">
        <div className="panel report-tile">
          <span className="muted">Позиций на учёте</span>
          <b className="display">{tracked.length}</b>
          <small className="muted">всего в каталоге: {(items ?? []).filter((item) => item.active).length}</small>
        </div>
        <div className="panel report-tile">
          <span className="muted">Остаток по себестоимости</span>
          <b className="display">{formatMoney(stockValue)}</b>
          <small className="muted">в филиале «{branch.name}»</small>
        </div>
        <div className="panel report-tile">
          <span className="muted">Ушло в минус</span>
          <b className="display">{negatives}</b>
          <small className="muted">{negatives ? "проверьте приход или проведите инвентаризацию" : "отрицательных остатков нет"}</small>
        </div>
      </div>
      {canWrite && (
        <div className="panel row" style={{ flexWrap: "wrap" }}>
          <button className="btn-gradient" onClick={() => open("receipt")}>Приход</button>
          <button className="btn" onClick={() => open("writeoff")}>Списание</button>
          {branches.length > 1 && <button className="btn" onClick={() => open("transfer")}>Перемещение</button>}
          <button className="btn-ghost" onClick={() => open("item")}>+ Новая позиция</button>
          <label className="row muted" style={{ marginLeft: "auto" }}>
            <input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} /> показать архив
          </label>
        </div>
      )}
      <div className="panel list">
        <table className="report-table">
          <thead>
            <tr><th>Артикул</th><th>Название</th><th className="num">Себестоимость</th><th className="num">Цена продажи</th><th className="num">Остаток</th>{canWrite && <th />}</tr>
          </thead>
          <tbody>
            {items === null && <tr><td colSpan={6} className="muted">Загрузка…</td></tr>}
            {items?.length === 0 && <tr><td colSpan={6} className="muted">Номенклатуры пока нет. Добавьте расходники и товары</td></tr>}
            {items?.map((item) => (
              <tr key={item.id} className={item.active ? "" : "void"}>
                <td className="muted">{item.sku}</td>
                <td>
                  {item.title}
                  {item.forSale && <span className="tag tag-ok" style={{ marginLeft: 6 }}>продаётся</span>}
                  {!item.trackStock && <span className="tag tag-muted" style={{ marginLeft: 6 }}>без учёта</span>}
                </td>
                <td className="num">{formatMoney(item.costMinor)} / {UNITS[item.unit]}</td>
                <td className="num">{item.forSale ? formatMoney(item.sellPriceMinor) : "—"}</td>
                <td className="num">
                  {item.trackStock ? (
                    <span className={item.qty < 0 ? "tag tag-bad" : item.qty === 0 ? "muted" : ""}>{fmtQty(item.qty)} {UNITS[item.unit]}</span>
                  ) : (
                    "—"
                  )}
                </td>
                {canWrite && (
                  <td className="num">
                    {item.active ? (
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        {item.trackStock && <button className="btn-ghost" onClick={() => open("receipt", item.id)}>Приход</button>}
                        <button className="btn danger" onClick={() => remove(item)}>Убрать</button>
                      </div>
                    ) : (
                      <button className="btn-ghost" onClick={() => restore(item)}>Вернуть</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modal === "item" && <ItemModal onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === "receipt" && <ReceiptModal branchId={branch.id} items={tracked} preset={preset} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === "writeoff" && <WriteOffModal branchId={branch.id} items={tracked} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === "transfer" && <TransferModal branch={branch} branches={branches} items={tracked} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
    </>
  );
}

function useSubmit(onDone: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    async submit(path: string, body: unknown, message: string) {
      setBusy(true);
      try {
        await api(path, { method: "POST", body: JSON.stringify(body) });
        toast(message);
        onDone();
      } catch (err) {
        toast((err as ApiError).message, "error");
      } finally {
        setBusy(false);
      }
    },
  };
}

function ItemModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { busy, submit } = useSubmit(onDone);
  const [form, setForm] = useState({ sku: "", title: "", unit: "pcs" as Unit, cost: "", price: "", forSale: false, trackStock: true });
  return (
    <Modal title="Новая позиция" onClose={onClose}>
      <div className="list">
        <div className="field"><label>Название</label><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} autoFocus /></div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}><label>Артикул</label><input value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} /></div>
          <div className="field">
            <label>Единица</label>
            <select value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value as Unit })}>
              {Object.entries(UNITS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
        </div>
        <div className="field"><label>Себестоимость за {UNITS[form.unit]}, ₽</label><input inputMode="decimal" value={form.cost} onChange={(event) => setForm({ ...form, cost: event.target.value })} /></div>
        <label className="row"><input type="checkbox" checked={form.forSale} onChange={(event) => setForm({ ...form, forSale: event.target.checked })} /> продаётся клиентам в кассе</label>
        {form.forSale && <div className="field"><label>Цена продажи, ₽</label><input inputMode="decimal" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} /></div>}
        <label className="row"><input type="checkbox" checked={form.trackStock} onChange={(event) => setForm({ ...form, trackStock: event.target.checked })} /> вести остатки</label>
        <div className="row">
          <button className="btn" onClick={onClose}>Отмена</button>
          <button
            className="btn-gradient"
            disabled={busy}
            onClick={() =>
              submit(
                "/api/inventory/items",
                { sku: form.sku, title: form.title, unit: form.unit, costMinor: rub(form.cost), sellPriceMinor: form.forSale ? rub(form.price) : 0, forSale: form.forSale, trackStock: form.trackStock },
                "Позиция добавлена",
              )
            }
          >
            Добавить
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ItemSelect({ items, value, onChange }: { items: Item[]; value: string; onChange: (id: string) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Выберите позицию</option>
      {items.map((item) => <option key={item.id} value={item.id}>{item.title} · {fmtQty(item.qty)} {UNITS[item.unit]}</option>)}
    </select>
  );
}

function ReceiptModal({ branchId, items, preset, onClose, onDone }: { branchId: string; items: Item[]; preset: string; onClose: () => void; onDone: () => void }) {
  const { busy, submit } = useSubmit(onDone);
  const [supplier, setSupplier] = useState("");
  const [document, setDocument] = useState("");
  const [lines, setLines] = useState([{ itemId: preset, qty: "", cost: "" }]);
  const set = (index: number, patch: Partial<(typeof lines)[number]>) => setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  const total = lines.reduce((sum, line) => {
    const item = items.find((entry) => entry.id === line.itemId);
    const cost = line.cost ? rub(line.cost) : item?.costMinor ?? 0;
    return sum + Math.round(cost * (Number(line.qty.replace(",", ".")) || 0));
  }, 0);
  return (
    <Modal title="Приход на склад" onClose={onClose}>
      <div className="list">
        <div className="row">
          <div className="field" style={{ flex: 1 }}><label>Поставщик</label><input value={supplier} onChange={(event) => setSupplier(event.target.value)} /></div>
          <div className="field" style={{ width: 120 }}><label>Документ №</label><input value={document} onChange={(event) => setDocument(event.target.value)} /></div>
        </div>
        {lines.map((line, index) => {
          const item = items.find((entry) => entry.id === line.itemId);
          return (
            <div key={index} className="list" style={{ gap: 6, borderTop: index ? "1px solid var(--line)" : undefined, paddingTop: index ? 8 : 0 }}>
              <div className="field"><label>Позиция</label><ItemSelect items={items} value={line.itemId} onChange={(itemId) => set(index, { itemId })} /></div>
              <div className="row">
                <div className="field" style={{ flex: 1 }}><label>Количество{item ? `, ${UNITS[item.unit]}` : ""}</label><input inputMode="decimal" value={line.qty} onChange={(event) => set(index, { qty: event.target.value })} /></div>
                <div className="field" style={{ flex: 1 }}>
                  <label>Цена за ед., ₽</label>
                  <input inputMode="decimal" placeholder={item ? String(item.costMinor / 100) : ""} value={line.cost} onChange={(event) => set(index, { cost: event.target.value })} />
                </div>
              </div>
            </div>
          );
        })}
        <button className="btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setLines([...lines, { itemId: "", qty: "", cost: "" }])}>+ Ещё позиция</button>
        <div className="row">
          <button className="btn" onClick={onClose}>Отмена</button>
          <button
            className="btn-gradient"
            disabled={busy || lines.some((line) => !line.itemId || !line.qty)}
            onClick={() =>
              submit(
                "/api/inventory/receipt",
                { branchId, supplier, document, lines: lines.map((line) => ({ itemId: line.itemId, qty: line.qty, costMinor: line.cost ? rub(line.cost) : undefined })) },
                "Приход проведён",
              )
            }
          >
            Провести {total > 0 ? formatMoney(total) : ""}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function WriteOffModal({ branchId, items, onClose, onDone }: { branchId: string; items: Item[]; onClose: () => void; onDone: () => void }) {
  const { busy, submit } = useSubmit(onDone);
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  return (
    <Modal title="Списание" onClose={onClose}>
      <div className="list">
        <div className="field"><label>Позиция</label><ItemSelect items={items} value={itemId} onChange={setItemId} /></div>
        <div className="field"><label>Количество</label><input inputMode="decimal" value={qty} onChange={(event) => setQty(event.target.value)} /></div>
        <div className="field"><label>Причина</label><input value={reason} placeholder="Брак, просрочка, на нужды салона" onChange={(event) => setReason(event.target.value)} /></div>
        <div className="row">
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn-gradient" disabled={busy || !itemId || !qty || !reason.trim()} onClick={() => submit("/api/inventory/write-off", { branchId, itemId, qty, reason }, "Списано")}>
            Списать
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TransferModal({ branch, branches, items, onClose, onDone }: { branch: Branch; branches: Branch[]; items: Item[]; onClose: () => void; onDone: () => void }) {
  const { busy, submit } = useSubmit(onDone);
  const others = branches.filter((entry) => entry.id !== branch.id);
  const [to, setTo] = useState(others[0]?.id ?? "");
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("");
  return (
    <Modal title={`Перемещение из «${branch.name}»`} onClose={onClose}>
      <div className="list">
        <div className="field">
          <label>Куда</label>
          <select value={to} onChange={(event) => setTo(event.target.value)}>
            {others.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Позиция</label><ItemSelect items={items} value={itemId} onChange={setItemId} /></div>
        <div className="field"><label>Количество</label><input inputMode="decimal" value={qty} onChange={(event) => setQty(event.target.value)} /></div>
        <div className="row">
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn-gradient" disabled={busy || !itemId || !qty || !to} onClick={() => submit("/api/inventory/transfer", { fromBranchId: branch.id, toBranchId: to, itemId, qty }, "Перемещено")}>
            Переместить
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Moves({ branchId }: { branchId: string }) {
  const [type, setType] = useState("");
  const [moves, setMoves] = useState<Movement[] | null>(null);
  useEffect(() => {
    setMoves(null);
    api<Movement[]>(`/api/inventory/movements?branchId=${branchId}${type ? `&type=${type}` : ""}`).then(setMoves).catch(() => setMoves([]));
  }, [branchId, type]);
  return (
    <div className="panel list">
      <div className="row">
        <span className="muted">Тип</span>
        <select className="report-date" value={type} onChange={(event) => setType(event.target.value)}>
          <option value="">Все движения</option>
          {Object.entries(TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <table className="report-table">
        <thead><tr><th>Когда</th><th>Тип</th><th>Позиция</th><th>Детали</th><th className="num">Кол-во</th><th className="num">Сумма</th></tr></thead>
        <tbody>
          {moves === null && <tr><td colSpan={6} className="muted">Загрузка…</td></tr>}
          {moves?.length === 0 && <tr><td colSpan={6} className="muted">Движений нет</td></tr>}
          {moves?.map((move) => (
            <tr key={move.id}>
              <td className="muted">{fmtTime(move.createdAt)}</td>
              <td>
                <span className={`tag ${move.qty > 0 ? "tag-ok" : "tag-muted"}`}>{TYPES[move.type] ?? move.type}</span>
                {move.reversal && <span className="tag tag-warn" style={{ marginLeft: 4 }}>возврат</span>}
                {move.negative && <span className="tag tag-bad" style={{ marginLeft: 4 }}>в минус</span>}
              </td>
              <td>{move.itemTitle}</td>
              <td className="muted">{[move.supplier, move.document && `№ ${move.document}`, move.reason, move.userName].filter(Boolean).join(" · ")}</td>
              <td className="num">{move.qty > 0 ? "+" : ""}{fmtQty(move.qty)} {UNITS[move.unit]}</td>
              <td className="num">{formatMoney(Math.round(Math.abs(move.qty) * move.costMinor))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Counts({ branchId }: { branchId: string }) {
  const toast = useToast();
  const [counts, setCounts] = useState<CountSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const load = useCallback(() => {
    api<CountSummary[]>(`/api/inventory/counts?branchId=${branchId}`).then(setCounts).catch(() => setCounts([]));
  }, [branchId]);
  useEffect(load, [load]);
  if (openId) return <CountSheetView id={openId} onBack={() => { setOpenId(null); load(); }} />;
  const STATUS: Record<string, [string, string]> = { open: ["Идёт", "tag-warn"], applied: ["Проведена", "tag-ok"], cancelled: ["Отменена", "tag-muted"] };
  return (
    <>
      <div className="panel spread">
        <span className="muted">Система запомнит ожидаемые остатки, вы вводите факт, расхождения проводятся одной кнопкой.</span>
        <button
          className="btn-gradient"
          onClick={async () => {
            try {
              const sheet = await api<CountSheet>("/api/inventory/counts", { method: "POST", body: JSON.stringify({ branchId }) });
              setOpenId(sheet.id);
            } catch (err) {
              toast((err as ApiError).message, "error");
            }
          }}
        >
          Начать инвентаризацию
        </button>
      </div>
      <div className="panel list">
        <table className="report-table">
          <thead><tr><th>Начата</th><th>Статус</th><th className="num">Посчитано</th><th className="num">Расхождение</th></tr></thead>
          <tbody>
            {counts?.length === 0 && <tr><td colSpan={4} className="muted">Инвентаризаций ещё не было</td></tr>}
            {counts?.map((count) => (
              <tr key={count.id}>
                <td><a href="#" onClick={(event) => { event.preventDefault(); setOpenId(count.id); }}>{fmtTime(count.createdAt)}</a></td>
                <td><span className={`tag ${STATUS[count.status]?.[1]}`}>{STATUS[count.status]?.[0]}</span></td>
                <td className="num">{count.counted} из {count.lines}</td>
                <td className="num">{formatMoney(count.varianceCostMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CountSheetView({ id, onBack }: { id: string; onBack: () => void }) {
  const toast = useToast();
  const [sheet, setSheet] = useState<CountSheet | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    api<CountSheet>(`/api/inventory/counts/${id}`)
      .then((data) => {
        setSheet(data);
        setDraft(Object.fromEntries(data.lines.map((line) => [line.itemId, line.countedQty === null ? "" : String(line.countedQty)])));
      })
      .catch((err: ApiError) => toast(err.message, "error"));
  }, [id, toast]);

  async function call(path: string, method: string, body?: unknown) {
    try {
      const data = await api<CountSheet>(`/api/inventory/counts/${id}${path}`, { method, body: body ? JSON.stringify(body) : undefined });
      setSheet(data);
      return data;
    } catch (err) {
      toast((err as ApiError).message, "error");
      return null;
    }
  }

  if (!sheet) return <div className="skeleton" />;
  const open = sheet.status === "open";
  const save = () => call("/lines", "PUT", { lines: Object.entries(draft).map(([itemId, countedQty]) => ({ itemId, countedQty: countedQty === "" ? null : countedQty })) });

  return (
    <>
      <div className="panel spread" style={{ flexWrap: "wrap" }}>
        <div className="row">
          <button className="btn-ghost" onClick={onBack}>‹ Все инвентаризации</button>
          <b>от {fmtTime(sheet.createdAt)}</b>
          <span className="muted">посчитано {sheet.summary.counted} из {sheet.summary.total}</span>
        </div>
        <div className="row">
          <span className="muted">недостача {formatMoney(-sheet.summary.shortageCostMinor)} · излишек {formatMoney(sheet.summary.surplusCostMinor)}</span>
          {open && <button className="btn" onClick={save}>Сохранить</button>}
          {open && (
            <button
              className="btn-gradient"
              onClick={async () => {
                if (await save()) {
                  const done = await call("/apply", "POST");
                  if (done) toast("Остатки скорректированы");
                }
              }}
            >
              Провести
            </button>
          )}
          {open && <button className="btn danger" onClick={() => call("/cancel", "POST")}>Отменить</button>}
        </div>
      </div>
      <div className="panel list">
        <table className="report-table">
          <thead><tr><th>Позиция</th><th className="num">Ожидалось</th><th className="num">Факт</th><th className="num">Разница</th><th className="num">На сумму</th></tr></thead>
          <tbody>
            {sheet.lines.map((line) => (
              <tr key={line.itemId}>
                <td>{line.title} <span className="muted">· {line.sku}</span></td>
                <td className="num">{fmtQty(line.expectedQty)} {UNITS[line.unit]}</td>
                <td className="num">
                  {open ? (
                    <input
                      className="report-date"
                      style={{ width: 90, textAlign: "right" }}
                      inputMode="decimal"
                      value={draft[line.itemId] ?? ""}
                      onChange={(event) => setDraft({ ...draft, [line.itemId]: event.target.value })}
                    />
                  ) : line.countedQty === null ? "—" : `${fmtQty(line.countedQty)} ${UNITS[line.unit]}`}
                </td>
                <td className="num">
                  {line.diffQty === null ? "—" : line.diffQty === 0 ? <span className="muted">0</span> : (
                    <span className={line.diffQty < 0 ? "tag tag-bad" : "tag tag-ok"}>{line.diffQty > 0 ? "+" : ""}{fmtQty(line.diffQty)}</span>
                  )}
                </td>
                <td className="num">{line.diffCostMinor ? formatMoney(line.diffCostMinor) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ServiceConsumables({ branchId }: { branchId: string }) {
  const toast = useToast();
  const { items } = useItems(branchId);
  const [services, setServices] = useState<{ id: string; title: string }[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [lines, setLines] = useState<{ itemId: string; qty: string }[]>([]);
  useEffect(() => {
    api<{ services: { id: string; title: string }[] }>("/api/catalog").then((catalog) => setServices(catalog.services)).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!serviceId) return;
    api<{ itemId: string; qty: number }[]>(`/api/inventory/consumables/${serviceId}`)
      .then((rows) => setLines(rows.map((row) => ({ itemId: row.itemId, qty: String(row.qty) }))))
      .catch(() => setLines([]));
  }, [serviceId]);
  const tracked = (items ?? []).filter((item) => item.trackStock && item.active);
  const cost = lines.reduce((sum, line) => sum + Math.round((tracked.find((item) => item.id === line.itemId)?.costMinor ?? 0) * (Number(line.qty.replace(",", ".")) || 0)), 0);
  return (
    <div className="panel list">
      <div className="row" style={{ flexWrap: "wrap" }}>
        <span className="muted">Услуга</span>
        <select className="report-date" value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
          <option value="">Выберите услугу</option>
          {services.map((service) => <option key={service.id} value={service.id}>{service.title}</option>)}
        </select>
        {serviceId && <span className="muted">материалы на одну услугу: {formatMoney(cost)}</span>}
      </div>
      {serviceId && (
        <>
          {lines.map((line, index) => {
            const item = tracked.find((entry) => entry.id === line.itemId);
            return (
              <div key={index} className="row">
                <select className="report-date" style={{ flex: 1 }} value={line.itemId} onChange={(event) => setLines(lines.map((l, i) => (i === index ? { ...l, itemId: event.target.value } : l)))}>
                  <option value="">Позиция</option>
                  {tracked.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
                </select>
                <input className="report-date" style={{ width: 90 }} inputMode="decimal" value={line.qty} onChange={(event) => setLines(lines.map((l, i) => (i === index ? { ...l, qty: event.target.value } : l)))} />
                <span className="muted" style={{ width: 28 }}>{item ? UNITS[item.unit] : ""}</span>
                <button className="btn danger" onClick={() => setLines(lines.filter((_, i) => i !== index))}>Убрать</button>
              </div>
            );
          })}
          <div className="row">
            <button className="btn-ghost" onClick={() => setLines([...lines, { itemId: "", qty: "1" }])}>+ Материал</button>
            <button
              className="btn-gradient"
              onClick={async () => {
                try {
                  await api(`/api/inventory/consumables/${serviceId}`, { method: "PUT", body: JSON.stringify({ lines: lines.filter((line) => line.itemId) }) });
                  toast("Сохранено. Материалы спишутся, когда визит завершат");
                } catch (err) {
                  toast((err as ApiError).message, "error");
                }
              }}
            >
              Сохранить
            </button>
          </div>
          <small className="muted">Когда визит с этой услугой завершают, материалы списываются со склада филиала. Если остатка не хватает, по умолчанию визит всё равно завершится, а движение отметится «в минус» (запретить можно в настройках филиала).</small>
        </>
      )}
    </div>
  );
}
