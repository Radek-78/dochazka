// ════════════════════════════════════════════════════════════════════
//  90_Utils.gs — Drobné sdílené pomocné funkce.
// ════════════════════════════════════════════════════════════════════

function _dsJmeno(u) {
  return ((u.last_name || '') + ' ' + (u.first_name || '')).trim();
}

function _dsJeVedouci(u) {
  var sr = String(u.system_role || '').toUpperCase();
  var or_ = String(u.org_role || '').toUpperCase();
  return sr === 'ADMIN' || sr === 'SUPERADMIN' || sr === 'LEADER'
    || or_ === 'SECTION_LEADER' || or_ === 'SECTION_DEPUTY'
    || or_ === 'DEPT_LEADER' || or_ === 'DEPT_DEPUTY';
}

function _dsNazevMesice(mesic) {
  return (mesic < 10 ? '0' : '') + mesic + ' ' + DS_MESICE[mesic - 1];
}

function _dsHex(val, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(val || '')) ? String(val) : fallback;
}

/** Zesvětlí hex barvu směrem k bílé; k = podíl bílé (0 = beze změny, 1 = bílá). */
function _dsSvetleji(hex, k) {
  var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  var f = Math.max(0, Math.min(1, k));
  var out = '#';
  for (var i = 1; i <= 3; i++) {
    var v = Math.round(parseInt(m[i], 16) + (255 - parseInt(m[i], 16)) * f);
    out += ('0' + v.toString(16)).slice(-2);
  }
  return out;
}

function _dsFont(sheet) {
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).setFontFamily(DS_FONT);
}

/** Datum ze živé DB → "yyyy-MM-dd" nebo '' pro zápis do listu. */
function _dsFmtDatum(v) {
  var d = _dsParseDatum(v);
  if (!d) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Hodnota z buňky/DB → Date nebo null. */
function _dsParseDatum(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v || '').trim();
  if (!s) return null;
  s = s.replace(/^'/, '');
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Státní svátky ČR pro rok → { "MM-DD": "název" }. */
function _dsSvatkyCR(rok) {
  var m = {
    '01-01': 'Nový rok / Den obnovy samostatného českého státu',
    '05-01': 'Svátek práce',
    '05-08': 'Den vítězství',
    '07-05': 'Den slovanských věrozvěstů Cyrila a Metoděje',
    '07-06': 'Den upálení mistra Jana Husa',
    '09-28': 'Den české státnosti',
    '10-28': 'Den vzniku samostatného československého státu',
    '11-17': 'Den boje za svobodu a demokracii',
    '12-24': 'Štědrý den',
    '12-25': '1. svátek vánoční',
    '12-26': '2. svátek vánoční'
  };
  var e = _dsVelikonoce(rok);
  m[e.patek] = 'Velký pátek';
  m[e.pondeli] = 'Velikonoční pondělí';
  return m;
}

/** Velikonoce (Meeus/Jones/Butcher) → { patek:"MM-DD", pondeli:"MM-DD" }. */
function _dsVelikonoce(rok) {
  var a = rok % 19, b = Math.floor(rok / 100), c = rok % 100;
  var dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  var g = Math.floor((b - f + 1) / 3), h = (19 * a + b - dd - g + 15) % 30;
  var ii = Math.floor(c / 4), k = c % 4;
  var l = (32 + 2 * e + 2 * ii - h - k) % 7;
  var mm = Math.floor((a + 11 * h + 22 * l) / 451);
  var mesic = Math.floor((h + l - 7 * mm + 114) / 31);
  var den = ((h + l - 7 * mm + 114) % 31) + 1;
  var nedele = new Date(rok, mesic - 1, den);
  function fmt(x) { return ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); }
  var patek = new Date(nedele); patek.setDate(patek.getDate() - 2);
  var pondeli = new Date(nedele); pondeli.setDate(pondeli.getDate() + 1);
  return { patek: fmt(patek), pondeli: fmt(pondeli) };
}
