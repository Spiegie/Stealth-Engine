import React, { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// ============================================================
// Sherwood – Stealth-Taktik mit Polygon-Karte + Map-Editor
//
// Karte = Hintergrundbild + Polygone in acht Ebenen:
//   walk/climb/acro = Laufflächen (Navigation per Sichtbarkeitsgraph);
//     climb = Kletterflächen (Kletterer + Akrobaten, langsam),
//     acro  = Akrobatikflächen (nur Akrobaten, schnell)
//   hide     = Verstecke (durchsuchbar: Wache im Versteck sieht alles darin)
//   block    = Sichtblocker (Burg, Bäume, Häuser)
//   blocking = Bewegungsblocker (niemand kommt durch)
//   start/goal = Startregion und Zielregion
// Dazu Marker: Wachen (Patrouille A<->B, Posten mit Blickrichtung), Übergänge.
// ============================================================

const IMG_SOURCES = [
  "/map.png",
  "/map.jpg",
  "gen-image://57c5ccbf",
  "https://mistralaichatupprodswe.blob.core.windows.net/chat-images/assistant/94/3c/cb/943ccbec-dc09-4583-a291-f15b67076a22/3d534e61-0f11-440c-8b07-9badacfb0251/6557861b-ad9c-4540-9518-845d60a3f64f/a85e0a21-c88a-4a31-b99c-e60fd3022429.jpg",
];

const VIEW_W = 1024;
const VIEW_H = 600;

const GUARD_FOV = (80 * Math.PI) / 180;
const GUARD_RANGE = 270;

// Sichtparameter je Wachzustand: fov in Grad, range in px.
// Aufmerksam (Patrouille) = weitester Winkel. Alarmiert = engerer Winkel,
// etwas mehr Reichweite. Im Kampf = Tunnelblick auf das Ziel.
const VISION = {
  attentive: { fov: 80, range: 270 },
  inattentive: { fov: 52, range: 195 },
  suspicious: { fov: 68, range: 245 },
  alert: { fov: 58, range: 305 },
  tunnel: { fov: 28, range: 305 },
};

function visionParams(guard) {
  if (guard.engagedChars && guard.engagedChars.length > 0) return VISION.tunnel;
  if (guard.state === "alert") return VISION.alert;
  if (guard.state === "suspicious")
    // Köder-Wachen starren aufs Geräusch: Sichtfeld so schlecht wie unaufmerksam
    return guard.distractKind === "noise" ? VISION.inattentive : VISION.suspicious;
  return guard.attentive ? VISION.attentive : VISION.inattentive;
}
const NOISE_RADIUS = 240;
const WHISTLE_RADIUS = 430;
const ALARM_SPREAD = 300;

// Bogen (nur Robin): Umschalten dauert, im Bogen-Modus langsames Gehen,
// begrenzte Pfeile im Köcher, Schuss braucht Sichtlinie + Reichweite.
const BOW = {
  range: 430,
  switchTime: 2.2,
  arrowSpeed: 250,
  quiver: 6,
  moveMult: 0.6,
  noiseRadius: 170,
};

function bowActive(c, g) {
  return !!c.canBow && !!c.bowMode && g.time >= c.bowSwitchAt;
}

// Schuss abfeuern. target = { x, y, guard? } für eine Wache
// oder { x, y, poly } für ein beschießbares Interaktionsobjekt.
function fireArrow(g, ch, target, notify) {
  if (ch.arrows <= 0) {
    notify("Robins Köcher ist leer.");
    return false;
  }
  if (ch.engaged.length > 0 || ch.bowStowAt != null) {
    notify("Im Nahkampf kommt Robin nicht zum Schießen.");
    return false;
  }
  if (!hasLineOfSight(g.map, ch, target)) {
    notify("Kein freier Schusswinkel.");
    return false;
  }
  const dist = Math.hypot(target.x - ch.x, target.y - ch.y);
  if (dist > BOW.range) {
    notify("Zu weit für einen Schuss.");
    return false;
  }
  ch.arrows--;
  ch.facing = Math.atan2(target.y - ch.y, target.x - ch.x);
  g.arrows.push({
    sx: ch.x,
    sy: ch.y - 12,
    x: ch.x,
    y: ch.y - 12,
    tx: target.x,
    ty: target.y - 10,
    t: 0,
    dur: Math.max(0.3, dist / BOW.arrowSpeed),
    arc: Math.min(90, 22 + dist * 0.15),
    tg: target.guard ? target.guard.id : null,
    poly: target.poly ?? null,
  });
  notify("Robin schießt!");
  // Bogenschuss macht ein leises Geräusch
  for (const guard of g.guards) {
    if (guard.state === "knocked" || guard.state === "alert") continue;
    if (guard === target.guard) continue;
    if (Math.hypot(guard.x - ch.x, guard.y - ch.y) < BOW.noiseRadius) {
      guard.state = "suspicious";
      guard.suspTarget = { x: ch.x, y: ch.y };
      guard.scanTimer = 0;
      guard.distractKind = "noise";
      guard.path = findPath(g.map, getGuardNav(g), guard, { x: ch.x, y: ch.y });
    }
  }
  return true;
}
const CATCH_DIST = 20;

// ---------- Kampf ----------
const COMBAT = {
  tick: 1.5, // Sekunden pro Kampfrunde
  baseDmg: 26,
  guardHp: 50,
  drainBase: 5,
  drainExp: 1.5,
  counterFactor: 0.22, // Gegenschaden der Wache auf die Ausdauer
  disadvFactor: 2.4, // zusätzlicher Gegenschaden bei Waffennachteil
  disadvDrain: 2, // zusätzlicher Ausdauerverbrauch bei Waffennachteil
  comboExp: 0.7, // Schadensbonus bei mehreren Angreifern (sublinear)
  allyDiv: 0.8, // Rücken-an-Rücken: Ausdauerkosten / allies^allyDiv
  drainMinExp: 1.1, // Untergrenze des Ausdauerverbrauchs (Masse-Schutz)
  flankRange: 40,
  disengageCost: 25,
  disengageSlow: 0.7,
  noiseRadius: 190,
  engageDist: 30,
  enemyCap: (k) => Math.min(2 + 2 * k, 6),
};
const WEAPONS = {
  sword: { beats: "heavy", label: "Schwert", color: "#cbd5e1" },
  spear: { beats: "sword", label: "Speer", color: "#4ade80" },
  heavy: { beats: "spear", label: "Schwer", color: "#fb923c" },
};
const WEAPON_TIERS = {
  light: { label: "Leicht", dmg: 0.7, drain: 0.75, move: 1.1, ko: 0.8 },
  std: { label: "Standard", dmg: 1, drain: 1, move: 1, ko: 1 },
  heavy: { label: "Schwer", dmg: 1.35, drain: 1.3, move: 0.85, ko: 0.7 },
};
const WEAPON_LISTS = {
  sword: { light: "Dolch", std: "Einhänder", heavy: "Zweihänder" },
  spear: { light: "Mistgabel", std: "Speer", heavy: "Hellebarde" },
  heavy: { light: "Knüppel", std: "Axt", heavy: "Morgenstern" },
};

function weaponName(w) {
  return w ? WEAPON_LISTS[w.cat]?.[w.tier] ?? "?" : "?";
}

// Kampffertigkeit: skaliert verursachten Schaden (Figuren) bzw. Gegenschaden (Wachen)
const SKILLS = {
  green: { label: "Unerfahren", mult: 0.7, pips: 1 },
  regular: { label: "Durchschnittlich", mult: 1, pips: 2 },
  veteran: { label: "Erfahren", mult: 1.25, pips: 3 },
  elite: { label: "Elite", mult: 1.45, pips: 4 },
};

function normSkill(s) {
  return s && SKILLS[s] ? s : null;
}

function randSkill() {
  const r = Math.random();
  if (r < 0.3) return "green";
  if (r < 0.7) return "regular";
  if (r < 0.9) return "veteran";
  return "elite";
}

function normWeapon(w) {
  if (!w) return null;
  if (typeof w === "string") {
    const cat = w === "axe" ? "heavy" : w;
    return WEAPONS[cat] ? { cat, tier: "std" } : null;
  }
  if (w.cat && w.tier && WEAPONS[w.cat] && WEAPON_TIERS[w.tier]) return { cat: w.cat, tier: w.tier };
  return null;
}

function randWeapon() {
  const cats = ["sword", "spear", "heavy"];
  const r = Math.random();
  const tier = r < 0.6 ? "std" : r < 0.85 ? "light" : "heavy";
  return { cat: cats[Math.floor(Math.random() * 3)], tier };
}

function matchupMod(a, b) {
  if (a === b) return { dmg: 1, drain: 1 };
  if (WEAPONS[a].beats === b) return { dmg: 1.5, drain: 0.85 };
  return { dmg: 0.6, drain: 1.15 };
}

function processCombatTick(g, notify) {
  // Bindungen aufräumen
  for (const guard of g.guards) {
    if (guard.engagedChars.length === 0) continue;
    guard.engagedChars = guard.engagedChars.filter((ci) => {
      const c = g.chars[ci];
      return c && !c.caught && c.engaged.includes(guard.id);
    });
  }
  const fighting = g.guards.filter((gu) => gu.engagedChars.length > 0);
  for (const guard of fighting) {
    const k = guard.engagedChars.length;
    // Schaden an die Wache (Gruppenbonus sublinear)
    let sum = 0;
    for (const ci of guard.engagedChars) {
      const c = g.chars[ci];
      // Bogen tragende Figuren kämpfen nicht – sie verlieren die Initiative
      if (c.bowMode) continue;
      sum += COMBAT.baseDmg * matchupMod(c.weapon.cat, guard.weapon.cat).dmg * WEAPON_TIERS[c.weapon.tier].dmg * SKILLS[c.skill].mult;
    }
    const combo = 1 + 0.5 * Math.pow(k - 1, COMBAT.comboExp);
    guard.hp -= (sum / k) * combo;
    // Kampflärm alarmiert die Umgebung
    g.combatFx.push({ x: guard.x, y: guard.y, t: 0 });
    for (const other of g.guards) {
      if (other === guard || other.state === "knocked" || other.engagedChars.length > 0) continue;
      if (Math.hypot(other.x - guard.x, other.y - guard.y) < COMBAT.noiseRadius) {
        other.state = "alert";
        other.lastSeen = { x: guard.x, y: guard.y };
        other.lostSightAt = g.time;
      }
    }
    // Gegenschaden + Ausdauerkosten pro beteiligter Figur – vor dem
    // Todes-Check, damit die Wache in ihrer letzten Runde noch zuschlägt
    const gTier = WEAPON_TIERS[guard.weapon.tier];
    for (const ci of guard.engagedChars) {
      const c = g.chars[ci];
      const n = c.engaged.length;
      const allies =
        1 +
        g.chars.filter(
          (o) =>
            o !== c && !o.caught && o.engaged.length > 0 && Math.hypot(o.x - c.x, o.y - c.y) < COMBAT.flankRange,
        ).length;
      let drainSum = 0;
      for (const gid of c.engaged) {
        const gu = g.guards[gid];
        if (!gu || gu.state === "knocked") continue;
        drainSum +=
          (matchupMod(c.weapon.cat, gu.weapon.cat).drain * WEAPON_TIERS[gu.weapon.tier].drain) /
          Math.max(1, c.engaged.length);
      }
      // Waffennachteil: Die Wache trifft härter und zermürbt schneller –
      // falsches Matchup darf keine kostenlose Durchlauf-Option sein
      const rawMult = matchupMod(guard.weapon.cat, c.weapon.cat).dmg * gTier.dmg * SKILLS[guard.skill].mult;
      const counterMult = Math.min(2, rawMult);
      const disadv = matchupMod(guard.weapon.cat, c.weapon.cat).dmg > 1 ? COMBAT.disadvFactor : 1;
      const back =
        (COMBAT.baseDmg * counterMult * COMBAT.counterFactor * disadv) /
        Math.pow(k, 0.7);
      let drain = (COMBAT.drainBase * Math.pow(n * 0.85, COMBAT.drainExp) * drainSum) / Math.pow(allies, COMBAT.allyDiv);
      drain = Math.max(drain, COMBAT.drainBase * Math.pow(n / allies, COMBAT.drainMinExp));
      if (disadv > 1) drain *= COMBAT.disadvDrain;
      c.stamina -= drain + back;
      if (c.stamina <= 0) {
        c.stamina = 0;
        c.caught = true;
        for (const gid of c.engaged) {
          const gu = g.guards[gid];
          if (gu) gu.engagedChars = gu.engagedChars.filter((x) => x !== ci);
        }
        c.engaged = [];
        g.status = "lost";
        notify(`${c.name} wurde im Kampf überwältigt!`);
      }
    }
    // Todes-Check erst nach dem Gegenschlag der finalen Runde
    if (guard.hp <= 0) {
      guard.state = "knocked";
      guard.path = [];
      guard.engagedChars = [];
      g.knocked++;
      for (const c of g.chars) {
        c.engaged = c.engaged.filter((id) => id !== guard.id);
        if (c.attackTarget === guard.id) c.attackTarget = null;
      }
      notify("Gegner im Kampf bezwungen!");
    }
  }
}

// ---------- Geometrie ----------

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function centroid(poly) {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  return Math.abs(a / 2);
}

// Ebenen-Modell:
//   walk     = normale Lauffläche (alle)
//   climb    = Kletterfläche (nur Kletterer/Akrobaten, 0,55× Tempo)
//   acro     = Akrobatikfläche (nur Akrobaten, 1,6× Tempo)
//   blocking = unüberwindbares Hindernis (überschreibt alles)
//   hide     = Versteck
//   block    = Sichtblocker
//   start    = Startregion (Spawn + Flucht)
//   goal     = Zielregion (Gold)
//   interact = Interaktionsobjekt (Strg+Klick triggert Effekt, wenn Figur darin steht)
//   paths    = benannte Wachenpfade (Polylinien) + Geheimgänge/Sprünge sind hier editierbar
//   fx       = freie Flächen ohne Spielfunktion – nur Markierung/Referenz für Effekte
//              (z. B. als knock-Ziele oder zur Planung; beeinflussen weder Bewegung noch Sicht)

const LAYER_NAMES = ["walk", "climb", "acro", "hide", "blocking", "block", "interact", "paths", "fx", "start", "goal"];
const MOVE_LAYERS = ["walk", "climb", "acro"];

function inAnyPoly(polys, p) {
  for (const poly of polys) {
    if (poly && poly.pts.length >= 3 && pointInPoly(p.x, p.y, poly.pts)) return true;
  }
  return false;
}

// Alle begehbaren Polygone (walk + climb + acro) in fester Reihenfolge
function movePolys(map) {
  return MOVE_LAYERS.flatMap((ln) => map.layers[ln] ?? []);
}

// Index des begehbaren Polygons, in dem p liegt (-1 = keins)
function walkPolyIndexAt(map, p) {
  const polys = movePolys(map);
  for (let i = 0; i < polys.length; i++) {
    if (polys[i] && polys[i].pts.length >= 3 && pointInPoly(p.x, p.y, polys[i].pts)) return i;
  }
  return -1;
}

function polyBBox(poly) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly.pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

// Prüft, ob zwei Polygone über einen Übergang (Tür/Sprung) verknüpft sind
function linkViaTransition(map, ia, ib, ch) {
  for (const tr of map.markers.transitions ?? []) {
    if (tr.type === "jump" && !(ch && ch.canAcro)) continue;
    const fa = walkPolyIndexAt(map, tr.from);
    const ta = walkPolyIndexAt(map, tr.to);
    if ((fa === ia && ta === ib) || (fa === ib && ta === ia)) return true;
  }
  return false;
}

// Zwei Polygone gelten als verbunden, wenn sie großzügig aneinander grenzen
// oder durch einen Übergang (Tür für alle, Sprung nur Akrobaten) verknüpft sind.
function polysConnected(map, ia, ib, ch) {
  if (ia === ib) return true;
  if (ia < 0 || ib < 0) return false;
  const polys = movePolys(map);
  const a = polyBBox(polys[ia]);
  const b = polyBBox(polys[ib]);
  const gap =
    Math.max(b.x0 - a.x1, a.x0 - b.x1, 0) + Math.max(b.y0 - a.y1, a.y0 - b.y1, 0);
  if (gap <= 220) return true;
  return linkViaTransition(map, ia, ib, ch);
}

function pointWalkable(map, p, ch) {
  if (inAnyPoly(map.layers.blocking ?? [], p)) return false;
  if (inAnyPoly(map.layers.walk ?? [], p)) return true;
  // Klettern: Kletterer und Akrobaten (Akrobatik schließt Klettern ein)
  if (inAnyPoly(map.layers.climb ?? [], p)) return !!(ch && (ch.canClimb || ch.canAcro));
  if (inAnyPoly(map.layers.acro ?? [], p)) return !!(ch && ch.canAcro);
  return false;
}

function speedMult(map, p) {
  if (inAnyPoly(map.layers.acro ?? [], p)) return 1.6;
  if (inAnyPoly(map.layers.climb ?? [], p)) return 0.55;
  return 1;
}

// Start-/Zielregion: Zentrum und Radius des ersten Polygons der Ebene
function regionOf(map, layerName) {
  const polys = map.layers[layerName] ?? [];
  if (!polys.length || polys[0].pts.length < 3)
    return { x: map.world.w / 2, y: map.world.h / 2, r: 60 };
  const c = centroid(polys[0].pts);
  return { x: c.x, y: c.y, r: Math.max(40, Math.sqrt(polyArea(polys[0].pts) / Math.PI)) };
}
const startRegion = (map) => regionOf(map, "start");
const goalRegion = (map) => regionOf(map, "goal");

function pointHidden(map, p) {
  for (const poly of map.layers.hide) if (pointInPoly(p.x, p.y, poly.pts)) return true;
  return false;
}

function pointBlocksSight(map, p) {
  for (const poly of map.layers.block) if (pointInPoly(p.x, p.y, poly.pts)) return true;
  return false;
}

function segWalkable(map, a, b, ch) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.min(100, Math.max(2, Math.ceil(dist / 8)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!pointWalkable(map, { x: a.x + dx * t, y: a.y + dy * t }, ch)) return false;
  }
  return true;
}

function hasLineOfSight(map, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.min(120, Math.max(2, Math.ceil(dist / 12)));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (pointBlocksSight(map, { x: a.x + dx * t, y: a.y + dy * t })) return false;
  }
  return true;
}

function nearestWalkable(map, p, ch) {
  if (pointWalkable(map, p, ch)) return { x: p.x, y: p.y };
  for (let r = 12; r <= 200; r += 14) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const q = { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r };
      if (pointWalkable(map, q, ch)) return q;
    }
  }
  return null;
}

// ---------- Navigation: Sichtbarkeitsgraph über Polygonen ----------

// Douglas-Peucker für geschlossene Polygone: Index 0 bleibt Fixpunkt,
// die Kette 1..n-1 wird vereinfacht, Schlusskante n-1 -> 0 bleibt erhalten.
// Liefert mindestens ein Dreieck zurück.
function simplifyPolyDP(pts, tol) {
  const n = pts.length;
  if (n < 4 || tol <= 0) return pts.map((p) => ({ ...p }));
  const perp = (p, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (!L) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / L;
  };
  const dp = (lo, hi, keep) => {
    let worst = -1;
    let d = -1;
    for (let i = lo + 1; i < hi; i++) {
      const q = perp(pts[i], pts[lo], pts[hi]);
      if (q > d) {
        d = q;
        worst = i;
      }
    }
    if (d > tol) {
      keep.add(worst);
      dp(lo, worst, keep);
      dp(worst, hi, keep);
    }
  };
  const keep = new Set([0, n - 1]);
  dp(0, n - 1, keep);
  // Endpunkt n-1 liegt oft kollinear zur Schlusskante (letzter Punkt -> pts[0])
  // und wäre redundant – dann verwerfen.
  const perpEnd = (() => {
    const prev = [...keep].filter((i) => i !== n - 1).sort((a, b) => a - b).pop();
    if (prev == null) return Infinity;
    const dx = pts[0].x - pts[prev].x;
    const dy = pts[0].y - pts[prev].y;
    const L = Math.hypot(dx, dy);
    if (!L) return Infinity;
    return Math.abs(dy * (pts[n - 1].x - pts[prev].x) - dx * (pts[n - 1].y - pts[prev].y)) / L;
  })();
  if (perpEnd <= tol) keep.delete(n - 1);
  const out = [...keep].sort((a, b) => a - b).map((i) => ({ ...pts[i] }));
  if (out.length < 3) return pts.map((p) => ({ ...p }));
  return out;
}

function buildNav(map, ch, useTransitions) {
  // Knoten = Polygonzentren + Eckpunkte, jeweils mit Polygonzugehörigkeit
  const polys = movePolys(map).filter((p) => p && p.pts.length >= 3);
  const bboxes = polys.map((poly) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of poly.pts) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    return { x0, y0, x1, y1 };
  });

  const nodes = [];
  polys.forEach((poly, pi) => {
    // Knoten aus vereinfachter Kontur (Douglas-Peucker, fein): Indizes bleiben
    // stabil, nur die Knotenzahl sinkt. Original-Polygone bleiben Quelle der
    // Wahrheit für Begehbarkeit/Portale.
    const spts = simplifyPolyDP(poly.pts, 1.5);
    nodes.push({ ...centroid(spts), pi });
    for (const p of spts) nodes.push({ x: p.x, y: p.y, pi });
  });
  // Fragment-Knoten: blocking-Polygone können ein Laufflächen-Polygon zerschneiden.
  // Dann liegen Zentrum und Ecken evtl. im gesperrten Teil und das begehbare
  // Reststück hätte keinen Knoten. Für betroffene Polygone daher zusätzliche
  // Rasterpunkte setzen (nur begehbare).
  const blockings = (map.layers.blocking ?? []).filter((b) => b && b.pts.length >= 3);
  // Rasterweite skaliert mit der Kartengröße, damit Riesenkarten (bis 20000 px)
  // nicht quadratisch mehr Knoten erzeugen:
  const diag = Math.hypot(map.world.w, map.world.h);
  const fragStep = Math.max(70, Math.round(diag / 42));
  const ringSpacing = Math.max(26, Math.round(diag / 110));
  if (blockings.length) {
    const blockBBs = blockings.map(polyBBox);
    polys.forEach((poly, pi) => {
      const bb = bboxes[pi];
      const cut = blockBBs.some(
        (b2) => bb.x0 <= b2.x1 && b2.x0 <= bb.x1 && bb.y0 <= b2.y1 && b2.y0 <= bb.y1,
      );
      if (!cut) return;
      for (let gx = bb.x0 + fragStep / 2; gx < bb.x1; gx += fragStep) {
        for (let gy = bb.y0 + fragStep / 2; gy < bb.y1; gy += fragStep) {
          if (!pointInPoly(gx, gy, poly.pts)) continue;
          if (!pointWalkable(map, { x: gx, y: gy }, ch)) continue;
          nodes.push({ x: gx, y: gy, pi });
        }
      }
    });
    // Ring-Knoten um jedes blocking-Polygon: Punkte knapp außerhalb der
    // Kanten landen in jedem angrenzenden begehbaren Fragment – auch in
    // schmalen Schlitzen, die das Raster verpasst.
    const movePolysCache = movePolys(map);
    const ringPoint = (x, y) => {
      if (!pointWalkable(map, { x, y }, ch)) return;
      const pi2 = movePolysCache.findIndex((mp) => pointInPoly(x, y, mp.pts));
      if (pi2 >= 0) nodes.push({ x, y, pi: pi2 });
    };
    for (const b of blockings) {
      const bp = b.pts;
      for (let i = 0; i < bp.length; i++) {
        const a = bp[i];
        const c = bp[(i + 1) % bp.length];
        const ex = c.x - a.x;
        const ey = c.y - a.y;
        const L = Math.hypot(ex, ey);
        if (!L) continue;
        const nx = -ey / L;
        const ny = ex / L;
        const n = Math.max(2, Math.ceil(L / ringSpacing));
        for (let k = 0; k < n; k++) {
          const t = k / n;
          const px = a.x + ex * t;
          const py = a.y + ey * t;
          ringPoint(px + nx * 26, py + ny * 26);
          ringPoint(px - nx * 26, py - ny * 26);
        }
      }
    }
  }
  const trans = useTransitions ? map.markers.transitions ?? [] : [];
  for (const t of trans) {
    nodes.push({ x: t.from.x, y: t.from.y, pi: -1 });
    nodes.push({ x: t.to.x, y: t.to.y, pi: -1 });
  }
  const adj = nodes.map(() => []);
  // Kanten: innerhalb eines Polygons alle Paare; über Polygon-Grenzen nur
  // großzügig benachbarte bzw. über Übergänge verbundene Polygone. Knoten
  // werden dafür in Rasterzellen (1200 px) einsortiert – sonst wäre die
  // Kantensuche quadratisch und Riesenkarten würden Speicher/Zeit sprengen.
  const MAX_EDGE = 1200;
  const CELL = MAX_EDGE;
  const cells = new Map();
  const piGroups = new Map();
  nodes.forEach((nd, idx) => {
    const ck = Math.floor(nd.x / CELL) + "|" + Math.floor(nd.y / CELL);
    const cb = cells.get(ck);
    if (cb) cb.push(idx);
    else cells.set(ck, [idx]);
    if (nd.pi >= 0) {
      const pb = piGroups.get(nd.pi);
      if (pb) pb.push(idx);
      else piGroups.set(nd.pi, [idx]);
    }
  });
  const tryEdge = (i, j) => {
    const a = nodes[i];
    const b = nodes[j];
    if (a.pi !== b.pi) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (dx > MAX_EDGE || dx < -MAX_EDGE || dy > MAX_EDGE || dy < -MAX_EDGE) return;
      if (!polysConnected(map, a.pi, b.pi, ch)) return;
    }
    if (segWalkable(map, a, b, ch)) {
      adj[i].push({ to: j, type: null });
      adj[j].push({ to: i, type: null });
    }
  };
  for (const bucket of piGroups.values())
    for (let x = 0; x < bucket.length; x++)
      for (let y = x + 1; y < bucket.length; y++) tryEdge(bucket[x], bucket[y]);
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const gx = Math.floor(a.x / CELL);
    const gy = Math.floor(a.y / CELL);
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = cells.get(gx + ox + "|" + gy + oy);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i || nodes[j].pi === a.pi) continue;
          tryEdge(i, j);
        }
      }
  }
  // Übergänge: Türen für alle, Sprünge nur für Akrobaten
  const base = nodes.length - trans.length * 2;
  trans.forEach((t, k) => {
    if (t.type !== "door" && !(ch && ch.canAcro)) return;
    const fi = base + k * 2;
    const ti = base + k * 2 + 1;
    const d = Math.hypot(t.to.x - t.from.x, t.to.y - t.from.y);
    const cost = t.type === "door" ? 40 : Math.max(60, d * 0.8);
    adj[fi].push({ to: ti, type: t.type, cost });
    adj[ti].push({ to: fi, type: t.type, cost });
  });
  return { nodes, adj };
}

