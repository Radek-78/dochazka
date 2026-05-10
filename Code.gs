/**
 * Hlavní vstupní bod aplikace.
 */

// Vrátí efektivní org_role uživatele — preferuje org_role z pozice, fallback na user.org_role.
function _resolveOrgRole(user, positions) {
  if (user.position_id && positions) {
    let pos = positions.find(function(p) { return p.position_id === user.position_id; });
    if (pos && pos.org_role && pos.org_role !== '') return pos.org_role;
  }
  return user.org_role || ROLES.ORG.MEMBER;
}

// Pomocná funkce pro sjednocení formátu data (vždy YYYY-MM-DD) dle TZ spreadsheetu
function _toPfx(val, ss) {
  if (!val) return "";
  const tz = ss ? ss.getSpreadsheetTimeZone() : Session.getScriptTimeZone();
  if (val instanceof Date) return Utilities.formatDate(val, tz, "yyyy-MM-dd");
  let s = String(val);
  // Strip leading apostrophe (Google Sheets text prefix) — zabraňuje kolizi klíčů
  // při deduplikaci in-memory řádků kde datum je "'2026-04-07" (11 znaků)
  if (s.charAt(0) === "'") s = s.substring(1);
  return s.substring(0, 10);
}

function _auditLog(action, details, actorUser) {
  try {
    const user = actorUser || Auth.getCurrentUser();
    DB.insertRow(DB.getSystem(), DB_SHEETS.SYSTEM.AUDIT_LOG, {
      timestamp: new Date().toISOString(),
      user_email: user ? (user.email || user.user_id || "") : "",
      action: action,
      details: typeof details === "string" ? details : JSON.stringify(details || {})
    });
  } catch (e) {
    console.warn("_auditLog failed: " + e.toString());
  }
}

function _isRejectedAttendance(entry) {
  return String(entry && entry.approved || "").toLowerCase() === APPROVAL_STATUS.REJECTED;
}

function _canManageTargetAttendance(currentUser, targetUser, positions, rbacConfig) {
  if (!currentUser || !targetUser) return false;
  if (currentUser.user_id === targetUser.user_id) return true;

  const role = _resolveOrgRole(currentUser, positions);
  if ((role === ROLES.ORG.SECTION_LEADER || role === ROLES.ORG.SECTION_DEPUTY) &&
      currentUser.section_id && currentUser.section_id === targetUser.section_id) {
    return true;
  }
  if ((role === ROLES.ORG.DEPT_LEADER || role === ROLES.ORG.DEPT_DEPUTY) &&
      currentUser.department_id && currentUser.department_id === targetUser.department_id) {
    return true;
  }

  return false;
}

function _isVacationStatusId(statusId, statusMap) {
  const st = statusMap[Privacy.normalizeStatusId(statusId)];
  if (!st) return false;
  return st.is_vacation === "true" || st.is_vacation === true || String(st.name || "").indexOf("Dovolen") !== -1;
}

function _calculateVacationEntitlement(user, vacationConfig, yearNum) {
  let baseEntitlement = 30;
  if (vacationConfig.system_type === VACATION_SYSTEM_TYPE.GLOBAL) {
    baseEntitlement = Number(vacationConfig.global_days || 30);
  } else {
    let years = 0;
    if (user.date_start) {
      const start = new Date(user.date_start);
      if (!isNaN(start.getTime())) {
        years = yearNum - start.getFullYear();
        if (years < 0) years = 0;
      }
    }
    baseEntitlement = Number(vacationConfig.base_days || 25) + Math.min(years, Number(vacationConfig.max_extra_days || 5));
  }

  let entitlement = baseEntitlement;
  if (user.date_start) {
    const startDate = new Date(user.date_start);
    if (!isNaN(startDate.getTime()) && startDate.getFullYear() === yearNum) {
      const monthsNotWorked = startDate.getMonth();
      if (monthsNotWorked > 0) {
        const reduction = (baseEntitlement / 12) * monthsNotWorked;
        entitlement = baseEntitlement - reduction;
        entitlement = Math.round(entitlement * 2) / 2;
      }
    }
  }

  entitlement += Number(user.vacation_days_carried_over || 0);
  return entitlement;
}

function doGet(e) {
  const isInitialized = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_INITIALIZED) === "true";
  const template = HtmlService.createTemplateFromFile("index");
  template.isInitialized = isInitialized;

  return template.evaluate()
      .setTitle(CONFIG.APP_NAME)
      .addMetaTag("viewport", "width=device-width, initial-scale=1")
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Helper pro vkládání HTML souborů do šablon s podporou skriptletů.
 */
function include(filename) {
  return HtmlService.createTemplateFromFile(filename).evaluate().getContent();
}

/**
 * Vrátí e-mail aktuálního uživatele.
 */
function getUserEmail() {
  return Session.getActiveUser().getEmail();
}

/**
 * Vrátí informace o verzi a changelogu aplikace.
 */
function getAppVersionInfo() {
  return { 
    version: typeof APP_VERSION !== 'undefined' ? APP_VERSION : "v0.0.0",
    changelog: typeof APP_CHANGELOG !== 'undefined' ? APP_CHANGELOG : []
  };
}

/**
 * Serverová funkce pro spuštění inicializace z UI.
 */
function runInitialization() {
  try {
    Setup.initialize();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Ověří, zda má aktuální uživatel přístup do administrace.
 * Voláno z frontendu přes callServer – vrací standardní {success, data} formát.
 */
function isAdmin() {
  return { success: true, data: Auth.hasAdminAccess() };
}

/**
 * Získá veškerá data potřebná pro vykreslení plánovače (Oddělení + Zaměstnanci).
 * Vrací errorCode pro neregistrované / neschválené uživatele.
 */
function getPlannerData() {
  const startupPerf = {
    scope: "getPlannerData",
    started_at: new Date().toISOString(),
    stages: [],
    counts: {}
  };
  const startupPerfStart = Date.now();
  function _startPerfStage() {
    return Date.now();
  }
  function _endPerfStage(name, startedAt, extra) {
    const stage = { name: name, ms: Date.now() - startedAt };
    if (extra) stage.extra = extra;
    startupPerf.stages.push(stage);
    return stage.ms;
  }
  function _finishStartupPerf() {
    startupPerf.total_ms = Date.now() - startupPerfStart;
    try {
      console.log("[STARTUP PERF] " + JSON.stringify(startupPerf));
    } catch (logError) {
      // Diagnostika nesmí nikdy ovlivnit odpověď aplikace.
    }
    return startupPerf;
  }

  try {
    // Strukturální oprava DB se nespouští při startu aplikace.
    // Běží jako servisní údržba po noční záloze, aby neblokovala uživatele.
    let perfStage = _startPerfStage();
    const email = Session.getActiveUser().getEmail().toLowerCase();
    _endPerfStage("auth.getActiveUserEmail", perfStage);

    perfStage = _startPerfStage();
    const allUsers = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
    const user = allUsers.find(u => u.email && u.email.toLowerCase() === email) || null;
    startupPerf.counts.users_total = allUsers.length;
    _endPerfStage("core.users.loadForAuth", perfStage, { rows: allUsers.length });

    if (!user) {
      perfStage = _startPerfStage();
      const departments = DB.getTable(DB.getCore(), DB_SHEETS.CORE.DEPARTMENTS).filter(d => d.active === "true");
      _endPerfStage("core.departments.loadForRegistration", perfStage, { rows: departments.length });
      return { success: false, errorCode: "USER_NOT_FOUND", email: email, departments: departments, startupPerf: _finishStartupPerf() };
    }

    if (user.auth_status === AUTH_STATUS.PENDING) {
      return { success: false, errorCode: "USER_PENDING", email: email, startupPerf: _finishStartupPerf() };
    }

    if (user.auth_status === AUTH_STATUS.REJECTED) {
      return { success: false, errorCode: "USER_REJECTED", email: email, startupPerf: _finishStartupPerf() };
    }

    // Prázdný auth_status = legacy záznam nebo admin-vytvořený bez statusu → pustit dál
    // Explicitní APPROVED nebo prázdný řetězec = přístup povolen

    const coreSS = DB.getCore();
    const transSS = DB.getTransaction();
    perfStage = _startPerfStage();
    const departments = DB.getTable(coreSS, DB_SHEETS.CORE.DEPARTMENTS).filter(d => d.active === "true");
    _endPerfStage("core.departments", perfStage, { rows: departments.length });
    perfStage = _startPerfStage();
    const sections = DB.getTable(coreSS, DB_SHEETS.CORE.SECTIONS).filter(s => s.active !== "false");
    _endPerfStage("core.sections", perfStage, { rows: sections.length });
    perfStage = _startPerfStage();
    const allEmployees = DB.getTable(coreSS, DB_SHEETS.CORE.USERS);
    _endPerfStage("core.users.loadEmployees", perfStage, { rows: allEmployees.length });
    perfStage = _startPerfStage();
    const positions = DB.getTable(coreSS, DB_SHEETS.CORE.POSITIONS);
    _endPerfStage("core.positions", perfStage, { rows: positions.length });
    perfStage = _startPerfStage();
    const groups = DB.getTable(coreSS, DB_SHEETS.CORE.GROUPS);
    _endPerfStage("core.groups", perfStage, { rows: groups.length });
    perfStage = _startPerfStage();
    const statuses = Privacy.ensureFallbackMaskStatus(
      DB.getTable(coreSS, DB_SHEETS.CORE.ATTENDANCE_STATUSES).filter(s => s.active !== "false")
    );
    _endPerfStage("core.attendanceStatuses", perfStage, { rows: statuses.length });
    perfStage = _startPerfStage();
    const vacationConfig = Admin.getVacationConfig ? Admin.getVacationConfig() : { system_type: VACATION_SYSTEM_TYPE.GLOBAL, global_days: 30 };
    _endPerfStage("admin.vacationConfig", perfStage);
    startupPerf.counts.departments = departments.length;
    startupPerf.counts.sections = sections.length;
    startupPerf.counts.positions = positions.length;
    startupPerf.counts.groups = groups.length;
    startupPerf.counts.statuses = statuses.length;

    const today = new Date();
    const currYearNum = today.getFullYear();
    today.setHours(0, 0, 0, 0);

    startupPerf.counts.attendance_skipped_in_initial_payload = true;

    // Přepsat org_role přihlášeného uživatele z pozice
    user.org_role = _resolveOrgRole(user, positions);

    perfStage = _startPerfStage();
    const employees = allEmployees.filter(u => u.active === "true" && u.section_id === user.section_id).map(u => {
      // 0. Efektivní org_role z pozice
      u.org_role = _resolveOrgRole(u, positions);

      // 1. Aktivita (derived)
      let isDerivedActive = true;
      if (u.date_end) {
        const endDate = new Date(u.date_end);
        if (!isNaN(endDate.getTime()) && endDate < today) isDerivedActive = false;
      }

      const entitlement = _calculateVacationEntitlement(u, vacationConfig, currYearNum);

      return { 
        ...u, 
        is_derived_active: isDerivedActive,
        vacation_entitlement: entitlement,
        vacation_used: 0
      };
    });
    _endPerfStage("employees.buildVisibleAndVacationBalances", perfStage, { rows: employees.length });
    startupPerf.counts.employees_returned = employees.length;

    perfStage = _startPerfStage();
    const sectionViewConfig = Admin.getSectionViewConfig(user.section_id);
    _endPerfStage("admin.sectionViewConfig", perfStage);

    // Načti první aktivní mapu kanceláře pro úsek uživatele (jen pokud má úsek povolené rezervace)
    const userSection = sections.find(function(s) { return s.section_id === user.section_id; });
    const deskEnabled = userSection && String(userSection.desk_reservation_enabled).toLowerCase() === 'true';
    perfStage = _startPerfStage();
    const officeMaps = deskEnabled ? Admin.getOfficeMaps(user.section_id) : [];
    const officeMap = officeMaps.length > 0 ? officeMaps[0] : null;
    _endPerfStage("admin.officeMaps", perfStage, { deskEnabled: !!deskEnabled, rows: officeMaps.length });

    // Plánovací skupiny
    perfStage = _startPerfStage();
    const allPlannerGroups = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUPS);
    const allMemberships = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS);
    _endPerfStage("planner.groupsAndMemberships", perfStage, { groups: allPlannerGroups.length, memberships: allMemberships.length });
    
    // Skupiny, kde je uživatel členem
    const userMemberships = allMemberships.filter(m => String(m.user_id) === String(user.user_id));
    const userGroupsMap = {};
    userMemberships.forEach(m => {
      userGroupsMap[m.group_id] = m.permission || 'VIEW';
    });
    
    const userGroupIds = Object.keys(userGroupsMap);
    const accessibleGroups = allPlannerGroups.filter(g => userGroupIds.includes(String(g.group_id)) && (g.active === true || String(g.active).toLowerCase() === 'true')).map(g => {
        return {
           group_id: g.group_id,
           name: g.name,
           active: true,
           color: g.color || 'default'
        }
    });
    
    // Načti a vyfiltruj události plánovače
    perfStage = _startPerfStage();
    const allEvents = DB.getTable(transSS, DB_SHEETS.TRANSACTION.PLANNER_EVENTS);
    const plannerEvents = allEvents.filter(e => userGroupIds.includes(String(e.group_id)));
    _endPerfStage("planner.events.readAndFilter", perfStage, { total: allEvents.length, returned: plannerEvents.length });
    startupPerf.counts.planner_groups_total = allPlannerGroups.length;
    startupPerf.counts.planner_groups_returned = accessibleGroups.length;
    startupPerf.counts.planner_events_total = allEvents.length;
    startupPerf.counts.planner_events_returned = plannerEvents.length;

    perfStage = _startPerfStage();
    const anniversaryMilestones = (function() { try { return JSON.parse(vacationConfig.anniversary_milestones || '[]'); } catch(e) { return [10,15,20,40]; } })();
    const isAdminResult = Auth.hasAdminAccess(user);
    const rbacConfig = Admin.getRbacConfig ? Admin.getRbacConfig() : {};
    const namedDays = Admin.getNamedDays ? Admin.getNamedDays() : CalendarData.NAMED_DAYS;
    const holidays = CalendarData.getHolidaysForYear(currYearNum);
    const marketingWeeks = (function () { try { return DB.getTable(coreSS, DB_SHEETS.CORE.MARKETING_WEEKS) || []; } catch (e) { return []; } })();
    _endPerfStage("payload.supportingConfig", perfStage, {
      holidays: holidays.length || 0,
      marketingWeeks: marketingWeeks.length || 0
    });

    return {
      success: true,
      user: user,
      sections: sections,
      departments: departments,
      employees: employees,
      positions: positions,
      groups: groups,
      statuses: statuses,
      vacationConfig: vacationConfig,
      anniversaryMilestones: anniversaryMilestones,
      isAdmin: isAdminResult,
      sectionViewConfig: sectionViewConfig,
      officeMap: officeMap,
      rbacConfig: rbacConfig,
      namedDays: namedDays,
      holidays: holidays,
      marketingWeeks: marketingWeeks,
      plannerEvents: plannerEvents,
      plannerGroups: accessibleGroups,
      plannerPermissions: userGroupsMap,
      startupPerf: _finishStartupPerf()
    };
  } catch (e) {
    startupPerf.error = e.toString();
    return { success: false, error: e.toString(), startupPerf: _finishStartupPerf() };
  }
}

