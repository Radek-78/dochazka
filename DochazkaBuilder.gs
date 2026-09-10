/**
 * ============================================================================
 *  BUILDER SAMOSTATNÉHO DOCHÁZKOVÉHO SPREADSHEETU  (varianta A — čistý sheet)
 * ============================================================================
 *  Vytvoří NOVÝ samostatný Google Sheet s 12 měsíčními listy pro zadaný rok.
 *  Zadávání statusu = rozbalovací seznam přímo v buňce; podmíněné formátování
 *  buňku obarví podle vybrané zkratky. Půldny = 2 řádky na zaměstnance (DOP/ODP).
 *
 *  SPUŠTĚNÍ:
 *    V editoru Apps Scriptu vyber funkci  vytvorDochazkovySpreadsheet  a klikni
 *    Spustit. Vytvoří se soubor pro rok ROK_DEFAULT (viz níže). URL nového
 *    souboru se vypíše do panelu Spuštění (console.log) a vrátí jako návratová
 *    hodnota.
 *
 *  JINÝ ROK:
 *    Změň konstantu ROK_DEFAULT, nebo si přidej wrapper:
 *      function vytvorDochazku2027() { return vytvorDochazkovySpreadsheet(2027); }
 *
 *  Existující soubory tato funkce NEMAŽE ani NEPŘEPISUJE — vždy vytvoří nový.
 * ============================================================================
 */

var ROK_DEFAULT = new Date().getFullYear();

var DOCH_MESICE_CZ = ['Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
  'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];
var DOCH_DNY_CZ = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];

// Rozvržení: A = Úsek, B = Jméno, C = ½ ; den 1 začíná ve sloupci 4 (D)
var DOCH_PRVNI_DEN_COL = 4;
var DOCH_HLAVICKA_RADKU = 3;      // ř. 1 titulek, ř. 2 čísla dnů, ř. 3 dny v týdnu
var DOCH_PRVNI_DATA_RADEK = 4;

var DOCH_BG_TITULEK = '#004fac';
var DOCH_FG_TITULEK = '#ffffff';
var DOCH_BG_HLAVICKA = '#f1f5f9';
var DOCH_BG_VIKEND = '#e9edf2';
var DOCH_BG_SVATEK = '#fde8c8';
var DOCH_BG_BUNKA = '#ffffff';


/**
 * Hlavní funkce — vytvoří nový docházkový spreadsheet pro daný rok.
 * @param {number} [rok] Rok pro měsíční listy. Výchozí = ROK_DEFAULT.
 * @return {string} URL nového spreadsheetu.
 */
function vytvorDochazkovySpreadsheet(rok) {
  rok = Number(rok) || ROK_DEFAULT || new Date().getFullYear();

  // ── 1. Zdrojová data z živé DB ──────────────────────────────────────────
  var coreSS = DB.getCore();

  var nazevUseku = {};
  DB.getTable(coreSS, DB_SHEETS.CORE.SECTIONS).forEach(function (s) {
    nazevUseku[s.section_id] = s.name || '';
  });

  var dnes = new Date();
  dnes.setHours(0, 0, 0, 0);

  var zamestnanci = DB.getTable(coreSS, DB_SHEETS.CORE.USERS)
    .filter(function (u) {
      if (String(u.active) !== 'true') return false;
      if (u.date_end) {
        var konec = new Date(u.date_end);
        if (!isNaN(konec.getTime()) && konec < dnes) return false;
      }
      return true;
    })
    .map(function (u) {
      return {
        jmeno: ((u.last_name || '') + ' ' + (u.first_name || '')).trim(),
        usek: nazevUseku[u.section_id] || ''
      };
    })
    .sort(function (a, b) { return a.jmeno.localeCompare(b.jmeno, 'cs'); });

  if (zamestnanci.length === 0) {
    throw new Error('Nenašel jsem žádné aktivní zaměstnance v USERS.');
  }

  var statusy = DB.getTable(coreSS, DB_SHEETS.CORE.ATTENDANCE_STATUSES)
    .filter(function (s) { return String(s.active) !== 'false' && s.abbreviation; });

  // deduplikace zkratek (první výskyt vyhrává — pro dropdown i formátování)
  var zkratky = [];
  var videnaZkratka = {};
  var statusyUnik = [];
  statusy.forEach(function (s) {
    var z = String(s.abbreviation).trim();
    if (!z || videnaZkratka[z]) return;
    videnaZkratka[z] = true;
    zkratky.push(z);
    statusyUnik.push(s);
  });
  if (zkratky.length === 0) {
    throw new Error('Nenašel jsem žádné aktivní statusy se zkratkou v ATTENDANCE_STATUSES.');
  }

  // zkratky statusů dovolené (pro souhrnný sloupec)
  var zkratkyDovolene = statusyUnik
    .filter(function (s) { return String(s.is_vacation) === 'true'; })
    .map(function (s) { return String(s.abbreviation).trim(); });

  var svatky = CalendarData.getHolidaysForYear(rok);  // { "MM-DD": "název" }

  // ── 2. Nový spreadsheet ────────────────────────────────────────────────
  var ss = SpreadsheetApp.create('Docházka ' + rok);
  ss.setSpreadsheetLocale('cs_CZ');
  ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());

  _dochListNastaveni(ss, rok, zamestnanci.length, statusyUnik.length);
  _dochListStatusy(ss, statusyUnik);

  for (var m = 1; m <= 12; m++) {
    _dochMesicniList(ss, rok, m, zamestnanci, zkratky, statusyUnik, zkratkyDovolene, svatky);
  }

  // smazat výchozí prázdný list
  var vychozi = ss.getSheetByName('Sheet1') || ss.getSheetByName('List1');
  if (vychozi && ss.getSheets().length > 1) ss.deleteSheet(vychozi);

  var aktualni = ss.getSheetByName(_dochNazevListu(new Date().getMonth() + 1));
  ss.setActiveSheet(aktualni || ss.getSheets()[0]);

  var url = ss.getUrl();
  console.log('Docházkový spreadsheet vytvořen: ' + url);
  return url;
}


