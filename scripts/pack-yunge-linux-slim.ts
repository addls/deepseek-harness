/**
 * Materialize a Yunge-consumable **linux** DSH artifact from the workspace.
 *
 * Official Desktop packaging (`package-target`) does **not** support Linux.
 * UOS / 云歌方案 A therefore uses this workspace slim snapshot instead of a
 * Desktop `.desktop-build` target.
 *
 * Output (default):
 *   dist/yunge-artifacts/linux-<arch>/
 *     dsh/                         # required (real node_modules, no pnpm links)
 *     runtime/primary-runtime/     # best-effort; omitted if prepare fails
 *     yunge-artifact.json
 *
 * Usage (from repo root, on Linux):
 *   pnpm exec tsx scripts/pack-yunge-linux-slim.ts
 *   pnpm exec tsx scripts/pack-yunge-linux-slim.ts --skip-build
 *   pnpm exec tsx scripts/pack-yunge-linux-slim.ts --skip-primary-runtime
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { acceptsNpmPlatform } from './npm-platform.ts'
import { packedManifest } from './release/tarball.ts'
import { prepareDesktopPackageSet } from '../apps/desktop/scripts/prepare-package-set.ts'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_ROOT = join(ROOT, 'dist', 'yunge-artifacts')

function die(message: string): never {
  console.error(`pack-yunge-linux-slim: ${message}`)
  process.exit(1)
}

function run(command: string, args: readonly string[], cwd = ROOT): void {
  console.log(`pack-yunge-linux-slim: $ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, [...args], { cwd, stdio: 'inherit', env: process.env, shell: false })
  if (result.status !== 0) {
    die(`${command} ${args.join(' ')} exited ${String(result.status ?? result.signal)}`)
  }
}

function pnpm(): string {
  return process.env.PNPM_EXEC_PATH || 'pnpm'
}

function readProductVersion(): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string }
  if (typeof manifest.version !== 'string') die('root package.json has no version')
  return manifest.version
}

function assertLinuxHost(): { arch: 'x64' | 'arm64'; slug: string } {
  if (process.platform !== 'linux') {
    die(
      `refusing to run on ${process.platform}/${process.arch}. ` +
        'Official Desktop has no Linux target; this slim packer must run on a Linux host ' +
        '(ubuntu Actions runner or UOS/Linux build machine). ' +
        'Do not cross-copy darwin/win32 .desktop-build trees into a linux artifact.',
    )
  }
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    die(`unsupported linux arch ${process.arch}; need x64 or arm64`)
  }
  const arch = process.arch
  return { arch, slug: `linux-${arch}` }
}

function packWorkspace(packedRoot: string): { dsh: string; vendor: string; landlock: string } {
  const dsh = join(packedRoot, 'dsh')
  const vendor = join(packedRoot, 'vendor')
  const landlock = join(packedRoot, 'landlock')
  rmSync(packedRoot, { recursive: true, force: true })
  mkdirSync(dsh, { recursive: true })
  mkdirSync(vendor, { recursive: true })
  mkdirSync(landlock, { recursive: true })

  // Same unsigned Desktop pack inputs: local dsh family + private Host + vendor + landlock entry.
  run(pnpm(), ['exec', 'tsx', 'apps/desktop/scripts/pack-local-packages.ts', '--out', dsh])
  run(pnpm(), ['--dir', 'apps/desktop-host', 'pack', '--pack-destination', dsh])
  run(pnpm(), ['run', 'release:pack', '--family', 'vendor', '--out', vendor])
  run(pnpm(), ['--dir', 'native/system', 'run', 'build:ts'])
  run(pnpm(), [
    '--dir',
    'native/system/packages/entry',
    'pack',
    '--pack-destination',
    landlock,
  ])
  return { dsh, vendor, landlock }
}

function installFromPackageSet(
  packageSetDir: string,
  installRoot: string,
  target: { platform: NodeJS.Platform; arch: string },
): void {
  const setPath = join(packageSetDir, 'desktop-packages.json')
  const packagesDir = join(packageSetDir, 'desktop-packages')
  if (!existsSync(setPath) || !existsSync(packagesDir)) {
    die(`package set incomplete under ${packageSetDir}`)
  }
  const packageSet = JSON.parse(readFileSync(setPath, 'utf8')) as {
    packages: Array<{ name: string; version: string; file: string }>
  }

  rmSync(installRoot, { recursive: true, force: true })
  mkdirSync(installRoot, { recursive: true })

  // Prefer file: installs from the curated Desktop closure (includes @deepseek-ai/dsh + desktop-host).
  const dependencies: Record<string, string> = {}
  for (const entry of packageSet.packages) {
    const tarball = join(packagesDir, entry.file)
    if (!existsSync(tarball)) die(`missing tarball ${tarball}`)
    const manifest = packedManifest(tarball)
    const compatible =
      acceptsNpmPlatform(manifest.os as string[] | undefined, target.platform) &&
      acceptsNpmPlatform(manifest.cpu as string[] | undefined, target.arch)
    if (!compatible) continue
    dependencies[entry.name] = pathToFileURL(tarball).href
  }
  if (!dependencies['@deepseek-ai/dsh']) die('package set did not yield @deepseek-ai/dsh for linux')
  if (!dependencies['@deepseek-ai/dsh-desktop-host']) {
    die('package set did not yield @deepseek-ai/dsh-desktop-host for linux')
  }

  writeFileSync(
    join(installRoot, 'package.json'),
    `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime',
      private: true,
      version: readProductVersion(),
      type: 'module',
      dependencies,
    }, null, 2)}\n`,
  )

  // npm (not pnpm) so node_modules is a real tree without workspace symlinks — required by 云歌 pack gates.
  const npmCli = resolveNpmCli()
  const npmArgs = [
    'install',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--omit=optional',
  ]
  console.log(`pack-yunge-linux-slim: $ ${npmCli} ${npmArgs.join(' ')}`)
  const result = spawnSync(npmCli, npmArgs, {
    cwd: installRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      DSH_TELEMETRY_DISABLED: '1',
    },
    shell: false,
  })
  if (result.status !== 0) die(`npm install failed with ${String(result.status ?? result.signal)}`)

  const dshPkg = join(installRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const hostPkg = join(installRoot, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'package.json')
  if (!existsSync(dshPkg)) die('install missing @deepseek-ai/dsh')
  if (!existsSync(hostPkg)) die('install missing @deepseek-ai/dsh-desktop-host')
}

function resolveNpmCli(): string {
  const beside = join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm')
  if (existsSync(beside)) return beside
  return 'npm'
}

function materializeDsh(installRoot: string, outDsh: string): void {
  rmSync(outDsh, { recursive: true, force: true })
  mkdirSync(outDsh, { recursive: true })
  cpSync(join(installRoot, 'node_modules'), join(outDsh, 'node_modules'), {
    recursive: true,
    dereference: true,
  })
  writeFileSync(
    join(outDsh, 'package.json'),
    `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime',
      private: true,
      version: readProductVersion(),
      type: 'module',
      dependencies: JSON.parse(readFileSync(join(installRoot, 'package.json'), 'utf8')).dependencies,
      yunge: {
        kind: 'linux-slim-workspace',
        note: 'Not an official Desktop linux target; UOS/云歌方案 A workspace slim snapshot.',
      },
    }, null, 2)}\n`,
  )
}

function preparePrimaryRuntime(outRuntimeParent: string, targetName: string): boolean {
  mkdirSync(outRuntimeParent, { recursive: true })
  const args = [
    'exec',
    'tsx',
    'scripts/primary-runtime/prepare.ts',
    '--target',
    targetName,
    '--output',
    outRuntimeParent,
    '--cache',
    join(ROOT, 'dist', 'yunge-artifacts', '.cache', 'primary-runtime'),
  ]
  console.log(`pack-yunge-linux-slim: $ ${pnpm()} ${args.join(' ')}`)
  const result = spawnSync(pnpm(), args, { cwd: ROOT, stdio: 'inherit', env: process.env, shell: false })
  if (result.status !== 0) {
    console.warn(
      `pack-yunge-linux-slim: primary-runtime prepare failed (exit ${String(result.status ?? result.signal)}); ` +
        'Office / independent Node will be absent from this slim artifact.',
    )
    return false
  }
  return existsSync(join(outRuntimeParent, 'primary-runtime'))
}

function main(): void {
  const { values } = parseArgs({
    options: {
      'skip-build': { type: 'boolean', default: false },
      'skip-primary-runtime': { type: 'boolean', default: false },
      'out-root': { type: 'string' },
    },
    allowPositionals: false,
  })

  const { arch, slug } = assertLinuxHost()
  const outRoot = resolve(ROOT, values['out-root'] ?? OUT_ROOT)
  const staged = join(outRoot, slug)
  const version = readProductVersion()
  console.log(`pack-yunge-linux-slim: version=${version} slug=${slug} host=${process.platform}/${process.arch}`)

  if (!values['skip-build']) {
    // Local profile matches unsigned Desktop pack inputs (not official publication).
    run(pnpm(), ['run', 'build', '--profile', 'local'])
  }

  const packedRoot = mkdtempSync(join(tmpdir(), 'yunge-linux-packed-'))
  const installRoot = mkdtempSync(join(tmpdir(), 'yunge-linux-install-'))
  const packageSetDir = mkdtempSync(join(tmpdir(), 'yunge-linux-packageset-'))
  try {
    const packed = packWorkspace(packedRoot)
    // prepareDesktopPackageSet types Desktop as darwin|win32; linux is intentional for UOS slim.
    prepareDesktopPackageSet(
      [packed.dsh, packed.vendor, packed.landlock],
      packageSetDir,
      { platform: 'linux', arch } as unknown as { platform: 'darwin' | 'win32'; arch: 'arm64' | 'x64' },
    )
    console.log(`pack-yunge-linux-slim: package set → ${packageSetDir}`)
    installFromPackageSet(packageSetDir, installRoot, { platform: 'linux', arch })

    rmSync(staged, { recursive: true, force: true })
    mkdirSync(staged, { recursive: true })
    materializeDsh(installRoot, join(staged, 'dsh'))

    let hasPrimary = false
    if (!values['skip-primary-runtime']) {
      hasPrimary = preparePrimaryRuntime(join(staged, 'runtime'), slug)
      if (!hasPrimary) {
        rmSync(join(staged, 'runtime'), { recursive: true, force: true })
      }
    }

    const meta = {
      schemaVersion: 1,
      kind: 'yunge-dsh-artifact',
      slug,
      platform: 'linux',
      arch,
      dshVersion: version,
      hasPrimaryRuntime: hasPrimary,
      preparedAt: new Date().toISOString(),
      method: 'linux-slim-workspace',
      note: 'Workspace slim snapshot for 云歌 UOS (方案 A). Not official Desktop Linux.',
    }
    writeFileSync(join(staged, 'yunge-artifact.json'), `${JSON.stringify(meta, null, 2)}\n`)
    console.log(`pack-yunge-linux-slim: done → ${staged}`)
    console.log(`  packages in dsh/node_modules/@deepseek-ai: ${
      existsSync(join(staged, 'dsh', 'node_modules', '@deepseek-ai'))
        ? readdirSync(join(staged, 'dsh', 'node_modules', '@deepseek-ai')).length
        : 0
    }`)
  } finally {
    rmSync(packedRoot, { recursive: true, force: true })
    rmSync(installRoot, { recursive: true, force: true })
    rmSync(packageSetDir, { recursive: true, force: true })
  }
}

main()
