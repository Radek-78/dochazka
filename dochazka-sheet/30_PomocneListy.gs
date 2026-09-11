// ════════════════════════════════════════════════════════════════════
//  30_PomocneListy.gs — Listy Uživatelé, Pořadí, Stoly, Mapa, Rezervace a uspořádání řádků.
// ════════════════════════════════════════════════════════════════════


/**
 * Zajistí pomocné listy a připraví uspořádané řádky. Čte JEN z tohoto sešitu:
 * lidi z listu Uživatelé, statusy z listu Statusy, stoly z listu Stoly.
 */
function _dsNactiZdroj() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  _dsSeedStoly(ss);                        // vytvoří list Stoly jen pokud chybí
  _dsListStatusy(ss);                      // vytvoří list Statusy jen pokud chybí
  _dsListRezervace(ss);                    // vytvoří list Rezervace jen pokud chybí

  var lide = _dsCtiUzivatele(ss);          // ZDROJ pravdy o lidech
  if (lide.length === 0) {
    throw new Error('List ' + L_UZIV + ' je prázdný.\n\nDoplň lidi ručně, nebo je jednorázově natáhni: ' +
      '📋 Docházka → 🧳 Z aplikace → Naplnit listy z aplikace.');
  }
  _dsListPoradi(ss, lide);                 // vytvoří jen pokud chybí
  var poradi = _dsCtiPoradi(ss);
  _dsDoplnTrvaleUid(ss);                   // dohledá user_id k ručně zapsaným jménům
  _dsListMapa(ss);                         // náhledová mapa stolů (vždy přegeneruje)

  var statusy = _dsCtiStatusy(ss);
  if (statusy.length === 0) {
    throw new Error('List ' + L_STATUSY + ' je prázdný.\n\nDoplň statusy ručně, nebo je jednorázově natáhni: ' +
      '📋 Docházka → 🧳 Z aplikace → Naplnit listy z aplikace.');
  }
  return {
    radky: _dsSerazeni(lide, poradi), statusyUnik: statusy,
    vacAbbr: statusy.filter(function (s) { return s.vac; }).map(function (s) { return s.abbr; }),
    deskAbbr: statusy.filter(function (s) { return s.desk; }).map(function (s) { return s.abbr; })
  };
}

// ── list Statusy ─────────────────────────────────────────────────────────

/**
 * Zajistí list Statusy. S `radky` (z migrace) ho přepíše, bez nich ho jen
 * vytvoří prázdný s hlavičkou. Vrací list.
 */
function _dsListStatusy(ss, radky) {
  var W = DS_STATUSY_HLAVICKA.length;
  var sh = ss.getSheetByName(L_STATUSY);
  if (!sh) {
    sh = ss.insertSheet(L_STATUSY, Math.min(3, ss.getSheets().length));
    sh.getRange(1, 1, 1, W).setValues([DS_STATUSY_HLAVICKA])
      .setFontWeight('bold').setBackground('#f1f5f9');
    [80, 220, 90, 100, 80, 110, 70].forEach(function (px, i) { sh.setColumnWidth(i + 1, px); });
    sh.setFrozenRows(1);
    _dsFont(sh);
  }
  if (radky && radky.length) {
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, W).clearContent();
    sh.getRange(2, 1, radky.length, W).setValues(radky);
    // sloupec Barva ukazuje sám sebe, ať je vidět, co se v mřížce použije
    sh.getRange(2, 3, radky.length, 1).setBackgrounds(radky.map(function (r) { return [r[2]]; }));
    _dsFont(sh);
    _dsCacheZrus('STATUSY');
  }
  return sh;
}

/** Statusy z listu Statusy (jen aktivní, bez duplicitních zkratek; cache na jeden běh). */
function _dsCtiStatusy(ss) {
  return _dsCache('STATUSY', function () {
    var t = _dsTabulka(ss.getSheetByName(L_STATUSY));
    var out = [], videno = {};
    function ano(r, nazev) { return /^ano$/i.test(String(t.v(r, nazev) || '').trim()); }
    t.radky.forEach(function (x) {
      var ab = String(t.v(x.r, 'Zkratka') || '').trim();
      if (!ab || videno[ab] || !ano(x.r, 'Aktivní')) return;
      videno[ab] = 1;
      out.push({
        abbr: ab,
        name: String(t.v(x.r, 'Název') || '').trim(),
        color: _dsHex(t.v(x.r, 'Barva'), '#94a3b8'),
        fg: _dsHex(t.v(x.r, 'Barva textu'), '#ffffff'),
        vac: ano(x.r, 'Dovolená'),
        desk: ano(x.r, 'Vyžaduje stůl')
      });
    });
    return out;
  });
}

