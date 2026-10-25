import { runJsonPowerShell } from "../core/exec.js";
import { asArray } from "../core/util.js";
import type {
  HotfixInfo,
  ProgramInfo,
  ServiceInfo,
  SnapshotWarning,
  StartupInfo,
  TaskInfo,
} from "../core/types.js";

type RawSystem = {
  services?: Array<{
    Name?: string;
    DisplayName?: string;
    State?: string;
    StartMode?: string;
    StartName?: string;
    PathName?: string;
  }>;
  startup?: Array<{
    scope?: string;
    name?: string;
    command?: string;
    enabled?: boolean;
  }>;
  tasks?: Array<{
    TaskPath?: string;
    TaskName?: string;
    State?: string;
    triggerSummary?: string;
  }>;
  programs?: Array<{
    name?: string;
    version?: string;
    publisher?: string;
    installDate?: string;
    uninstallString?: string;
    wingetId?: string;
  }>;
  hotfixes?: Array<{ HotFixID?: string; InstalledOn?: string }>;
};

const SYSTEM_SCRIPT = `
$services = @()
try {
  $services = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | ForEach-Object {
    @{
      Name = [string]$_.Name
      DisplayName = [string]$_.DisplayName
      State = [string]$_.State
      StartMode = [string]$_.StartMode
      StartName = [string]$_.StartName
      PathName = [string]$_.PathName
    }
  })
} catch {}

$startup = @()
$runKeys = @(
  @{ scope = 'user'; path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' },
  @{ scope = 'machine'; path = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' },
  @{ scope = 'machine'; path = 'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Run' }
)
foreach ($key in $runKeys) {
  try {
    $item = Get-ItemProperty -Path $key.path -ErrorAction SilentlyContinue
    if ($item) {
      foreach ($prop in $item.PSObject.Properties) {
        if ($prop.Name -like 'PS*') { continue }
        if ($null -eq $prop.Value) { continue }
        $startup += @{
          scope = $key.scope
          name = [string]$prop.Name
          command = [string]$prop.Value
          enabled = $true
        }
      }
    }
  } catch {}
}
$startupFolders = @(
  @{ scope = 'user'; path = [Environment]::GetFolderPath('Startup') },
  @{ scope = 'machine'; path = [Environment]::GetFolderPath('CommonStartup') }
)
foreach ($folder in $startupFolders) {
  if (-not $folder.path) { continue }
  try {
    if (Test-Path $folder.path) {
      Get-ChildItem -Path $folder.path -File -ErrorAction SilentlyContinue | ForEach-Object {
        $startup += @{
          scope = 'startup-folder'
          name = $_.Name
          command = $_.FullName
          enabled = $true
        }
      }
    }
  } catch {}
}

$tasks = @()
try {
  $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
    @{
      TaskPath = [string]$_.TaskPath
      TaskName = [string]$_.TaskName
      State = [string]$_.State
      triggerSummary = [string](($_.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ', ')
    }
  })
} catch {}

$programs = @()
$uninstallKeys = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
foreach ($key in $uninstallKeys) {
  try {
    Get-ItemProperty -Path $key -ErrorAction SilentlyContinue | ForEach-Object {
      if (-not $_.DisplayName) { return }
      $programs += @{
        name = [string]$_.DisplayName
        version = [string]$_.DisplayVersion
        publisher = [string]$_.Publisher
        installDate = [string]$_.InstallDate
        uninstallString = [string]$_.UninstallString
        wingetId = [string]$_.WindowsInstaller
      }
    }
  } catch {}
}

$hotfixes = @()
try {
  $hotfixes = @(Get-HotFix -ErrorAction SilentlyContinue | ForEach-Object {
    @{ HotFixID = [string]$_.HotFixID; InstalledOn = [string]$_.InstalledOn }
  })
} catch {}

[pscustomobject]@{
  services = $services
  startup = $startup
  tasks = $tasks
  programs = $programs
  hotfixes = $hotfixes
} | ConvertTo-Json -Depth 6 -Compress
`;

export type SystemData = {
  services: ServiceInfo[];
  startup: StartupInfo[];
  tasks: TaskInfo[];
  programs: ProgramInfo[];
  hotfixes: HotfixInfo[];
  warnings: SnapshotWarning[];
};

export async function collectSystem(): Promise<SystemData> {
  const raw = await runJsonPowerShell<RawSystem>(SYSTEM_SCRIPT, { timeoutMs: 14_000 });
  const services = asArray(raw.services)
    .filter((service) => service.Name)
    .map((service) => ({
      name: String(service.Name),
      displayName: String(service.DisplayName ?? service.Name ?? ""),
      state: String(service.State ?? "Unknown"),
      startMode: String(service.StartMode ?? "Unknown"),
      startName: service.StartName ? String(service.StartName) : undefined,
      pathName: service.PathName ? String(service.PathName) : undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const startup = asArray(raw.startup)
    .filter((item) => item.name)
    .map((item) => ({
      scope: (item.scope === "user" ? "user" : item.scope === "startup-folder" ? "startup-folder" : "machine") as StartupInfo["scope"],
      name: String(item.name),
      command: String(item.command ?? ""),
      enabled: item.enabled !== false,
    }))
    .sort((a, b) => `${a.scope}:${a.name}`.localeCompare(`${b.scope}:${b.name}`));
  const tasks = asArray(raw.tasks)
    .filter((task) => task.TaskName)
    .map((task) => ({
      path: String(task.TaskPath ?? "\\"),
      name: String(task.TaskName),
      state: String(task.State ?? "Unknown"),
      triggerSummary: String(task.triggerSummary ?? ""),
    }))
    .sort((a, b) => `${a.path}${a.name}`.localeCompare(`${b.path}${b.name}`));
  const programs = dedupePrograms(
    asArray(raw.programs)
      .filter((program) => program.name)
      .map((program) => ({
        name: String(program.name),
        version: String(program.version ?? ""),
        publisher: program.publisher ? String(program.publisher) : undefined,
        installDate: program.installDate ? String(program.installDate) : undefined,
        uninstallString: program.uninstallString ? String(program.uninstallString) : undefined,
        wingetId: program.wingetId ? String(program.wingetId) : undefined,
      })),
  );
  const hotfixes = asArray(raw.hotfixes)
    .filter((hotfix) => hotfix.HotFixID)
    .map((hotfix) => ({
      id: String(hotfix.HotFixID),
      installedOn: hotfix.InstalledOn ? String(hotfix.InstalledOn) : undefined,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { services, startup, tasks, programs, hotfixes, warnings: [] };
}

export function emptySystem(warnings: SnapshotWarning[] = []): SystemData {
  return {
    services: [],
    startup: [],
    tasks: [],
    programs: [],
    hotfixes: [],
    warnings,
  };
}

function dedupePrograms(programs: ProgramInfo[]): ProgramInfo[] {
  const byKey = new Map<string, ProgramInfo>();
  for (const program of programs) {
    const key = `${program.name.toLowerCase()}:${program.version.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, program);
  }
  return [...byKey.values()].sort((a, b) => `${a.name}:${a.version}`.localeCompare(`${b.name}:${b.version}`));
}
