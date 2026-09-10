# Docházkový sheet (samostatný, varianta „modal v Sheetu")

Kód pro **bound skript vygenerovaného docházkového spreadsheetu** — není součástí
živé aplikace (proto je `dochazka-sheet/**` v `.claspignore`).

## Struktura souborů

Apps Script sdílí mezi soubory jeden globální scope, takže rozdělení je čistě
kvůli orientaci. Pořadí načítání řídí `filePushOrder` v `.clasp.json`.

| soubor | obsah |
|---|---|
| `00_Konfig.gs` | konstanty (`ZDROJ_*`, `USEK_NAZEV`, `ROK`, názvy listů `L_*`), geometrie mřížky `_g*`, cache čtení na jeden běh |
| `10_Menu.gs` | menu, vstupní body (`setup`, `setupMesic`, …), označení dnešního sloupce |
| `20_Zdroje.gs` | čtení tabulek z CORE / TRANSACTION + lokální cache `Z_*` |
| `30_PomocneListy.gs` | listy Uživatelé, Pořadí, Stoly, Mapa, Rezervace + uspořádání řádků |
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

## Jednorázové nastavení

1. Vytvoř nový prázdný Google Sheet.
2. Rozšíření → Apps Script → nahraj obsah této složky (nebo `clasp push`).
3. Služby (+) → **Google Sheets API** → Přidat (dávkové rozměry a rámečky;
   bez ní kód funguje taky, jen pomaleji).
4. V `00_Konfig.gs` nastav:
   - `ZDROJ_CORE_ID` — ID CORE DB živé appky (Apps Script živé appky → Nastavení
     projektu → Vlastnosti skriptu → `SPREADSHEET_CORE_ID`),
   - `ZDROJ_TRANSACTION_ID` — dtto `SPREADSHEET_TRANSACTION_ID`,
   - `USEK_NAZEV` — přesný název úseku.
5. Ulož, obnov spreadsheet, menu **📋 Docházka → 🔄 Postavit / obnovit všechny měsíce**.
   Napoprvé odsouhlas oprávnění.

Pro další úsek = kopie tohoto sešitu + změna `USEK_NAZEV` + znovu „Postavit / obnovit".

## Postup při běžném provozu

1. **🔄 Postavit / obnovit všechny měsíce** — struktura listů.
2. Zkontroluj `Uživatelé`, `Pořadí`, `Stoly`.
3. **📥 Načíst docházku z aplikace** — jen `ATTENDANCE`.
4. **🪑 Načíst rezervace stolů z aplikace** — jen `MAP_RESERVATIONS`.
5. Dál už jen **📝 Zadat můj měsíc**.

Při vývoji: **🧩 Pomocné listy → 💾 Cachovat zdroje z aplikace** udělá snapshot
CORE do skrytých listů `Z_*`, takže `setup` neotevírá CORE vůbec. Zpět na živá
data přes „🗑 Smazat cache zdrojů".
