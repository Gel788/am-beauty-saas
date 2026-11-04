"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import { Modal, useToast } from "./ui";

type Card = {
  allergies: string;
  contraindications: string;
  healthConsentAt: string | null;
  formulas: { id: string; kind: string; body: string; staffName: string | null; services: string | null; visitAt: string | null; createdAt: string; canDelete: boolean }[];
  photos: { id: string; kind: string; caption: string; staffName: string | null; url: string; createdAt: string; canDelete: boolean }[];
};

const KINDS: Record<string, { label: string; hint: string }> = {
  color: { label: "Окрашивание", hint: "7.1 + 8.0 1:1, оксид 6% 60 мл, 35 мин на корни" },
  nails: { label: "Ногти", hint: "База, цвет (номер), топ, форма, длина" },
  lashes: { label: "Ресницы", hint: "Изгиб C, толщина 0.07, длины 9–11, клей" },
  brows: { label: "Брови", hint: "Хна / краска, тон, время выдержки" },
  care: { label: "Уход", hint: "Средства, концентрации, реакция кожи" },
  other: { label: "Заметка", hint: "Что важно помнить мастеру" },
};
const PHOTO_KIND: Record<string, string> = { before: "до", after: "после", other: "фото" };
const day = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });

/** Downscale on the device: a phone photo of 5 MB becomes ~300 KB JPEG. */
async function shrink(file: File): Promise<{ data: string; mime: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Не удалось обработать фото"))), "image/jpeg", 0.85));
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return { data: btoa(binary), mime: "image/jpeg" };
}

