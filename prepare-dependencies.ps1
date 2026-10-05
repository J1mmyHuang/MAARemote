# ============================================================================
# MAARemote 依赖准备（首次使用优化）
# ----------------------------------------------------------------------------
# 用法：pwsh -NoProfile -File prepare-dependencies.ps1 -ServerDir <server目录>
# 成功退出码：0。依赖安装失败时保留 npm 退出码；其他失败使用明确非零码。
# 成功标记只在 npm 准备和 Node 加载检查均通过后写入 server/.maaremote-deps-state.json。
# ============================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ServerDir,

    [ValidateRange(1, 3600)]
    [int]$LockTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

function New-DependencyResult {
    param(
        [bool]$Success,
        [int]$ExitCode,
        [string]$Message = ''
    )
    [pscustomobject]@{
        Success   = $Success
        ExitCode  = $ExitCode
        Message   = $Message
    }
}

function Get-FullPathSafe {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        return [IO.Path]::GetFullPath($Path)
    } catch {
        return $null
    }
}

function Get-TextSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    } catch {
        return $null
    }
}

function Get-ManifestSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$PackagePath,
        [Parameter(Mandatory = $true)][string]$LockPath
    )

    if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
        return New-DependencyResult -Success $false -ExitCode 66 -Message "未找到清单 $PackagePath。"
    }
    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
        return New-DependencyResult -Success $false -ExitCode 66 -Message "未找到锁文件 $LockPath。"
    }

    try {
        # 两份清单都保留为 Hashtable，便于明确区分 JSON null、数组和对象结构。
        $packageJson = Get-Content -LiteralPath $PackagePath -Raw -Encoding UTF8 -ErrorAction Stop
        $package = $packageJson | ConvertFrom-Json -AsHashtable -ErrorAction Stop
        # npm lockfile v3 的 packages 根对象合法地包含空字符串键，必须保留为 Hashtable。
        $lockJson = Get-Content -LiteralPath $LockPath -Raw -Encoding UTF8 -ErrorAction Stop
        $lock = $lockJson | ConvertFrom-Json -AsHashtable -ErrorAction Stop
    } catch {
        return New-DependencyResult -Success $false -ExitCode 65 -Message ("package.json 或 package-lock.json 不是有效 JSON：{0}" -f $_.Exception.Message)
    }

    if ($packageJson.Trim() -eq 'null') {
        return New-DependencyResult -Success $false -ExitCode 65 -Message 'package.json 的 JSON 顶层为 null，必须是包含 dependencies 对象的 JSON 对象。'
    }
    if ($null -eq $package) {
        return New-DependencyResult -Success $false -ExitCode 65 -Message 'package.json 的 JSON 顶层结构无效，必须是 JSON 对象。'
    }
    if ($package -isnot [System.Collections.IDictionary]) {
        return New-DependencyResult -Success $false -ExitCode 65 -Message 'package.json 的 JSON 顶层结构无效，必须是 JSON 对象。'
    }
    if (-not $package.ContainsKey('dependencies')) {
        return New-DependencyResult -Success $false -ExitCode 65 -Message 'package.json 缺少 dependencies 根字段。'
    }
    if ($null -eq $package['dependencies'] -or $package['dependencies'] -isnot [System.Collections.IDictionary]) {
        return New-DependencyResult -Success $false -ExitCode 65 -Message 'package.json 的 dependencies 必须是 JSON 对象，不能为 null 或其他类型。'
    }

    if ($lockJson.Trim() -eq 'null') {
        return New-DependencyResult -Success $false -ExitCode 65 -Message 'package-lock.json 的 JSON 顶层为 null，必须是包含 lockfileVersion 与 packages 的 JSON 对象。'
    }
    if ($null -eq $lock) {
        return New-DependencyResult -Success $false -ExitCode 65 -Message 'package-lock.json 的 JSON 顶层结构无效，必须是 JSON 对象。'
    }
    if ($lock -isnot [System.Collections.IDictionary]) {
        return New-DependencyResult -Success $false -ExitCode 65 -Message 'package-lock.json 的 JSON 顶层结构无效，必须是 JSON 对象。'
    }
    $lockfileVersion = 0
    if (-not $lock.ContainsKey('lockfileVersion') -or
        -not [int]::TryParse([string]$lock['lockfileVersion'], [ref]$lockfileVersion) -or
        $lockfileVersion -lt 1) {
        return New-DependencyResult -Success $false -ExitCode 65 -Message 'package-lock.json 缺少有效的 lockfileVersion。'
    }
    if (-not $lock.ContainsKey('packages') -or $null -eq $lock['packages'] -or
        $lock['packages'] -isnot [System.Collections.IDictionary] -or
        -not $lock['packages'].ContainsKey('')) {
        return New-DependencyResult -Success $false -ExitCode 65 -Message 'package-lock.json 缺少有效的 packages 根结构（必须是包含空字符串根键的 JSON 对象）。'
    }

    $packageHash = Get-TextSha256 -Path $PackagePath
    $lockHash = Get-TextSha256 -Path $LockPath
    if (-not $packageHash -or -not $lockHash) {
        return New-DependencyResult -Success $false -ExitCode 66 -Message '无法读取 package.json 或 package-lock.json 的内容哈希。'
    }
    $fingerprintInput = [Text.Encoding]::UTF8.GetBytes("$packageHash`n$lockHash")
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $manifestHash = (($sha.ComputeHash($fingerprintInput) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        $sha.Dispose()
    }

    [pscustomobject]@{
        Success             = $true
        PackageHash         = $packageHash
        LockHash            = $lockHash
        ManifestHash        = $manifestHash
        PackagePath         = $PackagePath
        LockPath            = $LockPath
    }
}

