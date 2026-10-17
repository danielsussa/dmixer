#!/usr/bin/env python
"""
Pontos de corte de uma música: onde dá para tirar um trecho e emendar o resto sem que se perceba.

    ~/.dmixer/venv/bin/python -I packages/analyzer/analyze.py <arquivo de áudio>   → JSON na saída

1. A grade: as batidas vêm do Essentia (RhythmExtractor2013). O 1º tempo de cada compasso não vem de lugar
   nenhum pronto: é a fase (e o compasso, 3 ou 4) onde a harmonia mais muda e o grave mais ataca.
2. Cada batida é medida: harmonia (HPCP, 12 classes de altura), textura (energia por oitava, a mesma conta das
   `edges` da biblioteca) e volume.
3. Um salto de A para B (tirar [A, B)) é bom quando o compasso antes de A soa como o compasso antes de B e o
   compasso que começa em A soa como o que começa em B: quem ouve a emenda escuta uma continuação natural.
   A distância de cada par é comparada com a que já existe entre um compasso e o seguinte na própria música.
4. A música pensa em frases de 4 (e 8) compassos: um salto que tira ou repete frases inteiras mantém a forma; um que
   tira meia frase (2 compassos) ou um compasso solto desloca a frase, e isso se ouve mesmo com a harmonia batendo.
   Por isso a nota pesa: frase inteira vale o que mede; meia frase perde 15%; o resto, 30%.
5. Cada salto serve dos dois lados: de A para B tira o trecho [A, B); de B de volta para A repete esse trecho.
7. Com `--matriz`, sai também a nota de toda emenda entre compassos (`seams[i][j]`: tocar até o compasso i e seguir do
   compasso j). Serve para quem remonta a música inteira, inclusive trocando de seção (veja a conta no código).
6. Música sem batida firme (confiança baixa ou intervalos irregulares): sem compassos; pontos a cada meio segundo, ~2 s de
   contexto e crossfade longo (`pulse: "incerta"`). As sugestões se espalham pela música inteira (até 6 por trecho de
   30 s), para que todo pedaço de uma música longa tenha as suas.
"""
import json
import sys

import numpy as np
import essentia.standard as es

SR = 44100
QUADRO = 0.05
BANDAS = [60, 150, 300, 600, 1200, 2400, 4800, 9600, 16000]   # 8 faixas de uma oitava, como em etiquetas.py
SILENCIO = -50.0   # dB: batidas mais baixas que isso não entram na conta de harmonia
MAX_SALTOS = 40


def quadros(mono, sr):
    """energia por oitava (dB) em quadros de 50 ms"""
    w = int(QUADRO * sr)
    n = len(mono) // w
    if n == 0:
        return np.zeros((0, 8))
    F = np.abs(np.fft.rfft(mono[: n * w].reshape(n, w) * np.hanning(w), axis=1)) ** 2
    f = np.fft.rfftfreq(w, 1 / sr)
    return np.stack([10 * np.log10(F[:, (f >= a) & (f < b)].sum(axis=1) + 1e-10) for a, b in zip(BANDAS[:-1], BANDAS[1:])], axis=1)


def hpcp_quadros(x):
    """harmonia em quadros de ~46 ms (HPCP do Essentia), e o tempo de cada quadro"""
    win, spec, peaks = es.Windowing(type="blackmanharris62"), es.Spectrum(), es.SpectralPeaks(
        orderBy="magnitude", magnitudeThreshold=1e-5, minFrequency=40, maxFrequency=5000, maxPeaks=60, sampleRate=SR)
    hpcp = es.HPCP(size=12, referenceFrequency=440, minFrequency=40, maxFrequency=5000, sampleRate=SR, normalized="unitMax")
    out = [hpcp(*peaks(spec(win(fr)))) for fr in es.FrameGenerator(x, frameSize=4096, hopSize=2048, startFromZero=True)]
    return np.array(out), (np.arange(len(out)) * 2048 + 2048) / SR


def por_batida(valores, tempos, bordas):
    """a média dos quadros dentro de cada intervalo entre batidas"""
    idx = np.searchsorted(tempos, bordas)
    out = []
    for a, b in zip(idx[:-1], idx[1:]):
        out.append(valores[a:max(b, a + 1)].mean(axis=0) if a < len(valores) else valores[-1])
    return np.array(out)


