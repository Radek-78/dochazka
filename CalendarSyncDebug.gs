/**
 * DEBUG nástroje pro diagnostiku Google Calendar synchronizace.
 * Tyto funkce lze spustit přímo z Apps Script editoru (▶ Spustit).
 */

/**
 * Hlavní diagnostická funkce.
 * Spusť z Apps Script editoru a zkontroluj záložku "Protokol provádění".
 */
function debugCalendarSync() {
  var logs = [];
  var log = function(msg) { logs.push(msg); Logger.log(msg); };

  log('═══════════════════════════════════════');
  log('CalendarSync Debug – ' + new Date().toISOString());
  log('═══════════════════════════════════════');

  // 1. Přihlášený uživatel
  var currentUser;
  try {
    currentUser = Auth.getCurrentUser();
  } catch (e) {
    log('ERROR – Auth.getCurrentUser(): ' + e);
    return logs.join('\n');
  }
  if (!currentUser) { log('ERROR – getCurrentUser vrátil null'); return logs.join('\n'); }

  log('User:                 ' + currentUser.email);
  log('user_id:              ' + currentUser.user_id);
  log('sync_own_attendance:  ' + currentUser.sync_own_attendance);
  log('personal_calendar_id: ' + (currentUser.personal_calendar_id || '(prázdné)'));

  // 2. Existence kalendáře
  if (currentUser.personal_calendar_id) {
    try {
      var cal = CalendarApp.getCalendarById(currentUser.personal_calendar_id);
      log('Kalendář:             ' + (cal ? 'NALEZEN – "' + cal.getName() + '"' : 'NENALEZEN (getCalendarById vrátil null)'));
    } catch (e) {
      log('Kalendář ERROR:       ' + e.message);
    }
  } else {
    log('Kalendář:             (žádný calendar_id v DB)');
  }

  // 3. Záznamy docházky
  var yearStart = new Date().getFullYear() + '-01-01';
  log('Hledám záznamy od:    ' + yearStart);
  var records;
  try {
    records = DB.getTable(DB.getTransaction(), DB_SHEETS.TRANSACTION.ATTENDANCE);
    log('Celkem záznamy ATTENDANCE: ' + records.length);
    var mine = records.filter(function(a) { return a.user_id === currentUser.user_id; });
    log('Moje záznamy (všechny):    ' + mine.length);
    var mineYear = mine.filter(function(a) { return a.date >= yearStart; });
    log('Moje záznamy (tento rok):  ' + mineYear.length);
    records = mineYear;

    if (records.length > 0) {
      log('Vzorový záznam[0]:    ' + JSON.stringify(records[0]));
      log('  date raw:           ' + records[0].date);
      log('  date normalized:    ' + CalendarSync._toDate(records[0].date));
      log('  slot:               ' + records[0].slot);
      log('  status_id:          ' + records[0].status_id);
    }
  } catch (e) {
    log('ERROR – čtení ATTENDANCE: ' + e);
    return logs.join('\n');
  }

  // 4. Statusy
  var statuses;
  try {
    statuses = DB.getTable(DB.getCore(), DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    log('Počet statusů:        ' + statuses.length);
    if (records.length > 0) {
      var st = statuses.find(function(s) { return s.status_id === records[0].status_id; });
      log('Status nalezen:       ' + (st ? '"' + st.name + '"' : 'NE – status_id "' + records[0].status_id + '" neexistuje'));
    }
  } catch (e) {
    log('ERROR – čtení ATTENDANCE_STATUSES: ' + e);
  }

  // 5. Test vytvoření jednoho eventu
  if (currentUser.personal_calendar_id && records.length > 0) {
    log('───────────────────────────────────────');
    log('TEST: pokus o vytvoření jednoho eventu');
    var rec = records[0];
    var st2 = statuses && statuses.find(function(s) { return s.status_id === rec.status_id; });
    if (!st2) {
      log('TEST PŘESKOČEN – status nenalezen');
    } else {
      var dateNorm = CalendarSync._toDate(rec.date);
      var title = CalendarSync._buildTitle(st2.name, rec.slot);
      log('  calendarId: ' + currentUser.personal_calendar_id);
      log('  date:       ' + dateNorm);
      log('  slot:       ' + rec.slot);
      log('  title:      ' + title);
      try {
        CalendarSync._upsertEvent(currentUser.personal_calendar_id, dateNorm, rec.slot, title);
        log('TEST VÝSLEDEK: ✅ Event vytvořen OK');
      } catch (e) {
        log('TEST VÝSLEDEK: ❌ CHYBA – ' + e.toString());
        if (e.stack) log('Stack: ' + e.stack);
      }
    }
  }

  log('═══════════════════════════════════════');
  return logs.join('\n');
}

/**
 * Znovu spustí naplnění osobního kalendáře pro přihlášeného uživatele.
 * Použij pokud se události při prvním zapnutí nevytvořily.
 * Exponovaná funkce – lze volat z frontendu i přímo z editoru.
 */
function rebuildPersonalCalendarSync() {
  try {
    var currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: 'Uživatel není přihlášen.' };

    if (currentUser.sync_own_attendance !== 'true') {
      return { success: false, error: 'Synchronizace není zapnuta.' };
    }
    if (!currentUser.personal_calendar_id) {
      return { success: false, error: 'Kalendář nebyl nalezen v DB (personal_calendar_id je prázdné).' };
    }

    var yearStart = new Date().getFullYear() + '-01-01';
    var records = DB.getTable(DB.getTransaction(), DB_SHEETS.TRANSACTION.ATTENDANCE)
      .filter(function(a) { return a.user_id === currentUser.user_id && a.date >= yearStart; });

    if (records.length === 0) {
      return { success: true, created: 0, message: 'Žádné záznamy docházky k synchronizaci.' };
    }

    var statuses = DB.getTable(DB.getCore(), DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    var created = 0;
    var errors = [];

    records.forEach(function(rec) {
      var st = statuses.find(function(s) { return s.status_id === rec.status_id; });
      if (!st) return;
      try {
        var date = CalendarSync._toDate(rec.date);
        var title = CalendarSync._buildTitle(st.name, rec.slot);
        CalendarSync._upsertEvent(currentUser.personal_calendar_id, date, rec.slot, title);
        created++;
      } catch (e) {
        errors.push(rec.date + ': ' + e.message);
      }
    });

    return {
      success: true,
      created: created,
      total: records.length,
      errors: errors,
      message: 'Vytvořeno ' + created + ' z ' + records.length + ' eventů.'
        + (errors.length ? ' Chyby: ' + errors.join('; ') : '')
    };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}
/**
 * Opraví přístupy k plánovacím kalendářům (MASTER kalendářům skupin).
 */
function rebuildPlannerCalendarSync() {
  try {
    var currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: 'Uživatel není přihlášen.' };

    if (currentUser.sync_planner !== 'true') {
      return { success: false, error: 'Synchronizace planneru není zapnuta.' };
    }

    var displayName = (currentUser.first_name || '') + ' ' + (currentUser.last_name || '');
    return CalendarSync.enablePlannerSync(currentUser.user_id, currentUser.email, displayName);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}
