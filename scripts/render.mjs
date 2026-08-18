#!/usr/bin/env node
// Renders the fastfetch-style profile card into assets/fetch-{dark,light}.svg.
// Static text lives in profile.json, live numbers come from the public GitHub API.
// No dependencies, no external services.

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const FONT_SIZE = 14
const CHAR_W = 8.4
const LINE_H = 21
const PAD_X = 26
const PAD_Y = 22
const BAR_H = 38
const LOGO_GAP = 4
const KEY_FIELD = 11 // "OS ········" width, values start one column later

const LOGO = [
  '       ██       ',
  '      ████      ',
  '     ██  ██     ',
  '    ██    ██    ',
  '   ██▀▀▀▀▀▀██   ',
  '  ██        ██  ',
  ' ██          ██ ',
]

const THEMES = {
  dark: {
    // Catppuccin Mocha
    page: '#181825',
    panel: '#1e1e2e',
    bar: '#181825',
    border: '#313244',
    text: '#cdd6f4',
    dim: '#6c7086',
    sep: '#313244',
    key: '#89b4fa',
    caption: '#7f849c',
    logoA: '#cba6f7',
    logoB: '#89b4fa',
    ansi: ['#f38ba8', '#fab387', '#f9e2af', '#a6e3a1', '#94e2d5', '#89b4fa', '#cba6f7', '#f5c2e7'],
    lights: ['#f38ba8', '#f9e2af', '#a6e3a1'],
  },
  light: {
    // Catppuccin Latte
    page: '#e6e9ef',
    panel: '#eff1f5',
    bar: '#e6e9ef',
    border: '#ccd0da',
    text: '#4c4f69',
    dim: '#8c8fa1',
    sep: '#ccd0da',
    key: '#1e66f5',
    caption: '#7c7f93',
    logoA: '#8839ef',
    logoB: '#1e66f5',
    ansi: ['#d20f39', '#fe640b', '#df8e1d', '#40a02b', '#179299', '#1e66f5', '#8839ef', '#ea76cb'],
    lights: ['#d20f39', '#df8e1d', '#40a02b'],
  },
}

async function api(path) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'profile-card' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com${path}`, { headers })
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`)
  return res.json()
}

