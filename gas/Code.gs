const SPREADSHEET_ID = "{{SPREADSHEET_ID}}"; // スクリプト プロパティ `SPREADSHEET_ID` を優先
const API_SHARED_KEY = ""; // 利用する場合のみ値を入れ、クライアントは key パラメーターを付与
const MODEL_USER_ID = ""; // 任意: ダッシュボード下部のモデルユーザー表示用

const SHEET_USERS = "Users";
const SHEET_ATTENDANCE = "Attendance";
const TIMEZONE = "Asia/Tokyo";
const DATE_FORMAT = "yyyy-MM-dd";

function doGet(e) {
  const params = e?.parameter || {};
  const callback = params.callback || "";

  try {
    if (API_SHARED_KEY && params.key !== API_SHARED_KEY) {
      return response({ ok: false, error: "unauthorized", message: "共有キーが正しくありません。" }, callback);
    }

    const action = resolveAction(params);
    const store = new DataStore();

    switch (action) {
      case "health":
        return response(handleHealth(), callback);
      case "login":
        return response(handleLogin(store, params), callback);
      case "registerUser":
        return response(handleRegister(store, params), callback);
      case "getDashboard":
        return response(handleDashboard(store, params), callback);
      case "getAttendance":
        return response(handleGetAttendance(store, params), callback);
      case "checkin":
        return response(handleCheckin(store, params), callback);
      default:
        return response({ ok: false, error: "unknown_action", message: `action=${action} は未対応です` }, callback);
    }
  } catch (error) {
    console.error(error);
    return response({ ok: false, error: "server_error", message: error.message || "サーバーエラーが発生しました" }, callback);
  }
}

function resolveAction(params) {
  if (params.action) return String(params.action);

  const mode = String(params.mode || "");
  switch (mode) {
    case "register":
      return "registerUser";
    case "dashboard":
      return "getDashboard";
    case "login":
    case "getAttendance":
    case "checkin":
      return mode;
    default:
      return "health";
  }
}

function handleHealth() {
  return {
    ok: true,
    timezone: TIMEZONE,
    now: nowString(),
  };
}

function handleLogin(store, params) {
  const pin4 = normalizePin(params.pin4 || params.pin);
  if (!pin4) return fail("missing_pin", "PIN は4桁の数字です。");

  const user = store.findUser(pin4);
  if (!user) return fail("user_not_found", "ユーザーが存在しません。");

  return {
    ok: true,
    token: createToken(user.pin),
    name: user.name,
  };
}

function handleRegister(store, params) {
  const pin4 = normalizePin(params.pin4 || params.pin);
  const displayName = String(params.displayName || params.name || "").trim();

  if (!displayName) return fail("missing_name", "名前を入力してください。");
  if (!pin4) return fail("missing_pin", "PIN は4桁の数字です。");

  if (store.findUser(pin4)) {
    return fail("already_exists", "同じ PIN のユーザーが登録済みです。");
  }

  store.addUser({ pin: pin4, name: displayName });
  return {
    ok: true,
    message: "登録しました",
  };
}

function handleDashboard(store, params) {
  const mePin = requirePinFromToken(params.token, store);
  if (!mePin.ok) return mePin;

  const today = normalizeDate(new Date());
  const monthKey = today.slice(0, 7);

  return {
    ok: true,
    today,
    monthKey,
    me: buildMeMetrics(store, mePin.pin, today, monthKey),
    model: buildModelMetrics(store, today),
    retention: buildRetentionMetrics(store, today, monthKey),
  };
}

function handleGetAttendance(store, params) {
  const mePin = requirePinFromToken(params.token, store);
  if (!mePin.ok) return mePin;

  const monthKey = String(params.month || "").match(/^\d{4}-\d{2}$/)
    ? String(params.month)
    : normalizeDate(new Date()).slice(0, 7);

  const monthDoneDates = store
    .getAttendanceEntriesForPin(mePin.pin)
    .map((e) => e.date)
    .filter((date) => date.indexOf(monthKey) === 0)
    .sort();

  return {
    ok: true,
    monthKey,
    monthDoneDates,
  };
}

