#!/usr/bin/env python
"""
Análise profunda de uma música (opcional): o All-In-One (allin1, rede treinada para estrutura musical) dá as batidas, o 1º
tempo de cada compasso e as seções; o demucs que ele roda por dentro separa bateria, baixo, voz e o resto.

    <python do allin1> -I packages/analyzer/profunda.py <arquivo de áudio> <pasta de trabalho>   → JSON na saída

Serve para o que o Essentia sozinho não acerta (trilha orquestral, andamento que o RhythmExtractor lê dobrado): o
analyze.py --pecas usa esta grade no lugar da dele. Precisa de um ambiente próprio, com torch (~1,5 GB), indicado em
~/.dmixer/config.json como { "analyzer": { "profunda": "/caminho/bin/python" } }. Na CPU leva 3–5× a duração da música.

Saída: bpm, beats, downbeats, sections [{start, end, label}] e stems: o volume (dB) de cada stem em quadros de 50 ms.
Os stems em si (~200 MB por música) são apagados no fim; fica só o JSON.
"""
import json
import os
import shutil
import sys
from pathlib import Path

QUADRO = 0.05


def main(arquivo, trabalho):
    import numpy as np
    import soundfile as sf
    import allin1

    trabalho = Path(trabalho)
    trabalho.mkdir(parents=True, exist_ok=True)
    # o allin1 nomeia o cache e os stems pelo nome do arquivo: uma cópia com nome único na pasta de trabalho evita que um
    # "audio.m4a" sirva de resposta para outro (link físico quando dá; ele resolve links simbólicos)
    ent = trabalho / ("entrada" + Path(arquivo).suffix.lower())
    if not ent.exists():
        try:
            os.link(arquivo, ent)
        except OSError:
            shutil.copyfile(arquivo, ent)
    # o allin1 e o demucs escrevem progresso na saída padrão (até em subprocessos): ela vai para a de erro enquanto
    # eles rodam, e a saída padrão fica só com o JSON
    sys.stdout.flush()
    saida = os.dup(1)
    os.dup2(2, 1)
    try:
        r = allin1.analyze(str(ent), out_dir=str(trabalho / "out"), demix_dir=str(trabalho / "demix"),
                           spec_dir=str(trabalho / "spec"), device="cpu", keep_byproducts=True)
        stems = {}
        for nome in ("drums", "bass", "other", "vocals"):
            p = next((trabalho / "demix").rglob(f"{nome}.wav"), None)
            if p is None:
                continue
            y, sr = sf.read(str(p), dtype="float32", always_2d=True)
            y = y.mean(axis=1)
            w = int(QUADRO * sr)
            n = len(y) // w
            rms = np.sqrt((y[: n * w].reshape(n, w) ** 2).mean(axis=1))
            stems[nome] = np.round(20 * np.log10(rms + 1e-9), 1).tolist()
        sys.stdout.flush()
        os.dup2(saida, 1)
        print(json.dumps({
            "bpm": float(r.bpm),
            "beats": [round(float(b), 3) for b in r.beats],
            "downbeats": [round(float(b), 3) for b in r.downbeats],
            "sections": [{"start": round(float(s.start), 3), "end": round(float(s.end), 3), "label": s.label} for s in r.segments],
            "stems": {"quadro": QUADRO, **stems},
        }))
    finally:
        sys.stdout.flush()
        os.dup2(saida, 1)
        shutil.rmtree(trabalho, ignore_errors=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
