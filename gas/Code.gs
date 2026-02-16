const SPREADSHEET_ID = "{{SPREADSHEET_ID}}"; // スクリプト プロパティ `SPREADSHEET_ID` を優先
const API_SHARED_KEY = ""; // 利用する場合のみ値を入れる
const MODEL_USER_ID = ""; // 任意: ダッシュボード表示用
const SESSION_EXPIRES_DAYS = 7;

const SHEET_USERS = "Users";
const SHEET_ATTENDANCE = "Attendance";
const SHEET_SESSIONS = "Sessions";
const TIMEZONE = "Asia/Tokyo";
const DATE_FORMAT = "yyyy-MM-dd";

function doGet(e) {
  return api_(e);
}

function doPost(e) {
  return api_(e);
}

function api_(e) {
  const params = mergeParams_(e);
  const callback = params.callback || "";

  try {
    if (!isAuthorized_(params)) {
      return response(decorate_({ ok: false, error: "unauthorized", message: "共有キーが正しくありません。" }), callback);
    }

    const action = resolveAction(params);
    const store = new DataStore();

    let result;
    switch (action) {
      case "health":
        result = handleHealth();
        break;
      case "registerUser":
        result = handleRegister(store, params);
        break;
      case "login":
        result = handleLogin(store, params);
        break;
      case "loginBundle":
        result = handleLoginBundle(store, params);
        break;
      case "logout":
        result = handleLogout(store, params);
        break;
      case "getDashboard":
        result = handleDashboard(store, params);
        break;
      case "getAttendance":
        result = handleGetAttendance(store, params);
        break;
      case "checkin":
        result = handleCheckin(store, params);
        break;
      case "checkinBundle":
        result = handleCheckinBundle(store, params);
        break;
      default:
        result = fail("unknown_action", `action=${action} は未対応です`);
        break;
    }

    return response(decorate_(result), callback);
  } catch (error) {
    console.error(error);
    return response(decorate_({ ok: false, error: "server_error", message: error.message || "サーバーエラーが発生しました" }), callback);
  }
}

function mergeParams_(e) {
  const params = Object.assign({}, e?.parameter || {});
  const postData = e?.postData;
  if (postData?.contents && /^application\/json/.test(String(postData.type || ""))) {
    try {
      const body = JSON.parse(postData.contents);
      Object.keys(body).forEach((k) => {
        if (params[k] == null) params[k] = body[k];
      });
    } catch (_ignore) {}
  }

  // 旧仕様互換パラメータ
  if (params.pin4 == null && params.pin != null) params.pin4 = params.pin;
  if (params.displayName == null && params.name != null) params.displayName = params.name;

  return params;
}

function isAuthorized_(params) {
  if (!API_SHARED_KEY) return true;
  const key = String(params.key || params.k || "");
  return key === API_SHARED_KEY;
}

function resolveAction(params) {
  if (params.action) return String(params.action);

  const mode = String(params.mode || "").trim();
  switch (mode) {
    case "register":
      return "registerUser";
    case "dashboard":
      return "getDashboard";
    case "login":
      return "loginBundle";
    case "checkin":
      return "checkinBundle";
    case "health":
    case "logout":
    case "getAttendance":
      return mode;
    default:
      return "health";
  }
}

function decorate_(obj) {
  const out = obj || {};
  if (out.status == null) out.status = out.ok ? "ok" : "ng";
  if (out.ok && out.message == null) out.message = "ok";
  if (!out.ok && out.message == null && out.error != null) out.message = String(out.error);
  return out;
}

/* ============================
   Handlers
============================ */
function handleHealth() {
  return {
    ok: true,
    timezone: TIMEZONE,
    now: nowString(),
    sessionExpiresDays: SESSION_EXPIRES_DAYS,
  };
}

