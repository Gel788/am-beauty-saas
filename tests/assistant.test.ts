import { describe, expect, it } from "vitest";
import { OPENAI_VOICES } from "@/server/providers/tts";
import { INTEGRATIONS } from "@/server/integrations";

describe("VOICE-PRO assistant setup", () => {
  it("offers an OpenAI-compatible provider with address and model, and no Yandex", () => {
    const openai = INTEGRATIONS.find((item) => item.provider === "openai_voice");
    expect(openai?.kind).toBe("assistant");
    expect(openai?.fields.map((field) => field.key)).toEqual(["apiKey", "voice", "ttsModel", "baseUrl", "model"]);
    expect(INTEGRATIONS.some((item) => /yandex/.test(item.provider))).toBe(false);
    expect(OPENAI_VOICES.length).toBeGreaterThan(3);
  });
});
