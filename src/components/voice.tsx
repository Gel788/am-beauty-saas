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

const REPLY_KEY = "am-voice-reply";

// VOICE-PRO-01: with the salon's SpeechKit key the answer comes as a live voice from the server.
let liveVoice: Promise<boolean> | null = null;
let playing: HTMLAudioElement | null = null;
function hasLiveVoice() {
  liveVoice ??= fetch("/api/voice")
    .then((res) => (res.ok ? res.json() : { tts: false }))
    .then((body: { tts?: boolean }) => Boolean(body.tts))
    .catch(() => false);
  return liveVoice;
}

function browserSpeak(text: string) {
  if (!("speechSynthesis" in window)) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const phrase = new SpeechSynthesisUtterance(text);
  phrase.lang = "ru-RU";
  const voice = synth.getVoices().find((item) => item.lang.toLowerCase().startsWith("ru"));
  if (voice) phrase.voice = voice;
  phrase.rate = 1.05;
  synth.speak(phrase);
}

export function stopSpeaking() {
  playing?.pause();
  playing = null;
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

/** VOICE-03: the CRM answers out loud: the live voice when connected, the browser's own otherwise. */
export function speak(text: string) {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(REPLY_KEY) === "off") return;
  } catch {
    // storage blocked: keep talking
  }
  stopSpeaking();
  void (async () => {
    if (await hasLiveVoice()) {
      try {
        const res = await fetch("/api/voice/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
        if (!res.ok) throw new Error(String(res.status));
        const url = URL.createObjectURL(await res.blob());
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        playing = audio;
        await audio.play();
        return;
      } catch {
        // the live voice failed: say it with the browser's voice
      }
    }
    browserSpeak(text);
  })();
}

/** Whether spoken answers are on (default on), with a switch remembered in this browser. */
export function useVoiceReply() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    try {
      setOn(window.localStorage.getItem(REPLY_KEY) !== "off");
    } catch {
      // ignore
    }
  }, []);
  const toggle = useCallback(() => {
    setOn((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(REPLY_KEY, next ? "on" : "off");
      } catch {
        // ignore
      }
      if (!next) stopSpeaking();
      return next;
    });
  }, []);
  return { on, toggle };
}