function Get-NodeRuntime {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) {
        return New-DependencyResult -Success $false -ExitCode 126 -Message '未找到 node 命令，请先安装 Node.js ≥18。'
    }

    try {
        $versionOutput = (& node --version 2>&1 | Out-String).Trim()
        $versionExitCode = $LASTEXITCODE
        $abiOutput = (& node -p 'process.versions.modules' 2>&1 | Out-String).Trim()
        $abiExitCode = $LASTEXITCODE
    } catch {
        return New-DependencyResult -Success $false -ExitCode 126 -Message ("无法执行 node 运行时检查：{0}" -f $_.Exception.Message)
    }
    $versionMatch = [regex]::Match($versionOutput, '^v(\d+)(?:\.\d+){0,2}')
    if ($versionExitCode -ne 0 -or $abiExitCode -ne 0 -or -not $versionMatch.Success) {
        return New-DependencyResult -Success $false -ExitCode 126 -Message ("node 运行时检查失败：{0}" -f $versionOutput)
    }

    $nodeMajor = 0
    [void][int]::TryParse($versionMatch.Groups[1].Value, [ref]$nodeMajor)
    if ($nodeMajor -lt 18) {
        return New-DependencyResult -Success $false -ExitCode 126 -Message ("检测到 Node {0}，本项目要求 Node.js ≥18。" -f $versionOutput.TrimStart('v'))
    }
    if ($abiOutput -notmatch '^\d+$') {
        return New-DependencyResult -Success $false -ExitCode 126 -Message ("无法读取当前 Node ABI：{0}" -f $abiOutput)
    }

    [pscustomobject]@{
        Success     = $true
        NodeVersion = $versionOutput
        NodeAbi     = $abiOutput
        NodePath    = [string]$nodeCommand.Source
    }
}

