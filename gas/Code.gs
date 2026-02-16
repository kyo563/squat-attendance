const SPREADSHEET_ID = "{{SPREADSHEET_ID}}"; // スクリプト プロパティ `SPREADSHEET_ID` を優先
const API_SHARED_KEY = ""; // 利用する場合のみ値を入れ、クライアントは key パラメーターを付与
const MODEL_USER_ID = ""; // 任意: ダッシュボード下部のモデルユーザー表示用
const SESSION_EXPIRES_DAYS = 7;

const SHEET_USERS = "Users";
const SHEET_ATTENDANCE = "Attendance";
const SHEET_SESSIONS = "Sessions";
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
      case "logout":
        return response(handleLogout(store, params), callback);
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
    case "logout":
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
    sessionExpiresDays: SESSION_EXPIRES_DAYS,
  };
}

function handleLogin(store, params) {
  const userId = normalizeUserId(params.userId);
  const password = String(params.password || "");

  if (!userId) return fail("missing_user_id", "userId は必須です。");
  if (!password) return fail("missing_password", "password は必須です。");

  const user = store.findUser(userId);
  if (!user) return fail("user_not_found", "ユーザーが存在しません。");
  if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    return fail("invalid_credentials", "userId または password が正しくありません。");
  }

  const token = createSessionToken();
  store.upsertSession(user.userId, token, getSessionExpireDate());

  return {
    ok: true,
    token,
    name: user.name,
    userId: user.userId,
    expiresAt: dateTimeString(getSessionExpireDate()),
  };
}

function handleLogout(store, params) {
  const token = String(params.token || "").trim();
  if (!token) return fail("missing_token", "token は必須です。");

  store.deleteSession(token);
  return { ok: true, message: "ログアウトしました" };
}

function handleRegister(store, params) {
  const userId = normalizeUserId(params.userId);
  const password = String(params.password || "");

  if (!userId) return fail("missing_user_id", "userId は必須です（英数字・-_、3〜32文字）。");
  if (!/^\d{4}$/.test(password)) {
    return fail("weak_password", "password は4桁の数字にしてください。");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    if (store.findUser(userId)) {
      return fail("already_exists", "同じ userId のユーザーが登録済みです。");
    }

    const passwordSalt = generateSalt();
    const passwordHash = hashPassword(password, passwordSalt);

    store.addUser({ userId, name: userId, passwordSalt, passwordHash });
    return {
      ok: true,
      message: "登録しました",
    };
  } finally {
    lock.releaseLock();
  }
}

function handleDashboard(store, params) {
  const me = requireUserFromToken(params.token, store);
  if (!me.ok) return me;

  const today = normalizeDate(new Date());
  const monthKey = today.slice(0, 7);

  return {
    ok: true,
    today,
    monthKey,
    me: buildMeMetrics(store, me.userId, today, monthKey),
    model: buildModelMetrics(store, today),
    retention: buildRetentionMetrics(store, today, monthKey),
  };
}

function handleGetAttendance(store, params) {
  const me = requireUserFromToken(params.token, store);
  if (!me.ok) return me;

  const monthKey = String(params.month || "").match(/^\d{4}-\d{2}$/)
    ? String(params.month)
    : normalizeDate(new Date()).slice(0, 7);

  const monthDoneDates = store
    .getAttendanceEntriesForUserId(me.userId)
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
  const me = requireUserFromToken(params.token, store);
  if (!me.ok) return me;

  const reps = Number(params.reps || 0);
  if (!isFinite(reps) || reps < 1 || reps > 999) {
    return fail("invalid_reps", "回数（reps）が不正です。");
  }

  const today = normalizeDate(new Date());
  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    store.recordAttendance(me.userId, today, reps);
  } finally {
    lock.releaseLock();
  }

  return {
    ok: true,
    message: "チェックインしました",
    date: today,
  };
}

function requireUserFromToken(token, store) {
  const value = String(token || "").trim();
  if (!value) return fail("auth_required", "未ログインです。再ログインしてください。");

  const session = store.findSession(value);
  if (!session) return fail("auth_required", "未ログインです。再ログインしてください。");

  const now = new Date();
  if (session.expiresAt.getTime() <= now.getTime()) {
    store.deleteSession(value);
    return fail("session_expired", "セッション有効期限が切れました。再ログインしてください。");
  }

  const user = store.findUser(session.userId);
  if (!user) {
    store.deleteSession(value);
    return fail("session_expired", "セッション切れです。再ログインしてください。");
  }

  return { ok: true, userId: user.userId };
}

