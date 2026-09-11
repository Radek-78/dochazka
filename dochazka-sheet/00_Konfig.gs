
// ════════════════════════════════════════════════════════════════════
//  00_Konfig.gs — Konstanty, geometrie mřížky a cache čtení na jeden běh.
// ════════════════════════════════════════════════════════════════════
/**
 * ============================================================================
 *  DOCHÁZKOVÝ SHEET — BOUND SKRIPT  ·  ETAPA 3
 * ============================================================================
 *  Patří DOVNITŘ vygenerovaného docházkového spreadsheetu (Rozšíření → Apps
 *  Script), NE do projektu živé aplikace.
 *
 *  ⚠ BĚŽNÝ PROVOZ NESAHÁ NIKAM VEN. Všechno se čte z vlastních listů tohoto
 *  sešitu. Do sešitů živé aplikace sahá JEN podmenu „🧳 Z aplikace" —
 *  jednorázové naplnění listů a import historie. Až se aplikace smaže,
 *  stačí to podmenu (a soubor 60_Import.gs) odstranit a nic se nerozbije.
 *
 *  NASTAVENÍ (konstanty níže):
 *    USEK_NAZEV     — přesný název úseku (titulek listů; v SECTIONS při migraci).
 *    ROK            — rok pro měsíční listy.
 *    ZDROJ_CORE_ID / ZDROJ_TRANSACTION_ID — jen pro podmenu „🧳 Z aplikace".
 *
 *  MENU 📋 Docházka:
 *    "Zadat můj měsíc"                    → modal s měsíčním pohledem přihlášeného
 *    "Postavit / obnovit všechny měsíce"  → přegeneruje 12 měsíčních listů
 *    "Postavit / obnovit jen tento měsíc" → přegeneruje jen list otevřeného měsíce
 *    "Pomocné listy"                      → vytvořit chybějící / obnovit Mapu
 *    "🧳 Z aplikace" (jednorázově)        → naplnit listy, import docházky a rezervací
 *
 *  LIST "Statusy"   = ZDROJ pravdy o statusech.
 *                     Zkratka | Název | Barva | Barva textu | Dovolená | Vyžaduje stůl | Aktivní.
 *  LIST "Stoly"     = ZDROJ pravdy o stolech i o rozložení mapy.
 *                     Stůl | Trvale (jméno) | Aktivní | Řádek | Sloupec | cell_id | trvale_uid.
 *  LIST "Mapa"      = jen náhled rozložení stolů + trvalí majitelé (odvozený ze Stolů).
 *  LIST "Rezervace" = Datum | Stůl | Jméno | user_id.
 *
 *  LIST "Uživatelé" = ZDROJ pravdy o lidech. Sloupce: Jméno | Oddělení | Tým |
 *  Pozice | E-mail | Vedoucí | Od | Do | user_id (skrytý). Po datu "Do" se
 *  člověk v dalších měsících negeneruje. Nové lidi dopisuj rovnou sem.
 *
 *  LIST "Pořadí" = řídí uspořádání. Také se generuje jednou a dál jen čte.
 *  Sloupce: NAHOŘE (jména připnutá nahoru) | POŘADÍ ODDĚLENÍ | POŘADÍ TÝMŮ
 *  ("Oddělení > Tým"). Vedoucí oddělení jde první, mezi odděleními je tenký
 *  prázdný řádek, nezařazení skončí na konci.
 * ============================================================================
 */

// Začátek vyhodnocování skriptu. Apps Script načte a vyhodnotí VŠECHNY soubory
// při každém volání znovu — tohle měří, kolik z toho padne, než se vůbec spustí
// volaná funkce (viz panel ⏱ v modalu).
var _DM_BOOT = Date.now();

var ZDROJ_CORE_ID = '13RKMeOxnXVsJ7omEVElPP2BCJe5_bqtFYklbmE5YZ6g';
var ZDROJ_TRANSACTION_ID = '1gJsTyi8r0yKaJ1ODOIT9x9XM6Dvdc8rKf1QucYLwBB0';   // pro "Načíst docházku z aplikace"
var USEK_NAZEV = 'DL Plánování a řízení zásob';
var ROK = new Date().getFullYear();

