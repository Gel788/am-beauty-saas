import { afterEach, describe, expect, it } from "vitest";
import { setProviderHttp } from "@/server/providers/http";
import { speechkitCheck } from "@/server/providers/speechkit";

describe("VOICE-PRO-01 SpeechKit check", () => {
  afterEach(() => setProviderHttp(null));

  it("sends the key and folder, and reads a good answer", async () => {
    let seen: { url: string; auth: string; body: string } | null = null;
    setProviderHttp(async (url, init) => {
      seen = { url, auth: String((init?.headers as Record<string, string>).Authorization), body: String(init?.body) };
      return { ok: true, status: 200, text: async () => "mp3" };
    });
    const result = await speechkitCheck({ apiKey: "AQVN123", folderId: "b1gabc", voice: "filipp" });
    expect(result.ok).toBe(true);
    expect(seen!.url).toContain("tts.api.cloud.yandex.net");
    expect(seen!.auth).toBe("Api-Key AQVN123");
    expect(seen!.body).toContain("folderId=b1gabc");
    expect(seen!.body).toContain("voice=filipp");
  });

  it("explains a rejected key in plain words", async () => {
    setProviderHttp(async () => ({ ok: false, status: 401, text: async () => '{"error_message":"Unauthorized"}' }));
    const result = await speechkitCheck({ apiKey: "bad", folderId: "b1g" });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/ключ/);
  });

  it("asks for the key first", async () => {
    expect((await speechkitCheck({})).ok).toBe(false);
  });
});
