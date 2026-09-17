# Stealth-Engine

Stealth-Taktik-Prototyp im Stil von "Robin Hood: The Legend of Sherwood".

## Features

- **Polygon-Karte**: Ebenen `walk` (begehbar), `hide` (Versteck), `block` (Hindernis) — keine Tiles. Polygone sind benennbar (z. B. „Dorf“, „Burg“, „Fluss“).
- **Navigation**: Sichtbarkeitsgraph (Knoten = Polygon-Ecken + Portale zwischen benachbarten Polygonen), Dijkstra-Pfadsuche, String-Pulling zur Glättung.
- **Map-Editor**: Polygone zeichnen, benennen, verschieben, Ecken editieren (Doppelklick auf Kante fügt Punkt ein), Wachen/Marker ziehen, JSON-Export/-Import, Hintergrundbild laden.
- **Stealth-Mechanik**: Sichtkegel der Wachen, Versteck-Mechanik (eigene Figuren unentdeckbar bis zum ersten Alarm), Pfeifen, Schleichen, K.o. von hinten, Alarmausbreitung.
- **Kamera**: Zoom (Mausrad, 0,3–1,6×), Follow-Modus, freies Scrollen.

## Workflow: KI-generierte Karte

1. Im Editor Polygone zeichnen/anordnen und benennen (Eingabefeld unter „Polygone“).
2. „JSON exportieren“ und das JSON an den Assistenten übergeben → erzeugt daraus ein gemaltes Kartenbild, das sich ungefähr an das Layout und die Namen hält.
3. Bild entweder lokal als `public/map.jpg` speichern (wird beim Start automatisch geladen) oder im Editor über „Hintergrund laden“ einlegen.
4. Polygone über das Bild ziehen, bis alles passt; „JSON exportieren“ sichert das Ergebnis.

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
    "walk": [{ "name": "Dorf", "pts": [{ "x": 100, "y": 200 }] }],
    "hide": [],
    "block": []
  },
  "markers": {
    "escape": { "x": 0, "y": 0, "r": 50 },
    "gold": { "x": 0, "y": 0 },
    "guards": [{ "type": "pacer", "a": { "x": 0, "y": 0 }, "b": { "x": 0, "y": 0 } }]
  }
}
```

Ältere Karten ohne `name`/`pts` (reine Punktelisten) werden beim Import automatisch konvertiert.

## Hinweise

- Die Original-Hintergrundbild-URLs sind nicht öffentlich erreichbar; das Spiel fällt automatisch auf die gemalte Ersatzkarte zurück. `public/map.jpg` hat Vorrang, wenn vorhanden.
- `src/components/ui/` enthält minimale Shims für Badge/Button. Beim Wechsel auf shadcn/ui die beiden Dateien durch die echten Komponenten ersetzen.

## Status

Lauffähiger Prototyp. Ausbauschritte: Gegner-KI-Verbände, Rettungsszenarien, Sound, Tragen von K.o.-Gegnern.
