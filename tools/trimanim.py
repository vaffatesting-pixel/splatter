#!/usr/bin/env python3
"""
Riduce un .glb di animazioni alle sole clip che servono.

La libreria Quaternius porta 43 animazioni e un manichino: 7,3 MB, quasi tutti
keyframe di clip che non useremo mai (pistole, incantesimi, nuoto). A noi
servono sei movimenti. Qui si tengono quelli, si butta la mesh — le clip fanno
riferimento ai NODI, non alla geometria, quindi three.js le carica lo stesso —
e si ricompatta il buffer tenendo solo i bufferView ancora referenziati.

Uso:
    python tools/trimanim.py public/avatar/anims.glb public/avatar/anims.glb \
        Idle_Loop Walk_Loop Jog_Fwd_Loop Sitting_Enter Sitting_Idle_Loop Sitting_Exit
"""
import json
import struct
import sys

JSON_CHUNK, BIN_CHUNK = 0x4E4F534A, 0x004E4942


def read_glb(path):
    with open(path, 'rb') as f:
        magic, _v, _l = struct.unpack('<4sII', f.read(12))
        if magic != b'glTF':
            sys.exit('non e un GLB')
        js = bin_ = None
        while True:
            head = f.read(8)
            if len(head) < 8:
                break
            clen, ctype = struct.unpack('<II', head)
            data = f.read(clen)
            if ctype == JSON_CHUNK:
                js = json.loads(data)
            elif ctype == BIN_CHUNK:
                bin_ = data
        return js, bin_


def write_glb(path, js, bin_):
    jb = json.dumps(js, separators=(',', ':')).encode('utf-8')
    jb += b' ' * (-len(jb) % 4)
    bb = bin_ + b'\0' * (-len(bin_) % 4)
    total = 12 + 8 + len(jb) + 8 + len(bb)
    with open(path, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, total))
        f.write(struct.pack('<II', len(jb), JSON_CHUNK)); f.write(jb)
        f.write(struct.pack('<II', len(bb), BIN_CHUNK)); f.write(bb)


def main():
    src, dst, *keep = sys.argv[1:]
    if not keep:
        sys.exit('indica almeno una clip da tenere')
    js, bin_ = read_glb(src)
    before = len(bin_)

    anims = [a for a in js.get('animations', []) if a.get('name') in keep]
    missing = set(keep) - {a.get('name') for a in anims}
    if missing:
        print('ATTENZIONE, clip non trovate:', ', '.join(sorted(missing)))
    js['animations'] = anims

    # niente geometria: le clip puntano ai nodi, non alle mesh
    for n in js.get('nodes', []):
        n.pop('mesh', None)
        n.pop('skin', None)
    for k in ('meshes', 'skins', 'materials', 'textures', 'images', 'samplers'):
        js.pop(k, None)

    used = set()
    for a in anims:
        for s in a['samplers']:
            used.add(s['input'])
            used.add(s['output'])

    # rinumera accessor e bufferView tenendo solo il necessario
    acc_old = js['accessors']
    acc_map, accessors = {}, []
    for i in sorted(used):
        acc_map[i] = len(accessors)
        accessors.append(dict(acc_old[i]))

    # copia i soli bufferView ancora serviti, uno dietro l'altro, allineati a 4
    bv_old = js['bufferViews']
    views, blob, bv_map = [], bytearray(), {}
    for a in accessors:
        i = a.get('bufferView')
        if i is None:
            a.pop('bufferView', None)
            continue
        if i not in bv_map:
            v = bv_old[i]
            o, ln = v.get('byteOffset', 0), v['byteLength']
            pad = -len(blob) % 4
            blob += b'\0' * pad
            bv_map[i] = len(views)
            nv = {'buffer': 0, 'byteOffset': len(blob), 'byteLength': ln}
            if 'byteStride' in v:
                nv['byteStride'] = v['byteStride']
            views.append(nv)
            blob += bin_[o:o + ln]
        a['bufferView'] = bv_map[i]

    for a in anims:
        for s in a['samplers']:
            s['input'] = acc_map[s['input']]
            s['output'] = acc_map[s['output']]

    js['accessors'] = accessors
    js['bufferViews'] = views
    js['buffers'] = [{'byteLength': len(blob)}]
    write_glb(dst, js, bytes(blob))

    import os
    print(f'clip tenute: {len(anims)} su {len(read_glb(src)[0].get("animations", []))}')
    print(f'buffer {before / 1048576:.2f} MB -> {len(blob) / 1048576:.2f} MB')
    print(f'file   -> {os.path.getsize(dst) / 1048576:.2f} MB')


if __name__ == '__main__':
    main()
