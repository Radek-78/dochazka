/**
 * Modul pro abstrakci přístupu k databázi (Google Sheets).
 */

const DB = {
  _instances: {},
  _tableCache: {},

  // Listy, které se mění řádově jednou za týdny – drží se ve sdílené mezipaměti
  // mezi requesty, takže je nemusí číst každé volání každého uživatele znovu.
  // USERS ani transakční listy tu záměrně nejsou: USERS přepisuje heartbeat
  // každých 5 minut a ATTENDANCE by se do limitu CacheService stejně nevešla.
  // Názvy listů jsou napříč všemi třemi sešity unikátní, takže stačí jako klíč.
  _SHARED_CACHE_SHEETS: {
    LOCATIONS: true, SECTIONS: true, DEPARTMENTS: true, GROUPS: true, POSITIONS: true,
    ATTENDANCE_STATUSES: true, VACATION_CONFIG: true, SECTION_VIEW_CONFIG: true,
    NAMED_DAYS: true, RBAC_CONFIG: true, MARKETING_WEEKS: true
  },
  // Krátká platnost je pojistka: kdyby některá zapisující cesta zapomněla na
  // invalidaci, data se sama srovnají do dvou minut.
  _SHARED_CACHE_SECONDS: 120,
  // CacheService má limit 100 kB na klíč – co je větší, se prostě necachuje.
  _SHARED_CACHE_MAX_BYTES: 90000,

  _sharedCacheKey: function(sheetName) { return 'tbl_' + sheetName; },

  _sharedCacheGet: function(sheetName) {
    if (!this._SHARED_CACHE_SHEETS[sheetName]) return null;
    try {
      const raw = CacheService.getScriptCache().get(this._sharedCacheKey(sheetName));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null; // mezipaměť je jen zrychlení, její výpadek nesmí shodit čtení
    }
  },

  _sharedCachePut: function(sheetName, rows) {
    if (!this._SHARED_CACHE_SHEETS[sheetName]) return;
    try {
      const payload = JSON.stringify(rows);
      if (payload.length > this._SHARED_CACHE_MAX_BYTES) return;
      CacheService.getScriptCache().put(this._sharedCacheKey(sheetName), payload, this._SHARED_CACHE_SECONDS);
    } catch (e) { /* viz výše */ }
  },

  _sharedCacheRemove: function(sheetName) {
    try {
      const cache = CacheService.getScriptCache();
      if (sheetName) {
        cache.remove(this._sharedCacheKey(sheetName));
      } else {
        const self = this;
        cache.removeAll(Object.keys(this._SHARED_CACHE_SHEETS).map(function(n) {
          return self._sharedCacheKey(n);
        }));
      }
    } catch (e) { /* viz výše */ }
  },

  /**
   * Pomocná metoda pro získání/cachování spreadsheetu.
   */
  _getSS: function(propKey, errorMsg) {
    if (this._instances[propKey]) return this._instances[propKey];
    const id = PropertiesService.getScriptProperties().getProperty(propKey);
    if (!id) throw new Error(errorMsg);
    this._instances[propKey] = SpreadsheetApp.openById(id);
    return this._instances[propKey];
  },

  getCore: function() { 
    return this._getSS(CONFIG.PROP_SS_CORE_ID, "CORE_DB ID nebyl nalezen. Proběhla inicializace?"); 
  },
  
  getTransaction: function() { 
    return this._getSS(CONFIG.PROP_SS_TRANSACTION_ID, "TRANSACTION_DB ID nebyl nalezen. Proběhla inicializace?"); 
  },
  
  getSystem: function() { 
    return this._getSS(CONFIG.PROP_SS_SYSTEM_ID, "SYSTEM_DB ID nebyl nalezen. Proběhla inicializace?"); 
  },

  /**
   * Vymaže cache po zápisu (aby příští čtení vidělo nová data).
   */
  clearCache: function(sheetName) {
    if (sheetName) {
      // Klíče v _tableCache mají tvar "<spreadsheetId>_<sheetName>", proto se
      // nemaže podle holého názvu listu, ale podle přípony klíče.
      var suffix = "_" + sheetName;
      var cache = this._tableCache;
      Object.keys(cache).forEach(function(key) {
        if (key.length >= suffix.length && key.substring(key.length - suffix.length) === suffix) {
          delete cache[key];
        }
      });
      this._sharedCacheRemove(sheetName);
    } else {
      this._tableCache = {};
      this._sharedCacheRemove(null);
    }
  },

  /**
   * Univerzální metoda pro čtení dat z listu jako pole objektů s cachováním.
   */
  getTable: function(ss, sheetName) {
    const cacheKey = ss.getId() + "_" + sheetName;
    if (this._tableCache[cacheKey]) return this._tableCache[cacheKey];

    const shared = this._sharedCacheGet(sheetName);
    if (shared) {
      this._tableCache[cacheKey] = shared;
      return shared;
    }

    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return [];
    
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return []; 
    
    const headers = data[0];
    const rows = data.slice(1);
    const tz = ss.getSpreadsheetTimeZone();
    
    const result = rows.map(row => {
      const obj = {};
      headers.forEach((header, index) => {
        const val = row[index];
        if (val instanceof Date) {
          obj[header] = Utilities.formatDate(val, tz, "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
        } else {
          obj[header] = (val !== null && val !== undefined) ? String(val) : "";
        }
      });
      return obj;
    });

    this._tableCache[cacheKey] = result;
    this._sharedCachePut(sheetName, result);
    return result;
  },

  /**
   * Univerzální metoda pro vložení řádku do tabulky.
   */
  insertRow: function(ss, sheetName, dataObj) {
    // Před zápisem vymažeme cache pro tento list
    this.clearCache(sheetName);

    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }
    
    let lastCol = sheet.getLastColumn();
    if (lastCol === 0) {
      if (typeof Setup !== 'undefined' && Setup.setHeaders) {
        Setup.setHeaders(sheet, sheetName);
        lastCol = sheet.getLastColumn();
      }
    }
    
    if (lastCol === 0) throw new Error("List " + sheetName + " neexistuje nebo nemá definované sloupce.");
    
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const newRow = headers.map(header => dataObj[header] || "");
    
    sheet.appendRow(newRow);
  }
};
