# Stealth-Engine

Stealth-Taktik-Prototyp im Stil von "Robin Hood: The Legend of Sherwood".

## Features

- **Polygon-Karte**: Ebenen `walk` (begehbar), `hide` (Versteck), `block` (Hindernis) — keine Tiles. Polygone sind benennbar und haben optionale Flags.
- **Polygon-Flags**: `climb` (Kletterwand — nur Figuren mit Kletter-Fähigkeit, Bewegung 0,55×), `acro` (Akrobatik-Fläche — nur Akrobaten, Bewegung 1,6×).
- **Übergänge**: `jump` (Akrobatik-Sprung im Bogen von Fläche A nach B, nur Akrobaten) und `door` (Tür/Geheimgang, teleportiert alle Figuren). Beide sind normale Kanten im Navigationsgraph.
- **Navigation**: Sichtbarkeitsgraph (Polygon-Ecken + Übergangsknoten), Dijkstra-Pfadsuche, String-Pulling; pro Figur ein eigener Graph abhängig von ihren Fähigkeiten.
- **Map-Editor**: Polygone zeichnen, benennen, Flags setzen, verschieben, Ecken editieren (Doppelklick auf Kante fügt Punkt ein), Wachen/Marker/Übergänge ziehen, JSON-Export/-Import, Hintergrundbild laden.
- **Stealth-Mechanik**: Sichtkegel der Wachen, Versteck-Mechanik, Pfeifen, Schleichen, K.o. von hinten, Alarmausbreitung. Wachen benutzen keine Übergänge und keine Flag-Flächen.
- **Kamera**: Zoom (Mausrad, 0,3–1,6×), Follow-Modus, freies Scrollen.

## Figuren und Fähigkeiten

| Figur | Fähigkeit | Besonderheit |
|---|---|---|
| Robin | Klettern | betritt `climb`-Flächen (langsam) |
| Little John | — | K.o. aus der Distanz, aber keine Flag-Flächen |
| Marian | Akrobatik | betritt `acro`-Flächen (schnell), nutzt Sprung-Übergänge |

## Workflow: KI-generierte Karte

1. Im Editor Polygone zeichnen/anordnen und benennen (Eingabefeld unter „Polygone").
2. „JSON exportieren" und das JSON an den Assistenten übergeben → erzeugt daraus ein gemaltes Kartenbild, das sich ungefähr an das Layout und die Namen hält.
3. Bild entweder lokal als `public/map.jpg` speichern (wird beim Start automatisch geladen) oder im Editor über „Hintergrund laden" einlegen.
4. Polygone über das Bild ziehen, bis alles passt; „JSON exportieren" sichert das Ergebnis.

## Entwicklung

### Mit Nix (empfohlen)

```sh
nix develop       # Dev-Shell mit Node.js 22
npm install       # einmalig
npm run dev       # Dev-Server: http://localhost:5173
```

Produktions-Build:

```sh
npm run build     # -> dist/
npm run preview
```

### Ohne Nix

Node.js >= 20 genügt: `npm install && npm run dev`.

## Projektstruktur

```
flake.nix                 # Nix-Dev-Shell (nix develop)
package.json              # Vite + React + Tailwind v4
vite.config.js            # Alias "@" -> src/
public/map.jpg            # optionales eigenes Hintergrundbild
index.html
src/App.jsx               # komplettes Spiel
src/main.jsx              # Einstiegspunkt
src/index.css             # Tailwind-Import
src/components/ui/        # Badge/Button als leichte Shims
```

## Steuerung

| Taste | Aktion |
|---|---|
| Klick | Figur zum Ziel bewegen |
| 1–3 | Figur auswählen |
| S | Schleichen an/aus |
| Q | Pfeifen (Wachen ablenken) |
| F | Follow-Modus an/aus |
| V | Laufflächen ein-/ausblenden |
| Pfeiltasten | Kamera bewegen |
| Mausrad | Zoomen |
| R | Neustart |

Editor: Klick = Punkt, Doppelklick = Polygon schließen / Punkt auf Kante einfügen, Ziehen = verschieben, Entf = löschen.

## Kartenformat (JSON)

```json
{
  "world": { "w": 1536, "h": 864 },
  "layers": {
    "walk": [{ "name": "Marktdach", "pts": [{ "x": 100, "y": 200 }], "flags": ["acro"] }],
    "hide": [],
    "block": []
  },
  "markers": {
    "escape": { "x": 0, "y": 0, "r": 50 },
    "gold": { "x": 0, "y": 0 },
    "guards": [{ "type": "pacer", "a": { "x": 0, "y": 0 }, "b": { "x": 0, "y": 0 } }],
    "transitions": [
      { "type": "jump", "name": "Dachsprung", "from": { "x": 0, "y": 0 }, "to": { "x": 0, "y": 0 } },
      { "type": "door", "name": "Geheimgang", "from": { "x": 0, "y": 0 }, "to": { "x": 0, "y": 0 } }
    ]
  }
}
```

Gültige Flags: `climb` (Kletterwand), `acro` (Akrobatik). Übergänge: `jump` nur für Akrobaten, `door` für alle. Ältere Karten ohne `name`/`pts`/`flags` werden beim Import automatisch konvertiert.

## Hinweise

- Die Original-Hintergrundbild-URLs sind nicht öffentlich erreichbar; das Spiel fällt automatisch auf die gemalte Ersatzkarte zurück. `public/map.jpg` hat Vorrang, wenn vorhanden.
- `src/components/ui/` enthält minimale Shims für Badge/Button. Beim Wechsel auf shadcn/ui die beiden Dateien durch die echten Komponenten ersetzen.

## Status

Lauffähiger Prototyp. Ausbauschritte: Gegner-KI-Verbände, Rettungsszenarien, Sound, Tragen von K.o.-Gegnern.
