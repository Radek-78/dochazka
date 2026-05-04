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

  normalizeStatusId: function(statusId) {
    return String(statusId || "").trim();
  },

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
      var sid = Privacy.normalizeStatusId(s.status_id);
      statusById[sid] = s;
      if (!firstMaskStatusId && String(s.status_kind || "NORMAL").toUpperCase() === "MASK" && s.active !== "false") {
        firstMaskStatusId = sid;
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
    var normalizedStatusId = this.normalizeStatusId(statusId);
    var status = ctx && ctx.statusById ? ctx.statusById[normalizedStatusId] : null;
    if (!status) return this.FALLBACK_MASK_STATUS_ID;
    if (String(status.status_kind || "NORMAL").toUpperCase() === "MASK") return status.status_id;
    var configuredMaskId = this.normalizeStatusId(status.masked_status_id);
    if (!configuredMaskId) return status.status_id;
    var configuredMask = ctx.statusById[configuredMaskId] || null;
    if (configuredMask &&
        configuredMask.active !== "false" &&
        String(configuredMask.status_kind || "NORMAL").toUpperCase() === "MASK") {
      return configuredMask.status_id;
    }
    return ctx.firstMaskStatusId || this.FALLBACK_MASK_STATUS_ID;
  },

  getCanonicalStatusId: function(statusId, ctx) {
    var normalizedStatusId = this.normalizeStatusId(statusId);
    var status = ctx && ctx.statusById ? ctx.statusById[normalizedStatusId] : null;
    return status ? status.status_id : statusId;
  },

  isMaskStatusId: function(statusId, ctx) {
    var normalizedStatusId = this.normalizeStatusId(statusId);
    var status = ctx && ctx.statusById ? ctx.statusById[normalizedStatusId] : null;
    return !!status && String(status.status_kind || "NORMAL").toUpperCase() === "MASK";
  },

  normalizeAttendanceEntry: function(entry, ctx) {
    if (!entry) return entry;
    var canonicalStatusId = this.getCanonicalStatusId(entry.status_id, ctx);
    if (String(canonicalStatusId) === String(entry.status_id)) return entry;
    var normalized = {};
    Object.keys(entry).forEach(function(k) { normalized[k] = entry[k]; });
    normalized.status_id = canonicalStatusId;
    return normalized;
  },

  maskAttendanceEntry: function(entry, targetUser, ctx) {
    if (!entry || this.canViewUnmasked(targetUser, ctx)) return entry;
    var maskedStatusId = this.getMaskedStatusId(entry.status_id, ctx);
    if (this.normalizeStatusId(maskedStatusId) === this.normalizeStatusId(entry.status_id) &&
        String(maskedStatusId) === String(entry.status_id)) return entry;
    var masked = {};
    Object.keys(entry).forEach(function(k) { masked[k] = entry[k]; });
    masked.status_id = maskedStatusId;
    if (this.normalizeStatusId(maskedStatusId) !== this.normalizeStatusId(entry.status_id)) {
      masked.note = "";
    }
    return masked;
  },

  prepareAttendanceEntry: function(entry, targetUser, ctx) {
    var normalized = this.normalizeAttendanceEntry(entry, ctx);
    if (!ctx || !ctx.enabled) return normalized;
    return this.maskAttendanceEntry(normalized, targetUser, ctx);
  },

  prepareAttendanceEntries: function(entries, userMap, ctx) {
    if (!Array.isArray(entries)) return entries;
    var self = this;
    return entries.map(function(entry) {
      return self.prepareAttendanceEntry(entry, userMap[entry.user_id], ctx);
    });
  },

  maskAttendanceEntries: function(entries, userMap, ctx) {
    return this.prepareAttendanceEntries(entries, userMap, ctx);
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
