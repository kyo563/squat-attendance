const SPREADSHEET_ID = "{{SPREADSHEET_ID}}"; // スクリプト プロパティ `SPREADSHEET_ID` を優先
const API_SHARED_KEY = ""; // 利用する場合のみ値を入れ、クライアントは key パラメーターを付与

const SHEET_USERS = "Users";
const SHEET_ATTENDANCE = "Attendance";
const SHEET_SESSIONS = "Sessions";
const TIMEZONE = "Asia/Tokyo";
const DATE_FORMAT = "yyyy-MM-dd";
const SESSION_EXPIRES_DAYS = 30;
const MIN_PASSWORD_LENGTH = 8;

function doGet(e) {
  try {
    const params = e?.parameter || {};
    if (API_SHARED_KEY && params.key !== API_SHARED_KEY) {
      return jsonError("unauthorized", "共有キーが正しくありません。");
    }

    const mode = params.mode || "dashboard";
    const store = new DataStore();

    switch (mode) {
      case "login":
        return handleLogin(store, params);
      case "register":
        return handleRegister(store, params);
      case "getAttendance":
        return handleGetAttendance(store, params);
      case "checkin":
        return handleCheckin(store, params);
      case "dashboard":
        return jsonOk({ dashboard: buildDashboard(store) });
      case "logout":
        return handleLogout(store, params);
      default:
        return jsonError("unknown_mode", `mode=${mode} は未対応です`);
    }
  } catch (error) {
    console.error(error);
    return jsonError("server_error", error.message || "サーバーエラーが発生しました");
  }
}

function handleLogin(store, params) {
  const userId = (params.userId || params.pin || "").trim();
  const password = String(params.password || "");
  if (!userId || !password) {
    return jsonError("missing_params", "userId と password を指定してください。");
  }

  const user = store.findUserById(userId);
  if (!user) return jsonError("user_not_found", "ユーザーが存在しません。");

  if (!user.passwordHash || !user.passwordSalt) {
    return jsonError("password_not_configured", "このユーザーはパスワード未設定です。再登録してください。");
  }

  if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    return jsonError("invalid_credentials", "ユーザーID またはパスワードが違います。");
  }

  const session = store.createSession(user.userId);
  const attendance = store.getAttendanceForUser(user.userId);

  return jsonOk({
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      userId: user.userId,
      name: user.name,
    },
    attendance,
    dashboard: buildDashboard(store),
  });
}

function handleRegister(store, params) {
  const userId = (params.userId || params.pin || "").trim();
  const name = (params.name || "").trim();
  const password = String(params.password || "");

  if (!userId || !name || !password) {
    return jsonError("missing_params", "userId・name・password を入力してください。");
  }
  if (!/^\d{4,10}$/.test(userId)) {
    return jsonError("invalid_user_id", "userId は 4〜10 桁の数字にしてください。");
  }
  const pwdErr = validatePassword(password);
  if (pwdErr) return jsonError("weak_password", pwdErr);

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const exists = store.findUserById(userId);
    if (exists) return jsonError("already_exists", "同じ userId のユーザーが登録済みです。");

    const passwordSalt = generateSalt();
    const passwordHash = hashPassword(password, passwordSalt);

    store.addUser({ userId, name, passwordHash, passwordSalt });
  } finally {
    lock.releaseLock();
  }

  return jsonOk({
    message: "登録しました",
    users: store.listUsersSafe(),
  });
}

function handleGetAttendance(store, params) {
  const auth = requireAuth(store, params);
  if (auth.error) return auth.error;

  const attendance = store.getAttendanceForUser(auth.user.userId);
  return jsonOk({
    attendance,
    dashboard: buildDashboard(store),
    user: { userId: auth.user.userId, name: auth.user.name },
  });
}

