// ui.js — rendering and interaction for the clock-in PWA.
import {
  pad2,
  dateKey,
  monthKey,
  parseDateKey,
  parseHHMM,
  floorHHMM,
  durationMinutes,
  hoursDecimal,
  holidaySetAround,
  autoRemainingDays,
  monthStats,
  forecastRequired,
} from "./domain.js";
import { loadDoc, saveDoc, exportJSON, parseBackup, mergeDocs, LANG_KEY } from "./state.js";
import { getStrings } from "./i18n.js";

let doc = null;
let lang = "zh";
let strings = getStrings("zh");
let holidays = new Set();
let lastRenderedDate = "";

const $ = (id) => document.getElementById(id);

function t(key) {
  return strings[key] ?? key;
}

function unit() {
  return lang === "zh" ? "小时" : "h";
}

/** One-decimal hours with unit, e.g. "8.3小时" / "8.3h". */
function hoursText(minutes) {
  return `${hoursDecimal(minutes).toFixed(1)}${unit()}`;
}

function formatDayDate(date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const w = strings.weekdays[date.getDay()];
  if (lang === "zh") return `${m}月${d}日 ${w}`;
  return `${w}, ${strings.monthNames[date.getMonth()]} ${d}`;
}

function monthLabel(date) {
  if (lang === "zh") return `${date.getMonth() + 1}月`;
  return strings.monthNames[date.getMonth()];
}

function todayRecord() {
  return doc.days.find((d) => d.date === dateKey(new Date())) || null;
}

function openShift() {
  const open = doc.days.filter((d) => !d.clockOut);
  return open.length ? open[open.length - 1] : null; // most recent open shift
}

