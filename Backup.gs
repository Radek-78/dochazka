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
    console.log("Backup: SpouĹˇtĂ­m dennĂ­ plnou zĂˇlohu...");
    
    const prop = PropertiesService.getScriptProperties();
    const ssIds = [
      prop.getProperty(CONFIG.PROP_SS_CORE_ID),
      prop.getProperty(CONFIG.PROP_SS_TRANSACTION_ID),
      prop.getProperty(CONFIG.PROP_SS_SYSTEM_ID)
    ];

    // NajĂ­t nebo vytvoĹ™it sloĹľku "ZĂˇlohy DochĂˇzky"
    const parentFolder = DriveApp.getFileById(ssIds[0]).getParents().next();
    let backupFolder;
    const folders = parentFolder.getFoldersByName("ZĂˇlohy DochĂˇzky");
    if (folders.hasNext()) {
      backupFolder = folders.next();
    } else {
      backupFolder = parentFolder.createFolder("ZĂˇlohy DochĂˇzky");
    }

    const dateStr = Utilities.formatDate(new Date(), "GMT+1", "yyyy-MM-dd");
    
    // 1. Provest kopie
    ssIds.forEach(id => {
      if (!id) return;
      const file = DriveApp.getFileById(id);
      file.makeCopy(`[BACKUP ${dateStr}] ${file.getName()}`, backupFolder);
    });

    // 2. Promazat starĂ© zĂˇlohy (starĹˇĂ­ neĹľ 7 dnĂ­)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);
    
    const backupFiles = backupFolder.getFiles();
    while (backupFiles.hasNext()) {
      const bFile = backupFiles.next();
      if (bFile.getDateCreated() < cutoffDate) {
        console.log(`Backup: MaĹľu starou zĂˇlohu: ${bFile.getName()}`);
        bFile.setTrashed(true);
      }
    }
    
    console.log("Backup: DennĂ­ zĂˇloha dokonÄŤena.");
    this.runPostBackupMaintenance_();
    return true;
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
      if (typeof _auditLog === 'function') {
        _auditLog("DB_HEADER_REPAIR_AFTER_BACKUP_FAILED", { error: e.toString() }, { email: "SYSTEM_BACKUP" });
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

    if (typeof _auditLog === 'function') {
      _auditLog("DB_HEADER_REPAIR_AFTER_BACKUP", details, { email: "SYSTEM_BACKUP" });
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

    snapshotSheet.clearContents();
    snapshotSheet.getRange(1, 1, data.length, data[0].length).setValues(data);
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
      if (func === 'runDailyFullBackup' || func === 'runAttendanceSafetySnapshot') {
        ScriptApp.deleteTrigger(t);
      }
    });

    // DennĂ­ full backup v noci (mezi 2. a 3. rannĂ­)
    ScriptApp.newTrigger('runDailyFullBackup')
      .timeBased()
      .atHour(2)
      .everyDays(1)
      .create();

    // Snapshot dochĂˇzky kaĹľdou hodinu (častějjší interval pro v2.8.0)
    ScriptApp.newTrigger('runAttendanceSafetySnapshot')
      .timeBased()
      .everyHours(1)
      .create();
      
    console.log("Backup: AutomatickĂ© triggery nastaveny.");
  }
};

/**
 * GlobĂˇlnĂ­ wrapper funkce pro triggery
 */
function runDailyFullBackup() { Backup.runDailyFullBackup(); }
function runAttendanceSafetySnapshot() { Backup.runAttendanceSafetySnapshot(); }
function setupBackupTriggers() { Backup.setupTriggers(); }
function runDatabaseHeaderRepair() { return Backup.runDatabaseHeaderRepair(); }
