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
 *    "Zadat můj měsíc"              → modal s měsíčním pohledem přihlášeného
 *    "Postavit / obnovit listy"     → přegeneruje 12 měsíčních listů
 *    "Postavit jen aktuální měsíc"  → přegeneruje jen list otevřeného měsíce
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
var DS_MESICE = ['Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
  'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];
var DS_DNY = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];

var DS_DEN1_COL = 2;             // den 1 dopoledne = sloupec 2 (B)
var DS_HLAVICKA_RADKU = 3;      // ř. 1 titulek, ř. 2 čísla dnů, ř. 3 dny v týdnu
var DS_PRVNI_DATA_RADEK = 4;
var DS_UZIV_HLAVICKA = ['Jméno', 'Oddělení', 'Tým', 'Pozice', 'E-mail', 'Vedoucí', 'Od', 'Do', 'user_id'];


function onOpen() {
  SpreadsheetApp.getUi().createMenu('📋 Docházka')
    .addItem('📝 Zadat můj měsíc', 'otevriModal')
    .addSeparator()
    .addItem('🔄 Postavit / obnovit listy', 'setup')
    .addItem('📥 Načíst docházku z aplikace', 'nactiDochazku')
    .addToUi();
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

  for (var m = 1; m <= 12; m++) _dsListMesic(ss, m, z.radky, z.statusyUnik, z.vacAbbr);

  var vychozi = ss.getSheetByName('Sheet1') || ss.getSheetByName('List1');
  if (vychozi && ss.getSheets().length > 1) ss.deleteSheet(vychozi);

  var akt = ss.getSheetByName(_dsNazevMesice(new Date().getMonth() + 1));
  if (akt) ss.setActiveSheet(akt);

  SpreadsheetApp.getUi().alert('Hotovo — 12 měsíčních listů přegenerováno z listu Uživatelé.');
}

function setupMesic() {
  var z = _dsNactiZdroj();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var m = _dmMesicZListu(ss.getActiveSheet()) || (new Date().getMonth() + 1);
  _dsListMesic(ss, m, z.radky, z.statusyUnik, z.vacAbbr);
  ss.setActiveSheet(ss.getSheetByName(_dsNazevMesice(m)));
  SpreadsheetApp.getUi().alert('Postaven list ' + _dsNazevMesice(m) + '.');
}


/**
 * Zajistí listy Uživatelé a Pořadí (vytvoří / doplní nováčky) a připraví
 * uspořádané řádky. Zdrojem pravdy o lidech je list Uživatelé.
 */
