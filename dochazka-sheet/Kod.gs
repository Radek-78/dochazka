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
var DS_UZIV_HLAVICKA = ['Jméno', 'Oddělení', 'Tým', 'Pozice', 'E-mail', 'Vedoucí', 'Od', 'Do', 'user_id'];
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


function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('📋 Docházka')
    .addItem('📝 Zadat můj měsíc', 'otevriModal')
    .addSeparator()
    .addItem('🔄 Postavit / obnovit všechny měsíce', 'setup')
    .addItem('📅 Postavit / obnovit jen tento měsíc', 'setupMesic')
    .addSeparator()
    .addItem('📥 Načíst docházku z aplikace', 'nactiDochazku')
    .addItem('🪑 Načíst rezervace stolů z aplikace', 'nactiRezervace')
    .addSeparator()
    .addSubMenu(ui.createMenu('🧩 Pomocné listy')
      .addItem('Vytvořit chybějící (Uživatelé, Pořadí, Stoly, Rezervace)', 'vytvorPomocneListy')
      .addItem('Aktualizovat list Stoly z aplikace', 'aktualizujStoly')
      .addSeparator()
      .addItem('💾 Cachovat zdroje z aplikace (vývoj)', 'cachujZdroje')
      .addItem('🗑 Smazat cache zdrojů (zpět na živá data)', 'smazCacheZdroju'))
    .addToUi();
  _dsOznacDnes();
}

/** Obarví v hlavičce dnů aktuálního měsíce dnešní sloupec (a odbarví včerejší). */
function _dsOznacDnes() {
  try {
    var dt = new Date();
    if (dt.getFullYear() !== ROK) return;
    var mesic = dt.getMonth() + 1;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(_dsNazevMesice(mesic));
    if (!sheet) return;
    var den1 = DS_DEN1_COL;
    var N = _dmDniVMesici(mesic);
    var novyDop = _gDop(dt.getDate());

    var props = PropertiesService.getDocumentProperties();
    var stare = props.getProperty('DNES_SLOUPEC');
    if (stare) {
      var p = stare.split(':');
      var sM = Number(p[0]), sDop = Number(p[1]);
      if (!(sM === mesic && sDop === novyDop)) {
        var sSheet = ss.getSheetByName(_dsNazevMesice(sM));
        if (sSheet && sDop >= den1 && sDop <= _gDop(_dmDniVMesici(sM)) + 1) {
          _dsBarvaHlavicky(sSheet, sM, sDop, false);
        }
      }
    }
    if (novyDop >= den1 && novyDop <= _gDop(N) + 1) {
      _dsBarvaHlavicky(sheet, mesic, novyDop, true);
      props.setProperty('DNES_SLOUPEC', mesic + ':' + novyDop);
    }
  } catch (e) { /* onOpen nesmí spadnout */ }
}

function _dsBarvaHlavicky(sheet, mesic, dopCol, dnes) {
  var d = _gDenZeSloupce(dopCol);
  var dow = new Date(ROK, mesic - 1, d).getDay();
  var mmdd = ('0' + mesic).slice(-2) + '-' + ('0' + d).slice(-2);
  var svatek = !!_dsSvatkyCR(ROK)[mmdd];
  var bg = dnes ? '#facc15'
    : (svatek ? '#fca5a5' : ((dow === 0 || dow === 6) ? '#e9edf2' : '#f1f5f9'));
  sheet.getRange(2, dopCol, 2, 2).setBackground(bg);
}

function otevriModal() {
  var html = HtmlService.createHtmlOutputFromFile('Modal').setWidth(760).setHeight(660);
  SpreadsheetApp.getUi().showModalDialog(html, 'Moje docházka');
}


// ════════════════════════════════════════════════════════════════════════════
//  SETUP
// ════════════════════════════════════════════════════════════════════════════

function setup() {
  var z = _dsNactiZdroj();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  for (var m = 1; m <= 12; m++) _dsListMesic(ss, m, z.radky, z.statusyUnik, z.vacAbbr, z.deskAbbr);

  var vychozi = ss.getSheetByName('Sheet1') || ss.getSheetByName('List1');
  if (vychozi && ss.getSheets().length > 1) ss.deleteSheet(vychozi);

  var akt = ss.getSheetByName(_dsNazevMesice(new Date().getMonth() + 1));
  if (akt) ss.setActiveSheet(akt);

  PropertiesService.getDocumentProperties().deleteProperty('DNES_SLOUPEC');
  _dsOznacDnes();
  SpreadsheetApp.getUi().alert('Hotovo — 12 měsíčních listů přegenerováno z listu Uživatelé.');
}

function setupMesic() {
  var z = _dsNactiZdroj();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var m = _dmMesicZListu(ss.getActiveSheet()) || (new Date().getMonth() + 1);
  _dsListMesic(ss, m, z.radky, z.statusyUnik, z.vacAbbr, z.deskAbbr);
  ss.setActiveSheet(ss.getSheetByName(_dsNazevMesice(m)));
  PropertiesService.getDocumentProperties().deleteProperty('DNES_SLOUPEC');
  _dsOznacDnes();
  SpreadsheetApp.getUi().alert('Postaven list ' + _dsNazevMesice(m) + '.');
}

/** Vývoj: stáhne konfigurační tabulky z CORE do skrytých listů „Z_*". Pak setup / modal čtou z nich (rychlé). */
function cachujZdroje() {
  var ui = SpreadsheetApp.getUi();
  var core = SpreadsheetApp.openById(ZDROJ_CORE_ID);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hlaska = [];
  DS_ZDROJ_TABULKY.forEach(function (t) {
    var src = core.getSheetByName(t);
    if (!src) { hlaska.push('– ' + t + ' (v CORE není)'); return; }
    var data = src.getDataRange().getValues();
    var cil = ss.getSheetByName('Z_' + t) || ss.insertSheet('Z_' + t);
    cil.clear();
    if (data.length && data[0].length) cil.getRange(1, 1, data.length, data[0].length).setValues(data);
    cil.hideSheet();
    hlaska.push('✓ ' + t + '  (' + Math.max(0, data.length - 1) + ' řádků)');
  });
  _dsCacheZrus();
  ui.alert('Zdroje nacachovány do skrytých listů Z_*:\n\n' + hlaska.join('\n') +
    '\n\nSetup i modal teď čtou z cache. Pro čerstvá data spusť znovu, nebo „Smazat cache".');
}

/** Smaže skryté listy Z_* → čtení jde zase živě z CORE. */
function smazCacheZdroju() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var n = 0;
  DS_ZDROJ_TABULKY.forEach(function (t) {
    var sh = ss.getSheetByName('Z_' + t);
    if (sh) { ss.deleteSheet(sh); n++; }
  });
  _dsCacheZrus();
  SpreadsheetApp.getUi().alert('Smazáno ' + n + ' cache listů. Zdroje se teď čtou živě z CORE.');
}

/** Jen zajistí pomocné listy (Uživatelé, Pořadí, Stoly, Rezervace) — bez měsíců. */
function vytvorPomocneListy() {
  _dsNactiZdroj();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var stav = ['Uživatelé', 'Pořadí', 'Stoly', 'Rezervace'].map(function (n) {
    var sh = ss.getSheetByName(n);
    var radku = sh ? Math.max(0, sh.getLastRow() - 1) : 0;
    return (sh ? '✓ ' : '– ') + n + (sh ? '  (' + radku + ' řádků)' : '  chybí');
  }).join('\n');
  SpreadsheetApp.getUi().alert('Pomocné listy:\n\n' + stav +
    '\n\nMěsíční listy zůstaly beze změny.');
}

/** Přegeneruje list Stoly z OFFICE_MAPS živé aplikace (zachová ruční Aktivní/Trvale podle cell_id). */
function aktualizujStoly() {
  if (ZDROJ_CORE_ID.indexOf('VLOZ') !== -1) throw new Error('Nastav ZDROJ_CORE_ID nahoře ve skriptu.');
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Přegenerovat list Stoly z aplikace?\n\nStoly se natáhnou znovu z OFFICE_MAPS. Ruční úpravy sloupců Aktivní a Trvale se zachovají podle cell_id, nové stoly se doplní.',
    ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

  var usek = _dsZdroj('SECTIONS').filter(function (s) {
    return s.name === USEK_NAZEV && String(s.active) !== 'false';
  })[0];
  if (!usek) throw new Error('Úsek "' + USEK_NAZEV + '" nenalezen v SECTIONS.');
  var usersById = {};
  _dsZdroj('USERS').forEach(function (u) { usersById[u.user_id] = _dsJmeno(u); });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pocet = _dsSeedStoly(ss, usek, usersById, true);
  _dsListMapa(ss, usek, usersById);
  ui.alert('List Stoly přegenerován — ' + (pocet || 0) + ' stolů. List Mapa aktualizován.' +
    (ss.getSheetByName('Z_OFFICE_MAPS') ? '\n\n(Čteno z cache Z_*. Pro živá data „Smazat cache zdrojů".)' : ''));
}


/**
 * Zajistí listy Uživatelé a Pořadí (vytvoří / doplní nováčky) a připraví
 * uspořádané řádky. Zdrojem pravdy o lidech je list Uživatelé.
 */
function _dsNactiZdroj() {
  if (USEK_NAZEV.indexOf('VLOZ') !== -1) throw new Error('Nastav USEK_NAZEV nahoře ve skriptu.');

  var usek = _dsZdroj('SECTIONS').filter(function (s) {
    return s.name === USEK_NAZEV && String(s.active) !== 'false';
  })[0];
  if (!usek) throw new Error('Úsek "' + USEK_NAZEV + '" nenalezen v SECTIONS.');

  var oddMap = {};
  _dsZdroj('DEPARTMENTS').forEach(function (d) { oddMap[d.department_id] = d.name || ''; });
  var tymMap = {};
  _dsZdroj('GROUPS').forEach(function (g) { tymMap[g.group_id] = g.name || ''; });
  var pozMap = {};
  _dsZdroj('POSITIONS').forEach(function (p) { pozMap[p.position_id] = p.name || ''; });

  var dnes = new Date();
  dnes.setHours(0, 0, 0, 0);
  var liveLide = _dsZdroj('USERS')
    .filter(function (u) {
      if (u.section_id !== usek.section_id) return false;
      if (String(u.active) !== 'true') return false;
      if (u.date_end) {
        var k = new Date(u.date_end);
        if (!isNaN(k.getTime()) && k < dnes) return false;
      }
      return true;
    })
    .map(function (u) {
      u._oddNazev = oddMap[u.department_id] || '';
      u._tymNazev = tymMap[u.group_id] || '';
      u._pozice = pozMap[u.position_id] || '';
      return u;
    });

  var videno = {};
  var statusyUnik = [];
  var vacAbbr = [];
  var deskAbbr = [];
  _dsZdroj('ATTENDANCE_STATUSES')
    .filter(function (s) { return String(s.active) !== 'false' && s.abbreviation; })
    .forEach(function (s) {
      var z = String(s.abbreviation).trim();
      if (!z || videno[z]) return;
      videno[z] = true;
      statusyUnik.push(s);
      if (String(s.is_vacation) === 'true') vacAbbr.push(z);
      if (String(s.allows_desk_reservation) === 'true') deskAbbr.push(z);
    });

  var usersById = {};
  _dsZdroj('USERS').forEach(function (u) { usersById[u.user_id] = _dsJmeno(u); });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  _dsListUzivatele(ss, liveLide);          // vytvoří nebo doplní nováčky
  var lide = _dsCtiUzivatele(ss);          // ZDROJ pravdy
  if (lide.length === 0) throw new Error('List Uživatelé je prázdný.');
  _dsListPoradi(ss, lide);                 // vytvoří jen pokud chybí
  var poradi = _dsCtiPoradi(ss);
  _dsSeedStoly(ss, usek, usersById);       // vytvoří list Stoly jen pokud chybí
  _dsListRezervace(ss);                    // vytvoří list Rezervace jen pokud chybí
  _dsListMapa(ss, usek, usersById);        // náhledová mapa stolů (vždy přegeneruje)

  return {
    radky: _dsSerazeni(lide, poradi), statusyUnik: statusyUnik,
    vacAbbr: vacAbbr, deskAbbr: deskAbbr
  };
}


