/**
 * Automaticky generovaný soubor s informacemi o verzi a změnách.
 * Neprovádějte ruční změny, pokud nevíte, co děláte.
 */

const APP_VERSION = "2.10.1";

const APP_CHANGELOG = [
  {
    "version": "2.10.1",
    "date": "2026-04-13",
    "changes": [
      "Oprava: Dynamické generování matice rolí podle existujících pozic"
    ]
  },
  {
    "version": "2.10.0",
    "date": "2026-04-13",
    "changes": [
      "Implementace konfigurovatelné synchronizace týmového kalendáře"
    ]
  },
  {
    "version": "2.9.0",
    "date": "2026-04-02",
    "changes": [
      "Oprava detekce potřeby rezervace stolu (chybný název vlastnosti needs_desk -> allows_desk_reservation)"
    ]
  },
  {
    "version": "2.8.9",
    "date": "2026-04-01",
    "changes": [
      "Oprava role dropdown: admin muze u sebe videt vlastni roli, u ostatnich jen nizsi"
    ]
  },
  {
    "version": "2.8.8",
    "date": "2026-04-01",
    "changes": [
      "Marketing modul: viditelnost jako stats, YYYY-WW format kt, pill s Po/Ct labely, tooltip bez START"
    ]
  },
  {
    "version": "2.8.7",
    "date": "2026-04-01",
    "changes": [
      "Oprava ukladani kampani - spravny return { success: true } z Admin.updateMarketingWeeks"
    ]
  },
  {
    "version": "2.8.6",
    "date": "2026-04-01",
    "changes": [
      "Oprava ulozeni kampani (chybejici wrapper), redesign tooltipu, auto-predvyplneni 10 tydnu v modalu"
    ]
  },
  {
    "version": "2.8.5",
    "date": "2026-04-01",
    "changes": [
      "Oprava marketingoveho modulu: pointer-events, design sjednocen se statistikami, click handler"
    ]
  },
  {
    "version": "2.8.4",
    "date": "2026-04-01",
    "changes": [
      "Oprava interaktivity marketingového modulu - hasPermission oprava a trigger tooltipu na celou plochu."
    ]
  },
  {
    "version": "2.8.3",
    "date": "2026-04-01",
    "changes": [
      "Oprava inicializace marketingového modulu při prvním startu aplikace."
    ]
  },
  {
    "version": "2.8.2",
    "date": "2026-04-01",
    "changes": [
      "Stabilizace marketingového modulu - ošetření chyb a přidání diagnostických logů do konzole."
    ]
  },
  {
    "version": "2.8.1",
    "date": "2026-04-01",
    "changes": [
      "Oprava funkčnosti marketingového modulu - oprava z-indexu a inicializace kliknutí."
    ]
  },
  {
    "version": "2.8.0",
    "date": "2026-04-01",
    "changes": [
      "Implementace komplexního zálohovacího systému Backup.gs - denní plné zálohy a hodinová ochrana docházky."
    ]
  },
  {
    "version": "2.7.7",
    "date": "2026-04-01",
    "changes": [
      "Sjednocení designu marketingového modulu se statistikami a oprava výchozího popisku KT."
    ]
  },
  {
    "version": "2.7.6",
    "date": "2026-04-01",
    "changes": [
      "Oprava viditelnosti a umístění marketingového modulu v liště. UI úpravy pro display:flex."
    ]
  },
  {
    "version": "2.7.5",
    "date": "2026-04-01",
    "changes": [
      "Správa marketingových týdnů přímo z topbaru - interaktivní modal a inline editace."
    ]
  },
  {
    "version": "2.7.4",
    "date": "2026-04-01",
    "changes": [
      "Oprava vykreslování docházky, robustnější formátování času a stabilizace hlavičky changelogu."
    ]
  },
  {
    "version": "2.7.3",
    "date": "2026-04-01",
    "changes": [
      "Redesign changelogu: seskupení po dnech, klasifikace typu změny, barevné tečky"
    ]
  },
  {
    "version": "2.7.2",
    "date": "2026-04-01",
    "changes": [
      "Širší modální okno statusu, oprava ukládání default_work_start_time po zobrazení"
    ]
  },
  {
    "version": "2.7.1",
    "date": "2026-04-01",
    "changes": [
      "Redesign modálního okna statusu, řádkový přepínač zobrazení času, oprava auto-extend schématu pro shows_work_time"
    ]
  },
  {
    "version": "2.7.0",
    "date": "2026-04-01",
    "changes": [
      "Konfigurovatelné zobrazení času příchodu per-status (shows_work_time)"
    ]
  },
  {
    "version": "2.6.0",
    "date": "2026-04-01",
    "changes": [
      "Redesign profilu: kompaktní header, 2-sloupcové rozložení bez scrollování, barevné karty"
    ]
  },
  {
    "version": "2.5.3",
    "date": "2026-04-01",
    "changes": [
      "Oprava formátu času příchodu v chipu a uložení jako text v DB"
    ]
  },
  {
    "version": "2.5.2",
    "date": "2026-04-01",
    "changes": [
      "Oprava auto-extend schématu pro show_work_start_time a work_start_time"
    ]
  },
  {
    "version": "2.5.1",
    "date": "2026-04-01",
    "changes": [
      "Zobrazení času příchodu v badgi statusu Kancelář"
    ]
  },
  {
    "version": "2.5.0",
    "date": "2026-04-01",
    "changes": [
      "Přidání zobrazení času příchodu pro status Kancelář"
    ]
  },
  {
    "version": "2.4.2",
    "date": "2026-03-31",
    "changes": [
      "Testovaci nasazeni"
    ]
  },
  {
    "version": "2.4.1",
    "date": "2026-03-31",
    "changes": [
      "Testovací commit"
    ]
  },
  {
    "version": "2.4.0",
    "date": "2026-03-28",
    "changes": [
      "RBAC Scoped Engine připraven",
      "Implementace pokročilého řízení přístupu (RBAC)",
      "Optimalizace výkonu vykreslování kalendáře",
      "Vylepšené logování změn"
    ]
  },
  {
    "version": "2.3.0",
    "date": "2026-03-15",
    "changes": [
      "Přidána podpora pro více oddělení",
      "Oprava chyb v synchronizaci s Google Kalendářem",
      "Nové ikonky v navigaci"
    ]
  }
];
