/**
 * ============================================================================
 *  DOCHÁZKOVÝ SHEET — BOUND SKRIPT  ·  ETAPA 1 (kostra listů)
 * ============================================================================
 *  Tenhle skript patří DOVNITŘ vygenerovaného docházkového spreadsheetu
 *  (Rozšíření → Apps Script), NE do projektu živé aplikace.
 *
 *  NASTAVENÍ (uprav 3 konstanty níže):
 *    ZDROJ_CORE_ID  — ID spreadsheetu CORE DB živé appky.
 *                     Najdeš: Apps Script živé appky → Nastavení projektu →
 *                     Vlastnosti skriptu → hodnota "SPREADSHEET_CORE_ID".
 *    USEK_NAZEV     — přesný název úseku, pro který je tenhle soubor.
 *    ROK           — rok pro měsíční listy.
 *
 *  SPUŠTĚNÍ:
 *    Po nastavení konstant otevři spreadsheet, v menu "📋 Docházka" klikni
 *    "Postavit / obnovit listy" (nebo spusť funkci setup z editoru).
 *    Napoprvé odsouhlasíš oprávnění (čtení CORE DB + úpravy tohoto sešitu).
 *
 *  Etapa 1 staví jen kostru: Uživatelé + 12 měsíčních listů. Modal (zadávání
 *  přes okno) a slučování dnů přijdou v etapě 2.
 * ============================================================================
 */

var ZDROJ_CORE_ID = 'SEM_VLOZ_ID_CORE_DB';
var USEK_NAZEV = 'SEM_VLOZ_NAZEV_USEKU';
var ROK = new Date().getFullYear();

var DS_MESICE = ['Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
  'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];
var DS_DNY = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];

var DS_DEN1_COL = 2;              // den 1 dopoledne = sloupec 2 (B)
var DS_HLAVICKA_RADKU = 2;        // ř. 1 titulek, ř. 2 čísla dnů / dny v týdnu
var DS_PRVNI_DATA_RADEK = 3;


function onOpen() {
  SpreadsheetApp.getUi().createMenu('📋 Docházka')
    .addItem('Postavit / obnovit listy', 'setup')
    .addToUi();
}


/**
 * Postaví (nebo přestaví) list Uživatelé a 12 měsíčních listů podle živé DB.
 */
function setup() {
  if (ZDROJ_CORE_ID.indexOf('VLOZ') !== -1) throw new Error('Nastav ZDROJ_CORE_ID nahoře ve skriptu.');
  if (USEK_NAZEV.indexOf('VLOZ') !== -1) throw new Error('Nastav USEK_NAZEV nahoře ve skriptu.');

  var core = SpreadsheetApp.openById(ZDROJ_CORE_ID);

  var usek = _dsCti(core, 'SECTIONS').filter(function (s) {
    return s.name === USEK_NAZEV && String(s.active) !== 'false';
  })[0];
  if (!usek) throw new Error('Úsek "' + USEK_NAZEV + '" nenalezen v SECTIONS.');

  var oddeleni = _dsCti(core, 'DEPARTMENTS').filter(function (d) {
    return d.section_id === usek.section_id && String(d.active) !== 'false';
  });
  var tymy = _dsCti(core, 'GROUPS').filter(function (g) { return String(g.active) !== 'false'; });
  var statusy = _dsCti(core, 'ATTENDANCE_STATUSES').filter(function (s) {
    return String(s.active) !== 'false' && s.abbreviation;
  });

  var dnes = new Date();
  dnes.setHours(0, 0, 0, 0);
  var lide = _dsCti(core, 'USERS').filter(function (u) {
    if (u.section_id !== usek.section_id) return false;
    if (String(u.active) !== 'true') return false;
    if (u.date_end) {
      var k = new Date(u.date_end);
      if (!isNaN(k.getTime()) && k < dnes) return false;
    }
    return true;
  });
  if (lide.length === 0) throw new Error('Žádní aktivní zaměstnanci v úseku "' + USEK_NAZEV + '".');

  var oddMap = {};
  oddeleni.forEach(function (d) { oddMap[d.department_id] = d.name || ''; });
  var tymMap = {};
  tymy.forEach(function (g) { tymMap[g.group_id] = g.name || ''; });

  // deduplikace zkratek + ½ varianty pro dropdown
  var zkratky = [];
  var videno = {};
  var statusyUnik = [];
  statusy.forEach(function (s) {
    var z = String(s.abbreviation).trim();
    if (!z || videno[z]) return;
    videno[z] = true;
    zkratky.push(z);
    statusyUnik.push(s);
  });
  var zkratkyPlus = zkratky.slice();
  zkratky.forEach(function (z) { zkratkyPlus.push('½' + z); });

  var radky = _dsSerazeni(lide, oddeleni, tymy);
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  _dsListUzivatele(ss, lide, oddMap, tymMap);

  for (var m = 1; m <= 12; m++) {
    _dsListMesic(ss, m, radky, statusyUnik, zkratkyPlus);
  }

  var vychozi = ss.getSheetByName('Sheet1') || ss.getSheetByName('List1');
  if (vychozi && ss.getSheets().length > 1) ss.deleteSheet(vychozi);

  var akt = ss.getSheetByName(_dsNazevMesice(new Date().getMonth() + 1));
  if (akt) ss.setActiveSheet(akt);

  SpreadsheetApp.getUi().alert('Hotovo — postaveno ' + radky.filter(function (r) { return r.typ === 'emp'; }).length +
    ' zaměstnanců ve 12 měsíčních listech.');
}


