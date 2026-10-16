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
      privacySettings: this.getPrivacySettings(),
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
   * Hromadně aktualizuje marketingové kampaně v listu MARKETING_WEEKS.
   */
  updateMarketingWeeks: function (rows) {
    if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
    const coreSS = DB.getCore();
    const sheetName = DB_SHEETS.CORE.MARKETING_WEEKS;
    let sheet = coreSS.getSheetByName(sheetName);

    if (!sheet) {
      // Pokud list neexistuje, vytvoříme ho
      sheet = coreSS.insertSheet(sheetName);
    }

    const data = [["kt", "monday", "thursday"]];
    // Seřadit podle KT
    rows.sort((a, b) => Number(a.kt) - Number(b.kt));

    // Text začínající = + - @ by Sheets uložil jako vzorec
    const asText = v => (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v;
    rows.forEach(row => {
      if (row.kt) {
        data.push([row.kt, asText(row.monday || ""), asText(row.thursday || "")]);
      }
    });

    sheet.clearContents();
    if (data.length > 1) {
      sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
    } else {
      sheet.getRange(1, 1, 1, data[0].length).setValues(data);
    }
    DB.clearCache(DB_SHEETS.CORE.MARKETING_WEEKS);
    return { success: true };
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
    return this._writeEntity(sheetName, idField, data);
  },

  /**
   * Zápis entity BEZ kontroly oprávnění. Volat jen z cest, které oprávnění
   * ověřily samy (vlastní profil, synchronizace kalendáře, rezervace stolů).
   * @param {string} sheetName - List v CORE DB.
   * @param {string} idField - Název sloupce s ID.
   * @param {Object} data - Zapisovaná pole (s ID = úprava, bez ID = nový záznam).
   * @returns {{success: boolean, id: string}}
   */
  _writeEntity: function(sheetName, idField, data) {
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
      // Zápis jde mimo DB.insertRow, takže mezipaměť je nutné zneplatnit ručně
      DB.clearCache(sheetName);
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
      let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      let schemaChanged = false;
      const required = [
        'text_color',
        'category',
        'work_time_bg_color',
        'work_time_text_color',
        'status_kind',
        'masked_status_id',
        'retention_category'
      ];
      required.forEach(function(header) {
        if (headers.indexOf(header) === -1) {
          sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header).setFontWeight('bold');
          headers.push(header);
          schemaChanged = true;
        }
      });
      if (schemaChanged) DB.clearCache(DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    }
    const statuses = DB.getTable(coreSS, DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    return statuses.map(function(s) {
      if (!s.status_kind) s.status_kind = 'NORMAL';
      if (!s.retention_category) s.retention_category = s.is_vacation === 'true' ? 'YEAR_END' : 'SHORT_TERM';
      if (!s.work_time_bg_color) s.work_time_bg_color = '#1f2937';
      if (!s.work_time_text_color) s.work_time_text_color = '#ffffff';
      return s;
    });
  },

  /**
   * Vrátí globální nastavení GDPR maskování statusů.
   */
  getPrivacySettings: function() {
    if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
    const props = PropertiesService.getScriptProperties();
    return {
      masking_enabled: props.getProperty(CONFIG.PROP_PRIVACY_MASKING_ENABLED) === 'true'
    };
  },

  /**
   * Uloží globální nastavení GDPR maskování statusů.
   */
  savePrivacySettings: function(data) {
    if (!Auth.hasAdminAccess()) throw new Error("Nedostatečná oprávnění.");
    const enabled = data && (data.masking_enabled === true || data.masking_enabled === 'true');
    PropertiesService.getScriptProperties().setProperty(
      CONFIG.PROP_PRIVACY_MASKING_ENABLED,
      enabled ? 'true' : 'false'
    );
    return this.getPrivacySettings();
  },

  /**
   * Uloží docházkový nebo maskovací status a doplní bezpečné výchozí hodnoty.
   */
  updateAttendanceStatus: function(data) {
    if (!data) data = {};
    data.status_kind = data.status_kind === 'MASK' ? 'MASK' : 'NORMAL';
    if (!data.retention_category) {
      data.retention_category = data.is_vacation === 'true' ? 'YEAR_END' : 'SHORT_TERM';
    }
    if (data.status_kind === 'MASK') {
      data.masked_status_id = '';
      data.requires_approval = 'false';
      data.allows_desk_reservation = 'false';
      data.allows_note = 'false';
      data.is_vacation = 'false';
      data.shows_work_time = 'false';
      data.work_time_bg_color = '';
      data.work_time_text_color = '';
      if (!data.category) data.category = 'Ostatní';
    } else {
      if (!data.work_time_bg_color) data.work_time_bg_color = '#1f2937';
      if (!data.work_time_text_color) data.work_time_text_color = '#ffffff';
    }
    return this.updateEntity(DB_SHEETS.CORE.ATTENDANCE_STATUSES, 'status_id', data);
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
    const maskedIdx = headers.indexOf('masked_status_id');
    if (maskedIdx !== -1) {
      for (var refI = 1; refI < data.length; refI++) {
        if (data[refI][maskedIdx] === statusId) {
          throw new Error("Maskovací status je použitý u jiného statusu. Nejdříve zrušte jeho vazby.");
        }
      }
    }
    for (var i = 1; i < data.length; i++) {
      if (data[i][idIdx] === statusId) {
        sheet.deleteRow(i + 1);
        DB.clearCache(DB_SHEETS.CORE.ATTENDANCE_STATUSES);
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
        anniversary_milestones: '[10,15,20,40]',
        calendar_sync_map: '{}'
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
    if (cfg.calendar_sync_map === undefined || cfg.calendar_sync_map === '') {
      cfg.calendar_sync_map = '{}';
    }
    return cfg;
  },

  /**
   * Získá konfiguraci zobrazení úseku v kalendáři.
   */
  getSectionViewConfig: function(sectionId) {
    if (!sectionId) return { section_id: '', show_leader_first: false, show_team_headers: false, show_no_department_row: true, containers: [] };
    const coreSS = DB.getCore();
    // Zajistíme, že list existuje
    let sheet = coreSS.getSheetByName(DB_SHEETS.CORE.SECTION_VIEW_CONFIG);
    if (!sheet) {
      sheet = coreSS.insertSheet(DB_SHEETS.CORE.SECTION_VIEW_CONFIG);
      if (typeof Setup !== 'undefined') Setup.setHeaders(sheet, DB_SHEETS.CORE.SECTION_VIEW_CONFIG);
    }
    const table = DB.getTable(coreSS, DB_SHEETS.CORE.SECTION_VIEW_CONFIG);
    const row = table.find(function(r) { return r.section_id === sectionId; });
    if (!row) return { section_id: sectionId, show_leader_first: false, show_team_headers: false, show_no_department_row: true, containers: [] };
    let containers = [];
    try { containers = JSON.parse(row.config_json || '[]'); } catch(e) { containers = []; }
    return {
      section_id: sectionId,
      show_leader_first: row.show_leader_first === 'true',
      show_team_headers: row.show_team_headers === 'true',
      // Chybějící sloupec (starší řádky před zavedením přepínače) = zachovat dosavadní chování (zobrazeno)
      show_no_department_row: row.show_no_department_row === '' || row.show_no_department_row === undefined ? true : row.show_no_department_row === 'true',
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
      show_team_headers: String(data.show_team_headers === true || data.show_team_headers === 'true'),
      show_no_department_row: String(data.show_no_department_row !== false && data.show_no_department_row !== 'false'),
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
    let sheet = coreSS.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    let ss = coreSS;
    if (!sheet) {
      sheet = DB.getTransaction().getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
      ss = DB.getTransaction();
    }
    
    if (!sheet) {
      // Pokud vůbec neexistuje, vytvoříme ho v TRANSACTION
      sheet = DB.getTransaction().insertSheet(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
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

  /**
   * Vrátí rezervace pro několik měsíců najednou, seskupené podle "YYYY-MM".
   * List se čte jednou pro celý rozsah místo jednou za každý měsíc.
   */
  getMapReservationsForRange: function(mapId, yearMonths) {
    const result = {};
    (yearMonths || []).forEach(function(ym) { result[String(ym).substring(0, 7)] = []; });
    if (!mapId || Object.keys(result).length === 0) return result;

    const storage = this._getMapReservationStorage();
    const table = DB.getTable(storage.ss, DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);

    table.forEach(function(r) {
      if (r.map_id !== mapId || String(r.active) === 'false' || !r.date) return;
      const ym = String(r.date).substring(0, 7);
      if (result[ym]) result[ym].push(r);
    });
    return result;
  },

  _getMapReservationStorage: function() {
    const coreSS = DB.getCore();
    let sheet = coreSS.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    let ss = coreSS;
    if (!sheet) {
      sheet = DB.getTransaction().getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
      ss = DB.getTransaction();
    }
    if (!sheet) {
      sheet = DB.getTransaction().insertSheet(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
      ss = DB.getTransaction();
      if (typeof Setup !== 'undefined') Setup.setHeaders(sheet, DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    }
    return { ss: ss, sheet: sheet };
  },

  _findOfficeMapById: function(mapId) {
    const maps = this.getOfficeMaps('');
    return maps.find(function(m) { return String(m.map_id) === String(mapId); }) || null;
  },

  _deskOwnerNeedsDesk: function(ownerUserId, date) {
    if (!ownerUserId || !date) return { hasEntries: false, needsDesk: false };
    const targetDate = String(date).substring(0, 10);
    const statuses = DB.getTable(DB.getCore(), DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    const deskStatusIds = {};
    statuses.forEach(function(s) {
      if (String(s.allows_desk_reservation).toLowerCase() === 'true') {
        deskStatusIds[String(s.status_id)] = true;
      }
    });

    const attendance = DB.getTable(DB.getTransaction(), DB_SHEETS.TRANSACTION.ATTENDANCE);
    const entries = attendance.filter(function(a) {
      return String(a.user_id) === String(ownerUserId) &&
             String(a.date || '').substring(0, 10) === targetDate &&
             String(a.approved || '').toLowerCase() !== 'rejected';
    });

    return {
      hasEntries: entries.length > 0,
      needsDesk: entries.some(function(e) { return !!deskStatusIds[String(e.status_id)]; })
    };
  },

  saveMapReservation: function(data) {
    if (!data || !data.map_id || !data.cell_id || !data.user_id || !data.date)
      return { success: false, error: 'Chybějí povinné parametry.' };

    const storage = this._getMapReservationStorage();
    const ss = storage.ss;
    const table = DB.getTable(ss, DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    
    // Normalizujeme datum z požadavku
    const targetDate = String(data.date).substring(0, 10);
    const targetUserId = String(data.user_id).trim();
    const targetCellId = String(data.cell_id).trim();

    const officeMap = this._findOfficeMapById(data.map_id);
    if (!officeMap) return { success: false, error: 'Mapa kanceláře nebyla nalezena.' };
    const cell = (officeMap.cells || []).find(function(c) { return String(c.id) === targetCellId; });
    if (!cell || cell.type !== 'desk') return { success: false, error: 'Vybrané místo není stůl.' };

    const occupiedByOtherReservation = table.find(function(r) {
      const rDate = String(r.date).substring(0, 10);
      return String(r.map_id) === String(data.map_id) &&
             String(r.cell_id).trim() === targetCellId &&
             rDate === targetDate &&
             String(r.user_id).trim() !== targetUserId &&
             String(r.active) !== 'false';
    });
    if (occupiedByOtherReservation) {
      return { success: false, error: 'Tento stůl už má v daný den jinou rezervaci.' };
    }

    if (cell.permanent_user_id && String(cell.permanent_user_id) !== targetUserId) {
      const ownerState = this._deskOwnerNeedsDesk(cell.permanent_user_id, targetDate);
      if (!ownerState.hasEntries) {
        return { success: false, error: 'Pevný uživatel tohoto stolu nemá na daný den zadaný status.' };
      }
      if (ownerState.needsDesk) {
        return { success: false, error: 'Pevný uživatel tohoto stolu je v daný den v kanceláři.' };
      }
    }

    // Najdeme JAKOUKOLIV aktivní rezervaci uživatele na tento den (i na jiné mapě)
    const existing = table.find(function(r) {
      const rDate = String(r.date).substring(0, 10);
      return String(r.user_id).trim() === targetUserId && rDate === targetDate && String(r.active) !== 'false';
    });

    const payload = {
      reservation_id: existing ? existing.reservation_id : '',
      map_id: data.map_id,
      cell_id: targetCellId,
      user_id: data.user_id,
      date: targetDate, // Uložíme čistý formát YYYY-MM-DD
      active: true      // Uložíme jako boolean pro checkbox
    };
    return this._writeEntity(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS, 'reservation_id', payload);
  },

  clearUserReservations: function(userId, date) {
    if (!userId || !date) return;
    
    const coreSS = DB.getCore();
    let sheet = coreSS.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    let activeSS = coreSS;
    if (!sheet) {
      sheet = DB.getTransaction().getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
      activeSS = DB.getTransaction();
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
    let sheet = coreSS.getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
    let ss = coreSS;
    if (!sheet) {
      sheet = DB.getTransaction().getSheetByName(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS);
      ss = DB.getTransaction();
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
    return this._writeEntity(DB_SHEETS.TRANSACTION.MAP_RESERVATIONS, 'reservation_id', {
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
      // Běžná cesta jde přes sdílenou cache (getTable) – list se při každém startu nečte
      let table = DB.getTable(coreSS, DB_SHEETS.CORE.NAMED_DAYS);
      if (table.length > 0) return Admin._namedDaysFromTable_(table);

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

      DB.clearCache(DB_SHEETS.CORE.NAMED_DAYS); // po seedování načíst znovu
      return Admin._namedDaysFromTable_(DB.getTable(coreSS, DB_SHEETS.CORE.NAMED_DAYS));
    },

    /**
     * Převede řádky listu NAMED_DAYS na mapu MM-DD → jméno.
     * Klíč, který Sheets převedl na datum, vrací DB.getTable jako ISO řetězec – vezme se z něj MM-DD.
     * @param {Object[]} table - Výsledek DB.getTable.
     * @returns {Object<string, string>}
     */
    _namedDaysFromTable_: function(table) {
      const res = {};
      table.forEach(function(r) {
        let key = String(r.date_key || '').trim();
        if (/^\d{4}-\d{2}-\d{2}T/.test(key)) key = key.substring(5, 10);
        if (key) res[key] = r.name || "";
      });
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
    const correctHeaders = ["system_type", "global_days", "base_days", "max_extra_days", "require_dept_leader_approval", "anniversary_milestones", "calendar_sync_map"];

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
    const roles = ['USER', 'LEADER', 'ADMIN', 'SUPERADMIN', 'MEMBER', 'GROUP_LEADER', 'DEPT_LEADER', 'SECTION_LEADER'];
    const parseValue = (val) => {
      const s = String(val).toUpperCase();
      if (s === 'TRUE') return true;
      if (s === 'FALSE' || s === '') return false;
      return val; // pro 'OWN_DEPARTMENT', 'NONE', 'ALL' atd.
    };

    const config = {};
    rows.forEach(r => {
      if (!r.rbac_key) return;
      config[r.rbac_key] = {};
      roles.forEach(role => {
        if (r[role] !== undefined) config[r.rbac_key][role] = parseValue(r[role]);
      });
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

    const defaultHeaders = ["rbac_key", "USER", "LEADER", "ADMIN", "SUPERADMIN", "MEMBER", "GROUP_LEADER", "DEPT_LEADER", "SECTION_LEADER"];
    const configRoles = {};
    Object.keys(config || {}).forEach(key => {
      Object.keys(config[key] || {}).forEach(role => { configRoles[role] = true; });
    });
    const headers = defaultHeaders.slice();
    Object.keys(configRoles).forEach(role => {
      if (headers.indexOf(role) === -1) headers.push(role);
    });
    sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).clearContent();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sheet.setFrozenRows(1);

    // Smazat stará data (kromě hlavičky)
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(sheet.getLastColumn(), headers.length)).clearContent();
    }

    const prepareValue = (val) => {
      if (val === true || val === 'true') return true;
      if (val === false || val === 'false') return false;
      return val || false;
    };

    const rows = [];
    for (let key in config) {
      rows.push(headers.map(header => header === 'rbac_key' ? key : prepareValue(config[key][header])));
    }

    if (rows.length > 0) {
      // Důležité: Vyčistit stávající ověření dat (checkboxy), protože nyní do sloupců B-E ukládáme scope stringy
      if (sheet.getLastRow() > 1) {
        sheet.getRange(2, 2, sheet.getLastRow() - 1, headers.length - 1).setDataValidation(null);
      }
      sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }
    DB.clearCache(DB_SHEETS.CORE.RBAC_CONFIG);
    return true;
  }
};

/**
 * Serverové funkce volané z UI.
 */
function getRbacConfig() {
  try {
    if (!Auth.getCurrentUser()) throw new Error("Neautorizováno.");
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

/**
 * Serverová funkce pro uložení úseku a současné dokončení instalace (pro Wizard).
 */
function wizardSaveAndComplete(name, locationId) {
  try {
    if (PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_INITIALIZED) === 'true') {
      throw new Error("Aplikace je již inicializována. Wizard nelze spustit znovu.");
    }
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
    if (PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_INITIALIZED) === 'true') {
      Auth.requireSystemAdmin_();
    }
    return { success: true, data: Admin.addLocation(name, type) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function updateLocation(data) {
  try {
    if (!Auth.isSystemAdmin_()) throw new Error("Lokality a pozice může měnit jen administrátor.");
    return Admin.updateEntity(DB_SHEETS.CORE.LOCATIONS, 'location_id', data);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function deleteLocation(locationId) {
  try {
    if (!Auth.isSystemAdmin_()) throw new Error("Lokality a pozice může měnit jen administrátor.");
    Admin.deleteLocation(locationId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function getAllUsers() {
  try {
    const me = Auth.getCurrentUser();
    if (!me) throw new Error("Neautorizováno.");
    let users = Admin.getAllUsers();
    if (!Auth.isSystemAdmin_(me)) {
      // Osobní údaje všech zaměstnanců vidí jen administrátor; ostatní jen lidi ve svém rozsahu správy
      const scope = String(Auth.hasPermission('manage_users') || 'NONE').toUpperCase();
      if (scope === 'NONE' || scope === 'FALSE') {
        users = users.filter(u => u.user_id === me.user_id);
      } else if (scope !== 'ALL' && scope !== 'TRUE') {
        const inScope = _makeManageScopeCheck_(me, scope);
        users = users.filter(u => u.user_id === me.user_id || inScope(u.section_id, u.department_id));
      }
    }
    return { success: true, data: users };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Vrátí funkci (sectionId, deptId) => boolean, zda zařazení spadá do rozsahu správy.
 * Úsek se odvodí z oddělení, pokud chybí (např. nová registrace má jen oddělení).
 * @param {Object} currentUser
 * @param {string} scope - 'OWN_SECTION' | 'OWN_DEPARTMENT' (ALL řeší volající)
 * @returns {Function}
 */
function _makeManageScopeCheck_(currentUser, scope) {
  const depts = DB.getTable(DB.getCore(), DB_SHEETS.CORE.DEPARTMENTS);
  const sectionOfDept = function(deptId) {
    const d = depts.find(x => x.department_id === deptId);
    return d ? (d.section_id || '') : '';
  };
  const mySection = currentUser.section_id || sectionOfDept(currentUser.department_id);
  return function(sectionId, deptId) {
    if (scope === 'OWN_DEPARTMENT') {
      // Vlastní oddělení a úsek (pokud je uveden) musí odpovídat úseku tohoto oddělení
      return !!deptId && deptId === currentUser.department_id && (!sectionId || sectionId === sectionOfDept(deptId));
    }
    if (scope !== 'OWN_SECTION') return false; // neznámý rozsah = žádný přístup (ne širší)
    // OWN_SECTION: úsek (případně odvozený z oddělení) i oddělení musí patřit do mého úseku
    if (!mySection) return false;
    if (deptId && sectionOfDept(deptId) !== mySection) return false;
    return (sectionId || sectionOfDept(deptId)) === mySection;
  };
}

/**
 * Ověří oprávnění permKey s rozsahem pro objekt patřící do úseku sectionId
 * (konfigurace zobrazení úseku, mapy kanceláře). SUPERADMIN vždy.
 * @param {string} permKey - RBAC klíč (manage_org, manage_maps).
 * @param {string} sectionId - Úsek, kterého se změna týká.
 */
function _requireSectionScope_(permKey, sectionId) {
  const me = Auth.getCurrentUser();
  if (!me) throw new Error("Neautorizováno.");
  if (me.system_role === ROLES.SYSTEM.SUPERADMIN) return;
  const scope = String(Auth.hasPermission(permKey) || 'NONE').toUpperCase();
  if (scope === 'NONE' || scope === 'FALSE') throw new Error("Nedostatečná oprávnění.");
  if (scope === 'ALL' || scope === 'TRUE') return;
  if (!sectionId || !_makeManageScopeCheck_(me, 'OWN_SECTION')(sectionId, '')) {
    throw new Error("Úsek je mimo rozsah vašeho oprávnění.");
  }
}

/**
 * Ověří, že aktuální uživatel smí spravovat cílového uživatele: rozsah manage_users
 * (úsek/oddělení – úsek se odvodí i z oddělení, když chybí) a hierarchii rolí.
 * @param {Object} currentUser - Přihlášený uživatel.
 * @param {string} targetId - ID existujícího uživatele ('' = zakládání nového).
 * @param {Object} [data] - Nové hodnoty (section_id, department_id, system_role).
 * @returns {Object|null} Cílový uživatel (null u nového).
 */
function _requireUserManagement_(currentUser, targetId, data) {
  data = data || {};
  const core = DB.getCore();
  const target = targetId ? DB.getTable(core, DB_SHEETS.CORE.USERS).find(u => u.user_id === targetId) : null;
  if (targetId && !target) throw new Error("Uživatel nenalezen.");
  const myRole = currentUser.system_role || 'USER';
  if (myRole === 'SUPERADMIN') return target;

  const roleWeights = { 'USER': 1, 'LEADER': 2, 'ADMIN': 3, 'SUPERADMIN': 100 };
  const myWeight = roleWeights[myRole] || 0;
  const scope = String(Auth.hasPermission('manage_users') || 'NONE').toUpperCase();
  if (scope === 'NONE' || scope === 'FALSE') throw new Error("Nemáte oprávnění spravovat uživatele.");

  // Hierarchie: nelze spravovat stejnou/vyšší roli ani ji přidělit
  if (target && target.user_id !== currentUser.user_id && (roleWeights[target.system_role] || 1) >= myWeight) {
    throw new Error("Nemáte oprávnění spravovat uživatele se stejnou nebo vyšší rolí (" + target.system_role + ").");
  }
  if (data.system_role && (roleWeights[data.system_role] || 0) >= myWeight) {
    throw new Error("Nemáte oprávnění přidělit roli " + data.system_role + ".");
  }

  if (scope === 'ALL' || scope === 'TRUE') return target;
  const inScope = _makeManageScopeCheck_(currentUser, scope);
  if (target && !inScope(target.section_id, target.department_id)) {
    throw new Error("Uživatel je mimo rozsah vaší správy.");
  }
  if (!target || data.section_id !== undefined || data.department_id !== undefined) {
    const newSection = data.section_id !== undefined ? data.section_id : (target ? target.section_id : '');
    const newDept = data.department_id !== undefined ? data.department_id : (target ? target.department_id : '');
    if (!inScope(newSection, newDept)) throw new Error("Nové zařazení uživatele je mimo rozsah vaší správy.");
  }
  return target;
}

function updateUser(userId, data) {
  try {
    // Pokud je voláno jen s jedním argumentem (objektem), posuneme to
    if (typeof userId === 'object' && data === undefined) {
      data = userId;
      userId = data.user_id;
    }
    if (!data || typeof data !== 'object') throw new Error("Chybí data uživatele.");
    // Jediné cílové ID pro všechny kontroly i zápis (jinak by šlo poslat prázdné userId
    // a skutečný cíl schovat do data.user_id)
    userId = userId || data.user_id || '';
    if (userId) data.user_id = userId; else delete data.user_id;
    
    // Ověření oprávnění
    const currentUser = Auth.getCurrentUser();
    if (!currentUser) throw new Error("Neautorizováno.");
    if ((data.first_name !== undefined && !_isValidPersonName_(data.first_name)) ||
        (data.last_name !== undefined && !_isValidPersonName_(data.last_name))) {
      throw new Error("Jméno a příjmení mohou mít nejvýše 60 znaků a nesmí obsahovat znaky < > \".");
    }
    if (data.default_work_start_time !== undefined) {
      // Apostrof zachovat – jinak Sheets převede čas na datum
      const workTime = _sanitizeWorkTime_(data.default_work_start_time);
      data.default_work_start_time = workTime ? "'" + workTime : '';
    }
    const myRole = currentUser?.system_role || 'USER';
    const roleWeights = { 'USER': 1, 'LEADER': 2, 'ADMIN': 3, 'SUPERADMIN': 100 };
    const myWeight = roleWeights[myRole] || 0;

    // ── Vlastní profil: jen pole povolená v RBAC (edit_profile_*), bez admin brány ──
    if (userId && userId === currentUser.user_id && myRole !== 'SUPERADMIN') {
      const SELF_FIELDS = {
        first_name: 'edit_profile_name', last_name: 'edit_profile_name',
        email: 'edit_profile_email',
        section_id: 'edit_profile_org', department_id: 'edit_profile_org', group_id: 'edit_profile_org',
        date_start: 'edit_profile_org', date_end: 'edit_profile_org',
        position_id: 'edit_profile_pos',
        default_work_start_time: null, show_work_start_time: null
      };
      const clean = { user_id: currentUser.user_id };
      Object.keys(SELF_FIELDS).forEach(function(k) {
        if (!data.hasOwnProperty(k)) return;
        const perm = SELF_FIELDS[k] ? Auth.hasPermission(SELF_FIELDS[k]) : true;
        if (perm === true || perm === 'ALL') clean[k] = data[k];
      });
      return { success: true, data: Admin._writeEntity(DB_SHEETS.CORE.USERS, 'user_id', clean) };
    }

    // ── Úprava jiného uživatele nebo založení nového = správa uživatelů ──
    if (!Auth.hasAdminAccess(currentUser)) throw new Error("Můžete upravovat pouze vlastní profil.");
    if (data.system_role !== undefined && data.system_role !== '' && !roleWeights.hasOwnProperty(data.system_role)) {
      throw new Error("Neplatná systémová role.");
    }
    if (data.auth_status !== undefined &&
        ['', AUTH_STATUS.APPROVED, AUTH_STATUS.PENDING, AUTH_STATUS.REJECTED].indexOf(data.auth_status) === -1) {
      throw new Error("Neplatný stav účtu.");
    }
    _requireUserManagement_(currentUser, userId, data);

    return { success: true, data: Admin.updateUser(userId || null, data) };
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
      var orgRole = _resolveOrgRole(currentUser, DB.getTable(DB.getCore(), DB_SHEETS.CORE.POSITIONS));
      if (!Auth.isSystemAdmin_(currentUser) && managerRoles.indexOf(orgRole) === -1) {
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
    if (!user) throw new Error("Neautorizováno.");
    if (user.system_role !== 'SUPERADMIN') {
      const scope = Auth.hasPermission('manage_org');
      if (!scope || scope === 'NONE') throw new Error("Nemáte oprávnění spravovat org. strukturu.");
      if (scope === 'OWN_DEPARTMENT') throw new Error("Úseky může spravovat jen správce úseku.");
      if (scope !== 'ALL' && scope !== true) {
        if (!data.section_id || data.section_id !== user.section_id) throw new Error("Můžete spravovat pouze svůj vlastní úsek.");
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
    if (!user) throw new Error("Neautorizováno.");
    if (user.system_role !== 'SUPERADMIN') {
      const scope = Auth.hasPermission('manage_org');
      if (!scope || scope === 'NONE') throw new Error("Nemáte oprávnění spravovat org. strukturu.");
      if (scope === 'OWN_SECTION') {
        // Musí patřit do stejného úseku
        const depts = DB.getTable(DB.getCore(), DB_SHEETS.CORE.DEPARTMENTS);
        const target = depts.find(d => d.department_id === data.department_id);
        if (target && target.section_id !== user.section_id) throw new Error("Oddělení nepatří do vašeho úseku.");
        if (data.section_id && data.section_id !== user.section_id) throw new Error("Nemůžete přesunout oddělení mimo svůj úsek.");
        if (!target && data.section_id !== user.section_id) throw new Error("Nové oddělení musí patřit do vašeho úseku.");
      } else if (scope === 'OWN_DEPARTMENT') {
        if (!data.department_id || data.department_id !== user.department_id) throw new Error("Můžete spravovat pouze své vlastní oddělení.");
        const depts = DB.getTable(DB.getCore(), DB_SHEETS.CORE.DEPARTMENTS);
        const own = depts.find(d => d.department_id === user.department_id);
        if (data.section_id !== undefined && own && data.section_id !== own.section_id) throw new Error("Nemůžete přesunout oddělení do jiného úseku.");
      } else if (scope !== 'ALL' && scope !== true) {
        throw new Error("Nemáte oprávnění spravovat org. strukturu.");
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
    if (!user) throw new Error("Neautorizováno.");
    if (user.system_role !== 'SUPERADMIN') {
      const scope = Auth.hasPermission('manage_org');
      if (!scope || scope === 'NONE') throw new Error("Nemáte oprávnění spravovat org. strukturu.");
      if (scope === 'OWN_SECTION') {
        const groups = DB.getTable(DB.getCore(), DB_SHEETS.CORE.GROUPS);
        const target = groups.find(g => g.group_id === data.group_id);
        const depts = DB.getTable(DB.getCore(), DB_SHEETS.CORE.DEPARTMENTS);
        if (target) {
            const dept = depts.find(d => d.department_id === target.department_id);
            if (dept && dept.section_id !== user.section_id) throw new Error("Tým nepatří do vašeho úseku.");
        }
        // Nový tým i přesun: cílové oddělení musí být v mém úseku
        const newDeptId = data.department_id !== undefined ? data.department_id : (target ? target.department_id : '');
        const newDept = depts.find(d => d.department_id === newDeptId);
        if (!newDept || newDept.section_id !== user.section_id) throw new Error("Tým musí patřit do oddělení ve vašem úseku.");
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
    if (!currentUser) throw new Error("Neautorizováno.");
    if (!Auth.hasAdminAccess(currentUser)) throw new Error("Nedostatečná oprávnění.");
    if (!userId || userId === currentUser.user_id) throw new Error("Vlastní účet nelze smazat.");
    _requireUserManagement_(currentUser, userId, {});
    return { success: true, data: Admin.deleteUser(userId) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}
function repairDatabaseHeaders() {
  try {
    Auth.requireOwnerContext_();
    return { success: true, data: Setup.repairDatabaseHeaders() };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function updatePosition(data) {
  try {
    if (!Auth.isSystemAdmin_()) throw new Error("Lokality a pozice může měnit jen administrátor.");
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
    Auth.requireSystemAdmin_();
    return Admin.updateAttendanceStatus(data);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function savePrivacySettings(data) {
  try {
    Auth.requireSystemAdmin_();
    return { success: true, data: Admin.savePrivacySettings(data) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function deleteAttendanceStatus(statusId) {
  try {
    Auth.requireSystemAdmin_();
    Admin.deleteAttendanceStatus(statusId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function saveVacationConfig(data) {
  try {
    Auth.requireSystemAdmin_();
    const result = Admin.saveVacationConfig(data);
    DB.clearCache(DB_SHEETS.CORE.VACATION_CONFIG);
    return result;
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function getSectionViewConfig(sectionId) {
  try {
    if (!Auth.getCurrentUser()) throw new Error("Neautorizováno.");
    return { success: true, data: Admin.getSectionViewConfig(sectionId) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function saveSectionViewConfig(data) {
  try {
    _requireSectionScope_('manage_org', data && data.section_id);
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
    _requireSectionScope_('manage_maps', data && data.section_id);
    // U existující mapy i její dosavadní úsek (nelze „přesunout“ cizí mapu k sobě)
    const existingMap = data && data.map_id ? Admin._findOfficeMapById(data.map_id) : null;
    if (existingMap) _requireSectionScope_('manage_maps', existingMap.section_id);
    return Admin.saveOfficeMap(data);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function deleteOfficeMap(mapId) {
  try {
    const existingMap = Admin._findOfficeMapById(mapId);
    if (!existingMap) throw new Error("Mapa nenalezena.");
    _requireSectionScope_('manage_maps', existingMap.section_id);
    return Admin.deleteOfficeMap(mapId);
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function getMapReservationsForMonth(mapId, yearMonth) {
  try {
    if (!Auth.getCurrentUser()) throw new Error("Neautorizováno.");
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
    if (!Auth.hasAdminAccess() || !Auth.hasPermission('manage_namedays')) throw new Error("Nedostatečná oprávnění.");
    const result = Admin.saveNamedDay(dateKey, name);
    DB.clearCache(DB_SHEETS.CORE.NAMED_DAYS);
    return result;
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Ověří, že přihlášený uživatel smí spravovat rezervace daného uživatele:
 * vlastní, nebo uživatele, jehož docházku smí upravovat.
 * @param {string} userId - Uživatel, kterého se rezervace týká.
 */
function _requireReservationTarget_(userId) {
  const me = Auth.getCurrentUser();
  if (!me) throw new Error("Neautorizováno.");
  if (String(userId) === String(me.user_id)) return;
  const core = DB.getCore();
  const target = DB.getTable(core, DB_SHEETS.CORE.USERS).find(u => String(u.user_id) === String(userId));
  if (!target || !_canEditTargetAttendance_(me, target, DB.getTable(core, DB_SHEETS.CORE.POSITIONS), Admin.getRbacConfig())) {
    throw new Error("Nemáte oprávnění spravovat rezervace tohoto uživatele.");
  }
}

/**
 * Spustí fn pod script lockem (kontrola obsazenosti a zápis rezervace nesmí běžet souběžně).
 * @param {Function} fn
 * @returns {*} výsledek fn, nebo {success:false} když se zámek nepodaří získat
 */
function _withReservationLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { success: false, error: "Zápis právě probíhá. Zkuste to prosím znovu za okamžik." };
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function saveMapReservation(data) {
  try {
    _requireReservationTarget_(data && data.user_id);
    return _withReservationLock_(function() { return Admin.saveMapReservation(data); });
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Dávkové uložení rezervací stolů. Hromadná rezervace posílala jeden request na každý
 * den; takto proběhne jediné volání a mapa i docházka se čtou jen jednou pro celou dávku.
 * @param {Object[]} list - položky ve tvaru { map_id, cell_id, user_id, date }
 * @return {Object} { success, results: [{ date, success, id, error }] }
 */
function saveMapReservations(list) {
  try {
    if (!Array.isArray(list) || list.length === 0) {
      return { success: false, error: "Nebyly zadány žádné rezervace." };
    }
    list.forEach(function(item) { _requireReservationTarget_(item && item.user_id); });
    return _withReservationLock_(function() {
      const results = list.map(function(item) {
        try {
          const res = Admin.saveMapReservation(item) || {};
          return { date: item.date, success: !!res.success, id: res.id || '', error: res.error || '' };
        } catch (e) {
          return { date: item.date, success: false, id: '', error: e.toString() };
        }
      });
      return { success: true, results: results };
    });
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function deleteMapReservation(mapId, userId, date) {
  try {
    _requireReservationTarget_(userId);
    return _withReservationLock_(function() { return Admin.deleteMapReservation(mapId, userId, date); });
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}