/** Zkratky statusů, které vyžadují rezervaci stolu. */
function _dsDeskAbbr(ss) {
  return _dsCtiStatusy(ss)
    .filter(function (s) { return s.desk; })
    .map(function (s) { return s.abbr; });
}

// ── list Uživatelé ───────────────────────────────────────────────────────

/** Vytvoří list Uživatelé (z live DB) nebo jen doplní nové lidi (dle user_id). */
function _dsListUzivatele(ss, liveLide) {
  var sh = ss.getSheetByName(L_UZIV);

  function radekZLive(u) {
    return [
      _dsJmeno(u), u._oddNazev || '', u._tymNazev || '', u._pozice || '', u.email || '',
      _dsJeVedouci(u) ? 'ano' : '', _dsFmtDatum(u.date_start), _dsFmtDatum(u.date_end), u.user_id || ''
    ];
  }
  function cs(a, b) { return _dsJmeno(a).localeCompare(_dsJmeno(b), 'cs'); }

  if (!sh) {
    sh = ss.insertSheet(L_UZIV, 0);
    sh.getRange(1, 1, 1, DS_UZIV_HLAVICKA.length).setValues([DS_UZIV_HLAVICKA])
      .setFontWeight('bold').setBackground('#f1f5f9');
    var rows = liveLide.slice().sort(cs).map(radekZLive);
    if (rows.length) sh.getRange(2, 1, rows.length, DS_UZIV_HLAVICKA.length).setValues(rows);
  } else {
    _dsUpgradeUzivHlavicku(sh, liveLide);
    var t = _dsTabulka(sh);
    var jsou = {};
    t.radky.forEach(function (x) {
      var uid = String(t.v(x.r, 'user_id') || '').trim();
      if (uid) jsou[uid] = 1;
    });
    var noveRadky = liveLide
      .filter(function (u) { return !jsou[String(u.user_id)]; })
      .sort(cs).map(radekZLive);
    if (noveRadky.length) {
      sh.getRange(t.data.length + 1, 1, noveRadky.length, DS_UZIV_HLAVICKA.length).setValues(noveRadky);
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
  var t = _dsTabulka(sh);
  var vals = t.radky.map(function (x) {
    return [pozByUid[String(t.v(x.r, 'user_id') || '').trim()] || ''];
  });
  if (vals.length) sh.getRange(2, tymIdx + 2, vals.length, 1).setValues(vals);
}

/** Přečte list Uživatelé jako zdroj pravdy (cache na jeden běh, podle názvů sloupců). */
function _dsCtiUzivatele(ss) {
  return _dsCache('UZIVATELE', function () {
    var t = _dsTabulka(ss.getSheetByName(L_UZIV));
    var out = [];
    t.radky.forEach(function (x) {
      var jmeno = String(t.v(x.r, 'Jméno') || '').trim();
      var uid = String(t.v(x.r, 'user_id') || '').trim();
      if (!jmeno && !uid) return;
      out.push({
        user_id: uid,
        jmeno: jmeno,
        oddNazev: String(t.v(x.r, 'Oddělení') || '').trim(),
        tymNazev: String(t.v(x.r, 'Tým') || '').trim(),
        pozice: String(t.v(x.r, 'Pozice') || '').trim(),
        email: String(t.v(x.r, 'E-mail') || '').trim(),
        vedouci: /^ano$/i.test(String(t.v(x.r, 'Vedoucí') || '').trim()),
        od: _dsParseDatum(t.v(x.r, 'Od')),
        do: _dsParseDatum(t.v(x.r, 'Do'))
      });
    });
    return out;
  });
}

// ── list Pořadí ──────────────────────────────────────────────────────────

function _dsListPoradi(ss, lide) {
  if (ss.getSheetByName(L_PORADI)) return;

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

  var sh = ss.insertSheet(L_PORADI, 1);
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
  var sh = ss.getSheetByName(L_PORADI);
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

/** Zajistí list Stoly s hlavičkou (obsah nesahá — ten plní člověk nebo migrace). Vrací list. */
function _dsSeedStoly(ss) {
  var sh = ss.getSheetByName(L_STOLY);
  if (sh) { _dsUpgradeStolyHlavicku(sh); return sh; }

  sh = ss.insertSheet(L_STOLY, Math.min(2, ss.getSheets().length));
  sh.getRange(1, 1, 1, DS_STOLY_HLAVICKA.length).setValues([DS_STOLY_HLAVICKA])
    .setFontWeight('bold').setBackground('#f1f5f9');
  [120, 180, 70, 70, 70].forEach(function (px, i) { sh.setColumnWidth(i + 1, px); });
  sh.hideColumns(6, 2);            // cell_id + trvale_uid
  sh.setFrozenRows(1);
  _dsFont(sh);
  _dsCacheZrus('STOLY');
  return sh;
}

/** Doplní do staršího listu Stoly chybějící sloupce trvale_uid a Řádek/Sloupec. */
function _dsUpgradeStolyHlavicku(sh) {
  var hlav = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (x) { return String(x).trim(); });
  var zmena = false;

  if (hlav.indexOf('trvale_uid') === -1) {
    var novy = sh.getLastColumn() + 1;
    sh.getRange(1, novy).setValue('trvale_uid').setFontWeight('bold').setBackground('#f1f5f9');
    sh.hideColumns(novy);
    hlav.push('trvale_uid');
    zmena = true;
  }
  if (hlav.indexOf('Řádek') === -1) {
    // vloží se hned za „Aktivní", ať sedí pořadí v DS_STOLY_HLAVICKA
    var po = hlav.indexOf('Aktivní');
    if (po === -1) po = hlav.length - 1;
    sh.insertColumnsAfter(po + 1, 2);
    sh.getRange(1, po + 2, 1, 2).setValues([['Řádek', 'Sloupec']])
      .setFontWeight('bold').setBackground('#f1f5f9');
    sh.setColumnWidth(po + 2, 70);
    sh.setColumnWidth(po + 3, 70);
    zmena = true;
  }
  if (zmena) _dsCacheZrus('STOLY');
}

/**
 * Rozložení kanceláře z listu Stoly → { name, rows, cols, desks:[…] } nebo null.
 * Rozměry mřížky se odvodí z nejvyšší vyplněné pozice, název mapy si pamatuje
 * DocumentProperties (uloží ho migrace z aplikace).
 */
function _dsNactiMapu(ss) {
  var desks = [], rows = 0, cols = 0;
  _dsCtiStoly(ss).forEach(function (s) {
    if (s.radek < 0 || s.sloupec < 0) return;       // stůl bez pozice se do mapy nekreslí
    desks.push({
      id: s.cell_id, label: s.stul, row: s.radek, col: s.sloupec,
      trvale: s.trvale, trvaleUid: s.trvaleUid, aktivni: s.aktivni
    });
    rows = Math.max(rows, s.radek + 1);
    cols = Math.max(cols, s.sloupec + 1);
  });
  if (!desks.length) return null;
  return {
    name: PropertiesService.getDocumentProperties().getProperty('MAPA_NAZEV') || 'Kancelář',
    rows: rows, cols: cols, desks: desks
  };
}

/**
 * Kde je vyplněné jen jméno trvalého majitele, dohledá k němu user_id a zapíše
 * ho do trvale_uid (podle listu Uživatelé). Jednoznačná jména vyřeší sama,
 * u shodných jmen sloupec nechá prázdný a vrátí je k ručnímu dořešení.
 * Zapisuje jen když se něco změnilo. Vrací [{stul, jmeno, kolik}].
 */
function _dsDoplnTrvaleUid(ss) {
  var sh = ss.getSheetByName(L_STOLY);
  if (!sh) return [];
  var t = _dsTabulka(sh);
  var col = t.H['trvale_uid'];
  if (col === undefined || !t.radky.length) return [];

  var podleJmena = {};
  _dsCtiUzivatele(ss).forEach(function (u) {
    (podleJmena[u.jmeno] = podleJmena[u.jmeno] || []).push(String(u.user_id));
  });

  var zmena = false, nejasne = [];
  var hodnoty = t.radky.map(function (x) {
    var uid = String(t.v(x.r, 'trvale_uid') || '').trim();
    var jmeno = String(t.v(x.r, 'Trvale (jméno)') || '').trim();
    if (!jmeno) { if (uid) zmena = true; return ['']; }     // jméno smazáno → smaž i uid
    if (uid) return [uid];                                   // už vyřešeno
    var kandidati = podleJmena[jmeno] || [];
    if (kandidati.length === 1) { zmena = true; return [kandidati[0]]; }
    nejasne.push({ stul: String(t.v(x.r, 'Stůl') || '').trim(), jmeno: jmeno, kolik: kandidati.length });
    return [''];
  });

  if (zmena) {
    sh.getRange(2, col + 1, hodnoty.length, 1).setValues(hodnoty);
    _dsCacheZrus('STOLY');
  }
  return nejasne;
}

/**
 * List Mapa — vizuální rozložení stolů (jen rozvržení + trvalí majitelé, bez rezervací).
 * Přegeneruje se pokaždé, je to čistě odvozený list z listu Stoly.
 */
function _dsListMapa(ss) {
  var sh = ss.getSheetByName(L_MAPA) || ss.insertSheet(L_MAPA, Math.min(4, ss.getSheets().length));
  sh.clear();

  var mapa = _dsNactiMapu(ss);
  if (!mapa) {
    sh.getRange(1, 1).setValue('V listu ' + L_STOLY + ' nemá žádný stůl vyplněný Řádek a Sloupec — mapa se nedá vykreslit.');
    _dsFont(sh);
    return;
  }

  var R = mapa.rows, C = mapa.cols, r0 = 3;
  var grid = [], bg = [];
  for (var rr = 0; rr < R; rr++) {
    grid.push([]); bg.push([]);
    for (var cc = 0; cc < C; cc++) { grid[rr].push(''); bg[rr].push('#ffffff'); }
  }
  mapa.desks.forEach(function (d) {
    if (d.row >= R || d.col >= C) return;
    grid[d.row][d.col] = d.label + (d.trvale ? '\n' + d.trvale : '');
    bg[d.row][d.col] = !d.aktivni ? '#f1f5f9' : (d.trvale ? '#ffedd5' : '#dbeafe');
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
    .setDescription('Mapa je jen náhled — generuje se z listu ' + L_STOLY + ' (sloupce Řádek/Sloupec).');
}

/**
 * Vytvoří list Rezervace — jen pokud chybí. Vrátí ho.
 * Sloupec Datum se formátuje jako text jen při vzniku listu; oba zapisovací
 * cesty (dm_stul, _dmImportRezervace) si formát nastavují na svých buňkách,
 * takže tady se nesmí přeformátovávat celý sloupec (běželo by to při každé rezervaci).
 */
function _dsListRezervace(ss) {
  var sh = ss.getSheetByName(L_REZERVACE);
  if (sh) return sh;
  sh = ss.insertSheet(L_REZERVACE);
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
    var t = _dsTabulka(ss.getSheetByName(L_STOLY));
    var out = [];
    t.radky.forEach(function (x) {
      var lbl = String(t.v(x.r, 'Stůl') || '').trim();
      if (!lbl) return;
      out.push({
        stul: lbl,
        trvale: String(t.v(x.r, 'Trvale (jméno)') || '').trim(),
        trvaleUid: String(t.v(x.r, 'trvale_uid') || '').trim(),
        aktivni: /^ano$/i.test(String(t.v(x.r, 'Aktivní') || '').trim()),
        radek: _dsCislo(t.v(x.r, 'Řádek')),        // pozice v mapě, -1 = nemá
        sloupec: _dsCislo(t.v(x.r, 'Sloupec')),
        cell_id: String(t.v(x.r, 'cell_id') || '').trim()
      });
    });
    return out;
  });
}

/**
 * Celý list Rezervace přečtený JEDNOU za běh skriptu.
 * { rows:[{radek,datum,rok,mesic,den,stul,jmeno,uid}], volne:[čísla prázdných řádků], dalsi:první řádek za daty }
 */
function _dmCtiRezervace(ss) {
  return _dsCache('REZERVACE', function () {
    var t = _dsTabulka(ss.getSheetByName(L_REZERVACE));
    var prazdny = { rows: [], volne: [], dalsi: 2 };
    if (!t.radky.length || t.H['Datum'] === undefined || t.H['user_id'] === undefined) return prazdny;

    var rows = [], volne = [];
    t.radky.forEach(function (x) {
      var d = _dsFmtDatum(t.v(x.r, 'Datum'));
      var uid = String(t.v(x.r, 'user_id') || '').trim();
      if (!d && !uid) { volne.push(x.radek); return; }
      rows.push({
        radek: x.radek,
        datum: d,
        rok: Number(d.substring(0, 4)) || 0,
        mesic: Number(d.substring(5, 7)) || 0,
        den: Number(d.substring(8, 10)) || 0,
        stul: String(t.v(x.r, 'Stůl') || '').trim(),
        jmeno: String(t.v(x.r, 'Jméno') || '').trim(),
        uid: uid
      });
    });
    return { rows: rows, volne: volne, dalsi: t.data.length + 1 };
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
