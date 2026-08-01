#!/usr/bin/env python3
"""
Prune a binary Gaussian-splat .ply by importance instead of at random.

Why not just run LightGaussian or PUP 3D-GS: both score a gaussian by how much
it actually contributes to the *training views*, which means the original image
set, the 3DGS codebase and a CUDA rasteriser. We have neither the views (our
scenes are downloaded .ply files) nor an NVIDIA GPU. What survives that is
LightGaussian's per-gaussian term, which needs nothing but the file:

    score = sigmoid(opacity) * min(volume, volume_p90)
    volume = prod(exp(scale_i))                       (ellipsoid, up to 4/3*pi)

The p90 clip is from the paper: without it a handful of enormous background
blobs dominate and everything else looks worthless by comparison.

Dropping the view term has a known failure mode: the score is blind to
occlusion and to where detail is *needed*, so plain "keep the top N" wipes out
whole regions of small faint splats — exactly the soft detail decimate_ply.py
warns about. The `voxel` mode fixes that by applying the same score *within
each cell of a grid*: every neighbourhood keeps the same fraction, so nothing
empties out, but inside a neighbourhood the least useful gaussians go first.

Modes:
    global   keep the globally highest-scoring gaussians
    voxel    keep the highest-scoring within each voxel (recommended)

Usage:
    python prune_ply.py in.ply out.ply --target 1000000 --mode voxel
    python prune_ply.py in.ply out.ply --fraction 0.2 --mode global
"""
import argparse
import os
import sys

import numpy as np

from decimate_ply import read_header


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x, dtype=np.float64))


def importance(data, count, chunk=500_000):
    """sigmoid(opacity) * volume, read in chunks so a 1 GB file stays out of RAM."""
    names = data.dtype.names
    for need in ('opacity', 'scale_0', 'scale_1', 'scale_2'):
        if need not in names:
            sys.exit(f'ERRORE: manca la proprieta "{need}" — non e un .ply 3DGS')

    score = np.empty(count, dtype=np.float32)
    vol = np.empty(count, dtype=np.float32)
    for s in range(0, count, chunk):
        e = min(s + chunk, count)
        block = data[s:e]
        # scales are stored logged and opacity pre-sigmoid, as 3DGS trains them
        v = (np.exp(block['scale_0'].astype(np.float64))
             * np.exp(block['scale_1'].astype(np.float64))
             * np.exp(block['scale_2'].astype(np.float64)))
        vol[s:e] = v
        score[s:e] = sigmoid(block['opacity'].astype(np.float64)) * v

    p90 = np.percentile(vol, 90)
    np.minimum(vol, p90, out=vol)
    for s in range(0, count, chunk):          # recompute with the clipped volume
        e = min(s + chunk, count)
        score[s:e] = sigmoid(data[s:e]['opacity'].astype(np.float64)) * vol[s:e]
    return score, p90


def pick_global(score, keep):
    """Indices of the `keep` highest scores."""
    idx = np.argpartition(score, -keep)[-keep:]
    return np.sort(idx)


def pick_voxel(data, score, keep, count, grid, chunk=500_000):
    """Same score, but the keep *rate* is held constant inside every voxel."""
    xyz = np.empty((count, 3), dtype=np.float32)
    for s in range(0, count, chunk):
        e = min(s + chunk, count)
        b = data[s:e]
        xyz[s:e, 0] = b['x']
        xyz[s:e, 1] = b['y']
        xyz[s:e, 2] = b['z']

    # a robust box: raw min/max is set by a few floaters kilometres away
    lo = np.percentile(xyz, 0.5, axis=0)
    hi = np.percentile(xyz, 99.5, axis=0)
    span = np.maximum(hi - lo, 1e-6)
    cell = span.max() / grid
    ijk = np.floor((xyz - lo) / cell).astype(np.int64)
    np.clip(ijk, 0, int(span.max() / cell) + 1, out=ijk)
    side = int(ijk.max()) + 1
    vox = (ijk[:, 0] * side + ijk[:, 1]) * side + ijk[:, 2]
    del xyz, ijk

    frac = keep / count
    # sort by voxel, then by descending score inside each voxel
    order = np.lexsort((-score, vox))
    vsorted = vox[order]
    # rank of each entry within its voxel
    starts = np.flatnonzero(np.r_[True, vsorted[1:] != vsorted[:-1]])
    counts = np.diff(np.r_[starts, len(vsorted)])
    rank = np.arange(len(vsorted)) - np.repeat(starts, counts)
    quota = np.ceil(counts * frac).astype(np.int64)
    sel = order[rank < np.repeat(quota, counts)]

    # ceil() overshoots; drop the globally weakest of the winners to hit target
    if len(sel) > keep:
        sel = sel[np.argpartition(score[sel], -keep)[-keep:]]
    print(f'  voxel  : lato {cell:.3f} u · {len(starts):,} celle occupate '
          f'· mediana {int(np.median(counts))} splat/cella')
    return np.sort(sel)


def write_ply(src_header, data, idx, dst):
    new_header = []
    for line in src_header.decode('ascii', 'replace').splitlines(True):
        if line.startswith('element vertex'):
            line = f'element vertex {len(idx)}\n'
        new_header.append(line)
    with open(dst, 'wb') as out:
        out.write(''.join(new_header).encode('ascii'))
        CHUNK = 200_000
        for s in range(0, len(idx), CHUNK):
            out.write(data[idx[s:s + CHUNK]].tobytes())


def main():
    ap = argparse.ArgumentParser(description='Pota un .ply di Gaussian splat per importanza.')
    ap.add_argument('src')
    ap.add_argument('dst')
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--target', type=int)
    g.add_argument('--fraction', type=float)
    ap.add_argument('--mode', choices=('global', 'voxel'), default='voxel')
    ap.add_argument('--grid', type=int, default=64,
                    help='celle lungo il lato piu lungo (solo --mode voxel)')
    args = ap.parse_args()

    header, count, dtype, _ = read_header(args.src)
    keep = args.target if args.target else int(round(count * args.fraction))
    keep = max(1, min(keep, count))
    print(f'sorgente : {args.src}')
    print(f'  splat  : {count:,}   byte/splat: {dtype.itemsize}')
    if keep == count:
        print('  nulla da fare')
        return

    data = np.memmap(args.src, dtype=dtype, mode='r', offset=len(header), shape=(count,))
    score, p90 = importance(data, count)
    print(f'  score  : volume p90 {p90:.4g} · '
          f'mediana {np.median(score):.4g} · max {score.max():.4g}')

    idx = (pick_global(score, keep) if args.mode == 'global'
           else pick_voxel(data, score, keep, count, args.grid))
    write_ply(header, data, idx, args.dst)
    print(f'scritto  : {args.dst}  [{args.mode}]')
    print(f'  splat  : {len(idx):,} ({100 * len(idx) / count:.1f}%)   '
          f'{os.path.getsize(args.dst) / 1048576:.0f} MB '
          f'(era {os.path.getsize(args.src) / 1048576:.0f} MB)')


if __name__ == '__main__':
    main()
