import gensim.downloader as api, numpy as np
print("loading glove-wiki-gigaword-100 (downloads ~66MB first time)...", flush=True)
kv = api.load("glove-wiki-gigaword-100")
DIM = kv.vector_size; N = 20000; W = 20  # top-N words, fixed-width vocab entries
words = list(kv.index_to_key[:N])
# make sure CLI-domain words are present (they're common; belt-and-suspenders)
cli = "search find grep hunt locate scan match commit push pull branch merge stage rebase clone fetch build compile run container image docker download curl request install package dependency archive extract compress tar bundle unpack list remove delete create snapshot save".split()
vocab = sorted(set(w for w in words if len(w) < W) | set(w for w in cli if w in kv.key_to_index and len(w) < W))
voc = bytearray(); vec = bytearray()
for w in vocab:
    b = w.encode(); voc += b + b"\x00" * (W - len(b))
    v = kv[w].astype(np.float32); n = np.linalg.norm(v)
    if n > 0: v = v / n
    vec += np.clip(np.round(v * 127), -127, 127).astype(np.int8).tobytes()
open("libcontract/data/embed_glove.vocab", "wb").write(bytes(voc))
open("libcontract/data/embed_glove.vec", "wb").write(bytes(vec))
print(f"DIM={DIM} vocab={len(vocab)} vocab_bytes={len(voc)} vec_bytes={len(vec)}", flush=True)
# sanity: is the synonymy real now?
for a,b,c in [("search","find","commit"),("download","fetch","branch"),("build","compile","search")]:
    print(f"  cos({a},{b})={kv.similarity(a,b):.2f}  cos({a},{c})={kv.similarity(a,c):.2f}")