function handleCheckin(store, params) {
  const auth = requireAuth(store, params);
  if (auth.error) return auth.error;

  const rawDate = params.date ? new Date(params.date) : new Date();
  const date = normalizeDate(rawDate);
  const reps = Number(params.reps || 20);
  if (!Number.isFinite(reps) || reps <= 0 || reps > 999) {
    return jsonError("invalid_reps", "reps は 1〜999 の数字で指定してください。");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    store.recordAttendance(auth.user.userId, date, Math.floor(reps));
  } finally {
    lock.releaseLock();
  }

  const attendance = store.getAttendanceForUser(auth.user.userId);
  return jsonOk({
    message: `${date} を出席として記録しました`,
    attendance,
    dashboard: buildDashboard(store),
  });
}

function handleLogout(store, params) {
  const token = (params.token || "").trim();
  if (!token) return jsonError("missing_token", "token を指定してください。");

  store.deleteSession(token);
  return jsonOk({ message: "ログアウトしました" });
}

function requireAuth(store, params) {
  const token = (params.token || "").trim();
  if (!token) return { error: jsonError("missing_token", "token を指定してください。") };

  const session = store.findSession(token);
  if (!session) return { error: jsonError("invalid_token", "セッションが無効です。再ログインしてください。") };

  const user = store.findUserById(session.userId);
  if (!user) return { error: jsonError("user_not_found", "セッションのユーザーが存在しません。") };

  if (new Date(session.expiresAt).getTime() < Date.now()) {
    store.deleteSession(token);
    return { error: jsonError("session_expired", "セッション期限が切れています。再ログインしてください。") };
  }

  return { user };
}

function buildDashboard(store) {
  const users = store.listUsersSafe();
  const totalUsers = users.length;
  const today = normalizeDate(new Date());
  const attendedToday = store.countAttendanceByDate(today);

  const rate = totalUsers === 0 ? 0 : Math.round((attendedToday / totalUsers) * 100);

  return {
    modelToday: {
      status: attendedToday > 0 ? "進行中" : "未入力",
      desc: `${today} の記録は ${attendedToday} / ${totalUsers} 人です。`,
    },
    ret: {
      today: `${rate}%`,
      desc: totalUsers === 0
        ? "まだユーザーが登録されていません。"
        : `全 ${totalUsers} 人中 ${attendedToday} 人が今日出席しています。`,
    },
  };
}

/* ============================
   DataStore
============================ */
class DataStore {
  constructor() {
    this.sheet = SpreadsheetApp.openById(resolveSpreadsheetId());
    this.users = this.ensureSheetWithHeaders(SHEET_USERS, ["userId", "name", "passwordHash", "passwordSalt", "createdAt", "updatedAt"]);
    this.attendance = this.ensureSheetWithHeaders(SHEET_ATTENDANCE, ["date", "userId", "reps", "createdAt"]);
    this.sessions = this.ensureSheetWithHeaders(SHEET_SESSIONS, ["token", "userId", "expiresAt", "createdAt"]);
  }

  ensureSheetWithHeaders(name, headers) {
    let sheet = this.sheet.getSheetByName(name);
    if (!sheet) {
      sheet = this.sheet.insertSheet(name);
    }

    const lastCol = Math.max(sheet.getLastColumn(), headers.length);
    const firstRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map((v) => String(v || "").trim());

    headers.forEach((header, idx) => {
      if (firstRow[idx] !== header) {
        sheet.getRange(1, idx + 1).setValue(header);
      }
    });

    return sheet;
  }

  listUsersRaw() {
    const values = this.users.getDataRange().getValues();
    const [header, ...rows] = values;
    const index = indexMap(header);

    return rows
      .map((r) => ({
        userId: String(r[index.userId] || r[index.pin] || "").trim(),
        name: String(r[index.name] || "").trim(),
        passwordHash: String(r[index.passwordHash] || ""),
        passwordSalt: String(r[index.passwordSalt] || ""),
      }))
      .filter((u) => u.userId && u.name);
  }

