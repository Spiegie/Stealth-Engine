
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// ============================================================
// Sherwood – Stealth-Taktik mit Polygon-Karte + Map-Editor
//
// Karte = Hintergrundbild + Polygone in drei Ebenen:
//   walk  = Laufflächen (Navigation per Sichtbarkeitsgraph)
//   hide  = Verstecke (sicher solange kein Alarm)
//   block = Sichtblocker (Burg, Bäume, Häuser)
// Dazu Marker: Flucht/Start, Gold, Wachen (Patrouille A<->B,
// Posten mit Blickrichtung).
// ============================================================

const IMG_SOURCES = [
  "/map.jpg",
  "gen-image://57c5ccbf",
  "https://mistralaichatupprodswe.blob.core.windows.net/chat-images/assistant/94/3c/cb/943ccbec-dc09-4583-a291-f15b67076a22/3d534e61-0f11-440c-8b07-9badacfb0251/6557861b-ad9c-4540-9518-845d60a3f64f/a85e0a21-c88a-4a31-b99c-e60fd3022429.jpg",
];

const VIEW_W = 1024;
const VIEW_H = 600;

const GUARD_FOV = (80 * Math.PI) / 180;
const GUARD_RANGE = 270;
const NOISE_RADIUS = 240;
const WHISTLE_RADIUS = 430;
const ALARM_SPREAD = 300;
const CATCH_DIST = 20;

// ---------- Kampf ----------
const COMBAT = {
  tick: 1.5, // Sekunden pro Kampfrunde
  baseDmg: 26,
  guardHp: 50,
  drainBase: 5,
  drainExp: 1.5,
  counterFactor: 0.22, // Gegenschaden der Wache auf die Ausdauer
  comboExp: 0.7, // Schadensbonus bei mehreren Angreifern (sublinear)
  allyDiv: 0.8, // Rücken-an-Rücken: Ausdauerkosten / allies^allyDiv
  drainMinExp: 1.1, // Untergrenze des Ausdauerverbrauchs (Masse-Schutz)
  flankRange: 40,
  disengageCost: 25,
  disengageSlow: 0.7,
  noiseRadius: 300,
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
      sum += COMBAT.baseDmg * matchupMod(c.weapon.cat, guard.weapon.cat).dmg * WEAPON_TIERS[c.weapon.tier].dmg;
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
      continue;
    }
    // Gegenschaden + Ausdauerkosten pro beteiligter Figur
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
      const back =
        (COMBAT.baseDmg * matchupMod(guard.weapon.cat, c.weapon.cat).dmg * gTier.dmg * COMBAT.counterFactor) /
        Math.pow(k, 0.7);
      let drain = (COMBAT.drainBase * Math.pow(n * 0.85, COMBAT.drainExp) * drainSum) / Math.pow(allies, COMBAT.allyDiv);
      drain = Math.max(drain, COMBAT.drainBase * Math.pow(n / allies, COMBAT.drainMinExp));
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

function polyFlagsAt(map, p) {
  if (!p) return null;
  for (const poly of map.layers.walk) {
    if (!poly) continue;
    if (pointInPoly(p.x, p.y, poly.pts)) return poly.flags ?? [];
  }
  return null;
}

function pointWalkable(map, p, ch) {
  const flags = polyFlagsAt(map, p);
  if (flags === null) return false;
  if (flags.includes("climb") && !(ch && ch.canClimb)) return false;
  if (flags.includes("acro") && !(ch && ch.canAcro)) return false;
  return true;
}

function speedMult(map, p) {
  const flags = polyFlagsAt(map, p);
  if (!flags || flags.length === 0) return 1;
  if (flags.includes("acro")) return 1.6;
  if (flags.includes("climb")) return 0.55;
  return 1;
}

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