function nowHHMM() {
  const now = new Date();
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function applyI18n() {
  strings = getStrings(lang);
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.title = t("appTitle");
  $("langZh").classList.toggle("active", lang === "zh");
  $("langEn").classList.toggle("active", lang === "en");
}

function renderPunch() {
  const now = new Date();
  const open = openShift();
  const today = todayRecord();
  const btn = $("punchBtn");

  $("todayLabel").textContent = `${t("today")} · ${formatDayDate(now)}`;

  if (open) {
    btn.textContent = t("punchOut");
    btn.className = "punch-btn punch-out";
    btn.disabled = false;
  } else if (today && today.clockOut) {
    btn.textContent = t("doneToday");
    btn.className = "punch-btn punch-done";
    btn.disabled = true;
  } else {
    btn.textContent = t("punchIn");
    btn.className = "punch-btn punch-in";
    btn.disabled = false;
  }

  const line = $("ongoingLine");
  if (open) {
    const start = floorHHMM(open.clockIn);
    const openDate = parseDateKey(open.date);
    const prefix = open.date === dateKey(now) ? "" : `${formatDayDate(openDate)} `;
    line.hidden = false;
    if (lang === "zh") {
      line.innerHTML = "";
      line.append(
        document.createTextNode(`${prefix}${start} ${t("startedAt")}，${t("elapsed")} `),
      );
      const span = document.createElement("span");
      span.id = "elapsedValue";
      line.append(span);
      line.append(document.createTextNode(unit()));
    } else {
      line.innerHTML = "";
      line.append(document.createTextNode(`${t("startedAt")} ${prefix}${start} · ${t("elapsed")} `));
      const span = document.createElement("span");
      span.id = "elapsedValue";
      line.append(span);
      line.append(document.createTextNode(unit()));
    }
  } else {
    line.hidden = true;
    line.innerHTML = "";
  }
}

function renderStats() {
  const now = new Date();
  const stats = monthStats(doc.days, now.getFullYear(), now.getMonth());
  $("monthLabel").textContent = `${monthLabel(now)} · ${t("monthAvg")}`;
  $("monthAvgValue").textContent =
    stats.completedDays > 0 ? (stats.completedHours / stats.completedDays).toFixed(1) : "0.0";
  $("monthAvgUnit").textContent = unit();
  $("attendedValue").textContent = `${stats.completedDays} ${t("daysUnit")}`;
}

function remainingInfo() {
  const now = new Date();
  const mk = monthKey(now);
  const auto = autoRemainingDays(now, holidays);
  const override = doc.overrides[mk];
  const current = override === null || override === undefined ? auto : override;
  return { auto, override, current, monthKey: mk };
}

function renderForecast() {
  const now = new Date();
  const stats = monthStats(doc.days, now.getFullYear(), now.getMonth());
  const info = remainingInfo();
  const required = forecastRequired(
    stats.completedDays,
    stats.completedHours,
    info.current,
    doc.settings.target,
  );
  $("forecastValue").textContent = required === null ? "—" : required.toFixed(1);
  $("forecastUnit").textContent = unit();
  $("completedAvgValue").textContent =
    stats.completedDays > 0
      ? `${t("completedAvg")} ${(stats.completedHours / stats.completedDays).toFixed(1)}${unit()}`
      : `${t("completedAvg")} —`;
  $("remainingValue").textContent = String(info.current);
  $("remainingValue").hidden = false;
  $("remainingInput").hidden = true;
  $("remainingAutoNote").textContent =
    info.override === null || info.override === undefined
      ? ""
      : `${t("autoValue")} ${info.auto} ${t("daysUnit")}`;
  $("restoreAutoBtn").hidden = info.override === null || info.override === undefined;
}

function dayCard(day) {
  const date = parseDateKey(day.date);
  const card = document.createElement("div");
  card.className = "day-card";

  const head = document.createElement("div");
  head.className = "day-head";
  const dateEl = document.createElement("span");
  dateEl.className = "day-date";
  dateEl.textContent = formatDayDate(date);
  head.append(dateEl);

  const hoursEl = document.createElement("span");
  hoursEl.className = "day-hours";
  if (day.clockOut) {
    const dur = durationMinutes(day.clockIn, day.clockOut);
    hoursEl.textContent = dur === null ? "—" : hoursText(dur);
  } else {
    hoursEl.textContent = t("inProgress");
    hoursEl.classList.add("in-progress");
  }
  head.append(hoursEl);
  card.append(head);

  const times = document.createElement("div");
  times.className = "day-times";
  const inF = floorHHMM(day.clockIn) ?? day.clockIn;
  times.textContent = day.clockOut
    ? `${inF} – ${floorHHMM(day.clockOut) ?? day.clockOut}`
    : `${inF} – ${t("inProgress")}`;
  card.append(times);

  if (day.note) {
    const note = document.createElement("div");
    note.className = "day-note";
    note.textContent = day.note;
    card.append(note);
  }

  const actions = document.createElement("div");
  actions.className = "day-actions";
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "mini-btn";
  editBtn.textContent = t("edit");
  editBtn.addEventListener("click", () => openDayDialog(day.date));
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "mini-btn danger";
  delBtn.textContent = t("deleteBtn");
  delBtn.addEventListener("click", () => deleteDay(day.date));
  actions.append(editBtn, delBtn);
  card.append(actions);

  return card;
}

function renderHistory() {
  const list = $("historyList");
  list.innerHTML = "";
  const sorted = [...doc.days].sort((a, b) => (a.date < b.date ? 1 : -1));
  if (sorted.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = t("noRecords");
    list.append(empty);
    return;
  }
  for (const day of sorted) list.append(dayCard(day));
}

function renderAll() {
  lastRenderedDate = dateKey(new Date());
  renderPunch();
  renderStats();
  renderForecast();
  renderHistory();
}

// ---------------------------------------------------------------------------
// Ticking clock (every second) — updates only the clock + elapsed value.
// ---------------------------------------------------------------------------

function tick() {
  const now = new Date();
  const clock = $("liveClock");
  if (clock) {
    clock.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  }
  const elapsed = $("elapsedValue");
  const open = openShift();
  if (elapsed && open) {
    const startMins = parseHHMM(floorHHMM(open.clockIn));
    const start = parseDateKey(open.date);
    start.setHours(Math.floor(startMins / 60), startMins % 60, 0, 0);
    const mins = Math.max(0, Math.floor((now - start) / 60000));
    elapsed.textContent = hoursDecimal(mins).toFixed(1);
  }
  if (dateKey(now) !== lastRenderedDate) renderAll(); // rolled past midnight
}

// ---------------------------------------------------------------------------
// Punch
// ---------------------------------------------------------------------------

async function onPunch() {
  const open = openShift();
  if (open) {
    open.clockOut = nowHHMM();
  } else {
    const today = dateKey(new Date());
    if (!doc.days.some((d) => d.date === today)) {
      doc.days.push({ date: today, clockIn: nowHHMM(), clockOut: null, note: "" });
      doc.days.sort((a, b) => (a.date < b.date ? -1 : 1));
    }
  }
  await saveDoc(doc);
  renderAll();
}

// ---------------------------------------------------------------------------
// Day dialog (add / edit / delete)
// ---------------------------------------------------------------------------

let dialogMode = "add"; // "add" | "edit"
let dialogDate = null;

function openDayDialog(date) {
  const dialog = $("dayDialog");
  const existing = date ? doc.days.find((d) => d.date === date) : null;
  dialogMode = existing ? "edit" : "add";
  dialogDate = existing ? existing.date : dateKey(new Date());
  $("dialogTitle").textContent = existing ? t("edit") : t("addDay");
  const dateInput = $("fieldDate");
  dateInput.value = dialogDate;
  dateInput.disabled = !!existing;
  $("fieldClockIn").value = existing ? existing.clockIn : "";
  $("fieldClockOut").value = existing && existing.clockOut ? existing.clockOut : "";
  $("fieldNote").value = existing ? existing.note || "" : "";
  $("dialogDeleteBtn").hidden = !existing;
  dialog.showModal();
}

function closeDayDialog() {
  $("dayDialog").close();
}

async function saveDayDialog() {
  const date = $("fieldDate").value;
  const clockIn = $("fieldClockIn").value;
  const clockOut = $("fieldClockOut").value || null;
  const note = $("fieldNote").value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !clockIn) return;
  const idx = doc.days.findIndex((d) => d.date === date);
  const record = { date, clockIn, clockOut, note };
  if (idx >= 0) doc.days[idx] = record;
  else doc.days.push(record);
  doc.days.sort((a, b) => (a.date < b.date ? -1 : 1));
  await saveDoc(doc);
  closeDayDialog();
  renderAll();
}

