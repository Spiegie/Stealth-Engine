# Stealth-Engine

Stealth-Taktik-Prototyp im Stil von "Robin Hood: The Legend of Sherwood".

## Features

- **Polygon-Karte**: Ebenen `walk` (begehbar), `hide` (Versteck), `block` (Hindernis) — keine Tiles.
- **Navigation**: Sichtbarkeitsgraph (Knoten = Polygon-Ecken + Portale zwischen benachbarten Polygonen), Dijkstra-Pfadsuche, String-Pulling zur Glättung.
- **Map-Editor**: Polygone zeichnen, verschieben, Ecken editieren, Wachen/Marker ziehen, JSON-Export/-Import.
- **Stealth-Mechanik**: Sichtkegel der Wachen, Versteck-Mechanik (eigene Figuren unentdeckbar bis zum ersten Alarm), Pfeifen, Schleichen, K.o. von hinten, Alarmausbreitung.
- **Kamera**: Zoom (Mausrad, 0,3–1,6×), Follow-Modus, freies Scrollen.

## Steuerung

| Taste | Aktion |
|---|---|
| Klick | Figur zum Ziel bewegen |
| 1–3 | Figur auswählen |
| S | Schleichen an/aus |
| Q | Pfeifen (Wachen ablenken) |
| F | Follow-Modus an/aus |
| V | Versteck betreten/verlassen |
| Pfeiltasten | Kamera bewegen |
| Mausrad | Zoomen |
| R | Editor: Standardkarte laden |

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

## Einbindung

Nur `react` wird benötigt. `src/App.jsx` exportiert die Komponente als Default.

## Status

Lauffähiger Prototyp. Ausbauschritte: Gegner-KI-Verbände, Rettungsszenarien, Sound, Tragen von K.o.-Gegnern.
