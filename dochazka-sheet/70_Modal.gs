// ════════════════════════════════════════════════════════════════════
//  70_Modal.gs — Serverové funkce modalu „Zadat můj měsíc".
// ════════════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════════════════════
//  MODAL — serverové funkce
// ════════════════════════════════════════════════════════════════════════════

/**
 * Měřič kroků. Každá serverová funkce modalu vrací `log`, klient ho vypíše
 * do panelu ⏱ dole v okně — ať je vidět, na co se čeká.
 */
function _dmCasovac() {
  var t0 = Date.now(), last = t0, kroky = [];
  return {
    krok: function (nazev) {
      var n = Date.now();
      kroky.push({ co: nazev, ms: n - last });
      last = n;
    },
    pridej: function (jine) {
      (jine || []).forEach(function (k) { kroky.push(k); });
      last = Date.now();
    },
    // `boot` = kolik uteklo od začátku vyhodnocování skriptu do vstupu do funkce
    hotovo: function () { return { kroky: kroky, celkem: Date.now() - t0, boot: t0 - _DM_BOOT }; }
  };
}

/**
 * Vstup modalu — čte JEN z listů tohoto sešitu a rovnou vrací i data měsíce,
 * takže klient vystačí s jedním kolem komunikace se serverem.
 */
function dm_init() {
  var T = _dmCasovac();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var mesic = _dmMesicZListu(ss.getActiveSheet()) || (new Date().getMonth() + 1);
  T.krok('otevřít sešit + zjistit aktivní měsíc');

  var email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  T.krok('zjistit přihlášený e-mail');
  var me = _dsCtiUzivatele(ss).filter(function (u) {
    return u.email && u.email.toLowerCase() === email;
  })[0];
  T.krok('číst list ' + L_UZIV);
  if (!me) throw new Error('Tvůj e-mail (' + (email || '?') + ') není v listu ' + L_UZIV + ' ve sloupci E-mail.');

  var statusy = _dsCtiStatusy(ss);
  T.krok('číst list ' + L_STATUSY);
  var stolyRows = _dsCtiStoly(ss).filter(function (s) { return s.aktivni; });
  var stoly = stolyRows.map(function (s) {
    return { label: s.stul, trvale: s.trvale, trvaleUid: s.trvaleUid };
  });
  T.krok('číst list ' + L_STOLY);

  var mapaRaw = _dsNactiMapu(ss);
  var mapa = mapaRaw ? {
    name: mapaRaw.name, rows: mapaRaw.rows, cols: mapaRaw.cols,
    desks: mapaRaw.desks.filter(function (d) { return d.aktivni; }).map(function (d) {
      return { label: d.label, row: d.row, col: d.col, trvale: d.trvale, trvaleUid: d.trvaleUid };
    })
  } : null;
  T.krok('sestavit mapu stolů');

  var out = {
    rok: ROK, mesic: mesic, userId: me.user_id, jmeno: me.jmeno, usek: USEK_NAZEV,
    statusy: statusy,
    vacAbbr: statusy.filter(function (s) { return s.vac; }).map(function (s) { return s.abbr; }),
    deskAbbr: statusy.filter(function (s) { return s.desk; }).map(function (s) { return s.abbr; }),
    stoly: stoly, mapa: mapa
  };

  // data měsíce rovnou s initem; když list chybí nebo v něm uživatel není,
  // pošle se jen text chyby a klient ji zobrazí stejně jako dřív
  try {
    var d = dm_mesic({ userId: me.user_id, mesic: mesic });
    out.dny = d.dny;
    out.souhrn = d.souhrn;
    out.rezMesic = d.rezMesic;
    out.row = d.row;
    T.pridej(d.log.kroky);
  } catch (e) {
    out.chybaMesic = String((e && e.message) || e);
    T.krok('načtení měsíce SELHALO');
  }
  out.log = T.hotovo();
  return out;
}

function dm_mesic(payload) {
  var T = _dmCasovac();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _dmListMesice(payload.mesic);
  T.krok('měsíc: najít list');
  var b = _dmMujBlok(sheet, payload.userId, payload.mesic);
  T.krok('měsíc: řádek + dny + souhrn (jedním čtením)');
  var rez = _dmRezMesic(ss, payload.mesic);
  T.krok('měsíc: číst list ' + L_REZERVACE);
  return {
    mesic: payload.mesic, rok: ROK, row: b.row,
    dny: b.dny, souhrn: b.souhrn, rezMesic: rez, log: T.hotovo()
  };
}

