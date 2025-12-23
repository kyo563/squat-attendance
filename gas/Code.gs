const SPREADSHEET_ID = "{{SPREADSHEET_ID}}"; // スクリプト プロパティ `SPREADSHEET_ID` を優先
const API_SHARED_KEY = ""; // 利用する場合のみ値を入れ、クライアントは key パラメーターを付与

const SHEET_USERS = "Users";
const SHEET_ATTENDANCE = "Attendance";
const TIMEZONE = "Asia/Tokyo";
const DATE_FORMAT = "yyyy-MM-dd";

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
      default:
        return jsonError("unknown_mode", `mode=${mode} は未対応です`);
    }
  } catch (error) {
    console.error(error);
    return jsonError("server_error", error.message || "サーバーエラーが発生しました");
  }
}

function handleLogin(store, params) {
  const pin = (params.pin || "").trim();
  if (!pin) return jsonError("missing_pin", "PIN を指定してください。");

  const user = store.findUser(pin);
  if (!user) return jsonError("user_not_found", "ユーザーが存在しません。");

  const attendance = store.getAttendanceForPin(pin);
  const dashboard = buildDashboard(store);

  return jsonOk({
    name: user.name,
    users: store.listUsers(),
    attendance,
    dashboard,
  });
}

function handleRegister(store, params) {
  const pin = (params.pin || "").trim();
  const name = (params.name || "").trim();
  if (!pin || !name) return jsonError("missing_params", "名前と PIN を入力してください。");

  const exists = store.findUser(pin);
  if (exists) return jsonError("already_exists", "同じ PIN のユーザーが登録済みです。");

  store.addUser({ pin, name });
  return jsonOk({
    message: "登録しました",
    users: store.listUsers(),
  });
}

function handleGetAttendance(store, params) {
  const pin = (params.pin || "").trim();
  if (!pin) return jsonError("missing_pin", "PIN を指定してください。");

  const user = store.findUser(pin);
  if (!user) return jsonError("user_not_found", "ユーザーが存在しません。");

  const attendance = store.getAttendanceForPin(pin);
  const dashboard = buildDashboard(store);

  return jsonOk({ attendance, dashboard });
}

function handleCheckin(store, params) {
  const pin = (params.pin || "").trim();
  if (!pin) return jsonError("missing_pin", "PIN を指定してください。");

  const user = store.findUser(pin);
  if (!user) return jsonError("user_not_found", "ユーザーが存在しません。");

  const rawDate = params.date ? new Date(params.date) : new Date();
  const date = normalizeDate(rawDate);

  store.recordAttendance(pin, date);

  const attendance = store.getAttendanceForPin(pin);
  const dashboard = buildDashboard(store);

  return jsonOk({
    message: `${date} を出席として記録しました`,
    attendance,
    dashboard,
  });
}

function buildDashboard(store) {
  const users = store.listUsers();
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
    this.users = this.ensureSheet(SHEET_USERS, ["pin", "name", "createdAt", "updatedAt"]);
    this.attendance = this.ensureSheet(SHEET_ATTENDANCE, ["date", "pin"]);
  }

  ensureSheet(name, headers) {
    let sheet = this.sheet.getSheetByName(name);
    if (!sheet) {
      sheet = this.sheet.insertSheet(name);
    }
    const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    const hasHeader = firstRow.some(String);
    if (!hasHeader) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    return sheet;
  }

  listUsers() {
    const values = this.users.getDataRange().getValues();
    const [, ...rows] = values;
    return rows
      .filter((r) => r[0] && r[1])
      .map((r) => ({ pin: String(r[0]), name: String(r[1]) }));
  }

  findUser(pin) {
    return this.listUsers().find((u) => u.pin === String(pin));
  }

  addUser(user) {
    const now = nowString();
    this.users.appendRow([user.pin, user.name, now, now]);
  }

  getAttendanceForPin(pin) {
    const values = this.attendance.getDataRange().getValues();
    const [, ...rows] = values;
    return rows
      .filter((r) => String(r[1]) === String(pin))
      .map((r) => normalizeDate(r[0]));
  }

  recordAttendance(pin, dateStr) {
    const date = normalizeDate(dateStr);
    const exists = this.attendance
      .getDataRange()
      .getValues()
      .some((row, idx) => idx > 0 && normalizeDate(row[0]) === date && String(row[1]) === String(pin));
    if (!exists) {
      this.attendance.appendRow([date, pin]);
    }
  }

  countAttendanceByDate(dateStr) {
    const target = normalizeDate(dateStr);
    const values = this.attendance.getDataRange().getValues();
    const [, ...rows] = values;
    return rows.filter((r) => normalizeDate(r[0]) === target).length;
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
