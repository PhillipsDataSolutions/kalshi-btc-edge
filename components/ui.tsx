export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-2xl bg-card border border-line p-4 ${className}`}>{children}</section>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] uppercase tracking-wider text-ink3">{children}</div>;
}

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-card2 px-3 py-2">
      <Label>{label}</Label>
      <div className="tnum text-[15px] font-semibold text-ink">{value}</div>
      {sub ? <div className="tnum text-[11px] text-ink3">{sub}</div> : null}
    </div>
  );
}
