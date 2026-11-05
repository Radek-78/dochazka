/**
 * Sloučení docházkových statusů (jen SUPERADMIN).
 * Postup: analýza (bez zápisu) → spuštění (záloha, záznam změn, převod status_id, deaktivace zdrojů)
 * → přegenerování kalendářů po dávkách → do 30 dní možnost návratu.
 * Záznam změn je v SYSTEM DB, v listu STATUS_MERGE_LOG (obsahuje jen ID záznamů a statusů, bez jmen a dat osob).
 * Zápis do ATTENDANCE mění výhradně sloupce status_id a approved, nikdy celé řádky.
 *
 * Po selhání uprostřed sloučení je podporovaná cesta: Vrátit (návrat je idempotentní) a sloučení zopakovat.
 * Dokud pro zdrojový status existuje nevrácené nedokončené sloučení, nové sloučení se odmítne.
 */

const STATUS_MERGE_RETENTION_DAYS = 30;
// Časový limit jednoho volání přegenerování kalendářů (limit běhu skriptu je 6 minut)
const STATUS_MERGE_RESYNC_LIMIT_MS = 240000;
// Největší počet buněk v jednom RangeList volání
const STATUS_MERGE_CHUNK = 1000;
// Před vstupem do zápisu se sloučení odmítne, pokud příprava (analýza + záloha) trvala déle
const STATUS_MERGE_START_LIMIT_MS = 120000;
// Mezi kroky zápisu se kontroluje čas s rezervou vůči limitu běhu 6 minut
const STATUS_MERGE_STEP_LIMIT_MS = 270000;

// ─────────────────────────────────────────────────────────────────────────────
// Veřejné funkce (volatelné z klienta)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analýza sloučení – nic nezapisuje.
 * @param {string} targetId - Cílový status.
 * @param {string[]} sourceIds - Zdrojové statusy.
 * @returns {{success: boolean, analysis?: Object, error?: string}}
 */