/**
 * Můj řádek měsíčního listu jedním čtením: hodnoty celého bloku (jméno … user_id)
 * + sloučené buňky mého řádku. Dřív to byla čtyři samostatná volání.
 */
function _dmMujBlok(sheet, userId, mesic) {
  var N = _dmDniVMesici(mesic);
  var uidCol = _gUid(N), souhrnCol = _gSouhrn(N), prvni = DS_PRVNI_DATA_RADEK;
  var n = sheet.getLastRow() - prvni + 1;
  if (n < 1) throw new Error('Prázdný list.');
  var blok = sheet.getRange(prvni, 1, n, uidCol).getValues();

  var i = -1;
  for (var k = 0; k < n; k++) if (String(blok[k][uidCol - 1]) === String(userId)) { i = k; break; }
  if (i === -1) throw new Error('Nejsi v tomhle měsíci (list ' + sheet.getName() + '). Možná máš vyplněné datum Do.');

  var row = prvni + i;
  var merged = {};
  sheet.getRange(row, DS_DEN1_COL, 1, N * DS_DEN_KROK).getMergedRanges()
    .forEach(function (mr) { merged[mr.getColumn()] = true; });

  var dny = [];
  for (var d = 1; d <= N; d++) {
    var dopCol = _gDop(d);
    var dow = new Date(ROK, mesic - 1, d).getDay();
    var full = !!merged[dopCol];
    dny.push({
      den: d, dow: dow, weekend: (dow === 0 || dow === 6), full: full,
      dop: String(blok[i][dopCol - 1] || ''),
      odp: full ? '' : String(blok[i][dopCol] || '')
    });
  }
  return { row: row, souhrn: blok[i][souhrnCol - 1], dny: dny };
}

/**
 * Ověří řádek, který klient dostal při načtení měsíce (1 čtení buňky).
 * Kdyby se list mezitím přestavěl, dohledá řádek klasicky.
 */
function _dmRadekOveren(sheet, userId, mesic, tip) {
  var uidCol = _gUid(_dmDniVMesici(mesic));
  if (tip && String(sheet.getRange(tip, uidCol).getValue() || '') === String(userId)) return tip;
  return _dmMojeRadka(sheet, userId).row;
}

/** Stav dne, jak bude v listu vypadat po zápisu — bez nutnosti číst ho zpátky. */
function _dmDenPoZapisu(mesic, den, rezim, dop, odp) {
  var dow = new Date(ROK, mesic - 1, den).getDay();
  var full = rezim !== 'HALF';
  return {
    den: den, dow: dow, weekend: (dow === 0 || dow === 6), full: full,
    dop: rezim === 'CLEAR' ? '' : String(dop || ''),
    odp: full ? '' : String(odp || '')
  };
}

/** Rezervace měsíce bez záznamu daného člověka v daném dni. */
function _dmBezMe(rezMesic, userId, den) {
  return rezMesic.filter(function (r) { return !(r.den === den && r.uid === String(userId)); });
}

/**
 * Zapíše / zruší rezervaci stolu v listu Rezervace.
 * Vrací { maStul, rezMesic } — `rezMesic` je stav měsíce PO změně, poskládaný
 * z toho, co už je v paměti, takže se list nemusí číst znovu jen kvůli odpovědi.
 * Kolize a trvalé vlastnictví ověřuje VŽDY server — tohle se z klienta brát nesmí.
 */
