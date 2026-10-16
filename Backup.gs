/**
 * Modul pro automatické zálohování databází (Google Sheets).
 * Zajišťuje denní plné zálohy a ochranu proti smazání dat.
 */

var Backup = {
  
  /**
   * Provede denní plnou zálohu všech tří databázových souborů.
   * Udržuje historii po dobu 7 dní.
   */
  runDailyFullBackup: function() {
    console.log("Backup: Spouštím denní plnou zálohu...");
    try {
      const prop = PropertiesService.getScriptProperties();
      const ssIds = [
        prop.getProperty(CONFIG.PROP_SS_CORE_ID),
        prop.getProperty(CONFIG.PROP_SS_TRANSACTION_ID),
        prop.getProperty(CONFIG.PROP_SS_SYSTEM_ID)
      ];

      const backupFolder = this._getBackupFolder_(ssIds[0]);
      const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

      // 1. Provést kopie
      ssIds.forEach(id => {
        if (!id) return;
        const file = DriveApp.getFileById(id);
        file.makeCopy(`[BACKUP ${dateStr}] ${file.getName()}`, backupFolder);
      });

      // 2. Promazat staré zálohy a exporty podle retence – chyba retence nesmí shodit hotovou zálohu
      try {
        this._applyRetention_(backupFolder, ssIds[0]);
      } catch (retErr) {
        console.error("Backup: Retence selhala: " + retErr.toString());
        if (typeof _auditLog_ === 'function') {
          _auditLog_("BACKUP_RETENTION_ERROR", { error: retErr.toString() }, { email: "SYSTEM_BACKUP" });
        }
      }
    } catch (e) {
      console.error("Backup: Denní záloha selhala: " + e.toString());
      if (typeof _auditLog_ === 'function') {
        _auditLog_("BACKUP_ERROR", { error: e.toString() }, { email: "SYSTEM_BACKUP" });
      }
      throw e; // trigger musí skončit chybou (viditelné v Executions)
    }

    console.log("Backup: Denní záloha dokončena.");
    this.runPostBackupMaintenance_();
    return true;
  },

  /** Název složky se zálohami (vedle databázových souborů). */
  FOLDER_NAME_: "Zálohy Docházky",
  /** Dřívější název s chybným kódováním – obsah se jednorázově přesune do FOLDER_NAME_. */
  LEGACY_FOLDER_NAME_: "ZĂˇlohy DochĂˇzky",
  /** Složka s exporty logu docházky (Code.gs exportAttendanceLogToSheet). */
  EXPORT_FOLDER_NAME_: "Exporty Docházky",
  /** Retence ve dnech podle typu souboru. */
  RETENTION_DAYS_: { BACKUP: 7, PURGE_BACKUP: 30, EXPORT: 30 },

  /**
   * Najde (nebo založí) složku záloh vedle souboru fileId. Pokud ještě existuje
   * stará složka s chybně zakódovaným názvem, přesune její soubory sem a vyhodí ji do koše.
   * @param {string} fileId - ID databázového souboru, vedle kterého složka leží.
   * @returns {Folder}
   */
  _getBackupFolder_: function(fileId) {
    const parentFolder = DriveApp.getFileById(fileId).getParents().next();
    const folders = parentFolder.getFoldersByName(this.FOLDER_NAME_);
    const backupFolder = folders.hasNext() ? folders.next() : parentFolder.createFolder(this.FOLDER_NAME_);

    const legacy = parentFolder.getFoldersByName(this.LEGACY_FOLDER_NAME_);
    while (legacy.hasNext()) {
      const oldFolder = legacy.next();
      const files = oldFolder.getFiles();
      while (files.hasNext()) files.next().moveTo(backupFolder);
      if (!oldFolder.getFiles().hasNext() && !oldFolder.getFolders().hasNext()) {
        oldFolder.setTrashed(true);
        console.log("Backup: Stará složka záloh sloučena do '" + this.FOLDER_NAME_ + "'.");
      }
    }
    return backupFolder;
  },

  /**
   * Vyhodí do koše soubory starší než retence: denní zálohy [BACKUP ...] 7 dní,
   * zálohy před GDPR mazáním [PURGE_BACKUP ...] 30 dní, exporty logu 30 dní.
   * Ostatní soubory ve složce zálohy nechá být.
   * @param {Folder} backupFolder
   * @param {string} coreId - ID CORE sešitu (vedle něj leží složka exportů).
   */
  _applyRetention_: function(backupFolder, coreId) {
    const now = Date.now();
    const olderThan = (file, days) => file.getDateCreated().getTime() < now - days * 24 * 60 * 60 * 1000;

    const backupFiles = backupFolder.getFiles();
    while (backupFiles.hasNext()) {
      const bFile = backupFiles.next();
      const name = bFile.getName();
      const days = name.indexOf('[PURGE_BACKUP ') === 0 ? this.RETENTION_DAYS_.PURGE_BACKUP
        : (name.indexOf('[BACKUP ') === 0 ? this.RETENTION_DAYS_.BACKUP : null);
      if (days !== null && olderThan(bFile, days)) {
        console.log(`Backup: Mažu starou zálohu: ${name}`);
        bFile.setTrashed(true);
      }
    }

    const parentFolder = DriveApp.getFileById(coreId).getParents().next();
    const exportFolders = parentFolder.getFoldersByName(this.EXPORT_FOLDER_NAME_);
    while (exportFolders.hasNext()) {
      const exportFiles = exportFolders.next().getFiles();
      while (exportFiles.hasNext()) {
        const eFile = exportFiles.next();
        if (olderThan(eFile, this.RETENTION_DAYS_.EXPORT)) {
          console.log(`Backup: Mažu starý export: ${eFile.getName()}`);
          eFile.setTrashed(true);
        }
      }
    }
  },

  /**
   * Servisní údržba po úspěšné denní záloze.
   * Strukturální opravy DB běží až po vytvoření kopií, ne při startu aplikace.
   */
  runPostBackupMaintenance_: function() {
    try {
      const result = this.runDatabaseHeaderRepair();
      console.log("Backup: Servisní oprava hlaviček dokončena: " + JSON.stringify(result));
      return result;
    } catch (e) {
      console.warn("Backup: Servisní oprava hlaviček selhala: " + e.toString());
      if (typeof _auditLog_ === 'function') {
        _auditLog_("DB_HEADER_REPAIR_AFTER_BACKUP_FAILED", { error: e.toString() }, { email: "SYSTEM_BACKUP" });
      }
      return { success: false, error: e.toString() };
    }
  },

  /**
   * Ručně spustitelná oprava hlaviček databázových listů.
   * Používá se také po denní záloze.
   */
  runDatabaseHeaderRepair: function() {
    const startedAt = Date.now();
    if (typeof Setup === 'undefined' || !Setup.repairDatabaseHeaders) {
      throw new Error("Setup.repairDatabaseHeaders není dostupná.");
    }

    const result = Setup.repairDatabaseHeaders();
    const details = {
      duration_ms: Date.now() - startedAt,
      added_count: result && result.added ? result.added.length : 0,
      added: result && result.added ? result.added : []
    };

    if (typeof DB !== 'undefined' && DB.clearCache) {
      DB.clearCache();
    }

    if (typeof _auditLog_ === 'function') {
      _auditLog_("DB_HEADER_REPAIR_AFTER_BACKUP", details, { email: "SYSTEM_BACKUP" });
    }

    return {
      success: true,
      duration_ms: details.duration_ms,
      added_count: details.added_count,
      added: details.added
    };
  },

  /**
   * SpeciĂˇlnĂ­ ochrana pro tabulku dochĂˇzky (spouĹˇtÄ›no pravidelnÄ›).
   * VytvĂˇĹ™Ă­ snapshot pouze pokud tabulka obsahuje data.
   */
  runAttendanceSafetySnapshot: function() {
    console.log("Backup: Kontrola integrity dochĂˇzky...");
    const prop = PropertiesService.getScriptProperties();
    const transId = prop.getProperty(CONFIG.PROP_SS_TRANSACTION_ID);
    if (!transId) return;

    const ss = SpreadsheetApp.openById(transId);
    const sheet = ss.getSheetByName(DB_SHEETS.TRANSACTION.ATTENDANCE);
    if (!sheet) return;

    const data = sheet.getDataRange().getValues();
    const rowCount = data.length;

    // POJISTKA: Pokud mĂˇ tabulka mĂ©nÄ› neĹľ 2 Ĺ™Ăˇdky (jen hlaviÄŤka nebo prĂˇzdno), 
    // nepovaĹľujeme ji za platnou a snapshot NEPROVEDEME (nechceme pĹ™epsat dobrou zĂˇlohu prĂˇzdnem).
    if (rowCount < 5) {
      console.warn("Backup ALERT: Pokus o zĂˇlohu tĂ©mÄ›Ĺ™ prĂˇzdnĂ© tabulky ATTENDANCE zruĹˇen. MoĹľnĂˇ ztrĂˇta dat!");
      return;
    }

    // VytvoĹ™it/aktualizovat snapshot list v rĂˇmci stejnĂ©ho souboru (pro rychlou obnovu)
    let snapshotSheet = ss.getSheetByName("SAFETY_SNAPSHOT_ATTENDANCE");
    if (!snapshotSheet) {
      snapshotSheet = ss.insertSheet("SAFETY_SNAPSHOT_ATTENDANCE");
      snapshotSheet.hideSheet(); // Schovat pĹ™ed bÄ›ĹľnĂ˝m uĹľivatelem
    }

    // Nejdřív zapsat, až pak uklidit přebývající řádky – při chybě zápisu nezůstane snapshot prázdný
    if (snapshotSheet.getMaxRows() < data.length) {
      snapshotSheet.insertRowsAfter(snapshotSheet.getMaxRows(), data.length - snapshotSheet.getMaxRows());
    }
    if (snapshotSheet.getMaxColumns() < data[0].length) {
      snapshotSheet.insertColumnsAfter(snapshotSheet.getMaxColumns(), data[0].length - snapshotSheet.getMaxColumns());
    }
    snapshotSheet.getRange(1, 1, data.length, data[0].length).setValues(data);
    const extraRows = snapshotSheet.getLastRow() - data.length;
    if (extraRows > 0) {
      snapshotSheet.getRange(data.length + 1, 1, extraRows, snapshotSheet.getMaxColumns()).clearContent();
    }
    console.log(`Backup: Snapshot dochĂˇzky uloĹľen (${rowCount} Ĺ™ĂˇdkĹŻ).`);
  },

  /**
   * NastavĂ­ automatickĂ© triggery pro zĂˇlohovĂˇnĂ­.
   */
  setupTriggers: function() {
    // Odstranit starĂ© triggery stejneeho typu, abychom je neduplikovali
    const triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(t => {
      const func = t.getHandlerFunction();
      if (func === 'runDailyFullBackup' || func === 'runAttendanceSafetySnapshot' || func === 'runScheduledPurgeAnalysis') {
        ScriptApp.deleteTrigger(t);
      }
    });

    // DennĂ­ full backup v noci (mezi 2. a 3. rannĂ­)
    ScriptApp.newTrigger('runDailyFullBackup')
      .timeBased()
      .atHour(2)
      .everyDays(1)
      .create();

    // Snapshot dochĂˇzky (sníženo z 1h na 12h kvůli zátěži - denní plná záloha už chrání dostatečně)
    ScriptApp.newTrigger('runAttendanceSafetySnapshot')
      .timeBased()
      .everyHours(12)
      .create();

    // GDPR purge analýza — 1. den každého měsíce v 01:00
    ScriptApp.newTrigger('runScheduledPurgeAnalysis')
      .timeBased()
      .onMonthDay(1)
      .atHour(1)
      .create();

    console.log("Backup: AutomatickĂ© triggery nastaveny.");
  },

  /**
   * Vrátí, které automatické triggery jsou aktuálně nainstalované.
   */
  getTriggersStatus: function() {
    const triggers = ScriptApp.getProjectTriggers();
    const installed = new Set(triggers.map(function(t) { return t.getHandlerFunction(); }));
    return {
      dailyBackup: installed.has('runDailyFullBackup'),
      hourlySnapshot: installed.has('runAttendanceSafetySnapshot'),
      monthlyPurgeAnalysis: installed.has('runScheduledPurgeAnalysis')
    };
  },

  /**
   * Provede zálohu TRANSACTION spreadsheetů před GDPR mazáním.
   * Vrátí ID záložního souboru.
   */
  createPurgeBackup: function() {
    const prop = PropertiesService.getScriptProperties();
    const transId = prop.getProperty(CONFIG.PROP_SS_TRANSACTION_ID);
    if (!transId) throw new Error("TRANSACTION spreadsheet není nakonfigurován.");

    const backupFolder = this._getBackupFolder_(transId);
    const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd_HH-mm");
    const file = DriveApp.getFileById(transId);
    const copy = file.makeCopy(`[PURGE_BACKUP ${dateStr}] ${file.getName()}`, backupFolder);
    console.log("Backup: Purge záloha vytvořena: " + copy.getId());
    return copy.getId();
  }
};

/**
 * GlobĂˇlnĂ­ wrapper funkce pro triggery
 */
function runDailyFullBackup() { Auth.requireOwnerContext_(); Backup.runDailyFullBackup(); }
function runAttendanceSafetySnapshot() { Auth.requireOwnerContext_(); Backup.runAttendanceSafetySnapshot(); }
function setupBackupTriggers() { Auth.requireOwnerContext_(); Backup.setupTriggers(); }
function runDatabaseHeaderRepair() { Auth.requireOwnerContext_(); return Backup.runDatabaseHeaderRepair(); }
