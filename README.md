# dmixer

Um mixer de áudio declarativo. A mixagem é um arquivo YAML numa pasta. A tela, o preview e o CLI são jeitos diferentes de olhar e mudar esse arquivo. É o irmão do [vidmeo](../vidmeo), só que para som, e o modelo de mixagem é o de uma DAW como o REAPER.

```
                         mix.yaml
                     (fonte da verdade)
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
   Editor (/c/<uuid>)   Agentes / LLMs      CLI
        timeline        editam o arquivo    dmixer render
        mixer, preview                      dmixer validate
            └───────────────┼───────────────┘
                            ▼
                         mix.yaml
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
         Web Audio (preview)      motor JS + ffmpeg (render)
```

Não existe IA dentro do editor. Um agente é só mais alguém que escreve no `mix.yaml`: ele edita o arquivo, o servidor percebe, o esquema recusa o que estiver malformado, e a tela atualiza.

## Começar

Precisa de Node 20+ e de `ffmpeg`/`ffprobe` no `PATH`.

```bash
npm install && npm run build
./examples/demo/make-media.sh                       # mídias sintéticas do exemplo
npm run dmixer -- link examples/demo/mix.yaml        # → http://localhost:5184/c/<uuid>
npm run dmixer -- open                               # um servidor para todas as mixagens
```

**Uma mixagem = um link.** O servidor não fica preso a uma pasta. Cada YAML, em qualquer pasta da máquina, ganha um UUID e abre em `/c/<uuid>`. A raiz `/` lista as mixagens ligadas e tem um campo para ligar um caminho novo.
- O índice fica em `~/.dmixer/index.json` (ou em `DMIXER_HOME`).
- O UUID também é gravado no YAML (`project.id`). Se o arquivo mudar de lugar, `dmixer link` no caminho novo mantém o mesmo link.
- Cada mixagem usa a **pasta do próprio YAML**: mídias relativas, `cache/` e `renders/` ficam ao lado dele.
- `DMIXER_PUBLIC_URL` define o endereço que o `link` imprime, por exemplo o nome na tailnet.

Para desenvolver a interface: `npm run dev` (Vite em 5183, com proxy para o servidor em 5184).

## As duas regras

**Tudo é estado.** Se algo soa na mixagem, está no arquivo. Não existe mixagem escondida na tela.

**Toda mudança é um patch** (JSON Patch endereçado por id): `/tracks/[id=musica]/clips/[id=c03]/start`. A tela, um agente e o CLI escrevem pelo mesmo caminho. É daí que saem o desfazer/refazer, o histórico e a garantia de nunca gravar um arquivo inválido. Os comentários do arquivo sobrevivem às gravações.

## O formato

```yaml
version: 1
project:
  name: demo
  sample_rate: 44100
  bpm: 72              # opcional: grade, ímã e régua de compassos
  meter: 4
media:                 # pastas de fora que os assets podem usar como "@nome/…"
  video: ..
assets:
  fala-1: { src: audio/fala-1.wav }           # a duração é preenchida ao abrir
  voz-01: { src: "@video/engine/media/s0.voice.mp3" }
markers:
  - { id: virada, at: 6.67, label: "a virada" }
  - { id: respiro, at: "@virada + 3" }         # tempo semântico: segue o outro marcador
master:
  loudness: { target: -14, true_peak: -1.5 }   # o render normaliza para isto
  effects: [{ type: limiter, ceiling: -1 }]
tracks:
  - id: voz
    name: Narração
    volume: 0          # dB
    pan: 0             # −1 … +1
    effects:
      - { type: highpass, freq: 80 }
      - { type: compressor, threshold: -18, ratio: 3, attack: 0.01, release: 0.15 }
    clips:
      - id: frase-1
        asset: fala-1
        start: 1                  # segundos na timeline, ou "@virada - 0.2"
        in: 0                     # trecho do arquivo
        out: 2
        gain: 0                   # dB
        fade_in: 0.005
        fade_out: 0.005
        label: primeira frase
  - id: musica
    output: bus-musica            # manda para um bus em vez do master
    clips: [{ id: cama, asset: musica, start: 0 }]
  - id: bus-musica
    type: bus
    effects:
      - { type: eq, freq: 3000, gain: -3, q: 1 }
      - { type: duck, source: voz, depth: 10, attack: 0.1, release: 0.5, hold: 0.6 }
      - { type: reverb, mix: 0.2, seconds: 2 }
    automation:
      volume:                     # envelope em dB, somado ao volume da trilha
        - { at: 0, db: 0 }
        - { at: "@respiro", db: 0 }
        - { at: "@respiro + 2", db: -20 }    # curve: hold faz degrau
```