function _dsNactiZdroj() {
  if (ZDROJ_CORE_ID.indexOf('VLOZ') !== -1) throw new Error('Nastav ZDROJ_CORE_ID nahoře ve skriptu.');
  if (USEK_NAZEV.indexOf('VLOZ') !== -1) throw new Error('Nastav USEK_NAZEV nahoře ve skriptu.');

  var core = SpreadsheetApp.openById(ZDROJ_CORE_ID);

  var usek = _dsCti(core, 'SECTIONS').filter(function (s) {
    return s.name === USEK_NAZEV && String(s.active) !== 'false';
  })[0];
  if (!usek) throw new Error('Úsek "' + USEK_NAZEV + '" nenalezen v SECTIONS.');

  var oddMap = {};
  _dsCti(core, 'DEPARTMENTS').forEach(function (d) { oddMap[d.department_id] = d.name || ''; });
  var tymMap = {};
  _dsCti(core, 'GROUPS').forEach(function (g) { tymMap[g.group_id] = g.name || ''; });
  var pozMap = {};
  _dsCti(core, 'POSITIONS').forEach(function (p) { pozMap[p.position_id] = p.name || ''; });

  var dnes = new Date();
  dnes.setHours(0, 0, 0, 0);
  var liveLide = _dsCti(core, 'USERS')
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
  _dsCti(core, 'ATTENDANCE_STATUSES')
    .filter(function (s) { return String(s.active) !== 'false' && s.abbreviation; })
    .forEach(function (s) {
      var z = String(s.abbreviation).trim();
      if (!z || videno[z]) return;
      videno[z] = true;
      statusyUnik.push(s);
      if (String(s.is_vacation) === 'true') vacAbbr.push(z);
    });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  _dsListUzivatele(ss, liveLide);          // vytvoří nebo doplní nováčky
  var lide = _dsCtiUzivatele(ss);          // ZDROJ pravdy
  if (lide.length === 0) throw new Error('List Uživatelé je prázdný.');
  _dsListPoradi(ss, lide);                 // vytvoří jen pokud chybí
  var poradi = _dsCtiPoradi(ss);

  return { radky: _dsSerazeni(lide, poradi), statusyUnik: statusyUnik, vacAbbr: vacAbbr };
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

/** Přečte list Uživatelé jako zdroj pravdy (podle názvů sloupců). */
function _dsCtiUzivatele(ss) {
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

function _dsListMesic(ss, mesic, radkyFull, statusyUnik, vacAbbr) {
  var radky = _dsRadkyProMesic(radkyFull, mesic);

  var nazev = _dsNazevMesice(mesic);
  var stary = ss.getSheetByName(nazev);
  var zachovano = stary ? _dsPrectiDochazku(stary, mesic) : {};   // zachovat existující docházku
  if (stary) ss.deleteSheet(stary);
  var sheet = ss.insertSheet(nazev);

  var pocetDnu = _dmDniVMesici(mesic);
  var den1 = DS_DEN1_COL;
  var poslDenCol = den1 + 2 * pocetDnu - 1;
  var souhrnCol = poslDenCol + 1;
  var uidCol = souhrnCol + 1;
  var prvniData = DS_PRVNI_DATA_RADEK;
  var pocetRadku = Math.max(radky.length, 1);
  var poslData = prvniData + pocetRadku - 1;

  var maxC = sheet.getMaxColumns();
  if (maxC < uidCol) sheet.insertColumnsAfter(maxC, uidCol - maxC);
  else if (maxC > uidCol) sheet.deleteColumns(uidCol + 1, maxC - uidCol);
  var maxR = sheet.getMaxRows();
  if (maxR < poslData) sheet.insertRowsAfter(maxR, poslData - maxR);
  else if (maxR > poslData) sheet.deleteRows(poslData + 1, maxR - poslData);

  // ── ř. 1: sloučený titulek na střed + účet vpravo ──
  sheet.getRange(1, 1, 1, souhrnCol).setBackground('#004fac').setFontColor('#ffffff').setFontWeight('bold');
  var titEnd = Math.max(2, souhrnCol - 6);
  sheet.getRange(1, 2, 1, titEnd - 1).merge()
    .setValue(USEK_NAZEV + ' — ' + DS_MESICE[mesic - 1].toUpperCase() + ' ' + ROK)
    .setFontSize(13).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.getRange(1, titEnd + 1, 1, souhrnCol - titEnd).merge()
    .setValue(String(Session.getActiveUser().getEmail() || ''))
    .setFontSize(9).setFontColor('#cfe3ff').setFontWeight('normal')
    .setHorizontalAlignment('right').setVerticalAlignment('middle');

  // ── ř. 2-3: čísla dnů / dny v týdnu; klasifikace svátek/víkend ──
  var svatky = _dsSvatkyCR(ROK);
  var r2 = [], r3 = [];
  for (var i = 0; i < souhrnCol; i++) { r2.push(''); r3.push(''); }
  r2[0] = 'Jméno';
  var klas = {};          // dopCol -> 'svatek' | 'vikend'
  var svatekNazev = {};
  for (var d = 1; d <= pocetDnu; d++) {
    var dop = den1 + 2 * (d - 1);
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
  for (var d2 = 1; d2 <= pocetDnu; d2++) {
    sheet.getRange(2, den1 + 2 * (d2 - 1), 2, 2).mergeAcross();
  }

  var BG_HLAV = { svatek: '#fca5a5', vikend: '#e9edf2' };   // svátky ČERVENĚ
  var BG_MRIZ = { svatek: '#fee2e2', vikend: '#e9edf2' };
  Object.keys(klas).forEach(function (dc) {
    sheet.getRange(2, Number(dc), 2, 2).setBackground(BG_HLAV[klas[dc]]);
    if (svatekNazev[dc]) sheet.getRange(3, Number(dc)).setNote(svatekNazev[dc]);
  });

  var mrizka = sheet.getRange(prvniData, den1, pocetRadku, 2 * pocetDnu);
  var bg = [];
  for (var r = 0; r < pocetRadku; r++) {
    var rr = [];
    for (var c = den1; c <= poslDenCol; c++) {
      var dc2 = ((c - den1) % 2 === 0) ? c : c - 1;
      rr.push(klas[dc2] ? BG_MRIZ[klas[dc2]] : '#ffffff');
    }
    bg.push(rr);
  }
  mrizka.setBackgrounds(bg);
  mrizka.setNumberFormat('@').setHorizontalAlignment('center').setVerticalAlignment('middle')
    .setFontWeight('bold').setFontSize(10);

  // ── levý sloupec (jen nadpisy) + skrytý user_id ──
  var colA = radky.map(function (it) { return [it.typ === 'emp' ? '' : (it.label || '')]; });
  var colU = radky.map(function (it) { return [it.typ === 'emp' ? (it.u.user_id || '') : '']; });
  if (radky.length) {
    sheet.getRange(prvniData, 1, radky.length, 1).setValues(colA);
    sheet.getRange(prvniData, uidCol, radky.length, 1).setValues(colU);
  }
  sheet.hideColumns(uidCol);
  sheet.getRange(prvniData, 1, pocetRadku, 1)
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP).setVerticalAlignment('middle');
  sheet.setRowHeights(prvniData, pocetRadku, 30);

  for (var dd = 1; dd <= pocetDnu; dd++) {
    sheet.getRange(prvniData, den1 + 2 * (dd - 1), pocetRadku, 2).mergeAcross();
  }

  // ── styl nadpisů, zaměstnanců (jméno + řádek s pozicí / koncem), gapů ──
  var tz = Session.getScriptTimeZone();
  var ST_JMENO = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(10).setForegroundColor('#1e293b').build();
  var ST_POZICE = SpreadsheetApp.newTextStyle().setBold(false).setFontSize(8).setForegroundColor('#64748b').build();
  var ST_KONEC = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(8).setForegroundColor('#dc2626').build();
  function jePosledni(u) {
    return u.do && u.do.getFullYear() === ROK && (u.do.getMonth() + 1) === mesic;
  }

  var bloky = [];
  var blokStart = -1;
  for (var j = 0; j < radky.length; j++) {
    var it = radky[j];
    var row = prvniData + j;
    if (it.typ === 'dept') {
      if (blokStart !== -1) bloky.push([prvniData + blokStart, row - 1]);
      blokStart = j;
      sheet.getRange(row, 1, 1, souhrnCol).setBackground('#dbeafe').setFontColor('#1e3a8a').setFontWeight('bold');
    } else if (it.typ === 'team') {
      sheet.getRange(row, 1, 1, souhrnCol).setBackground('#eef2ff').setFontColor('#4338ca').setFontWeight('bold').setFontStyle('italic');
    } else if (it.typ === 'gap') {
      if (blokStart !== -1) bloky.push([prvniData + blokStart, row - 1]);
      blokStart = -1;
      sheet.setRowHeight(row, 8);
      sheet.getRange(row, 1, 1, souhrnCol).setBackground('#ffffff');
    } else {
      var text = it.u.jmeno;
      var styly = [[0, text.length, ST_JMENO]];
      var seg = [];
      if (it.u.pozice) seg.push({ t: it.u.pozice, st: ST_POZICE });
      if (jePosledni(it.u)) seg.push({ t: 'do ' + Utilities.formatDate(it.u.do, tz, 'd.M.yyyy'), st: ST_KONEC });
      if (seg.length) {
        text += '\n';
        seg.forEach(function (sg, i) {
          if (i > 0) { var s0 = text.length; text += '  ·  '; styly.push([s0, text.length, ST_POZICE]); }
          var b0 = text.length;
          text += sg.t;
          styly.push([b0, text.length, sg.st]);
        });
      }
      var rtb = SpreadsheetApp.newRichTextValue().setText(text);
      styly.forEach(function (s) { rtb.setTextStyle(s[0], s[1], s[2]); });
      sheet.getRange(row, 1).setRichTextValue(rtb.build());
      if (it.u.vedouci) sheet.getRange(row, 1).setBackground('#ffedd5');
    }
  }
  if (blokStart !== -1) bloky.push([prvniData + blokStart, prvniData + radky.length - 1]);

  // ── podmíněné formátování: barvy statusů + dynamický "dnešní" sloupec ──
  var pravidla = [];
  statusyUnik.forEach(function (s) {
    var zk = String(s.abbreviation).trim();
    if (!zk) return;
    pravidla.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(zk).setBackground(_dsHex(s.color, '#94a3b8'))
      .setFontColor(_dsHex(s.text_color, '#ffffff')).setBold(true)
      .setRanges([mrizka]).build());
  });
  var dnesVzorec = '=AND(YEAR(TODAY())=' + ROK + ',MONTH(TODAY())=' + mesic +
    ',OR(COLUMN()=' + den1 + '+2*(DAY(TODAY())-1),COLUMN()=' + den1 + '+2*(DAY(TODAY())-1)+1))';
  // hlavička dnů — silné zvýraznění (je zmrazená, takže vždy vidět)
  pravidla.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(dnesVzorec).setBackground('#facc15').setBold(true)
    .setRanges([sheet.getRange(2, den1, 2, 2 * pocetDnu)]).build());
  // mřížka — jemné zvýraznění (na obsazených buňkách vítězí barva statusu)
  pravidla.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(dnesVzorec).setBackground('#fef9c3')
    .setRanges([mrizka]).build());
  sheet.setConditionalFormatRules(pravidla);

  // ── rámy, zmrazení, rozměry ──
  sheet.getRange(prvniData, 1, pocetRadku, souhrnCol)
    .setBorder(true, true, true, true, false, true, '#e2e8f0', SpreadsheetApp.BorderStyle.SOLID);
  bloky.forEach(function (b) { _dsRamOddeleni(sheet, b[0], b[1], souhrnCol); });
  sheet.setFrozenRows(DS_HLAVICKA_RADKU);
  sheet.setFrozenColumns(1);
  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidths(den1, 2 * pocetDnu, 22);
  sheet.setColumnWidth(souhrnCol, 90);
  sheet.getRange(prvniData, souhrnCol, pocetRadku, 1)
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.setRowHeight(1, 26);

  sheet.getRange(prvniData, 1, pocetRadku, souhrnCol).protect()
    .setDescription('Docházková mřížka — edituj přes menu 📋 Docházka')
    .setWarningOnly(true);

  // ── vrátit zachovanou docházku ──
  _dsVratDochazku(sheet, mesic, radky, zachovano, vacAbbr || []);

  _dsFont(sheet);
}

