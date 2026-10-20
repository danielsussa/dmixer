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
8. Com `--pecas [--grade profunda.json]`, sai a música em peças para remontar (veja "peças", no fim do arquivo).
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


# ───────────────────────────── peças (remontagem) ─────────────────────────────
#
# Com `--pecas [--grade profunda.json]`, a música vira peças para remontar como um quebra-cabeça:
# 1. A grade de compassos: a do Essentia (a mesma dos pontos de corte) ou, com --grade, a do All-In-One (profunda.py),
#    limpa (um trecho com meio compasso, onde o modelo dobrou o andamento, é juntado), posta numa reta quando o andamento
#    é fixo e completada para trás quando a música começa antes do primeiro compasso achado.
# 2. As peças: programação dinâmica sobre a força de cada divisa (o quanto o compasso muda do anterior, mais o começo das
#    seções quando há), preferindo frases de 4 compassos (8 e 2 também servem; 1, 3, 5 e 7 custam mais).
# 3. Cada peça: energia (0–1 dentro da música), camadas (com stems: bateria, baixo, outros, voz; sem eles: batida e
#    grave, medidos na textura), variação dentro dela e a função: abertura, respiro, base, subida, virada (a batida sai
#    no fim: pede um pico depois), pico, final. Peças quase iguais são "gêmeas" (refrões repetidos).
# 4. A emenda entre toda peça A e toda peça B: a nota da matriz de emendas (a mesma conta do --matriz) na divisa onde A
#    acaba e B começa. 1 é natural (eram vizinhas, ou soa como se fossem); 0,5 é tão parecido quanto um compasso e o seguinte.

ATIVO_DB = -35.0
PEN_TAMANHO = {4: 0.0, 8: 0.2, 2: 0.35, 6: 0.45, 3: 0.6, 5: 0.6, 7: 0.7, 1: 0.9}


def grade_profunda(g, dur, fluxo, tf):
    """compassos do All-In-One: tira meios compassos, põe numa reta se o andamento é fixo e completa o começo"""
    d0 = np.array([t for t in g["downbeats"] if t < dur])
    iv = np.diff(d0)
    m = np.median(iv)
    meio, dobro = np.mean(np.abs(iv / (m / 2) - 1) < 0.15), np.mean(np.abs(iv / (2 * m) - 1) < 0.15)
    if max(meio, dobro) > 0.2:
        longo = float(np.median(iv[np.abs(iv / (2 * m) - 1) < 0.15])) if dobro > meio else float(np.median(iv[np.abs(iv / m - 1) < 0.15]))
        manter = [d0[0]]
        for t in d0[1:]:
            if t - manter[-1] >= 0.75 * longo:
                manter.append(t)
        d0 = np.array(manter)
    k0 = np.arange(len(d0))
    b, a = np.polyfit(k0, d0, 1)
    fixo = bool(np.median(np.abs(d0 - (a + b * k0))) < 0.012)
    comp = float(b) if fixo else float(np.median(np.diff(d0)))
    extra = 0
    while d0[0] - (extra + 1) * comp > 0.25:
        extra += 1
    forca = lambda ts: float(np.mean(np.interp(ts, tf, fluxo)))
    if fixo:
        base = a + b * np.arange(-extra, len(d0))
        desl = max(np.arange(-0.03, 0.0305, 0.001), key=lambda o: forca(base[extra:] + o))
        bars = base + desl
    else:
        bars = np.r_[[d0[0] - j * comp for j in range(extra, 0, -1)], d0]
    return bars[bars < dur - 0.5], fixo


def fluxo_agudo(x, sr):
    """força de ataque (fluxo espectral positivo) em quadros de ~5,8 ms: para alinhar a grade aos golpes"""
    hop, n = 256, 1024
    q = (len(x) - n) // hop
    if q <= 0:
        return np.zeros(1), np.zeros(1)
    idx = np.arange(n)[None, :] + hop * np.arange(q)[:, None]
    S = np.log1p(np.abs(np.fft.rfft(x[idx] * np.hanning(n), axis=1)))
    f = np.r_[0, np.maximum(0, np.diff(S, axis=0)).sum(axis=1)]
    return f, (np.arange(q) * hop + n / 2) / sr