function Acquire-DependencyLock {
    param(
        [Parameter(Mandatory = $true)][string]$ServerPath,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )

    $lockPath = Join-Path $ServerPath '.maaremote-deps.lock'
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $timeoutMilliseconds = $TimeoutSeconds * 1000
    while ($true) {
        try {
            # 以 server 目录内固定文件作为物理锁；只释放句柄，锁文件本身保留。
            $stream = [IO.FileStream]::new(
                $lockPath,
                [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::None
            )
            return [pscustomobject]@{
                Success  = $true
                ExitCode = 0
                Message  = ''
                Stream   = $stream
            }
        } catch [IO.IOException] {
            $remaining = $timeoutMilliseconds - [int]$stopwatch.ElapsedMilliseconds
            if ($remaining -le 0) {
                return [pscustomobject]@{
                    Success  = $false
                    ExitCode = 75
                    Message  = '等待 server 局部依赖锁超时；未并发修改依赖。'
                    Stream   = $null
                }
            }
            Start-Sleep -Milliseconds ([Math]::Min(100, $remaining))
        } catch {
            return [pscustomobject]@{
                Success  = $false
                ExitCode = 73
                Message  = ("无法打开 server 局部依赖锁：{0}" -f $_.Exception.Message)
                Stream   = $null
            }
        }
    }
}

function Read-DependencyMarker {
    param(
        [Parameter(Mandatory = $true)][string]$MarkerPath,
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$Node
    )

    if (-not (Test-Path -LiteralPath $MarkerPath)) {
        return [pscustomobject]@{ State = 'missing'; Marker = $null; Reason = '未找到成功标记。' }
    }
    if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
        return [pscustomobject]@{ State = 'unreadable'; Marker = $null; Reason = '成功标记路径不是文件。' }
    }
    try {
        $markerJson = Get-Content -LiteralPath $MarkerPath -Raw -Encoding UTF8 -ErrorAction Stop
        if ($markerJson.Trim() -eq 'null') {
            return [pscustomobject]@{ State = 'damaged'; Marker = $null; Reason = '成功标记 JSON 为 null，必须是包含完整字段的 JSON 对象。' }
        }
        $marker = $markerJson | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return [pscustomobject]@{ State = 'damaged'; Marker = $null; Reason = ("成功标记不是有效 JSON：{0}" -f $_.Exception.Message) }
    }
    if ($null -eq $marker) {
        return [pscustomobject]@{ State = 'damaged'; Marker = $null; Reason = '成功标记 JSON 顶层结构无效，必须是 JSON 对象。' }
    }
    if ($marker -is [System.Array] -or $marker -is [string] -or $marker -is [ValueType]) {
        return [pscustomobject]@{ State = 'damaged'; Marker = $marker; Reason = '成功标记顶层结构无效，必须是 JSON 对象。' }
    }
    $required = @('schema_version', 'manifest_hash', 'package_json_sha256', 'package_lock_sha256', 'node_abi', 'dependency_load_check')
    $missing = @()
    foreach ($name in $required) {
        if (-not $marker.PSObject.Properties[$name]) {
            $missing += $name
        }
    }
    if ($missing.Count -gt 0) {
        return [pscustomobject]@{ State = 'damaged'; Marker = $marker; Reason = ("成功标记缺少字段：{0}。" -f ($missing -join '、')) }
    }
    $schemaVersion = 0
    if (-not [int]::TryParse([string]$marker.schema_version, [ref]$schemaVersion)) {
        return [pscustomobject]@{ State = 'damaged'; Marker = $marker; Reason = '成功标记 schema_version 不是有效整数。' }
    }
    if ($schemaVersion -ne 1) {
        return [pscustomobject]@{ State = 'old'; Marker = $marker; Reason = '成功标记版本过旧。' }
    }
    if ([string]$marker.manifest_hash -ne [string]$Manifest.ManifestHash -or
        [string]$marker.package_json_sha256 -ne [string]$Manifest.PackageHash -or
        [string]$marker.package_lock_sha256 -ne [string]$Manifest.LockHash) {
        return [pscustomobject]@{ State = 'manifest_changed'; Marker = $marker; Reason = 'package.json 或 package-lock.json 已变化。' }
    }
    if ([string]$marker.node_abi -ne [string]$Node.NodeAbi) {
        return [pscustomobject]@{ State = 'node_abi_changed'; Marker = $marker; Reason = '当前 Node ABI 已变化。' }
    }
    if ([string]$marker.dependency_load_check -ne 'passed') {
        return [pscustomobject]@{ State = 'damaged'; Marker = $marker; Reason = '成功标记 dependency_load_check 不是 passed。' }
    }
    return [pscustomobject]@{ State = 'valid'; Marker = $marker; Reason = '成功标记校验通过。' }
}

