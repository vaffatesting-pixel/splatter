#!/usr/bin/env python3
"""
Misura una heightfield generata da makehf.js e dice se la mappa e' giocabile.

makehf stampa gia' area e percentuale camminabile, ma la percentuale da sola
inganna: una scena puo' essere "camminabile al 50%" ed essere fatta di isole
piu' strette del personaggio, che quindi non ci passa. Le due misure che
decidono davvero sono:

  area connessa   la piu' grande zona camminabile tutta collegata, in unita'
                  reali — se e' 2x1 non e' una mappa, e' un ripostiglio
  raggio libero   quanto ci si puo' allontanare dal muro piu' vicino nel punto
                  piu' aperto di quella zona. Il personaggio e' una capsula di
                  raggio 0.30, quindi sotto ~0.6 non passa e sotto 1.0 non e'
                  giocabile

La pendenza conta perche' il character controller di Rapier fa scivolare oltre
i 35 gradi: una superficie a spuntoni resta "camminabile" ma inagibile.

Uso:
    python tools/hfstats.py public/hf-drjohnson.json
    python tools/hfstats.py public/hf-*.json
"""
import json
import math
import sys
from collections import deque

import numpy as np


def load(path):
    hf = json.load(open(path, encoding='utf-8'))
    G = hf['G']
    h = np.asarray(hf['heights'], dtype=np.float64)
    # Rapier vuole column-major: righe -> Z, colonne -> X
    h = h.reshape(G, G, order='F')
    return hf, G, h


def largest_component(mask):
    """Etichetta la componente 4-connessa piu' grande di mask (bool)."""
    G = mask.shape[0]
    seen = np.zeros_like(mask, dtype=bool)
    best = np.zeros_like(mask, dtype=bool)
    for start in zip(*np.nonzero(mask)):
        if seen[start]:
            continue
        q = deque([start])
        seen[start] = True
        comp = [start]
        while q:
            r, c = q.popleft()
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nr, nc = r + dr, c + dc
                if 0 <= nr < G and 0 <= nc < G and mask[nr, nc] and not seen[nr, nc]:
                    seen[nr, nc] = True
                    q.append((nr, nc))
                    comp.append((nr, nc))
        if len(comp) > best.sum():
            best = np.zeros_like(mask, dtype=bool)
            for r, c in comp:
                best[r, c] = True
    return best


def distance_to_edge(mask, cell_x, cell_z):
    """Chamfer 3x3: distanza approssimata di ogni cella dal bordo del mask."""
    big = 1e9
    d = np.where(mask, big, 0.0)
    # il bordo della griglia conta come muro, altrimenti una stanza aperta
    # sul bordo sembrerebbe infinitamente larga
    d[0, :] = np.minimum(d[0, :], 0.0)
    d[-1, :] = np.minimum(d[-1, :], 0.0)
    d[:, 0] = np.minimum(d[:, 0], 0.0)
    d[:, -1] = np.minimum(d[:, -1], 0.0)
    dz, dx = cell_z, cell_x
    diag = math.hypot(dx, dz)
    G = mask.shape[0]
    for r in range(G):                       # passata avanti
        for c in range(G):
            v = d[r, c]
            if r: v = min(v, d[r - 1, c] + dz)
            if c: v = min(v, d[r, c - 1] + dx)
            if r and c: v = min(v, d[r - 1, c - 1] + diag)
            if r and c + 1 < G: v = min(v, d[r - 1, c + 1] + diag)
            d[r, c] = v
    for r in range(G - 1, -1, -1):           # passata indietro
        for c in range(G - 1, -1, -1):
            v = d[r, c]
            if r + 1 < G: v = min(v, d[r + 1, c] + dz)
            if c + 1 < G: v = min(v, d[r, c + 1] + dx)
            if r + 1 < G and c + 1 < G: v = min(v, d[r + 1, c + 1] + diag)
            if r + 1 < G and c: v = min(v, d[r + 1, c - 1] + diag)
            d[r, c] = v
    return d


def stats(path):
    hf, G, h = load(path)
    sx, sz = hf['scale']['x'], hf['scale']['z']
    cell_x, cell_z = sx / (G - 1), sz / (G - 1)
    wall = hf['wallLevel']
    walk = h < wall

    # pendenza per cella, solo dove i vicini hanno dati
    gz, gx = np.gradient(np.where(walk, h, np.nan), cell_z, cell_x)
    slope = np.degrees(np.arctan(np.hypot(gx, gz)))
    sl = slope[np.isfinite(slope) & walk]

    comp = largest_component(walk)
    d = distance_to_edge(comp, cell_x, cell_z)
    free = float(d[comp].max()) if comp.any() else 0.0
    ci, cj = np.unravel_index(np.where(comp, d, -1).argmax(), d.shape)
    # centro della cella piu' aperta, in coordinate mondo
    spot_x = hf['center']['x'] - sx / 2 + (cj + 0.5) * cell_x
    spot_z = hf['center']['z'] - sz / 2 + (ci + 0.5) * cell_z
    spot_y = float(h[ci, cj])

    cell_area = cell_x * cell_z
    return {
        'file': path.split('/')[-1].split('\\')[-1],
        'area': f'{sx:.1f} x {sz:.1f} u',
        'area_ok': sx > 30 and sz > 30,
        'celle': f'{cell_x:.2f} x {cell_z:.2f} u',
        'camminabile_pct': round(100 * walk.sum() / (G * G), 1),
        'pendenza_mediana': round(float(np.median(sl)), 1) if sl.size else None,
        'sotto_35_pct': round(100 * float((sl < 35).sum()) / (G * G), 1) if sl.size else None,
        'area_connessa_u2': round(float(comp.sum() * cell_area), 1),
        'raggio_libero': round(free, 2),
        'raggio_ok': free > 1.0,
        # +1 unita' sopra il terreno: si scende per gravita' invece di
        # nascere dentro il pavimento
        'spawn_suggerito': [round(float(spot_x), 2), round(float(spot_y) + 1.0, 2),
                            round(float(spot_z), 2)],
        'orientamento_sicuro': hf.get('orientationConfident'),
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit('uso: python tools/hfstats.py <hf.json> [...]')
    for p in sys.argv[1:]:
        s = stats(p)
        ok = s['area_ok'] and s['raggio_ok']
        print(f"\n=== {s['file']} === {'PASSA' if ok else 'SCARTATA'}")
        for k, v in s.items():
            if k != 'file':
                print(f'  {k:20} {v}')