def primeiro_tempo(h, graves, n_bat):
    """o compasso (3 ou 4) e a fase do 1º tempo: onde a harmonia troca e o grave ataca"""
    hn = h / (np.linalg.norm(h, axis=1, keepdims=True) + 1e-9)
    troca = np.r_[0, 1 - (hn[1:] * hn[:-1]).sum(axis=1)]
    ataque = np.r_[0, np.maximum(0, np.diff(graves))]
    z = lambda v: (v - v.mean()) / (v.std() + 1e-9)
    s = z(troca) + 0.5 * z(ataque)
    melhor = None
    for m in (4, 3):
        fases = [s[p::m].mean() for p in range(m)]
        p = int(np.argmax(fases))
        contraste = fases[p] - np.mean([f for k, f in enumerate(fases) if k != p])
        # 4 por 4 é a regra; 3 só quando se destaca bem mais
        if melhor is None or contraste > 1.3 * melhor[2]:
            melhor = (m, p, contraste)
    return melhor[0], melhor[1]


PASSO_LIVRE = 0.5      # s: sem batida firme, a "grade" é um quadro a cada meio segundo
XFADE_BATIDA = 0.06    # s: corte no tempo, crossfade curto (um longo borraria o ataque)
XFADE_LIVRE = 1.5      # s: música sem pulso firme se emenda com crossfade longo
POR_JANELA, JANELA_S, MAX_TOTAL = 6, 30.0, 400   # sugestões espalhadas: até 6 por trecho de 30 s (onde o salto começa)


def batida_firme(beats, conf):
    """dá para confiar na grade? confiança do Essentia razoável e intervalos entre batidas regulares"""
    d = np.diff(beats)
    cv = float(d.std() / (np.median(d) + 1e-9))
    return conf >= 1.0 and cv <= 0.08, cv