/** CL-TECH-01..03 in the client card. Hidden for roles without access. */
export function TechCard({ clientId }: { clientId: string }) {
  const toast = useToast();
  const [card, setCard] = useState<Card | null>(null);
  const [hidden, setHidden] = useState(false);
  const [health, setHealth] = useState({ allergies: "", contraindications: "", consent: false });
  const [kind, setKind] = useState("nails");
  const [body, setBody] = useState("");
  const [photoKind, setPhotoKind] = useState("after");
  const [viewing, setViewing] = useState<Card["photos"][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const apply = useCallback((value: Card) => {
    setCard(value);
    setHealth({ allergies: value.allergies, contraindications: value.contraindications, consent: Boolean(value.healthConsentAt) });
  }, []);
  useEffect(() => {
    setCard(null);
    api<Card>(`/api/clients/${clientId}/techcard`)
      .then((value) => { apply(value); setHidden(false); })
      .catch((error: ApiError) => { if (error.code === "FORBIDDEN") setHidden(true); });
  }, [clientId, apply]);

  async function call(path: string, method: string, payload: unknown, message: string) {
    setBusy(true);
    try {
      apply(await api<Card>(path, { method, body: JSON.stringify(payload) }));
      toast(message);
      return true;
    } catch (error) {
      toast((error as ApiError).message, "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    try {
      const photo = await shrink(file);
      await call(`/api/clients/${clientId}/photos`, "POST", { ...photo, kind: photoKind }, "Фото добавлено");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  if (hidden) return null;
  if (!card) return <div className="panel"><div className="skeleton" /></div>;
  const changed = health.allergies !== card.allergies || health.contraindications !== card.contraindications;
  const needsConsent = !card.healthConsentAt && Boolean(health.allergies.trim() || health.contraindications.trim());
  return (
    <div className="panel tech-card">
      <div className="spread">
        <strong>Техкарта</strong>
        <span className="muted" style={{ fontSize: 12 }}>видят мастера и администраторы</span>
      </div>
      <div className={`tech-health ${card.allergies || card.contraindications ? "has-alert" : ""}`}>
        <div className="field">
          <label>Аллергии</label>
          <textarea value={health.allergies} maxLength={500} placeholder="латекс, никель, лидокаин…" onChange={(event) => setHealth({ ...health, allergies: event.target.value })} />
        </div>
        <div className="field">
          <label>Противопоказания</label>
          <textarea value={health.contraindications} maxLength={500} placeholder="беременность, диабет, чувствительная кожа…" onChange={(event) => setHealth({ ...health, contraindications: event.target.value })} />
        </div>
      </div>
      {needsConsent && (
        <label className="row" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={health.consent} onChange={(event) => setHealth({ ...health, consent: event.target.checked })} />
          Клиент согласился на хранение сведений о здоровье (152-ФЗ, ст. 10)
        </label>
      )}
      {changed && (
        <button className="btn" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => call(`/api/clients/${clientId}/health`, "PATCH", health, "Сохранено. Мастер увидит это в записи")}>
          Сохранить
        </button>
      )}

      <strong style={{ fontSize: 14 }}>Формулы и заметки мастера</strong>
      <div className="row" style={{ alignItems: "stretch" }}>
        <select value={kind} onChange={(event) => setKind(event.target.value)} className="rebook-select">
          {Object.entries(KINDS).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
        </select>
        <input className="reply-input" value={body} placeholder={KINDS[kind].hint} onChange={(event) => setBody(event.target.value)} onKeyDown={async (event) => { if (event.key === "Enter" && body.trim() && (await call(`/api/clients/${clientId}/formulas`, "POST", { kind, body }, "Записано"))) setBody(""); }} />
        <button className="btn" disabled={busy || !body.trim()} onClick={async () => { if (await call(`/api/clients/${clientId}/formulas`, "POST", { kind, body }, "Записано")) setBody(""); }}>Добавить</button>
      </div>
      {card.formulas.length === 0 && <span className="muted" style={{ fontSize: 13 }}>Пока нет. Запишите, что сделали: в следующий раз любой мастер повторит.</span>}
      {card.formulas.map((formula) => (
        <div key={formula.id} className="formula-row">
          <span className="tag">{KINDS[formula.kind]?.label ?? formula.kind}</span>
          <div className="formula-body">
            <p>{formula.body}</p>
            <span>{[formula.staffName, formula.services, day(formula.visitAt ?? formula.createdAt)].filter(Boolean).join(" · ")}</span>
          </div>
          {formula.canDelete && <button className="icon-btn" aria-label="Удалить" onClick={() => call(`/api/clients/${clientId}/formulas/${formula.id}`, "DELETE", {}, "Удалено")}>×</button>}
        </div>
      ))}

      <div className="spread">
        <strong style={{ fontSize: 14 }}>Фото до и после</strong>
        <div className="segment">
          {Object.entries(PHOTO_KIND).map(([key, label]) => <button key={key} className={photoKind === key ? "on" : ""} onClick={() => setPhotoKind(key)}>{label}</button>)}
        </div>
      </div>
      <div className="photo-grid">
        <label className="photo-add">
          + Фото «{PHOTO_KIND[photoKind]}»
          <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) upload(file); event.target.value = ""; }} />
        </label>
        {card.photos.map((photo) => (
          <button key={photo.id} className="photo-tile" onClick={() => setViewing(photo)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo.url} alt={photo.caption || `Фото ${PHOTO_KIND[photo.kind]}`} loading="lazy" />
            <span className="tag">{PHOTO_KIND[photo.kind]}</span>
          </button>
        ))}
      </div>
      {viewing && (
        <Modal title={`Фото ${PHOTO_KIND[viewing.kind]} · ${day(viewing.createdAt)}`} onClose={() => setViewing(null)}>
          <div className="photo-view list">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={viewing.url} alt={viewing.caption} />
            <span className="muted">{[viewing.staffName, viewing.caption].filter(Boolean).join(" · ")}</span>
            {viewing.canDelete && (
              <button className="btn-ghost" style={{ alignSelf: "flex-start" }} onClick={async () => { if (await call(`/api/clients/${clientId}/photos/${viewing.id}`, "DELETE", {}, "Фото удалено")) setViewing(null); }}>
                Удалить фото
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
