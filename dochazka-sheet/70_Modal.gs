// ════════════════════════════════════════════════════════════════════
//  70_Modal.gs — Serverové funkce modalu „Zadat můj měsíc".
// ════════════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════════════════════
//  MODAL — serverové funkce
// ════════════════════════════════════════════════════════════════════════════

// ── kdo jsem a co smím ──────────────────────────────────────────────────
// Identita se VŽDY odvozuje ze session, nikdy z toho, co pošle klient —
// jinak by stačilo upravit payload a psát za kohokoli.

/**
 * Kdo je přihlášený. Dohledá se v listu Uživatelé podle e-mailu a výsledek se
 * uloží do UserProperties — ukládá ho server po ověření, klient do toho nevidí,
 * takže se tím nedá nic podvrhnout. Díky tomu nemusí každé uložení dne kvůli
 * kontrole oprávnění číst list (ušetří to ~300 ms na volání).
 * Změna role se projeví při dalším otevření modalu.
 */
function _dmJa(ss) {
  return _dsCache('JA', function () {
    var email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
    var ulozene = null;
    try { ulozene = JSON.parse(PropertiesService.getUserProperties().getProperty('JA') || 'null'); } catch (e) {}
    if (ulozene && ulozene.user_id && String(ulozene.email || '').toLowerCase() === email) return ulozene;
    return _dmJaZListu(ss, email);
  });
}

/** Dohledání v listu Uživatelé + uložení do UserProperties pro příští běhy. */
function _dmJaZListu(ss, email) {
  var s = ss || SpreadsheetApp.getActiveSpreadsheet();
  email = email || String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var me = _dsCtiUzivatele(s).filter(function (u) {
    return u.email && u.email.toLowerCase() === email;
  })[0];
  if (!me) {
    throw new Error('Tvůj e-mail (' + (email || '?') + ') není v listu ' + L_UZIV + ' ve sloupci E-mail.');
  }
  try {
    PropertiesService.getUserProperties().setProperty('JA', JSON.stringify({
      user_id: me.user_id, jmeno: me.jmeno, oddNazev: me.oddNazev, pozice: me.pozice,
      role: me.role, email: me.email
    }));
  } catch (e) {}
  return me;
}

/**
 * Rozsah, ve kterém člověk smí zadávat docházku a vidět skutečné citlivé
 * statusy: 'vse' | 'oddeleni' | 'ja'. Jedno pravidlo pro obojí.
 *
 * U role správce nerozhoduje role, ale POZICE — role správce je o tom, co smí
 * v menu (přestavět listy, importovat), ne o přístupu k cizí docházce.
 * Technický správce, který je řadový zaměstnanec, tak zůstává u své vlastní.
 */
function _dmRozsah(ja) {
  if (ja.role === R_WGL) return 'vse';
  if (ja.role === R_AL) return 'oddeleni';
  if (ja.role === R_SPRAVCE) {
    if (_dsPoziceJe(ja.pozice, DS_POZICE_USEK)) return 'vse';
    if (_dsPoziceJe(ja.pozice, DS_POZICE_ODDELENI)) return 'oddeleni';
  }
  return 'ja';
}

/** Je `cil` v kompetenci `ja`? Platí pro zadávání i pro vidění citlivých statusů. */
function _dmVKompetenci(ja, cil) {
  if (String(ja.user_id) === String(cil.user_id)) return true;      // sám za sebe vždycky
  var r = _dmRozsah(ja);
  if (r === 'vse') return true;
  if (r === 'oddeleni') return !!ja.oddNazev && ja.oddNazev === cil.oddNazev;
  return false;
}

/** Za koho se zapisuje. `userId` je přání klienta — tady se ověří, že na něj má právo. */
function _dmCil(ss, userId) {
  var ja = _dmJa(ss);
  if (!userId || String(userId) === String(ja.user_id)) return ja;
  var cil = _dsCtiUzivatele(ss).filter(function (u) { return String(u.user_id) === String(userId); })[0];
  if (!cil) throw new Error('Uživatel ' + userId + ' není v listu ' + L_UZIV + '.');
  if (!_dmVKompetenci(ja, cil)) {
    throw new Error('Nemáš oprávnění zadávat docházku za: ' + cil.jmeno + '.' +
      '\n\nTvoje role: ' + ja.role + ', pozice: ' + (ja.pozice || '—') +
      '  →  rozsah: ' + _dmRozsah(ja) + '.');
  }
  return cil;
}

