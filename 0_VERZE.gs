/**
 * KONTROLNÍ SOUBOR NASAZENÍ
 * Tento soubor je záměrně první v abecedním seznamu souborů projektu (prefix "0_"),
 * aby šlo hned v Apps Script editoru i ve výpisu "clasp push" poznat, jestli se
 * poslední nasazení opravdu propsalo - prohlížeč webové appky totiž kvůli cache
 * někdy ještě chvíli ukazuje starou verzi.
 *
 * Při každém nasazení (viz CLAUDE.md, sekce "Deploy tohoto projektu") se toto
 * číslo aktualizuje na stejnou hodnotu jako APP_VERSION ve Version.gs.
 */
const DEPLOYED_VERSION = "2.15.4";