function _dmRezervujStul(ss, userId, jmeno, mesic, den, stul) {
  var sh = _dsListRezervace(ss);
  var dateStr = ROK + '-' + ('0' + mesic).slice(-2) + '-' + ('0' + den).slice(-2);
  var rez = _dmCtiRezervace(ss);                          // jediné čtení listu za běh
  var vMesici = _dmRezMesic(ss, mesic);
  var vDen = vMesici.filter(function (r) { return r.den === den; });
  var moje = vDen.filter(function (r) { return r.uid === String(userId); })[0];
  var po = _dmBezMe(vMesici, userId, den);

  if (!stul) {
    if (moje) {
      sh.getRange(moje.radek, 1, 1, 4).clearContent();
      _dsCacheZrus('REZERVACE');
    }
    return { maStul: false, rezMesic: po };
  }

  var desk = _dsCtiStoly(ss).filter(function (s) { return s.stul === stul && s.aktivni; })[0];
  if (!desk) throw new Error('Stůl "' + stul + '" neexistuje nebo není aktivní.');
  if ((desk.trvale || desk.trvaleUid) && !_dmStulPatri(desk, userId, jmeno)) {
    throw new Error('Stůl ' + stul + ' patří natrvalo: ' + (desk.trvale || '—') + '.');
  }
  var kolize = vDen.filter(function (r) { return r.stul === stul && r.uid !== String(userId); })[0];
  if (kolize) throw new Error('Stůl ' + stul + ' je ' + dateStr + ' obsazený: ' + kolize.jmeno + '.');

  var cil = moje ? moje.radek : (rez.volne.length ? rez.volne[0] : rez.dalsi);
  sh.getRange(cil, 1, 1, 4).setNumberFormats([['@', '@', '@', '@']])
    .setValues([[dateStr, stul, jmeno, userId]]);
  _dsCacheZrus('REZERVACE');
  po.push({
    radek: cil, datum: dateStr, rok: ROK, mesic: mesic, den: den,
    stul: stul, jmeno: jmeno, uid: String(userId)
  });
  return { maStul: true, rezMesic: po };
}

