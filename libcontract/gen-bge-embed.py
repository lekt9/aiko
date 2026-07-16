#!/usr/bin/env python3
"""gen-bge-embed.py — bake bge-small-en-v1.5 into a dependency-free blob for the
pure-Zig BERT embedder (bge.zig). Reproducible: run once at build time.

  - quantizes every matmul weight (incl. word embeddings) to per-ROW int8 + f32 scale
    (dynamic weight-only quant — the scheme measured at 87% routing);
  - keeps biases / LayerNorm / position+type embeddings as f32 (small);
  - writes a self-describing tensor-table blob (bge_weights.bin) + WordPiece vocab
    (bge_vocab.txt) into src/ (co-located so Zig @embedFile works standalone);
  - VALIDATES end-to-end: runs the identical LOO routing harness with a numpy forward
    pass over the QUANTIZED weights, so we lock the target number before porting to Zig;
  - dumps bge_ref.bin (probe token-ids + reference CLS vectors) for Zig's numeric test.

Output layout (bge_weights.bin), little-endian:
  magic 'BGEW' u32 | version u32 | n_tensors u32
  per tensor: name_len u16 | name bytes | dtype u8 (0=i8,1=f32) | ndim u8 | dims[ndim] u32 | data
Naming: emb.word{,.s}, emb.pos, emb.type, emb.ln.g, emb.ln.b,
        L{i}.{q,k,v,ao,inter,out}.w{,.s}, L{i}.{q,k,v,ao,inter,out}.b,
        L{i}.{attnln,outln}.{g,b}
"""
import os, struct, numpy as np
os.environ["TOKENIZERS_PARALLELISM"]="false"
import torch
from transformers import AutoModel, AutoTokenizer

MODEL="BAAI/bge-small-en-v1.5"
SRC=os.path.join(os.path.dirname(os.path.abspath(__file__)), "src")
H, L, HEADS, INTER, EPS = 384, 12, 12, 1536, 1e-12

m=AutoModel.from_pretrained(MODEL).eval()
sd={k:v.numpy().astype(np.float32) for k,v in m.state_dict().items()}
tok=AutoTokenizer.from_pretrained(MODEL)

def q8_row(W):                      # [out,in] -> int8 [out,in], scale f32 [out]
    s=np.abs(W).max(axis=1)/127.0; s=np.where(s==0,1.0,s)
    q=np.round(W/s[:,None]).clip(-127,127).astype(np.int8)
    return q, s.astype(np.float32)
def dq(q,s): return q.astype(np.float32)*s[:,None]

# ── collect tensors (quantized where it pays) ──
tensors=[]  # (name, np.array)  dtype int8 or float32
def add(name,a): tensors.append((name,a))
qw,qs=q8_row(sd["embeddings.word_embeddings.weight"]);      add("emb.word",qw); add("emb.word.s",qs)
add("emb.pos", sd["embeddings.position_embeddings.weight"])
add("emb.type", sd["embeddings.token_type_embeddings.weight"])
add("emb.ln.g", sd["embeddings.LayerNorm.weight"]); add("emb.ln.b", sd["embeddings.LayerNorm.bias"])
MAP={"q":"attention.self.query","k":"attention.self.key","v":"attention.self.value",
     "ao":"attention.output.dense","inter":"intermediate.dense","out":"output.dense"}
for i in range(L):
    p=f"encoder.layer.{i}."
    for tag,hf in MAP.items():
        w=sd[p+hf+".weight"]; q,s=q8_row(w)
        add(f"L{i}.{tag}.w",q); add(f"L{i}.{tag}.w.s",s); add(f"L{i}.{tag}.b",sd[p+hf+".bias"])
    add(f"L{i}.attnln.g",sd[p+"attention.output.LayerNorm.weight"]); add(f"L{i}.attnln.b",sd[p+"attention.output.LayerNorm.bias"])
    add(f"L{i}.outln.g", sd[p+"output.LayerNorm.weight"]);           add(f"L{i}.outln.b", sd[p+"output.LayerNorm.bias"])

# dequantized-weight views for the numpy reference forward (what Zig will compute)
T={}
for name,a in tensors: T[name]=a
def W(tag_i):  # returns dequantized [out,in]
    return dq(T[tag_i+".w"], T[tag_i+".w.s"])

def erf(x):
    # Abramowitz-Stegun 7.1.26 (max err 1.5e-7) — vectorized, dependency-free (matches Zig)
    s=np.sign(x); x=np.abs(x); t=1/(1+0.3275911*x)
    y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*np.exp(-x*x)
    return s*y