function buildMeMetrics(store, userId, today, monthKey) {
  const entries = store.getAttendanceEntriesForUserId(userId);
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
  const modelUserId = normalizeUserId(MODEL_USER_ID);
  if (!modelUserId) return { userId: null, today: { done: null, timestamp: "" } };

  const user = store.findUser(modelUserId);
  if (!user) return { userId: modelUserId, today: { done: null, timestamp: "" } };

  const todayEntry = store.getAttendanceEntriesForUserId(modelUserId).find((e) => e.date === today) || null;
  return {
    userId: modelUserId,
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

  const activeUserIds = new Set();
  const monthDailyCount = {};
  const monthDayLimit = Number(today.slice(8, 10));

  users.forEach((u) => {
    const entries = store.getAttendanceEntriesForUserId(u.userId);
    let active7 = false;

    entries.forEach((entry) => {
      if (isWithinLastDays(entry.date, today, 7)) active7 = true;
      if (entry.date.indexOf(monthKey) === 0) {
        monthDailyCount[entry.date] = (monthDailyCount[entry.date] || 0) + 1;
      }
    });

    if (active7) activeUserIds.add(u.userId);
  });

  let monthRateSum = 0;
  for (let d = 1; d <= monthDayLimit; d++) {
    const key = `${monthKey}-${pad2(d)}`;
    monthRateSum += (monthDailyCount[key] || 0) / totalUsers;
  }

  return {
    totalUsers,
    active7Users: activeUserIds.size,
    active7dRate: activeUserIds.size / totalUsers,
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
    this.users = this.ensureSheet(SHEET_USERS, ["userId", "name", "passwordSalt", "passwordHash", "createdAt", "updatedAt"]);
    this.attendance = this.ensureSheet(SHEET_ATTENDANCE, ["date", "userId", "reps", "createdAt"]);
    this.sessions = this.ensureSheet(SHEET_SESSIONS, ["token", "userId", "expiresAt", "createdAt", "updatedAt"]);
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
      .map((r) => ({
        userId: normalizeUserId(r[0]),
        name: String(r[1] || "").trim(),
        passwordSalt: String(r[2] || ""),
        passwordHash: String(r[3] || ""),
      }))
      .filter((u) => u.userId && u.name && u.passwordSalt && u.passwordHash);
  }

  findUser(userId) {
    const target = normalizeUserId(userId);
    if (!target) return null;
    return this.listUsers().find((u) => u.userId === target) || null;
  }

  addUser(user) {
    const now = nowString();
    this.users.appendRow([user.userId, user.name, user.passwordSalt, user.passwordHash, now, now]);
  }

  getAttendanceEntriesForUserId(userId) {
    const target = normalizeUserId(userId);
    const values = this.attendance.getDataRange().getValues();
    const [, ...rows] = values;

    return rows
      .filter((r) => normalizeUserId(r[1]) === target)
      .map((r) => ({
        date: normalizeDate(r[0]),
        reps: Number(r[2] || 0),
        createdAt: String(r[3] || ""),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  recordAttendance(userId, dateStr, reps) {
    const targetUserId = normalizeUserId(userId);
    const date = normalizeDate(dateStr);
    const all = this.attendance.getDataRange().getValues();

    for (let i = 1; i < all.length; i++) {
      const row = all[i];
      if (normalizeDate(row[0]) === date && normalizeUserId(row[1]) === targetUserId) {
        const rowIndex = i + 1;
        this.attendance.getRange(rowIndex, 3, 1, 2).setValues([[reps, row[3] || nowString()]]);
        return;
      }
    }

    this.attendance.appendRow([date, targetUserId, reps, nowString()]);
  }

  upsertSession(userId, token, expiresAtDate) {
    const targetToken = String(token || "").trim();
    if (!targetToken) return;

    const now = nowString();
    const expiresAt = dateTimeString(expiresAtDate);
    const all = this.sessions.getDataRange().getValues();

    for (let i = 1; i < all.length; i++) {
      const row = all[i];
      if (String(row[0] || "") === targetToken) {
        const rowIndex = i + 1;
        this.sessions.getRange(rowIndex, 2, 1, 4).setValues([[userId, expiresAt, row[3] || now, now]]);
        return;
      }
    }

    this.sessions.appendRow([targetToken, userId, expiresAt, now, now]);
  }

  findSession(token) {
    const targetToken = String(token || "").trim();
    if (!targetToken) return null;

    const values = this.sessions.getDataRange().getValues();
    const [, ...rows] = values;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (String(row[0] || "") !== targetToken) continue;

      const userId = normalizeUserId(row[1]);
      const expiresAtRaw = String(row[2] || "").trim();
      const expiresAt = new Date(expiresAtRaw);
      if (!userId || !expiresAtRaw || isNaN(expiresAt.getTime())) return null;

      return {
        token: targetToken,
        userId,
        expiresAt,
      };
    }
    return null;
  }

  deleteSession(token) {
    const targetToken = String(token || "").trim();
    if (!targetToken) return;

    const values = this.sessions.getDataRange().getValues();
    for (let i = values.length - 1; i >= 1; i--) {
      const row = values[i];
      if (String(row[0] || "") === targetToken) {
        this.sessions.deleteRow(i + 1);
      }
    }
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

function normalizeUserId(value) {
  const userId = String(value || "").trim();
  return /^[A-Za-z0-9_-]{3,32}$/.test(userId) ? userId : "";
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

function dateTimeString(date) {
  return Utilities.formatDate(date, TIMEZONE, "yyyy-MM-dd HH:mm:ss");
}

function getSessionExpireDate() {
  const now = new Date();
  now.setDate(now.getDate() + SESSION_EXPIRES_DAYS);
  return now;
}

function createSessionToken() {
  const raw = `${Utilities.getUuid()}:${Date.now()}:${Math.random()}`;
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, "");
}

function generateSalt() {
  return Utilities.getUuid().replace(/-/g, "") + String(Date.now());
}

function hashPassword(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, `${salt}:${password}`);
  return bytesToHex(bytes);
}

function verifyPassword(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) return false;
  return hashPassword(password, salt) === String(expectedHash);
}

function bytesToHex(bytes) {
  return bytes
    .map((b) => {
      const v = b < 0 ? b + 256 : b;
      return v.toString(16).padStart(2, "0");
    })
    .join("");
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