/**
 * Vyhodí chybu, když přihlášený není správce. Používají to položky menu.
 * Dvě pojistky proti zamčení sešitu: prázdný list Uživatelé (nový sešit se musí
 * dát postavit) a stav, kdy roli správce nemá vůbec nikdo.
 */
function _dmVyzadujSpravce() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lide = _dsCtiUzivatele(ss);
  if (!lide.length) return null;
  if (!lide.some(function (u) { return u.role === R_SPRAVCE; })) return null;

  var ja = _dmJa(ss);
  if (ja.role !== R_SPRAVCE) {
    throw new Error('Tuhle akci smí spustit jen ' + R_SPRAVCE + '.\n\nTvoje role: ' + ja.role +
      ' (mění se v listu ' + L_UZIV + ', sloupec Role).');
  }
  return ja;
}

/**
 * Vstup modalu — čte JEN z listů tohoto sešitu a rovnou vrací i data měsíce,
 * takže klient vystačí s jedním kolem komunikace se serverem.
 */
function dm_init() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var mesic = _dmMesicZListu(ss.getActiveSheet()) || (new Date().getMonth() + 1);

  // Otevření modalu je jediné místo, kde se identita čte ZNOVU z listu — tím se
  // propíše i změna role. Ostatní volání pak jedou z UserProperties.
  var me = _dsCache('JA', function () { return _dmJaZListu(ss); });
  // ať menu při příštím otevření sešitu ví, co zobrazit (onOpen si roli nezjistí spolehlivě)
  try { PropertiesService.getUserProperties().setProperty('ROLE', me.role); } catch (e) {}

  // za koho smí zadávat; jen sám za sebe = výběr osoby se v modalu nezobrazí
  var lide = _dsCtiUzivatele(ss)
    .filter(function (u) { return u.user_id && _dmVKompetenci(me, u); })
    .sort(function (a, b) { return String(a.jmeno).localeCompare(String(b.jmeno), 'cs'); })
    .map(function (u) { return { userId: u.user_id, jmeno: u.jmeno, odd: u.oddNazev }; });

  var statusy = _dsCtiStatusy(ss);
  _dsNahradyZListu(ss);                    // obnoví sdílenou mapu citlivých statusů
  var stolyRows = _dsCtiStoly(ss).filter(function (s) { return s.aktivni; });
  var stoly = stolyRows.map(function (s) {
    return { label: s.stul, trvale: s.trvale, trvaleUid: s.trvaleUid };
  });

  var mapaRaw = _dsNactiMapu(ss);
  var mapa = mapaRaw ? {
    name: mapaRaw.name, rows: mapaRaw.rows, cols: mapaRaw.cols,
    desks: mapaRaw.desks.filter(function (d) { return d.aktivni; }).map(function (d) {
      return { label: d.label, row: d.row, col: d.col, trvale: d.trvale, trvaleUid: d.trvaleUid };
    })
  } : null;

  // „dnes" podle serveru — klient podle toho pozná, co se počítá do „k dnešku"
  var dnes = new Date();
  var out = {
    rok: ROK, mesic: mesic, userId: me.user_id, jmeno: me.jmeno, usek: USEK_NAZEV,
    dnes: dnes.getFullYear() === ROK
      ? { mesic: dnes.getMonth() + 1, den: dnes.getDate() }
      : { mesic: 13, den: 31 },              // jiný rok → celý rok je „k dnešku"
    role: me.role, lide: lide,
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
    out.souhrny = d.souhrny;
    out.rezMesic = d.rezMesic;
    out.row = d.row;
  } catch (e) {
    out.chybaMesic = String((e && e.message) || e);
  }
  return out;
}

