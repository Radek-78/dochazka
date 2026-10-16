/**
 * GDPR modul pro automatizované mazání docházky.
 *
 * Retenční politika:
 *   - Uchovává aktuální měsíc + 2 předchozí měsíce.
 *   - Statusy dovolené (is_vacation=true nebo retention_category=YEAR_END)
 *     se uchovávají do konce kalendářního roku.
 *   - 1. ledna se dovolené z předchozího roku také smažou.
 */

var Purge = Purge || {};

/**
 * Vrátí množinu status_id, které jsou dovolené (YEAR_END retence).
 */
Purge._getVacationStatusIds = function() {
  const coreSS = DB.getCore();
  const statuses = DB.getTable(coreSS, DB_SHEETS.CORE.ATTENDANCE_STATUSES);
  const ids = new Set();
  statuses.forEach(function(st) {
    if (st.is_vacation === 'true' || st.is_vacation === true ||
        st.retention_category === 'YEAR_END') {
      ids.add(String(st.status_id || '').trim());
    }
  });
  return ids;
};

/**
 * Spočítá cutoff datum — 1. den měsíce před (aktuální - 2).
 * Záznamy s datem < cutoffDate jsou kandidáty ke smazání.
 */
Purge._getCutoffDate = function(now) {
  const d = now || new Date();
  const year = d.getFullYear();
  const month = d.getMonth(); // 0-based
  // aktuální měsíc = month, uchováváme current + 2 předchozí
  // → mazáme vše před (month - 2), tj. cutoff = první den (month - 2)
  const cutoffMonth = month - 2;
  const cutoffYear = cutoffMonth < 0 ? year - 1 : year;
  const normalizedMonth = ((cutoffMonth % 12) + 12) % 12;
  return new Date(cutoffYear, normalizedMonth, 1);
};

/**
 * Vybere záznamy docházky ke smazání podle retenční politiky.
 * Používá ji analýza, náhled čekající analýzy i samotné mazání – seznam se
 * neukládá (Script Properties mají limit 9 kB na hodnotu), vždy se přepočítá.
 * @param {Date} cutoffDate - Záznamy starší než toto datum jsou kandidáti ke smazání.
 * @param {boolean} isNewYear - Novoroční běh: mažou se i dovolené z předchozího roku.
 * @param {number} currentYear - Rok, ke kterému se novoroční běh vztahuje.
 * @returns {Object} toDelete, toDeleteVacation a měsíční přehledy
 */
