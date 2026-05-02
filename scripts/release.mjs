#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const tauriConfigPath = join(repoRoot, 'src-tauri', 'tauri.conf.json')
const cargoManifestPath = join(repoRoot, 'src-tauri', 'Cargo.toml')
const localDir = join(repoRoot, '.local')
const defaultReleaseTree = 'releases/squirreldisk'
const defaultReleaseOwnerNpub = 'npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm'

class SkipStepError extends Error {}

function usage() {
  console.log(`Usage: node scripts/release.mjs [options]

Build SquirrelDisk desktop release artifacts, stage a git.iris.to-compatible
hashtree release directory, and optionally publish it.

Options:
  --publish                 Publish the staged tree with htree
  --dry-run                 Print the plan without running build or publish commands
  --skip-verify            Skip npm/cargo verification
  --allow-dirty            Allow releasing from a dirty git tree
  --allow-partial          Publish even if a platform build fails
  --tag <tag>              Release tag (defaults to src-tauri/tauri.conf.json version)
  --release-tree <name>    htree release tree name (default: releases/squirreldisk)
  --owner-npub <npub>      Owner npub for the printed git.iris.to release URL
  --stage-dir <path>       Directory for staged release metadata
  --artifacts-dir <path>   Directory for collected build artifacts
  --only <csv>             Limit steps to verify,macos,linux,windows
  --skip <csv>             Skip steps by name
  --help                   Show this help

Environment:
  SQD_RELEASE_TREE
  SQD_RELEASE_OWNER_NPUB
  SQD_RELEASE_ALLOW_DIRTY
  SQD_RELEASE_ALLOW_PARTIAL
  SQD_MACOS_TARGET         Default: host macOS architecture
  SQD_LINUX_TARGET         Default: host Linux architecture in Docker
  SQD_LINUX_DOCKER_IMAGE   Default: squirreldisk-tauri-linux-release:<arch>
  SQD_PDU_VERSION          Default: 0.23.0
  SQD_WINDOWS_VM_NAME
  SQD_WINDOWS_SHARED_REPO_PATH
`)
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function normalizeTag(value) {
  const tag = String(value || '').trim()
  if (!tag) {
    throw new Error('Release tag must not be empty')
  }
  return tag.startsWith('v') ? tag : `v${tag}`
}

function envFlagEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim())
}

function parseArgs(argv) {
  const options = {
    publish: false,
    dryRun: false,
    skipVerify: false,
    allowDirty: false,
    allowPartial: false,
    tag: null,
    releaseTree: null,
    ownerNpub: null,
    stageDir: null,
    artifactsDir: null,
    only: null,
    skip: new Set(),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '-h':
      case '--help':
      case 'help':
        usage()
        process.exit(0)
      case '--publish':
        options.publish = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--skip-verify':
        options.skipVerify = true
        break
      case '--allow-dirty':
        options.allowDirty = true
        break
      case '--allow-partial':
        options.allowPartial = true
        break
      case '--tag':
        options.tag = normalizeTag(argv[++index] ?? '')
        break
      case '--release-tree':
        options.releaseTree = argv[++index] ?? ''
        break
      case '--owner-npub':
        options.ownerNpub = argv[++index] ?? ''
        break
      case '--stage-dir':
        options.stageDir = resolve(repoRoot, argv[++index] ?? '')
        break
      case '--artifacts-dir':
        options.artifactsDir = resolve(repoRoot, argv[++index] ?? '')
        break
      case '--only':
        options.only = new Set(splitCsv(argv[++index] ?? ''))
        break
      case '--skip':
        for (const value of splitCsv(argv[++index] ?? '')) {
          options.skip.add(value)
        }
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function quote(arg) {
  const value = String(arg)
  return /[^\w./:=@%+-]/.test(value) ? JSON.stringify(value) : value
}

function run(command, args, { cwd = repoRoot, env = process.env, capture = false, dryRun = false } = {}) {
  const rendered = [command, ...args].map(quote).join(' ')
  console.log(`$ ${rendered}`)
  if (dryRun) {
    return ''
  }

  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  })

  if (result.status !== 0) {
    const stderr = capture ? result.stderr.trim() : ''
    throw new Error(stderr || `${command} exited with status ${result.status ?? 'unknown'}`)
  }

  return capture ? result.stdout.trim() : ''
}

