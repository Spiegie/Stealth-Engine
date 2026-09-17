# Stealth-Engine („Sherwood“)

Taktik-Prototyp im Robin-Hood-Stil: Polygon-Karten-Editor, Stealth-Bewegung,
Patrouillen-Wachen mit Sichtkegeln und ein rundenloser Kampfmodus mit
Waffendreieck, Waffenklassen und Kampffertigkeiten.

## Features

### Karte & Editor
- Hintergrundbild + Polygone in drei Ebenen: `walk` (Laufflächen), `hide` (Verstecke), `block` (Sichtblocker)
- Editor mit Ziehen, Hinzufügen, Löschen von Polygonen; Skalieren der Karte
- Marker: Flucht/Start, Gold, Wachen (Patrouille A<->B oder Posten mit Blickrichtung)
- Polygon-Flags auf Laufflächen: `climb` (kletterbar, 0,55× Tempo), `acro` (Akrobatik, 1,6× Tempo)
- Übergänge: Sprünge (nur Akrobaten) und Türen/Geheimgänge (alle) als Graphkanten
- JSON-Import/-Export (Karten als Datei teilbar)

### Stealth
- Sichtbarkeitsgraph-Navigation pro Figur (Wachen nutzen keine Flag-Flächen/Übergänge)
- Sichtkegel der Wachen, Verstecke, Alarm-Logik
- Figuren: Robin (klettert), Marian (Akrobatin, schnell), John (ausgewogen, stark im Kampf)

### Kampf
- **Ausdauer statt Trefferpunkte:** Kampf kostet Ausdauer (Robin 100, John 120, Marian 80).
- **Belastungsformel:** `drain = 5 · (n·0.85)^1.5 · matchup · tier / alliierte^0.8`, mit Untergrenze `5 · (n/alliierte)^1.1`.
  Drei Gegner sind gerade so schaffbar, vier sind nicht gewinnbar.
- **Gruppenkampf sublinear:** Jeder zusätzliche Alliierte macht nur einen zusätzlichen
  Gegner gut bekämpfbar — Überzahl bleibt Überzahl.
- **Waffendreieck (Schere-Stein-Papier):** Schwert schlägt schwere Waffe, schwere Waffe
  schlägt Speer, Speer schlägt Schwert (Schaden ×1,5 / ×1 / ×0,6, Ausdauerkosten
  entsprechend ×0,85 / ×1 / ×1,15).
- **Waffenklassen (Abstufungen):**
  - Schwert: Dolch (leicht), Einhänder (Standard), Zweihänder (schwer)
  - Speer: Mistgabel (leicht), Speer (Standard), Hellebarde (schwer)
  - Schwere Waffe: Knüppel (leicht), Axt (Standard), Morgenstern (schwer)
  - Leicht: schneller, wendiger; schwer: mehr Schaden und KO-Chance, aber höherer
    Ausdauerverbrauch und langsamere Bewegung.
- **Kampffertigkeiten (4 Stufen):** Grün (×0,7), Regulär (×1), Veteran (×1,25), Elite (×1,45).
  Robin und John sind Veteranen, Marian ist grün. Wachen werden zufällig verteilt
  (30/40/20/10 %) und sind im Editor per Dropdown einstellbar (JSON-Feld `skill`).
- **Lärm:** Kampf erzeugt Lärm (rote Ringe), der Wachen im Umkreis alarmiert.
- **Ablösen:** Kampf abbrechen kostet Ausdauer; Marian kann sich dank Akrobatik gratis lösen.
- **Steuerung:** Angriff via Shift+Klick, Waffen- und Fertigkeitswahl im Editor.

## JSON-Format (Auszug)

```json
{
  "polys": [
    { "name": "Markt", "pts": [[10,20],[30,20],[30,40]], "flags": ["acro"] }
  ],
  "transitions": [
    { "type": "jump", "from": [10,20], "to": [50,60], "cost": 2 },
    { "type": "door", "from": [12,22], "to": [70,80] }
  ],
  "guards": [
    { "pos": [40,40], "patrol": [[10,10],[60,60]], "weapon": "sword", "skill": "veteran" }
  ]
}
```

## Entwicklung

Vite + React. `npm install && npm run dev`. Die komplette App liegt in `src/App.jsx`.
