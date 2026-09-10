# Docházkový sheet (samostatný, varianta „modal v Sheetu")

Kód pro **bound skript vygenerovaného docházkového spreadsheetu** — není součástí
živé aplikace (proto je `dochazka-sheet/**` v `.claspignore`).

## Etapy

- **Etapa 1 – `Kod.gs` (hotovo):** `setup()` postaví list `Uživatelé` a 12 měsíčních
  listů (2 sloupce na den, seskupení oddělení → tým, dropdown statusů + ½ varianty,
  víkendy, souhrn dovolené, měkké zamčení mřížky, skrytý sloupec s `user_id`).
  Zatím bez modalu a bez slučování dnů.
- **Etapa 2:** modal (měsíční pohled osoby, klik → CELÝ DEN / ½ DEN → statusy,
  zápis do listu, slučování dvojice u celého dne / rozdělení u půldne).
- **Etapa 3:** oprávnění vedoucí vs. uživatel, regenerace při změně lidí bez ztráty dat.

## Jednorázové nastavení

1. Vytvoř nový prázdný Google Sheet.
2. Rozšíření → Apps Script → vlož obsah `Kod.gs`.
3. Nahoře ve skriptu nastav:
   - `ZDROJ_CORE_ID` — ID CORE DB živé appky (Apps Script živé appky → Nastavení
     projektu → Vlastnosti skriptu → `SPREADSHEET_CORE_ID`).
   - `USEK_NAZEV` — přesný název úseku.
   - `ROK`.
4. Ulož, obnov spreadsheet, v menu **📋 Docházka → Postavit / obnovit listy**.
   Napoprvé odsouhlas oprávnění.

Pro další úsek = kopie tohoto sešitu + změna `USEK_NAZEV` + znovu „Postavit / obnovit listy".