function buildNav(map, ch, useTransitions) {
  const nodes = [];
  for (const poly of map.layers.walk) {
    const pts = poly.pts;
    if (pts.length < 3) continue;
    nodes.push(centroid(pts));
    for (const p of pts) nodes.push({ x: p.x, y: p.y });
  }
  const trans = useTransitions ? map.markers.transitions ?? [] : [];
  for (const t of trans) {
    nodes.push({ x: t.from.x, y: t.from.y });
    nodes.push({ x: t.to.x, y: t.to.y });
  }
  const adj = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++)
      if (segWalkable(map, nodes[i], nodes[j], ch)) {
        adj[i].push({ to: j, type: null });
        adj[j].push({ to: i, type: null });
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
  return smoothPath(map, path, ch);
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
    return i === 2
      ? { name: "Kletterhecke", pts: octagon(c.x, c.y, 0.065 * h), flags: ["climb"] }
      : { name: "Hecke", pts: octagon(c.x, c.y, 0.065 * h) };
  });

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
  const roofA = { name: "Marktdach", pts: octagon(roofAC.x, roofAC.y, 0.055 * h), flags: ["acro"] };
  const roofB = { name: "Marktdach", pts: octagon(roofBC.x, roofBC.y, 0.055 * h), flags: ["acro"] };

  const sentryPost = { x: plazaC.x, y: plazaC.y + 0.14 * h * 0.45 };

  return {
    world: { w, h },
    layers: {
      walk: [road, plaza, village].concat(hedges, [roofA, roofB]),
      hide: [village].concat(hedges),
      block: [castle].concat(trees),
    },
    markers: {
      escape: { x: villageC.x, y: villageC.y, r: 0.16 * h * 0.85 },
      gold: { x: plazaC.x, y: plazaC.y - 0.14 * h * 0.35 },
      guards: [
        { type: "pacer", a: roadAt(0.12), b: roadAt(0.4), weapon: { cat: "spear", tier: "std" } },
        { type: "pacer", a: roadAt(0.56), b: roadAt(0.84), weapon: { cat: "sword", tier: "heavy" } },
        { type: "sentry", post: sentryPost, look: roadAt(0.55), weapon: { cat: "heavy", tier: "heavy" } },
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

function scaleMap(map, nw, nh) {
  const sx = nw / map.world.w;
  const sy = nh / map.world.h;
  const sp = (p) => ({ x: p.x * sx, y: p.y * sy });
  const out = {
    world: { w: nw, h: nh },
    layers: {
      walk: map.layers.walk.map((poly) => ({ name: poly.name, flags: poly.flags, pts: poly.pts.map(sp) })),
      hide: map.layers.hide.map((poly) => ({ name: poly.name, flags: poly.flags, pts: poly.pts.map(sp) })),
      block: map.layers.block.map((poly) => ({ name: poly.name, flags: poly.flags, pts: poly.pts.map(sp) })),
    },
    markers: {
      escape: {
        x: map.markers.escape.x * sx,
        y: map.markers.escape.y * sy,
        r: map.markers.escape.r * (sx + sy) / 2,
      },
      gold: sp(map.markers.gold),
      guards: map.markers.guards.map((gd) =>
        gd.type === "pacer"
          ? { type: "pacer", a: sp(gd.a), b: sp(gd.b) }
          : { type: "sentry", post: sp(gd.post), look: sp(gd.look) },
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
  const nav = buildNav(map, null, false);
  const esc = map.markers.escape;
  const startOffsets = [
    { x: -26, y: 10 },
    { x: -46, y: -12 },
    { x: -10, y: 32 },
  ];
  const charDefs = [
    { id: "robin", name: "Robin", role: "Ausgewogen · klettert · Einhänder", color: "#2f7d32", speed: 132, sneakSpeed: 72, koRange: 46, canClimb: true, stamina: 100, weapon: { cat: "sword", tier: "std" } },
    { id: "john", name: "Little John", role: "Bruiser · Morgenstern", color: "#6b4f2a", speed: 118, sneakSpeed: 64, koRange: 72, stamina: 120, weapon: { cat: "heavy", tier: "heavy" } },
    { id: "marian", name: "Marian", role: "Schnell · Akrobatin · Dolch", color: "#3b6fa0", speed: 152, sneakSpeed: 82, koRange: 44, canAcro: true, stamina: 80, weapon: { cat: "sword", tier: "light" } },
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
    };
  });
  const charNavs = {};
  for (const c of chars) charNavs[c.id] = buildNav(map, c, true);

  const guards = map.markers.guards.map((gd, i) => {
    const pacer = gd.type === "pacer";
    let a;
    let b;
    let post;
    let look;
    if (pacer) {
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
    return {
      id: i,
      name: pacer ? `Patrouille ${i + 1}` : "Posten",
      x: post.x,
      y: post.y,
      homePath: pacer ? [a, b] : [post],
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
      hp: COMBAT.guardHp,
      weapon: normWeapon(gd.weapon) ?? randWeapon(),
      engagedChars: [],
    };
  });

  return {
    map,
    nav,
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
    whistleAt: -99,
    whistleFx: null,
    showWalk: true,
  };
}

// ---------- Spiellogik ----------

function guardSees(g, guard, pos, rangeMult = 1) {
  const dx = pos.x - guard.x;
  const dy = pos.y - guard.y;
  const dist = Math.hypot(dx, dy);
  if (dist > GUARD_RANGE * rangeMult) return false;
  const ang = Math.atan2(dy, dx);
  let diff = Math.abs(ang - guard.facing);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  if (diff > GUARD_FOV / 2) return false;
  return hasLineOfSight(g.map, guard, pos);
}

function updateGame(g, dt, notify) {
  const map = g.map;

  // Kampfrunde (Tick) abarbeiten
  g.combatAcc += dt;
  if (g.combatAcc >= COMBAT.tick) {
    g.combatAcc -= COMBAT.tick;
    processCombatTick(g, notify);
  }

  for (let ci = 0; ci < g.chars.length; ci++) {
    const c = g.chars[ci];
    if (c.caught) continue;
    const bound = c.engaged.length > 0;
    const retreating = g.time < c.disengageUntil;
    let base = (g.sneak ? c.sneakSpeed : c.speed) * WEAPON_TIERS[c.weapon.tier].move;
    if (retreating) base *= COMBAT.disengageSlow;
    const moving = bound && !retreating ? false : moveAlongPath(c, base * speedMult(map, c), dt, map);

    if (moving && !g.sneak && g.time - g.noiseAt > 0.4) {
      g.noiseAt = g.time;
      for (const guard of g.guards) {
        if (guard.state === "knocked" || guard.state === "alert") continue;
        if (Math.hypot(guard.x - c.x, guard.y - c.y) < NOISE_RADIUS) {
          guard.state = "suspicious";
          guard.suspTarget = { x: c.x, y: c.y };
          guard.scanTimer = 0;
          guard.path = findPath(map, g.nav, guard, { x: c.x, y: c.y });
        }
      }
    }

    if (c.koTarget !== null) {
      const guard = g.guards[c.koTarget];
      if (!guard || guard.state === "knocked" || guard.engagedChars.length > 0) c.koTarget = null;
      else {
        const dist = Math.hypot(guard.x - c.x, guard.y - c.y);
        if (dist <= c.koRange * WEAPON_TIERS[c.weapon.tier].ko) {
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

    const gold = map.markers.gold;
    if (!g.gold && Math.hypot(c.x - gold.x, c.y - gold.y) < 34) {
      g.gold = true;
      notify("Gold erbeutet – zurück zum Fluchtpunkt!");
    }

    const esc = map.markers.escape;
    if (g.gold && Math.hypot(c.x - esc.x, c.y - esc.y) < esc.r) {
      g.status = "won";
      return;
    }
  }

  const activeChars = g.chars.filter((c) => !c.caught);
  const alarmActive = g.guards.some((gu) => gu.state === "alert");
  const isHidden = (pos) => !alarmActive && pointHidden(map, pos);

  for (const guard of g.guards) {
    if (guard.state === "knocked") continue;

    // Gebundene Wache: kämpft, folgt nur ihrem Gegner
    if (guard.engagedChars.length > 0) {
      const c0 = g.chars[guard.engagedChars[0]];
      if (!c0 || c0.caught) {
        guard.engagedChars = [];
      } else {
        guard.state = "alert";
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
          notify("Eine weitere Wache schließt sich dem Kampf an!");
          break;
        }
      }
    }

    let seen = null;
    for (const c of activeChars) {
      if (isHidden(c)) continue;
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
            other.path = findPath(map, g.nav, other, { x: seen.x, y: seen.y });
          }
        }
      }
      guard.state = "alert";
      guard.lastSeen = { x: seen.x, y: seen.y };
      guard.lostSightAt = g.time;
    } else if (guard.state === "alert" && g.time - guard.lostSightAt > 5) {
      guard.state = "suspicious";
      guard.suspTarget = guard.lastSeen;
      guard.scanTimer = 0;
      guard.path = findPath(map, g.nav, guard, guard.lastSeen);
    }

    for (const other of g.guards) {
      if (other.state !== "knocked" || guard.foundBodies.includes(other.id)) continue;
      if (isHidden(other)) continue;
      if (guardSees(g, guard, other)) {
        guard.foundBodies.push(other.id);
        if (guard.state !== "alert") {
          guard.state = "suspicious";
          guard.suspTarget = { x: other.x, y: other.y };
          guard.scanTimer = 0;
          guard.path = findPath(map, g.nav, guard, { x: other.x, y: other.y });
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
          guard.path = findPath(map, g.nav, guard, wp);
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
      const moving = moveAlongPath(guard, 82, dt, map);
      if (!moving) {
        guard.scanTimer += dt;
        guard.facing += dt * 1.4;
        if (guard.scanTimer > 2.8) {
          guard.state = "patrol";
          guard.path = [];
          if (guard.homePath.length === 1) guard.distractCooldown = 4;
        }
      }
    } else if (guard.state === "alert") {
      if (g.time - guard.repathAt > 0.4) {
        guard.repathAt = g.time;
        const target = guard.lastSeen ?? activeChars[0];
        if (target) guard.path = findPath(map, g.nav, guard, target);
      }
      moveAlongPath(guard, 118, dt, map);
    }

    if (guard.state === "alert") {
      for (const c of activeChars) {
        if (guard.engagedChars.includes(g.chars.indexOf(c))) continue;
        if (Math.hypot(guard.x - c.x, guard.y - c.y) < CATCH_DIST) {
          c.caught = true;
          g.status = "lost";
          return;
        }
      }
    }
  }
}

// ---------- Rendering ----------

function drawBackground(ctx, map, img) {
  if (img && img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, 0, 0, map.world.w, map.world.h);
    return;
  }
  // Ersatzkarte aus den Polygonen
  ctx.fillStyle = "#4a7c3a";
  ctx.fillRect(0, 0, map.world.w, map.world.h);
  for (const poly of map.layers.walk) {
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
  const range = guard.state === "alert" ? GUARD_RANGE + 80 : GUARD_RANGE;
  const N = 20;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const ang = guard.facing - GUARD_FOV / 2 + (GUARD_FOV * i) / N;
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
  if (guard.hp !== undefined && guard.hp < COMBAT.guardHp) {
    ctx.fillStyle = "#00000088";
    ctx.fillRect(guard.x - 14, guard.y - 30, 28, 4);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(guard.x - 14, guard.y - 30, (28 * Math.max(0, guard.hp)) / COMBAT.guardHp, 4);
  }
  // Kampf-Indikator
  if (guard.engagedChars && guard.engagedChars.length > 0) {
    ctx.strokeStyle = `rgba(239,68,68,${0.5 + Math.sin(t * 8) * 0.4})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(guard.x, guard.y - 10, 23, 0, Math.PI * 2);
    ctx.stroke();
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
  }
}

function drawPlay(ctx, g, t, showWalk) {
  const map = g.map;

  if (showWalk) {
    for (const poly of map.layers.walk) {
      const flags = poly.flags ?? [];
      let color = "rgba(134,239,172,0.14)";
      if (flags.includes("climb")) color = "rgba(96,165,250,0.18)";
      else if (flags.includes("acro")) color = "rgba(244,114,182,0.18)";
      fillPolyPath(ctx, poly.pts);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  const esc = map.markers.escape;
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
  const gold = map.markers.gold;
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

  // Kampflärm
  for (const fx of g.combatFx ?? []) {
    const r = fx.t * COMBAT.noiseRadius;
    ctx.strokeStyle = `rgba(239,68,68,${Math.max(0, 1 - fx.t / 1.2)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2);
    ctx.stroke();
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
  hide: { fill: "rgba(52,211,153,0.2)", stroke: "#34d399", label: "Versteck" },
  block: { fill: "rgba(248,113,113,0.15)", stroke: "#f87171", label: "Sichtblocker" },
};

function drawEdit(ctx, map, edit, hover) {
  for (const layerName of ["walk", "hide", "block"]) {
    const style = LAYER_STYLE[layerName];
    const polys = map.layers[layerName];
    for (let pi = 0; pi < polys.length; pi++) {
      const poly = polys[pi];
      const pts = poly.pts;
      if (pts.length < 2) continue;
      const sel = edit.selected && edit.selected.layer === layerName && edit.selected.index === pi;
      const flags = poly.flags ?? [];
      let strokeCol = sel ? "#fbbf24" : style.stroke;
      if (!sel && flags.includes("climb")) strokeCol = "#60a5fa";
      else if (!sel && flags.includes("acro")) strokeCol = "#f472b6";
      fillPolyPath(ctx, pts);
      ctx.fillStyle = style.fill;
      ctx.fill();
      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = sel ? 3 : 1.5;
      ctx.stroke();
      const flagTxt = flags.includes("climb") ? "Klettern" : flags.includes("acro") ? "Akrobatik" : "";
      const label = poly.name ? poly.name + (flagTxt ? ` (${flagTxt})` : "") : flagTxt;
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
  ctx.strokeStyle = "#4ade80";
  ctx.beginPath();
  ctx.arc(m.escape.x, m.escape.y, m.escape.r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#4ade80";
  ctx.font = "bold 13px Georgia, serif";
  ctx.textAlign = "center";
  ctx.fillText("FLUCHT", m.escape.x, m.escape.y - m.escape.r - 8);

  ctx.fillStyle = "#facc15";
  ctx.save();
  ctx.translate(m.gold.x, m.gold.y);
  ctx.rotate(Math.PI / 4);
  ctx.fillRect(-9, -9, 18, 18);
  ctx.restore();
  ctx.fillStyle = "#facc15";
  ctx.fillText("GOLD", m.gold.x, m.gold.y - 18);

  m.guards.forEach((gd, gi) => {
    const isSel = edit.selectedGuard === gi;
    const col = isSel ? "#fbbf24" : "#f87171";
    ctx.fillStyle = col;
    if (gd.type === "pacer") {
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
    } else {
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
    }
  });

  // Übergänge
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
  const editRef = useRef({ drawing: null, selected: null, selectedGuard: null, selectedTrans: null });
  const bgFileRef = useRef(null);
  if (!mapRef.current) mapRef.current = defaultMap(worldDims.current.w, worldDims.current.h);
  if (!gameRef.current) gameRef.current = newGame(mapRef.current);

  const [mode, setMode] = useState("play");
  const [layer, setLayer] = useState("walk");
  const [imgOk, setImgOk] = useState(false);
  const [editInfo, setEditInfo] = useState({ drawing: 0, selected: false, selectedGuard: null, selectedTrans: null, name: "", flags: [], guardWeapon: null });
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
      flags: selPoly ? selPoly.flags ?? [] : [],
      guardWeapon:
        e.selectedGuard !== null && mapRef.current.markers.guards[e.selectedGuard]
          ? mapRef.current.markers.guards[e.selectedGuard].weapon ?? null
          : null,
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

  const toggleSneak = useCallback(() => {
    gameRef.current.sneak = !gameRef.current.sneak;
  }, []);

  const toggleFollow = useCallback(() => {
    camRef.current.follow = !camRef.current.follow;
  }, []);

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
        guard.path = findPath(g.map, g.nav, guard, { x: c.x, y: c.y });
      }
    }
  }, []);

  // ---------- Editor-Aktionen ----------

  const startPolygon = useCallback(() => {
    editRef.current.drawing = [];
    editRef.current.selected = null;
    syncEditInfo();
  }, [syncEditInfo]);

  const finishPolygon = useCallback(() => {
    const e = editRef.current;
    if (e.drawing && e.drawing.length >= 3) {
      mapRef.current.layers[layer].push({ name: "", pts: e.drawing });
    }
    e.drawing = null;
    syncEditInfo();
  }, [layer, syncEditInfo]);

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
    });
  }, []);

  const toggleFlag = useCallback((flag, on) => {
    const ed = editRef.current;
    if (!ed.selected) return;
    const poly = mapRef.current.layers[ed.selected.layer][ed.selected.index];
    const flags = new Set(poly.flags ?? []);
    if (on) flags.add(flag);
    else flags.delete(flag);
    poly.flags = Array.from(flags);
    setEditInfo((p) => ({ ...p, flags: poly.flags }));
  }, []);

  const setGuardWeapon = useCallback((part, value) => {
    const ed = editRef.current;
    if (ed.selectedGuard === null) return;
    const gd = mapRef.current.markers.guards[ed.selectedGuard];
    const w = normWeapon(gd.weapon) ?? { cat: "sword", tier: "std" };
    gd.weapon = part === "cat" ? { ...w, cat: value } : { ...w, tier: value };
    setEditInfo((p) => ({ ...p, guardWeapon: gd.weapon }));
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
    mapRef.current = defaultMap(worldDims.current.w, worldDims.current.h);
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
    };
    img.src = url;
    e.target.value = "";
  }, []);

  const clearBg = useCallback(() => {
    imgRef.current = null;
    setImgOk(false);
  }, []);

  const exportJson = useCallback(() => {
    setJsonText(JSON.stringify(mapRef.current));
  }, []);

  const importJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      if (!parsed.layers || !parsed.layers.walk || !parsed.markers) throw new Error("Struktur unvollständig");
      const normPoly = (p) =>
        Array.isArray(p)
          ? { name: "", pts: p, flags: [] }
          : { name: p.name ?? "", pts: p.pts ?? p.points ?? [], flags: p.flags ?? [] };
      mapRef.current = {
        ...parsed,
        layers: {
          walk: parsed.layers.walk.map(normPoly),
          hide: (parsed.layers.hide ?? []).map(normPoly),
          block: (parsed.layers.block ?? []).map(normPoly),
        },
        markers: {
          ...parsed.markers,
          guards: (parsed.markers.guards ?? []).map((gd) => ({
            ...gd,
            weapon: normWeapon(gd.weapon) ?? randWeapon(),
          })),
          transitions: parsed.markers.transitions ?? [],
        },
      };
      worldDims.current = parsed.world ?? worldDims.current;
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
      if (g.status !== "playing") return;
      if (k === "1") g.selected = 0;
      if (k === "2") g.selected = 1;
      if (k === "3") g.selected = 2;
      if (k === "s" || k === "S") toggleSneak();
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
  }, [restart, toggleSneak, whistle, toggleFollow, toggleWalk, finishPolygon, deleteSelected, deleteGuard, deleteTrans, syncEditInfo]);

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

    // Wachen-Griffe
    for (let gi = 0; gi < map.markers.guards.length; gi++) {
      const gd = map.markers.guards[gi];
      if (gd.type === "pacer") {
        if (Math.hypot(gd.a.x - w.x, gd.a.y - w.y) < th) return { kind: "guard", gi, key: "a" };
        if (Math.hypot(gd.b.x - w.x, gd.b.y - w.y) < th) return { kind: "guard", gi, key: "b" };
      } else {
        if (Math.hypot(gd.post.x - w.x, gd.post.y - w.y) < th) return { kind: "guard", gi, key: "post" };
        if (Math.hypot(gd.look.x - w.x, gd.look.y - w.y) < th) return { kind: "guard", gi, key: "look" };
      }
    }
    // Marker
    if (Math.hypot(map.markers.gold.x - w.x, map.markers.gold.y - w.y) < th) return { kind: "gold" };
    if (Math.hypot(map.markers.escape.x - w.x, map.markers.escape.y - w.y) < th) return { kind: "escape" };
    for (let ti = 0; ti < (map.markers.transitions ?? []).length; ti++) {
      const tr = map.markers.transitions[ti];
      if (Math.hypot(tr.from.x - w.x, tr.from.y - w.y) < th) return { kind: "trans", ti, key: "from" };
      if (Math.hypot(tr.to.x - w.x, tr.to.y - w.y) < th) return { kind: "trans", ti, key: "to" };
    }
    // Punkte der ausgewählten Ebene zuerst
    const polys = map.layers[layer];
    for (let pi = polys.length - 1; pi >= 0; pi--) {
      const pts = polys[pi].pts;
      for (let vi = pts.length - 1; vi >= 0; vi--) {
        if (Math.hypot(pts[vi].x - w.x, pts[vi].y - w.y) < th)
          return { kind: "vertex", layer, index: pi, vi };
      }
    }
    // dann Flächen (alle Ebenen)
    for (const ln of ["hide", "block", "walk"]) {
      const ps = map.layers[ln];
      for (let pi = ps.length - 1; pi >= 0; pi--) {
        if (pointInPoly(w.x, w.y, ps[pi].pts)) return { kind: "poly", layer: ln, index: pi };
      }
    }
    return null;
  };

  const onPointerDown = (e) => {
    const { lx, ly } = canvasPoint(e);
    const w = toWorld(lx, ly);
    if (modeRef.current === "edit") {
      const ed = editRef.current;
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
      } else if (hit.kind === "gold") {
        dragRef.current = { kind: "gold", last: { lx, ly }, moved: false };
      } else if (hit.kind === "escape") {
        dragRef.current = { kind: "escape", last: { lx, ly }, moved: false };
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
    } else if (d.kind === "gold") {
      mapRef.current.markers.gold = { x: mapRef.current.markers.gold.x + dx, y: mapRef.current.markers.gold.y + dy };
    } else if (d.kind === "escape") {
      mapRef.current.markers.escape = {
        ...mapRef.current.markers.escape,
        x: mapRef.current.markers.escape.x + dx,
        y: mapRef.current.markers.escape.y + dy,
      };
    }
    d.last = { lx, ly };
  };

  const onPointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.moved || modeRef.current !== "play") return;
    const { lx, ly } = canvasPoint(e);
    commandAt(lx, ly, e.shiftKey);
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
    (lx, ly, shift) => {
      const g = gameRef.current;
      if (g.status !== "playing") return;
      const cam = camRef.current;
      const wx = cam.x + lx / cam.z;
      const wy = cam.y + ly / cam.z;
      const c = g.chars[g.selected];
      if (c.caught) return;

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
        // Angriffsbefehl: Shift+Klick oder Klick auf alarmierte Wache
        if (shift || guard.state === "alert") {
          if (guard.engagedChars.includes(g.selected)) return;
          c.koTarget = null;
          c.attackTarget = guard.id;
          c.path = findPath(g.map, g.charNavs[c.id], c, { x: guard.x, y: guard.y }, c);
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
        if (dist <= c.koRange * WEAPON_TIERS[c.weapon.tier].ko) {
          guard.state = "knocked";
          guard.path = [];
          g.knocked++;
          c.koTarget = null;
          pushMessage("Wache ausgeschaltet.");
        } else {
          c.koTarget = guard.id;
          c.path = findPath(g.map, g.charNavs[c.id], c, { x: guard.x, y: guard.y }, c);
        }
        return;
      }

      for (let i = 0; i < g.chars.length; i++) {
        const ch = g.chars[i];
        if (ch.caught) continue;
        if (Math.hypot(ch.x - wx, ch.y - (wy + 10)) < 30 / cam.z) {
          g.selected = i;
          return;
        }
      }

      // Rückzug aus dem Kampf (Klick auf freie Fläche)
      if (c.engaged.length > 0) {
        const flags = polyFlagsAt(g.map, c);
        const free = c.canAcro && flags && flags.includes("acro");
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
      const path = findPath(g.map, g.charNavs[c.id], c, { x: wx, y: wy }, c);
      if (path.length) c.path = path.slice(1);
      else {
        const flags = polyFlagsAt(g.map, { x: wx, y: wy });
        if (flags && flags.includes("climb") && !c.canClimb)
          pushMessage(`${c.name} kann nicht klettern.`);
        else if (flags && flags.includes("acro") && !c.canAcro)
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
      const map = mapRef.current;
      g.time += dt;

      if (modeRef.current === "play" && g.status === "playing") {
        updateGame(g, dt, pushMessage);
      }
      if (g.whistleFx) {
        g.whistleFx.t += dt;
        if (g.whistleFx.t > 1.2) g.whistleFx = null;
      }
      for (const fx of g.combatFx ?? []) fx.t += dt;
      if (g.combatFx) g.combatFx = g.combatFx.filter((fx) => fx.t <= 1.2);

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
      const hidden = alarm < 2 && !sel.caught && pointHidden(map, sel);
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
          stams: g.chars.map((c) => Math.round(c.stamina)).join(","),
          fights: g.guards.reduce((m, gu) => m + (gu.engagedChars.length > 0 ? 1 : 0), 0),
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
          prev.stams === next.stams &&
          prev.fights === next.fights;
        return same ? prev : next;
      });

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [pushMessage]);

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
              Sichtblocker als Polygone
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
                : "Editor: Klick = Punkt, Doppelklick = fertig/Edge-Punkt, Ziehen = verschieben"}
              {imgOk ? " · Bild geladen" : " · Ersatzkarte (Bild nicht ladbar)"}
            </div>
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
                      variant={ui.showWalk ? "default" : "outline"}
                      className={ui.showWalk ? "bg-lime-800 text-white hover:bg-lime-700" : ""}
                      onClick={toggleWalk}
                    >
                      Wege (V)
                    </Button>
                  </div>
                  <p className="mt-2 text-[10px] leading-snug text-stone-400">
                    Im Versteck (grün gestrichelt) seid ihr unentdeckbar, solange kein Alarm herrscht. Posten werden
                    regelmäßig abgelenkt (Punkte über dem Helm). Blaue Flächen = Klettern (nur Robin, langsam), rosa
                    Flächen = Akrobatik (nur Marian, schnell). Violette Türchen teleportieren, gelbe Bögen sind
                    Sprungübergänge.
                  </p>
                </div>

                <div className="rounded-lg border border-stone-700/60 bg-stone-900/40 p-3 text-[11px] leading-relaxed text-stone-300">
                  <p className="mb-1 font-semibold text-stone-100">Steuerung</p>
                  <p>Klick: Figur bewegen / Wache ausschalten</p>
                  <p>Shift+Klick auf Wache: Kampf aufnehmen</p>
                  <p>Klick daneben im Kampf: Rückzug (25 Ausdauer)</p>
                  <p>Ziehen, Pfeiltasten, Mausrad: Kamera</p>
                  <p>1–3: Figur · F: folgen · V: Laufflächen</p>
                  <p>S: Schleichen · Q: Pfeifen · R: Neustart</p>
                  <p className="mt-1 text-stone-400">
                    Waffen-Dreieck: Schwert schlägt Schwer, Schwer schlägt Speer, Speer schlägt Schwert (Ringfarbe).
                    Ringstärke = Stufe. 3 Gegner sind knapp machbar, 4 nicht – Kampf erzeugt Lärm (rote Ringe).
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-lg border border-stone-700/60 bg-stone-900/40 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">Ebene</p>
                  <div className="flex flex-col gap-1">
                    {["walk", "hide", "block"].map((ln) => (
                      <button
                        key={ln}
                        onClick={() => setLayer(ln)}
                        className={`flex items-center gap-2 rounded border px-2 py-1.5 text-left text-xs ${
                          layer === ln ? "border-amber-500 bg-amber-900/30" : "border-stone-700 hover:border-stone-500"
                        }`}
                      >
                        <span
                          className="h-3 w-3 rounded-sm"
                          style={{ backgroundColor: LAYER_STYLE[ln].stroke }}
                        />
                        {LAYER_STYLE[ln].label}
                      </button>
                    ))}
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
                  <div className="mt-2 flex gap-4">
                    <label
                      className={`flex items-center gap-1.5 text-xs ${
                        editInfo.selected ? "text-stone-200" : "text-stone-500"
                      }`}
                    >
                      <input
                        type="checkbox"
                        disabled={!editInfo.selected}
                        checked={editInfo.flags.includes("climb")}
                        onChange={(e) => toggleFlag("climb", e.target.checked)}
                      />
                      Kletterbar
                    </label>
                    <label
                      className={`flex items-center gap-1.5 text-xs ${
                        editInfo.selected ? "text-stone-200" : "text-stone-500"
                      }`}
                    >
                      <input
                        type="checkbox"
                        disabled={!editInfo.selected}
                        checked={editInfo.flags.includes("acro")}
                        onChange={(e) => toggleFlag("acro", e.target.checked)}
                      />
                      Akrobatik
                    </label>
                  </div>
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
                    Patrouille: zwei Endpunkte (A↔B). Posten: Standpunkt + Blickpunkt. GOLD und FLUCHT verschiebbar.
                    Wachen-Punkte auf Laufflächen legen, sonst laufen sie nicht.
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
                    Sprung (gelb, Bogen): nur Akrobaten springen im Bogen von A nach B. Tür (violett): alle Figuren
                    werden teleportiert. Beide Endpunkte auf begehbare Flächen legen und ziehen zum Anpassen.
                  </p>
                </div>

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
                    <Button size="sm" variant="outline" onClick={exportJson}>
                      JSON exportieren
                    </Button>
                    <Button size="sm" variant="outline" onClick={importJson}>
                      JSON anwenden
                    </Button>
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
                    wird außerdem automatisch public/map.jpg als Hintergrund verwendet.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
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
