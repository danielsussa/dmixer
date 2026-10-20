import type { PatchOp } from './patch.js'
import type { ResolvedProject } from './resolve.js'
import type { Project } from './schema.js'

/**
 * O roteiro: o texto que a narração diz, na ordem da mixagem, dividido pelos capítulos e marcado pelos humores.
 * Capítulos, humor e texto são faixas de tags com id fixo — é por elas que o roteiro sabe onde cada coisa começa.
 * Antes da gravação, a fala mora na faixa `texto` (uma tag por bloco, com `text`, no tempo estimado pela leitura);
 * depois, vale o que foi gravado (o `palavras.json` ao lado de cada voz).
 */
export const FAIXA_CAPITULOS = 'capitulos'
export const FAIXA_HUMOR = 'humor'
export const FAIXA_TEXTO = 'texto'
export const FAIXAS_DO_ROTEIRO = [
  { id: FAIXA_CAPITULOS, name: 'Capítulos' },
  { id: FAIXA_HUMOR, name: 'Humor' },
  { id: FAIXA_TEXTO, name: 'Texto' },
]

/** palavras por segundo de uma narração de vídeo (a do decidiu dá ~2,6) */
export const LEITURA = 2.5

/** Quanto um texto leva para ser lido: as palavras no ritmo de LEITURA, mais um respiro por frase. */
export function duracaoDaLeitura(texto: string): number {
  const palavras = texto.split(/\s+/).filter(Boolean).length
  const frases = (texto.match(/[.!?…]+(\s|$)/g) ?? []).length
  return Math.max(1, Math.round((palavras / LEITURA + 0.35 * frases) * 10) / 10)
}

/** Os humores de sempre, cada um com a sua cor (a mesma em todas as mixagens). Outro nome também vale. */
export const HUMORES = [
  { nome: 'leve', cor: '#8fd16a' },
  { nome: 'energia', cor: '#ff8a3d' },
  { nome: 'agressivo', cor: '#e0312b' },
  { nome: 'relaxado', cor: '#2bb3c9' },
  { nome: 'triste', cor: '#4f7cff' },
  { nome: 'feliz', cor: '#3fb68b' },
  { nome: 'tenso', cor: '#c9a227' },
  { nome: 'dançante', cor: '#a77bca' },
  { nome: 'festa', cor: '#e07a9b' },
  { nome: 'valência', cor: '#f2b705' },
]

export function corDoHumor(nome: string | undefined): string | undefined {
  const n = nome?.trim().toLowerCase()
  return HUMORES.find((h) => h.nome === n)?.cor
}

/** As operações que criam as faixas Capítulos e Humor que faltam, sem mexer nas outras. */
export function criarFaixasDoRoteiro(project: Project): PatchOp[] {
  const atuais = project.lanes ?? []
  const faltam = FAIXAS_DO_ROTEIRO.filter((f) => !atuais.some((l) => l.id === f.id))
  if (!faltam.length) return []
  return [{ op: project.lanes ? 'replace' : 'add', path: '/lanes', value: [...faltam, ...atuais] }]
}

/** O que o pipeline de voz grava ao lado de cada fala (`s0.palavras.json`): tempos em segundos do arquivo. */
export interface Transcricao {
  palavras: [number, number, string][]
  frases?: [number, number, string][]
}

export interface PalavraNoRoteiro { start: number; end: number; texto: string; humor?: string }
export interface FraseNoRoteiro { start: number; end: number; palavras: PalavraNoRoteiro[] }
/** um clipe de fala (ou, antes da gravação, uma tag da faixa texto, `estimado`): o parágrafo */
export interface ParagrafoNoRoteiro { trackId: string; clipId: string; start: number; end: number; frases: FraseNoRoteiro[]; estimado?: boolean }
export interface CapituloNoRoteiro { id: string | null; label: string; color?: string; start: number; end: number; paragrafos: ParagrafoNoRoteiro[] }

export interface Roteiro {
  capitulos: CapituloNoRoteiro[]
  /** as tags da faixa Humor, por id (cor, rótulo, onde) */
  humores: Record<string, { label: string; color: string; start: number; end: number }>
  /** clipes de fala sem transcrição ao lado */
  semTexto: { trackId: string; clipId: string; start: number; end: number }[]
}

/**
 * Monta o roteiro do que a mixagem toca de fato: só as palavras dentro do trecho de cada clipe (um corte some do
 * texto), no tempo da timeline. `transcricoes` vem por src; null é um clipe de fala sem transcrição.
 */