def segmenta(forca):
    n = len(forca)
    best = [-1e9] * (n + 1)
    best[0] = 0.0
    de = [0] * (n + 1)
    for k in range(1, n + 1):
        for L, p in PEN_TAMANHO.items():
            if L <= k:
                v = best[k - L] + forca[k - L] - p - 0.1
                if v > best[k]:
                    best[k], de[k] = v, k - L
    cortes, k = [], n
    while k > 0:
        cortes.append(de[k])
        k = de[k]
    cortes = sorted(cortes)
    trechos = list(zip(cortes, cortes[1:] + [n]))
    if len(trechos) > 2 and trechos[-1][1] - trechos[-1][0] <= 2:   # um final de 1–2 compassos (só o golpe) vai com a frase anterior
        trechos[-2:] = [(trechos[-2][0], trechos[-1][1])]
    if len(trechos) > 2 and trechos[0][1] - trechos[0][0] <= 2:     # uma abertura de 1–2 compassos (a anacruse) vai com a frase seguinte
        trechos[:2] = [(trechos[0][0], trechos[1][1])]
    return trechos


def pecas(path, grade_path=None):
    x = es.MonoLoader(filename=path, sampleRate=SR)()
    dur = len(x) / SR
    fluxo, tf = fluxo_agudo(x, SR)
    secoes = []
    stems = None
    origem = "essentia"
    if grade_path:
        g = json.load(open(grade_path))
        bars, fixo = grade_profunda(g, dur, fluxo, tf)
        bpm = 60 / (np.median(np.diff(bars)) / 4)
        secoes = g.get("sections", [])
        stems = g.get("stems")
        origem = "allin1"
    else:
        bpm, beats, conf, _, _ = es.RhythmExtractor2013(method="multifeature")(x)
        beats = np.array([b for b in beats if b < dur])
        firme, _ = batida_firme(beats, conf) if len(beats) >= 16 else (False, 1.0)
        if not firme:
            print(json.dumps({"version": 1, "duration": round(dur, 3), "error":
                              "sem batida firme: a remontagem precisa de compassos. A análise profunda (All-In-One) costuma achá-los."}))
            return
        # mesma grade dos pontos de corte: 1º tempo pela harmonia e pelo grave
        bordas = np.r_[beats, min(dur, beats[-1] + np.median(np.diff(beats)))]
        q = quadros(x, SR)
        tq = (np.arange(len(q)) + 0.5) * QUADRO
        hq, th = hpcp_quadros(x)
        h = por_batida(hq, th, bordas)
        h /= np.linalg.norm(h, axis=1, keepdims=True) + 1e-9
        meter, fase = primeiro_tempo(h, por_batida(q, tq, bordas)[:, :2].max(axis=1), len(beats))
        bars = beats[fase::meter]
        comp = float(np.median(np.diff(bars)))
        extra = 0
        while bars[0] - (extra + 1) * comp > 0.25:
            extra += 1
        bars = np.r_[[bars[0] - j * comp for j in range(extra, 0, -1)], bars]
        bpm = float(bpm)
    nb = len(bars)
    if nb < 8:
        print(json.dumps({"version": 1, "duration": round(dur, 3), "error": "música curta demais para remontar"}))
        return
    comp = float(np.median(np.diff(bars)))
    fins = np.r_[bars[1:], min(dur, bars[-1] + comp)]

    # medidas por meio-tempo (8 por compasso): a matriz de emendas olha 2 compassos de cada lado com esta resolução
    sub = 8
    grade = np.concatenate([np.linspace(a, b, sub, endpoint=False) for a, b in zip(bars, fins)])
    bordas = np.r_[grade, fins[-1]]
    q = quadros(x, SR)
    tq = (np.arange(len(q)) + 0.5) * QUADRO
    textura = por_batida(q, tq, bordas)
    potencia = por_batida(10 ** (q / 10), tq, bordas).sum(axis=1)
    volume = 10 * np.log10(potencia + 1e-10)
    volume -= volume.max()
    hq, th = hpcp_quadros(x)
    harmonia = por_batida(hq, th, bordas)
    harmonia /= np.linalg.norm(harmonia, axis=1, keepdims=True) + 1e-9
    n = len(grade)

    def dist(a, b):
        dh = 1 - (harmonia[a] * harmonia[b]).sum(axis=-1)
        dh = np.where((volume[a] < SILENCIO) & (volume[b] < SILENCIO), 0, dh)
        dt = np.abs(textura[a] - textura[b]).mean(axis=-1)
        dl = np.abs(volume[a] - volume[b])
        return dh, dt, dl
    k = np.arange(n - sub)
    rh, rt, rl = (np.median(v) + 1e-6 for v in dist(k, k + sub))
    nota = lambda d: 1 / (1 + (d / 2.5) ** 2)

    bb = np.arange(0, n, sub)
    lado = 2 * sub
    antes, depois = np.arange(-lado, 0), np.arange(0, lado)
    pa = 1.0 / (1 + np.abs(antes + 0.5)); pa /= pa.sum()
    pd = 1.0 / (1 + np.abs(depois + 0.5)); pd /= pd.sum()

    def nota_lado(o, w):
        # nas pontas falta contexto de um lado: usa o que existe (o lado que falta não conta)
        A = np.clip(bb[:, None] + o[None, :], 0, n - 1)
        dh, dt, dl = dist(A[:, None, :], A[None, :, :])
        d = (w[None, None, :] * (dh / rh + dt / rt + 0.5 * dl / rl)).sum(axis=2)
        s = nota(d)
        ok = (bb + o[0] >= 0) & (bb + o[-1] < n)
        s[~ok, :] = 0
        s[:, ~ok] = 0
        return s
    M = np.maximum(nota_lado(antes, pa), nota_lado(depois, pd))
    np.fill_diagonal(M, 1.0)

    # por compasso
    def media_bar(v):
        return np.array([v[i * sub:(i + 1) * sub].mean(axis=0) for i in range(nb)])
    e_bar = 10 * np.log10(media_bar(potencia) + 1e-10)
    tex_bar = media_bar(textura)
    harm_bar = media_bar(harmonia)
    # batida e grave sem stems: o fluxo agudo médio do compasso, e o grave (60–300 Hz) perto do grave mais forte
    fl = np.array([np.mean(fluxo[(tf >= a) & (tf < b)]) if np.any((tf >= a) & (tf < b)) else 0 for a, b in zip(bars, fins)])
    p5, p95 = np.percentile(fl, 5), np.percentile(fl, 95)
    batida = np.clip((fl - p5) / (p95 - p5 + 1e-9), 0, 1)
    grave = 10 * np.log10(10 ** (tex_bar[:, 0] / 10) + 10 ** (tex_bar[:, 1] / 10))
    stems_bar = None
    if stems:
        tq_s = stems["quadro"]
        nomes = {"drums": "bateria", "bass": "baixo", "other": "outros", "vocals": "voz"}
        stems_bar = {}
        for s_, nome in nomes.items():
            if s_ not in stems:
                continue
            v = 10 ** (np.array(stems[s_]) / 10)
            t_s = (np.arange(len(v)) + 0.5) * tq_s
            stems_bar[nome] = [float(10 * np.log10(v[(t_s >= a) & (t_s < b)].mean() + 1e-12)) if np.any((t_s >= a) & (t_s < b)) else -120.0
                               for a, b in zip(bars, fins)]

    # força de cada divisa: o quanto o compasso muda do anterior (harmonia + textura), mais o começo de uma seção
    mud = np.zeros(nb)
    for i in range(1, nb):
        dh = 1 - float(np.dot(harm_bar[i], harm_bar[i - 1]) / (np.linalg.norm(harm_bar[i]) * np.linalg.norm(harm_bar[i - 1]) + 1e-9))
        mud[i] = dh / rh + np.abs(tex_bar[i] - tex_bar[i - 1]).mean() / rt + 0.5 * abs(e_bar[i] - e_bar[i - 1]) / rl
    mud = mud / (np.percentile(mud[1:], 95) + 1e-9)
    forca = 0.5 * np.clip(mud, 0, 1.5)
    for s_ in secoes:
        i = int(np.argmin(np.abs(bars - s_["start"])))
        if abs(bars[i] - s_["start"]) < comp / 2 and 0 < i:
            forca[i] += 0.35
    forca[0] = 1.0
    trechos = segmenta(forca.tolist())

    # peças e categorias
    lo, hi = np.percentile(e_bar, 5), e_bar.max()
    tem_bateria = bool(stems_bar and max(stems_bar.get("bateria", [-120])) > ATIVO_DB) if stems_bar else bool(p95 > 2 * p5)
    out = []
    for i, (c0, c1) in enumerate(trechos):
        e = float(10 * np.log10(np.mean(10 ** (e_bar[c0:c1] / 10))))
        p = {"i": i, "start": 0.0 if i == 0 else round(float(bars[c0]), 3), "end": round(float(dur if c1 == nb else bars[c1]), 3),
             "bar": int(c0), "bars": int(c1 - c0),
             "energy": round(float(np.clip((e - lo) / (hi - lo + 1e-9), 0, 1)), 3),
             "change_db": round(float(e_bar[c1 - 1] - e_bar[c0]), 1)}
        if stems_bar:
            p["layers"] = [nm for nm, v in stems_bar.items() if np.mean(np.array(v[c0:c1]) > ATIVO_DB) >= 0.5]
            ini_b = stems_bar.get("bateria", [-120] * nb)[c0]
            fim_b = min(stems_bar.get("bateria", [-120] * nb)[max(c0, c1 - 2):c1])
            sai_batida = ini_b - fim_b > 8
            tem_b = "bateria" in p["layers"]
        else:
            camadas = []
            if np.mean(batida[c0:c1]) > 0.35:
                camadas.append("batida")
            if np.mean(grave[c0:c1]) > grave.max() - 12:
                camadas.append("grave")
            p["layers"] = camadas
            sai_batida = batida[c0] - batida[max(c0, c1 - 2):c1].min() > 0.4
            tem_b = "batida" in camadas
        en = p["energy"]
        if i == 0:
            f = "abertura"
        elif i == len(trechos) - 1:
            f = "final"
        elif en < 0.35 or (stems_bar and tem_bateria and not tem_b and en < 0.6):   # sem stems, "sem batida" engana na orquestra
            f = "respiro"
        elif tem_bateria and sai_batida:
            f = "virada"
        elif p["change_db"] >= 4:
            f = "subida"
        elif en >= 0.75:
            f = "pico"
        else:
            f = "base"
        p["role"] = f
        if secoes:
            meio = (bars[c0] + (bars[c1] if c1 < nb else dur)) / 2
            p["section"] = next((s_["label"] for s_ in secoes if s_["start"] <= meio < s_["end"]), None)
        out.append(p)
    # gêmeas: mesmo tamanho e cada compasso quase igual ao correspondente (a nota da emenda entre eles fica perto de 1)
    for p in out:
        p["twins"] = [o["i"] for o in out if o is not p and o["bars"] == p["bars"]
                      and np.mean([M[p["bar"] + j, o["bar"] + j] for j in range(p["bars"])]) > 0.85]
    # emendas entre peças: tocar A até a divisa onde ela acaba e seguir do começo de B
    E = np.zeros((len(out), len(out)))
    for a in out:
        fim = a["bar"] + a["bars"]
        for b in out:
            if fim >= nb or b["i"] == 0:
                E[a["i"], b["i"]] = 0.0          # nada vem depois do final, e a abertura só abre
            else:
                E[a["i"], b["i"]] = M[fim, b["bar"]]
    print(json.dumps({
        "version": 1,
        "duration": round(dur, 3),
        "bpm": round(float(bpm), 2),
        "grid": origem,
        "bar": round(comp, 4),
        "bars": [round(float(b), 3) for b in bars],
        "sections": secoes,
        "pieces": out,
        "seams": np.round(E, 3).tolist(),
    }))


if __name__ == "__main__":
    args = sys.argv[2:]
    if "--pecas" in args:
        pecas(sys.argv[1], args[args.index("--grade") + 1] if "--grade" in args else None)
    else:
        main(sys.argv[1], "--matriz" in args)
