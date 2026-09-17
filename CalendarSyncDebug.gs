/**
 * DEBUG nástroje pro diagnostiku Google Calendar synchronizace.
 * Tyto funkce lze spustit přímo z Apps Script editoru (▶ Spustit).
 */

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