// ── list Uživatelé ───────────────────────────────────────────────────────

/** Vytvoří list Uživatelé (z live DB) nebo jen doplní nové lidi (dle user_id). */
function _dsListUzivatele(ss, liveLide) {
  var sh = ss.getSheetByName('Uživatelé');

  function radekZLive(u) {
    return [
      _dsJmeno(u), u._oddNazev || '', u._tymNazev || '', u._pozice || '', u.email || '',
      _dsJeVedouci(u) ? 'ano' : '', _dsFmtDatum(u.date_start), _dsFmtDatum(u.date_end), u.user_id || ''
    ];
  }
  function cs(a, b) { return _dsJmeno(a).localeCompare(_dsJmeno(b), 'cs'); }

  if (!sh) {
    sh = ss.insertSheet('Uživatelé', 0);
    sh.getRange(1, 1, 1, DS_UZIV_HLAVICKA.length).setValues([DS_UZIV_HLAVICKA])
      .setFontWeight('bold').setBackground('#f1f5f9');
    var rows = liveLide.slice().sort(cs).map(radekZLive);
    if (rows.length) sh.getRange(2, 1, rows.length, DS_UZIV_HLAVICKA.length).setValues(rows);
  } else {
    _dsUpgradeUzivHlavicku(sh, liveLide);
    var data = sh.getDataRange().getValues();
    var H = {};
    data[0].forEach(function (h, i) { H[String(h).trim()] = i; });
    var jsou = {};
    for (var i = 1; i < data.length; i++) {
      var uid = String(data[i][H['user_id']] || '').trim();
      if (uid) jsou[uid] = 1;
    }
    var noveRadky = liveLide
      .filter(function (u) { return !jsou[String(u.user_id)]; })
      .sort(cs).map(radekZLive);
    if (noveRadky.length) {
      sh.getRange(data.length + 1, 1, noveRadky.length, DS_UZIV_HLAVICKA.length).setValues(noveRadky);
    }
  }

  _dsCacheZrus('UZIVATELE');
  var uidIdx = DS_UZIV_HLAVICKA.indexOf('user_id') + 1;
  sh.setColumnWidth(1, 180);
  sh.setColumnWidth(2, 150);
  sh.setColumnWidth(3, 140);
  sh.setColumnWidth(4, 170);
  sh.setColumnWidth(5, 210);
  sh.setColumnWidth(6, 70);
  sh.setColumnWidth(7, 95);
  sh.setColumnWidth(8, 95);
  sh.hideColumns(uidIdx);
  sh.setFrozenRows(1);
  _dsFont(sh);
}

/** Doplní do staršího listu Uživatelé chybějící sloupec Pozice (zachová data). */
function _dsUpgradeUzivHlavicku(sh, liveLide) {
  var hlav = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (x) { return String(x).trim(); });
  if (hlav.indexOf('Pozice') !== -1) return;
  var tymIdx = hlav.indexOf('Tým');
  if (tymIdx === -1) return;   // neznámý formát, nech být
  sh.insertColumnAfter(tymIdx + 1);
  sh.getRange(1, tymIdx + 2).setValue('Pozice').setFontWeight('bold').setBackground('#f1f5f9');
  var pozByUid = {};
  liveLide.forEach(function (u) { pozByUid[String(u.user_id)] = u._pozice || ''; });
  var data = sh.getDataRange().getValues();
  var uidIdx = data[0].map(function (x) { return String(x).trim(); }).indexOf('user_id');
  var vals = [];
  for (var i = 1; i < data.length; i++) {
    vals.push([pozByUid[String(data[i][uidIdx] || '').trim()] || '']);
  }
  if (vals.length) sh.getRange(2, tymIdx + 2, vals.length, 1).setValues(vals);
}

/** Přečte list Uživatelé jako zdroj pravdy (cache na jeden běh, podle názvů sloupců). */
function _dsCtiUzivatele(ss) {
  return _dsCache('UZIVATELE', function () {
    var sh = ss.getSheetByName('Uživatelé');
    if (!sh) return [];
    var data = sh.getDataRange().getValues();
    if (data.length < 2) return [];
    var H = {};
    data[0].forEach(function (h, i) { H[String(h).trim()] = i; });
    function v(r, name) { return H[name] === undefined ? '' : r[H[name]]; }
    var out = [];
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      var jmeno = String(v(r, 'Jméno') || '').trim();
      var uid = String(v(r, 'user_id') || '').trim();
      if (!jmeno && !uid) continue;
      out.push({
        user_id: uid,
        jmeno: jmeno,
        oddNazev: String(v(r, 'Oddělení') || '').trim(),
        tymNazev: String(v(r, 'Tým') || '').trim(),
        pozice: String(v(r, 'Pozice') || '').trim(),
        email: String(v(r, 'E-mail') || '').trim(),
        vedouci: /^ano$/i.test(String(v(r, 'Vedoucí') || '').trim()),
        od: _dsParseDatum(v(r, 'Od')),
        do: _dsParseDatum(v(r, 'Do'))
      });
    }
    return out;
  });
}


// ── list Pořadí ──────────────────────────────────────────────────────────

function _dsListPoradi(ss, lide) {
  if (ss.getSheetByName('Pořadí')) return;

  function cs(a, b) { return String(a).localeCompare(String(b), 'cs'); }

  var nahore = lide.filter(function (u) { return !u.oddNazev && !u.tymNazev; })
    .map(function (u) { return u.jmeno; }).sort(cs);

  var oddNazvy = [];
  lide.forEach(function (u) { if (u.oddNazev && oddNazvy.indexOf(u.oddNazev) === -1) oddNazvy.push(u.oddNazev); });
  oddNazvy.sort(cs);

  var tymPoradi = [];
  oddNazvy.forEach(function (odd) {
    var tymy = [];
    lide.forEach(function (u) {
      if (u.oddNazev === odd && u.tymNazev && tymy.indexOf(u.tymNazev) === -1) tymy.push(u.tymNazev);
    });
    tymy.sort(cs).forEach(function (t) { tymPoradi.push(odd + ' > ' + t); });
  });

  var sh = ss.insertSheet('Pořadí', 1);
  sh.getRange(1, 1, 1, 3)
    .setValues([['NAHOŘE (jména)', 'POŘADÍ ODDĚLENÍ', 'POŘADÍ TÝMŮ (Oddělení > Tým)']])
    .setFontWeight('bold').setBackground('#f1f5f9');

  var n = Math.max(nahore.length, oddNazvy.length, tymPoradi.length, 1);
  var out = [];
  for (var i = 0; i < n; i++) out.push([nahore[i] || '', oddNazvy[i] || '', tymPoradi[i] || '']);
  sh.getRange(2, 1, out.length, 3).setValues(out);

  sh.setColumnWidth(1, 200);
  sh.setColumnWidth(2, 200);
  sh.setColumnWidth(3, 300);
  sh.setFrozenRows(1);
  _dsFont(sh);
}

function _dsCtiPoradi(ss) {
  var sh = ss.getSheetByName('Pořadí');
  if (!sh) return { nahore: [], oddPoradi: [], tymPoradi: [] };
  var data = sh.getDataRange().getValues();
  var nahore = [], oddPoradi = [], tymPoradi = [];
  for (var i = 1; i < data.length; i++) {
    var a = String(data[i][0] || '').trim();
    var b = String(data[i][1] || '').trim();
    var c = String(data[i][2] || '').trim();
    if (a) nahore.push(a);
    if (b) oddPoradi.push(b);
    if (c && c.indexOf('>') !== -1) {
      var p = c.split('>');
      tymPoradi.push({ odd: p[0].trim(), tym: p.slice(1).join('>').trim() });
    }
  }
  return { nahore: nahore, oddPoradi: oddPoradi, tymPoradi: tymPoradi };
}


// ── listy Stoly a Rezervace ─────────────────────────────────────────────

/** Aktivní kancelářská mapa úseku z OFFICE_MAPS → { name, rows, cols, desks:[{id,label,row,col,permUid}] } nebo null. */
function _dsNactiMapu(usek) {
  var m = _dsZdroj('OFFICE_MAPS').filter(function (x) {
    return x.section_id === usek.section_id && String(x.active) !== 'false';
  })[0];
  if (!m) return null;
  var cells = [];
  try { cells = JSON.parse(m.cells_json || '[]'); } catch (e) { cells = []; }
  var desks = cells.filter(function (c) { return String(c.type) === 'desk'; }).map(function (c) {
    return {
      id: c.id || '', label: c.label || c.id || '',
      row: Math.max(0, Number(c.row) || 0), col: Math.max(0, Number(c.col) || 0),
      permUid: c.permanent_user_id || ''
    };
  });
  function maxPlus1(f) { return desks.reduce(function (a, d) { return Math.max(a, f(d)); }, -1) + 1; }
  return {
    name: m.name || 'Kancelář',
    rows: Number(m.rows) || maxPlus1(function (d) { return d.row; }) || 1,
    cols: Number(m.cols) || maxPlus1(function (d) { return d.col; }) || 1,
    desks: desks
  };
}

/**
 * List Stoly z živé OFFICE_MAPS. Bez `force` jen pokud list chybí.
 * S `force` přegeneruje a zachová ruční Aktivní/Trvale podle cell_id. Vrací počet stolů.
 */
function _dsSeedStoly(ss, usek, usersById, force) {
  var existuje = ss.getSheetByName('Stoly');
  if (existuje && !force) return;

  var mapa = _dsNactiMapu(usek);

  var stare = {};
  if (existuje) _dsCtiStoly(ss).forEach(function (s) { if (s.cell_id) stare[s.cell_id] = s; });

  var radky = [];
  (mapa ? mapa.desks : []).forEach(function (c) {
    var id = c.id || '';
    var owner = c.permUid ? (usersById[c.permUid] || '') : '';
    var st = stare[id];
    radky.push([
      c.label || id || '',
      st ? st.trvale : owner,
      st ? (st.aktivni ? 'ano' : '') : 'ano',
      id
    ]);
  });

  var sh = existuje || ss.insertSheet('Stoly', 2);
  if (!existuje) {
    sh.getRange(1, 1, 1, 4).setValues([['Stůl', 'Trvale (jméno)', 'Aktivní', 'cell_id']])
      .setFontWeight('bold').setBackground('#f1f5f9');
    sh.setColumnWidth(1, 120);
    sh.setColumnWidth(2, 180);
    sh.setColumnWidth(3, 70);
    sh.hideColumns(4);
    sh.setFrozenRows(1);
  }
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 4).clearContent();
  if (radky.length) sh.getRange(2, 1, radky.length, 4).setValues(radky);
  _dsFont(sh);
  _dsCacheZrus('STOLY');
  return radky.length;
}

/**
 * List Mapa — vizuální rozložení stolů (jen rozvržení + trvalí majitelé, bez rezervací).
 * Přegeneruje se pokaždé, je to čistě odvozený list.
 */