**Efeitos:** `highpass`, `lowpass`, `eq` (peaking), `shelf` (low/high), `compressor`, `duck`, `reverb` (Freeverb), `limiter`. Qualquer um aceita `bypass: true`.

**Ducking** segue os **clipes** da trilha de origem, não o sinal. Do `attack` antes de cada clipe até o `release` depois dele, a trilha baixa `depth` dB. Intervalos entre clipes menores que `hold` continuam baixos, para a música não "bombear" nas respirações. Por seguir os clipes, o preview e o render dão sempre o mesmo resultado.

**Mute e solo** funcionam como numa DAW: uma trilha em solo mantém audível o bus para onde ela manda.

**Trilhas de samplers** (`samplers: true`) guardam só peças da biblioteca. As peças nunca vão para outra trilha, e narração ou outros áudios não entram nelas. Ao colar ou arrastar uma peça, ela vai para a trilha de samplers selecionada, senão para a da última peça, senão para uma nova trilha "Samplers". Os complementos ganham trilhas de samplers próprias, uma camada acima das bases. Arrastar um clipe entre uma trilha de samplers e uma trilha comum não é permitido. As trilhas antigas `lib-*` e `compl-*` contam como trilhas de samplers.

## Vídeo

O dmixer edita a imagem junto com o som, num arquivo só. Uma trilha `type: video` guarda imagem. As trilhas de vídeo mais acima na lista ficam por cima. A composição foi trazida do vidmeo (`core/src/visual.ts`) e é a mesma no visor e no render mp4 (`server/src/video.ts`).

**O que um clipe de vídeo pode ser:**
- **um arquivo:** vídeo (`in`/`out`, como no áudio), foto (`.jpg`, `.png`…, com `duration`) ou página `.html` (um título animado, com `duration` e `params`, que vão na query string);
- **`type: color`:** um cartão chapado da cor `fill` (preto por padrão), sem arquivo;
- **`type: adjustment`:** uma camada de ajuste, que não desenha nada e aplica os `effects` dela a tudo o que está abaixo, enquanto dura (a grade do filme todo, o grão).

**Campos de imagem:**
- `transform` (`x`, `y` em pixels a partir do centro; `scale` sobre o encaixe no quadro; `rotation` em graus), cada um um número ou `{keyframes: [{at, value, easing?}]}`, com `at` no tempo do clipe. Zoom de 2,0 → 1,85 ao longo do clipe é o Ken Burns;
- `crop` (frações), `opacity`, `transition` e `transition_out` (`{type: fade, duration}`, rampas de opacidade nas pontas);
- `effects`: `color` (exposure, contrast, saturation, gamma, temperature, tint, red/green/blue, com uma fórmula só para o ffmpeg e o navegador), `grain`, `blur`, `brightness`, `contrast`, `saturate`, `grayscale`.

**Páginas html:** o contrato de tempo é o do vidmeo, com os mesmos nomes, e as mesmas páginas servem nos dois. As animações CSS ficam pausadas e são postas no tempo local do clipe; `--vidmeo-duration` e `--vidmeo-time` ficam no `<html>`; `window.vidmeoSeek(t, dur)` é chamado a cada quadro, se existir. No render, o Chrome headless (playwright-core; `DMIXER_CHROME` escolhe o executável) captura os quadros, com cache em `cache/html/`.

**Na tela:**
- **Visor:** à direita, compõe o quadro do playhead e acompanha a mixagem. ⤢ amplia. O grão só aparece com a mix parada.
- **Inspetor:** num clipe de vídeo, mostra duração, zoom e x/y do começo ao fim, entrada e saída, a cor e, numa página, os params (o texto do título).
- **Adicionar:** arraste fotos e vídeos do computador para uma trilha de vídeo (vão para `imagem/`; uma foto entra com 4 s), ou use o menu da trilha: "Importar foto ou vídeo…" e "Cartão preto no playhead".
- **Render mp4:** `dmixer render mix.yaml --out f.mp4 [--from s] [--to s]`, ou pela tela.

A trilha de vídeo não faz som. Para ouvir o som original, ponha o mesmo arquivo numa trilha de áudio.

