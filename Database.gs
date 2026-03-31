/**
 * Modul pro abstrakci přístupu k databázi (Google Sheets).
 */

const DB = {
  _instances: {},
  _tableCache: {},

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
      delete this._tableCache[sheetName];
    } else {
      this._tableCache = {};
    }
  },

  /**
   * Univerzální metoda pro čtení dat z listu jako pole objektů s cachováním.
   */
  getTable: function(ss, sheetName) {
    const cacheKey = ss.getId() + "_" + sheetName;
    if (this._tableCache[cacheKey]) return this._tableCache[cacheKey];

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
