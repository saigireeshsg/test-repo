"""
Step 4 - How many dimensions does the Gita's meaning-space actually use?

The embeddings have 384 dimensions, but the 700 verse vectors do not spread evenly over them.
This computes the full PCA spectrum and summarises it:

  * explained variance per principal component (scree) and cumulative
  * components needed for 50 / 80 / 90 / 95 % of the variance
  * participation ratio (sum l)^2 / sum l^2  - a standard "effective dimensionality"
  * the top 10 axes: verse coordinates, the verses at each pole, and which themes sit at each pole
    (so every axis can be read as a named direction of meaning)

Output: web/data/dimensions.json
Run:    python pipeline/04_dimensions.py
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
D = ROOT / "web" / "data"
ix = json.load(open(D / "gita_index.json", encoding="utf-8"))
X = np.fromfile(D / "verse_embeddings.f32", dtype=np.float32).reshape(-1, ix["dim"]).astype(np.float64)
verses = ix["verses"]
themes = {t["id"]: t["name"] for t in ix["themes"]}
K = 10

mean = X.mean(0)
Xc = X - mean
U, S, Vt = np.linalg.svd(Xc, full_matrices=False)
lam = S**2 / (len(X) - 1)
evr = lam / lam.sum()
cum = np.cumsum(evr)
need = {str(p): int(np.searchsorted(cum, p / 100) + 1) for p in (50, 80, 90, 95)}
pr = float(lam.sum() ** 2 / (lam**2).sum())

# fix each axis's sign so that its positive pole holds the larger-magnitude verse scores
scores = Xc @ Vt[:K].T
for k in range(K):
    if abs(scores[:, k].min()) > abs(scores[:, k].max()):
        scores[:, k] *= -1
        Vt[k] *= -1

axes = []
prim = np.array([v["primary_theme"] for v in verses])
for k in range(K):
    s = scores[:, k]
    order = np.argsort(s)
    tmean = {t: float(s[prim == t].mean()) for t in themes if (prim == t).any()}
    ranked = sorted(tmean.items(), key=lambda kv: kv[1])
    axes.append({
        "pc": k + 1,
        "explained": float(evr[k]),
        "positive_verses": [verses[i]["id"] for i in order[::-1][:4]],
        "negative_verses": [verses[i]["id"] for i in order[:4]],
        "positive_themes": [themes[t] for t, _ in ranked[::-1][:3]],
        "negative_themes": [themes[t] for t, _ in ranked[:3]],
        "label": f"{themes[ranked[-1][0]]}  ↔  {themes[ranked[0][0]]}",
    })

out = {
    "dim": ix["dim"],
    "n": len(X),
    "explained_variance_ratio": [round(float(x), 6) for x in evr],
    "cumulative": [round(float(x), 6) for x in cum],
    "components_for": need,
    "participation_ratio": round(pr, 1),
    "k": K,
    "mean": [round(float(x), 6) for x in mean],
    "components": [[round(float(x), 6) for x in row] for row in Vt[:K]],
    "scores": [[round(float(x), 4) for x in row] for row in scores],
    "axes": axes,
}
(D / "dimensions.json").write_text(json.dumps(out), encoding="utf-8")
print("components for 50/80/90/95% variance:", need, "| participation ratio:", round(pr, 1))
for a in axes:
    print(f"PC{a['pc']:>2} {100*a['explained']:.1f}%  {a['label']}")
