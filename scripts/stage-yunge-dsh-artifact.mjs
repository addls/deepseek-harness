#!/usr/bin/env node
/**
 * Stage a Yunge-consumable DSH artifact directory and optionally archive it.
 *
 * Usage:
 *   node scripts/stage-yunge-dsh-artifact.mjs \
 *     --from <artifact-root-with-dsh> \
 *     --slug darwin-arm64|darwin-x64|win32-x64|linux-x64 \
 *     [--out-root dist/yunge-artifacts] \
 *     [--archive] \
 *     [--with-office]   # include primary-runtime + office-skills + LibreOffice Kit
 *
 * Default (云歌 slim): dsh/ only, strip LibreOffice Kit natives; no runtime/.
 * Layout written:
 *   <out-root>/<slug>/dsh/
 *   <out-root>/<slug>/runtime/primary-runtime/   (only with --with-office)
 *   <out-root>/<slug>/runtime/office-skills/     (only with --with-office)
 *   <out-root>/<slug>/yunge-artifact.json
 *
 * With --archive:
 *   <out-root>/yunge-dsh-<slug>.tgz   (unix)
 *   <out-root>/yunge-dsh-<slug>.zip   (win32 host, or when --zip)
 *
 * When --from is the staged dir (or lives under it), content is copied through a
 * temp directory first so rm of the stage target cannot delete the live source.
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SLUGS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64'])

function die(message) {
  console.error(`stage-yunge-dsh-artifact: ${message}`)
  process.exit(1)
}

function argValue(name) {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  if (hit) return hit.slice(prefix.length)
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1]
  }
  return undefined
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

/** True when `inner` is the same path as `outer`, or a path under it. */
function isSameOrInside(inner, outer) {
  const a = resolve(inner)
  const b = resolve(outer)
  if (a === b) return true
  const rel = relative(b, a)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}


/** Rewrite CI absolute python/python3 symlinks to relative pythonX.Y aliases. */
function normalizePrimaryRuntimePythonAliases(primaryRoot) {
  const bin = join(primaryRoot, 'dependencies', 'python', 'bin')
  if (!existsSync(bin)) return
  let interpreter = 'python3.12'
  const runtimeJson = join(primaryRoot, 'runtime.json')
  if (existsSync(runtimeJson)) {
    try {
      const manifest = JSON.parse(readFileSync(runtimeJson, 'utf8'))
      const parts = String(manifest.python || '').split('.')
      if (parts.length >= 2) interpreter = `python${parts[0]}.${parts[1]}`
    } catch { /* keep default */ }
  }
  const target = join(bin, interpreter)
  if (!existsSync(target) || !lstatSync(target).isFile()) return
  for (const name of ['python', 'python3']) {
    const path = join(bin, name)
    let ok = false
    try {
      ok = existsSync(path) && lstatSync(path).isSymbolicLink() && readlinkSync(path) === interpreter
    } catch { ok = false }
    if (ok) continue
    try { unlinkSync(path) } catch { /* missing */ }
    symlinkSync(interpreter, path)
  }
}


/** Drop Office-only native/skill packages from a staged dsh/ tree (~150MB+). */
function stripOfficeNativeDeps(dshRoot) {
  const nm = join(dshRoot, 'node_modules', '@deepseek-ai')
  if (!existsSync(nm)) return []
  const removed = []
  for (const name of readdirSync(nm)) {
    if (
      name === 'libreoffice-kit'
      || name.startsWith('libreoffice-kit-')
      || name === 'dsh-skill-office'
      || name === 'dsh-office-to-pdf'
    ) {
      rmSync(join(nm, name), { recursive: true, force: true })
      removed.push(name)
    }
  }
  return removed
}

function copyTree(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true, dereference: true })
}

/**
 * Materialize dsh/ (+ optional primary-runtime) from `from` into `destRoot`.
 * `destRoot` must not overlap a live source that still needs reading, or the
 * caller must have already copied through a non-overlapping temp.
 */
