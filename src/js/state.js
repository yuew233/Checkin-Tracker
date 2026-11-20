// state.js — persistence for the clock-in PWA.
//
// Primary store: IndexedDB, database "clock-in", object store "kv", key "doc".
// The whole app state is one JSON document:
//   { version: 1,
//     days: [{ date: "YYYY-MM-DD", clockIn: "HH:MM", clockOut: "HH:MM"|null, note: "" }],
//     settings: { target: 8.1 },
//     overrides: { "YYYY-MM": <number>|null } }   // null = auto remaining days
// Fallback: localStorage key "clock-in-doc", used only when IndexedDB is
// unavailable (e.g. some private modes). Language preference lives in
// localStorage under "clock-in-lang".

export const DB_NAME = "clock-in";
export const STORE_NAME = "kv";
export const DOC_KEY = "doc";
export const LS_FALLBACK_KEY = "clock-in-doc";
export const LANG_KEY = "clock-in-lang";

export function emptyDoc() {
  return { version: 1, days: [], settings: { target: 8.1 }, overrides: {} };
}

function isValidDay(d) {
  return (
    d &&
    typeof d.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(d.date) &&
    typeof d.clockIn === "string" &&
    (d.clockOut === null || typeof d.clockOut === "string")
  );
}

export function normalizeDoc(raw) {
  const doc = emptyDoc();
  if (!raw || typeof raw !== "object") return doc;
  if (Array.isArray(raw.days)) {
    doc.days = raw.days
      .filter(isValidDay)
      .map((d) => ({ date: d.date, clockIn: d.clockIn, clockOut: d.clockOut ?? null, note: typeof d.note === "string" ? d.note : "" }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  if (raw.settings && typeof raw.settings === "object") {
    const t = Number(raw.settings.target);
    if (Number.isFinite(t) && t > 0) doc.settings.target = t;
  }
  if (raw.overrides && typeof raw.overrides === "object") {
    for (const [k, v] of Object.entries(raw.overrides)) {
      if (/^\d{4}-\d{2}$/.test(k) && (v === null || (Number.isFinite(Number(v)) && Number(v) >= 0))) {
        doc.overrides[k] = v === null ? null : Number(v);
      }
    }
  }
  return doc;
}

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexeddb-unavailable"));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexeddb-open-failed"));
    req.onblocked = () => reject(new Error("indexeddb-blocked"));
  });
}

function idbGet() {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(DOC_KEY);
        req.onsuccess = () => {
          db.close();
          resolve(req.result ?? null);
        };
        req.onerror = () => {
          db.close();
          reject(req.error || new Error("indexeddb-read-failed"));
        };
      }),
  );
}

function idbPut(doc) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).put(doc, DOC_KEY);
        req.onsuccess = () => {
          db.close();
          resolve();
        };
        req.onerror = () => {
          db.close();
          reject(req.error || new Error("indexeddb-write-failed"));
        };
      }),
  );
}

export async function loadDoc() {
  try {
    const stored = await idbGet();
    if (stored) return normalizeDoc(stored);
  } catch (err) {
    // IndexedDB unavailable — fall through to localStorage.
  }
  try {
    const raw = localStorage.getItem(LS_FALLBACK_KEY);
    if (raw) return normalizeDoc(JSON.parse(raw));
  } catch (err) {
    // Corrupt fallback — start empty.
  }
  return emptyDoc();
}

export async function saveDoc(doc) {
  try {
    await idbPut(doc);
    return;
  } catch (err) {
    // IndexedDB unavailable — persist to the localStorage fallback instead.
  }
  try {
    localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(doc));
  } catch (err) {
    // Storage full/blocked; nothing more we can do.
  }
}

// ---------------------------------------------------------------------------
// Backup: Export JSON (download) / Import JSON (merge by date, file wins).
// Backup format:
//   {"app":"clock-in","version":1,
//    "days":[{"date":"2026-01-05","clockIn":"09:00","clockOut":"18:00","note":""}],
//    "settings":{...},"overrides":{}}
// ---------------------------------------------------------------------------

export function exportJSON(doc) {
  return JSON.stringify(
    { app: "clock-in", version: 1, days: doc.days, settings: doc.settings, overrides: doc.overrides },
    null,
    2,
  );
}

export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error("invalid-json");
  }
  if (!data || data.app !== "clock-in" || !Array.isArray(data.days)) {
    throw new Error("not-a-clock-in-backup");
  }
  const imported = normalizeDoc(data);
  if (imported.days.length === 0 && data.days.length > 0) {
    throw new Error("no-valid-days");
  }
  return imported;
}

export function mergeDocs(current, imported) {
  const byDate = new Map(current.days.map((d) => [d.date, d]));
  for (const d of imported.days) byDate.set(d.date, d); // file wins on same date
  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    version: 1,
    days,
    settings: { ...current.settings, ...imported.settings },
    overrides: { ...current.overrides, ...imported.overrides },
  };
}
