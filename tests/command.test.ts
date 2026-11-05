import { describe, expect, it } from "vitest";
import { matchPages, parseCommand } from "@/domain/command";

const staff = [
  { id: "s1", name: "Алина Ковалёва" },
  { id: "s2", name: "Марина Соколова" },
  { id: "s3", name: "Денис Волков" },
];
const clients = [
  { id: "c1", name: "Анна Смирнова" },
  { id: "c2", name: "Мария Кузнецова" },
  { id: "c3", name: "Ксения Орлова" },
  { id: "c4", name: "Марина Гусева" },
];
const services = [
  { id: "v1", title: "Маникюр с гель-лаком", staffIds: ["s1"], durationMin: 90, priceMinor: 240000 },
  { id: "v2", title: "Коррекция бровей", staffIds: ["s2"], durationMin: 60, priceMinor: 150000 },
  { id: "v3", title: "Мужская стрижка", staffIds: ["s3"], durationMin: 60, priceMinor: 180000 },
];
const today = "2026-11-05"; // Thursday
const parse = (text: string) => parseCommand(text, { staff, clients, services, today });

describe("command bar", () => {
  it("CMD-BAR-01 books from one phrase with Russian endings", () => {
    const result = parse("запиши Анну к Алине завтра в 15 на маникюр");
    expect(result).toMatchObject({ intent: "book", date: "2026-11-06", time: 900 });
    expect(result.client?.id).toBe("c1");
    expect(result.staff?.id).toBe("s1");
    expect(result.services.map((s) => s.id)).toEqual(["v1"]);
  });

  it("CMD-BAR-01b a service word right after the hour is not a month", () => {
    expect(parse("запиши Анну к Алине завтра в 15 маникюр")).toMatchObject({ time: 900, date: "2026-11-06", services: [{ id: "v1" }] });
    expect(parse("запиши к Алине 3 мая в 11").date).toBe("2027-05-03");
  });

  it("CMD-BAR-02 dates and times in the ways people write them", () => {
    expect(parse("запиши Марию к Марине в пятницу в 10:30")).toMatchObject({ date: "2026-11-06", time: 630, staff: { id: "s2" }, client: { id: "c2" } });
    expect(parse("запиши к Денису 12 ноября в 3")).toMatchObject({ date: "2026-11-12", time: 900, staff: { id: "s3" } });
    expect(parse("журнал 20.11").date).toBe("2026-11-20");
    expect(parse("через 2 недели").date).toBe("2026-11-19");
    expect(parse("запиши Ксению на четверг в 9 утра")).toMatchObject({ date: "2026-11-12", time: 540 });
  });

  it("CMD-BAR-03 a new client's name stays in the rest", () => {
    const result = parse("запиши Олесю Петрову к Марине завтра в 12 брови");
    expect(result.client).toBeNull();
    expect(result.rest).toContain("олесю");
    expect(result.services[0].id).toBe("v2");
  });

  it("CMD-BAR-04 pages by the words people use", () => {
    expect(matchPages("склад")[0].href).toBe("/inventory");
    expect(matchPages("зарплата")[0].href).toBe("/payroll");
    expect(matchPages("касса")[0].href).toBe("/cash");
    expect(matchPages("отзывы")[0].href).toBe("/retention");
  });
});

describe("VOICE-01 spoken numbers", () => {
  it("turns spoken times and counts into digits", async () => {
    const { spokenToDigits } = await import("@/domain/command");
    expect(spokenToDigits("запиши Анну к Алине завтра в пятнадцать тридцать на маникюр")).toBe("запиши Анну к Алине завтра в 15:30 на маникюр");
    expect(spokenToDigits("в десять ноль ноль")).toBe("в 10:00");
    expect(spokenToDigits("в три часа дня")).toBe("в 3 часа дня");
    expect(spokenToDigits("через две недели")).toBe("через 2 недели");
    expect(spokenToDigits("в девятнадцать сорок пять")).toBe("в 19:45");
  });
});
