"use client";

import { useCallback, useEffect, useState } from "react";
import { spokenToDigits } from "@/domain/command";

const WAKE_KEY = "am-wake-word";
const WAKE = /(?:^|\s)(?:ассистент|асистент|ассистентка)[,.!]?\s*/i;

type Rec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
};

function recClass(): (new () => Rec) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function stored() {
  try {
    return window.localStorage.getItem(WAKE_KEY) === "on";
  } catch {
    return false;
  }
}

/** The switch for «Ассистент…», shared by every place that shows it. */
export function useWakeSwitch() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(stored());
    const sync = () => setOn(stored());
    window.addEventListener("wake-word-changed", sync);
    return () => window.removeEventListener("wake-word-changed", sync);
  }, []);
  const toggle = useCallback(() => {
    const next = !stored();
    try {
      window.localStorage.setItem(WAKE_KEY, next ? "on" : "off");
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event("wake-word-changed"));
  }, []);
  return { on, toggle, supported: typeof window !== "undefined" && Boolean(recClass()) };
}

/**
 * VOICE-PRO-02: hands-free. While the CRM tab is open it listens for «Ассистент»; the words after it go
 * to the command bar and run by themselves («Ассистент, запиши Анну к Денису завтра в 16»). Only the
 * wake word starts anything; the browser shows its own microphone indicator the whole time.
 */
export function WakeWordListener() {
  const { on } = useWakeSwitch();
  const [barOpen, setBarOpen] = useState(false);

  useEffect(() => {
    const onState = (event: Event) => setBarOpen(Boolean((event as CustomEvent<{ open: boolean }>).detail?.open));
    window.addEventListener("command-bar-state", onState);
    return () => window.removeEventListener("command-bar-state", onState);
  }, []);

  useEffect(() => {
    const Klass = recClass();
    if (!on || barOpen || !Klass) return;
    let alive = true;
    let rec: Rec | null = null;
    let restart: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const listen = () => {
      restart = null;
      if (!alive || document.hidden) return;
      rec = new Klass();
      rec.lang = "ru-RU";
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (event) => {
        failures = 0;
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (!result.isFinal) continue;
          const said = result[0].transcript;
          const match = WAKE.exec(said);
          if (!match) continue;
          const rest = said.slice(match.index + match[0].length).trim();
          alive = false;
          rec?.abort();
          window.dispatchEvent(new CustomEvent("open-command-bar", { detail: rest.length > 2 ? { text: spokenToDigits(rest), auto: true } : { voice: true } }));
          return;
        }
      };
      rec.onerror = (event) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          alive = false;
          try {
            window.localStorage.setItem(WAKE_KEY, "off");
          } catch {
            // ignore
          }
          window.dispatchEvent(new Event("wake-word-changed"));
        } else if (event.error !== "no-speech" && event.error !== "aborted") failures += 1;
      };
      rec.onend = () => {
        if (alive) restart = setTimeout(listen, Math.min(30000, 400 * 2 ** failures));
      };
      try {
        rec.start();
      } catch {
        restart = setTimeout(listen, 1500);
      }
    };
    const onVisible = () => {
      if (!document.hidden && alive && !restart) listen();
    };
    listen();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      if (restart) clearTimeout(restart);
      document.removeEventListener("visibilitychange", onVisible);
      rec?.abort();
    };
  }, [on, barOpen]);

  return null;
}
