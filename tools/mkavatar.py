#!/usr/bin/env python3
"""
Prepara l'avatar Quaternius per il web: stesse geometrie, texture ridotte.

Il pacchetto originale ha texture da 4K (una normal map da 4 MB) pensate per
Unreal, non per una pagina che deve aprirsi da telefono. La geometria e il rig
pesano 733 KB e vanno benissimo; sono le immagini a fare il danno. Qui le si
ricampiona a 512 e le si salva in JPEG (le normal map restano PNG: il JPEG
introdurrebbe artefatti sulle normali), poi si riscrivono gli URI nel .gltf.

Il .gltf resta un file + .bin + immagini invece di un .glb unico: piu' richieste
HTTP, ma nessuna dipendenza da strumenti esterni e le texture restano
sostituibili a mano.

Uso:
    python tools/mkavatar.py
"""
import json
import os
import shutil
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit('serve Pillow: pip install pillow')

SRC = 'public/_src/q/Universal Base Characters[Standard]/Base Characters'
ANIM = 'public/_src/q/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb'
DST = 'public/avatar'
SIZE = 512
# le normal map non sopportano la compressione JPEG: restano PNG
KEEP_PNG = ('normal',)


def find(name):
    """Il .gltf cita 'T_Hair_1_Normal_png.png' ma il file si chiama
    'T_Hair_1_Normal.png': l'export ha lasciato un suffisso di troppo."""
    stem, ext = os.path.splitext(name)
    for cand in (name, stem.removesuffix('_png') + ext):
        for folder in ('Godot - UE', 'Textures', 'Textures/Normals'):
            p = os.path.join(SRC, folder, cand)
            if os.path.exists(p):
                return p
    raise FileNotFoundError(name)


def convert(name, out_dir):
    src = find(name)
    im = Image.open(src)
    im.thumbnail((SIZE, SIZE), Image.LANCZOS)
    png = any(k in name.lower() for k in KEEP_PNG)
    out = os.path.splitext(name)[0] + ('.png' if png else '.jpg')
    path = os.path.join(out_dir, out)
    if png:
        im.convert('RGB').save(path, optimize=True)
    else:
        im.convert('RGB').save(path, quality=82, optimize=True)
    return out, os.path.getsize(path), os.path.getsize(src)


def main():
    os.makedirs(DST, exist_ok=True)
    for who in ('Male', 'Female'):
        stem = f'Superhero_{who}_FullBody'
        g = json.load(open(os.path.join(SRC, 'Godot - UE', stem + '.gltf'), encoding='utf-8'))
        shutil.copy(os.path.join(SRC, 'Godot - UE', stem + '.bin'), os.path.join(DST, stem + '.bin'))
        tot_new = tot_old = 0
        for img in g.get('images', []):
            uri = img.get('uri')
            if not uri:
                continue
            new, n, o = convert(uri, DST)
            img['uri'] = new
            tot_new += n
            tot_old += o
        json.dump(g, open(os.path.join(DST, stem + '.gltf'), 'w', encoding='utf-8'))
        print(f'{stem}: texture {tot_old / 1048576:.1f} MB -> {tot_new / 1048576:.2f} MB'
              f'  (+ {os.path.getsize(os.path.join(DST, stem + ".bin")) / 1024:.0f} KB di rig)')

    shutil.copy(ANIM, os.path.join(DST, 'anims.glb'))
    tot = sum(os.path.getsize(os.path.join(DST, f)) for f in os.listdir(DST))
    print(f'anims.glb: {os.path.getsize(os.path.join(DST, "anims.glb")) / 1048576:.1f} MB (43 clip)')
    print(f'TOTALE {DST}: {tot / 1048576:.1f} MB')


if __name__ == '__main__':
    main()