function _dsListMapa(ss, usek, usersById) {
  var sh = ss.getSheetByName('Mapa') || ss.insertSheet('Mapa', 3);
  sh.clear();

  var mapa = _dsNactiMapu(usek);
  if (!mapa || !mapa.desks.length) {
    sh.getRange(1, 1).setValue('Pro úsek "' + USEK_NAZEV + '" není v OFFICE_MAPS žádná aktivní mapa se stoly.');
    _dsFont(sh);
    return;
  }

  var trvaleByCell = {};
  _dsCtiStoly(ss).forEach(function (s) { if (s.cell_id) trvaleByCell[s.cell_id] = s.trvale; });

  var R = mapa.rows, C = mapa.cols, r0 = 3;
  var grid = [], bg = [];
  for (var rr = 0; rr < R; rr++) {
    grid.push([]); bg.push([]);
    for (var cc = 0; cc < C; cc++) { grid[rr].push(''); bg[rr].push('#ffffff'); }
  }
  mapa.desks.forEach(function (d) {
    if (d.row >= R || d.col >= C) return;
    var owner = (trvaleByCell[d.id] !== undefined && trvaleByCell[d.id] !== '')
      ? trvaleByCell[d.id]
      : (d.permUid ? (usersById[d.permUid] || '') : '');
    grid[d.row][d.col] = d.label + (owner ? '\n' + owner : '');
    bg[d.row][d.col] = owner ? '#ffedd5' : '#dbeafe';
  });

  sh.getRange(1, 1, 1, C).merge().setValue('Mapa stolů — ' + mapa.name)
    .setFontWeight('bold').setFontSize(12).setHorizontalAlignment('center')
    .setBackground('#004fac').setFontColor('#ffffff');

  var rng = sh.getRange(r0, 1, R, C);
  rng.setValues(grid).setBackgrounds(bg)
    .setHorizontalAlignment('center').setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP)
    .setFontSize(9)
    .setBorder(true, true, true, true, true, true, '#94a3b8', SpreadsheetApp.BorderStyle.SOLID);
  for (var c2 = 1; c2 <= C; c2++) sh.setColumnWidth(c2, 104);
  for (var r2 = r0; r2 < r0 + R; r2++) sh.setRowHeight(r2, 44);
  _dsFont(sh);
  sh.getRange(r0, 1, R, C).protect().setWarningOnly(true)
    .setDescription('Mapa je jen náhled — generuje se z OFFICE_MAPS.');
}

/**
 * Vytvoří list Rezervace — jen pokud chybí. Vrátí ho.
 * Sloupec Datum se formátuje jako text jen při vzniku listu; oba zapisovací
 * cesty (dm_stul, _dmImportRezervace) si formát nastavují na svých buňkách,
 * takže tady se nesmí přeformátovávat celý sloupec (běželo by to při každé rezervaci).
 */
function _dsListRezervace(ss) {
  var sh = ss.getSheetByName('Rezervace');
  if (sh) return sh;
  sh = ss.insertSheet('Rezervace');
  sh.getRange(1, 1, 1, 4).setValues([['Datum', 'Stůl', 'Jméno', 'user_id']])
    .setFontWeight('bold').setBackground('#f1f5f9');
  sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@');
  sh.setColumnWidth(1, 110);
  sh.setColumnWidth(2, 110);
  sh.setColumnWidth(3, 180);
  sh.hideColumns(4);
  sh.setFrozenRows(1);
  _dsFont(sh);
  return sh;
}

/** Přečte stoly (cache na jeden běh — po zápisu do listu volej _dsCacheZrus('STOLY')). */
function _dsCtiStoly(ss) {
  return _dsCache('STOLY', function () {
    var sh = ss.getSheetByName('Stoly');
    if (!sh) return [];
    var data = sh.getDataRange().getValues();
    if (data.length < 2) return [];
    var H = {};
    data[0].forEach(function (h, i) { H[String(h).trim()] = i; });
    function v(r, n) { return H[n] === undefined ? '' : r[H[n]]; }
    var out = [];
    for (var i = 1; i < data.length; i++) {
      var lbl = String(v(data[i], 'Stůl') || '').trim();
      if (!lbl) continue;
      out.push({
        stul: lbl,
        trvale: String(v(data[i], 'Trvale (jméno)') || '').trim(),
        aktivni: /^ano$/i.test(String(v(data[i], 'Aktivní') || '').trim()),
        cell_id: String(v(data[i], 'cell_id') || '').trim()
      });
    }
    return out;
  });
}

/**
 * Celý list Rezervace přečtený JEDNOU za běh skriptu.
 * { rows:[{radek,datum,rok,mesic,den,stul,jmeno,uid}], volne:[čísla prázdných řádků], dalsi:první řádek za daty }
 */
function _dmCtiRezervace(ss) {
  return _dsCache('REZERVACE', function () {
    var prazdny = { rows: [], volne: [], dalsi: 2 };
    var sh = ss.getSheetByName('Rezervace');
    if (!sh) return prazdny;
    var data = sh.getDataRange().getValues();
    if (data.length < 2) return prazdny;
    var H = {};
    data[0].forEach(function (h, i) { H[String(h).trim()] = i; });
    if (H['Datum'] === undefined || H['user_id'] === undefined) return prazdny;

    var rows = [], volne = [];
    for (var i = 1; i < data.length; i++) {
      var d = _dsFmtDatum(data[i][H['Datum']]);
      var uid = String(data[i][H['user_id']] || '').trim();
      if (!d && !uid) { volne.push(i + 1); continue; }
      rows.push({
        radek: i + 1,
        datum: d,
        rok: Number(d.substring(0, 4)) || 0,
        mesic: Number(d.substring(5, 7)) || 0,
        den: Number(d.substring(8, 10)) || 0,
        stul: String(data[i][H['Stůl']] || '').trim(),
        jmeno: String(data[i][H['Jméno']] || '').trim(),
        uid: uid
      });
    }
    return { rows: rows, volne: volne, dalsi: data.length + 1 };
  });
}

/** Rezervace v daném měsíci: [{den, stul, jmeno, uid, …}]. */
function _dmRezMesic(ss, mesic) {
  return _dmCtiRezervace(ss).rows.filter(function (r) {
    return r.rok === ROK && r.mesic === mesic;
  });
}


// ── uspořádání řádků ─────────────────────────────────────────────────────

function _dsSerazeni(lide, poradi) {
  poradi = poradi || { nahore: [], oddPoradi: [], tymPoradi: [] };
  function cs(a, b) { return String(a.jmeno).localeCompare(String(b.jmeno), 'cs'); }

  var radky = [];
  var pouzito = {};

  poradi.nahore.forEach(function (jm) {
    var u = lide.filter(function (x) { return !pouzito[x.user_id] && x.jmeno === jm; })[0];
    if (u) { radky.push({ typ: 'emp', u: u }); pouzito[u.user_id] = 1; }
  });

  var oddNazvy = [];
  lide.forEach(function (u) {
    if (u.oddNazev && !pouzito[u.user_id] && oddNazvy.indexOf(u.oddNazev) === -1) oddNazvy.push(u.oddNazev);
  });
  var oddSer = _dsPodlePoradi(oddNazvy, poradi.oddPoradi, function (x) { return x; }, function (x) { return x; });

  oddSer.forEach(function (odd) {
    var vDept = lide.filter(function (u) { return u.oddNazev === odd && !pouzito[u.user_id]; });
    if (vDept.length === 0) return;

    if (radky.length) radky.push({ typ: 'gap' });
    radky.push({ typ: 'dept', label: odd });

    vDept.filter(function (u) { return u.vedouci; }).sort(cs).forEach(function (u) {
      radky.push({ typ: 'emp', u: u }); pouzito[u.user_id] = 1;
    });

    var tymNazvy = [];
    vDept.forEach(function (u) { if (u.tymNazev && tymNazvy.indexOf(u.tymNazev) === -1) tymNazvy.push(u.tymNazev); });
    var tymKlice = poradi.tymPoradi.filter(function (t) { return t.odd === odd; }).map(function (t) { return t.tym; });
    var tymSer = _dsPodlePoradi(tymNazvy, tymKlice, function (x) { return x; }, function (x) { return x; });

    tymSer.forEach(function (tym) {
      var vTeam = lide.filter(function (u) {
        return u.oddNazev === odd && u.tymNazev === tym && !pouzito[u.user_id];
      }).sort(cs);
      if (vTeam.length === 0) return;
      radky.push({ typ: 'team', label: tym });
      vTeam.forEach(function (u) { radky.push({ typ: 'emp', u: u }); pouzito[u.user_id] = 1; });
    });

    var bezT = lide.filter(function (u) { return u.oddNazev === odd && !pouzito[u.user_id]; }).sort(cs);
    if (bezT.length) {
      if (tymNazvy.length) radky.push({ typ: 'team', label: 'Bez týmu' });
      bezT.forEach(function (u) { radky.push({ typ: 'emp', u: u }); pouzito[u.user_id] = 1; });
    }
  });

  var zbytek = lide.filter(function (u) { return !pouzito[u.user_id]; }).sort(cs);
  if (zbytek.length) {
    if (radky.length) radky.push({ typ: 'gap' });
    radky.push({ typ: 'dept', label: 'Bez oddělení' });
    zbytek.forEach(function (u) { radky.push({ typ: 'emp', u: u }); });
  }

  while (radky.length && radky[radky.length - 1].typ === 'gap') radky.pop();
  return radky;
}

function _dsPodlePoradi(polozky, poradiKlicu, klicFn, jmenoFn) {
  var idx = {};
  (poradiKlicu || []).forEach(function (k, i) { if (idx[k] === undefined) idx[k] = i; });
  return polozky.slice().sort(function (a, b) {
    var ia = idx[klicFn(a)], ib = idx[klicFn(b)];
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return jmenoFn(a).localeCompare(jmenoFn(b), 'cs');
  });
}

/** Ořízne řádky na daný měsíc dle Od/Do a odstraní osamocené nadpisy/gapy. */
function _dsRadkyProMesic(radky, mesic) {
  var mStart = new Date(ROK, mesic - 1, 1);
  var mEnd = new Date(ROK, mesic, 0, 23, 59, 59);
  function aktivni(u) {
    if (u.od && u.od > mEnd) return false;
    if (u.do && u.do < mStart) return false;
    return true;
  }

  var tmp = radky.filter(function (it) { return it.typ !== 'emp' || aktivni(it.u); });

  function nadpisMaObsah(i) {
    var it = tmp[i];
    for (var j = i + 1; j < tmp.length; j++) {
      if (tmp[j].typ === 'emp') return true;
      if (tmp[j].typ === 'dept') return false;
      if (tmp[j].typ === 'team' && it.typ === 'team') return false;
    }
    return false;
  }

  var out = [];
  for (var i = 0; i < tmp.length; i++) {
    var it = tmp[i];
    if (it.typ === 'dept' || it.typ === 'team') {
      if (nadpisMaObsah(i)) out.push(it);
    } else if (it.typ === 'gap') {
      if (out.length && out[out.length - 1].typ !== 'gap') out.push(it);
    } else {
      out.push(it);
    }
  }
  while (out.length && out[out.length - 1].typ === 'gap') out.pop();
  while (out.length && out[0].typ === 'gap') out.shift();
  return out;
}


// ── měsíční list ─────────────────────────────────────────────────────────

// Bumpuj při JAKÉKOLI změně struktury listu (kvůli fast-path porovnání podpisu).
var DS_BUILD_VER = 5;

/** Podpis struktury listu (hash) — když se nezmění, přestavba se přeskočí. */
function _dsPodpisListu(mesic, radky, N) {
  var kl = radky.map(function (it) {
    if (it.typ !== 'emp') return it.typ + ':' + (it.label || '');
    var u = it.u;
    var konec = (u.do && u.do.getFullYear() === ROK && (u.do.getMonth() + 1) === mesic) ? 1 : 0;
    return 'emp:' + u.user_id + '|' + u.jmeno + '|' + (u.pozice || '') + '|' + (u.vedouci ? 1 : 0) + '|' + konec;
  });
  var raw = 'v' + DS_BUILD_VER + '|r' + ROK + '|d' + N + '|t' + DS_CHIP_TON + '|' + kl.join('¶');
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw));
}

