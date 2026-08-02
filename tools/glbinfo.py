#!/usr/bin/env python3
"""
Sbircia dentro un .glb senza caricarlo in un motore 3D.

Un GLB e' un header di 12 byte seguito da blocchi; il primo blocco e' il JSON
della scena. Leggendo solo quello si sanno animazioni, ossa e materiali —
abbastanza per scegliere un avatar senza aprire il browser.

Uso:  python tools/glbinfo.py public/_src/Soldier.glb [...]
"""
import json
import struct
import sys


def read(path):
    with open(path, 'rb') as f:
        magic, _ver, _len = struct.unpack('<4sII', f.read(12))
        if magic != b'glTF':
            sys.exit(f'{path}: non e un GLB')
        clen, ctype = struct.unpack('<II', f.read(8))
        if ctype != 0x4E4F534A:                 # 'JSON'
            sys.exit(f'{path}: primo blocco non JSON')
        return json.loads(f.read(clen))


def info(path):
    g = read(path)
    nodes = g.get('nodes', [])
    names = [n.get('name', '') for n in nodes]
    anims = [a.get('name', '?') for a in g.get('animations', [])]
    skins = g.get('skins', [])
    joints = skins[0].get('joints', []) if skins else []
    bones = [names[j] for j in joints if j < len(names)]
    head = [b for b in bones if 'head' in b.lower()]
    meshes = [m.get('name', '?') for m in g.get('meshes', [])]

    import os
    print(f"\n=== {os.path.basename(path)}  ({os.path.getsize(path) / 1024:.0f} KB) ===")
    print(f"  animazioni ({len(anims)}): {', '.join(anims) or 'nessuna'}")
    print(f"  mesh ({len(meshes)}): {', '.join(meshes[:6])}")
    print(f"  ossa: {len(bones)}")
    print(f"  ossa 'head': {', '.join(head) or 'NESSUNA'}")
    print(f"  materiali: {len(g.get('materials', []))}   texture: {len(g.get('images', []))}")
    # figli dell'osso Head: se ce ne sono, la testa e' isolabile come gruppo
    for h in head:
        i = names.index(h)
        kids = [names[c] for c in nodes[i].get('children', [])]
        print(f"    figli di {h}: {', '.join(kids) or 'nessuno'}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit('uso: python tools/glbinfo.py <file.glb> [...]')
    for p in sys.argv[1:]:
        info(p)