function dm_mesic(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cil = _dmCil(ss, payload.userId);
  var b = _dmMujBlok(_dmListMesice(payload.mesic), cil, payload.mesic);
  // v mřížce jsou náhrady; skutečné citlivé statusy dostane jen oprávněný
  if (_dmVKompetenci(_dmJa(ss), cil)) {
    _dmDosadCitlive(b.dny, _dmCitliveMesic(ss, cil.user_id, payload.mesic), _dsNahrady(ss));
  }
  return {
    mesic: payload.mesic, rok: ROK, row: b.row,
    dny: b.dny, souhrny: b.souhrny, rezMesic: _dmRezMesic(ss, payload.mesic)
  };
}

/**
 * Řádek daného člověka jedním čtením: hodnoty celého bloku (jméno … user_id)
 * + sloučené buňky jeho řádku. Dřív to byla čtyři samostatná volání.
 */
function _dmMujBlok(sheet, cil, mesic) {
  var N = _dmDniVMesici(mesic);
  var uidCol = _gUid(N), souhrnCol = _gSouhrn(N), prvni = DS_PRVNI_DATA_RADEK;
  var n = sheet.getLastRow() - prvni + 1;
  if (n < 1) throw new Error('Prázdný list.');
  var blok = sheet.getRange(prvni, 1, n, uidCol).getValues();

  var i = -1;
  for (var k = 0; k < n; k++) if (String(blok[k][uidCol - 1]) === String(cil.user_id)) { i = k; break; }
  if (i === -1) throw new Error(_dmChybiRadek(sheet, cil));

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
  return { row: row, souhrny: _dsParsujDovolenou(blok[i][souhrnCol - 1]), dny: dny };
}

/**
 * Ověří řádek, který klient dostal při načtení měsíce (1 čtení buňky).
 * Kdyby se list mezitím přestavěl, dohledá řádek klasicky.
 */
function _dmRadekOveren(sheet, cil, mesic, tip) {
  var uidCol = _gUid(_dmDniVMesici(mesic));
  if (tip && String(sheet.getRange(tip, uidCol).getValue() || '') === String(cil.user_id)) return tip;
  return _dmMojeRadka(sheet, cil).row;
}

/** Hláška, když člověk v měsíčním listu není (typicky vyplněné datum Do). */
function _dmChybiRadek(sheet, cil) {
  return 'V listu ' + sheet.getName() + ' není řádek pro: ' + (cil.jmeno || cil.user_id) +
    '.\nMožná má vyplněné datum Do, nebo se list od té doby nepřestavěl.';
}

/**
 * Dosadí do dnů skutečné citlivé statusy místo náhrad.
 * Dosazuje jen tam, kde v mřížce opravdu stojí očekávaná náhrada — osamocený
 * záznam v listu Citlivé (např. po ruční úpravě mřížky) se tím ignoruje.
 */
function _dmDosadCitlive(dny, skutecne, nahrady) {
  dny.forEach(function (d) {
    var x = skutecne[d.den];
    if (!x) return;
    if (x.dop && d.dop === _dsMaska(nahrady, x.dop)) d.dop = x.dop;
    if (x.odp && !d.full && d.odp === _dsMaska(nahrady, x.odp)) d.odp = x.odp;
  });
}

/**
 * Zapíše do sloupce Dovolená tři čísla, která spočítal klient (zná celý měsíc
 * i to, co v buňce stálo). Když je nepošle, spadne to na serverový přepočet
 * měsíce — roční čísla pak srovná až „Přepočítat dovolenou".
 */
