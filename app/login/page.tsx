"use client";

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        window.location.replace("/");
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Sign-in failed");
    } catch {
      setError("Network error");
    }
    setBusy(false);
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <div className="mb-6 text-center">
        <div className="text-[13px] uppercase tracking-wider text-ink3">Kalshi BTC 15m Edge</div>
        <div className="mt-1 text-[22px] font-bold">Sign in</div>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <input
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-xl border border-line bg-card px-4 py-3 text-[16px] text-ink outline-none focus:border-ink3"
        />
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-xl bg-ink py-3 text-[16px] font-semibold text-bg disabled:opacity-50"
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
        {error ? <div className="text-center text-[13px] text-down">{error}</div> : null}
      </form>
    </main>
  );
}
