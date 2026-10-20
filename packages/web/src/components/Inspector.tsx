import { useEffect, useRef, useState } from 'react'
import { CORES_FUNCAO, duracaoDaLeitura, FAIXA_HUMOR, FAIXA_TEXTO, HUMORES, LEITURA, CURVAS, curvaOriginal, formatTime, remontar, type Effect, type EffectType, type Molde, type Remontagem } from '@dmixer/core'
import { acervoProntas, hasAnalysis, loadAcervo, loadAnalysis, loadPieces, P, patch, type AcervoAnalysis, type Analysis, type PecasResposta } from '../api'
import { engine, type Preview } from '../audio'
import { cx } from './ui'
import { aplicarRemontagem, encaixarEmendas, removeStretch, repeatStretch, separarPecas, trechoDaMusica } from '../tools'
import { useEditor } from '../store'
import { ImagemCampos } from './ImagemCampos'
import { alinharComTag, baseChords, cobrirEmenda, descobrirEmenda, emendaDe, libraryItemsById, loadLibraries, refitComplement, setBaseChord } from './Library'

/** Edits whatever is selected. Every field commits on Enter or blur, as one undo step. */
export function Inspector() {
  const sel = useEditor((s) => s.selection)
  const project = useEditor((s) => s.project)
  const resolved = useEditor((s) => s.resolved)
  if (!project || !resolved) return null

  let body: React.ReactNode = <Empty />
  if (sel?.kind === 'clip') {
    const t = project.tracks.find((x) => x.id === sel.trackId)
    const c = t?.clips?.find((x) => x.id === sel.clipId)
    const rc = resolved.tracks.find((x) => x.id === sel.trackId)?.clips.find((x) => x.id === sel.clipId)
    if (t && c && rc) {
      const base = P.clip(t.id, c.id)
      const set = (k: string, v: unknown) => patch([{ op: v === undefined ? 'remove' : (k in c ? 'replace' : 'add'), path: `${base}/${k}`, ...(v === undefined ? {} : { value: v }) } as never], `${k} of ${c.id}`)
      body = (
        <Section title={`Clipe · ${c.id}`}>
          <Row label="asset"><span className="truncate text-[var(--muted)]" title={project.assets[c.asset ?? '']?.src}>{c.asset}</span></Row>
          <Row label="início"><Text value={String(c.start)} onCommit={(v) => set('start', timeOrNumber(v))} /></Row>
          <Row label=""><span className="num text-[var(--muted)]">{formatTime(rc.start, 2)} → {formatTime(rc.end, 2)} ({rc.duration.toFixed(2)} s)</span></Row>
          {t.type === 'video' ? <ImagemCampos c={c} rc={rc} set={set} /> : project.assets[c.asset ?? '']?.body !== undefined ? (
            <div className="rounded-lg bg-ink-850 border border-white/[0.05] p-2.5 text-[11.5px] text-ink-400 leading-snug space-y-1">
              <div><b className="text-ink-200">{c.label ?? c.id}</b></div>
              <div>Peça da biblioteca: tamanho e conteúdo fixos, como um bloco de lego. Dá para mover, mutar e apagar; o volume se ajusta na trilha ou no envelope.</div>
              <Emenda trackId={sel.trackId} clipId={c.id} />
            </div>
          ) : (<>
          <Row label="in (s)"><Num value={c.in ?? 0} onCommit={(v) => set('in', v)} /></Row>
          <Row label="out (s)"><Num value={c.out ?? rc.out} onCommit={(v) => set('out', v)} /></Row>
          <Row label="ganho dB"><Num value={c.gain ?? 0} onCommit={(v) => set('gain', v === 0 ? undefined : v)} /></Row>
          <Row label="fade in"><Num value={c.fade_in ?? 0.005} onCommit={(v) => set('fade_in', v)} /></Row>
          <Row label="fade out"><Num value={c.fade_out ?? 0.005} onCommit={(v) => set('fade_out', v)} /></Row>
          <Row label="rótulo"><Text value={c.label ?? ''} onCommit={(v) => set('label', v || undefined)} /></Row>
          {t.type !== 'bus' && <PecasDoAcervo src={rc.src} start={rc.start} from={rc.in} to={rc.out} onSeparar={() => void separarPecas(t.id, c.id)} />}
          {t.type !== 'bus' && <CutPoints trackId={t.id} clipId={c.id} />}
          {t.type !== 'bus' && project.assets[c.asset ?? '']?.body === undefined && <Remontar trackId={t.id} clipId={c.id} />}
          </>)}
          <Row label="nota"><Text value={c.note ?? ''} onCommit={(v) => set('note', v || undefined)} /></Row>
          <Row label="mudo"><input type="checkbox" checked={!!c.muted} onChange={(e) => set('muted', e.target.checked || undefined)} /></Row>
          <ComplementRefit trackId={t.id} clipId={c.id} asset={c.asset ?? ''} />
          <div className="pt-2">
            <button className="btn" onClick={() => patch([{ op: 'remove', path: base }], `Delete ${c.id}`)}>Apagar clipe</button>
          </div>
        </Section>
      )
    }
  } else if (sel?.kind === 'track') {
    const t = project.tracks.find((x) => x.id === sel.trackId)
    if (t) {
      const base = P.track(t.id)
      const set = (k: string, v: unknown) => patch([{ op: v === undefined ? 'remove' : (k in t ? 'replace' : 'add'), path: `${base}/${k}`, ...(v === undefined ? {} : { value: v }) } as never], `${k} of ${t.id}`)
      const buses = project.tracks.filter((x) => x.type === 'bus' && x.id !== t.id)
      body = (
        <>
          <Section title={`${t.type === 'bus' ? 'Bus' : 'Trilha'} · ${t.id}`}>
            <Row label="nome"><Text value={t.name ?? ''} onCommit={(v) => set('name', v || undefined)} /></Row>
            <Row label="cor"><input type="color" value={t.color ?? '#5b8def'} onChange={(e) => set('color', e.target.value)} /></Row>
            <Row label="volume dB"><Num value={t.volume ?? 0} onCommit={(v) => set('volume', v)} /></Row>
            <Row label="pan"><Num value={t.pan ?? 0} onCommit={(v) => set('pan', Math.max(-1, Math.min(1, v)))} /></Row>
            <Row label="saída">
              <select className="field" value={t.output ?? ''} onChange={(e) => set('output', e.target.value || undefined)}>
                <option value="">master</option>
                {buses.map((b) => <option key={b.id} value={b.id}>{b.name ?? b.id}</option>)}
              </select>
            </Row>
            <Row label="nota"><Text value={t.note ?? ''} onCommit={(v) => set('note', v || undefined)} /></Row>
          </Section>
          <Effects effects={t.effects ?? []} base={base} tracks={project.tracks.map((x) => x.id).filter((id) => id !== t.id)} />
        </>
      )
    }
  } else if (sel?.kind === 'marker') {
    const m = project.markers?.find((x) => x.id === sel.markerId)
    if (m) {
      const base = P.marker(m.id)
      const at = resolved.markers.find((x) => x.id === m.id)?.at ?? 0
      body = (
        <Section title={`Marcador · @${m.id}`}>
          <Row label="tempo"><Text value={String(m.at)} onCommit={(v) => patch([{ op: 'replace', path: `${base}/at`, value: timeOrNumber(v) }], `Marker ${m.id}`)} /></Row>
          <Row label=""><span className="num text-[var(--muted)]">{formatTime(at, 2)}</span></Row>
          <Row label="rótulo"><Text value={m.label ?? ''} onCommit={(v) => patch([{ op: m.label === undefined ? 'add' : 'replace', path: `${base}/label`, value: v }], `Marker ${m.id}`)} /></Row>
          <div className="pt-2"><button className="btn" onClick={() => patch([{ op: 'remove', path: base }], `Delete marker ${m.id}`)}>Apagar marcador</button></div>
        </Section>
      )
    }
  } else if (sel?.kind === 'region') {
    const g = project.regions?.find((x) => x.id === sel.regionId)
    const rg = resolved.regions.find((x) => x.id === sel.regionId)
    if (g && rg) {
      const base = P.region(g.id)
      const set = (k: string, v: unknown) => patch([{ op: v === undefined ? 'remove' : (k in g ? 'replace' : 'add'), path: `${base}/${k}`, ...(v === undefined ? {} : { value: v }) } as never], `Tag ${g.id} ${k}`)
      body = (
        <Section title={`Tag · @${g.id}`}>
          <Row label="rótulo"><Text value={g.label ?? ''} onCommit={(v) => set('label', v || undefined)} /></Row>
          {rg.lane === FAIXA_TEXTO && (
            <Row label="fala">
              <div className="flex flex-col gap-1 w-full">
                <TextoLongo value={g.text ?? ''} onCommit={(v) => set('text', v.trim() ? v : undefined)} />
                {!!g.text?.trim() && (
                  <button type="button" className="btn !h-7 self-start" title={`${LEITURA} palavras/s, mais um respiro por frase`}
                    onClick={() => set('end', Math.round((rg.start + duracaoDaLeitura(g.text!)) * 1000) / 1000)}>
                    duração pela leitura: {duracaoDaLeitura(g.text)} s
                  </button>
                )}
              </div>
            </Row>
          )}
          {rg.lane === FAIXA_HUMOR && (
            <Row label="humor">
              <div className="flex flex-wrap gap-1">
                {HUMORES.map((h) => (
                  <button key={h.nome} type="button" title={`rótulo "${h.nome}", cor da paleta`}
                    className={cx('h-[20px] px-1.5 rounded text-[11px] font-medium', rg.label === h.nome ? 'ring-2 ring-white/70' : 'opacity-80 hover:opacity-100')}
                    style={{ background: h.cor, color: '#0b0b0c' }}
                    onClick={() => patch([
                      { op: 'label' in g ? 'replace' : 'add', path: `${base}/label`, value: h.nome },
                      ...('color' in g ? [{ op: 'remove' as const, path: `${base}/color` }] : []),
                    ], `Humor ${g.id}: ${h.nome}`)}>{h.nome}</button>
                ))}
              </div>
            </Row>
          )}
          <Row label="início"><Text value={String(g.start)} onCommit={(v) => set('start', timeOrNumber(v))} /></Row>
          <Row label="fim"><Text value={String(g.end)} onCommit={(v) => set('end', timeOrNumber(v))} /></Row>
          <Row label=""><span className="num text-[var(--muted)]">{formatTime(rg.start, 2)} → {formatTime(rg.end, 2)} ({(rg.end - rg.start).toFixed(2)} s)</span></Row>
          <Row label="faixa">
            <select className="field" value={rg.lane} onChange={(e) => set('lane', e.target.value)}>
              {resolved.lanes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Row>
          <Row label="cor"><input type="color" value={rg.color} onChange={(e) => set('color', e.target.value)} /></Row>
          <Row label="nota"><Text value={g.note ?? ''} onCommit={(v) => set('note', v || undefined)} /></Row>
          <div className="text-[11px] text-[var(--muted)] pt-1">Ancore clipes nela: <code>@{g.id}</code> (início) e <code>@{g.id}.end</code> (fim).</div>
          <Alinhar alvo={rg.start} rotulo={g.label ?? g.id} />
          <div className="pt-2"><button className="btn" onClick={() => patch([{ op: 'remove', path: base }], `Delete tag ${g.id}`)}>Apagar tag</button></div>
        </Section>
      )
    }
  } else if (sel?.kind === 'lane') {
    const lanes: { id: string; name?: string; color?: string }[] = project.lanes ?? resolved.lanes.map((l) => ({ id: l.id, name: l.name }))
    const l = lanes.find((x) => x.id === sel.laneId)
    if (l) {
      const write = (next: typeof lanes, label: string) => patch([{ op: project.lanes ? 'replace' : 'add', path: '/lanes', value: next }], label)
      const i = lanes.indexOf(l)
      const count = resolved.regions.filter((g) => g.lane === l.id).length
      body = (
        <Section title={`Faixa de tags · ${l.id}`}>
          <Row label="nome"><Text value={l.name ?? ''} onCommit={(v) => write(lanes.map((x) => (x.id === l.id ? { ...x, name: v } : x)), 'Rename lane')} /></Row>
          <Row label="cor"><input type="color" value={l.color ?? '#6a9bcc'} onChange={(e) => write(lanes.map((x) => (x.id === l.id ? { ...x, color: e.target.value } : x)), 'Lane color')} /></Row>
          <div className="flex gap-2 pt-2">
            <button className="btn" disabled={i === 0} onClick={() => { const n = [...lanes]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; void write(n, 'Move lane') }}>subir</button>
            <button className="btn" disabled={count > 0} title={count ? 'apague ou mova as tags antes' : ''} onClick={() => write(lanes.filter((x) => x.id !== l.id), 'Delete lane')}>apagar faixa</button>
          </div>
          <div className="text-[11px] text-[var(--muted)]">{count} tag(s). Duplo clique na faixa cria uma tag.</div>
        </Section>
      )
    }
  } else if (sel?.kind === 'point') {
    const t = resolved.tracks.find((x) => x.id === sel.trackId)
    const p = t?.envelope[sel.index]
    if (t && p) {
      const path = `${P.track(t.id)}/automation/volume/${p.index}`
      body = (
        <Section title={`Ponto do envelope · ${t.name}`}>
          <Row label="tempo"><Text value={String(t.raw.automation?.volume?.[p.index]?.at ?? p.at)} onCommit={(v) => patch([{ op: 'replace', path: `${path}/at`, value: timeOrNumber(v) }], 'Envelope point')} /></Row>
          <Row label="dB"><Num value={p.db} onCommit={(v) => patch([{ op: 'replace', path: `${path}/db`, value: v }], 'Envelope point')} /></Row>
          <Row label="curva">
            <select className="field" value={p.curve} onChange={(e) => patch([{ op: 'replace', path: `${path}/curve`, value: e.target.value }], 'Envelope point')}>
              <option value="linear">linear</option><option value="hold">degrau</option>
            </select>
          </Row>
          <div className="pt-2"><button className="btn" onClick={() => patch([{ op: 'remove', path }], 'Delete envelope point')}>Apagar ponto</button></div>
        </Section>
      )
    }
  } else if (sel?.kind === 'master') {
    const m = project.master ?? {}
    const set = (k: string, v: unknown) => patch([{ op: 'replace', path: `/master`, value: { ...m, [k]: v } }], `Master ${k}`)
    body = (
      <>
        <Section title="Master">
          <Row label="volume dB"><Num value={m.volume ?? 0} onCommit={(v) => set('volume', v)} /></Row>
          <Row label="LUFS alvo"><Num value={m.loudness?.target ?? -14} onCommit={(v) => set('loudness', { ...(m.loudness ?? {}), target: v })} /></Row>
          <Row label="true peak"><Num value={m.loudness?.true_peak ?? -1} onCommit={(v) => set('loudness', { target: m.loudness?.target ?? -14, true_peak: v })} /></Row>
        </Section>
        <Effects effects={m.effects ?? []} base="/master" tracks={project.tracks.map((x) => x.id)} master />
      </>
    )
  }
  return <div className="flex-1 min-h-0 overflow-y-auto">{body}</div>
}

function Empty() {
  return (
    <div className="p-4 text-ink-400 leading-relaxed">
      Selecione um clipe, uma trilha, uma tag, um marcador ou um ponto de envelope.
      <div className="mt-3 space-y-1 text-[11px]">
        <div><b>Espaço</b> toca / pausa · <b>Home</b> volta ao início</div>
        <div><b>Ctrl+S</b> salva · <b>Ctrl+Z</b> desfaz · <b>Ctrl+Shift+Z</b> refaz</div>
        <div><b>Roda</b> zoom · <b>roda lateral</b> ou <b>Shift+roda</b> rola para os lados · <b>Alt+roda</b> rola as trilhas · <b>Alt</b> desliga o ímã ao arrastar</div>
        <div><b>A</b> na trilha: duplo clique cria ponto, Alt+clique apaga</div>
        <div><b>+ tags</b> cria uma faixa de tags; duplo clique nela cria uma tag</div>
        <div><b>Delete</b> apaga o que está selecionado</div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-4 border-b border-white/[0.05]">
      <div className="text-[11px] uppercase tracking-wider text-ink-400 mb-3">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 shrink-0 text-ink-400 text-[12px]">{label}</div>
      <div className="flex-1 min-w-0 flex">{children}</div>
    </div>
  )
}

export function Text({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <input className="field" value={v} onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation() }}
      onBlur={() => v !== value && onCommit(v)} />
  )
}