function _dsRichLabel(label, style) {
  var s = String(label || '');
  var b = SpreadsheetApp.newRichTextValue().setText(s);
  if (s.length) b.setTextStyle(0, s.length, style);
  return b.build();
}

function _dsListMesic(ss, mesic, radkyFull, statusyUnik, vacAbbr, deskAbbr) {
  deskAbbr = deskAbbr || [];
  var radky = _dsRadkyProMesic(radkyFull, mesic);
  var N = _dmDniVMesici(mesic);
  var nLog = Math.max(radky.length, 1);

  var nazev = _dsNazevMesice(mesic);
  var stary = ss.getSheetByName(nazev);
  var podpis = _dsPodpisListu(mesic, radky, N);
  var props = PropertiesService.getDocumentProperties();

  // ── FAST-PATH: struktura beze změny → data v listu už jsou ──
  if (stary && props.getProperty('PODPIS_' + mesic) === podpis) {
    var rezF = _dmRezMesic(ss, mesic);
    var hF = _dmRezHash(rezF);
    if (props.getProperty('REZ_' + mesic) !== hF) {   // změnily se rezervace → přeznač
      _dmObnovStulyList(stary, mesic, deskAbbr, rezF);
      props.setProperty('REZ_' + mesic, hF);
    }
    return;
  }
  var zachovano = stary ? _dsPrectiDochazku(stary, mesic) : {};
  if (stary) ss.deleteSheet(stary);
  var sheet = ss.insertSheet(nazev);

  var den1 = DS_DEN1_COL;
  var souhrnCol = _gSouhrn(N);
  var uidCol = _gUid(N);
  var prvni = DS_PRVNI_DATA_RADEK;
  var mezR = prvni - 1;                 // ř. 4: 1px mezera pod hlavičkou
  var dataR = nLog * 2;                 // každý logický řádek + mezera pod ním
  var poslR = prvni + dataR - 1;
  var dnyW = N * DS_DEN_KROK;           // šířka datové oblasti dnů (vč. mezerových sloupců)

  var maxC = sheet.getMaxColumns();
  if (maxC < uidCol) sheet.insertColumnsAfter(maxC, uidCol - maxC);
  else if (maxC > uidCol) sheet.deleteColumns(uidCol + 1, maxC - uidCol);
  var maxRr = sheet.getMaxRows();
  if (maxRr < poslR) sheet.insertRowsAfter(maxRr, poslR - maxRr);
  else if (maxRr > poslR) sheet.deleteRows(poslR + 1, maxRr - poslR);

  // ── ř. 1: titulek + e-mail ──
  sheet.getRange(1, 1, 1, souhrnCol).setBackground('#004fac').setFontColor('#ffffff').setFontWeight('bold');
  var titEnd = Math.max(den1, souhrnCol - 6);
  sheet.getRange(1, den1, 1, titEnd - den1 + 1).merge()
    .setValue(USEK_NAZEV + ' — ' + DS_MESICE[mesic - 1].toUpperCase() + ' ' + ROK)
    .setFontSize(13).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.getRange(1, titEnd + 1, 1, souhrnCol - titEnd).merge()
    .setValue(String(Session.getActiveUser().getEmail() || ''))
    .setFontSize(9).setFontColor('#cfe3ff').setFontWeight('normal')
    .setHorizontalAlignment('right').setVerticalAlignment('middle');

  // ── ř. 2-3: čísla dnů / dny v týdnu; klasifikace svátek/víkend ──
  var svatky = _dsSvatkyCR(ROK);
  var r2 = [], r3 = [];
  for (var i0 = 0; i0 < souhrnCol; i0++) { r2.push(''); r3.push(''); }
  r2[0] = 'Jméno';
  var klas = {};          // dopCol -> 'svatek' | 'vikend'
  var svatekNazev = {};
  for (var d = 1; d <= N; d++) {
    var dop = _gDop(d);
    var dow = new Date(ROK, mesic - 1, d).getDay();
    r2[dop - 1] = d;
    r3[dop - 1] = DS_DNY[dow];
    var mmdd = ('0' + mesic).slice(-2) + '-' + ('0' + d).slice(-2);
    if (svatky[mmdd]) { klas[dop] = 'svatek'; svatekNazev[dop] = svatky[mmdd]; }
    else if (dow === 0 || dow === 6) klas[dop] = 'vikend';
  }
  r2[souhrnCol - 1] = 'Dovolená';
  r3[souhrnCol - 1] = '(dny)';
  sheet.getRange(2, 1, 1, souhrnCol).setValues([r2])
    .setBackground('#f1f5f9').setFontWeight('bold').setFontSize(10)
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.getRange(3, 1, 1, souhrnCol).setValues([r3])
    .setBackground('#f1f5f9').setFontColor('#64748b').setFontSize(9)
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.getRange(2, 1).setHorizontalAlignment('left');
  for (var d2 = 1; d2 <= N; d2++) sheet.getRange(2, _gDop(d2), 2, 2).mergeAcross();

  var BG_HLAV = { svatek: '#fca5a5', vikend: '#e9edf2' };
  var BG_MRIZ = { svatek: '#fee2e2', vikend: '#e9edf2' };
  Object.keys(klas).forEach(function (dc) {
    sheet.getRange(2, Number(dc), 2, 2).setBackground(BG_HLAV[klas[dc]]);
    if (svatekNazev[dc]) sheet.getRange(3, Number(dc)).setNote(svatekNazev[dc]);
  });

  // ── datová oblast: pozadí + hodnoty + jména dávkově ──
  var tz = Session.getScriptTimeZone();
  var ST_JMENO = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(10).setForegroundColor('#1e293b').build();
  var ST_POZICE = SpreadsheetApp.newTextStyle().setBold(false).setFontSize(8).setForegroundColor('#64748b').build();
  var ST_KONEC = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(8).setForegroundColor('#dc2626').build();
  var ST_DEPT = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(10).setForegroundColor('#1e3a8a').build();
  var ST_TEAM = SpreadsheetApp.newTextStyle().setBold(true).setItalic(true).setFontSize(10).setForegroundColor('#4338ca').build();
  function jePosledni(u) { return u.do && u.do.getFullYear() === ROK && (u.do.getMonth() + 1) === mesic; }

  var vac = {};
  (vacAbbr || []).forEach(function (a) { vac[String(a).trim()] = 1; });

  var bgAll = [];        // dataR × souhrnCol
  var rtA = [];          // dataR × 1  (sloupec A)
  var valsG = [];        // dataR × dnyW  (den 1..N, dop/odp/mezera)
  var souhrnV = [];      // dataR × 1
  for (var rp = 0; rp < dataR; rp++) {
    var brow = [];
    for (var cc = 0; cc < souhrnCol; cc++) brow.push('#ffffff');
    bgAll.push(brow);
    rtA.push([SpreadsheetApp.newRichTextValue().setText('').build()]);
    var vrow = [];
    for (var cg = 0; cg < dnyW; cg++) vrow.push('');
    valsG.push(vrow);
    souhrnV.push(['']);
  }

  var bloky = [];
  var blokStart = (radky.length && radky[0].typ === 'emp') ? 0 : -1;
  var deptRadky = [], teamRadky = [], gapRadky = [], pulDny = [];

  for (var j = 0; j < radky.length; j++) {
    var it = radky[j];
    var fr = _gRadek(j);           // fyzický řádek
    var pi = fr - prvni;           // index do bgAll/rtA/valsG
    if (it.typ === 'dept') {
      if (blokStart !== -1) bloky.push([_gRadek(blokStart), _gRadek(j - 1)]);
      blokStart = j;
      for (var cD = 0; cD < souhrnCol; cD++) bgAll[pi][cD] = '#dbeafe';
      deptRadky.push(fr);
      rtA[pi] = [_dsRichLabel(it.label, ST_DEPT)];
    } else if (it.typ === 'team') {
      for (var cT = 0; cT < souhrnCol; cT++) bgAll[pi][cT] = '#eef2ff';
      teamRadky.push(fr);
      rtA[pi] = [_dsRichLabel(it.label, ST_TEAM)];
    } else if (it.typ === 'gap') {
      if (blokStart !== -1) bloky.push([_gRadek(blokStart), _gRadek(j - 1)]);
      blokStart = -1;
      gapRadky.push(fr);
    } else {
      // jméno + 2. řádek (pozice / konec)
      var text = it.u.jmeno;
      var styly = [[0, text.length, ST_JMENO]];
      var seg = [];
      if (it.u.pozice) seg.push({ t: it.u.pozice, st: ST_POZICE });
      if (jePosledni(it.u)) seg.push({ t: 'do ' + Utilities.formatDate(it.u.do, tz, 'd.M.yyyy'), st: ST_KONEC });
      if (seg.length) {
        text += '\n';
        seg.forEach(function (sg, k) {
          if (k > 0) { var s0 = text.length; text += '  ·  '; styly.push([s0, text.length, ST_POZICE]); }
          var b0 = text.length; text += sg.t; styly.push([b0, text.length, sg.st]);
        });
      }
      var rtb = SpreadsheetApp.newRichTextValue().setText(text);
      styly.forEach(function (s) { rtb.setTextStyle(s[0], s[1], s[2]); });
      rtA[pi] = [rtb.build()];
      if (it.u.vedouci) bgAll[pi][0] = '#ffedd5';

      // víkendy/svátky do buněk dne (bgAll je indexovaný od sloupce 1)
      for (var dv = 1; dv <= N; dv++) {
        if (!klas[_gDop(dv)]) continue;
        var off = _gDop(dv) - 1;
        bgAll[pi][off] = BG_MRIZ[klas[_gDop(dv)]];
        bgAll[pi][off + 1] = BG_MRIZ[klas[_gDop(dv)]];
      }
      // zachovaná docházka + souhrn dovolené
      var dny = zachovano[String(it.u.user_id || '').trim()];
      var sumDov = 0;
      if (dny) Object.keys(dny).forEach(function (dStr) {
        var e = dny[dStr];
        var o = _gDop(Number(dStr)) - den1;
        valsG[pi][o] = e.dop || '';
        if (e.full) { if (vac[e.dop]) sumDov += 1; }
        else {
          valsG[pi][o + 1] = e.odp || '';
          pulDny.push({ row: fr, col: _gDop(Number(dStr)), dop: e.dop || '', odp: e.odp || '' });
          if (vac[e.dop]) sumDov += 0.5;
          if (vac[e.odp]) sumDov += 0.5;
        }
      });
      souhrnV[pi] = [sumDov];
    }
  }
  if (blokStart !== -1) bloky.push([_gRadek(blokStart), _gRadek(radky.length - 1)]);

  // skrytý user_id
  var colU = [];
  for (var ju = 0; ju < dataR; ju++) colU.push(['']);
  radky.forEach(function (it, j) { if (it.typ === 'emp') colU[_gRadek(j) - prvni] = [it.u.user_id || '']; });

  // zápisy pozadí / jména / uid
  sheet.getRange(prvni, 1, dataR, souhrnCol).setBackgrounds(bgAll);
  sheet.getRange(prvni, 1, dataR, 1).setRichTextValues(rtA)
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP).setVerticalAlignment('middle');
  sheet.getRange(prvni, uidCol, dataR, 1).setValues(colU);
  sheet.hideColumns(uidCol);

  // hodnoty (mřížka zatím nesloučená) + souhrn
  sheet.getRange(prvni, den1, dataR, dnyW).setValues(valsG)
    .setNumberFormat('@').setHorizontalAlignment('center').setVerticalAlignment('middle')
    .setFontWeight('bold').setFontSize(10).setFontColor(DS_CHIP_TON > 0 ? DS_BARVA_TEXT : '#ffffff');
  sheet.getRange(prvni, souhrnCol, dataR, 1).setValues(souhrnV);

  // sloučení dvojic dne (všechny data řádky), pak rozbití půldnů a dopsání jejich hodnot
  for (var dm = 1; dm <= N; dm++) sheet.getRange(prvni, _gDop(dm), dataR, 2).mergeAcross();
  pulDny.forEach(function (p) {
    sheet.getRange(p.row, p.col, 1, 2).breakApart();
    sheet.getRange(p.row, p.col).setValue(p.dop);
    sheet.getRange(p.row, p.col + 1).setValue(p.odp);
  });

  // sloučení dnů u řádků oddělení / týmů
  deptRadky.concat(teamRadky).forEach(function (fr) {
    sheet.getRange(fr, den1, 1, dnyW - 1).breakApart().merge();
  });

  // ── podmíněné formátování: jen pozadí tónem barvy statusu ──
  var mrizka = sheet.getRange(prvni, den1, dataR, dnyW);
  var pravidla = [];
  statusyUnik.forEach(function (s) {
    var zk = String(s.abbreviation).trim();
    if (!zk) return;
    var barva = _dsHex(s.color, '#94a3b8');
    var pr = SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(zk).setBold(true).setRanges([mrizka]);
    pr.setBackground(DS_CHIP_TON > 0 ? _dsSvetleji(barva, DS_CHIP_TON) : barva);
    pravidla.push(pr.build());
  });
  sheet.setConditionalFormatRules(pravidla);

  // ── indikace stolů: při stavbě jen červené písmo (rychlé); rámečky doplní import ──
  var rezM = _dmRezMesic(ss, mesic);
  _dmObnovStulyList(sheet, mesic, deskAbbr, rezM, 'jen_pismo');

  // ── ohraničení: vnější rámeček (hrany v mezerových řádcích) + rámy bloků; vnitřní dělení dělají 1px mezery ──
  sheet.getRange(mezR, 1, dataR + 1, souhrnCol)
    .setBorder(true, true, true, true, false, false, '#cbd5e1', SpreadsheetApp.BorderStyle.SOLID);
  bloky.forEach(function (b) { _dsRamOddeleni(sheet, b[0], b[1], souhrnCol); });

  // ── rozměry ──
  sheet.setFrozenRows(DS_HLAVICKA_RADKU);
  sheet.setFrozenColumns(1);
  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidth(den1 - 1, DS_MEZ_PX);          // mezera mezi jménem a dny
  sheet.setColumnWidths(den1, dnyW, 22);
  for (var sm = 1; sm <= N; sm++) sheet.setColumnWidth(_gDop(sm) + 2, DS_MEZ_PX);   // mezerové sloupce mezi dny
  sheet.setColumnWidth(souhrnCol, 90);
  sheet.getRange(prvni, souhrnCol, dataR, 1).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.setRowHeight(1, 26);
  sheet.setRowHeight(mezR, DS_MEZ_PX);
  sheet.setRowHeights(prvni, dataR, 30);
  radky.forEach(function (it, j) { sheet.setRowHeight(_gRadek(j) + 1, DS_MEZ_PX); });   // mezerové řádky
  gapRadky.forEach(function (fr) { sheet.setRowHeight(fr, 8); });

  sheet.getRange(prvni, 1, dataR, souhrnCol).protect()
    .setDescription('Docházková mřížka — edituj přes menu 📋 Docházka')
    .setWarningOnly(true);

  _dsFont(sheet);
  props.setProperty('PODPIS_' + mesic, podpis);
  props.setProperty('REZ_' + mesic, _dmRezHash(rezM));
}

