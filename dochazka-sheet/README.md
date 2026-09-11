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
| `Navod.html` | návod pro uživatele — šablona, do které `otevriNavod` vloží roli a skutečné statusy |
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
| `Uživatelé` | lidé: `Jméno · Oddělení · Tým · Pozice · E-mail · Vedoucí · Role · Od · Do · user_id` |
| `Pořadí` | řazení: jména nahoru, pořadí oddělení, pořadí týmů |
| `Statusy` | `Zkratka · Název · Barva · Barva textu · Dovolená · Vyžaduje stůl · Citlivý · Náhrada · Aktivní` |
| `Citlivé` | skrytý: `Datum · user_id · Dopoledne · Odpoledne` — skutečné zkratky citlivých statusů |
| `Nastavení` | `Klíč · Hodnota` — zatím jen `Rok`, pro který je sešit |
| `Stoly` | `Stůl · Trvale (jméno) · Aktivní · Řádek · Sloupec · cell_id · trvale_uid` |
| `Rezervace` | `Datum · Stůl · Jméno · user_id` |
| `Mapa` | jen náhled — přegeneruje se ze `Stoly` (podle `Řádek`/`Sloupec`) |

`Řádek`/`Sloupec` jsou 0-based pozice v mapě; stůl s prázdnou pozicí se v mapě
nekreslí, ale rezervovat se dá. Rozměry mapy se dopočtou z nejvyšší pozice.

## Sloupec Dovolená

Buňka nese **tři čísla**: `za měsíc · od 1. 1. do dneška · za celý rok`
(`_dsCislaDovolene` / `_dsParsujDovolenou`). Vzorcem to nejde — půlden se od
celého dne pozná jen podle sloučení buněk, což tabulkové funkce neumí.

- **Zdroj pravdy** je `_dsPrepocitejDovolenou(ss)`: přečte všech 12 listů a
  přepíše sloupec ve všech měsících. Volá ho `setup`, `setupMesic`, import
  a menu **🧮 Přepočítat dovolenou**.
- **Při uložení dne** posílá tři čísla klient — zná celý měsíc i to, co v buňce
  stálo, takže roční a „k dnešku" jen poposune o rozdíl. Server tedy kvůli
  souhrnům nečte 12 listů (bylo by to ~11 s).
- „Dnešek" posílá server v `dm_init` jako `dnes: {mesic, den}`, ať klient
  nepočítá podle hodin prohlížeče.

> Dopočítávání může zastarat — po ručním zásahu do mřížky nebo po přelomu dne.
> Srovná to 🧮 Přepočítat dovolenou.

## Barvy statusů v mřížce

Buňka dostane **plnou barvu statusu** a jeho **`Barva textu`** — přesně to, co
je vidět ve sloupci `Zkratka` v listu `Statusy` (`_dsObarviStatusy` ho obarvuje
stejným výpočtem, takže se to nemůže rozejít).

- **Pozadí** dělá podmíněné formátování (`_dsListMesic`).
- **Barva písma** se nastavuje **přímo**, ne přes CF. Podmíněné formátování by
  přebilo červené písmo u kancelářského dne bez rezervace stolu.
- Mapa `{ zkratka: {bg, fg} }` je v `_dsStatusMapa` vedle náhrad citlivých
  statusů, drží se v `DocumentProperties` → uložení dne kvůli barvám nečte list.

**Kancelářský den bez rezervace** dostane červenou zkratku i červený rámeček.
Rámečky kreslí `_dmObnovStulyList`, a to ve třech režimech: `'nove'` (čerstvý
list — jen červené, není co mazat), `'plne'` (i úklid starých) a `'jen_pismo'`.
Stavba listu používá `'nove'` — dřív běžela s `'jen_pismo'` a rámečky doplňoval
až import, takže po přestavbě chyběly.

