import { beforeAll, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { createAppointment } from "@/server/appointments";
import { createClient, getClient, listClients } from "@/server/clients";
import { many, one } from "@/server/db";
import { commitImport, listImports, previewImport, undoImport } from "@/server/import";
import { findDuplicates, markNotDuplicates, mergeClients } from "@/server/merge";
import { guessMapping, looksLikeHeader, nameKey, parseCsv, parseDate, parseMoney, parseXlsx } from "@/domain/sheet";
import { at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
beforeAll(async () => {
  salon = await createSalon();
});

let seq = 0;
const phone = () => {
  seq += 1;
  return `+7915${salon.tenantId.replace(/\D/g, "").slice(0, 5).padEnd(5, "0")}${String(seq).padStart(2, "0")}`;
};

describe("sheet parsing", () => {
  it("reads Excel-style CSV with ; and quotes, and guesses YClients columns", () => {
    const sheet = parseCsv('﻿Имя;Телефон;E-mail;День рождения;Категории;Визиты;Последний визит;Сумма продаж;Бонусы;Комментарий\n"Иванова, Анна";8 (916) 111-22-33;A@B.RU;15.03.1990;VIP, окрашивание;12;01.10.2026;"45 000,00";350;"аллергия на ""аммиак"""\n');
    expect(sheet).toHaveLength(2);
    expect(sheet[1][0]).toBe("Иванова, Анна");
    expect(sheet[1][9]).toBe('аллергия на "аммиак"');
    expect(looksLikeHeader(sheet[0])).toBe(true);
    expect(guessMapping(sheet[0])).toEqual({ name: 0, phone: 1, email: 2, birthDate: 3, tags: 4, visits: 5, lastVisit: 6, revenue: 7, bonus: 8, notes: 9 });
  });

  it("reads the first sheet of an xlsx with shared strings and numbers", () => {
    const shared = '<sst><si><t>ФИО</t></si><si><t>Телефон</t></si><si><r><t>Петрова </t></r><r><t>Ольга</t></r></si></sst>';
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Дата рождения</t></is></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>79161112233</v></c><c r="D2"><v>32947</v></c></row></sheetData></worksheet>';
    const bytes = zipSync({ "xl/sharedStrings.xml": strToU8(shared), "xl/worksheets/sheet1.xml": strToU8(sheet) });
    const rows = parseXlsx(bytes);
    expect(rows).toEqual([["ФИО", "Телефон", "", "Дата рождения"], ["Петрова Ольга", "79161112233", "", "32947"]]);
    expect(parseDate(rows[1][3])).toBe("1990-03-15");
    expect(() => parseXlsx(new Uint8Array([1, 2, 3]))).toThrow(/xlsx/);
  });

  it("parses dates, money and names the way Russian exports write them", () => {
    expect(parseDate("15.03.90")).toBe("1990-03-15");
    expect(parseDate("2026-10-01 14:30")).toBe("2026-10-01");
    expect(parseDate("31.02.2000")).toBeNull();
    expect(parseMoney("12 500,50 ₽")).toBe(1250050);
    expect(parseMoney("-1500")).toBe(-150000);
    expect(nameKey("Ёлкина  Анна")).toBe(nameKey("анна елкина"));
  });
});

describe("client import", () => {
  const mapping = { name: 0, phone: 1, email: 2, birthDate: 3, tags: 4, visits: 5, lastVisit: 6, revenue: 7, bonus: 8, debt: 9 };
  const header = ["Имя", "Телефон", "Email", "ДР", "Категории", "Визиты", "Последний", "Сумма", "Бонусы", "Долг"];

  it("CL-IMPORT-01 dry run reports new, existing, in-file twins and bad rows; commit writes them", async () => {
    const existing = await run(salon.admin, (ctx) => createClient(ctx, { name: "Уже есть", phone: phone() }));
    const a = phone();
    const rows = [
      header,
      ["Анна Смирнова", a, "anna@mail.ru", "01.02.1991", "VIP", "10", "20.10.2026", "30000", "200", "1500"],
      ["Анна Смирнова", `${a}, 8 999 000-00-00`, "", "", "окрашивание", "2", "25.10.2026", "4000", "", ""],
      ["Без телефона", "", "", "", "", "", "", "", "", ""],
      ["Кривой", "12-34", "", "", "", "", "", "", "", ""],
      ["Уже Есть Иначе", existing.phones[0].phone, "old@mail.ru", "", "из файла", "5", "", "", "", ""],
    ];
    const report = await run(salon.admin, (ctx) => previewImport(ctx, { rows, mapping, options: { existing: "fill", tag: "Импорт" } }));
    expect(report).toMatchObject({ total: 5, create: 1, update: 1, skip: 0, mergedInFile: 1, invalid: 2, withDebt: 1, withBonus: 1 });
    expect(report.issues.map((issue) => issue.reason)).toEqual(["Нет телефона", "Не удалось разобрать телефон"]);
    // Nothing was written by the dry run.
    expect(await run(salon.admin, (ctx) => one(ctx.db, "SELECT 1 FROM client_phones WHERE phone_e164 = $1", [a]))).toBeNull();

    const result = await run(salon.admin, (ctx) => commitImport(ctx, { rows, mapping, options: { existing: "fill", consentGiven: true, tag: "Импорт" }, fileName: "clients.csv" }));
    expect(result.create).toBe(1);
    const anna = await run(salon.admin, (ctx) =>
      one<{ id: string }>(ctx.db, "SELECT client_id AS id FROM client_phones WHERE phone_e164 = $1 AND deleted_at IS NULL", [a]),
    );
    const card = await run(salon.admin, (ctx) => getClient(ctx, anna!.id));
    expect(card).toMatchObject({ name: "Анна Смирнова", email: "anna@mail.ru", birthDate: "1991-02-01", balanceMinor: 150000, source: "import" });
    expect(card.phones.map((row) => row.phone)).toEqual([a, "+79990000000"]);
    expect(card.tags.sort()).toEqual(["VIP", "Импорт", "окрашивание"]);
    expect(card.imported).toEqual({ visits: 12, lastVisit: "2026-10-25", revenueMinor: 3400000 });
    const extra = await run(salon.admin, (ctx) =>
      one<{ bonus_balance: number; consent_pd_source: string }>(ctx.db, "SELECT bonus_balance, consent_pd_source FROM clients WHERE id = $1", [anna!.id]),
    );
    expect(extra).toEqual({ bonus_balance: 200, consent_pd_source: "import" });

    const updated = await run(salon.admin, (ctx) => getClient(ctx, existing.id));
    expect(updated).toMatchObject({ name: "Уже есть", email: "old@mail.ru" });
    expect(updated.tags).toContain("из файла");
    expect(updated.imported?.visits).toBe(5);
  });

  it("CL-IMPORT-01 skip mode leaves existing cards alone; undo hides only untouched cards", async () => {
    const b = phone();
    const c = phone();
    const rows = [header, ["Вера", b, "", "", "", "", "", "", "", ""], ["Галина", c, "", "", "", "", "", "", "", ""]];
    const job = await run(salon.admin, (ctx) => commitImport(ctx, { rows, mapping, options: { existing: "skip" } }));
    const again = await run(salon.admin, (ctx) => previewImport(ctx, { rows, mapping, options: {} }));
    expect(again).toMatchObject({ create: 0, skip: 2 });
    await expect(run(salon.admin, (ctx) => commitImport(ctx, { rows, mapping, options: {} }))).rejects.toMatchObject({ code: "VALIDATION" });

    const galina = await run(salon.admin, (ctx) => one<{ id: string }>(ctx.db, "SELECT client_id AS id FROM client_phones WHERE phone_e164 = $1", [c]));
    await run(salon.admin, (ctx) =>
      createAppointment(ctx, { branchId: salon.branchId, staffId: salon.staffA, clientId: galina!.id, startsAt: at("12:00", "2026-11-20"), services: [{ serviceId: salon.serviceId }] }),
    );
    const undone = await run(salon.admin, (ctx) => undoImport(ctx, job.jobId));
    expect(undone).toEqual({ removed: 1, kept: 1 });
    await expect(run(salon.admin, (ctx) => undoImport(ctx, job.jobId))).rejects.toMatchObject({ code: "VALIDATION" });
    const list = await run(salon.admin, (ctx) => listImports(ctx));
    expect(list.find((row) => row.id === job.jobId)).toMatchObject({ status: "undone", live: 1 });
    // The freed phone can be imported again.
    expect((await run(salon.admin, (ctx) => previewImport(ctx, { rows, mapping, options: {} }))).create).toBe(1);
  });

  it("CL-IMPORT-01 needs name and phone columns, and admin rights", async () => {
    await expect(run(salon.admin, (ctx) => previewImport(ctx, { rows: [header], mapping: { name: 0 } }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.master, (ctx) => previewImport(ctx, { rows: [header], mapping }))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("duplicate merge", () => {
  it("CL-MERGE-01 finds same-name cards, merges everything into one and hides the other", async () => {
    const keep = await run(salon.admin, (ctx) => createClient(ctx, { name: "Дарья Морозова", phone: phone(), tags: ["VIP"] }));
    const dup = await run(salon.admin, (ctx) => createClient(ctx, { name: "морозова дарья", phone: phone(), email: "dasha@mail.ru", tags: ["окрашивание"], notes: "Любит кофе" }));
    const visit = await run(salon.admin, (ctx) =>
      createAppointment(ctx, { branchId: salon.branchId, staffId: salon.staffB, clientId: dup.id, startsAt: at("15:00", "2026-11-21"), services: [{ serviceId: salon.serviceId }] }),
    );
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE clients SET balance_minor = 50000, bonus_balance = 120 WHERE id = $1", [dup.id]));
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE clients SET balance_minor = 10000 WHERE id = $1", [keep.id]));

    const groups = await run(salon.admin, (ctx) => findDuplicates(ctx));
    const group = groups.find((item) => item.clients.some((client) => client.id === dup.id));
    expect(group?.reason).toBe("name");
    expect(group!.clients.map((client) => client.id).sort()).toEqual([keep.id, dup.id].sort());

    await expect(run(salon.master, (ctx) => mergeClients(ctx, keep.id, dup.id))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const merged = await run(salon.admin, (ctx) => mergeClients(ctx, keep.id, dup.id));
    expect(merged.moved.appointments).toBe(1);

    const card = await run(salon.admin, (ctx) => getClient(ctx, keep.id));
    expect(card).toMatchObject({ email: "dasha@mail.ru", notes: "Любит кофе", balanceMinor: 60000 });
    expect(card.phones).toHaveLength(2);
    expect(card.tags.sort()).toEqual(["VIP", "окрашивание"]);
    const appt = await run(salon.admin, (ctx) => one<{ client_id: string }>(ctx.db, "SELECT client_id FROM appointments WHERE id = $1", [visit.id]));
    expect(appt!.client_id).toBe(keep.id);
    const gone = await run(salon.admin, (ctx) => getClient(ctx, dup.id));
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.mergedIntoId).toBe(keep.id);
    const bonus = await run(salon.admin, (ctx) => one<{ bonus_balance: number }>(ctx.db, "SELECT bonus_balance FROM clients WHERE id = $1", [keep.id]));
    expect(bonus!.bonus_balance).toBe(120);
    const history = await run(salon.admin, (ctx) => many<{ action: string }>(ctx.db, "SELECT action FROM audit_log WHERE entity_id = $1", [keep.id]));
    expect(history.map((row) => row.action)).toContain("client.merged");
    expect((await run(salon.admin, (ctx) => listClients(ctx, "Морозова"))).map((row) => row.id)).toEqual([keep.id]);
    await expect(run(salon.admin, (ctx) => mergeClients(ctx, keep.id, dup.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("CL-MERGE-01 'different people' hides the pair from the duplicates list", async () => {
    const a = await run(salon.admin, (ctx) => createClient(ctx, { name: "Ирина Ким", phone: phone() }));
    const b = await run(salon.admin, (ctx) => createClient(ctx, { name: "Ким Ирина", phone: phone() }));
    const before = await run(salon.admin, (ctx) => findDuplicates(ctx));
    expect(before.some((group) => group.clients.some((client) => client.id === a.id))).toBe(true);
    await run(salon.admin, (ctx) => markNotDuplicates(ctx, [a.id, b.id]));
    const after = await run(salon.admin, (ctx) => findDuplicates(ctx));
    expect(after.some((group) => group.clients.some((client) => client.id === a.id))).toBe(false);
  });
});