/** Hash stavu rezervací měsíce pro fast-path. */
function _dmRezHash(rez) {
  var raw = (rez || []).map(function (r) { return r.uid + '_' + r.den + '_' + r.stul; }).sort().join(';');
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw || '-'));
}

/**
 * Označí kancelářské dny bez rezervace. Vrací počet.
 * rezim: 'plne' (default) = červená zkratka + červený rámeček + úklid starých rámečků;
 *        'jen_pismo' = jen červená zkratka (rychlé, pro čerstvě postavený list).
 */
function _dmObnovStulyList(sheet, mesic, deskAbbr, rezMesicArr, rezim) {
  var jenPismo = rezim === 'jen_pismo';
  var da = deskAbbr || [];
  if (!da.length) return 0;
  var deskSet = {};
  da.forEach(function (a) { deskSet[String(a).trim()] = 1; });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var N = _dmDniVMesici(mesic);
  var den1 = DS_DEN1_COL;
  var dnyW = N * DS_DEN_KROK;
  var uidCol = _gUid(N);
  var last = sheet.getLastRow();
  if (last < DS_PRVNI_DATA_RADEK) return 0;
  var nRows = last - DS_PRVNI_DATA_RADEK + 1;
  var uids = sheet.getRange(DS_PRVNI_DATA_RADEK, uidCol, nRows, 1).getValues();
  var rng = sheet.getRange(DS_PRVNI_DATA_RADEK, den1, nRows, dnyW);
  var grid = rng.getValues();
  var merged = {};
  rng.getMergedRanges().forEach(function (mr) { merged[mr.getRow() + '_' + mr.getColumn()] = 1; });

  var rezSet = {};
  (rezMesicArr || _dmRezMesic(ss, mesic)).forEach(function (r) {
    if (r.stul) rezSet[String(r.uid) + '_' + r.den] = 1;
  });

  // uživatelé s natrvalo přiřazeným stolem → nikdy neindikovat
  var trvalyUid = {};
  var uidByJmeno = {};
  _dsCtiUzivatele(ss).forEach(function (u) { uidByJmeno[u.jmeno] = String(u.user_id); });
  _dsCtiStoly(ss).forEach(function (s) {
    if (s.trvale && uidByJmeno[s.trvale]) trvalyUid[uidByJmeno[s.trvale]] = 1;
  });

  var vychozi = DS_CHIP_TON > 0 ? DS_BARVA_TEXT : '#ffffff';
  var fc = [];
  for (var r0 = 0; r0 < nRows; r0++) {
    var rr = [];
    for (var c0 = 0; c0 < dnyW; c0++) rr.push(vychozi);
    fc.push(rr);
  }
  var CERV = SpreadsheetApp.BorderStyle.SOLID_MEDIUM;
  var zvyrazneno = 0;
  for (var i = 0; i < nRows; i++) {
    var uid = String(uids[i][0] || '').trim();
    if (!uid) continue;
    var absRow = DS_PRVNI_DATA_RADEK + i;
    var maStul = !!trvalyUid[uid];
    for (var d = 1; d <= N; d++) {
      var idx = (d - 1) * DS_DEN_KROK;
      var full = !!merged[absRow + '_' + _gDop(d)];
      var vDop = String(grid[i][idx] || '').trim();
      var vOdp = full ? '' : String(grid[i][idx + 1] || '').trim();
      var jeKancl = deskSet[vDop] || (!full && deskSet[vOdp]);
      if (!jeKancl) continue;
      var chybi = !maStul && !rezSet[uid + '_' + d];
      if (chybi) {
        if (deskSet[vDop]) fc[i][idx] = DS_BARVA_BEZ_STOLU;
        if (!full && deskSet[vOdp]) fc[i][idx + 1] = DS_BARVA_BEZ_STOLU;
        if (!jenPismo) sheet.getRange(absRow, _gDop(d), 1, 2)
          .setBorder(true, true, true, true, false, false, DS_BARVA_BEZ_STOLU, CERV);
        zvyrazneno++;
      } else if (!jenPismo) {
        sheet.getRange(absRow, _gDop(d), 1, 2).setBorder(false, false, false, false, false, false, null, null);
      }
    }
  }
  sheet.getRange(DS_PRVNI_DATA_RADEK, den1, nRows, dnyW).setFontColors(fc);
  return zvyrazneno;
}

/** Zkratky statusů, které vyžadují rezervaci stolu (allows_desk_reservation). */
function _dsDeskAbbr() {
  var out = [];
  _dsZdroj('ATTENDANCE_STATUSES').forEach(function (s) {
    var a = String(s.abbreviation || '').trim();
    if (a && String(s.allows_desk_reservation) === 'true' && out.indexOf(a) === -1) out.push(a);
  });
  return out;
}

/** Má uživatel (podle jména) natrvalo přiřazený stůl v listu Stoly? */
function _dmMaTrvalyStul(ss, jmeno) {
  if (!jmeno) return false;
  return _dsCtiStoly(ss).some(function (s) { return s.trvale && s.trvale === jmeno; });
}

/** Smaže rezervaci uživatele pro daný den (list Rezervace). Vrací true, když něco smazal. */
function _dmZrusRezervaci(ss, userId, mesic, den) {
  var sh = ss.getSheetByName('Rezervace');
  if (!sh) return false;
  var smazano = false;
  _dmRezMesic(ss, mesic).forEach(function (r) {
    if (r.den !== den || r.uid !== String(userId)) return;
    sh.getRange(r.radek, 1, 1, 4).clearContent();
    smazano = true;
  });
  if (smazano) _dsCacheZrus('REZERVACE');
  return smazano;
}

/** Potřebuje status(y) daného dne stůl? */
function _dmPotrebaStul(rezim, dop, odp, deskAbbr) {
  if (rezim === 'CLEAR') return false;
  var da = deskAbbr || [];
  return da.indexOf(String(dop || '').trim()) !== -1 || da.indexOf(String(odp || '').trim()) !== -1;
}

