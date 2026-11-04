"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type ApiError } from "./api";
import { initials, Modal, useToast } from "./ui";

type Staff = { id: string; displayName: string; color: string; specialties: string; active: boolean; onlineBookable: boolean; branchIds: string[] };
type Interval = { weekday: number; startMin: number; endMin: number; kind: "work" | "break" };
type Kind = "day_off" | "vacation" | "special_hours";
type Exception = { id: string; startsOn: string; endsOn: string; kind: Kind; startMin: number | null; endMin: number | null; note: string };
type Request = {
  id: string;
  staffId: string;
  staffName: string;
  kind: "template" | "exception";
  payload: { intervals?: Interval[]; kind?: Kind; startsOn?: string; endsOn?: string; startMin?: number; endMin?: number };
  comment: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  decisionNote: string | null;
  createdAt: string;
};
type Branch = { id: string; name: string };
type Me = { actor: { role: string; staffId: string | null }; branches: Branch[] };

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const KIND_LABEL: Record<Kind, string> = { day_off: "Выходной", vacation: "Отпуск", special_hours: "Особые часы" };
const STATUS: Record<Request["status"], [string, string]> = {
  pending: ["ждёт решения", "tag-warn"],
  approved: ["согласовано", "tag-ok"],
  rejected: ["отказ", "tag-bad"],
  withdrawn: ["отозван", "tag-muted"],
};
const ADMIN = ["owner", "admin", "super"];

const hhmm = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const toMin = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso: string) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", weekday: "short" }).format(new Date(`${iso}T12:00:00Z`));
const fmtRange = (from: string, to: string) => (from === to ? fmtDate(from) : `${fmtDate(from)} — ${fmtDate(to)}`);
const describeException = (item: { kind?: Kind; startsOn?: string; endsOn?: string; startMin?: number | null; endMin?: number | null }) =>
  `${KIND_LABEL[item.kind ?? "day_off"]} · ${fmtRange(item.startsOn ?? "", item.endsOn ?? item.startsOn ?? "")}${
    item.kind === "special_hours" && item.startMin != null && item.endMin != null ? ` · ${hhmm(item.startMin)}–${hhmm(item.endMin)}` : ""
  }`;
const weekHours = (intervals: Interval[]) => {
  const work = intervals.filter((item) => item.kind === "work").reduce((sum, item) => sum + item.endMin - item.startMin, 0);
  const rest = intervals.filter((item) => item.kind === "break").reduce((sum, item) => sum + item.endMin - item.startMin, 0);
  return Math.round(((work - rest) / 60) * 10) / 10;
};

export function StaffView() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe).catch(() => setMe(null));
  }, []);
  if (!me) return <div className="reports-page"><div className="skeleton" /></div>;
  if (me.actor.role === "master") return <MySchedule me={me} />;
  return <TeamView me={me} />;
}

// ---------- Admin: the team ----------

