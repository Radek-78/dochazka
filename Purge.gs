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
 * Provede analýzu co by se smazalo — bez jakéhokoliv zásahu do dat.
 * Výsledek uloží do Script Properties jako pending purge.
 * Vrátí summary objekt.
 */
Purge.analyze = function() {
  if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");

  const now = new Date();
  const cutoffDate = Purge._getCutoffDate(now);
  const currentYear = now.getFullYear();
  const isNewYear = (now.getMonth() === 0 && now.getDate() === 1);

  const cutoffDateStr = Utilities.formatDate(cutoffDate, "GMT+1", "yyyy-MM-dd");
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
  const monthDetails = {};        // "2026-01" → { deleteByStatus: {}, keepByStatus: {} }

  const totalScanned = attendance.length;

  attendance.forEach(function(entry) {
    const dateStr = _toPfx(entry.date);
    if (!dateStr || dateStr.length < 10) return;

    const entryDate = new Date(dateStr + 'T00:00:00');
    const isVacation = vacationIds.has(String(entry.status_id || '').trim());
    const entryYear = entryDate.getFullYear();
    const mk = dateStr.substring(0, 7);
    const sName = statusMap[String(entry.status_id || '').trim()] || entry.status_id || '?';

    if (!monthDetails[mk]) monthDetails[mk] = { deleteByStatus: {}, keepByStatus: {} };

    if (entryDate >= cutoffDate) {
      // V retenčním okně — ponechat
      keptRecentMonths[mk] = (keptRecentMonths[mk] || 0) + 1;
      monthDetails[mk].keepByStatus[sName] = (monthDetails[mk].keepByStatus[sName] || 0) + 1;
      return;
    }

    // Starší než cutoff
    if (isVacation) {
      if (isNewYear && entryYear < currentYear) {
        // 1. ledna: dovolené z minulého roku se také mažou
        toDeleteVacation.push({
          attendance_id: entry.attendance_id,
          user_name: userMap[entry.user_id] || entry.user_id,
          date: dateStr,
          status_name: sName,
          slot: entry.slot || ''
        });
        deleteMonths[mk] = (deleteMonths[mk] || 0) + 1;
        monthDetails[mk].deleteByStatus[sName] = (monthDetails[mk].deleteByStatus[sName] || 0) + 1;
      } else {
        // Dovolená v nenovoročním běhu — ponechat
        keptVacationMonths[mk] = (keptVacationMonths[mk] || 0) + 1;
        monthDetails[mk].keepByStatus[sName] = (monthDetails[mk].keepByStatus[sName] || 0) + 1;
      }
    } else {
      toDelete.push({
        attendance_id: entry.attendance_id,
        user_name: userMap[entry.user_id] || entry.user_id,
        date: dateStr,
        status_name: sName,
        slot: entry.slot || ''
      });
      deleteMonths[mk] = (deleteMonths[mk] || 0) + 1;
      monthDetails[mk].deleteByStatus[sName] = (monthDetails[mk].deleteByStatus[sName] || 0) + 1;
    }
  });

  // Sestavit přehledy měsíců (seřazeno)
  const months = Object.keys(deleteMonths).sort().map(function(m) {
    return { month: m, count: deleteMonths[m] };
  });
  const keptRecentMonthsList = Object.keys(keptRecentMonths).sort().map(function(m) {
    return { month: m, count: keptRecentMonths[m] };
  });
  const keptVacationMonthsList = Object.keys(keptVacationMonths).sort().map(function(m) {
    return { month: m, count: keptVacationMonths[m] };
  });

  // Sestavit detail po měsících a statusech
  const monthDetailsList = Object.keys(monthDetails).sort().map(function(m) {
    const d = monthDetails[m];
    const toDeleteArr = Object.keys(d.deleteByStatus).sort().map(function(s) {
      return { status: s, count: d.deleteByStatus[s] };
    });
    const toKeepArr = Object.keys(d.keepByStatus).sort().map(function(s) {
      return { status: s, count: d.keepByStatus[s] };
    });
    const total = toDeleteArr.reduce(function(a, b) { return a + b.count; }, 0) +
                  toKeepArr.reduce(function(a, b) { return a + b.count; }, 0);
    return { month: m, total: total, toDelete: toDeleteArr, toKeep: toKeepArr };
  });

  const purgeId = 'PURGE_' + Utilities.formatDate(now, "GMT+1", "yyyyMMdd_HHmmss");

  const pending = {
    purgeId: purgeId,
    analyzedAt: now.toISOString(),
    cutoffDate: cutoffDateStr,
    isNewYear: isNewYear,
    totalScanned: totalScanned,
    totalToDelete: toDelete.length + toDeleteVacation.length,
    regularCount: toDelete.length,
    vacationCount: toDeleteVacation.length,
    keptVacation: Object.values(keptVacationMonths).reduce(function(a,b){return a+b;}, 0),
    keptRecent: Object.values(keptRecentMonths).reduce(function(a,b){return a+b;}, 0),
    months: months,
    keptRecentMonths: keptRecentMonthsList,
    keptVacationMonths: keptVacationMonthsList,
    monthDetailsList: monthDetailsList,
    records: toDelete,
    vacationRecords: toDeleteVacation,
    status: PURGE_STATUS.PENDING
  };

  PropertiesService.getScriptProperties().setProperty(
    PROP_PENDING_PURGE,
    JSON.stringify(pending)
  );

  return {
    purgeId: purgeId,
    analyzedAt: pending.analyzedAt,
    cutoffDate: cutoffDateStr,
    isNewYear: isNewYear,
    totalScanned: totalScanned,
    totalToDelete: pending.totalToDelete,
    regularCount: pending.regularCount,
    vacationCount: pending.vacationCount,
    keptVacation: pending.keptVacation,
    keptRecent: pending.keptRecent,
    months: months,
    keptRecentMonths: keptRecentMonthsList,
    keptVacationMonths: keptVacationMonthsList,
    monthDetailsList: monthDetailsList,
    records: toDelete,
    vacationRecords: toDeleteVacation
  };
};