def gelu(x): return 0.5*x*(1+erf(x/np.sqrt(2)))
def ln(x,g,b):
    mu=x.mean(-1,keepdims=True); var=x.var(-1,keepdims=True)
    return (x-mu)/np.sqrt(var+EPS)*g+b

word_dq=dq(T["emb.word"],T["emb.word.s"])
def forward(ids):                         # ids: list[int] -> CLS L2-normalized [H]
    ids=np.array(ids); Tn=len(ids)
    E=word_dq[ids]+T["emb.pos"][:Tn]+T["emb.type"][0][None,:]
    E=ln(E,T["emb.ln.g"],T["emb.ln.b"])
    dh=H//HEADS
    for i in range(L):
        pre=f"L{i}."
        Q=E@W(pre+"q").T+T[pre+"q.b"]; K=E@W(pre+"k").T+T[pre+"k.b"]; V=E@W(pre+"v").T+T[pre+"v.b"]
        ctx=np.zeros((Tn,H),np.float32)
        for h in range(HEADS):
            sl=slice(h*dh,(h+1)*dh)
            sc=Q[:,sl]@K[:,sl].T/np.sqrt(dh)
            sc=sc-sc.max(-1,keepdims=True); w=np.exp(sc); w/=w.sum(-1,keepdims=True)
            ctx[:,sl]=w@V[:,sl]
        A=ctx@W(pre+"ao").T+T[pre+"ao.b"]
        E=ln(E+A,T[pre+"attnln.g"],T[pre+"attnln.b"])
        Hd=gelu(E@W(pre+"inter").T+T[pre+"inter.b"])
        O=Hd@W(pre+"out").T+T[pre+"out.b"]
        E=ln(E+O,T[pre+"outln.g"],T[pre+"outln.b"])
    cls=E[0]; return cls/np.linalg.norm(cls)

def encode(texts):
    return np.vstack([forward(tok(t,truncation=True,max_length=64)["input_ids"]) for t in texts])

# ── VALIDATE: run the faithful LOO harness on the quantized numpy forward ──
import sys; sys.path.insert(0,"/private/tmp/claude-501/-Users-lewis-Unbrowse-contract/bd58b537-0da0-45ba-927a-a31c6f62902f/scratchpad")
import bench_embed as B
emb=B.embed_all(encode); ov,per=B.loo(emb)
print(f"\n  numpy per-row-int8 forward — LOO routing: {ov:.1f}%   (target ~87%, fp32 bge 88.9%)")
print("    per-binary: "+"  ".join(f"{b}:{per[b]:.0f}" for b in B.BINS))

# ── WRITE blob + vocab + reference (only the artifacts; validation already printed) ──
os.makedirs(SRC,exist_ok=True)
with open(f"{SRC}/bge_weights.bin","wb") as f:
    f.write(b"BGEW"+struct.pack("<II",1,len(tensors)))
    for name,a in tensors:
        nb=name.encode(); dt=0 if a.dtype==np.int8 else 1
        f.write(struct.pack("<H",len(nb))+nb+struct.pack("<BB",dt,a.ndim)+struct.pack(f"<{a.ndim}I",*a.shape))
        f.write(a.tobytes())
# vocab (30522 lines) for the WordPiece tokenizer
vocab=[None]*tok.vocab_size
for t,i in tok.get_vocab().items():
    if i<tok.vocab_size: vocab[i]=t
with open(f"{SRC}/bge_vocab.txt","w") as f: f.write("\n".join(vocab))
# reference: probe ids + CLS vectors (Zig numeric self-test)
probes=["hunt for a phrase across the whole tree","commit my changes to the repository","search"]
with open(f"{SRC}/bge_ref.bin","wb") as f:
    f.write(struct.pack("<I",len(probes)))
    for p in probes:
        ids=tok(p)["input_ids"]; v=forward(ids).astype(np.float32)
        f.write(struct.pack("<H",len(ids))+struct.pack(f"<{len(ids)}I",*ids)+v.tobytes())
sz=os.path.getsize(f"{SRC}/bge_weights.bin")
print(f"\n  wrote src/bge_weights.bin ({sz/1e6:.1f} MB) · bge_vocab.txt ({tok.vocab_size} toks) · bge_ref.bin ({len(probes)} probes)")
print(f"  special ids: CLS {tok.cls_token_id} SEP {tok.sep_token_id} UNK {tok.unk_token_id} PAD {tok.pad_token_id}")
