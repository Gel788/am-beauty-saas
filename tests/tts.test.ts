import { afterEach, describe, expect, it } from "vitest";
import { setProviderHttp } from "@/server/providers/http";
import { elevenCheck, openaiCheck } from "@/server/providers/tts";

describe("VOICE-PRO-01 voice keys", () => {
  afterEach(() => setProviderHttp(null));

  it("checks an OpenAI-compatible key at the provider's own address", async () => {
    let seen = "";
    setProviderHttp(async (url, init) => {
      seen = `${url} ${(init?.headers as Record<string, string>).Authorization}`;
      return { ok: true, status: 200, text: async () => "{}" };
    });
    expect((await openaiCheck({ apiKey: "sk-1", baseUrl: "https://proxy.example/v1/" })).ok).toBe(true);
    expect(seen).toBe("https://proxy.example/v1/models Bearer sk-1");
  });

  it("says plainly when the country is blocked", async () => {
    setProviderHttp(async () => ({ ok: false, status: 403, text: async () => '{"error":{"code":"unsupported_country_region_territory"}}' }));
    const result = await openaiCheck({ apiKey: "sk-1" });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/IP этого сервера/);
  });

  it("checks an ElevenLabs key", async () => {
    setProviderHttp(async () => ({ ok: false, status: 401, text: async () => "{}" }));
    expect((await elevenCheck({ apiKey: "x" })).text).toMatch(/не принял ключ/);
  });
});

describe("VOICE-PRO-04 SaluteSpeech", () => {
  afterEach(() => setProviderHttp(null));

  it("gets a token with the authorization key and the account scope", async () => {
    let seen: { url: string; auth: string; body: string; rq: string } | null = null;
    setProviderHttp(async (url, init) => {
      const headers = init?.headers as Record<string, string>;
      seen = { url, auth: headers.Authorization, body: String(init?.body), rq: headers.RqUID };
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "tok", expires_at: Date.now() + 1800000 }) };
    });
    const { sberCheck } = await import("@/server/providers/tts");
    expect((await sberCheck({ authKey: "QUJD", scope: "SALUTE_SPEECH_CORP" })).ok).toBe(true);
    expect(seen!.url).toContain("ngw.devices.sberbank.ru");
    expect(seen!.auth).toBe("Basic QUJD");
    expect(seen!.body).toBe("scope=SALUTE_SPEECH_CORP");
    expect(seen!.rq).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("explains a refused key", async () => {
    setProviderHttp(async () => ({ ok: false, status: 401, text: async () => "{}" }));
    const { sberCheck } = await import("@/server/providers/tts");
    expect((await sberCheck({ authKey: "bad" })).text).toMatch(/не принял/);
  });
});