function _dmZapisSouhrny(sheet, row, N, souhrny, mesic, vacAbbr) {
  var s = souhrny || {};
  if (isNaN(Number(s.mesic))) {
    var m = _dmPrepocitejSouhrn(sheet, row, mesic, vacAbbr || []);
    return { mesic: m, doDnes: m, rok: m };
  }
  var v = { mesic: Number(s.mesic), doDnes: Number(s.doDnes) || 0, rok: Number(s.rok) || 0 };
  sheet.getRange(row, _gSouhrn(N)).setValue(_dsCislaDovolene(v.mesic, v.doDnes, v.rok));
  return v;
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

/** Rezervace / uvolnění stolu bez změny statusu. payload: {userId, mesic, den, stul, row, maTrvalyStul} */
function dm_stul(payload) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var cil = _dmCil(ss, payload.userId);          // jméno bere ze seznamu, ne z payloadu
    var r = _dmRezervujStul(ss, cil.user_id, cil.jmeno, payload.mesic, payload.den, payload.stul);

    try {
      var msh = _dmListMesice(payload.mesic);
      var row = _dmRadekOveren(msh, cil, payload.mesic, payload.row);
      _dmObnovStul(msh, row, payload.den, payload.deskAbbr || [], r.maStul || !!payload.maTrvalyStul);
      PropertiesService.getDocumentProperties().deleteProperty('REZ_' + payload.mesic);
    } catch (e) {}
    return { rezMesic: r.rezMesic };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Uloží jeden den — a rovnou i rezervaci stolu, když je `stul` v payloadu
 * (jedno kolo místo dvou, a hlavně bez čekání na zámek podruhé).
 *
 * Klient posílá, co už sám ví, aby server nemusel číst listy znovu:
 *   userId        — za koho se zapisuje (server ověří oprávnění přes _dmCil)
 *   row           — řádek z načtení měsíce (server ho jen ověří, 1 buňka)
 *   souhrny       — {mesic, doDnes, rok} dovolené (server je jen zapíše)
 *   maTrvalyStul  — dotyčný má někde trvale přidělený stůl (list Stoly)
 *   maRezervaci   — dotyčný má ten den rezervaci (list Rezervace)
 *   stul          — chybí = neřešit; '' = uvolnit; 'A16' = rezervovat
 */
function dm_uloz(payload) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var cil = _dmCil(ss, payload.userId);
    var sheet = _dmListMesice(payload.mesic);
    var N = _dmDniVMesici(payload.mesic);
    var row = _dmRadekOveren(sheet, cil, payload.mesic, payload.row);

    // O tom, co je citlivé, rozhoduje server — do sdílené mřížky jde náhrada
    // a skutečná zkratka zvlášť do skrytého listu Citlivé.
    var nahrady = _dsNahrady(ss);
    var skutDop = payload.rezim === 'CLEAR' ? '' : String(payload.dop || '');
    var skutOdp = payload.rezim === 'HALF' ? String(payload.odp || '') : '';
    _dmZapisDen(sheet, row, payload.den, payload.rezim,
      _dsMaska(nahrady, skutDop), _dsMaska(nahrady, skutOdp));
    // Když nic citlivého nezapisujeme a klient netvrdí, že tam něco bylo, nemá
    // smysl list Citlivé vůbec otevírat. Kdyby se klient spletl, osamocený
    // záznam se stejně nikde nezobrazí (viz _dmDosadCitlive).
    if (nahrady[skutDop] || nahrady[skutOdp] || payload.byloCitlive) {
      _dmZapisCitlive(ss, cil.user_id, payload.mesic, payload.den, skutDop, skutOdp, nahrady);
    }

    var souhrny = _dmZapisSouhrny(sheet, row, N, payload.souhrny, payload.mesic, payload.vacAbbr);

    var potreba = _dmPotrebaStul(payload.rezim, payload.dop, payload.odp, payload.deskAbbr);
    var maStul = !!payload.maTrvalyStul;
    var rezPo = null;                       // stav rezervací po změně (bez dalšího čtení listu)
    if (payload.stul !== undefined && payload.stul !== null) {
      var r = _dmRezervujStul(ss, cil.user_id, cil.jmeno, payload.mesic,
        payload.den, potreba ? payload.stul : '');
      maStul = r.maStul || maStul;
      rezPo = r.rezMesic;
    } else if (!potreba && payload.maRezervaci) {
      // status už stůl nepotřebuje → zruš rezervaci (jen když klient říká, že nějaká je)
      var pred = _dmRezMesic(ss, payload.mesic);
      if (_dmZrusRezervaci(ss, cil.user_id, payload.mesic, payload.den)) {
        rezPo = _dmBezMe(pred, cil.user_id, payload.den);
      }
    } else {
      maStul = maStul || !!payload.maRezervaci;
    }

    var den = _dmDenPoZapisu(payload.mesic, payload.den, payload.rezim, skutDop, skutOdp);
    try {
      _dmObnovStul(sheet, row, payload.den, payload.deskAbbr || [], maStul, {
        dop: _dsMaska(nahrady, den.dop), odp: _dsMaska(nahrady, den.odp), full: den.full
      });
    } catch (e) {}
    try { sheet.getRange(row, _gDop(payload.den)).activate(); } catch (e) {}

    var out = { den: den, souhrny: souhrny, row: row };
    if (rezPo) out.rezMesic = rezPo;        // jinak si klient nechá svoje
    return out;
  } finally {
    lock.releaseLock();
  }
}

