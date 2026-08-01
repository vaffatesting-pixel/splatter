#!/usr/bin/env python3
"""
Build the mobile-weight variant of a scene: prune by importance, write .splat.

Two things happen here, and the second is what actually makes the budget.

1. Pruning reuses prune_ply's voxel-importance selection (see that file for why
   the score is sigmoid(opacity) * clipped volume, and why it is applied per
   voxel rather than globally).

2. The output is always antimatter15 .splat, 32 bytes per gaussian, against the
   236 bytes of a 3DGS .ply. The .ply spends 180 of those bytes on 45 spherical
   harmonic coefficients — view-dependent colour. Our scenes are rendered unlit
   with a torch modifier that overwrites rgb anyway, so those bytes buy nothing
   and cost 7x the download. 400k gaussians land at ~13 MB.

Record layout (what Spark's SplatFileType.SPLAT expects):
    float32 x,y,z | float32 sx,sy,sz | uint8 r,g,b,a | uint8 rot w,x,y,z

Usage:
    python mklight.py ../public/capitoline.ply ../public/cap-light.splat --target 400000
    python mklight.py ../public/bonsai.splat  ../public/bonsai-light.splat --target 300000
"""
import argparse
import os
import sys

import numpy as np

from decimate_ply import read_header
from prune_ply import pick_voxel, sigmoid

SH_C0 = 0.28209479177387814
SPLAT_ITEM = 32


def load_ply(path):
    """-> dict of arrays in *linear* units, ready to encode."""
    header, count, dtype, _ = read_header(path)
    need = ('x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2',
            'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2')
    for n in need:
        if n not in dtype.names:
            sys.exit(f'ERRORE: manca la proprieta "{n}"')
    data = np.memmap(path, dtype=dtype, mode='r', offset=len(header), shape=(count,))

    xyz = np.stack([data['x'], data['y'], data['z']], axis=1).astype(np.float32)
    scale = np.exp(np.stack([data['scale_0'], data['scale_1'], data['scale_2']],
                            axis=1).astype(np.float64)).astype(np.float32)
    alpha = sigmoid(data['opacity'].astype(np.float64)).astype(np.float32)
    rgb = np.stack([0.5 + SH_C0 * data[f'f_dc_{i}'].astype(np.float64) for i in range(3)],
                   axis=1).astype(np.float32)
    rot = np.stack([data[f'rot_{i}'] for i in range(4)], axis=1).astype(np.float32)
    return dict(count=count, xyz=xyz, scale=scale, alpha=alpha, rgb=rgb, rot=rot)


def load_splat(path):
    """.splat has no header at all: it is just the records back to back."""
    size = os.path.getsize(path)
    if size % SPLAT_ITEM:
        sys.exit(f'ERRORE: {size} byte non e multiplo di {SPLAT_ITEM} — non e un .splat')
    count = size // SPLAT_ITEM
    raw = np.memmap(path, dtype=np.uint8, mode='r', shape=(count, SPLAT_ITEM))
    f = raw[:, :24].copy().view(np.float32).reshape(count, 6)
    b = raw[:, 24:].astype(np.float32)
    return dict(count=count,
                xyz=f[:, :3].copy(), scale=f[:, 3:].copy(),
                alpha=(b[:, 3] / 255.0),
                rgb=b[:, :3] / 255.0,
                # stored as (q * 128 + 128); undo it, the exact norm does not
                # matter because we re-normalise on the way out
                rot=(b[:, 4:] - 128.0) / 128.0)


def encode(s, idx, dst):
    n = len(idx)
    out = np.zeros((n, SPLAT_ITEM), dtype=np.uint8)
    f = np.empty((n, 6), dtype=np.float32)
    f[:, :3] = s['xyz'][idx]
    f[:, 3:] = s['scale'][idx]
    out[:, :24] = f.view(np.uint8).reshape(n, 24)
    rgba = np.empty((n, 4), dtype=np.float32)
    rgba[:, :3] = s['rgb'][idx] * 255.0
    rgba[:, 3] = s['alpha'][idx] * 255.0
    out[:, 24:28] = np.clip(rgba, 0, 255).astype(np.uint8)
    q = s['rot'][idx]
    q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-9)
    out[:, 28:] = np.clip(q * 128.0 + 128.0, 0, 255).astype(np.uint8)
    with open(dst, 'wb') as fh:
        fh.write(out.tobytes())


def main():
    ap = argparse.ArgumentParser(description='Variante leggera .splat potata per importanza.')
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--target', type=int, required=True)
    ap.add_argument('--mode', choices=('voxel', 'random'), default='voxel')
    ap.add_argument('--grid', type=int, default=64)
    ap.add_argument('--seed', type=int, default=1234)
    args = ap.parse_args()

    ext = args.src.rsplit('.', 1)[-1].lower()
    s = load_ply(args.src) if ext == 'ply' else load_splat(args.src)
    count = s['count']
    keep = max(1, min(args.target, count))
    print(f'sorgente : {args.src}\n  splat  : {count:,}  '
          f'({os.path.getsize(args.src) / 1048576:.0f} MB)')

    if keep == count:
        idx = np.arange(count)
    elif args.mode == 'random':
        idx = np.sort(np.random.default_rng(args.seed).choice(count, keep, replace=False))
    else:
        vol = s['scale'].astype(np.float64).prod(axis=1)
        np.minimum(vol, np.percentile(vol, 90), out=vol)
        score = (s['alpha'].astype(np.float64) * vol).astype(np.float32)
        # pick_voxel reads x/y/z off a record array, so hand it one
        rec = np.zeros(count, dtype=[('x', 'f4'), ('y', 'f4'), ('z', 'f4')])
        rec['x'], rec['y'], rec['z'] = s['xyz'][:, 0], s['xyz'][:, 1], s['xyz'][:, 2]
        idx = pick_voxel(rec, score, keep, count, args.grid)

    encode(s, idx, args.dst)
    print(f'scritto  : {args.dst}\n  splat  : {len(idx):,} ({100 * len(idx) / count:.1f}%)   '
          f'{os.path.getsize(args.dst) / 1048576:.1f} MB')


if __name__ == '__main__':
    main()