Purge._selectRecords_ = function(cutoffDate, isNewYear, currentYear) {
  const vacationIds = Purge._getVacationStatusIds();
  const transSS = DB.getTransaction();
  const attendance = DB.getTable(transSS, DB_SHEETS.TRANSACTION.ATTENDANCE);

  // Načteme uživatele pro zobrazení jmen
  const coreSS = DB.getCore();
  const users = DB.getTable(coreSS, DB_SHEETS.CORE.USERS);
  const userMap = {};
  users.forEach(function(u) { userMap[u.user_id] = (u.first_name || '') + ' ' + (u.last_name || ''); });

  // Načteme statusy pro zobrazení názvů
  const statuses = DB.getTable(coreSS, DB_SHEETS.CORE.ATTENDANCE_STATUSES);
  const statusMap = {};
  statuses.forEach(function(st) { statusMap[String(st.status_id || '').trim()] = st.name || st.status_id; });

  const toDelete = [];       // běžné záznamy ke smazání
  const toDeleteVacation = []; // dovolené ke smazání (jen při newYear)

  const deleteMonths = {};        // "2026-01" → count  (ke smazání)
  const keptRecentMonths = {};    // "2026-03" → count  (v retenci)
  const keptVacationMonths = {};  // "2026-01" → count  (dovolené ponechané)

  attendance.forEach(function(entry) {
    const dateStr = _toPfx(entry.date);
    if (!dateStr || dateStr.length < 10) return;

    const entryDate = new Date(dateStr + 'T00:00:00');
    const isVacation = vacationIds.has(String(entry.status_id || '').trim());
    const entryYear = entryDate.getFullYear();
    const mk = dateStr.substring(0, 7);

    if (entryDate >= cutoffDate) {
      // V retenčním okně — ponechat
      keptRecentMonths[mk] = (keptRecentMonths[mk] || 0) + 1;
      return;
    }

    const record = {
      attendance_id: entry.attendance_id,
      user_name: userMap[entry.user_id] || entry.user_id,
      date: dateStr,
      status_name: statusMap[String(entry.status_id || '').trim()] || entry.status_id,
      slot: entry.slot || ''
    };

    // Starší než cutoff
    if (isVacation) {
      if (isNewYear && entryYear < currentYear) {
        // 1. ledna: dovolené z minulého roku se také mažou
        toDeleteVacation.push(record);
        deleteMonths[mk] = (deleteMonths[mk] || 0) + 1;
      } else {
        // Dovolená v nenovoročním běhu — ponechat
        keptVacationMonths[mk] = (keptVacationMonths[mk] || 0) + 1;
      }
    } else {
      toDelete.push(record);
      deleteMonths[mk] = (deleteMonths[mk] || 0) + 1;
    }
  });

  const toList = function(obj) {
    return Object.keys(obj).sort().map(function(m) { return { month: m, count: obj[m] }; });
  };
  const sum = function(obj) {
    return Object.keys(obj).reduce(function(a, k) { return a + obj[k]; }, 0);
  };
  return {
    toDelete: toDelete,
    toDeleteVacation: toDeleteVacation,
    months: toList(deleteMonths),
    keptRecentMonths: toList(keptRecentMonths),
    keptVacationMonths: toList(keptVacationMonths),
    keptRecent: sum(keptRecentMonths),
    keptVacation: sum(keptVacationMonths)
  };
};

/**
 * Doplní k uloženým metadatům analýzy aktuální výběr záznamů (tvar pro UI).
 * @param {Object} meta - Metadata uložená v Script Properties.
 * @returns {Object}
 */
Purge._withRecords_ = function(meta) {
  const sel = Purge._selectRecords_(new Date(meta.cutoffDate + 'T00:00:00'), meta.isNewYear, meta.currentYear);
  const result = {};
  Object.keys(meta).forEach(function(k) { result[k] = meta[k]; });
  result.totalToDelete = sel.toDelete.length + sel.toDeleteVacation.length;
  result.regularCount = sel.toDelete.length;
  result.vacationCount = sel.toDeleteVacation.length;
  result.keptVacation = sel.keptVacation;
  result.keptRecent = sel.keptRecent;
  result.months = sel.months;
  result.keptRecentMonths = sel.keptRecentMonths;
  result.keptVacationMonths = sel.keptVacationMonths;
  result.records = sel.toDelete;
  result.vacationRecords = sel.toDeleteVacation;
  return result;
};

/**
 * Provede analýzu co by se smazalo — bez jakéhokoliv zásahu do dat.
 * Do Script Properties uloží jen metadata (bez seznamu záznamů).
 * Vrátí summary objekt včetně seznamu záznamů.
 */
Purge.analyze = function() {
  if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");

  const now = new Date();
  const cutoffDate = Purge._getCutoffDate(now);
  const tz = Session.getScriptTimeZone();
  const meta = {
    purgeId: 'PURGE_' + Utilities.formatDate(now, tz, "yyyyMMdd_HHmmss"),
    analyzedAt: now.toISOString(),
    cutoffDate: Utilities.formatDate(cutoffDate, tz, "yyyy-MM-dd"),
    isNewYear: (now.getMonth() === 0 && now.getDate() === 1),
    currentYear: now.getFullYear(),
    status: PURGE_STATUS.PENDING
  };
  const summary = Purge._withRecords_(meta);
  meta.totalToDelete = summary.totalToDelete; // jen pro přehled, provedení vždy přepočítá

  PropertiesService.getScriptProperties().setProperty(PROP_PENDING_PURGE, JSON.stringify(meta));
  return summary;
};