/**
 * Vrátí uspořádaný seznam řádků: oddělení → tým → zaměstnanci.
 * Prvky: {typ:'dept'|'team'|'emp', label?, u?}
 */
function _dsSerazeni(lide, oddeleni, tymy) {
  var tymByDept = {};
  tymy.forEach(function (g) {
    (tymByDept[g.department_id] = tymByDept[g.department_id] || []).push(g);
  });
  Object.keys(tymByDept).forEach(function (k) {
    tymByDept[k].sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', 'cs'); });
  });
  var odd = oddeleni.slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', 'cs'); });

  function cs(a, b) { return _dsJmeno(a).localeCompare(_dsJmeno(b), 'cs'); }
  var radky = [];
  var pouzito = {};

  odd.forEach(function (d) {
    var vDept = lide.filter(function (u) { return u.department_id === d.department_id; });
    if (vDept.length === 0) return;
    radky.push({ typ: 'dept', label: d.name });

    var teamList = tymByDept[d.department_id] || [];
    teamList.forEach(function (g) {
      var vTeam = vDept.filter(function (u) { return u.group_id === g.group_id; }).sort(cs);
      if (vTeam.length === 0) return;
      radky.push({ typ: 'team', label: g.name });
      vTeam.forEach(function (u) { radky.push({ typ: 'emp', u: u }); pouzito[u.user_id] = 1; });
    });

    var bezTymu = vDept.filter(function (u) { return !pouzito[u.user_id]; }).sort(cs);
    if (bezTymu.length) {
      if (teamList.length) radky.push({ typ: 'team', label: 'Bez týmu' });
      bezTymu.forEach(function (u) { radky.push({ typ: 'emp', u: u }); pouzito[u.user_id] = 1; });
    }
  });

  var bezOdd = lide.filter(function (u) { return !pouzito[u.user_id]; }).sort(cs);
  if (bezOdd.length) {
    radky.push({ typ: 'dept', label: 'Bez oddělení' });
    bezOdd.forEach(function (u) { radky.push({ typ: 'emp', u: u }); });
  }
  return radky;
}


/**
 * List "Uživatelé" — snapshot z živé DB.
 */
function _dsListUzivatele(ss, lide, oddMap, tymMap) {
  var stary = ss.getSheetByName('Uživatelé');
  if (stary) ss.deleteSheet(stary);
  var sh = ss.insertSheet('Uživatelé', 0);

  sh.getRange(1, 1, 1, 6)
    .setValues([['Jméno', 'Oddělení', 'Tým', 'E-mail', 'Vedoucí', 'Aktivní']])
    .setFontWeight('bold').setBackground('#f1f5f9');

  var rows = lide.slice()
    .sort(function (a, b) { return _dsJmeno(a).localeCompare(_dsJmeno(b), 'cs'); })
    .map(function (u) {
      return [
        _dsJmeno(u),
        oddMap[u.department_id] || '',
        tymMap[u.group_id] || '',
        u.email || '',
        _dsJeVedouci(u) ? 'ano' : '',
        String(u.active) === 'true' ? 'ano' : ''
      ];
    });
  if (rows.length) sh.getRange(2, 1, rows.length, 6).setValues(rows);

  sh.setColumnWidth(1, 180);
  sh.setColumnWidth(2, 150);
  sh.setColumnWidth(3, 140);
  sh.setColumnWidth(4, 220);
  sh.setColumnWidth(5, 80);
  sh.setColumnWidth(6, 70);
  sh.setFrozenRows(1);
}


