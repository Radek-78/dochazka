// ════════════════════════════════════════════════════════════════════
//  50_Stoly.gs — Rezervace stolů — indikace v mřížce a pravidla vlastnictví.
// ════════════════════════════════════════════════════════════════════

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

  var trvalyUid = _dmTrvaleStolyUid(ss);   // uživatelé s trvalým stolem → nikdy neindikovat

  // výchozí barva písma jde podle statusu v buňce, červená ji jen přebije
  var barvy = _dsBarvyStatusu(ss);
  var fc = [];
  for (var r0 = 0; r0 < nRows; r0++) {
    var rr = [];
    for (var c0 = 0; c0 < dnyW; c0++) rr.push(_dsFgStatusu(barvy, grid[r0][c0]));
    fc.push(rr);
  }
  var ramecky = [];
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
        zvyrazneno++;
      }
      if (!jenPismo) {
        ramecky.push({ row: absRow, col: _gDop(d), rows: 1, cols: 2, barva: chybi ? DS_BARVA_BEZ_STOLU : null });
      }
    }
  }
  sheet.getRange(DS_PRVNI_DATA_RADEK, den1, nRows, dnyW).setFontColors(fc);
  _dsRameckyDavkove(sheet, ramecky);
  return zvyrazneno;
}

/**
 * Patří stůl natrvalo tomuto uživateli?
 * Rozhoduje user_id; jméno je jen záloha pro starší listy Stoly, kde trvale_uid
 * ještě není vyplněné. Díky tomu si dva lidé se stejným jménem nepřebijí stůl.
 */
function _dmStulPatri(desk, userId, jmeno) {
  if (!desk) return false;
  if (desk.trvaleUid) return desk.trvaleUid === String(userId);
  return !!desk.trvale && desk.trvale === jmeno;
}

/** { user_id: 1 } pro všechny, kdo mají natrvalo přiřazený nějaký stůl. */
function _dmTrvaleStolyUid(ss) {
  var uidByJmeno = {};
  _dsCtiUzivatele(ss).forEach(function (u) {
    if (uidByJmeno[u.jmeno] === undefined) uidByJmeno[u.jmeno] = String(u.user_id);
    else uidByJmeno[u.jmeno] = null;          // shodné jméno → přes jméno nerozhodneme
  });
  var out = {};
  _dsCtiStoly(ss).forEach(function (s) {
    if (s.trvaleUid) { out[s.trvaleUid] = 1; return; }
    if (s.trvale && uidByJmeno[s.trvale]) out[uidByJmeno[s.trvale]] = 1;
  });
  return out;
}

/** Smaže rezervaci uživatele pro daný den (list Rezervace). Vrací true, když něco smazal. */
function _dmZrusRezervaci(ss, userId, mesic, den) {
  var sh = ss.getSheetByName(L_REZERVACE);
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

/**
 * Jeden den: kancelář bez stolu → červená zkratka + červený rámeček, jinak výchozí
 * barva bez rámečku. `stav` = { dop, odp, full } — když ho volající zná (právě to
 * zapsal), ušetří se čtení listu; jinak se dočte.
 */
function _dmObnovStul(sheet, row, den, deskAbbr, maRezervaci, stav) {
  var dopCol = _gDop(den);
  var pair = sheet.getRange(row, dopCol, 1, 2);
  if (!stav) {
    var vals = pair.getValues()[0];
    stav = { dop: vals[0], odp: vals[1], full: pair.isPartOfMerge() };
  }
  var da = deskAbbr || [];
  var barvy = _dsBarvyStatusu(SpreadsheetApp.getActiveSpreadsheet());
  var dopDesk = da.indexOf(String(stav.dop || '').trim()) !== -1;
  var odpDesk = !stav.full && da.indexOf(String(stav.odp || '').trim()) !== -1;
  var chybi = (dopDesk || odpDesk) && !maRezervaci;
  pair.setFontColors([[
    dopDesk && chybi ? DS_BARVA_BEZ_STOLU : _dsFgStatusu(barvy, stav.dop),
    odpDesk && chybi ? DS_BARVA_BEZ_STOLU : _dsFgStatusu(barvy, stav.odp)
  ]]);
  if (chybi) pair.setBorder(true, true, true, true, false, false, DS_BARVA_BEZ_STOLU, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  else pair.setBorder(false, false, false, false, false, false, null, null);
}
