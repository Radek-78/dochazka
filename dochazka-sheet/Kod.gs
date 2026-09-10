/**
 * ============================================================================
 *  DOCHÁZKOVÝ SHEET — BOUND SKRIPT  ·  ETAPA 2 (modal + zápis)
 * ============================================================================
 *  Patří DOVNITŘ vygenerovaného docházkového spreadsheetu (Rozšíření → Apps
 *  Script), NE do projektu živé aplikace.
 *
 *  NASTAVENÍ (3 konstanty níže):
 *    ZDROJ_CORE_ID  — ID CORE DB živé appky (Apps Script živé appky → Nastavení
 *                     projektu → Vlastnosti skriptu → "SPREADSHEET_CORE_ID").
 *    USEK_NAZEV     — přesný název úseku.
 *    ROK           — rok pro měsíční listy.
 *
 *  MENU 📋 Docházka:
 *    "Zadat můj měsíc"           → modal s měsíčním pohledem přihlášeného
 *    "Postavit / obnovit listy"  → (pře)postaví Uživatelé + 12 měsíčních listů
 *
 *  Model dne: dvojice sloupců (dopoledne | odpoledne).
 *    - Sloučená dvojice  = celý den (jedna hodnota).
 *    - Rozdělená dvojice = půlden (dopo hodnota + odpo hodnota, každá vlastní).
 *  Souhrn "Dovolená (dny)" udržuje skript (celý den = 1, půlden = 0,5).
 * ============================================================================
 */

var ZDROJ_CORE_ID = 'SEM_VLOZ_ID_CORE_DB';
var USEK_NAZEV = 'SEM_VLOZ_NAZEV_USEKU';
var ROK = new Date().getFullYear();

var DS_MESICE = ['Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
  'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];
var DS_DNY = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];

var DS_DEN1_COL = 2;             // den 1 dopoledne = sloupec 2 (B)
var DS_HLAVICKA_RADKU = 2;      // ř. 1 titulek, ř. 2 čísla dnů / dny v týdnu
var DS_PRVNI_DATA_RADEK = 3;


function onOpen() {
  SpreadsheetApp.getUi().createMenu('📋 Docházka')
    .addItem('Zadat můj měsíc', 'otevriModal')
    .addSeparator()
    .addItem('Postavit / obnovit listy', 'setup')
    .addToUi();
}

function otevriModal() {
  var html = HtmlService.createHtmlOutputFromFile('Modal')
    .setWidth(760).setHeight(660);
  SpreadsheetApp.getUi().showModalDialog(html, 'Moje docházka');
}


// ════════════════════════════════════════════════════════════════════════════
//  SETUP — kostra listů
// ════════════════════════════════════════════════════════════════════════════

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

  var radky = _dsSerazeni(lide, oddeleni, tymy);
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  _dsListUzivatele(ss, lide, oddMap, tymMap);
  for (var m = 1; m <= 12; m++) {
    _dsListMesic(ss, m, radky, statusyUnik, zkratky);
  }

  var vychozi = ss.getSheetByName('Sheet1') || ss.getSheetByName('List1');
  if (vychozi && ss.getSheets().length > 1) ss.deleteSheet(vychozi);

  var akt = ss.getSheetByName(_dsNazevMesice(new Date().getMonth() + 1));
  if (akt) ss.setActiveSheet(akt);

  SpreadsheetApp.getUi().alert('Hotovo — ' +
    radky.filter(function (r) { return r.typ === 'emp'; }).length + ' zaměstnanců ve 12 měsíčních listech.');
}


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


function _dsListUzivatele(ss, lide, oddMap, tymMap) {
  var stary = ss.getSheetByName('Uživatelé');
  if (stary) ss.deleteSheet(stary);
  var sh = ss.insertSheet('Uživatelé', 0);

  sh.getRange(1, 1, 1, 7)
    .setValues([['Jméno', 'Oddělení', 'Tým', 'E-mail', 'Vedoucí', 'Aktivní', 'user_id']])
    .setFontWeight('bold').setBackground('#f1f5f9');

  var rows = lide.slice()
    .sort(function (a, b) { return _dsJmeno(a).localeCompare(_dsJmeno(b), 'cs'); })
    .map(function (u) {
      return [
        _dsJmeno(u), oddMap[u.department_id] || '', tymMap[u.group_id] || '',
        u.email || '', _dsJeVedouci(u) ? 'ano' : '',
        String(u.active) === 'true' ? 'ano' : '', u.user_id || ''
      ];
    });
  if (rows.length) sh.getRange(2, 1, rows.length, 7).setValues(rows);

  sh.setColumnWidth(1, 180);
  sh.setColumnWidth(2, 150);
  sh.setColumnWidth(3, 140);
  sh.setColumnWidth(4, 220);
  sh.setColumnWidth(5, 80);
  sh.setColumnWidth(6, 70);
  sh.hideColumns(7);
  sh.setFrozenRows(1);
}