def main(path, matriz=False):
    x = es.MonoLoader(filename=path, sampleRate=SR)()
    dur = len(x) / SR
    bpm, beats, conf, _, _ = es.RhythmExtractor2013(method="multifeature")(x)
    beats = np.array([b for b in beats if b < dur])
    firme, cv = batida_firme(beats, conf) if len(beats) >= 16 else (False, 1.0)
    if not firme:
        # 6. Sem batida firme (orquestral livre, ambiente): não há compasso para respeitar. Os pontos são quadros de meio
        #    segundo, o contexto é ~2 s de cada lado, e a emenda é um crossfade longo — sem grade (nada de SNAP falso).
        beats = np.arange(0.0, max(0.0, dur - PASSO_LIVRE), PASSO_LIVRE)
    if len(beats) < 16:
        print(json.dumps({"version": 3, "duration": round(dur, 3), "bpm": round(float(bpm), 2), "error": "música curta demais"}))
        return

    bordas = np.r_[beats, min(dur, beats[-1] + np.median(np.diff(beats)))]
    q = quadros(x, SR)
    tq = (np.arange(len(q)) + 0.5) * QUADRO
    textura = por_batida(q, tq, bordas)                                   # dB por oitava
    volume = 10 * np.log10(por_batida(10 ** (q / 10), tq, bordas).sum(axis=1) + 1e-10)
    volume -= volume.max()
    hq, th = hpcp_quadros(x)
    harmonia = por_batida(hq, th, bordas)
    harmonia /= np.linalg.norm(harmonia, axis=1, keepdims=True) + 1e-9
    graves = textura[:, :2].max(axis=1)
    n = len(beats)

    if firme:
        meter, fase = primeiro_tempo(harmonia, graves, n)
        cands = np.arange(fase, n, meter)            # os 1ºs tempos
        passo = meter                                # a régua: um compasso para o seguinte
        off = np.arange(-meter, meter)
        minimo = meter                               # tira ou repete pelo menos um compasso
    else:
        meter = 4
        cands = np.arange(0, n, 2)                   # um ponto por segundo
        passo = 2
        off = np.arange(-4, 4)                       # ~2 s de cada lado
        minimo = int(4 / PASSO_LIVRE)                # pelo menos 4 s
    peso = 1.0 / (1 + np.abs(off + 0.5))
    peso /= peso.sum()

    def dist(a, b):
        """distância entre as batidas a e b (arrays de índices): harmonia, textura e volume"""
        dh = 1 - (harmonia[a] * harmonia[b]).sum(axis=-1)
        dh = np.where((volume[a] < SILENCIO) & (volume[b] < SILENCIO), 0, dh)
        dt = np.abs(textura[a] - textura[b]).mean(axis=-1)
        dl = np.abs(volume[a] - volume[b])
        return dh, dt, dl

    # a régua: o quanto um trecho já difere do seguinte na própria música
    k = np.arange(n - passo)
    rh, rt, rl = (np.median(v) + 1e-6 for v in dist(k, k + passo))

    validos = cands[(cands - len(off) // 2 >= 0) & (cands + len(off) // 2 <= n)]
    saltos = []
    for ii, i in enumerate(validos):
        js = validos[ii + 1:]
        js = js[js - i >= minimo]
        if not len(js):
            continue
        A = i + off
        B = js[:, None] + off[None, :]
        dh, dt, dl = dist(A[None, :], B)
        d = (peso[None, :] * (dh / rh + dt / rt + 0.5 * dl / rl)).sum(axis=1)
        saltos.extend(zip(d.tolist(), [int(i)] * len(js), js.tolist()))
    if not saltos:
        print(json.dumps({"version": 3, "duration": round(dur, 3), "bpm": round(float(bpm), 2), "error": "música curta demais"}))
        return

    # nota: 1 é uma repetição perfeita; 0,5 é tão parecido quanto um trecho com o seguinte
    nota = lambda d: 1 / (1 + (d / 2.5) ** 2)

    def forma(i, j):
        if not firme:
            return 1.0
        c = (j - i) // meter
        return 1.0 if c % 4 == 0 else 0.85 if c % 2 == 0 else 0.7
    saltos = sorted(((nota(d) * forma(i, j), i, j) for d, i, j in saltos), reverse=True)
    escolhidos = []
    por_janela = {}
    for s, i, j in saltos:
        if s < 0.5 or len(escolhidos) >= MAX_TOTAL:
            break
        jan = int(beats[i] // JANELA_S)
        if por_janela.get(jan, 0) >= POR_JANELA:
            continue
        lag = j - i
        # o mesmo salto deslocado um pouco (a mesma repetição) conta uma vez só
        if any(abs(lag - (b - a)) <= passo and abs(i - a) < 4 * passo for _, a, b in escolhidos):
            continue
        escolhidos.append((s, i, j))
        por_janela[jan] = por_janela.get(jan, 0) + 1
    escolhidos.sort(reverse=True)

    extra = {}
    if matriz and firme:
        # nota de cada emenda compasso i → compasso j (na linha do 1º tempo). Na emenda só se ouve o que vem antes de i e o
        # que vem depois de j. Ela soa natural se o antes de i parece o antes de j (é como a música chegava em j) ou se o
        # depois de j parece o depois de i (é como a música seguiria de i): a nota é a melhor das duas.
        bb = np.arange(fase, n, meter)
        lado = 2 * meter                               # dois compassos de cada lado
        antes, depois = np.arange(-lado, 0), np.arange(0, lado)
        pa = 1.0 / (1 + np.abs(antes + 0.5)); pa /= pa.sum()
        pd = 1.0 / (1 + np.abs(depois + 0.5)); pd /= pd.sum()

        def nota_lado(o, w):
            ok = (bb + o[0] >= 0) & (bb + o[-1] < n)
            A = np.clip(bb[:, None] + o[None, :], 0, n - 1)
            dh, dt, dl = dist(A[:, None, :], A[None, :, :])
            d = (w[None, None, :] * (dh / rh + dt / rt + 0.5 * dl / rl)).sum(axis=2)
            s = nota(d)
            s[~ok, :] = 0
            s[:, ~ok] = 0
            return s
        m = np.maximum(nota_lado(antes, pa), nota_lado(depois, pd))
        np.fill_diagonal(m, 1.0)
        extra["seams"] = np.round(m, 3).tolist()

    print(json.dumps({
        "version": 3,
        "duration": round(dur, 3),
        "bpm": round(float(bpm), 2),
        "confidence": round(float(conf), 2),
        "pulse": "firme" if firme else "incerta",
        "meter": meter,
        "beats": [round(float(b), 3) for b in beats] if firme else [],
        "bars": [round(float(beats[i]), 3) for i in np.arange(fase, n, meter)] if firme else [],
        "jumps": [{
            "from": round(float(beats[i]), 3),
            "to": round(float(beats[j]), 3),
            "removes": round(float(beats[j] - beats[i]), 3),
            "bars": int((j - i) // meter) if firme else 0,
            "phrase": bool(firme and (j - i) // meter % 4 == 0),
            "score": round(float(s), 3),
            "xfade": XFADE_BATIDA if firme else XFADE_LIVRE,
        } for s, i, j in escolhidos],
        **extra,
    }))


if __name__ == "__main__":
    main(sys.argv[1], "--matriz" in sys.argv[2:])
