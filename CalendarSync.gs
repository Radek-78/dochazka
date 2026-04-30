/**
 * Modul pro synchronizaci Google Kalendáře.
 *
 * Skript běží jako SUPERADMIN (USER_DEPLOYING) – kalendáře jsou vytvářeny
 * v účtu SUPERADMIN a sdíleny pouze pro čtení s cílovými uživateli.
 * Při vypnutí synchronizace je kalendář kompletně smazán (zmizí z účtu uživatele).
 *
 * Závislosti:
 *   – CalendarApp  (built-in GAS service)
 *   – Calendar     (Advanced Service, Calendar API v3 – nutno zapnout v appsscript.json)
 */

var CalendarSync = {

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC – zapnout / vypnout synchronizaci
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Zapne synchronizaci vlastní docházky.
   * Vytvoří Google Kalendář "Osobní", sdílí s uživatelem (read-only),
   * naplní záznamy z aktuálního roku.
   */
  enablePersonalSync: function(userId, userEmail, displayName) {
    try {
      CalendarSync._ensureCalendarColumns();

      // Ochrana: smazat starý kalendář pokud existuje (prevence duplikátů)
      var existingUser = CalendarSync._getUser(userId);
      if (existingUser && existingUser.personal_calendar_id) {
        try {
          var oldCal = CalendarApp.getCalendarById(existingUser.personal_calendar_id);
          if (oldCal) oldCal.deleteCalendar();
        } catch (e) {
          console.warn('CalendarSync.enablePersonalSync – cleanup old calendar: ' + e);
        }
      }

      var calName = 'Osobní – ' + displayName;
      var cal = CalendarApp.createCalendar(calName, {
        color: CalendarApp.Color.CYAN,
        description: 'Docházka – ' + displayName + ' (' + userEmail + ')'
      });
      var calId = cal.getId();

      CalendarSync._shareWithUser(calId, userEmail);

      // Pokud kalendář není pro mě, skryju ho ze svého seznamu, aby mi tam nepřekážel
      if (userEmail !== Session.getActiveUser().getEmail()) {
        CalendarSync._unsubscribeFromCalendar(calId);
      }

      Admin.updateUser(userId, {
        user_id: userId,
        sync_own_attendance: 'true',
        personal_calendar_id: calId
      });

      // Audit log
      CalendarSync._auditLog(userEmail, 'PERSONAL_SYNC_ENABLED', 'Calendar: ' + calId + ' for ' + displayName);

      // Krátká pauza – nově vytvořený kalendář potřebuje chvíli
      // než je Google Calendar API připravené přijímat zápisy
      Utilities.sleep(3000);

      // Naplnit záznamy z aktuálního roku
      CalendarSync._fillPersonalCalendar(userId, calId);

      return { success: true };
    } catch (e) {
      console.error('CalendarSync.enablePersonalSync: ' + e);
      return { success: false, error: e.message || e.toString() };
    }
  },

  /**
   * Vypne synchronizaci vlastní docházky.
   * Smaže Google Kalendář – zmizí i z účtu uživatele.
   */
  disablePersonalSync: function(userId) {
    try {
      var user = CalendarSync._getUser(userId);
      if (user && user.personal_calendar_id) {
        try {
          var cal = CalendarApp.getCalendarById(user.personal_calendar_id);
          if (cal) cal.deleteCalendar();
        } catch (e) {
          // Kalendář možná již neexistuje – pokračujeme
          console.warn('CalendarSync.disablePersonalSync – deleteCalendar: ' + e);
        }
      }

      Admin.updateUser(userId, {
        user_id: userId,
        sync_own_attendance: 'false',
        personal_calendar_id: ''
      });

      return { success: true };
    } catch (e) {
      console.error('CalendarSync.disablePersonalSync: ' + e);
      return { success: false, error: e.message || e.toString() };
    }
  },

  /**
   * Zapne synchronizaci docházky týmu (jen pro vedoucí).
   * Vytvoří Google Kalendář "Týmový" a sdílí ho s vedoucím.
   */
  enableTeamSync: function(userId, userEmail, displayName) {
    try {
      CalendarSync._ensureCalendarColumns();

      // Ochrana: smazat starý kalendář pokud existuje (prevence duplikátů)
      var existingUser = CalendarSync._getUser(userId);
      if (existingUser && existingUser.team_calendar_id) {
        try {
          var oldCal = CalendarApp.getCalendarById(existingUser.team_calendar_id);
          if (oldCal) oldCal.deleteCalendar();
        } catch (e) {
          console.warn('CalendarSync.enableTeamSync – cleanup old calendar: ' + e);
        }
      }

      var calName = 'Týmový – ' + displayName;
      var cal = CalendarApp.createCalendar(calName, {
        color: CalendarApp.Color.GREEN,
        description: 'Docházka týmu – ' + displayName + ' (' + userEmail + ')'
      });
      var calId = cal.getId();

      CalendarSync._shareWithUser(calId, userEmail);

      // Pokud kalendář není pro mě, skryju ho ze svého seznamu
      if (userEmail !== Session.getActiveUser().getEmail()) {
        CalendarSync._unsubscribeFromCalendar(calId);
      }

      Admin.updateUser(userId, {
        user_id: userId,
        sync_team_vacations: 'true',
        team_calendar_id: calId
      });

      // Audit log
      CalendarSync._auditLog(userEmail, 'TEAM_SYNC_ENABLED', 'Calendar: ' + calId + ' for ' + displayName);

      // Naplnit dovolené a HO podřízených z aktuálního roku
      CalendarSync._fillTeamCalendar(userId, calId);

      return { success: true };
    } catch (e) {
      console.error('CalendarSync.enableTeamSync: ' + e);
      return { success: false, error: e.message || e.toString() };
    }
  },

  /**
   * Vypne synchronizaci docházky týmu.
   * Smaže Google Kalendář.
   */
  disableTeamSync: function(userId) {
    try {
      var user = CalendarSync._getUser(userId);
      if (user && user.team_calendar_id) {
        try {
          var cal = CalendarApp.getCalendarById(user.team_calendar_id);
          if (cal) cal.deleteCalendar();
        } catch (e) {
          console.warn('CalendarSync.disableTeamSync – deleteCalendar: ' + e);
        }
      }

      Admin.updateUser(userId, {
        user_id: userId,
        sync_team_vacations: 'false',
        team_calendar_id: ''
      });

      return { success: true };
    } catch (e) {
      console.error('CalendarSync.disableTeamSync: ' + e);
      return { success: false, error: e.message || e.toString() };
    }
  },

  /**
   * Zapne synchronizaci plánovacího kalendáře.
   * Vytvoří Google Kalendář "Plánovací", sdílí s uživatelem,
   * naplní událostmi ze skupin, ve kterých je uživatel členem.
   */
  /**
   * Zapne synchronizaci plánovacích kalendářů pro uživatele.
   * Projde všechny skupiny, kde je uživatel členem, nasdílí mu jejich "Master" kalendáře.
   */
  enablePlannerSync: function(userId, userEmail, displayName) {
    try {
      CalendarSync._ensureCalendarColumns();
      var coreSS = DB.getCore();
      
      // 1. Najít skupiny, kde je uživatel členem
      var memberships = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS)
        .filter(function(m) { return String(m.user_id) === String(userId); });
      
      var plannerGroups = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUPS);
      
      memberships.forEach(function(mem) {
        var group = plannerGroups.find(function(g) { return String(g.group_id) === String(mem.group_id); });
        if (group && group.calendar_id) {
          // 1. Nasdílet MASTER kalendář
          CalendarSync._shareWithUser(group.calendar_id, userEmail);
          
          // 2. Přidat do seznamu kalendářů (pouze pokud jsem to JÁ, API neumí "vnutit" kalendář jinému účtu do seznamu bez souhlasu)
          if (userEmail === Session.getActiveUser().getEmail()) {
            CalendarSync._subscribeToCalendar(group.calendar_id, group.color);
          }
        }
      });

      Admin.updateUser(userId, {
        user_id: userId,
        sync_planner: 'true'
      });

      return { success: true };
    } catch (e) {
      console.error('CalendarSync.enablePlannerSync: ' + e);
      return { success: false, error: e.message || e.toString() };
    }
  },

  /**
   * Vypne synchronizaci plánovacího kalendáře.
   * Pozn: Master kalendáře skupin nemažeme, jen uživateli zrušíme autorizaci (ACL).
   */
  disablePlannerSync: function(userId) {
    try {
      var user = CalendarSync._getUser(userId);
      if (!user) return { success: false, error: 'Uživatel nenalezen.' };
      
      var coreSS = DB.getCore();
      var memberships = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS)
        .filter(function(m) { return String(m.user_id) === String(userId); });
      
      var plannerGroups = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUPS);
      
      memberships.forEach(function(mem) {
        var group = plannerGroups.find(function(g) { return String(g.group_id) === String(mem.group_id); });
        if (group && group.calendar_id) {
          // 1. Odhlásit z CalendarListu
          CalendarSync._unsubscribeFromCalendar(group.calendar_id);

          // 2. Odebrat přístup z MASTER kalendáře (ACL)
          try {
            Calendar.Acl.remove(group.calendar_id, 'user:' + user.email);
          } catch(e) { /* tichý fail pokud už neexistuje */ }
        }
      });

      Admin.updateUser(userId, {
        user_id: userId,
        sync_planner: 'false'
      });

      return { success: true };
    } catch (e) {
      console.error('CalendarSync.disablePlannerSync: ' + e);
      return { success: false, error: e.message || e.toString() };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC – synchronizace jednotlivých eventů
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Synchronizuje docházkový záznam do osobního kalendáře uživatele.
   * Volat po každém uložení záznamu docházky (setAttendance).
   *
   * @param {string} userId
   * @param {string} dateStr    – formát YYYY-MM-DD
   * @param {string} slot       – ALL_DAY | AM | PM
   * @param {string} statusName – název statusu (např. "HomeOffice")
   */
  syncPersonalEvent: function(userId, dateStr, slot, statusName) {
    try {
      var user = CalendarSync._getUser(userId);
      if (!user || user.sync_own_attendance !== 'true' || !user.personal_calendar_id) return;

      var title = CalendarSync._buildTitle(statusName, slot);
      CalendarSync._upsertEvent(user.personal_calendar_id, dateStr, slot, title);
    } catch (e) {
      console.warn('CalendarSync.syncPersonalEvent: ' + e);
    }
  },

  /**
   * Smaže docházkový event z osobního kalendáře.
   * Volat při smazání záznamu docházky.
   */
  deletePersonalEvent: function(userId, dateStr, slot) {
    try {
      var user = CalendarSync._getUser(userId);
      if (!user || !user.personal_calendar_id) return;
      CalendarSync._deleteSlotEvents(user.personal_calendar_id, dateStr, slot);
    } catch (e) {
      console.warn('CalendarSync.deletePersonalEvent: ' + e);
    }
  },

  /**
   * Synchronizuje docházkový záznam podřízeného do týmových kalendářů vedoucích.
   * Synchronizuje pouze statusy označené jako dovolená nebo HomeOffice.
   * Volat po uložení záznamu docházky.
   *
   * @param {string} subordinateId  – userId podřízeného zaměstnance
   * @param {string} dateStr
   * @param {string} slot
   * @param {object} statusObj      – { name, is_vacation, abbreviation }
   * @param {string} subordinateName – zobrazované jméno podřízeného
   */
  syncTeamEvent: function(subordinateId, dateStr, slot, statusObj, subordinateName) {
    try {
      if (!CalendarSync._isTeamSyncStatus(statusObj)) return;

      var managers = CalendarSync._getManagersOf(subordinateId);
      var coreSS = DB.getCore();
      var statuses = Privacy.ensureFallbackMaskStatus(DB.getTable(coreSS, DB_SHEETS.CORE.ATTENDANCE_STATUSES));
      var positions = DB.getTable(coreSS, DB_SHEETS.CORE.POSITIONS);
      var allUsers = DB.getTable(coreSS, DB_SHEETS.CORE.USERS);
      var subordinate = allUsers.find(function(u) { return u.user_id === subordinateId; }) || { user_id: subordinateId };
      var statusById = {};
      statuses.forEach(function(s) { statusById[s.status_id] = s; });

      managers.forEach(function(manager) {
        if (manager.sync_team_vacations !== 'true' || !manager.team_calendar_id) return;
        var privacyCtx = Privacy.createContext({ viewer: manager, positions: positions, statuses: statuses });
        var displayStatus = statusObj;
        if (!Privacy.canViewUnmasked(subordinate, privacyCtx)) {
          displayStatus = statusById[Privacy.getMaskedStatusId(statusObj.status_id, privacyCtx)] || statusObj;
        }
        var displayName = (displayStatus.abbreviation && displayStatus.abbreviation.toUpperCase() === 'HO') ? displayStatus.abbreviation : displayStatus.name;
        var title = subordinateName + ' – ' + CalendarSync._buildTitle(displayName, slot);
        CalendarSync._upsertTeamEvent(manager.team_calendar_id, dateStr, slot, subordinateId, title);
      });
    } catch (e) {
      console.warn('CalendarSync.syncTeamEvent: ' + e);
    }
  },

  /**
   * Synchronizuje plánovací událost do kalendářů všech členů skupiny.
   * Volat po každém uložení události v plánovači.
   *
   * @param {string} eventId    – UUID události
   * @param {string} groupId    – UUID skupiny
   * @param {string} dateStr    – formát YYYY-MM-DD
   * @param {string} description – popis události
   * @param {string} groupName  – název skupiny (pro titulek eventu)
   */
  syncPlannerEvent: function(eventId, groupId, dateStr, description, groupName) {
    try {
      var group = DB.getTable(DB.getCore(), DB_SHEETS.CORE.PLANNER_GROUPS)
        .find(function(g) { return String(g.group_id) === String(groupId); });
      
      if (!group || !group.calendar_id) return;

      // Zápis do MASTER kalendáře skupiny (vidí ho všichni členové)
      CalendarSync._upsertPlannerEvent(group.calendar_id, eventId, dateStr, description);
    } catch (e) {
      console.warn('CalendarSync.syncPlannerEvent: ' + e);
    }
  },

  /**
   * Odstraní plánovací událost z MASTER kalendáře skupiny.
   */
  removePlannerEvent: function(eventId, groupId) {
    try {
      var group = DB.getTable(DB.getCore(), DB_SHEETS.CORE.PLANNER_GROUPS)
        .find(function(g) { return String(g.group_id) === String(groupId); });

      if (group && group.calendar_id) {
        CalendarSync._deletePlannerEventById(group.calendar_id, eventId);
      }
    } catch (e) {
      console.warn('CalendarSync.removePlannerEvent: ' + e);
    }
  },

  /**
   * Smaže event podřízeného z týmových kalendářů vedoucích.
   */
  deleteTeamEvent: function(subordinateId, dateStr, slot) {
    try {
      var managers = CalendarSync._getManagersOf(subordinateId);
      managers.forEach(function(manager) {
        if (!manager.team_calendar_id) return;
        CalendarSync._deleteTeamSlotEvents(manager.team_calendar_id, dateStr, slot, subordinateId);
      });
    } catch (e) {
      console.warn('CalendarSync.deleteTeamEvent: ' + e);
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC – cleanup osiřelých kalendářů
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Najde a smaže osiřelé kalendáře (existují v Google, ale nemají záznam v DB).
   * Bezpečné: maže pouze kalendáře vytvořené touto aplikací (identifikované popisem).
   * Vrací seznam smazaných kalendářů pro audit.
   * @return {{ success: boolean, cleaned: Array, errors: Array }}
   */
  cleanupOrphanedCalendars: function() {
    try {
      var cleaned = [];
      var errors = [];

      // 1. Načíst všechny calendar_id z DB (USERS tabulka)
      var coreSS = DB.getCore();
      var users = DB.getTable(coreSS, DB_SHEETS.CORE.USERS);
      var dbCalendarIds = new Set();
      users.forEach(function(u) {
        if (u.personal_calendar_id) dbCalendarIds.add(u.personal_calendar_id);
        if (u.team_calendar_id) dbCalendarIds.add(u.team_calendar_id);
      });

      // Přidat planner group calendar IDs
      var plannerGroups = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUPS);
      plannerGroups.forEach(function(g) {
        if (g.calendar_id) dbCalendarIds.add(g.calendar_id);
      });

      // 2. Načíst všechny kalendáře z Google Calendar účtu
      var calendarList = Calendar.CalendarList.list({ maxResults: 250 });
      var items = calendarList.items || [];

      items.forEach(function(cal) {
        // Přeskočit primární a importované kalendáře
        if (cal.primary || cal.accessRole !== 'owner') return;

        // Identifikace: kalendář vytvořený naší aplikací má v description "Docházka"
        var desc = cal.description || '';
        var summary = cal.summary || '';
        var isOurCalendar = desc.indexOf('Docházka') !== -1 ||
                            summary.indexOf('Osobní –') !== -1 ||
                            summary.indexOf('Týmový –') !== -1;

        if (!isOurCalendar) return;

        // Pokud calendar_id NENÍ v DB → orphan
        if (!dbCalendarIds.has(cal.id)) {
          try {
            var gcal = CalendarApp.getCalendarById(cal.id);
            if (gcal) {
              gcal.deleteCalendar();
              cleaned.push({ id: cal.id, name: summary });
              CalendarSync._auditLog(
                Session.getActiveUser().getEmail(),
                'ORPHAN_CALENDAR_DELETED',
                'Calendar: ' + cal.id + ' (' + summary + ')'
              );
            }
          } catch (e) {
            errors.push({ id: cal.id, name: summary, error: e.toString() });
          }
        }
      });

      return { success: true, cleaned: cleaned, errors: errors };
    } catch (e) {
      console.error('CalendarSync.cleanupOrphanedCalendars: ' + e);
      return { success: false, error: e.toString() };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE – event helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Vytvoří nebo přepíše event v kalendáři pro daný den a slot.
   * Slot je uložen v extendedProperties.private.dochazka_slot pro přesný výběr.
   */
  _upsertEvent: function(calendarId, dateStr, slot, title) {
    var date = CalendarSync._toDate(dateStr);
    CalendarSync._deleteSlotEvents(calendarId, date, slot);

    Calendar.Events.insert({
      summary: title,
      start: { date: date },
      end: { date: CalendarSync._nextDay(date) },
      reminders: { useDefault: false, overrides: [] },
      transparency: 'transparent',
      extendedProperties: {
        private: { dochazka_slot: slot }
      }
    }, calendarId);
  },

  /**
   * Smaže všechny eventy pro daný den a slot (identifikuje přes extendedProperties).
   */
  _deleteSlotEvents: function(calendarId, dateStr, slot) {
    try {
      var date = CalendarSync._toDate(dateStr);
      var result = Calendar.Events.list(calendarId, {
        timeMin: date + 'T00:00:00Z',
        timeMax: CalendarSync._nextDay(date) + 'T00:00:00Z',
        privateExtendedProperty: 'dochazka_slot=' + slot,
        singleEvents: true,
        maxResults: 20
      });
      (result.items || []).forEach(function(ev) {
        try { Calendar.Events.remove(calendarId, ev.id); } catch (e) {}
      });
    } catch (e) {
      console.warn('CalendarSync._deleteSlotEvents: ' + e);
    }
  },

  /**
   * Vytvoří nebo přepíše team event identifikovaný kombinací slot + subordinateId.
   */
  _upsertTeamEvent: function(calendarId, dateStr, slot, subordinateId, title) {
    var date = CalendarSync._toDate(dateStr);
    CalendarSync._deleteTeamSlotEvents(calendarId, date, slot, subordinateId);

    Calendar.Events.insert({
      summary: title,
      start: { date: date },
      end: { date: CalendarSync._nextDay(date) },
      reminders: { useDefault: false, overrides: [] },
      transparency: 'transparent',
      extendedProperties: {
        private: {
          dochazka_slot: slot,
          dochazka_user: subordinateId
        }
      }
    }, calendarId);
  },

  _deleteTeamSlotEvents: function(calendarId, dateStr, slot, subordinateId) {
    try {
      var date = CalendarSync._toDate(dateStr);
      var result = Calendar.Events.list(calendarId, {
        timeMin: date + 'T00:00:00Z',
        timeMax: CalendarSync._nextDay(date) + 'T00:00:00Z',
        privateExtendedProperty: 'dochazka_slot=' + slot,
        singleEvents: true,
        maxResults: 20
      });
      (result.items || [])
        .filter(function(ev) {
          return ev.extendedProperties &&
            ev.extendedProperties.private &&
            ev.extendedProperties.private.dochazka_user === subordinateId;
        })
        .forEach(function(ev) {
          try { Calendar.Events.remove(calendarId, ev.id); } catch (e) {}
        });
    } catch (e) {
      console.warn('CalendarSync._deleteTeamSlotEvents: ' + e);
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE – počáteční naplnění kalendáře
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Vytvoří nebo přepíše plánovací event identifikovaný planner_event_id.
   */
  _upsertPlannerEvent: function(calId, eventId, dateStr, title) {
    var date = CalendarSync._toDate(dateStr);
    CalendarSync._deletePlannerEventById(calId, eventId);

    Calendar.Events.insert({
      summary: title,
      start: { date: date },
      end: { date: CalendarSync._nextDay(date) },
      reminders: { useDefault: false, overrides: [] },
      transparency: 'transparent',
      extendedProperties: {
        private: { planner_event_id: eventId }
      }
    }, calId);
  },

  /**
   * Smaže plánovací event z kalendáře dle planner_event_id.
   */
  _deletePlannerEventById: function(calId, eventId) {
    try {
      var now = new Date();
      var result = Calendar.Events.list(calId, {
        timeMin: new Date(now.getFullYear() - 1, 0, 1).toISOString(),
        timeMax: new Date(now.getFullYear() + 2, 0, 1).toISOString(),
        privateExtendedProperty: 'planner_event_id=' + eventId,
        singleEvents: true,
        maxResults: 10
      });
      (result.items || []).forEach(function(ev) {
        try { Calendar.Events.remove(calId, ev.id); } catch (e) {}
      });
    } catch (e) {
      console.warn('CalendarSync._deletePlannerEventById: ' + e);
    }
  },

  /**
   * Znovu sestaví VŠECHNY sdílené kalendáře skupin.
   * Projde všechny skupiny a naplní je aktuálními událostmi z DB.
   */
  rebuildAllSharedCalendars: function() {
    try {
      var coreSS = DB.getCore();
      var groups = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUPS);
      
      groups.forEach(function(group) {
        if (group.calendar_id) {
          CalendarSync._fillMasterGroupCalendar(group.group_id, group.calendar_id);
        }
      });
      return { success: true, message: 'Sdílené kalendáře skupin byly obnoveny.' };
    } catch (e) {
      console.error('CalendarSync.rebuildAllSharedCalendars: ' + e);
      return { success: false, error: e.toString() };
    }
  },

  /**
   * Naplní MASTER kalendář jedné skupiny všemi jejími aktivními událostmi.
   */
  _fillMasterGroupCalendar: function(groupId, calId) {
    try {
      var transSS = DB.getTransaction();
      var events = DB.getTable(transSS, DB_SHEETS.TRANSACTION.PLANNER_EVENTS)
        .filter(function(ev) { return String(ev.group_id) === String(groupId) && ev.status !== 'deleted'; });
      
      events.forEach(function(ev) {
        try {
          CalendarSync._upsertPlannerEvent(calId, ev.event_id, ev.date, ev.description || '');
        } catch (e) {
          console.warn('_fillMasterGroupCalendar – event ' + ev.event_id + ': ' + e);
        }
      });
    } catch (e) {
      console.warn('CalendarSync._fillMasterGroupCalendar: ' + e);
    }
  },

  /**
   * OSOLETNÍ: Původní funkce pro plnění osobního "Plánovacího" kalendáře.
   * Nyní se již nepoužívá, nahrazeno sdílenými kalendáři skupin.
   */
  _fillPlannerCalendar: function(userId, calId) {
     // Ponecháno prázdné nebo přesměrovat na novou logiku pokud je třeba.
  },

  /**
   * Naplní osobní kalendář záznamy docházky z aktuálního roku.
   */
  _fillPersonalCalendar: function(userId, calId) {
    var yearStart = new Date().getFullYear() + '-01-01';
    var records = DB.getTable(DB.getTransaction(), DB_SHEETS.TRANSACTION.ATTENDANCE)
      .filter(function(a) { return a.user_id === userId && a.date >= yearStart; });

    var statuses = DB.getTable(DB.getCore(), DB_SHEETS.CORE.ATTENDANCE_STATUSES);

    records.forEach(function(rec) {
      var st = statuses.find(function(s) { return s.status_id === rec.status_id; });
      if (!st) return;
      try {
        var title = CalendarSync._buildTitle(st.name, rec.slot);
        CalendarSync._upsertEvent(calId, rec.date, rec.slot, title);
      } catch (e) {
        // Chyba jednoho eventu nezastaví zpracování ostatních
        console.warn('_fillPersonalCalendar – event ' + rec.date + '/' + rec.slot + ': ' + e);
      }
    });
  },

  /**
   * Naplní týmový kalendář dovolenými a HO podřízených z aktuálního roku.
   */
  _fillTeamCalendar: function(managerId, calId) {
    try {
      var yearStart = new Date().getFullYear() + '-01-01';
      var coreSS = DB.getCore();
      var transSS = DB.getTransaction();
      var statuses = Privacy.ensureFallbackMaskStatus(DB.getTable(coreSS, DB_SHEETS.CORE.ATTENDANCE_STATUSES));
      var allUsers = DB.getTable(coreSS, DB_SHEETS.CORE.USERS);
      var manager = allUsers.find(function(u) { return u.user_id === managerId; });
      if (!manager) return;
      var positions = DB.getTable(coreSS, DB_SHEETS.CORE.POSITIONS);
      var privacyCtx = Privacy.createContext({ viewer: manager, positions: positions, statuses: statuses });
      var statusById = {};
      statuses.forEach(function(s) { statusById[s.status_id] = s; });

      // Najít podřízené (stejné oddělení nebo sekce, dle role)
      var subordinates = CalendarSync._getSubordinates(manager, allUsers);

      var allAttendance = DB.getTable(transSS, DB_SHEETS.TRANSACTION.ATTENDANCE)
        .filter(function(a) { return a.date >= yearStart; });

      subordinates.forEach(function(sub) {
        var subRecords = allAttendance.filter(function(a) { return a.user_id === sub.user_id; });
        subRecords.forEach(function(rec) {
          var st = statuses.find(function(s) { return s.status_id === rec.status_id; });
          if (!st || !CalendarSync._isTeamSyncStatus(st)) return;
          var name = (sub.first_name || '') + ' ' + (sub.last_name || '');
          var displayStatus = Privacy.canViewUnmasked(sub, privacyCtx)
            ? st
            : (statusById[Privacy.getMaskedStatusId(st.status_id, privacyCtx)] || st);
          var displayName = (displayStatus.abbreviation && displayStatus.abbreviation.toUpperCase() === 'HO') ? displayStatus.abbreviation : displayStatus.name;
          var title = name.trim() + ' – ' + CalendarSync._buildTitle(displayName, rec.slot);
          CalendarSync._upsertTeamEvent(calId, rec.date, rec.slot, sub.user_id, title);
        });
      });
    } catch (e) {
      console.warn('CalendarSync._fillTeamCalendar: ' + e);
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE – organizační logika
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Vrátí seznam aktivních vedoucích, kteří mají přímou nadřízenost nad userId.
   * (Vedoucí stejného oddělení nebo sekce.)
   */
  _getManagersOf: function(userId) {
    try {
      var coreSS = DB.getCore();
      var allUsers = DB.getTable(coreSS, DB_SHEETS.CORE.USERS)
        .filter(function(u) { return u.active !== 'false'; });
      var positions = DB.getTable(coreSS, DB_SHEETS.CORE.POSITIONS);

      var employee = allUsers.find(function(u) { return u.user_id === userId; });
      if (!employee) return [];

      var managerRoles = [
        ROLES.ORG.SECTION_LEADER, ROLES.ORG.SECTION_DEPUTY,
        ROLES.ORG.DEPT_LEADER, ROLES.ORG.DEPT_DEPUTY
      ];

      return allUsers.filter(function(u) {
        if (u.user_id === userId) return false;
        var orgRole = _resolveOrgRole(u, positions);
        if (managerRoles.indexOf(orgRole) === -1) return false;
        // Vedoucí sekce vidí celou sekci
        if ((orgRole === ROLES.ORG.SECTION_LEADER || orgRole === ROLES.ORG.SECTION_DEPUTY) &&
            u.section_id === employee.section_id) return true;
        // Vedoucí oddělení vidí jen své oddělení
        if ((orgRole === ROLES.ORG.DEPT_LEADER || orgRole === ROLES.ORG.DEPT_DEPUTY) &&
            u.department_id === employee.department_id) return true;
        return false;
      });
    } catch (e) {
      console.warn('CalendarSync._getManagersOf: ' + e);
      return [];
    }
  },

  /**
   * Vrátí seznam podřízených daného vedoucího.
   */
  _getSubordinates: function(manager, allUsers) {
    try {
      var coreSS = DB.getCore();
      var positions = DB.getTable(coreSS, DB_SHEETS.CORE.POSITIONS);
      var orgRole = _resolveOrgRole(manager, positions);
      
      // Načíst konfiguraci synchronizace
      var vacationConfig = Admin.getVacationConfig();
      var syncMap = {};
      try {
        syncMap = JSON.parse(vacationConfig.calendar_sync_map || '{}');
      } catch (e) {
        console.warn('CalendarSync._getSubordinates – JSON parse error: ' + e);
      }
      
      var allowedRoles = syncMap[orgRole];

      return allUsers.filter(function(u) {
        if (u.user_id === manager.user_id || u.active === 'false') return false;
        
        // 1. Kontrola rozsahu (úsek vs oddělení)
        var inScope = false;
        if (orgRole === ROLES.ORG.SECTION_LEADER || orgRole === ROLES.ORG.SECTION_DEPUTY) {
          inScope = (u.section_id === manager.section_id);
        } else if (orgRole === ROLES.ORG.DEPT_LEADER || orgRole === ROLES.ORG.DEPT_DEPUTY) {
          inScope = (u.department_id === manager.department_id);
        }
        
        if (!inScope) return false;

        // 2. Kontrola role (pokud je nakonfigurována)
        if (allowedRoles && Array.isArray(allowedRoles) && allowedRoles.length > 0) {
          var uRole = _resolveOrgRole(u, positions);
          var isAllowed = allowedRoles.indexOf(uRole) !== -1;
          
          // Speciální případ: Člen bez oddělení (DIRECT_MEMBER)
          if (!isAllowed && allowedRoles.indexOf('DIRECT_MEMBER') !== -1) {
            if (!u.department_id || u.department_id === '') {
              isAllowed = true;
            }
          }
          return isAllowed;
        }

        // Pokud není nic konfigurováno, vracíme všechny v rozsahu (původní chování)
        return true;
      });
    } catch (e) {
      console.warn('CalendarSync._getSubordinates error: ' + e);
      return [];
    }
  },

  /**
   * Vrací true pokud jde o status, který se má synchronizovat do týmového kalendáře.
   * Synchronizují se pouze dovolená a HomeOffice (ne kancelář, nemoc apod.).
   */
  _isTeamSyncStatus: function(statusObj) {
    if (!statusObj) return false;
    if (statusObj.is_vacation === 'true' || statusObj.is_vacation === true) return true;
    var abbr = (statusObj.abbreviation || '').toUpperCase();
    return abbr === 'HO' || abbr === 'D';
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE – sdílení a DB
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sdílí kalendář s uživatelem jako čtenář (read-only).
   * Využívá Calendar Advanced Service (Calendar API v3).
   */
  _shareWithUser: function(calendarId, email) {
    try {
      Calendar.Acl.insert({
        role: 'reader',
        scope: { type: 'user', value: email }
      }, calendarId);
    } catch (e) {
      console.warn('CalendarSync._shareWithUser: ' + e);
    }
  },

  /**
   * Načte uživatele z DB podle userId.
   */
  _getUser: function(userId) {
    var users = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
    return users.find(function(u) { return u.user_id === userId; }) || null;
  },

  /**
   * Normalizuje datum libovolného formátu na čistý řetězec YYYY-MM-DD.
   * DB.getTable() vrací datumy jako "2026-03-05T00:00:00.000Z" – Calendar API
   * pro celodenní eventy vyžaduje pouze "2026-03-05".
   */
  _toDate: function(dateStr) {
    if (dateStr instanceof Date) {
      return Utilities.formatDate(dateStr, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    return String(dateStr).substring(0, 10);
  },

  /**
   * Vrátí datum o jeden den pozdější (formát YYYY-MM-DD).
   * Potřebné pro end.date u celodenních eventů v Google Calendar API.
   */
  _nextDay: function(dateStr) {
    var d = new Date(CalendarSync._toDate(dateStr) + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  },

  /**
   * Sestaví název eventu. Pro půldny přidá přívlastek (dop./odp.).
   */
  _buildTitle: function(statusName, slot) {
    if (slot === 'AM') return statusName + ' (dop.)';
    if (slot === 'PM') return statusName + ' (odp.)';
    return statusName;
  },

  /**
   * Najde nebo vytvoří sdílený "Master" kalendář pro konkrétní plánovací skupinu.
   * Volá se při založení/editaci skupiny v Code.gs.
   */
  _getOrCreateGroupCalendar: function(groupId, name, colorHex) {
    var coreSS = DB.getCore();
    var groups = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUPS);
    var group = groups.find(function(g) { return String(g.group_id) === String(groupId); });
    
    var calId = group ? group.calendar_id : null;
    var calendar;

    if (calId) {
      try {
        calendar = CalendarApp.getCalendarById(calId);
      } catch (e) {
        console.warn('CalendarSync._getOrCreateGroupCalendar – calendar not found, creating new: ' + e);
      }
    }

    if (!calendar) {
      calendar = CalendarApp.createCalendar('Planner: ' + name, {
        description: 'Sdílený kalendář pro skupinu ' + name
      });
      calId = calendar.getId();
      // Jako tvůrce ho nechci automaticky vidět ve svém kalendáři (pokud nejsem člen, což pořeší enablePlannerSync)
      CalendarSync._unsubscribeFromCalendar(calId);
    } else {
      calendar.setName('Planner: ' + name);
    }

    // Nastavení barvy (v CalendarListu pro Superadmina, a později pro uživatele)
    var googleColorId = CalendarSync._getGoogleColorId(colorHex);
    try {
      Calendar.CalendarList.patch({ colorId: googleColorId }, calId);
    } catch(e) {
      console.warn('CalendarSync._getOrCreateGroupCalendar – set color failed: ' + e);
    }

    return calId;
  },

  /**
   * Převede Hex barvu na Id barvy v Google Kalendáři (1-24).
   * Snaží se najít nejbližší shodu.
   */
  _getGoogleColorId: function(hex) {
    if (!hex || hex === 'default') return "3"; // Grape jako default

    // Mapa přibližných barev
    var colors = {
      "1": "#a4bdfc", // Lavender
      "2": "#7ae7bf", // Sage
      "3": "#dbadff", // Grape
      "4": "#ff887c", // Flamingo
      "5": "#fbd75b", // Banana
      "6": "#ffb878", // Tangerine
      "7": "#46d6db", // Peacock
      "8": "#e1e1e1", // Graphite
      "9": "#5484ed", // Blueberry
      "10": "#51b749", // Basil
      "11": "#dc2127", // Tomato
      "12": "#dbadff", // Port...
      "14": "#9fe1e7", // Sage variant
      "22": "#f4511e"  // Mango (Orange)
    };

    // Pokud nemáme sofistikovaný algoritmus, vrátíme fixní mapu pro nejčastější barvy
    var h = String(hex).toLowerCase();
    if (h.indexOf("#0ea5e9") !== -1 || h.indexOf("#2196f3") !== -1) return "9"; // Blue
    if (h.indexOf("#ef4444") !== -1 || h.indexOf("#f44336") !== -1) return "11"; // Red
    if (h.indexOf("#22c55e") !== -1 || h.indexOf("#4caf50") !== -1) return "10"; // Green
    if (h.indexOf("#f59e0b") !== -1 || h.indexOf("#ff9800") !== -1) return "22"; // Orange
    if (h.indexOf("#8b5cf6") !== -1 || h.indexOf("#9c27b0") !== -1) return "3";  // Purple
    
    return "3"; 
  },

  /**
   * Přidá kalendář do seznamu kalendářů konkrétního uživatele.
   * Díky tomu se mu zobrazí v Google Kalendáři v sekci "Jiné kalendáře".
   */
  _subscribeToCalendar: function(calendarId, colorHex) {
    try {
      var googleColorId = CalendarSync._getGoogleColorId(colorHex);
      // CalendarList.insert přidá kalendář do seznamu přihlášeného/aktivního kontextu.
      // Protože skript běží pod Superadminem, ale my chceme aby se to objevilo uživateli, 
      // musíme zajistit, že je kalendář nejdříve nasdílen.
      Calendar.CalendarList.insert({
        id: calendarId,
        colorId: googleColorId,
        selected: true
      });
    } catch (e) {
      if (e.toString().indexOf('already exists') === -1) {
        console.warn('CalendarSync._subscribeToCalendar: ' + e);
      }
    }
  },

  /**
   * Odstraní kalendář ze seznamu kalendářů (odhlášení odběru).
   */
  _unsubscribeFromCalendar: function(calendarId) {
    try {
      Calendar.CalendarList.remove(calendarId);
    } catch (e) {
      console.warn('CalendarSync._unsubscribeFromCalendar: ' + e);
    }
  },

  /**
   * DB migrace: zajistí existenci sloupců personal_calendar_id a team_calendar_id
   * v tabulce USERS. Volá se před prvním zápisem.
   */
  _ensureCalendarColumns: function() {
    try {
      var coreSS = DB.getCore();
      var sheet = coreSS.getSheetByName(DB_SHEETS.CORE.USERS);
      if (!sheet || sheet.getLastColumn() === 0) return;

      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var needed = ['personal_calendar_id', 'team_calendar_id', 'sync_planner', 'planner_calendar_id'];
      needed.forEach(function(col) {
        if (headers.indexOf(col) === -1) {
          sheet.getRange(1, sheet.getLastColumn() + 1).setValue(col).setFontWeight('bold');
        }
      });
    } catch (e) {
      console.warn('CalendarSync._ensureCalendarColumns: ' + e);
    }
  },

  /**
   * Zapíše záznam do AUDIT_LOG pro sledování kalendářních operací.
   */
  _auditLog: function(userEmail, action, details) {
    try {
      var sysDb = DB.getSystem();
      var sheet = sysDb.getSheetByName(DB_SHEETS.SYSTEM.AUDIT_LOG);
      if (sheet) {
        sheet.appendRow([new Date().toISOString(), userEmail, action, details]);
      }
    } catch (e) {
      console.warn('CalendarSync._auditLog: ' + e);
    }
  }
};