async function deleteDay(date) {
  if (!window.confirm(t("confirmDelete"))) return;
  doc.days = doc.days.filter((d) => d.date !== date);
  await saveDoc(doc);
  renderAll();
}

async function deleteDialogDay() {
  if (!dialogDate) return;
  if (!window.confirm(t("confirmDelete"))) return;
  doc.days = doc.days.filter((d) => d.date !== dialogDate);
  await saveDoc(doc);
  closeDayDialog();
  renderAll();
}

// ---------------------------------------------------------------------------
// Remaining-days editor
// ---------------------------------------------------------------------------

async function setOverride(value) {
  const info = remainingInfo();
  doc.overrides[info.monthKey] = value;
  await saveDoc(doc);
  renderAll();
}

function editRemainingInline() {
  const span = $("remainingValue");
  const input = $("remainingInput");
  const info = remainingInfo();
  input.value = String(info.current);
  span.hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

function commitRemainingInput() {
  const input = $("remainingInput");
  if (input.hidden) return;
  const raw = input.value.trim();
  input.hidden = true;
  $("remainingValue").hidden = false;
  const v = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
  if (v === null || Number.isNaN(v)) {
    setOverride(null); // empty = back to auto
  } else {
    setOverride(v);
  }
}

// ---------------------------------------------------------------------------
// Backup: export / import
// ---------------------------------------------------------------------------

function onExport() {
  const blob = new Blob([exportJSON(doc)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `clock-in-backup-${dateKey(new Date())}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function onImportFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const imported = parseBackup(String(reader.result));
      doc = mergeDocs(doc, imported);
      await saveDoc(doc);
      renderAll();
      showToast(t("importDone"));
    } catch (err) {
      showToast(t("importFailed"));
    }
  };
  reader.readAsText(file);
}

let toastTimer = null;
function showToast(msg) {
  const toast = $("toast");
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

// ---------------------------------------------------------------------------
// Wiring + init
// ---------------------------------------------------------------------------

function wireEvents() {
  $("punchBtn").addEventListener("click", onPunch);
  $("addDayBtn").addEventListener("click", () => openDayDialog(null));
  $("dialogForm").addEventListener("submit", (e) => {
    e.preventDefault();
    saveDayDialog();
  });
  $("dialogCancelBtn").addEventListener("click", closeDayDialog);
  $("dialogDeleteBtn").addEventListener("click", deleteDialogDay);
  $("exportBtn").addEventListener("click", onExport);
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", onImportFile);
  $("remainingMinus").addEventListener("click", async () => {
    const info = remainingInfo();
    await setOverride(Math.max(0, info.current - 1));
  });
  $("remainingPlus").addEventListener("click", async () => {
    const info = remainingInfo();
    await setOverride(info.current + 1);
  });
  $("remainingValue").addEventListener("click", editRemainingInline);
  $("remainingInput").addEventListener("change", commitRemainingInput);
  $("remainingInput").addEventListener("blur", commitRemainingInput);
  $("remainingInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("remainingInput").blur();
    if (e.key === "Escape") renderForecast();
  });
  $("restoreAutoBtn").addEventListener("click", () => setOverride(null));
  $("langZh").addEventListener("click", () => setLang("zh"));
  $("langEn").addEventListener("click", () => setLang("en"));
}

async function setLang(next) {
  if (next !== "zh" && next !== "en") return;
  lang = next;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch (err) {
    // Language preference not persistable; session-only.
  }
  applyI18n();
  renderAll();
}

async function init() {
  const storedLang = (() => {
    try {
      return localStorage.getItem(LANG_KEY);
    } catch (err) {
      return null;
    }
  })();
  lang = storedLang === "en" ? "en" : "zh";
  doc = await loadDoc();
  holidays = holidaySetAround(new Date().getFullYear());
  applyI18n();
  wireEvents();
  renderAll();
  setInterval(tick, 1000);
  tick();
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (err) {
      // Offline support unavailable (e.g. plain file://); app still works.
    }
  }
}

init();