/**
 * Sestaví jeden měsíční list.
 */
function _dochMesicniList(ss, rok, mesic, zamestnanci, zkratky, statusyUnik, zkratkyDovolene, svatky) {
  var sheet = ss.insertSheet(_dochNazevListu(mesic));

  var pocetDnu = new Date(rok, mesic, 0).getDate();
  var prvniDen = DOCH_PRVNI_DEN_COL;
  var posledniDen = prvniDen + pocetDnu - 1;
  var souhrnCol = posledniDen + 1;
  var pocetZam = zamestnanci.length;
  var pocetRadku = pocetZam * 2;
  var prvniData = DOCH_PRVNI_DATA_RADEK;
  var posledniData = prvniData + pocetRadku - 1;

  // ── rozměry listu (nový list má 26 sl. / 1000 ř.) ──
  var maxCol = sheet.getMaxColumns();
  if (maxCol < souhrnCol) sheet.insertColumnsAfter(maxCol, souhrnCol - maxCol);
  else if (maxCol > souhrnCol) sheet.deleteColumns(souhrnCol + 1, maxCol - souhrnCol);
  var maxRow = sheet.getMaxRows();
  if (maxRow < posledniData) sheet.insertRowsAfter(maxRow, posledniData - maxRow);
  else if (maxRow > posledniData) sheet.deleteRows(posledniData + 1, maxRow - posledniData);

  // ── ř. 1: titulek ──
  sheet.getRange(1, 1, 1, souhrnCol).merge()
    .setValue(DOCH_MESICE_CZ[mesic - 1].toUpperCase() + ' ' + rok)
    .setBackground(DOCH_BG_TITULEK).setFontColor(DOCH_FG_TITULEK)
    .setFontWeight('bold').setFontSize(13)
    .setHorizontalAlignment('center').setVerticalAlignment('middle');

  // ── ř. 2-3: hlavička (čísla dnů + dny v týdnu), evidence víkendů/svátků ──
  var r2 = new Array(souhrnCol);
  var r3 = new Array(souhrnCol);
  r2[0] = 'Úsek'; r2[1] = 'Jméno'; r2[2] = '½';
  r3[0] = ''; r3[1] = ''; r3[2] = '';
  var vikendCol = {};
  var svatekCol = {};

  for (var d = 1; d <= pocetDnu; d++) {
    var col = prvniDen + d - 1;
    var dow = new Date(rok, mesic - 1, d).getDay();
    r2[col - 1] = d;
    r3[col - 1] = DOCH_DNY_CZ[dow];
    if (dow === 0 || dow === 6) vikendCol[col] = true;
    var klic = _pad2(mesic) + '-' + _pad2(d);
    if (svatky[klic]) svatekCol[col] = svatky[klic];
  }
  r2[souhrnCol - 1] = 'Dovolená (dny)';
  r3[souhrnCol - 1] = '';

  sheet.getRange(2, 1, 1, souhrnCol).setValues([r2])
    .setBackground(DOCH_BG_HLAVICKA).setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.getRange(3, 1, 1, souhrnCol).setValues([r3])
    .setBackground(DOCH_BG_HLAVICKA).setFontColor('#64748b').setFontSize(9)
    .setHorizontalAlignment('center');
  sheet.getRange(2, 1, 1, 3).setHorizontalAlignment('left');

  for (var hc in vikendCol) sheet.getRange(2, Number(hc), 2, 1).setBackground(DOCH_BG_VIKEND);
  for (var sc in svatekCol) {
    sheet.getRange(2, Number(sc), 2, 1).setBackground(DOCH_BG_SVATEK);
    sheet.getRange(3, Number(sc)).setNote(svatekCol[sc]);
  }

  // ── levý blok: Úsek / Jméno / ½ (DOP + ODP na zaměstnance) ──
  var levy = [];
  for (var i = 0; i < pocetZam; i++) {
    levy.push([zamestnanci[i].usek, zamestnanci[i].jmeno, 'DOP']);
    levy.push([zamestnanci[i].usek, zamestnanci[i].jmeno, 'ODP']);
  }
  sheet.getRange(prvniData, 1, pocetRadku, 3).setValues(levy);
  sheet.getRange(prvniData, 2, pocetRadku, 1).setFontWeight('bold');
  sheet.getRange(prvniData, 3, pocetRadku, 1)
    .setFontSize(9).setFontColor('#64748b').setHorizontalAlignment('center');

  // ── denní mřížka: pozadí (bílá / víkend / svátek) ──
  var bg = [];
  for (var r = 0; r < pocetRadku; r++) {
    var radekBg = [];
    for (var c = prvniDen; c <= posledniDen; c++) {
      radekBg.push(svatekCol[c] ? DOCH_BG_SVATEK : (vikendCol[c] ? DOCH_BG_VIKEND : DOCH_BG_BUNKA));
    }
    bg.push(radekBg);
  }
  var mrizka = sheet.getRange(prvniData, prvniDen, pocetRadku, pocetDnu);
  mrizka.setBackgrounds(bg);
  mrizka.setNumberFormat('@')                    // text — zabrání autokonverzi zkratek
    .setHorizontalAlignment('center').setFontWeight('bold').setFontSize(10);

  // ── denní mřížka: rozbalovací seznam statusů ──
  mrizka.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(zkratky, true)
    .setAllowInvalid(false)
    .setHelpText('Vyber status ze seznamu (viz list Statusy).')
    .build());

  // ── denní mřížka: podmíněné formátování — barva podle zkratky ──
  var pravidla = [];
  statusyUnik.forEach(function (s) {
    var z = String(s.abbreviation).trim();
    if (!z) return;
    pravidla.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(z)
      .setBackground(_dochHex(s.color, '#94a3b8'))
      .setFontColor(_dochHex(s.text_color, '#ffffff'))
      .setBold(true)
      .setRanges([mrizka])
      .build());
  });
  sheet.setConditionalFormatRules(pravidla);

  // ── souhrnný sloupec: =(COUNTIF(...)+...)/2 v DOP řádku každého zaměstnance ──
  var denOd = _colToA1(prvniDen);
  var denDo = _colToA1(posledniDen);
  var souhrn = [];
  for (var z2 = 0; z2 < pocetZam; z2++) {
    var rDop = prvniData + z2 * 2;
    if (zkratkyDovolene.length === 0) { souhrn.push(['']); souhrn.push(['']); continue; }
    var rozsah = denOd + rDop + ':' + denDo + (rDop + 1);
    var casti = zkratkyDovolene.map(function (zk) { return 'COUNTIF(' + rozsah + ',"' + zk + '")'; });
    souhrn.push(['=(' + casti.join('+') + ')/2']);
    souhrn.push(['']);
  }
  var souhrnRange = sheet.getRange(prvniData, souhrnCol, pocetRadku, 1);
  souhrnRange.setValues(souhrn);
  souhrnRange.setHorizontalAlignment('center').setNumberFormat('0.0');

  // ── orámování datového bloku (vnější + vodorovné mezi řádky) ──
  sheet.getRange(prvniData, 1, pocetRadku, souhrnCol)
    .setBorder(true, true, true, true, false, true, '#e2e8f0', SpreadsheetApp.BorderStyle.SOLID);

  // ── rozměry, zmrazení ──
  sheet.setFrozenRows(DOCH_HLAVICKA_RADKU);
  sheet.setFrozenColumns(3);
  sheet.setColumnWidth(1, 110);
  sheet.setColumnWidth(2, 170);
  sheet.setColumnWidth(3, 46);
  sheet.setColumnWidths(prvniDen, pocetDnu, 32);
  sheet.setColumnWidth(souhrnCol, 95);
  sheet.setRowHeight(1, 28);

  return sheet;
}