/**
 * Vrátí aktuálně čekající analýzu (nebo null) se seznamem záznamů přepočteným k teď.
 */
Purge.getPending = function() {
  if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_PENDING_PURGE);
  if (!raw) return null;
  let p;
  try {
    p = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (p.status !== PURGE_STATUS.PENDING) return null;
  if (!p.currentYear) p.currentYear = new Date(p.analyzedAt).getFullYear(); // analýza z dřívější verze
  return Purge._withRecords_(p);
};

/**
 * Zruší čekající analýzu.
 */
Purge.cancelPending = function() {
  if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
  PropertiesService.getScriptProperties().deleteProperty(PROP_PENDING_PURGE);
  return { success: true };
};

/**
 * Provede zálohu, smaže záznamy a zapíše do PURGE_LOG.
 * Vyžaduje platný purgeId shodující se s pending analýzou.
 */
Purge.execute = function(purgeId) {
  if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");

  const raw = PropertiesService.getScriptProperties().getProperty(PROP_PENDING_PURGE);
  if (!raw) throw new Error("Žádná čekající analýza nebyla nalezena.");

  const pending = JSON.parse(raw);
  if (pending.purgeId !== purgeId) throw new Error("Neplatné purgeId — spusťte analýzu znovu.");
  if (pending.status !== PURGE_STATUS.PENDING) throw new Error("Analýza již byla provedena nebo zrušena.");
  if (!pending.currentYear) pending.currentYear = new Date(pending.analyzedAt).getFullYear();

  const actor = Auth.getCurrentUser();

  // 1. Záloha TRANSACTION spreadsheetu před mazáním (bez zálohy se nemaže).
  // Běží ještě mimo zámek – kopie trvá i desítky sekund a uživatelé by mezitím nemohli ukládat.
  // Mažou se jen staré záznamy, které se mezi zálohou a mazáním nemění.
  const backupFileId = Backup.createPurgeBackup();

  // Mazání řádků nesmí běžet souběžně s ukládáním docházky (to pracuje s čísly řádků)
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Probíhá zápis docházky, zkuste mazání za chvíli znovu.");
  let deletedCount = 0;
  try {
    // Souběžné provedení stejné analýzy (dvojklik, dva admini) – druhé už nemá co dělat
    const current = PropertiesService.getScriptProperties().getProperty(PROP_PENDING_PURGE);
    if (!current || JSON.parse(current).purgeId !== purgeId) {
      throw new Error("Analýza již byla provedena nebo zrušena.");
    }
    // Čerstvá data – v plánovaném běhu má ATTENDANCE v mezipaměti už analýza
    DB.clearCache(DB_SHEETS.TRANSACTION.ATTENDANCE);
    // Výběr se přepočítá podle uložených parametrů (seznam se kvůli limitu Properties neukládá)
    const sel = Purge._selectRecords_(new Date(pending.cutoffDate + 'T00:00:00'), pending.isNewYear, pending.currentYear);
    const deleteIds = new Set(sel.toDelete.concat(sel.toDeleteVacation)
      .map(function(r) { return String(r.attendance_id || ''); })
      .filter(function(id) { return id !== ''; })); // prázdné ID by smazalo všechny řádky bez ID

    // 2. Fyzické smazání z ATTENDANCE – souvislé bloky odspodu, aby se indexy neposunuly
    const transSS = DB.getTransaction();
    const sheet = transSS.getSheetByName(DB_SHEETS.TRANSACTION.ATTENDANCE);
    const allRows = sheet.getDataRange().getValues();
    const idIdx = allRows[0].indexOf('attendance_id');
    let i = allRows.length - 1;
    while (i >= 1) {
      if (!deleteIds.has(String(allRows[i][idIdx] || ''))) { i--; continue; }
      const end = i;
      while (i >= 1 && deleteIds.has(String(allRows[i][idIdx] || ''))) i--;
      // řádky i+1..end (index v poli) = listové řádky i+2..end+1
      sheet.deleteRows(i + 2, end - i);
      deletedCount += end - i;
    }
    SpreadsheetApp.flush();
    DB.clearCache(DB_SHEETS.TRANSACTION.ATTENDANCE);
  } finally {
    lock.releaseLock();
  }

  // 3. Zápis do PURGE_LOG
  const systemSS = DB.getSystem();
  DB.insertRow(systemSS, DB_SHEETS.SYSTEM.PURGE_LOG, {
    purge_id: purgeId,
    executed_at: new Date().toISOString(),
    executed_by: actor ? (actor.email || actor.user_id) : 'SYSTEM',
    deleted_count: deletedCount,
    backup_file_id: backupFileId,
    cutoff_date: pending.cutoffDate,
    included_vacation: pending.isNewYear ? 'ano' : 'ne',
    note: pending.isNewYear ? 'Novoroční běh — smazány i dovolené z předchozího roku' : ''
  });

  // 4. Audit log
  _auditLog_("GDPR_PURGE_EXECUTED", {
    purge_id: purgeId,
    deleted_count: deletedCount,
    cutoff_date: pending.cutoffDate,
    backup_file_id: backupFileId,
    is_new_year: pending.isNewYear
  }, actor);

  // 5. Vymazat pending
  PropertiesService.getScriptProperties().deleteProperty(PROP_PENDING_PURGE);

  return { success: true, deletedCount: deletedCount, backupFileId: backupFileId };
};

