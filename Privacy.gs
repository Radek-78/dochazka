/**
 * GDPR maskování docházkových statusů.
 * Konfigurace je uložená v RBAC_CONFIG pod klíčem privacy_unmasked_status_scope.
 */

var Privacy = {
  FALLBACK_MASK_STATUS_ID: "__MASKED_STATUS__",

  DEFAULT_SCOPE_BY_ORG_ROLE: {
    MEMBER: "OWN",
    GROUP_LEADER: "OWN_GROUP",
    DEPT_LEADER: "OWN_DEPARTMENT",
    SECTION_LEADER: "OWN_SECTION"
  },

  ORG_ROLES: ["MEMBER", "GROUP_LEADER", "DEPT_LEADER", "SECTION_LEADER"],

  isMaskingEnabled: function() {
    try {
      return PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_PRIVACY_MASKING_ENABLED) === "true";
    } catch (e) {
      console.warn("Privacy.isMaskingEnabled: " + e);
      return false;
    }
  },

  createContext: function(options) {
    options = options || {};
    var positions = options.positions || DB.getTable(DB.getCore(), DB_SHEETS.CORE.POSITIONS);
    var viewer = options.viewer || Auth.getCurrentUser();
    if (viewer) viewer.org_role = _resolveOrgRole(viewer, positions);

    var statuses = options.statuses || DB.getTable(DB.getCore(), DB_SHEETS.CORE.ATTENDANCE_STATUSES);
    var rbacConfig = options.rbacConfig || (Admin.getRbacConfig ? Admin.getRbacConfig() : {});
    var privacyConfig = rbacConfig.privacy_unmasked_status_scope || {};

    var statusById = {};
    var firstMaskStatusId = "";
    statuses.forEach(function(s) {
      statusById[s.status_id] = s;
      if (!firstMaskStatusId && String(s.status_kind || "NORMAL").toUpperCase() === "MASK" && s.active !== "false") {
        firstMaskStatusId = s.status_id;
      }
    });

    return {
      enabled: this.isMaskingEnabled(),
      viewer: viewer,
      positions: positions,
      statuses: statuses,
      statusById: statusById,
      rbacConfig: rbacConfig,
      privacyConfig: privacyConfig,
      firstMaskStatusId: firstMaskStatusId
    };
  },

  getScopeForViewer: function(ctx) {
    if (!ctx || !ctx.viewer) return "OWN";
    var orgRole = _resolveOrgRole(ctx.viewer, ctx.positions);
    if (this.ORG_ROLES.indexOf(orgRole) === -1) orgRole = "MEMBER";
    return ctx.privacyConfig[orgRole] || this.DEFAULT_SCOPE_BY_ORG_ROLE[orgRole] || "OWN";
  },

  canViewUnmasked: function(targetUser, ctx) {
    if (!ctx || !ctx.enabled) return true;
    if (!ctx.viewer || !targetUser) return false;
    if (String(ctx.viewer.user_id) === String(targetUser.user_id)) return true;

    var scope = this.getScopeForViewer(ctx);
    if (scope === "ALL") return true;
    if (scope === "OWN_GROUP") {
      return !!ctx.viewer.group_id && ctx.viewer.group_id === targetUser.group_id;
    }
    if (scope === "OWN_DEPARTMENT") {
      return !!ctx.viewer.department_id && ctx.viewer.department_id === targetUser.department_id;
    }
    if (scope === "OWN_SECTION") {
      return !!ctx.viewer.section_id && ctx.viewer.section_id === targetUser.section_id;
    }
    return false;
  },

  getMaskedStatusId: function(statusId, ctx) {
    var status = ctx && ctx.statusById ? ctx.statusById[statusId] : null;
    if (!status) return this.FALLBACK_MASK_STATUS_ID;
    if (String(status.status_kind || "NORMAL").toUpperCase() === "MASK") return status.status_id;
    var configuredMask = status.masked_status_id ? ctx.statusById[status.masked_status_id] : null;
    if (configuredMask &&
        configuredMask.active !== "false" &&
        String(configuredMask.status_kind || "NORMAL").toUpperCase() === "MASK") {
      return configuredMask.status_id;
    }
    return ctx.firstMaskStatusId || this.FALLBACK_MASK_STATUS_ID;
  },

  maskAttendanceEntry: function(entry, targetUser, ctx) {
    if (!entry || this.canViewUnmasked(targetUser, ctx)) return entry;
    var masked = {};
    Object.keys(entry).forEach(function(k) { masked[k] = entry[k]; });
    masked.status_id = this.getMaskedStatusId(entry.status_id, ctx);
    masked.note = "";
    return masked;
  },

  maskAttendanceEntries: function(entries, userMap, ctx) {
    if (!ctx || !ctx.enabled || !Array.isArray(entries)) return entries;
    var self = this;
    return entries.map(function(entry) {
      return self.maskAttendanceEntry(entry, userMap[entry.user_id], ctx);
    });
  },

  ensureFallbackMaskStatus: function(statuses) {
    var hasFallback = statuses.some(function(s) { return s.status_id === Privacy.FALLBACK_MASK_STATUS_ID; });
    if (hasFallback) return statuses;
    return statuses.concat([{
      status_id: Privacy.FALLBACK_MASK_STATUS_ID,
      name: "Skrytý status",
      abbreviation: "GDPR",
      color: "#64748b",
      text_color: "#ffffff",
      category: "Ostatní",
      active: "true",
      requires_approval: "false",
      allows_desk_reservation: "false",
      is_vacation: "false",
      shows_work_time: "false",
      status_kind: "MASK",
      masked_status_id: "",
      retention_category: "SHORT_TERM"
    }]);
  }
};
