"use client";

import { useCallback, useEffect, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

const KEY = "am-sidebar-collapsed";

/**
 * SIDEBAR-01: the side menu folds into a strip of icons and stays that way after a reload.
 * «[» toggles it from anywhere outside a text field.
 */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(KEY) === "1");
    } catch {
      // Private mode or blocked storage: the menu just starts open.
    }
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(KEY, next ? "1" : "0");
      } catch {
        // Not remembered, still toggled.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "[" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { collapsed, toggle };
}

export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const label = collapsed ? "Развернуть меню" : "Свернуть меню";
  return (
    <button type="button" className="side-toggle" onClick={onToggle} aria-label={label} title={`${label} · [`}>
      <Icon size={17} />
    </button>
  );
}