function smoothPath(map, path, ch) {
  if (path.length < 3) return path;
  const out = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let j = path.length - 1;
    if (path[j].seg) j = i + 1; // Übergangskanten nicht überspringen
    for (; j > i + 1; j--) {
      if (path[j].seg) continue;
      if (segWalkable(map, path[i], path[j], ch)) break;
    }
    out.push(path[j]);
    i = j;
  }
  return out;
}

function findPath(map, nav, from, to, ch) {
  if (!pointWalkable(map, to, ch)) return [];
  const start = nearestWalkable(map, from, ch);
  if (!start) return [];
  const { nodes, adj } = nav;
  const N = nodes.length;
  const pts = nodes.concat([start, to]);
  const S = N;
  const T = N + 1;
  const dist = new Array(N + 2).fill(Infinity);
  const prev = new Array(N + 2).fill(-1);
  const etype = new Array(N + 2).fill(null);
  const visited = new Array(N + 2).fill(false);
  dist[S] = 0;
  const linksOf = (u) => {
    if (u === T) return [];
    if (u === S) {
      const out = [];
      for (let k = 0; k < N; k++) if (segWalkable(map, pts[S], pts[k], ch)) out.push({ to: k, type: null });
      if (segWalkable(map, pts[S], pts[T], ch)) out.push({ to: T, type: null });
      return out;
    }
    const out = adj[u].slice();
    if (segWalkable(map, pts[u], pts[T], ch)) out.push({ to: T, type: null });
    return out;
  };
  while (true) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < N + 2; i++)
      if (!visited[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    if (u === -1 || u === T) break;
    visited[u] = true;
    for (const ed of linksOf(u)) {
      const v = ed.to;
      const w = ed.cost ?? Math.hypot(pts[v].x - pts[u].x, pts[v].y - pts[u].y);
      const nd = dist[u] + w;
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        etype[v] = ed.type;
      }
    }
  }
  if (dist[T] === Infinity) return [];
  const path = [];
  let cur = T;
  while (cur !== -1) {
    path.unshift({ x: pts[cur].x, y: pts[cur].y, seg: etype[cur] });
    cur = prev[cur];
  }
  return funnelPath(map, path, ch);
}

// ---------- Standardkarte (an die Bildkomposition angelehnt) ----------

function octagon(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

function defaultMap(w, h) {
  const roadA = { x: 0.015 * w, y: 0.9 * h };
  const roadB = { x: 0.985 * w, y: 0.1 * h };
  const roadHalf = 0.075 * h;
  const dx = roadB.x - roadA.x;
  const dy = roadB.y - roadA.y;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  const roadAt = (t) => ({ x: roadA.x + dx * t, y: roadA.y + dy * t });
  const off = (p, s, d) => ({ x: p.x + nx * s * d, y: p.y + ny * s * d });

  const road = {
    name: "Landstraße",
    pts: [
      off(roadA, 1, roadHalf),
      off(roadB, 1, roadHalf),
      off(roadB, -1, roadHalf),
      off(roadA, -1, roadHalf),
    ],
  };
  const plazaC = { x: 0.865 * w, y: 0.185 * h };
  const plaza = { name: "Burghof", pts: octagon(plazaC.x, plazaC.y, 0.14 * h) };
  const villageC = { x: 0.115 * w, y: 0.845 * h };
  const village = { name: "Dorf", pts: octagon(villageC.x, villageC.y, 0.16 * h) };

  const hedges = [0.2, 0.31, 0.46, 0.63, 0.74].map((t, i) => {
    const c = off(roadAt(t), i % 2 === 0 ? 1 : -1, roadHalf + 0.05 * h);
    return { name: i === 2 ? "Kletterhecke" : "Hecke", pts: octagon(c.x, c.y, 0.065 * h) };
  });
  const climbHedge = hedges[2];

  const castle = {
    name: "Burg",
    pts: [
      { x: 0.66 * w, y: 0 },
      { x: w, y: 0 },
      { x: w, y: 0.13 * h },
      { x: 0.66 * w, y: 0.13 * h },
    ],
  };
  const trees = [
    { name: "Waldstück", pts: octagon(0.36 * w, 0.3 * h, 0.045 * w) },
    { name: "Waldstück", pts: octagon(0.56 * w, 0.66 * h, 0.045 * w) },
    { name: "Waldstück", pts: octagon(0.24 * w, 0.52 * h, 0.04 * w) },
  ];

  // Akrobatik-Dächer: eines grenzt an die Straße, das andere nur per Sprung erreichbar
  const roofAC = off(roadAt(0.56), 1, roadHalf + 0.03 * h);
  const roofBC = off(roadAt(0.7), -1, roadHalf + 0.18 * h);
  const roofA = { name: "Marktdach", pts: octagon(roofAC.x, roofAC.y, 0.055 * h) };
  const roofB = { name: "Marktdach", pts: octagon(roofBC.x, roofBC.y, 0.055 * h) };

  // Blockierende Zone: Bachlauf, den niemand überqueren kann
  const streamC = off(roadAt(0.38), -1, roadHalf + 0.13 * h);
  const stream = {
    name: "Bach",
    pts: [
      { x: streamC.x - 0.09 * w, y: streamC.y - 0.1 * h },
      { x: streamC.x + 0.02 * w, y: streamC.y - 0.13 * h },
      { x: streamC.x + 0.05 * w, y: streamC.y - 0.02 * h },
      { x: streamC.x - 0.06 * w, y: streamC.y + 0.01 * h },
    ],
  };

  const sentryPost = { x: plazaC.x, y: plazaC.y + 0.14 * h * 0.45 };

  return {
    world: { w, h },
    layers: {
      walk: [road, plaza, village].concat(hedges),
      climb: [climbHedge],
      acro: [roofA, roofB],
      hide: [village].concat(hedges),
      blocking: [stream],
      block: [castle].concat(trees),
      start: [{ name: "Dorf", pts: octagon(villageC.x, villageC.y, 0.13 * h) }],
      goal: [{ name: "Schatzkammer", pts: octagon(plazaC.x, plazaC.y - 0.14 * h * 0.35, 0.03 * h) }],
      interact: [
        {
          name: "Wegweiser",
          pts: octagon(villageC.x + 0.05 * w, villageC.y - 0.12 * h, 26),
          effect: { type: "msg", text: "Wegweiser: Der Sheriff bewacht den Burghof. über die Dächer kommt man ihm näher.", once: false },
        },
        {
          name: "Waffenkammer",
          pts: octagon(plazaC.x + 0.06 * w, plazaC.y + 0.05 * h, 34),
          effect: { type: "weapon" },
        },
        {
          name: "Kräuterbeet",
          pts: octagon(roadAt(0.3).x, roadAt(0.3).y - roadHalf - 0.05 * h, 30),
          effect: { type: "stamina", once: true },
        },
      ],
      paths: [
        { name: "Westpatrouille", pts: [roadAt(0.12), roadAt(0.26), roadAt(0.4)] },
        { name: "Ostpatrouille", pts: [roadAt(0.56), roadAt(0.7), roadAt(0.84)] },
      ],
      fx: [],
    },
    markers: {
      guards: [
        { type: "pacer", path: "Westpatrouille", weapon: { cat: "spear", tier: "std" }, skill: "green" },
        { type: "pacer", path: "Ostpatrouille", weapon: { cat: "sword", tier: "heavy" }, skill: "regular" },
        { type: "sentry", post: sentryPost, look: roadAt(0.55), weapon: { cat: "heavy", tier: "heavy" }, skill: "elite" },
      ],
      transitions: [
        { type: "jump", name: "Dachsprung", from: roofAC, to: roofBC },
        {
          type: "door",
          name: "Geheimgang",
          from: { x: villageC.x + 30, y: villageC.y + 30 },
          to: { x: plazaC.x - 30, y: plazaC.y + 40 },
        },
      ],
    },
  };
}

// Sicherstellen, dass jede Ebene existiert (alte Karten/JSONs ohne fx etc.)
function ensureLayers(map) {
  map.layers ??= {};
  for (const ln of LAYER_NAMES) if (!Array.isArray(map.layers[ln])) map.layers[ln] = [];
  return map;
}

function scaleMap(map, nw, nh) {
  const sx = nw / map.world.w;
  const sy = nh / map.world.h;
  const sp = (p) => ({ x: p.x * sx, y: p.y * sy });
  const out = {
    world: { w: nw, h: nh },
    layers: Object.fromEntries(
      LAYER_NAMES.map((ln) => [
        ln,
        (map.layers[ln] ?? []).map((poly) => ({
          name: poly.name,
          pts: poly.pts.map(sp),
          ...(poly.effect ? { effect: poly.effect } : {}),
        })),
      ]),
    ),
    markers: {
      guards: map.markers.guards.map((gd) =>
        gd.type === "pacer" && gd.path
          ? { ...gd }
          : gd.type === "pacer"
            ? { type: "pacer", a: sp(gd.a), b: sp(gd.b), weapon: gd.weapon, skill: gd.skill, attentive: gd.attentive }
            : { type: "sentry", post: sp(gd.post), look: sp(gd.look), weapon: gd.weapon, skill: gd.skill, attentive: gd.attentive },
      ),
      transitions: (map.markers.transitions ?? []).map((tr) => ({
        type: tr.type,
        name: tr.name ?? "",
        from: sp(tr.from),
        to: sp(tr.to),
      })),
    },
  };
  return out;
}

// ---------- Bewegung ----------

function moveAlongPath(e, speed, dt, map) {
  if (e.jump) {
    e.jump.t += (dt * 300) / Math.max(30, e.jump.dist);
    if (e.jump.t >= 1) {
      e.x = e.jump.x1;
      e.y = e.jump.y1;
      e.facing = e.jump.ang;
      e.jump = null;
      e.path.shift();
    }
    return true;
  }
  if (!e.path.length || speed <= 0) return false;
  let budget = speed * dt;
  while (budget > 0 && e.path.length) {
    const target = e.path[0];
    if (target.seg === "door") {
      e.path.shift();
      e.x = target.x;
      e.y = target.y;
      continue;
    }
    if (target.seg === "jump") {
      e.path.shift();
      e.jump = {
        x0: e.x,
        y0: e.y,
        x1: target.x,
        y1: target.y,
        t: 0,
        dist: Math.hypot(target.x - e.x, target.y - e.y),
        ang: Math.atan2(target.y - e.y, target.x - e.x),
      };
      return true;
    }
    const dx = target.x - e.x;
    const dy = target.y - e.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 2) {
      e.x = target.x;
      e.y = target.y;
      e.path.shift();
      continue;
    }
    e.facing = Math.atan2(dy, dx);
    const step = Math.min(budget, dist);
    e.x += (dx / dist) * step;
    e.y += (dy / dist) * step;
    budget -= step;
  }
  return true;
}

// ---------- Spielzustand ----------

function newGame(map) {
  const esc = startRegion(map);
  const startOffsets = [
    { x: -26, y: 10 },
    { x: -46, y: -12 },
    { x: -10, y: 32 },
  ];
  const charDefs = [
    { id: "robin", name: "Robin", role: "Erfahrener Krieger · klettert · Einhänder", color: "#2f7d32", speed: 132, sneakSpeed: 72, koRange: 46, canClimb: true, stamina: 100, skill: "veteran", weapon: { cat: "sword", tier: "std" } },
    { id: "john", name: "Little John", role: "Erfahrener Krieger · Morgenstern", color: "#6b4f2a", speed: 118, sneakSpeed: 64, koRange: 72, stamina: 120, skill: "veteran", weapon: { cat: "heavy", tier: "heavy" } },
    { id: "marian", name: "Marian", role: "Kämpferin light · Akrobatin (klettert auch) · Dolch", color: "#3b6fa0", speed: 152, sneakSpeed: 82, koRange: 44, canAcro: true, canClimb: true, stamina: 80, skill: "green", weapon: { cat: "sword", tier: "light" } },
  ];
  const chars = charDefs.map((cd, i) => {
    const raw = { x: esc.x + startOffsets[i].x, y: esc.y + startOffsets[i].y };
    const pos = nearestWalkable(map, raw, cd) ?? { x: esc.x, y: esc.y };
    return {
      ...cd,
      x: pos.x,
      y: pos.y,
      path: [],
      facing: -Math.PI / 3,
      koTarget: null,
      caught: false,
      jump: null,
      maxStamina: cd.stamina,
      stamina: cd.stamina,
      engaged: [],
      attackTarget: null,
      disengageUntil: 0,
      canBow: cd.id === "robin",
      bowMode: false,
      bowSwitchAt: 0,
      arrows: cd.id === "robin" ? BOW.quiver : 0,
    };
  });
  const charNavs = {};

  const guards = map.markers.guards.map((gd, i) => {
    let pacer = gd.type === "pacer";
    let a;
    let b;
    let post;
    let look;
    // Pfad-Referenz: benannte Polylinie aus der paths-Ebene
    let pathPts = null;
    if (gd.path != null) {
      const pl = (map.layers.paths ?? []).find(
        (p) => p.name === gd.path || (typeof gd.path === "number" && (map.layers.paths ?? [])[gd.path] === p),
      );
      if (pl && pl.pts && pl.pts.length >= 1) {
        pathPts = pl.pts.map((p) => ({ x: p.x, y: p.y }));
      }
    }
    if (pathPts) {
      pacer = pathPts.length >= 2;
      pathPts = pathPts.map((p) => nearestWalkable(map, p, null) ?? p);
      post = pathPts[0];
      look = pathPts[1] ?? { x: post.x + 100, y: post.y };
      a = post;
      b = look;
    } else if (pacer) {
      a = nearestWalkable(map, gd.a, null) ?? gd.a ?? { x: 0, y: 0 };
      b = nearestWalkable(map, gd.b, null) ?? gd.b ?? a;
      post = a;
      look = b;
    } else {
      post = nearestWalkable(map, gd.post, null) ?? gd.post ?? { x: 0, y: 0 };
      look = gd.look ?? { x: post.x + 100, y: post.y };
      a = post;
      b = look;
    }
    const guard = {
      id: i,
      name: pacer ? `Patrouille ${i + 1}` : "Posten",
      x: post.x,
      y: post.y,
      homePath: pathPts ? pathPts : pacer ? [a, b] : [post],
      wpIndex: pacer ? 1 : 0,
      path: [],
      facing: Math.atan2(look.y - post.y, look.x - post.x),
      state: "patrol",
      suspTarget: null,
      scanTimer: 0,
      lastSeen: null,
      lostSightAt: 0,
      repathAt: 0,
      foundBodies: [],
      pauseTimer: 0,
      pauseCooldown: 4 + i * 3.5,
      distractTimer: 0,
      distractCooldown: 4,
      baseFacing: Math.atan2(look.y - post.y, look.x - post.x),
      speed: pacer ? 58 : 0,
      skill: normSkill(gd.skill) ?? randSkill(),
      weapon: normWeapon(gd.weapon) ?? randWeapon(),
      attentive: typeof gd.attentive === "boolean" ? gd.attentive : Math.random() < 0.5,
      engagedChars: [],
    };
    guard.maxHp = Math.round(COMBAT.guardHp * SKILLS[guard.skill].mult);
    guard.hp = guard.maxHp;
    return guard;
  });

  return {
    map,
    nav: null,
    charNavs,
    chars,
    guards,
    selected: 0,
    sneak: false,
    gold: false,
    knocked: 0,
    status: "playing",
    time: 0,
    noiseAt: 0,
    combatAcc: 0,
    combatFx: [],
    arrows: [],
    whistleAt: -99,
    whistleFx: null,
    showWalk: true,
    paused: false,
    interacted: new Set(),
    items: [],
  };
}

// ---------- Spiellogik ----------

// Kartenwechsel: baut neues Spiel auf neuer Karte, übernimmt Charakter-Fortschritt
function applyMapChange(g) {
  const key = g.pendingMap;
  g.pendingMap = null;
  if (!key) return false;
  let nextMap = null;
  let nextId = null;
  if (typeof key === "string") {
    const entry = (g.mapPool ?? {})[key];
    if (typeof entry === "function") nextMap = entry();
    else if (entry && entry.map) {
      // Spiel-Sammlung: { id, map, name } aus dem geladenen Spiel
      nextMap = entry.map;
      nextId = entry.id;
    } else if (entry) nextMap = entry;
  } else if (key && key.layers) {
    nextMap = key;
  }
  if (!nextMap || !nextMap.layers || !nextMap.layers.walk) return false;
  if (nextId) g.mapId = nextId;
  const ng = newGame(nextMap);
  // Charakter-Fortschritt übernehmen (Position wird neu gesetzt)
  for (const nc of ng.chars) {
    const oc = g.chars.find((c) => c.id === nc.id);
    if (!oc) continue;
    nc.weapon = oc.weapon;
    nc.stamina = oc.stamina;
    nc.maxStamina = oc.maxStamina;
    nc.caught = oc.caught;
    nc.bowMode = oc.bowMode ?? false;
    nc.bowSwitchAt = oc.bowSwitchAt ?? 0;
    nc.arrows = oc.arrows ?? nc.arrows;
  }
  ng.items = g.items ?? [];
  ng.knocked = g.knocked;
  ng.selected = g.selected;
  ng.paused = g.paused;
  ng.mapPool = g.mapPool;
  Object.assign(g, ng);
  return true;
}

// ---------- Funnel-Pfadmodell ----------
// Statt Wegpunkte nur an Graphknoten (Polygonzentren/-ecken) zu glätten, wird
// der Polygon-Korridor des A*-Pfads extrahiert und mit String-Pulling
// (Simple-Stupid-Funnel) durch die gemeinsamen Kanten (Portale) der Laufflächen
// gezogen. Ergebnis: nahezu optimale Pfade, die Ecken abschneiden, statt an
// Knoten zu zickzacken. Jede Teilstrecke wird mit segWalkable validiert;
// schlägt etwas fehl (Überlappung statt gemeinsamer Kante, Fehlorientierung),
// fällt das Stück auf die alte greedy-Glättung zurück.