function ago(iso) {
  const mins = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000))
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  return months < 24 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`
}

// Only /users/:user/repos is queried, so private repositories can never leak
// into the card even when the workflow runs with a token.
async function collect(user) {
  const profile = await api(`/users/${user}`)
  const repos = []
  for (let page = 1; page <= 5; page++) {
    const batch = await api(`/users/${user}/repos?per_page=100&type=owner&sort=pushed&page=${page}`)
    repos.push(...batch)
    if (batch.length < 100) break
  }
  const own = repos.filter((r) => !r.fork && !r.private)
  const active = own.filter((r) => !r.archived)
  // The profile repo commits itself on every card refresh, so it would always
  // win "latest" and hide real work.
  const notSelf = (r) => r.name.toLowerCase() !== user.toLowerCase()
  // `pushed_at` counts a push to any branch, so a bot updating a sync branch
  // makes a repo look freshly worked on. Only the default branch head counts.
  // Sorted by `pushed_at`, which is never older than the head commit, so the
  // true winner cannot rank below this many candidates in practice.
  const candidates = (active.length ? active : own).filter(notSelf).slice(0, 15)
  const heads = await Promise.all(
    candidates.map(async (r) => {
      const [head] = await api(`/repos/${r.full_name}/commits?sha=${r.default_branch}&per_page=1`)
      return head ? { name: r.name, at: head.commit.committer.date } : null
    }),
  )
  const latest = heads.filter(Boolean).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  return {
    // Includes forks, since a heavily rewritten fork can still be a shipped plugin.
    names: new Set(repos.map((r) => r.name)),
    followers: profile.followers,
    repos: own.length,
    stars: own.reduce((sum, r) => sum + r.stargazers_count, 0),
    latestRepo: latest?.name ?? user,
    latestAge: latest ? ago(latest.at) : 'unknown',
  }
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(values[k] ?? `{{${k}}}`))
}

// Whitespace inside an SVG <text> collapses, so every segment must be a run of
// non-space characters carrying its own column. This keeps the grid exact.
function runs(text, startCol, tone) {
  const out = []
  for (const match of text.matchAll(/\S+/g)) out.push({ col: startCol + match.index, text: match[0], tone })
  return out
}

// A line is a list of {col, text, tone} segments placed on a fixed character grid.
function layout(cfg, stats) {
  const values = { ...stats, plugins: cfg.pluginRepos.length }
  const info = []

  info.push([
    { col: 0, text: cfg.user, tone: 'logoA' },
    { col: cfg.user.length, text: '@', tone: 'dim' },
    { col: cfg.user.length + 1, text: cfg.host, tone: 'key' },
  ])
  info.push('rule')

  for (const [key, raw] of cfg.rows) {
    const segs = [
      { col: 0, text: key, tone: 'key' },
      { col: key.length + 1, text: '·'.repeat(KEY_FIELD - key.length - 1), tone: 'dim' },
    ]
    let col = KEY_FIELD + 1
    for (const part of fill(raw, values).split(/( · )/)) {
      if (!part) continue
      if (part === ' · ') segs.push({ col: col + 1, text: '·', tone: 'dim' })
      else segs.push({ col, text: part, tone: 'text' })
      col += part.length
    }
    info.push(segs)
  }

  info.push([])
  for (const tone of ['ansi', 'ansiDim']) {
    info.push(THEMES.dark.ansi.map((_, i) => ({ col: i * 4, text: '███', tone: `${tone}${i}` })))
  }

  const width = Math.max(
    ...info.map((line) => (line === 'rule' || !line.length ? 0 : Math.max(...line.map((s) => s.col + s.text.length))))
  )
  const rule = { col: 0, text: '─'.repeat(width), tone: 'sep' }
  const lines = info.map((line) => (line === 'rule' ? [rule] : line))

  const caption = [
    { col: Math.floor((LOGO[0].length - cfg.logoCaption.length) / 2), text: cfg.logoCaption, tone: 'caption' },
  ]
  const logo = [...LOGO.map(() => []), [], caption]

  return { lines, logo, cols: LOGO[0].length + LOGO_GAP + width, rows: lines.length }
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function color(theme, tone) {
  if (tone.startsWith('ansiDim')) return theme.ansi[Number(tone.slice(7))]
  if (tone.startsWith('ansi')) return theme.ansi[Number(tone.slice(4))]
  if (tone === 'logo') return 'url(#logo)'
  return theme[tone] ?? theme.text
}

function render(box, cfg, theme) {
  const width = Math.round(PAD_X * 2 + box.cols * CHAR_W)
  const height = Math.round(BAR_H + PAD_Y * 2 + box.rows * LINE_H)
  const out = []

  const emit = (line, rowIndex, colOffset) => {
    for (const seg of line) {
      const x = (PAD_X + (seg.col + colOffset) * CHAR_W).toFixed(1)
      const y = (BAR_H + PAD_Y + rowIndex * LINE_H + FONT_SIZE).toFixed(1)
      const opacity = seg.tone.startsWith('ansiDim') ? ' opacity="0.45"' : ''
      out.push(
        `<text x="${x}" y="${y}" fill="${color(theme, seg.tone)}"${opacity} ` +
          `textLength="${(seg.text.length * CHAR_W).toFixed(1)}" lengthAdjust="spacingAndGlyphs">${esc(seg.text)}</text>`
      )
    }
  }

  const logoTop = Math.max(0, Math.floor((box.rows - box.logo.length) / 2))
  box.logo.forEach((line, i) => emit(line, logoTop + i, 0))
  box.lines.forEach((line, i) => emit(line, i, LOGO[0].length + LOGO_GAP))

  // The mark is drawn as grid rectangles. Block characters would leave seams
  // between line boxes and would depend on the viewer's font.
  const marks = []
  LOGO.forEach((row, rowIndex) => {
    const top = BAR_H + PAD_Y + (logoTop + rowIndex) * LINE_H
    // Contiguous cells are merged into one rect so no antialiasing seam shows.
    for (const run of row.matchAll(/(█+|▀+)/g)) {
      const full = run[0][0] === '█'
      marks.push(
        `<rect x="${(PAD_X + run.index * CHAR_W).toFixed(2)}" y="${(top + (full ? 0 : LINE_H / 4)).toFixed(2)}" ` +
          `width="${(run[0].length * CHAR_W).toFixed(2)}" height="${(full ? LINE_H : LINE_H / 2).toFixed(2)}" fill="url(#logo)"/>`
      )
    }
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(cfg.user)} profile card">
<title>${esc(cfg.user)} profile card</title>
<defs>
<linearGradient id="logo" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="${theme.logoA}"/>
<stop offset="100%" stop-color="${theme.logoB}"/>
</linearGradient>
<clipPath id="card"><rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="13.5"/></clipPath>
</defs>
<g clip-path="url(#card)">
<rect width="${width}" height="${height}" fill="${theme.panel}"/>
<rect width="${width}" height="${BAR_H}" fill="${theme.bar}"/>
<line x1="0" y1="${BAR_H}.5" x2="${width}" y2="${BAR_H}.5" stroke="${theme.border}"/>
<circle cx="24" cy="${BAR_H / 2}" r="5.5" fill="${theme.lights[0]}"/>
<circle cx="43" cy="${BAR_H / 2}" r="5.5" fill="${theme.lights[1]}"/>
<circle cx="62" cy="${BAR_H / 2}" r="5.5" fill="${theme.lights[2]}"/>
<text x="${width / 2}" y="${BAR_H / 2 + 4}" fill="${theme.dim}" font-size="12" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace">${esc(cfg.windowTitle)}</text>
${marks.join('\n')}
<g font-family="ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace" font-size="${FONT_SIZE}" xml:space="preserve">
${out.join('\n')}
</g>
</g>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="13.5" fill="none" stroke="${theme.border}"/>
</svg>
`
}

async function writeIfChanged(path, content) {
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current === content) return false
  await writeFile(path, content)
  return true
}

const cfg = JSON.parse(await readFile(join(ROOT, 'profile.json'), 'utf8'))
const stats = await collect(cfg.user)

// A renamed or archived plugin repo should be loud, not silently miscounted.
for (const repo of cfg.pluginRepos) {
  if (!stats.names.has(repo)) console.warn(`warning: pluginRepos lists ${repo}, which is not a public repo`)
}

const box = layout(cfg, stats)

for (const [name, theme] of Object.entries(THEMES)) {
  const path = join(ROOT, 'assets', `fetch-${name}.svg`)
  const changed = await writeIfChanged(path, render(box, cfg, theme))
  console.log(`${changed ? 'wrote' : 'unchanged'} assets/fetch-${name}.svg`)
}
