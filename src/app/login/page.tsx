"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("olga@ambeauty.local");
  const [password, setPassword] = useState("ambeauty");
  const [error, setError] = useState("");

  return (
    <div className="aurora login-wrap" style={{ height: "auto" }}>
      <form
        className="login-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            const signed = await api<{ actor: { role: string } | null; platform?: boolean }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
            // PLAT-CABINET-05: the platform team goes to its own cabinet, not into a salon.
            if (signed.platform) {
              router.push("/platform");
              return;
            }
            const me = await api<{ actor: { role: string } }>("/api/auth/me");
            router.push(me.actor.role === "accountant" ? "/cash" : "/journal");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Не удалось войти");
          }
        }}
      >
        <div className="wordmark">
          <span className="am">Am</span>
          <span className="beauty">BEAUTY</span>
        </div>
        <h1 style={{ fontSize: 32, margin: "8px 0 6px" }}>Вход в студию</h1>
        <p className="muted">Журнал, клиенты и касса салона.</p>
        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="email">Почта</label>
          <input id="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" />
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="password">Пароль</label>
          <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
        </div>
        {error && <p className="danger">{error}</p>}
        <button className="btn-gradient" style={{ width: "100%", marginTop: 16 }} type="submit">Войти</button>
        <p className="muted" style={{ marginTop: 14, fontSize: 13, lineHeight: 1.45 }}>
          Пароль демо ambeauty
          <br />
          olga@ambeauty.local · admin@ · alina@ · buh@
          <br />
          <a href="/register">Открыть новый салон</a>
        </p>
      </form>
    </div>
  );
}