/**
 * Vrátí aktuálně čekající analýzu (nebo null).
 */
Purge.getPending = function() {
  if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_PENDING_PURGE);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return p.status === PURGE_STATUS.PENDING ? p : null;
  } catch (e) {
    return null;
  }
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

  const actor = Auth.getCurrentUser();

  // 1. Záloha TRANSACTION spreadsheetu před mazáním
  const backupFileId = Backup.createPurgeBackup();

  // 2. Fyzické smazání z ATTENDANCE sheetu
  const transSS = DB.getTransaction();
  const sheet = transSS.getSheetByName(DB_SHEETS.TRANSACTION.ATTENDANCE);
  const allRows = sheet.getDataRange().getValues();
  const headers = allRows[0];
  const idIdx = headers.indexOf('attendance_id');

  // Sestavit Set ID k smazání
  const allToDelete = (pending.records || []).concat(pending.vacationRecords || []);
  const deleteIds = new Set(allToDelete.map(function(r) { return String(r.attendance_id); }));

  // Smazat od posledního řádku (aby indexy nespadly)
  let deletedCount = 0;
  for (let i = allRows.length - 1; i >= 1; i--) {
    const rowId = String(allRows[i][idIdx] || '');
    if (deleteIds.has(rowId)) {
      sheet.deleteRow(i + 1); // +1 protože GAS je 1-based
      deletedCount++;
    }
  }

  DB.clearCache(DB_SHEETS.TRANSACTION.ATTENDANCE);

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
  _auditLog("GDPR_PURGE_EXECUTED", {
    purge_id: purgeId,
    deleted_count: deletedCount,
    cutoff_date: pending.cutoffDate,
    backup_file_id: backupFileId,
    is_new_year: pending.isNewYear
  }, actor);

  // 5. Email notifikace adminům
  Purge._notifyAdmins_(
    'GDPR mazání provedeno — ' + deletedCount + ' záznamů smazáno',
    'Uživatel ' + (actor ? actor.email : 'SYSTEM') + ' provedl GDPR mazání docházky.\n\n' +
    'Smazáno záznamů: ' + deletedCount + '\n' +
    'Cutoff datum: ' + pending.cutoffDate + '\n' +
    'Záloha: ' + backupFileId + '\n' +
    (pending.isNewYear ? 'Novoroční běh — smazány i dovolené z předchozího roku.\n' : '')
  );

  // 6. Vymazat pending
  PropertiesService.getScriptProperties().deleteProperty(PROP_PENDING_PURGE);

  return { success: true, deletedCount: deletedCount, backupFileId: backupFileId };
};