/**
 * Zaregistruje nového uživatele se statusem PENDING a odešle notifikace.
 */
function registerUser(data) {
  try {
    const email = Session.getActiveUser().getEmail().toLowerCase();
    if (!email) return { success: false, error: "Nepodařilo se ověřit přihlášení Google." };

    const allUsers = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
    const existing = allUsers.find(u => u.email && u.email.toLowerCase() === email);
    if (existing) return { success: false, error: "Účet s tímto e-mailem již existuje." };

    if (!data.first_name || !data.last_name || !data.department_id) {
      return { success: false, error: "Vyplňte všechna povinná pole." };
    }

    const newUser = {
      user_id: Utilities.getUuid(),
      email: email,
      first_name: data.first_name.trim(),
      last_name: data.last_name.trim(),
      section_id: "",
      department_id: data.department_id,
      group_id: "",
      position_id: "",
      system_role: ROLES.SYSTEM.USER,
      org_role: ROLES.ORG.MEMBER,
      date_start: "",
      date_end: "",
      active: "false",
      auth_status: AUTH_STATUS.PENDING,
      last_active: "",
      last_visit: new Date().toISOString(),
      sync_own_attendance: "false",
      sync_team_vacations: "false",
      vacation_days_total: "0"
    };

    DB.insertRow(DB.getCore(), DB_SHEETS.CORE.USERS, newUser);
    Auth.notifyAdminsAndLeader(newUser, allUsers);

    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Vrátí notifikace aktuálního uživatele, obohacené o data žadatele.
 */
function getNotifications() {
  try {
    const user = Auth.getCurrentUser();
    if (!user) return { success: false, error: "Neautorizováno." };

    const systemDb = DB.getSystem();
    const all = DB.getTable(systemDb, DB_SHEETS.SYSTEM.NOTIFICATIONS);
    const mine = all
      .filter(function(n) { return n.user_id === user.user_id; })
      .sort(function(a, b) { return new Date(b.timestamp) - new Date(a.timestamp); })
      .slice(0, 50);

    const allUsers    = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
    const departments = DB.getTable(DB.getCore(), DB_SHEETS.CORE.DEPARTMENTS);

    const enriched = mine.map(function(n) {
      let item = {};
      Object.keys(n).forEach(function(k) { item[k] = n[k]; });
      if (n.type === NOTIFICATION_TYPES.REGISTRATION_REQUEST) {
        let emailMatch = n.message.match(/\(([^)]+)\)/);
        if (emailMatch) {
          let email = emailMatch[1].toLowerCase();
          let pu = allUsers.find(function(u) {
            return u.email && u.email.toLowerCase() === email && u.auth_status === AUTH_STATUS.PENDING;
          }) || allUsers.find(function(u) {
            return u.email && u.email.toLowerCase() === email;
          });
          if (pu) {
            let dept = departments.find(function(d) { return d.department_id === pu.department_id; });
            item.pending_user = {
              user_id:         pu.user_id,
              first_name:      pu.first_name,
              last_name:       pu.last_name,
              email:           pu.email,
              department_name: dept ? dept.name : pu.department_id,
              auth_status:     pu.auth_status
            };
          }
        }
      } else if (n.type === "VACATION_APPROVAL_REQUEST") {
        try {
          let payload = JSON.parse(n.message);
          let requester = allUsers.find(function(u) { return u.user_id === payload.requester_id; });
          if (requester) {
            let dept2 = departments.find(function(d) { return d.department_id === requester.department_id; });
            item.vacation_request = {
              requester_id:   requester.user_id,
              requester_name: requester.first_name + ' ' + requester.last_name,
              department_name: dept2 ? dept2.name : '',
              entries:        payload.entries || []
            };
          }
        } catch (pe) { /* JSON parse error */ }
      }
      return item;
    });

    return { success: true, notifications: enriched };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Schválí registraci uživatele (APPROVED + active).
 */
function approveUser(userId) {
  try {
    const currentUser = Auth.getCurrentUser();
    if (!Auth.hasAdminAccess(currentUser)) throw new Error("Nedostatečná oprávnění.");
    Admin.updateUser(userId, { user_id: userId, auth_status: AUTH_STATUS.APPROVED, active: "true" });
    _markRegNotifsRead(userId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Zamítne registraci uživatele (REJECTED).
 */
function rejectUser(userId) {
  try {
    const currentUser = Auth.getCurrentUser();
    if (!Auth.hasAdminAccess(currentUser)) throw new Error("Nedostatečná oprávnění.");
    Admin.updateUser(userId, { user_id: userId, auth_status: AUTH_STATUS.REJECTED });
    _markRegNotifsRead(userId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Označí notifikaci jako přečtenou.
 */
function markNotificationRead(notifId) {
  try {
    const systemDb = DB.getSystem();
    const sheet = systemDb.getSheetByName(DB_SHEETS.SYSTEM.NOTIFICATIONS);
    if (!sheet) return { success: false };
    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    const idIdx   = headers.indexOf('notif_id');
    const rdIdx   = headers.indexOf('read');
    for (let i = 1; i < data.length; i++) {
      if (data[i][idIdx] === notifId) {
        sheet.getRange(i + 1, rdIdx + 1).setValue("true");
        break;
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Označí všechny notifikace aktuálního uživatele jako přečtené.
 */
function markAllNotificationsRead() {
  try {
    const systemDb = DB.getSystem();
    const sheet = systemDb.getSheetByName(DB_SHEETS.SYSTEM.NOTIFICATIONS);
    if (!sheet) return { success: false };
    
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const userIdx = headers.indexOf('user_id');
    const readIdx = headers.indexOf('read');
    
    // Aktuální uživatel
    const currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: "Neautorizováno." };
    const myId = currentUser.user_id;

    for (let i = 1; i < data.length; i++) {
      if (data[i][userIdx] === myId && (data[i][readIdx] === "false" || data[i][readIdx] === false)) {
        sheet.getRange(i + 1, readIdx + 1).setValue("true");
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}


/**
 * Interní: Označí REGISTRATION_REQUEST notifikace žadatele jako přečtené u všech příjemců.
 */
function _markRegNotifsRead(pendingUserId) {
  try {
    const allUsers = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
    let pu = allUsers.find(function(u) { return u.user_id === pendingUserId; });
    if (!pu) return;
    const sheet = DB.getSystem().getSheetByName(DB_SHEETS.SYSTEM.NOTIFICATIONS);
    if (!sheet) return;
    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    const typeIdx = headers.indexOf('type');
    const rdIdx   = headers.indexOf('read');
    const msgIdx  = headers.indexOf('message');
    for (let i = 1; i < data.length; i++) {
      if (data[i][typeIdx] === NOTIFICATION_TYPES.REGISTRATION_REQUEST &&
          data[i][msgIdx].indexOf(pu.email) !== -1 &&
          data[i][rdIdx] === "false") {
        sheet.getRange(i + 1, rdIdx + 1).setValue("true");
      }
    }
  } catch (e) {
    console.warn("_markRegNotifsRead: " + e.toString());
  }
}

/**
 * Vrátí záznamy docházky pro daný rok a měsíc (pouze pro viditelné uživatele).
 */
function getMonthAttendance(year, month) {
  try {
    const currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: "Neautorizováno." };
    
    // Reset mezipaměti RBAC pro tento požadavek (prevence zastaralých dat)
    if (Auth._rbacCache !== undefined) Auth._rbacCache = null;
    const rbacConfig = Admin.getRbacConfig();

    const allUsers = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
    const userMap = {};
    allUsers.forEach(function(u) { userMap[u.user_id] = u; });

    const allAttendance = DB.getTable(DB.getTransaction(), DB_SHEETS.TRANSACTION.ATTENDANCE);

    const monthStr = String(Number(month) + 1).padStart(2, '0');
    const prefix = String(year) + '-' + monthStr;

    const filtered = allAttendance.filter(function(a) {
      if (_isRejectedAttendance(a)) return false;
      if (!a.date || !String(a.date).startsWith(prefix)) return false;
      const targetUser = userMap[a.user_id];
      if (!targetUser) return false;
      return Auth.canAccessUserData(targetUser, rbacConfig);
    });

    const statuses = Privacy.ensureFallbackMaskStatus(DB.getTable(DB.getCore(), DB_SHEETS.CORE.ATTENDANCE_STATUSES));
    const positions = DB.getTable(DB.getCore(), DB_SHEETS.CORE.POSITIONS);
    const privacyCtx = Privacy.createContext({
      viewer: currentUser,
      positions: positions,
      statuses: statuses,
      rbacConfig: rbacConfig
    });

    return { success: true, data: Privacy.prepareAttendanceEntries(filtered, userMap, privacyCtx) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Vrátí autoritativní roční a měsíční bilance dovolené pro viditelné uživatele.
 * Volá se mimo úvodní getPlannerData, aby první vykreslení nečekalo na čtení ATTENDANCE.
 */
function getVacationBalances(year) {
  try {
    const currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: "Neautorizováno." };

    if (Auth._rbacCache !== undefined) Auth._rbacCache = null;

    const targetYear = Number(year) || new Date().getFullYear();
    const yearPrefix = String(targetYear) + "-";
    const coreSS = DB.getCore();
    const transSS = DB.getTransaction();
    const rbacConfig = Admin.getRbacConfig();
    const vacationConfig = Admin.getVacationConfig ? Admin.getVacationConfig() : { system_type: VACATION_SYSTEM_TYPE.GLOBAL, global_days: 30 };
    const statuses = Privacy.ensureFallbackMaskStatus(DB.getTable(coreSS, DB_SHEETS.CORE.ATTENDANCE_STATUSES));
    const positions = DB.getTable(coreSS, DB_SHEETS.CORE.POSITIONS);
    const allUsers = DB.getTable(coreSS, DB_SHEETS.CORE.USERS);
    const visibleUsers = allUsers.filter(function(u) {
      if (u.active !== "true") return false;
      u.org_role = _resolveOrgRole(u, positions);
      return Auth.canAccessUserData(u, rbacConfig);
    });
    const visibleUserIds = {};
    visibleUsers.forEach(function(u) {
      visibleUserIds[String(u.user_id)] = true;
    });

    const statusMap = {};
    statuses.forEach(function(st) {
      statusMap[Privacy.normalizeStatusId(st.status_id)] = st;
    });

    const byUser = {};
    visibleUsers.forEach(function(u) {
      const entitlement = _calculateVacationEntitlement(u, vacationConfig, targetYear);
      byUser[String(u.user_id)] = {
        user_id: u.user_id,
        entitlement: entitlement,
        used_year: 0,
        remaining: entitlement,
        used_by_month: {}
      };
    });

    const allAttendance = DB.getTable(transSS, DB_SHEETS.TRANSACTION.ATTENDANCE);
    allAttendance.forEach(function(entry) {
      const userId = String(entry.user_id || "");
      if (!visibleUserIds[userId]) return;
      if (_isRejectedAttendance(entry)) return;
      const dateStr = String(entry.date || "");
      if (!dateStr.startsWith(yearPrefix)) return;
      if (!_isVacationStatusId(entry.status_id, statusMap)) return;

      const monthIdx = Number(dateStr.substring(5, 7)) - 1;
      if (monthIdx < 0 || monthIdx > 11) return;
      const value = (entry.slot === "ALL_DAY" || !entry.slot) ? 1 : 0.5;
      const balance = byUser[userId];
      if (!balance) return;

      balance.used_year += value;
      balance.used_by_month[monthIdx] = (balance.used_by_month[monthIdx] || 0) + value;
    });

    Object.keys(byUser).forEach(function(userId) {
      const balance = byUser[userId];
      balance.used_year = Math.round(balance.used_year * 2) / 2;
      Object.keys(balance.used_by_month).forEach(function(monthKey) {
        balance.used_by_month[monthKey] = Math.round(balance.used_by_month[monthKey] * 2) / 2;
      });
      balance.remaining = Math.round((balance.entitlement - balance.used_year) * 2) / 2;
    });

    return {
      success: true,
      year: targetYear,
      generated_at: new Date().toISOString(),
      data: byUser
    };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Diagnostika párování status_id mezi ATTENDANCE a číselníkem statusů.
 * Volatelné ručně z Apps Scriptu nebo přes google.script.run pro administrátora.
 */
function debugPrivacyStatusMapping(year, month) {
  try {
    const currentUser = Auth.getCurrentUser();
    if (!currentUser || !Auth.hasAdminAccess(currentUser)) {
      const denied = { success: false, error: "Neautorizováno.", active_user: Session.getActiveUser().getEmail() };
      Logger.log(JSON.stringify(denied, null, 2));
      return denied;
    }

    const coreSS = DB.getCore();
    const transSS = DB.getTransaction();
    const statuses = Privacy.ensureFallbackMaskStatus(DB.getTable(coreSS, DB_SHEETS.CORE.ATTENDANCE_STATUSES));
    const positions = DB.getTable(coreSS, DB_SHEETS.CORE.POSITIONS);
    const rbacConfig = Admin.getRbacConfig ? Admin.getRbacConfig() : {};
    const privacyCtx = Privacy.createContext({
      viewer: currentUser,
      positions: positions,
      statuses: statuses,
      rbacConfig: rbacConfig
    });

    const statusMap = {};
    statuses.forEach(function(s) {
      statusMap[Privacy.normalizeStatusId(s.status_id)] = {
        status_id: s.status_id,
        name: s.name || "",
        status_kind: s.status_kind || "NORMAL",
        masked_status_id: s.masked_status_id || "",
        active: s.active
      };
    });

    const now = new Date();
    const targetYear = year || now.getFullYear();
    const targetMonth = month !== undefined && month !== null ? Number(month) : now.getMonth();
    const prefix = String(targetYear) + "-" + String(targetMonth + 1).padStart(2, "0");
    const allAttendance = DB.getTable(transSS, DB_SHEETS.TRANSACTION.ATTENDANCE)
      .filter(function(a) {
        return a.date && String(a.date).startsWith(prefix);
      });

    const rawCounts = {};
    let unmatchedCount = 0;
    let maskStatusAttendanceCount = 0;
    const unmatched = [];
    const maskStatusSample = [];
    allAttendance.forEach(function(a) {
      const rawStatusId = a.status_id;
      const normalizedStatusId = Privacy.normalizeStatusId(rawStatusId);
      const statusInfo = statusMap[normalizedStatusId] || null;
      rawCounts[normalizedStatusId] = (rawCounts[normalizedStatusId] || 0) + 1;
      if (statusInfo && String(statusInfo.status_kind || "NORMAL").toUpperCase() === "MASK") {
        maskStatusAttendanceCount++;
        if (maskStatusSample.length < 100) {
          maskStatusSample.push({
            user_id: a.user_id,
            date: String(a.date),
            slot: a.slot || "ALL_DAY",
            raw_status_id: rawStatusId,
            status_name: statusInfo.name
          });
        }
      }
      if (!statusInfo) {
        unmatchedCount++;
        if (unmatched.length < 100) {
          unmatched.push({
            user_id: a.user_id,
            date: String(a.date),
            slot: a.slot || "ALL_DAY",
            raw_status_id: rawStatusId,
            normalized_status_id: normalizedStatusId
          });
        }
      }
    });

    const result = {
      success: true,
      data: {
        prefix: prefix,
        masking_enabled: privacyCtx.enabled,
        status_count: statuses.length,
        attendance_count: allAttendance.length,
        mask_status_attendance_count: maskStatusAttendanceCount,
        unmatched_count: unmatchedCount,
        raw_status_counts: rawCounts,
        mask_status_sample: maskStatusSample,
        unmatched_sample: unmatched
      }
    };
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  } catch (e) {
    const errorResult = { success: false, error: e.toString(), stack: e.stack || "" };
    Logger.log(JSON.stringify(errorResult, null, 2));
    return errorResult;
  }
}

/**
 * Uloží dávku docházkových záznamů (upsert dle user_id + date + slot).
 * Celý batch se zpracuje v jednom volání — žádné race conditions.
 */
function saveAttendanceEntries(entries) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { success: false, error: "Zápis právě probíhá. Zkuste to prosím znovu za okamžik." };
  try {
    const currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: "Neautorizováno." };
    if (!Array.isArray(entries) || entries.length === 0) {
      return { success: false, error: "Žádné záznamy." };
    }

    const allUsers = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
    const transDB = DB.getTransaction();
    const sheet = transDB.getSheetByName(DB_SHEETS.TRANSACTION.ATTENDANCE);
    if (!sheet) return { success: false, error: "ATTENDANCE sheet nenalezen." };

    if (sheet.getLastColumn() === 0) {
      if (typeof Setup !== 'undefined') Setup.setHeaders(sheet, DB_SHEETS.TRANSACTION.ATTENDANCE);
    }

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var normalizedHeaders = headers.map(function(h) { return String(h || '').trim(); });
    var headerSeen = {};
    var duplicateHeaders = normalizedHeaders.filter(function(h) {
      if (!h) return false;
      if (headerSeen[h]) return true;
      headerSeen[h] = true;
      return false;
    });
    if (duplicateHeaders.length > 0) {
      _auditLog("ATTENDANCE_SAVE_BLOCKED", { reason: "duplicate_headers", duplicates: duplicateHeaders }, currentUser);
      return { success: false, error: "ATTENDANCE obsahuje duplicitní hlavičky. Zápis byl zastaven kvůli ochraně dat." };
    }

    // Auto-migrace: pokud sloupec created_at v sheetu chybí, přidej ho
    if (headers.indexOf('created_at') === -1) {
      var newCol = headers.length + 1;
      sheet.getRange(1, newCol).setValue('created_at');
      headers.push('created_at');
    }

    // Auto-migrace: pokud sloupec work_start_time v sheetu chybí, přidej ho
    if (headers.indexOf('work_start_time') === -1) {
      var newCol = headers.length + 1;
      sheet.getRange(1, newCol).setValue('work_start_time');
      headers.push('work_start_time');
    }

    const aidIdx  = headers.indexOf('attendance_id');
    const uidIdx  = headers.indexOf('user_id');
    const dateIdx = headers.indexOf('date');
    const slotIdx = headers.indexOf('slot');
    const statIdx = headers.indexOf('status_id');
    const noteIdx = headers.indexOf('note');
    const apprIdx = headers.indexOf('approved');
    const catIdx  = headers.indexOf('created_at');
    const wstIdx  = headers.indexOf('work_start_time');
    if ([aidIdx, uidIdx, dateIdx, slotIdx, statIdx, noteIdx, apprIdx].some(function(idx) { return idx === -1; })) {
      _auditLog("ATTENDANCE_SAVE_BLOCKED", { reason: "missing_headers", headers: headers }, currentUser);
      return { success: false, error: "ATTENDANCE nemá očekávané hlavičky. Zápis byl zastaven." };
    }

    const lastRow = sheet.getLastRow();
    const allRows = lastRow > 1
      ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
      : [];

    // Předpočítaný index pro O(1) lookup existujících záznamů.
    // Zároveň slouží k identifikaci duplicit, které by mohly zůstat v tabulce jako "duchové".
    const attIndex = {};
    allRows.forEach(function(r, ri) {
      const key = r[uidIdx] + '_' + _toPfx(r[dateIdx], transDB) + '_' + (r[slotIdx] || 'ALL_DAY');
      attIndex[key] = ri; // Vždy odkazuje na poslední výskyt daného klíče
    });

    // Načíst statusy a vacation config pro logiku schvalování
    const coreDbForAppr = DB.getCore();
    const allStatuses = DB.getTable(coreDbForAppr, DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    const allPositions = DB.getTable(coreDbForAppr, DB_SHEETS.CORE.POSITIONS);
    const vacCfg = Admin.getVacationConfig ? Admin.getVacationConfig() : {};
    const isAdminUser = Auth.hasAdminAccess(currentUser);
    // Efektivní org_role: primárně z pozice uživatele, fallback na uložené user.org_role
    const curOrgRole = _resolveOrgRole(currentUser, allPositions);
    // Přepočítat org_role i pro všechny uživatele (pro hledání schvalovatele)
    allUsers.forEach(function(u) { u.org_role = _resolveOrgRole(u, allPositions); });
    // Mapy pro O(1) lookup místo O(n) find() v cyklu
    const userMap = {};
    allUsers.forEach(function(u) { userMap[u.user_id] = u; });
    const statusMap = {};
    allStatuses.forEach(function(s) { statusMap[Privacy.normalizeStatusId(s.status_id)] = s; });

    function _getWritableStatusId(statusId) {
      const normalizedStatusId = Privacy.normalizeStatusId(statusId);
      const st = statusMap[normalizedStatusId] || null;
      if (!st) {
        throw new Error("Neznámý docházkový status: " + statusId);
      }
      if (String(st.status_kind || "NORMAL").toUpperCase() === "MASK") {
        throw new Error("Maskovací status nelze uložit jako docházku: " + (st.name || st.status_id));
      }
      return st.status_id;
    }

    // Určí zda aktuální uživatel potřebuje schválení pro dovolené (ukládá sám sobě).
    // Schvalování je čistě organizační (org_role), system_role (ADMIN/SUPERADMIN) nemá vliv.
    function _isApprovalNeeded(statusId, targetUserId) {
      if (targetUserId !== currentUser.user_id) return false; // vedoucí zadává pro jiného → pre-approved
      let st = statusMap[Privacy.normalizeStatusId(statusId)];
      if (!st || st.requires_approval !== 'true') return false;
      if (curOrgRole === ROLES.ORG.SECTION_LEADER || curOrgRole === ROLES.ORG.SECTION_DEPUTY) return false;
      if (curOrgRole === ROLES.ORG.DEPT_LEADER || curOrgRole === ROLES.ORG.DEPT_DEPUTY) {
        return vacCfg.require_dept_leader_approval === 'true';
      }
      return true; // všichni ostatní (včetně SUPERADMIN s org_role MEMBER) → potřebují schválení
    }

    // Najde ID schvalovatele pro aktuálního uživatele
    function _findApproverId() {
      if (curOrgRole === ROLES.ORG.DEPT_LEADER || curOrgRole === ROLES.ORG.DEPT_DEPUTY) {
        // Schvaluje vedoucí úseku (SECTION_LEADER)
        let sl = allUsers.find(function(u) {
          return u.section_id === currentUser.section_id &&
                 (u.org_role === ROLES.ORG.SECTION_LEADER || u.org_role === ROLES.ORG.SECTION_DEPUTY) &&
                 u.active === 'true' && u.user_id !== currentUser.user_id;
        });
        return sl ? sl.user_id : null;
      } 
      
      // MEMBER (všichni ostatní): Schvaluje vedoucí oddělení (DEPT_LEADER)
      let dl = allUsers.find(function(u) {
        return u.department_id === currentUser.department_id &&
               (u.org_role === ROLES.ORG.DEPT_LEADER || u.org_role === ROLES.ORG.DEPT_DEPUTY) &&
               u.active === 'true' && u.user_id !== currentUser.user_id;
      });
      if (dl) return dl.user_id;

      // Fallback: Pokud v oddělení chybí DEPT_LEADER, notifikaci dostane vedoucí celého úseku (SECTION_LEADER)
      let slFallback = allUsers.find(function(u) {
        return u.section_id === currentUser.section_id &&
               (u.org_role === ROLES.ORG.SECTION_LEADER || u.org_role === ROLES.ORG.SECTION_DEPUTY) &&
               u.active === 'true' && u.user_id !== currentUser.user_id;
      });
      return slFallback ? slFallback.user_id : null;
    }

    const toUpdate = [];
    const toInsert = [];
    // Sbírá pending záznamy pro vytvoření notifikace po uložení
    let pendingEntries = []; // { attendance_id, date, slot, status_id }
    let approverId = null;
    // Sbírá úspěšně uložené záznamy pro CalendarSync
    const calSyncEntries = [];

    for (let i = 0; i < entries.length; i++) {
      let e = entries[i];
      let statusId = _getWritableStatusId(e.status_id);
      let canEdit = e.user_id === currentUser.user_id || isAdminUser;
      if (!canEdit) {
        let tu = userMap[e.user_id] || null;
        canEdit = tu ? Auth.canAccessUserData(tu) : false;
      }
      if (!canEdit) continue;

      let slot = e.slot || 'ALL_DAY';
      let datePfx = _toPfx(e.date, transDB);
      calSyncEntries.push({ user_id: e.user_id, date: datePfx, slot: slot, status_id: statusId });
      let needsApproval = _isApprovalNeeded(statusId, e.user_id);
      let approvedVal = needsApproval ? APPROVAL_STATUS.PENDING : APPROVAL_STATUS.NOT_REQUIRED;

      // O(1) lookup přes předpočítaný index místo O(n) průchodu celé tabulky
      let lookupKey = e.user_id + '_' + datePfx + '_' + slot;
      let existIdx = attIndex[lookupKey] !== undefined ? attIndex[lookupKey] : -1;

      if (existIdx !== -1) {
        let existingAid = allRows[existIdx][aidIdx];
        allRows[existIdx][statIdx] = statusId;
        allRows[existIdx][noteIdx] = e.note || '';
        allRows[existIdx][apprIdx] = approvedVal;
        if (catIdx !== -1) allRows[existIdx][catIdx] = new Date().toISOString();
        if (wstIdx !== -1) allRows[existIdx][wstIdx] = e.work_start_time ? "'" + e.work_start_time : '';
        toUpdate.push({ row: existIdx + 2, values: allRows[existIdx].slice() });
        if (needsApproval) {
          pendingEntries.push({ attendance_id: existingAid, user_id: e.user_id, date: datePfx, slot: slot, status_id: statusId });
        }
      } else {
        let newAid = Utilities.getUuid();
        let newRow = headers.map(function() { return ''; });
        newRow[aidIdx]  = newAid;
        newRow[uidIdx]  = e.user_id;
        newRow[dateIdx] = "'" + datePfx;
        newRow[slotIdx] = slot;
        newRow[statIdx] = statusId;
        newRow[noteIdx] = e.note || '';
        newRow[apprIdx] = approvedVal;
        if (catIdx !== -1) newRow[catIdx] = new Date().toISOString();
        if (wstIdx !== -1) newRow[wstIdx] = e.work_start_time ? "'" + e.work_start_time : '';
        toInsert.push(newRow);
        attIndex[lookupKey] = allRows.length; // udržuj index aktuální pro případ duplicit ve vstupu
        allRows.push(newRow);
        if (needsApproval) {
          pendingEntries.push({ attendance_id: newAid, user_id: e.user_id, date: datePfx, slot: slot, status_id: statusId });
        }
      }
    }

    // Zjistit approverId jen jednou (všechny pending záznamy mají stejného schvalovatele)
    if (pendingEntries.length > 0) {
      approverId = _findApproverId();
    }

    // Zápis je cílený po řádcích. Záměrně nepřepisujeme celý ATTENDANCE sheet,
    // aby běžný autosave nikdy nemohl při chybě smazat větší část databáze.
    const updatedRows = new Set();
    toUpdate.forEach(function(item) {
      if (updatedRows.has(item.row)) return;
      sheet.getRange(item.row, 1, 1, headers.length).setValues([item.values]);
      updatedRows.add(item.row);
    });
    if (toInsert.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, toInsert.length, headers.length).setValues(toInsert);
    }
    _auditLog("ATTENDANCE_SAVE_BATCH", {
      input_count: entries.length,
      updated_count: updatedRows.size,
      inserted_count: toInsert.length
    }, currentUser);

    // Vytvořit notifikaci pro schvalovatele
    if (pendingEntries.length > 0 && approverId) {
      _createVacationNotification(approverId, currentUser.user_id, pendingEntries);
    }

    // --- AGRESIVNÍ SYNCHRONIZACE REZERVACÍ STOLŮ ---
    try {
      SpreadsheetApp.flush(); 
      const sysDb = DB.getSystem();
      
      const statuses = DB.getTable(DB.getCore(), DB_SHEETS.CORE.ATTENDANCE_STATUSES);
      const deskStatusIds = statuses
        .filter(function(s) { return String(s.allows_desk_reservation).toLowerCase() === 'true'; })
        .map(function(s) { return s.status_id; });
      
      // Deduplikace affected pairs pomocí Set – O(entries) místo O(entries²)
      const affectedPairSet = new Set();
      const affectedPairs = [];
      entries.forEach(function(e) {
        const d = _toPfx(e.date, transDB);
        const k = e.user_id + '_' + d;
        if (!affectedPairSet.has(k)) {
          affectedPairSet.add(k);
          affectedPairs.push({ userId: e.user_id, date: d });
        }
      });

      const dbRows = sheet.getDataRange().getValues();
      const h = dbRows[0];
      const dbUidIdx = h.indexOf('user_id');
      const dbDateIdx = h.indexOf('date');
      const dbStatIdx = h.indexOf('status_id');

      // Build Set pro O(1) lookup – místo O(pairs × rows) .some() v cyklu
      const deskStatusSet = new Set(deskStatusIds);
      const hasDeskAttendance = new Set();
      for (let ri = 1; ri < dbRows.length; ri++) {
        const r = dbRows[ri];
        if (deskStatusSet.has(String(r[dbStatIdx]))) {
          hasDeskAttendance.add(r[dbUidIdx] + '_' + _toPfx(r[dbDateIdx], transDB));
        }
      }

      affectedPairs.forEach(function(pair) {
        const stillNeedsDesk = hasDeskAttendance.has(pair.userId + '_' + pair.date);

        if (!stillNeedsDesk) {
          Admin.clearUserReservations(pair.userId, pair.date);
          DB.insertRow(sysDb, DB_SHEETS.SYSTEM.AUDIT_LOG, {
            timestamp: new Date().toISOString(),
            user_email: pair.userId,
            action: "AUTO_CLEAR_RESERVATION",
            details: "Datum: " + pair.date + " | Statusy nevyžadují stůl."
          });
        }
      });
    } catch (resErr) {
      console.error("SYNC ERROR: " + resErr.toString());
    }
    // -------------------------------------------------

    // --- CALENDAR SYNC ---
    try {
      if (typeof CalendarSync !== 'undefined' && calSyncEntries.length > 0) {
        calSyncEntries.forEach(function(ce) {
          var st = statusMap[ce.status_id];
          if (!st) return;
          var targetUser = userMap[ce.user_id];
          var name = targetUser
            ? ((targetUser.first_name || '') + ' ' + (targetUser.last_name || '')).trim()
            : ce.user_id;
          CalendarSync.syncPersonalEvent(ce.user_id, ce.date, ce.slot, st.name);
          CalendarSync.syncTeamEvent(ce.user_id, ce.date, ce.slot, st, name);
        });
      }
    } catch (calErr) {
      console.error('CALENDAR SYNC ERROR: ' + calErr.toString());
    }
    // -------------------------------------------------

    return {
      success: true,
      saved: toUpdate.length + toInsert.length,
      pendingApproval: pendingEntries.length > 0,
      pendingEntries: pendingEntries
    };
  } catch (e) {
    return { success: false, error: e.toString() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Schválí docházkové záznamy dovolené (batch). Volá vedoucí/admin.
 * entryIds = pole attendance_id řetězců
 */
function approveVacationEntries(entryIds) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { success: false, error: "Zápis právě probíhá. Zkuste to prosím znovu za okamžik." };
  try {
    const currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: "Neautorizováno." };
    if (!Auth.canApproveVacation(currentUser)) return { success: false, error: "Nedostatečná oprávnění." };
    if (!Array.isArray(entryIds) || entryIds.length === 0) return { success: false, error: "Žádné záznamy." };

    const transSS = DB.getTransaction();
    const sheet = transSS.getSheetByName(DB_SHEETS.TRANSACTION.ATTENDANCE);
    if (!sheet) return { success: false, error: "ATTENDANCE sheet nenalezen." };
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const aidIdx  = headers.indexOf('attendance_id');
    const apprIdx = headers.indexOf('approved');
    const uidIdx  = headers.indexOf('user_id');
    const statIdx = headers.indexOf('status_id');
    const allUsers = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
    const userMap = {};
    allUsers.forEach(function(u) { userMap[u.user_id] = u; });
    const positions = DB.getTable(DB.getCore(), DB_SHEETS.CORE.POSITIONS);
    const statuses = DB.getTable(DB.getCore(), DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    const statusMap = {};
    statuses.forEach(function(s) { statusMap[Privacy.normalizeStatusId(s.status_id)] = s; });
    const rbacConfig = Admin.getRbacConfig ? Admin.getRbacConfig() : {};

    // Sbíráme user_id požadatelů pro notifikace
    const requesterSet = new Set();

    for (let i = 1; i < data.length; i++) {
      if (entryIds.indexOf(data[i][aidIdx]) !== -1) {
        if (!_canManageTargetAttendance(currentUser, userMap[data[i][uidIdx]], positions, rbacConfig)) continue;
        if (!_isVacationStatusId(data[i][statIdx], statusMap)) continue;
        sheet.getRange(i + 1, apprIdx + 1).setValue(APPROVAL_STATUS.APPROVED);
        requesterSet.add(data[i][uidIdx]);
      }
    }

    // Notifikace zaměstnancům — schválení
    let ids = Array.from(requesterSet);
    ids.forEach(function(uid) {
      _createUserNotification(uid, NOTIFICATION_TYPES.VACATION_APPROVED, 'Dovolená schválena',
        'Vaše žádost o dovolenou byla schválena.');
    });

    // Označit schvalovací notifikace jako přečtené
    _markVacationNotifsProcessed(ids);

    _auditLog("VACATION_APPROVED", { count: ids.length, entry_ids: entryIds }, currentUser);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Zamítne docházkové záznamy dovolené (batch). Volá vedoucí/admin.
 * entryIds = pole attendance_id řetězců
 */
function rejectVacationEntries(entryIds) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { success: false, error: "Zápis právě probíhá. Zkuste to prosím znovu za okamžik." };
  try {
    const currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: "Neautorizováno." };
    if (!Auth.canApproveVacation(currentUser)) return { success: false, error: "Nedostatečná oprávnění." };
    if (!Array.isArray(entryIds) || entryIds.length === 0) return { success: false, error: "Žádné záznamy." };

    const transSS = DB.getTransaction();
    const sheet = transSS.getSheetByName(DB_SHEETS.TRANSACTION.ATTENDANCE);
    if (!sheet) return { success: false, error: "ATTENDANCE sheet nenalezen." };
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const aidIdx = headers.indexOf('attendance_id');
    const uidIdx = headers.indexOf('user_id');
    const apprIdx = headers.indexOf('approved');
    const statIdx = headers.indexOf('status_id');
    const allUsers = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
    const userMap = {};
    allUsers.forEach(function(u) { userMap[u.user_id] = u; });
    const positions = DB.getTable(DB.getCore(), DB_SHEETS.CORE.POSITIONS);
    const statuses = DB.getTable(DB.getCore(), DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    const statusMap = {};
    statuses.forEach(function(s) { statusMap[Privacy.normalizeStatusId(s.status_id)] = s; });
    const rbacConfig = Admin.getRbacConfig ? Admin.getRbacConfig() : {};

    let requesterIds = [];
    for (let i = 1; i < data.length; i++) {
      if (entryIds.indexOf(data[i][aidIdx]) !== -1) {
        if (!_canManageTargetAttendance(currentUser, userMap[data[i][uidIdx]], positions, rbacConfig)) continue;
        if (!_isVacationStatusId(data[i][statIdx], statusMap)) continue;
        sheet.getRange(i + 1, apprIdx + 1).setValue(APPROVAL_STATUS.REJECTED);
        let uid = data[i][uidIdx];
        if (requesterIds.indexOf(uid) === -1) requesterIds.push(uid);
      }
    }

    // Notifikace zaměstnancům — zamítnutí
    requesterIds.forEach(function(uid) {
      _createUserNotification(uid, NOTIFICATION_TYPES.VACATION_REJECTED, 'Dovolená zamítnuta',
        'Vaše žádost o dovolenou byla zamítnuta.');
    });

    _markVacationNotifsProcessed(requesterIds);

    _auditLog("VACATION_REJECTED", { count: requesterIds.length, entry_ids: entryIds }, currentUser);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Vytvoří notifikaci pro schvalovatele dovolené.
 */
function _createVacationNotification(approverId, requesterId, entries) {
  try {
    let msg = JSON.stringify({ requester_id: requesterId, entries: entries });
    DB.insertRow(DB.getSystem(), DB_SHEETS.SYSTEM.NOTIFICATIONS, {
      notif_id:  Utilities.getUuid(),
      user_id:   approverId,
      title:     'Žádost o dovolenou',
      message:   msg,
      type:      NOTIFICATION_TYPES.VACATION_APPROVAL_REQUEST,
      read:      'false',
      timestamp: "'" + new Date().toISOString()
    });
  } catch (e) {
    console.warn('_createVacationNotification error: ' + e.toString());
  }
}

/**
 * Vytvoří notifikaci pro zaměstnance (schválení/zamítnutí).
 */
function _createUserNotification(userId, type, title, message) {
  try {
    DB.insertRow(DB.getSystem(), DB_SHEETS.SYSTEM.NOTIFICATIONS, {
      notif_id:  Utilities.getUuid(),
      user_id:   userId,
      title:     title,
      message:   message,
      type:      type,
      read:      'false',
      timestamp: "'" + new Date().toISOString()
    });
  } catch (e) {
    console.warn('_createUserNotification error: ' + e.toString());
  }
}

/**
 * Zpracuje rozhodnutí schvalovatele najednou — část schválí, část zamítne.
 * approvedIds = pole attendance_id ke schválení
 * rejectedIds = pole attendance_id k zamítnutí
 * Odešle jednu souhrnnou notifikaci na uživatele.
 */
function processVacationDecisions(approvedIds, rejectedIds) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { success: false, error: "Zápis právě probíhá. Zkuste to prosím znovu za okamžik." };
  try {
    const currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: 'Neautorizováno.' };
    if (!Auth.canApproveVacation(currentUser)) return { success: false, error: 'Nedostatečná oprávnění.' };

    approvedIds = Array.isArray(approvedIds) ? approvedIds : [];
    rejectedIds = Array.isArray(rejectedIds) ? rejectedIds : [];
    if (approvedIds.length === 0 && rejectedIds.length === 0) return { success: true };

    const transSS = DB.getTransaction();
    const sheet = transSS.getSheetByName(DB_SHEETS.TRANSACTION.ATTENDANCE);
    if (!sheet) return { success: false, error: 'ATTENDANCE sheet nenalezen.' };

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const aidIdx  = headers.indexOf('attendance_id');
    const apprIdx = headers.indexOf('approved');
    const uidIdx  = headers.indexOf('user_id');
    const dateIdx = headers.indexOf('date');
    const slotIdx = headers.indexOf('slot');
    const statIdx = headers.indexOf('status_id');

    if ([aidIdx, apprIdx, uidIdx, dateIdx, slotIdx, statIdx].some(function(idx) { return idx === -1; })) {
      _auditLog("VACATION_DECISION_BLOCKED", { reason: "missing_headers", headers: headers }, currentUser);
      return { success: false, error: "ATTENDANCE nemá očekávané hlavičky." };
    }

    const allUsers = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
    const userMap = {};
    allUsers.forEach(function(u) { userMap[u.user_id] = u; });
    const positions = DB.getTable(DB.getCore(), DB_SHEETS.CORE.POSITIONS);
    const statuses = DB.getTable(DB.getCore(), DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    const statusMap = {};
    statuses.forEach(function(s) { statusMap[Privacy.normalizeStatusId(s.status_id)] = s; });
    const rbacConfig = Admin.getRbacConfig ? Admin.getRbacConfig() : {};
    const approvedSet = new Set(approvedIds);
    const rejectedSet = new Set(rejectedIds);

    // Per-user sbíráme schválené a zamítnuté záznamy pro notifikaci
    let userApproved = {};  // { uid: [date, ...] }
    let userRejected = {};  // { uid: [date, ...] }
    let approvedCount = 0;
    let rejectedCount = 0;
    let skipped = [];
    let rejectedCalendarDeletes = [];

    // --- Schválení ---
    for (let i = 1; i < data.length; i++) {
      let aid = data[i][aidIdx];
      if (!approvedSet.has(aid)) continue;
      let uid = data[i][uidIdx];
      if (!_canManageTargetAttendance(currentUser, userMap[uid], positions, rbacConfig) ||
          !_isVacationStatusId(data[i][statIdx], statusMap) ||
          String(data[i][apprIdx]) !== APPROVAL_STATUS.PENDING) {
        skipped.push({ attendance_id: aid, user_id: uid, decision: "approve" });
        continue;
      }
      sheet.getRange(i + 1, apprIdx + 1).setValue(APPROVAL_STATUS.APPROVED);
      approvedCount++;
      let dateVal = data[i][dateIdx];
      let slot    = data[i][slotIdx] || 'ALL_DAY';
      let dateStr = dateVal instanceof Date
        ? Utilities.formatDate(dateVal, Session.getScriptTimeZone(), 'dd.MM.yyyy')
        : String(dateVal);
      if (slot !== 'ALL_DAY') dateStr += ' (' + slot + ')';
      if (!userApproved[uid]) userApproved[uid] = [];
      userApproved[uid].push(dateStr);
    }

    // --- Zamítnutí ---
    for (let j = 1; j < data.length; j++) {
      let aid2 = data[j][aidIdx];
      if (!rejectedSet.has(aid2)) continue;
      let uid2 = data[j][uidIdx];
      if (!_canManageTargetAttendance(currentUser, userMap[uid2], positions, rbacConfig) ||
          !_isVacationStatusId(data[j][statIdx], statusMap) ||
          String(data[j][apprIdx]) !== APPROVAL_STATUS.PENDING) {
        skipped.push({ attendance_id: aid2, user_id: uid2, decision: "reject" });
        continue;
      }
      sheet.getRange(j + 1, apprIdx + 1).setValue(APPROVAL_STATUS.REJECTED);
      rejectedCount++;
      let dateVal2 = data[j][dateIdx];
      let slot2    = data[j][slotIdx] || 'ALL_DAY';
      rejectedCalendarDeletes.push({ user_id: uid2, date: _toPfx(dateVal2, transSS), slot: slot2 });
      let dateStr2 = dateVal2 instanceof Date
        ? Utilities.formatDate(dateVal2, Session.getScriptTimeZone(), 'dd.MM.yyyy')
        : String(dateVal2);
      if (slot2 !== 'ALL_DAY') dateStr2 += ' (' + slot2 + ')';
      if (!userRejected[uid2]) userRejected[uid2] = [];
      userRejected[uid2].push(dateStr2);
    }

    // --- Jedna souhrnná notifikace per uživatel ---
    let allUids = Object.keys(userApproved).concat(Object.keys(userRejected))
      .filter(function(v, i, a) { return a.indexOf(v) === i; });

    allUids.forEach(function(uid) {
      let approvedDates = userApproved[uid] || [];
      let rejectedDates = userRejected[uid] || [];
      let parts = [];
      if (approvedDates.length > 0) {
        parts.push('Schváleno: ' + approvedDates.join(', '));
      }
      if (rejectedDates.length > 0) {
        parts.push('Zamítnuto: ' + rejectedDates.join(', '));
      }
      let message = parts.join(' | ');
      let hasApproved = approvedDates.length > 0;
      let hasRejected = rejectedDates.length > 0;
      let type  = hasApproved && hasRejected ? NOTIFICATION_TYPES.VACATION_APPROVED :
                  hasApproved ? NOTIFICATION_TYPES.VACATION_APPROVED : NOTIFICATION_TYPES.VACATION_REJECTED;
      let title = hasApproved && hasRejected ? 'Dovolená částečně schválena' :
                  hasApproved ? 'Dovolená schválena' : 'Dovolená zamítnuta';
      _createUserNotification(uid, type, title, message);
    });

    // Označit schvalovací notifikace jako zpracované
    _markVacationNotifsProcessed(allUids);

    try {
      if (typeof CalendarSync !== 'undefined') {
        rejectedCalendarDeletes.forEach(function(e) {
          CalendarSync.deletePersonalEvent(e.user_id, e.date, e.slot);
          CalendarSync.deleteTeamEvent(e.user_id, e.date, e.slot);
        });
      }
    } catch (calErr) {
      console.error("VACATION REJECT CALENDAR DELETE ERROR: " + calErr.toString());
    }

    _auditLog("VACATION_DECISIONS_PROCESSED", {
      approved_count: approvedCount,
      rejected_count: rejectedCount,
      skipped_count: skipped.length,
      skipped_sample: skipped.slice(0, 20)
    }, currentUser);

    return { success: true, approvedCount: approvedCount, rejectedCount: rejectedCount, skippedCount: skipped.length };
  } catch (e) {
    return { success: false, error: e.toString() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Označí VACATION_APPROVAL_REQUEST notifikace pro dané zaměstnance jako přečtené.
 */
function _markVacationNotifsProcessed(requesterIds) {
  try {
    const sheet = DB.getSystem().getSheetByName(DB_SHEETS.SYSTEM.NOTIFICATIONS);
    if (!sheet) return;
    const data = sheet.getDataRange().getValues();
    const h = data[0];
    const typeIdx = h.indexOf('type');
    const rdIdx   = h.indexOf('read');
    const msgIdx  = h.indexOf('message');
    for (let i = 1; i < data.length; i++) {
      if (data[i][typeIdx] !== NOTIFICATION_TYPES.VACATION_APPROVAL_REQUEST) continue;
      try {
        let payload = JSON.parse(data[i][msgIdx]);
        if (requesterIds.indexOf(payload.requester_id) !== -1) {
          sheet.getRange(i + 1, rdIdx + 1).setValue('true');
        }
      } catch (pe) { /* JSON parse error, skip */ }
    }
  } catch (e) {
    console.warn('_markVacationNotifsProcessed error: ' + e.toString());
  }
}

/**
 * Smaže docházkový záznam pro daný user_id, datum a slot.
 */
function clearAttendanceEntry(userId, date, slot) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { success: false, error: "Zápis právě probíhá. Zkuste to prosím znovu za okamžik." };
  try {
    const currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: "Neautorizováno." };

    const allUsers = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
    const targetUser = allUsers.find(function(u) { return u.user_id === userId; });
    const positions = DB.getTable(DB.getCore(), DB_SHEETS.CORE.POSITIONS);
    const rbacConfig = Admin.getRbacConfig ? Admin.getRbacConfig() : {};
    let canEdit = _canManageTargetAttendance(currentUser, targetUser, positions, rbacConfig);
    if (!canEdit) return { success: false, error: "Nedostatečná oprávnění." };

    const slotVal = slot || 'ALL_DAY';
    const transSS = DB.getTransaction();
    const datePfx = _toPfx(date, transSS);
    const sheet = transSS.getSheetByName(DB_SHEETS.TRANSACTION.ATTENDANCE);
    if (!sheet) return { success: true };

    const data = sheet.getDataRange().getValues();
    const h = data[0];
    const uidIdx  = h.indexOf('user_id');
    const dateIdx = h.indexOf('date');
    const slotIdx = h.indexOf('slot');

    // Můžeme smazat buď jeden konkrétní slot, nebo vše pro daný den ('*')
    for (let i = data.length - 1; i >= 1; i--) {
      let match = (data[i][uidIdx] === userId && _toPfx(data[i][dateIdx], transSS) === datePfx);
      if (match) {
        if (slotVal === '*' || data[i][slotIdx] === slotVal) {
          sheet.deleteRow(i + 1);
          if (slotVal !== '*') break; // Pokud mažeme vše, pokračujeme, jinak konec
        }
      }
    }
    _auditLog("ATTENDANCE_DELETE_SINGLE", { user_id: userId, date: datePfx, slot: slotVal }, currentUser);

    // Pokud mažeme celý den nebo konkrétní slot, prověříme zda nezmizel nárok na stůl
    try {
      SpreadsheetApp.flush(); 
      const statuses = DB.getTable(DB.getCore(), DB_SHEETS.CORE.ATTENDANCE_STATUSES);
      const deskStatusIds = statuses
        .filter(function(s) { return String(s.allows_desk_reservation).toLowerCase() === 'true'; })
        .map(function(s) { return s.status_id; });

      const remainingRows = sheet.getDataRange().getValues();
      const h = remainingRows[0];
      const dbUidIdx = h.indexOf('user_id');
      const dbDateIdx = h.indexOf('date');
      const dbStatIdx = h.indexOf('status_id');

      const stillNeedsDesk = remainingRows.some(function(r, idx) {
        if (idx === 0) return false;
        const rDate = _toPfx(r[dbDateIdx], transSS);
        return r[dbUidIdx] === userId && rDate === datePfx && deskStatusIds.indexOf(r[dbStatIdx]) !== -1;
      });

      if (!stillNeedsDesk) {
        Admin.clearUserReservations(userId, datePfx);
        DB.insertRow(DB.getSystem(), DB_SHEETS.SYSTEM.AUDIT_LOG, {
          timestamp: new Date().toISOString(),
          user_email: userId,
          action: "AUTO_CLEAR_RESERVATION_ON_DELETE",
          details: "Datum: " + datePfx
        });
      }
    } catch (resErr) {
      console.error("SYNC DELETE ERROR: " + resErr.toString());
    }
    // -------------------------------------------------

    // --- CALENDAR SYNC ---
    try {
      if (typeof CalendarSync !== 'undefined') {
        if (slotVal === '*') {
          ['ALL_DAY', 'AM', 'PM'].forEach(function(s) {
            CalendarSync.deletePersonalEvent(userId, datePfx, s);
            CalendarSync.deleteTeamEvent(userId, datePfx, s);
          });
        } else {
          CalendarSync.deletePersonalEvent(userId, datePfx, slotVal);
          CalendarSync.deleteTeamEvent(userId, datePfx, slotVal);
        }
      }
    } catch (calErr) {
      console.error('CALENDAR DELETE SYNC ERROR: ' + calErr.toString());
    }
    // -------------------------------------------------

    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Hromadně smaže docházkové záznamy.
 */
function clearAttendanceEntries(entries) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { success: false, error: "Zápis právě probíhá. Zkuste to prosím znovu za okamžik." };
  try {
    const currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: "Neautorizováno." };
    if (!Array.isArray(entries)) return { success: false, error: "Neplatný požadavek na mazání." };
    if (entries.length > 100) {
      _auditLog("ATTENDANCE_DELETE_BLOCKED", { reason: "too_many_entries", requested_count: entries.length }, currentUser);
      return { success: false, error: "Příliš mnoho záznamů k mazání najednou. Akce byla z bezpečnostních důvodů zastavena." };
    }

    const allUsers = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
    const userMap = {};
    allUsers.forEach(function(u) { userMap[u.user_id] = u; });
    const positions = DB.getTable(DB.getCore(), DB_SHEETS.CORE.POSITIONS);
    const rbacConfig = Admin.getRbacConfig ? Admin.getRbacConfig() : {};

    const transSS = DB.getTransaction();
    const sheet = transSS.getSheetByName(DB_SHEETS.TRANSACTION.ATTENDANCE);
    if (!sheet) return { success: true };

    const data = sheet.getDataRange().getValues();
    const h = data[0];
    const uidIdx  = h.indexOf('user_id');
    const dateIdx = h.indexOf('date');
    const slotIdx = h.indexOf('slot');

    // Množina klíčů ke smazání
    const deleteKeys = new Set();
    const calSyncDeletes = [];
    
    entries.forEach(function(e) {
      let canEdit = _canManageTargetAttendance(currentUser, userMap[e.user_id], positions, rbacConfig);
      if (canEdit) {
        let datePfx = _toPfx(e.date, transSS);
        let slotVal = e.slot || 'ALL_DAY';
        // Safe Cleanup: Pokud mažeme celodenní (ALL_DAY) nebo explicitně vše (*), 
        // musíme vyčistit i AM/PM zbytky. V opačném případě vyčistíme konkrétní slot
        // a preventivně i případný celodenní status, který by s ním kolidoval.
        if (slotVal === '*' || slotVal === 'ALL_DAY') {
          ['ALL_DAY', 'AM', 'PM'].forEach(function(s) { deleteKeys.add(e.user_id + '_' + datePfx + '_' + s); });
        } else {
          deleteKeys.add(e.user_id + '_' + datePfx + '_' + slotVal);
          deleteKeys.add(e.user_id + '_' + datePfx + '_ALL_DAY'); // Preventivně smaž i kolidující ALL_DAY
        }
        calSyncDeletes.push({ user_id: e.user_id, date: datePfx, slot: slotVal });
      }
    });

    if (deleteKeys.size === 0) return { success: true };
    if (deleteKeys.size > 150) {
      _auditLog("ATTENDANCE_DELETE_BLOCKED", { reason: "too_many_keys", requested_count: entries.length, delete_key_count: deleteKeys.size }, currentUser);
      return { success: false, error: "Mazání by zasáhlo příliš mnoho buněk. Akce byla zastavena." };
    }

    let rowsToDelete = [];
    for (let i = 1; i < data.length; i++) {
        let key = data[i][uidIdx] + '_' + _toPfx(data[i][dateIdx], transSS) + '_' + (data[i][slotIdx] || 'ALL_DAY');
        if (deleteKeys.has(key)) {
            rowsToDelete.push(i + 1); // 1-based pro uložení
        }
    }

    if (rowsToDelete.length > 0) {
        if (rowsToDelete.length > 150 || rowsToDelete.length >= data.length - 1) {
          _auditLog("ATTENDANCE_DELETE_BLOCKED", { reason: "unsafe_row_count", rows_to_delete: rowsToDelete.length, total_rows: data.length - 1 }, currentUser);
          return { success: false, error: "Mazání by zasáhlo podezřele mnoho záznamů. Akce byla zastavena." };
        }

        rowsToDelete.sort(function(a, b) { return b - a; }).forEach(function(rowNo) {
          sheet.deleteRow(rowNo);
        });
        _auditLog("ATTENDANCE_DELETE_BATCH", {
          requested_count: entries.length,
          deleted_rows: rowsToDelete.length,
          keys_sample: Array.from(deleteKeys).slice(0, 30)
        }, currentUser);
        
        // Desk Sync
        try {
          SpreadsheetApp.flush(); 
          const statuses = DB.getTable(DB.getCore(), DB_SHEETS.CORE.ATTENDANCE_STATUSES);
          const deskStatusIds = statuses
            .filter(function(s) { return String(s.allows_desk_reservation).toLowerCase() === 'true'; })
            .map(function(s) { return s.status_id; });
    
          const remainingRows = sheet.getDataRange().getValues();
          const dbUidIdx = h.indexOf('user_id');
          const dbDateIdx = h.indexOf('date');
          const dbStatIdx = h.indexOf('status_id');
          
          const hasDeskMap = new Set();
          for (let ri = 1; ri < remainingRows.length; ri++) {
            if (deskStatusIds.indexOf(String(remainingRows[ri][dbStatIdx])) !== -1) {
              hasDeskMap.add(remainingRows[ri][dbUidIdx] + '_' + _toPfx(remainingRows[ri][dbDateIdx], transSS));
            }
          }
    
          calSyncDeletes.forEach(function(e) {
             let k = e.user_id + '_' + e.date;
             if (!hasDeskMap.has(k)) {
                Admin.clearUserReservations(e.user_id, e.date);
                DB.insertRow(DB.getSystem(), DB_SHEETS.SYSTEM.AUDIT_LOG, {
                  timestamp: new Date().toISOString(),
                  user_email: e.user_id,
                  action: "AUTO_CLEAR_RESERVATION_ON_DELETE",
                  details: "Datum: " + e.date
                });
             }
          });
        } catch (resErr) {
          console.error("SYNC DELETE ERROR: " + resErr.toString());
        }

        // CalendarSync
        try {
          if (typeof CalendarSync !== 'undefined') {
            calSyncDeletes.forEach(function(e) {
                if (e.slot === '*') {
                  ['ALL_DAY', 'AM', 'PM'].forEach(function(s) {
                    CalendarSync.deletePersonalEvent(e.user_id, e.date, s);
                    CalendarSync.deleteTeamEvent(e.user_id, e.date, s);
                  });
                } else {
                  CalendarSync.deletePersonalEvent(e.user_id, e.date, e.slot);
                  CalendarSync.deleteTeamEvent(e.user_id, e.date, e.slot);
                }
            });
          }
        } catch (calErr) {
          console.error("CALENDAR DELETE SYNC ERROR: " + calErr.toString());
        }
    }
    
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * POMOCNÁ FUNKCE: Resetuje aplikaci do továrního nastavení.
 * Smaže Script Properties, čímž vynutí znovu spuštění Wizardu.
 * Spouštějte pouze ručně z editoru pro účely testování.
 */
function RESET_APP_FOR_WIZARD() {
  if (!Auth.hasSystemRole(ROLES.SYSTEM.SUPERADMIN)) {
    throw new Error("Nedostatečná oprávnění. Pouze SUPERADMIN může resetovat aplikaci.");
  }
  const props = PropertiesService.getScriptProperties();
  props.deleteAllProperties();
  console.log("Aplikace byla resetována. Při příštím otevření se spustí Wizard.");
}
/**
 * Aktualizuje aktivitu uživatele (heartbeat).
 */
function updateUserActivity() {
  try {
    const user = Auth.getCurrentUser();
    if (!user) return { success: false };
    
    const coreSS = DB.getCore();
    const sheet = coreSS.getSheetByName(DB_SHEETS.CORE.USERS);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const uidIdx = headers.indexOf('user_id');
    const actIdx = headers.indexOf('last_active');
    
    if (uidIdx === -1 || actIdx === -1) return { success: false };
    
    const now = new Date().toISOString();
    for (let i = 1; i < data.length; i++) {
        if (data[i][uidIdx] === user.user_id) {
            sheet.getRange(i + 1, actIdx + 1).setValue(now);
            return { success: true };
        }
    }
    return { success: false };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Získá statistiky pro daný den.
 */
function getDailyStats(dateStr) {
  try {
    const currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: "Neautorizováno." };

    const coreSS = DB.getCore();
    const transSS = DB.getTransaction();
    
    const date = dateStr ? new Date(dateStr) : new Date();
    const isoDate = _toPfx(date, transSS);
    
    const allUsers = DB.getTable(coreSS, DB_SHEETS.CORE.USERS);
    const allAttendance = DB.getTable(transSS, DB_SHEETS.TRANSACTION.ATTENDANCE);
    const statuses = Privacy.ensureFallbackMaskStatus(DB.getTable(coreSS, DB_SHEETS.CORE.ATTENDANCE_STATUSES));
    const positions = DB.getTable(coreSS, DB_SHEETS.CORE.POSITIONS);
    const rbacConfig = Admin.getRbacConfig ? Admin.getRbacConfig() : {};
    const privacyCtx = Privacy.createContext({
      viewer: currentUser,
      positions: positions,
      statuses: statuses,
      rbacConfig: rbacConfig
    });
    
    const dayAttendance = allAttendance.filter(a => {
        if (_isRejectedAttendance(a)) return false;
        const dStr = _toPfx(a.date, transSS);
        return dStr === isoDate;
    });

    const activeUsers = allUsers.filter(function(u) {
      if (u.active === 'false') return false;
      return Auth.canAccessUserData(u, rbacConfig);
    });
    const now = new Date();
    const onlineThresholdMinutes = 10;

    // Statusy do mapy pro O(1) lookup
    const statusMap = {};
    statuses.forEach(s => statusMap[s.status_id] = s);

    // Docházka dne do mapy user_id → záznamy pro O(1) lookup místo O(n×m)
    const attByUser = {};
    dayAttendance.forEach(a => {
      if (!attByUser[a.user_id]) attByUser[a.user_id] = [];
      attByUser[a.user_id].push(a);
    });
    
    const stats = {
      date: isoDate,
      namedDay: CalendarData.getNamedDay(date),
      online: [],
      totalCount: activeUsers.length,
      unfilled: [],
      kancelar: [],
      homeoffice: [],
      dovolena: [],
      ostatni: []
    };
    
    activeUsers.forEach(u => {
      // Online status (last_active v posledních 10 min)
      if (u.last_active) {
        const lastActive = new Date(u.last_active);
        // Srovnání ISO řetězců nebo Date objektů - zajistíme robustnost
        const diffMs = now.getTime() - lastActive.getTime();
        if (diffMs > 0 && diffMs / 1000 / 60 < onlineThresholdMinutes) {
          stats.online.push(u.first_name + " " + u.last_name);
        }
      }
      
      const userAtt = attByUser[u.user_id] || [];
      if (userAtt.length === 0) {
        stats.unfilled.push(u.first_name + " " + u.last_name);
        return;
      }
      
      const primaryRaw = userAtt.find(a => a.slot === 'ALL_DAY') || userAtt.find(a => a.slot === 'AM') || userAtt[0];
      const primary = Privacy.prepareAttendanceEntry(primaryRaw, u, privacyCtx);
      const status = statusMap[primary.status_id];
      if (!status) {
        stats.unfilled.push(u.first_name + " " + u.last_name);
        return;
      }
      
      const fullName = u.first_name + " " + u.last_name;
      const sName = status.name ? status.name.toLowerCase() : "";
      const sCat = status.category ? status.category.toLowerCase() : "";
      const color = status.color || "#94a3b8";

      const item = { name: fullName, status: status.name, color: color, category: status.category || "Ostatní" };

      if (sName.includes('kancelář')) {
        stats.kancelar.push(item);
      } else if (sName.includes('homeoffice') || sName.includes('home office')) {
        stats.homeoffice.push(item);
      } else if (sCat.includes('volno') || sCat.includes('absence') || sName.includes('dovolená') || sName.includes('volno')) {
        stats.dovolena.push(item);
      } else {
        stats.ostatni.push(item);
      }
    });
    
    return { success: true, stats: stats };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Uloží nebo aktualizuje událost v plánovači s kontrolou oprávnění.
 */
function savePlannerEvent(event) {
  try {
    const user = Auth.getCurrentUser();
    if (!user) throw new Error("Uživatel nenalezen.");

    const coreSS = DB.getCore();
    const transSS = DB.getTransaction();
    const memberships = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS);
    
    const membership = memberships.find(m => String(m.group_id) === String(event.group_id) && String(m.user_id) === String(user.user_id));
    if (!membership) throw new Error("Nemáte přístup k této plánovací skupině.");
    
    if (membership.permission === 'VIEW') throw new Error("K této skupině máte pouze právo náhledu.");

    const sheetName = DB_SHEETS.TRANSACTION.PLANNER_EVENTS;
    
    // Záchrana DB: oprava hlaviček pro události
    const evSheet = transSS.getSheetByName(sheetName);
    if (evSheet) {
      let lc = Math.max(1, evSheet.getLastColumn());
      let heads = evSheet.getRange(1, 1, 1, lc).getValues()[0];
      if (heads.indexOf("description") === -1 || heads.indexOf("group_id") === -1) {
        if (typeof Setup !== 'undefined' && Setup.setHeaders) {
          Setup.setHeaders(evSheet, sheetName);
        }
      }
    }
    
    if (!event.event_id) {
       // Vytvoření nové události
       event.user_id = user.user_id;
       event.event_id = Utilities.getUuid();
       DB.insertRow(transSS, sheetName, event);
    } else {
       // Aktualizace stávající
       const all = DB.getTable(transSS, sheetName);
       const idx = all.findIndex(e => e.event_id === event.event_id);
       if (idx === -1) throw new Error("Událost nenalezena.");
       
       const existing = all[idx];
       
       // Kontrola oprávnění pro editaci
       // WRITE: může editovat jen své události
       // ADMIN: může editovat vše
       if (membership.permission === 'WRITE' && String(existing.user_id) !== String(user.user_id)) {
          throw new Error("Nemáte oprávnění upravovat cizí události.");
       }
       
       const sheet = transSS.getSheetByName(sheetName);
       const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
       const row = idx + 2;
       const rowValues = headers.map(h => event[h] || (h === 'user_id' ? existing.user_id : ""));
       sheet.getRange(row, 1, 1, headers.length).setValues([rowValues]);
    }
    // --- CALENDAR SYNC ---
    try {
      if (typeof CalendarSync !== 'undefined') {
        var groups = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUPS);
        var grp = groups.find(function(g) { return String(g.group_id) === String(event.group_id); });
        CalendarSync.syncPlannerEvent(
          event.event_id,
          event.group_id,
          event.date,
          event.description || '',
          grp ? grp.name : ''
        );
      }
    } catch (calErr) {
      console.error('CALENDAR PLANNER SYNC ERROR: ' + calErr.toString());
    }
    // -------------------------------------------------

    return { success: true, event_id: event.event_id };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Smaže událost z plánovače s kontrolou oprávnění.
 */
function deletePlannerEvent(eventId) {
  try {
    const user = Auth.getCurrentUser();
    const transSS = DB.getTransaction();
    const coreSS = DB.getCore();
    const sheetName = DB_SHEETS.TRANSACTION.PLANNER_EVENTS;
    const all = DB.getTable(transSS, sheetName);
    const idx = all.findIndex(e => e.event_id === eventId);
    if (idx === -1) return { success: true };
    
    const existing = all[idx];
    const memberships = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS);
    const membership = memberships.find(m => String(m.group_id) === String(existing.group_id) && String(m.user_id) === String(user.user_id));
    
    if (!membership || membership.permission === 'VIEW') throw new Error("Nedostatečná oprávnění ke smazání.");
    
    if (membership.permission === 'WRITE' && String(existing.user_id) !== String(user.user_id)) {
       throw new Error("Nemáte oprávnění mazat cizí události.");
    }

    // --- CALENDAR SYNC (před smazáním, dokud existuje existing) ---
    try {
      if (typeof CalendarSync !== 'undefined') {
        CalendarSync.removePlannerEvent(existing.event_id, existing.group_id);
      }
    } catch (calErr) {
      console.error('CALENDAR PLANNER DELETE SYNC ERROR: ' + calErr.toString());
    }
    // -------------------------------------------------

    transSS.getSheetByName(sheetName).deleteRow(idx + 2);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Vytvoří novou plánovací skupinu a přidá členy.
 */
function createPlannerGroup(data) {
  try {
    const user = Auth.getCurrentUser();
    if (!user) throw new Error("Uživatel nenalezen.");
    
    // Oprávnění k vytvoření (např. ADMIN nebo vedoucí)
    const canCreate = Auth.hasAdminAccess(user) || ['SECTION_LEADER', 'DEPT_LEADER'].includes(user.org_role);
    if (!canCreate) throw new Error("Nemáte oprávnění vytvářet plánovací skupiny.");

    const coreSS = DB.getCore();
    const isUpdate = !!data.group_id;
    const groupId = isUpdate ? data.group_id : Utilities.getUuid();
    
    // Záchrana DB: Pokud Google Tabulka fyzicky nemá sloupečky v hlavičce
    const pgSheet = coreSS.getSheetByName(DB_SHEETS.CORE.PLANNER_GROUPS);
    if (pgSheet) {
      let lc = Math.max(1, pgSheet.getLastColumn());
      let heads = pgSheet.getRange(1, 1, 1, lc).getValues()[0];
      if (heads.indexOf("color") === -1) {
        pgSheet.getRange(1, ++lc).setValue("color").setFontWeight("bold");
      }
      if (heads.indexOf("calendar_id") === -1) {
        pgSheet.getRange(1, ++lc).setValue("calendar_id").setFontWeight("bold");
      }
    }

    // Vytvořit/získat Google Kalendář pro skupinu
    const calId = CalendarSync._getOrCreateGroupCalendar(groupId, data.name, data.color);
    
    if (isUpdate) {
        // Kontrola oprávnění pro update (musí být admin skupiny)
        const memberships = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS);
        const mem = memberships.find(m => String(m.group_id) === String(groupId) && String(m.user_id) === String(user.user_id));
        if (!mem || mem.permission !== 'ADMIN') throw new Error("Ke změně planneru potřebujete práva SPRÁVCE.");
        
        const allGroups = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUPS);
        const idxGroup = allGroups.findIndex(g => String(g.group_id) === String(groupId));
        if (idxGroup !== -1) {
            const rowNumber = idxGroup + 2;
            const headers = pgSheet.getRange(1, 1, 1, pgSheet.getLastColumn()).getValues()[0];
            const updatedGroup = { ...allGroups[idxGroup], name: data.name, color: data.color || 'default', calendar_id: calId };
            const rowValues = headers.map(h => updatedGroup[h] !== undefined ? updatedGroup[h] : "");
            pgSheet.getRange(rowNumber, 1, 1, headers.length).setValues([rowValues]);
        }
        
        // Smazat staré členy, aby se přepsali novými
        const memSheet = coreSS.getSheetByName(DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS);
        const mData = memSheet.getDataRange().getValues();
        for (let i = mData.length - 1; i > 0; i--) {
            if (String(mData[i][0]) === String(groupId)) {
                memSheet.deleteRow(i + 1);
            }
        }
    } else {
        // Založení nového
        const group = {
          group_id: groupId,
          name: data.name,
          description: data.description || "",
          active: "true",
          color: data.color || "default",
          calendar_id: calId
        };
        DB.insertRow(coreSS, DB_SHEETS.CORE.PLANNER_GROUPS, group);
    }
    
    // Záchrana DB: Pokud Google Tabulka fyzicky nemá sloupeček 'permission' v hlavičce, databáze při zápisu hodnotu ignoruje.
    const planMemSheet = coreSS.getSheetByName(DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS);
    if (planMemSheet) {
      let lc = Math.max(1, planMemSheet.getLastColumn());
      let heads = planMemSheet.getRange(1, 1, 1, lc).getValues()[0];
      if (heads.indexOf("permission") === -1) {
        planMemSheet.getRange(1, lc + 1).setValue("permission");
      }
    }

    // Zpracování členů a explicitně vložit/updatovat zakladatele
    const members = data.members || [];
    const hasOtherAdmin = members.some(m => String(m.user_id) !== String(user.user_id) && (m.permission || '').toString().toUpperCase() === 'ADMIN');
    let callerFoundInList = false;
    
    if (members.length > 0) {
      members.forEach(m => {
        let perm = m.permission || 'VIEW';
        
        // Pokud je to volající
        if (String(m.user_id) === String(user.user_id)) {
            callerFoundInList = true;
            // Pokud není jiný admin, musí tento zůstat ADMINem (aby skupina nezůstala bez správce)
            if (!hasOtherAdmin) {
                perm = 'ADMIN';
            }
        }
        
        DB.insertRow(coreSS, DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS, {
          group_id: groupId,
          user_id: m.user_id,
          permission: perm
        });
      });
    }
    
    // Pokud volající nebyl v seznamu (např. se smazal) a není tam jiný admin, automaticky ho vrátíme jako ADMINa
    if (!callerFoundInList && !hasOtherAdmin) {
      DB.insertRow(coreSS, DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS, {
        group_id: groupId,
        user_id: user.user_id,
        permission: 'ADMIN'
      });
    }

    return { success: true, group_id: groupId };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Smaže celou plánovací skupinu (pokud je zakladatel/ADMIN).
 */
function deletePlannerGroup(groupId) {
  try {
    const user = Auth.getCurrentUser();
    if (!user) throw new Error("Neautorizováno.");
    
    const coreSS = DB.getCore();
    const transSS = DB.getTransaction();
    
    // Check permission - pouze ADMIN
    const memberships = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS);
    const m = memberships.find(m => String(m.group_id) === String(groupId) && String(m.user_id) === String(user.user_id));
    if (!m || m.permission !== 'ADMIN') throw new Error("Ke smazání Planneru potřebujete práva SPRÁVCE.");
    
    // Získat kalendář a smazat ho
    const allGroups = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUPS);
    const targetGroup = allGroups.find(g => String(g.group_id) === String(groupId));
    if (targetGroup && targetGroup.calendar_id) {
        try {
            const cal = CalendarApp.getCalendarById(targetGroup.calendar_id);
            if (cal) cal.deleteCalendar();
        } catch(e) {
            console.warn('deletePlannerGroup – smazání kalendáře selhalo: ' + e);
        }
    }
    
    // Smazat skupinu
    const pgSheet = coreSS.getSheetByName(DB_SHEETS.CORE.PLANNER_GROUPS);
    const dataGroups = pgSheet.getDataRange().getValues();
    for (let i = dataGroups.length - 1; i > 0; i--) {
        if (String(dataGroups[i][0]) === String(groupId)) {
            pgSheet.deleteRow(i + 1);
        }
    }
    
    // Smazat členství
    const memSheet = coreSS.getSheetByName(DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS);
    const mData = memSheet.getDataRange().getValues();
    for (let i = mData.length - 1; i > 0; i--) {
        if (String(mData[i][0]) === String(groupId)) {
            memSheet.deleteRow(i + 1);
        }
    }
    
    // Smazat události
    const evSheet = transSS.getSheetByName(DB_SHEETS.TRANSACTION.PLANNER_EVENTS);
    if (evSheet && evSheet.getLastRow() > 0) {
      const eData = evSheet.getDataRange().getValues();
      const h = eData[0];
      const gIdIdx = h.indexOf("group_id");
      if (gIdIdx !== -1) {
        for (let i = eData.length - 1; i > 0; i--) {
            if (String(eData[i][gIdIdx]) === String(groupId)) {
                evSheet.deleteRow(i + 1);
            }
        }
      }
    }
    
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Získá všechny členy konkrétní plánovací skupiny (pro účely editace zakladatelem).
 */
function getPlannerGroupMembers(groupId) {
  try {
    const user = Auth.getCurrentUser();
    if (!user) throw new Error("Neautorizováno.");
    const coreSS = DB.getCore();
    const memberships = DB.getTable(coreSS, DB_SHEETS.CORE.PLANNER_GROUP_MEMBERS);
    
    // Kontrola - vracet jen když je user ADMIN
    const myMem = memberships.find(m => String(m.group_id) === String(groupId) && String(m.user_id) === String(user.user_id));
    if (!myMem || myMem.permission !== 'ADMIN') throw new Error("Nemáte oprávnění prohlížet tuto skupinu.");
    
    const groupMembers = memberships.filter(m => String(m.group_id) === String(groupId)).map(m => {
        return { user_id: m.user_id, permission: m.permission };
    });
    
    return { success: true, members: groupMembers };
  } catch(e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Vrátí log docházkových záznamů pro celý úsek (section) aktuálního uživatele.
 * Seřazeno podle created_at DESC. Vrací max 500 záznamů.
 * @param {number} offset - kolik záznamů přeskočit (pro stránkování)
 * @return {{ success: boolean, entries: Array, hasMore: boolean }}
 */
function getAttendanceLog(offset) {
  try {
    const currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: "Neautorizováno." };

    const coreDb = DB.getCore();
    const allUsers = DB.getTable(coreDb, DB_SHEETS.CORE.USERS);
    const allStatuses = Privacy.ensureFallbackMaskStatus(DB.getTable(coreDb, DB_SHEETS.CORE.ATTENDANCE_STATUSES));
    const positions = DB.getTable(coreDb, DB_SHEETS.CORE.POSITIONS);
    const rbacConfig = Admin.getRbacConfig ? Admin.getRbacConfig() : {};
    const privacyCtx = Privacy.createContext({
      viewer: currentUser,
      positions: positions,
      statuses: allStatuses,
      rbacConfig: rbacConfig
    });

    // Uživatelé ve stejném úseku
    const sectionId = currentUser.section_id;
    const sectionUserMap = {};
    const sectionUserObjMap = {};
    allUsers.forEach(function(u) {
      if (u.section_id === sectionId && u.active === 'true') {
        u.org_role = _resolveOrgRole(u, positions);
        sectionUserMap[u.user_id] = u.first_name + ' ' + u.last_name;
        sectionUserObjMap[u.user_id] = u;
      }
    });

    // Mapa statusů pro enrichment
    const statusMap = {};
    allStatuses.forEach(function(s) {
      statusMap[s.status_id] = { name: s.name || s.status_id, color: s.color || '#94a3b8', icon: s.icon || '' };
    });

    // Načti ATTENDANCE sheet
    const transDB = DB.getTransaction();
    const sheet = transDB.getSheetByName(DB_SHEETS.TRANSACTION.ATTENDANCE);
    if (!sheet || sheet.getLastRow() <= 1) return { success: true, entries: [], hasMore: false };

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const aidIdx  = headers.indexOf('attendance_id');
    const uidIdx  = headers.indexOf('user_id');
    const dateIdx = headers.indexOf('date');
    const statIdx = headers.indexOf('status_id');
    const slotIdx = headers.indexOf('slot');
    const catIdx  = headers.indexOf('created_at');

    const allRows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();

    // Filtruj jen uživatele z úseku a enrichni
    var logEntries = [];
    allRows.forEach(function(r) {
      var uid = r[uidIdx];
      if (!sectionUserMap[uid]) return;
      var createdAt = catIdx !== -1 ? r[catIdx] : '';
      var rawStatusId = r[statIdx];
      var canonicalStatusId = Privacy.getCanonicalStatusId(rawStatusId, privacyCtx);
      var statusId = Privacy.canViewUnmasked(sectionUserObjMap[uid], privacyCtx)
        ? canonicalStatusId
        : Privacy.getMaskedStatusId(canonicalStatusId, privacyCtx);
      logEntries.push({
        attendance_id: r[aidIdx],
        user_id: uid,
        user_name: sectionUserMap[uid],
        date: _toPfx(r[dateIdx], transDB),
        status_id: statusId,
        status_name: (statusMap[statusId] || {}).name || statusId,
        status_color: (statusMap[statusId] || {}).color || '#94a3b8',
        status_icon: (statusMap[statusId] || {}).icon || '',
        slot: r[slotIdx] || 'ALL_DAY',
        created_at: createdAt ? String(createdAt) : ''
      });
    });

    // Seřaď podle created_at DESC (záznamy bez timestampu na konec)
    logEntries.sort(function(a, b) {
      if (!a.created_at && !b.created_at) return 0;
      if (!a.created_at) return 1;
      if (!b.created_at) return -1;
      return b.created_at.localeCompare(a.created_at);
    });

    // Stránkování
    var startIdx = offset || 0;
    var pageSize = 500;
    var page = logEntries.slice(startIdx, startIdx + pageSize);
    var hasMore = (startIdx + pageSize) < logEntries.length;

    return { success: true, entries: page, hasMore: hasMore, total: logEntries.length };
  } catch(e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Vrátí log aktivity všech uživatelů (last_active).
 * Pouze pro roli SUPERADMIN.
 */
function getUserActivityLog(offset) {
  try {
    const currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: "Neautorizováno." };
    
    // Pouze SUPERADMIN
    if (currentUser.system_role !== ROLES.SYSTEM.SUPERADMIN) {
      return { success: false, error: "Nedostatečná oprávnění. Vyžadována role SUPERADMIN." };
    }

    const coreDb = DB.getCore();
    const allUsers = DB.getTable(coreDb, DB_SHEETS.CORE.USERS);
    const depts = DB.getTable(coreDb, DB_SHEETS.CORE.DEPARTMENTS);
    const deptMap = {};
    depts.forEach(function(d) { deptMap[d.department_id] = d.name; });

    // Filtruj uživatele s aktivitou
    var logEntries = [];
    allUsers.forEach(function(u) {
      if (!u.last_active) return;
      logEntries.push({
          user_id: u.user_id,
          user_name: (u.first_name || '') + ' ' + (u.last_name || ''),
          email: u.email,
          dept_name: deptMap[u.department_id] || u.department_id || '—',
          last_active: u.last_active
      });
    });

    // Seřaď podle last_active DESC
    logEntries.sort(function(a, b) {
      return b.last_active.localeCompare(a.last_active);
    });

    // Stránkování
    var startIdx = offset || 0;
    var pageSize = 500;
    var page = logEntries.slice(startIdx, startIdx + pageSize);
    var hasMore = (startIdx + pageSize) < logEntries.length;

    return { success: true, entries: page, hasMore: hasMore, total: logEntries.length };
  } catch(e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Uloží marketingové kampaně (KT, pondělí, čtvrtek). Pouze ADMIN a SUPERADMIN.
 */
function updateMarketingWeeks(rows) {
  try {
    return Admin.updateMarketingWeeks(rows);
  } catch(e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Vyčistí osiřelé kalendáře (existují v Google, ale nemají záznam v DB).
 * Pouze ADMIN a SUPERADMIN.
 */
function cleanupOrphanedCalendars() {
  try {
    var currentUser = Auth.getCurrentUser();
    if (!currentUser) return { success: false, error: 'Neautorizováno.' };
    if (!Auth.hasAdminAccess(currentUser)) return { success: false, error: 'Nedostatečná oprávnění.' };
    return CalendarSync.cleanupOrphanedCalendars();
  } catch(e) {
    return { success: false, error: e.toString() };
  }
}
