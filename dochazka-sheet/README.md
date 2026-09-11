# Docházkový sheet (samostatný, varianta „modal v Sheetu")

Kód pro **bound skript vygenerovaného docházkového spreadsheetu** — není součástí
živé aplikace (proto je `dochazka-sheet/**` v `.claspignore`).

> **Běžný provoz nesahá nikam ven.** Všechna data čte sešit ze svých vlastních
> listů. Do sešitů živé aplikace sahá jen podmenu **🧳 Z aplikace** — jednorázové
> naplnění listů a import historie. Až se aplikace vypne, smažou se soubory
> `20_Zdroje.gs` a `60_Import.gs` plus to podmenu a zbytek funguje dál.

## Struktura souborů

Apps Script sdílí mezi soubory jeden globální scope, takže rozdělení je čistě
kvůli orientaci. Pořadí načítání řídí `filePushOrder` v `.clasp.json`.

| soubor | obsah |
|---|---|
| `00_Konfig.gs` | konstanty (`ZDROJ_*`, `USEK_NAZEV`, `ROK`, názvy listů `L_*`), geometrie mřížky `_g*`, cache čtení na jeden běh |
| `10_Menu.gs` | menu, vstupní body (`setup`, `setupMesic`, `odpojOdAplikace`, …), označení dnešního sloupce |
| `20_Zdroje.gs` | **jediné místo sahající do aplikace** — jednorázové naplnění listů + cache `Z_*` |
| `30_PomocneListy.gs` | listy Uživatelé, Pořadí, Statusy, Stoly, Mapa, Rezervace + uspořádání řádků |
| `40_Builder.gs` | stavba měsíčního listu, fast-path, dávkové operace přes Sheets API |
| `50_Stoly.gs` | rezervace stolů — indikace v mřížce a pravidla vlastnictví |
| `60_Import.gs` | import docházky a rezervací ze živé aplikace |
| `70_Modal.gs` | serverové funkce modalu „Zadat můj měsíc" |
| `90_Utils.gs` | drobné sdílené pomocné funkce (datum, barvy, svátky) |
| `Modal.html` | klient modalu |
| `appsscript.json` | manifest — deklaruje závislost na **Sheets API v4** |

## Geometrie měsíčního listu

- Každý **den = 3 sloupce**: dopoledne, odpoledne, 1px mezera (`DS_DEN_KROK`).
- Každý **logický řádek = 2 fyzické**: data + 1px mezera pod ním.
- `A` = jméno, `B` = 1px mezera, `C` = den 1 dopoledne (`DS_DEN1_COL = 3`).
- Řádek 4 je 1px mezera pod zmraženou hlavičkou, data začínají na 5.

**Indexy nikdy nepočítej ručně** — použij `_gDop(d)`, `_gSouhrn(N)`, `_gUid(N)`,
`_gRadek(j)`, `_gDenZeSloupce(col)`. Při změně struktury bumpni `DS_BUILD_VER`
v `40_Builder.gs` (je v podpisu pro fast-path, jinak se listy nepřestaví).

## Zdroje pravdy (lokální listy)

| list | co v něm je |
|---|---|
| `Uživatelé` | lidé: `Jméno · Oddělení · Tým · Pozice · E-mail · Vedoucí · Od · Do · user_id` |
| `Pořadí` | řazení: jména nahoru, pořadí oddělení, pořadí týmů |
| `Statusy` | `Zkratka · Název · Barva · Barva textu · Dovolená · Vyžaduje stůl · Aktivní` |
| `Stoly` | `Stůl · Trvale (jméno) · Aktivní · Řádek · Sloupec · cell_id · trvale_uid` |
| `Rezervace` | `Datum · Stůl · Jméno · user_id` |
| `Mapa` | jen náhled — přegeneruje se ze `Stoly` (podle `Řádek`/`Sloupec`) |

`Řádek`/`Sloupec` jsou 0-based pozice v mapě; stůl s prázdnou pozicí se v mapě
nekreslí, ale rezervovat se dá. Rozměry mapy se dopočtou z nejvyšší pozice.

## Jednorázové nastavení

1. Vytvoř nový prázdný Google Sheet.
2. Rozšíření → Apps Script → nahraj obsah této složky (nebo `clasp push`).
3. Služby (+) → **Google Sheets API** → Přidat (dávkové rozměry a rámečky;
   bez ní kód funguje taky, jen pomaleji).
4. V `00_Konfig.gs` nastav `USEK_NAZEV` (přesný název úseku) a — dokud aplikace
   ještě žije — `ZDROJ_CORE_ID` / `ZDROJ_TRANSACTION_ID` (Apps Script živé appky
   → Nastavení projektu → Vlastnosti skriptu → `SPREADSHEET_CORE_ID`,
   `SPREADSHEET_TRANSACTION_ID`).
5. Ulož, obnov spreadsheet a v menu **📋 Docházka**:
   1. **🧳 Z aplikace → 🧳 Naplnit listy z aplikace** — naplní `Uživatelé`,
      `Statusy`, `Stoly` (včetně pozic) a `Mapa`. Napoprvé odsouhlas oprávnění.
   2. **🔄 Postavit / obnovit všechny měsíce**.
   3. **🧳 Z aplikace → 📥 Načíst docházku** a **🪑 Načíst rezervace stolů**.

Bez živé aplikace: naplň `Uživatelé`, `Statusy` a `Stoly` ručně a rovnou spusť
**🔄 Postavit / obnovit všechny měsíce**.

Pro další úsek = kopie tohoto sešitu + změna `USEK_NAZEV` + úprava lokálních listů.

## Postup při běžném provozu

1. Změny lidí / statusů / stolů piš přímo do listů `Uživatelé`, `Statusy`, `Stoly`.
2. **🔄 Postavit / obnovit všechny měsíce** (nebo **📅 jen tento měsíc**) —
   struktura beze změny se přeskočí přes podpis v `DocumentProperties`.
3. Dál už jen **📝 Zadat můj měsíc**.

Při vývoji: **🧳 Z aplikace → 💾 Cachovat zdroje z aplikace** udělá snapshot CORE
do skrytých listů `Z_*`, takže i import neotevírá CORE. Zpět na živá data přes
„🗑 Smazat cache zdrojů".
