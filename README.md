# Stealth-Engine

Stealth-Taktik-Prototyp im Stil von "Robin Hood: The Legend of Sherwood".

## Features

- **Polygon-Karte**: Ebenen `walk` (begehbar), `hide` (Versteck), `block` (Hindernis) — keine Tiles.
- **Navigation**: Sichtbarkeitsgraph (Knoten = Polygon-Ecken + Portale zwischen benachbarten Polygonen), Dijkstra-Pfadsuche, String-Pulling zur Glättung.
- **Map-Editor**: Polygone zeichnen, verschieben, Ecken editieren, Wachen/Marker ziehen, JSON-Export/-Import.
- **Stealth-Mechanik**: Sichtkegel der Wachen, Versteck-Mechanik (eigene Figuren unentdeckbar bis zum ersten Alarm), Pfeifen, Schleichen, K.o. von hinten, Alarmausbreitung.
- **Kamera**: Zoom (Mausrad, 0,3–1,6×), Follow-Modus, freies Scrollen.

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

## Kartenformat (JSON)

```json
{
  "walk": [[[0,0],[100,0],[100,50],[0,50]]],
  "hide": [],
  "block": [],
  "guards": [{ "path": [[x,y],[x,y]], "speed": 40 }],
  "posts": [{ "pos": [x,y], "facing": 0 }]
}
```

## Hinweise

- Die Original-Hintergrundbild-URLs sind nicht öffentlich erreichbar; das Spiel fällt automatisch auf die gemalte Ersatzkarte zurück (Polygon-Rendering). Eigene Bilder: `IMG_SOURCES` in `src/App.jsx` anpassen.
- `src/components/ui/` enthält minimale Shims für Badge/Button. Beim Wechsel auf shadcn/ui die beiden Dateien durch die echten Komponenten ersetzen.

## Status

Lauffähiger Prototyp. Ausbauschritte: Gegner-KI-Verbände, Rettungsszenarien, Sound, Tragen von K.o.-Gegnern.