```yaml
project:
  video: { width: 1920, height: 1080, fps: 24 }
media:
  fotos: arquivo/fotos-2k
assets:
  terra: { src: "@fotos/as13-60-8588.jpg" }
  texto: { src: titulos/texto.html }
tracks:
  - id: titulos
    type: video
    clips: [{ id: t1, asset: texto, start: 17.3, duration: 2.6, params: { t: "Apollo 13 · abril de 1970" } }]
  - id: grade
    type: video
    clips: [{ id: grade, type: adjustment, start: 0, duration: 300, effects: [{ type: color, contrast: 1.12 }, { type: grain, amount: 12 }] }]
  - id: imagem
    type: video
    clips:
      - { id: preto, type: color, start: 0, duration: 1.2 }
      - { id: p1, asset: terra, start: 1.2, duration: 7.5, transform: { scale: { keyframes: [{ at: 0, value: 2.0 }, { at: 7.5, value: 1.85 }] } } }
```

## Bibliotecas de peças

Uma biblioteca é uma pasta com um `index.json` marcado `"dmixer_library": 1`. O índice lista as peças com arquivo, categoria, camada, acorde, intensidade e compassos (veja `youtube.com-danielsussa/scripts/biblioteca.py`, que gera uma). Campos opcionais viram filtros na aba Biblioteca e na gaveta do celular: `source`, a origem (`lote-N` aparece como "lote N", e o lote mais novo fica em destaque); `mood`, o clima; `instruments`, as famílias de instrumento; e `under_voice`, se a peça cabe embaixo da narração. O índice pode trazer `moods` com a ordem dos climas. Peças podem ter cauda (`tail`): o fim das notas e o reverb depois do corpo (`body`). A timeline mostra só o corpo, que é o que encaixa, e a cauda soa por baixo da próxima peça. Com `edges` (a energia por oitava, de 50 em 50 ms, nos ~300 ms do fim do corpo, do começo do corpo e do começo da cauda), o dmixer calcula o salto de textura de cada emenda. Acima de 6,5, a bolinha fica laranja ("soa como corte") e o modo conector esconde a peça. Em `edges.pulse`, o índice diz se cada borda é rítmica e qual a força do 1º tempo. Depois de uma peça rítmica, uma peça rítmica que chega com o 1º tempo fraco (mais de 6 dB abaixo do maior ataque do compasso) faz "a batida tropeçar", e também fica laranja. Uma emenda brusca pode ser **coberta**: o botão "＋ transição na emenda" (no inspetor da peça e no bloco selecionado no celular) põe uma peça de cobertura (`role: cobertura`, só percussão sem altura, com `hit`, onde cai o golpe) numa trilha "Transições", com o golpe no 1º tempo da peça nova. A escolha segue o problema: batida que tropeça leva virada de caixa; instrumento que some ou textura que muda leva prato crescendo com golpe; o resto leva só o golpe de chegada. Emenda coberta fica azul. Com `cuts` (pontos de corte medidos: divisas de compasso sem golpe cortado, onde a textura emenda tão bem quanto no fim verdadeiro), o bloco mostra um tracejado em cada ponto. Soltar outra peça perto de um tracejado faz ela entrar ali. A anterior termina no ponto (`body` no clipe) e o que vinha depois some em 0,4 s por baixo da nova (`out` e `fade_out`). Arrastar a nova para longe devolve a anterior inteira. No celular, o bloco selecionado tem ✂ (encurta até o ponto anterior, e as peças seguintes andam junto) e "inteira". O dmixer acha as bibliotecas de dois jeitos:
- pastas que a mixagem já declara em `media:`;
- as listadas em `~/.dmixer/config.json` (`{"libraries": [{"alias": "pecas", "path": "/…/biblioteca"}]}`).

Na aba **Biblioteca** você filtra por categoria, acorde e intensidade, ouve a prévia e arrasta a peça para a timeline. Ela cai no compasso mais próximo, numa trilha de áudio ou numa trilha nova da categoria, que é mandada para o bus. Na primeira vez, a pasta é declarada em `media:`.

## Pontos de corte