function _dsListMesic(ss, mesic, radky, statusyUnik, zkratky) {
  var nazev = _dsNazevMesice(mesic);
  var stary = ss.getSheetByName(nazev);
  if (stary) ss.deleteSheet(stary);
  var sheet = ss.insertSheet(nazev);

  var pocetDnu = _dmDniVMesici(mesic);
  var den1 = DS_DEN1_COL;
  var poslDenCol = den1 + 2 * pocetDnu - 1;
  var souhrnCol = poslDenCol + 1;
  var uidCol = souhrnCol + 1;
  var prvniData = DS_PRVNI_DATA_RADEK;
  var pocetRadku = radky.length;
  var poslData = prvniData + pocetRadku - 1;

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

  // ř. 2 hlavička
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

  // denní mřížka — pozadí
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

  // výchozí stav: dvojice dnů sloučené (celý den) — 1 mergeAcross na den
  for (var dd = 1; dd <= pocetDnu; dd++) {
    sheet.getRange(prvniData, den1 + 2 * (dd - 1), pocetRadku, 2).mergeAcross();
  }

  // styl skupinových hlaviček + tučná jména
  for (var i = 0; i < radky.length; i++) {
    var it = radky[i];
    var row = prvniData + i;
    if (it.typ === 'dept') {
      sheet.getRange(row, 1, 1, souhrnCol).setBackground('#dbeafe').setFontColor('#1e3a8a').setFontWeight('bold');
    } else if (it.typ === 'team') {
      sheet.getRange(row, 1, 1, souhrnCol).setBackground('#eef2ff').setFontColor('#4338ca').setFontWeight('bold').setFontStyle('italic');
    } else {
      sheet.getRange(row, 1).setFontWeight('bold');
    }
  }

  // dropdown (fallback pro ruční editaci)
  mrizka.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(zkratky, true).setAllowInvalid(false)
    .setHelpText('Doporučeno zadávat přes menu 📋 Docházka → Zadat můj měsíc.')
    .build());

  // podmíněné formátování — barva podle zkratky
  var pravidla = [];
  statusyUnik.forEach(function (s) {
    var z = String(s.abbreviation).trim();
    if (!z) return;
    pravidla.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(z).setBackground(_dsHex(s.color, '#94a3b8'))
      .setFontColor(_dsHex(s.text_color, '#ffffff')).setBold(true)
      .setRanges([mrizka]).build());
  });
  sheet.setConditionalFormatRules(pravidla);

  // orámování, zmrazení, rozměry
  sheet.getRange(prvniData, 1, pocetRadku, souhrnCol)
    .setBorder(true, true, true, true, false, true, '#e2e8f0', SpreadsheetApp.BorderStyle.SOLID);
  sheet.setFrozenRows(DS_HLAVICKA_RADKU);
  sheet.setFrozenColumns(1);
  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidths(den1, 2 * pocetDnu, 22);
  sheet.setColumnWidth(souhrnCol, 90);
  sheet.setRowHeight(1, 26);

  sheet.getRange(prvniData, 1, pocetRadku, souhrnCol).protect()
    .setDescription('Docházková mřížka — edituj přes menu 📋 Docházka')
    .setWarningOnly(true);
}


// ════════════════════════════════════════════════════════════════════════════
//  MODAL — serverové funkce
// ════════════════════════════════════════════════════════════════════════════

/** Data pro první vykreslení modalu. */
function dm_init() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var mesic = _dmMesicZListu(ss.getActiveSheet()) || (new Date().getMonth() + 1);

  var core = SpreadsheetApp.openById(ZDROJ_CORE_ID);
  var email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var me = _dsCti(core, 'USERS').filter(function (u) {
    return String(u.email).toLowerCase() === email;
  })[0];
  if (!me) throw new Error('Tvůj účet (' + (email || '?') + ') není v USERS živé appky.');

  var seen = {};
  var statusy = [];
  _dsCti(core, 'ATTENDANCE_STATUSES')
    .filter(function (s) { return String(s.active) !== 'false' && s.abbreviation; })
    .forEach(function (s) {
      var ab = String(s.abbreviation).trim();
      if (!ab || seen[ab]) return;
      seen[ab] = 1;
      statusy.push({
        abbr: ab, name: s.name || '',
        color: _dsHex(s.color, '#94a3b8'), fg: _dsHex(s.text_color, '#ffffff'),
        vac: String(s.is_vacation) === 'true'
      });
    });

  return {
    rok: ROK, mesic: mesic, userId: me.user_id, jmeno: _dsJmeno(me), usek: USEK_NAZEV,
    statusy: statusy,
    vacAbbr: statusy.filter(function (s) { return s.vac; }).map(function (s) { return s.abbr; })
  };
}

