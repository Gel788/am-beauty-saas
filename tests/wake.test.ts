import { describe, expect, it } from "vitest";
import { matchWake } from "@/domain/wake";

describe("VOICE-PRO-02 wake phrase", () => {
  it("wakes on the salon's own name, with or without a greeting", () => {
    expect(matchWake("Привет, Марина, кто сегодня свободен?", "Марина")).toBe("кто сегодня свободен?");
    expect(matchWake("Марина запиши Анну к Денису завтра в 16", "Марина")).toBe("запиши Анну к Денису завтра в 16");
    expect(matchWake("Марин", "Марина")).toBe("");
    expect(matchWake("Ассистент, кто у Алины после обеда", "Ассистент")).toBe("кто у Алины после обеда");
  });

  it("does not wake on the name inside a command or on other words", () => {
    expect(matchWake("запиши Анну к Марине завтра", "Марина")).toBeNull();
    expect(matchWake("привет как дела", "Марина")).toBeNull();
  });
});
