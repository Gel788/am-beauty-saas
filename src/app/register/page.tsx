"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/api";

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "", salonName: "Моя студия" });
  const [error, setError] = useState("");
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: event.target.value });

  return (
    <div className="login-wrap">
      <form
        className="login-card"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await api("/api/auth/register", { method: "POST", body: JSON.stringify(form) });
            router.push("/journal");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Не удалось создать салон");
          }
        }}
      >
        <div className="wordmark"><span className="am">Am</span><span className="beauty">BEAUTY</span></div>
        <h1 style={{ fontSize: 30 }}>Новый салон</h1>
        <div className="field"><label>Ваше имя</label><input value={form.name} onChange={set("name")} required /></div>
        <div className="field"><label>Название салона</label><input value={form.salonName} onChange={set("salonName")} required /></div>
        <div className="field"><label>Почта</label><input value={form.email} onChange={set("email")} required /></div>
        <div className="field"><label>Пароль</label><input type="password" value={form.password} onChange={set("password")} required /></div>
        {error && <p className="danger">{error}</p>}
        <button className="btn-gradient" type="submit" style={{ width: "100%", marginTop: 12 }}>Создать</button>
      </form>
    </div>
  );
}