function TextoLongo({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <textarea className="field min-h-[120px] leading-snug" value={v} onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()} onBlur={() => v !== value && onCommit(v)} />
  )
}

export function Num({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  return <Text value={String(value)} onCommit={(s) => { const n = Number(s.replace(',', '.')); if (Number.isFinite(n)) onCommit(n) }} />
}

function timeOrNumber(v: string): number | string {
  const n = Number(v.replace(',', '.'))
  return Number.isFinite(n) && !/@/.test(v) ? n : v
}

const DEFAULTS: Record<EffectType, Effect> = {
  highpass: { type: 'highpass', freq: 100 },
  lowpass: { type: 'lowpass', freq: 8000 },
  eq: { type: 'eq', freq: 3000, gain: -3, q: 1 },
  shelf: { type: 'shelf', kind: 'low', freq: 200, gain: -3 },
  compressor: { type: 'compressor', threshold: -18, ratio: 3, attack: 0.01, release: 0.15 },
  duck: { type: 'duck', source: '', depth: 10, attack: 0.08, release: 0.4, hold: 0.6 },
  espectral: { type: 'espectral', source: '', snr: 12, max: 7 },
  reverb: { type: 'reverb', mix: 0.2, seconds: 2.5 },
  limiter: { type: 'limiter', ceiling: -1 },
}
const NAMES: Record<EffectType, string> = {
  highpass: 'passa-altas', lowpass: 'passa-baixas', eq: 'EQ', shelf: 'shelf', compressor: 'compressor',
  duck: 'ducking', espectral: 'duck espectral', reverb: 'reverb', limiter: 'limitador',
}

function Effects({ effects, base, tracks, master }: { effects: Effect[]; base: string; tracks: string[]; master?: boolean }) {
  const project = useEditor((s) => s.project)!
  const write = (next: Effect[], label: string) => {
    if (master) return patch([{ op: 'replace', path: '/master', value: { ...(project.master ?? {}), effects: next } }], label)
    const t = project.tracks.find((x) => `/tracks/[id=${x.id}]` === base)
    return patch([{ op: t && 'effects' in t ? 'replace' : 'add', path: `${base}/effects`, value: next }], label)
  }
  return (
    <Section title="Efeitos">
      {effects.map((e, i) => (
        <div key={i} className="rounded-lg bg-ink-850 border border-white/[0.05] p-2.5 space-y-1.5">
          <div className="flex items-center gap-2">
            <b className="flex-1">{NAMES[e.type]}</b>
            <label className="flex items-center gap-1 text-[var(--muted)]">
              <input type="checkbox" checked={!e.bypass} onChange={(ev) => write(effects.map((x, j) => (j === i ? { ...x, bypass: !ev.target.checked || undefined } : x)), `Bypass ${e.type}`)} /> ativo
            </label>
            <button className="text-[var(--muted)] hover:text-white" disabled={i === 0} onClick={() => { const n = [...effects]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; void write(n, 'Reorder effects') }}>↑</button>
            <button className="text-[var(--muted)] hover:text-white" onClick={() => write(effects.filter((_, j) => j !== i), `Remove ${e.type}`)}>✕</button>
          </div>
          {Object.entries(e).filter(([k]) => k !== 'type' && k !== 'bypass').map(([k, v]) => (
            <Row key={k} label={k}>
              {k === 'source' ? (
                <select className="field" value={String(v)} onChange={(ev) => write(effects.map((x, j) => (j === i ? { ...x, source: ev.target.value } as Effect : x)), 'Duck source')}>
                  <option value="">—</option>
                  {tracks.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              ) : k === 'kind' ? (
                <select className="field" value={String(v)} onChange={(ev) => write(effects.map((x, j) => (j === i ? { ...x, kind: ev.target.value } as Effect : x)), 'Shelf kind')}>
                  <option value="low">grave</option><option value="high">agudo</option>
                </select>
              ) : (
                <Num value={Number(v)} onCommit={(n) => write(effects.map((x, j) => (j === i ? { ...x, [k]: n } as Effect : x)), `${e.type} ${k}`)} />
              )}
            </Row>
          ))}
        </div>
      ))}
      <select className="field" value="" onChange={(e) => { const t = e.target.value as EffectType; if (t) void write([...effects, { ...DEFAULTS[t] }], `Add ${t}`) }}>
        <option value="">+ adicionar efeito…</option>
        {(Object.keys(DEFAULTS) as EffectType[]).map((t) => <option key={t} value={t}>{NAMES[t]}</option>)}
      </select>
    </Section>
  )
}

/** A complement knows which chords it was made over; after a base changes (or to cover more bars), make it again. */
function ComplementRefit({ trackId, clipId, asset }: { trackId: string; clipId: string; asset: string }) {
  const [, force] = useState(0)
  useEffect(() => { void loadLibraries().then(() => force((n) => n + 1)) }, [])
  const it = libraryItemsById().get(asset)
  const [bars, setBars] = useState(it?.bars ?? 1)
  useEffect(() => { if (it?.bars) setBars(it.bars) }, [it?.bars])
  if (it?.role === 'base') {
    return (
      <div className="mt-2 rounded-lg bg-ink-850 border border-white/[0.05] p-2.5 space-y-2">
        <div className="text-[11px] text-ink-400">base <b className="text-ink-200">{it.recipe}</b> · {it.bars} compasso(s) · i{it.intensity}</div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-ink-400">acorde</span>
          <select className="field !w-auto" value={it.chord}
            onChange={(e) => { const p = useEditor.getState().project; if (p) void setBaseChord(p, trackId, clipId, e.target.value) }}>
            {baseChords(asset).map((ch) => <option key={ch}>{ch}</option>)}
          </select>
          <span className="text-[11px] text-ink-500">os complementos em cima se refazem</span>
        </div>
      </div>
    )
  }
  if (!it || it.role !== 'complemento') return null
  return (
    <div className="mt-2 rounded-lg bg-ink-850 border border-white/[0.05] p-2.5 space-y-2">
      <div className="text-[11px] text-ink-400">
        complemento <b className="text-ink-200">{it.recipe}</b> · {it.harmonic === false ? 'neutro' : `sobre ${(it.chords ?? []).join(' ')}`}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-ink-400">compassos</span>
        <select className="field !w-auto" value={bars} onChange={(e) => setBars(Number(e.target.value))}>
          {[1, 2, 3, 4, 6, 8].filter((n) => n >= (it.min_bars ?? 1)).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <button className="btn !h-7" onClick={() => { const p = useEditor.getState().project; if (p) void refitComplement(p, trackId, clipId, bars) }}
          title="gera de novo nos acordes das bases que estão embaixo dele agora">Refazer sobre as bases</button>
      </div>
    </div>
  )
}

/** "Alinhar com a tag": a calço after the piece before the tag, so a downbeat lands on it. */
function Alinhar({ alvo, rotulo }: { alvo: number; rotulo: string }) {
  const [msg, setMsg] = useState('')
  return (
    <div className="pt-2 space-y-1">
      <button className="btn" title="insere um calço de 1, 2 ou 3 tempos depois da última peça antes desta tag, para um 1º tempo cair no início dela"
        onClick={() => void alinharComTag(alvo, rotulo).then(setMsg)}>Alinhar a música com esta tag</button>
      {msg && <div className="text-[11px] text-ink-300 leading-snug">{msg}</div>}
    </div>
  )
}

/** The join that arrives at this piece: its verdict, and a transition over it. */
function Emenda({ trackId, clipId }: { trackId: string; clipId: string }) {
  const project = useEditor((s) => s.project)
  const [msg, setMsg] = useState('')
  const e = project ? emendaDe(project, trackId, clipId) : null
  if (!e) return null
  const cor = e.cobertura ? 'text-sky-300' : e.sm.kind === 'ok' ? 'text-emerald-300' : e.sm.kind === 'family' ? 'text-red-300' : 'text-orange-300'
  return (
    <div className="pt-1.5 space-y-1.5">
      <div className={cor}>emenda com a anterior: {e.cobertura ? `coberta por ${e.cobertura.clip.label ?? 'uma transição'}` : e.sm.text}</div>
      {e.cobertura
        ? <button className="btn" onClick={() => void descobrirEmenda(trackId, clipId)}>Tirar a transição</button>
        : <button className="btn" title="uma virada ou um prato crescendo com o golpe no 1º tempo desta peça, numa trilha de transições por cima"
            onClick={() => void cobrirEmenda(trackId, clipId).then(setMsg)}>＋ Transição na emenda</button>}
      {msg && <div className="text-ink-300">{msg}</div>}
    </div>
  )
}

/**
 * Where the song can lose a stretch and still join: the analyzer's jumps that fall inside this clip.
 * Each can be heard first (a few seconds before the cut, then straight on from after it) and taken out.
 */
function CutPoints({ trackId, clipId }: { trackId: string; clipId: string }) {
  const rc = useEditor((s) => s.resolved?.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId))
  const track = useEditor((s) => s.resolved?.tracks.find((t) => t.id === trackId))
  const setState = useEditor((s) => s.setState)
  const [a, setA] = useState<Analysis | null>(null)
  const [state, setStatus] = useState<'idle' | 'busy' | 'error'>('idle')
  const [error, setError] = useState('')
  const [onlyPhrases, setOnlyPhrases] = useState(false)
  const [more, setMore] = useState(false)
  const [playing, setPlaying] = useState<number | null>(null)
  const preview = useRef<Preview | null>(null)
  const src = rc?.src ?? ''
  const run = () => {
    setStatus('busy')
    loadAnalysis(src).then((r) => { setA(r); setStatus('idle') }).catch((e: Error) => { setError(e.message); setStatus('error') })
  }
  // already analyzed in this session: show it right away
  useEffect(() => { setA(null); setStatus('idle'); if (src && hasAnalysis(src)) run() }, [src])
  useEffect(() => () => { preview.current?.pause(); setState({ jumpHover: null }) }, [clipId])
  if (!rc) return null

  // emendas entre pedaços desta música, nesta trilha, que não caem num compasso dela
  const irmaos = (track?.clips ?? []).filter((x) => x.src === src).sort((x, y) => x.start - y.start)
  const fora = (v: number) => !!a?.bars?.length && Math.min(...a.bars.map((b) => Math.abs(b - v))) > 0.06
  const foraDaGrade = irmaos.slice(1).filter((b, k) => {
    const ant = irmaos[k]
    return Math.abs(b.start - ant.end) < 0.15 && (fora(ant.out - (ant.raw.fade_out ?? 0) / 2) || fora(b.in + (b.raw.fade_in ?? 0) / 2))
  }).length
  // em ordem de tempo (a nota fica na cor): ordenadas pela nota, as melhores de um trecho escondiam as dos outros
  const jumps = (a?.jumps ?? [])
    .filter((j) => j.from > rc.in + 0.1 && j.to < rc.out - 0.1 && (!onlyPhrases || j.phrase))
    .sort((x, y) => x.from - y.from || x.to - y.to)
  const shown = more || jumps.length <= 40 ? jumps : jumps.slice(0, 40)
  const at = (f: number) => formatTime(rc.start + (f - rc.in), 1)
  const listen = (i: number, from: number, to: number) => {
    preview.current?.pause()
    if (playing === i) { setPlaying(null); return }
    const p = engine.previewJump(src, from, to, 4, 4, a?.pulse === 'incerta' ? 1.5 : 0.06)
    p.onended = () => setPlaying((x) => (x === i ? null : x))
    preview.current = p
    setPlaying(i)
  }
  return (
    <div className="rounded-lg bg-ink-850 border border-white/[0.05] p-2.5 space-y-2 mt-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-ink-400 flex-1">Pontos de corte</span>
        {a && !a.error && <span className="text-[11px] font-mono text-ink-400" title={`confiança da batida: ${a.confidence ?? '?'}`}>{a.pulse === 'incerta' ? 'sem batida firme' : `${Math.round(a.bpm)} BPM · ${a.meter}/4`}</span>}
      </div>
      {!a && state !== 'busy' && (
        <>
          <div className="text-[11.5px] text-ink-400 leading-snug">Acha trechos que podem sair da música (encurtar) ou tocar de novo (alongar) com o resto emendando no compasso: mesma harmonia, textura e volume dos dois lados. Frases inteiras (4 e 8 compassos) vêm primeiro.</div>
          <button className="btn" onClick={run}>Analisar a música</button>
          {state === 'error' && <div className="text-[11.5px] text-red-400">{error}</div>}
        </>
      )}
      {state === 'busy' && <div className="text-[11.5px] text-ink-400">analisando (alguns segundos na primeira vez)…</div>}
      {a?.error && <div className="text-[11.5px] text-amber-300">{a.error}</div>}
      {a?.pulse === 'incerta' && (
        <div className="text-[11.5px] text-sky-200/90 leading-snug">Esta música não tem uma batida firme (o andamento muda ou é livre): os cortes não seguem compasso e emendam com crossfade longo (1,5 s), em pontos onde a música soa igual dos dois lados.</div>
      )}
      {a && !a.error && foraDaGrade > 0 && (
        <div className="rounded-md bg-amber-300/10 border border-amber-300/20 p-2 space-y-1.5">
          <div className="text-[11.5px] text-amber-100 leading-snug">{foraDaGrade} emenda(s) desta música fora do compasso: a batida pula de fase ali.</div>
          <button className="btn" title="cada emenda passa a sair e entrar num compasso da música, colada com um crossfade curto; o que vem depois anda junto"
            onClick={() => void encaixarEmendas(trackId, src)}>Encaixar as emendas na grade</button>
        </div>
      )}
      {a && !a.error && (
        <>
          <label className="flex items-center gap-1.5 text-[11.5px] text-ink-400">
            <input type="checkbox" checked={onlyPhrases} onChange={(e) => setOnlyPhrases(e.target.checked)} />
            só frases inteiras (múltiplos de 4 compassos)
          </label>
          {!jumps.length && <div className="text-[11.5px] text-ink-400">Nenhum trecho bom dentro deste clipe.</div>}
          <div className="space-y-1">
            {shown.map((j, i) => (
              <div key={`${j.from}-${j.to}`} className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-white/[0.04] text-[11.5px]"
                onMouseEnter={() => setState({ jumpHover: { trackId, clipId, from: j.from, to: j.to } })}
                onMouseLeave={() => setState({ jumpHover: null })}>
                <button type="button" title="ouvir a emenda: 4 s antes do corte, e segue do depois" onClick={() => listen(i, j.from, j.to)}
                  className="w-6 h-6 rounded grid place-items-center bg-white/[0.06] text-ink-200 hover:bg-white/[0.12] shrink-0">
                  {playing === i ? '■' : '▶'}
                </button>
                <button type="button" title="ouvir a repetição: 4 s antes do fim do trecho, e volta para o começo dele" onClick={() => listen(i + 10000, j.to, j.from)}
                  className="w-6 h-6 rounded grid place-items-center bg-white/[0.06] text-ink-200 hover:bg-white/[0.12] shrink-0">
                  {playing === i + 10000 ? '■' : '↺'}
                </button>
                <span className="font-mono text-ink-200 tabular">{at(j.from)}→{at(j.to)}</span>
                <span className="text-ink-400 truncate flex-1" title={j.bars ? `${j.bars} compassos: tirar encurta, repetir alonga` : 'tirar encurta, repetir alonga'}>±{j.removes.toFixed(1)} s{j.bars ? ` · ${j.bars}c` : ''}{j.phrase ? ' · frase' : ''}</span>
                <span className="font-mono tabular w-9 text-right" style={{ color: j.score > 0.8 ? '#4ade80' : j.score > 0.65 ? '#f2c14e' : '#9aa0aa' }}
                  title="1 = repetição perfeita; 0,5 = tão parecido quanto um compasso com o seguinte">{Math.round(j.score * 100)}%</span>
                <button type="button" className="btn !h-6 !px-2 shrink-0" title="tirar este trecho: o clipe vira dois, emendados com um crossfade curto"
                  onClick={() => { preview.current?.pause(); setPlaying(null); setState({ jumpHover: null }); void removeStretch(trackId, clipId, j.from, j.to, j.xfade) }}>tirar</button>
                <button type="button" className="btn !h-6 !px-2 shrink-0" title={`repetir este trecho (+${j.removes.toFixed(1)} s): a música chega no fim dele, volta ao começo e segue — alonga a trilha`}
                  onClick={() => { preview.current?.pause(); setPlaying(null); setState({ jumpHover: null }); void repeatStretch(trackId, clipId, j.from, j.to, j.xfade) }}>repetir</button>
              </div>
            ))}
          </div>
          {jumps.length > 40 && <button className="text-[11.5px] text-ink-400 hover:text-ink-100" onClick={() => setMore(!more)}>{more ? 'menos' : `mais ${jumps.length - 40}`}</button>}
        </>
      )}
    </div>
  )
}

/** peças já cortadas nesta sessão, por música: o painel continua aberto quando a seleção passa para as peças novas */
const pecasFeitas = new Map<string, PecasResposta>()
const avisoFeito = new Map<string, string>()
const qualEmenda = (e: number) => (e >= 0.999 ? '#8a8f98' : e > 0.8 ? '#4ade80' : e > 0.6 ? '#f2c14e' : e > 0.35 ? '#ff8a3d' : '#f87171')

/**
 * Remontar a música como um quebra-cabeça: o analisador a corta em peças de compassos inteiros, cada uma com uma função
 * (abertura, respiro, base, subida, virada, pico, final), e a busca acha as sequências que seguem um molde (duração,
 * curva de energia, picos em marcadores) com as emendas mais naturais. Aplicar troca o trecho por um clipe por peça.
 */
function Remontar({ trackId, clipId }: { trackId: string; clipId: string }) {
  const resolved = useEditor((s) => s.resolved)
  const rc = resolved?.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId)
  const src = rc?.src ?? ''
  const [pecas, setPecas] = useState<PecasResposta | null>(() => pecasFeitas.get(src) ?? null)
  const [estado, setEstado] = useState<'idle' | 'busy' | 'error'>('idle')
  const [erro, setErro] = useState('')
  const [espera, setEspera] = useState(0)
  const [profunda, setProfunda] = useState(false)
  const [modoDur, setModoDur] = useState<'trecho' | 'segundos' | 'marcador'>('trecho')
  const [segundos, setSegundos] = useState(60)
  const [marcaFim, setMarcaFim] = useState('')
  const [curva, setCurva] = useState('original')
  const [marcaPico, setMarcaPico] = useState('')
  const [livreInicio, setLivreInicio] = useState(false)
  const [livreFim, setLivreFim] = useState(false)
  const [opcoes, setOpcoes] = useState<Remontagem[] | null>(null)
  const [msg, setMsg] = useState(() => avisoFeito.get(src) ?? '')
  useEffect(() => { setPecas(pecasFeitas.get(src) ?? null); setOpcoes(null); setEstado('idle'); setMsg(avisoFeito.get(src) ?? '') }, [src])
  if (!rc || !resolved) return null
  const trecho = trechoDaMusica(resolved, trackId, clipId)
  const ini = trecho[0]?.start ?? rc.start
  const durTrecho = (trecho[trecho.length - 1]?.end ?? rc.end) - ini
  const marcas = resolved.markers.filter((m) => m.at > ini + 1)

  const analisar = (prof: boolean) => {
    setEstado('busy'); setEspera(0); setProfunda(prof); setOpcoes(null)
    loadPieces(src, prof, setEspera).then((r) => { pecasFeitas.set(src, r); setPecas(r); setEstado('idle') }).catch((e: Error) => { setErro(e.message); setEstado('error') })
  }
  const molde = (): Molde | null => {
    if (!pecas || pecas.error) return null
    const fim = marcas.find((m) => m.id === marcaFim)
    const duracao = modoDur === 'segundos' ? segundos : modoDur === 'marcador' && fim ? fim.at - ini : durTrecho
    const pico = marcas.find((m) => m.id === marcaPico)
    return {
      duracao,
      curva: curva === 'original' ? curvaOriginal(pecas) : CURVAS[curva].pts,
      picos: pico ? [pico.at - ini] : [],
      inicio: livreInicio ? 'qualquer' : 'abertura',
      fim: livreFim ? 'qualquer' : 'final',
    }
  }
  const gerar = () => { const m = molde(); if (m && pecas) { setOpcoes(remontar(pecas, m, 3)); setMsg('') } }
  const aplicar = (r: Remontagem, alinhar: boolean) => {
    if (!pecas) return
    const pico = marcas.find((m) => m.id === marcaPico)
    const desloca = alinhar && pico && r.picos[0] ? pico.at - ini - r.picos[0].at : 0
    void aplicarRemontagem(trackId, clipId, pecas, r, desloca).then((m) => { avisoFeito.set(src, m); setMsg(m) })
    setOpcoes(null)
  }
  const P_ = pecas?.pieces ?? []
  const fita = (seq: number[]) => (
    <div className="flex h-3 rounded overflow-hidden gap-px">
      {seq.map((j, k) => (
        <div key={k} title={`P${j + 1} · ${P_[j].role} · energia ${Math.round(P_[j].energy * 100)}`}
          style={{ flex: P_[j].end - P_[j].start, background: CORES_FUNCAO[P_[j].role] }} />
      ))}
    </div>
  )
  return (
    <div className="rounded-lg bg-ink-850 border border-white/[0.05] p-2.5 space-y-2 mt-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-ink-400 flex-1">Remontar</span>
        {pecas && !pecas.error && <span className="text-[11px] font-mono text-ink-400" title="de onde veio a grade de compassos">
          {P_.length} peças · {Math.round(pecas.bpm ?? 0)} BPM · {pecas.grid === 'allin1' ? 'All-In-One' : 'Essentia'}</span>}
      </div>
      {!pecas && estado !== 'busy' && (
        <>
          <div className="text-[11.5px] text-ink-400 leading-snug">Corta a música em frases (de 4 compassos), dá uma função a cada uma e monta de novo seguindo um molde: duração, curva de energia e picos nos marcadores, com as emendas mais naturais.</div>
          <div className="flex flex-wrap gap-1.5">
            <button className="btn" onClick={() => analisar(false)}>Cortar em peças</button>
            <button className="btn" title="usa a grade e as seções do All-In-One (precisa estar configurado). Leva minutos na primeira vez." onClick={() => analisar(true)}>Análise profunda</button>
          </div>
          {estado === 'error' && <div className="text-[11.5px] text-red-400">{erro}</div>}
        </>
      )}
      {estado === 'busy' && <div className="text-[11.5px] text-ink-400">{profunda ? `análise profunda (All-In-One)… ${espera} s — na CPU leva 3–5× a duração da música` : 'cortando em peças…'}</div>}
      {pecas?.error && (
        <div className="space-y-1.5">
          <div className="text-[11.5px] text-amber-300">{pecas.error}</div>
          {pecas.profunda_disponivel && !profunda && <button className="btn" onClick={() => analisar(true)}>Análise profunda</button>}
        </div>
      )}
      {pecas && !pecas.error && (
        <>
          {fita(P_.map((p) => p.i))}
          <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10.5px] text-ink-400">
            {Object.entries(CORES_FUNCAO).map(([f, c]) => <span key={f} className="flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: c }} />{f}</span>)}
          </div>
          <div className="grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-1.5 text-[11.5px]">
            <span className="text-ink-400">duração</span>
            <div className="flex flex-wrap gap-1.5 min-w-0">
              <select className="field !w-auto" value={modoDur} onChange={(e) => setModoDur(e.target.value as never)}>
                <option value="trecho">a do trecho ({durTrecho.toFixed(0)} s)</option>
                <option value="segundos">segundos</option>
                {marcas.length > 0 && <option value="marcador">até um marcador</option>}
              </select>
              {modoDur === 'segundos' && <input className="field !w-16" type="number" min={5} value={segundos} onChange={(e) => setSegundos(Number(e.target.value) || 0)} />}
              {modoDur === 'marcador' && (
                <select className="field !w-auto min-w-0 max-w-full" value={marcaFim} onChange={(e) => setMarcaFim(e.target.value)}>
                  <option value="">—</option>
                  {marcas.map((m) => <option key={m.id} value={m.id}>{m.label ?? m.id} ({formatTime(m.at, 1)})</option>)}
                </select>
              )}
            </div>
            <span className="text-ink-400">energia</span>
            <select className="field" value={curva} onChange={(e) => setCurva(e.target.value)}>
              <option value="original">como a original</option>
              {Object.entries(CURVAS).map(([k, c]) => <option key={k} value={k}>{c.nome}</option>)}
            </select>
            <span className="text-ink-400">pico em</span>
            <select className="field" value={marcaPico} onChange={(e) => setMarcaPico(e.target.value)} title="um trecho forte começa neste marcador (o drop num corte do vídeo)">
              <option value="">nenhum marcador</option>
              {marcas.map((m) => <option key={m.id} value={m.id}>{m.label ?? m.id} ({formatTime(m.at, 1)})</option>)}
            </select>
          </div>
          <label className="flex items-center gap-1.5 text-[11.5px] text-ink-400"><input type="checkbox" checked={livreInicio} onChange={(e) => setLivreInicio(e.target.checked)} />pode começar no meio da música</label>
          <label className="flex items-center gap-1.5 text-[11.5px] text-ink-400"><input type="checkbox" checked={livreFim} onChange={(e) => setLivreFim(e.target.checked)} />pode acabar antes do final (com fade)</label>
          <div className="flex gap-1.5">
            <button className="btn" onClick={gerar}>Gerar opções</button>
            {pecas.profunda_disponivel && pecas.grid !== 'allin1' && <button className="btn" title="refaz as peças com a grade e as seções do All-In-One" onClick={() => analisar(true)}>Análise profunda</button>}
          </div>
          {opcoes && !opcoes.length && <div className="text-[11.5px] text-amber-300">Nenhuma sequência fecha com esse molde. Tente outra duração ou deixe começar/acabar no meio.</div>}
          {opcoes?.map((r, k) => {
            const novas = r.emendas.filter((e): e is number => e !== null && e < 0.999)
            const pior = novas.length ? Math.min(...novas) : 1
            const pico = r.picos[0]
            return (
              <div key={k} className="rounded-md bg-white/[0.03] p-2 space-y-1.5">
                <div className="flex items-center gap-2 text-[11.5px]">
                  <span className="font-mono text-ink-200">{formatTime(r.duracao, 1)}</span>
                  <span className="text-ink-400 flex-1">{r.seq.length} peças · {novas.length} emendas novas{novas.length ? <> · pior <b style={{ color: qualEmenda(pior) }}>{Math.round(pior * 100)}%</b></> : ''}</span>
                  <button className="btn !h-6 !px-2" onClick={() => aplicar(r, false)}>aplicar</button>
                </div>
                {fita(r.seq)}
                <div className="flex flex-wrap gap-1 text-[10.5px] font-mono">
                  {r.seq.map((j, i) => (
                    <span key={i} className="text-ink-300" title={i ? `emenda ${Math.round((r.emendas[i] ?? 0) * 100)}%` : 'começo'}>
                      {i > 0 && <span style={{ color: qualEmenda(r.emendas[i] ?? 0) }}>›</span>}P{j + 1}
                    </span>
                  ))}
                </div>
                {pico && (
                  <div className="flex items-center gap-2 text-[11px] text-ink-400">
                    <span className="flex-1">pico a {pico.erro < 0.05 ? 'tempo no marcador' : `${pico.erro.toFixed(1)} s do marcador`}</span>
                    {pico.erro >= 0.05 && <button className="btn !h-6 !px-2" title="desloca a remontagem inteira para o pico cair exatamente no marcador" onClick={() => aplicar(r, true)}>aplicar alinhando</button>}
                  </div>
                )}
              </div>
            )
          })}
          {msg && <div className="text-[11.5px] text-ink-300">{msg} · Ctrl+Z desfaz</div>}
        </>
      )}
    </div>
  )
}

/**
 * As peças que o acervo achou na música (quando o arquivo veio de lá): P<n>, a função e onde começa no arquivo, com a
 * borda na cor da função. As que caem dentro do clipe ficam acesas; clicar numa delas leva a agulha até lá.
 */
function PecasDoAcervo({ src, start, from, to, onSeparar }: { src: string; start: number; from: number; to: number; onSeparar: () => void }) {
  const [a, setA] = useState<AcervoAnalysis | null | undefined>(acervoProntas.get(src))
  useEffect(() => {
    let vivo = true
    setA(acervoProntas.get(src))
    loadAcervo(src).then((x) => { if (vivo) setA(x) }, () => { if (vivo) setA(null) })
    return () => { vivo = false }
  }, [src])
  if (!a?.pieces.length) return null
  const setPlayhead = useEditor.getState().setPlayhead
  const funcoes = [...new Set(a.pieces.map((p) => p.role).filter(Boolean))]
  return (
    <div className="space-y-1.5 pt-1">
      <div className="text-[11px] uppercase tracking-wider text-ink-400">
        Peças do acervo <span className="normal-case tracking-normal text-ink-500">· {a.id.split('/')[1]}{a.bpm ? ` · ${Math.round(a.bpm)} BPM` : ''}{a.key ? ` · ${a.key}` : ''}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {a.pieces.map((p, i) => {
          const dentro = p.end > from && p.start < to
          const cor = CORES_FUNCAO[p.role as keyof typeof CORES_FUNCAO] ?? '#8a8f98'
          return (
            <button key={i} disabled={!dentro}
              className="rounded-md bg-ink-850 border border-white/[0.06] pl-1.5 pr-2 py-1 text-[11px] leading-none text-left disabled:opacity-40 hover:border-white/30"
              style={{ borderLeft: `3px solid ${cor}` }}
              title={`${p.mood ? `humor dominante: ${p.mood}\n` : ''}${formatTime(p.start, 1)} → ${formatTime(p.end, 1)} do arquivo · energia ${Math.round(p.energy * 100)}${dentro ? '\nclique para levar a agulha até aqui' : '\nfora do clipe'}`}
              onClick={() => setPlayhead(start + Math.max(0, p.start - from))}>
              <b className="text-ink-100">P{i + 1}</b> <span className="text-ink-400">{p.role || p.mood} · {formatTime(p.start, 0)}</span>
            </button>
          )
        })}
      </div>
      {a.pieces.filter((p) => p.end > from + 0.05 && p.start < to - 0.05).length > 1 && (
        <button className="btn" onClick={onSeparar} title="Corta o clipe nas divisas das peças: cada peça presente vira um clipe independente">Separar as peças</button>
      )}
      {funcoes.length > 0 && (
        <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-[10.5px] text-ink-400">
          {Object.entries(CORES_FUNCAO).filter(([f]) => funcoes.includes(f)).map(([f, c]) => (
            <span key={f} className="inline-flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: c }} />{f}</span>
          ))}
        </div>
      )}
    </div>
  )
}