/** Jeden den: kancelář bez stolu → červená zkratka + červený rámeček, jinak výchozí barva bez rámečku. */
function _dmObnovStul(sheet, row, den, deskAbbr, maRezervaci) {
  var dopCol = _gDop(den);
  var pair = sheet.getRange(row, dopCol, 1, 2);
  var vals = pair.getValues()[0];
  var full = pair.isPartOfMerge();
  var da = deskAbbr || [];
  var vychozi = DS_CHIP_TON > 0 ? DS_BARVA_TEXT : '#ffffff';
  var dopDesk = da.indexOf(String(vals[0] || '').trim()) !== -1;
  var odpDesk = !full && da.indexOf(String(vals[1] || '').trim()) !== -1;
  var chybi = (dopDesk || odpDesk) && !maRezervaci;
  sheet.getRange(row, dopCol).setFontColor(dopDesk && chybi ? DS_BARVA_BEZ_STOLU : vychozi);
  sheet.getRange(row, dopCol + 1).setFontColor(odpDesk && chybi ? DS_BARVA_BEZ_STOLU : vychozi);
  if (chybi) pair.setBorder(true, true, true, true, false, false, DS_BARVA_BEZ_STOLU, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  else pair.setBorder(false, false, false, false, false, false, null, null);
}

/**
 * Rám oddělení. Horní i dolní hranu kreslí do 1px mezerových řádků těsně NAD a POD blokem,
 * takže se nikde nepotká s rámečkem buňky (např. červený rámeček „Kancelář bez stolu").
 */
function _dsRamOddeleni(sheet, r1, r2, lastCol) {
  if (r2 < r1) return;
  var top = Math.max(DS_PRVNI_DATA_RADEK - 1, r1 - 1);   // mezerový řádek nad blokem
  var bot = r2 + 1;                                        // mezerový řádek pod blokem
  sheet.getRange(top, 1, bot - top + 1, lastCol)
    .setBorder(true, true, true, true, false, false, '#64748b', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
}

/** Přečte docházku z (starého) měsíčního listu: { user_id: { den: {full,dop,odp} } }. */
// Čte podle hlavičky (ř. 2 = čísla dnů), takže funguje pro STARÉ i NOVÉ rozvržení listu.
function _dsPrectiDochazku(sheet, mesic) {
  var last = sheet.getLastRow(), lastC = sheet.getLastColumn();
  if (last < 4 || lastC < 3) return {};
  var head2 = sheet.getRange(2, 1, 1, lastC).getValues()[0];
  var dayCol = {};      // den -> 1-based sloupec „dopoledne"
  var uidCol = -1;
  for (var c = 0; c < lastC; c++) {
    var raw = head2[c];
    var s = String(raw).trim();
    var n = parseInt(s, 10);
    if (n >= 1 && n <= 31 && s === String(n)) dayCol[n] = c + 1;
    if (s === 'Dovolená') uidCol = c + 2;    // Dovolená, pak skrytý user_id
  }
  if (uidCol < 1 || !Object.keys(dayCol).length) return {};

  var body = sheet.getRange(4, 1, last - 3, lastC);
  var vals = body.getValues();
  var mset = {};
  body.getMergedRanges().forEach(function (mr) { mset[mr.getRow() + '_' + mr.getColumn()] = 1; });

  var out = {};
  for (var i = 0; i < vals.length; i++) {
    var uid = String(vals[i][uidCol - 1] || '').trim();
    if (!uid) continue;
    var absRow = 4 + i;
    var dny = {};
    Object.keys(dayCol).forEach(function (dStr) {
      var dc = dayCol[dStr];
      var full = !!mset[absRow + '_' + dc];
      var vDop = String(vals[i][dc - 1] || '').trim();
      var vOdp = full ? '' : String(vals[i][dc] || '').trim();
      if (vDop || vOdp) dny[Number(dStr)] = { full: full, dop: vDop, odp: vOdp };
    });
    if (Object.keys(dny).length) out[uid] = dny;
  }
  return out;
}


// ════════════════════════════════════════════════════════════════════════════
//  IMPORT DOCHÁZKY ZE ŽIVÉ APLIKACE
// ════════════════════════════════════════════════════════════════════════════

function nactiDochazku() {
  if (ZDROJ_TRANSACTION_ID.indexOf('VLOZ') !== -1) {
    throw new Error('Nastav ZDROJ_TRANSACTION_ID nahoře ve skriptu (Vlastnosti skriptu živé appky → SPREADSHEET_TRANSACTION_ID).');
  }
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Načíst docházku z živé aplikace do všech měsíčních listů roku ' + ROK +
    '?\nHodnoty v listech se přepíšou hodnotami z aplikace.', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

  var trans = SpreadsheetApp.openById(ZDROJ_TRANSACTION_ID);

  var abbr = {};
  var vacAbbr = [];
  _dsZdroj('ATTENDANCE_STATUSES').forEach(function (s) {
    var a = String(s.abbreviation || '').trim();
    if (!a) return;
    abbr[String(s.status_id).trim()] = a;
    if (String(s.is_vacation) === 'true' && vacAbbr.indexOf(a) === -1) vacAbbr.push(a);
  });
  var deskAbbr = _dsDeskAbbr();

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var radkaVMesici = {};   // user_id -> { mesic -> row }
  for (var m = 1; m <= 12; m++) {
    var sh = ss.getSheetByName(_dsNazevMesice(m));
    if (!sh) continue;
    var uidCol = _gUid(_dmDniVMesici(m));
    var last = sh.getLastRow();
    if (last < DS_PRVNI_DATA_RADEK) continue;
    var uids = sh.getRange(DS_PRVNI_DATA_RADEK, uidCol, last - DS_PRVNI_DATA_RADEK + 1, 1).getValues();
    for (var i = 0; i < uids.length; i++) {
      var uid = String(uids[i][0] || '').trim();
      if (uid) (radkaVMesici[uid] = radkaVMesici[uid] || {})[m] = DS_PRVNI_DATA_RADEK + i;
    }
  }

  var podleM = {};   // mesic -> [ {row, den, slot, ab} ]
  _dsCti(trans, 'ATTENDANCE').forEach(function (a) {
    if (String(a.approved).toLowerCase() === 'rejected') return;
    var datum = String(a.date || '').substring(0, 10);
    if (datum.substring(0, 4) !== String(ROK)) return;
    var uid = String(a.user_id || '').trim();
    var mm = parseInt(datum.substring(5, 7), 10);
    var row = radkaVMesici[uid] && radkaVMesici[uid][mm];
    if (!row) return;
    var ab = abbr[String(a.status_id).trim()];
    if (!ab) return;
    (podleM[mm] = podleM[mm] || []).push({
      row: row, den: parseInt(datum.substring(8, 10), 10),
      slot: String(a.slot || 'ALL_DAY').toUpperCase(), ab: ab
    });
  });

  var pocet = 0;
  Object.keys(podleM).forEach(function (mm) {
    pocet += _dmImportMesic(ss.getSheetByName(_dsNazevMesice(Number(mm))), Number(mm), podleM[mm], vacAbbr);
  });

  // rezervace stolů se sem NEnačítají — jsou zvlášť přes „🪑 Načíst rezervace stolů z aplikace".
  var zvyrazneno = 0;
  var propsN = PropertiesService.getDocumentProperties();
  for (var mb = 1; mb <= 12; mb++) {
    var shb = ss.getSheetByName(_dsNazevMesice(mb));
    if (!shb) continue;
    var rezMb = _dmRezMesic(ss, mb);
    zvyrazneno += _dmObnovStulyList(shb, mb, deskAbbr, rezMb);
    propsN.setProperty('REZ_' + mb, _dmRezHash(rezMb));
  }

  ui.alert('Načteno ' + pocet + ' dní docházky.\n\n' +
    'Statusy vyžadující stůl: ' + (deskAbbr.join(', ') || '— žádný (v ATTENDANCE_STATUSES není allows_desk_reservation)') + '\n' +
    'Kancelářských dnů bez rezervace (červený rámeček): ' + zvyrazneno + '\n\n' +
    'Rezervace stolů načteš zvlášť: 🪑 Načíst rezervace stolů z aplikace.');
}

/** Načte jen rezervace stolů z živé aplikace (bez docházky). */
function nactiRezervace() {
  if (ZDROJ_TRANSACTION_ID.indexOf('VLOZ') !== -1) {
    throw new Error('Nastav ZDROJ_TRANSACTION_ID nahoře ve skriptu (Vlastnosti skriptu živé appky → SPREADSHEET_TRANSACTION_ID).');
  }
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Načíst rezervace stolů z živé aplikace pro rok ' + ROK +
    '?\nList Rezervace se přepíše hodnotami z aplikace.', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

  var core = SpreadsheetApp.openById(ZDROJ_CORE_ID);
  var trans = SpreadsheetApp.openById(ZDROJ_TRANSACTION_ID);
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var deskAbbr = _dsDeskAbbr();

  var d = _dmImportRezervace(ss, core, trans);

  var zvyrazneno = 0;
  var propsR = PropertiesService.getDocumentProperties();
  for (var mb = 1; mb <= 12; mb++) {
    var shb = ss.getSheetByName(_dsNazevMesice(mb));
    if (!shb) continue;
    var rezMb = _dmRezMesic(ss, mb);
    zvyrazneno += _dmObnovStulyList(shb, mb, deskAbbr, rezMb);
    propsR.setProperty('REZ_' + mb, _dmRezHash(rezMb));
  }

  if (d.stoly === 0) {
    ui.alert('List "Stoly" je prázdný nebo chybí.\n\nNejdřív spusť 🔄 Postavit / obnovit listy — ten vytvoří list Stoly z OFFICE_MAPS živé aplikace. Bez stolů se rezervace nedají spárovat.');
    return;
  }
  ui.alert('Načteno ' + d.count + ' rezervací stolů.\n\n' +
    'Stolů v listu: ' + d.stoly + '\n' +
    'Zdroj rezervací: ' + (d.zdroj || 'NENALEZEN') + '\n' +
    'Řádků celkem: ' + d.celkem + '\n' +
    'Z toho pro rok ' + ROK + ': ' + d.letos + '\n' +
    (d.bezStolu ? 'Nespárováno se stolem (cell_id): ' + d.bezStolu + '\n' : '') +
    'Statusy vyžadující stůl: ' + (deskAbbr.join(', ') || '— žádný') + '\n' +
    'Kancelářských dnů bez rezervace (červený rámeček): ' + zvyrazneno + '\n' +
    (!d.zdroj ? '\n⚠ Tabulka rezervací nikde nenalezena.' + d.listy() +
      '\n\nPošli mi, jak se list s rezervacemi jmenuje.' : '') +
    (d.zdroj && d.celkem > 0 && d.letos === 0 ? '\n⚠ Žádná rezervace pro rok ' + ROK + '.' : '') +
    (d.letos > 0 && d.count === 0 ? '\n⚠ Rezervace existují, ale cell_id nesedí s listem Stoly — spusť Pomocné listy → Aktualizovat list Stoly.' : ''));
}

/**
 * Najde tabulku podle víc možných názvů napříč víc sešity. Vrací {rows, zdroj}.
 * Nalezené místo si zapamatuje do DocumentProperties (`propKlic`), takže příště
 * jde rovnou tam místo prohledávání až 10 kombinací sešit × název.
 */
function _dsCtiKdekoliv(sesity, nazvy, propKlic) {
  var props = propKlic ? PropertiesService.getDocumentProperties() : null;

  function zkus(sesit, nazev) {
    var sh = sesit.ss.getSheetByName(nazev);
    if (!sh || sh.getLastRow() < 2) return null;
    if (props) props.setProperty(propKlic, sesit.jmeno + '|' + nazev);
    return { rows: _dsCtiSheet(sh), zdroj: sesit.jmeno + ' → ' + nazev };
  }

  // 1) zapamatovaná kombinace
  var znama = props ? props.getProperty(propKlic) : null;
  if (znama) {
    var p = znama.split('|');
    var sesit = sesity.filter(function (s) { return s.jmeno === p[0]; })[0];
    if (sesit) {
      var hit = zkus(sesit, p[1]);
      if (hit) return hit;
      props.deleteProperty(propKlic);   // přesunulo se / vyprázdnilo → hledej znovu
    }
  }

  // 2) plné hledání
  for (var i = 0; i < sesity.length; i++) {
    for (var j = 0; j < nazvy.length; j++) {
      var hit2 = zkus(sesity[i], nazvy[j]);
      if (hit2) return hit2;
    }
  }
  return { rows: [], zdroj: '' };
}

/**
 * Natáhne MAP_RESERVATIONS z živé DB do listu Rezervace (roku ROK).
 * Vrací { count, stoly, celkem, letos, bezStolu, zdroj, listy() }.
 * `listy()` je LÍNÉ — seznam listů obou sešitů se načte, jen když se tabulka
 * nenajde a je potřeba ho vypsat do chybové hlášky.
 */
function _dmImportRezervace(ss, core, trans) {
  var d = {
    count: 0, stoly: 0, celkem: 0, letos: 0, bezStolu: 0, zdroj: '',
    listy: function () {
      function nazvy(x) { return x.getSheets().map(function (s) { return s.getName(); }).join(', '); }
      return '\n\nListy v TRANSACTION:\n' + nazvy(trans) + '\n\nListy v CORE:\n' + nazvy(core);
    }
  };

  var stoly = _dsCtiStoly(ss);
  d.stoly = stoly.length;
  if (stoly.length === 0) return d;
  var labelByCell = {};
  stoly.forEach(function (s) { if (s.cell_id) labelByCell[s.cell_id] = s.stul; });

  var jmenoByUid = {};
  _dsZdroj('USERS').forEach(function (u) { jmenoByUid[u.user_id] = _dsJmeno(u); });

  // rezervace stolů bývají v CORE (v TRANSACTION je list často prázdný) → CORE první
  var nalez = _dsCtiKdekoliv(
    [{ ss: core, jmeno: 'CORE' }, { ss: trans, jmeno: 'TRANSACTION' }],
    ['MAP_RESERVATIONS', 'map_reservations', 'MAP_RESERVATION', 'RESERVATIONS', 'DESK_RESERVATIONS'],
    'ZDROJ_REZERVACI'
  );
  d.zdroj = nalez.zdroj;

  var sh = _dsListRezervace(ss);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 4).clearContent();

  var out = [];
  nalez.rows.forEach(function (r) {
    d.celkem++;
    if (String(r.active) === 'false') return;
    var datum = _dsFmtDatum(r.date);
    if (datum.substring(0, 4) !== String(ROK)) return;
    d.letos++;
    var stul = labelByCell[String(r.cell_id).trim()];
    if (!stul) { d.bezStolu++; return; }
    out.push([datum, stul, jmenoByUid[String(r.user_id).trim()] || '', String(r.user_id).trim()]);
  });
  if (out.length) sh.getRange(2, 1, out.length, 4).setNumberFormat('@').setValues(out);
  d.count = out.length;
  _dsCacheZrus('REZERVACE');
  return d;
}

/**
 * Zapíše importované dny do měsíčního listu DÁVKOVĚ.
 * 1 čtení mřížky + 1 zápis hodnot + 1 zápis souhrnů; slučování se řeší jen
 * u dnů, které opravdu mění stav (celý den ↔ půlden) — těch je málo.
 * Dny, které v importu nejsou, zůstávají beze změny.
 */
function _dmImportMesic(sheet, mesic, zapisy, vacAbbr) {
  if (!sheet || !zapisy || !zapisy.length) return 0;

  var N = _dmDniVMesici(mesic);
  var den1 = DS_DEN1_COL;
  var dnyW = N * DS_DEN_KROK;
  var prvni = DS_PRVNI_DATA_RADEK;
  var last = sheet.getLastRow();
  if (last < prvni) return 0;
  var nRows = last - prvni + 1;

  // ── jedno čtení: hodnoty mřížky, stav sloučení, skrytý sloupec user_id ──
  var rng = sheet.getRange(prvni, den1, nRows, dnyW);
  var grid = rng.getValues();
  var merged = {};
  rng.getMergedRanges().forEach(function (mr) { merged[mr.getRow() + '_' + mr.getColumn()] = 1; });
  var uids = sheet.getRange(prvni, _gUid(N), nRows, 1).getValues();

  // ── sloučit záznamy po dnech (AM/PM/ALL_DAY) ──
  var poDni = {};   // "row_den" -> { row, den, all, am, pm }
  zapisy.forEach(function (z) {
    var key = z.row + '_' + z.den;
    var e = poDni[key] || (poDni[key] = { row: z.row, den: z.den, all: '', am: '', pm: '' });
    if (z.slot === 'AM') e.am = z.ab;
    else if (z.slot === 'PM') e.pm = z.ab;
    else e.all = z.ab;
  });

  // ── promítnout do pole v paměti + posbírat nutné změny slučování ──
  var slouc = [], rozdel = [], n = 0;
  Object.keys(poDni).forEach(function (k) {
    var e = poDni[k];
    var i = e.row - prvni;
    if (i < 0 || i >= nRows) return;                 // řádek mimo list
    var dopCol = _gDop(e.den);
    var idx = dopCol - den1;
    var jeSloucen = !!merged[e.row + '_' + dopCol];
    if (e.all) {
      grid[i][idx] = e.all;
      grid[i][idx + 1] = '';
      if (!jeSloucen) slouc.push([e.row, dopCol]);
    } else {
      grid[i][idx] = e.am;
      grid[i][idx + 1] = e.pm;
      if (jeSloucen) rozdel.push([e.row, dopCol]);
    }
    n++;
  });

  // Pořadí je důležité: půldny rozbít PŘED zápisem (jinak by se odpolední
  // hodnota ztratila ve sloučené buňce), celodenní sloučit AŽ PO zápisu
  // (sloučení si ponechá levou = správnou hodnotu).
  rozdel.forEach(function (p) { sheet.getRange(p[0], p[1], 1, 2).breakApart(); });
  rng.setValues(grid);
  slouc.forEach(function (p) { sheet.getRange(p[0], p[1], 1, 2).merge(); });

  // ── souhrn dovolené: spočítat v paměti, zapsat jedním voláním ──
  slouc.forEach(function (p) { merged[p[0] + '_' + p[1]] = 1; });
  rozdel.forEach(function (p) { delete merged[p[0] + '_' + p[1]]; });
  var vac = {};
  (vacAbbr || []).forEach(function (a) { vac[String(a).trim()] = 1; });

  var souhrn = [];
  for (var i2 = 0; i2 < nRows; i2++) {
    if (!String(uids[i2][0] || '').trim()) { souhrn.push(['']); continue; }   // mezera / nadpis
    var dny = 0;
    for (var d = 1; d <= N; d++) {
      var c = _gDop(d), o = c - den1;
      if (merged[(prvni + i2) + '_' + c]) {
        if (vac[String(grid[i2][o] || '').trim()]) dny += 1;
      } else {
        if (vac[String(grid[i2][o] || '').trim()]) dny += 0.5;
        if (vac[String(grid[i2][o + 1] || '').trim()]) dny += 0.5;
      }
    }
    souhrn.push([dny]);
  }
  sheet.getRange(prvni, _gSouhrn(N), nRows, 1).setValues(souhrn);
  return n;
}


// ════════════════════════════════════════════════════════════════════════════
//  MODAL — serverové funkce
// ════════════════════════════════════════════════════════════════════════════

function dm_init() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var mesic = _dmMesicZListu(ss.getActiveSheet()) || (new Date().getMonth() + 1);

  var email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var me = _dsZdroj('USERS').filter(function (u) {
    return String(u.email).toLowerCase() === email;
  })[0];
  if (!me) throw new Error('Tvůj účet (' + (email || '?') + ') není v USERS živé appky.');

  var seen = {};
  var statusy = [];
  _dsZdroj('ATTENDANCE_STATUSES')
    .filter(function (s) { return String(s.active) !== 'false' && s.abbreviation; })
    .forEach(function (s) {
      var ab = String(s.abbreviation).trim();
      if (!ab || seen[ab]) return;
      seen[ab] = 1;
      statusy.push({
        abbr: ab, name: s.name || '',
        color: _dsHex(s.color, '#94a3b8'), fg: _dsHex(s.text_color, '#ffffff'),
        vac: String(s.is_vacation) === 'true',
        desk: String(s.allows_desk_reservation) === 'true'
      });
    });

  var stolyRows = _dsCtiStoly(ss).filter(function (s) { return s.aktivni; });
  var stoly = stolyRows.map(function (s) { return { label: s.stul, trvale: s.trvale }; });
  var trvaleByCell = {};
  stolyRows.forEach(function (s) { if (s.cell_id) trvaleByCell[s.cell_id] = s.trvale; });
  var aktivniLabel = {};
  stolyRows.forEach(function (s) { aktivniLabel[s.stul] = 1; });

  var usek = _dsZdroj('SECTIONS').filter(function (s) {
    return s.name === USEK_NAZEV && String(s.active) !== 'false';
  })[0];
  var mapaRaw = usek ? _dsNactiMapu(usek) : null;
  var mapa = null;
  if (mapaRaw) {
    mapa = {
      name: mapaRaw.name, rows: mapaRaw.rows, cols: mapaRaw.cols,
      desks: mapaRaw.desks
        .filter(function (d) { return aktivniLabel[d.label]; })
        .map(function (d) {
          return { label: d.label, row: d.row, col: d.col, trvale: trvaleByCell[d.id] || '' };
        })
    };
  }

  return {
    rok: ROK, mesic: mesic, userId: me.user_id, jmeno: _dsJmeno(me), usek: USEK_NAZEV,
    statusy: statusy,
    vacAbbr: statusy.filter(function (s) { return s.vac; }).map(function (s) { return s.abbr; }),
    deskAbbr: statusy.filter(function (s) { return s.desk; }).map(function (s) { return s.abbr; }),
    stoly: stoly, mapa: mapa
  };
}

