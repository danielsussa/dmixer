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

Uma trilha `type: video` guarda a imagem. Os clipes dela usam os mesmos campos dos de áudio (`start`, `in`, `out`, ancoragem em marcadores e tags) e aparecem na timeline com miniaturas.
- **Visor:** à direita, mostra o quadro do playhead e acompanha a mixagem ao tocar, pausar ou arrastar o playhead.
- **Render mp4:** monta a imagem com a mixagem como som. As trilhas de vídeo mais acima na lista ficam por cima, e cada clipe é ajustado ao quadro de `project.video`.
- **Som do vídeo:** a trilha de vídeo não faz som. Para ouvir o som original, ponha o mesmo arquivo numa trilha de áudio.

```yaml
project:
  video: { width: 1920, height: 1080, fps: 30 }
assets:
  edicao: { src: "@video/renders/edicao.mp4" }
tracks:
  - id: imagem
    type: video
    clips: [{ id: corte-1, asset: edicao, start: 0 }]
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
