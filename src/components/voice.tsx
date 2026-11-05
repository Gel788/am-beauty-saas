"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function recognitionClass(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "Разрешите доступ к микрофону в настройках браузера",
  "service-not-allowed": "Браузер не даёт распознавать речь. Попробуйте Chrome или Safari",
  "no-speech": "Ничего не услышали. Нажмите и скажите ещё раз",
  "audio-capture": "Микрофон не найден",
  network: "Нет связи с распознаванием речи",
};

/**
 * VOICE-01: dictation in Russian with the browser's own speech recognition (Chrome, Edge, Safari).
 * No keys and no audio on our servers. `onText(text, final)` gets the words as they come.
 */
export function useVoice(onText: (text: string, final: boolean) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const handler = useRef(onText);
  handler.current = onText;

  useEffect(() => setSupported(Boolean(recognitionClass())), []);
  useEffect(() => () => rec.current?.abort(), []);

  const stop = useCallback(() => rec.current?.stop(), []);

  const start = useCallback(() => {
    const Klass = recognitionClass();
    if (!Klass) {
      setError("Этот браузер не умеет распознавать речь. Попробуйте Chrome или Safari");
      return;
    }
    rec.current?.abort();
    const next = new Klass();
    next.lang = "ru-RU";
    next.interimResults = true;
    next.continuous = false;
    next.maxAlternatives = 1;
    next.onresult = (event) => {
      let text = "";
      let final = false;
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i][0].transcript;
        if (event.results[i].isFinal) final = true;
      }
      handler.current(text.trim(), final);
    };
    next.onerror = (event) => {
      if (event.error !== "aborted") setError(ERRORS[event.error] ?? "Не получилось распознать речь");
    };
    next.onend = () => setListening(false);
    rec.current = next;
    setError(null);
    setListening(true);
    try {
      next.start();
    } catch {
      setListening(false);
    }
  }, []);

  return { supported, listening, error, start, stop };
}
