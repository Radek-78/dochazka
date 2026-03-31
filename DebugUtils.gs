/**
 * POMOCNÉ FUNKCE PRO VÝVOJ A RESET
 */

/**
 * Totální reset aplikace do výchozího stavu.
 * Smaže příznak inicializace a tím umožní znovu spustit Wizard.
 * POZOR: Tato funkce nemaže samotné tabulky v Google Drive, ty je v případě potřeby nutné smazat ručně.
 */
function debugResetApp() {
  const props = PropertiesService.getScriptProperties();
  
  // Smazání hlavních příznaků
  props.deleteProperty(CONFIG.PROP_INITIALIZED);
  props.deleteProperty(CONFIG.PROP_SUPERADMIN_EMAIL);
  props.deleteProperty(CONFIG.PROP_DEFAULT_LOCS_SEEDED);
  
  // Volitelně můžete smazat i ID tabulek, pokud chcete, aby Setup vytvořil úplně nové
  // props.deleteProperty(CONFIG.PROP_SS_CORE_ID);
  // props.deleteProperty(CONFIG.PROP_SS_TRANSACTION_ID);
  // props.deleteProperty(CONFIG.PROP_SS_SYSTEM_ID);
  
  console.log("Aplikace byla resetována. Při příštím otevření se spustí Wizard.");
  return "Reset hotov. Obnovte stránku aplikace.";
}

/**
 * Pokud chcete smazat i data v tabulkách (ale ponechat soubory), můžete použít toto.
 * Promaže tabulky v CORE_DB.
 */
function debugClearDatabase() {
  const coreSS = DB.getCore();
  const sheets = coreSS.getSheets();
  
  sheets.forEach(sheet => {
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.deleteRows(2, lastRow - 1);
    }
  });
  
  console.log("Databáze (CORE) byla promazána.");
  return "Data v CORE_DB byla smazána.";
}
