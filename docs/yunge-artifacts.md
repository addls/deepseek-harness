# Yunge DSH artifacts (云歌 `DSH_AGENT_ARTIFACT`)

GitHub Actions workflow: [`.github/workflows/yunge-dsh-artifacts.yml`](../.github/workflows/yunge-dsh-artifacts.yml).

Builds **unsigned** runtime trees for 云歌 PC embedding — **not** signed Desktop DMG/EXE installers. Each archive’s root layout is:

```text
dsh/                         # required
runtime/primary-runtime/     # only with stage --with-office (Office / independent Node)
yunge-artifact.json          # metadata (platform/arch/slug)
```


## Slim by default (云歌)

Stage **omits** `runtime/primary-runtime` / `office-skills` and **strips** `@deepseek-ai/libreoffice-kit*` (+ `dsh-skill-office`, `dsh-office-to-pdf`) unless you pass `--with-office`.

Linux slim packer defaults to `--skip-primary-runtime`; use `--with-office` when an Office-capable linux artifact is needed.

云歌 Host keeps Office off unless `LINGXIN_DSH_ENABLE_OFFICE=1`, so slim artifacts are the normal Release pin.


## Targets

| Target | Runner | Method | Archive slug |
|--------|--------|--------|--------------|
| `mac-arm64` | `macos-15` (Apple Silicon) | Official Desktop `package-target … --dir --unsigned` | `darwin-arm64` |
| `mac-x64` | `macos-15-intel` | Same | `darwin-x64` |
| `win-x64` | `windows-latest` | Same | `win32-x64` |
| `linux-x64` | `ubuntu-latest` | **Workspace slim** (`scripts/pack-yunge-linux-slim.ts`) — **not** official Desktop Linux | `linux-x64` |
| `linux-arm64` | `ubuntu-24.04-arm` | Same slim packer on native arm64 Linux (UOS 鲲鹏/飞腾) | `linux-arm64` |

Official Desktop packaging only allows `mac-arm64` / `mac-x64` / `win-x64`. Linux for UOS (云歌方案 A) is a curated workspace snapshot: local pack of the dsh family + desktop-host + vendor + landlock → npm install into a real `node_modules` tree → optional `primary-runtime` when `--with-office`. Slim must run on a **matching Linux arch** host (`linux-x64` / `linux-arm64`); do not cross-copy trees across arch. Some Win/Mac-only natives may be absent; that is expected degradation for UOS.

## How to run

**Tag push only** — no `workflow_dispatch`, no branch/PR builds.

Push a tag matching `yunge-dsh-v*` (preferred; 云歌 pins this) or `dsh-v*`:

```bash
git tag yunge-dsh-v1.0.1
git push origin yunge-dsh-v1.0.1
```

That starts **Yunge DSH artifacts**, builds all five targets (`mac-arm64`, `mac-x64`, `win-x64`, `linux-x64`, `linux-arm64`), uploads Actions artifacts `yunge-dsh-<slug>`, and attaches archives to a GitHub Release for that tag (creating the release if needed). Download `.tgz` (mac/linux) or `.zip` (windows) from the Release or the Actions run.

## Use with 云歌 (lingxin)

```bash
# 1) Download & extract so the folder path contains the platform-arch slug
mkdir -p ~/dsh-artifacts && cd ~/dsh-artifacts
# example: yunge-dsh-darwin-arm64.tgz → ./darwin-arm64/{dsh,runtime,...}
mkdir -p darwin-arm64 && tar -xzf yunge-dsh-darwin-arm64.tgz -C darwin-arm64

# 2) Point 云歌 prepare at that root (must contain dsh/)
export DSH_AGENT_ARTIFACT="$HOME/dsh-artifacts/darwin-arm64"

# 3) In lingxin client/desktop
cd /path/to/lingxin/client/desktop
npm run prepare:dsh-agent          # or package:mac:prod / package:win:prod / package:linux:uos:prod
```

Path slug (`darwin-arm64` / `win32-x64` / `linux-x64` / `linux-arm64`) satisfies 云歌 pack gates when `dsh-agent.lock.json` is absent. Prefer matching host OS/arch when preparing and packaging.

### Local harness equivalents

```bash
# Mac / Win (on matching host) — same tree Actions archives:
pnpm exec tsx apps/desktop/scripts/package-target.ts mac-x64 --dir --unsigned
# → apps/desktop/.desktop-build/targets/mac-x64/{dsh,runtime}

# Linux slim (must run on Linux same arch). Prefer a distinct --out-root so Stage
# does not restage from the same path (workflow uses dist/yunge-artifacts/_raw):
pnpm exec tsx scripts/pack-yunge-linux-slim.ts --out-root dist/yunge-artifacts/_raw
# → dist/yunge-artifacts/_raw/linux-<host-arch>/{dsh,runtime?}
# CI: linux-x64 on ubuntu-latest; linux-arm64 on ubuntu-24.04-arm.

# Stage + archive (safe even if --from equals out-root/<slug>; uses a temp copy):
node scripts/stage-yunge-dsh-artifact.mjs \
  --from dist/yunge-artifacts/_raw/linux-x64 \
  --slug linux-x64 \
  --archive
# arm64 host example:
#   --from dist/yunge-artifacts/_raw/linux-arm64 --slug linux-arm64 --archive
# Mac/Win example:
#   --from apps/desktop/.desktop-build/targets/mac-x64 --slug darwin-x64 --archive
```

## Signing

These trees are produced with `DSH_DESKTOP_UNSIGNED=1` / `--unsigned`. They do **not** need Apple or Microsoft code-signing certificates. 云歌’s own installer signing remains separate.

## CI notes

- **Stage argv (macOS):** the Stage step keeps flags in a non-empty bash array before `"${args[@]}"`. An empty `extra=()` plus `set -u` fails on macOS runners (`extra[@]: unbound variable`).
- **Linux source path:** slim pack writes `dist/yunge-artifacts/_raw/<slug>` so Stage can wipe `dist/yunge-artifacts/<slug>` without self-deleting. The stage script also temp-copies when `--from` overlaps the stage dir.
- **Windows `prepare:packages`:** Desktop package-set reading uses `scripts/release/tarball.ts` (`tar` beside the `.tgz` via `cwd` + basename) so GNU tar on `windows-latest` does not treat `D:\…` as a remote host. Official `windows-package.yml` runs on self-hosted runners and did not surface this path.
- **pnpm cache key:** includes `matrix.slug` so `linux-x64` and `linux-arm64` do not share native module caches.
