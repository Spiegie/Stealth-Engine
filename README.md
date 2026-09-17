# Sherwood – Polygon-Map-Editor & Stealth-Taktik

Stealth-Taktik im Stil von „Robin Hood: The Legend of Sherwood", gebaut als React-Canvas (Vite). Die Karte besteht aus Polygonen: Laufflächen, Verstecke, Sichtblocker, Übergänge (Sprünge, Türen) und Wachen-Marker. Ein eingebauter Editor erlaubt das Anlegen eigener Karten, den Export als JSON und die Generierung eines passenden Kartenbildes.

## Features

- **Polygon-Karte**: Laufflächen (`walk`), Verstecke (`hide`), Sichtblocker (`block`) mit Sichtkegel-Berechnung
- **Polygon-Flags**: `climb` (kletterbar, nur Robin, 0,55× Tempo) und `acro` (Akrobatik, nur Marian, 1,6× Tempo)
- **Übergänge**: Sprünge (nur Akrobaten, Bogen-Animation) und Türen/Geheimgänge (Teleport, alle Figuren)
- **Figuren mit Fähigkeiten**: Robin (klettert), Marian (Akrobatin, Sprung-Rückzug aus dem Kampf), Little John (K.o. aus der Distanz)
- **Kampfsystem**: Ausdauer-basiert, Waffen-Dreieck mit Stufen, Gruppenkampf, Kampflärm
- **Wachen-KI**: Patrouillen, Posten mit Ablenkung, Misstrauen, Alarm, Fund bewusstloser Kollegen
- **Editor**: Polygone zeichnen/verschieben, Wachen platzieren, Waffen zuweisen, Übergänge setzen, JSON Import/Export, Hintergrundbild

## Kampfsystem

### Ausdauer statt zweiter HP-Leiste

Jede Figur hat Ausdauer (Robin 100, John 120, Marian 80). Pro Kampfrunde (1,5 s) kostet der Kampf Ausdauer, überlinear mit der Zahl gebundener Gegner:

```
drain = 5 · (n · 0,85)^1,5 · matchupDrain · tierDrain / allies^0,8
```

- **1 Figur gegen 3 Gegner**: knapp gewinnbar
- **1 Figur gegen 4 Gegner**: nicht gewinnbar – Überzahl bleibt Überzahl
- **Gruppenkampf**: jeder weitere eigene Charakter im Kampf bringt nur ~60 % (sublineare Skalierung); Schadensbonus `1 + 0,5·(k−1)^0,7`
- **Rücken an Rücken**: eigene Figuren in Kampfnähe (< 40 px) dämpfen den Ausdauerverbrauch (`/allies^0,8`)
- Ausdauer = 0: Figur ist überwältigt, Mission verloren

### Waffen-Dreieck (Schere-Stein-Papier)

| Kategorie | schlägt | verliert gegen |
|---|---|---|
| Schwert | Schwer | Speer |
| Schwer | Speer | Schwert |
| Speer | Schwert | Schwert |

Modifikatoren pro Bindungspaar: Vorteil ×1,5 Schaden / ×0,85 Ausdauer, Nachteil ×0,6 / ×1,15, neutral ×1.

### Waffenstufen

| Kategorie | Leicht | Standard | Schwer |
|---|---|---|---|
| Schwert | Dolch | Einhänder | Zweihänder |
| Speer | Mistgabel | Speer | Hellebarde |
| Schwer | Knüppel | Axt | Morgenstern |

Stufen-Multiplikatoren: Schaden ×0,7/×1,0/×1,35, Ausdauerkosten ×0,75/×1,0/×1,3, Kampf-Tempo ×1,1/×1,0/×0,85, K.o.-Reichweite ×0,8/×1,0/×0,7.

### Figuren

| Figur | Rolle | Waffe | Ausdauer | Fähigkeit |
|---|---|---|---|---|
| Robin | Ausgewogen | Einhänder | 100 | klettert |
| Little John | Bruiser | Morgenstern | 120 | K.o. aus der Distanz |
| Marian | schnell | Dolch | 80 | Akrobatin, Sprünge, kostenloser Sprung-Rückzug auf Akro-Flächen |

### Kampf-Befehle

- **Shift+Klick auf Wache** (oder Klick auf alarmierte Wache): Kampf aufnehmen
- **Klick auf freie Fläche im Kampf**: Rückzug (25 Ausdauer, 2,5 s verlangsamt); Marian auf Akro-Fläche: gratis Sprung
- **Kampflärm**: jede Kampfrunde erzeugt ein Lärmereignis (Radius 300, rote Ringe); Wachen im Radius alarmieren und laufen heran – ankommende Wachen treten in den Kampf ein

### Tuning-Knöpfe

Alle Werte liegen in der `COMBAT`-Konstante (`tick`, `drainBase`, `drainExp`, `counterFactor`, `comboExp`, `allyDiv`, `drainMinExp`, `enemyCap`).

## Wachen-Waffen im Editor

Ausgewählte Wache: zwei Dropdowns (Kategorie: Schwert/Speer/Schwer, Stufe: Leicht/Standard/Schwer). Im Spiel zeigt der Ring um die Wache die Kategorie (Farbe) und die Stufe (Ringstärke; schwere Stufe zusätzlich gestrichelter Außenring). HP-Balken erscheint bei Beschädigung.

## JSON-Format

```json
{
  "world": { "w": 1600, "h": 1000 },
  "layers": {
    "walk":  [{ "name": "Dorf", "pts": [{ "x": 0, "y": 0 }], "flags": ["climb"] }],
    "hide":  [{ "name": "Hecke", "pts": [] }],
    "block": [{ "name": "Burg", "pts": [] }]
  },
  "markers": {
    "escape": { "x": 100, "y": 800, "r": 120 },
    "gold":   { "x": 1400, "y": 150 },
    "guards": [
      { "type": "pacer", "a": {}, "b": {}, "weapon": { "cat": "sword", "tier": "std" } },
      { "type": "sentry", "post": {}, "look": {}, "weapon": { "cat": "heavy", "tier": "heavy" } }
    ],
    "transitions": [
      { "type": "jump", "name": "Dachsprung", "from": {}, "to": {} },
      { "type": "door", "name": "Geheimgang", "from": {}, "to": {} }
    ]
  }
}
```

- `flags` ist optional (`climb`, `acro`); `transitions` ist optional
- `weapon` ist optional; fehlende Wachen bekommen eine zufällige Waffe (60 % Standard, 25 % Leicht, 15 % Schwer)
- Altes String-Format (`"weapon": "axe"`) wird normalisiert (`axe` → Schwer/Standard)

## Entwicklung

```bash
npm install
npm run dev
```

Kartenbild als `public/map.jpg` ablegen – es wird automatisch als Hintergrund geladen (Cascade über `IMG_SOURCES`).

## Steuerung

- Klick: Figur bewegen / Wache ausschalten (stille Wachen in K.o.-Reichweite)
- Shift+Klick auf Wache: Kampf aufnehmen
- 1–3: Figur wählen · S: Schleichen · Q: Pfeifen · F: Kamera folgen · V: Laufflächen · R: Neustart
- Ziehen, Pfeiltasten, Mausrad: Kamera
