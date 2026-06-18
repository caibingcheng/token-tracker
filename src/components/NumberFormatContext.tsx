"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";

interface NumberFormatContextValue {
  compact: boolean;
  setCompact: (value: boolean) => void;
}

const NumberFormatContext = createContext<NumberFormatContextValue | undefined>(
  undefined
);

const STORAGE_KEY = "token-tracker-number-format";

interface NumberFormatProviderProps {
  children: ReactNode;
}

export function NumberFormatProvider({ children }: NumberFormatProviderProps) {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      setCompact(stored === "compact");
    }
  }, []);

  const handleSetCompact = (value: boolean) => {
    setCompact(value);
    localStorage.setItem(STORAGE_KEY, value ? "compact" : "full");
  };

  return (
    <NumberFormatContext.Provider value={{ compact, setCompact: handleSetCompact }}>
      {children}
    </NumberFormatContext.Provider>
  );
}

export function useNumberFormat(): NumberFormatContextValue {
  const context = useContext(NumberFormatContext);
  if (context === undefined) {
    throw new Error(
      "useNumberFormat must be used within a NumberFormatProvider"
    );
  }
  return context;
}
