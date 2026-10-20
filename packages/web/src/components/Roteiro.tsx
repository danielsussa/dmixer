import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { criarFaixasDoRoteiro, FAIXAS_DO_ROTEIRO, formatTime, montarRoteiro, type ParagrafoNoRoteiro, type Roteiro as RoteiroT, type Transcricao } from '@dmixer/core'
import { go, loadTranscricoes, patch } from '../api'
import { engine } from '../audio'
import { useEditor } from '../store'
import { Logo } from './Bars'
import { cx, Icon, IconButton, Pill } from './ui'

/**
 * O roteiro da mixagem (/c/<id>/roteiro): o texto que a narração diz, dividido pelos capítulos (a faixa Capítulos) e
 * marcado pelos humores (a faixa Humor). Clicar numa palavra toca dali; a palavra que está tocando fica acesa.
 */
export function RoteiroPage() {
  const project = useEditor((s) => s.project)
  const resolved = useEditor((s) => s.resolved)
  const id = useEditor((s) => s.projectName)
  const playing = useEditor((s) => s.playing)
  const [textos, setTextos] = useState<Record<string, Transcricao | null> | null>(null)
  const [erro, setErro] = useState('')
  const [seguir, setSeguir] = useState(true)

  const srcs = useMemo(() => [...new Set((resolved?.tracks ?? []).filter((t) => t.type === 'audio' && !t.samplers).flatMap((t) => t.clips.map((c) => c.src)))].sort(), [resolved])
  const chave = srcs.join('\n')
  useEffect(() => {
    if (!srcs.length) return
    let vivo = true
    loadTranscricoes(srcs).then((t) => vivo && setTextos(t), (e) => vivo && setErro(String(e.message ?? e)))
    return () => { vivo = false }
  }, [chave])

  // sem áudio nenhum (roteiro ainda não gravado) não há o que pedir: só a faixa texto
  const prontos = srcs.length ? textos : {}
  const roteiro = useMemo(() => (resolved && prontos ? montarRoteiro(resolved, prontos) : null), [resolved, prontos])
  useEffect(() => { document.title = `Roteiro · ${project?.project.name ?? 'dmixer'}` }, [project?.project.name])

  if (!project || !resolved) return <div className="h-full grid place-items-center text-ink-400">carregando…</div>
  const faltam = criarFaixasDoRoteiro(project)
  const ausentes = FAIXAS_DO_ROTEIRO.filter((f) => !(project.lanes ?? []).some((l) => l.id === f.id)).map((f) => f.name)
  const voltar = () => go(`/c/${id}`)

  return (
    <div className="h-full flex flex-col bg-ink-950">
      <header className="h-[52px] shrink-0 flex items-center gap-2 px-3 bg-ink-900 border-b border-white/[0.05]">
        <Logo />
        <Pill className="px-3 gap-2 max-w-[340px] min-w-0">
          <span className="text-[13px] text-ink-100 font-medium truncate">{project.project.name}</span>
          <span className="text-[12px] text-ink-400">roteiro</span>
        </Pill>
        <button type="button" className="btn !h-9 flex items-center gap-1.5" onClick={voltar} title="voltar à timeline"><Icon.Tracks size={14} /> Timeline</button>
        <span className="flex-1" />
        <Pill className="px-1 gap-1">
          <IconButton title="Tocar / pausar (Espaço)" className="text-ink-100" onClick={() => (playing ? engine.stop() : void engine.play())}>
            {playing ? <Icon.Pause /> : <Icon.Play />}
          </IconButton>
          <Relogio />
        </Pill>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-300 px-2 select-none" title="rolar até a frase que está tocando">
          <input type="checkbox" checked={seguir} onChange={(e) => setSeguir(e.target.checked)} /> seguir
        </label>
      </header>

      {faltam.length > 0 && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-amber-300/10 border-b border-amber-300/20 text-[13px] text-amber-100">
          O roteiro lê três faixas de tags: <b>Capítulos</b>, <b>Humor</b> e <b>Texto</b> (a fala antes de gravada). Falta{ausentes.length > 1 ? 'm' : ''} {ausentes.join(' e ')}.
          <button type="button" className="btn !h-7" onClick={() => void patch(faltam, 'Faixas do roteiro')}>Criar as faixas</button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {roteiro && <Indice roteiro={roteiro} />}
        <main className="flex-1 min-w-0 overflow-y-auto" data-roteiro>
          <div className="max-w-[760px] mx-auto px-4 sm:px-8 py-8">
            {erro && <p className="text-red-300 text-[13px]">Não foi possível ler as falas: {erro}</p>}
            {!roteiro && !erro && <p className="text-ink-400">lendo as falas…</p>}
            {roteiro && <Texto roteiro={roteiro} seguir={seguir && playing} />}
          </div>
        </main>
      </div>
    </div>
  )
}

function Relogio() {
  const t = useEditor((s) => s.playhead)
  return <span className="font-mono text-[12.5px] text-ink-200 tabular w-[84px] text-center">{formatTime(t, 1)}</span>
}

const tocar = (t: number) => {
  useEditor.getState().setPlayhead(t)
  void engine.play(t)
}

function Indice({ roteiro }: { roteiro: RoteiroT }) {
  const humores = Object.entries(roteiro.humores).reduce<Record<string, string>>((m, [, h]) => ({ ...m, [h.label]: h.color }), {})
  return (
    <nav className="hidden lg:flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r border-white/[0.05] bg-ink-900 p-3 text-[13px]">
      <div className="px-2 pb-1 text-[11px] uppercase tracking-wider text-ink-400">Capítulos</div>
      {roteiro.capitulos.map((c) => (
        <a key={c.id ?? 'fora'} href={`#cap-${c.id ?? 'fora'}`} className="flex items-baseline gap-2 rounded-md px-2 py-1 text-ink-200 hover:bg-white/[0.05]"
          onClick={(e) => { e.preventDefault(); document.getElementById(`cap-${c.id ?? 'fora'}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>
          <span className="w-1.5 h-1.5 rounded-full shrink-0 translate-y-[-1px]" style={{ background: c.color ?? '#6e6e76' }} />
          <span className="flex-1 min-w-0 truncate">{c.label}</span>
          <span className="font-mono text-[11px] text-ink-400">{formatTime(c.paragrafos[0]?.start ?? c.start, 0)}</span>
        </a>
      ))}
      {Object.keys(humores).length > 0 && (
        <>
          <div className="px-2 pt-4 pb-1 text-[11px] uppercase tracking-wider text-ink-400">Humores</div>
          <div className="flex flex-wrap gap-1 px-2">
            {Object.entries(humores).map(([nome, cor]) => <Chip key={nome} cor={cor}>{nome}</Chip>)}
          </div>
        </>
      )}
    </nav>
  )
}

const Chip = ({ cor, children }: { cor: string; children: React.ReactNode }) => (
  <span className="inline-flex items-center h-[18px] px-1.5 rounded text-[11px] font-medium leading-none align-[2px]" style={{ background: cor, color: '#0b0b0c' }}>{children}</span>
)

/** A palavra que está tocando: [parágrafo, frase, palavra], só quando o playhead cai dentro de um parágrafo. */
function useAtiva(paragrafos: ParagrafoNoRoteiro[]) {
  return useEditor((s) => {
    const t = s.playhead
    const pi = paragrafos.findIndex((p) => t >= p.start && t < p.end + 0.3)
    if (pi < 0) return null
    const p = paragrafos[pi]
    let fi = p.frases.findIndex((f) => t < f.end + 0.3)
    if (fi < 0) fi = p.frases.length - 1
    const ws = p.frases[fi].palavras
    let wi = ws.findIndex((w) => t < w.end)
    if (wi < 0) wi = ws.length - 1
    return `${pi}:${fi}:${t >= ws[wi].start - 0.05 ? wi : -1}`
  })
}

function Texto({ roteiro, seguir }: { roteiro: RoteiroT; seguir: boolean }) {
  const paragrafos = useMemo(() => roteiro.capitulos.flatMap((c) => c.paragrafos), [roteiro])
  const ativa = useAtiva(paragrafos)
  const [pi, fi, wi] = ativa ? ativa.split(':').map(Number) : [-1, -1, -1]
  const fraseRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (seguir) fraseRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [seguir, pi, fi])

  if (!paragrafos.length && !roteiro.semTexto.length) {
    return <p className="text-ink-400 text-[14px] leading-relaxed">Nenhuma fala com texto. Antes da gravação, o texto mora nas tags da faixa <b>Texto</b> (campo <code>text</code>); depois, no <code>palavras.json</code> ao lado de cada voz (<code>s0.voice.mp3</code> → <code>s0.palavras.json</code>).</p>
  }
  let n = 0
  return (
    <article className="flex flex-col gap-10">
      {roteiro.capitulos.map((c) => {
        // os humores do capítulo, na ordem em que aparecem, sem repetir o nome
        const humores = [...new Map(c.paragrafos.flatMap((p) => p.frases.flatMap((f) => f.palavras.map((w) => w.humor)))
          .filter((h): h is string => !!h).map((h) => [roteiro.humores[h].label, h])).values()]
        return (
          <section key={c.id ?? 'fora'} id={`cap-${c.id ?? 'fora'}`} className="scroll-mt-6">
            <header className="mb-4 pb-2 border-b border-white/[0.06]">
              <div className="flex items-baseline gap-3">
                <span className="w-1 self-stretch rounded" style={{ background: c.color ?? '#4a4a50' }} />
                <h2 className="flex-1 text-[22px] font-semibold text-ink-100 cursor-pointer hover:text-white" title="tocar daqui" onClick={() => tocar(c.paragrafos[0]?.start ?? c.start)}>{c.label}</h2>
                <span className="font-mono text-[12px] text-ink-400">{formatTime(c.start, 0)}–{formatTime(c.end, 0)}</span>
              </div>
              {humores.length > 0 && <div className="flex flex-wrap gap-1 mt-2 ml-4">{humores.map((h) => <Chip key={h} cor={roteiro.humores[h].color}>{roteiro.humores[h].label}</Chip>)}</div>}
            </header>
            {!c.paragrafos.length && <p className="text-ink-500 text-[14px] italic">sem fala neste capítulo</p>}
            <div className="flex flex-col gap-4">
              {c.paragrafos.map((p) => {
                const i = n++
                return <Paragrafo key={`${p.trackId}/${p.clipId}`} p={p} humores={roteiro.humores} ativa={i === pi ? [fi, wi] : null}
                  fraseRef={i === pi ? fraseRef : undefined} anterior={paragrafos[i - 1]} />
              })}
            </div>
          </section>
        )
      })}
      {roteiro.semTexto.length > 0 && (
        <p className="text-[12px] text-ink-400">
          {roteiro.semTexto.length} clipe(s) de fala sem <code>palavras.json</code> ao lado: {roteiro.semTexto.map((s) => `${s.clipId} (${formatTime(s.start, 0)})`).join(', ')}.
        </p>
      )}
    </article>
  )
}

const Paragrafo = memo(function Paragrafo({ p, humores, ativa, fraseRef, anterior }: {
  p: ParagrafoNoRoteiro
  humores: RoteiroT['humores']
  ativa: [number, number] | null
  fraseRef?: React.MutableRefObject<HTMLElement | null>
  anterior?: ParagrafoNoRoteiro
}) {
  // o humor da última palavra do parágrafo anterior: o chip só aparece quando o humor muda
  const ultimo = anterior?.frases.at(-1)?.palavras.at(-1)?.humor
  let humor = ultimo
  return (
    <div className="group grid grid-cols-[52px_1fr] gap-3">
      <button type="button" className="self-start text-right font-mono text-[11px] text-ink-500 group-hover:text-ink-300 pt-[7px]"
        title={p.estimado ? `ainda não gravado: tempo estimado pela leitura · tag @${p.clipId}` : `tocar daqui · clipe ${p.clipId}`} onClick={() => tocar(p.start)}>
        {p.estimado ? '~' : ''}{formatTime(p.start, 0)}
      </button>
      <p className={cx('text-[17px] leading-[1.75]', p.estimado ? 'text-ink-300 border-l-2 border-dashed border-white/[0.12] pl-3 -ml-[14px]' : 'text-ink-200')}>
        {p.frases.map((f, fi) => {
          const acesa = ativa?.[0] === fi
          return (
            <span key={fi} ref={acesa ? (el) => { if (fraseRef) fraseRef.current = el } : undefined} className={cx(acesa && 'text-ink-100')}>
              {f.palavras.map((w, wi) => {
                const muda = w.humor !== humor
                humor = w.humor
                const h = w.humor ? humores[w.humor] : undefined
                return (
                  <span key={wi}>
                    {muda && h && <><Chip cor={h.color}>{h.label}</Chip>{' '}</>}
                    {/* o sublinhado do humor pega a palavra e o espaço depois dela: um traço contínuo */}
                    <span style={h ? { boxShadow: `inset 0 -2px 0 ${h.color}88` } : undefined}>
                      <span onClick={() => tocar(w.start)} title={formatTime(w.start, 2)}
                        className={cx('cursor-pointer rounded-sm hover:bg-white/[0.08]', acesa && ativa?.[1] === wi && 'bg-white/[0.16] text-white')}>{w.texto}</span>{' '}
                    </span>
                  </span>
                )
              })}
            </span>
          )
        })}
      </p>
    </div>
  )
}, (a, b) => a.p === b.p && a.humores === b.humores && a.anterior === b.anterior && a.ativa?.[0] === b.ativa?.[0] && a.ativa?.[1] === b.ativa?.[1])