/** Stav měsíce pro přihlášeného. payload: {userId, mesic} */
function dm_mesic(payload) {
  var sheet = _dmListMesice(payload.mesic);
  var mr = _dmMojeRadka(sheet, payload.userId);
  var souhrnCol = DS_DEN1_COL + 2 * _dmDniVMesici(payload.mesic);
  return {
    mesic: payload.mesic, rok: ROK,
    dny: _dmDenData(sheet, mr.row, payload.mesic),
    souhrn: sheet.getRange(mr.row, souhrnCol).getValue()
  };
}

/** Zápis jednoho dne. payload: {userId, mesic, den, rezim:'FULL'|'HALF'|'CLEAR', dop, odp, vacAbbr} */
function dm_uloz(payload) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    var sheet = _dmListMesice(payload.mesic);
    var mr = _dmMojeRadka(sheet, payload.userId);
    var dopCol = DS_DEN1_COL + 2 * (payload.den - 1);
    var pair = sheet.getRange(mr.row, dopCol, 1, 2);

    if (pair.isPartOfMerge()) pair.breakApart();

    if (payload.rezim === 'CLEAR') {
      pair.clearContent();
      pair.merge();
    } else if (payload.rezim === 'HALF') {
      sheet.getRange(mr.row, dopCol).setValue(payload.dop || '');
      sheet.getRange(mr.row, dopCol + 1).setValue(payload.odp || '');
    } else { // FULL
      pair.merge();
      sheet.getRange(mr.row, dopCol).setValue(payload.dop || '');
    }

    var souhrn = _dmPrepocitejSouhrn(sheet, mr.row, payload.mesic, payload.vacAbbr || []);
    var den = _dmDenData(sheet, mr.row, payload.mesic).filter(function (x) { return x.den === payload.den; })[0];
    return { den: den, souhrn: souhrn };
  } finally {
    lock.releaseLock();
  }
}


// ── modal helpers ─────────────────────────────────────────────────────────

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
  var mesic = _dmMesicZListu(sheet);
  var uidCol = DS_DEN1_COL + 2 * _dmDniVMesici(mesic) + 1;
  var last = sheet.getLastRow();
  var n = last - DS_PRVNI_DATA_RADEK + 1;
  if (n < 1) throw new Error('Prázdný list.');
  var uids = sheet.getRange(DS_PRVNI_DATA_RADEK, uidCol, n, 1).getValues();
  for (var i = 0; i < uids.length; i++) {
    if (String(uids[i][0]) === String(userId)) return { row: DS_PRVNI_DATA_RADEK + i };
  }
  throw new Error('Nejsi v tomhle úseku (list ' + sheet.getName() + ').');
}

function _dmDenData(sheet, row, mesic) {
  var N = _dmDniVMesici(mesic);
  var den1 = DS_DEN1_COL;
  var rng = sheet.getRange(row, den1, 1, 2 * N);
  var vals = rng.getValues()[0];
  var mergedDop = {};
  rng.getMergedRanges().forEach(function (mr) { mergedDop[mr.getColumn()] = true; });

  var dny = [];
  for (var d = 1; d <= N; d++) {
    var dopCol = den1 + 2 * (d - 1);
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
  var rng = sheet.getRange(row, den1, 1, 2 * N);
  var vals = rng.getValues()[0];
  var mergedDop = {};
  rng.getMergedRanges().forEach(function (mr) { mergedDop[mr.getColumn()] = true; });
  var vac = {};
  (vacAbbr || []).forEach(function (a) { vac[a] = true; });

  var dny = 0;
  for (var d = 1; d <= N; d++) {
    var dopCol = den1 + 2 * (d - 1);
    var idx = dopCol - den1;
    if (mergedDop[dopCol]) {
      if (vac[String(vals[idx] || '')]) dny += 1;
    } else {
      if (vac[String(vals[idx] || '')]) dny += 0.5;
      if (vac[String(vals[idx + 1] || '')]) dny += 0.5;
    }
  }
  sheet.getRange(row, den1 + 2 * N).setValue(dny);
  return dny;
}


// ── společné pomocné funkce ──────────────────────────────────────────────

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

function _dsHex(val, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(val || '')) ? String(val) : fallback;
}