/**
 * List "Nastavení" — kontext souboru + stručný návod.
 */
function _dochListNastaveni(ss, rok, pocetZam, pocetStatusu) {
  var sheet = ss.insertSheet('Nastavení', 0);
  var radky = [
    ['DOCHÁZKA — NASTAVENÍ', ''],
    ['', ''],
    ['Rok', rok],
    ['Vygenerováno', Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm')],
    ['Počet zaměstnanců', pocetZam],
    ['Počet statusů', pocetStatusu],
    ['', ''],
    ['Jak to funguje', ''],
    ['', '• Každý zaměstnanec má 2 řádky: DOP (dopoledne) a ODP (odpoledne).'],
    ['', '• Celý den = vyplň obě půlky stejně (vyplň DOP a přetáhni dolů).'],
    ['', '• Status se vybírá z rozbalovacího seznamu v buňce; barva se doplní sama.'],
    ['', '• Rychlé zadání: přetáhni úchyt buňky, nebo označ rozsah + napiš + Ctrl+Enter.'],
    ['', '• Víkendy jsou šedě, svátky oranžově (název svátku je v poznámce buňky).'],
    ['', ''],
    ['Nový rok / přegenerování', ''],
    ['', '• Spusť znovu funkci vytvorDochazkovySpreadsheet(<rok>) v Apps Scriptu.'],
    ['', '• Vytvoří se VŽDY NOVÝ soubor. Tenhle se nepřepisuje. Starý si smaž ručně.'],
    ['', ''],
    ['Řazení', ''],
    ['', '• Když přeřazuješ lidi, seřaď podle sloupce "Jméno", pak "½",'],
    ['', '  ať zůstanou dvojice DOP/ODP pohromadě a ve správném pořadí.']
  ];
  sheet.getRange(1, 1, radky.length, 2).setValues(radky);
  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  sheet.getRangeList(['A3:A6', 'A8', 'A15', 'A19']).setFontWeight('bold');
  sheet.setColumnWidth(1, 190);
  sheet.setColumnWidth(2, 560);
  sheet.setFrozenRows(1);
  return sheet;
}


/**
 * List "Statusy" — legenda zkratek a barev.
 */
function _dochListStatusy(ss, statusyUnik) {
  var sheet = ss.insertSheet('Statusy', 1);
  sheet.getRange(1, 1, 1, 5)
    .setValues([['Zkratka', 'Název', 'Kategorie', 'Barva', 'Dovolená']])
    .setFontWeight('bold').setBackground(DOCH_BG_HLAVICKA);

  var radky = statusyUnik.map(function (s) {
    return [
      s.abbreviation || '',
      s.name || '',
      s.category || '',
      '',
      String(s.is_vacation) === 'true' ? 'ano' : ''
    ];
  });
  if (radky.length) {
    sheet.getRange(2, 1, radky.length, 5).setValues(radky);
    for (var i = 0; i < statusyUnik.length; i++) {
      var bgc = _dochHex(statusyUnik[i].color, '#94a3b8');
      var fgc = _dochHex(statusyUnik[i].text_color, '#ffffff');
      sheet.getRange(2 + i, 1).setBackground(bgc).setFontColor(fgc)
        .setFontWeight('bold').setHorizontalAlignment('center');
      sheet.getRange(2 + i, 4).setBackground(bgc);   // barevný swatch
    }
  }
  sheet.setColumnWidth(1, 80);
  sheet.setColumnWidth(2, 200);
  sheet.setColumnWidth(3, 150);
  sheet.setColumnWidth(4, 90);
  sheet.setColumnWidth(5, 80);
  sheet.setFrozenRows(1);
  return sheet;
}


// ── pomocné funkce ────────────────────────────────────────────────────────

function _dochNazevListu(mesic) {
  return _pad2(mesic) + ' ' + DOCH_MESICE_CZ[mesic - 1];
}

function _pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function _colToA1(col) {
  var s = '';
  while (col > 0) {
    var r = (col - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}

function _dochHex(val, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(val || '')) ? String(val) : fallback;
}
