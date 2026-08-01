#!/usr/bin/env python3
"""
Decimate a binary Gaussian-splat .ply down to a target number of splats.

Web viewers choke well before a 1 GB / 5M-gaussian scene: the frame rate drops
far enough that the character controller's dt clamp slows movement to a crawl.
Decimating trades visual density for frame rate; the geometry (floor level,
extents, slopes) is unchanged, so a heightfield built from a decimated file
matches the full one.

Selection is a uniform random sample with a fixed seed: it preserves the spatial
distribution, degrades gracefully, and is reproducible. Weighting by opacity was
considered but tends to strip the faint splats that carry soft detail.

Usage:
    python decimate_ply.py in.ply out.ply --target 1000000
    python decimate_ply.py in.ply out.ply --fraction 0.25
"""
import argparse
import sys

import numpy as np

PLY_TO_NP = {
    'float': 'f4', 'float32': 'f4', 'double': 'f8', 'float64': 'f8',
    'uchar': 'u1', 'uint8': 'u1', 'char': 'i1', 'int8': 'i1',
    'ushort': 'u2', 'uint16': 'u2', 'short': 'i2', 'int16': 'i2',
    'uint': 'u4', 'uint32': 'u4', 'int': 'i4', 'int32': 'i4',
}


def read_header(path):
    """Return (header_bytes, vertex_count, numpy dtype, header_lines)."""
    with open(path, 'rb') as f:
        raw = b''
        while b'end_header' not in raw:
            chunk = f.read(4096)
            if not chunk:
                sys.exit('ERRORE: end_header non trovato — non sembra un .ply')
            raw += chunk
            if len(raw) > 1 << 20:
                sys.exit('ERRORE: header troppo lungo')
    end = raw.index(b'end_header')
    end = raw.index(b'\n', end) + 1
    header = raw[:end]
    lines = header.decode('ascii', 'replace').splitlines()

    if not any(l.startswith('format binary_little_endian') for l in lines):
        sys.exit('ERRORE: supportato solo "format binary_little_endian"')

    count, fields, in_vertex = None, [], False
    for line in lines:
        parts = line.split()
        if not parts:
            continue
        if parts[0] == 'element':
            in_vertex = parts[1] == 'vertex'
            if in_vertex:
                count = int(parts[2])
            elif count is not None:
                break          # another element after vertex: not supported
        elif parts[0] == 'property' and in_vertex:
            if parts[1] == 'list':
                sys.exit('ERRORE: property list non supportata nei vertici')
            ply_type = parts[1]
            if ply_type not in PLY_TO_NP:
                sys.exit(f'ERRORE: tipo non gestito "{ply_type}"')
            fields.append((parts[2], PLY_TO_NP[ply_type]))

    if count is None or not fields:
        sys.exit('ERRORE: nessun element vertex trovato')
    if sum(1 for l in lines if l.startswith('element')) > 1:
        sys.exit('ERRORE: il file ha piu di un element — non supportato')

    return header, count, np.dtype(fields), lines


def main():
    ap = argparse.ArgumentParser(description='Decima un .ply di Gaussian splat.')
    ap.add_argument('src')
    ap.add_argument('dst')
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--target', type=int, help='numero di splat da tenere')
    g.add_argument('--fraction', type=float, help='frazione da tenere (0-1)')
    ap.add_argument('--seed', type=int, default=1234)
    args = ap.parse_args()

    header, count, dtype, _ = read_header(args.src)
    keep = args.target if args.target else int(round(count * args.fraction))
    keep = max(1, min(keep, count))

    print(f'sorgente : {args.src}')
    print(f'  splat  : {count:,}   byte/splat: {dtype.itemsize}   proprieta: {len(dtype.names)}')

    if keep == count:
        print('  nulla da fare (target >= totale)')
        return

    data = np.memmap(args.src, dtype=dtype, mode='r',
                     offset=len(header), shape=(count,))

    rng = np.random.default_rng(args.seed)
    idx = np.sort(rng.choice(count, size=keep, replace=False))

    # rewrite the header with the new vertex count
    new_header = []
    for line in header.decode('ascii', 'replace').splitlines(True):
        if line.startswith('element vertex'):
            line = f'element vertex {keep}\n'
        new_header.append(line)
    new_header = ''.join(new_header).encode('ascii')

    with open(args.dst, 'wb') as out:
        out.write(new_header)
        CHUNK = 200_000                      # keep peak memory modest
        for start in range(0, keep, CHUNK):
            out.write(data[idx[start:start + CHUNK]].tobytes())

    import os
    print(f'scritto  : {args.dst}')
    print(f'  splat  : {keep:,}  ({100 * keep / count:.1f}%)   '
          f'{os.path.getsize(args.dst) / 1048576:.0f} MB '
          f'(era {os.path.getsize(args.src) / 1048576:.0f} MB)')


if __name__ == '__main__':
    main()
