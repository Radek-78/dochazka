
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
 *  NASTAVENÍ (3 konstanty níže):
 *    ZDROJ_CORE_ID  — ID CORE DB živé appky.
 *    USEK_NAZEV     — přesný název úseku (řádek v SECTIONS) pro prvotní naplnění.
 *    ROK           — rok pro měsíční listy.
 *
 *  MENU 📋 Docházka:
 *    "Zadat můj měsíc"                    → modal s měsíčním pohledem přihlášeného
 *    "Postavit / obnovit všechny měsíce"  → přegeneruje 12 měsíčních listů
 *    "Postavit / obnovit jen tento měsíc" → přegeneruje jen list otevřeného měsíce
 *    "Načíst docházku z aplikace"         → import jen ATTENDANCE (bez rezervací)
 *    "Načíst rezervace stolů z aplikace"  → import jen MAP_RESERVATIONS
 *    "Pomocné listy"                      → vytvořit chybějící / aktualizovat Stoly + Mapa;
 *                                           💾 Cachovat zdroje (vývoj) = snapshot CORE do
 *                                           skrytých listů Z_*, pak se čte z nich (rychlé)
 *
 *  LIST "Stoly"     = stoly z OFFICE_MAPS (Stůl | Trvale | Aktivní | cell_id).
 *  LIST "Mapa"      = jen náhled rozložení stolů + trvalí majitelé (odvozený).
 *  LIST "Rezervace" = Datum | Stůl | Jméno | user_id (import z MAP_RESERVATIONS).
 *
 *  LIST "Uživatelé" = ZDROJ pravdy o lidech. Při prvním běhu se naplní z živé
 *  DB, pak už se jen ČTE a jen se DOPLŇUJÍ noví lidé (existující řádky se
 *  nepřepisují). Sloupce: Jméno | Oddělení | Tým | E-mail | Vedoucí | Od | Do
 *  | user_id (skrytý). Po datu "Do" se člověk v dalších měsících negeneruje.
 *
 *  LIST "Pořadí" = řídí uspořádání. Také se generuje jednou a dál jen čte.
 *  Sloupce: NAHOŘE (jména připnutá nahoru) | POŘADÍ ODDĚLENÍ | POŘADÍ TÝMŮ
 *  ("Oddělení > Tým"). Vedoucí oddělení jde první, mezi odděleními je tenký
 *  prázdný řádek, nezařazení skončí na konci.
 * ============================================================================
 */

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
var L_CACHE_PREFIX = 'Z_';

var DS_UZIV_HLAVICKA = ['Jméno', 'Oddělení', 'Tým', 'Pozice', 'E-mail', 'Vedoucí', 'Od', 'Do', 'user_id'];
// „Trvale (jméno)" je pro člověka, „trvale_uid" je to, podle čeho se opravdu páruje
// (jména se mohou shodovat). Oba skryté sloupce jsou na konci.
var DS_STOLY_HLAVICKA = ['Stůl', 'Trvale (jméno)', 'Aktivní', 'cell_id', 'trvale_uid'];
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
  if (klic === undefined) _DS_CACHE = {};
  else delete _DS_CACHE[klic];
}