Para encurtar uma música sem que se perceba: selecione o clipe, e no Inspetor clique em **Analisar a música**. O analisador (`packages/analyzer/analyze.py`, com [Essentia](https://essentia.upf.edu)) acha as batidas e o 1º tempo de cada compasso e lista os trechos que podem sair: aqueles em que o compasso antes do corte soa como o compasso antes da volta, e o depois como o depois (harmonia, textura por oitava e volume). Cada trecho tem uma nota: 100% é uma repetição perfeita, e 50% é tão parecido quanto um compasso com o seguinte.
- **▶** toca 4 s antes do corte e segue do ponto de volta, como vai ficar.
- **tirar** divide o clipe em dois, emendados com um crossfade de 60 ms.
- Passar o mouse sobre um trecho marca na timeline o que sai.
- Funciona melhor em música com andamento fixo. O resultado fica em `cache/analysis/`, então a segunda vez é instantânea.

Instalação (uma vez): `npm run setup:analyzer` cria `~/.dmixer/venv` com numpy e Essentia. Outro Python pode ser indicado em `~/.dmixer/config.json`: `{"analyzer": {"python": "/caminho/bin/python"}}`.

## Roteiro

O botão **Roteiro** na barra de cima abre `/c/<id>/roteiro`: o texto que a narração diz, na ordem da mixagem,
dividido pelos capítulos e marcado pelos humores. Clicar numa palavra (ou no horário de um parágrafo) toca dali; a
palavra que está tocando fica acesa, e "seguir" rola até ela. O áudio é o mesmo da timeline.

- **Faixas fixas.** O roteiro lê três faixas de tags pelo id: `capitulos` (uma tag por capítulo), `humor` e `texto`.
  Mixagens novas já nascem com elas; numa antiga, a página oferece "Criar as faixas".
- **Humores de sempre.** leve, energia, agressivo, relaxado, triste, feliz, tenso, dançante, festa e valência, cada um
  com sua cor (`HUMORES` em `packages/core/src/roteiro.ts`). Uma tag na faixa Humor sem `color` pega a cor do nome; o
  Inspector mostra a paleta para escolher. Outro nome também vale.
- **Antes da gravação**, a fala mora na faixa `texto`: uma tag por bloco, com o texto em `text`, no tempo estimado pela
  leitura (2,5 palavras/s; o Inspector tem "duração pela leitura"). Assim capítulos, humores e até a trilha já podem
  ser montados sem a voz. O roteiro mostra esses blocos com `~` no horário e uma borda tracejada. Para revisar, o agente
  lê o `dmixer context`, que traz o texto inteiro de cada bloco, e altera o `text` das tags.

  ```yaml
  - id: b1
    start: 0
    end: 8.6
    lane: texto
    text: E quando você tem as melhores cartas da mesa, e o jogo perfeito está ali?
  ```
- **Depois da gravação**, o texto vem do `palavras.json` ao lado de cada voz (`s0.voice.mp3` → `s0.palavras.json`, com
  `palavras: [[início, fim, "palavra"], …]` e, opcional, `frases`). Só entra o que o clipe toca: um corte some do texto.
  Onde há fala gravada, o bloco da faixa texto deixa de aparecer. Trilhas de fala sem transcrição aparecem no fim.

## Remontar (quebra-cabeça)

Para refazer uma música com outra duração ou outra forma: selecione um clipe dela, e no Inspetor, em **Remontar**, clique em **Cortar em peças**.

1. **Peças.** O analisador (`analyze.py --pecas`) corta a música em frases de compassos inteiros, normalmente de 4. A divisão sai de uma busca pelas divisas onde a música mais muda.
2. **Função de cada peça:** abertura, respiro, base, subida, virada (a batida sai no fim e pede um pico depois), pico ou final. Junto vêm a energia (0–1 dentro da música) e as camadas ativas. Peças quase iguais são marcadas como gêmeas.
3. **Emenda entre peças.** Para cada par de peças, a emenda é medida com a mesma conta da matriz dos pontos de corte. Peças que já eram vizinhas no original têm nota 100%.
4. **O molde:**
   - **duração:** a do trecho, em segundos, ou até um marcador;
   - **curva de energia:** como a original, direto ao pico, pico no meio, cresce até o fim, ou dois picos com um respiro;
   - **pico em um marcador:** um trecho forte começa ali, como o drop num corte do vídeo;
   - **começo e fim:** pode começar no meio da música e acabar antes do final, com fade.
5. **Gerar opções.** A busca (`core/remontar.ts`) mostra 3 sequências diferentes. Cada uma vem com a fita das peças coloridas por função, a nota de cada emenda e o pior caso. "aplicar alinhando" desloca a remontagem para o pico cair exatamente no marcador; quando seria preciso começar antes, apara o começo da abertura.
6. **Aplicar.** O trecho (o clipe e os pedaços da mesma música encostados nele) vira um clipe por peça, colorido e rotulado (`P3 · pico`). A nota de cada clipe diz de onde a peça veio e a nota da emenda. Cada emenda corta 12 ms antes do 1º tempo, com crossfade de 20 ms, para o golpe da peça nova entrar inteiro. O que vem depois na trilha anda junto, e Ctrl+Z desfaz tudo.

**Análise profunda (opcional).** Quando o Essentia não acha uma batida firme (trilha orquestral, andamento lido dobrado), o botão **Análise profunda** usa o [All-In-One](https://github.com/mir-aidj/all-in-one) (`profunda.py`). Ele dá a grade, as seções e os stems (bateria, baixo, outros, voz), que melhoram as funções.
- Precisa de um ambiente Python próprio, com torch (~1,5 GB), indicado em `~/.dmixer/config.json`: `{"analyzer": {"profunda": "/caminho/bin/python"}}`.
- Na CPU leva 3–5× a duração da música na primeira vez. O servidor trabalha em segundo plano e guarda o resultado em `cache/analysis/`.

## Preview e render

- **Preview:** nós do Web Audio montados a partir do arquivo. Os filtros usam as mesmas equações (RBJ) nos dois lados, e o reverb do preview é a resposta ao impulso do próprio Freeverb do render. Uma edição durante o play reconstrói a mixagem na posição atual. O preview não normaliza o loudness; isso é só no render.
- **Render:** motor em JS sobre buffers float. Posiciona os clipes, passa os efeitos de cada trilha, aplica envelope, volume e pan, soma os buses antes do master e normaliza o loudness com o `loudnorm` do ffmpeg em duas passagens. Sai em mp3, wav ou mp4 (com a imagem), pela tela ou pelo CLI (`--out f.mp4`).

## CLI

```bash
npm run dmixer -- init <arquivo.yaml>                 # mixagem vazia (já ligada)
npm run dmixer -- link <arquivo.yaml | pasta>         # liga e imprime o link /c/<uuid>
npm run dmixer -- list                                # mixagens ligadas
npm run dmixer -- unlink <uuid>
npm run dmixer -- open [arquivo.yaml | pasta …]       # servidor (liga o que for passado)
npm run dmixer -- validate <arquivo.yaml | uuid>
npm run dmixer -- context <arquivo.yaml | uuid>       # resumo compacto, para um agente ler
npm run dmixer -- render <arquivo.yaml | uuid> [--out f.mp3|.wav] [--from s] [--to s] [--raw]
```

## Atalhos do editor

| Tecla | Ação |
|---|---|
| Espaço | toca / pausa |
| Home | volta ao início |
| Ctrl+S | salva |
| Ctrl+Z / Ctrl+Shift+Z | desfaz / refaz |
| roda do mouse, Ctrl+roda, pinça, + e − | zoom (centrado no cursor) |
| roda lateral ou Shift+roda | rola para os lados |
| Alt+roda | rola as trilhas para cima e para baixo |
| M | marcador no playhead |
| Delete | apaga o clipe, marcador ou ponto selecionado |
| **SNAP** (barra superior) | compasso, tempo ou desligado: o que você move ou solta cai na grade, e as bordas das peças, os marcadores e o playhead grudam quando estão perto |
| Alt ao arrastar | inverte o SNAP naquele arrasto |
| V / C | ferramenta Selecionar / Cortar (no Cortar, clicar num clipe divide ali; Esc volta) |
| S | divide no playhead: o clipe selecionado, os da trilha selecionada, ou todos sob o playhead |
| X | crossfade do clipe selecionado para o próximo da trilha, com a duração da barra de ferramentas |
| botão **A** da trilha | edita o envelope: duplo clique cria ponto, arrastar move, Alt+clique apaga |

**Importar áudio:** arraste um mp3/wav do computador para uma trilha de áudio, ou use "Importar áudio…" no menu da trilha (botão direito), que põe o clipe no playhead. O arquivo é copiado para `audio/`, ao lado do YAML (sem sobrescrever: um nome repetido ganha `-2`), e vira um asset com caminho relativo.

Arrastar um clipe para outra trilha muda a trilha dele. As bordas do clipe aparam o `in` e o `out`.

## A pasta

```
minha-mix/
  mix.yaml          uma mixagem (a pasta pode ter várias, escolhidas no topo)
  audio/, stems/    mídias, em qualquer profundidade
  cache/peaks/      formas de onda (descartável)
  renders/          saídas
  .snapshots/       cópias a cada gravação
```
