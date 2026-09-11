// ════════════════════════════════════════════════════════════════════
//  10_Menu.gs — Menu, vstupní body a označení dnešního sloupce.
// ════════════════════════════════════════════════════════════════════


function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('📋 Docházka')
    .addItem('📝 Zadat můj měsíc', 'otevriModal')
    .addSeparator()
    .addItem('🔄 Postavit / obnovit všechny měsíce', 'setup')
    .addItem('📅 Postavit / obnovit jen tento měsíc', 'setupMesic')
    .addSeparator()
    .addItem('🧩 Zkontrolovat pomocné listy', 'vytvorPomocneListy')
    .addSeparator()
    // Jediná část menu, která sahá do sešitů živé aplikace. Až aplikace skončí,
    // smaže se tohle podmenu spolu s 20_Zdroje.gs a 60_Import.gs.
    .addSubMenu(ui.createMenu('🧳 Z aplikace (jednorázově)')
      .addItem('🧳 Naplnit listy z aplikace (odpojení)', 'odpojOdAplikace')
      .addSeparator()
      .addItem('📥 Načíst docházku z aplikace', 'nactiDochazku')
      .addItem('🪑 Načíst rezervace stolů z aplikace', 'nactiRezervace')
      .addItem('🪑 Přegenerovat list Stoly z aplikace', 'aktualizujStoly')
      .addSeparator()
      .addItem('💾 Cachovat zdroje z aplikace (vývoj)', 'cachujZdroje')
      .addItem('🗑 Smazat cache zdrojů (zpět na živá data)', 'smazCacheZdroju'))
    .addToUi();
  _dsOznacDnes();
}

/** Obarví v hlavičce dnů aktuálního měsíce dnešní sloupec (a odbarví včerejší). */
function _dsOznacDnes() {
  try {
    var dt = new Date();
    if (dt.getFullYear() !== ROK) return;
    var mesic = dt.getMonth() + 1;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(_dsNazevMesice(mesic));
    if (!sheet) return;
    var den1 = DS_DEN1_COL;
    var N = _dmDniVMesici(mesic);
    var novyDop = _gDop(dt.getDate());

    var props = PropertiesService.getDocumentProperties();
    var stare = props.getProperty('DNES_SLOUPEC');
    if (stare) {
      var p = stare.split(':');
      var sM = Number(p[0]), sDop = Number(p[1]);
      if (!(sM === mesic && sDop === novyDop)) {
        var sSheet = ss.getSheetByName(_dsNazevMesice(sM));
        if (sSheet && sDop >= den1 && sDop <= _gDop(_dmDniVMesici(sM)) + 1) {
          _dsBarvaHlavicky(sSheet, sM, sDop, false);
        }
      }
    }
    if (novyDop >= den1 && novyDop <= _gDop(N) + 1) {
      _dsBarvaHlavicky(sheet, mesic, novyDop, true);
      props.setProperty('DNES_SLOUPEC', mesic + ':' + novyDop);
    }
  } catch (e) { /* onOpen nesmí spadnout */ }
}

function _dsBarvaHlavicky(sheet, mesic, dopCol, dnes) {
  var d = _gDenZeSloupce(dopCol);
  var dow = new Date(ROK, mesic - 1, d).getDay();
  var mmdd = ('0' + mesic).slice(-2) + '-' + ('0' + d).slice(-2);
  var svatek = !!_dsSvatkyCR(ROK)[mmdd];
  var bg = dnes ? '#facc15'
    : (svatek ? '#fca5a5' : ((dow === 0 || dow === 6) ? '#e9edf2' : '#f1f5f9'));
  sheet.getRange(2, dopCol, 2, 2).setBackground(bg);
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

  for (var m = 1; m <= 12; m++) _dsListMesic(ss, m, z.radky, z.statusyUnik, z.vacAbbr, z.deskAbbr);

  var vychozi = ss.getSheetByName('Sheet1') || ss.getSheetByName('List1');
  if (vychozi && ss.getSheets().length > 1) ss.deleteSheet(vychozi);

  var akt = ss.getSheetByName(_dsNazevMesice(new Date().getMonth() + 1));
  if (akt) ss.setActiveSheet(akt);

  PropertiesService.getDocumentProperties().deleteProperty('DNES_SLOUPEC');
  _dsOznacDnes();
  SpreadsheetApp.getUi().alert('Hotovo — 12 měsíčních listů přegenerováno z listu Uživatelé.');
}