function handleRegister(store, params) {
  const userIdInput = normalizeUserId(params.userId);
  const passwordInput = normalizePin4(params.password);

  // 現行仕様: userId + password
  if (userIdInput && passwordInput) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30 * 1000);
    try {
      if (store.findUser(userIdInput)) {
        return fail("already_exists", "同じ userId のユーザーが登録済みです。");
      }
      const passwordSalt = generateSalt();
      const passwordHash = hashPassword(passwordInput, passwordSalt);
      store.addUser({ userId: userIdInput, name: userIdInput, passwordSalt, passwordHash });
      return { ok: true, userId: userIdInput, name: userIdInput, message: "登録しました" };
    } finally {
      lock.releaseLock();
    }
  }

  // 旧仕様互換: displayName + pin4
  const displayName = String(params.displayName || "").trim();
  const pin4 = normalizePin4(params.pin4);
  if (!displayName) return fail("missing_display_name", "displayName（または name）は必須です。");
  if (!pin4) return fail("weak_password", "pin4 は4桁の数字にしてください。");

  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    if (store.findUserByPin4(pin4)) {
      return fail("pin_dup", "そのPINは既に使用されています。別のPINにしてください。");
    }
    const userId = `u_${Utilities.getUuid().replace(/-/g, "").slice(0, 12)}`;
    const passwordSalt = generateSalt();
    const passwordHash = hashPassword(pin4, passwordSalt);
    store.addUser({ userId, name: displayName, passwordSalt, passwordHash });
    return { ok: true, userId, name: displayName, message: "登録しました" };
  } finally {
    lock.releaseLock();
  }
}

function handleLogin(store, params) {
  const userId = normalizeUserId(params.userId);
  const password = normalizePin4(params.password);

  // 現行仕様ログイン
  if (userId && password) {
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

  // 旧仕様ログイン: pin4 のみ
  const pin4 = normalizePin4(params.pin4);
  if (!pin4) return fail("missing_credentials", "userId/password または pin4 を指定してください。");

  const legacyUser = store.findUserByPin4(pin4);
  if (!legacyUser) return fail("not_found", "PINが見つかりません。");

  const token = createSessionToken();
  store.upsertSession(legacyUser.userId, token, getSessionExpireDate());

  return {
    ok: true,
    token,
    name: legacyUser.name,
    userId: legacyUser.userId,
    expiresAt: dateTimeString(getSessionExpireDate()),
  };
}

function handleLoginBundle(store, params) {
  const login = handleLogin(store, params);
  if (!login.ok) return login;

  const dashboard = handleDashboard(store, { token: login.token });
  if (!dashboard.ok) return dashboard;

  return {
    ok: true,
    token: login.token,
    userId: login.userId,
    name: login.name,
    dashboard,
  };
}

function handleLogout(store, params) {
  const token = String(params.token || "").trim();
  if (!token) return fail("missing_token", "token は必須です。");

  store.deleteSession(token);
  return { ok: true, message: "ログアウトしました" };
}

function handleDashboard(store, params) {
  const tokenResult = resolveTokenAndUser_(store, params);
  if (!tokenResult.ok) return tokenResult;

  const userId = tokenResult.userId;
  const today = normalizeDate(new Date());
  const monthKey = today.slice(0, 7);

  return {
    ok: true,
    today,
    monthKey,
    me: buildMeMetrics(store, userId, today, monthKey),
    model: buildModelMetrics(store, today),
    retention: buildRetentionMetrics(store, today, monthKey),
  };
}

function handleGetAttendance(store, params) {
  const tokenResult = resolveTokenAndUser_(store, params);
  if (!tokenResult.ok) return tokenResult;

  const monthKey = /^\d{4}-\d{2}$/.test(String(params.month || ""))
    ? String(params.month)
    : normalizeDate(new Date()).slice(0, 7);

  const today = normalizeDate(new Date());
  const entries = store.getAttendanceEntriesForUserId(tokenResult.userId);

  const monthDoneDates = entries
    .map((e) => e.date)
    .filter((date) => date.indexOf(monthKey) === 0)
    .sort();

  const doneMap = {};
  entries.forEach((e) => {
    doneMap[e.date] = true;
  });

  return {
    ok: true,
    today,
    monthKey,
    todayStatus: {
      done: !!doneMap[today],
      timestamp: "",
    },
    monthDoneDates,
    monthCount: monthDoneDates.length,
    streak: calcStreakFromMap_(doneMap, today),
  };
}

function handleCheckin(store, params) {
  const tokenResult = resolveTokenAndUser_(store, params);
  if (!tokenResult.ok) return tokenResult;

  const reps = normalizeReps(params.reps);
  if (!reps) return fail("invalid_reps", "reps は1〜999の数値にしてください。");

  const today = normalizeDate(new Date());
  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    store.recordAttendance(tokenResult.userId, today, reps);
  } finally {
    lock.releaseLock();
  }

  const me = store.findUser(tokenResult.userId);
  return {
    ok: true,
    date: today,
    name: me ? me.name : tokenResult.userId,
    reps,
    message: "チェックインを記録しました",
  };
}

