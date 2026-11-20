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
  autoRemainingDays,
  monthStats,
  forecastRequired,
} from "./domain.js";
import { loadDoc, saveDoc, exportJSON, parseBackup, mergeDocs, LANG_KEY } from "./state.js";
import { getStrings } from "./i18n.js";

let doc = null;
let lang = "zh";
let strings = getStrings("zh");
let lastRenderedDate = "";
let currentTab = "home";
let selectedChartDate = null;
let viewYear = null; // viewed month on the history tab (defaults to the current month)
let viewMonth0 = null;
let range = "month"; // history range: "week" | "month" | "all"

const TABS = ["home", "history", "settings"];
const CHART_MAX_HOURS = 12; // fixed bar-chart scale, hours

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
// Tabs + hash routing (#home / #history / #settings)
// ---------------------------------------------------------------------------

/** Map a location hash to a tab id; anything unknown falls back to "home". */
export function tabFromHash(hash) {
  const h = String(hash || "").replace(/^#/, "");
  return TABS.includes(h) ? h : "home";
}

export function showTab(tab) {
  if (!TABS.includes(tab)) tab = "home";
  currentTab = tab;
  for (const name of TABS) {
    const view = $(`view-${name}`);
    if (view) view.classList.toggle("active", name === tab);
  }
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  window.scrollTo(0, 0);
}

export function route() {
  const tab = tabFromHash(location.hash);
  if (tab !== currentTab) showTab(tab);
}

function goTab(tab) {
  if (!TABS.includes(tab)) tab = "home";
  if (`#${tab}` !== location.hash) {
    location.hash = `#${tab}`; // hashchange event drives showTab
  }
  route();
}

// ---------------------------------------------------------------------------
// Viewed month on the history tab (defaults to the current month)
// ---------------------------------------------------------------------------

function isCurrentViewMonth() {
  const now = new Date();
  return viewYear === now.getFullYear() && viewMonth0 === now.getMonth();
}

function monthYearLabel(year, month0) {
  if (lang === "zh") return `${year}年${month0 + 1}月`;
  return `${strings.monthNames[month0]} ${year}`;
}

/** Switch the history tab to another month; future months clamp to the current month. */
export function setViewMonth(year, month0) {
  const now = new Date();
  let target = new Date(year, month0, 1);
  const cur = new Date(now.getFullYear(), now.getMonth(), 1);
  if (target > cur) target = cur;
  viewYear = target.getFullYear();
  viewMonth0 = target.getMonth();
  selectedChartDate = null; // renderChart picks a default for the new month
  renderHistoryTab();
}

export function viewMonth() {
  return { year: viewYear, month0: viewMonth0 };
}

function stepViewMonth(delta) {
  setViewMonth(viewYear, viewMonth0 + delta);
}

function renderMonthNav() {
  $("monthNavCard").hidden = range !== "month";
  $("monthLabelBtn").textContent = monthYearLabel(viewYear, viewMonth0);
  $("monthNext").disabled = isCurrentViewMonth();
  $("backToCurrentBtn").hidden = isCurrentViewMonth();
  const picker = $("monthPicker");
  picker.value = `${viewYear}-${pad2(viewMonth0 + 1)}`;
  const now = new Date();
  picker.max = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}

/** Re-render everything on the history tab for the selected range. */
function renderHistoryTab() {
  renderMonthNav();
  renderChart();
  renderHistory();
}

/** Calendar range shown by the history tab's chart + list. */
function rangeDays() {
  const now = new Date();
  if (range === "week") {
    const dow = (now.getDay() + 6) % 7; // Monday = 0
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    return { start, end };
  }
  if (range === "all") {
    const first = doc.days.length
      ? parseDateKey([...doc.days].map((d) => d.date).sort()[0])
      : now;
    return { start: first, end: now };
  }
  return {
    start: new Date(viewYear, viewMonth0, 1),
    end: new Date(viewYear, viewMonth0 + 1, 0),
  };
}

function rangeLabel() {
  if (range === "week") return t("thisWeek");
  if (range === "all") return t("rangeAll");
  return monthLabel(new Date(viewYear, viewMonth0, 1));
}

/** Switch the history range; the month picker only shows in month mode. */
export function setRange(next) {
  if (!["week", "month", "all"].includes(next)) return;
  range = next;
  for (const [key, id] of [["week", "rangeWeek"], ["month", "rangeMonth"], ["all", "rangeAll"]]) {
    $(id).classList.toggle("active", key === range);
  }
  selectedChartDate = null;
  renderHistoryTab();
}

export function getRange() {
  return range;
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
  const label = $("punchText");
  const elapsed = $("elapsedTime");

  $("todayLabel").textContent = `${t("today")} · ${formatDayDate(now)}`;

  if (open) {
    label.textContent = t("punchOut");
    btn.className = "punch-btn punch-out has-elapsed";
    btn.disabled = false;
    elapsed.style.display = "block";
    updateElapsedTime(now);
  } else if (today && today.clockOut) {
    label.textContent = t("doneToday");
    btn.className = "punch-btn punch-done";
    btn.disabled = true;
    elapsed.style.display = "none";
  } else {
    label.textContent = t("punchIn");
    btn.className = "punch-btn punch-in";
    btn.disabled = false;
    elapsed.style.display = "none";
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
  const auto = autoRemainingDays(now);
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
  const { start, end } = rangeDays();
  const inRange = doc.days.filter((d) => {
    const dd = parseDateKey(d.date);
    return dd >= start && dd <= end;
  });
  const sorted = [...inRange].sort((a, b) => (a.date < b.date ? 1 : -1));
  if (sorted.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = t("noRecords");
    list.append(empty);
    return;
  }
  for (const day of sorted) list.append(dayCard(day));
}

/** Today's completed record on the punch tab (hidden until today is done). */
function renderTodayRecord() {
  const card = $("todayRecordCard");
  const today = todayRecord();
  if (!today || !today.clockOut) {
    card.hidden = true;
    return;
  }
  const date = parseDateKey(today.date);
  $("todayRecordDate").textContent = formatDayDate(date);
  const dur = durationMinutes(today.clockIn, today.clockOut);
  $("todayRecordHours").textContent = dur === null ? "—" : hoursText(dur);
  $("todayRecordTimes").textContent =
    `${floorHHMM(today.clockIn) ?? today.clockIn} – ${floorHHMM(today.clockOut) ?? today.clockOut}`;
  card.hidden = false;
}

/** Bar chart of daily hours for the selected range; weekends show as 0. */
function renderChart() {
  const { start, end } = rangeDays();
  $("chartTitle").textContent = `${rangeLabel()} · ${t("chartTitle")}`;

  const today = dateKey(new Date());
  const sel = selectedChartDate ? parseDateKey(selectedChartDate) : null;
  if (!sel || sel < start || sel > end) {
    // Default detail: latest completed day in range; else today if in range; else range start.
    const done = doc.days
      .filter((d) => {
        const dd = parseDateKey(d.date);
        return dd >= start && dd <= end && d.clockOut;
      })
      .map((d) => d.date)
      .sort();
    if (done.length) {
      selectedChartDate = done[done.length - 1];
    } else if (today >= dateKey(start) && today <= dateKey(end)) {
      selectedChartDate = today;
    } else {
      selectedChartDate = dateKey(start);
    }
  }

  const bars = $("chartBars");
  bars.innerHTML = "";
  let selColEl = null;
  for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
    const key = dateKey(dt);
    const rec = doc.days.find((x) => x.date === key);
    let hours = null;
    if (rec && rec.clockOut) {
      const dur = durationMinutes(rec.clockIn, rec.clockOut);
      if (dur !== null) hours = hoursDecimal(dur);
    }

    const col = document.createElement("div");
    col.className = "chart-col";
    if (dt.getDay() === 0 || dt.getDay() === 6) col.classList.add("weekend");
    col.dataset.date = key;
    const area = document.createElement("div");
    area.className = "chart-bar-area";
    const bar = document.createElement("div");
    bar.className = "chart-bar" + (hours === null ? " empty" : "");
    if (key === today) bar.classList.add("today");
    if (key === selectedChartDate) bar.classList.add("selected");
    bar.style.height =
      hours === null ? "2px" : `${Math.min(100, (hours / CHART_MAX_HOURS) * 100)}%`;
    area.append(bar);
    const label = document.createElement("div");
    label.className = "chart-label" + (key === today ? " today" : "");
    label.textContent = String(dt.getDate());
    col.append(area, label);
    bars.append(col);
    if (key === selectedChartDate) selColEl = col;
  }

  // Dynamic width: every column keeps a 20px floor (matching the
  // .chart-col flex-basis) so the day-number labels never overflow
  // their column; the scroller handles the rest — a week fits, a
  // month / all scrolls. min-width: 100% in CSS lets short ranges
  // stretch to fill the card.
  const count = bars.children.length;
  bars.style.width = count > 0 ? `${count * 20 + (count - 1) * 2}px` : "";

  // Keep the selected bar visible inside the scroller.
  const scroller = $("chartScroll");
  if (
    scroller &&
    selColEl &&
    typeof selColEl.offsetLeft === "number" &&
    typeof scroller.scrollLeft === "number"
  ) {
    const left = selColEl.offsetLeft;
    const right = left + selColEl.offsetWidth;
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (right > scroller.scrollLeft + scroller.clientWidth)
      scroller.scrollLeft = right - scroller.clientWidth;
  }

  // Detail line for the tapped (or default) bar.
  const detail = $("chartDetail");
  const selDate = parseDateKey(selectedChartDate);
  const selRec = doc.days.find((x) => x.date === selectedChartDate);
  if (selRec) {
    const inF = floorHHMM(selRec.clockIn) ?? selRec.clockIn;
    if (selRec.clockOut) {
      const dur = durationMinutes(selRec.clockIn, selRec.clockOut);
      const outF = floorHHMM(selRec.clockOut) ?? selRec.clockOut;
      detail.textContent =
        `${formatDayDate(selDate)} · ${inF} – ${outF} · ${dur === null ? "—" : hoursText(dur)}`;
    } else {
      detail.textContent = `${formatDayDate(selDate)} · ${inF} – ${t("inProgress")}`;
    }
  } else if (selDate.getDay() === 0 || selDate.getDay() === 6) {
    detail.textContent = `${formatDayDate(selDate)} · ${hoursText(0)}`;
  } else {
    detail.textContent = `${formatDayDate(selDate)} · ${t("chartNoRecord")}`;
  }
}

function renderAll() {
  lastRenderedDate = dateKey(new Date());
  renderPunch();
  renderTodayRecord();
  renderStats();
  renderForecast();
  renderHistoryTab();
}

// ---------------------------------------------------------------------------
// Punch-button elapsed timer (shown while clocked in; ticks every second).
// ---------------------------------------------------------------------------

/** "H:MM:SS" for the time since clock-in, e.g. "6:24:18". */
function formatElapsed(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${pad2(m)}:${pad2(s)}`;
}

/** Seconds since the open shift started (floored clock-in time). */
function openElapsedSeconds(now) {
  const open = openShift();
  if (!open) return null;
  const startMins = parseHHMM(floorHHMM(open.clockIn));
  const start = parseDateKey(open.date);
  start.setHours(Math.floor(startMins / 60), startMins % 60, 0, 0);
  return Math.max(0, Math.floor((now - start) / 1000));
}

/** Refresh the elapsed timer inside the punch button. */
function updateElapsedTime(now) {
  const el = $("elapsedTime");
  if (!el || el.style.display === "none") return;
  const secs = openElapsedSeconds(now);
  if (secs !== null) el.textContent = formatElapsed(secs);
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
  updateElapsedTime(now);
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
  const saved = parseDateKey(date);
  if (saved.getFullYear() !== viewYear || saved.getMonth() !== viewMonth0) {
    setRange("month"); // jump to the saved month
    setViewMonth(saved.getFullYear(), saved.getMonth());
  }
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
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => goTab(btn.dataset.tab));
  });
  window.addEventListener("hashchange", route);
  $("chartBars").addEventListener("click", (e) => {
    const col = e.target.closest ? e.target.closest(".chart-col") : null;
    if (col && col.dataset.date) {
      selectedChartDate = col.dataset.date;
      renderChart();
    }
  });
  $("monthPrev").addEventListener("click", () => stepViewMonth(-1));
  $("monthNext").addEventListener("click", () => stepViewMonth(1));
  $("backToCurrentBtn").addEventListener("click", () => {
    const n = new Date();
    setViewMonth(n.getFullYear(), n.getMonth());
  });
  $("monthPicker").addEventListener("change", (e) => {
    const v = e.target.value;
    if (!/^\d{4}-\d{2}$/.test(v)) return;
    const [y, m] = v.split("-").map(Number);
    setViewMonth(y, m - 1);
  });
  $("rangeWeek").addEventListener("click", () => setRange("week"));
  $("rangeMonth").addEventListener("click", () => setRange("month"));
  $("rangeAll").addEventListener("click", () => setRange("all"));
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
  const now = new Date();
  viewYear = now.getFullYear();
  viewMonth0 = now.getMonth();
  applyI18n();
  wireEvents();
  route(); // open the tab named by the URL hash (default #home)
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

// Only auto-start in a browser; importing this module in node (for tests)
// must not touch the DOM.
if (typeof document !== "undefined") {
  init();
}