  listUsersSafe() {
    return this.listUsersRaw().map((u) => ({ userId: u.userId, name: u.name }));
  }

  findUserById(userId) {
    return this.listUsersRaw().find((u) => u.userId === String(userId));
  }

  addUser(user) {
    const now = nowString();
    this.users.appendRow([user.userId, user.name, user.passwordHash, user.passwordSalt, now, now]);
  }

  getAttendanceForUser(userId) {
    const values = this.attendance.getDataRange().getValues();
    const [header, ...rows] = values;
    const index = indexMap(header);

    return rows
      .filter((r) => String(r[index.userId] || r[index.pin] || "") === String(userId))
      .map((r) => normalizeDate(r[index.date]));
  }

  recordAttendance(userId, dateStr, reps) {
    const date = normalizeDate(dateStr);
    const values = this.attendance.getDataRange().getValues();
    const [header, ...rows] = values;
    const index = indexMap(header);

    const exists = rows.some((row) => (
      normalizeDate(row[index.date]) === date && String(row[index.userId] || row[index.pin] || "") === String(userId)
    ));

    if (!exists) {
      this.attendance.appendRow([date, userId, reps, nowString()]);
    }
  }

  countAttendanceByDate(dateStr) {
    const target = normalizeDate(dateStr);
    const values = this.attendance.getDataRange().getValues();
    const [header, ...rows] = values;
    const index = indexMap(header);

    const userSet = new Set();
    rows.forEach((r) => {
      if (normalizeDate(r[index.date]) !== target) return;
      const userId = String(r[index.userId] || r[index.pin] || "").trim();
      if (userId) userSet.add(userId);
    });
    return userSet.size;
  }

  createSession(userId) {
    const token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
    const expiresAtDate = new Date(Date.now() + SESSION_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
    const expiresAt = Utilities.formatDate(expiresAtDate, "Etc/GMT", "yyyy-MM-dd'T'HH:mm:ss'Z'");
    this.sessions.appendRow([token, userId, expiresAt, nowString()]);
    return { token, expiresAt };
  }

  findSession(token) {
    const values = this.sessions.getDataRange().getValues();
    const [header, ...rows] = values;
    const index = indexMap(header);

    for (const row of rows) {
      if (String(row[index.token]) !== String(token)) continue;
      return {
        token: String(row[index.token]),
        userId: String(row[index.userId] || ""),
        expiresAt: String(row[index.expiresAt] || ""),
      };
    }
    return null;
  }

  deleteSession(token) {
    const values = this.sessions.getDataRange().getValues();
    const [header, ...rows] = values;
    const index = indexMap(header);

    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (String(rows[i][index.token]) === String(token)) {
        this.sessions.deleteRow(i + 2);
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

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Utilities.formatDate(date, TIMEZONE, DATE_FORMAT);
}

function nowString() {
  return Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss");
}

function validatePassword(password) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password は ${MIN_PASSWORD_LENGTH} 文字以上にしてください。`;
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return "password は英字と数字を両方含めてください。";
  }
  return "";
}

function generateSalt() {
  return Utilities.getUuid().replace(/-/g, "");
}

function hashPassword(password, salt) {
  const raw = `${salt}:${password}`;
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return digest.map((b) => {
    const n = b < 0 ? b + 256 : b;
    return (`0${n.toString(16)}`).slice(-2);
  }).join("");
}

function verifyPassword(password, salt, expectedHash) {
  return hashPassword(password, salt) === String(expectedHash || "");
}

function indexMap(headerRow) {
  const map = {};
  (headerRow || []).forEach((name, idx) => {
    map[String(name || "").trim()] = idx;
  });
  return map;
}

function jsonOutput(body) {
  const output = ContentService.createTextOutput(JSON.stringify(body));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function jsonOk(data) {
  return jsonOutput({ status: "ok", ...data });
}

function jsonError(code, message) {
  return jsonOutput({ status: "error", code, message });
}