/**
 * Jeden měsíční list (2 sloupce na den, seskupení, dropdown, barvy).
 */
function _dsListMesic(ss, mesic, radky, statusyUnik, zkratkyPlus) {
  var nazev = _dsNazevMesice(mesic);
  var stary = ss.getSheetByName(nazev);
  if (stary) ss.deleteSheet(stary);
  var sheet = ss.insertSheet(nazev);

  var pocetDnu = new Date(ROK, mesic, 0).getDate();
  var den1 = DS_DEN1_COL;
  var poslDenCol = den1 + 2 * pocetDnu - 1;
  var souhrnCol = poslDenCol + 1;
  var uidCol = souhrnCol + 1;
  var prvniData = DS_PRVNI_DATA_RADEK;
  var pocetRadku = radky.length;
  var poslData = prvniData + pocetRadku - 1;

  // rozměry listu
  var maxC = sheet.getMaxColumns();
  if (maxC < uidCol) sheet.insertColumnsAfter(maxC, uidCol - maxC);
  else if (maxC > uidCol) sheet.deleteColumns(uidCol + 1, maxC - uidCol);
  var maxR = sheet.getMaxRows();
  if (maxR < poslData) sheet.insertRowsAfter(maxR, poslData - maxR);
  else if (maxR > poslData) sheet.deleteRows(poslData + 1, maxR - poslData);

  // ř. 1 titulek (bez slučování)
  sheet.getRange(1, 1, 1, souhrnCol)
    .setBackground('#004fac').setFontColor('#ffffff').setFontWeight('bold').setFontSize(13);
  sheet.getRange(1, 1).setValue(USEK_NAZEV + ' — ' + DS_MESICE[mesic - 1].toUpperCase() + ' ' + ROK);

  // ř. 2 hlavička — číslo dne (dop sloupec) + zkratka dne (odp sloupec)
  var hlav = new Array(souhrnCol);
  hlav[0] = 'Jméno';
  var vikend = {};
  for (var d = 1; d <= pocetDnu; d++) {
    var dop = den1 + 2 * (d - 1);
    var odp = dop + 1;
    var dow = new Date(ROK, mesic - 1, d).getDay();
    hlav[dop - 1] = d;
    hlav[odp - 1] = DS_DNY[dow];
    if (dow === 0 || dow === 6) { vikend[dop] = 1; vikend[odp] = 1; }
  }
  hlav[souhrnCol - 1] = 'Dovolená (dny)';
  sheet.getRange(2, 1, 1, souhrnCol).setValues([hlav])
    .setBackground('#f1f5f9').setFontWeight('bold').setFontSize(9).setHorizontalAlignment('center');
  sheet.getRange(2, 1).setHorizontalAlignment('left');
  Object.keys(vikend).forEach(function (c) { sheet.getRange(2, Number(c)).setBackground('#e9edf2'); });

  // denní mřížka — pozadí (bílá / víkend)
  var mrizka = sheet.getRange(prvniData, den1, pocetRadku, 2 * pocetDnu);
  var bg = [];
  for (var r = 0; r < pocetRadku; r++) {
    var rr = [];
    for (var c = den1; c <= poslDenCol; c++) rr.push(vikend[c] ? '#e9edf2' : '#ffffff');
    bg.push(rr);
  }
  mrizka.setBackgrounds(bg);
  mrizka.setNumberFormat('@').setHorizontalAlignment('center').setFontWeight('bold').setFontSize(10);

  // levý sloupec + skrytý user_id
  var colA = radky.map(function (it) { return [it.typ === 'emp' ? _dsJmeno(it.u) : it.label]; });
  var colU = radky.map(function (it) { return [it.typ === 'emp' ? (it.u.user_id || '') : '']; });
  sheet.getRange(prvniData, 1, pocetRadku, 1).setValues(colA);
  sheet.getRange(prvniData, uidCol, pocetRadku, 1).setValues(colU);
  sheet.hideColumns(uidCol);

  // styl skupinových hlaviček + tučná jména
  for (var i = 0; i < radky.length; i++) {
    var it = radky[i];
    var row = prvniData + i;
    if (it.typ === 'dept') {
      sheet.getRange(row, 1, 1, souhrnCol).setBackground('#dbeafe')
        .setFontColor('#1e3a8a').setFontWeight('bold');
    } else if (it.typ === 'team') {
      sheet.getRange(row, 1, 1, souhrnCol).setBackground('#eef2ff')
        .setFontColor('#4338ca').setFontWeight('bold').setFontStyle('italic');
    } else {
      sheet.getRange(row, 1).setFontWeight('bold');
    }
  }

  // dropdown statusů
  mrizka.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(zkratkyPlus, true).setAllowInvalid(false)
    .setHelpText('Vyber status (½ = půlden). Doporučeno zadávat přes menu 📋 Docházka.')
    .build());

  // podmíněné formátování — barva podle zkratky (+ světlejší ½ varianta)
  var pravidla = [];
  statusyUnik.forEach(function (s) {
    var z = String(s.abbreviation).trim();
    if (!z) return;
    var bgc = _dsHex(s.color, '#94a3b8');
    var fgc = _dsHex(s.text_color, '#ffffff');
    pravidla.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(z).setBackground(bgc).setFontColor(fgc).setBold(true)
      .setRanges([mrizka]).build());
    pravidla.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('½' + z).setBackground(_dsBlend(bgc, 0.45)).setFontColor(fgc)
      .setBold(true).setItalic(true).setRanges([mrizka]).build());
  });
  sheet.setConditionalFormatRules(pravidla);

  // souhrnný sloupec (jen řádky zaměstnanců)
  var dovZkr = statusyUnik.filter(function (s) { return String(s.is_vacation) === 'true'; })
    .map(function (s) { return String(s.abbreviation).trim(); });
  var od = _dsA1(den1);
  var doo = _dsA1(poslDenCol);
  var souhrn = radky.map(function (it, idx) {
    if (it.typ !== 'emp' || dovZkr.length === 0) return [''];
    var row = prvniData + idx;
    var rng = od + row + ':' + doo + row;
    var parts = dovZkr.map(function (z) {
      return 'COUNTIF(' + rng + ',"' + z + '")+COUNTIF(' + rng + ',"½' + z + '")*0.5';
    });
    return ['=' + parts.join('+')];
  });
  sheet.getRange(prvniData, souhrnCol, pocetRadku, 1).setValues(souhrn)
    .setHorizontalAlignment('center').setNumberFormat('0.0');

  // orámování, zmrazení, rozměry
  sheet.getRange(prvniData, 1, pocetRadku, souhrnCol)
    .setBorder(true, true, true, true, false, true, '#e2e8f0', SpreadsheetApp.BorderStyle.SOLID);
  sheet.setFrozenRows(DS_HLAVICKA_RADKU);
  sheet.setFrozenColumns(1);
  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidths(den1, 2 * pocetDnu, 22);
  sheet.setColumnWidth(souhrnCol, 90);
  sheet.setRowHeight(1, 26);

  // měkké zamčení mřížky (skript píše dál, ruční editaci jen varuje)
  sheet.getRange(prvniData, 1, pocetRadku, souhrnCol).protect()
    .setDescription('Docházková mřížka — edituj přes menu 📋 Docházka')
    .setWarningOnly(true);
}


// ── pomocné funkce ────────────────────────────────────────────────────────

function _dsCti(ss, listName) {
  var sh = ss.getSheetByName(listName);
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var head = data[0];
  return data.slice(1).map(function (row) {
    var o = {};
    head.forEach(function (h, i) {
      var v = row[i];
      o[h] = (v === null || v === undefined) ? '' : String(v).trim();
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

function _dsA1(col) {
  var s = '';
  while (col > 0) {
    var r = (col - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}

function _dsHex(val, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(val || '')) ? String(val) : fallback;
}

function _dsBlend(hex, t) {
  var r = parseInt(hex.substr(1, 2), 16);
  var g = parseInt(hex.substr(3, 2), 16);
  var b = parseInt(hex.substr(5, 2), 16);
  r = Math.round(r + (255 - r) * t);
  g = Math.round(g + (255 - g) * t);
  b = Math.round(b + (255 - b) * t);
  return '#' + [r, g, b].map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
}
