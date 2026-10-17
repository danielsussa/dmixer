#!/usr/bin/env -S node --import tsx
import fs from 'node:fs/promises'
import path from 'node:path'
import { describeProject, emptyProject, serializeProject } from '@dmixer/core'
import { ProjectRegistry, type Entry } from './registry.js'
import { renderMix } from './render.js'
import { PUBLIC_URL, projectRoot, startServer } from './index.js'
import { Workspace } from './workspace.js'

const HELP = `dmixer — the mix is a YAML file

  dmixer init <file.yaml>                     create an empty mix (and link it)
  dmixer link <file.yaml | folder>            link a mix from anywhere; prints its URL (/c/<id>)
  dmixer list                                 linked mixes and their URLs
  dmixer unlink <id>
  dmixer open [file.yaml | folder …]          start the server (linking what you name)
  dmixer validate <file.yaml | id>            schema + semantic checks (exit 1 on error)
  dmixer context <file.yaml | id>             compact summary, for an agent to read
  dmixer render <file.yaml | id> [--out f.mp3|.wav] [--from s] [--to s] [--raw]

The index of links lives in ~/.dmixer (DMIXER_HOME). URLs use DMIXER_PUBLIC_URL (now ${PUBLIC_URL}).
`

function flags(argv: string[]) {
  const pos: string[] = []
  const opt: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) opt[a.slice(2)] = true
      else {
        opt[a.slice(2)] = v
        i++
      }
    } else pos.push(a)
  }
  return { pos, opt }
}

const [cmd, ...rest] = process.argv.slice(2)
const { pos, opt } = flags(rest)
const url = (e: Entry) => `${PUBLIC_URL}/c/${e.id}`

/** A mix named by its id or by a path (a folder means its first mix); linked on the way. */
async function resolveMix(registry: ProjectRegistry, target: string | undefined): Promise<Entry> {
  if (target && registry.entry(target)) return registry.entry(target)!
  const abs = projectRoot(target)
  const st = await fs.stat(abs)
  if (st.isDirectory()) {
    const first = (await new Workspace(abs).listProjects())[0]
    if (!first) throw new Error(`No mix in ${abs}`)
    return registry.link(path.join(abs, first))
  }
  return registry.link(abs)
}

const registry = new ProjectRegistry()
await registry.init()
try {
  switch (cmd) {
    case 'init': {
      const file = projectRoot(pos[0] ?? 'mix.yaml')
      const target = /\.ya?ml$/i.test(file) ? file : path.join(file, 'mix.yaml')
      await fs.mkdir(path.dirname(target), { recursive: true })
      try {
        await fs.access(target)
        throw new Error(`${target} already exists`)
      } catch (e) {
        if ((e as Error).message.includes('already exists')) throw e
      }
      await fs.writeFile(target, serializeProject(emptyProject({ name: path.basename(target, path.extname(target)) })))
      const e = await registry.link(target)
      console.log(`created ${target}\n${url(e)}`)
      break
    }
    case 'link': {
      const abs = projectRoot(pos[0])
      const st = await fs.stat(abs)
      const entries = st.isDirectory() ? await registry.linkFolder(abs) : [await registry.link(abs)]
      if (!entries.length) throw new Error(`No mix in ${abs}`)
      for (const e of entries) console.log(`${url(e)}  ${e.path}`)
      break
    }
    case 'list':
      for (const e of registry.list()) console.log(`${url(e)}  ${e.name}  ${e.path}`)
      if (!registry.list().length) console.log('(nothing linked yet — dmixer link <file.yaml>)')
      break
    case 'unlink':
      await registry.unlink(pos[0])
      console.log('ok')
      break
    case 'open': {
      await registry.close()
      const h = await startServer(pos.map((p) => projectRoot(p)))
      console.log(`dmixer  ${h.url}  (${h.registry.list().length} mixes; ${PUBLIC_URL}/)`)
      break
    }
    case 'validate': {
      const e = await resolveMix(registry, pos[0])
      const diags = (await registry.get(e.id)).getDiagnostics()
      for (const d of diags) console.log(`${d.severity}: ${d.message}`)
      if (diags.some((d) => d.severity === 'error')) process.exitCode = 1
      else console.log('ok')
      break
    }
    case 'context': {
      const e = await resolveMix(registry, pos[0])
      console.log(describeProject((await registry.get(e.id)).getProject()))
      console.log(`\nURL ${url(e)}`)
      break
    }
    case 'render': {
      const e = await resolveMix(registry, pos[0])
      const store = await registry.get(e.id)
      const base = path.basename(store.name, path.extname(store.name))
      const out = path.resolve(process.env.INIT_CWD ?? process.cwd(), typeof opt.out === 'string' ? opt.out : path.join(store.workspace.rendersDir, `${base}.mp3`))
      const t0 = Date.now()
      let last = -1
      const r = await renderMix(store.getProject(), store.workspace, {
        out,
        from: opt.from ? Number(opt.from) : undefined,
        to: opt.to ? Number(opt.to) : undefined,
        normalize: !opt.raw,
        onProgress: (p, stage) => {
          const pct = Math.floor(p * 100)
          if (pct !== last) process.stderr.write(`\r${String(pct).padStart(3)}%  ${stage.padEnd(30)}`)
          last = pct
        },
      })
      process.stderr.write('\n')
      console.log(`ok ${r.out} (${r.duration.toFixed(1)} s, ${((Date.now() - t0) / 1000).toFixed(1)} s to render)`)
      break
    }
    default:
      console.log(HELP)
      if (cmd && cmd !== 'help') process.exitCode = 1
  }
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 1
}
if (cmd !== 'open') {
  await registry.close()
  process.exit()
}
