"use client";

import { useEffect, useState } from "react";
import { BellRing, Download } from "lucide-react";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();

/** PWA-INSTALL-01: registers the service worker once and keeps the browser's install offer for later. */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    const keep = (event: Event) => {
      event.preventDefault();
      deferred = event as InstallEvent;
      listeners.forEach((listener) => listener());
    };
    const installed = () => {
      deferred = null;
      listeners.forEach((listener) => listener());
    };
    window.addEventListener("beforeinstallprompt", keep);
    window.addEventListener("appinstalled", installed);
    return () => {
      window.removeEventListener("beforeinstallprompt", keep);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);
  return null;
}

function standalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function base64ToBytes(value: string) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/**
 * PWA-INSTALL-01 + PWA-PUSH-01: «Установить приложение» and «Уведомления на этом устройстве».
 * Shown in the sidebar; hides itself when there is nothing to offer.
 */
export function AppDevice() {
  const toast = useToast();
  const [canInstall, setCanInstall] = useState(false);
  const [iosHint, setIosHint] = useState(false);
  const [installedApp, setInstalledApp] = useState(true);
  const [push, setPush] = useState<"unsupported" | "denied" | "off" | "on">("unsupported");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sync = () => setCanInstall(Boolean(deferred));
    listeners.add(sync);
    sync();
    setInstalledApp(standalone());
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return setPush("unsupported");
      if (Notification.permission === "denied") return setPush("denied");
      const registration = await navigator.serviceWorker.getRegistration();
      const current = await registration?.pushManager.getSubscription();
      setPush(current ? "on" : "off");
    })().catch(() => setPush("unsupported"));
    return () => {
      listeners.delete(sync);
    };
  }, []);

  async function install() {
    if (deferred) {
      await deferred.prompt();
      await deferred.userChoice.catch(() => undefined);
      deferred = null;
      setCanInstall(false);
      return;
    }
    if (isIos()) setIosHint((value) => !value);
  }

  async function enablePush() {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPush(permission === "denied" ? "denied" : "off");
        toast("Уведомления не разрешены в браузере", "error");
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const { publicKey } = await api<{ publicKey: string }>("/api/push");
      const subscription = (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) }));
      await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) });
      setPush("on");
      await api("/api/push/test", { method: "POST" }).catch(() => undefined);
      toast("Уведомления включены на этом устройстве");
    } catch (error) {
      toast((error as ApiError).message || "Не получилось включить уведомления", "error");
    } finally {
      setBusy(false);
    }
  }

  async function disablePush() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) });
        await subscription.unsubscribe();
      }
      setPush("off");
      toast("Уведомления на этом устройстве выключены");
    } catch (error) {
      toast((error as ApiError).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const showInstall = !installedApp && (canInstall || isIosSafe());
  if (!showInstall && push === "unsupported") return null;
  return (
    <div className="app-device">
      {showInstall && (
        <button type="button" className="app-device-btn" onClick={() => void install()}>
          <Download size={15} /> Установить приложение
        </button>
      )}
      {iosHint && <p className="app-device-hint">В Safari нажмите «Поделиться» и выберите «На экран „Домой“».</p>}
      {push === "off" && (
        <button type="button" className="app-device-btn" disabled={busy} onClick={() => void enablePush()}>
          <BellRing size={15} /> Уведомления на телефон
        </button>
      )}
      {push === "on" && (
        <button type="button" className="app-device-btn on" disabled={busy} onClick={() => void disablePush()} title="Нажмите, чтобы выключить">
          <BellRing size={15} /> Уведомления включены
        </button>
      )}
      {push === "denied" && <p className="app-device-hint">Уведомления запрещены в настройках браузера для этого сайта.</p>}
    </div>
  );
}

function isIosSafe() {
  return typeof navigator !== "undefined" && isIos();
}
