/**
 * Modul pro inicializaci aplikace a vytvoření databáze.
 */

const Setup = {
  /**
   * Hlavní inicializační funkce. Vytvoří strukturu v Drive a tabulky.
   */
  initialize: function() {
    // 1. Získání rodičovské složky aktuálního skriptu
    let parentFolder;
    try {
      const scriptFile = DriveApp.getFileById(ScriptApp.getScriptId());
      parentFolder = scriptFile.getParents().next();
    } catch (e) {
      // Fallback na root pokud nelze rodiče získat (např. u unbound skriptů)
      parentFolder = DriveApp.getRootFolder();
    }

    // 2. Vytvoření/vyhledání složky projektu v rámci rodiče
    let folder;
    const folders = parentFolder.getFoldersByName(CONFIG.FOLDER_NAME);
    if (folders.hasNext()) {
      folder = folders.next();
    } else {
      folder = parentFolder.createFolder(CONFIG.FOLDER_NAME);
    }

    // 3. Vytvoření Spreadsheetů
    const coreId = this.createSpreadsheet(folder, "CORE_DB", DB_SHEETS.CORE);
    const transId = this.createSpreadsheet(folder, "TRANSACTION_DB", DB_SHEETS.TRANSACTION);
    const systemId = this.createSpreadsheet(folder, "SYSTEM_DB", DB_SHEETS.SYSTEM);

    // 3. Uložení ID do Script Properties
    const props = PropertiesService.getScriptProperties();
    props.setProperties({
      [CONFIG.PROP_SS_CORE_ID]: coreId,
      [CONFIG.PROP_SS_TRANSACTION_ID]: transId,
      [CONFIG.PROP_SS_SYSTEM_ID]: systemId
    });

    // 4. Předvyplnění výchozích dat (např. statusy)
    this.seedDefaultData(coreId);
    
    // 5. Předvyplnění výchozích lokací
    if (typeof Admin !== 'undefined' && Admin.ensureDefaultLocations) {
      Admin.ensureDefaultLocations();
    }

    return true;
  },

  /**
   * Vytvoří Spreadsheet a listy v něm.
   */
  createSpreadsheet: function(folder, name, sheetsConfig) {
    const files = folder.getFilesByName(name);
    let ss;
    if (files.hasNext()) {
      ss = SpreadsheetApp.open(files.next());
    } else {
      ss = SpreadsheetApp.create(name);
      const file = DriveApp.getFileById(ss.getId());
      folder.addFile(file);
      DriveApp.getRootFolder().removeFile(file);
    }

    // Vytvoření listů dle konfigurace
    for (let key in sheetsConfig) {
      const sheetName = sheetsConfig[key];
      let sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        sheet = ss.insertSheet(sheetName);
        this.setHeaders(sheet, sheetName);
      }
    }

    // Smazání výchozího "Sheet1"
    const sheet1 = ss.getSheetByName("Sheet1");
    if (sheet1 && ss.getSheets().length > 1) {
      ss.deleteSheet(sheet1);
    }

    return ss.getId();
  },

  /**
   * Nastaví hlavičky pro konkrétní listy.
   */
  setHeaders: function(sheet, sheetName) {
    let headers = [];
    switch (sheetName) {
      case DB_SHEETS.CORE.LOCATIONS: 
        headers = ["location_id", "name", "type", "active"]; break;
      case DB_SHEETS.CORE.SECTIONS: 
        headers = ["section_id", "name", "location_id", "active", "desk_reservation_enabled"]; break;
      case DB_SHEETS.CORE.DEPARTMENTS: 
        headers = ["department_id", "name", "section_id", "active"]; break;
      case DB_SHEETS.CORE.GROUPS: 
        headers = ["group_id", "name", "department_id", "active"]; break;
      case DB_SHEETS.CORE.POSITIONS:
        headers = ["position_id", "name", "active", "org_role"]; break;
      case DB_SHEETS.CORE.USERS:
        headers = ["user_id", "email", "first_name", "last_name", "section_id", "department_id", "group_id", "position_id", "system_role", "org_role", "date_start", "date_end", "active", "auth_status", "last_active", "last_visit", "sync_own_attendance", "sync_team_vacations", "vacation_days_total", "vacation_days_carried_over", "show_work_start_time", "default_work_start_time"]; break;
      case DB_SHEETS.CORE.ATTENDANCE_STATUSES:
        headers = ["status_id", "name", "abbreviation", "color", "text_color", "category", "requires_approval", "allows_desk_reservation", "active", "is_vacation", "shows_work_time"]; break;
      case DB_SHEETS.CORE.VACATION_CONFIG:
        headers = ["system_type", "global_days", "base_days", "max_extra_days", "require_dept_leader_approval"]; break;
      case DB_SHEETS.CORE.PLANNER_GROUPS:
        headers = ["group_id", "name", "description", "active", "color", "calendar_id"]; break;
      case DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS:
        headers = ["group_id", "user_id", "permission"]; break; // permission: VIEW, WRITE, ADMIN
      case DB_SHEETS.CORE.SECTION_VIEW_CONFIG:
        headers = ["section_id", "show_leader_first", "config_json"]; break;
      case DB_SHEETS.CORE.OFFICE_MAPS:
        headers = ["map_id", "section_id", "name", "rows", "cols", "cells_json", "active"]; break;
      case DB_SHEETS.CORE.RBAC_CONFIG:
        headers = ["rbac_key", "USER", "LEADER", "ADMIN", "SUPERADMIN"]; break;

      case DB_SHEETS.TRANSACTION.ATTENDANCE:
        headers = ["attendance_id", "user_id", "date", "status_id", "slot", "note", "approved", "created_at", "work_start_time"]; break;
      case DB_SHEETS.TRANSACTION.PLANNER_EVENTS:
        headers = ["event_id", "group_id", "user_id", "date", "type", "description", "status"]; break;
      case DB_SHEETS.TRANSACTION.MAP_RESERVATIONS:
        headers = ["reservation_id", "map_id", "cell_id", "user_id", "date", "active"]; break;

      case DB_SHEETS.SYSTEM.NOTIFICATIONS:
        headers = ["notif_id", "user_id", "title", "message", "type", "read", "timestamp"]; break;
      case DB_SHEETS.SYSTEM.AUDIT_LOG:
        headers = ["timestamp", "user_email", "action", "details"]; break;
    }
    
    if (headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }
  },

  /**
   * Vrátí očekávané hlavičky pro daný sheet (bez zápisu).
   * Používá se pro auto-extend sloupců v updateEntity.
   */
  getExpectedHeaders: function(sheetName) {
    var h = [];
    switch (sheetName) {
      case DB_SHEETS.CORE.LOCATIONS: h = ["location_id", "name", "type", "active"]; break;
      case DB_SHEETS.CORE.SECTIONS: h = ["section_id", "name", "location_id", "active", "desk_reservation_enabled"]; break;
      case DB_SHEETS.CORE.DEPARTMENTS: h = ["department_id", "name", "section_id", "active"]; break;
      case DB_SHEETS.CORE.GROUPS: h = ["group_id", "name", "department_id", "active"]; break;
      case DB_SHEETS.CORE.POSITIONS: h = ["position_id", "name", "active", "org_role"]; break;
      case DB_SHEETS.CORE.USERS: h = ["user_id", "email", "first_name", "last_name", "section_id", "department_id", "group_id", "position_id", "system_role", "org_role", "date_start", "date_end", "active", "auth_status", "last_active", "last_visit", "sync_own_attendance", "sync_team_vacations", "vacation_days_total", "vacation_days_carried_over", "show_work_start_time", "default_work_start_time"]; break;
      case DB_SHEETS.CORE.ATTENDANCE_STATUSES: h = ["status_id", "name", "abbreviation", "color", "text_color", "category", "requires_approval", "allows_desk_reservation", "active", "is_vacation"]; break;
      case DB_SHEETS.CORE.SECTION_VIEW_CONFIG: h = ["section_id", "show_leader_first", "config_json"]; break;
      case DB_SHEETS.CORE.OFFICE_MAPS: h = ["map_id", "section_id", "name", "rows", "cols", "cells_json", "active"]; break;
      case DB_SHEETS.TRANSACTION.ATTENDANCE: h = ["attendance_id", "user_id", "date", "status_id", "slot", "note", "approved", "created_at", "work_start_time"]; break;
      case DB_SHEETS.TRANSACTION.MAP_RESERVATIONS: h = ["reservation_id", "map_id", "cell_id", "user_id", "date", "active"]; break;
    }
    return h;
  },

  /**
   * Opraví chybějící hlavičky ve všech existujících listech.
   */
  repairDatabaseHeaders: function() {
    const ssList = [DB.getCore(), DB.getTransaction(), DB.getSystem()];
    const configs = [DB_SHEETS.CORE, DB_SHEETS.TRANSACTION, DB_SHEETS.SYSTEM];
    var added = [];

    ssList.forEach((ss, idx) => {
      const config = configs[idx];
      for (let key in config) {
        const sheetName = config[key];
        const sheet = ss.getSheetByName(sheetName);
        if (!sheet) continue;

        if (sheet.getLastRow() === 0) {
          this.setHeaders(sheet, sheetName);
          continue;
        }

        // Přidat chybějící sloupce k existujícím datům
        var expected = this.getExpectedHeaders(sheetName);
        if (!expected || expected.length === 0) continue;

        var lastCol = sheet.getLastColumn();
        var currentHeaders = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
        var currentSet = new Set(currentHeaders);

        expected.forEach(function(h) {
          if (!currentSet.has(h)) {
            var newCol = sheet.getLastColumn() + 1;
            sheet.getRange(1, newCol).setValue(h).setFontWeight('bold');
            currentSet.add(h);
            added.push(sheetName + '.' + h);
          }
        });
      }
    });
    return { success: true, added: added };
  },

  /**
   * Vloží základní číselníky.
   */
  seedDefaultData: function(coreId) {
    const ss = SpreadsheetApp.openById(coreId);
    const statusSheet = ss.getSheetByName(DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    
    if (statusSheet && statusSheet.getLastRow() === 1) {
      const defaultStatuses = [
        // status_id, name, abbreviation, color, text_color, category, requires_approval, allows_desk_reservation, active, is_vacation
        [Utilities.getUuid(), "Kancelář", "K", "#4CAF50", "#ffffff", "Práce", false, true, true, false],
        [Utilities.getUuid(), "HomeOffice", "HO", "#2196F3", "#ffffff", "Práce", false, false, true, false],
        [Utilities.getUuid(), "Dovolená", "D", "#FF9800", "#ffffff", "Volno / Absence", true, false, true, true],
        [Utilities.getUuid(), "Nemoc", "N", "#F44336", "#ffffff", "Zdraví", false, false, true, false]
      ];
      statusSheet.getRange(2, 1, defaultStatuses.length, defaultStatuses[0].length).setValues(defaultStatuses);
    }
  }
};
