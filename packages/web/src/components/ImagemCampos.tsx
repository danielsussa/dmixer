import { round, type Animatable, type Clip, type ResolvedClip, type VisualEffect } from '@dmixer/core'
import { Num, Row, Text } from './Inspector'

/**
 * Os campos de um clipe de trilha de vídeo: duração, o movimento (zoom e deslocamento do começo ao fim do clipe, o
 * Ken Burns), a cor, as transições e, numa página html, os params dela (o texto do título).
 */
export function ImagemCampos({ c, rc, set }: { c: Clip; rc: ResolvedClip; set: (k: string, v: unknown) => void }) {
  const dur = rc.duration
  const tr = c.transform ?? {}
  const mover = (k: 'scale' | 'x' | 'y', ponta: 0 | 1, v: number) => {
    const [a, b] = pontas(tr[k], k === 'scale' ? 1 : 0, dur)
    const [na, nb] = ponta === 0 ? [v, b] : [a, v]
    const neutro = k === 'scale' ? 1 : 0
    const valor: Animatable | undefined = na === nb ? (na === neutro ? undefined : na) : { keyframes: [{ at: 0, value: na }, { at: round(dur), value: nb }] }
    const novo = { ...tr, [k]: valor }
    if (valor === undefined) delete novo[k]
    set('transform', Object.keys(novo).length ? novo : undefined)
  }
  const efeitos = c.effects ?? []
  const mudaEfeito = (i: number, k: string, v: number | undefined) => {
    const lista = efeitos.map((e, j) => (j === i ? { ...e, [k]: v } : e))
    set('effects', lista)
  }
  const cor = efeitos.findIndex((e) => e.type === 'color')
  const grao = efeitos.findIndex((e) => e.type === 'grain')
  return (
    <>
      <Row label="duração (s)">
        <Num value={round(dur)} onCommit={(v) => (c.duration !== undefined || c.out === undefined ? set('duration', v) : set('out', round((c.in ?? 0) + v)))} />
      </Row>
      {rc.kind === 'video' && <Row label="in (s)"><Num value={c.in ?? 0} onCommit={(v) => set('in', v)} /></Row>}
      {rc.kind === 'color' && <Row label="cor"><Text value={c.fill ?? '#000000'} onCommit={(v) => set('fill', v || undefined)} /></Row>}
      {rc.kind === 'html' && Object.entries(c.params ?? {}).map(([k, v]) => (
        <Row key={k} label={k}>
          <Text value={String(v)} onCommit={(s) => set('params', { ...c.params, [k]: typeof v === 'number' && Number.isFinite(Number(s)) ? Number(s) : s })} />
        </Row>
      ))}
      {(rc.kind === 'image' || rc.kind === 'video') && (<>
        <div className="text-[11px] text-ink-400 pt-1">movimento, do começo ao fim do clipe</div>
        <Row label="zoom"><Pares pares={pontas(tr.scale, 1, dur)} onCommit={(p, v) => mover('scale', p, v)} /></Row>
        <Row label="x (px)"><Pares pares={pontas(tr.x, 0, dur)} onCommit={(p, v) => mover('x', p, v)} /></Row>
        <Row label="y (px)"><Pares pares={pontas(tr.y, 0, dur)} onCommit={(p, v) => mover('y', p, v)} /></Row>
      </>)}
      {rc.kind !== 'adjustment' && (<>
        <Row label="entrada (s)"><Num value={c.transition?.duration ?? 0} onCommit={(v) => set('transition', v > 0 ? { type: 'fade', duration: v } : undefined)} /></Row>
        <Row label="saída (s)"><Num value={c.transition_out?.duration ?? 0} onCommit={(v) => set('transition_out', v > 0 ? { type: 'fade', duration: v } : undefined)} /></Row>
      </>)}
      {rc.kind !== 'html' && (<>
        <div className="text-[11px] text-ink-400 pt-1">cor{rc.kind === 'adjustment' ? ' (vale para tudo abaixo)' : ''}</div>
        {cor < 0
          ? <button className="text-[12px] text-ink-300 hover:text-white text-left" onClick={() => set('effects', [...efeitos, { type: 'color' } as VisualEffect])}>＋ correção de cor</button>
          : COR.map(([k, rotulo, neutro]) => (
            <Row key={k} label={rotulo}>
              <Num value={(efeitos[cor] as unknown as Record<string, number | undefined>)[k] ?? neutro} onCommit={(v) => mudaEfeito(cor, k, v === neutro ? undefined : v)} />
            </Row>
          ))}
        {grao >= 0 && <Row label="grão"><Num value={efeitos[grao].amount ?? 25} onCommit={(v) => mudaEfeito(grao, 'amount', v)} /></Row>}
      </>)}
    </>
  )
}

const COR: [string, string, number][] = [
  ['exposure', 'exposição', 0], ['contrast', 'contraste', 1], ['saturation', 'saturação', 1],
  ['gamma', 'gama', 1], ['temperature', 'temperatura K', 6500],
]

/** O valor no começo e no fim do clipe. */
function pontas(v: Animatable | undefined, neutro: number, dur: number): [number, number] {
  if (v === undefined) return [neutro, neutro]
  if (typeof v === 'number') return [v, v]
  const k = [...v.keyframes].sort((a, b) => a.at - b.at)
  const em = (t: number) => (t <= k[0].at ? k[0].value : t >= k[k.length - 1].at ? k[k.length - 1].value : k[0].value)
  return [round(em(0), 4), round(em(dur), 4)]
}

function Pares({ pares, onCommit }: { pares: [number, number]; onCommit: (ponta: 0 | 1, v: number) => void }) {
  return (
    <div className="flex gap-1.5 items-center w-full">
      <Num value={pares[0]} onCommit={(v) => onCommit(0, v)} />
      <span className="text-ink-500">→</span>
      <Num value={pares[1]} onCommit={(v) => onCommit(1, v)} />
    </div>
  )
}
