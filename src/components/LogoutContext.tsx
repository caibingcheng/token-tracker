"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// 登出入口只有两处：移动端 /admin 列表页底部、桌面端侧栏 Admin 子菜单末尾。
// ApiKeyGate 持有登出实现并下发，避免各页面重复实现 apiLogout + 登录态复位逻辑。
export interface LogoutContextValue {
  logout: () => Promise<void>;
  loggingOut: boolean;
}

const LogoutContext = createContext<LogoutContextValue | undefined>(undefined);

export function LogoutProvider({
  value,
  children,
}: {
  value: LogoutContextValue;
  children: ReactNode;
}) {
  return <LogoutContext.Provider value={value}>{children}</LogoutContext.Provider>;
}

export function useLogout(): LogoutContextValue {
  const context = useContext(LogoutContext);
  if (context === undefined) {
    throw new Error("useLogout must be used within a LogoutProvider");
  }
  return context;
}

// 二次确认（桌面与移动端一致）：点一次进入确认态，confirmMs 内再点才真正登出，
// 超时自动复位。触发按钮用 confirming 切换文案/样式，loggingOut 期间禁用。
const LOGOUT_CONFIRM_MS = 3000;

export function useConfirmLogout(confirmMs: number = LOGOUT_CONFIRM_MS) {
  const { logout, loggingOut } = useLogout();
  const [confirming, setConfirming] = useState(false);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    };
  }, []);

  const triggerLogout = () => {
    if (loggingOut) return;
    if (confirming) {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
      setConfirming(false);
      void logout();
      return;
    }
    setConfirming(true);
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    confirmTimeoutRef.current = setTimeout(() => setConfirming(false), confirmMs);
  };

  return { confirming, loggingOut, triggerLogout };
}
