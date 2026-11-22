// Tiny IndexedDB wrapper (no dependencies).

export interface LogEntry {
  id?: number;
  ts: number;
  ticker: string;
  closeTime: number;
  minsLeft: number;
  pUp: number; // displayed P(Up) at the time (calib + shrink applied)
  // Ingredients so calibration can be re-fit later:
  lnr: number;
  vol: number;
  tEff: number;
  calib: number;
  kalshiMid: number | null; // cents
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  price: number;
  target: number;
  fast: boolean;
}

export interface ResultEntry {
  ticker: string;
  result: "yes" | "no";
  settle: number | null; // final 60s BRTI average
  target: number | null;
  closeTime: number;
  fetchedAt: number;
}

const DB_NAME = "kalshi-btc-edge";
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("logs")) {
        const s = db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
        s.createIndex("ticker", "ticker");
      }
      if (!db.objectStoreNames.contains("results")) {
        db.createObjectStore("results", { keyPath: "ticker" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const addLog = (e: LogEntry) => tx("logs", "readwrite", (s) => s.add(e));
export const allLogs = () => tx<LogEntry[]>("logs", "readonly", (s) => s.getAll());
export const putResult = (r: ResultEntry) => tx("results", "readwrite", (s) => s.put(r));
export const allResults = () => tx<ResultEntry[]>("results", "readonly", (s) => s.getAll());

export async function clearAll() {
  await tx("logs", "readwrite", (s) => s.clear());
  await tx("results", "readwrite", (s) => s.clear());
}

export async function importAll(data: { logs?: LogEntry[]; results?: ResultEntry[] }) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(["logs", "results"], "readwrite");
    const logs = t.objectStore("logs");
    const results = t.objectStore("results");
    for (const l of data.logs ?? []) {
      const { id: _id, ...rest } = l;
      logs.add(rest);
    }
    for (const r of data.results ?? []) results.put(r);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
