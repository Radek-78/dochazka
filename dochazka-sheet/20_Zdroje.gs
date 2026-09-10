// ════════════════════════════════════════════════════════════════════
//  20_Zdroje.gs — Čtení tabulek z CORE / TRANSACTION (+ lokální cache Z_*).
// ════════════════════════════════════════════════════════════════════


// ── listy Stoly a Rezervace ─────────────────────────────────────────────

/** Aktivní kancelářská mapa úseku z OFFICE_MAPS → { name, rows, cols, desks:[{id,label,row,col,permUid}] } nebo null. */
function _dsNactiMapu(usek) {
  var m = _dsZdroj('OFFICE_MAPS').filter(function (x) {
    return x.section_id === usek.section_id && String(x.active) !== 'false';
  })[0];
  if (!m) return null;
  var cells = [];
  try { cells = JSON.parse(m.cells_json || '[]'); } catch (e) { cells = []; }
  var desks = cells.filter(function (c) { return String(c.type) === 'desk'; }).map(function (c) {
    return {
      id: c.id || '', label: c.label || c.id || '',
      row: Math.max(0, Number(c.row) || 0), col: Math.max(0, Number(c.col) || 0),
      permUid: c.permanent_user_id || ''
    };
  });
  function maxPlus1(f) { return desks.reduce(function (a, d) { return Math.max(a, f(d)); }, -1) + 1; }
  return {
    name: m.name || 'Kancelář',
    rows: Number(m.rows) || maxPlus1(function (d) { return d.row; }) || 1,
    cols: Number(m.cols) || maxPlus1(function (d) { return d.col; }) || 1,
    desks: desks
  };
}

/** Zkratky statusů, které vyžadují rezervaci stolu (allows_desk_reservation). */
function _dsDeskAbbr() {
  var out = [];
  _dsZdroj('ATTENDANCE_STATUSES').forEach(function (s) {
    var a = String(s.abbreviation || '').trim();
    if (a && String(s.allows_desk_reservation) === 'true' && out.indexOf(a) === -1) out.push(a);
  });
  return out;
}

/**
 * Najde tabulku podle víc možných názvů napříč víc sešity. Vrací {rows, zdroj}.
 * Nalezené místo si zapamatuje do DocumentProperties (`propKlic`), takže příště
 * jde rovnou tam místo prohledávání až 10 kombinací sešit × název.
 */
function _dsCtiKdekoliv(sesity, nazvy, propKlic) {
  var props = propKlic ? PropertiesService.getDocumentProperties() : null;

  function zkus(sesit, nazev) {
    var sh = sesit.ss.getSheetByName(nazev);
    if (!sh || sh.getLastRow() < 2) return null;
    if (props) props.setProperty(propKlic, sesit.jmeno + '|' + nazev);
    return { rows: _dsCtiSheet(sh), zdroj: sesit.jmeno + ' → ' + nazev };
  }

  // 1) zapamatovaná kombinace
  var znama = props ? props.getProperty(propKlic) : null;
  if (znama) {
    var p = znama.split('|');
    var sesit = sesity.filter(function (s) { return s.jmeno === p[0]; })[0];
    if (sesit) {
      var hit = zkus(sesit, p[1]);
      if (hit) return hit;
      props.deleteProperty(propKlic);   // přesunulo se / vyprázdnilo → hledej znovu
    }
  }

  // 2) plné hledání
  for (var i = 0; i < sesity.length; i++) {
    for (var j = 0; j < nazvy.length; j++) {
      var hit2 = zkus(sesity[i], nazvy[j]);
      if (hit2) return hit2;
    }
  }
  return { rows: [], zdroj: '' };
}

// ── společné pomocné funkce ──────────────────────────────────────────────