/**
 * Vrátí nastavení automatického měsíčního mazání (bez ručního schválení).
 */
Purge.getAutoPurgeSetting = function() {
  if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
  return {
    enabled: PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_GDPR_AUTO_PURGE_ENABLED) === 'true'
  };
};

/**
 * Uloží nastavení automatického měsíčního mazání.
 */
Purge.setAutoPurgeSetting = function(enabled) {
  if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.PROP_GDPR_AUTO_PURGE_ENABLED,
    (enabled === true || enabled === 'true') ? 'true' : 'false'
  );
  return this.getAutoPurgeSetting();
};

/**
 * Time trigger — 1. dne každého měsíce v 01:00.
 * Spustí analýzu. Pokud je zapnuté automatické mazání, rovnou ho provede
 * (se zálohou, jako při ručním schválení). Jinak analýza čeká na ruční
 * schválení v administraci (sekce GDPR / Archivace) – bez upozornění.
 */
Purge.scheduledRun = function() {
  try {
    const summary = Purge.analyze();

    if (summary.totalToDelete === 0) {
      console.log("Purge: Žádné záznamy ke smazání.");
      return;
    }

    if (Purge.getAutoPurgeSetting().enabled) {
      // Purge.execute sama zajišťuje zálohu, smazání i log
      const result = Purge.execute(summary.purgeId);
      console.log("Purge: Automatické mazání provedeno. Smazáno: " + result.deletedCount);
      return;
    }

    console.log("Purge: Analýza uložena, čeká na schválení v administraci. Ke smazání: " + summary.totalToDelete);
  } catch (e) {
    console.error("Purge.scheduledRun error: " + e.toString());
    _auditLog_("GDPR_PURGE_SCHEDULED_ERROR", { error: e.toString() }, { email: "SYSTEM_PURGE" });
    throw e; // bez upozornění musí být selhání vidět aspoň v Executions (a e-mailem od Googlu)
  }
};

/**
 * Vrátí historii provedených promazání z PURGE_LOG.
 */
Purge.getLog = function() {
  if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
  const systemSS = DB.getSystem();
  const log = DB.getTable(systemSS, DB_SHEETS.SYSTEM.PURGE_LOG);
  return log.slice().reverse(); // nejnovější první
};

/**
 * Globální wrapper pro time trigger.
 */
function runScheduledPurgeAnalysis() { Auth.requireOwnerContext_(); Purge.scheduledRun(); }