function Invalidate-DependencyMarker {
    param([Parameter(Mandatory = $true)][string]$MarkerPath)
    if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
        return New-DependencyResult -Success $true -ExitCode 0
    }
    try {
        Remove-Item -LiteralPath $MarkerPath -Force -ErrorAction Stop
        return New-DependencyResult -Success $true -ExitCode 0
    } catch {
        return New-DependencyResult -Success $false -ExitCode 73 -Message ("无法使旧成功标记失效：{0}" -f $_.Exception.Message)
    }
}

function Test-DependencyHealth {
    param([Parameter(Mandatory = $true)][string]$ServerPath)
    $healthScript = @'
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const serverPath = process.argv[1];
if (!serverPath) throw new Error('未收到指定的 server 目录');
const nodeModulesPath = path.resolve(serverPath, 'node_modules');
if (!fs.existsSync(nodeModulesPath) || !fs.statSync(nodeModulesPath).isDirectory()) {
    throw new Error(`指定 ServerDir 缺少 node_modules：${nodeModulesPath}`);
}

const requireFromServer = createRequire(path.join(serverPath, 'package.json'));
function isWithin(root, target) {
    const relative = path.relative(root, target);
    return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function resolveLocal(packageName) {
    let resolved;
    try {
        resolved = path.resolve(requireFromServer.resolve(packageName));
    } catch (error) {
        throw new Error(`无法从指定 ServerDir 解析 ${packageName}：${error.message}`);
    }
    if (!isWithin(nodeModulesPath, resolved)) {
        throw new Error(`${packageName} 解析到了指定 ServerDir/node_modules 之外：${resolved}`);
    }
    return resolved;
}

const fastifyPath = resolveLocal('fastify');
const sqlitePath = resolveLocal('better-sqlite3');
const FastifyExport = requireFromServer('fastify');
const DatabaseExport = requireFromServer('better-sqlite3');
const Fastify = FastifyExport.default ?? FastifyExport;
const Database = DatabaseExport.default ?? DatabaseExport;
const app = Fastify();
try {
    const db = new Database(':memory:');
    try {
        const row = db.prepare('SELECT 1 AS ok').get();
        if (!row || row.ok !== 1) throw new Error('better-sqlite3 内存查询结果异常');
    } finally {
        db.close();
    }
} finally {
    await app.close();
}
console.log(`fastify=${fastifyPath}`);
console.log(`better-sqlite3=${sqlitePath}`);
'@
    try {
        Push-Location $ServerPath
        try {
            $output = (& node --input-type=module -e $healthScript -- $ServerPath 2>&1 | Out-String).Trim()
            $exitCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }
    } catch {
        return [pscustomobject]@{ Success = $false; Message = ("依赖加载检查无法执行：{0}" -f $_.Exception.Message) }
    }
    if ($exitCode -ne 0) {
        $detail = if ($output) { $output } else { 'Node 未返回诊断信息。' }
        if ($detail.Length -gt 1200) { $detail = $detail.Substring(0, 1200) }
        return [pscustomobject]@{ Success = $false; Message = ("Fastify/better-sqlite3 加载检查失败（退出码 {0}）：{1}" -f $exitCode, $detail) }
    }
    return [pscustomobject]@{ Success = $true; Message = $output }
}

function Write-DependencyMarker {
    param(
        [Parameter(Mandatory = $true)][string]$MarkerPath,
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$Node
    )
    $tempPath = '{0}.{1}.{2}.tmp' -f $MarkerPath, $PID, ([guid]::NewGuid().ToString('N'))
    $marker = [ordered]@{
        schema_version          = 1
        manifest_hash           = $Manifest.ManifestHash
        package_json_sha256     = $Manifest.PackageHash
        package_lock_sha256     = $Manifest.LockHash
        node_version            = $Node.NodeVersion
        node_abi                = $Node.NodeAbi
        dependency_load_check   = 'passed'
        prepared_at             = (Get-Date).ToUniversalTime().ToString('o')
    }
    try {
        if (Test-Path -LiteralPath $MarkerPath -PathType Container) {
            return New-DependencyResult -Success $false -ExitCode 73 -Message '成功标记路径是目录，无法写入标记文件。'
        }
        if (Test-Path -LiteralPath $MarkerPath -PathType Leaf) {
            $existing = Get-Item -LiteralPath $MarkerPath -ErrorAction Stop
            if ($existing.IsReadOnly) {
                return New-DependencyResult -Success $false -ExitCode 73 -Message '成功标记文件被设置为只读，无法安全更新。'
            }
        }
        $marker | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $tempPath -Encoding UTF8 -ErrorAction Stop
        Move-Item -LiteralPath $tempPath -Destination $MarkerPath -Force -ErrorAction Stop
        return New-DependencyResult -Success $true -ExitCode 0
    } catch {
        if (Test-Path -LiteralPath $tempPath) {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
        return New-DependencyResult -Success $false -ExitCode 73 -Message ("成功标记不可写，依赖已准备但不能确认其状态：{0}" -f $_.Exception.Message)
    }
}

function Invoke-DependencyPreparation {
    param(
        [Parameter(Mandatory = $true)][string]$ServerPath,
        [Parameter(Mandatory = $true)][string]$PackagePath,
        [Parameter(Mandatory = $true)][string]$LockPath,
        [Parameter(Mandatory = $true)][string]$MarkerPath
    )

    $node = Get-NodeRuntime
    if (-not $node.Success) {
        return New-DependencyResult -Success $false -ExitCode $node.ExitCode -Message $node.Message
    }
    $lockStream = $null
    try {
        Write-Host ("[依赖] 正在等待依赖准备锁（最多 {0} 秒）..." -f $LockTimeoutSeconds)
        $lockResult = Acquire-DependencyLock -ServerPath $ServerPath -TimeoutSeconds $LockTimeoutSeconds
        if (-not $lockResult.Success) {
            return New-DependencyResult -Success $false -ExitCode $lockResult.ExitCode -Message $lockResult.Message
        }
        $lockStream = $lockResult.Stream

        $manifest = Get-ManifestSnapshot -PackagePath $PackagePath -LockPath $LockPath
        if (-not $manifest.Success) {
            return New-DependencyResult -Success $false -ExitCode $manifest.ExitCode -Message $manifest.Message
        }
        Write-Host '[依赖] package.json 与 package-lock.json 校验通过。'

        $markerState = Read-DependencyMarker -MarkerPath $MarkerPath -Manifest $manifest -Node $node
        if ($markerState.State -eq 'valid') {
            $health = Test-DependencyHealth -ServerPath $ServerPath
            if ($health.Success) {
                Write-Host '[依赖] 已有健康依赖且清单、Node ABI 未变化，跳过 npm 准备。'
                return New-DependencyResult -Success $true -ExitCode 0
            }
            Write-Host ("[依赖] 成功标记存在，但加载检查失败，将重新准备：{0}" -f $health.Message)
            $invalidateResult = Invalidate-DependencyMarker -MarkerPath $MarkerPath
            if (-not $invalidateResult.Success) {
                return $invalidateResult
            }
            Write-Host '[依赖] 旧成功标记已作废，后续失败会保留重试机会。'
        } else {
            $reason = if ($markerState.Reason) { $markerState.Reason } else { '成功标记未通过校验。' }
            Write-Host ("[依赖] {0}正在准备依赖。" -f $reason)
        }

        $npmCommand = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $npmCommand) {
            return New-DependencyResult -Success $false -ExitCode 127 -Message '依赖需要重新准备，但未找到 npm 命令；请安装 Node.js/npm 后重试。'
        }
        Write-Host '[依赖] 正在执行 npm ci --no-fund --no-audit，请勿关闭窗口...'
        $npmExitCode = 1
        try {
            Push-Location $ServerPath
            try {
                & npm ci --no-fund --no-audit | Out-Host
                $npmExitCode = [int]$LASTEXITCODE
            } finally {
                Pop-Location
            }
        } catch {
            return New-DependencyResult -Success $false -ExitCode 1 -Message ("npm 准备过程异常：{0}" -f $_.Exception.Message)
        }
        if ($npmExitCode -ne 0) {
            return New-DependencyResult -Success $false -ExitCode $npmExitCode -Message ("npm ci 失败（退出码 {0}）；旧成功标记已作废，请修复后重试。" -f $npmExitCode)
        }

        $afterManifest = Get-ManifestSnapshot -PackagePath $PackagePath -LockPath $LockPath
        if (-not $afterManifest.Success) {
            return New-DependencyResult -Success $false -ExitCode $afterManifest.ExitCode -Message ("npm 完成后清单不可读：{0}" -f $afterManifest.Message)
        }
        if ([string]$afterManifest.ManifestHash -ne [string]$manifest.ManifestHash) {
            return New-DependencyResult -Success $false -ExitCode 78 -Message 'npm 准备过程改写了 package.json 或 package-lock.json；为避免清单漂移，拒绝写入成功标记。'
        }

        Write-Host '[依赖] 正在验证 Fastify 与 better-sqlite3 加载及原生 ABI...'
        $health = Test-DependencyHealth -ServerPath $ServerPath
        if (-not $health.Success) {
            return New-DependencyResult -Success $false -ExitCode 79 -Message ("依赖准备后仍不可用：{0}" -f $health.Message)
        }
        $writeResult = Write-DependencyMarker -MarkerPath $MarkerPath -Manifest $manifest -Node $node
        if (-not $writeResult.Success) {
            return New-DependencyResult -Success $false -ExitCode $writeResult.ExitCode -Message $writeResult.Message
        }
        Write-Host '[依赖] 准备完成，成功标记已写入。'
        return New-DependencyResult -Success $true -ExitCode 0
    } catch {
        return New-DependencyResult -Success $false -ExitCode 1 -Message ("依赖准备异常：{0}" -f $_.Exception.Message)
    } finally {
        if ($lockStream) {
            try { $lockStream.Dispose() } catch { }
        }
    }
}

$serverPath = Get-FullPathSafe -Path $ServerDir
if (-not $serverPath -or -not (Test-Path -LiteralPath $serverPath -PathType Container)) {
    Write-Host ("[依赖失败] server 目录不存在或路径无效：{0}" -f $ServerDir) -ForegroundColor Red
    exit 66
}
$packagePath = Join-Path $serverPath 'package.json'
$lockPath = Join-Path $serverPath 'package-lock.json'
$markerPath = Join-Path $serverPath '.maaremote-deps-state.json'
$result = Invoke-DependencyPreparation -ServerPath $serverPath -PackagePath $packagePath -LockPath $lockPath -MarkerPath $markerPath
if (-not $result.Success) {
    Write-Host ("[依赖失败] {0}" -f $result.Message) -ForegroundColor Red
    exit $result.ExitCode
}
exit 0
