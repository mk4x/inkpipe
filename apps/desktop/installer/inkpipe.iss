; inkpipe Windows installer (ADR 0005).
;
; Decision 25 asked that setup do everything: detect Ollama, install it if it is
; missing, and leave a working application behind. This does the install half.
; Ollama is DETECTED here and installed by the setup wizard inside the app,
; because that download is gigabytes and belongs behind a progress bar the user
; can cancel, not inside a silent installer step.
;
; A bundled Node runtime ships alongside the app. Nothing needs to be installed
; beforehand, and it does not touch a Node the user already has: the shortcut
; runs the bundled node.exe by absolute path.
;
; Per user, not per machine. This application holds a private key and writes to
; a personal vault, so it has no business in Program Files or needing admin.

#define AppName "inkpipe"
#define AppVersion "0.1.0"
#define AppPublisher "inkpipe"
#define AppURL "https://github.com/mk4x/inkpipe"

[Setup]
AppId={{8A6C1F4E-2D5B-4C77-9E3A-0B7D1C6F2A94}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppSupportURL={#AppURL}
DefaultDirName={localappdata}\Programs\inkpipe
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; No admin. Everything lives under the user's own profile.
PrivilegesRequired=lowest
OutputDir=..\..\..\build
OutputBaseFilename=inkpipe-setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\inkpipe.exe
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startup"; Description: "Start inkpipe when I sign in"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
; The staged tree: source, production node_modules, and the Node runtime.
Source: "..\..\..\build\stage\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "inkpipe.vbs"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Launched through the VBScript so no console window flashes up. A terminal
; appearing and vanishing is exactly what made this not feel like an app.
Name: "{group}\inkpipe"; Filename: "{app}\inkpipe.vbs"; WorkingDir: "{app}"
Name: "{userdesktop}\inkpipe"; Filename: "{app}\inkpipe.vbs"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{userstartup}\inkpipe"; Filename: "{app}\inkpipe.vbs"; WorkingDir: "{app}"; Tasks: startup

[Run]
Filename: "{app}\inkpipe.vbs"; Description: "Start inkpipe now"; Flags: postinstall nowait shellexec skipifsilent

[UninstallDelete]
; The browser profile the window uses. Config, keys and secrets are NOT removed:
; keys.json is derived from the recovery phrase and losing it makes every
; pending page unreadable, so uninstalling must never destroy it silently.
Type: filesandordirs; Name: "{userappdata}\inkpipe\window-profile"

[Code]
function OllamaInstalled(): Boolean;
begin
  // Both usual locations, plus the data directory it creates, which survives
  // an install to somewhere non standard.
  Result := FileExists(ExpandConstant('{localappdata}\Programs\Ollama\ollama.exe'))
         or FileExists(ExpandConstant('{pf}\Ollama\ollama.exe'))
         or DirExists(ExpandConstant('{userprofile}\.ollama'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not OllamaInstalled() then
      MsgBox('inkpipe needs Ollama to read your handwriting, and it was not found.' + #13#10#13#10 +
             'The setup screen inside inkpipe will detect this and offer to install it. ' +
             'That download is several gigabytes, so it is done there with a progress bar ' +
             'rather than silently here.',
             mbInformation, MB_OK);
  end;
end;