> ⚠ **`setBorder(…, vertical, horizontal, …)`**: `false` vnitřní ohraničení
> **SMAŽE**, `null` ho nechá být. Vnější rám listu i rámy oddělení proto musí
> mít `null` — s `false` smazaly červené rámečky buněk. A indikace stolů se
> kreslí **až po nich**, ať ji nic nepřekreslí. Výjimka je dvojice půldnů
> (1×2), kde `false` správně odstraní dělicí čáru uprostřed.

`DS_CHIP_TON` v `00_Konfig.gs` přepíná vzhled: `0` = plná barva (výchozí),
`0.5–0.85` = jemný tón na bílé s tmavým textem. Je součástí podpisu listu,
takže změna vynutí přestavbu měsíců.

## Rok sešitu a nový rok

`ROK` je **uložená hodnota** (list `Nastavení`, řádek `Rok`), ne
`new Date().getFullYear()`. Jinak by se sešit 1. ledna sám přepnul na nový rok,
měsíční listy by se přestavěly na jiné dny v týdnu a loňská docházka by se
rozsypala. Takhle zůstane loňský sešit loňským — archivem.

`_dsRok()` cachuje hodnotu do `DocumentProperties` jako `"<rok>|<id sešitu>"`.
Kopie sešitu má jiné ID, takže si rok přečte z listu znovu a **sama se opraví**
i v případě, že by se properties zkopírovaly.

**📆 Vytvořit sešit pro nový rok** (`vytvorSesitProRok`, jen správce):

1. Zkopíruje soubor přes `DriveApp` do stejné složky — **jedině tak se
   zkopíruje i tenhle bound skript**, takže kopie rovnou funguje.
2. Přenese sdílení (editory i prohlížeče).
3. `_dsPripravRok` v kopii nastaví rok, vyčistí `Rezervace` a `Citlivé`
   a smaže měsíční listy.
4. Měsíce si postaví **kopie sama** přes 🔄 — stavěly by se jinak podle roku
   toho skriptu, co kopii vyrábí.

Podpisy fast-path (`PODPIS_<m>`) řešit netřeba — rok je součástí hashe, takže
kopie se přestaví i kdyby se properties přenesly.

> ⚠ `DriveApp` znamená **oprávnění k Disku**. Po nasazení se všem uživatelům
> jednou objeví obrazovka se schvalováním přístupu.

## Role

Sloupec `Role` v listu `Uživatelé` (prázdné = `uživatel`):

Role rozhoduje o **dvou nezávislých věcech**:

**1. Co je vidět v menu** (`Role` samotná):

| role | menu |
|---|---|
| `uživatel`, `AL`, `WGL` | jen „📝 Zadat docházku" |
| `správce` | + přestavba listů, pomocné listy, import z aplikace |

**2. Čí docházku smí zadávat a u koho vidí skutečné citlivé statusy**
(`_dmRozsah` → `_dmVKompetenci`) — jedno pravidlo pro zadávání i pro vidění:

| role | rozsah |
|---|---|
| `uživatel` | jen sebe |
| `AL` | své oddělení |
| `WGL` | všechny |
| `správce` | **podle sloupce `Pozice`**: `Vedoucí úseku` → všechny, `Vedoucí oddělení` → své oddělení, jinak jen sebe |

Role `správce` je tedy čistě technická — dává přístup k menu, ne k cizí docházce.
Správce, který je řadový zaměstnanec, zůstává u své vlastní.

Sloupec `Vedoucí` je něco jiného — řídí jen pořadí řádků a oranžové podbarvení.

> ⚠ **Není to bezpečnostní hranice.** Kdo smí sešit editovat, může psát přímo do
> buněk, otevřít Apps Script nebo si v listu `Uživatelé` přepsat roli. Role jsou
> pro pohodlí a proti omylům, ne jako zámek.

Identita se **vždy** odvozuje ze `Session.getActiveUser()`, nikdy z toho, co
pošle klient (`_dmJa` → `_dmCil`). Kdo smí zadávat za koho, řeší `_dmVKompetenci`.
Zjištěná identita se ukládá do `UserProperties`, aby každé uložení dne nemuselo
kvůli kontrole číst list; obnoví se při každém otevření modalu — **změna role se
tedy projeví až po dalším otevření**.