function TeamView({ me }: { me: Me }) {
  const toast = useToast();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [selected, setSelected] = useState("");
  const [branchId, setBranchId] = useState(me.branches[0]?.id ?? "");
  const [name, setName] = useState("");
  const [tab, setTab] = useState<"team" | "requests">("team");
  const [pending, setPending] = useState(0);
  const canEdit = ADMIN.includes(me.actor.role);

  const load = useCallback(async () => {
    const rows = await api<Staff[]>("/api/staff");
    setStaff(rows);
    setSelected((current) => current || rows.find((row) => row.active)?.id || "");
  }, []);
  const loadPending = useCallback(() => {
    if (!canEdit) return;
    api<Request[]>(`/api/schedule-requests?branchId=${branchId}&status=pending`).then((rows) => setPending(rows.length)).catch(() => setPending(0));
  }, [branchId, canEdit]);
  useEffect(() => {
    load().catch((error: ApiError) => toast(error.message, "error"));
  }, [load, toast]);
  useEffect(loadPending, [loadPending]);

  const person = staff.find((row) => row.id === selected);
  const personBranches = me.branches.filter((branch) => person?.branchIds.includes(branch.id));
  const scheduleBranch = personBranches.some((branch) => branch.id === branchId) ? branchId : personBranches[0]?.id ?? branchId;

  return (
    <div className="reports-page">
      <div className="journal-top">
        <div>
          <div className="page-kicker">Команда</div>
          <h1 className="date-title">Мастера</h1>
        </div>
        <div className="row">
          {me.branches.length > 1 && (
            <select className="report-date" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              {me.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          )}
          {canEdit && (
            <div className="segment">
              <button className={tab === "team" ? "on" : ""} onClick={() => setTab("team")}>График</button>
              <button className={tab === "requests" ? "on" : ""} onClick={() => setTab("requests")}>
                Запросы мастеров{pending ? ` · ${pending}` : ""}
              </button>
            </div>
          )}
        </div>
      </div>
      {tab === "requests" ? (
        <RequestsInbox branchId={branchId} onChanged={loadPending} />
      ) : (
        <div className="staff-grid">
          <div className="list">
            {canEdit && (
              <form
                className="panel row"
                onSubmit={async (event) => {
                  event.preventDefault();
                  try {
                    const created = await api<Staff>("/api/staff", { method: "POST", body: JSON.stringify({ displayName: name, branchIds: [branchId] }) });
                    setName("");
                    toast("Мастер добавлен");
                    await load();
                    setSelected(created.id);
                  } catch (error) {
                    toast((error as ApiError).message, "error");
                  }
                }}
              >
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Имя нового мастера" required style={{ flex: 1, minWidth: 0 }} />
                <button className="btn-gradient" type="submit">Добавить</button>
              </form>
            )}
            {staff.map((row) => (
              <button key={row.id} className={`person ${row.id === selected ? "on" : ""}`} type="button" onClick={() => setSelected(row.id)} style={{ opacity: row.active ? 1 : 0.55 }}>
                <div className="avatar" style={{ background: row.color }}>{initials(row.displayName)}</div>
                <div>
                  <strong>{row.displayName}</strong>
                  <span>{row.active ? row.specialties || "мастер" : "деактивирован"}</span>
                </div>
              </button>
            ))}
          </div>
          {person ? (
            <div className="list" key={`${person.id}-${scheduleBranch}`}>
              <Profile person={person} branches={me.branches} staff={staff} canEdit={canEdit} onChanged={load} />
              <WeekEditor staffId={person.id} branchId={scheduleBranch} mode={canEdit ? "edit" : "view"} />
              <Exceptions staffId={person.id} branchId={scheduleBranch} canEdit={canEdit} />
            </div>
          ) : (
            <div className="panel empty">Выберите мастера</div>
          )}
        </div>
      )}
    </div>
  );
}

function Profile({ person, branches, staff, canEdit, onChanged }: { person: Staff; branches: Branch[]; staff: Staff[]; canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ displayName: person.displayName, color: person.color, specialties: person.specialties, onlineBookable: person.onlineBookable, branchIds: person.branchIds });
  const [deactivating, setDeactivating] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify({ displayName: person.displayName, color: person.color, specialties: person.specialties, onlineBookable: person.onlineBookable, branchIds: person.branchIds });
  async function save() {
    try {
      await api(`/api/staff/${person.id}`, { method: "PATCH", body: JSON.stringify(form) });
      toast("Профиль сохранён");
      onChanged();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }
  return (
    <div className="panel list">
      <div className="spread">
        <div className="row">
          <div className="avatar" style={{ background: form.color }}>{initials(form.displayName || "?")}</div>
          <h2 className="display" style={{ fontSize: 22, margin: 0 }}>{person.displayName}</h2>
          {!person.active && <span className="tag tag-muted">деактивирован</span>}
        </div>
        {canEdit && person.active && <button className="btn danger" type="button" onClick={() => setDeactivating(true)}>Деактивировать</button>}
      </div>
      {canEdit && (
        <>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>Имя</label><input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></div>
            <div className="field" style={{ flex: 1 }}><label>Специализация</label><input value={form.specialties} placeholder="маникюр, педикюр" onChange={(event) => setForm({ ...form, specialties: event.target.value })} /></div>
            <div className="field"><label>Цвет</label><input type="color" value={form.color} onChange={(event) => setForm({ ...form, color: event.target.value })} style={{ width: 52, padding: 2 }} /></div>
          </div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <label className="row"><input type="checkbox" checked={form.onlineBookable} onChange={(event) => setForm({ ...form, onlineBookable: event.target.checked })} /> доступен в онлайн-записи</label>
            {branches.length > 1 &&
              branches.map((branch) => (
                <label key={branch.id} className="row">
                  <input
                    type="checkbox"
                    checked={form.branchIds.includes(branch.id)}
                    onChange={(event) =>
                      setForm({ ...form, branchIds: event.target.checked ? [...form.branchIds, branch.id] : form.branchIds.filter((id) => id !== branch.id) })
                    }
                  />{" "}
                  {branch.name}
                </label>
              ))}
            {dirty && <button className="btn" type="button" onClick={save} style={{ marginLeft: "auto" }}>Сохранить профиль</button>}
          </div>
        </>
      )}
      {deactivating && <DeactivateModal person={person} staff={staff} onClose={() => setDeactivating(false)} onDone={() => { setDeactivating(false); onChanged(); }} />}
    </div>
  );
}

function DeactivateModal({ person, staff, onClose, onDone }: { person: Staff; staff: Staff[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [future, setFuture] = useState<number | null>(null);
  const [decision, setDecision] = useState<"reassign" | "cancel">("reassign");
  const others = staff.filter((row) => row.active && row.id !== person.id);
  const [target, setTarget] = useState(others[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  async function go(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await api(`/api/staff/${person.id}/deactivate`, { method: "POST", body: JSON.stringify(body) });
      toast(`${person.displayName}: деактивирован, история сохранена`);
      onDone();
    } catch (error) {
      const err = error as ApiError;
      if (err.details && typeof err.details.futureCount === "number") setFuture(err.details.futureCount);
      else toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Деактивировать: ${person.displayName}`} onClose={onClose}>
      <div className="list">
        <p className="muted">Мастер пропадёт из журнала и онлайн-записи. Прошлые визиты, оплаты и зарплата останутся.</p>
        {future === null ? (
          <button className="btn danger" disabled={busy} onClick={() => go({})}>Продолжить</button>
        ) : (
          <>
            <div className="banner">У мастера {future} будущих записей. Что с ними сделать?</div>
            <label className="row"><input type="radio" checked={decision === "reassign"} onChange={() => setDecision("reassign")} /> перенести к другому мастеру</label>
            {decision === "reassign" && (
              <select value={target} onChange={(event) => setTarget(event.target.value)}>
                {others.map((row) => <option key={row.id} value={row.id}>{row.displayName}</option>)}
              </select>
            )}
            <label className="row"><input type="radio" checked={decision === "cancel"} onChange={() => setDecision("cancel")} /> отменить записи</label>
            <button className="btn danger" disabled={busy || (decision === "reassign" && !target)} onClick={() => go(decision === "reassign" ? { decision, reassignToStaffId: target } : { decision })}>
              Деактивировать
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------- Week template ----------

function WeekEditor({
  staffId,
  branchId,
  mode,
  onRequest,
}: {
  staffId: string;
  branchId: string;
  mode: "edit" | "view" | "request";
  onRequest?: (intervals: Interval[], comment: string) => Promise<boolean>;
}) {
  const toast = useToast();
  const [saved, setSaved] = useState<Interval[] | null>(null);
  const [intervals, setIntervals] = useState<Interval[]>([]);
  const [editing, setEditing] = useState(mode === "edit");
  const [comment, setComment] = useState("");
  const load = useCallback(() => {
    api<Interval[]>(`/api/staff/${staffId}/schedule?branchId=${branchId}`)
      .then((rows) => {
        setSaved(rows);
        setIntervals(rows);
      })
      .catch((error: ApiError) => toast(error.message, "error"));
  }, [staffId, branchId, toast]);
  useEffect(load, [load]);
  const dirty = JSON.stringify(saved) !== JSON.stringify(intervals);
  const readOnly = !editing;

  const dayRows = (weekday: number) => intervals.map((item, index) => ({ item, index })).filter(({ item }) => item.weekday === weekday).sort((a, b) => a.item.startMin - b.item.startMin);
  const patch = (index: number, change: Partial<Interval>) => setIntervals((rows) => rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const remove = (index: number) => setIntervals((rows) => rows.filter((_, i) => i !== index));
  const add = (weekday: number, kind: "work" | "break") => {
    const works = intervals.filter((row) => row.weekday === weekday && row.kind === "work").sort((a, b) => a.startMin - b.startMin);
    const last = works[works.length - 1];
    const item: Interval =
      kind === "break"
        ? { weekday, kind, startMin: last ? Math.min(last.endMin - 60, 780) : 780, endMin: last ? Math.min(last.endMin, 840) : 840 }
        : { weekday, kind, startMin: last ? last.endMin + 60 : 600, endMin: last ? Math.min(1440, last.endMin + 240) : 1200 };
    setIntervals((rows) => [...rows, item]);
  };
  const copyToWeekdays = (weekday: number) =>
    setIntervals((rows) => [
      ...rows.filter((row) => row.weekday === weekday || row.weekday > 5),
      ...[1, 2, 3, 4, 5].filter((day) => day !== weekday).flatMap((day) => rows.filter((row) => row.weekday === weekday).map((row) => ({ ...row, weekday: day }))),
    ]);

  async function save() {
    try {
      if (mode === "request") {
        if (await onRequest?.(intervals, comment)) {
          setIntervals(saved ?? []);
          setComment("");
          setEditing(false);
        }
        return;
      }
      await api(`/api/staff/${staffId}/schedule`, { method: "PUT", body: JSON.stringify({ branchId, intervals }) });
      toast("График сохранён");
      load();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  return (
    <div className="panel list">
      <div className="spread">
        <h2 style={{ margin: 0 }}>Неделя</h2>
        <span className="muted">{weekHours(intervals)} ч в неделю</span>
      </div>
      {saved === null ? (
        <div className="skeleton" />
      ) : (
        <div className="week-grid">
          {DAYS.map((label, index) => {
            const weekday = index + 1;
            const rows = dayRows(weekday);
            return (
              <div key={label} className="week-row">
                <strong className={weekday > 5 ? "muted" : ""}>{label}</strong>
                <div className="week-cells">
                  {rows.length === 0 && <span className="muted">выходной</span>}
                  {rows.map(({ item, index: i }) =>
                    readOnly ? (
                      <span key={i} className={`chip ${item.kind === "break" ? "warn" : ""}`}>
                        {item.kind === "break" ? "перерыв " : ""}
                        {hhmm(item.startMin)}–{hhmm(item.endMin)}
                      </span>
                    ) : (
                      <span key={i} className={`interval ${item.kind}`}>
                        {item.kind === "break" && <small>перерыв</small>}
                        <TimeInput value={item.startMin} onChange={(startMin) => patch(i, { startMin })} />
                        –
                        <TimeInput value={item.endMin} onChange={(endMin) => patch(i, { endMin })} />
                        <button type="button" className="icon-btn" aria-label="Убрать" onClick={() => remove(i)}>×</button>
                      </span>
                    ),
                  )}
                </div>
                {!readOnly && (
                  <div className="row week-actions">
                    <button type="button" className="btn-ghost" onClick={() => add(weekday, "work")}>+ часы</button>
                    {rows.some(({ item }) => item.kind === "work") && <button type="button" className="btn-ghost" onClick={() => add(weekday, "break")}>+ перерыв</button>}
                    {weekday <= 5 && rows.length > 0 && <button type="button" className="btn-ghost" title="Скопировать этот день на все будни" onClick={() => copyToWeekdays(weekday)}>на будни</button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {mode === "request" && !editing && (
        <button className="btn" type="button" onClick={() => setEditing(true)}>Предложить другой график</button>
      )}
      {editing && mode === "request" && dirty && (
        <input placeholder="Комментарий для администратора" value={comment} onChange={(event) => setComment(event.target.value)} />
      )}
      {editing && (dirty || mode === "request") && (
        <div className="row">
          {dirty && <button className="btn-gradient" type="button" onClick={save}>{mode === "request" ? "Отправить на согласование" : "Сохранить неделю"}</button>}
          <button className="btn" type="button" onClick={() => { setIntervals(saved ?? []); if (mode === "request") setEditing(false); }}>Отменить</button>
        </div>
      )}
    </div>
  );
}

// ---------- Exceptions ----------

function ExceptionForm({ onSubmit, submitLabel, needComment }: { onSubmit: (body: Record<string, unknown>) => Promise<boolean>; submitLabel: string; needComment?: boolean }) {
  const [form, setForm] = useState({ kind: "day_off" as Kind, startsOn: today(), endsOn: today(), start: "10:00", end: "16:00", note: "" });
  return (
    <div className="exception-form">
      <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as Kind })}>
        {Object.entries(KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <input type="date" value={form.startsOn} onChange={(event) => setForm({ ...form, startsOn: event.target.value, endsOn: form.endsOn < event.target.value ? event.target.value : form.endsOn })} />
      {form.kind === "special_hours" ? (
        <>
          <TimeInput value={toMin(form.start)} onChange={(value) => setForm({ ...form, start: hhmm(value) })} />
          <TimeInput value={toMin(form.end)} onChange={(value) => setForm({ ...form, end: hhmm(value) })} />
        </>
      ) : (
        <input type="date" value={form.endsOn} min={form.startsOn} onChange={(event) => setForm({ ...form, endsOn: event.target.value })} />
      )}
      <input placeholder={needComment ? "Причина" : "Комментарий"} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      <button
        type="button"
        className="btn-gradient"
        disabled={needComment && !form.note.trim()}
        onClick={async () => {
          const body = {
            kind: form.kind,
            startsOn: form.startsOn,
            endsOn: form.kind === "special_hours" ? form.startsOn : form.endsOn,
            ...(form.kind === "special_hours" ? { startMin: toMin(form.start), endMin: toMin(form.end) } : {}),
            note: form.note,
          };
          if (await onSubmit(body)) setForm({ ...form, note: "" });
        }}
      >
        {submitLabel}
      </button>
    </div>
  );
}

function Exceptions({ staffId, branchId, canEdit, onRequest }: { staffId: string; branchId: string; canEdit: boolean; onRequest?: (body: Record<string, unknown>) => Promise<boolean> }) {
  const toast = useToast();
  const [rows, setRows] = useState<Exception[] | null>(null);
  const [confirm, setConfirm] = useState<{ body: Record<string, unknown>; message: string } | null>(null);
  const load = useCallback(() => {
    api<Exception[]>(`/api/staff/${staffId}/exceptions?branchId=${branchId}&from=${today()}`).then(setRows).catch(() => setRows([]));
  }, [staffId, branchId]);
  useEffect(load, [load]);

  async function add(body: Record<string, unknown>) {
    try {
      const result = await api<{ affected: number }>(`/api/staff/${staffId}/exceptions`, { method: "POST", body: JSON.stringify({ ...body, branchId }) });
      toast(result.affected ? `Сохранено. Перенесите ${result.affected} зап. в журнале` : "Исключение добавлено");
      setConfirm(null);
      load();
      return true;
    } catch (error) {
      const err = error as ApiError;
      if (err.code === "SOFT_CONFIRM") setConfirm({ body: { ...body, acknowledgeSoft: true }, message: err.message });
      else toast(err.message, "error");
      return false;
    }
  }
  async function remove(id: string) {
    try {
      await api(`/api/schedule-exceptions/${id}`, { method: "DELETE" });
      load();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }
  async function copyWeek() {
    try {
      const result = await api<{ copied: number }>(`/api/staff/${staffId}/copy-week`, { method: "POST", body: JSON.stringify({ branchId, date: today() }) });
      toast(result.copied ? `Скопировано на следующую неделю: ${result.copied}` : "На этой неделе исключений нет");
      load();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  return (
    <div className="panel list">
      <div className="spread">
        <h2 style={{ margin: 0 }}>Выходные, отпуска, особые часы</h2>
        {canEdit && <button className="btn-ghost" type="button" onClick={copyWeek} title="Исключения этой недели повторятся на следующей">Повторить эту неделю на следующей</button>}
      </div>
      {rows?.length === 0 && <span className="muted">Исключений нет, мастер работает по неделе.</span>}
      {rows?.map((row) => (
        <div key={row.id} className="spread person">
          <div>
            <strong>{describeException(row)}</strong>
            {row.note && <span>{row.note}</span>}
          </div>
          {canEdit && <button className="icon-btn" type="button" aria-label="Удалить" onClick={() => remove(row.id)}>×</button>}
        </div>
      ))}
      {canEdit && <ExceptionForm onSubmit={add} submitLabel="Добавить" />}
      {onRequest && <ExceptionForm onSubmit={onRequest} submitLabel="Попросить" needComment />}
      {confirm && (
        <Modal title="На эти дни есть записи" onClose={() => setConfirm(null)}>
          <div className="list">
            <p>{confirm.message}.</p>
            <div className="row">
              <button className="btn" onClick={() => setConfirm(null)}>Не сохранять</button>
              <button className="btn-gradient" onClick={() => add(confirm.body)}>Сохранить всё равно</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- Requests ----------

function RequestCard({ row, admin, onDecide }: { row: Request; admin: boolean; onDecide?: (approve: boolean, note: string) => void }) {
  const [note, setNote] = useState("");
  const [tag, tone] = STATUS[row.status];
  return (
    <div className="panel list">
      <div className="spread">
        <div>
          <strong>{admin ? `${row.staffName}: ` : ""}{row.kind === "template" ? "новая неделя" : describeException(row.payload)}</strong>
          <div className="muted" style={{ fontSize: 13 }}>{new Date(row.createdAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}{row.comment ? ` · «${row.comment}»` : ""}</div>
        </div>
        <span className={`tag ${tone}`}>{tag}</span>
      </div>
      {row.kind === "template" && (
        <div className="chips">
          {DAYS.map((label, index) => {
            const items = (row.payload.intervals ?? []).filter((item) => item.weekday === index + 1 && item.kind === "work");
            return <span key={label} className="chip">{label} {items.length ? items.map((item) => `${hhmm(item.startMin)}–${hhmm(item.endMin)}`).join(", ") : "выходной"}</span>;
          })}
        </div>
      )}
      {row.decisionNote && <div className="muted">Ответ: {row.decisionNote}</div>}
      {row.status === "pending" && onDecide && (
        <div className="row">
          {admin && <input placeholder="Комментарий мастеру (для отказа обязателен)" value={note} onChange={(event) => setNote(event.target.value)} style={{ flex: 1 }} />}
          {admin && <button className="btn-gradient" onClick={() => onDecide(true, note)}>Согласовать</button>}
          <button className="btn" onClick={() => onDecide(false, note)}>{admin ? "Отказать" : "Отозвать"}</button>
        </div>
      )}
    </div>
  );
}

function useRequests(branchId: string) {
  const [rows, setRows] = useState<Request[] | null>(null);
  const load = useCallback(() => {
    api<Request[]>(`/api/schedule-requests?branchId=${branchId}`).then(setRows).catch(() => setRows([]));
  }, [branchId]);
  useEffect(load, [load]);
  return { rows, load };
}

function RequestsInbox({ branchId, onChanged }: { branchId: string; onChanged: () => void }) {
  const toast = useToast();
  const { rows, load } = useRequests(branchId);
  async function decide(id: string, approve: boolean, note: string, acknowledgeSoft = false) {
    try {
      await api(`/api/schedule-requests/${id}/decide`, { method: "POST", body: JSON.stringify({ approve, note, acknowledgeSoft }) });
      toast(approve ? "Согласовано, график обновлён" : "Отказ отправлен мастеру");
      load();
      onChanged();
    } catch (error) {
      const err = error as ApiError;
      if (err.code === "SOFT_CONFIRM" && window.confirm(`${err.message}. Согласовать?`)) return decide(id, approve, note, true);
      toast(err.message, "error");
    }
  }
  return (
    <div className="list" style={{ maxWidth: 820 }}>
      {rows?.length === 0 && <div className="panel empty">Мастера пока ничего не просили. Запрос появится здесь, когда мастер предложит свой график или выходной.</div>}
      {rows?.map((row) => <RequestCard key={row.id} row={row} admin onDecide={(approve, note) => decide(row.id, approve, note)} />)}
    </div>
  );
}

// ---------- Master: my schedule ----------

function MySchedule({ me }: { me: Me }) {
  const toast = useToast();
  const branch = me.branches[0];
  const staffId = me.actor.staffId;
  const { rows, load } = useRequests(branch?.id ?? "");
  if (!branch || !staffId) return <div className="reports-page"><div className="banner">Ваш профиль мастера не привязан к аккаунту</div></div>;

  async function send(body: Record<string, unknown>) {
    try {
      await api("/api/schedule-requests", { method: "POST", body: JSON.stringify({ branchId: branch.id, ...body }) });
      toast("Запрос отправлен администратору");
      load();
      return true;
    } catch (error) {
      toast((error as ApiError).message, "error");
      return false;
    }
  }
  async function withdraw(id: string) {
    try {
      await api(`/api/schedule-requests/${id}/decide`, { method: "POST", body: JSON.stringify({ approve: false }) });
      load();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  return (
    <div className="reports-page">
      <div className="journal-top">
        <div>
          <div className="page-kicker">{branch.name}</div>
          <h1 className="date-title">Мой график</h1>
        </div>
      </div>
      <div className="staff-grid mine">
        <div className="list">
          <WeekEditor
            staffId={staffId}
            branchId={branch.id}
            mode="request"
            onRequest={(intervals, comment) => send({ kind: "template", intervals, comment })}
          />
          <Exceptions
            staffId={staffId}
            branchId={branch.id}
            canEdit={false}
            onRequest={async (body) => {
              const { note, ...exception } = body;
              return send({ kind: "exception", exception, comment: note });
            }}
          />
        </div>
        <div className="list">
          <h2 style={{ margin: "4px 0" }}>Мои запросы</h2>
          {rows?.length === 0 && <div className="panel empty">Менять график самостоятельно нельзя: предложите неделю или попросите выходной, администратор согласует.</div>}
          {rows?.map((row) => <RequestCard key={row.id} row={row} admin={false} onDecide={() => withdraw(row.id)} />)}
        </div>
      </div>
    </div>
  );
}

/** 24-hour HH:MM field that does not depend on the browser locale; commits on blur. */
function TimeInput({ value, onChange }: { value: number; onChange: (minutes: number) => void }) {
  const [text, setText] = useState(hhmm(value));
  useEffect(() => setText(hhmm(value)), [value]);
  function commit() {
    const match = text.trim().match(/^(\d{1,2})[:.]?(\d{2})?$/);
    const minutes = match ? Number(match[1]) * 60 + Number(match[2] ?? 0) : NaN;
    if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440) onChange(Math.round(minutes / 5) * 5);
    else setText(hhmm(value));
  }
  return (
    <input
      className="time-input"
      inputMode="numeric"
      value={text}
      aria-label="Время"
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && (event.currentTarget as HTMLInputElement).blur()}
    />
  );
}