function _dsRamOddeleni(sheet, r1, r2, lastCol) {
  if (r2 < r1) return;
  sheet.getRange(r1, 1, r2 - r1 + 1, lastCol)
    .setBorder(true, true, true, true, false, false, '#64748b', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
}

/** Přečte docházku z (starého) měsíčního listu: { user_id: { den: {full,dop,odp} } }. */
function _dsPrectiDochazku(sheet, mesic) {
  var N = _dmDniVMesici(mesic);
  var den1 = DS_DEN1_COL;
  var uidCol = den1 + 2 * N + 1;
  var last = sheet.getLastRow();
  if (last < DS_PRVNI_DATA_RADEK) return {};
  var nRows = last - DS_PRVNI_DATA_RADEK + 1;
  var uids = sheet.getRange(DS_PRVNI_DATA_RADEK, uidCol, nRows, 1).getValues();
  var rng = sheet.getRange(DS_PRVNI_DATA_RADEK, den1, nRows, 2 * N);
  var grid = rng.getValues();
  var merged = {};
  rng.getMergedRanges().forEach(function (mr) { merged[mr.getRow() + '_' + mr.getColumn()] = true; });

  var out = {};
  for (var i = 0; i < nRows; i++) {
    var uid = String(uids[i][0] || '').trim();
    if (!uid) continue;
    var absRow = DS_PRVNI_DATA_RADEK + i;
    var dny = {};
    for (var d = 1; d <= N; d++) {
      var dopCol = den1 + 2 * (d - 1);
      var idx = dopCol - den1;
      var full = !!merged[absRow + '_' + dopCol];
      var vDop = String(grid[i][idx] || '').trim();
      var vOdp = full ? '' : String(grid[i][idx + 1] || '').trim();
      if (vDop || vOdp) dny[d] = { full: full, dop: vDop, odp: vOdp };
    }
    if (Object.keys(dny).length) out[uid] = dny;
  }
  return out;
}

/** Zapíše zachovanou docházku do čerstvě postaveného listu (dvojice jsou sloučené). */
function _dsVratDochazku(sheet, mesic, radky, zachovano, vacAbbr) {
  var den1 = DS_DEN1_COL;
  var dotcene = {};
  for (var j = 0; j < radky.length; j++) {
    var it = radky[j];
    if (it.typ !== 'emp') continue;
    var dny = zachovano[String(it.u.user_id || '').trim()];
    if (!dny) continue;
    var absRow = DS_PRVNI_DATA_RADEK + j;
    Object.keys(dny).forEach(function (dStr) {
      var e = dny[dStr];
      var dopCol = den1 + 2 * (Number(dStr) - 1);
      if (e.full) {
        sheet.getRange(absRow, dopCol).setValue(e.dop);
      } else {
        sheet.getRange(absRow, dopCol, 1, 2).breakApart();
        sheet.getRange(absRow, dopCol).setValue(e.dop);
        sheet.getRange(absRow, dopCol + 1).setValue(e.odp);
      }
      dotcene[absRow] = 1;
    });
  }
  Object.keys(dotcene).forEach(function (rw) {
    _dmPrepocitejSouhrn(sheet, Number(rw), mesic, vacAbbr);
  });
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

  var core = SpreadsheetApp.openById(ZDROJ_CORE_ID);
  var trans = SpreadsheetApp.openById(ZDROJ_TRANSACTION_ID);

  var abbr = {};
  var vacAbbr = [];
  _dsCti(core, 'ATTENDANCE_STATUSES').forEach(function (s) {
    var a = String(s.abbreviation || '').trim();
    if (!a) return;
    abbr[String(s.status_id).trim()] = a;
    if (String(s.is_vacation) === 'true' && vacAbbr.indexOf(a) === -1) vacAbbr.push(a);
  });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var radkaVMesici = {};   // user_id -> { mesic -> row }
  for (var m = 1; m <= 12; m++) {
    var sh = ss.getSheetByName(_dsNazevMesice(m));
    if (!sh) continue;
    var uidCol = DS_DEN1_COL + 2 * _dmDniVMesici(m) + 1;
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
  ui.alert('Načteno ' + pocet + ' dní docházky.');
}

function _dmImportMesic(sheet, mesic, zapisy, vacAbbr) {
  if (!sheet) return 0;
  var den1 = DS_DEN1_COL;

  var poDni = {};   // "row_den" -> { row, den, all, am, pm }
  zapisy.forEach(function (z) {
    var key = z.row + '_' + z.den;
    var e = poDni[key] || (poDni[key] = { row: z.row, den: z.den, all: '', am: '', pm: '' });
    if (z.slot === 'AM') e.am = z.ab;
    else if (z.slot === 'PM') e.pm = z.ab;
    else e.all = z.ab;
  });

  var dotcene = {};
  var n = 0;
  Object.keys(poDni).forEach(function (k) {
    var e = poDni[k];
    var dopCol = den1 + 2 * (e.den - 1);
    var pair = sheet.getRange(e.row, dopCol, 1, 2);
    if (e.all) {
      if (!pair.isPartOfMerge()) pair.merge();
      sheet.getRange(e.row, dopCol).setValue(e.all);
    } else {
      if (pair.isPartOfMerge()) pair.breakApart();
      sheet.getRange(e.row, dopCol).setValue(e.am);
      sheet.getRange(e.row, dopCol + 1).setValue(e.pm);
    }
    dotcene[e.row] = 1;
    n++;
  });

  Object.keys(dotcene).forEach(function (row) {
    _dmPrepocitejSouhrn(sheet, Number(row), mesic, vacAbbr);
  });
  return n;
}


// ════════════════════════════════════════════════════════════════════════════
//  MODAL — serverové funkce
// ════════════════════════════════════════════════════════════════════════════

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
    // udržet pohled listu u řádku uživatele (jinak po zápisu skáče nahoru)
    try { sheet.getRange(mr.row, dopCol).activate(); } catch (e) {}
    return { den: den, souhrn: souhrn };
  } finally {
    lock.releaseLock();
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
  var uidCol = DS_DEN1_COL + 2 * _dmDniVMesici(_dmMesicZListu(sheet)) + 1;
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