function handleCheckin(store, params) {
  const mePin = requirePinFromToken(params.token, store);
  if (!mePin.ok) return mePin;

  const reps = Number(params.reps || 0);
  if (!isFinite(reps) || reps < 1 || reps > 999) {
    return fail("invalid_reps", "回数（reps）が不正です。");
  }

  const today = normalizeDate(new Date());
  store.recordAttendance(mePin.pin, today, reps);

  return {
    ok: true,
    message: "チェックインしました",
    date: today,
  };
}

function requirePinFromToken(token, store) {
  const pin = parseToken(token);
  if (!pin) return fail("auth_required", "未ログインです。再ログインしてください。");

  const user = store.findUser(pin);
  if (!user) return fail("session_expired", "セッション切れです。再ログインしてください。");

  return { ok: true, pin };
}

function buildMeMetrics(store, pin, today, monthKey) {
  const entries = store.getAttendanceEntriesForPin(pin);
  const doneDates = entries.map((e) => e.date);
  const doneSet = new Set(doneDates);

  const monthCount = doneDates.filter((d) => d.indexOf(monthKey) === 0).length;
  const todayDoneEntry = entries.find((e) => e.date === today) || null;

  return {
    monthCount,
    streak: calcStreak(doneSet, today),
    today: {
      done: !!todayDoneEntry,
      timestamp: todayDoneEntry ? todayDoneEntry.createdAt : "",
    },
  };
}

function buildModelMetrics(store, today) {
  const modelPin = normalizePin(MODEL_USER_ID);
  if (!modelPin) return { userId: null, today: { done: null, timestamp: "" } };

  const user = store.findUser(modelPin);
  if (!user) return { userId: modelPin, today: { done: null, timestamp: "" } };

  const todayEntry = store.getAttendanceEntriesForPin(modelPin).find((e) => e.date === today) || null;
  return {
    userId: modelPin,
    today: {
      done: !!todayEntry,
      timestamp: todayEntry ? todayEntry.createdAt : "",
    },
  };
}

function buildRetentionMetrics(store, today, monthKey) {
  const users = store.listUsers();
  const totalUsers = users.length;
  if (totalUsers === 0) {
    return {
      totalUsers: 0,
      active7Users: 0,
      active7dRate: 0,
      monthAvgRate: 0,
    };
  }

  const activePins = new Set();
  const monthDailyCount = {};
  const monthDayLimit = Number(today.slice(8, 10));

  users.forEach((u) => {
    const entries = store.getAttendanceEntriesForPin(u.pin);
    let active7 = false;

    entries.forEach((entry) => {
      if (isWithinLastDays(entry.date, today, 7)) active7 = true;
      if (entry.date.indexOf(monthKey) === 0) {
        monthDailyCount[entry.date] = (monthDailyCount[entry.date] || 0) + 1;
      }
    });

    if (active7) activePins.add(u.pin);
  });

  let monthRateSum = 0;
  for (let d = 1; d <= monthDayLimit; d++) {
    const key = `${monthKey}-${pad2(d)}`;
    monthRateSum += (monthDailyCount[key] || 0) / totalUsers;
  }

  return {
    totalUsers,
    active7Users: activePins.size,
    active7dRate: activePins.size / totalUsers,
    monthAvgRate: monthDayLimit > 0 ? monthRateSum / monthDayLimit : 0,
  };
}

