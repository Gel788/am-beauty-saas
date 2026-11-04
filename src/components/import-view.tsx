"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { FileSpreadsheet, Undo2, Upload } from "lucide-react";
import { IMPORT_FIELDS, guessMapping, looksLikeHeader, parseCsv, parseXlsx, type ImportField, type Mapping, type Sheet } from "@/domain/sheet";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type Report = {
  total: number;
  create: number;
  update: number;
  skip: number;
  mergedInFile: number;
  invalid: number;
  withDebt: number;
  withBonus: number;
  issues: { line: number; name: string; phone: string; reason: string }[];
  samples: { line: number; name: string; phone: string; action: "create" | "update" | "skip" }[];
};
type Job = { id: string; fileName: string; status: string; created: number; updated: number; skipped: number; invalid: number; live: number; createdAt: string; undoneAt: string | null };

const FIELDS = Object.entries(IMPORT_FIELDS) as [ImportField, string][];
const ACTION = { create: "новый", update: "дополним", skip: "уже есть" };

/** CL-IMPORT-01: file → columns → check → load. */
export function ImportView() {
  const toast = useToast();
  const [fileName, setFileName] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<Mapping>({});
  const [existing, setExisting] = useState<"skip" | "fill">("fill");
  const [consent, setConsent] = useState(false);
  const [tag, setTag] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<(Report & { jobId: string }) | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);

  const loadJobs = () => api<Job[]>("/api/clients/imports").then(setJobs).catch(() => undefined);
  useEffect(() => {
    loadJobs();
  }, []);

  async function read(file: File) {
    try {
      const rows = /\.xlsx$/i.test(file.name) ? parseXlsx(new Uint8Array(await file.arrayBuffer())) : parseCsv(await decode(file));
      if (!rows.length) throw new Error("В файле нет строк");
      const header = looksLikeHeader(rows[0]);
      setFileName(file.name);
      setSheet(rows);
      setHasHeader(header);
      setMapping(header ? guessMapping(rows[0]) : {});
      setReport(null);
      setDone(null);
      setTag(/yclients/i.test(file.name) ? "из YClients" : "");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  const width = useMemo(() => Math.min(30, Math.max(0, ...(sheet ?? []).slice(0, 50).map((row) => row.length))), [sheet]);
  const titles = useMemo(() => Array.from({ length: width }, (_, index) => (hasHeader ? sheet?.[0][index] : "") || `Колонка ${index + 1}`), [sheet, hasHeader, width]);
  const preview = (sheet ?? []).slice(hasHeader ? 1 : 0, hasHeader ? 6 : 5);
  const body = () => JSON.stringify({ rows: sheet, hasHeader, mapping, options: { existing, consentGiven: consent, tag }, fileName });

  async function check() {
    setBusy(true);
    try {
      setReport(await api<Report>("/api/clients/import/preview", { method: "POST", body: body() }));
    } catch (error) {
      toast((error as ApiError).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    try {
      const result = await api<Report & { jobId: string }>("/api/clients/import", { method: "POST", body: body() });
      setDone(result);
      setReport(null);
      toast(`Загружено: ${result.create} новых, ${result.update} дополнено`);
      loadJobs();
    } catch (error) {
      toast((error as ApiError).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function undo(job: Job) {
    if (!window.confirm(`Скрыть клиентов из «${job.fileName || "импорта"}»? Карточки, с которыми уже работали, останутся.`)) return;
    try {
      const result = await api<{ removed: number; kept: number }>(`/api/clients/imports/${job.id}/undo`, { method: "POST", body: "{}" });
      toast(`Скрыто ${result.removed}${result.kept ? `, оставлено ${result.kept} (у них уже есть записи или оплаты)` : ""}`);
      loadJobs();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  const setField = (field: ImportField, value: string) => {
    const next = { ...mapping };
    for (const key of Object.keys(next) as ImportField[]) if (next[key] === Number(value)) delete next[key];
    if (value === "") delete next[field];
    else next[field] = Number(value);
    setMapping(next);
    setReport(null);
  };
  const fieldOf = (index: number) => FIELDS.find(([field]) => mapping[field] === index)?.[0] ?? "";

  return (
    <>
      <div className="spread">
        <div>
          <div className="page-kicker"><Link href="/clients">Клиенты</Link> · переезд</div>
          <h1>Импорт клиентов</h1>
        </div>
        <Link className="btn" href="/clients/duplicates">Найти дубли</Link>
      </div>
      <div className="import-grid">
        <section className="panel list">
          <h2 style={{ margin: 0 }}>1. Файл</h2>
          <span className="muted" style={{ fontSize: 13 }}>
            Выгрузите базу из прежней программы в Excel (.xlsx) или CSV. В YClients это «Клиенты → Действия → Выгрузить в Excel». Подойдёт и своя таблица: нужны хотя бы имя и телефон.
          </span>
          <label className="dropzone">
            <input type="file" accept=".xlsx,.csv,.txt" onChange={(event) => event.target.files?.[0] && read(event.target.files[0])} />
            <Upload size={20} />
            <span>{fileName ? <><b>{fileName}</b> · {sheet ? sheet.length - (hasHeader ? 1 : 0) : 0} строк</> : "Выберите файл .xlsx или .csv"}</span>
          </label>
          {sheet && (
            <label className="row"><input type="checkbox" checked={hasHeader} onChange={(event) => { setHasHeader(event.target.checked); setReport(null); }} /> Первая строка — заголовки</label>
          )}
        </section>

        {sheet && (
          <section className="panel list" style={{ overflow: "hidden" }}>
            <h2 style={{ margin: 0 }}>2. Что в какой колонке</h2>
            <span className="muted" style={{ fontSize: 13 }}>Колонки мы угадали по заголовкам. Проверьте и поправьте; ненужные оставьте «не загружать».</span>
            <div className="map-table">
              <table>
                <thead>
                  <tr>
                    {titles.map((title, index) => (
                      <th key={index}>
                        <div className="map-title">{title}</div>
                        <select value={fieldOf(index)} onChange={(event) => (event.target.value ? setField(event.target.value as ImportField, String(index)) : setField(fieldOf(index) as ImportField, ""))}>
                          <option value="">не загружать</option>
                          {FIELDS.map(([field, label]) => <option key={field} value={field}>{label}</option>)}
                        </select>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row, line) => (
                    <tr key={line}>{titles.map((_, index) => <td key={index} className={fieldOf(index) ? "" : "unused"}>{row[index] ?? ""}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className="sub-h">Если телефон уже есть в базе</h3>
            <div className="segment" style={{ alignSelf: "flex-start" }}>
              <button type="button" className={existing === "fill" ? "on" : ""} onClick={() => { setExisting("fill"); setReport(null); }}>Дополнить пустые поля</button>
              <button type="button" className={existing === "skip" ? "on" : ""} onClick={() => { setExisting("skip"); setReport(null); }}>Пропустить</button>
            </div>
            <div className="form-grid">
              <div className="field"><label>Метка для всех загруженных</label><input value={tag} placeholder="например, из YClients" onChange={(event) => setTag(event.target.value)} /></div>
            </div>
            <label className="row" style={{ alignItems: "flex-start" }}>
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              <span style={{ fontSize: 13 }}>Клиенты давали согласие на обработку персональных данных в прежней системе или на бумаге <span className="muted">(152-ФЗ; согласие на рекламу не переносится)</span></span>
            </label>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" type="button" disabled={busy || mapping.name === undefined || mapping.phone === undefined} onClick={check}>Проверить</button>
              {(mapping.name === undefined || mapping.phone === undefined) && <span className="muted" style={{ fontSize: 13 }}>Выберите колонки с именем и телефоном</span>}
            </div>
          </section>
        )}

        {report && (
          <section className="panel list">
            <h2 style={{ margin: 0 }}>3. Проверка</h2>
            <div className="import-stats">
              <div><b>{report.create}</b><span>новых клиентов</span></div>
              <div><b>{report.update}</b><span>дополним</span></div>
              <div><b>{report.skip}</b><span>уже в базе</span></div>
              <div><b>{report.mergedInFile}</b><span>повторов в файле</span></div>
              <div className={report.invalid ? "bad" : ""}><b>{report.invalid}</b><span>с ошибкой</span></div>
            </div>
            {(report.withDebt > 0 || report.withBonus > 0) && (
              <span className="muted" style={{ fontSize: 13 }}>
                Перенесём {report.withDebt ? `долги у ${report.withDebt}` : ""}{report.withDebt && report.withBonus ? " и " : ""}{report.withBonus ? `бонусы у ${report.withBonus}` : ""} клиентов. Визиты и суммы из прежней системы появятся в карточке как история.
              </span>
            )}
            {report.samples.length > 0 && (
              <div className="list" style={{ gap: 4 }}>
                {report.samples.map((row) => (
                  <div key={row.line} className="spread" style={{ fontSize: 13 }}>
                    <span>{row.name} · {row.phone}</span>
                    <span className={`tag ${row.action === "create" ? "tag-ok" : ""}`}>{ACTION[row.action]}</span>
                  </div>
                ))}
              </div>
            )}
            {report.issues.length > 0 && (
              <details>
                <summary style={{ cursor: "pointer", fontSize: 13 }}>Строки с ошибкой ({report.invalid}) не загрузятся</summary>
                <div className="list" style={{ gap: 2, marginTop: 6 }}>
                  {report.issues.map((issue) => (
                    <span key={issue.line} className="muted" style={{ fontSize: 12.5 }}>Строка {issue.line + (hasHeader ? 1 : 0)}: {issue.name || "без имени"} {issue.phone && `· ${issue.phone}`} — {issue.reason}</span>
                  ))}
                </div>
              </details>
            )}
            <button className="btn-gradient" type="button" disabled={busy || report.create + report.update === 0} onClick={commit}>
              {busy ? "Загружаем…" : `Загрузить ${report.create + report.update} клиентов`}
            </button>
          </section>
        )}

        {done && (
          <section className="panel list">
            <div className="banner" style={{ background: "#e7f6ec", color: "#1d6b3a" }}>
              Готово: {done.create} новых, {done.update} дополнено, {done.skip} пропущено. Дальше проверьте <Link href="/clients/duplicates">возможные дубли</Link>.
            </div>
          </section>
        )}

        {jobs.length > 0 && (
          <section className="panel list">
            <h2 style={{ margin: 0 }}>Загрузки</h2>
            {jobs.map((job) => (
              <div key={job.id} className="spread" style={{ fontSize: 13, paddingBottom: 6, borderBottom: "1px solid var(--line)" }}>
                <span><FileSpreadsheet size={14} style={{ verticalAlign: -2 }} /> {job.fileName || "без имени"} · {new Date(job.createdAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · новых {job.created}, дополнено {job.updated}</span>
                {job.status === "undone" ? (
                  <span className="tag">отменена, осталось {job.live}</span>
                ) : (
                  <button className="btn-ghost" type="button" onClick={() => undo(job)}><Undo2 size={14} /> Отменить</button>
                )}
              </div>
            ))}
          </section>
        )}
      </div>
    </>
  );
}

/** Excel on Windows saves CSV in cp1251; everything else is UTF-8. */
async function decode(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("�")) return utf8;
  return new TextDecoder("windows-1251").decode(bytes);
}
