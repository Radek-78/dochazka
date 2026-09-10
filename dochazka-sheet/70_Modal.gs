// ════════════════════════════════════════════════════════════════════
//  70_Modal.gs — Serverové funkce modalu „Zadat můj měsíc".
// ════════════════════════════════════════════════════════════════════


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
  var stoly = stolyRows.map(function (s) {
    return { label: s.stul, trvale: s.trvale, trvaleUid: s.trvaleUid };
  });
  var stulByCell = {};
  stolyRows.forEach(function (s) { if (s.cell_id) stulByCell[s.cell_id] = s; });
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
          var s = stulByCell[d.id];
          return {
            label: d.label, row: d.row, col: d.col,
            trvale: (s && s.trvale) || '', trvaleUid: (s && s.trvaleUid) || ''
          };
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
      if ((desk.trvale || desk.trvaleUid) && !_dmStulPatri(desk, payload.userId, payload.jmeno)) {
        throw new Error('Stůl ' + payload.stul + ' patří natrvalo: ' + (desk.trvale || '—') + '.');
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
      _dmObnovStul(msh, mmr.row, payload.den, payload.deskAbbr || [], maStul || _dmMaTrvalyStul(ss, payload.userId, payload.jmeno));
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
      _dmObnovStul(sheet, mr.row, payload.den, payload.deskAbbr || [], maR || _dmMaTrvalyStul(ssU, payload.userId, payload.jmeno));
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
        var trvaly = _dmMaTrvalyStul(ssH, payload.userId, payload.jmeno);
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