function calcStreak(doneSet, fromDate) {
  let streak = 0;
  let cursor = new Date(fromDate + "T00:00:00");

  while (true) {
    const key = normalizeDate(cursor);
    if (!doneSet.has(key)) break;

    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function isWithinLastDays(dateStr, baseDateStr, days) {
  const dayMs = 24 * 60 * 60 * 1000;
  const target = new Date(dateStr + "T00:00:00").getTime();
  const base = new Date(baseDateStr + "T00:00:00").getTime();
  const diff = base - target;
  return diff >= 0 && diff <= dayMs * (days - 1);
}

/* ============================
   DataStore
============================ */
class DataStore {
  constructor() {
    this.sheet = SpreadsheetApp.openById(resolveSpreadsheetId());
    this.users = this.ensureSheet(SHEET_USERS, ["pin", "name", "createdAt", "updatedAt"]);
    this.attendance = this.ensureSheet(SHEET_ATTENDANCE, ["date", "pin", "reps", "createdAt"]);
  }

  ensureSheet(name, headers) {
    let sheet = this.sheet.getSheetByName(name);
    if (!sheet) {
      sheet = this.sheet.insertSheet(name);
    }

    const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    const hasHeader = firstRow.some((cell) => String(cell || "").trim() !== "");
    if (!hasHeader) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    return sheet;
  }

  listUsers() {
    const values = this.users.getDataRange().getValues();
    const [, ...rows] = values;
    return rows
      .map((r) => ({ pin: normalizePin(r[0]), name: String(r[1] || "").trim() }))
      .filter((u) => u.pin && u.name);
  }

  findUser(pin) {
    const target = normalizePin(pin);
    if (!target) return null;
    return this.listUsers().find((u) => u.pin === target) || null;
  }

  addUser(user) {
    const now = nowString();
    this.users.appendRow([user.pin, user.name, now, now]);
  }

  getAttendanceEntriesForPin(pin) {
    const target = normalizePin(pin);
    const values = this.attendance.getDataRange().getValues();
    const [, ...rows] = values;

    return rows
      .filter((r) => normalizePin(r[1]) === target)
      .map((r) => ({
        date: normalizeDate(r[0]),
        reps: Number(r[2] || 0),
        createdAt: String(r[3] || ""),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  recordAttendance(pin, dateStr, reps) {
    const pin4 = normalizePin(pin);
    const date = normalizeDate(dateStr);
    const all = this.attendance.getDataRange().getValues();

    for (let i = 1; i < all.length; i++) {
      const row = all[i];
      if (normalizeDate(row[0]) === date && normalizePin(row[1]) === pin4) {
        const rowIndex = i + 1;
        this.attendance.getRange(rowIndex, 3, 1, 2).setValues([[reps, row[3] || nowString()]]);
        return;
      }
    }

    this.attendance.appendRow([date, pin4, reps, nowString()]);
  }
}

/* ============================
   Helpers
============================ */
function resolveSpreadsheetId() {
  const propId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID") || "";
  const candidate = propId || SPREADSHEET_ID || "";
  if (!candidate || candidate === "{{SPREADSHEET_ID}}") {
    throw new Error("SPREADSHEET_ID が設定されていません。スクリプト プロパティか Code.gs を設定してください。");
  }
  return candidate.trim();
}

function normalizePin(value) {
  const pin = String(value || "").trim();
  return /^\d{4}$/.test(pin) ? pin : "";
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Utilities.formatDate(date, TIMEZONE, DATE_FORMAT);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function nowString() {
  return Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss");
}

function createToken(pin) {
  const payload = JSON.stringify({ pin: normalizePin(pin), iat: Date.now() });
  return Utilities.base64EncodeWebSafe(payload);
}

function parseToken(token) {
  if (!token) return "";
  try {
    const decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(String(token))).getDataAsString();
    const payload = JSON.parse(decoded);
    return normalizePin(payload.pin);
  } catch (e) {
    return "";
  }
}

function fail(error, message) {
  return { ok: false, error, message };
}

function response(body, callbackName) {
  if (isValidCallbackName(callbackName)) {
    const js = `${callbackName}(${JSON.stringify(body)});`;
    return ContentService.createTextOutput(js).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

function isValidCallbackName(name) {
  return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(String(name || ""));
}
