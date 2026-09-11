// ════════════════════════════════════════════════════════════════════
//  40_Builder.gs — Stavba měsíčního listu.
// ════════════════════════════════════════════════════════════════════


// ── měsíční list ─────────────────────────────────────────────────────────

// Bumpuj při JAKÉKOLI změně struktury listu (kvůli fast-path porovnání podpisu).
var DS_BUILD_VER = 8;

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

// ── dávkové operace přes Advanced Sheets API ────────────────────────────
// Rozměry a rámečky se v Apps Scriptu nastavují po jednom volání; u mřížky
// s mezerovými řádky/sloupci to dělá ~70 volání na měsíc a stovky rámečků
// při importu. Sheets API to zvládne jedním requestem. Když služba není
// zapnutá (Rozšíření → Apps Script → Služby → Google Sheets API), kód
// automaticky spadne zpět na původní volání — jen pomaleji.

var _DS_DAVKA_MAX = 500;   // requestů na jeden batchUpdate

function _dsMaSheetsApi() {
  return typeof Sheets !== 'undefined' && !!Sheets && !!Sheets.Spreadsheets;
}

function _dsPosliDavku(sheet, requests) {
  SpreadsheetApp.flush();                       // Sheets API čte uložený stav
  var id = sheet.getParent().getId();
  for (var i = 0; i < requests.length; i += _DS_DAVKA_MAX) {
    Sheets.Spreadsheets.batchUpdate({ requests: requests.slice(i, i + _DS_DAVKA_MAX) }, id);
  }
}

function _dsRgbApi(hex) {
  var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return { red: 0, green: 0, blue: 0 };
  return {
    red: parseInt(m[1], 16) / 255,
    green: parseInt(m[2], 16) / 255,
    blue: parseInt(m[3], 16) / 255
  };
}

/**
 * Rozměry řádků/sloupců dávkově.
 * polozky = [{ typ: 'ROWS'|'COLUMNS', od: 1-based, pocet, px }]
 * Pozdější položka přebíjí dřívější (stejné pořadí jako u jednotlivých volání).
 */
function _dsRozmeryDavkove(sheet, polozky) {
  if (!polozky.length) return;
  if (_dsMaSheetsApi()) {
    var sid = sheet.getSheetId();
    _dsPosliDavku(sheet, polozky.map(function (p) {
      return {
        updateDimensionProperties: {
          range: { sheetId: sid, dimension: p.typ, startIndex: p.od - 1, endIndex: p.od - 1 + p.pocet },
          properties: { pixelSize: p.px },
          fields: 'pixelSize'
        }
      };
    }));
    return;
  }
  polozky.forEach(function (p) {
    if (p.typ === 'ROWS') sheet.setRowHeights(p.od, p.pocet, p.px);
    else sheet.setColumnWidths(p.od, p.pocet, p.px);
  });
}

/**
 * Rámečky buněk dávkově.
 * polozky = [{ row, col, rows, cols, barva }] — barva null/'' znamená rámeček zrušit.
 */