Dvě pojistky proti zamčení sešitu (`_dmVyzadujSpravce`): prázdný list `Uživatelé`
a stav, kdy roli `správce` nemá vůbec nikdo — v obou případech se položky menu
nezamykají.

**Menu** staví `_dmRoleProMenu` — čte roli **přímo z listu**, aby se změna
projevila hned po obnovení sešitu. `onOpen` je jednoduchý trigger, takže identita
v něm jde zjistit až potom, co uživatel skriptu povolil přístup; dokud se to
nepovede, použije se poslední známá role z `UserProperties`, a když není ani ta,
má menu jen „📝 Zadat docházku" a „🔑 Zjistit moje oprávnění".

Pozor na rozdíl: **menu** čte roli z listu (okamžitě), **modal a zápisy** jedou
z `UserProperties` kvůli rychlosti a obnoví se při otevření modalu.

## Citlivé statusy (GDPR)

Status označený v listu `Statusy` jako **`Citlivý`** se do měsíčního listu
**nikdy nezapíše** — v mřížce stojí jeho **`Náhrada`** a skutečná zkratka jde
do skrytého listu `Citlivé`. Modal ji dosadí jen tomu, kdo na ni má právo.

Důvod: buňka v Sheetu má jednu hodnotu pro všechny. Vykreslit ji každému jinak
nejde, takže jediná možnost je nedat ji do sdílené mřížky vůbec.

Skutečné statusy vidí každý u lidí ve **svém rozsahu** — je to stejné pravidlo
jako pro zadávání docházky (viz tabulka výše). Kdo je mimo rozsah, není v modalu
vůbec dosažitelný a v mřížce má jen náhradu.

Pozice se porovnávají s `DS_POZICE_USEK` / `DS_POZICE_ODDELENI` v `00_Konfig.gs` —
**musí přesně sedět s hodnotami ve sloupci `Pozice`.**

**Maskování při zápisu platí jen pro nově zadávané dny.** Na to, co už v listech
je, se pouští jednorázově **🔒 Skrýt citlivé statusy v listech** (`skryjCitlive`) —
projde 12 měsíců, v mřížce zkratku nahradí a skutečnou přesune do `Citlivé`.
Spouštěj po každém označení dalšího statusu jako citlivého; opakované spuštění
nic nezkazí.

Co je citlivé, rozhoduje **vždy server** (`_dsNahrady`); klient by si mohl říct,
že nic citlivé není. Mapa se drží v `DocumentProperties`, aby uložení dne
nestálo čtení listu, a obnovuje ji `_dsNahradyZListu` při otevření modalu a při
přestavbě listů. Souhrn dovolené se počítá z **maskovaných** hodnot, ať sedí
s tím, co v mřížce opravdu stojí — citlivý status proto neoznačuj jako `Dovolená`.

> ⚠ **Není to plná GDPR shoda.** List `Citlivé` je skrytý, ne chráněný — kdo smí
> sešit editovat, si ho odkryje. Oproti stavu, kdy citlivý status svítil přímo
> v mřížce, je to velký posun, ale skutečnou hranici by dalo jen úložiště mimo
> tenhle sešit (malá web app běžící pod vlastníkem).

### Test rolí

1. Jednou spusť **🔄 Postavit / obnovit všechny měsíce** (nebo 🧩) — tím vznikne
   sloupec `Role`, pokud v listu `Uživatelé` ještě není.
2. Ve svém řádku přepiš `Role` a **obnov stránku** (F5). Menu se změní hned.
3. Modal (výběr osoby) se řídí rolí z posledního otevření — po změně role ho
   zavři a otevři znovu.
4. Demontovat sám sebe je bezpečné: roli si kdykoli přepíšeš zpátky přímo
   v listu, na to menu nepotřebuješ.

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