function statusMergeAnalyze(targetId, sourceIds) {
  try {
    _statusMergeRequireSuperadmin_();
    DB.clearCache(DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    const st = _statusMergeReadStatuses_();
    const v = _statusMergeValidate_(st, targetId, sourceIds);
    return { success: true, analysis: _statusMergeCompute_(st, v).analysis };
  } catch (e) {
    return { success: false, error: _statusMergeErr_(e) };
  }
}

/**
 * Provede sloučení. Pokud se počty od potvrzené analýzy liší, nic nezapíše a vrátí novou analýzu.
 * @param {string} targetId
 * @param {string[]} sourceIds
 * @param {string} expectedFingerprint - Otisk z potvrzené analýzy.
 * @param {boolean} acknowledgeWarnings - Uživatel výslovně potvrdil zobrazená varování.
 * @returns {Object} { success, mismatch?, analysis?, result?, merge_id?, error? }
 */
function statusMergeExecute(targetId, sourceIds, expectedFingerprint, acknowledgeWarnings) {
  const state = { startedAt: Date.now(), mergeId: '', step: '', logged: false };
  let user = null;
  let backupId = '';
  try {
    user = _statusMergeRequireSuperadmin_();

    // 1. Předběžná kontrola mimo zámek (levná, ať se zbytečně nezálohuje)
    DB.clearCache(DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    let st = _statusMergeReadStatuses_();
    let v = _statusMergeValidate_(st, targetId, sourceIds);
    let computed = _statusMergeCompute_(st, v);
    if (!expectedFingerprint || computed.analysis.fingerprint !== String(expectedFingerprint)) {
      return { success: false, mismatch: true, error: "Data se od analýzy změnila. Zkontrolujte novou analýzu.", analysis: computed.analysis };
    }
    if (computed.analysis.blockers.length > 0) {
      return { success: false, error: computed.analysis.blockers.join(' '), analysis: computed.analysis };
    }
    if (computed.analysis.warnings.length > 0 && acknowledgeWarnings !== true) {
      return { success: false, error: "Se zobrazenými varováními lze sloučení spustit jen po jejich výslovném potvrzení." };
    }

    // 2. Záloha před zámkem, ať neblokuje ukládání. Když selže, nezapíše se nic.
    try {
      backupId = Backup.createStatusMergeBackup();
    } catch (backupErr) {
      console.error("StatusMerge: záloha selhala: " + backupErr.toString());
      return { success: false, error: "Záloha databáze selhala, sloučení nebylo provedeno: " + _statusMergeErr_(backupErr) };
    }

    // 3. Přepočet a zápis pod zámkem po čerstvém čtení
    const outcome = _withScriptLock_(function() {
      DB.clearCache();
      st = _statusMergeReadStatuses_();
      v = _statusMergeValidate_(st, targetId, sourceIds);
      computed = _statusMergeCompute_(st, v);
      if (computed.analysis.fingerprint !== String(expectedFingerprint)) {
        return { mismatch: true, analysis: computed.analysis };
      }
      if (computed.analysis.blockers.length > 0) {
        return { blocked: true, analysis: computed.analysis };
      }
      // Záloha mohla trvat dlouho; do zápisu se vstoupí jen s dostatečnou rezervou vůči limitu běhu
      if (Date.now() - state.startedAt > STATUS_MERGE_START_LIMIT_MS) {
        return { tooSlow: true };
      }
      return { result: _statusMergeApply_(st, v, computed, backupId, state) };
    }, 30000);

    // Nic se nezapsalo → záloha je zbytečná
    if (outcome.mismatch || outcome.blocked || outcome.tooSlow) _statusMergeDiscardBackup_(backupId);
    if (outcome.mismatch) {
      return { success: false, mismatch: true, error: "Data se od analýzy změnila. Zkontrolujte novou analýzu.", analysis: outcome.analysis };
    }
    if (outcome.blocked) {
      return { success: false, error: outcome.analysis.blockers.join(' '), analysis: outcome.analysis };
    }
    if (outcome.tooSlow) {
      return { success: false, error: "Příprava (záloha) trvala příliš dlouho, nic nebylo zapsáno. Spusťte sloučení znovu." };
    }
    const result = outcome.result;
    _auditLog_("STATUS_MERGE", {
      merge_id: result.merge_id,
      target_status_id: result.target_id,
      source_status_ids: result.source_ids,
      expected: result.expected,
      converted: result.converted,
      remaining: result.remaining,
      pending_converted: result.pending_converted,
      reservations_cleared: result.reservations_cleared,
      notifications_updated: result.notifications_updated,
      warnings_count: result.warnings.length,
      failed_steps: result.failed_steps,
      completed: result.remaining === 0 && result.warnings.length === 0
    }, user);
    if (result.remaining !== 0) {
      return { success: false, merge_id: result.merge_id, error: "Převod není úplný: zbývá " + result.remaining + " záznamů. Zdrojové statusy zůstaly aktivní. V seznamu Proběhlá sloučení použijte Vrátit a sloučení pak zopakujte.", result: result };
    }
    return { success: true, result: result };
  } catch (e) {
    console.error("statusMergeExecute (krok " + state.step + "): " + e.toString());
    const msg = _statusMergeErr_(e);
    if (!state.logged) _statusMergeDiscardBackup_(backupId);
    if (state.mergeId) {
      try {
        _auditLog_("STATUS_MERGE_FAILED", { merge_id: state.mergeId, step: state.step, logged: state.logged, error: msg.substring(0, 200) }, user || undefined);
      } catch (auditErr) { /* audit nesmí zakrýt původní chybu */ }
    }
    if (state.logged) {
      return {
        success: false, merge_id: state.mergeId,
        error: "Sloučení selhalo během kroku „" + state.step + "“ (" + msg + "). Část dat už může být převedená, zdrojové statusy zůstaly aktivní. V seznamu Proběhlá sloučení použijte Vrátit a sloučení pak zopakujte."
      };
    }
    return { success: false, error: msg };
  }
}

/**
 * Vrátí sloučení (do 30 dní od provedení). Návrat je idempotentní, lze ho použít i po selhání uprostřed sloučení.
 * @param {string} mergeId
 * @returns {Object} { success, restored, skipped, pendingRestored, reservationsNote } | { success: false, error }
 */
function statusMergeRollback(mergeId) {
  try {
    const user = _statusMergeRequireSuperadmin_();
    mergeId = String(mergeId || "").trim();
    if (!mergeId) throw new Error("Chybí identifikátor sloučení.");
    const result = _withScriptLock_(function() {
      DB.clearCache();
      return _statusMergeRollbackLocked_(mergeId);
    }, 30000);
    _auditLog_("STATUS_MERGE_ROLLBACK", {
      merge_id: mergeId,
      restored: result.restored,
      skipped: result.skipped,
      pending_restored: result.pendingRestored
    }, user);
    return {
      success: true, restored: result.restored, skipped: result.skipped, pendingRestored: result.pendingRestored,
      reservationsNote: "Zrušené rezervace stolů se nevracejí." +
        (result.pendingRestored > 0 ? " U " + result.pendingRestored + " záznamů se vrátil stav „čeká na schválení“, ale žádost schvalovateli se znovu nevytváří." : "")
    };
  } catch (e) {
    console.error("statusMergeRollback: " + e.toString());
    try {
      _auditLog_("STATUS_MERGE_ROLLBACK_FAILED", { merge_id: String(mergeId || "").substring(0, 64), error: _statusMergeErr_(e).substring(0, 200) });
    } catch (auditErr) { /* audit nesmí zakrýt původní chybu */ }
    return { success: false, error: _statusMergeErr_(e) };
  }
}

/**
 * Seznam sloučení, která lze ještě vrátit, a ID statusů chráněných proti smazání.
 * @returns {{success: boolean, merges?: Object[], protectedStatusIds?: string[]}}
 */
function statusMergeList() {
  try {
    _statusMergeRequireSuperadmin_();
    DB.clearCache(DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    const st = _statusMergeReadStatuses_();
    const log = _statusMergeReadLog_();
    const byMerge = {};
    const order = [];
    log.rows.forEach(function(r) {
      let m = byMerge[r.mergeId];
      if (!m) {
        m = byMerge[r.mergeId] = { merge_id: r.mergeId, merged_at: r.mergedAtIso, target_id: r.newStatusId, source_ids: [], moved: 0, rolled_back: true, markers: [], _ms: r.mergedAtMs };
        order.push(r.mergeId);
      }
      if (!r.rolledBack) m.rolled_back = false;
      if (!r.attendanceId) {
        if (m.source_ids.indexOf(r.oldStatusId) === -1) m.source_ids.push(r.oldStatusId);
        m.markers.push(r);
      } else {
        m.moved++;
      }
    });
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const nameOf = function(id) { return st.byId[id] ? (st.byId[id].name || id) : "(smazaný status)"; };
    const merges = order.map(function(id) {
      const m = byMerge[id];
      const ageDays = (now - m._ms) / DAY;
      // Nedokončené sloučení: některý zdroj nebyl přepnut na cílový status
      const incomplete = !m.rolled_back && m.source_ids.some(function(sid) {
        return !st.byId[sid] || _smNorm_(st.byId[sid].merged_into) !== _smNorm_(m.target_id);
      });
      // Dokončeno s chybou: zdroje jsou přepnuté, ale některý navazující krok neproběhl (chybí completed_at)
      const withError = !m.rolled_back && !incomplete && m.markers.some(function(x) { return x.completedAt === ''; });
      return {
        merge_id: m.merge_id,
        merged_at: m.merged_at,
        target_id: m.target_id,
        target_name: nameOf(m.target_id),
        source_ids: m.source_ids,
        source_names: m.source_ids.map(nameOf),
        moved: m.moved,
        incomplete: incomplete,
        with_error: withError,
        rolled_back: m.rolled_back,
        days_left: Math.max(0, Math.ceil(STATUS_MERGE_RETENTION_DAYS - ageDays)),
        can_rollback: !m.rolled_back && ageDays <= STATUS_MERGE_RETENTION_DAYS
      };
    }).sort(function(a, b) { return a.merged_at < b.merged_at ? 1 : -1; });
    const period = _statusMergeReadPeriod_(log);
    const prot = {};
    Object.keys(period.sources).concat(Object.keys(period.targets)).forEach(function(id) { prot[id] = true; });
    return { success: true, merges: merges, protectedStatusIds: Object.keys(prot) };
  } catch (e) {
    return { success: false, error: _statusMergeErr_(e) };
  }
}

/**
 * Přegeneruje kalendářové události od dneška dál pro řádky daného sloučení.
 * Běží po dávkách s časovým limitem jednoho volání; klient volá ve smyčce s vráceným offsetem.
 * Lze spustit znovu od začátku (offset 0) – události se jen aktualizují. Chyby jednotlivých událostí
 * se počítají (failed), dávka kvůli nim nekončí.
 * @param {string} mergeId
 * @param {number} offset - Index první nezpracované položky.
 * @returns {{success: boolean, processed?: number, nextOffset?: number, total?: number, done?: boolean, failed?: number}}
 */
function statusMergeResyncCalendars(mergeId, offset) {
  const startedAt = Date.now();
  try {
    _statusMergeRequireSuperadmin_();
    mergeId = String(mergeId || "").trim();
    if (!mergeId) throw new Error("Chybí identifikátor sloučení.");
    if (typeof CalendarSync === 'undefined') throw new Error("CalendarSync není dostupný.");
    offset = Math.max(0, parseInt(offset, 10) || 0);

    DB.clearCache(DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    DB.clearCache(DB_SHEETS.CORE.USERS);
    const log = _statusMergeReadLog_();
    // Značky zdrojových statusů (prázdné attendance_id) se počítají jako nalezené sloučení i bez záznamů
    const mine = log.rows.filter(function(r) { return r.mergeId === mergeId; });
    if (mine.length === 0) throw new Error("Sloučení nebylo nalezeno (záznam změn mohl být smazán retencí).");
    const aidSet = {};
    mine.forEach(function(r) { if (r.attendanceId) aidSet[r.attendanceId] = true; });

    const trans = DB.getTransaction();
    const att = _statusMergeReadAttendance_(trans);
    const today = Utilities.formatDate(new Date(), trans.getSpreadsheetTimeZone(), "yyyy-MM-dd");
    const items = [];
    att.data.forEach(function(r, i) {
      if (i === 0) return;
      const aid = String(r[att.idx.aid]);
      if (!aidSet[aid]) return;
      if (String(r[att.idx.appr]).toLowerCase() === APPROVAL_STATUS.REJECTED) return;
      const datePfx = _toPfx(r[att.idx.date], trans);
      if (datePfx < today) return;
      items.push({ aid: aid, user_id: String(r[att.idx.uid]), date: datePfx, slot: String(r[att.idx.slot] || 'ALL_DAY'), status_id: _smNorm_(r[att.idx.stat]) });
    });
    // Stabilní pořadí kvůli offsetu mezi dávkami (nezávislé na pořadí řádků v listu)
    items.sort(function(a, b) { return a.aid < b.aid ? -1 : (a.aid > b.aid ? 1 : 0); });

    const core = DB.getCore();
    const statusMap = {};
    DB.getTable(core, DB_SHEETS.CORE.ATTENDANCE_STATUSES).forEach(function(s) { statusMap[_smNorm_(s.status_id)] = s; });
    const userMap = {};
    DB.getTable(core, DB_SHEETS.CORE.USERS).forEach(function(u) { userMap[u.user_id] = u; });

    let i = offset;
    let failed = 0;
    for (; i < items.length; i++) {
      if (Date.now() - startedAt > STATUS_MERGE_RESYNC_LIMIT_MS) break;
      const it = items[i];
      const s = statusMap[it.status_id];
      if (!s) continue;
      const u = userMap[it.user_id];
      const name = u ? ((u.first_name || '') + ' ' + (u.last_name || '')).trim() : it.user_id;
      try {
        CalendarSync.syncPersonalEvent(it.user_id, it.date, it.slot, s.name, true);
        if (CalendarSync._isTeamSyncStatus(s)) {
          CalendarSync.syncTeamEvent(it.user_id, it.date, it.slot, s, name, true);
        } else {
          // syncTeamEvent u statusu mimo týmový kalendář nic nedělá, starou událost je nutné odstranit
          CalendarSync.deleteTeamEvent(it.user_id, it.date, it.slot, true);
        }
      } catch (calErr) {
        failed++;
        console.error("statusMergeResyncCalendars: událost se nepodařilo upravit: " + calErr.toString());
      }
    }
    return { success: true, processed: i - offset, nextOffset: i, total: items.length, done: i >= items.length, failed: failed };
  } catch (e) {
    console.error("statusMergeResyncCalendars: " + e.toString());
    return { success: false, error: _statusMergeErr_(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ochrana proti smazání statusu (volá Admin.deleteAttendanceStatus pod ScriptLockem)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vyhodí chybu, pokud na status odkazují záznamy v ATTENDANCE nebo je zdrojem či cílem sloučení,
 * které je ještě v návratovém období.
 * @param {string} statusId
 */
function _statusMergeAssertDeletable_(statusId) {
  const id = _smNorm_(statusId);
  const period = _statusMergeReadPeriod_(_statusMergeReadLog_());
  if (period.sources[id]) {
    throw new Error("Status byl nedávno sloučen do jiného. Smazat ho lze až po uplynutí návratového období (" + STATUS_MERGE_RETENTION_DAYS + " dní).");
  }
  if (period.targets[id]) {
    throw new Error("Status je cílem nedávného sloučení. Smazat ho lze až po uplynutí návratového období (" + STATUS_MERGE_RETENTION_DAYS + " dní).");
  }
  // Na status nesmí odkazovat něčí merged_into (jinak by se starým tabům překládalo na smazaný status)
  DB.clearCache(DB_SHEETS.CORE.ATTENDANCE_STATUSES);
  _statusMergeReadStatuses_().list.forEach(function(s) {
    if (_smNorm_(s.merged_into) === id) {
      throw new Error("Na status odkazuje sloučený status (merged_into). Smazat ho nelze, dokud se sloučení nevrátí.");
    }
  });
  const sheet = DB.getTransaction().getSheetByName(DB_SHEETS.TRANSACTION.ATTENDANCE);
  if (!sheet || sheet.getLastRow() < 2) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const statCol = headers.indexOf('status_id') + 1;
  if (statCol === 0) throw new Error("ATTENDANCE nemá sloupec status_id, mazání bylo zastaveno.");
  const values = sheet.getRange(2, statCol, sheet.getLastRow() - 1, 1).getValues();
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (_smNorm_(values[i][0]) === id) count++;
  }
  if (count > 0) {
    throw new Error("Status nelze smazat, odkazuje na něj " + count + " záznamů docházky. Nejdřív je převeďte jiným statusem (např. sloučením).");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Interní pomocné funkce
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vyhodí do koše zbytečnou zálohu (sloučení se nespustilo, nic se nezapsalo).
 */
function _statusMergeDiscardBackup_(backupId) {
  if (!backupId) return;
  try {
    DriveApp.getFileById(backupId).setTrashed(true);
  } catch (e) {
    console.warn("StatusMerge: nepoužitou zálohu se nepodařilo odstranit: " + e.toString());
  }
}

function _statusMergeRequireSuperadmin_() {
  const user = Auth.getCurrentUser();
  if (!user || user.system_role !== ROLES.SYSTEM.SUPERADMIN) {
    throw new Error("Tuto akci může provést jen SUPERADMIN.");
  }
  return user;
}

function _statusMergeErr_(e) {
  return String(e && e.message ? e.message : e);
}

function _smBool_(v) {
  return String(v).toLowerCase() === 'true';
}

// Aktivní je vše kromě výslovného 'false' (stejně jako zbytek aplikace); prázdná hodnota = aktivní
function _smActive_(s) {
  return String(s.active).toLowerCase() !== 'false';
}

function _smNorm_(v) {
  return Privacy.normalizeStatusId(v);
}

function _smIsMask_(s) {
  return String(s.status_kind || 'NORMAL').toUpperCase() === 'MASK';
}

/**
 * Vyhodí chybu, pokud došel čas na další krok zápisu (limit běhu skriptu je 6 minut).
 */
function _statusMergeCheckTime_(state) {
  if (Date.now() - state.startedAt > STATUS_MERGE_STEP_LIMIT_MS) {
    throw new Error("Překročen časový limit běhu");
  }
}

/**
 * Načte statusy přímo z listu (čerstvě, s čísly řádků).
 */
function _statusMergeReadStatuses_() {
  const sheet = DB.getCore().getSheetByName(DB_SHEETS.CORE.ATTENDANCE_STATUSES);
  if (!sheet || sheet.getLastRow() < 2) throw new Error("List ATTENDANCE_STATUSES nenalezen nebo je prázdný.");
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(function(h) { return String(h || '').trim(); });
  const list = [];
  const byId = {};
  for (let i = 1; i < data.length; i++) {
    const obj = { _row: i + 1 };
    headers.forEach(function(h, c) {
      obj[h] = (data[i][c] !== null && data[i][c] !== undefined) ? String(data[i][c]) : '';
    });
    list.push(obj);
    byId[_smNorm_(obj.status_id)] = obj;
  }
  return { sheet: sheet, headers: headers, list: list, byId: byId };
}

/**
 * Vrátí číslo sloupce (1-based); když chybí, přidá ho do hlavičky.
 */
function _statusMergeEnsureColumn_(sheet, headers, name) {
  let idx = headers.indexOf(name);
  if (idx === -1) {
    sheet.getRange(1, headers.length + 1).setValue(name).setFontWeight('bold');
    headers.push(name);
    idx = headers.length - 1;
  }
  return idx + 1;
}

/**
 * Načte list STATUS_MERGE_LOG; když neexistuje, vrátí prázdný výsledek.
 */
function _statusMergeReadLog_() {
  const sheet = DB.getSystem().getSheetByName(DB_SHEETS.SYSTEM.STATUS_MERGE_LOG);
  const out = { sheet: sheet, headers: [], rows: [] };
  if (!sheet || sheet.getLastRow() < 2) return out;
  const data = sheet.getDataRange().getValues();
  const h = data[0].map(function(x) { return String(x || '').trim(); });
  out.headers = h;
  const ix = function(n) { return h.indexOf(n); };
  const mid = ix('merge_id'), aid = ix('attendance_id'), oldS = ix('old_status_id'), newS = ix('new_status_id');
  const oldA = ix('old_approved'), mAt = ix('merged_at'), rb = ix('rolled_back_at'), newA = ix('new_approved');
  const oAct = ix('old_active'), cmp = ix('completed_at');
  const cell = function(r, c) { return (c === -1 || r[c] === undefined || r[c] === null) ? '' : String(r[c]); };
  if (mid === -1 || aid === -1 || oldS === -1 || newS === -1 || mAt === -1) return out;
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const at = r[mAt];
    const ms = (at instanceof Date) ? at.getTime() : Date.parse(String(at || ''));
    out.rows.push({
      row: i + 1,
      mergeId: String(r[mid]),
      attendanceId: String(r[aid] || ''),
      oldStatusId: _smNorm_(r[oldS]),
      newStatusId: _smNorm_(r[newS]),
      oldApproved: oldA === -1 ? '' : String(r[oldA]),
      newApproved: cell(r, newA),
      mergedAtMs: ms,
      mergedAtIso: (at instanceof Date) ? at.toISOString() : String(at || ''),
      oldActive: cell(r, oAct),
      completedAt: cell(r, cmp),
      rolledBack: rb !== -1 && String(r[rb] || '') !== ''
    });
  }
  return out;
}

/**
 * Zdroje a cíle sloučení, která jsou ještě v návratovém období a nebyla vrácena.
 */
function _statusMergeReadPeriod_(log) {
  const now = Date.now();
  const limit = STATUS_MERGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const period = { sources: {}, targets: {} };
  log.rows.forEach(function(r) {
    if (r.rolledBack || !(now - r.mergedAtMs <= limit)) return;
    if (r.oldStatusId) period.sources[r.oldStatusId] = true;
    if (r.newStatusId) period.targets[r.newStatusId] = true;
  });
  return period;
}

/**
 * Založí list STATUS_MERGE_LOG při prvním použití, doplní chybějící sloupce a vrátí ho.
 */
function _statusMergeEnsureLogSheet_() {
  const sys = DB.getSystem();
  let sheet = sys.getSheetByName(DB_SHEETS.SYSTEM.STATUS_MERGE_LOG);
  if (!sheet) sheet = sys.insertSheet(DB_SHEETS.SYSTEM.STATUS_MERGE_LOG);
  if (sheet.getLastRow() === 0) Setup.setHeaders(sheet, DB_SHEETS.SYSTEM.STATUS_MERGE_LOG);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) { return String(h || '').trim(); });
  ['merge_id', 'attendance_id', 'old_status_id', 'new_status_id', 'old_approved', 'merged_at', 'rolled_back_at', 'new_approved', 'old_active', 'completed_at'].forEach(function(c) {
    _statusMergeEnsureColumn_(sheet, headers, c);
  });
  return sheet;
}

/**
 * Ověří výběr cíle a zdrojů (kritérium 2).
 */
function _statusMergeValidate_(st, targetId, sourceIds) {
  targetId = _smNorm_(targetId);
  if (!targetId) throw new Error("Vyberte cílový status.");
  const ids = [];
  (Array.isArray(sourceIds) ? sourceIds : []).forEach(function(raw) {
    const id = _smNorm_(raw);
    if (id && ids.indexOf(id) === -1) ids.push(id);
  });
  if (ids.length === 0) throw new Error("Vyberte alespoň jeden zdrojový status.");

  const target = st.byId[targetId];
  if (!target) throw new Error("Cílový status neexistuje.");
  const tName = target.name || targetId;
  if (_smIsMask_(target)) throw new Error("Cílem nemůže být maskovací status („" + tName + "“).");
  if (!_smActive_(target)) throw new Error("Cílový status „" + tName + "“ je neaktivní.");
  if (target.merged_into) throw new Error("Cílový status „" + tName + "“ je sám sloučený do jiného.");
  if (ids.indexOf(targetId) !== -1) throw new Error("Cílový status nemůže být zároveň zdrojem.");

  const period = _statusMergeReadPeriod_(_statusMergeReadLog_());
  if (period.sources[targetId]) throw new Error("Cílový status „" + tName + "“ je zdrojem sloučení v návratovém období. Nejdřív ho vraťte nebo počkejte na uplynutí návratového období.");
  const sources = ids.map(function(id) {
    const s = st.byId[id];
    if (!s) throw new Error("Zdrojový status neexistuje.");
    const label = s.name || id;
    if (s.merged_into) throw new Error("Status „" + label + "“ už je sloučený.");
    if (_smIsMask_(s)) throw new Error("Maskovací status („" + label + "“) nelze sloučit.");
    // Neaktivní zdroj je v pořádku (může mít staré záznamy), podmínkou je jen neoznačený merged_into
    // Sloučené zdroje jsou odmítnuty výše, sem se dostane jen zdroj nedokončeného (nevráceného) sloučení
    if (period.sources[id]) throw new Error("Pro status „" + label + "“ existuje nevrácené nedokončené sloučení. Nejdřív ho vraťte (Vrátit v seznamu Proběhlá sloučení).");
    if (period.targets[id]) throw new Error("Status „" + label + "“ je cílem sloučení v návratovém období. Nejdřív sloučení vraťte nebo počkejte na uplynutí návratového období.");
    return s;
  });
  return { target: target, sources: sources };
}

/**
 * Načte ATTENDANCE (hodnoty + indexy sloupců).
 */
function _statusMergeReadAttendance_(trans) {
  const sheet = trans.getSheetByName(DB_SHEETS.TRANSACTION.ATTENDANCE);
  if (!sheet) throw new Error("ATTENDANCE sheet nenalezen.");
  const data = sheet.getLastRow() > 0 ? sheet.getDataRange().getValues() : [[]];
  const headers = (data[0] || []).map(function(h) { return String(h || '').trim(); });
  const idx = {
    aid: headers.indexOf('attendance_id'), uid: headers.indexOf('user_id'), date: headers.indexOf('date'),
    slot: headers.indexOf('slot'), stat: headers.indexOf('status_id'), appr: headers.indexOf('approved')
  };
  Object.keys(idx).forEach(function(k) {
    if (idx[k] === -1) throw new Error("ATTENDANCE nemá očekávané hlavičky. Sloučení bylo zastaveno.");
  });
  return { sheet: sheet, data: data, headers: headers, idx: idx };
}

/**
 * Aktivní rezervace stolů (CORE, případně TRANSACTION) jako seznam klíčů uživatel_datum s čísly řádků.
 */
function _statusMergeReadReservations_() {
  const core = DB.getCore();
  let ss = core;
  let sheet = core.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
  if (!sheet) {
    ss = DB.getTransaction();
    sheet = ss.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
  }
  const list = [];
  if (!sheet || sheet.getLastRow() < 2) return list;
  const data = sheet.getDataRange().getValues();
  const h = data[0];
  const uidIdx = h.indexOf('user_id'), dateIdx = h.indexOf('date'), actIdx = h.indexOf('active');
  if (uidIdx === -1 || dateIdx === -1 || actIdx === -1) return list;
  for (let i = 1; i < data.length; i++) {
    const act = String(data[i][actIdx]).toUpperCase();
    if (act !== 'TRUE' && act !== '1') continue;
    list.push(String(data[i][uidIdx]).trim() + '_' + _toPfx(data[i][dateIdx], ss));
  }
  return list;
}

/**
 * Projde čekající žádosti o schválení v notifikacích a připraví jejich úpravu.
 * Pending + cíl vyžaduje schválení → přepíše status_id; pending + cíl nevyžaduje → položku odebere
 * (žádost bez položek se označí za přečtenou).
 */
function _statusMergeNotifScan_(sourceSet, target) {
  const out = { counts: {}, changes: [], sheet: null, msgCol: 0, readCol: 0 };
  const sheet = DB.getSystem().getSheetByName(DB_SHEETS.SYSTEM.NOTIFICATIONS);
  if (!sheet || sheet.getLastRow() < 2) return out;
  const data = sheet.getDataRange().getValues();
  const h = data[0];
  const typeIdx = h.indexOf('type'), rdIdx = h.indexOf('read'), msgIdx = h.indexOf('message');
  if (typeIdx === -1 || rdIdx === -1 || msgIdx === -1) return out;
  out.sheet = sheet;
  out.msgCol = msgIdx + 1;
  out.readCol = rdIdx + 1;
  const keepPending = _smBool_(target.requires_approval);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][typeIdx]) !== NOTIFICATION_TYPES.VACATION_APPROVAL_REQUEST) continue;
    if (_smBool_(data[i][rdIdx])) continue;
    let payload;
    try { payload = JSON.parse(data[i][msgIdx]); } catch (pe) { continue; }
    if (!payload || !Array.isArray(payload.entries)) continue;
    let hits = 0;
    const kept = [];
    payload.entries.forEach(function(en) {
      const sid = _smNorm_(en && en.status_id);
      if (!sourceSet[sid]) { kept.push(en); return; }
      hits++;
      out.counts[sid] = (out.counts[sid] || 0) + 1;
      if (keepPending) {
        en.status_id = target.status_id;
        kept.push(en);
      }
    });
    if (hits === 0) continue;
    payload.entries = kept;
    out.changes.push({ row: i + 1, message: JSON.stringify(payload), markRead: kept.length === 0 });
  }
  return out;
}

/**
 * Spočítá analýzu a podklady pro zápis. Nic nezapisuje.
 */
function _statusMergeCompute_(st, v) {
  const trans = DB.getTransaction();
  const att = _statusMergeReadAttendance_(trans);
  const target = v.target;
  const targetId = _smNorm_(target.status_id);
  const sourceSet = {};
  const per = {};
  v.sources.forEach(function(s) {
    const id = _smNorm_(s.status_id);
    sourceSet[id] = true;
    per[id] = { status_id: s.status_id, name: s.name || '', total: 0, future: 0, pending: 0, rejected: 0, reservations: 0, notifications: 0 };
  });
  const deskIds = {};
  st.list.forEach(function(s) { if (_smBool_(s.allows_desk_reservation)) deskIds[_smNorm_(s.status_id)] = true; });
  const targetDesk = _smBool_(target.allows_desk_reservation);
  const targetRequires = _smBool_(target.requires_approval);
  const today = Utilities.formatDate(new Date(), trans.getSpreadsheetTimeZone(), "yyyy-MM-dd");

  const moved = [];
  const movedKeys = {};
  const hasDeskKeys = {};
  let noId = 0;
  let dupId = 0;
  const seenAid = {};
  const I = att.idx;
  for (let i = 1; i < att.data.length; i++) {
    const r = att.data[i];
    const sid = _smNorm_(r[I.stat]);
    const isSrc = sourceSet[sid] === true;
    if (!isSrc && !deskIds[sid]) continue;
    const datePfx = _toPfx(r[I.date], trans);
    const key = String(r[I.uid]).trim() + '_' + datePfx;
    if (!isSrc) { hasDeskKeys[key] = true; continue; }
    const appr = String(r[I.appr]).toLowerCase();
    const p = per[sid];
    p.total++;
    if (datePfx >= today) p.future++;
    if (appr === APPROVAL_STATUS.PENDING) p.pending++;
    if (appr === APPROVAL_STATUS.REJECTED) p.rejected++;
    if (String(r[I.aid]) === '') noId++;
    else if (seenAid[String(r[I.aid])]) dupId++;
    seenAid[String(r[I.aid])] = true;
    moved.push({ row: i + 1, aid: String(r[I.aid]), oldStatus: sid, oldApproved: String(r[I.appr]), pending: appr === APPROVAL_STATUS.PENDING });
    if (!movedKeys[key]) movedKeys[key] = { userId: String(r[I.uid]).trim(), date: datePfx, srcs: {} };
    movedKeys[key].srcs[sid] = true;
  }

  // Dny od dneška dál, které po převodu nemají status s nárokem na stůl → jejich rezervace se zruší (minulost se nemění)
  const pairs = [];
  const pairKeys = {};
  if (!targetDesk) {
    Object.keys(movedKeys).forEach(function(k) {
      if (hasDeskKeys[k] || movedKeys[k].date < today) return;
      pairs.push({ userId: movedKeys[k].userId, date: movedKeys[k].date });
      pairKeys[k] = movedKeys[k];
    });
  }
  let reservationsTotal = 0;
  if (pairs.length > 0) {
    _statusMergeReadReservations_().forEach(function(k) {
      if (!pairKeys[k]) return;
      reservationsTotal++;
      Object.keys(pairKeys[k].srcs).forEach(function(sid) { per[sid].reservations++; });
    });
  }

  const notif = _statusMergeNotifScan_(sourceSet, target);
  Object.keys(notif.counts).forEach(function(sid) { per[sid].notifications = notif.counts[sid]; });

  // Varování o rozdílech vlastností
  const warnings = [];
  const yn = function(b) { return b ? 'ano' : 'ne'; };
  const maskName = function(id) { const s = st.byId[_smNorm_(id)]; return s ? (s.name || id) : (id ? id : '–'); };
  const retention = function(s) { return s.retention_category || (_smBool_(s.is_vacation) ? 'YEAR_END' : 'SHORT_TERM'); };
  const checks = [
    { label: 'Dovolená (čerpání dovolené)', get: function(s) { return yn(_smBool_(s.is_vacation)); } },
    { label: 'Doba uchování dat (retence)', get: retention },
    { label: 'Vyžaduje schválení', get: function(s) { return yn(_smBool_(s.requires_approval)); } },
    { label: 'Nárok na rezervaci stolu', get: function(s) { return yn(_smBool_(s.allows_desk_reservation)); } },
    { label: 'Kategorie', get: function(s) { return s.category || '–'; } },
    { label: 'Zobrazuje čas příchodu', get: function(s) { return yn(_smBool_(s.shows_work_time)); } },
    { label: 'Povoluje poznámku', get: function(s) { return yn(_smBool_(s.allows_note)); } },
    { label: 'Týmový kalendář', get: function(s) { return yn(CalendarSync._isTeamSyncStatus(s)); } }
  ];
  // Maskování se sloučením nemění (masked_status_id se nepřepisuje); rozdíl je důležitý jen při zapnutém maskování
  if (Privacy.isMaskingEnabled()) {
    checks.push({ label: 'Maskování (GDPR)', get: function(s) { return maskName(s.masked_status_id); } });
  }
  v.sources.forEach(function(s) {
    checks.forEach(function(c) {
      const a = String(c.get(s));
      const b = String(c.get(target));
      if (a !== b) warnings.push((s.name || s.status_id) + ': ' + c.label + ' (' + a + ' → ' + b + ')');
    });
  });

  const ids = Object.keys(per).sort();
  const sources = ids.map(function(id) { return per[id]; });
  const totals = { total: 0, future: 0, pending: 0, rejected: 0, reservations: reservationsTotal, notifications: 0, no_id: noId, dup_id: dupId };
  sources.forEach(function(p) {
    totals.total += p.total; totals.future += p.future; totals.pending += p.pending; totals.rejected += p.rejected;
    totals.notifications += p.notifications;
  });

  // Překážky: sloučení se s nimi nesmí spustit
  const blockers = [];
  if (noId > 0) {
    blockers.push(noId + " záznamů docházky se zdrojovým statusem nemá vyplněné attendance_id, sloučení by kolidovalo se značkami záznamu změn. Záznamy je nutné nejdřív opravit.");
  }
  if (dupId > 0) {
    blockers.push(dupId + " záznamů docházky se zdrojovým statusem má duplicitní attendance_id, návrat by je nedokázal bezpečně přiřadit. Záznamy je nutné nejdřív opravit.");
  }
  if (totals.pending > 0 && targetRequires && !_isVacationStatusId(target.status_id, st.byId)) {
    blockers.push("Cílový status vyžaduje schválení, ale není dovolená, takže " + totals.pending + " čekajících žádostí by nešlo schválit. Zvolte jiný cíl, nebo žádosti nejdřív vyřešte.");
  }

  // Otisk zahrnuje počty i varování, aby změna vlastností statusů po analýze zneplatnila potvrzení
  const fingerprint = targetId + '>' + ids.map(function(id) {
    const p = per[id];
    return [id, p.total, p.future, p.pending, p.rejected, p.reservations, p.notifications].join(':');
  }).join('|') + '#' + warnings.join('|') + '#' + noId + '/' + dupId;

  return {
    analysis: {
      target: { status_id: target.status_id, name: target.name || '', requires_approval: targetRequires },
      sources: sources,
      totals: totals,
      warnings: warnings,
      blockers: blockers,
      fingerprint: fingerprint
    },
    plan: { att: att, moved: moved, pairs: pairs, notif: notif }
  };
}

/**
 * Zapíše stejnou hodnotu do sloupce po dávkách (RangeList má praktický limit počtu buněk).
 */
function _statusMergeSetCells_(sheet, rows, col, value) {
  for (let i = 0; i < rows.length; i += STATUS_MERGE_CHUNK) {
    _setCellsValue_(sheet, rows.slice(i, i + STATUS_MERGE_CHUNK), col, value);
  }
}

/**
 * Změní hodnoty vybraných řádků jednoho sloupce jedním čtením a jedním setValues celého sloupce.
 * Nezměněné buňky se zapisují zpět v původním typu (boolean zůstane boolean). Před zápisem se ověří
 * aktuální hodnoty; když nesedí, nezapíše se nic.
 * @param {Sheet} sheet
 * @param {number} col - 1-based.
 * @param {Object} updates - { čísloŘádku: novéHodnoty }
 * @param {Function} [isAllowed] - (aktuálníHodnota) => boolean
 */
function _statusMergeWriteColumn_(sheet, col, updates, isAllowed) {
  const rows = Object.keys(updates);
  if (rows.length === 0) return;
  const last = sheet.getLastRow();
  if (last < 2) throw new Error("List je prázdný, zápis byl zastaven.");
  const range = sheet.getRange(2, col, last - 1, 1);
  const vals = range.getValues();
  rows.forEach(function(r) {
    const i = Number(r) - 2;
    if (i < 0 || i >= vals.length) throw new Error("Řádek " + r + " je mimo rozsah listu, zápis byl zastaven.");
    if (isAllowed && !isAllowed(vals[i][0])) throw new Error("Data se během zápisu změnila (řádek " + r + "), zápis byl zastaven.");
    vals[i][0] = updates[r];
  });
  range.setValues(vals);
}

/**
 * Vlastní zápis sloučení. Volat pouze pod ScriptLockem a po čerstvém přepočtu.
 * Pořadí: příprava sloupců → záznam změn → status_id → approved → kontrola → deaktivace zdrojů →
 * (každý ve vlastním try/catch) rezervace, notifikace → značka dokončení.
 * Zdroje se deaktivují hned po úspěšné kontrole, takže sloučení lze vrátit i při selhání dalších kroků.
 */
function _statusMergeApply_(st, v, computed, backupId, state) {
  const plan = computed.plan;
  const att = plan.att;
  const target = v.target;
  const targetId = target.status_id;
  const mergeId = Utilities.getUuid();
  state.mergeId = mergeId;
  const nowIso = new Date().toISOString();
  const sheet = att.sheet;
  const I = att.idx;
  const moved = plan.moved;
  const targetRequires = _smBool_(target.requires_approval);
  const sourceSet = {};
  v.sources.forEach(function(s) { sourceSet[_smNorm_(s.status_id)] = true; });

  // 0. Sloupce potřebné pro zápis se zajistí dřív, než se zapíše první data
  state.step = 'příprava';
  const logSheet = _statusMergeEnsureLogSheet_();
  const logHeaders = logSheet.getRange(1, 1, 1, logSheet.getLastColumn()).getValues()[0].map(function(h) { return String(h || '').trim(); });
  const stSheet = st.sheet;
  const activeCol = _statusMergeEnsureColumn_(stSheet, st.headers, 'active');
  const mergedCol = _statusMergeEnsureColumn_(stSheet, st.headers, 'merged_into');

  // 1. Záznam změn (jedním zápisem) + řádky-značky zdrojových statusů (attendance_id prázdné)
  state.step = 'záznam změn';
  const logRows = [];
  const mk = function(aid, oldId, oldAppr, newAppr) {
    const row = logHeaders.map(function() { return ''; });
    row[logHeaders.indexOf('merge_id')] = mergeId;
    row[logHeaders.indexOf('attendance_id')] = aid;
    row[logHeaders.indexOf('old_status_id')] = oldId;
    row[logHeaders.indexOf('new_status_id')] = targetId;
    row[logHeaders.indexOf('old_approved')] = oldAppr;
    row[logHeaders.indexOf('new_approved')] = newAppr;
    row[logHeaders.indexOf('merged_at')] = "'" + nowIso;
    return row;
  };
  // Značky si pamatují původní active, návrat ho obnoví (neaktivní zdroj zůstane neaktivní)
  const oldActiveIdx = logHeaders.indexOf('old_active');
  v.sources.forEach(function(s) {
    const marker = mk('', s.status_id, '', '');
    marker[oldActiveIdx] = _smActive_(s) ? 'true' : 'false';
    logRows.push(marker);
  });
  moved.forEach(function(m) {
    // Hodnota approved po převodu: čekající žádost u cíle bez schvalování se mění na NOT_REQUIRED
    const newAppr = (m.pending && !targetRequires) ? APPROVAL_STATUS.NOT_REQUIRED : m.oldApproved;
    logRows.push(mk(m.aid, m.oldStatus, m.oldApproved, newAppr));
  });
  const firstFree = logSheet.getLastRow() + 1;
  const lastNeeded = firstFree + logRows.length - 1;
  if (logSheet.getMaxRows() < lastNeeded) logSheet.insertRowsAfter(logSheet.getMaxRows(), lastNeeded - logSheet.getMaxRows());
  logSheet.getRange(firstFree, 1, logRows.length, logHeaders.length).setValues(logRows);
  // Záznam změn musí fyzicky existovat dřív, než se začne převádět docházka
  SpreadsheetApp.flush();
  state.logged = true;
  DB.clearCache(DB_SHEETS.SYSTEM.STATUS_MERGE_LOG);

  // 2. status_id (a approved u čekajících žádostí, pokud cíl schválení nevyžaduje) – po celém sloupci
  state.step = 'převod docházky';
  const statusUpdates = {};
  moved.forEach(function(m) { statusUpdates[m.row] = targetId; });
  _statusMergeWriteColumn_(sheet, I.stat + 1, statusUpdates, function(cur) { return sourceSet[_smNorm_(cur)] === true; });
  _statusMergeCheckTime_(state);
  const pendingRows = moved.filter(function(m) { return m.pending; }).map(function(m) { return m.row; });
  let pendingConverted = 0;
  if (!targetRequires && pendingRows.length > 0) {
    state.step = 'schválení';
    const apprUpdates = {};
    pendingRows.forEach(function(r) { apprUpdates[r] = APPROVAL_STATUS.NOT_REQUIRED; });
    _statusMergeWriteColumn_(sheet, I.appr + 1, apprUpdates, function(cur) { return String(cur).toLowerCase() === APPROVAL_STATUS.PENDING; });
    pendingConverted = pendingRows.length;
  }
  SpreadsheetApp.flush();
  DB.clearCache(DB_SHEETS.TRANSACTION.ATTENDANCE);
  _statusMergeCheckTime_(state);

  // 3. Kontrola výsledku z čerstvě načteného sloupce status_id
  state.step = 'kontrola';
  const lastRow = sheet.getLastRow();
  const statusCol = lastRow > 1 ? sheet.getRange(2, I.stat + 1, lastRow - 1, 1).getValues() : [];
  let remaining = 0;
  statusCol.forEach(function(r) { if (sourceSet[_smNorm_(r[0])]) remaining++; });
  let converted = 0;
  moved.forEach(function(m) {
    const cell = statusCol[m.row - 2];
    if (cell && _smNorm_(cell[0]) === _smNorm_(targetId)) converted++;
  });
  const result = {
    merge_id: mergeId, target_id: targetId, source_ids: v.sources.map(function(s) { return s.status_id; }),
    expected: moved.length, converted: converted, remaining: remaining,
    pending_converted: pendingConverted, reservations_cleared: 0, notifications_updated: 0,
    backup_id: backupId, warnings: [], failed_steps: []
  };
  // Při neúplném převodu zdroje zůstanou aktivní; sloučení se pak vrací (Vrátit)
  if (remaining !== 0) return result;

  // 4. Deaktivace zdrojů hned po kontrole (od teď je sloučení kompletní a vratné)
  state.step = 'deaktivace zdrojů';
  const srcRows = v.sources.map(function(s) { return s._row; });
  _statusMergeSetCells_(stSheet, srcRows, activeCol, 'false');
  _statusMergeSetCells_(stSheet, srcRows, mergedCol, targetId);
  SpreadsheetApp.flush();
  DB.clearCache(DB_SHEETS.CORE.ATTENDANCE_STATUSES);

  // 5. Navazující kroky; selhání jednoho nezastaví ostatní a vrací se jako varování
  const post = function(label, fn) {
    state.step = label;
    try {
      _statusMergeCheckTime_(state);
      fn();
    } catch (e) {
      console.error("StatusMerge: krok „" + label + "“ selhal: " + e.toString());
      result.failed_steps.push(label);
      result.warnings.push("Krok „" + label + "“ se nepodařilo dokončit (" + _statusMergeErr_(e) + "). Sloučení je neúplné: v seznamu Proběhlá sloučení použijte Vrátit a sloučení zopakujte.");
    }
  };

  // Rezervace stolů u dnů (od dneška dál) bez nároku na stůl, po dávkách
  post('rezervace stolů', function() {
    for (let i = 0; i < plan.pairs.length; i += STATUS_MERGE_CHUNK) {
      result.reservations_cleared += Admin.clearUserReservationsBatch(plan.pairs.slice(i, i + STATUS_MERGE_CHUNK)).length;
    }
    SpreadsheetApp.flush();
    DB.clearCache(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
  });

  // Čekající žádosti v notifikacích: jen dotčené buňky. Celý sloupec by přepsal souběžné „přečteno“
  // (notifikace se zapisují i mimo zámek) a mohl by převést text uložený s apostrofem.
  post('žádosti v notifikacích', function() {
    const notif = plan.notif;
    if (!notif.sheet || notif.changes.length === 0) return;
    notif.changes.forEach(function(c) {
      notif.sheet.getRange(c.row, notif.msgCol).setValue(c.message);
    });
    _statusMergeSetCells_(notif.sheet, notif.changes.filter(function(c) { return c.markRead; }).map(function(c) { return c.row; }), notif.readCol, 'true');
    result.notifications_updated = notif.changes.length;
    SpreadsheetApp.flush();
    DB.clearCache(DB_SHEETS.SYSTEM.NOTIFICATIONS);
  });

  // Značka dokončení: bez ní seznam ukáže „dokončeno s chybou“ (i po tvrdém ukončení běhu)
  if (result.warnings.length === 0) {
    post('značka dokončení', function() {
      const markerRows = v.sources.map(function(s, i) { return firstFree + i; });
      _statusMergeSetCells_(logSheet, markerRows, logHeaders.indexOf('completed_at') + 1, "'" + new Date().toISOString());
      SpreadsheetApp.flush();
    });
  }
  return result;
}

/**
 * Vlastní návrat sloučení. Volat pouze pod ScriptLockem. Je idempotentní: obnoví zdrojům původní
 * active a čistí merged_into bez ohledu na to, v jakém stavu sloučení skončilo.
 */
function _statusMergeRollbackLocked_(mergeId) {
  const log = _statusMergeReadLog_();
  const mine = log.rows.filter(function(r) { return r.mergeId === mergeId; });
  if (mine.length === 0) throw new Error("Sloučení nebylo nalezeno (návratové období mohlo uplynout).");
  // Částečně označený návrat (selhání mezi dávkami) lze dokončit
  if (mine.every(function(r) { return r.rolledBack; })) throw new Error("Toto sloučení už bylo vráceno.");
  // Sloupec pro označení vrácení musí existovat dřív, než se zapíší data
  const rbCol = log.headers.indexOf('rolled_back_at') + 1;
  if (rbCol === 0) throw new Error("List STATUS_MERGE_LOG nemá sloupec rolled_back_at. Spusťte opravu hlaviček.");
  const ageMs = Date.now() - mine[0].mergedAtMs;
  if (!(ageMs <= STATUS_MERGE_RETENTION_DAYS * 24 * 60 * 60 * 1000)) {
    throw new Error("Návratové období (" + STATUS_MERGE_RETENTION_DAYS + " dní) už uplynulo.");
  }
  const targetId = mine[0].newStatusId;
  const st = _statusMergeReadStatuses_();
  const target = st.byId[targetId];
  if (!target) throw new Error("Cílový status už neexistuje, sloučení nelze vrátit.");
  if (target.merged_into) throw new Error("Cílový status byl mezitím sám sloučen do jiného. Nejdřív vraťte pozdější sloučení.");

  const sourceIds = [];
  mine.forEach(function(r) { if (!r.attendanceId && sourceIds.indexOf(r.oldStatusId) === -1) sourceIds.push(r.oldStatusId); });
  sourceIds.forEach(function(id) {
    const s = st.byId[id];
    if (!s) throw new Error("Zdrojový status už neexistuje, sloučení nelze vrátit.");
    // Odmítne jen cizí cíl; prázdné merged_into (nedokončené sloučení nebo už vrácené jiným návratem) je v pořádku
    if (s.merged_into && _smNorm_(s.merged_into) !== _smNorm_(targetId)) {
      throw new Error("Zdrojový status „" + (s.name || id) + "“ je sloučený do jiného statusu, sloučení nelze vrátit.");
    }
  });
  // Sloupce se zajistí před prvním zápisem dat
  const activeCol = _statusMergeEnsureColumn_(st.sheet, st.headers, 'active');
  const mergedCol = _statusMergeEnsureColumn_(st.sheet, st.headers, 'merged_into');

  // Vrací se jen řádky, které mají stále převedený status a stav schválení z převodu.
  // Jiný stav schválení znamená pozdější rozhodnutí schvalovatele nebo nové uložení – ty se nepřepisují.
  const trans = DB.getTransaction();
  const att = _statusMergeReadAttendance_(trans);
  const I = att.idx;
  const rowByAid = {};
  for (let i = 1; i < att.data.length; i++) rowByAid[String(att.data[i][I.aid])] = i;
  const statusUpdates = {};
  const apprUpdates = {};
  let restored = 0;
  let skipped = 0;
  mine.forEach(function(r) {
    if (!r.attendanceId) return;
    const i = rowByAid[r.attendanceId];
    if (i === undefined || _smNorm_(att.data[i][I.stat]) !== _smNorm_(targetId)) { skipped++; return; }
    const old = String(r.oldApproved).toLowerCase();
    const cur = String(att.data[i][I.appr]).toLowerCase();
    // cur === old: převod approved neměnil, nebo předchozí návrat stihl zapsat jen approved
    if (cur !== String(r.newApproved).toLowerCase() && cur !== old) { skipped++; return; }
    if (old === APPROVAL_STATUS.PENDING && cur !== APPROVAL_STATUS.PENDING) apprUpdates[i + 1] = APPROVAL_STATUS.PENDING;
    statusUpdates[i + 1] = r.oldStatusId;
    restored++;
  });
  // Nejdřív approved: řádek s vráceným statusem by opakovaný návrat přeskočil a pending by se ztratilo
  _statusMergeWriteColumn_(att.sheet, I.appr + 1, apprUpdates);
  _statusMergeWriteColumn_(att.sheet, I.stat + 1, statusUpdates, function(cur) { return _smNorm_(cur) === _smNorm_(targetId); });
  SpreadsheetApp.flush();
  DB.clearCache(DB_SHEETS.TRANSACTION.ATTENDANCE);

  // Vrátit zdrojům původní active a zrušit merged_into (idempotentně)
  const wasInactive = {};
  mine.forEach(function(r) { if (!r.attendanceId && String(r.oldActive).toLowerCase() === 'false') wasInactive[r.oldStatusId] = true; });
  const srcRows = sourceIds.map(function(id) { return st.byId[id]._row; });
  _statusMergeSetCells_(st.sheet, sourceIds.filter(function(id) { return !wasInactive[id]; }).map(function(id) { return st.byId[id]._row; }), activeCol, 'true');
  _statusMergeSetCells_(st.sheet, sourceIds.filter(function(id) { return wasInactive[id]; }).map(function(id) { return st.byId[id]._row; }), activeCol, 'false');
  _statusMergeSetCells_(st.sheet, srcRows, mergedCol, '');
  SpreadsheetApp.flush();
  DB.clearCache(DB_SHEETS.CORE.ATTENDANCE_STATUSES);

  // Záznamy se ponechají (kvůli přegenerování kalendářů), jen se označí jako vrácené
  _statusMergeSetCells_(log.sheet, mine.map(function(r) { return r.row; }), rbCol, "'" + new Date().toISOString());
  SpreadsheetApp.flush();
  DB.clearCache(DB_SHEETS.SYSTEM.STATUS_MERGE_LOG);
  return { restored: restored, skipped: skipped, pendingRestored: Object.keys(apprUpdates).length };
}
