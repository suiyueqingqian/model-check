// Auth context and provider

"use client";

import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from "react";

function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

interface AuthContextType {
  token: string | null;
  isAuthenticated: boolean;
  login: (password: string) => Promise<boolean>;
  logout: () => void;
  authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    const saved = localStorage.getItem("auth_token");
    if (saved && isTokenExpired(saved)) {
      localStorage.removeItem("auth_token");
      return null;
    }
    return saved;
  });

  // 定时检查 token 是否过期
  useEffect(() => {
    if (!token) return;
    const clearAuth = () => {
      setToken(null);
      localStorage.removeItem("auth_token");
    };
    const remaining = (() => {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        return payload.exp * 1000 - Date.now();
      } catch {
        return 0;
      }
    })();
    const timer = setTimeout(clearAuth, Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [token]);

  const login = useCallback(async (password: string): Promise<boolean> => {
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json();
      if (data.token) {
        setToken(data.token);
        localStorage.setItem("auth_token", data.token);
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    localStorage.removeItem("auth_token");
  }, []);

  // 封装 fetch，401 时自动退出登录
  const authFetch = useCallback(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    const response = await fetch(input, { ...init, headers });
    if (response.status === 401 && token) {
      setToken(null);
      localStorage.removeItem("auth_token");
    }
    return response;
  }, [token]);

  return (
    <AuthContext.Provider
      value={{
        token,
        isAuthenticated: !!token,
        login,
        logout,
        authFetch,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