function dm_mesic(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _dmListMesice(payload.mesic);
  var mr = _dmMojeRadka(sheet, payload.userId);
  var souhrnCol = _gSouhrn(_dmDniVMesici(payload.mesic));
  return {
    mesic: payload.mesic, rok: ROK,
    dny: _dmDenData(sheet, mr.row, payload.mesic),
    souhrn: sheet.getRange(mr.row, souhrnCol).getValue(),
    rezMesic: _dmRezMesic(ss, payload.mesic)
  };
}

/** Rezervace / uvolnění stolu. payload: {userId, jmeno, mesic, den, stul} (stul='' = uvolnit) */
function dm_stul(payload) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = _dsListRezervace(ss);
    var dateStr = ROK + '-' + ('0' + payload.mesic).slice(-2) + '-' + ('0' + payload.den).slice(-2);
    var rez = _dmCtiRezervace(ss);                        // jediné čtení listu za běh
    var vDen = _dmRezMesic(ss, payload.mesic).filter(function (r) { return r.den === payload.den; });
    var moje = vDen.filter(function (r) { return r.uid === String(payload.userId); })[0];

    var maStul = false;
    if (!payload.stul) {
      if (moje) sh.getRange(moje.radek, 1, 1, 4).clearContent();
    } else {
      maStul = true;
      var desk = _dsCtiStoly(ss).filter(function (s) { return s.stul === payload.stul && s.aktivni; })[0];
      if (!desk) throw new Error('Stůl "' + payload.stul + '" neexistuje nebo není aktivní.');
      if (desk.trvale && desk.trvale !== payload.jmeno) {
        throw new Error('Stůl ' + payload.stul + ' patří natrvalo: ' + desk.trvale + '.');
      }
      var kolize = vDen.filter(function (r) {
        return r.stul === payload.stul && r.uid !== String(payload.userId);
      })[0];
      if (kolize) {
        throw new Error('Stůl ' + payload.stul + ' je ' + dateStr + ' obsazený: ' + kolize.jmeno + '.');
      }
      var cil = moje ? moje.radek : (rez.volne.length ? rez.volne[0] : rez.dalsi);
      sh.getRange(cil, 1, 1, 4).setNumberFormats([['@', '@', '@', '@']])
        .setValues([[dateStr, payload.stul, payload.jmeno, payload.userId]]);
    }
    _dsCacheZrus('REZERVACE');                            // list se změnil

    try {
      var msh = _dmListMesice(payload.mesic);
      var mmr = _dmMojeRadka(msh, payload.userId);
      _dmObnovStul(msh, mmr.row, payload.den, payload.deskAbbr || [], maStul || _dmMaTrvalyStul(ss, payload.jmeno));
      PropertiesService.getDocumentProperties().deleteProperty('REZ_' + payload.mesic);
    } catch (e) {}
    return { rezMesic: _dmRezMesic(ss, payload.mesic) };
  } finally {
    lock.releaseLock();
  }
}

function dm_uloz(payload) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    var sheet = _dmListMesice(payload.mesic);
    var mr = _dmMojeRadka(sheet, payload.userId);
    _dmZapisDen(sheet, mr.row, payload.den, payload.rezim, payload.dop, payload.odp);
    var souhrn = _dmPrepocitejSouhrn(sheet, mr.row, payload.mesic, payload.vacAbbr || []);
    var ssU = SpreadsheetApp.getActiveSpreadsheet();
    // status už nepotřebuje stůl → zruš případnou rezervaci
    if (!_dmPotrebaStul(payload.rezim, payload.dop, payload.odp, payload.deskAbbr)) {
      _dmZrusRezervaci(ssU, payload.userId, payload.mesic, payload.den);
    }
    try {
      var maR = _dmRezMesic(ssU, payload.mesic).some(function (r) {
        return String(r.uid) === String(payload.userId) && r.den === payload.den && r.stul;
      });
      _dmObnovStul(sheet, mr.row, payload.den, payload.deskAbbr || [], maR || _dmMaTrvalyStul(ssU, payload.jmeno));
    } catch (e) {}
    var den = _dmDenData(sheet, mr.row, payload.mesic).filter(function (x) { return x.den === payload.den; })[0];
    try { sheet.getRange(mr.row, _gDop(payload.den)).activate(); } catch (e) {}
    return { den: den, souhrn: souhrn, rezMesic: _dmRezMesic(ssU, payload.mesic) };
  } finally {
    lock.releaseLock();
  }
}

