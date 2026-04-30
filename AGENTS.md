# Frontend Design Guidelines

When creating any frontend interface (dashboard, web component, landing page, HTML/CSS layout, React component, or any UI), always follow these design principles:

## Design Thinking – před kódováním

Nejdřív pochop kontext a zvol JASNÝ estetický směr:
- **Účel**: Jaký problém rozhraní řeší? Kdo ho používá?
- **Tón**: Vyber jasný směr – brutálně minimální, maximalistický chaos, retro-futuristický, organický/přírodní, luxusní/rafinovaný, hravý/hračkový, editoriální/magazínový, brutalistický/surový, art deco/geometrický, pastelový, industriální/utilitární, atd.
- **Omezení**: Technické požadavky (framework, výkon, přístupnost).
- **Odlišnost**: Co bude NEZAPOMENUTELNÉ? Co si uživatel zapamatuje?

**KRITICKÉ**: Vyber jasný konceptuální směr a proveď ho precizně. Záměrnost je důležitější než intenzita.

## Estetické pokyny

### Typografie
- Vybírej fonty, které jsou krásné, unikátní a zajímavé
- VYHNI SE generickým fontům: Arial, Inter, Roboto, system fonts
- Použij nečekané, charakterní volby fontů
- Spáruj výrazný display font s rafinovaným body fontem
- Nikdy nepoužívej Space Grotesk opakovaně

### Barvy & Téma
- Zavázej se ke kohezní estetice, používej CSS proměnné
- Dominantní barvy s ostrými akcenty fungují lépe než opatrné rovnoměrné palety
- Střídej světlá a tmavá témata – ne vždy stejný přístup

### Pohyb & Animace
- Používej animace pro efekty a mikrointerakce
- Upřednostňuj CSS-only řešení pro HTML
- Jeden dobře orchestrovaný page load se staggered reveals (animation-delay) vytvoří více radosti než náhodné mikrointerakce
- Hover stavy, které překvapí

### Prostorová kompozice
- Nečekané layouty, asymetrie, překryvy
- Diagonální flow, prvky breaking z gridu
- Velkorysý negativní prostor NEBO kontrolovaná hustota

### Pozadí & Vizuální detaily
- Vytvářej atmosféru a hloubku, nevracuj se k plným barvám
- Gradient meshe, noise textury, geometrické vzory, vrstvené průhlednosti
- Dramatické stíny, dekorativní bordery, grain overlay

## Co NIKDY nedělat
- Přetížené AI-generické estetiky (fialové gradienty na bílém pozadí)
- Předvídatelné layouty a komponentové vzory
- Cookie-cutter design bez kontextu
- Opakování stejných fontů nebo barevných schémat napříč projekty

## Implementace
- Kód musí být produkční kvality a funkční
- Vizuálně výrazný a zapamatovatelný
- Kohezní s jasným estetickým pohledem
- Meticulózně vyladěný v každém detailu
- Maximalistické designy potřebují propracovaný kód s rozsáhlými animacemi
- Minimalistické designy potřebují preciznost a pečlivou pozornost k typografii a detailům

---
*Tato pravidla se aplikují automaticky při jakékoli tvorbě frontend rozhraní.*
