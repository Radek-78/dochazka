/**
 * Modul pro administrační funkce (Backend).
 */

var Admin = {
  /**
   * Získá data pro správu organizační struktury.
   */
  getOrgData: function() {
    // Ověření oprávnění přes RBAC
    if (!Auth.hasAdminAccess()) {
      throw new Error("Nedostatečná oprávnění pro přístup k administraci.");
    }

    const coreSS = DB.getCore();
    this.ensureDefaultLocations();
    const config = this.getVacationConfig();
    return {
      locations: DB.getTable(coreSS, DB_SHEETS.CORE.LOCATIONS),
      sections: DB.getTable(coreSS, DB_SHEETS.CORE.SECTIONS),
      departments: DB.getTable(coreSS, DB_SHEETS.CORE.DEPARTMENTS),
      groups: DB.getTable(coreSS, DB_SHEETS.CORE.GROUPS),
      positions: Admin._getPositionsWithMigration(coreSS),
      vacationConfig: config,
      orgRoles: ROLES.ORG
    };
  },

  /**
   * Zajistí, že DB obsahuje 6 výchozích lokací — spustí se POUZE JEDNOU,
   * poté je uložen příznak do ScriptProperties. Zabrání duplicitám po přejmenování.
   */
  ensureDefaultLocations: function() {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(CONFIG.PROP_DEFAULT_LOCS_SEEDED) === 'true') return;

    const coreSS = DB.getCore();
    const existing = DB.getTable(coreSS, DB_SHEETS.CORE.LOCATIONS);
    const defaults = [
      { name: 'DL', type: 'HQ' },
      { name: '5 Brandýs nad Labem', type: 'LC' },
      { name: '6 Olomouc', type: 'LC' },
      { name: '7 Cerhovice', type: 'LC' },
      { name: '9 Buštěhrad', type: 'LC' },
      { name: '11 Bravantice', type: 'LC' }
    ];
    defaults.forEach(function(def) {
      if (!existing.find(function(loc) { return loc.name === def.name; })) {
        DB.insertRow(coreSS, DB_SHEETS.CORE.LOCATIONS, {
          location_id: Utilities.getUuid(),
          name: def.name,
          type: def.type,
          active: 'true'
        });
      }
    });

    props.setProperty(CONFIG.PROP_DEFAULT_LOCS_SEEDED, 'true');
  },

  /**
   * Soft-smaže lokaci a kaskádově deaktivuje všechny její úseky, oddělení a týmy.
   */
  deleteLocation: function(locationId) {
    if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
    const coreSS = DB.getCore();
    const self = this;

    const sections = DB.getTable(coreSS, DB_SHEETS.CORE.SECTIONS)
      .filter(function(s) { return s.location_id === locationId; });

    sections.forEach(function(s) {
      const depts = DB.getTable(coreSS, DB_SHEETS.CORE.DEPARTMENTS)
        .filter(function(d) { return d.section_id === s.section_id; });

      depts.forEach(function(d) {
        const groups = DB.getTable(coreSS, DB_SHEETS.CORE.GROUPS)
          .filter(function(g) { return g.department_id === d.department_id; });

        groups.forEach(function(g) {
          self.updateEntity(DB_SHEETS.CORE.GROUPS, 'group_id', { group_id: g.group_id, active: 'false' });
        });

        self.updateEntity(DB_SHEETS.CORE.DEPARTMENTS, 'department_id', { department_id: d.department_id, active: 'false' });
      });

      self.updateEntity(DB_SHEETS.CORE.SECTIONS, 'section_id', { section_id: s.section_id, active: 'false' });
    });

    self.updateEntity(DB_SHEETS.CORE.LOCATIONS, 'location_id', { location_id: locationId, active: 'false' });
    return true;
  },

  /**
   * Přidá novou lokaci (DL/LC).
   */
  addLocation: function(name, type) {
    if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
    const coreSS = DB.getCore();
    const newLocation = {
      location_id: Utilities.getUuid(),
      name: name,
      type: type,
      active: true
    };
    DB.insertRow(coreSS, DB_SHEETS.CORE.LOCATIONS, newLocation);
    return newLocation;
  },

  /**
   * Přidá nový úsek (Section).
   */
  addSection: function(name, locationId) {
    if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
    const coreSS = DB.getCore();
    const newSection = {
      section_id: Utilities.getUuid(),
      name: name,
      location_id: locationId,
      active: true
    };
    DB.insertRow(coreSS, DB_SHEETS.CORE.SECTIONS, newSection);
    return newSection;
  },

  /**
   * Přidá nové oddělení (Department).
   */
  addDepartment: function(name, sectionId) {
    if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
    const coreSS = DB.getCore();
    const newDept = {
      department_id: Utilities.getUuid(),
      name: name,
      section_id: sectionId,
      active: true
    };
    DB.insertRow(coreSS, DB_SHEETS.CORE.DEPARTMENTS, newDept);
    return newDept;
  },

  /**
   * Finální zápis SUPERADMINA do tabulky USERS.
   */
  completeSetup: function(data) {
    if (PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_INITIALIZED) === 'true') {
      throw new Error("Aplikace je již inicializována. Wizard nelze spustit znovu.");
    }
    const coreSS = DB.getCore();
    const userEmail = Session.getActiveUser().getEmail();
    
    // Vytvoření záznamu uživatele
    const newUser = {
      user_id: Utilities.getUuid(),
      email: userEmail,
      first_name: "", 
      last_name: "",
      section_id: data.section_id,
      department_id: data.department_id || "",
      system_role: ROLES.SYSTEM.SUPERADMIN,
      org_role: "", 
      active: true,
      auth_status: AUTH_STATUS.APPROVED,
      date_start: new Date()
    };
    
    DB.insertRow(coreSS, DB_SHEETS.CORE.USERS, newUser);
    
    // Nastavení globálního příznaku
    PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_INITIALIZED, "true");
    PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_SUPERADMIN_EMAIL, userEmail);
    
    let url = "";
    try {
      url = ScriptApp.getService().getUrl();
    } catch (e) {
      // Pokud selže getUrl, zkusíme prázdný řetězec, klient si poradí refreshem
      console.error("Nepodařilo se získat URL skriptu: " + e.toString());
    }

    return {
      url: url
    };
  },

  /**
   * Získá všechny uživatele pro administraci.
   */
  getAllUsers: function() {
    if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
    const coreSS = DB.getCore();
    const users = DB.getTable(coreSS, DB_SHEETS.CORE.USERS);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Automatická detekce neaktivity podle data ukončení
    return users.map(user => {
      let isDerivedActive = user.active !== "false";
      if (user.date_end) {
        // Parsovat jako lokální datum (ne UTC) – "YYYY-MM-DD" by new Date() interpretoval
        // jako UTC půlnoc, což způsobuje off-by-one chybu v časových pásmech mimo UTC.
        let endDate;
        if (user.date_end instanceof Date) {
          endDate = user.date_end;
        } else {
          const parts = String(user.date_end).split(/[-T]/);
          endDate = parts.length >= 3
            ? new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
            : new Date(user.date_end);
        }
        if (!isNaN(endDate.getTime()) && endDate < today) {
          isDerivedActive = false;
        }
      }
      return { ...user, is_derived_active: isDerivedActive };
    });
  },

  /**
   * Generická funkce pro aktualizaci nebo vytvoření entity v Core databázi.
   */
  updateEntity: function(sheetName, idField, data) {
    if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
    const coreSS = DB.getCore();
    let sheet = coreSS.getSheetByName(sheetName);
    if (!sheet) {
      sheet = coreSS.insertSheet(sheetName);
      if (typeof Setup !== 'undefined') Setup.setHeaders(sheet, sheetName);
    }
    
    const table = DB.getTable(coreSS, sheetName);
    const entityId = data[idField];
    let rowIndex = -1;
    if (entityId) {
      rowIndex = table.findIndex(item => item[idField] === entityId);
    }
    
    let lastCol = sheet.getLastColumn();
    if (lastCol === 0) { // If sheet has no columns, try to set headers
      if (typeof Setup !== 'undefined' && Setup.setHeaders) {
        Setup.setHeaders(sheet, sheetName);
        lastCol = sheet.getLastColumn(); // Re-get lastCol after setting headers
      }
    }
    
    if (lastCol === 0) throw new Error("List " + sheetName + " nemá definované sloupce.");
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

    // Auto-extend: přidat chybějící sloupce z dat (pokud schema v Setup.gs má nové sloupce)
    var headersSet = new Set(headers);
    Object.keys(data).forEach(function(k) {
      if (!headersSet.has(k) && k !== '') {
        // Ověříme zda je sloupec definován v schema
        if (typeof Setup !== 'undefined' && Setup.setHeaders) {
          try {
            var tempHeaders = [];
            // Projdeme známé schéma pro tento sheet
            var expectedHeaders = Setup.getExpectedHeaders ? Setup.getExpectedHeaders(sheetName) : null;
            if (expectedHeaders && expectedHeaders.indexOf(k) !== -1) {
              // Sloupec patří do schema → přidáme ho
              var newCol = lastCol + 1;
              sheet.getRange(1, newCol).setValue(k);
              headers.push(k);
              headersSet.add(k);
              lastCol = newCol;
            }
          } catch(e) { /* tiché selhání */ }
        }
      }
    });

    if (rowIndex === -1) {
      // Vytvoření nové entity
      const newEntity = { ...data };
      if (!newEntity[idField]) newEntity[idField] = Utilities.getUuid();
      if (newEntity.active === undefined) newEntity.active = "true";
      
      DB.insertRow(coreSS, sheetName, newEntity);
      return { success: true, id: newEntity[idField] };
    } else {
      // Aktualizace stávající
      const rowNum = rowIndex + 2;
      headers.forEach((header, i) => {
        if (data.hasOwnProperty(header)) {
          sheet.getRange(rowNum, i + 1).setValue(data[header]);
        }
      });
      return { success: true, id: entityId };
    }
  },

  /**
   * Aktualizuje nebo vytvoří data uživatele.
   * Uživatel vytvořený adminem dostane auth_status APPROVED automaticky.
   */
  updateUser: function(userId, data) {
    if (!data) return { success: false, error: "Chybí data uživatele." };
    if (userId) data.user_id = userId;
    // Nový uživatel (bez user_id) vytvořený adminem = rovnou APPROVED
    if (!data.user_id && !data.auth_status) {
      data.auth_status = AUTH_STATUS.APPROVED;
    }
    return this.updateEntity(DB_SHEETS.CORE.USERS, 'user_id', data);
  },

  /**
   * Deaktivuje uživatele (soft delete).
   */
  deleteUser: function(userId) {
    return this.updateUser(userId, { active: "false" });
  },

  /**
   * Vrátí všechny docházkové statusy. Automaticky přidá chybějící sloupec text_color.
   */
  getAttendanceStatuses: function() {
    if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
    const coreSS = DB.getCore();
    const sheet = coreSS.getSheetByName(DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    if (sheet && sheet.getLastColumn() > 0) {
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      if (headers.indexOf('text_color') === -1) {
        sheet.getRange(1, sheet.getLastColumn() + 1).setValue('text_color').setFontWeight('bold');
      }
      // Re-read headers after potential migration above
      const hdrs2 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      if (hdrs2.indexOf('category') === -1) {
        sheet.getRange(1, sheet.getLastColumn() + 1).setValue('category').setFontWeight('bold');
      }
    }
    return DB.getTable(coreSS, DB_SHEETS.CORE.ATTENDANCE_STATUSES);
  },

  /**
   * Načte pozice a automaticky přidá chybějící sloupec org_role (migrace pro existující DB).
   */
  _getPositionsWithMigration: function(coreSS) {
    const sheet = coreSS.getSheetByName(DB_SHEETS.CORE.POSITIONS);
    if (sheet && sheet.getLastColumn() > 0) {
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      if (headers.indexOf('org_role') === -1) {
        sheet.getRange(1, sheet.getLastColumn() + 1).setValue('org_role').setFontWeight('bold');
      }
    }
    return DB.getTable(coreSS, DB_SHEETS.CORE.POSITIONS);
  },

  /**
   * Trvale odstraní status ze sheetu.
   */
  deleteAttendanceStatus: function(statusId) {
    if (!Auth.hasSystemRole(ROLES.SYSTEM.ADMIN)) throw new Error("Nedostatečná oprávnění. Vyžaduje roli ADMIN.");
    const coreSS = DB.getCore();
    const sheet = coreSS.getSheetByName(DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    if (!sheet) throw new Error("List ATTENDANCE_STATUSES nenalezen.");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idIdx = headers.indexOf('status_id');
    for (var i = 1; i < data.length; i++) {
      if (data[i][idIdx] === statusId) {
        sheet.deleteRow(i + 1);
        return true;
      }
    }
    throw new Error("Status nenalezen.");
  },

  /**
   * Získá konfiguraci dovolených.
   */
  getVacationConfig: function() {
    const coreSS = DB.getCore();
    const table = DB.getTable(coreSS, DB_SHEETS.CORE.VACATION_CONFIG);
    if (table.length === 0) {
      // Výchozí hodnoty
      return {
        system_type: VACATION_SYSTEM_TYPE.GLOBAL,
        global_days: 30,
        base_days: 25,
        max_extra_days: 5,
        require_dept_leader_approval: 'false',
        anniversary_milestones: '[10,15,20,40]'
      };
    }
    const cfg = table[0];
    // Zajistit výchozí hodnotu pro nové pole
    if (cfg.require_dept_leader_approval === undefined || cfg.require_dept_leader_approval === '') {
      cfg.require_dept_leader_approval = 'false';
    }
    if (cfg.anniversary_milestones === undefined || cfg.anniversary_milestones === '') {
      cfg.anniversary_milestones = '[10,15,20,40]';
    }
    return cfg;
  },

  /**
   * Získá konfiguraci zobrazení úseku v kalendáři.
   */
  getSectionViewConfig: function(sectionId) {
    if (!sectionId) return { section_id: '', show_leader_first: false, containers: [] };
    const coreSS = DB.getCore();
    // Zajistíme, že list existuje
    let sheet = coreSS.getSheetByName(DB_SHEETS.CORE.SECTION_VIEW_CONFIG);
    if (!sheet) {
      sheet = coreSS.insertSheet(DB_SHEETS.CORE.SECTION_VIEW_CONFIG);
      if (typeof Setup !== 'undefined') Setup.setHeaders(sheet, DB_SHEETS.CORE.SECTION_VIEW_CONFIG);
    }
    const table = DB.getTable(coreSS, DB_SHEETS.CORE.SECTION_VIEW_CONFIG);
    const row = table.find(function(r) { return r.section_id === sectionId; });
    if (!row) return { section_id: sectionId, show_leader_first: false, containers: [] };
    let containers = [];
    try { containers = JSON.parse(row.config_json || '[]'); } catch(e) { containers = []; }
    return {
      section_id: sectionId,
      show_leader_first: row.show_leader_first === 'true',
      containers: containers
    };
  },

  /**
   * Uloží konfiguraci zobrazení úseku.
   */
  saveSectionViewConfig: function(data) {
    if (!data || !data.section_id) return { success: false, error: 'Chybí section_id.' };
    const configJson = JSON.stringify(data.containers || []);
    return this.updateEntity(DB_SHEETS.CORE.SECTION_VIEW_CONFIG, 'section_id', {
      section_id: data.section_id,
      show_leader_first: String(data.show_leader_first === true || data.show_leader_first === 'true'),
      config_json: configJson
    });
  },

  // ─── MAPY KANCELÁŘÍ ─────────────────────────────────────────────────────────

  /**
   * Vrátí všechny aktivní mapy pro daný úsek.
   */
  getOfficeMaps: function(sectionId) {
    if (!Auth.getCurrentUser()) throw new Error("Neautorizováno.");
    const coreSS = DB.getCore();
    let sheet = coreSS.getSheetByName(DB_SHEETS.CORE.OFFICE_MAPS);
    if (!sheet) {
      sheet = coreSS.insertSheet(DB_SHEETS.CORE.OFFICE_MAPS);
      if (typeof Setup !== 'undefined') Setup.setHeaders(sheet, DB_SHEETS.CORE.OFFICE_MAPS);
    }
    const table = DB.getTable(coreSS, DB_SHEETS.CORE.OFFICE_MAPS);
    return table
      .filter(function(m) { return (!sectionId || m.section_id === sectionId) && m.active !== 'false'; })
      .map(function(m) {
        var cells = [];
        try { cells = JSON.parse(m.cells_json || '[]'); } catch(e) { cells = []; }
        return {
          map_id: m.map_id,
          section_id: m.section_id,
          name: m.name,
          rows: parseInt(m.rows) || 5,
          cols: parseInt(m.cols) || 8,
          cells: cells,
          active: m.active
        };
      });
  },

  /**
   * Uloží (vytvoří nebo aktualizuje) mapu kanceláře.
   */
  saveOfficeMap: function(data) {
    if (!data || !data.section_id) return { success: false, error: 'Chybí section_id.' };
    return this.updateEntity(DB_SHEETS.CORE.OFFICE_MAPS, 'map_id', {
      map_id: data.map_id || '',
      section_id: data.section_id,
      name: data.name || 'Mapa kanceláře',
      rows: String(parseInt(data.rows) || 5),
      cols: String(parseInt(data.cols) || 8),
      cells_json: JSON.stringify(data.cells || []),
      active: 'true'
    });
  },

  /**
   * Soft-smaže mapu kanceláře.
   */
  deleteOfficeMap: function(mapId) {
    if (!mapId) return { success: false, error: 'Chybí map_id.' };
    return this.updateEntity(DB_SHEETS.CORE.OFFICE_MAPS, 'map_id', { map_id: mapId, active: 'false' });
  },

  // ─── REZERVACE STOLŮ ─────────────────────────────────────────────────────

  getMapReservationsForMonth: function(mapId, yearMonth) {
    if (!mapId || !yearMonth) return [];
    
    // Hledáme list v CORE i TRANSACTION sešitu (pro jistotu, default je TRANSACTION)
    const coreSS = DB.getCore();
    const transSS = DB.getTransaction();
    let sheet = coreSS.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    let ss = coreSS;
    if (!sheet) {
      sheet = transSS.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
      ss = transSS;
    }
    
    if (!sheet) {
      // Pokud vůbec neexistuje, vytvoříme ho v TRANSACTION
      sheet = transSS.insertSheet(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
      if (typeof Setup !== 'undefined') Setup.setHeaders(sheet, DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
      return [];
    }

    const table = DB.getTable(ss, DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    const targetMonth = String(yearMonth).substring(0, 7);

    return table.filter(function(r) {
      return r.map_id === mapId && String(r.active) !== 'false' &&
             r.date && String(r.date).substring(0, 7) === targetMonth;
    });
  },

  saveMapReservation: function(data) {
    if (!data || !data.map_id || !data.cell_id || !data.user_id || !data.date)
      return { success: false, error: 'Chybějí povinné parametry.' };
    
    // Hledáme list v CORE i TRANSACTION
    const coreSS = DB.getCore();
    const transSS = DB.getTransaction();
    let sheet = coreSS.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    let ss = coreSS;
    if (!sheet) {
      sheet = transSS.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
      ss = transSS;
    }

    if (!sheet) {
      sheet = transSS.insertSheet(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
      ss = transSS;
      if (typeof Setup !== 'undefined') Setup.setHeaders(sheet, DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    }
    const table = DB.getTable(ss, DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    
    // Normalizujeme datum z požadavku
    const targetDate = String(data.date).substring(0, 10);
    const targetUserId = String(data.user_id).trim();

    // Najdeme JAKOUKOLIV aktivní rezervaci uživatele na tento den (i na jiné mapě)
    const existing = table.find(function(r) {
      const rDate = String(r.date).substring(0, 10);
      return String(r.user_id).trim() === targetUserId && rDate === targetDate && String(r.active) !== 'false';
    });

    const payload = {
      reservation_id: existing ? existing.reservation_id : '',
      map_id: data.map_id,
      cell_id: data.cell_id,
      user_id: data.user_id,
      date: targetDate, // Uložíme čistý formát YYYY-MM-DD
      active: true      // Uložíme jako boolean pro checkbox
    };
    return this.updateEntity(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS, 'reservation_id', payload);
  },

  clearUserReservations: function(userId, date) {
    if (!userId || !date) return;
    
    const coreSS = DB.getCore();
    const transSS = DB.getTransaction();
    let sheet = coreSS.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    let activeSS = coreSS;
    if (!sheet) {
      sheet = transSS.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
      activeSS = transSS;
    }
    if (!sheet) return;

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const uidIdx = headers.indexOf('user_id');
    const dateIdx = headers.indexOf('date');
    const actIdx = headers.indexOf('active');

    if (uidIdx === -1 || dateIdx === -1 || actIdx === -1) return;

    // Totální normalizace cílového data na YYYY-MM-DD
    const targetDateStr = (date instanceof Date) 
      ? Utilities.formatDate(date, activeSS.getSpreadsheetTimeZone(), "yyyy-MM-dd")
      : String(date).substring(0, 10);
    
    const targetUserId = String(userId).trim();

    let changedCount = 0;
    for (let i = 1; i < data.length; i++) {
      // Normalizace data v aktuálním řádku
      let rowDate = data[i][dateIdx];
      let rowDateStr = "";
      if (rowDate instanceof Date) {
        rowDateStr = Utilities.formatDate(rowDate, activeSS.getSpreadsheetTimeZone(), "yyyy-MM-dd");
      } else {
        rowDateStr = String(rowDate).substring(0, 10);
      }

      const rowUserId = String(data[i][uidIdx]).trim();
      const rowActiveRaw = String(data[i][actIdx]).toUpperCase();
      const isActive = (rowActiveRaw === 'TRUE' || rowActiveRaw === '1');

      if (rowUserId === targetUserId && rowDateStr === targetDateStr && isActive) {
        // Zápis přímo do buňky jako Boolean FALSE (odškrtne checkbox)
        sheet.getRange(i + 1, actIdx + 1).setValue(false);
        changedCount++;
      }
    }
    
    if (changedCount > 0) SpreadsheetApp.flush();
  },


  deleteMapReservation: function(mapId, userId, date) {
    if (!mapId || !userId || !date) return { success: false, error: 'Chybějí parametry.' };
    
    // Hledáme list v CORE i TRANSACTION
    const coreSS = DB.getCore();
    const transSS = DB.getTransaction();
    let sheet = coreSS.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    let ss = coreSS;
    if (!sheet) {
      sheet = transSS.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
      ss = transSS;
    }
    
    if (!sheet) return { success: true };
    
    const table = DB.getTable(ss, DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    const targetDate = String(date).substring(0, 10);
    const targetUserId = String(userId).trim();

    const existing = table.find(function(r) {
      const rDate = String(r.date).substring(0, 10);
      return r.map_id === mapId && String(r.user_id).trim() === targetUserId && rDate === targetDate && String(r.active) !== 'false';
    });
    
    if (!existing) return { success: true };
    return this.updateEntity(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS, 'reservation_id', {
      reservation_id: existing.reservation_id, active: 'false'
    });
  },

    /**
     * Získá jmeniny z databáze (nebo je nainicializuje z CalendarData).
     */
    getNamedDays: function() {
      // Čtení je povoleno všem přihlášeným uživatelům
      if (!Auth.getCurrentUser()) throw new Error("Neautorizováno.");
      
      const coreSS = DB.getCore();
      let sheet = coreSS.getSheetByName(DB_SHEETS.CORE.NAMED_DAYS);
      
      // Pokud list neexistuje nebo je prázdný a uživatel je ADMIN, provedeme seedování
      if ((!sheet || sheet.getLastRow() <= 1) && Auth.hasAdminAccess()) {
        if (!sheet) {
          sheet = coreSS.insertSheet(DB_SHEETS.CORE.NAMED_DAYS);
        }
        if (sheet.getLastRow() === 0) {
          sheet.getRange(1, 1, 1, 2).setValues([["date_key", "name"]]).setFontWeight("bold");
        }
        
        if (sheet.getLastRow() <= 1) {
          const data = [];
          for (let key in CalendarData.NAMED_DAYS) {
            data.push([key, CalendarData.NAMED_DAYS[key]]);
          }
          if (data.length > 0) {
            sheet.getRange(2, 1, data.length, 2).setValues(data);
            sheet.getRange(2, 1, data.length, 1).setNumberFormat("@");
          }
        }
      }
      
      // Pokud list stále neexistuje nebo je prázdný (pro ne-adminy), vrátíme výchozí hardcoded data
      if (!sheet || sheet.getLastRow() <= 1) {
        return CalendarData.NAMED_DAYS;
      }
      
      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const keyIdx = headers.indexOf('date_key');
      const nameIdx = headers.indexOf('name');
      
      const res = {};
      for (let i = 1; i < data.length; i++) {
        let key = data[i][keyIdx];
        // Pokud Google Sheets převedl key na Date objekt, musíme jej převést zpět na MM-DD string
        if (key instanceof Date) {
          const m = String(key.getMonth() + 1).padStart(2, '0');
          const d = String(key.getDate()).padStart(2, '0');
          key = m + "-" + d;
        } else if (key) {
          key = String(key).trim();
        }
        
        if (key) {
          res[key] = data[i][nameIdx] || "";
        }
      }
      return res;
    },

    saveNamedDay: function(dateKey, name) {
      const coreSS = DB.getCore();
      const sheet = coreSS.getSheetByName(DB_SHEETS.CORE.NAMED_DAYS);
      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const keyIdx = headers.indexOf('date_key');
      const nameIdx = headers.indexOf('name');
      
      for (let i = 1; i < data.length; i++) {
        let rowKey = data[i][keyIdx];
        if (rowKey instanceof Date) {
          const m = String(rowKey.getMonth() + 1).padStart(2, '0');
          const d = String(rowKey.getDate()).padStart(2, '0');
          rowKey = m + "-" + d;
        } else {
          rowKey = String(rowKey).trim();
        }

        if (rowKey === dateKey) {
          sheet.getRange(i + 1, nameIdx + 1).setValue(name);
          return { success: true };
        }
      }
      DB.insertRow(coreSS, DB_SHEETS.CORE.NAMED_DAYS, { date_key: dateKey, name: name });
      return { success: true };
    },

    saveVacationConfig: function(data) {
    const coreSS = DB.getCore();
    let sheet = coreSS.getSheetByName(DB_SHEETS.CORE.VACATION_CONFIG);
    const correctHeaders = ["system_type", "global_days", "base_days", "max_extra_days", "require_dept_leader_approval", "anniversary_milestones"];

    if (!sheet) {
      sheet = coreSS.insertSheet(DB_SHEETS.CORE.VACATION_CONFIG);
    }

    // Přepíšeme natvrdo hlavičky (zajistí i migraci starých DB bez nového sloupce)
    sheet.getRange(1, 1, 1, correctHeaders.length).setValues([correctHeaders]).setFontWeight("bold");

    // Vytvoříme pole hodnot přesně v pořadí sloupců
    const rowData = correctHeaders.map(h => data[h] !== undefined ? data[h] : '');
    sheet.getRange(2, 1, 1, correctHeaders.length).setValues([rowData]);

    return { success: true };
  },

  /**
   * Načte konfiguraci oprávnění (RBAC) z databáze.
   */
  getRbacConfig: function() {
    const ss = DB.getCore();
    const rows = DB.getTable(ss, DB_SHEETS.CORE.RBAC_CONFIG);
    const parseValue = (val) => {
      const s = String(val).toUpperCase();
      if (s === 'TRUE') return true;
      if (s === 'FALSE' || s === '') return false;
      return val; // pro 'OWN_DEPARTMENT', 'NONE', 'ALL' atd.
    };

    const config = {};
    rows.forEach(r => {
      config[r.rbac_key] = {
        USER: parseValue(r.USER),
        LEADER: parseValue(r.LEADER),
        ADMIN: parseValue(r.ADMIN),
        SUPERADMIN: parseValue(r.SUPERADMIN)
      };
    });
    return config;
  },

  /**
   * Uloží konfiguraci oprávnění (RBAC) do databáze.
   */
  saveRbacConfig: function(config) {
    if (!Auth.hasSystemRole(ROLES.SYSTEM.SUPERADMIN)) throw new Error("Pouze SUPERADMIN může měnit oprávnění.");
    
    const ss = DB.getCore();
    let sheet = ss.getSheetByName(DB_SHEETS.CORE.RBAC_CONFIG);
    if (!sheet) {
      sheet = ss.insertSheet(DB_SHEETS.CORE.RBAC_CONFIG);
      Setup.setHeaders(sheet, DB_SHEETS.CORE.RBAC_CONFIG);
    }

    // Smazat stará data (kromě hlavičky)
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastHeaderColumn ? sheet.getLastHeaderColumn() : 5).clearContent();
    }

    const prepareValue = (val) => {
      if (val === true || val === 'true') return true;
      if (val === false || val === 'false') return false;
      return val || false;
    };

    const rows = [];
    for (let key in config) {
      rows.push([
        key,
        prepareValue(config[key].USER),
        prepareValue(config[key].LEADER),
        prepareValue(config[key].ADMIN),
        prepareValue(config[key].SUPERADMIN)
      ]);
    }

    if (rows.length > 0) {
      // Důležité: Vyčistit stávající ověření dat (checkboxy), protože nyní do sloupců B-E ukládáme scope stringy
      if (sheet.getLastRow() > 1) {
        sheet.getRange(2, 2, sheet.getLastRow() - 1, 4).setDataValidation(null);
      }
      sheet.getRange(2, 1, rows.length, 5).setValues(rows);
    }
    return true;
  }
};

/**
 * Serverové funkce volané z UI.
 */
function getRbacConfig() {
  try {
    return { success: true, data: Admin.getRbacConfig() };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function saveRbacConfig(config) {
  try {
    return { success: true, data: Admin.saveRbacConfig(config) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}
function addDepartment(name, sectionId) {
  try {
    return { success: true, data: Admin.addDepartment(name, sectionId) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Serverová funkce pro uložení úseku a současné dokončení instalace (pro Wizard).
 */
function wizardSaveAndComplete(name, locationId) {
  try {
    // 1. Vytvoříme pouze úsek (Section)
    const section = Admin.addSection(name, locationId);
    
    // 2. Dokončíme setup a přiřadíme uživatele k tomuto úseku
    const setupResult = Admin.completeSetup({ 
      section_id: section.section_id
    });
    return { success: true, data: { url: setupResult.url } };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}
function getAdminOrgData() {
  try {
    return { success: true, data: Admin.getOrgData() };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function addLocation(name, type) {
  try {
    return { success: true, data: Admin.addLocation(name, type) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function updateLocation(data) {
  try {
    return Admin.updateEntity(DB_SHEETS.CORE.LOCATIONS, 'location_id', data);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function deleteLocation(locationId) {
  try {
    Admin.deleteLocation(locationId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function addSection(name, locationId) {
  try {
    return { success: true, data: Admin.addSection(name, locationId) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function getAllUsers() {
  try {
    return { success: true, data: Admin.getAllUsers() };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function updateUser(userId, data) {
  try {
    // Pokud je voláno jen s jedním argumentem (objektem), posuneme to
    if (typeof userId === 'object' && data === undefined) {
      data = userId;
      userId = data.user_id;
    }
    
    // Ověření oprávnění
    const currentUser = Auth.getCurrentUser();
    const myRole = currentUser?.system_role || 'USER';
    const roleWeights = { 'USER': 1, 'LEADER': 2, 'ADMIN': 3, 'SUPERADMIN': 100 };
    const myWeight = roleWeights[myRole] || 0;

    if (!Auth.hasAdminAccess(currentUser)) {
      if (!userId || userId !== currentUser.user_id) {
        throw new Error("Můžete upravovat pouze vlastní profil.");
      }
      // Omezení polí pro běžného uživatele
      delete data.org_role;
      delete data.section_id;
      delete data.department_id;
      delete data.group_id;
    } else if (myRole !== 'SUPERADMIN') {
      // ── ROLE HIERARCHY CHECK ──
      // 1. Nemůže editovat někoho se stejnou nebo vyšší rolí
      if (userId && userId !== currentUser.user_id) {
        const users = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
        const targetUser = users.find(u => u.user_id === userId);
        if (targetUser) {
          const targetWeight = roleWeights[targetUser.system_role] || 1;
          if (targetWeight >= myWeight) {
            throw new Error("Nemáte oprávnění editovat uživatele se stejnou nebo vyšší rolí (" + targetUser.system_role + ").");
          }
        }
      }
      // 2. Nemůže přidělit roli vyšší nebo stejnou jako má on sám
      if (data.system_role) {
         if (roleWeights[data.system_role] >= myWeight) {
           throw new Error("Nemáte oprávnění přidělit roli " + data.system_role + ".");
         }
      }
    }

    return { success: true, data: Admin.updateUser(userId, data) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Zapne nebo vypne synchronizaci Google Kalendáře pro přihlášeného uživatele.
 * Volá CalendarSync.enable/disable, které vytvoří nebo smažou Google Kalendář.
 *
 * @param {string}  type    – 'personal' | 'team'
 * @param {boolean} enabled – true = zapnout, false = vypnout
 */
function toggleCalendarSync(type, enabled) {
  try {
    var currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: 'Uživatel není přihlášen.' };

    var userId = currentUser.user_id;
    var email  = currentUser.email;
    var name   = ((currentUser.first_name || '') + ' ' + (currentUser.last_name || '')).trim();

    if (type === 'personal') {
      return enabled
        ? CalendarSync.enablePersonalSync(userId, email, name)
        : CalendarSync.disablePersonalSync(userId);
    }

    if (type === 'team') {
      // Pouze pro vedoucí pracovníky
      var managerRoles = [
        ROLES.ORG.SECTION_LEADER, ROLES.ORG.SECTION_DEPUTY,
        ROLES.ORG.DEPT_LEADER,    ROLES.ORG.DEPT_DEPUTY
      ];
      if (!Auth.hasAdminAccess(currentUser) && managerRoles.indexOf(currentUser.org_role) === -1) {
        return { success: false, error: 'Nedostatečná oprávnění pro synchronizaci týmového kalendáře.' };
      }
      return enabled
        ? CalendarSync.enableTeamSync(userId, email, name)
        : CalendarSync.disableTeamSync(userId);
    }

    if (type === 'planner') {
      return enabled
        ? CalendarSync.enablePlannerSync(userId, email, name)
        : CalendarSync.disablePlannerSync(userId);
    }

    return { success: false, error: 'Neznámý typ synchronizace: ' + type };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function updateSection(data) {
  try {
    const user = Auth.getCurrentUser();
    if (user.system_role !== 'SUPERADMIN') {
      const scope = Auth.hasPermission('manage_org');
      if (scope === 'NONE') throw new Error("Nemáte oprávnění spravovat org. strukturu.");
      if (scope === 'OWN_SECTION' || scope === 'OWN_DEPARTMENT') {
        if (data.section_id !== user.section_id) throw new Error("Můžete spravovat pouze svůj vlastní úsek.");
      }
    }
    return Admin.updateEntity(DB_SHEETS.CORE.SECTIONS, 'section_id', data);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function updateDepartment(data) {
  try {
    const user = Auth.getCurrentUser();
    if (user.system_role !== 'SUPERADMIN') {
      const scope = Auth.hasPermission('manage_org');
      if (scope === 'NONE') throw new Error("Nemáte oprávnění spravovat org. strukturu.");
      if (scope === 'OWN_SECTION') {
        // Musí patřit do stejného úseku
        const depts = DB.getTable(DB.getCore(), DB_SHEETS.CORE.DEPARTMENTS);
        const target = depts.find(d => d.department_id === data.department_id);
        if (target && target.section_id !== user.section_id) throw new Error("Oddělení nepatří do vašeho úseku.");
        if (data.section_id && data.section_id !== user.section_id) throw new Error("Nemůžete přesunout oddělení mimo svůj úsek.");
      } else if (scope === 'OWN_DEPARTMENT') {
        if (data.department_id !== user.department_id) throw new Error("Můžete spravovat pouze své vlastní oddělení.");
      }
    }
    return Admin.updateEntity(DB_SHEETS.CORE.DEPARTMENTS, 'department_id', data);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function updateGroup(data) {
  try {
    const user = Auth.getCurrentUser();
    if (user.system_role !== 'SUPERADMIN') {
      const scope = Auth.hasPermission('manage_org');
      if (scope === 'NONE') throw new Error("Nemáte oprávnění spravovat org. strukturu.");
      if (scope === 'OWN_SECTION') {
        const groups = DB.getTable(DB.getCore(), DB_SHEETS.CORE.GROUPS);
        const target = groups.find(g => g.group_id === data.group_id);
        if (target) {
            const depts = DB.getTable(DB.getCore(), DB_SHEETS.CORE.DEPARTMENTS);
            const dept = depts.find(d => d.department_id === target.department_id);
            if (dept && dept.section_id !== user.section_id) throw new Error("Tým nepatří do vašeho úseku.");
        }
      } else if (scope === 'OWN_DEPARTMENT') {
        const groups = DB.getTable(DB.getCore(), DB_SHEETS.CORE.GROUPS);
        const target = groups.find(g => g.group_id === data.group_id);
        if (target && target.department_id !== user.department_id) throw new Error("Tým nepatří do vašeho oddělení.");
        if (data.department_id && data.department_id !== user.department_id) throw new Error("Nemůžete přesunout tým mimo své oddělení.");
      }
    }
    return Admin.updateEntity(DB_SHEETS.CORE.GROUPS, 'group_id', data);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function deleteUser(userId) {
  try {
    const currentUser = Auth.getCurrentUser();
    const myRole = currentUser?.system_role || 'USER';
    if (!Auth.hasAdminAccess(currentUser)) throw new Error("Nedostatečná oprávnění.");

    // Role hierarchy check
    if (myRole !== 'SUPERADMIN') {
        const users = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
        const targetUser = users.find(u => u.user_id === userId);
        if (targetUser) {
           const roleWeights = { 'USER': 1, 'LEADER': 2, 'ADMIN': 3, 'SUPERADMIN': 100 };
           if (roleWeights[targetUser.system_role] >= roleWeights[myRole]) {
               throw new Error("Nemáte oprávnění smazat uživatele se stejnou nebo vyšší rolí.");
           }
        }
    }
    return { success: true, data: Admin.deleteUser(userId) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}
function repairDatabaseHeaders() {
  try {
    return { success: true, data: Setup.repairDatabaseHeaders() };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function updatePosition(data) {
  try {
    return Admin.updateEntity(DB_SHEETS.CORE.POSITIONS, 'position_id', data);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function getAttendanceStatuses() {
  try {
    return { success: true, data: Admin.getAttendanceStatuses() };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function updateAttendanceStatus(data) {
  try {
    return Admin.updateEntity(DB_SHEETS.CORE.ATTENDANCE_STATUSES, 'status_id', data);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function deleteAttendanceStatus(statusId) {
  try {
    Admin.deleteAttendanceStatus(statusId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function saveVacationConfig(data) {
  try {
    return Admin.saveVacationConfig(data);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function getSectionViewConfig(sectionId) {
  try {
    return { success: true, data: Admin.getSectionViewConfig(sectionId) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function saveSectionViewConfig(data) {
  try {
    return Admin.saveSectionViewConfig(data);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function getOfficeMaps(sectionId) {
  try {
    return { success: true, data: Admin.getOfficeMaps(sectionId) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function saveOfficeMap(data) {
  try {
    return Admin.saveOfficeMap(data);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function deleteOfficeMap(mapId) {
  try {
    return Admin.deleteOfficeMap(mapId);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function getMapReservationsForMonth(mapId, yearMonth) {
  try {
    return { success: true, data: Admin.getMapReservationsForMonth(mapId, yearMonth) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function getNamedDays() {
  try {
    return { success: true, data: Admin.getNamedDays() };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function saveNamedDay(dateKey, name) {
  try {
    return Admin.saveNamedDay(dateKey, name);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function saveMapReservation(data) {
  try {
    return Admin.saveMapReservation(data);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function deleteMapReservation(mapId, userId, date) {
  try {
    return Admin.deleteMapReservation(mapId, userId, date);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}
