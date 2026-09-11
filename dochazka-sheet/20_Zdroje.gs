// ════════════════════════════════════════════════════════════════════
//  20_Zdroje.gs — JEDINÉ místo, které sahá do sešitů živé aplikace.
//
//  Používá se výhradně z podmenu „🧳 Z aplikace" (jednorázové naplnění
//  lokálních listů + import historie). Běžný provoz sem nechodí — až se
//  aplikace smaže, zmizí tenhle soubor spolu s 60_Import.gs.
// ════════════════════════════════════════════════════════════════════


// ── jednorázové čtení konfigurace z aplikace ────────────────────────────

/** Řádek úseku USEK_NAZEV ze SECTIONS (jinak vyhodí chybu). */
function _dsUsekZAplikace() {
  var usek = _dsZdroj('SECTIONS').filter(function (s) {
    return s.name === USEK_NAZEV && String(s.active) !== 'false';
  })[0];
  if (!usek) throw new Error('Úsek "' + USEK_NAZEV + '" nenalezen v SECTIONS.');
  return usek;
}

/** Aktivní lidé úseku z USERS, s dopočtenými názvy oddělení / týmu / pozice. */
function _dsLideZAplikace(usek) {
  var oddMap = {};
  _dsZdroj('DEPARTMENTS').forEach(function (d) { oddMap[d.department_id] = d.name || ''; });
  var tymMap = {};
  _dsZdroj('GROUPS').forEach(function (g) { tymMap[g.group_id] = g.name || ''; });
  var pozMap = {};
  _dsZdroj('POSITIONS').forEach(function (p) { pozMap[p.position_id] = p.name || ''; });

  var dnes = new Date();
  dnes.setHours(0, 0, 0, 0);
  return _dsZdroj('USERS')
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
}

/**
 * Odhad role podle rolí v aplikaci — jen první nástřel pro list Uživatelé,
 * dál se role spravuje ručně ve sloupci Role.
 */
function _dsRoleZAplikace(u) {
  var sr = String(u.system_role || '').toUpperCase();
  var or_ = String(u.org_role || '').toUpperCase();
  if (sr === 'ADMIN' || sr === 'SUPERADMIN') return R_SPRAVCE;
  if (or_ === 'SECTION_LEADER' || or_ === 'SECTION_DEPUTY') return R_WGL;
  if (or_ === 'DEPT_LEADER' || or_ === 'DEPT_DEPUTY') return R_AL;
  return '';
}

/** ATTENDANCE_STATUSES → řádky pro lokální list Statusy (bez duplicitních zkratek). */
function _dsStatusyZAplikace() {
  var videno = {}, out = [];
  _dsZdroj('ATTENDANCE_STATUSES').forEach(function (s) {
    var ab = String(s.abbreviation || '').trim();
    if (!ab || videno[ab]) return;
    videno[ab] = 1;
    out.push([
      ab, s.name || '', _dsHex(s.color, '#94a3b8'), _dsHex(s.text_color, '#ffffff'),
      String(s.is_vacation) === 'true' ? 'ano' : '',
      String(s.allows_desk_reservation) === 'true' ? 'ano' : '',
      String(s.active) === 'false' ? '' : 'ano'
    ]);
  });
  return out;
}

/** Aktivní kancelářská mapa úseku z OFFICE_MAPS → { name, desks:[{id,label,row,col,permUid}] } nebo null. */
function _dsMapaZAplikace(usek) {
  var m = _dsZdroj('OFFICE_MAPS').filter(function (x) {
    return x.section_id === usek.section_id && String(x.active) !== 'false';
  })[0];
  if (!m) return null;
  var cells = [];
  try { cells = JSON.parse(m.cells_json || '[]'); } catch (e) { cells = []; }
  return {
    name: m.name || 'Kancelář',
    desks: cells.filter(function (c) { return String(c.type) === 'desk'; }).map(function (c) {
      return {
        id: c.id || '', label: c.label || c.id || '',
        row: Math.max(0, Number(c.row) || 0), col: Math.max(0, Number(c.col) || 0),
        permUid: c.permanent_user_id || ''
      };
    })
  };
}

/**
 * Přegeneruje lokální list Stoly z OFFICE_MAPS — včetně pozic Řádek/Sloupec,
 * díky kterým pak mapa funguje bez aplikace. Ruční Aktivní / Trvale se
 * zachovají podle cell_id. Vrací počet stolů.
 */
function _dsStolyZAplikace(ss, usek, usersById) {
  var sh = _dsSeedStoly(ss);
  var mapa = _dsMapaZAplikace(usek);
  var W = DS_STOLY_HLAVICKA.length;

  var stare = {};
  _dsCtiStoly(ss).forEach(function (s) { if (s.cell_id) stare[s.cell_id] = s; });

  var radky = (mapa ? mapa.desks : []).map(function (c) {
    var id = c.id || '';
    var st = stare[id];
    return [
      c.label || id || '',
      st ? st.trvale : (c.permUid ? (usersById[c.permUid] || '') : ''),
      st ? (st.aktivni ? 'ano' : '') : 'ano',
      c.row, c.col, id,
      st ? st.trvaleUid : (c.permUid || '')
    ];
  });

  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, W).clearContent();
  if (radky.length) sh.getRange(2, 1, radky.length, W).setValues(radky);
  _dsFont(sh);
  _dsCacheZrus('STOLY');
  _dsDoplnTrvaleUid(ss);
  if (mapa && mapa.name) PropertiesService.getDocumentProperties().setProperty('MAPA_NAZEV', mapa.name);
  return radky.length;
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
