"use client";
import { useCallback, useEffect, useState } from "react";

export function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function writeLS(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/** Object-valued state persisted to localStorage (merged over defaults). */
export function usePersisted<T extends object>(key: string, defaults: T) {
  const [value, setValue] = useState<T>(defaults);
  useEffect(() => {
    setValue(readLS(key, defaults));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const update = useCallback(
    (patch: Partial<T>) =>
      setValue((prev) => {
        const next = { ...prev, ...patch };
        writeLS(key, next);
        return next;
      }),
    [key],
  );
  return [value, update] as const;
}

export interface Settings {
  margin: number; // cents
  contracts: number; // for fee rounding
  lead: boolean; // Binance lead feed
  showBook: boolean;
  lite: boolean; // light price engine (top-of-book feeds) to save mobile data
  biasCorrect: boolean; // shift the replica by its measured offset vs official settlements
}

export const DEFAULT_SETTINGS: Settings = {
  margin: 3,
  contracts: 1,
  lead: true,
  showBook: true,
  lite: false,
  biasCorrect: true,
};

export interface Position {
  ticker: string;
  side: "up" | "down" | "none";
  entry: number; // cents paid per contract (before fee)
  contracts: number;
}

export const DEFAULT_POSITION: Position = { ticker: "", side: "none", entry: 0, contracts: 1 };
