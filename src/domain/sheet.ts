/**
 * Spreadsheet reading for client import (CL-IMPORT-01): CSV in any of the usual
 * Russian exports (`;` from Excel, `,`, tab) and XLSX (YClients, Altegio, Excel).
 * Works in the browser and in Node, so the server can re-check what the browser read.
 */
import { strFromU8, unzipSync } from "fflate";

export type Sheet = string[][];

export function parseCsv(text: string): Sheet {
  const source = text.replace(/^﻿/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const counts = [";", ",", "\t"].map((sep) => [sep, firstLine.split(sep).length] as const);
  const delimiter = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows: Sheet = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === "") quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return trimSheet(rows);
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function textOf(xml: string) {
  // <t> runs inside a shared string or an inline string; phonetic runs (<rPh>) are skipped.
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  return [...clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1])).join("");
}

function columnIndex(ref: string) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** The first worksheet of an .xlsx file, as text cells. Numbers stay as written (dates as Excel serials). */
export function parseXlsx(bytes: Uint8Array): Sheet {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (file) => file.name.startsWith("xl/") });
  } catch {
    throw new Error("Файл не похож на Excel (.xlsx). Сохраните его как .xlsx или .csv");
  }
  const shared = files["xl/sharedStrings.xml"] ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textOf(match[1])) : [];
  let sheetPath = "xl/worksheets/sheet1.xml";
  const workbook = files["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : "";
  const rels = files["xl/_rels/workbook.xml.rels"] ? strFromU8(files["xl/_rels/workbook.xml.rels"]) : "";
  const firstSheet = /<sheet\b[^>]*r:id="([^"]+)"/.exec(workbook)?.[1];
  if (firstSheet) {
    const target = new RegExp(`<Relationship\\b[^>]*Id="${firstSheet}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
      ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstSheet}"`).exec(rels)?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = files[sheetPath] ?? Object.entries(files).find(([name]) => name.startsWith("xl/worksheets/sheet"))?.[1];
  if (!sheet) throw new Error("В файле нет листа с данными");
  const xml = strFromU8(sheet);
  const rows: Sheet = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = textOf(body);
      else if (raw !== undefined) value = decodeXml(raw);
      const index = ref ? columnIndex(ref) : row.length;
      while (row.length < index) row.push("");
      row[index] = value;
    }
    rows.push(row);
  }
  return trimSheet(rows);
}

function trimSheet(rows: Sheet): Sheet {
  const cleaned = rows.map((row) => row.map((cell) => (cell ?? "").replace(/ /g, " ").trim()));
  return cleaned.filter((row) => row.some((cell) => cell !== ""));
}

// ------------------------------------------------------------------ Mapping

export const IMPORT_FIELDS = {
  name: "Имя",
  lastName: "Фамилия",
  phone: "Телефон",
  phone2: "Доп. телефон",
  email: "Email",
  birthDate: "Дата рождения",
  notes: "Комментарий",
  tags: "Категории / метки",
  visits: "Число визитов",
  lastVisit: "Последний визит",
  revenue: "Сумма продаж, ₽",
  bonus: "Бонусы",
  debt: "Долг, ₽",
  balance: "Баланс, ₽ (минус — долг)",
} as const;
export type ImportField = keyof typeof IMPORT_FIELDS;
export type Mapping = Partial<Record<ImportField, number>>;

const SYNONYMS: [ImportField, RegExp][] = [
  ["lastName", /^(фамилия|last ?name|surname)$/],
  ["phone2", /(доп|втор|second|additional).*(тел|phone)|(тел|phone).*(2|доп)/],
  ["phone", /(телефон|тел\.?|phone|мобильн|номер)/],
  ["email", /(e-?mail|почта|эл\.? ?адрес)/],
  ["birthDate", /(рожд|birth|д\.?р\.?$)/],
  ["lastVisit", /(последн|last).*(визит|посещ|visit)|(визит|посещ).*последн/],
  ["visits", /(кол.*визит|визитов|число визит|^визиты$|посещени|visits)/],
  ["revenue", /(сумм|продаж|оплачен|выручк|потрачен|spent|revenue|ltv)/],
  ["bonus", /(бонус|балл|кэшбэк|cashback|points)/],
  ["debt", /(долг|задолж|debt)/],
  ["balance", /(баланс|депозит|balance)/],
  ["tags", /(категор|метк|тег|групп|tags?|label)/],
  ["notes", /(коммент|примеч|заметк|описан|notes?|comment)/],
  ["name", /(^имя|фио|^клиент|name|полное имя)/],
];

/** Guesses columns from the header row: YClients, Altegio, Dikidi and hand-made sheets. */
export function guessMapping(header: string[]): Mapping {
  const mapping: Mapping = {};
  header.forEach((title, index) => {
    const value = title.toLowerCase().replace(/ё/g, "е").trim();
    if (!value) return;
    const hit = SYNONYMS.find(([field, pattern]) => mapping[field] === undefined && pattern.test(value));
    if (hit) mapping[hit[0]] = index;
  });
  return mapping;
}

/** Whether the first row looks like titles rather than a client. */
export function looksLikeHeader(row: string[]) {
  const mapping = guessMapping(row);
  return mapping.name !== undefined || mapping.phone !== undefined;
}

// ------------------------------------------------------------------ Values

/** "15.03.1990", "1990-03-15", "15.03.90", Excel serial 32947 → "1990-03-15". */
export function parseDate(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  let year: number;
  let month: number;
  let day: number;
  let match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[ T].*)?$/.exec(value);
  if (match) {
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
    if (year < 100) year += year > 30 ? 1900 : 2000;
  } else if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(value))) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else if (/^\d{4,5}(\.\d+)?$/.test(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(value)) * 86_400_000);
    year = date.getUTCFullYear();
    month = date.getUTCMonth() + 1;
    day = date.getUTCDate();
  } else return null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** "12 500,50 ₽" → 1250050 minor units; empty → null. */
export function parseMoney(input: string): number | null {
  const value = input.replace(/[\s ₽руб.р]/gi, "").replace(",", ".");
  if (!value || value === "-") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100);
}

export function parseCount(input: string): number | null {
  const value = input.replace(/\s/g, "");
  if (!value) return null;
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

/** For finding duplicates: case, ё and word order do not matter. */
export function nameKey(name: string) {
  return name
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}