/** Hromadné zadání: den od–do, volitelně jen všední dny. */
function dm_hromadne(payload) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(25000);
  try {
    var ssH = SpreadsheetApp.getActiveSpreadsheet();
    var cil = _dmCil(ssH, payload.userId);
    var sheet = _dmListMesice(payload.mesic);
    var mr = { row: _dmRadekOveren(sheet, cil, payload.mesic, payload.row) };
    var N = _dmDniVMesici(payload.mesic);
    var od = Math.max(1, Math.min(N, Number(payload.odDen) || 1));
    var doo = Math.max(od, Math.min(N, Number(payload.doDen) || N));
    var potrebaStul = _dmPotrebaStul(payload.rezim, payload.dop, payload.odp, payload.deskAbbr);
    var nahrady = _dsNahrady(ssH);
    var hDop = payload.rezim === 'CLEAR' ? '' : String(payload.dop || '');
    var hOdp = payload.rezim === 'HALF' ? String(payload.odp || '') : '';
    var mDop = _dsMaska(nahrady, hDop), mOdp = _dsMaska(nahrady, hOdp);
    // dny, kdy mám rezervaci, zná klient → list Rezervace se nemusí číst vůbec
    var rezDny = {};
    (payload.rezDny || []).forEach(function (x) { rezDny[Number(x)] = 1; });
    var rezZmena = false;

    for (var d = od; d <= doo; d++) {
      if (payload.jenVsedni) {
        var dow = new Date(ROK, payload.mesic - 1, d).getDay();
        if (dow === 0 || dow === 6) continue;
      }
      _dmZapisDen(sheet, mr.row, d, payload.rezim, mDop, mOdp);
      if (nahrady[hDop] || nahrady[hOdp] || payload.byloCitlive) {
        _dmZapisCitlive(ssH, cil.user_id, payload.mesic, d, hDop, hOdp, nahrady);
      }
      if (!potrebaStul && rezDny[d]) {
        if (_dmZrusRezervaci(ssH, cil.user_id, payload.mesic, d)) rezZmena = true;
        delete rezDny[d];
      }
    }
    var souhrny = _dmZapisSouhrny(sheet, mr.row, N, payload.souhrny, payload.mesic, payload.vacAbbr);
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
    try { sheet.getRange(mr.row, 1).activate(); } catch (e) {}
    var dnyZpet = _dmDenData(sheet, mr.row, payload.mesic);
    if (_dmVKompetenci(_dmJa(ssH), cil)) {          // v mřížce jsou náhrady
      _dmDosadCitlive(dnyZpet, _dmCitliveMesic(ssH, cil.user_id, payload.mesic), nahrady);
    }
    var vysl = { dny: dnyZpet, souhrny: souhrny };
    if (rezZmena) vysl.rezMesic = _dmRezMesic(ssH, payload.mesic);   // jinak si klient nechá svoje
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

function _dmMojeRadka(sheet, cil) {
  var uidCol = _gUid(_dmDniVMesici(_dmMesicZListu(sheet)));
  var last = sheet.getLastRow();
  var n = last - DS_PRVNI_DATA_RADEK + 1;
  if (n < 1) throw new Error('Prázdný list.');
  var uids = sheet.getRange(DS_PRVNI_DATA_RADEK, uidCol, n, 1).getValues();
  for (var i = 0; i < uids.length; i++) {
    if (String(uids[i][0]) === String(cil.user_id)) return { row: DS_PRVNI_DATA_RADEK + i };
  }
  throw new Error(_dmChybiRadek(sheet, cil));
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