function setupMesic() {
  var z = _dsNactiZdroj();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var m = _dmMesicZListu(ss.getActiveSheet()) || (new Date().getMonth() + 1);
  _dsListMesic(ss, m, z.radky, z.statusyUnik, z.vacAbbr, z.deskAbbr);
  ss.setActiveSheet(ss.getSheetByName(_dsNazevMesice(m)));
  PropertiesService.getDocumentProperties().deleteProperty('DNES_SLOUPEC');
  _dsOznacDnes();
  SpreadsheetApp.getUi().alert('Postaven list ' + _dsNazevMesice(m) + '.');
}

/** Vývoj: stáhne konfigurační tabulky z CORE do skrytých listů „Z_*". Pak setup / modal čtou z nich (rychlé). */
function cachujZdroje() {
  var ui = SpreadsheetApp.getUi();
  var core = SpreadsheetApp.openById(ZDROJ_CORE_ID);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hlaska = [];
  DS_ZDROJ_TABULKY.forEach(function (t) {
    var src = core.getSheetByName(t);
    if (!src) { hlaska.push('– ' + t + ' (v CORE není)'); return; }
    var data = src.getDataRange().getValues();
    var cil = ss.getSheetByName(L_CACHE_PREFIX + t) || ss.insertSheet(L_CACHE_PREFIX + t);
    cil.clear();
    if (data.length && data[0].length) cil.getRange(1, 1, data.length, data[0].length).setValues(data);
    cil.hideSheet();
    hlaska.push('✓ ' + t + '  (' + Math.max(0, data.length - 1) + ' řádků)');
  });
  _dsCacheZrus();
  ui.alert('Zdroje nacachovány do skrytých listů Z_*:\n\n' + hlaska.join('\n') +
    '\n\nSetup i modal teď čtou z cache. Pro čerstvá data spusť znovu, nebo „Smazat cache".');
}

/** Smaže skryté listy Z_* → čtení jde zase živě z CORE. */
function smazCacheZdroju() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var n = 0;
  DS_ZDROJ_TABULKY.forEach(function (t) {
    var sh = ss.getSheetByName(L_CACHE_PREFIX + t);
    if (sh) { ss.deleteSheet(sh); n++; }
  });
  _dsCacheZrus();
  SpreadsheetApp.getUi().alert('Smazáno ' + n + ' cache listů. Zdroje se teď čtou živě z CORE.');
}

/** Hláška o stolech, u kterých se jméno trvalého majitele nedá jednoznačně přiřadit. */
function _dsHlaskaNejasneStoly(nejasne) {
  if (!nejasne || !nejasne.length) return '';
  return '\n\n⚠ U těchto stolů nejde jméno jednoznačně přiřadit (shodná jména v listu Uživatelé):\n' +
    nejasne.map(function (x) { return '   ' + x.stul + ' — ' + x.jmeno + ' (' + x.kolik + ' osob)'; }).join('\n') +
    '\nVypiš k nim ručně user_id do skrytého sloupce trvale_uid v listu Stoly.';
}

/** Jen zajistí pomocné listy a přegeneruje Mapu — bez měsíčních listů. */
function vytvorPomocneListy() {
  _dsNactiZdroj();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var stav = [L_UZIV, L_PORADI, L_STATUSY, L_STOLY, L_REZERVACE, L_MAPA].map(function (n) {
    var sh = ss.getSheetByName(n);
    var radku = sh ? Math.max(0, sh.getLastRow() - 1) : 0;
    return (sh ? '✓ ' : '– ') + n + (sh ? '  (' + radku + ' řádků)' : '  chybí');
  }).join('\n');
  SpreadsheetApp.getUi().alert('Pomocné listy:\n\n' + stav +
    _dsHlaskaNejasneStoly(_dsDoplnTrvaleUid(ss)) +
    '\n\nMěsíční listy zůstaly beze změny.');
}