// ── cache zdrojů z CORE (jen pro vývoj: „Cachovat zdroje z aplikace") ──
// Seznam tabulek je nahoře u konstant (DS_ZDROJ_TABULKY).
var _DS_CORE = null;
function _dsCore() {
  if (!_DS_CORE) {
    if (ZDROJ_CORE_ID.indexOf('VLOZ') !== -1) throw new Error('Nastav ZDROJ_CORE_ID nahoře ve skriptu.');
    _DS_CORE = SpreadsheetApp.openById(ZDROJ_CORE_ID);
  }
  return _DS_CORE;
}
/** Čte tabulku z CORE — přednostně z lokální cache „Z_<název>", jinak živě z CORE (1× za běh). */
function _dsZdroj(name) {
  return _dsCache('ZDROJ_' + name, function () {
    var lok = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(L_CACHE_PREFIX + name);
    if (lok && lok.getLastRow() >= 2) return _dsCtiSheet(lok);
    return _dsCtiSheet(_dsCore().getSheetByName(name));
  });
}

/**
 * Základ pro všechna čtení listu s hlavičkou v 1. řádku.
 *   data  — 2D pole včetně hlavičky
 *   H     — { názevSloupce: index }
 *   v(r, nazev) — hodnota sloupce z řádku (prázdný řetězec, když sloupec chybí)
 *   radky — [{ radek: číslo řádku v listu, r: pole hodnot }] bez hlavičky
 */
function _dsTabulka(sh) {
  var prazdna = { data: [], H: {}, v: function () { return ''; }, radky: [] };
  if (!sh) return prazdna;
  var data = sh.getDataRange().getValues();
  if (!data.length) return prazdna;
  var H = {};
  data[0].forEach(function (h, i) { H[String(h).trim()] = i; });
  var radky = [];
  for (var i = 1; i < data.length; i++) radky.push({ radek: i + 1, r: data[i] });
  return {
    data: data, H: H, radky: radky,
    v: function (r, nazev) { return H[nazev] === undefined ? '' : r[H[nazev]]; }
  };
}

/** Hodnota buňky → text (Date na ISO, ořez apostrofu a mezer). */
function _dsBunka(val, tz) {
  if (val instanceof Date && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, tz, "yyyy-MM-dd'T'HH:mm:ss");
  }
  return (val === null || val === undefined) ? '' : String(val).replace(/^'/, '').trim();
}

/**
 * Jako _dsCtiSheet, ale načte jen souvislý úsek sloupců pokrývající požadovaná
 * jména. U širokých tabulek (ATTENDANCE má i note / created_at / work_start_time)
 * tím znatelně klesne objem přenášených dat.
 */
function _dsCtiSloupce(ss, listName, sloupce) {
  var sh = ss.getSheetByName(listName);
  if (!sh) return [];
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  if (lastR < 2 || lastC < 1) return [];

  var head = sh.getRange(1, 1, 1, lastC).getValues()[0].map(function (h) { return String(h).trim(); });
  var chci = [], min = lastC, max = 1;
  sloupce.forEach(function (n) {
    var i = head.indexOf(n);
    if (i === -1) return;
    chci.push({ jmeno: n, col: i + 1 });
    if (i + 1 < min) min = i + 1;
    if (i + 1 > max) max = i + 1;
  });
  if (!chci.length) return [];

  var data = sh.getRange(2, min, lastR - 1, max - min + 1).getValues();
  var tz = Session.getScriptTimeZone();
  return data.map(function (r) {
    var o = {};
    for (var k = 0; k < chci.length; k++) o[chci[k].jmeno] = _dsBunka(r[chci[k].col - min], tz);
    return o;
  });
}

function _dsCtiSheet(sh) {
  var t = _dsTabulka(sh);
  if (!t.radky.length) return [];
  var head = t.data[0];
  var tz = Session.getScriptTimeZone();          // dřív se volalo pro KAŽDOU datumovou buňku
  return t.radky.map(function (x) {
    var o = {};
    for (var i = 0; i < head.length; i++) o[head[i]] = _dsBunka(x.r[i], tz);
    return o;
  });
}
