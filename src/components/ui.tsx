"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Puts a modal or drawer straight into <body>, so a blurred or scrolled parent can't stretch or clip it. */
export function Overlay({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  return host ? createPortal(children, host) : null;
}

type Toast = { id: number; message: string; tone: "ok" | "error" };

const ToastContext = createContext<(message: string, tone?: "ok" | "error") => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    if (tone === "ok") {
      window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 2000);
    }
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-wrap">
        {toasts.map((toast) => (
          <button key={toast.id} className={`toast ${toast.tone === "error" ? "error" : ""}`} onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}>
            {toast.message}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <Overlay>
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={wide ? "modal modal-wide" : "modal"} onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="spread">
          <h2 className="display" style={{ fontSize: 22 }}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">×</button>
        </div>
        <div style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
    </Overlay>
  );
}

export function initials(name: string) {
  return name.split(" ").slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}