function _dsRameckyDavkove(sheet, polozky) {
  if (!polozky.length) return;
  if (_dsMaSheetsApi()) {
    var sid = sheet.getSheetId();
    _dsPosliDavku(sheet, polozky.map(function (p) {
      var okraj = p.barva ? { style: 'SOLID_MEDIUM', color: _dsRgbApi(p.barva) } : { style: 'NONE' };
      return {
        updateBorders: {
          range: {
            sheetId: sid,
            startRowIndex: p.row - 1, endRowIndex: p.row - 1 + (p.rows || 1),
            startColumnIndex: p.col - 1, endColumnIndex: p.col - 1 + (p.cols || 1)
          },
          top: okraj, bottom: okraj, left: okraj, right: okraj
        }
      };
    }));
    return;
  }
  polozky.forEach(function (p) {
    var r = sheet.getRange(p.row, p.col, p.rows || 1, p.cols || 1);
    if (p.barva) r.setBorder(true, true, true, true, false, false, p.barva, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    else r.setBorder(false, false, false, false, false, false, null, null);
  });
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
  r3[souhrnCol - 1] = 'měsíc · k dnešku · rok';
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
  // Barva písma se nastavuje PŘÍMO, ne přes podmíněné formátování — to by
  // přebilo červené písmo u kancelářského dne bez rezervace stolu.
  var barvy = _dsBarvyStatusu(ss);
  var fcG = valsG.map(function (radek) {
    return radek.map(function (v) { return _dsFgStatusu(barvy, v); });
  });
  sheet.getRange(prvni, den1, dataR, dnyW).setValues(valsG)
    .setNumberFormat('@').setHorizontalAlignment('center').setVerticalAlignment('middle')
    .setFontWeight('bold').setFontSize(10).setFontColors(fcG);
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
  // Jen pozadí — barva písma zůstává na přímém formátování (viz výše).
  statusyUnik.forEach(function (s) {
    if (!s.abbr || !barvy[s.abbr]) return;
    pravidla.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(s.abbr).setBold(true).setRanges([mrizka])
      .setBackground(barvy[s.abbr].bg).build());
  });
  sheet.setConditionalFormatRules(pravidla);

  // ── ohraničení: vnější rámeček (hrany v mezerových řádcích) + rámy bloků; vnitřní dělení dělají 1px mezery ──
  // `null` u vnitřních hran znamená „nesahat" — `false` by je smazalo včetně
  // červených rámečků jednotlivých buněk.
  sheet.getRange(mezR, 1, dataR + 1, souhrnCol)
    .setBorder(true, true, true, true, null, null, '#cbd5e1', SpreadsheetApp.BorderStyle.SOLID);
  bloky.forEach(function (b) { _dsRamOddeleni(sheet, b[0], b[1], souhrnCol); });

  // ── indikace stolů: červené písmo i rámeček. Až PO rámech, ať je nic nepřekreslí.
  //    Na čerstvém listu není co mazat, takže se kreslí jen ty červené.
  var rezM = _dmRezMesic(ss, mesic);
  _dmObnovStulyList(sheet, mesic, deskAbbr, rezM, 'nove');

  // ── rozměry ──
  sheet.setFrozenRows(DS_HLAVICKA_RADKU);
  sheet.setFrozenColumns(1);
  sheet.getRange(prvni, souhrnCol, dataR, 1).setHorizontalAlignment('center').setVerticalAlignment('middle');

  // všechny šířky a výšky jedním requestem (pořadí = pozdější přebíjí dřívější)
  var rozmery = [
    { typ: 'COLUMNS', od: 1, pocet: 1, px: 170 },
    { typ: 'COLUMNS', od: den1 - 1, pocet: 1, px: DS_MEZ_PX },   // mezera mezi jménem a dny
    { typ: 'COLUMNS', od: den1, pocet: dnyW, px: 22 },
    { typ: 'COLUMNS', od: souhrnCol, pocet: 1, px: 130 },
    { typ: 'ROWS', od: 1, pocet: 1, px: 26 },
    { typ: 'ROWS', od: mezR, pocet: 1, px: DS_MEZ_PX },
    { typ: 'ROWS', od: prvni, pocet: dataR, px: 30 }
  ];
  for (var sm = 1; sm <= N; sm++) {                              // mezerové sloupce mezi dny
    rozmery.push({ typ: 'COLUMNS', od: _gDop(sm) + 2, pocet: 1, px: DS_MEZ_PX });
  }
  radky.forEach(function (it, j) {                               // mezerové řádky
    rozmery.push({ typ: 'ROWS', od: _gRadek(j) + 1, pocet: 1, px: DS_MEZ_PX });
  });
  gapRadky.forEach(function (fr) { rozmery.push({ typ: 'ROWS', od: fr, pocet: 1, px: 8 }); });
  _dsRozmeryDavkove(sheet, rozmery);

  sheet.getRange(prvni, 1, dataR, souhrnCol).protect()
    .setDescription('Docházková mřížka — edituj přes menu 📋 Docházka')
    .setWarningOnly(true);

  _dsFont(sheet);
  props.setProperty('PODPIS_' + mesic, podpis);
  props.setProperty('REZ_' + mesic, _dmRezHash(rezM));
}

/**
 * Rám oddělení. Horní i dolní hranu kreslí do 1px mezerových řádků těsně NAD a POD blokem,
 * takže se nikde nepotká s rámečkem buňky (např. červený rámeček „Kancelář bez stolu").
 */
function _dsRamOddeleni(sheet, r1, r2, lastCol) {
  if (r2 < r1) return;
  var top = Math.max(DS_PRVNI_DATA_RADEK - 1, r1 - 1);   // mezerový řádek nad blokem
  var bot = r2 + 1;                                        // mezerový řádek pod blokem
  // vnitřní hrany `null` = nesahat na ně (jinak by zmizely rámečky buněk)
  sheet.getRange(top, 1, bot - top + 1, lastCol)
    .setBorder(true, true, true, true, null, null, '#64748b', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
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