function triarea(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

// Längster kolinearer Überlappungs-Abschnitt zwischen Kante p-q und Kante r-s
function segOverlapOnLine(p, q, r, s, eps) {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const L1 = Math.hypot(dx, dy);
  if (!L1) return null;
  const tol = eps * L1;
  const cr = (r.x - p.x) * dy - (r.y - p.y) * dx;
  const cs = (s.x - p.x) * dy - (s.y - p.y) * dx;
  if (Math.abs(cr) > tol || Math.abs(cs) > tol) return null;
  const t = (pt) => ((pt.x - p.x) * dx + (pt.y - p.y) * dy) / (L1 * L1);
  let t1 = t(r);
  let t2 = t(s);
  if (t1 > t2) [t1, t2] = [t2, t1];
  const lo = Math.max(t1, 0);
  const hi = Math.min(t2, 1);
  if (hi - lo < 1e-6) return null;
  return {
    a: { x: p.x + dx * lo, y: p.y + dy * lo },
    b: { x: p.x + dx * hi, y: p.y + dy * hi },
  };
}

const portalCache = new WeakMap();

// Gemeinsame Kante (Portal) zwischen zwei Laufflächen; null wenn nur Überlappung
function portalBetween(map, ia, ib) {
  let m = portalCache.get(map);
  if (!m) {
    m = new Map();
    portalCache.set(map, m);
  }
  const key = ia < ib ? ia + "|" + ib : ib + "|" + ia;
  if (m.has(key)) return m.get(key);
  const polys = movePolys(map);
  const A = polys[ia];
  const B = polys[ib];
  let best = null;
  let bestLen = -1;
  const eps = 0.75;
  for (let i = 0; i < A.pts.length; i++) {
    const p = A.pts[i];
    const q = A.pts[(i + 1) % A.pts.length];
    for (let j = 0; j < B.pts.length; j++) {
      const r = B.pts[j];
      const s = B.pts[(j + 1) % B.pts.length];
      const ov = segOverlapOnLine(p, q, r, s, eps);
      if (ov) {
        const len = Math.hypot(ov.b.x - ov.a.x, ov.b.y - ov.a.y);
        if (len > bestLen) {
          bestLen = len;
          best = ov;
        }
      }
    }
  }
  m.set(key, best);
  return best;
}

// Simple-Stupid-Funnel. portals: [leftPoint, rightPoint][] (rechts der Fahrtrichtung orientiert)
function runFunnel(start, end, portals) {
  const P = portals.concat([[end, end]]);
  const n = P.length;
  const out = [];
  let apex = start;
  let lp = P[0][0];
  let rp = P[0][1];
  let li = 0;
  let ri = 0;
  let i = 1;
  let iter = 0;
  const maxIter = 4 * n + 16;
  while (i < n && iter++ < maxIter) {
    const la = P[i][0];
    const ra = P[i][1];
    // Rechte Schiene verengt?
    if (triarea(apex, rp, ra) <= 0) {
      if (triarea(apex, lp, ra) <= 0) {
        // links gekreuzt: Apex auf linke Schiene vorziehen
        out.push(lp);
        apex = lp;
        i = li + 1;
        lp = P[i][0];
        rp = P[i][1];
        li = ri = i;
        continue;
      }
      rp = ra;
      ri = i;
    }
    // Linke Schiene verengt?
    if (triarea(apex, lp, la) >= 0) {
      if (triarea(apex, rp, la) >= 0) {
        // rechts gekreuzt: Apex auf rechte Schiene vorziehen
        out.push(rp);
        apex = rp;
        i = ri + 1;
        lp = P[i][0];
        rp = P[i][1];
        li = ri = i;
        continue;
      }
      lp = la;
      li = i;
    }
    i++;
  }
  if (iter >= maxIter) return null;
  out.push(end);
  return out;
}

// Ein pfadstück (ohne Übergangsknoten) durch den Polygon-Korridor funneln
function funnelPiece(map, piece, ch) {
  if (piece.length < 3) return piece;
  const corridor = [];
  for (const p of piece) {
    if (p.pi == null || p.pi < 0) continue;
    if (corridor[corridor.length - 1] !== p.pi) corridor.push(p.pi);
  }
  const startPi = walkPolyIndexAt(map, piece[0]);
  const endPi = walkPolyIndexAt(map, piece[piece.length - 1]);
  if (endPi >= 0 && corridor[corridor.length - 1] !== endPi) corridor.push(endPi);
  if (startPi >= 0 && corridor[0] !== startPi) corridor.unshift(startPi);
  if (corridor.length < 2) return smoothPath(map, piece, ch);
  const polys = movePolys(map);
  const centers = corridor.map((pi) => centroid(polys[pi].pts));
  const portals = [];
  for (let i = 0; i + 1 < corridor.length; i++) {
    const portal = portalBetween(map, corridor[i], corridor[i + 1]);
    if (!portal) return smoothPath(map, piece, ch);
    // Orientierung: linker Punkt = links der Fahrtrichtung (Zentroid i -> i+1)
    const dx = centers[i + 1].x - centers[i].x;
    const dy = centers[i + 1].y - centers[i].y;
    const ca = dx * (portal.a.y - centers[i].y) - dy * (portal.a.x - centers[i].x);
    portals.push(ca >= 0 ? [portal.a, portal.b] : [portal.b, portal.a]);
  }
  const fun = runFunnel(piece[0], piece[piece.length - 1], portals);
  if (!fun) return smoothPath(map, piece, ch);
  for (let i = 0; i + 1 < fun.length; i++)
    if (!segWalkable(map, fun[i], fun[i + 1], ch)) return smoothPath(map, piece, ch);
  return fun;
}

// Gesamten Pfad an Übergängen (Tür/Sprung) zerlegen und stückweise funneln.
// Abschließend Shortcut-Pass: sind zwei Punkte um einen Übergang herum direkt
// begehbar, darf er übersprungen werden (altes Verhalten – Türen sind
// Abkürzungen, keine Pflicht).
function funnelPath(map, path, ch) {
  if (path.length < 3) return path;
  const out = [];
  let piece = [];
  for (const p of path) {
    if (p.seg) {
      if (piece.length) {
        out.push(...funnelPiece(map, piece, ch));
        piece = [];
      }
      out.push(p);
    } else {
      piece.push(p);
    }
  }
  if (piece.length) out.push(...funnelPiece(map, piece, ch));
  return smoothPath(map, out, ch);
}
// ---------- Gebackene Navmeshes (Editor) ----------
// Nav ist nicht karteneindeutig, sondern profilabhängig: Wachen (Boden, ohne
// Übergänge), Bodenfiguren, Kletterer und Akrobaten (mit Übergängen) bekommen
// jeweils eigene Graphen. Der Editor backt alle vier vorweg und speichert sie
// samt rev-Prüfsumme auf der Karte; die Runtime lädt sie, statt selbst zu
// rechnen. Stimmt die Prüfsumme nicht (Karte nachträglich geändert, altes
// JSON), wird wie bisher on-demand gebaut.

const NAV_KEYS = ["guard", "ground", "climber", "acrobat"];

function navRev(map) {
  const data = JSON.stringify([
    "nav-v2", // Portale sind seit v2 NICHT mehr Teil der Navigation
    map.world,
    map.layers,
    { guards: map.markers?.guards ?? null, transitions: map.markers?.transitions ?? null },
  ]);
  let h = 5381;
  for (let i = 0; i < data.length; i++) h = ((h * 33) ^ data.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function navKeyForChar(c) {
  if (c.canAcro) return "acrobat";
  if (c.canClimb) return "climber";
  return "ground";
}

function buildNavFor(map, key) {
  // Übergänge (Portale) sind seit v2 NICHT mehr Teil der Navigationsgraphen:
  // Der Spieler betritt ein Portal im Spiel und wählt einen Ausgang. Die
  // Graphen enthalten daher für alle Profile nur begehbare Flächen.
  switch (key) {
    case "guard":
      return buildNav(map, null, false);
    case "ground":
      return buildNav(map, { canClimb: false, canAcro: false }, false);
    case "climber":
      return buildNav(map, { canClimb: true, canAcro: false }, false);
    default:
      return buildNav(map, { canClimb: true, canAcro: true }, false);
  }
}

function loadNav(g, key, c) {
  const nm = g.map.navMesh;
  if (nm && nm.rev === navRev(g.map) && nm.navs && nm.navs[key]) return nm.navs[key];
  return buildNavFor(g.map, key);
}

// Navigationen lazy: erst bauen/laden, wenn tatsächlich ein Weg gesucht wird
function getGuardNav(g) {
  if (!g.nav) g.nav = loadNav(g, "guard", null);
  return g.nav;
}

function getCharNav(g, c) {
  const key = navKeyForChar(c);
  if (!g.charNavs[key]) g.charNavs[key] = loadNav(g, key, c);
  return g.charNavs[key];
}

// ---------- Interaktionsobjekte ----------

const INTERACT_TYPES = {
  msg: "Hinweis / Text",
  weapon: "Waffen-Upgrade (Figur im Polygon)",
  stamina: "Ausdauer auffrischen (alle)",
  knock: "Wachen betäuben (Radius)",
  alarm: "Falle: Alarm auslösen",
  item: "Item einsammeln",
  map: "Karte wechseln (Ziel aus Spielsammlung)",
  guardShift: "Wachen: Pfade/Posten ändern",
  noise: "Köder: Geräusch an Position",
  stealth: "Verkleidung: kurz unentdeckbar",
};
const TIER_ORDER = ["light", "std", "heavy"];

// Führt den Effekt eines Interaktions-Polygons aus.
// Aufrufer prüft: Figur steht im Polygon, Strg+Klick traf das Polygon.
function runInteraction(g, poly, ch, pushMessage) {
  const eff = poly.effect ?? { type: "msg", text: "Nichts passiert." };
  switch (eff.type) {
    case "msg":
      pushMessage(eff.text ?? poly.name ?? "Nichts passiert.");
      break;
    case "weapon": {
      const cur = TIER_ORDER.indexOf(ch.weapon.tier);
      if (cur >= 0 && cur < TIER_ORDER.length - 1) {
        const next = TIER_ORDER[cur + 1];
        ch.weapon = { ...ch.weapon, tier: next };
        pushMessage(`${ch.name} findet ${WEAPON_LISTS[ch.weapon.cat]?.[next] ?? "eine bessere Waffe"}!`);
      } else {
        pushMessage(`${ch.name} trägt bereits die beste Waffe.`);
      }
      break;
    }
    case "stamina": {
      if (eff.scope === "self") {
        ch.stamina = ch.maxStamina;
        pushMessage(`${ch.name} frischt den Mut auf – Ausdauer voll.`);
      } else {
        for (const c of g.chars) if (!c.caught) c.stamina = c.maxStamina;
        pushMessage("Alle frischen Mut gemacht – Ausdauer voll.");
      }
      break;
    }
    case "knock": {
      // Ziel-Polygone auflösen: eigenes Polygon + optional weitere (targets)
      const targetPtSets = [];
      const addTarget = (t) => {
        if (t && t.pts) targetPtSets.push(t.pts);
      };
      if (eff.area === "poly") addTarget(poly);
      for (const t of eff.targets ?? []) {
        if (Array.isArray(t)) {
          // Inline-Punktliste
          if (t.length >= 3) targetPtSets.push(t);
        } else if (t.layer != null && t.index != null) {
          addTarget((g.map.layers[t.layer] ?? [])[t.index]);
        } else if (t.name != null) {
          // Name: erstes Polygons dieses Namens in irgendeiner Ebene
          for (const ln of LAYER_NAMES) {
            const found = (g.map.layers[ln] ?? []).find((p) => p.name === t.name);
            if (found) {
              addTarget(found);
              break;
            }
          }
        }
      }
      let n = 0;
      if (eff.area === "poly" || (eff.targets ?? []).length) {
        // Wachen in einem der Zielpolygone werden betäubt
        for (const guard of g.guards) {
          if (guard.state === "knocked") continue;
          if (targetPtSets.some((pts) => pointInPoly(guard.x, guard.y, pts))) {
            guard.state = "knocked";
            guard.path = [];
            guard.engagedChars = [];
            g.knocked++;
            n++;
          }
        }
      }
      if (!n && eff.area !== "poly" && !(eff.targets ?? []).length) {
        const c = centroid(poly.pts);
        const r = eff.radius ?? 300;
        for (const guard of g.guards) {
          if (guard.state === "knocked") continue;
          if (Math.hypot(guard.x - c.x, guard.y - c.y) <= r) {
            guard.state = "knocked";
            guard.path = [];
            guard.engagedChars = [];
            g.knocked++;
            n++;
          }
        }
      }
      pushMessage(n ? `${n} Wache${n > 1 ? "n" : ""} schla${n > 1 ? "fen" : "gt"} tief und fest.` : "Hier ist keine Wache in Reichweite.");
      break;
    }
    case "alarm": {
      // Optional nur bestimmte Wachen: per Index-Liste oder Zielpolygone
      // (z. B. fx-Flächen). Ohne Angabe werden alle alarmiert.
      const byIndex = new Set(eff.guards ?? []);
      const hasSpec = byIndex.size > 0 || (eff.targets ?? []).length > 0;
      const targetPtSets = [];
      for (const t of eff.targets ?? []) {
        const tp =
          t.layer != null && t.index != null ? (g.map.layers[t.layer] ?? [])[t.index]
          : t.name != null
            ? LAYER_NAMES.flatMap((ln) => g.map.layers[ln] ?? []).find((p) => p.name === t.name)
            : null;
        if (tp) targetPtSets.push(tp.pts);
      }
      const select = (guard, i) =>
        hasSpec
          ? byIndex.has(i) || targetPtSets.some((pts) => pointInPoly(guard.x, guard.y, pts))
          : true;
      let n = 0;
      for (let i = 0; i < g.guards.length; i++) {
        const guard = g.guards[i];
        if (guard.state === "knocked" || !select(guard, i)) continue;
        guard.state = "alert";
        guard.distractKind = null;
        guard.suspTarget = { x: ch.x, y: ch.y };
        guard.lastSeen = { x: ch.x, y: ch.y, at: g.time };
        n++;
      }
      pushMessage(n ? `Eine Glocke ertönt – ${n} Wache${n > 1 ? "n" : ""} auf Alarm!` : "Eine Glocke ertönt – aber niemand hört sie.");
      break;
    }
    case "item":
      (g.items ??= []).push({ name: eff.text ?? poly.name ?? "Item", at: g.time });
      pushMessage(`Aufgehoben: ${eff.text ?? poly.name ?? "Item"}.`);
      break;
    case "map":
      g.pendingMap = eff.map ?? eff.text ?? null;
      if (!g.pendingMap) pushMessage("Diese Tür führt nirgendwohin.");
      else pushMessage("Ihr schreitet durch …");
      break;
    case "guardShift": {
      const shifts = eff.assign ?? eff.guards ?? [];
      for (const s of shifts) {
        const guard = g.guards[s.index];
        if (!guard || guard.state === "knocked") continue;
        let pts = null;
        if (s.path != null) {
          const pl = (g.map.layers.paths ?? []).find((p) => p.name === s.path);
          if (pl && pl.pts && pl.pts.length >= 1) pts = pl.pts.map((p) => ({ x: p.x, y: p.y }));
        } else if (s.a && s.b) pts = [s.a, s.b];
        else if (s.post) pts = [s.post];
        if (pts) {
          pts = pts.map((p) => nearestWalkable(g.map, p, null) ?? p);
          guard.homePath = pts;
          guard.wpIndex = pts.length > 1 ? 1 : 0;
          guard.speed = pts.length > 1 ? 58 : 0;
          guard.x = pts[0].x;
          guard.y = pts[0].y;
        }
        if (s.look) guard.facing = Math.atan2(s.look.y - guard.y, s.look.x - guard.x);
        if (s.reset !== false) {
          guard.state = "patrol";
          guard.suspTarget = null;
          guard.engagedChars = [];
          guard.repathAt = 0;
        }
        guard.path = [];
      }
      pushMessage(eff.text ?? "Drinnen regt sich etwas – die Wachen verteilen sich neu.");
      break;
    }
    case "noise": {
      const at = eff.at ?? centroid(poly.pts);
      const r = eff.radius ?? 400;
      let n = 0;
      for (const guard of g.guards) {
        if (guard.state === "knocked" || guard.state === "alert") continue;
        if (Math.hypot(guard.x - at.x, guard.y - at.y) < r) {
          guard.state = "suspicious";
          guard.suspTarget = { x: at.x, y: at.y };
          guard.scanTimer = 0;
          guard.distractKind = "noise";
          guard.path = findPath(g.map, getGuardNav(g), guard, at);
          n++;
        }
      }
      g.noiseFx = { x: at.x, y: at.y, t: 0 };
      pushMessage(n ? `Ein Geräusch lockt ${n} Wache${n > 1 ? "n" : ""} fort.` : "Ein Geräusch – aber keine Wache hört es.");
      break;
    }
    case "stealth":
      g.stealthUntil = g.time + (eff.duration ?? 12);
      pushMessage(eff.text ?? `Verkleidung! Für ${Math.round(eff.duration ?? 12)} Sekunden sieht euch keine Wache.`);
      break;
    default:
      pushMessage("Nichts passiert.");
  }
}


function guardSees(g, guard, pos, rangeMult = 1) {
  const v = visionParams(guard);
  let range = v.range * rangeMult;
  // Tunnelblick im Kampf: sieht nur bis (kurz hinter) das eigene Ziel
  if (guard.engagedChars && guard.engagedChars.length > 0) {
    const t = g.chars[guard.engagedChars[0]];
    if (t && !t.caught)
      range = Math.min(range, Math.hypot(t.x - guard.x, t.y - guard.y) + 24);
  }
  const dx = pos.x - guard.x;
  const dy = pos.y - guard.y;
  const dist = Math.hypot(dx, dy);
  if (dist > range) return false;
  const ang = Math.atan2(dy, dx);
  let diff = Math.abs(ang - guard.facing);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  if (diff > ((v.fov * Math.PI) / 180) / 2) return false;
  return hasLineOfSight(g.map, guard, pos);
}

// Figur ist vor dieser Wache versteckt, außer die Wache steht im selben Versteck
function charHiddenFrom(map, guard, c) {
  if (!pointHidden(map, c)) return false;
  for (const poly of map.layers.hide) {
    if (pointInPoly(c.x, c.y, poly.pts) && pointInPoly(guard.x, guard.y, poly.pts))
      return false; // Wache hat das Versteck betreten und sieht alles darin
  }
  return true;
}

function updateGame(g, dt, notify) {
  const map = g.map;

  // Kampfrunde (Tick) abarbeiten
  g.combatAcc += dt;
  if (g.combatAcc >= COMBAT.tick) {
    g.combatAcc -= COMBAT.tick;
    processCombatTick(g, notify);
  }

  // Pfeile in der Luft: folgen bewegten Zielen, fliegen in einem Ballistikbogen
  for (const a of g.arrows ?? []) {
    a.t += dt;
    const tg = a.tg != null ? g.guards[a.tg] : null;
    if (tg && tg.state !== "knocked") {
      a.tx = tg.x;
      a.ty = tg.y - 10;
    }
    const f = Math.min(1, a.t / a.dur);
    a.x = a.sx + (a.tx - a.sx) * f;
    a.y = a.sy + (a.ty - a.sy) * f - Math.sin(Math.PI * f) * a.arc;
    if (f >= 1 && !a.done) {
      a.done = true;
      if (tg) {
        if (tg.state !== "knocked") {
          tg.state = "knocked";
          tg.path = [];
          tg.engagedChars = [];
          g.knocked++;
          notify("Volltreffer – Wache am Boden!");
        } else {
          notify("Der Pfeil prallt wirkungslos ab.");
        }
      } else if (a.poly) {
        const robin = g.chars.find((cc) => cc.canBow) ?? g.chars[0];
        runInteraction(g, a.poly, robin, notify);
        if ((a.poly.effect ?? {}).once !== false) (g.interacted ??= new Set()).add(a.poly);
      }
    }
  }
  if (g.arrows) g.arrows = g.arrows.filter((a) => !a.done);

  for (let ci = 0; ci < g.chars.length; ci++) {
    const c = g.chars[ci];
    if (c.caught) continue;
    // Betreten-Trigger: als „beim Betreten“ markierte Interaktionsflächen
    // lösen aus, sobald eine Figur hineinläuft (unsichtbar, kein Strg+Klick).
    (c.enterPolys ??= new Set());
    for (const poly of map.layers.interact ?? []) {
      const eff = poly.effect;
      if (!eff || !eff.enter) continue;
      const inside = pointInPoly(c.x, c.y, poly.pts);
      const was = c.enterPolys.has(poly);
      if (inside !== was) {
        if (inside) {
          c.enterPolys.add(poly);
          if (!(g.interacted ??= new Set()).has(poly)) {
            runInteraction(g, poly, c, notify);
            if ((poly.effect ?? {}).once !== false) g.interacted.add(poly);
          }
        } else {
          c.enterPolys.delete(poly);
        }
      }
    }
    const bound = c.engaged.length > 0;
    const retreating = g.time < c.disengageUntil;
    let base = (g.sneak ? c.sneakSpeed : c.speed) * WEAPON_TIERS[c.weapon.tier].move;
    if (retreating) base *= COMBAT.disengageSlow;
    if (c.bowMode) base *= BOW.moveMult;
    if (c.bowMode && c.engaged.length > 0 && c.bowStowAt == null) {
      // Angegriffen: Bogen within 1s wegpacken, bis dahin kampfunfähig
      c.bowStowAt = g.time + 1;
      notify(`${c.name} wird angegriffen – er muss den Bogen wegpacken!`);
    }
    if (c.bowStowAt != null && g.time >= c.bowStowAt && !c.bowMode) c.bowStowAt = null;
    if (c.bowStowAt != null && g.time >= c.bowStowAt && c.bowMode) {
      c.bowMode = false;
      c.bowStowAt = null;
      c.bowSwitchAt = g.time + BOW.switchTime;
      notify(`${c.name} hat den Bogen weggepackt und zieht die Waffe.`);
    }
    const immobile = !!c.bowMode; // Mit gespanntem Bogen kein Schritt
    const moving =
      bound && !retreating ? false : immobile ? false : moveAlongPath(c, base * speedMult(map, c), dt, map);

    if (moving && !g.sneak && g.time - g.noiseAt > 0.4) {
      g.noiseAt = g.time;
      for (const guard of g.guards) {
        if (guard.state === "knocked" || guard.state === "alert") continue;
        if (Math.hypot(guard.x - c.x, guard.y - c.y) < NOISE_RADIUS) {
          guard.state = "suspicious";
          guard.suspTarget = { x: c.x, y: c.y };
          guard.scanTimer = 0;
          guard.path = findPath(map, getGuardNav(g), guard, { x: c.x, y: c.y });
        }
      }
    }

    if (c.koTarget !== null) {
      const guard = g.guards[c.koTarget];
      if (!guard || guard.state === "knocked" || guard.engagedChars.length > 0) c.koTarget = null;
      else {
        const dist = Math.hypot(guard.x - c.x, guard.y - c.y);
        const koM = guard.distractKind === "noise" ? 1.5 : guard.distractKind === "body" ? 0.6 : 1;
        if (dist <= c.koRange * WEAPON_TIERS[c.weapon.tier].ko * koM) {
          if (guard.state !== "alert") {
            guard.state = "knocked";
            guard.path = [];
            g.knocked++;
            c.path = [];
            notify("Wache ausgeschaltet.");
          }
          c.koTarget = null;
        }
      }
    }

    // Kampf-Angriff: auf die Zielwache zulaufen und binden
    if (c.attackTarget !== null) {
      const guard = g.guards[c.attackTarget];
      if (!guard || guard.state === "knocked") c.attackTarget = null;
      else {
        const dist = Math.hypot(guard.x - c.x, guard.y - c.y);
        if (dist <= COMBAT.engageDist) {
          if (!c.engaged.includes(guard.id)) c.engaged.push(guard.id);
          if (!guard.engagedChars.includes(ci)) guard.engagedChars.push(ci);
          guard.state = "alert";
          guard.distractKind = null;
          guard.lastSeen = { x: c.x, y: c.y };
          guard.lostSightAt = g.time;
          guard.path = [];
          c.path = [];
          c.attackTarget = null;
          c.koTarget = null;
          notify(`${c.name} nimmt den Kampf auf (${weaponName(c.weapon)} gegen ${weaponName(guard.weapon)})!`);
        }
      }
    }

    const gold = goalRegion(map);
    if (!g.gold && Math.hypot(c.x - gold.x, c.y - gold.y) < 34) {
      g.gold = true;
      notify("Gold erbeutet – zurück zum Fluchtpunkt!");
    }

    const esc = startRegion(map);
    if (g.gold && Math.hypot(c.x - esc.x, c.y - esc.y) < esc.r) {
      g.status = "won";
      return;
    }
  }

  // Portale: aktive Figur nahe einem Portal-Eingang -> Ausgänge zur Auswahl.
  // Portale sind NICHT Teil der Navigation: Der Spieler läuft zum Eingang,
  // sieht die möglichen Ausgänge (nummerierte Marker) und wählt mit 1–9.
  const act = g.chars[g.selected];
  if (act && !act.caught && g.status === "playing") {
    const trans = map.markers.transitions ?? [];
    let entry = null;
    for (const tr of trans) {
      if (tr.type === "jump" && !act.canAcro) continue;
      if (Math.hypot(tr.from.x - act.x, tr.from.y - act.y) < 42) {
        entry = tr;
        break;
      }
    }
    const hadPortal = !!g.portal;
    if (entry) {
      // Gleicher Name = ein Portal mit mehreren Ausgängen
      const groupName = entry.name ?? "";
      const members = groupName
        ? trans.filter((t2) => (t2.name ?? "") === groupName)
        : [entry];
      const options = [];
      for (const m of members) {
        if (!options.some((o) => Math.hypot(o.x - m.to.x, o.y - m.to.y) < 2))
          options.push({ x: m.to.x, y: m.to.y });
      }
      g.portal = { name: groupName, kind: entry.type, options };
      if (!hadPortal)
        notify(
          "Portal betreten – Ausgang wählen: " +
            options.map((_, i) => String(i + 1)).join(", ") +
            (options.length === 1 ? " (Taste 1)" : ""),
        );
    } else if (hadPortal) {
      g.portal = null;
    }
  } else if (g.portal) {
    g.portal = null;
  }

  const activeChars = g.chars.filter((c) => !c.caught);

  for (const guard of g.guards) {
    if (guard.state === "knocked") continue;

    // Verkleidung aktiv: Wachen, die nicht gerade kämpfen, verlieren das Ziel
    if (g.stealthUntil && g.time < g.stealthUntil && guard.engagedChars.length === 0 && guard.state !== "patrol") {
      guard.state = "patrol";
      guard.suspTarget = null;
      guard.lastSeen = null;
      guard.path = [];
    }

    // Gebundene Wache: kämpft, folgt nur ihrem Gegner
    if (guard.engagedChars.length > 0) {
      const c0 = g.chars[guard.engagedChars[0]];
      if (!c0 || c0.caught) {
        guard.engagedChars = [];
      } else {
        guard.state = "alert";
        guard.distractKind = null;
        guard.lastSeen = { x: c0.x, y: c0.y };
        guard.lostSightAt = g.time;
        const d = Math.hypot(guard.x - c0.x, guard.y - c0.y);
        guard.facing = Math.atan2(c0.y - guard.y, c0.x - guard.x);
        if (d > CATCH_DIST) {
          const sp = 62 * dt;
          guard.x += ((c0.x - guard.x) / d) * sp;
          guard.y += ((c0.y - guard.y) / d) * sp;
        }
        continue;
      }
    }

    // Alarmierte Wache schließt sich einem Kampf in der Nähe an
    if (guard.state === "alert" && guard.engagedChars.length === 0) {
      for (let ci = 0; ci < g.chars.length; ci++) {
        const c = g.chars[ci];
        if (c.caught || c.engaged.length === 0) continue;
        if (Math.hypot(guard.x - c.x, guard.y - c.y) < COMBAT.engageDist + 10) {
          guard.engagedChars.push(ci);
          c.engaged.push(guard.id);
          notify(`Achtung: ${c.engaged.length} Gegner im Kampf gegen ${c.name}!`);
          break;
        }
      }
    }

    let seen = null;
    for (const c of activeChars) {
      if (g.stealthUntil && g.time < g.stealthUntil) break; // Verkleidung: keine Entdeckung
      if (charHiddenFrom(map, guard, c)) continue;
      const mult = g.sneak ? 0.55 : 1;
      if (guardSees(g, guard, c, mult)) {
        seen = c;
        break;
      }
    }

    if (seen) {
      if (guard.state !== "alert") {
        for (const other of g.guards) {
          if (other === guard || other.state === "knocked" || other.state === "alert") continue;
          if (Math.hypot(other.x - guard.x, other.y - guard.y) < ALARM_SPREAD) {
            other.state = "suspicious";
            other.suspTarget = { x: seen.x, y: seen.y };
            other.scanTimer = 0;
            other.path = findPath(map, getGuardNav(g), other, { x: seen.x, y: seen.y });
          }
        }
      }
      guard.state = "alert";
      guard.distractKind = null;
      guard.lastSeen = { x: seen.x, y: seen.y };
      guard.lostSightAt = g.time;
    } else if (guard.state === "alert" && g.time - guard.lostSightAt > 5) {
      guard.state = "suspicious";
      guard.suspTarget = guard.lastSeen;
      guard.scanTimer = 0;
      guard.path = findPath(map, getGuardNav(g), guard, guard.lastSeen);
    }

    for (const other of g.guards) {
      if (other.state !== "knocked" || guard.foundBodies.includes(other.id)) continue;
      if (charHiddenFrom(map, guard, other)) continue;
      if (guardSees(g, guard, other)) {
        guard.foundBodies.push(other.id);
        if (guard.state !== "alert") {
          guard.state = "suspicious";
          guard.suspTarget = { x: other.x, y: other.y };
          guard.scanTimer = 0;
          guard.distractKind = "body";
          guard.path = findPath(map, getGuardNav(g), guard, { x: other.x, y: other.y });
        }
      }
    }

    if (guard.state === "patrol") {
      if (guard.homePath.length === 1) {
        // Posten: steht, wird hin und wieder abgelenkt
        guard.distractCooldown -= dt;
        if (guard.distractTimer > 0) {
          guard.distractTimer -= dt;
          guard.facing = guard.baseFacing + 1.9;
          if (guard.distractTimer <= 0) guard.distractCooldown = 6 + Math.random() * 6;
        } else {
          guard.facing = guard.baseFacing + Math.sin(g.time * 0.7 + guard.id) * 0.12;
          if (guard.distractCooldown <= 0) guard.distractTimer = 2.5 + Math.random() * 1.5;
        }
      } else if (guard.pauseTimer > 0) {
        guard.pauseTimer -= dt;
        guard.facing += dt * 0.9 * (Math.sin(g.time * 0.8 + guard.id * 2) > 0 ? 1 : -1);
      } else {
        const wp = guard.homePath[guard.wpIndex];
        if (!guard.path.length && g.time - guard.repathAt > 0.5) {
          guard.repathAt = g.time;
          guard.path = findPath(map, getGuardNav(g), guard, wp);
        }
        const arrived = !moveAlongPath(guard, guard.speed, dt, map);
        guard.pauseCooldown -= dt;
        if (arrived && Math.hypot(guard.x - wp.x, guard.y - wp.y) < 30) {
          guard.wpIndex = (guard.wpIndex + 1) % guard.homePath.length;
          if (guard.pauseCooldown <= 0 && Math.random() < 0.75) {
            guard.pauseTimer = 1.5 + Math.random() * 2.5;
            guard.pauseCooldown = 6 + Math.random() * 8;
          }
        } else if (guard.pauseCooldown <= 0 && Math.random() < dt * 0.1) {
          guard.pauseTimer = 1 + Math.random() * 1.5;
          guard.pauseCooldown = 7 + Math.random() * 7;
        }
      }
    } else if (guard.state === "suspicious") {
      // Köder-Wachen: lange, verwirrt-wackelige Suche (leicht ausknockbar).
      // Leichen-Finder: lange, wache Suche.
      const isNoise = guard.distractKind === "noise";
      const isBody = guard.distractKind === "body";
      const giveUpAfter = isBody ? 7 : isNoise ? 4.5 : 2.8;
      const turnSpeed = isBody ? 2.4 : isNoise ? 0.5 : 1.4;
      const moving = moveAlongPath(guard, isNoise ? 60 : 82, dt, map);
      if (!moving) {
        guard.scanTimer += dt;
        if (isNoise) {
          // Starrt auf den Köder: dreht sich zur Geräuschquelle und fixiert sie
          if (guard.suspTarget) {
            const want = Math.atan2(guard.suspTarget.y - guard.y, guard.suspTarget.x - guard.x);
            let d = want - guard.facing;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            guard.facing += Math.max(-turnSpeed * 3 * dt, Math.min(turnSpeed * 3 * dt, d));
          }
        } else {
          guard.facing += dt * turnSpeed;
        }
        if (guard.scanTimer > giveUpAfter) {
          guard.state = "patrol";
          guard.distractKind = null;
          guard.path = [];
          if (guard.homePath.length === 1) guard.distractCooldown = 4;
        }
      }
    } else if (guard.state === "alert") {
      if (g.time - guard.repathAt > 0.4) {
        guard.repathAt = g.time;
        const target = guard.lastSeen ?? activeChars[0];
        if (target) guard.path = findPath(map, getGuardNav(g), guard, target);
      }
      moveAlongPath(guard, 118, dt, map);
    }

    if (guard.state === "alert") {
      for (const c of activeChars) {
        const ci = g.chars.indexOf(c);
        if (guard.engagedChars.includes(ci)) continue;
        if (Math.hypot(guard.x - c.x, guard.y - c.y) < CATCH_DIST) {
          // Wache eröffnet den Kampf statt die Figur sofort zu fassen
          if (!c.engaged.includes(guard.id)) c.engaged.push(guard.id);
          guard.engagedChars.push(ci);
          c.koTarget = null;
          c.attackTarget = null;
          c.path = [];
          notify(`Wache eröffnet den Kampf gegen ${c.name}!`);
        }
      }
    }
  }
}

// ---------- Rendering ----------

function drawBackground(ctx, map, img) {
  if (img && img.complete && img.naturalWidth > 0) {
    // Hintergrund 1:1 in voller Auflösung (keine Skalierung auf das Welt-Rechteck)
    ctx.drawImage(img, 0, 0);
    return;
  }
  // Ersatzkarte aus den Polygonen
  ctx.fillStyle = "#4a7c3a";
  ctx.fillRect(0, 0, map.world.w, map.world.h);
  for (const poly of movePolys(map)) {
    const pts = poly.pts;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = "#b59a6b";
    ctx.fill();
  }
}

function fillPolyPath(ctx, poly) {
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
}

function drawBush(ctx, x, y, r) {
  const greens = ["#24501f", "#2f5d2a", "#1c421a"];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + x * 0.1;
    ctx.fillStyle = greens[i % 3];
    ctx.beginPath();
    ctx.ellipse(x + Math.cos(a) * r * 0.4, y + Math.sin(a) * r * 0.25 - 4, r * 0.45, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCone(ctx, g, guard) {
  const color =
    guard.state === "alert"
      ? "rgba(239,68,68,0.25)"
      : guard.state === "suspicious"
        ? "rgba(245,158,11,0.2)"
        : "rgba(250,204,21,0.14)";
  const stroke =
    guard.state === "alert"
      ? "rgba(239,68,68,0.55)"
      : guard.state === "suspicious"
        ? "rgba(245,158,11,0.5)"
        : "rgba(250,204,21,0.4)";
  const v = visionParams(guard);
  const fov = (v.fov * Math.PI) / 180;
  let range = v.range;
  if (guard.engagedChars && guard.engagedChars.length > 0) {
    const t = g.chars[guard.engagedChars[0]];
    if (t && !t.caught)
      range = Math.min(range, Math.hypot(t.x - guard.x, t.y - guard.y) + 24);
  }
  const N = 20;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const ang = guard.facing - fov / 2 + (fov * i) / N;
    let maxT = range;
    for (let t = 20; t <= range; t += 14) {
      if (pointBlocksSight(g.map, { x: guard.x + Math.cos(ang) * t, y: guard.y + Math.sin(ang) * t })) {
        maxT = t - 14;
        break;
      }
    }
    pts.push({ x: guard.x + Math.cos(ang) * maxT, y: guard.y + Math.sin(ang) * maxT });
  }
  ctx.beginPath();
  ctx.moveTo(guard.x, guard.y);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawGuard(ctx, guard, t) {
  if (guard.state === "knocked") {
    ctx.save();
    ctx.translate(guard.x, guard.y);
    ctx.rotate(0.5);
    ctx.fillStyle = "#00000033";
    ctx.beginPath();
    ctx.ellipse(0, 6, 20, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#8a8f98";
    ctx.beginPath();
    ctx.ellipse(0, 0, 17, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#6b7280";
    ctx.beginPath();
    ctx.arc(14, -2, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.fillStyle = "#00000033";
  ctx.beginPath();
  ctx.ellipse(guard.x, guard.y + 3, 12, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  const bodyColor =
    guard.state === "alert" ? "#b91c1c" : guard.state === "suspicious" ? "#d97706" : "#9aa0aa";
  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.arc(guard.x, guard.y - 10, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d1d5db";
  ctx.beginPath();
  ctx.arc(guard.x, guard.y - 17, 6, 0, Math.PI * 2);
  ctx.fill();
  // Aufmerksamkeits-Anzeige: offenes Auge (hell, links vom Helm) vs. Lidstrich
  if (guard.attentive && guard.distractKind !== "noise") {
    ctx.strokeStyle = "#f8fafc";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(guard.x - 13, guard.y - 17, 4, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = "#f8fafc";
    ctx.beginPath();
    ctx.arc(guard.x - 13, guard.y - 17, 1.4, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(guard.x - 17, guard.y - 17);
    ctx.lineTo(guard.x - 9, guard.y - 17);
    ctx.stroke();
  }
  // Waffenring: Farbe = Kategorie, Stärke = Stufe
  if (guard.weapon && WEAPONS[guard.weapon.cat]) {
    ctx.strokeStyle = WEAPONS[guard.weapon.cat].color;
    ctx.lineWidth = guard.weapon.tier === "light" ? 1.5 : guard.weapon.tier === "heavy" ? 4 : 2.5;
    ctx.beginPath();
    ctx.arc(guard.x, guard.y - 10, 15, 0, Math.PI * 2);
    ctx.stroke();
    if (guard.weapon.tier === "heavy") {
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(guard.x, guard.y - 10, 19, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // HP-Balken (nur wenn beschädigt)
  const maxHp = guard.maxHp ?? COMBAT.guardHp;
  if (guard.hp !== undefined && guard.hp < maxHp) {
    ctx.fillStyle = "#00000088";
    ctx.fillRect(guard.x - 14, guard.y - 30, 28, 4);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(guard.x - 14, guard.y - 30, (28 * Math.max(0, guard.hp)) / maxHp, 4);
  }
  // Kampf-Indikator
  if (guard.engagedChars && guard.engagedChars.length > 0) {
    ctx.strokeStyle = `rgba(239,68,68,${0.5 + Math.sin(t * 8) * 0.4})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(guard.x, guard.y - 10, 23, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Skill-Pips über dem Helm (1=Rookie bis 4=Elite)
  const sk = guard.skill && SKILLS[guard.skill];
  if (sk) {
    for (let i = 0; i < sk.pips; i++) {
      ctx.fillStyle = guard.skill === "elite" ? "#f87171" : guard.skill === "veteran" ? "#fbbf24" : "#94a3b8";
      ctx.beginPath();
      ctx.arc(guard.x - 7 + i * 5, guard.y - 27 - (guard.hp < maxHp ? 6 : 0), 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const fx = Math.cos(guard.facing);
  const fy = Math.sin(guard.facing);
  ctx.strokeStyle = "#f8fafc";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(guard.x + fx * 5, guard.y - 13 + fy * 2);
  ctx.lineTo(guard.x + fx * 13, guard.y - 13 + fy * 6);
  ctx.stroke();
  if (guard.pauseTimer > 0 || guard.distractTimer > 0) {
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    for (let i = 0; i < 3; i++) {
      const bob = Math.sin(t * 5 + i * 1.2) * 2;
      ctx.beginPath();
      ctx.arc(guard.x - 8 + i * 8, guard.y - 32 + bob, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function entPos(e) {
  if (e.jump) {
    const t = e.jump.t;
    return {
      x: e.jump.x0 + (e.jump.x1 - e.jump.x0) * t,
      y: e.jump.y0 + (e.jump.y1 - e.jump.y0) * t - Math.sin(Math.PI * t) * 48,
    };
  }
  return { x: e.x, y: e.y };
}

function drawChar(ctx, c, selected, t) {
  const p = entPos(c);
  if (c.jump) {
    ctx.strokeStyle = "rgba(251,191,36,0.5)";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(c.jump.x0, c.jump.y0);
    ctx.quadraticCurveTo(
      (c.jump.x0 + c.jump.x1) / 2,
      (c.jump.y0 + c.jump.y1) / 2 - 60,
      c.jump.x1,
      c.jump.y1,
    );
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (selected) {
    ctx.strokeStyle = `rgba(251,191,36,${0.6 + Math.sin(t * 4) * 0.3})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + 3, 17, 8, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = "#00000033";
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + 3, 11, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = c.color;
  ctx.beginPath();
  ctx.arc(p.x, p.y - 10, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#00000044";
  ctx.beginPath();
  ctx.arc(p.x, p.y - 12, 7, Math.PI, Math.PI * 2);
  ctx.fill();
  // Ausdauerbalken + Waffenmarkierung
  if (c.stamina !== undefined && (c.stamina < c.maxStamina || (c.engaged && c.engaged.length > 0))) {
    const frac = Math.max(0, c.stamina / c.maxStamina);
    ctx.fillStyle = "#00000088";
    ctx.fillRect(p.x - 14, p.y - 30, 28, 4);
    ctx.fillStyle = frac > 0.5 ? "#34d399" : frac > 0.25 ? "#fbbf24" : "#ef4444";
    ctx.fillRect(p.x - 14, p.y - 30, 28 * frac, 4);
    if (c.weapon && WEAPONS[c.weapon.cat]) {
      ctx.fillStyle = WEAPONS[c.weapon.cat].color;
      ctx.fillRect(p.x - 14, p.y - 24, 7, 3);
    }
    // Skill-Pips neben dem Ausdauerbalken
    const csk = c.skill && SKILLS[c.skill];
    if (csk) {
      ctx.fillStyle = c.skill === "veteran" ? "#fbbf24" : "#94a3b8";
      for (let i = 0; i < csk.pips; i++) {
        ctx.beginPath();
        ctx.arc(p.x + 8 + i * 4, p.y - 27, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawPlay(ctx, g, t, showWalk) {
  const map = g.map;

  // Portal-Eingänge (violette Ringe; Sprünge orange) und aktive Ausgangswahl
  for (const tr of map.markers.transitions ?? []) {
    ctx.beginPath();
    ctx.arc(tr.from.x, tr.from.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = tr.type === "jump" ? "rgba(217,119,6,0.5)" : "rgba(139,92,246,0.5)";
    ctx.fill();
    ctx.strokeStyle = "#c4b5fd";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (g.portal) {
    g.portal.options.forEach((o, i) => {
      const pulse = 1 + 0.15 * Math.sin(t * 5);
      ctx.beginPath();
      ctx.arc(o.x, o.y, 12 * pulse, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(196,181,253,0.35)";
      ctx.fill();
      ctx.strokeStyle = "#a78bfa";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#ddd6fe";
      ctx.font = "bold 12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), o.x, o.y);
    });
    const c = g.chars[g.selected];
    ctx.fillStyle = "rgba(221,214,254,0.9)";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Portal: Ausgang mit 1" + (g.portal.options.length > 1 ? "\u2013" + g.portal.options.length : "") + " wählen", c.x, c.y - 34);
  }

  if (showWalk) {
    const overlayColors = {
      walk: "rgba(134,239,172,0.14)",
      climb: "rgba(96,165,250,0.18)",
      acro: "rgba(244,114,182,0.18)",
    };
    for (const ln of MOVE_LAYERS) {
      for (const poly of map.layers[ln] ?? []) {
        fillPolyPath(ctx, poly.pts);
        ctx.fillStyle = overlayColors[ln];
        ctx.fill();
      }
    }
    // Blockierende Zonen rot schraffieren
    for (const poly of map.layers.blocking ?? []) {
      fillPolyPath(ctx, poly.pts);
      ctx.fillStyle = "rgba(127,29,29,0.35)";
      ctx.fill();
      ctx.strokeStyle = "rgba(248,113,113,0.6)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  const esc = startRegion(map);
  const pulse = 0.5 + Math.sin(t * 3) * 0.3;
  ctx.strokeStyle = `rgba(134,239,172,${pulse})`;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(esc.x, esc.y, esc.r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = "bold 15px Georgia, serif";
  ctx.textAlign = "center";
  ctx.fillStyle = `rgba(134,239,172,${0.75 + Math.sin(t * 3) * 0.2})`;
  ctx.fillText("VERSTECK / FLUCHT", esc.x, esc.y - esc.r - 10);

  // Verstecke als Hecken andeuten
  for (const poly of map.layers.hide) {
    const c = centroid(poly.pts);
    const r = Math.sqrt(polyArea(poly.pts) / Math.PI);
    ctx.strokeStyle = "rgba(52,211,153,0.35)";
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 2;
    fillPolyPath(ctx, poly.pts);
    ctx.stroke();
    ctx.setLineDash([]);
    if (r > 18) drawBush(ctx, c.x, c.y, Math.min(r, 42));
  }

  // Goldtruhe
  const gold = goalRegion(map);
  if (!g.gold) {
    const shine = 0.5 + Math.sin(t * 3) * 0.4;
    ctx.strokeStyle = `rgba(253,224,71,${shine})`;
    ctx.lineWidth = 3;
    ctx.strokeRect(gold.x - 16, gold.y - 14, 32, 24);
  }
  ctx.fillStyle = "#00000033";
  ctx.beginPath();
  ctx.ellipse(gold.x, gold.y + 12, 18, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#7c5a2e";
  ctx.fillRect(gold.x - 15, gold.y - 6, 30, 17);
  ctx.fillStyle = g.gold ? "#3f2f18" : "#facc15";
  ctx.fillRect(gold.x - 15, gold.y - 11, 30, 6);

  // Übergänge (Türen + Sprünge)
  for (const tr of map.markers.transitions ?? []) {
    if (tr.type === "door") {
      ctx.strokeStyle = "rgba(167,139,250,0.55)";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(tr.from.x, tr.from.y);
      ctx.lineTo(tr.to.x, tr.to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const key of ["from", "to"]) {
        ctx.fillStyle = "#a78bfa";
        ctx.fillRect(tr[key].x - 7, tr[key].y - 10, 14, 20);
        ctx.fillStyle = "#2e1065";
        ctx.fillRect(tr[key].x - 3, tr[key].y - 6, 6, 12);
      }
    } else {
      ctx.strokeStyle = "rgba(251,191,36,0.55)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([7, 6]);
      ctx.beginPath();
      ctx.moveTo(tr.from.x, tr.from.y);
      ctx.quadraticCurveTo((tr.from.x + tr.to.x) / 2, (tr.from.y + tr.to.y) / 2 - 55, tr.to.x, tr.to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(251,191,36,0.8)";
      for (const key of ["from", "to"]) {
        ctx.beginPath();
        ctx.arc(tr[key].x, tr[key].y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  for (const guard of g.guards) {
    if (guard.state === "knocked") continue;
    drawCone(ctx, g, guard);
  }

  if (g.whistleFx) {
    const r = g.whistleFx.t * WHISTLE_RADIUS;
    ctx.strokeStyle = `rgba(251,191,36,${Math.max(0, 1 - g.whistleFx.t / 1.2)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(g.whistleFx.x, g.whistleFx.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Köder-Geräusch
  if (g.noiseFx) {
    const r = g.noiseFx.t * 400;
    ctx.strokeStyle = `rgba(96,165,250,${Math.max(0, 1 - g.noiseFx.t / 1.2)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(g.noiseFx.x, g.noiseFx.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Verkleidung aktiv: schimmernder Ring um alle Figuren
  if (g.stealthUntil && g.time < g.stealthUntil) {
    for (const c of g.chars) {
      if (c.caught) continue;
      ctx.strokeStyle = `rgba(167,139,250,${0.5 + Math.sin(t * 5) * 0.3})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(c.x, c.y - 10, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Kampflärm
  for (const fx of g.combatFx ?? []) {
    const r = fx.t * COMBAT.noiseRadius;
    ctx.strokeStyle = `rgba(239,68,68,${Math.max(0, 1 - fx.t / 1.2)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Pfeile im Flug: Ausrichtung entlang der Ballistikbahn (inkl. Bogenhöhe)
  for (const a of g.arrows ?? []) {
    const f = Math.min(1, a.t / a.dur);
    const dx = a.tx - a.sx;
    const dyLin = a.ty - a.sy;
    const dyArc = Math.PI * a.arc * Math.cos(Math.PI * f); // d/dt von -sin(pi f)*arc
    const ang = Math.atan2(dyLin / a.dur - dyArc / a.dur, dx / a.dur);
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(ang);
    ctx.strokeStyle = "#e7d8b1";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-11, 0);
    ctx.lineTo(6, 0);
    ctx.stroke();
    ctx.fillStyle = "#f8fafc";
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(4, -3);
    ctx.lineTo(4, 3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Bogen-Anzeige für Robin: Ladekreis beim Spannen/Abhängen/Wegpacken, Ring wenn bereit
  const robinBow = g.chars.find((cc) => cc.canBow);
  if (
    robinBow &&
    !robinBow.caught &&
    (robinBow.bowMode || robinBow.bowStowAt != null || g.time < robinBow.bowSwitchAt)
  ) {
    const stowing = robinBow.bowStowAt != null; // erzwungen nach Angriff (1 s)
    const unbowing = !robinBow.bowMode && g.time < robinBow.bowSwitchAt; // manuelles Abhängen
    const total = stowing ? 1 : BOW.switchTime;
    const remaining = stowing
      ? Math.max(0, robinBow.bowStowAt - g.time)
      : Math.max(0, robinBow.bowSwitchAt - g.time);
    const elapsed = total - remaining;
    if (stowing || unbowing || robinBow.bowMode) {
      if (robinBow.bowMode && !stowing && remaining <= 0) {
        // Bogen bereit: durchgehender Ring
        ctx.strokeStyle = "rgba(163,230,53,0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(robinBow.x, robinBow.y - 10, 19, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // Ladebalken als Kreis: grün beim Spannen, gelb beim Abhängen/Wegpacken
        ctx.strokeStyle = "rgba(0,0,0,0.4)";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(robinBow.x, robinBow.y - 10, 19, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = robinBow.bowMode ? "#a3e635" : "#fbbf24";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(
          robinBow.x,
          robinBow.y - 10,
          19,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * Math.min(1, Math.max(0, elapsed / total)),
        );
        ctx.stroke();
      }
    }
  }

  // Interaktionsobjekte
  for (const poly of map.layers.interact ?? []) {
    // Betreten-Trigger sind im Spiel unsichtbar
    if ((poly.effect ?? {}).enter) continue;
    const used = (g.interacted ?? new Set()).has(poly);
    const c = centroid(poly.pts);
    ctx.strokeStyle = used ? "rgba(120,113,108,0.4)" : "rgba(167,139,250,0.7)";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    fillPolyPath(ctx, poly.pts);
    if (!used) {
      ctx.fillStyle = "rgba(163,230,53,0.08)";
      ctx.fill();
    }
    // Beschießbar-Markierung (Bogen-Ziel)
    if ((poly.effect ?? {}).targetable && !used) {
      ctx.strokeStyle = "rgba(163,230,53,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 9, 0, Math.PI * 2);
      ctx.moveTo(c.x - 14, c.y);
      ctx.lineTo(c.x - 5, c.y);
      ctx.moveTo(c.x + 5, c.y);
      ctx.lineTo(c.x + 14, c.y);
      ctx.moveTo(c.x, c.y - 14);
      ctx.lineTo(c.x, c.y - 5);
      ctx.moveTo(c.x, c.y + 5);
      ctx.lineTo(c.x, c.y + 14);
      ctx.stroke();
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // Zielpolygone des Effekts: schwach angedeutet, deutlich hervorgehoben,
    // sobald eine Figur im Interaktions-Polygon steht – nur solange unbenutzt
    const eff = poly.effect;
    if (!used && eff && (eff.targets ?? []).length) {
      const occupied = g.chars.some((ch) => !ch.caught && pointInPoly(ch.x, ch.y, poly.pts));
      const pulse = 0.5 + Math.sin(t * 4) * 0.3;
      for (const tg of eff.targets ?? []) {
        const tp =
          tg.layer != null && tg.index != null
            ? (map.layers[tg.layer] ?? [])[tg.index]
            : tg.name != null
              ? LAYER_NAMES.flatMap((ln) => map.layers[ln] ?? []).find((p) => p.name === tg.name)
              : null;
        if (!tp) continue;
        fillPolyPath(ctx, tp.pts);
        if (occupied) {
          ctx.fillStyle = "rgba(167,139,250,0.18)";
          ctx.fill();
          ctx.strokeStyle = `rgba(196,181,253,${0.55 + pulse * 0.4})`;
          ctx.lineWidth = 2.5;
          ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = "rgba(167,139,250,0.35)";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([2, 6]);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        // Verbindungslinie Objekt → Ziel bei Betreten
        if (occupied) {
          const tc = centroid(tp.pts);
          ctx.strokeStyle = `rgba(196,181,253,${0.35 + pulse * 0.25})`;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 7]);
          ctx.beginPath();
          ctx.moveTo(c.x, c.y);
          ctx.lineTo(tc.x, tc.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = used ? "rgba(120,113,108,0.5)" : `rgba(196,181,253,${0.6 + Math.sin(t * 3) * 0.3})`;
    ctx.fillRect(-5, -5, 10, 10);
    ctx.restore();
    // noise-Köder: Geräuschposition + Wirkungsradius nur sichtbar, solange
    // unbenutzt UND eine Figur im Interaktions-Polygon steht
    if (!used && poly.effect?.type === "noise") {
      const occupied = g.chars.some((ch) => !ch.caught && pointInPoly(ch.x, ch.y, poly.pts));
      if (occupied) {
        const at = poly.effect.at ?? c;
        const r = poly.effect.radius ?? 400;
        const pulse = 0.5 + Math.sin(t * 4) * 0.3;
        // Radius-Kreis um die Geräuschposition
        ctx.strokeStyle = `rgba(96,165,250,${0.65 + pulse * 0.35})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(96,165,250,0.08)";
        ctx.fill();
        // Verbindungslinie Objekt → Geräuschposition (nur bei externer Position)
        if (poly.effect.at) {
          ctx.strokeStyle = "rgba(96,165,250,0.6)";
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 7]);
          ctx.beginPath();
          ctx.moveTo(c.x, c.y);
          ctx.lineTo(at.x, at.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // Marker an der Geräuschposition
        ctx.fillStyle = "rgba(96,165,250,0.95)";
        ctx.beginPath();
        ctx.arc(at.x, at.y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#0c120a";
        ctx.font = "bold 11px Georgia, serif";
        ctx.textAlign = "center";
        ctx.fillText("♪", at.x, at.y + 4);
      }
    }
  }

  // Geplante Laufwege der Spieler-Charaktere
  for (let i = 0; i < g.chars.length; i++) {
    const c = g.chars[i];
    if (c.caught || !c.path || c.path.length === 0) continue;
    ctx.strokeStyle = c.color;
    ctx.globalAlpha = i === g.selected ? 0.9 : 0.45;
    ctx.lineWidth = i === g.selected ? 2.5 : 1.5;
    ctx.setLineDash([6, 7]);
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    for (const p of c.path) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // Zielmarke am Pfadende
    const last = c.path[c.path.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = c.color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  const ents = [];
  for (let i = 0; i < g.chars.length; i++) {
    const c = g.chars[i];
    if (c.caught) continue;
    ents.push({ depth: c.y, render: () => drawChar(ctx, c, i === g.selected, t) });
  }
  for (const guard of g.guards) {
    ents.push({ depth: guard.y, render: () => drawGuard(ctx, guard, t) });
  }
  ents.sort((a, b) => a.depth - b.depth);
  for (const e of ents) e.render();
}

const LAYER_STYLE = {
  walk: { fill: "rgba(134,239,172,0.15)", stroke: "#86efac", label: "Lauffläche" },
  climb: { fill: "rgba(96,165,250,0.18)", stroke: "#60a5fa", label: "Klettern" },
  acro: { fill: "rgba(244,114,182,0.18)", stroke: "#f472b6", label: "Akrobatik" },
  hide: { fill: "rgba(52,211,153,0.2)", stroke: "#34d399", label: "Versteck" },
  blocking: { fill: "rgba(127,29,29,0.3)", stroke: "#ef4444", label: "Hindernis" },
  block: { fill: "rgba(248,113,113,0.15)", stroke: "#f87171", label: "Sichtblocker" },
  start: { fill: "rgba(74,222,128,0.25)", stroke: "#4ade80", label: "Start/Flucht" },
  goal: { fill: "rgba(250,204,21,0.25)", stroke: "#facc15", label: "Ziel (Gold)" },
  interact: { fill: "rgba(167,139,250,0.15)", stroke: "#a78bfa", label: "Interaktion" },
  paths: { fill: "rgba(0,0,0,0)", stroke: "#fb7185", label: "Wachenpfade & Übergänge" },
  fx: { fill: "rgba(45,212,191,0.08)", stroke: "#2dd4bf", label: "Effekt-Fläche (ohne Spielfunktion)" },
};

// Zusammengefasste Editor-Ebenen: Start/Flucht + Ziel und Hindernis +
// Sichtblocker teilen sich je eine Auswahl im Ebenen-Panel. Neue Polygone
// landen über den Unter-Buttons in der jeweiligen Einzel-Ebene.
const EDIT_GROUPS = [
  { layers: ["walk"] },
  { layers: ["climb"] },
  { layers: ["acro"] },
  { layers: ["hide"] },
  { layers: ["blocking", "block"], label: "Hindernis & Sichtblocker", sub: true },
  { layers: ["interact"] },
  { layers: ["paths"] },
  { layers: ["fx"] },
  { layers: ["start", "goal"], label: "Start/Flucht & Ziel", sub: true },
];
const editLayersOf = (ln) =>
  (EDIT_GROUPS.find((g) => g.layers.includes(ln)) ?? { layers: [ln] }).layers;

function drawEdit(ctx, map, edit, hover) {
  const inPaths = edit.layer === "paths";
  for (const layerName of LAYER_NAMES) {
    if (layerName === "paths" && !inPaths) continue;
    const style = LAYER_STYLE[layerName];
    const polys = map.layers[layerName] ?? [];
    for (let pi = 0; pi < polys.length; pi++) {
      const poly = polys[pi];
      const pts = poly.pts;
      if (pts.length < 2) continue;
      const sel = edit.selected && edit.selected.layer === layerName && edit.selected.index === pi;
      const strokeCol = sel ? "#fbbf24" : style.stroke;
      if (layerName === "paths") {
        // Polylinie: offen, mit Wegpunkt-Punkten und Pfeilrichtung
        ctx.strokeStyle = strokeCol;
        ctx.lineWidth = sel ? 3 : 1.5;
        ctx.setLineDash(sel ? [] : [10, 8]);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = strokeCol;
        for (let k = 0; k < pts.length; k++) {
          ctx.beginPath();
          ctx.arc(pts[k].x, pts[k].y, sel ? 6 : 4, 0, Math.PI * 2);
          ctx.fill();
        }
        const label = poly.name ?? "";
        if (label) {
          const c = centroid(pts);
          ctx.font = "bold 13px Georgia, serif";
          ctx.textAlign = "center";
          ctx.lineWidth = 4;
          ctx.strokeStyle = "rgba(0,0,0,0.75)";
          ctx.strokeText(label, c.x, c.y - 12);
          ctx.fillStyle = "#fda4af";
          ctx.fillText(label, c.x, c.y - 12);
        }
        continue;
      }
      // Köder-Position von noise-Interaktionen (blauer Marker + Ziellinie)
      // nur wenn das Polygon in der interact-Ebene ausgewählt ist
      if (
        layerName === "interact" &&
        edit.selected?.layer === "interact" &&
        edit.selected.index === pi &&
        poly.effect?.type === "noise" &&
        poly.effect.at
      ) {
        const c = centroid(poly.pts);
        const at = poly.effect.at;
        const r = poly.effect.radius ?? 400;
        ctx.strokeStyle = "rgba(96,165,250,0.85)";
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([4, 6]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(at.x, at.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#60a5fa";
        ctx.beginPath();
        ctx.arc(at.x, at.y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#0c120a";
        ctx.font = "bold 12px Georgia, serif";
        ctx.textAlign = "center";
        ctx.fillText("♪", at.x, at.y + 4);
      }
      fillPolyPath(ctx, pts);
      ctx.fillStyle = style.fill;
      ctx.fill();
      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = sel ? 3 : 1.5;
      ctx.stroke();
      const label = poly.name ?? "";
      if (label) {
        const c = centroid(pts);
        ctx.font = "bold 14px Georgia, serif";
        ctx.textAlign = "center";
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.strokeText(label, c.x, c.y);
        ctx.fillStyle = "#fde68a";
        ctx.fillText(label, c.x, c.y);
      }
      if (sel) {
        ctx.fillStyle = "#fbbf24";
        for (const p of pts) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // Zeichen-in-Progress
  if (edit.drawing && edit.drawing.length > 0) {
    const pts = edit.drawing.concat(hover ? [hover] : []);
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#fbbf24";
    for (const p of edit.drawing) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Marker
  const m = map.markers;
  ctx.lineWidth = 2;

  if (inPaths)
  m.guards.forEach((gd, gi) => {
    const isSel = edit.selectedGuard === gi;
    const col = isSel ? "#fbbf24" : "#f87171";
    ctx.fillStyle = col;
    if (gd.type === "pacer" && gd.a && gd.b) {
      for (const key of ["a", "b"]) {
        ctx.beginPath();
        ctx.arc(gd[key].x, gd[key].y, 9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = col;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.moveTo(gd.a.x, gd.a.y);
      ctx.lineTo(gd.b.x, gd.b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.fillText(`WACHE ${gi + 1}`, (gd.a.x + gd.b.x) / 2, (gd.a.y + gd.b.y) / 2 - 14);
    } else if (gd.post && gd.look) {
      ctx.beginPath();
      ctx.arc(gd.post.x, gd.post.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(gd.look.x, gd.look.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(gd.post.x, gd.post.y);
      ctx.lineTo(gd.look.x, gd.look.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.fillText(`POSTEN ${gi + 1}`, gd.post.x, gd.post.y - 16);
    } else {
      // Pfad-referenzierte Wache: Marker am ersten Punkt des benannten Pfads
      const pl = (map.layers.paths ?? []).find((p) => p.name === gd.path);
      if (pl && pl.pts[0]) {
        ctx.beginPath();
        ctx.arc(pl.pts[0].x, pl.pts[0].y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = col;
        ctx.font = "bold 12px Georgia, serif";
        ctx.textAlign = "center";
        ctx.fillText(`WACHE ${gi + 1}`, pl.pts[0].x, pl.pts[0].y - 16);
      }
    }
  });

  // Übergänge (nur in der paths-Ebene editierbar)
  if (inPaths)
  (map.markers.transitions ?? []).forEach((tr, ti) => {
    const isSel = edit.selectedTrans === ti;
    const col = isSel ? "#fbbf24" : tr.type === "door" ? "#a78bfa" : "#fbbf24";
    ctx.strokeStyle = col;
    ctx.lineWidth = isSel ? 3 : 2;
    ctx.setLineDash(tr.type === "door" ? [3, 5] : [7, 6]);
    ctx.beginPath();
    ctx.moveTo(tr.from.x, tr.from.y);
    if (tr.type === "door") ctx.lineTo(tr.to.x, tr.to.y);
    else
      ctx.quadraticCurveTo(
        (tr.from.x + tr.to.x) / 2,
        (tr.from.y + tr.to.y) / 2 - 55,
        tr.to.x,
        tr.to.y,
      );
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = col;
    for (const key of ["from", "to"]) {
      ctx.beginPath();
      ctx.arc(tr[key].x, tr[key].y, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = "bold 12px Georgia, serif";
    ctx.textAlign = "center";
    ctx.fillText(
      tr.type === "door" ? tr.name || "TÜR" : "SPRUNG",
      (tr.from.x + tr.to.x) / 2,
      (tr.from.y + tr.to.y) / 2 - 14,
    );
  });
}

// ---------- Hauptkomponente ----------

// Importiertes / geladenes Karten-JSON normalisieren (Ebenen, Wachen, Übergänge).
// Wird vom JSON-Import und vom Laden von Karten aus Spielsammlungen genutzt.
function normalizeImportedMap(parsed) {
  if (!parsed.layers || !parsed.layers.walk || !parsed.markers) throw new Error("Struktur unvollständig");
  const normPoly = (p) =>
    Array.isArray(p)
      ? { name: "", pts: p }
      : { name: p.name ?? "", pts: p.pts ?? p.points ?? [] };
  const rawWalk = parsed.layers.walk ?? [];
  const walkOut = [];
  const climbOut = [...(parsed.layers.climb ?? []).map(normPoly)];
  const acroOut = [...(parsed.layers.acro ?? []).map(normPoly)];
  for (const raw of rawWalk) {
    const flags = Array.isArray(raw) ? [] : raw.flags ?? [];
    const poly = normPoly(raw);
    if (flags.includes("climb")) climbOut.push(poly);
    else if (flags.includes("acro")) acroOut.push(poly);
    else walkOut.push(poly);
  }
  const layerOut = {
    walk: walkOut,
    climb: climbOut,
    acro: acroOut,
    hide: (parsed.layers.hide ?? []).map(normPoly),
    blocking: (parsed.layers.blocking ?? []).map(normPoly),
    block: (parsed.layers.block ?? []).map(normPoly),
    start: (parsed.layers.start ?? []).map(normPoly),
    goal: (parsed.layers.goal ?? []).map(normPoly),
    interact: [...(parsed.layers.interact ?? []).map((p) => {
      const poly = normPoly(p);
      const e = p && !Array.isArray(p) && p.effect ? p.effect : null;
      return e ? { ...poly, effect: e } : poly;
    }),
    ],
    paths: (parsed.layers.paths ?? []).map(normPoly),
    fx: (parsed.layers.fx ?? []).map(normPoly),
  };
  return ensureLayers({
    ...parsed,
    layers: layerOut,
    markers: {
      ...parsed.markers,
      guards: (parsed.markers.guards ?? []).map((gd) => ({
        ...gd,
        weapon: normWeapon(gd.weapon) ?? randWeapon(),
        skill: normSkill(gd.skill) ?? randSkill(),
        attentive: typeof gd.attentive === "boolean" ? gd.attentive : Math.random() < 0.5,
      })),
      transitions: parsed.markers.transitions ?? [],
    },
  });
}

// Fortschritt einer Partie für Sitzungs-Wiederherstellung (Reload) kompakt
// aufzeichnen und auf eine neue Partie übertragen.
function captureProgress(g) {
  return {
    chars: g.chars.map((c) => ({
      id: c.id,
      weapon: c.weapon,
      stamina: c.stamina,
      maxStamina: c.maxStamina,
      caught: c.caught,
      arrows: c.arrows,
      bowMode: c.bowMode,
    })),
    knocked: g.knocked,
    items: g.items ?? [],
  };
}

function applyProgress(g, snap) {
  for (const nc of g.chars) {
    const oc = (snap.chars ?? []).find((x) => x.id === nc.id);
    if (!oc) continue;
    nc.weapon = oc.weapon;
    nc.stamina = oc.stamina;
    nc.maxStamina = oc.maxStamina;
    nc.caught = oc.caught;
    nc.arrows = oc.arrows;
    nc.bowMode = oc.bowMode;
  }
  g.knocked = snap.knocked ?? g.knocked;
  g.items = snap.items ?? [];
}

export default function App() {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const imgScaledRef = useRef(false);
  const worldDims = useRef({ w: 1536, h: 864 });
  const gameRef = useRef(null);
  const camRef = useRef({ x: 0, y: 0, z: 1, follow: true });
  const keysRef = useRef(new Set());
  const dragRef = useRef(null);
  const hoverRef = useRef(null);
  const modeRef = useRef("play");
  const mapRef = useRef(null);
  const editRef = useRef({ drawing: null, selected: null, selectedGuard: null, selectedTrans: null, pickNoiseFor: null });
  const bgFileRef = useRef(null);
  if (!mapRef.current) mapRef.current = ensureLayers(defaultMap(worldDims.current.w, worldDims.current.h));
  if (!gameRef.current) gameRef.current = newGame(mapRef.current);

  const [mode, setMode] = useState("play");
  const [layer, setLayer] = useState("walk");
  const [newTarget, setNewTarget] = useState("start");
  const [worldW, setWorldW] = useState(worldDims.current.w);
  const [worldH, setWorldH] = useState(worldDims.current.h);
  const [navInfo, setNavInfo] = useState(null);
  const [collection, setCollection] = useState(null); // verfügbare Spiele (lokal + Repo)
  const [activeGame, setActiveGame] = useState(null); // laufendes Spiel
  const [menuOpen, setMenuOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [loadingMaps, setLoadingMaps] = useState(false);
  const [wonMaps, setWonMaps] = useState(() => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem("sherwood.won") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const mapIdRef = useRef("builtin");
  const activeGameRef = useRef(null);
  const mapCacheRef = useRef(new Map()); // "gameId/mapId" -> { id, name, data, img, image }
  const [reduceTol, setReduceTol] = useState(2.5);
  const [reduceInfo, setReduceInfo] = useState(null);
  const undoRef = useRef(null);
  useEffect(() => {
    editRef.current.layer = layer;
  }, [layer]);
  const [imgOk, setImgOk] = useState(false);
  const [editInfo, setEditInfo] = useState({ drawing: 0, selected: false, selectedGuard: null, selectedTrans: null, name: "", guardWeapon: null, guardSkill: null, guardPath: "" });
  const [jsonText, setJsonText] = useState("");
  const [ui, setUi] = useState({
    selected: 0,
    sneak: false,
    gold: false,
    knocked: 0,
    status: "playing",
    alarm: 0,
    whistleReady: true,
    hidden: true,
    follow: true,
    showWalk: true,
    paused: false,
    stams: "100,120,80",
    fights: 0,
  });
  const [message, setMessage] = useState(null);

  const pushMessage = useCallback((text) => {
    setMessage(text);
    window.setTimeout(() => setMessage((m) => (m === text ? null : m)), 2600);
  }, []);

  const syncEditInfo = useCallback(() => {
    const e = editRef.current;
    const selPoly =
      e.selected && mapRef.current.layers[e.selected.layer][e.selected.index]
        ? mapRef.current.layers[e.selected.layer][e.selected.index]
        : null;
    setEditInfo({
      drawing: e.drawing ? e.drawing.length : 0,
      selected: !!e.selected,
      selectedGuard: e.selectedGuard,
      selectedTrans: e.selectedTrans,
      name: selPoly ? selPoly.name ?? "" : "",
      layer: e.selected ? e.selected.layer : null,
      effect: selPoly && e.selected?.layer === "interact" ? selPoly.effect ?? { type: "msg", once: true } : null,
      guardWeapon:
        e.selectedGuard !== null && mapRef.current.markers.guards[e.selectedGuard]
          ? mapRef.current.markers.guards[e.selectedGuard].weapon ?? null
          : null,
      guardSkill:
        e.selectedGuard !== null && mapRef.current.markers.guards[e.selectedGuard]
          ? mapRef.current.markers.guards[e.selectedGuard].skill ?? null
          : null,
      guardPath:
        e.selectedGuard !== null && mapRef.current.markers.guards[e.selectedGuard]
          ? mapRef.current.markers.guards[e.selectedGuard].path ?? ""
          : "",
    });
  }, []);

  // Bild laden (Kaskade) -> Karte auf Bildproportionen skalieren
  useEffect(() => {
    let cancelled = false;
    const tryLoad = (i) => {
      if (cancelled) return;
      if (i >= IMG_SOURCES.length) {
        setImgOk(false);
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        imgRef.current = img;
        setImgOk(true);
        if (!imgScaledRef.current) {
          imgScaledRef.current = true;
          if (Math.abs(img.naturalWidth - mapRef.current.world.w) > 2 || Math.abs(img.naturalHeight - mapRef.current.world.h) > 2) {
            mapRef.current = scaleMap(mapRef.current, img.naturalWidth, img.naturalHeight);
            worldDims.current = { w: img.naturalWidth, h: img.naturalHeight };
            setWorldW(img.naturalWidth);
            setWorldH(img.naturalHeight);
            if (gameRef.current.status === "playing" && gameRef.current.time < 3) {
              gameRef.current = newGame(mapRef.current);
            }
          }
        }
      };
      img.onerror = () => tryLoad(i + 1);
      img.src = IMG_SOURCES[i];
    };
    tryLoad(0);
    return () => {
      cancelled = true;
    };
  }, []);

  const startPlay = useCallback(() => {
    gameRef.current = newGame(mapRef.current);
    camRef.current.follow = true;
    modeRef.current = "play";
    setMode("play");
    pushMessage("Mission gestartet.");
  }, [pushMessage]);

  const enterEditor = useCallback(() => {
    editRef.current = { drawing: null, selected: null, selectedGuard: null, selectedTrans: null };
    syncEditInfo();
    modeRef.current = "edit";
    setMode("edit");
  }, [syncEditInfo]);

  const restart = useCallback(() => {
    gameRef.current = newGame(mapRef.current);
    pushMessage("Neuer Versuch!");
  }, [pushMessage]);

  // ---------- Spielsammlungen (lokal + Git-Repo) ----------
  // Ein Spiel = Ordner mit maps/…: index.json listet Spiele, jedes Spiel listet
  // seine Karten (JSON + Hintergrundbild). Lokal: /games/<id>/…, im Repo:
  // raw.githubusercontent.com/<owner>/<repo>/<ref>/games/<id>/…

  const rawBaseFromUrl = (url) => {
    const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)(?:\/tree\/([^/\s]+))?/.exec(url);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3] ?? "main"}/`;
    const m2 = /^https?:\/\/raw\.githubusercontent\.com\/(.+?)\/?$/.exec(url);
    if (m2) return `https://raw.githubusercontent.com/${m2[1].replace(/\/$/, "")}/`;
    return url.endsWith("/") ? url : url + "/";
  };

  const loadCollection = useCallback(async (extraRepoUrl) => {
    const games = [
      {
        id: "builtin",
        name: "Sherwood (eingebaut)",
        source: "builtin",
        base: null,
        maps: [{ id: "builtin", name: "Standardkarte", image: null, json: null }],
      },
    ];
    const readIndex = async (base, source) => {
      try {
        const r = await fetch(base + "index.json");
        if (!r.ok) return;
        const idx = await r.json();
        for (const gm of idx.games ?? []) {
          if (!gm || !gm.id || !Array.isArray(gm.maps)) continue;
          games.push({
            id: gm.id,
            name: gm.name ?? gm.id,
            source,
            base: base + gm.id + "/",
            maps: gm.maps.filter((m) => m && m.id),
          });
        }
      } catch {
        /* Quelle nicht verfügbar – überspringen */
      }
    };
    await readIndex("/games/", "local");
    if (extraRepoUrl) await readIndex(rawBaseFromUrl(extraRepoUrl) + "games/", "repo");
    setCollection({ games });
    return games;
  }, []);

  useEffect(() => {
    // Wenn eine Sitzung mit Nicht-Builtin-Spiel gespeichert ist, übernimmt der
    // Restore-Effect den Ladevorgang (inkl. Repo-URL) – hier nicht doppeln.
    const saved = (() => {
      try {
        return JSON.parse(sessionStorage.getItem("sherwood.session") ?? "null");
      } catch {
        return null;
      }
    })();
    if (saved && saved.game && saved.game.source !== "builtin") return;
    loadCollection();
  }, [loadCollection]);

  const loadMapData = useCallback(async (game, m) => {
    const key = game.id + "/" + m.id;
    if (mapCacheRef.current.has(key)) return mapCacheRef.current.get(key);
    const ent = { id: m.id, name: m.name ?? m.id, data: null, img: null, image: m.image ? (game.base ?? "") + m.image : null };
    mapCacheRef.current.set(key, ent);
    try {
      if (game.source === "builtin" || !m.json) {
        ent.data = ensureLayers(defaultMap(worldDims.current.w, worldDims.current.h));
      } else {
        const r = await fetch((game.base ?? "") + m.json);
        if (!r.ok) throw new Error("HTTP " + r.status);
        ent.data = normalizeImportedMap(await r.json());
      }
    } catch {
      ent.data = ensureLayers(defaultMap(worldDims.current.w, worldDims.current.h));
    }
    return ent;
  }, []);

  const ensureMapImage = useCallback((ent, mapId) => {
    if (!ent || ent.img || !ent.image) return;
    const img = new Image();
    img.onload = () => {
      ent.img = img;
      if (mapIdRef.current === mapId) {
        imgRef.current = img;
        setImgOk(true);
      }
    };
    img.src = ent.image;
  }, []);

  // Bild + Kartengröße einer Karte in die Ansicht übernehmen
  const applyMapToView = useCallback((ent) => {
    imgRef.current = ent.img ?? null;
    setImgOk(!!ent.img);
    ensureMapImage(ent, ent.id);
    worldDims.current = { w: ent.data.world.w, h: ent.data.world.h };
    setWorldW(ent.data.world.w);
    setWorldH(ent.data.world.h);
    imgScaledRef.current = true;
  }, [ensureMapImage]);

  // ---------- Reload-Robustheit (sessionStorage) ----------

  const saveSession = useCallback(() => {
    try {
      const game = activeGameRef.current;
      const g = gameRef.current;
      sessionStorage.setItem(
        "sherwood.session",
        JSON.stringify({
          repoUrl,
          game:
            game && game.source !== "builtin"
              ? { id: game.id, name: game.name, source: game.source, base: game.base, maps: game.maps }
              : null,
          mapId: (g && g.mapId) || mapIdRef.current,
          progress: g ? captureProgress(g) : null,
        }),
      );
    } catch {
      /* Speicher voll / privater Modus: nicht weiter tragisch */
    }
  }, [repoUrl]);

  const markWon = useCallback((id) => {
    if (!id) return;
    setWonMaps((prev) => {
      if (prev.has(id)) return prev;
      const s = new Set(prev);
      s.add(id);
      try {
        sessionStorage.setItem("sherwood.won", JSON.stringify([...s]));
      } catch {
        /* ignorieren */
      }
      return s;
    });
  }, []);

  // Sitzung nach Reload wiederherstellen: Spiel, aktuelle Karte, Fortschritt
  useEffect(() => {
    let cancelled = false;
    const saved = (() => {
      try {
        return JSON.parse(sessionStorage.getItem("sherwood.session") ?? "null");
      } catch {
        return null;
      }
    })();
    if (!saved || !saved.game || saved.game.source === "builtin") return;
    (async () => {
      const games = await loadCollection(saved.repoUrl ?? "");
      if (cancelled) return;
      const gm = games.find((x) => x.id === saved.game.id && x.source === saved.game.source);
      if (!gm || gm.source === "builtin" || !gm.maps.length) return;
      const entries = await Promise.all(gm.maps.map((m) => loadMapData(gm, m)));
      if (cancelled) return;
      const idx = Math.max(0, gm.maps.findIndex((m) => m.id === saved.mapId));
      const m = gm.maps[idx];
      const ent = entries[idx];
      activeGameRef.current = gm;
      setActiveGame(gm);
      if (saved.repoUrl) setRepoUrl(saved.repoUrl);
      mapIdRef.current = m.id;
      mapRef.current = ent.data;
      applyMapToView(ent);
      const g = newGame(ent.data);
      g.mapId = m.id;
      g.mapPool = {};
      gm.maps.forEach((mm, i) => {
        g.mapPool[mm.id] = { id: mm.id, map: entries[i].data, name: mm.name };
      });
      if (saved.progress) applyProgress(g, saved.progress);
      gameRef.current = g;
      pushMessage("Sitzung wiederhergestellt: " + gm.name + " · Karte: " + (m.name ?? m.id));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadCollection, loadMapData, applyMapToView, pushMessage]);

  const startGameMap = useCallback(
    async (game, mapIndex, toEditor) => {
      setLoadingMaps(true);
      const entries = await Promise.all(game.maps.map((m) => loadMapData(game, m)));
      setLoadingMaps(false);
      const game2 = { ...game, maps: game.maps.map((m, i) => ({ ...m, name: m.name ?? entries[i].name })) };
      activeGameRef.current = game2;
      setActiveGame(game2);
      setMenuOpen(false);
      const m = game2.maps[mapIndex] ?? game2.maps[0];
      const ent = entries[mapIndex] ?? entries[0];
      mapIdRef.current = m.id;
      mapRef.current = ent.data;
      applyMapToView(ent);
      const g = newGame(ent.data);
      g.mapId = m.id;
      g.mapPool = {};
      game2.maps.forEach((mm, i) => {
        g.mapPool[mm.id] = { id: mm.id, map: entries[i].data, name: mm.name };
      });
      gameRef.current = g;
      editRef.current = { drawing: null, selected: null, selectedGuard: null, selectedTrans: null };
      syncEditInfo();
      modeRef.current = toEditor ? "edit" : "play";
      setMode(toEditor ? "edit" : "play");
      camRef.current = { x: 0, y: 0, z: 1, follow: true };
      pushMessage("Spiel gestartet: " + game2.name + " · Karte: " + m.name);
      saveSession();
    },
    [loadMapData, applyMapToView, syncEditInfo, pushMessage, saveSession],
  );

  // Karte im Editor anzeigen/bearbeiten (Kartenwechsel ohne Spielneustart)
  const editMap = useCallback(
    async (m) => {
      const game = activeGameRef.current;
      if (!game) return;
      const ent = await loadMapData(game, m);
      mapIdRef.current = m.id;
      mapRef.current = ent.data;
      applyMapToView(ent);
      gameRef.current = newGame(ent.data);
      gameRef.current.mapId = m.id;
      gameRef.current.mapPool = gameRef.current.mapPool ?? {};
      for (const mm of game.maps) {
        const e2 = mapCacheRef.current.get(game.id + "/" + mm.id);
        if (e2) gameRef.current.mapPool[mm.id] = { id: mm.id, map: e2.data, name: mm.name };
      }
      editRef.current = { drawing: null, selected: null, selectedGuard: null, selectedTrans: null };
      syncEditInfo();
      modeRef.current = "edit";
      setMode("edit");
      pushMessage("Karte im Editor: " + (m.name ?? m.id));
      saveSession();
    },
    [loadMapData, applyMapToView, syncEditInfo, pushMessage, saveSession],
  );

  // Leere Karte zum aktiven Spiel hinzufügen (nur im Speicher, via JSON exportierbar)
  const addNewMap = useCallback(() => {
    const game = activeGameRef.current;
    if (!game) return;
    const id = "neu-" + Date.now().toString(36);
    const w = Math.max(400, Math.min(20000, Math.round(Number(worldW) || 2400)));
    const h = Math.max(400, Math.min(20000, Math.round(Number(worldH) || 1600)));
    const rect = (x, y, ww, hh) => ({ name: "", pts: [{ x, y }, { x: x + ww, y }, { x: x + ww, y: y + hh }, { x, y: y + hh }] });
    const data = ensureLayers({
      world: { w, h },
      layers: Object.fromEntries(LAYER_NAMES.map((ln) => [ln, []])),
      markers: { guards: [], transitions: [] },
    });
    data.layers.start.push(rect(40, 40, 120, 120));
    data.layers.goal.push(rect(w - 200, h - 200, 160, 160));
    const m = { id, name: "Neue Karte", image: null, json: null };
    mapCacheRef.current.set(game.id + "/" + id, { id, name: m.name, data, img: null, image: null });
    const game2 = { ...game, maps: [...game.maps, m] };
    activeGameRef.current = game2;
    setActiveGame(game2);
    const g = gameRef.current;
    if (g) g.mapPool = { ...(g.mapPool ?? {}), [id]: { id, map: data, name: m.name } };
    pushMessage("Neue Karte angelegt (nur im Speicher – per JSON exportieren).");
  }, [worldW, worldH, pushMessage]);

  // Nach gewonnenem Spiel: nächste Karte der Sammlung
  const goNextMap = useCallback(() => {
    const g = gameRef.current;
    const game = activeGameRef.current;
    if (!g || !game) return;
    const cur = game.maps.findIndex((m) => m.id === (g.mapId ?? mapIdRef.current));
    if (cur < 0 || cur + 1 >= game.maps.length) {
      pushMessage("Letzte Karte – Sammlung durchgespielt!");
      return;
    }
    const next = game.maps[cur + 1];
    const ent = mapCacheRef.current.get(game.id + "/" + next.id);
    if (!ent) return;
    g.pendingMap = next.id;
    applyMapChange(g);
  }, [pushMessage]);

  const hasNextMap = useCallback(() => {
    const game = activeGameRef.current;
    const g = gameRef.current;
    if (!game || !g) return false;
    const cur = game.maps.findIndex((m) => m.id === (g.mapId ?? mapIdRef.current));
    return cur >= 0 && cur + 1 < game.maps.length;
  }, []);

  // ---------- Spiel-Export (Downloads: JSON + PNG + index.json) ----------

  const downloadFile = (name, dataUrl) => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const exportGame = useCallback(() => {
    const game = activeGameRef.current;
    if (!game) return;
    const mapsOut = [];
    let nImg = 0;
    for (const m of game.maps) {
      const ent = mapCacheRef.current.get(game.id + "/" + m.id);
      if (!ent) continue;
      const safeId = String(m.id).replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadFile(
        safeId + ".json",
        "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(ent.data)),
      );
      const entry = { id: m.id, name: m.name ?? m.id, json: safeId + ".json" };
      if (ent.img && ent.img.naturalWidth > 0) {
        const cv = document.createElement("canvas");
        cv.width = ent.img.naturalWidth;
        cv.height = ent.img.naturalHeight;
        const cx = cv.getContext("2d");
        if (cx) {
          cx.drawImage(ent.img, 0, 0);
          downloadFile(safeId + ".png", cv.toDataURL("image/png"));
          entry.image = safeId + ".png";
          nImg++;
        }
      }
      mapsOut.push(entry);
    }
    const idx = { games: [{ id: game.id, name: game.name, maps: mapsOut }] };
    downloadFile(
      "index.json",
      "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(idx, null, 2)),
    );
    pushMessage(
      "Spiel exportiert: " + mapsOut.length + " Karten-JSONs, " + nImg + " PNG-Bilder, index.json. " +
        "Dateien in games/" + game.id + "/ ablegen.",
    );
  }, [pushMessage]);

  const toggleSneak = useCallback(() => {
    gameRef.current.sneak = !gameRef.current.sneak;
  }, []);

  const toggleFollow = useCallback(() => {
    camRef.current.follow = !camRef.current.follow;
  }, []);

  const toggleBow = useCallback(() => {
    const g = gameRef.current;
    if (g.status !== "playing") return;
    const c = g.chars[g.selected];
    if (!c || c.caught) return;
    if (!c.canBow) {
      pushMessage("Nur Robin führt einen Bogen.");
      return;
    }
    if (g.time < c.bowSwitchAt) return;
    c.bowMode = !c.bowMode;
    c.bowStowAt = null;
    c.bowSwitchAt = g.time + BOW.switchTime;
    c.path = [];
    pushMessage(c.bowMode ? "Robin spannt den Bogen …" : "Robin hängt den Bogen ab …");
    setUi((p) => ({ ...p, bow: c.bowMode ? "switch" : "stow", arrows: c.arrows ?? 0 }));
  }, [pushMessage]);

  const toggleWalk = useCallback(() => {
    gameRef.current.showWalk = !gameRef.current.showWalk;
  }, []);

  const whistle = useCallback(() => {
    const g = gameRef.current;
    if (g.time - g.whistleAt < 6 || g.status !== "playing") return;
    const c = g.chars[g.selected];
    if (c.caught) return;
    g.whistleAt = g.time;
    g.whistleFx = { x: c.x, y: c.y, t: 0 };
    for (const guard of g.guards) {
      if (guard.state === "knocked" || guard.state === "alert") continue;
      if (Math.hypot(guard.x - c.x, guard.y - c.y) < WHISTLE_RADIUS) {
        guard.state = "suspicious";
        guard.suspTarget = { x: c.x, y: c.y };
        guard.scanTimer = 0;
        guard.path = findPath(g.map, getGuardNav(g), guard, { x: c.x, y: c.y });
      }
    }
  }, []);

  // ---------- Editor-Aktionen ----------

  const setInteractEffect = useCallback((part, value) => {
    const ed = editRef.current;
    if (!ed.selected || ed.selected.layer !== "interact") return;
    const poly = mapRef.current.layers.interact[ed.selected.index];
    poly.effect = { once: true, ...(poly.effect ?? { type: "msg" }), [part]: value };
    syncEditInfo();
  }, [syncEditInfo]);

  const togglePause = useCallback(() => {
    const g = gameRef.current;
    if (!g || g.status !== "playing") return;
    g.paused = !g.paused;
    setUi((p) => ({ ...p, paused: g.paused }));
  }, []);

  const startPolygon = useCallback(() => {
    editRef.current.drawing = [];
    editRef.current.selected = null;
    syncEditInfo();
  }, [syncEditInfo]);

  const finishPolygon = useCallback(() => {
    const e = editRef.current;
    if (e.drawing && e.drawing.length >= 3) {
      // Zusammengefasste Gruppe: Ziel-Ebene über Unter-Auswahl bestimmen
      const target = editLayersOf(layer).length > 1 ? newTarget : layer;
      mapRef.current.layers[target].push({ name: "", pts: e.drawing });
    }
    e.drawing = null;
    syncEditInfo();
  }, [layer, newTarget, syncEditInfo]);

  const deleteSelected = useCallback(() => {
    const e = editRef.current;
    if (e.selected) {
      mapRef.current.layers[e.selected.layer].splice(e.selected.index, 1);
      e.selected = null;
    }
    syncEditInfo();
  }, [syncEditInfo]);

  const deleteGuard = useCallback(() => {
    const e = editRef.current;
    if (e.selectedGuard !== null) {
      mapRef.current.markers.guards.splice(e.selectedGuard, 1);
      e.selectedGuard = null;
      syncEditInfo();
    }
  }, [syncEditInfo]);

  const addPacer = useCallback(() => {
    const c = camRef.current;
    const cx = c.x + VIEW_W / (2 * c.z);
    const cy = c.y + VIEW_H / (2 * c.z);
    mapRef.current.markers.guards.push({
      type: "pacer",
      a: { x: cx - 90, y: cy },
      b: { x: cx + 90, y: cy },
      weapon: randWeapon(),
      skill: randSkill(),
    });
  }, []);

  const addSentry = useCallback(() => {
    const c = camRef.current;
    const cx = c.x + VIEW_W / (2 * c.z);
    const cy = c.y + VIEW_H / (2 * c.z);
    mapRef.current.markers.guards.push({
      type: "sentry",
      post: { x: cx, y: cy },
      look: { x: cx + 140, y: cy + 60 },
      weapon: randWeapon(),
      skill: randSkill(),
    });
  }, []);

  const setGuardWeapon = useCallback((part, value) => {
    const ed = editRef.current;
    if (ed.selectedGuard === null) return;
    const gd = mapRef.current.markers.guards[ed.selectedGuard];
    const w = normWeapon(gd.weapon) ?? { cat: "sword", tier: "std" };
    gd.weapon = part === "cat" ? { ...w, cat: value } : { ...w, tier: value };
    setEditInfo((p) => ({ ...p, guardWeapon: gd.weapon }));
  }, []);

  const setGuardSkill = useCallback((value) => {
    const ed = editRef.current;
    if (ed.selectedGuard === null) return;
    const gd = mapRef.current.markers.guards[ed.selectedGuard];
    gd.skill = normSkill(value) ?? "regular";
    setEditInfo((p) => ({ ...p, guardSkill: gd.skill }));
  }, []);

  // Wache einem benannten Pfad aus der paths-Ebene zuweisen
  // noise-Effekt: nächste Karte-Klicks setzen die Geräuschposition
  const pickNoisePos = useCallback(() => {
    editRef.current.pickNoiseFor = editRef.current.selected;
    syncEditInfo();
  }, [syncEditInfo]);

  const setGuardPath = useCallback((value) => {
    const ed = editRef.current;
    if (ed.selectedGuard === null) return;
    const gd = mapRef.current.markers.guards[ed.selectedGuard];
    if (value === "") delete gd.path;
    else gd.path = value;
    setEditInfo((p) => ({ ...p, guardPath: gd.path ?? "" }));
  }, []);

  const addJump = useCallback(() => {
    const c = camRef.current;
    const cx = c.x + VIEW_W / (2 * c.z);
    const cy = c.y + VIEW_H / (2 * c.z);
    if (!mapRef.current.markers.transitions) mapRef.current.markers.transitions = [];
    mapRef.current.markers.transitions.push({
      type: "jump",
      name: "",
      from: { x: cx - 70, y: cy },
      to: { x: cx + 70, y: cy },
    });
  }, []);

  const addDoor = useCallback(() => {
    const c = camRef.current;
    const cx = c.x + VIEW_W / (2 * c.z);
    const cy = c.y + VIEW_H / (2 * c.z);
    if (!mapRef.current.markers.transitions) mapRef.current.markers.transitions = [];
    mapRef.current.markers.transitions.push({
      type: "door",
      name: "",
      from: { x: cx - 60, y: cy },
      to: { x: cx + 60, y: cy },
    });
  }, []);

  const deleteTrans = useCallback(() => {
    const e = editRef.current;
    if (e.selectedTrans !== null) {
      mapRef.current.markers.transitions.splice(e.selectedTrans, 1);
      e.selectedTrans = null;
      syncEditInfo();
    }
  }, [syncEditInfo]);

  const resetMap = useCallback(() => {
    mapRef.current = ensureLayers(defaultMap(worldDims.current.w, worldDims.current.h));
    editRef.current = { drawing: null, selected: null, selectedGuard: null, selectedTrans: null };
    syncEditInfo();
  }, [syncEditInfo]);

  const onBgFile = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgOk(true);
      // Karte auf die volle Bildgröße bringen (kein Stauchen auf das alte Welt-Rechteck)
      imgScaledRef.current = true;
      if (Math.abs(img.naturalWidth - mapRef.current.world.w) > 2 || Math.abs(img.naturalHeight - mapRef.current.world.h) > 2) {
        mapRef.current = scaleMap(mapRef.current, img.naturalWidth, img.naturalHeight);
        worldDims.current = { w: img.naturalWidth, h: img.naturalHeight };
        setWorldW(img.naturalWidth);
        setWorldH(img.naturalHeight);
        if (gameRef.current.status === "playing" && gameRef.current.time < 3) {
          gameRef.current = newGame(mapRef.current);
        }
      }
    };
    img.src = url;
    e.target.value = "";
  }, []);

  const clearBg = useCallback(() => {
    imgRef.current = null;
    setImgOk(false);
  }, []);

  const clearPolygons = useCallback(() => {
    const m = mapRef.current;
    for (const ln of LAYER_NAMES) m.layers[ln] = [];
    editRef.current = { ...editRef.current, drawing: null, selected: null };
    syncEditInfo();
    pushMessage("Alle Polygone entfernt (Wachen, Pfade und Karte bleiben).");
  }, [syncEditInfo, pushMessage]);

  const applyWorldSize = useCallback(() => {
    const w = Math.max(400, Math.min(20000, Math.round(Number(worldW) || 0)));
    const h = Math.max(400, Math.min(20000, Math.round(Number(worldH) || 0)));
    if (w !== mapRef.current.world.w || h !== mapRef.current.world.h) {
      mapRef.current = scaleMap(mapRef.current, w, h);
      worldDims.current = { w, h };
      if (gameRef.current.status === "playing") gameRef.current = newGame(mapRef.current);
    }
    setWorldW(w);
    setWorldH(h);
  }, [worldW, worldH]);

  const reducePoints = useCallback(() => {
    const map = mapRef.current;
    let before = 0;
    let after = 0;
    undoRef.current = JSON.stringify(map.layers);
    for (const ln of LAYER_NAMES) {
      for (const poly of map.layers[ln] ?? []) {
        before += poly.pts.length;
        poly.pts = simplifyPolyDP(poly.pts, reduceTol);
        after += poly.pts.length;
      }
    }
    setReduceInfo({ before, after, tol: reduceTol });
    syncEditInfo();
    pushMessage("Punkte reduziert: " + before + " → " + after + " (Toleranz " + reduceTol + " px).");
  }, [reduceTol, syncEditInfo, pushMessage]);

  const undoReduce = useCallback(() => {
    if (!undoRef.current) return;
    mapRef.current.layers = JSON.parse(undoRef.current);
    undoRef.current = null;
    setReduceInfo(null);
    syncEditInfo();
    pushMessage("Reduktion rückgängig – Original-Polygone wiederhergestellt.");
  }, [syncEditInfo, pushMessage]);

  const bakeNavMesh = useCallback(() => {
    const map = mapRef.current;
    const t0 = performance.now();
    const rev = navRev(map);
    const navs = {};
    const counts = {};
    for (const key of NAV_KEYS) {
      const nav = buildNavFor(map, key);
      navs[key] = nav;
      counts[key] = nav.nodes.length;
    }
    map.navMesh = { rev, navs };
    setNavInfo({ rev, counts, ms: Math.round(performance.now() - t0) });
    pushMessage(
      "Navmesh gebacken (Wache/Boden/Kletterer/Akrobat): " +
        NAV_KEYS.map((k) => counts[k] + " Knoten").join(" / ") +
        " in " + Math.round(performance.now() - t0) + " ms. Export enthält ihn automatisch.",
    );
  }, [pushMessage]);

  const exportJson = useCallback(() => {
    setJsonText(JSON.stringify(mapRef.current));
  }, []);

  const importJson = useCallback(() => {
    try {
      mapRef.current = normalizeImportedMap(JSON.parse(jsonText));
      worldDims.current = mapRef.current.world ?? worldDims.current;
      setWorldW(worldDims.current.w);
      setWorldH(worldDims.current.h);
      // Optionale Karten-Sammlung für map-Interaktionen (Karte wechseln)
      if (parsed.mapPool && typeof parsed.mapPool === "object") {
        if (gameRef.current) gameRef.current.mapPool = parsed.mapPool;
      }
      pushMessage("Karte importiert.");
    } catch (err) {
      pushMessage("Import fehlgeschlagen: " + String(err.message ?? err));
    }
  }, [jsonText, pushMessage]);

  // ---------- Eingaben ----------

  useEffect(() => {
    const onKey = (e) => {
      if (e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")) return;
      const k = e.key;
      if (k === "r" || k === "R") {
        if (modeRef.current === "play") restart();
        return;
      }
      if (modeRef.current === "edit") {
        const ed = editRef.current;
        if (k === "Escape") {
          ed.drawing = null;
          syncEditInfo();
        }
        if (k === "Enter") finishPolygon();
        // N = neues Polygon beginnen
        if (k === "n" || k === "N") startPolygon();
        // 1-9, 0, Minus = Ebene wählen (Reihenfolge wie im Ebenen-Panel)
        const digitIdx = "1234567890-".indexOf(k);
        if (digitIdx >= 0 && digitIdx < LAYER_NAMES.length) {
          setLayer(LAYER_NAMES[digitIdx]);
        }
        // L = nächste Ebene durchschalten
        if (k === "l" || k === "L") {
          const cur = LAYER_NAMES.indexOf(editRef.current.layer ?? "walk");
          setLayer(LAYER_NAMES[(cur + 1) % LAYER_NAMES.length]);
        }
        if (k === "Delete" || k === "Backspace") {
          e.preventDefault();
          if (ed.selectedGuard !== null) deleteGuard();
          else if (ed.selectedTrans !== null) deleteTrans();
          else deleteSelected();
        }
        return;
      }
      const g = gameRef.current;
      if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
        keysRef.current.add(k);
        camRef.current.follow = false;
        e.preventDefault();
      }
      // Portal: Ausgang mit 1–9 wählen (nur aktive Figur, nur im Spielmodus)
      if (g.portal && g.portal.options.length) {
        const di = "123456789".indexOf(k);
        if (di >= 0 && di < g.portal.options.length) {
          const c = g.chars[g.selected];
          const o = g.portal.options[di];
          c.x = o.x;
          c.y = o.y;
          c.path = [];
          c.jump = null;
          c.koTarget = null;
          c.attackTarget = null;
          pushMessage(
            g.portal.kind === "jump"
              ? c.name + " springt hinüber!"
              : c.name + " schlüpft durch " + (g.portal.name || "den Gang") + ".",
          );
          g.portal = null;
          return;
        }
      }
      if (g.status !== "playing") return;
      if (k === "p" || k === "P" || k === " ") {
        if (modeRef.current === "play") {
          e.preventDefault();
          togglePause();
        }
        return;
      }
      if (k === "1") g.selected = 0;
      if (k === "2") g.selected = 1;
      if (k === "3") g.selected = 2;
      if (k === "s" || k === "S") toggleSneak();
      if (k === "b" || k === "B") toggleBow();
      if (k === "q" || k === "Q") whistle();
      if (k === "f" || k === "F") toggleFollow();
      if (k === "v" || k === "V") toggleWalk();
    };
    const onKeyUp = (e) => keysRef.current.delete(e.key);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [restart, toggleSneak, whistle, toggleFollow, toggleWalk, togglePause, toggleBow, finishPolygon, deleteSelected, deleteGuard, deleteTrans, syncEditInfo, startPolygon]);

  // Mausrad-Zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e) => {
      e.preventDefault();
      const cam = camRef.current;
      const rect = canvas.getBoundingClientRect();
      const lx = ((e.clientX - rect.left) / rect.width) * canvas.width;
      const ly = ((e.clientY - rect.top) / rect.height) * canvas.height;
      const wx = cam.x + lx / cam.z;
      const wy = cam.y + ly / cam.z;
      const nz = Math.max(0.3, Math.min(1.6, cam.z * (e.deltaY < 0 ? 1.12 : 0.89)));
      cam.z = nz;
      cam.x = wx - lx / nz;
      cam.y = wy - ly / nz;
      cam.follow = false;
      clampCam(cam, mapRef.current.world);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const canvasPoint = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const lx = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const ly = ((e.clientY - rect.top) / rect.height) * canvas.height;
    return { lx, ly };
  };

  const toWorld = (lx, ly) => {
    const cam = camRef.current;
    return { x: cam.x + lx / cam.z, y: cam.y + ly / cam.z };
  };

  // ---------- Editor-Interaktion ----------

  const hitTest = (w) => {
    const th = 12 / camRef.current.z;
    const map = mapRef.current;
    const ed = editRef.current;

    // Wachen-Griffe (nur in der paths-Ebene)
    if (layer === "paths")
    for (let gi = 0; gi < map.markers.guards.length; gi++) {
      const gd = map.markers.guards[gi];
      if (gd.type === "pacer" || gd.path != null) {
        if (gd.a && Math.hypot(gd.a.x - w.x, gd.a.y - w.y) < th) return { kind: "guard", gi, key: "a" };
        if (gd.b && Math.hypot(gd.b.x - w.x, gd.b.y - w.y) < th) return { kind: "guard", gi, key: "b" };
      } else {
        if (Math.hypot(gd.post.x - w.x, gd.post.y - w.y) < th) return { kind: "guard", gi, key: "post" };
        if (Math.hypot(gd.look.x - w.x, gd.look.y - w.y) < th) return { kind: "guard", gi, key: "look" };
      }
    }
    // Marker (nur in der paths-Ebene)
    if (layer === "paths")
    for (let ti = 0; ti < (map.markers.transitions ?? []).length; ti++) {
      const tr = map.markers.transitions[ti];
      if (Math.hypot(tr.from.x - w.x, tr.from.y - w.y) < th) return { kind: "trans", ti, key: "from" };
      if (Math.hypot(tr.to.x - w.x, tr.to.y - w.y) < th) return { kind: "trans", ti, key: "to" };
    }
    // Punkte der ausgewählten (ggf. zusammengefassten) Ebenen zuerst
    const groupLayers = editLayersOf(layer);
    for (const ln of groupLayers) {
      const polys = map.layers[ln];
      for (let pi = polys.length - 1; pi >= 0; pi--) {
        const pts = polys[pi].pts;
        for (let vi = pts.length - 1; vi >= 0; vi--) {
          if (Math.hypot(pts[vi].x - w.x, pts[vi].y - w.y) < th)
            return { kind: "vertex", layer: ln, index: pi, vi };
        }
      }
    }
    // dann Flächen – nur der ausgewählten (ggf. zusammengefassten) Ebenen
    for (const ln of groupLayers) {
      const polys = map.layers[ln];
      for (let pi = polys.length - 1; pi >= 0; pi--) {
        if (pointInPoly(w.x, w.y, polys[pi].pts)) return { kind: "poly", layer: ln, index: pi };
      }
    }
    return null;
  };

  const onPointerDown = (e) => {
    const { lx, ly } = canvasPoint(e);
    const w = toWorld(lx, ly);
    if (modeRef.current === "edit") {
      const ed = editRef.current;
      // Köder-Position wählen: Klick setzt eff.at des ausgewählten noise-Objekts
      if (ed.pickNoiseFor && ed.pickNoiseFor.layer === "interact") {
        const poly = mapRef.current.layers.interact[ed.pickNoiseFor.index];
        if (poly) {
          poly.effect = { once: true, ...(poly.effect ?? {}), at: { x: w.x, y: w.y } };
        }
        ed.pickNoiseFor = null;
        syncEditInfo();
        return;
      }
      if (ed.drawing) {
        if (ed.drawing.length >= 3 && Math.hypot(ed.drawing[0].x - w.x, ed.drawing[0].y - w.y) < 14 / camRef.current.z) {
          finishPolygon();
        } else {
          ed.drawing.push(w);
          syncEditInfo();
        }
        return;
      }
      const hit = hitTest(w);
      if (!hit) {
        ed.selected = null;
        ed.selectedGuard = null;
        ed.selectedTrans = null;
        syncEditInfo();
        dragRef.current = { kind: "pan", last: { lx, ly }, moved: false };
        return;
      }
      ed.selectedGuard = null;
      ed.selectedTrans = null;
      if (hit.kind === "trans") {
        ed.selectedTrans = hit.ti;
        dragRef.current = { kind: "trans", ti: hit.ti, key: hit.key, last: { lx, ly }, moved: false };
      } else if (hit.kind === "guard") {
        ed.selectedGuard = hit.gi;
        dragRef.current = { kind: "guard", gi: hit.gi, key: hit.key, last: { lx, ly }, moved: false };
      } else if (hit.kind === "vertex") {
        ed.selected = { layer: hit.layer, index: hit.index };
        dragRef.current = { kind: "vertex", layer: hit.layer, index: hit.index, vi: hit.vi, last: { lx, ly }, moved: false };
      } else if (hit.kind === "poly") {
        ed.selected = { layer: hit.layer, index: hit.index };
        dragRef.current = { kind: "poly", layer: hit.layer, index: hit.index, last: { lx, ly }, moved: false };
      }
      syncEditInfo();
      return;
    }
    // Spielmodus
    dragRef.current = { kind: "pan", last: { lx, ly }, moved: false };
  };

  const onPointerMove = (e) => {
    const { lx, ly } = canvasPoint(e);
    const cam = camRef.current;
    const w = toWorld(lx, ly);
    if (modeRef.current === "edit") hoverRef.current = w;
    const d = dragRef.current;
    if (!d) return;
    const dx = (lx - d.last.lx) / cam.z;
    const dy = (ly - d.last.ly) / cam.z;
    if (Math.abs(lx - d.last.lx) + Math.abs(ly - d.last.ly) > 3) d.moved = true;
    if (d.kind === "pan") {
      if (d.moved) {
        cam.follow = false;
        cam.x -= dx;
        cam.y -= dy;
        clampCam(cam, mapRef.current.world);
      }
    } else if (d.kind === "vertex") {
      const poly = mapRef.current.layers[d.layer][d.index];
      poly.pts[d.vi] = { x: poly.pts[d.vi].x + dx, y: poly.pts[d.vi].y + dy };
    } else if (d.kind === "poly") {
      const poly = mapRef.current.layers[d.layer][d.index];
      for (let i = 0; i < poly.pts.length; i++)
        poly.pts[i] = { x: poly.pts[i].x + dx, y: poly.pts[i].y + dy };
    } else if (d.kind === "trans") {
      const tr = mapRef.current.markers.transitions[d.ti];
      tr[d.key] = { x: tr[d.key].x + dx, y: tr[d.key].y + dy };
    } else if (d.kind === "guard") {
      const gd = mapRef.current.markers.guards[d.gi];
      gd[d.key] = { x: gd[d.key].x + dx, y: gd[d.key].y + dy };
    }
    d.last = { lx, ly };
  };

  const onPointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.moved || modeRef.current !== "play") return;
    const { lx, ly } = canvasPoint(e);
    commandAt(lx, ly, e.shiftKey, e.ctrlKey || e.metaKey);
  };

  const onDoubleClick = () => {
    if (modeRef.current !== "edit") return;
    const ed = editRef.current;
    if (ed.drawing) {
      finishPolygon();
      return;
    }
    if (!ed.selected) return;
    const h = hoverRef.current;
    if (!h) return;
    const poly = mapRef.current.layers[ed.selected.layer][ed.selected.index];
    const pts = poly.pts;
    // nächsten Randpunkt suchen und Eckpunkt einfügen
    let best = null;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const l2 = abx * abx + aby * aby;
      if (l2 === 0) continue;
      let t = ((h.x - a.x) * abx + (h.y - a.y) * aby) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + abx * t;
      const py = a.y + aby * t;
      const dd = Math.hypot(h.x - px, h.y - py);
      if (dd < 16 / camRef.current.z && (!best || dd < best.dd)) best = { dd, i, p: { x: px, y: py } };
    }
    if (best) pts.splice(best.i + 1, 0, best.p);
  };

  const commandAt = useCallback(
    (lx, ly, shift, ctrl) => {
      const g = gameRef.current;
      if (g.status !== "playing") return;
      const cam = camRef.current;
      const wx = cam.x + lx / cam.z;
      const wy = cam.y + ly / cam.z;
      const c = g.chars[g.selected];
      if (c.caught) return;

      // Ctrl = Auswahlmodus: nur Figuren auswählen, keine Befehle
      if (ctrl) {
        for (let i = 0; i < g.chars.length; i++) {
          if (i === g.selected) continue; // bereits ausgewählte Figur nicht erneut wählen
          const ch = g.chars[i];
          if (ch.caught) continue;
          if (Math.hypot(ch.x - wx, ch.y - (wy + 10)) < 30 / cam.z) {
            g.selected = i;
            return;
          }
        }
        // Interaktionsobjekt: Strg+Klick auf Polygon, Figur muss darin stehen
        for (const poly of g.map.layers.interact ?? []) {
          if ((poly.effect ?? {}).enter) continue; // Betreten-Trigger: nicht klickbar
          if (!pointInPoly(wx, wy, poly.pts)) continue;
          if ((g.interacted ??= new Set()).has(poly)) {
            pushMessage("Hier gibt es nichts mehr zu holen.");
            return;
          }
          if (!pointInPoly(c.x, c.y, poly.pts)) {
            pushMessage(`${c.name} muss dafür näher heran (im Objekt stehen).`);
            return;
          }
          runInteraction(g, poly, c, pushMessage);
          if ((poly.effect ?? {}).once !== false) g.interacted.add(poly);
          return;
        }
        return;
      }

      let clickedGuard = null;
      let bestD = 26 / cam.z;
      for (const guard of g.guards) {
        const d = Math.hypot(guard.x - wx, guard.y - (wy + 10));
        if (d < bestD) {
          bestD = d;
          clickedGuard = guard;
        }
      }

      if (clickedGuard) {
        const guard = clickedGuard;
        if (guard.state === "knocked") return;
        // Bogenschuss auf Wache
        if (bowActive(c, g)) {
          fireArrow(g, c, { x: guard.x, y: guard.y, guard }, pushMessage);
          return;
        }
        // Angriffsbefehl: Shift+Klick oder Klick auf alarmierte Wache
        if (shift || guard.state === "alert") {
          if (guard.engagedChars.includes(g.selected)) return;
          c.koTarget = null;
          c.attackTarget = guard.id;
          c.path = findPath(g.map, getCharNav(g, c), c, { x: guard.x, y: guard.y }, c);
          const m = matchupMod(c.weapon.cat, guard.weapon.cat);
          pushMessage(
            m.dmg > 1
              ? `${c.name} greift an – Waffenvorteil!`
              : m.dmg < 1
                ? `${c.name} greift an – Waffennachteil!`
                : `${c.name} greift an.`,
          );
          return;
        }
        const dist = Math.hypot(guard.x - c.x, guard.y - c.y);
        const koM = guard.distractKind === "noise" ? 1.5 : guard.distractKind === "body" ? 0.6 : 1;
        if (dist <= c.koRange * WEAPON_TIERS[c.weapon.tier].ko * koM) {
          guard.state = "knocked";
          guard.path = [];
          g.knocked++;
          c.koTarget = null;
          pushMessage("Wache ausgeschaltet.");
        } else {
          c.koTarget = guard.id;
          c.path = findPath(g.map, getCharNav(g, c), c, { x: guard.x, y: guard.y }, c);
        }
        return;
      }

      // Beschießbares Interaktionsobjekt im Bogen-Modus (targetable)
      if (bowActive(c, g)) {
        for (const poly of g.map.layers.interact ?? []) {
          if (!(poly.effect ?? {}).targetable) continue;
          if (!pointInPoly(wx, wy, poly.pts)) continue;
          fireArrow(g, c, { x: wx, y: wy, poly }, pushMessage);
          return;
        }
      }

      // Rückzug aus dem Kampf (Klick auf freie Fläche)
      if (c.engaged.length > 0) {
        const free = c.canAcro && inAnyPoly(g.map.layers.acro ?? [], c);
        if (!free && c.stamina < COMBAT.disengageCost) {
          pushMessage(`${c.name} ist zu erschöpft für den Rückzug!`);
          return;
        }
        if (!free) c.stamina -= COMBAT.disengageCost;
        for (const gid of c.engaged) {
          const gu = g.guards[gid];
          if (gu) gu.engagedChars = gu.engagedChars.filter((x) => x !== g.selected);
        }
        c.engaged = [];
        c.attackTarget = null;
        c.disengageUntil = g.time + 2.5;
        pushMessage(free ? `${c.name} entkommt mit einem Sprung!` : `${c.name} löst sich aus dem Kampf.`);
      }

      c.koTarget = null;
      const path = findPath(g.map, getCharNav(g, c), c, { x: wx, y: wy }, c);
      if (path.length) c.path = path.slice(1);
      else {
        const p = { x: wx, y: wy };
        if (inAnyPoly(g.map.layers.blocking ?? [], p))
          pushMessage("Dort kommt niemand durch.");
        else if (inAnyPoly(g.map.layers.climb ?? [], p) && !c.canClimb && !c.canAcro)
          pushMessage(`${c.name} kann nicht klettern.`);
        else if (inAnyPoly(g.map.layers.acro ?? [], p) && !c.canAcro)
          pushMessage(`${c.name} beherrscht keine Akrobatik.`);
        else pushMessage("Dort kann niemand laufen.");
      }
    },
    [pushMessage],
  );

  // ---------- Spiel-Loop ----------

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const loop = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const g = gameRef.current;
      const cam = camRef.current;
      let map = mapRef.current;
      if (!g.paused) g.time += dt;

      if (modeRef.current === "play" && g.status === "playing" && !g.paused) {
        updateGame(g, dt, pushMessage);
        if (g.pendingMap) {
          if (applyMapChange(g)) {
            pushMessage("Neues Gebiet betreten.");
            saveSession();
          } else pushMessage("Diese Tür führt nirgendwohin.");
        }
        if (g.status === "won") markWon(g.mapId ?? mapIdRef.current);
      }
      if (!g.paused) {
        if (g.whistleFx) {
          g.whistleFx.t += dt;
          if (g.whistleFx.t > 1.2) g.whistleFx = null;
        }
        if (g.noiseFx) {
          g.noiseFx.t += dt;
          if (g.noiseFx.t > 1.2) g.noiseFx = null;
        }
        for (const fx of g.combatFx ?? []) fx.t += dt;
        if (g.combatFx) g.combatFx = g.combatFx.filter((fx) => fx.t <= 1.2);
      }

      // Kartenwechsel (map-Effekt / nächste Karte): Engine hat g.mapId gesetzt,
      // hier Sicht + Karte synchronisieren
      if (g.mapId && g.mapId !== mapIdRef.current) {
        const game = activeGameRef.current;
        const ent = game
          ? mapCacheRef.current.get(game.id + "/" + g.mapId)
          : null;
        if (ent) {
          mapIdRef.current = g.mapId;
          mapRef.current = ent.data;
          applyMapToView(ent);
          map = ent.data;
          camRef.current.follow = true;
          pushMessage("Karte gewechselt: " + (ent.name ?? g.mapId));
          saveSession();
        }
      }

      // Kamera
      const panSpeed = 430 * dt / cam.z;
      const keys = keysRef.current;
      if (keys.has("ArrowLeft")) cam.x -= panSpeed;
      if (keys.has("ArrowRight")) cam.x += panSpeed;
      if (keys.has("ArrowUp")) cam.y -= panSpeed;
      if (keys.has("ArrowDown")) cam.y -= panSpeed;
      if (modeRef.current === "play" && cam.follow) {
        const c = g.chars[g.selected];
        const tx = c.x - VIEW_W / (2 * cam.z);
        const ty = c.y - VIEW_H / (2 * cam.z);
        cam.x += (tx - cam.x) * Math.min(1, dt * 5);
        cam.y += (ty - cam.y) * Math.min(1, dt * 5);
      }
      clampCam(cam, map.world);

      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#0c120a";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.save();
          ctx.scale(cam.z, cam.z);
          ctx.translate(-cam.x, -cam.y);
          drawBackground(ctx, map, imgRef.current);
          if (modeRef.current === "play") {
            drawPlay(ctx, g, g.time, g.showWalk !== false);
          } else {
            drawEdit(ctx, map, editRef.current, hoverRef.current);
          }
          ctx.restore();
        }
      }

      const alarm = g.guards.reduce(
        (m, gu) => Math.max(m, gu.state === "alert" ? 2 : gu.state === "suspicious" ? 1 : 0),
        0,
      );
      const sel = g.chars[g.selected];
      const hidden =
        !sel.caught &&
        pointHidden(map, sel) &&
        g.guards.every((gu) => gu.state !== "knocked" && charHiddenFrom(map, gu, sel));
      setUi((prev) => {
        const next = {
          selected: g.selected,
          sneak: g.sneak,
          gold: g.gold,
          knocked: g.knocked,
          status: g.status,
          alarm,
          whistleReady: g.time - g.whistleAt >= 6,
          hidden,
          follow: !!cam.follow,
          showWalk: g.showWalk !== false,
          paused: !!g.paused,
          stams: g.chars.map((c) => Math.round(c.stamina)).join(","),
          fights: g.guards.reduce((m, gu) => m + (gu.engagedChars.length > 0 ? 1 : 0), 0),
          bow: !g.chars[g.selected].canBow
            ? "none"
            : g.chars[g.selected].bowStowAt != null
              ? "stow"
              : bowActive(g.chars[g.selected], g)
                ? "ready"
                : g.chars[g.selected].bowMode
                  ? "switch"
                  : g.time < g.chars[g.selected].bowSwitchAt
                    ? "unbow"
                    : "off",
          arrows: g.chars[g.selected].arrows ?? 0,
        };
        const same =
          prev.selected === next.selected &&
          prev.sneak === next.sneak &&
          prev.gold === next.gold &&
          prev.knocked === next.knocked &&
          prev.status === next.status &&
          prev.alarm === next.alarm &&
          prev.whistleReady === next.whistleReady &&
          prev.hidden === next.hidden &&
          prev.follow === next.follow &&
          prev.showWalk === next.showWalk &&
          prev.paused === next.paused &&
          prev.stams === next.stams &&
          prev.fights === next.fights &&
          prev.bow === next.bow &&
          prev.arrows === next.arrows;
        return same ? prev : next;
      });

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [pushMessage, markWon, saveSession]);

  const alarmLabel = ["Ruhig", "Misstrauisch", "ALARM!"][ui.alarm];
  const alarmClass = [
    "bg-emerald-900/60 text-emerald-200",
    "bg-amber-800/60 text-amber-200",
    "bg-red-800/70 text-red-200",
  ][ui.alarm];

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#1d2b1a,#0c120a)] p-4 text-stone-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-serif text-2xl font-semibold tracking-wide text-amber-100">
              Sherwood <span className="text-sm font-normal text-stone-400">– Polygon-Karte & Editor</span>
            </h1>
            <p className="text-xs text-stone-400">
              Stealth-Taktik im Stil von „Robin Hood: The Legend of Sherwood“ · Laufflächen, Verstecke und
              Sichtblocker als Polygone · Spielsammlungen lokal oder aus Git-Repos
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {mode === "play" && (
              <>
                <Badge className={alarmClass}>Wachen: {alarmLabel}</Badge>
                <Badge className={ui.hidden ? "bg-emerald-800/70 text-emerald-100" : "bg-stone-800/70 text-stone-400"}>
                  {ui.hidden ? "Im Versteck" : "Sichtbar!"}
                </Badge>
                <Badge className={ui.gold ? "bg-yellow-700/60 text-yellow-100" : "bg-stone-800/70 text-stone-300"}>
                  {ui.gold ? "Gold erbeutet – flieht!" : "Ziel: Goldtruhe"}
                </Badge>
                <Badge className="bg-stone-800/70 text-stone-300">K.o.: {ui.knocked}</Badge>
              </>
            )}
            {mode === "edit" && <Badge className="bg-sky-900/60 text-sky-200">Editor aktiv</Badge>}
            <Button size="sm" variant="outline" onClick={() => setMenuOpen(true)}>
              {activeGame ? "Spiel: " + activeGame.name : "Spiel wählen"}
            </Button>
            {mode === "play" ? (
              <Button size="sm" variant="outline" onClick={enterEditor}>
                Karten-Editor
              </Button>
            ) : (
              <Button size="sm" className="bg-emerald-700 text-white hover:bg-emerald-600" onClick={startPlay}>
                Spielen
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_270px]">
          <div className="relative overflow-hidden rounded-lg border border-stone-700/60 bg-black/40">
            <canvas
              ref={canvasRef}
              width={VIEW_W}
              height={VIEW_H}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onDoubleClick={onDoubleClick}
              className="block w-full cursor-crosshair touch-none select-none"
            />
            {message && (
              <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded bg-black/70 px-3 py-1 text-sm text-amber-100">
                {message}
              </div>
            )}
            <div className="pointer-events-none absolute bottom-2 right-3 text-[10px] text-stone-400">
              {mode === "play"
                ? (ui.follow ? "Kamera folgt (Pfeile: frei, Rad: Zoom)" : "Freie Kamera (F: folgen, Rad: Zoom)")
                : "Editor: Klick = Punkt, Doppelklick = fertig/Edge-Punkt, Ziehen = verschieben · N: neues Polygon · 1–0/-: Ebene · L: Ebene weiter"}
              {imgOk ? " · Bild geladen" : " · Ersatzkarte (Bild nicht ladbar)"}
            </div>
            {mode === "play" && ui.paused && (
              <div className="absolute inset-x-0 top-6 flex justify-center">
                <div className="rounded border-2 border-amber-500 bg-stone-950/90 px-6 py-2 font-serif text-2xl font-bold text-amber-300">
                  PAUSE
                </div>
              </div>
            )}
            {mode === "play" && ui.status !== "playing" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/75">
                <h2 className="font-serif text-4xl font-bold">
                  {ui.status === "won" ? "Mission gelungen!" : "Mission gescheitert"}
                </h2>
                <p className="max-w-md text-center text-sm text-stone-300">
                  {ui.status === "won"
                    ? "Das Gold des Sheriffs ist zurück im Wald. Die Legende von Sherwood wächst."
                    : "Eine Wache hat euch ergriffen. Im Kerker von Nottingham wartet ihr auf die Rettung."}
                </p>
                <Button onClick={restart} className="bg-amber-700 text-white hover:bg-amber-600">
                  Neue Mission (R)
                </Button>
                {ui.status === "won" && hasNextMap() && (
                  <Button onClick={goNextMap} className="bg-emerald-700 text-white hover:bg-emerald-600">
                    Nächste Karte
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            {mode === "play" ? (
              <>
                <div className="flex flex-col gap-2">
                  {gameRef.current.chars.map((c, i) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        const g = gameRef.current;
                        if (!g.chars[i].caught && g.status === "playing") g.selected = i;
                      }}
                      className={`flex items-center gap-3 rounded-lg border p-2 text-left transition ${
                        ui.selected === i
                          ? "border-amber-500 bg-amber-900/30"
                          : "border-stone-700/60 bg-stone-900/40 hover:border-stone-500"
                      }`}
                    >
                      <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 text-[10px] font-bold text-white"
                        style={{ backgroundColor: c.color, borderColor: "#00000055" }}
                      >
                        {i + 1}
                      </span>
                      <span>
                        <span className="block text-sm font-semibold">{c.name}</span>
                        <span className="block text-[10px] leading-tight text-stone-400">{c.role}</span>
                        <span className="mt-1 block h-1.5 w-full overflow-hidden rounded bg-stone-800">
                          <span
                            className="block h-full"
                            style={{
                              width: `${Math.max(0, (c.stamina / c.maxStamina) * 100)}%`,
                              backgroundColor:
                                c.stamina > c.maxStamina * 0.5
                                  ? "#34d399"
                                  : c.stamina > c.maxStamina * 0.25
                                    ? "#fbbf24"
                                    : "#ef4444",
                            }}
                          />
                        </span>
                      </span>
                    </button>
                  ))}
                </div>

                <div className="rounded-lg border border-stone-700/60 bg-stone-900/40 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">Aktionen</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={ui.sneak ? "default" : "outline"}
                      className={ui.sneak ? "bg-emerald-700 text-white hover:bg-emerald-600" : ""}
                      onClick={toggleSneak}
                    >
                      Schleichen (S)
                    </Button>
                    {ui.bow !== "none" && (
                      <Button
                        size="sm"
                        variant={ui.bow === "ready" ? "default" : "outline"}
                        className={ui.bow === "ready" ? "bg-lime-700 text-white hover:bg-lime-600" : ""}
                        onClick={toggleBow}
                      >
                        {ui.bow === "switch"
                          ? "Bogen spannt …"
                          : ui.bow === "stow"
                            ? "Robin packt den Bogen weg …"
                            : ui.bow === "unbow"
                              ? "Bogen wird abgehängt …"
                              : ui.bow === "ready"
                                ? "Bogen bereit"
                                : "Bogen"}{" "}
                        ({ui.arrows})
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={ui.whistleReady ? "default" : "outline"}
                      className={ui.whistleReady ? "bg-amber-700 text-white hover:bg-amber-600" : ""}
                      onClick={whistle}
                    >
                      Pfeifen (Q)
                    </Button>
                    <Button
                      size="sm"
                      variant={ui.follow ? "default" : "outline"}
                      className={ui.follow ? "bg-sky-700 text-white hover:bg-sky-600" : ""}
                      onClick={toggleFollow}
                    >
                      Folgen (F)
                    </Button>
                    <Button
                      size="sm"
                      variant={ui.paused ? "default" : "outline"}
                      className={ui.paused ? "bg-amber-600 text-white hover:bg-amber-500" : ""}
                      onClick={togglePause}
                    >
                      {ui.paused ? "Weiter (P)" : "Pause (P)"}
                    </Button>
                    <Button
                      size="sm"
                      variant={ui.showWalk ? "default" : "outline"}
                      className={ui.showWalk ? "bg-lime-800 text-white hover:bg-lime-700" : ""}
                      onClick={toggleWalk}
                    >
                      Wege (V)
                    </Button>
                  </div>
                  <p className="mt-2 text-[10px] leading-snug text-stone-400">
                    Im Versteck (grün gestrichelt) bleibt ihr unentdeckt – bis eine Wache das Versteck selbst
                    betritt: Dann sieht sie alles darin. Posten werden regelmäßig abgelenkt (Punkte über dem
                    Helm). Wachen gibt es aufmerksam (offenes Auge, weiter Kegel) und unaufmerksam (Lidstrich,
                    enger und kürzer). Alarmierte Wachen sehen enger, aber weiter; kämpfende Wachen haben
                    Tunnelblick auf ihr Ziel. Blaue Flächen = Klettern (nur Robin, langsam), rosa Flächen =
                    Akrobatik (nur Marian, schnell). Violette Türchen teleportieren, gelbe Bögen sind
                    Sprungübergänge.
                  </p>
                  <p className="mt-1 text-stone-400">
                    Bewegung: Es sind nur Klicks in das eigene oder ein angrenzendes Polygon möglich; entferntere
                    Ziele müssen über Zwischenwege (oder Türen/Sprünge) erreicht werden. Geheimgang (violette
                    Türchen): auf die Fläche hinter dem anderen Tür-Ende klicken – die Figur läuft zum Türchen und
                    wird durchteleportiert.
                  </p>
                </div>

                <div className="rounded-lg border border-stone-700/60 bg-stone-900/40 p-3 text-[11px] leading-relaxed text-stone-300">
                  <p className="mb-1 font-semibold text-stone-100">Steuerung</p>
                  <p>Klick: Figur bewegen / Wache ausschalten</p>
                  <p>Strg+Klick auf Figur: nur auswählen (kein Befehl)</p>
                  <p>Strg+Klick auf Interaktion (violette Raute): auslösen</p>
                  <p>Shift+Klick auf Wache: Kampf aufnehmen</p>
                  <p>Klick daneben im Kampf: Rückzug (25 Ausdauer)</p>
                  <p>Ziehen, Pfeiltasten, Mausrad: Kamera</p>
                  <p>1–3: Figur · F: folgen · V: Laufflächen</p>
                  <p>S: Schleichen · Q: Pfeifen · R: Neustart</p>
                  <p>B: Bogen-Modus (nur Robin) – Umschalten dauert, mit gespanntem Bogen kein Schritt</p>
                  <p>
                    Bogen aktiv: Klick auf Wache oder beschießbares Objekt (violett, Ziel-Markierung)
                    schießt einen Pfeil – braucht freie Sichtlinie und Reichweite. Wird Robin im
                    Bogen-Modus angegriffen, packt er den Bogen innerhalb einer Sekunde weg – in der
                    Zeit kämpft er nicht und verliert die Initiative. Pfeile im Köcher sind
                    begrenzt, jeder Schuss macht ein leises Geräusch. Pfeile treffen auch bewegte Wachen.
                  </p>
                  <p>P / Leertaste: Pause</p>
                  <p className="mt-1 text-stone-400">
                    Waffen-Dreieck: Schwert schlägt Schwer, Schwer schlägt Speer, Speer schlägt Schwert (Ringfarbe).
                    Ringstärke = Stufe, Punkte über dem Helm = Kampffertigkeit (1–4). Robin und John sind erfahrene
                    Krieger, Marian nicht – 3 Gegner sind knapp machbar, 4 nicht, Kampf erzeugt Lärm (rote Ringe).
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-lg border border-stone-700/60 bg-stone-900/40 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">Ebene</p>
                  <div className="flex flex-col gap-1">
                    {EDIT_GROUPS.map((g) => {
                      const ln0 = g.layers[0];
                      const active = g.layers.includes(layer);
                      const label = g.label ?? LAYER_STYLE[ln0].label;
                      return (
                        <div key={g.layers.join("+")} className="flex flex-col gap-1">
                          <button
                            onClick={() => {
                              setLayer(ln0);
                              setNewTarget(ln0);
                            }}
                            className={`flex items-center gap-2 rounded border px-2 py-1.5 text-left text-xs ${
                              active ? "border-amber-500 bg-amber-900/30" : "border-stone-700 hover:border-stone-500"
                            }`}
                          >
                            {g.layers.length > 1 ? (
                              <span className="flex w-3 gap-0.5">
                                <span className="h-3 w-1.5 rounded-sm" style={{ backgroundColor: LAYER_STYLE[g.layers[0]].stroke }} />
                                <span className="h-3 w-1.5 rounded-sm" style={{ backgroundColor: LAYER_STYLE[g.layers[1]].stroke }} />
                              </span>
                            ) : (
                              <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: LAYER_STYLE[ln0].stroke }} />
                            )}
                            {label}
                          </button>
                          {g.sub && active && (
                            <div className="ml-5 flex gap-1">
                              {g.layers.map((sl) => (
                                <button
                                  key={sl}
                                  onClick={() => setNewTarget(sl)}
                                  className={`rounded border px-1.5 py-0.5 text-[10px] ${
                                    newTarget === sl
                                      ? "border-amber-500 text-amber-200"
                                      : "border-stone-700 text-stone-400 hover:border-stone-500"
                                  }`}
                                >
                                  Neu: {LAYER_STYLE[sl].label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-lg border border-stone-700/60 bg-stone-900/40 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">Polygone</p>
                  <div className="flex flex-wrap gap-2">
                    {!editInfo.drawing ? (
                      <Button size="sm" variant="outline" onClick={startPolygon}>
                        Neues Polygon
                      </Button>
                    ) : (
                      <>
                        <Button size="sm" className="bg-emerald-700 text-white hover:bg-emerald-600" onClick={finishPolygon}>
                          Fertig ({editInfo.drawing})
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            editRef.current.drawing = null;
                            syncEditInfo();
                          }}
                        >
                          Abbrechen
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!editInfo.selected && editInfo.selectedGuard === null}
                      onClick={editInfo.selectedGuard !== null ? deleteGuard : deleteSelected}
                    >
                      Löschen (Entf)
                    </Button>
                  </div>
                  <input
                    value={editInfo.name}
                    disabled={!editInfo.selected}
                    onChange={(e) => {
                      const ed = editRef.current;
                      if (ed.selected) {
                        mapRef.current.layers[ed.selected.layer][ed.selected.index].name = e.target.value;
                        setEditInfo((p) => ({ ...p, name: e.target.value }));
                      }
                    }}
                    placeholder="Name des ausgewählten Polygons (z. B. Dorf, Burg, Fluss)"
                    className="mt-2 w-full rounded border border-stone-700 bg-stone-950 px-2 py-1.5 text-xs text-stone-200 placeholder:text-stone-500 disabled:opacity-40"
                  />
                  <p className="mt-2 text-[10px] leading-snug text-stone-400">
                    Hindernis & Sichtblocker sowie Start/Flucht & Ziel sind jeweils zu einer Gruppe
                    zusammengefasst – per „Neu“-Knopf wird gewählt, auf welche der beiden Teilebenen
                    neue Polygone gelegt werden. Angeklickt werden alle sichtbaren Flächen,
                    Sperren (blocking) blockieren jede Bewegung.
                  </p>
                  {editInfo.layer === "interact" && editInfo.effect && (
                    <div className="mt-2 flex flex-col gap-1.5 rounded border border-violet-800/50 bg-violet-950/20 p-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-300">Interaktion</p>
                      <label className="flex items-center gap-2 text-xs text-stone-300">
                        Effekt
                        <select
                          value={editInfo.effect.type}
                          onChange={(e) => setInteractEffect("type", e.target.value)}
                          className="rounded border border-stone-700 bg-stone-950 px-1.5 py-1 text-xs text-stone-200"
                        >
                          {Object.entries(INTERACT_TYPES).map(([v, l]) => (
                            <option key={v} value={v}>{l}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-2 text-xs text-stone-300">
                        <input
                          type="checkbox"
                          checked={!!editInfo.effect.targetable}
                          onChange={(e) => setInteractEffect("targetable", e.target.checked)}
                        />
                        Aus der Distanz beschießbar (Bogen)
                      </label>
                      <label className="flex items-center gap-2 text-xs text-stone-300">
                        <input
                          type="checkbox"
                          checked={!!editInfo.effect.enter}
                          onChange={(e) => setInteractEffect("enter", e.target.checked)}
                        />
                        Beim Betreten auslösen (im Spiel unsichtbar, kein Strg+Klick)
                      </label>
                      {["msg", "item"].includes(editInfo.effect.type) && (
                        <input
                          type="text"
                          value={editInfo.effect.text ?? ""}
                          onChange={(e) => setInteractEffect("text", e.target.value)}
                          placeholder={editInfo.effect.type === "msg" ? "Hinweistext" : "Item-Name"}
                          className="rounded border border-stone-700 bg-stone-950 px-2 py-1 text-xs text-stone-200"
                        />
                      )}
                      {editInfo.effect.type === "stamina" && (
                        <label className="flex items-center gap-2 text-xs text-stone-300">
                          Gilt für
                          <select
                            value={editInfo.effect.scope ?? "all"}
                            onChange={(e) => setInteractEffect("scope", e.target.value)}
                            className="rounded border border-stone-700 bg-stone-950 px-1.5 py-1 text-xs text-stone-200"
                          >
                            <option value="all">Alle Figuren</option>
                            <option value="self">Nur interagierende Figur</option>
                          </select>
                        </label>
                      )}
                      {editInfo.effect.type === "knock" && (
                        <label className="flex items-center gap-2 text-xs text-stone-300">
                          Bereich
                          <select
                            value={editInfo.effect.area ?? "radius"}
                            onChange={(e) => setInteractEffect("area", e.target.value)}
                            className="rounded border border-stone-700 bg-stone-950 px-1.5 py-1 text-xs text-stone-200"
                          >
                            <option value="radius">Radius um das Objekt</option>
                            <option value="poly">Genau dieses Polygon</option>
                          </select>
                        </label>
                      )}
                      {editInfo.effect.type === "knock" && (editInfo.effect.area ?? "radius") === "radius" && (
                        <label className="flex items-center gap-2 text-xs text-stone-300">
                          Radius
                          <input
                            type="number"
                            value={editInfo.effect.radius ?? 300}
                            onChange={(e) => setInteractEffect("radius", Math.max(0, Number(e.target.value) || 0))}
                            className="w-20 rounded border border-stone-700 bg-stone-950 px-1.5 py-1 text-xs text-stone-200"
                          />
                        </label>
                      )}
                      {editInfo.effect.type === "knock" && (editInfo.effect.area ?? "radius") !== "radius" && (
                        <div className="flex flex-col gap-1.5">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-300">Zielpolygone</p>
                          <p className="text-[10px] text-stone-500">
                            Betäubt Wachen im Interaktions-Polygon selbst und in allen hier gelisteten Flächen.
                          </p>
                          {(editInfo.effect.targets ?? []).map((t, ti) => {
                            const found =
                              t.layer != null && t.index != null
                                ? mapRef.current.layers[t.layer]?.[t.index]
                                : null;
                            const label = found
                              ? `${found.name || "unbenannt"} (${LAYER_STYLE[t.layer]?.label ?? t.layer})`
                              : `${t.name ?? "?"}`;
                            return (
                              <div key={ti} className="flex items-center gap-1.5 text-[10px] text-stone-200">
                                <span className="flex-1 truncate rounded border border-stone-700 bg-stone-950 px-1.5 py-1">
                                  {label}
                                </span>
                                <button
                                  onClick={() => {
                                    const arr = [...(editInfo.effect.targets ?? [])];
                                    arr.splice(ti, 1);
                                    setInteractEffect("targets", arr);
                                  }}
                                  className="text-red-400 hover:text-red-300"
                                >
                                  ✕
                                </button>
                              </div>
                            );
                          })}
                          <select
                            value=""
                            onChange={(e) => {
                              if (!e.target.value) return;
                              const [ln, idx] = e.target.value.split(":");
                              const arr = [...(editInfo.effect.targets ?? [])];
                              arr.push({ layer: ln, index: Number(idx) });
                              setInteractEffect("targets", arr);
                            }}
                            className="rounded border border-stone-700 bg-stone-950 px-1.5 py-1 text-xs text-stone-200"
                          >
                            <option value="">+ Zielpolygon hinzufügen …</option>
                            {LAYER_NAMES.flatMap((ln) =>
                              (mapRef.current.layers[ln] ?? []).map((p, pi) => (
                                <option key={`${ln}:${pi}`} value={`${ln}:${pi}`}>
                                  {LAYER_STYLE[ln]?.label ?? ln} · {p.name || `Polygon ${pi + 1}`}
                                </option>
                              )),
                            )}
                          </select>
                        </div>
                      )}
                      {editInfo.effect.type === "noise" && (
                        <div className="flex flex-col gap-1.5">
                          <label className="flex items-center gap-2 text-xs text-stone-300">
                            Radius
                            <input
                              type="number"
                              value={editInfo.effect.radius ?? 400}
                              onChange={(e) => setInteractEffect("radius", Math.max(0, Number(e.target.value) || 0))}
                              className="w-20 rounded border border-stone-700 bg-stone-950 px-1.5 py-1 text-xs text-stone-200"
                            />
                          </label>
                          <Button
                            size="sm"
                            variant={editRef.current.pickNoiseFor ? "default" : "outline"}
                            className={editRef.current.pickNoiseFor ? "bg-violet-700 text-white hover:bg-violet-600" : ""}
                            onClick={pickNoisePos}
                          >
                            {editRef.current.pickNoiseFor
                              ? "Position anklicken … (abbrechen mit erneutem Klick)"
                              : editInfo.effect.at
                                ? "Geräuschposition ändern"
                                : "Geräuschposition festlegen"}
                          </Button>
                          {editInfo.effect.at && (
                            <p className="text-[10px] text-stone-500">
                              Geräusch bei ({Math.round(editInfo.effect.at.x)}|{Math.round(editInfo.effect.at.y)})
                            </p>
                          )}
                        </div>
                      )}
                      {editInfo.effect.type === "stealth" && (
                        <label className="flex items-center gap-2 text-xs text-stone-300">
                          Dauer (s)
                          <input
                            type="number"
                            value={editInfo.effect.duration ?? 12}
                            onChange={(e) => setInteractEffect("duration", Math.max(1, Number(e.target.value) || 1))}
                            className="w-20 rounded border border-stone-700 bg-stone-950 px-1.5 py-1 text-xs text-stone-200"
                          />
                        </label>
                      )}
                      {editInfo.effect.type === "map" && (
                        activeGame ? (
                          <select
                            value={editInfo.effect.map ?? ""}
                            onChange={(e) => setInteractEffect("map", e.target.value)}
                            className="rounded border border-stone-700 bg-stone-950 px-1.5 py-1 text-xs text-stone-200"
                          >
                            <option value="">-- Zielkarte wählen --</option>
                            {activeGame.maps.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name ?? m.id}
                                {m.id === (gameRef.current.mapId ?? mapIdRef.current) ? " (aktuell)" : ""}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={editInfo.effect.map ?? editInfo.effect.text ?? ""}
                            onChange={(e) => setInteractEffect("map", e.target.value)}
                            placeholder="Schlüssel der Zielkarte (mapPool) oder JSON inline"
                            className="rounded border border-stone-700 bg-stone-950 px-2 py-1 text-xs text-stone-200"
                          />
                        )
                      )}
                      {editInfo.effect.type === "alarm" && (
                        <div className="flex flex-col gap-1.5">
                          <p className="text-[10px] text-stone-500">
                            Ohne Auswahl: alle Wachen. Mit Zielen: nur Wachen darin (oder per Wachen-Nummer).
                          </p>
                          {(editInfo.effect.guards ?? []).map((gi, ai) => (
                            <div key={ai} className="flex items-center gap-1.5 text-[10px] text-stone-200">
                              <select
                                value={gi}
                                onChange={(e) => {
                                  const arr = [...(editInfo.effect.guards ?? [])];
                                  arr[ai] = Number(e.target.value);
                                  setInteractEffect("guards", arr);
                                }}
                                className="flex-1 rounded border border-stone-700 bg-stone-950 px-1.5 py-1"
                              >
                                {mapRef.current.markers.guards.map((_, i) => (
                                  <option key={i} value={i}>Wache {i + 1}</option>
                                ))}
                              </select>
                              <button
                                onClick={() => {
                                  const arr = [...(editInfo.effect.guards ?? [])];
                                  arr.splice(ai, 1);
                                  setInteractEffect("guards", arr);
                                }}
                                className="text-red-400 hover:text-red-300"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              const arr = [...(editInfo.effect.guards ?? [])];
                              arr.push(0);
                              setInteractEffect("guards", arr);
                            }}
                          >
                            + Wache
                          </Button>
                          {(editInfo.effect.targets ?? []).map((t, ti) => {
                            const found =
                              t.layer != null && t.index != null
                                ? mapRef.current.layers[t.layer]?.[t.index]
                                : null;
                            return (
                              <div key={`t${ti}`} className="flex items-center gap-1.5 text-[10px] text-stone-200">
                                <span className="flex-1 truncate rounded border border-stone-700 bg-stone-950 px-1.5 py-1">
                                  {found ? `${found.name || "unbenannt"} (${LAYER_STYLE[t.layer]?.label ?? t.layer})` : t.name ?? "?"}
                                </span>
                                <button
                                  onClick={() => {
                                    const arr = [...(editInfo.effect.targets ?? [])];
                                    arr.splice(ti, 1);
                                    setInteractEffect("targets", arr);
                                  }}
                                  className="text-red-400 hover:text-red-300"
                                >
                                  ✕
                                </button>
                              </div>
                            );
                          })}
                          <select
                            value=""
                            onChange={(e) => {
                              if (!e.target.value) return;
                              const [ln, idx] = e.target.value.split(":");
                              const arr = [...(editInfo.effect.targets ?? [])];
                              arr.push({ layer: ln, index: Number(idx) });
                              setInteractEffect("targets", arr);
                            }}
                            className="rounded border border-stone-700 bg-stone-950 px-1.5 py-1 text-xs text-stone-200"
                          >
                            <option value="">+ Zielfläche hinzufügen …</option>
                            {LAYER_NAMES.filter((ln) => ln !== "paths").flatMap((ln) =>
                              (mapRef.current.layers[ln] ?? []).map((p, pi) => (
                                <option key={`${ln}:${pi}`} value={`${ln}:${pi}`}>
                                  {LAYER_STYLE[ln]?.label ?? ln} · {p.name || `Polygon ${pi + 1}`}
                                </option>
                              )),
                            )}
                          </select>
                        </div>
                      )}
                      {editInfo.effect.type === "guardShift" && (
                        <div className="flex flex-col gap-1.5">
                          {(editInfo.effect.assign ?? []).map((asg, ai) => (
                            <div key={ai} className="flex items-center gap-1.5">
                              <select
                                value={asg.index}
                                onChange={(e) => {
                                  const arr = [...(editInfo.effect.assign ?? [])];
                                  arr[ai] = { ...asg, index: Number(e.target.value) };
                                  setInteractEffect("assign", arr);
                                }}
                                className="rounded border border-stone-700 bg-stone-950 px-1 py-1 text-[10px] text-stone-200"
                              >
                                {mapRef.current.markers.guards.map((_, gi) => (
                                  <option key={gi} value={gi}>Wache {gi + 1}</option>
                                ))}
                              </select>
                              <span className="text-[10px] text-stone-500">→</span>
                              <select
                                value={asg.path ?? ""}
                                onChange={(e) => {
                                  const arr = [...(editInfo.effect.assign ?? [])];
                                  arr[ai] = { ...asg, path: e.target.value };
                                  setInteractEffect("assign", arr);
                                }}
                                className="rounded border border-stone-700 bg-stone-950 px-1 py-1 text-[10px] text-stone-200"
                              >
                                <option value="">— Posten (1. Punkt) —</option>
                                {(mapRef.current.layers.paths ?? []).map((p, pi) => (
                                  <option key={pi} value={p.name ?? `Pfad ${pi + 1}`}>
                                    {p.name || `Pfad ${pi + 1}`}
                                  </option>
                                ))}
                              </select>
                              <button
                                onClick={() => {
                                  const arr = [...(editInfo.effect.assign ?? [])];
                                  arr.splice(ai, 1);
                                  setInteractEffect("assign", arr);
                                }}
                                className="ml-auto text-[10px] text-red-400 hover:text-red-300"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              const arr = [...(editInfo.effect.assign ?? [])];
                              arr.push({ index: 0, path: "" });
                              setInteractEffect("assign", arr);
                            }}
                          >
                            + Zuweisung
                          </Button>
                          <p className="text-[10px] text-stone-500">
                            Pfade vorher in der Ebene „Wachenpfade &amp; Übergänge“ zeichnen und benennen.
                          </p>
                        </div>
                      )}
                      <label className="flex items-center gap-1.5 text-xs text-stone-300">
                        <input
                          type="checkbox"
                          checked={editInfo.effect.once !== false}
                          onChange={(e) => setInteractEffect("once", e.target.checked)}
                        />
                        Nur einmal nutzbar
                      </label>
                    </div>
                  )}
                  <p className="mt-2 text-[10px] leading-snug text-stone-400">
                    Klick setzt Punkte, Klick auf den ersten Punkt oder Doppelklick schließt das Polygon. Punkte und
                    Flächen verschieben; Doppelklick auf eine Kante fügt einen Punkt ein.
                  </p>
                </div>

                <div className="rounded-lg border border-stone-700/60 bg-stone-900/40 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">Wachen & Marker</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={addPacer}>
                      + Patrouille
                    </Button>
                    <Button size="sm" variant="outline" onClick={addSentry}>
                      + Posten
                    </Button>
                  </div>
                  <p className="mt-2 text-[10px] leading-snug text-stone-400">
                    Patrouillen laufen benannte Pfade aus der Ebene „Wachenpfade &amp; Übergänge“ ab (im
                    Wachen-Panel zuweisen) oder eigene A↔B-Endpunkte. Posten: Standpunkt + Blickpunkt.
                    Start (grün) und Ziel (gelb) liegen auf eigenen Ebenen. Wachen-Punkte auf Laufflächen
                    legen, sonst laufen sie nicht.
                  </p>
                  {editInfo.selectedGuard !== null && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <label className="flex flex-col gap-1 text-[10px] text-stone-400">
                        Waffen-Kategorie
                        <select
                          value={editInfo.guardWeapon?.cat ?? "sword"}
                          onChange={(e) => setGuardWeapon("cat", e.target.value)}
                          className="rounded border border-stone-700 bg-stone-950 px-1.5 py-1 text-xs text-stone-200"
                        >
                          <option value="sword">Schwert</option>
                          <option value="spear">Speer</option>
                          <option value="heavy">Schwer (Axt &amp; Co.)</option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-[10px] text-stone-400">
                        Stufe
                        <select
                          value={editInfo.guardWeapon?.tier ?? "std"}
                          onChange={(e) => setGuardWeapon("tier", e.target.value)}
                          className="rounded border border-stone-700 bg-stone-950 px-1.5 py-1 text-xs text-stone-200"
                        >
                          <option value="light">Leicht</option>
                          <option value="std">Standard</option>
                          <option value="heavy">Schwer</option>
                        </select>
                      </label>
                      <p className="w-full text-[10px] text-stone-500">
                        Auswahl: {editInfo.guardWeapon ? weaponName(editInfo.guardWeapon) : "—"} · Dreieck: Schwert
                        &gt; Schwer &gt; Speer &gt; Schwert
                      </p>
                      <label className="flex flex-col gap-1 text-[10px] text-stone-400">
                        Kampffertigkeit
                        <select
                          value={editInfo.guardSkill ?? "regular"}
                          onChange={(e) => setGuardSkill(e.target.value)}
                          className="rounded border border-stone-700 bg-stone-950 px-1.5 py-1 text-xs text-stone-200"
                        >
                          {Object.entries(SKILLS).map(([key, s]) => (
                            <option key={key} value={key}>
                              {s.label} (×{s.mult})
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="w-full text-[10px] text-stone-500">
                        Fertigkeit: {editInfo.guardSkill ? SKILLS[editInfo.guardSkill].label : "—"} · im Spiel als
                        Punkte über dem Helm (1–4)
                      </p>
                      <label className="flex flex-col gap-1 text-[10px] text-stone-400">
                        Pfad (aus Ebene „Wachenpfade“)
                        <select
                          value={editInfo.guardPath}
                          onChange={(e) => setGuardPath(e.target.value)}
                          className="rounded border border-stone-700 bg-stone-950 px-1.5 py-1 text-xs text-stone-200"
                        >
                          <option value="">— eigener Weg (A/B bzw. Posten) —</option>
                          {(mapRef.current.layers.paths ?? []).map((p, i) => (
                            <option key={i} value={p.name ?? `Pfad ${i + 1}`}>
                              {p.name || `Pfad ${i + 1}`} ({p.pts.length} Punkte)
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-stone-700/60 bg-stone-900/40 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">Übergänge</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={addJump}>
                      + Sprung
                    </Button>
                    <Button size="sm" variant="outline" onClick={addDoor}>
                      + Tür
                    </Button>
                    <Button size="sm" variant="outline" disabled={editInfo.selectedTrans === null} onClick={deleteTrans}>
                      Löschen (Entf)
                    </Button>
                  </div>
                  <p className="mt-2 text-[10px] leading-snug text-stone-400">
                    Portale sind seit der Umstellung NICHT mehr Teil der Wegfindung: Figuren laufen bis zum
                    Eingangspunkt, sehen dort die möglichen Ausgänge als nummerierte Marker und wählen mit
                    Taste 1–9. Sprünge (gelb, Bogen) können nur Akrobaten benutzen, Türen (violett) alle.
                    Übergänge mit gleichem Namen bilden ein Portal mit mehreren Ausgängen. Beide Endpunkte
                    auf begehbare Flächen legen und ziehen zum Anpassen.
                  </p>
                </div>

                {mode === "edit" && activeGame && (
                  <div className="rounded-lg border border-stone-700/60 bg-stone-900/40 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">
                      Karten: {activeGame.name}
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {activeGame.maps.map((m) => (
                        <div key={m.id} className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs text-stone-300">
                            {m.name ?? m.id}
                            {m.id === (gameRef.current.mapId ?? mapIdRef.current) ? " ✓" : ""}
                            {wonMaps.has(m.id) ? " ★" : ""}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => editMap(m)}
                            className="px-2 py-0.5 text-[10px]"
                          >
                            öffnen
                          </Button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={addNewMap}>
                        Neue Karte
                      </Button>
                      <Button size="sm" variant="outline" onClick={exportGame}>
                        Spiel exportieren
                      </Button>
                    </div>
                    <p className="mt-2 text-[10px] leading-snug text-stone-500">
                      Änderungen gelten der geöffneten Karte im Speicher. „Spiel exportieren“ lädt alle Karten
                      als JSON + PNG plus passende index.json herunter (Browser fragt ggf. nach Erlaubnis für
                      mehrere Dateien) – Dateien in games/{activeGame.id}/ ablegen.
                    </p>
                  </div>
                )}

                <div className="rounded-lg border border-stone-700/60 bg-stone-900/40 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">Karte</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => bgFileRef.current && bgFileRef.current.click()}
                    >
                      Hintergrund laden
                    </Button>
                    <Button size="sm" variant="outline" onClick={clearBg}>
                      Hintergrund weg
                    </Button>
                    <Button size="sm" variant="outline" onClick={resetMap}>
                      Standardkarte
                    </Button>
                    <Button size="sm" variant="outline" onClick={clearPolygons}>
                      Alle Polygone entfernen
                    </Button>
                    <Button size="sm" variant="outline" onClick={exportJson}>
                      JSON exportieren
                    </Button>
                    <Button size="sm" variant="outline" onClick={importJson}>
                      JSON anwenden
                    </Button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="text-[10px] uppercase tracking-wide text-stone-400">Kartengröße</label>
                    <input
                      type="number" min={400} max={20000} step={1} value={worldW}
                      onChange={(e) => setWorldW(e.target.value)}
                      className="w-24 rounded border border-stone-700 bg-stone-950 px-2 py-1 text-xs text-stone-200"
                    />
                    <span className="text-xs text-stone-500">×</span>
                    <input
                      type="number" min={400} max={20000} step={1} value={worldH}
                      onChange={(e) => setWorldH(e.target.value)}
                      className="w-24 rounded border border-stone-700 bg-stone-950 px-2 py-1 text-xs text-stone-200"
                    />
                    <span className="text-[10px] text-stone-500">px</span>
                    <Button size="sm" variant="outline" onClick={applyWorldSize}>
                      Größe setzen
                    </Button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" onClick={bakeNavMesh}>
                      Navmesh backen
                    </Button>
                    {navInfo ? (
                      <span className="text-[10px] text-stone-400">
                        Gebacken · rev {navInfo.rev} ·{" "}
                        {NAV_KEYS.map((k) => k + ": " + navInfo.counts[k]).join(" · ")} Knoten · {navInfo.ms} ms ·{" "}
                        {mapRef.current.navMesh && mapRef.current.navMesh.rev === navInfo.rev
                          ? "im Karten-JSON gespeichert"
                          : "Karte wurde danach geändert – neu backen"}
                      </span>
                    ) : (
                      <span className="text-[10px] text-stone-500">
                        Noch nicht gebacken – die Runtime baut Navmeshes on-demand.
                      </span>
                    )}
                  </div>
                  <div className="mt-2 rounded border border-stone-700/60 bg-stone-950/40 p-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">Punkte-Reduktion</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <label className="text-[10px] text-stone-400">Toleranz {reduceTol} px</label>
                      <input
                        type="range"
                        min={0.5}
                        max={10}
                        step={0.5}
                        value={reduceTol}
                        onChange={(e) => setReduceTol(Number(e.target.value))}
                        className="w-40 accent-emerald-600"
                      />
                      <Button size="sm" variant="outline" onClick={reducePoints}>
                        Punkte reduzieren
                      </Button>
                      <Button size="sm" variant="outline" onClick={undoReduce} disabled={!reduceInfo}>
                        Rückgängig
                      </Button>
                    </div>
                    <p className="mt-1 text-[10px] leading-snug text-stone-500">
                      {reduceInfo
                        ? "Letzte Reduktion: " +
                          reduceInfo.before +
                          " → " +
                          reduceInfo.after +
                          " Punkte (Toleranz " +
                          reduceInfo.tol +
                          " px). „Rückgängig“ stellt den Stand davor wieder her."
                        : "Entfernt überflüssige Eckpunkte (Douglas-Peucker). Höhere Toleranz = gröbere Flächen. Vor dem Reduzieren wird automatisch ein Wiederherstellungspunkt angelegt."}
                    </p>
                  </div>
                  <textarea
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    placeholder="Export füllt dieses Feld; zum Importieren JSON hier einfügen und 'JSON anwenden' klicken."
                    className="mt-2 h-24 w-full rounded border border-stone-700 bg-stone-950 p-2 font-mono text-[10px] text-stone-300"
                  />
                  <input ref={bgFileRef} type="file" accept="image/*" onChange={onBgFile} className="hidden" />
                  <p className="mt-2 text-[10px] leading-snug text-stone-400">
                    Workflow: Polygone benennen, JSON exportieren, daraus ein Kartenbild generieren lassen, das Bild
                    über „Hintergrund laden“ einlegen und die Polygone über das Bild ziehen, bis alles passt. Lokal
                    wird außerdem automatisch public/map.png (oder map.jpg) als Hintergrund verwendet. Hintergründe werden 1:1 in
                    voller Auflösung gezeichnet; das Laden eines Bildes setzt die Kartengröße auf die Bildgröße,
                    per „Größe setzen“ (bis 20000 px) ist sie frei wählbar – bestehende Polygone werden dabei
                    proportional mitskaliert.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {menuOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-stone-700 bg-stone-950 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-serif text-xl font-bold text-amber-100">Spiel wählen</h2>
              <Button size="sm" variant="outline" onClick={() => setMenuOpen(false)}>
                Schließen
              </Button>
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-stone-800 bg-stone-900/40 p-2">
              <label className="text-[10px] uppercase tracking-wide text-stone-400">Maps-Repository</label>
              <input
                type="text"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/owner/maps-repo (Hauptzweig) oder raw-URL"
                className="min-w-[240px] flex-1 rounded border border-stone-700 bg-stone-950 px-2 py-1 text-xs text-stone-200"
              />
              <Button size="sm" variant="outline" onClick={() => loadCollection(repoUrl)}>
                Repo laden
              </Button>
            </div>
            {loadingMaps && <p className="mb-2 text-sm text-amber-200">Karten werden geladen …</p>}
            <div className="flex flex-col gap-2">
              {(collection?.games ?? []).map((gm) => (
                <div key={gm.source + "/" + gm.id} className="rounded border border-stone-800 bg-stone-900/40 p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-stone-200">
                      {gm.name}
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-stone-500">
                        {gm.source === "builtin"
                          ? "eingebaut"
                          : gm.source === "local"
                            ? "Server /games"
                            : "Repository"}
                        {" · "}
                        {gm.maps.length} Karte{gm.maps.length !== 1 ? "n" : ""}
                      </span>
                    </span>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="bg-emerald-700 text-white hover:bg-emerald-600"
                        onClick={() => startGameMap(gm, 0, false)}
                      >
                        Spielen
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => startGameMap(gm, 0, true)}>
                        Im Editor öffnen
                      </Button>
                    </div>
                  </div>
                  {gm.maps.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {gm.maps.map((m, i) => (
                        <Button
                          key={m.id}
                          size="sm"
                          variant="outline"
                          className="px-2 py-0.5 text-[10px]"
                          onClick={() => startGameMap(gm, i, false)}
                        >
                          {i + 1}. {m.name ?? m.id}{wonMaps.has(m.id) ? " ★" : ""}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {!collection && <p className="text-sm text-stone-400">Lade verfügbare Spiele …</p>}
            </div>
            <p className="mt-3 text-[10px] leading-snug text-stone-500">
              Lokale Spiele: Ordner „games/&lt;spiel-id&gt;/“ mit index.json auf dem Server (Docker: Volume-Mount auf
              /usr/share/nginx/html/games). Repository: gleiche Struktur in einem öffentlichen Git-Repo, als URL
              oben eintragen. Jede Karte ist eine Kombination aus Karten-JSON und Hintergrundbild. Gewonnene
              Karten führen per „Nächste Karte“ weiter; Interaktionsflächen vom Typ „Karte wechseln“ springen
              direkt auf die gewählte Karte.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function clampCam(cam, world) {
  const vw = VIEW_W / cam.z;
  const vh = VIEW_H / cam.z;
  if (world.w <= vw) cam.x = (world.w - vw) / 2;
  else cam.x = Math.max(0, Math.min(world.w - vw, cam.x));
  if (world.h <= vh) cam.y = (world.h - vh) / 2;
  else cam.y = Math.max(0, Math.min(world.h - vh, cam.y));
}
