import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

const SCRIPT = resolve(fileURLToPath(new URL('./stage-yunge-dsh-artifact.mjs', import.meta.url)))
const roots: string[] = []

function fixture(prefix = 'yunge-stage-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function seedArtifact(root: string, marker: string, withPrimary = false): void {
  mkdirSync(join(root, 'dsh'), { recursive: true })
  writeFileSync(join(root, 'dsh', 'marker.txt'), marker)
  if (withPrimary) {
    mkdirSync(join(root, 'runtime', 'primary-runtime'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'primary-runtime', 'node'), 'fake-node')
  }
}

function runStage(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: process.env,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('stage-yunge-dsh-artifact', () => {
  it('stages from a distinct --from into out-root/slug', () => {
    const from = fixture('yunge-from-')
    const outRoot = fixture('yunge-out-')
    seedArtifact(from, 'distinct-source', true)

    const result = runStage([
      '--from', from,
      '--slug', 'linux-x64',
      '--out-root', outRoot,
    ])
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(outRoot, 'linux-x64', 'dsh', 'marker.txt'), 'utf8')).toBe('distinct-source')
    expect(existsSync(join(outRoot, 'linux-x64', 'runtime', 'primary-runtime', 'node'))).toBe(true)
    const meta = JSON.parse(readFileSync(join(outRoot, 'linux-x64', 'yunge-artifact.json'), 'utf8')) as {
      slug: string
      hasPrimaryRuntime: boolean
      hasOfficeSkills?: boolean
    }
    expect(meta.slug).toBe('linux-x64')
    expect(meta.hasPrimaryRuntime).toBe(true)
  })

  it('does not self-delete when --from equals the staged directory', () => {
    const outRoot = fixture('yunge-same-')
    const staged = join(outRoot, 'linux-x64')
    seedArtifact(staged, 'same-path-source', true)

    const result = runStage([
      '--from', staged,
      '--slug', 'linux-x64',
      '--out-root', outRoot,
      '--archive',
    ])
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(staged, 'dsh', 'marker.txt'), 'utf8')).toBe('same-path-source')
    expect(existsSync(join(staged, 'runtime', 'primary-runtime', 'node'))).toBe(true)
    expect(existsSync(join(staged, 'yunge-artifact.json'))).toBe(true)
    const tgz = join(outRoot, 'yunge-dsh-linux-x64.tgz')
    expect(existsSync(tgz)).toBe(true)
  })

  it('survives when --from is nested under the staged directory', () => {
    const outRoot = fixture('yunge-nested-')
    const staged = join(outRoot, 'linux-x64')
    const nested = join(staged, '_raw_nested')
    seedArtifact(nested, 'nested-source')

    const result = runStage([
      '--from', nested,
      '--slug', 'linux-x64',
      '--out-root', outRoot,
    ])
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(staged, 'dsh', 'marker.txt'), 'utf8')).toBe('nested-source')
    expect(existsSync(join(staged, '_raw_nested'))).toBe(false)
  })
})