function handleCheckinBundle(store, params) {
  const checkin = handleCheckin(store, params);
  if (!checkin.ok) return checkin;

  const tokenResult = resolveTokenAndUser_(store, params);
  if (!tokenResult.ok) return tokenResult;

  const dashboard = handleDashboard(store, { token: tokenResult.token });
  if (!dashboard.ok) return dashboard;

  return {
    ok: true,
    checkin,
    dashboard,
  };
}

function resolveTokenAndUser_(store, params) {
  const directToken = String(params.token || "").trim();
  if (directToken) {
    const user = requireUserFromToken(directToken, store);
    if (!user.ok) return user;
    return { ok: true, token: directToken, userId: user.userId };
  }

  const login = handleLogin(store, params);
  if (!login.ok) return login;
  return { ok: true, token: login.token, userId: login.userId };
}

/* ============================
   Metrics
============================ */
function buildMeMetrics(store, userId, today, monthKey) {
  const entries = store.getAttendanceEntriesForUserId(userId);
  const doneDates = entries.map((e) => e.date).sort();
  const monthDoneDates = doneDates.filter((d) => d.indexOf(monthKey) === 0);

  const doneMap = {};
  doneDates.forEach((d) => {
    doneMap[d] = true;
  });

  return {
    userId,
    name: store.findUser(userId)?.name || userId,
    today: {
      done: !!doneMap[today],
      timestamp: "",
    },
    monthDoneDates,
    allDoneDates: doneDates,
    monthCount: monthDoneDates.length,
    streak: calcStreakFromMap_(doneMap, today),
  };
}

function buildModelMetrics(store, today) {
  const modelId = normalizeUserId(MODEL_USER_ID);
  if (!modelId) {
    return {
      userId: "",
      today: { done: false, timestamp: "" },
    };
  }

  const entries = store.getAttendanceEntriesForUserId(modelId);
  const doneToday = entries.some((e) => e.date === today);

  return {
    userId: modelId,
    today: { done: doneToday, timestamp: "" },
  };
}

function buildRetentionMetrics(store, today, monthKey) {
  const users = store.listUsers();
  const totalUsers = users.length;

  const todayDate = parseDateYmd_(today);
  const start7 = new Date(todayDate.getTime());
  start7.setDate(start7.getDate() - 6);
  const start7Str = normalizeDate(start7);

  const allAttendance = store.getAllAttendanceEntries();

  const active7Set = {};
  let monthAttend = 0;

  allAttendance.forEach((entry) => {
    if (entry.date >= start7Str && entry.date <= today) active7Set[entry.userId] = true;
    if (entry.date.indexOf(monthKey) === 0) monthAttend++;
  });

  const active7Users = Object.keys(active7Set).length;
  const active7dRate = totalUsers > 0 ? active7Users / totalUsers : 0;

  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(5, 7));
  const monthStart = new Date(y, m - 1, 1);
  const daysElapsed = Math.max(1, Math.floor((todayDate.getTime() - monthStart.getTime()) / 86400000) + 1);
  const denom = totalUsers * daysElapsed;
  const monthAvgRate = denom ? monthAttend / denom : 0;

  return {
    totalUsers,
    active7Users,
    active7dRate,
    monthAttend,
    daysElapsed,
    monthAvgRate,
  };
}