var DS_FONT = 'Lidl Font Cond Pro';
// Vzhled chipu statusu v mřížce: 0 = plná barva statusu + bílý text,
// 0.5–0.85 = jen jemný tón barvy na bílé + tmavý čitelný text (ohraničení pak víc vynikne).
var DS_CHIP_TON = 0.74;
// Kancelářský den bez rezervace stolu: zkratka statusu se vypíše touto barvou (jinak DS_BARVA_TEXT).
var DS_BARVA_TEXT = '#1e293b';
var DS_BARVA_BEZ_STOLU = '#dc2626';
var DS_MESICE = ['Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
  'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];
var DS_DNY = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];

var DS_DEN1_COL = 3;             // A = jméno, B = 1px mezera, C = den 1 dopoledne
var DS_HLAVICKA_RADKU = 3;      // zmražené řádky: 1 titulek, 2 čísla dnů, 3 dny v týdnu
var DS_PRVNI_DATA_RADEK = 5;    // ř. 4 = 1px mezera pod hlavičkou
var DS_MEZ_PX = 2;             // velikost „1px" mezer mezi buňkami (řádky i sloupce)
var DS_DEN_KROK = 3;          // sloupce na jeden den: dopoledne, odpoledne, mezera

// ── geometrie mřížky (jediné místo pro výpočet indexů) ──
function _gDop(d) { return DS_DEN1_COL + (d - 1) * DS_DEN_KROK; }          // sloupec „dopoledne" dne d
function _gSouhrn(N) { return DS_DEN1_COL + N * DS_DEN_KROK; }             // sloupec Dovolená
function _gUid(N) { return DS_DEN1_COL + N * DS_DEN_KROK + 1; }           // skrytý sloupec user_id
function _gRadek(j) { return DS_PRVNI_DATA_RADEK + j * 2; }               // fyzický řádek logického řádku j (mezera je +1)
function _gDenZeSloupce(dopCol) { return (dopCol - DS_DEN1_COL) / DS_DEN_KROK + 1; }
// ── názvy listů (jedno místo, ať se nikde nepřepisují jako řetězce) ──
var L_UZIV = 'Uživatelé';
var L_PORADI = 'Pořadí';
var L_STOLY = 'Stoly';
var L_REZERVACE = 'Rezervace';
var L_MAPA = 'Mapa';
var L_STATUSY = 'Statusy';
var L_CACHE_PREFIX = 'Z_';

var DS_UZIV_HLAVICKA = ['Jméno', 'Oddělení', 'Tým', 'Pozice', 'E-mail', 'Vedoucí', 'Od', 'Do', 'user_id'];
// „Trvale (jméno)" je pro člověka, „trvale_uid" je to, podle čeho se opravdu páruje
// (jména se mohou shodovat). Řádek/Sloupec jsou pozice stolu v mapě (0-based).
// Oba skryté sloupce (cell_id, trvale_uid) jsou na konci.
var DS_STOLY_HLAVICKA = ['Stůl', 'Trvale (jméno)', 'Aktivní', 'Řádek', 'Sloupec', 'cell_id', 'trvale_uid'];
var DS_STATUSY_HLAVICKA = ['Zkratka', 'Název', 'Barva', 'Barva textu', 'Dovolená', 'Vyžaduje stůl', 'Aktivní'];
var DS_ZDROJ_TABULKY = ['SECTIONS', 'DEPARTMENTS', 'GROUPS', 'POSITIONS', 'ATTENDANCE_STATUSES', 'OFFICE_MAPS', 'USERS'];

// ── cache čtení na jeden běh skriptu ────────────────────────────────────
// Apps Script vyhodnocuje soubor znovu při každém spuštění, takže tahle cache
// žije právě jeden běh. Pomocné listy se tím čtou 1× místo 7–12×.
// KAŽDÝ zápis do cachovaného listu musí zavolat _dsCacheZrus(klíč)!
var _DS_CACHE = {};
function _dsCache(klic, fn) {
  if (!(klic in _DS_CACHE)) _DS_CACHE[klic] = fn();
  return _DS_CACHE[klic];
}
function _dsCacheZrus(klic) {
  if (klic === undefined) { _DS_CACHE = {}; return; }
  delete _DS_CACHE[klic];
  delete _DS_CACHE['RAW'];   // syrová dávka pomocných listů je tím taky neplatná
}
