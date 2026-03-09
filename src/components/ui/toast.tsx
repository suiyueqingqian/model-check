// Simple toast notification component

"use client";

import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, ReactNode } from "react";
import { X, CheckCircle, XCircle, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastType = "success" | "error" | "loading" | "warning";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => string;
  dismiss: (id: string) => void;
  update: (id: string, message: string, type: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let toastCounter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 组件卸载时清理所有 timer
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const setAutoDismiss = useCallback((id: string) => {
    // 先清理该 id 已有的 timer
    const existing = timersRef.current.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current.delete(id);
    }, 3000);
    timersRef.current.set(id, timer);
  }, []);

  const toast = useCallback((message: string, type: ToastType = "success") => {
    const id = String(++toastCounter);
    setToasts((prev) => [...prev, { id, message, type }]);

    // Auto dismiss non-loading toasts after 3s
    if (type !== "loading") {
      setAutoDismiss(id);
    }

    return id;
  }, [setAutoDismiss]);

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const update = useCallback((id: string, message: string, type: ToastType) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, message, type } : t))
    );

    // Auto dismiss after update if not loading
    if (type !== "loading") {
      setAutoDismiss(id);
    }
  }, [setAutoDismiss]);

  const contextValue = useMemo(() => ({ toast, dismiss, update }), [toast, dismiss, update]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}

      {/* All toasts - centered with prominent style */}
      {toasts.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col gap-3 pointer-events-auto">
            {toasts.map((t) => (
              <div
                key={t.id}
                className={cn(
                  "flex items-center gap-3 px-6 py-4 rounded-xl shadow-2xl border-2 backdrop-blur-md animate-in zoom-in-95 fade-in duration-200",
                  t.type === "loading" && "border-blue-500/50 bg-blue-500/20 text-blue-600 dark:text-blue-400",
                  t.type === "success" && "border-green-500/50 bg-green-500/20 text-green-600 dark:text-green-400",
                  t.type === "error" && "border-red-500/50 bg-red-500/20 text-red-600 dark:text-red-400",
                  t.type === "warning" && "border-yellow-500/50 bg-yellow-500/20 text-yellow-600 dark:text-yellow-400"
                )}
              >
                {t.type === "success" && <CheckCircle className="h-5 w-5 shrink-0" />}
                {t.type === "error" && <XCircle className="h-5 w-5 shrink-0" />}
                {t.type === "warning" && <AlertTriangle className="h-5 w-5 shrink-0" />}
                {t.type === "loading" && <Loader2 className="h-5 w-5 shrink-0 animate-spin" />}
                <span className="text-base font-medium">{t.message}</span>
                {t.type !== "loading" && (
                  <button
                    onClick={() => dismiss(t.id)}
                    className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors shrink-0 ml-2"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}
