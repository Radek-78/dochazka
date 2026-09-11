// ════════════════════════════════════════════════════════════════════
//  60_Import.gs — Import docházky a rezervací ze živé aplikace.
// ════════════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════════════════════
//  IMPORT DOCHÁZKY ZE ŽIVÉ APLIKACE
// ════════════════════════════════════════════════════════════════════════════

function nactiDochazku() {
  _dmVyzadujSpravce();
  if (ZDROJ_TRANSACTION_ID.indexOf('VLOZ') !== -1) {
    throw new Error('Nastav ZDROJ_TRANSACTION_ID nahoře ve skriptu (Vlastnosti skriptu živé appky → SPREADSHEET_TRANSACTION_ID).');
  }
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Načíst docházku z živé aplikace do všech měsíčních listů roku ' + ROK +
    '?\nHodnoty v listech se přepíšou hodnotami z aplikace.', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

  var trans = SpreadsheetApp.openById(ZDROJ_TRANSACTION_ID);

  // Překlad status_id → zkratka jde jen z aplikace (lokální list Statusy id nenese).
  // Co je dovolená a co vyžaduje stůl, se ale už bere z lokálního listu Statusy.
  var abbr = {};
  _dsZdroj('ATTENDANCE_STATUSES').forEach(function (s) {
    var a = String(s.abbreviation || '').trim();
    if (a) abbr[String(s.status_id).trim()] = a;
  });
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var vacAbbr = _dsCtiStatusy(ss).filter(function (s) { return s.vac; })
    .map(function (s) { return s.abbr; });
  var deskAbbr = _dsDeskAbbr(ss);
  var nahrady = _dsNahradyZListu(ss);   // do sdílené mřížky smí jen náhrady

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

  // Z ATTENDANCE čteme jen 5 potřebných sloupců — tabulka je celofiremní
  // a nese i note / created_at / work_start_time, které nepoužijeme.
  var zaznamy = _dsCtiSloupce(trans, 'ATTENDANCE',
    ['user_id', 'date', 'status_id', 'slot', 'approved']);
  if (!zaznamy.length) {
    ui.alert('Tabulka ATTENDANCE je prázdná nebo v TRANSACTION sešitu není.');
    return;
  }
  var prvni = zaznamy[0];
  if (prvni.date === undefined || prvni.user_id === undefined || prvni.status_id === undefined) {
    throw new Error('ATTENDANCE nemá očekávané sloupce (user_id, date, status_id). Zkontroluj ZDROJ_TRANSACTION_ID.');
  }

  var podleM = {};   // mesic -> [ {row, den, slot, ab} ]
  var citliveDny = {};
  zaznamy.forEach(function (a) {
    if (String(a.approved).toLowerCase() === 'rejected') return;
    var datum = String(a.date || '').substring(0, 10);
    if (datum.substring(0, 4) !== String(ROK)) return;
    var uid = String(a.user_id || '').trim();
    var mm = parseInt(datum.substring(5, 7), 10);
    var row = radkaVMesici[uid] && radkaVMesici[uid][mm];
    if (!row) return;
    var ab = abbr[String(a.status_id).trim()];
    if (!ab) return;
    var den = parseInt(datum.substring(8, 10), 10);
    var slot = String(a.slot || 'ALL_DAY').toUpperCase();
    (podleM[mm] = podleM[mm] || []).push({
      row: row, den: den, slot: slot, ab: _dsMaska(nahrady, ab)
    });
    if (nahrady[ab]) {                       // skutečná zkratka mimo mřížku
      var k = uid + '|' + mm + '|' + den;
      var e = citliveDny[k] || (citliveDny[k] = { uid: uid, mesic: mm, den: den, dop: '', odp: '' });
      if (slot === 'PM') e.odp = ab; else e.dop = ab;
    }
  });

  var klice = Object.keys(citliveDny);
  klice.forEach(function (k) {
    var e = citliveDny[k];
    _dmZapisCitlive(ss, e.uid, e.mesic, e.den, e.dop, e.odp, nahrady);
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

  var dov = _dsPrepocitejDovolenou(ss);

  ui.alert('Načteno ' + pocet + ' dní docházky.\n\n' +
    (klice.length ? 'Citlivých dnů skrytých za náhradu: ' + klice.length + '\n' : '') +
    'Dovolená přepočítána pro ' + dov.lidi + ' lidí.\n' +
    'Statusy vyžadující stůl: ' + (deskAbbr.join(', ') || '— žádný (v listu ' + L_STATUSY + ' nemá nikdo „Vyžaduje stůl")') + '\n' +
    'Kancelářských dnů bez rezervace (červený rámeček): ' + zvyrazneno + '\n\n' +
    'Rezervace stolů načteš zvlášť: 🪑 Načíst rezervace stolů z aplikace.');
}

/** Načte jen rezervace stolů z živé aplikace (bez docházky). */
function nactiRezervace() {
  _dmVyzadujSpravce();
  if (ZDROJ_TRANSACTION_ID.indexOf('VLOZ') !== -1) {
    throw new Error('Nastav ZDROJ_TRANSACTION_ID nahoře ve skriptu (Vlastnosti skriptu živé appky → SPREADSHEET_TRANSACTION_ID).');
  }
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Načíst rezervace stolů z živé aplikace pro rok ' + ROK +
    '?\nList Rezervace se přepíše hodnotami z aplikace.', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

  var core = SpreadsheetApp.openById(ZDROJ_CORE_ID);
  var trans = SpreadsheetApp.openById(ZDROJ_TRANSACTION_ID);
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var deskAbbr = _dsDeskAbbr(ss);

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
    ui.alert('List "' + L_STOLY + '" je prázdný nebo chybí.\n\nNejdřív spusť 🧳 Z aplikace → Naplnit listy z aplikace. Bez stolů se rezervace nedají spárovat.');
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
    (d.letos > 0 && d.count === 0 ? '\n⚠ Rezervace existují, ale cell_id nesedí s listem Stoly — spusť 🧳 Z aplikace → Přegenerovat list Stoly.' : ''));
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
  _dsCtiUzivatele(ss).forEach(function (u) { jmenoByUid[u.user_id] = u.jmeno; });

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