/** Rezervace / uvolnění stolu bez změny statusu. payload: {userId, jmeno, mesic, den, stul, row, maTrvalyStul} */
function dm_stul(payload) {
  var T = _dmCasovac();
  var lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  T.krok('stůl: zámek dokumentu');
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var r = _dmRezervujStul(ss, payload.userId, payload.jmeno, payload.mesic, payload.den, payload.stul);
    T.krok('stůl: list ' + L_REZERVACE + ' (čtení + zápis)');

    try {
      var msh = _dmListMesice(payload.mesic);
      var row = _dmRadekOveren(msh, payload.userId, payload.mesic, payload.row);
      _dmObnovStul(msh, row, payload.den, payload.deskAbbr || [], r.maStul || !!payload.maTrvalyStul);
      PropertiesService.getDocumentProperties().deleteProperty('REZ_' + payload.mesic);
    } catch (e) {}
    T.krok('stůl: přeznačit buňku v měsíčním listu');
    return { rezMesic: r.rezMesic, log: T.hotovo() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Uloží jeden den — a rovnou i rezervaci stolu, když je `stul` v payloadu
 * (jedno kolo místo dvou, a hlavně bez čekání na zámek podruhé).
 *
 * Klient posílá, co už sám ví, aby server nemusel číst listy znovu:
 *   row           — můj řádek z načtení měsíce (server ho jen ověří, 1 buňka)
 *   souhrn        — přepočtená dovolená (server ji jen zapíše)
 *   maTrvalyStul  — mám někde trvale přidělený stůl (list Stoly)
 *   maRezervaci   — mám ten den rezervaci (list Rezervace)
 *   stul          — chybí = neřešit; '' = uvolnit; 'A16' = rezervovat
 */
function dm_uloz(payload) {
  var T = _dmCasovac();
  var lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  T.krok('uložit: zámek dokumentu');
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = _dmListMesice(payload.mesic);
    var N = _dmDniVMesici(payload.mesic);
    var row = _dmRadekOveren(sheet, payload.userId, payload.mesic, payload.row);
    T.krok('uložit: ověřit můj řádek');

    _dmZapisDen(sheet, row, payload.den, payload.rezim, payload.dop, payload.odp);
    T.krok('uložit: zapsat den (sloučení buněk)');

    var souhrn = payload.souhrn;
    if (souhrn === undefined || souhrn === null || isNaN(Number(souhrn))) {
      souhrn = _dmPrepocitejSouhrn(sheet, row, payload.mesic, payload.vacAbbr || []);
    } else {
      souhrn = Number(souhrn);
      sheet.getRange(row, _gSouhrn(N)).setValue(souhrn);
    }
    T.krok('uložit: zapsat souhrn dovolené');

    var potreba = _dmPotrebaStul(payload.rezim, payload.dop, payload.odp, payload.deskAbbr);
    var maStul = !!payload.maTrvalyStul;
    var rezPo = null;                       // stav rezervací po změně (bez dalšího čtení listu)
    if (payload.stul !== undefined && payload.stul !== null) {
      var r = _dmRezervujStul(ss, payload.userId, payload.jmeno, payload.mesic,
        payload.den, potreba ? payload.stul : '');
      maStul = r.maStul || maStul;
      rezPo = r.rezMesic;
    } else if (!potreba && payload.maRezervaci) {
      // status už stůl nepotřebuje → zruš rezervaci (jen když klient říká, že nějaká je)
      var pred = _dmRezMesic(ss, payload.mesic);
      if (_dmZrusRezervaci(ss, payload.userId, payload.mesic, payload.den)) {
        rezPo = _dmBezMe(pred, payload.userId, payload.den);
      }
    } else {
      maStul = maStul || !!payload.maRezervaci;
    }
    T.krok('uložit: rezervace stolu');

    var den = _dmDenPoZapisu(payload.mesic, payload.den, payload.rezim, payload.dop, payload.odp);
    try {
      _dmObnovStul(sheet, row, payload.den, payload.deskAbbr || [], maStul, den);
    } catch (e) {}
    try { sheet.getRange(row, _gDop(payload.den)).activate(); } catch (e) {}
    T.krok('uložit: indikace „bez stolu" v buňce');

    var out = { den: den, souhrn: souhrn, row: row, log: null };
    if (rezPo) out.rezMesic = rezPo;        // jinak si klient nechá svoje
    out.log = T.hotovo();
    return out;
  } finally {
    lock.releaseLock();
  }
}

/** Hromadné zadání: den od–do, volitelně jen všední dny. */
function dm_hromadne(payload) {
  var T = _dmCasovac();
  var lock = LockService.getDocumentLock();
  lock.waitLock(25000);
  T.krok('hromadně: zámek dokumentu');
  try {
    var sheet = _dmListMesice(payload.mesic);
    var mr = { row: _dmRadekOveren(sheet, payload.userId, payload.mesic, payload.row) };
    T.krok('hromadně: ověřit můj řádek');
    var N = _dmDniVMesici(payload.mesic);
    var od = Math.max(1, Math.min(N, Number(payload.odDen) || 1));
    var doo = Math.max(od, Math.min(N, Number(payload.doDen) || N));
    var ssH = SpreadsheetApp.getActiveSpreadsheet();
    var potrebaStul = _dmPotrebaStul(payload.rezim, payload.dop, payload.odp, payload.deskAbbr);
    // dny, kdy mám rezervaci, zná klient → list Rezervace se nemusí číst vůbec
    var rezDny = {};
    (payload.rezDny || []).forEach(function (x) { rezDny[Number(x)] = 1; });
    var rezZmena = false;

    for (var d = od; d <= doo; d++) {
      if (payload.jenVsedni) {
        var dow = new Date(ROK, payload.mesic - 1, d).getDay();
        if (dow === 0 || dow === 6) continue;
      }
      _dmZapisDen(sheet, mr.row, d, payload.rezim, payload.dop, payload.odp);
      if (!potrebaStul && rezDny[d]) {
        if (_dmZrusRezervaci(ssH, payload.userId, payload.mesic, d)) rezZmena = true;
        delete rezDny[d];
      }
    }
    T.krok('hromadně: zapsat dny ' + od + '–' + doo);
    var souhrn = _dmPrepocitejSouhrn(sheet, mr.row, payload.mesic, payload.vacAbbr || []);
    T.krok('hromadně: přepočítat souhrn dovolené');
    try {
      var da = payload.deskAbbr || [];
      if (da.length) {
        var trvaly = !!payload.maTrvalyStul;
        for (var dd = od; dd <= doo; dd++) {
          if (payload.jenVsedni) {
            var w = new Date(ROK, payload.mesic - 1, dd).getDay();
            if (w === 0 || w === 6) continue;
          }
          _dmObnovStul(sheet, mr.row, dd, da, !!rezDny[dd] || trvaly);
        }
      }
    } catch (e) {}
    T.krok('hromadně: indikace stolů');
    try { sheet.getRange(mr.row, 1).activate(); } catch (e) {}
    var dnyZpet = _dmDenData(sheet, mr.row, payload.mesic);
    T.krok('hromadně: přečíst měsíc zpět');
    var vysl = { dny: dnyZpet, souhrn: souhrn, log: null };
    if (rezZmena) vysl.rezMesic = _dmRezMesic(ssH, payload.mesic);   // jinak si klient nechá svoje
    vysl.log = T.hotovo();
    return vysl;
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