function materializeInto(from, destRoot, { withOffice = false } = {}) {
  const srcDsh = join(from, 'dsh')
  if (!existsSync(srcDsh)) die(`missing dsh/ under ${from}`)

  rmSync(destRoot, { recursive: true, force: true })
  mkdirSync(destRoot, { recursive: true })
  const destDsh = join(destRoot, 'dsh')
  copyTree(srcDsh, destDsh)

  let stripped = []
  if (!withOffice) {
    stripped = stripOfficeNativeDeps(destDsh)
  }

  let hasPrimary = false
  let hasOfficeSkills = false
  if (withOffice) {
    const srcPrimary = join(from, 'runtime', 'primary-runtime')
    if (existsSync(srcPrimary)) {
      mkdirSync(join(destRoot, 'runtime'), { recursive: true })
      const destPrimary = join(destRoot, 'runtime', 'primary-runtime')
      copyTree(srcPrimary, destPrimary)
      normalizePrimaryRuntimePythonAliases(destPrimary)
      hasPrimary = true
    }
    const srcOfficeSkills = join(from, 'runtime', 'office-skills')
    if (existsSync(srcOfficeSkills)) {
      mkdirSync(join(destRoot, 'runtime'), { recursive: true })
      copyTree(srcOfficeSkills, join(destRoot, 'runtime', 'office-skills'))
      hasOfficeSkills = true
    }
  }
  return { hasPrimary, hasOfficeSkills, strippedOfficeNatives: stripped, withOffice }
}

function main() {
  const fromRaw = argValue('from')
  const slug = argValue('slug')
  const outRoot = resolve(ROOT, argValue('out-root') || 'dist/yunge-artifacts')
  const wantArchive = hasFlag('archive')
  const forceZip = hasFlag('zip')
  const withOffice = hasFlag('with-office')

  if (!fromRaw || !slug) {
    die('required: --from <dir> --slug <darwin-arm64|darwin-x64|win32-x64|linux-x64|linux-arm64>')
  }
  if (!SLUGS.has(slug)) die(`unknown slug ${slug}`)

  const from = resolve(fromRaw)
  const staged = join(outRoot, slug)
  if (!existsSync(join(from, 'dsh'))) die(`missing dsh/ under ${from}`)

  let stagedBits
  // Overlap: wiping `staged` would delete the live --from (same path or parent).
  if (isSameOrInside(from, staged)) {
    const tmp = mkdtempSync(join(tmpdir(), `yunge-stage-${slug}-`))
    try {
      stagedBits = materializeInto(from, tmp, { withOffice })
      rmSync(staged, { recursive: true, force: true })
      mkdirSync(dirname(staged), { recursive: true })
      cpSync(tmp, staged, { recursive: true, dereference: true })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } else {
    stagedBits = materializeInto(from, staged, { withOffice })
  }
  const { hasPrimary, hasOfficeSkills, strippedOfficeNatives, withOffice: officeOn } = stagedBits

  const [platform, arch] = slug.split('-')
  const meta = {
    schemaVersion: 1,
    kind: 'yunge-dsh-artifact',
    slug,
    platform,
    arch,
    dshVersion: readVersion(),
    withOffice: officeOn,
    hasPrimaryRuntime: hasPrimary,
    hasOfficeSkills,
    strippedOfficeNatives,
    preparedAt: new Date().toISOString(),
    source: from,
  }
  writeFileSync(join(staged, 'yunge-artifact.json'), `${JSON.stringify(meta, null, 2)}\n`)

  console.log(`stage-yunge-dsh-artifact: staged ${staged}`)
  console.log(
    `  dsh/=yes with-office=${officeOn ? 'yes' : 'no'} primary-runtime=${hasPrimary ? 'yes' : 'no'} office-skills=${hasOfficeSkills ? 'yes' : 'no'}`,
  )
  if (strippedOfficeNatives.length) {
    console.log(`  stripped office natives: ${strippedOfficeNatives.join(', ')}`)
  }

  if (!wantArchive) return

  mkdirSync(outRoot, { recursive: true })
  const useZip = forceZip || process.platform === 'win32'
  if (useZip) {
    const zipPath = join(outRoot, `yunge-dsh-${slug}.zip`)
    rmSync(zipPath, { force: true })
    // Archive contents at archive root: dsh/, optional runtime/, yunge-artifact.json
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path (Join-Path '${staged}' '*') -DestinationPath '${zipPath}' -Force`,
      ],
      { stdio: 'inherit' },
    )
    if (result.status !== 0) {
      // Fallback: tar.exe is available on modern Windows runners
      const tar = spawnSync('tar', ['-a', '-cf', zipPath, '-C', staged, '.'], { stdio: 'inherit' })
      if (tar.status !== 0) die(`zip failed for ${slug}`)
    }
    console.log(`stage-yunge-dsh-artifact: archive ${zipPath}`)
  } else {
    const tgzPath = join(outRoot, `yunge-dsh-${slug}.tgz`)
    rmSync(tgzPath, { force: true })
    const tar = spawnSync('tar', ['-czf', tgzPath, '-C', staged, '.'], { stdio: 'inherit' })
    if (tar.status !== 0) die(`tar failed for ${slug}`)
    console.log(`stage-yunge-dsh-artifact: archive ${tgzPath}`)
  }
}

main()