function runWithInput(command, args, input, { cwd = repoRoot, dryRun = false } = {}) {
  const rendered = [command, ...args].map(quote).join(' ')
  console.log(`$ ${rendered}`)
  if (dryRun) {
    return ''
  }

  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  })

  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`)
  }

  return ''
}

function commandExists(command) {
  const result =
    process.platform === 'win32'
      ? spawnSync('where', [command], { stdio: 'ignore' })
      : spawnSync('sh', ['-lc', `command -v ${JSON.stringify(command)}`], { stdio: 'ignore' })

  return result.status === 0
}

function readTauriConfig() {
  return JSON.parse(readFileSync(tauriConfigPath, 'utf8'))
}

function readDefaultTag() {
  return normalizeTag(readTauriConfig().version)
}

function shouldRunStep(name, options) {
  if (options.skip.has(name)) {
    return false
  }
  return !options.only || options.only.has(name)
}

function defaultMacosTarget(env) {
  if (env.SQD_MACOS_TARGET) {
    return env.SQD_MACOS_TARGET
  }
  return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
}

function archLabel(target) {
  if (target === 'universal-apple-darwin') return 'universal'
  if (target.startsWith('aarch64-')) return 'arm64'
  if (target.startsWith('x86_64-')) return 'x64'
  return target.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function cargoTargetRoot(env, fallbackRoot = repoRoot) {
  return env.CARGO_TARGET_DIR ? resolve(fallbackRoot, env.CARGO_TARGET_DIR) : join(fallbackRoot, 'src-tauri', 'target')
}

function walkFiles(root) {
  if (!existsSync(root)) {
    return []
  }

  const result = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      result.push(...walkFiles(path))
    } else if (entry.isFile()) {
      result.push(path)
    }
  }
  return result
}

function newestFile(paths) {
  return paths
    .filter((path) => existsSync(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] ?? null
}

function copyAsset(sourcePath, targetDir, targetName) {
  mkdirSync(targetDir, { recursive: true })
  const targetPath = join(targetDir, targetName)
  copyFileSync(sourcePath, targetPath)
  return targetPath
}

function fileExt(path) {
  if (path.endsWith('.app.tar.gz')) return '.app.tar.gz'
  if (path.endsWith('.tar.gz')) return '.tar.gz'
  return extname(path)
}

function collectNewestByExt({ sourceDir, artifactDir, tag, platform, arch, extensions, builtLines }) {
  const files = walkFiles(sourceDir)
  const assets = []

  for (const extension of extensions) {
    const sourcePath = newestFile(files.filter((path) => path.endsWith(extension)))
    if (!sourcePath) {
      continue
    }

    const targetName = `squirreldisk-${tag}-${platform}-${arch}${extension}`
    assets.push(copyAsset(sourcePath, artifactDir, targetName))
    builtLines.push(`${platform} ${arch} artifact: ${targetName}`)

    const sigPath = `${sourcePath}.sig`
    if (existsSync(sigPath)) {
      assets.push(copyAsset(sigPath, artifactDir, `${targetName}.sig`))
    }
  }

  return assets
}

function runVerify({ dryRun, builtLines }) {
  run('npm', ['test'], { dryRun })
  run('npm', ['run', 'build'], { dryRun })
  run('cargo', ['test', '--manifest-path', cargoManifestPath], { dryRun })
  builtLines.push('Ran npm test, npm run build, and cargo test for src-tauri.')
}

function buildMacosArtifacts({ env, tag, artifactDir, dryRun, builtLines }) {
  if (process.platform !== 'darwin') {
    throw new SkipStepError('macOS artifacts are only built on Darwin hosts.')
  }

  const target = defaultMacosTarget(env)
  let buildError = null
  try {
    run('npm', ['run', 'tauri', '--', 'build', '--target', target, '--bundles', 'app,dmg', '--ci'], {
      dryRun,
    })
  } catch (error) {
    buildError = error
  }

  const targetDir = join(cargoTargetRoot(env), target, 'release', 'bundle')
  const assets = collectNewestByExt({
    sourceDir: targetDir,
    artifactDir,
    tag,
    platform: 'macos',
    arch: archLabel(target),
    extensions: ['.dmg', '.app.tar.gz'],
    builtLines,
  })

  if (assets.length === 0) {
    if (buildError) {
      throw buildError
    }
    throw new SkipStepError(`macOS build completed but no bundle artifacts were found in ${targetDir}.`)
  }

  if (buildError) {
    builtLines.push(`macOS Tauri build exited after producing bundles: ${buildError.message}`)
  }

  return assets
}

function defaultLinuxTarget(env) {
  if (env.SQD_LINUX_TARGET) {
    return env.SQD_LINUX_TARGET
  }
  return process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
}

function linuxDockerPlatform(target) {
  if (target.startsWith('aarch64-')) return 'linux/arm64'
  return 'linux/amd64'
}

function linuxDockerfile(target) {
  return `FROM node:22-bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \\
  && apt-get install -y --no-install-recommends \\
    ca-certificates \\
    curl \\
    build-essential \\
    pkg-config \\
    libssl-dev \\
    libgtk-3-dev \\
    libwebkit2gtk-4.1-dev \\
    libayatana-appindicator3-dev \\
    librsvg2-dev \\
    patchelf \\
    file \\
    xz-utils \\
  && rm -rf /var/lib/apt/lists/*
ENV CARGO_HOME=/usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup
ENV PATH=/usr/local/cargo/bin:$PATH
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal --default-toolchain stable \\
  && rustup target add ${target} \\
  && chmod -R a+rwx /usr/local/cargo /usr/local/rustup
`
}

function ensureLinuxDockerImage({ env, target, platform, dryRun }) {
  const image = env.SQD_LINUX_DOCKER_IMAGE || `squirreldisk-tauri-linux-release:${archLabel(target)}`
  runWithInput('docker', ['build', '--platform', platform, '-t', image, '-'], linuxDockerfile(target), {
    cwd: repoRoot,
    dryRun,
  })
  return image
}

function createCleanWorktree({ dryRun }) {
  const worktreeParent = join(localDir, 'worktrees')
  mkdirSync(worktreeParent, { recursive: true })
  const tempDir = mkdtempSync(join(worktreeParent, 'linux-x64-'))
  rmSync(tempDir, { recursive: true, force: true })
  run('git', ['worktree', 'add', '--detach', tempDir, 'HEAD'], { dryRun })
  return tempDir
}

function removeWorktree(path, { dryRun }) {
  if (!path || dryRun) {
    return
  }
  run('git', ['worktree', 'remove', '--force', path], { dryRun })
}

function buildLinuxArtifacts({ env, tag, artifactDir, dryRun, builtLines }) {
  const target = defaultLinuxTarget(env)
  const arch = archLabel(target)

  if (process.platform === 'linux') {
    let buildError = null
    try {
      run('npm', ['run', 'tauri', '--', 'build', '--target', target, '--ci'], {
        dryRun,
      })
    } catch (error) {
      buildError = error
    }
    const targetDir = join(cargoTargetRoot(env), target, 'release', 'bundle')
    const assets = collectNewestByExt({
      sourceDir: targetDir,
      artifactDir,
      tag,
      platform: 'linux',
      arch,
      extensions: ['.deb', '.AppImage', '.rpm'],
      builtLines,
    })
    if (assets.length === 0) {
      if (buildError) {
        throw buildError
      }
      throw new SkipStepError(`Linux build completed but no bundle artifacts were found in ${targetDir}.`)
    }
    if (buildError) {
      builtLines.push(`Linux Tauri build exited after producing bundles: ${buildError.message}`)
    }
    return assets
  }

  if (!commandExists('docker')) {
    throw new SkipStepError('Linux artifacts require either a Linux host or Docker.')
  }

  const platform = linuxDockerPlatform(target)
  const image = ensureLinuxDockerImage({ env, target, platform, dryRun })
  const worktree = createCleanWorktree({ dryRun })
  try {
    const uid = String(process.getuid?.() ?? 1000)
    const gid = String(process.getgid?.() ?? 1000)
    const pduVersion = env.SQD_PDU_VERSION || '0.23.0'
    const dockerScript = [
      'set -Eeuo pipefail',
      '. /usr/local/cargo/env',
      'npm ci',
      `if [ ${JSON.stringify(target)} = "aarch64-unknown-linux-gnu" ] && [ ! -x src-tauri/bin/pdu-aarch64-unknown-linux-gnu ]; then`,
      `  cargo install parallel-disk-usage --version ${JSON.stringify(pduVersion)} --root /tmp/pdu-root`,
      '  cp /tmp/pdu-root/bin/pdu src-tauri/bin/pdu-aarch64-unknown-linux-gnu',
      'fi',
      `npm run tauri -- build --target ${target} --ci`,
    ].join('\n')

    let buildError = null
    try {
      run(
        'docker',
        [
          'run',
          '--rm',
          '--platform',
          platform,
          '--user',
          `${uid}:${gid}`,
          '-e',
          'HOME=/tmp/squirreldisk-home',
          '-v',
          `${worktree}:/work`,
          '-w',
          '/work',
          image,
          'bash',
          '-lc',
          dockerScript,
        ],
        { dryRun },
      )
    } catch (error) {
      buildError = error
    }

    const targetDir = join(worktree, 'src-tauri', 'target', target, 'release', 'bundle')
    const assets = collectNewestByExt({
      sourceDir: targetDir,
      artifactDir,
      tag,
      platform: 'linux',
      arch,
      extensions: ['.deb', '.AppImage', '.rpm'],
      builtLines,
    })

    if (assets.length === 0) {
      if (buildError) {
        throw buildError
      }
      throw new SkipStepError(`Linux build completed but no bundle artifacts were found in ${targetDir}.`)
    }

    if (buildError) {
      builtLines.push(`Linux Tauri build exited after producing bundles: ${buildError.message}`)
    }

    return assets
  } finally {
    removeWorktree(worktree, { dryRun })
  }
}

function defaultSharedWindowsRepoPath() {
  if (process.platform !== 'darwin') {
    return null
  }

  const homeDir = os.homedir()
  if (!repoRoot.startsWith(`${homeDir}/`)) {
    return null
  }

  const relative = repoRoot.slice(homeDir.length + 1).split('/').join('\\')
  return `C:\\Mac\\Home\\${relative}`
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function encodePowerShellScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function runWindowsPowerShell(vmName, script, { dryRun = false } = {}) {
  const encoded = encodePowerShellScript(script)
  return run(
    'prlctl',
    ['exec', vmName, '--current-user', 'powershell.exe', '-NoProfile', '-EncodedCommand', encoded],
    { dryRun },
  )
}

function autoDetectWindowsVmName(prlctlListOutput) {
  const candidates = []
  for (const line of prlctlListOutput.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      continue
    }

    const match = trimmed.match(/^\{[^}]+\}\s+(\S+)\s+\S+\s+(.+)$/)
    if (!match) {
      continue
    }

    const status = match[1].toLowerCase()
    const name = match[2].trim()
    if ((status === 'running' || status === 'suspended') && /windows/i.test(name)) {
      candidates.push(name)
    }
  }

  return candidates.length === 1 ? candidates[0] : null
}

function buildWindowsArtifacts({ env, tag, artifactDir, dryRun, builtLines }) {
  if (process.platform !== 'darwin') {
    throw new SkipStepError('Windows artifacts are only wired for macOS hosts with Parallels.')
  }
  if (!commandExists('prlctl')) {
    throw new SkipStepError('Windows artifacts require prlctl.')
  }

  const sharedRepoPath = env.SQD_WINDOWS_SHARED_REPO_PATH || defaultSharedWindowsRepoPath()
  if (!sharedRepoPath) {
    throw new SkipStepError('Windows shared repo path could not be derived; set SQD_WINDOWS_SHARED_REPO_PATH.')
  }

  const vmName =
    env.SQD_WINDOWS_VM_NAME ||
    autoDetectWindowsVmName(run('prlctl', ['list', '-a'], { capture: true, dryRun }))
  if (!vmName) {
    throw new SkipStepError('No unique running Windows VM was detected; set SQD_WINDOWS_VM_NAME.')
  }

  const rawOutDir = join(artifactDir, 'windows-raw')
  rmSync(rawOutDir, { recursive: true, force: true })
  mkdirSync(rawOutDir, { recursive: true })
  const sharedRawOutDir = `${sharedRepoPath}\\.local\\release-artifacts\\${tag}\\windows-raw`

  let buildError = null
  try {
    runWindowsPowerShell(
      vmName,
      `
$ErrorActionPreference = 'Stop'
$sharedRepo = ${psQuote(sharedRepoPath)}
$guestRepo = Join-Path $env:USERPROFILE 'src\\squirreldisk'
$guestRoot = Split-Path $guestRepo
New-Item -ItemType Directory -Force -Path $guestRoot | Out-Null
$skipRelDirs = @('node_modules', 'dist', 'dist-ssr', '.git', '.local', 'src-tauri\\target')
$skipDirs = @()
foreach ($relDir in $skipRelDirs) {
  $skipDirs += (Join-Path $sharedRepo $relDir)
  $skipDirs += (Join-Path $guestRepo $relDir)
}
robocopy $sharedRepo $guestRepo /MIR /NFL /NDL /NJH /NJS /NC /NS /NP /XD $skipDirs /XF .DS_Store | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) { throw "robocopy failed with code $rc" }
Set-Location $guestRepo
rustup target add x86_64-pc-windows-msvc | Out-Null
npm.cmd ci
npm.cmd run tauri -- build --target x86_64-pc-windows-msvc --ci
$bundleRoot = Join-Path $guestRepo 'src-tauri\\target\\x86_64-pc-windows-msvc\\release\\bundle'
if (!(Test-Path $bundleRoot)) { throw "Missing bundle output at $bundleRoot" }
$sharedOut = ${psQuote(sharedRawOutDir)}
New-Item -ItemType Directory -Force -Path $sharedOut | Out-Null
Get-ChildItem $bundleRoot -Recurse -File -Include '*.exe','*.msi','*.zip','*.sig' | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $sharedOut $_.Name) -Force
}
`,
      { dryRun },
    )
  } catch (error) {
    buildError = error
  }

  const assets = collectNewestByExt({
    sourceDir: rawOutDir,
    artifactDir,
    tag,
    platform: 'windows',
    arch: 'x64',
    extensions: ['.exe', '.msi', '.zip'],
    builtLines,
  })

  rmSync(rawOutDir, { recursive: true, force: true })

  if (assets.length === 0) {
    if (buildError) {
      throw buildError
    }
    throw new SkipStepError(`Windows build completed but no bundle artifacts were found in ${rawOutDir}.`)
  }

  if (buildError) {
    builtLines.push(`Windows Tauri build exited after producing bundles: ${buildError.message}`)
  }

  return assets
}

function checkGitClean({ allowDirty, dryRun }) {
  if (allowDirty || dryRun) {
    return
  }
  const status = run('git', ['status', '--porcelain'], { capture: true })
  if (status.trim()) {
    throw new Error('Working tree is dirty. Commit changes first or pass --allow-dirty.')
  }
}

function resolveReleaseCommit(tag, { dryRun }) {
  if (dryRun) {
    return tag
  }
  const tagged = spawnSync('git', ['rev-parse', '-q', '--verify', `${tag}^{commit}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  if (tagged.status === 0 && tagged.stdout.trim()) {
    return tagged.stdout.trim()
  }
  return run('git', ['rev-parse', 'HEAD'], { capture: true })
}

function describeAsset(name) {
  if (name.endsWith('.dmg')) return 'macOS installer'
  if (name.endsWith('.app.tar.gz')) return 'macOS updater archive'
  if (name.endsWith('.AppImage')) return 'Linux AppImage'
  if (name.endsWith('.deb')) return 'Linux Debian package'
  if (name.endsWith('.rpm')) return 'Linux RPM package'
  if (name.endsWith('.exe')) return 'Windows installer'
  if (name.endsWith('.msi')) return 'Windows MSI installer'
  if (name.endsWith('.zip')) return 'Windows portable archive'
  return name
}

function writeReleaseNotes({ tag, commit, assetPaths, builtLines, skippedLines }) {
  const lines = [
    `# SquirrelDisk ${tag}`,
    '',
    '## Downloads',
    '',
  ]

  for (const assetPath of [...assetPaths].sort((left, right) => basename(left).localeCompare(basename(right)))) {
    const name = basename(assetPath)
    lines.push(`- ${describeAsset(name)}: \`${name}\``)
  }

  lines.push('', '## Release Build', '', `- Built from commit \`${commit}\`.`)

  for (const line of builtLines) {
    lines.push(`- ${line}`)
  }

  if (skippedLines.length > 0) {
    lines.push('', '## Skipped or Not Built', '')
    for (const line of skippedLines) {
      lines.push(`- ${line}`)
    }
  }

  return `${lines.join('\n')}\n`
}

function stageRelease({ tag, commit, stageDir, assetPaths, builtLines, skippedLines, dryRun }) {
  if (assetPaths.length === 0) {
    if (dryRun) {
      console.log(`Would stage ${tag} at ${stageDir}`)
      return
    }
    throw new Error('No assets were produced; nothing to stage.')
  }

  console.log(`Staging ${tag} at ${stageDir}`)
  if (dryRun) {
    return
  }

  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(join(stageDir, 'assets'), { recursive: true })

  const stagedAssetPaths = []
  for (const assetPath of assetPaths) {
    const targetPath = join(stageDir, 'assets', basename(assetPath))
    copyFileSync(assetPath, targetPath)
    stagedAssetPaths.push(targetPath)
  }

  const createdAt = Math.floor(Date.now() / 1000)
  const assets = stagedAssetPaths
    .map((assetPath) => ({
      name: basename(assetPath),
      path: `assets/${basename(assetPath)}`,
      size: statSync(assetPath).size,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

  writeFileSync(
    join(stageDir, 'release.json'),
    `${JSON.stringify(
      {
        id: tag,
        title: tag,
        tag,
        commit,
        created_at: createdAt,
        published_at: createdAt,
        draft: false,
        prerelease: tag.includes('-'),
        notes_file: 'notes.md',
        assets,
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    join(stageDir, 'notes.md'),
    writeReleaseNotes({ tag, commit, assetPaths: stagedAssetPaths, builtLines, skippedLines }),
  )
}

function publishRelease({ stageDir, releaseTree, tag, dryRun }) {
  if (dryRun) {
    console.log(`Would publish ${tag} from ${stageDir} into ${releaseTree}`)
    return 'dry-run'
  }

  const addOutput = run('htree', ['add', stageDir], { capture: true })
  console.log(addOutput)
  const match = addOutput.match(/^\s*(?:url|cid):\s*(\S+)/m)
  if (!match) {
    throw new Error('Could not parse htree add output for release CID.')
  }

  const cid = match[1]
  run('htree', ['release', 'publish', releaseTree, tag, cid])
  return cid
}

function resolveOwnerNpub(env, explicitOwner, { dryRun }) {
  if (explicitOwner) return explicitOwner
  if (env.SQD_RELEASE_OWNER_NPUB) return env.SQD_RELEASE_OWNER_NPUB
  if (!dryRun && commandExists('htree')) {
    const output = run('htree', ['user'], { capture: true })
    const match = output.match(/^(npub1[023456789acdefghjklmnpqrstuvwxyz]+)\s+\(self\)/m)
    if (match) {
      return match[1]
    }
  }
  return defaultReleaseOwnerNpub
}

function releasePageUrl(ownerNpub, repoName, tag = null) {
  const params = new URLSearchParams()
  params.set('tab', 'releases')
  if (tag) {
    params.set('id', tag)
  }
  return `https://git.iris.to/#/${ownerNpub}/${repoName}?${params.toString()}`
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const env = process.env
  const tag = options.tag || readDefaultTag()
  const releaseTree = options.releaseTree || env.SQD_RELEASE_TREE || defaultReleaseTree
  const ownerNpub = resolveOwnerNpub(env, options.ownerNpub, { dryRun: options.dryRun })
  const stageDir = options.stageDir || join(localDir, 'release', tag)
  const artifactDir = options.artifactsDir || join(localDir, 'release-artifacts', tag)
  const builtLines = []
  const skippedLines = []
  const assetPaths = []
  const allowDirty = options.allowDirty || envFlagEnabled(env.SQD_RELEASE_ALLOW_DIRTY)
  const allowPartial = options.allowPartial || envFlagEnabled(env.SQD_RELEASE_ALLOW_PARTIAL)

  console.log(`Release tag: ${tag}`)
  console.log(`Release tree: ${releaseTree}`)
  console.log(`Release page: ${releasePageUrl(ownerNpub, 'squirreldisk', tag)}`)
  if (options.dryRun) {
    console.log('Dry run mode: no build, copy, or publish commands will be executed.')
  }

  checkGitClean({ allowDirty, dryRun: options.dryRun })
  rmSync(artifactDir, { recursive: true, force: true })
  mkdirSync(artifactDir, { recursive: true })

  const steps = [
    ['verify', () => runVerify({ dryRun: options.dryRun, builtLines })],
    ['macos', () => buildMacosArtifacts({ env, tag, artifactDir, dryRun: options.dryRun, builtLines })],
    ['linux', () => buildLinuxArtifacts({ env, tag, artifactDir, dryRun: options.dryRun, builtLines })],
    ['windows', () => buildWindowsArtifacts({ env, tag, artifactDir, dryRun: options.dryRun, builtLines })],
  ]

  for (const [name, fn] of steps) {
    if ((name === 'verify' && options.skipVerify) || !shouldRunStep(name, options)) {
      skippedLines.push(`${name} skipped by CLI options.`)
      continue
    }

    try {
      const stepAssets = fn()
      if (Array.isArray(stepAssets)) {
        assetPaths.push(...stepAssets)
      }
    } catch (error) {
      if (error instanceof SkipStepError) {
        skippedLines.push(error.message)
        continue
      }
      if (name === 'verify') {
        throw error
      }
      skippedLines.push(`${name} build failed: ${error.message}`)
    }
  }

  const failedLines = skippedLines.filter((line) => line.includes(' build failed:'))
  if (failedLines.length > 0 && !allowPartial) {
    throw new Error(`Refusing to publish a partial release:\n${failedLines.join('\n')}`)
  }

  const commit = resolveReleaseCommit(tag, { dryRun: options.dryRun })
  stageRelease({
    tag,
    commit,
    stageDir,
    assetPaths,
    builtLines,
    skippedLines,
    dryRun: options.dryRun,
  })

  if (options.publish) {
    if (!commandExists('htree')) {
      throw new Error('Missing htree; cannot publish release.')
    }
    const cid = publishRelease({ stageDir, releaseTree, tag, dryRun: options.dryRun })
    console.log(`Published ${tag} to ${releaseTree} via ${cid}`)
    console.log(`Release page: ${releasePageUrl(ownerNpub, 'squirreldisk', tag)}`)
  } else {
    console.log(`Staged release at ${stageDir}`)
    console.log(`Release page after publish: ${releasePageUrl(ownerNpub, 'squirreldisk', tag)}`)
  }
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