/**
 * Time trigger — 1. dne každého měsíce v 01:00.
 * Spustí analýzu a notifikuje adminy emailem + in-app.
 */
Purge.scheduledRun = function() {
  try {
    const summary = Purge.analyze();

    if (summary.totalToDelete === 0) {
      console.log("Purge: Žádné záznamy ke smazání.");
      return;
    }

    const subject = 'GDPR docházka — čeká schválení mazání (' + summary.totalToDelete + ' záznamů)';
    const body =
      'Automatická GDPR analýza docházky proběhla ' + new Date().toLocaleDateString('cs-CZ') + '.\n\n' +
      'Ke smazání: ' + summary.totalToDelete + ' záznamů\n' +
      'Cutoff datum: ' + summary.cutoffDate + '\n' +
      (summary.isNewYear ? 'Novoroční běh — budou smazány i dovolené z předchozího roku.\n' : '') +
      '\nPřihlaste se do administrace a schvalte nebo zamítněte promazání v sekci GDPR / Archivace.';

    Purge._notifyAdmins_(subject, body);
    Purge._insertInAppNotification_(subject);

    console.log("Purge: Analýza uložena, admini notifikováni. Ke smazání: " + summary.totalToDelete);
  } catch (e) {
    console.error("Purge.scheduledRun error: " + e.toString());
    _auditLog("GDPR_PURGE_SCHEDULED_ERROR", { error: e.toString() }, { email: "SYSTEM_PURGE" });
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
 * Pošle email všem adminům a superadminům.
 */
Purge._notifyAdmins_ = function(subject, body) {
  try {
    const coreSS = DB.getCore();
    const users = DB.getTable(coreSS, DB_SHEETS.CORE.USERS);
    const adminEmails = users
      .filter(function(u) {
        return (u.system_role === ROLES.SYSTEM.SUPERADMIN || u.system_role === ROLES.SYSTEM.ADMIN) &&
               String(u.active) === 'true' && u.email;
      })
      .map(function(u) { return u.email; });

    if (adminEmails.length === 0) return;

    GmailApp.sendEmail(
      adminEmails.join(','),
      '[Docházkový systém] ' + subject,
      body
    );
  } catch (e) {
    console.warn("Purge._notifyAdmins_ failed: " + e.toString());
  }
};

/**
 * Vloží in-app notifikaci do NOTIFICATIONS pro všechny adminy.
 */
Purge._insertInAppNotification_ = function(message) {
  try {
    const coreSS = DB.getCore();
    const systemSS = DB.getSystem();
    const users = DB.getTable(coreSS, DB_SHEETS.CORE.USERS);
    const admins = users.filter(function(u) {
      return (u.system_role === ROLES.SYSTEM.SUPERADMIN || u.system_role === ROLES.SYSTEM.ADMIN) &&
             String(u.active) === 'true';
    });
    admins.forEach(function(u) {
      DB.insertRow(systemSS, DB_SHEETS.SYSTEM.NOTIFICATIONS, {
        notif_id: Utilities.getUuid(),
        user_id: u.user_id,
        title: 'GDPR — čeká schválení mazání',
        message: message,
        type: 'GDPR_PURGE_PENDING',
        read: 'false',
        timestamp: new Date().toISOString()
      });
    });
  } catch (e) {
    console.warn("Purge._insertInAppNotification_ failed: " + e.toString());
  }
};

/**
 * Globální wrapper pro time trigger.
 */
function runScheduledPurgeAnalysis() { Purge.scheduledRun(); }
