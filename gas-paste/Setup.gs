function setupSpreadsheet() {
  const spreadsheet = SpreadsheetApp.openById(resolveSpreadsheetId());

  // 先頭で既存スプレッドシートをリセット
  const tempSheet = resetSpreadsheet_(spreadsheet);

  createSheetWithHeaders_(spreadsheet, SHEET_USERS, ["userId", "name", "passwordSalt", "passwordHash", "createdAt", "updatedAt"]);
  createSheetWithHeaders_(spreadsheet, SHEET_ATTENDANCE, ["date", "userId", "reps", "createdAt"]);
  createSheetWithHeaders_(spreadsheet, SHEET_SESSIONS, ["token", "userId", "expiresAt", "createdAt", "updatedAt"]);

  spreadsheet.setActiveSheet(spreadsheet.getSheetByName(SHEET_USERS));
  spreadsheet.deleteSheet(tempSheet);
}

function resetSpreadsheet_(spreadsheet) {
  const tempName = `__RESET_TMP__${Date.now()}`;
  const tempSheet = spreadsheet.insertSheet(tempName);

  spreadsheet
    .getSheets()
    .filter((sheet) => sheet.getSheetId() !== tempSheet.getSheetId())
    .forEach((sheet) => spreadsheet.deleteSheet(sheet));

  return tempSheet;
}

function createSheetWithHeaders_(spreadsheet, name, headers) {
  const existing = spreadsheet.getSheetByName(name);
  if (existing) spreadsheet.deleteSheet(existing);

  const sheet = spreadsheet.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}
