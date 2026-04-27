/**
 * Modul pro autentizaci a správu rolí.
 */

var Auth = {
  _currentUserCache: null,

  /**
   * Získá aktuálně přihlášeného uživatele.
   */
  getCurrentUser: function() {
    if (this._currentUserCache) return this._currentUserCache;
    const email = Session.getActiveUser().getEmail().toLowerCase();
    const allUsers = DB.getTable(DB.getCore(), DB_SHEETS.CORE.USERS);
    
    this._currentUserCache = allUsers.find(u => u.email && u.email.toLowerCase() === email) || null;
    return this._currentUserCache;
  },

  /**
   * Ověří, zda má uživatel danou systémovou roli.
   */
  hasSystemRole: function(role) {
    const user = this.getCurrentUser();
    if (!user) return false;
    
    if (user.system_role === ROLES.SYSTEM.SUPERADMIN) return true;
    return user.system_role === role;
  },

  // Mezipaměť pro RBAC konfiguraci během trvání jednoho serverového požadavku
  _rbacCache: null,

  /**
   * Ověří přístup k datům jiného uživatele na základě organizační hierarchie.
   * @param {Object} targetUser - Cílový uživatel.
   * @param {Object} [rbacConfig] - Volitelná konfigurace RBAC (pro optimalizaci výkonu v cyklech).
   */
  canAccessUserData: function(targetUser, rbacConfig) {
    const currentUser = this.getCurrentUser();
    if (!currentUser) return false;
    if (currentUser.user_id === targetUser.user_id) return true;
    
    // Načtení RBAC konfigurace (s využitím mezipaměti pro daný request)
    if (!this._rbacCache && !rbacConfig) {
      try {
        if (typeof Admin !== 'undefined' && Admin.getRbacConfig) {
          this._rbacCache = Admin.getRbacConfig();
        } else {
          this._rbacCache = {};
        }
      } catch (e) {
        this._rbacCache = {};
      }
    }

    let scope = 'NONE';
    const role = currentUser.system_role || 'USER';

    const config = rbacConfig || this._rbacCache || {};
    const perm = config['view_attendance_scope'];
    if (perm) {
      scope = perm[role] || 'NONE';
    } else {
      // Fallback pokud není v databázi RBAC záznam (použijeme výchozí pravidla aplikace)
      if (role === 'ADMIN') {
        scope = 'ALL';
      } else if (role === 'SUPERADMIN') {
        scope = 'OWN_SECTION';
      } else if (role === 'LEADER' || role === 'USER') {
        scope = 'OWN_SECTION';
      } else {
        // Stará logika pro org_role (zpětná kompatibilita)
        if (currentUser.org_role === ROLES.ORG.SECTION_LEADER || currentUser.org_role === ROLES.ORG.SECTION_DEPUTY) {
          return currentUser.section_id === targetUser.section_id;
        }
        if (currentUser.org_role === ROLES.ORG.DEPT_LEADER || currentUser.org_role === ROLES.ORG.DEPT_DEPUTY) {
          return currentUser.department_id === targetUser.department_id;
        }
        scope = 'NONE';
      }
    }

    // Vyhodnocení scope
    if (scope === 'ALL') return true;
    if (scope === 'OWN_SECTION') return currentUser.section_id === targetUser.section_id && currentUser.section_id !== "";
    if (scope === 'OWN_DEPARTMENT') return currentUser.department_id === targetUser.department_id && currentUser.department_id !== "";
    if (scope === 'NONE') return false;
    
    // true/false fallback pro starší boolean záznamy
    return (scope === true || scope === 'true');
  },

  /**
   * Odešle notifikace adminům a vedoucímu oddělení při nové registrační žádosti.
   */
  notifyAdminsAndLeader: function(newUser, allUsers) {
    try {
      const systemDb = DB.getSystem();
      const timestamp = "'" + new Date().toISOString();
      const fullName = newUser.first_name + " " + newUser.last_name;

      const departments = DB.getTable(DB.getCore(), DB_SHEETS.CORE.DEPARTMENTS);
      const dept = departments.find(d => d.department_id === newUser.department_id);
      const deptName = dept ? dept.name : newUser.department_id;

      const title = "Nová žádost o registraci";
      const message = fullName + " (" + newUser.email + ") žádá o přístup. Oddělení: " + deptName + ".";

      // Admini a Superadmini – aktivní i nově vytvořené záznamy (active !== "false")
      const admins = allUsers.filter(function(u) {
        return (u.system_role === ROLES.SYSTEM.ADMIN || u.system_role === ROLES.SYSTEM.SUPERADMIN) &&
               u.active !== "false";
      });

      const adminIds = new Set(admins.map(function(a) { return a.user_id; }));
      // Vedoucí stejného oddělení: buď přes org_role (DEPT_LEADER/DEPUTY)
      // nebo přes system_role "LEADER" (historická hodnota používaná v UI)
      const leaders = allUsers.filter(function(u) {
        return u.department_id === newUser.department_id &&
          u.active !== "false" &&
          !adminIds.has(u.user_id) &&
          (u.org_role === ROLES.ORG.DEPT_LEADER ||
           u.org_role === ROLES.ORG.DEPT_DEPUTY ||
           u.system_role === "LEADER");
      });

      admins.concat(leaders).forEach(function(recipient) {
        DB.insertRow(systemDb, DB_SHEETS.SYSTEM.NOTIFICATIONS, {
          notif_id: Utilities.getUuid(),
          user_id: recipient.user_id,
          title: title,
          message: message,
          type: "REGISTRATION_REQUEST",
          read: "false",
          timestamp: timestamp
        });
      });
    } catch (e) {
      console.warn("Notifikace selhaly: " + e.toString());
    }
  },

  /**
   * Ověří, zda má uživatel oprávnění schvalovat dovolené.
   * Schvalovat může: admin, vedoucí/zástupce úseku nebo oddělení.
   * Jako vedlejší efekt nastavuje user.org_role z tabulky POSITIONS.
   */
  canApproveVacation: function(user) {
    if (!user) return false;
    user.org_role = _resolveOrgRole(user, DB.getTable(DB.getCore(), DB_SHEETS.CORE.POSITIONS));
    return this.hasAdminAccess(user) ||
      user.org_role === ROLES.ORG.DEPT_LEADER ||
      user.org_role === ROLES.ORG.DEPT_DEPUTY ||
      user.org_role === ROLES.ORG.SECTION_LEADER ||
      user.org_role === ROLES.ORG.SECTION_DEPUTY;
  },

  /**
   * Kontrola administrátorských oprávnění.
   */
  hasAdminAccess: function(optUser) {
    // Pokud aplikace ještě není inicializována, povolíme přístup pro účely wizardu
    const isInit = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_INITIALIZED) === 'true';
    if (!isInit) return true;

    const user = optUser || this.getCurrentUser();
    if (!user) return false;

    // Superadmin má přístup vždy
    if (user.system_role === ROLES.SYSTEM.SUPERADMIN) return true;

    // Kontrola přes RBAC
    const perm = this.hasPermission('access_admin');
    return perm === true || perm === 'true' || perm === 'ALL' || perm === 'ANY';
  },

  /**
   * Ověří oprávnění na základě RBAC konfigurace. Straší implementace vrací boolean,
   * nová může vracet i scope string ('OWN_SECTION', 'ALL', 'NONE').
   */
  hasPermission: function(permKey) {
    const user = this.getCurrentUser();
    if (!user) return false;
    const role = user.system_role || 'USER';

    // Načtení RBAC konfigurace
    let rbacConfig = {};
    try {
      // Admin.gs by měl být dostupný v globálním scope
      if (typeof Admin !== 'undefined' && Admin.getRbacConfig) {
        rbacConfig = Admin.getRbacConfig();
      }
    } catch (e) {
      console.warn("Auth.hasPermission: Nepodařilo se načíst RBAC config.");
    }

    const config = rbacConfig[permKey] || {};
    let val = config[role];

    // Pokud je role SUPERADMIN a hodnota není v DB, dáváme full access 
    // (Superadmini obvykle nejsou v RBAC tabulce explicitně omezováni)
    if (role === ROLES.SYSTEM.SUPERADMIN) {
      // Pokud existuje default a je to scope, vracíme ALL
      return 'ALL';
    }

    if (val === undefined) {
      // Pokud nemáme v DB, vracíme false (bezpečnější)
      return false;
    }

    return val;
  }
};