/** Hromadné zadání: den od–do, volitelně jen všední dny. */
function dm_hromadne(payload) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(25000);
  try {
    var sheet = _dmListMesice(payload.mesic);
    var mr = _dmMojeRadka(sheet, payload.userId);
    var N = _dmDniVMesici(payload.mesic);
    var od = Math.max(1, Math.min(N, Number(payload.odDen) || 1));
    var doo = Math.max(od, Math.min(N, Number(payload.doDen) || N));
    var ssH = SpreadsheetApp.getActiveSpreadsheet();
    var potrebaStul = _dmPotrebaStul(payload.rezim, payload.dop, payload.odp, payload.deskAbbr);
    for (var d = od; d <= doo; d++) {
      if (payload.jenVsedni) {
        var dow = new Date(ROK, payload.mesic - 1, d).getDay();
        if (dow === 0 || dow === 6) continue;
      }
      _dmZapisDen(sheet, mr.row, d, payload.rezim, payload.dop, payload.odp);
      if (!potrebaStul) _dmZrusRezervaci(ssH, payload.userId, payload.mesic, d);
    }
    var souhrn = _dmPrepocitejSouhrn(sheet, mr.row, payload.mesic, payload.vacAbbr || []);
    try {
      var da = payload.deskAbbr || [];
      if (da.length) {
        var trvaly = _dmMaTrvalyStul(ssH, payload.jmeno);
        var rezDny = {};
        _dmRezMesic(ssH, payload.mesic).forEach(function (r) {
          if (String(r.uid) === String(payload.userId) && r.stul) rezDny[r.den] = 1;
        });
        for (var dd = od; dd <= doo; dd++) {
          if (payload.jenVsedni) {
            var w = new Date(ROK, payload.mesic - 1, dd).getDay();
            if (w === 0 || w === 6) continue;
          }
          _dmObnovStul(sheet, mr.row, dd, da, !!rezDny[dd] || trvaly);
        }
      }
    } catch (e) {}
    try { sheet.getRange(mr.row, 1).activate(); } catch (e) {}
    return { dny: _dmDenData(sheet, mr.row, payload.mesic), souhrn: souhrn, rezMesic: _dmRezMesic(ssH, payload.mesic) };
  } finally {
    lock.releaseLock();
  }
}

function _dmZapisDen(sheet, row, den, rezim, dop, odp) {
  var dopCol = _gDop(den);
  var pair = sheet.getRange(row, dopCol, 1, 2);
  if (pair.isPartOfMerge()) pair.breakApart();
  if (rezim === 'CLEAR') {
    pair.clearContent();
    pair.merge();
  } else if (rezim === 'HALF') {
    sheet.getRange(row, dopCol).setValue(dop || '');
    sheet.getRange(row, dopCol + 1).setValue(odp || '');
  } else { // FULL
    pair.merge();
    sheet.getRange(row, dopCol).setValue(dop || '');
  }
}


function _dmListMesice(mesic) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(_dsNazevMesice(mesic));
  if (!sheet) throw new Error('List měsíce neexistuje. Spusť „Postavit / obnovit listy".');
  return sheet;
}

function _dmMesicZListu(sheet) {
  var m = parseInt(String(sheet.getName()).substring(0, 2), 10);
  return (m >= 1 && m <= 12) ? m : 0;
}

function _dmDniVMesici(mesic) {
  return new Date(ROK, mesic, 0).getDate();
}

function _dmMojeRadka(sheet, userId) {
  var uidCol = _gUid(_dmDniVMesici(_dmMesicZListu(sheet)));
  var last = sheet.getLastRow();
  var n = last - DS_PRVNI_DATA_RADEK + 1;
  if (n < 1) throw new Error('Prázdný list.');
  var uids = sheet.getRange(DS_PRVNI_DATA_RADEK, uidCol, n, 1).getValues();
  for (var i = 0; i < uids.length; i++) {
    if (String(uids[i][0]) === String(userId)) return { row: DS_PRVNI_DATA_RADEK + i };
  }
  throw new Error('Nejsi v tomhle měsíci (list ' + sheet.getName() + '). Možná máš vyplněné datum Do.');
}

function _dmDenData(sheet, row, mesic) {
  var N = _dmDniVMesici(mesic);
  var den1 = DS_DEN1_COL;
  var rng = sheet.getRange(row, den1, 1, N * DS_DEN_KROK);
  var vals = rng.getValues()[0];
  var mergedDop = {};
  rng.getMergedRanges().forEach(function (mr) { mergedDop[mr.getColumn()] = true; });

  var dny = [];
  for (var d = 1; d <= N; d++) {
    var dopCol = _gDop(d);
    var idx = dopCol - den1;
    var dow = new Date(ROK, mesic - 1, d).getDay();
    var full = !!mergedDop[dopCol];
    dny.push({
      den: d, dow: dow, weekend: (dow === 0 || dow === 6),
      full: full,
      dop: String(vals[idx] || ''),
      odp: full ? '' : String(vals[idx + 1] || '')
    });
  }
  return dny;
}

function _dmPrepocitejSouhrn(sheet, row, mesic, vacAbbr) {
  var N = _dmDniVMesici(mesic);
  var den1 = DS_DEN1_COL;
  var rng = sheet.getRange(row, den1, 1, N * DS_DEN_KROK);
  var vals = rng.getValues()[0];
  var mergedDop = {};
  rng.getMergedRanges().forEach(function (mr) { mergedDop[mr.getColumn()] = true; });
  var vac = {};
  (vacAbbr || []).forEach(function (a) { vac[a] = true; });

  var dny = 0;
  for (var d = 1; d <= N; d++) {
    var dopCol = _gDop(d);
    var idx = dopCol - den1;
    if (mergedDop[dopCol]) {
      if (vac[String(vals[idx] || '')]) dny += 1;
    } else {
      if (vac[String(vals[idx] || '')]) dny += 0.5;
      if (vac[String(vals[idx + 1] || '')]) dny += 0.5;
    }
  }
  sheet.getRange(row, _gSouhrn(N)).setValue(dny);
  return dny;
}


// ── společné pomocné funkce ──────────────────────────────────────────────

// ── cache zdrojů z CORE (jen pro vývoj: „Cachovat zdroje z aplikace") ──
// Seznam tabulek je nahoře u konstant (DS_ZDROJ_TABULKY).
var _DS_CORE = null;
function _dsCore() {
  if (!_DS_CORE) {
    if (ZDROJ_CORE_ID.indexOf('VLOZ') !== -1) throw new Error('Nastav ZDROJ_CORE_ID nahoře ve skriptu.');
    _DS_CORE = SpreadsheetApp.openById(ZDROJ_CORE_ID);
  }
  return _DS_CORE;
}
/** Čte tabulku z CORE — přednostně z lokální cache „Z_<název>", jinak živě z CORE (1× za běh). */
function _dsZdroj(name) {
  return _dsCache('ZDROJ_' + name, function () {
    var lok = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Z_' + name);
    if (lok && lok.getLastRow() >= 2) return _dsCtiSheet(lok);
    return _dsCtiSheet(_dsCore().getSheetByName(name));
  });
}

function _dsCti(ss, listName) {
  return _dsCtiSheet(ss.getSheetByName(listName));
}

function _dsCtiSheet(sh) {
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var head = data[0];
  return data.slice(1).map(function (row) {
    var o = {};
    head.forEach(function (h, i) {
      var v = row[i];
      if (v instanceof Date && !isNaN(v.getTime())) {
        o[h] = Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
      } else {
        o[h] = (v === null || v === undefined) ? '' : String(v).replace(/^'/, '').trim();
      }
    });
    return o;
  });
}

function _dsJmeno(u) {
  return ((u.last_name || '') + ' ' + (u.first_name || '')).trim();
}

function _dsJeVedouci(u) {
  var sr = String(u.system_role || '').toUpperCase();
  var or_ = String(u.org_role || '').toUpperCase();
  return sr === 'ADMIN' || sr === 'SUPERADMIN' || sr === 'LEADER'
    || or_ === 'SECTION_LEADER' || or_ === 'SECTION_DEPUTY'
    || or_ === 'DEPT_LEADER' || or_ === 'DEPT_DEPUTY';
}

function _dsNazevMesice(mesic) {
  return (mesic < 10 ? '0' : '') + mesic + ' ' + DS_MESICE[mesic - 1];
}

function _dsHex(val, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(val || '')) ? String(val) : fallback;
}

/** Zesvětlí hex barvu směrem k bílé; k = podíl bílé (0 = beze změny, 1 = bílá). */
function _dsSvetleji(hex, k) {
  var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  var f = Math.max(0, Math.min(1, k));
  var out = '#';
  for (var i = 1; i <= 3; i++) {
    var v = Math.round(parseInt(m[i], 16) + (255 - parseInt(m[i], 16)) * f);
    out += ('0' + v.toString(16)).slice(-2);
  }
  return out;
}

function _dsFont(sheet) {
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).setFontFamily(DS_FONT);
}

/** Datum ze živé DB → "yyyy-MM-dd" nebo '' pro zápis do listu. */
function _dsFmtDatum(v) {
  var d = _dsParseDatum(v);
  if (!d) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Hodnota z buňky/DB → Date nebo null. */
function _dsParseDatum(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v || '').trim();
  if (!s) return null;
  s = s.replace(/^'/, '');
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Státní svátky ČR pro rok → { "MM-DD": "název" }. */
function _dsSvatkyCR(rok) {
  var m = {
    '01-01': 'Nový rok / Den obnovy samostatného českého státu',
    '05-01': 'Svátek práce',
    '05-08': 'Den vítězství',
    '07-05': 'Den slovanských věrozvěstů Cyrila a Metoděje',
    '07-06': 'Den upálení mistra Jana Husa',
    '09-28': 'Den české státnosti',
    '10-28': 'Den vzniku samostatného československého státu',
    '11-17': 'Den boje za svobodu a demokracii',
    '12-24': 'Štědrý den',
    '12-25': '1. svátek vánoční',
    '12-26': '2. svátek vánoční'
  };
  var e = _dsVelikonoce(rok);
  m[e.patek] = 'Velký pátek';
  m[e.pondeli] = 'Velikonoční pondělí';
  return m;
}

/** Velikonoce (Meeus/Jones/Butcher) → { patek:"MM-DD", pondeli:"MM-DD" }. */
function _dsVelikonoce(rok) {
  var a = rok % 19, b = Math.floor(rok / 100), c = rok % 100;
  var dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  var g = Math.floor((b - f + 1) / 3), h = (19 * a + b - dd - g + 15) % 30;
  var ii = Math.floor(c / 4), k = c % 4;
  var l = (32 + 2 * e + 2 * ii - h - k) % 7;
  var mm = Math.floor((a + 11 * h + 22 * l) / 451);
  var mesic = Math.floor((h + l - 7 * mm + 114) / 31);
  var den = ((h + l - 7 * mm + 114) % 31) + 1;
  var nedele = new Date(rok, mesic - 1, den);
  function fmt(x) { return ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); }
  var patek = new Date(nedele); patek.setDate(patek.getDate() - 2);
  var pondeli = new Date(nedele); pondeli.setDate(pondeli.getDate() + 1);
  return { patek: fmt(patek), pondeli: fmt(pondeli) };
}