function calcStreakFromMap_(doneMap, todayYmd) {
  let streak = 0;
  const d = parseDateYmd_(todayYmd);

  while (streak <= 5000) {
    const key = normalizeDate(d);
    if (!doneMap[key]) break;
    streak++;
    d.setDate(d.getDate() - 1);
  }

  return streak;
}

/* ============================
   Data Store
============================ */
class DataStore {
  constructor() {
    this.ss = SpreadsheetApp.openById(resolveSpreadsheetId());

    this.users = this.ensureSheet(SHEET_USERS, [
      "userId",
      "name",
      "passwordSalt",
      "passwordHash",
      "createdAt",
      "updatedAt",
    ]);

    this.attendance = this.ensureSheet(SHEET_ATTENDANCE, [
      "date",
      "userId",
      "reps",
      "createdAt",
    ]);

    this.sessions = this.ensureSheet(SHEET_SESSIONS, [
      "token",
      "userId",
      "expiresAt",
      "createdAt",
      "updatedAt",
    ]);
  }

  ensureSheet(name, header) {
    let sheet = this.ss.getSheetByName(name);
    if (!sheet) {
      sheet = this.ss.insertSheet(name);
    }

    const hasHeader = sheet.getLastRow() >= 1;
    if (!hasHeader) {
      sheet.getRange(1, 1, 1, header.length).setValues([header]);
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

  findUserByPin4(pin4) {
    const pin = normalizePin4(pin4);
    if (!pin) return null;

    const users = this.listUsers();
    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      if (verifyPassword(pin, u.passwordSalt, u.passwordHash)) return u;
    }
    return null;
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
        userId: normalizeUserId(r[1]),
        reps: Number(r[2] || 0),
        createdAt: String(r[3] || ""),
      }))
      .filter((e) => e.date && e.userId)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  getAllAttendanceEntries() {
    const values = this.attendance.getDataRange().getValues();
    const [, ...rows] = values;
    return rows
      .map((r) => ({
        date: normalizeDate(r[0]),
        userId: normalizeUserId(r[1]),
        reps: Number(r[2] || 0),
      }))
      .filter((e) => e.date && e.userId);
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

function normalizePin4(value) {
  const pin = String(value || "").trim();
  return /^\d{4}$/.test(pin) ? pin : "";
}

function normalizeReps(value) {
  if (value == null || value === "") return 30;
  const num = Number(value);
  if (!isFinite(num) || num < 1 || num > 999) return 0;
  return Math.floor(num);
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Utilities.formatDate(date, TIMEZONE, DATE_FORMAT);
}

function parseDateYmd_(ymd) {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
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

function requireUserFromToken(token, store) {
  const t = String(token || "").trim();
  if (!t) return fail("missing_token", "token は必須です。");

  const session = store.findSession(t);
  if (!session) return fail("invalid_token", "セッションが無効です。再ログインしてください。");

  if (session.expiresAt.getTime() < Date.now()) {
    store.deleteSession(t);
    return fail("session_expired", "セッションが期限切れです。再ログインしてください。");
  }

  const user = store.findUser(session.userId);
  if (!user) {
    store.deleteSession(t);
    return fail("user_not_found", "ユーザーが見つかりません。");
  }

  return { ok: true, userId: user.userId, name: user.name };
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
  return /^[A-Za-z_$][0-9A-Za-z_$\.]*$/.test(String(name || ""));
}
