#!/usr/bin/env node
/**
 * Stage a Yunge-consumable DSH artifact directory and optionally archive it.
 *
 * Usage:
 *   node scripts/stage-yunge-dsh-artifact.mjs \
 *     --from <artifact-root-with-dsh> \
 *     --slug darwin-arm64|darwin-x64|win32-x64|linux-x64 \
 *     [--out-root dist/yunge-artifacts] \
 *     [--archive]
 *
 * Layout written:
 *   <out-root>/<slug>/dsh/
 *   <out-root>/<slug>/runtime/primary-runtime/   (when present in --from)
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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

function copyTree(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true, dereference: true })
}

/**
 * Materialize dsh/ (+ optional primary-runtime) from `from` into `destRoot`.
 * `destRoot` must not overlap a live source that still needs reading, or the
 * caller must have already copied through a non-overlapping temp.
 */
function materializeInto(from, destRoot) {
  const srcDsh = join(from, 'dsh')
  if (!existsSync(srcDsh)) die(`missing dsh/ under ${from}`)

  rmSync(destRoot, { recursive: true, force: true })
  mkdirSync(destRoot, { recursive: true })
  copyTree(srcDsh, join(destRoot, 'dsh'))

  const srcPrimary = join(from, 'runtime', 'primary-runtime')
  let hasPrimary = false
  if (existsSync(srcPrimary)) {
    mkdirSync(join(destRoot, 'runtime'), { recursive: true })
    copyTree(srcPrimary, join(destRoot, 'runtime', 'primary-runtime'))
    hasPrimary = true
  }
  return hasPrimary
}

function main() {
  const fromRaw = argValue('from')
  const slug = argValue('slug')
  const outRoot = resolve(ROOT, argValue('out-root') || 'dist/yunge-artifacts')
  const wantArchive = hasFlag('archive')
  const forceZip = hasFlag('zip')

  if (!fromRaw || !slug) {
    die('required: --from <dir> --slug <darwin-arm64|darwin-x64|win32-x64|linux-x64|linux-arm64>')
  }
  if (!SLUGS.has(slug)) die(`unknown slug ${slug}`)

  const from = resolve(fromRaw)
  const staged = join(outRoot, slug)
  if (!existsSync(join(from, 'dsh'))) die(`missing dsh/ under ${from}`)

  let hasPrimary
  // Overlap: wiping `staged` would delete the live --from (same path or parent).
  if (isSameOrInside(from, staged)) {
    const tmp = mkdtempSync(join(tmpdir(), `yunge-stage-${slug}-`))
    try {
      hasPrimary = materializeInto(from, tmp)
      rmSync(staged, { recursive: true, force: true })
      mkdirSync(dirname(staged), { recursive: true })
      cpSync(tmp, staged, { recursive: true, dereference: true })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } else {
    hasPrimary = materializeInto(from, staged)
  }

  const [platform, arch] = slug.split('-')
  const meta = {
    schemaVersion: 1,
    kind: 'yunge-dsh-artifact',
    slug,
    platform,
    arch,
    dshVersion: readVersion(),
    hasPrimaryRuntime: hasPrimary,
    preparedAt: new Date().toISOString(),
    source: from,
  }
  writeFileSync(join(staged, 'yunge-artifact.json'), `${JSON.stringify(meta, null, 2)}\n`)

  console.log(`stage-yunge-dsh-artifact: staged ${staged}`)
  console.log(`  dsh/=yes primary-runtime=${hasPrimary ? 'yes' : 'no'}`)

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
