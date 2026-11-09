import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertHostSystemNative,
  hostSystemNativePackageName,
} from './pack-yunge-linux-slim.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('pack-yunge-linux-slim host system native gate', () => {
  it('names the flock platform package for the host arch', () => {
    expect(hostSystemNativePackageName('arm64')).toBe('@deepseek-ai/node-addon-system-linux-arm64')
    expect(hostSystemNativePackageName('x64')).toBe('@deepseek-ai/node-addon-system-linux-x64')
  })

  it('passes when the platform package.json is present under dsh/node_modules', () => {
    const dsh = mkdtempSync(join(tmpdir(), 'yunge-native-ok-'))
    roots.push(dsh)
    const pkgDir = join(dsh, 'node_modules', '@deepseek-ai', 'node-addon-system-linux-arm64')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), '{"name":"@deepseek-ai/node-addon-system-linux-arm64"}\n')
    expect(() => assertHostSystemNative(dsh, 'arm64')).not.toThrow()
  })

  it('exits when the platform package is missing (omit=optional regression)', () => {
    const dsh = mkdtempSync(join(tmpdir(), 'yunge-native-missing-'))
    roots.push(dsh)
    mkdirSync(join(dsh, 'node_modules', '@deepseek-ai', 'node-addon-system'), { recursive: true })
    writeFileSync(
      join(dsh, 'node_modules', '@deepseek-ai', 'node-addon-system', 'package.json'),
      '{"name":"@deepseek-ai/node-addon-system"}\n',
    )
    const spy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => assertHostSystemNative(dsh, 'arm64')).toThrow(/exit 1/)
    err.mockRestore()
    spy.mockRestore()
  })
})