/** Přegeneruje list Stoly z OFFICE_MAPS živé aplikace (zachová ruční Aktivní/Trvale podle cell_id). */
function aktualizujStoly() {
  if (ZDROJ_CORE_ID.indexOf('VLOZ') !== -1) throw new Error('Nastav ZDROJ_CORE_ID nahoře ve skriptu.');
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Přegenerovat list Stoly z aplikace?\n\nStoly se natáhnou znovu z OFFICE_MAPS včetně pozic Řádek/Sloupec. Ruční úpravy sloupců Aktivní a Trvale se zachovají podle cell_id, nové stoly se doplní.',
    ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var usek = _dsUsekZAplikace();
  var usersById = {};
  _dsZdroj('USERS').forEach(function (u) { usersById[u.user_id] = _dsJmeno(u); });

  var pocet = _dsStolyZAplikace(ss, usek, usersById);
  _dsListMapa(ss);
  ui.alert('List Stoly přegenerován — ' + (pocet || 0) + ' stolů. List Mapa aktualizován.' +
    _dsHlaskaNejasneStoly(_dsDoplnTrvaleUid(ss)) +
    (ss.getSheetByName('Z_OFFICE_MAPS') ? '\n\n(Čteno z cache Z_*. Pro živá data „Smazat cache zdrojů".)' : ''));
}

/**
 * JEDNORÁZOVĚ: naplní lokální listy vším, co se dosud četlo z živé aplikace,
 * takže sešit dál funguje sám. Konkrétně:
 *   Uživatelé — doplní chybějící lidi úseku z USERS (existující řádky nechá),
 *   Statusy   — přepíše z ATTENDANCE_STATUSES (od téhle chvíle je to zdroj pravdy),
 *   Stoly     — přepíše z OFFICE_MAPS včetně pozic Řádek/Sloupec,
 *   Mapa      — přegeneruje z listu Stoly.
 * Docházku a rezervace natáhni potom zvlášť (📥 a 🪑).
 */
function odpojOdAplikace() {
  if (ZDROJ_CORE_ID.indexOf('VLOZ') !== -1) throw new Error('Nastav ZDROJ_CORE_ID nahoře ve skriptu.');
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Naplnit lokální listy z aplikace?\n\n' +
    '• Uživatelé — doplní chybějící lidi úseku (existující řádky zůstanou)\n' +
    '• Statusy — PŘEPÍŠE z ATTENDANCE_STATUSES\n' +
    '• Stoly — PŘEPÍŠE z OFFICE_MAPS včetně pozic v mapě\n' +
    '• Mapa — přegeneruje\n\n' +
    'Potom už sešit čte všechno jen ze sebe.', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var usek = _dsUsekZAplikace();
  var usersById = {};
  _dsZdroj('USERS').forEach(function (u) { usersById[u.user_id] = _dsJmeno(u); });

  _dsListUzivatele(ss, _dsLideZAplikace(usek));
  var lide = _dsCtiUzivatele(ss);
  var statusy = _dsStatusyZAplikace();
  _dsListStatusy(ss, statusy);
  var stolu = _dsStolyZAplikace(ss, usek, usersById);
  _dsListPoradi(ss, lide);
  _dsListRezervace(ss);
  _dsListMapa(ss);

  var bezPozice = _dsCtiStoly(ss).filter(function (s) { return s.radek < 0 || s.sloupec < 0; }).length;
  var desk = _dsDeskAbbr(ss);
  ui.alert('Listy naplněny:\n\n' +
    '✓ ' + L_UZIV + '  (' + lide.length + ' lidí)\n' +
    '✓ ' + L_STATUSY + '  (' + statusy.length + ' statusů' +
    (desk.length ? ', stůl vyžadují: ' + desk.join(', ') : ', žádný nevyžaduje stůl') + ')\n' +
    '✓ ' + L_STOLY + '  (' + stolu + ' stolů' + (bezPozice ? ', z toho ' + bezPozice + ' bez pozice v mapě' : '') + ')\n' +
    '✓ ' + L_MAPA + '\n' +
    _dsHlaskaNejasneStoly(_dsDoplnTrvaleUid(ss)) +
    '\n\nTeď ještě jednou natáhni historii: 📥 Načíst docházku a 🪑 Načíst rezervace stolů.\n' +
    'Pak už aplikaci nepotřebuješ — ověř provoz a dej vědět, ať se podmenu „🧳 Z aplikace" smaže.');
}
