/**
 * Duck espectral: o que render e preview compartilham. A máscara é calculada no servidor (STFT da voz e da faixa) e
 * vira, a cada PASSO segundos, a atenuação (dB, ≥ 0) de cada uma das BANDAS; os dois lados aplicam essa tabela num
 * banco de filtros peaking em série (centro na banda, Q fixo, ganho = −atenuação × FATOR).
 */

/** centros (Hz): de 2/3 em 2/3 de oitava, cobrindo a fala (≈200 Hz–8 kHz) */
export const ESPECTRAL_BANDAS = [250, 400, 630, 1000, 1600, 2500, 4000, 6300]
/** Q dos peaking: largura de ~2/3 de oitava, para os vizinhos se encontrarem perto de −3 dB */
export const ESPECTRAL_Q = 2.1
/** ganho de cada peaking = −atenuação da banda × FATOR (1,0 deu o mesmo corte médio do STFT original, ~3,5 LU sob a voz) */
export const ESPECTRAL_FATOR = 1.0
/** segundos entre linhas da tabela */
export const ESPECTRAL_PASSO = 0.02

export interface MascaraEspectral {
  passo: number
  bandas: number[]
  /** atenuação em dB, linha a linha: att[k * bandas.length + b] é a banda b no instante k * passo */
  att: Float32Array
}

/** a atenuação (dB) de cada banda no instante t, interpolando entre as linhas */
export function atenuacaoEm(m: MascaraEspectral, t: number, out: Float32Array): Float32Array {
  const nb = m.bandas.length
  const linhas = m.att.length / nb
  const x = t / m.passo
  const k = Math.floor(x)
  if (k < 0 || k >= linhas - 1) {
    out.fill(0)
    return out
  }
  const f = x - k
  for (let b = 0; b < nb; b++) out[b] = m.att[k * nb + b] * (1 - f) + m.att[(k + 1) * nb + b] * f
  return out
}

/** a máscara como texto (base64 de bytes em quartos de dB, até 63,75 dB), para o preview */
export function mascaraParaJson(m: MascaraEspectral): { passo: number; bandas: number[]; att: string } {
  const q = new Uint8Array(m.att.length)
  for (let i = 0; i < q.length; i++) q[i] = Math.max(0, Math.min(255, Math.round(m.att[i] * 4)))
  let bin = ''
  for (let i = 0; i < q.length; i += 0x8000) bin += String.fromCharCode(...q.subarray(i, i + 0x8000))
  return { passo: m.passo, bandas: m.bandas, att: btoa(bin) }
}

export function mascaraDoJson(j: { passo: number; bandas: number[]; att: string }): MascaraEspectral {
  const bin = atob(j.att)
  const att = new Float32Array(bin.length)
  for (let i = 0; i < bin.length; i++) att[i] = bin.charCodeAt(i) / 4
  return { passo: j.passo, bandas: j.bandas, att }
}