export function montarRoteiro(r: ResolvedProject, transcricoes: Record<string, Transcricao | null | undefined>): Roteiro {
  const humorTags = r.regions.filter((g) => g.lane === FAIXA_HUMOR).sort((a, b) => a.start - b.start)
  const humorEm = (t: number) => humorTags.find((g) => t >= g.start && t < g.end)?.id
  const paragrafos: ParagrafoNoRoteiro[] = []
  const semTexto: Roteiro['semTexto'] = []
  for (const t of r.tracks) {
    if (t.type !== 'audio' || t.samplers || t.muted) continue
    // uma trilha de fala: tem alguma transcrição, ou o nome diz (música e efeitos não entram nem como "sem texto")
    if (!t.clips.some((c) => transcricoes[c.src]) && !/narra|voz|fala|locu|voice/i.test(`${t.id} ${t.name}`)) continue
    for (const c of t.clips) {
      if (c.muted) continue
      const tr = transcricoes[c.src]
      if (!tr) {
        semTexto.push({ trackId: t.id, clipId: c.id, start: c.start, end: c.end })
        continue
      }
      // uma palavra fica se o meio dela está dentro do trecho que o clipe toca
      const naMix = (a: number, b: number) => (a + b) / 2 >= c.in && (a + b) / 2 < c.out
      const mix = (s: number) => c.start + (s - c.in)
      const palavra = ([a, b, texto]: [number, number, string]): PalavraNoRoteiro => {
        const p: PalavraNoRoteiro = { start: mix(a), end: mix(b), texto }
        const h = humorEm(p.start)
        if (h) p.humor = h
        return p
      }
      const dentro = tr.palavras.filter(([a, b]) => naMix(a, b))
      if (!dentro.length) continue
      const frases: FraseNoRoteiro[] = []
      const limites = tr.frases?.length ? tr.frases : porPontuacao(tr.palavras)
      let i = 0
      for (const [, fim] of limites) {
        const ps: PalavraNoRoteiro[] = []
        while (i < dentro.length && dentro[i][0] < fim - 1e-6) ps.push(palavra(dentro[i++]))
        if (ps.length) frases.push({ start: ps[0].start, end: ps[ps.length - 1].end, palavras: ps })
      }
      if (i < dentro.length) {
        const ps = dentro.slice(i).map(palavra)
        frases.push({ start: ps[0].start, end: ps[ps.length - 1].end, palavras: ps })
      }
      paragrafos.push({ trackId: t.id, clipId: c.id, start: frases[0].start, end: frases[frases.length - 1].end, frases })
    }
  }
  // o texto ainda não gravado: as tags da faixa texto que nenhuma fala gravada cobre. Sem áudio não há tempo de
  // palavra; cada uma ganha um pedaço da tag proporcional ao tamanho dela
  const gravados = [...paragrafos]
  for (const g of r.regions) {
    const texto = g.lane === FAIXA_TEXTO ? g.raw.text?.trim() : undefined
    if (!texto || gravados.some((p) => p.start < g.end && p.end > g.start)) continue
    const ws = texto.split(/\s+/)
    const peso = ws.reduce((n, w) => n + w.length + 1, 0)
    let t = g.start
    const triplas = ws.map((w): [number, number, string] => {
      const d = ((w.length + 1) / peso) * (g.end - g.start)
      return [t, (t += d), w]
    })
    const frases = porPontuacao(triplas).map(([, fim]) => fim)
    const out: FraseNoRoteiro[] = []
    let i = 0
    for (const fim of frases) {
      const ps: PalavraNoRoteiro[] = []
      while (i < triplas.length && triplas[i][0] < fim - 1e-6) {
        const [a, b, w] = triplas[i++]
        ps.push({ start: a, end: b, texto: w })
      }
      if (!ps.length) continue
      // o tempo é estimado: o humor vale pela frase inteira (pelo meio dela), não troca no meio de uma palavra qualquer
      const h = humorEm((ps[0].start + ps[ps.length - 1].end) / 2)
      if (h) for (const p of ps) p.humor = h
      out.push({ start: ps[0].start, end: ps[ps.length - 1].end, palavras: ps })
    }
    paragrafos.push({ trackId: FAIXA_TEXTO, clipId: g.id, start: g.start, end: g.end, frases: out, estimado: true })
  }
  paragrafos.sort((a, b) => a.start - b.start)

  const caps = r.regions.filter((g) => g.lane === FAIXA_CAPITULOS).sort((a, b) => a.start - b.start)
  const capitulos: CapituloNoRoteiro[] = caps.map((g) => ({ id: g.id, label: g.label, color: g.color, start: g.start, end: g.end, paragrafos: [] }))
  const fora: CapituloNoRoteiro = { id: null, label: caps.length ? 'Fora dos capítulos' : 'Roteiro', start: 0, end: r.duration, paragrafos: [] }
  for (const p of paragrafos) {
    // o capítulo onde o parágrafo começa (com uma folga de meio segundo antes do início da tag)
    const cap = [...capitulos].reverse().find((k) => p.start >= k.start - 0.5 && p.start < k.end)
    ;(cap ?? fora).paragrafos.push(p)
  }
  const todos = fora.paragrafos.length ? [...capitulos, fora].sort((a, b) => (a.paragrafos[0]?.start ?? a.start) - (b.paragrafos[0]?.start ?? b.start)) : capitulos
  const humores = Object.fromEntries(humorTags.map((g) => [g.id, { label: g.label, color: g.color, start: g.start, end: g.end }]))
  return { capitulos: todos, humores, semTexto }
}

/** frases pelo ponto final, quando a transcrição não as traz */
function porPontuacao(palavras: [number, number, string][]): [number, number, string][] {
  const out: [number, number, string][] = []
  let ini = palavras[0]?.[0] ?? 0
  for (const [a, b, w] of palavras) {
    if (!out.length && a < ini) ini = a
    if (/[.!?…]["”»)]?$/.test(w)) {
      out.push([ini, b, ''])
      ini = b
    }
  }
  if (palavras.length) out.push([ini, palavras[palavras.length - 1][1] + 1, ''])
  return out
}
