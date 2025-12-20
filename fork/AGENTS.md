# Fork Notes (EntityProcess)

This document is fork-specific and is referenced by the root `AGENTS.md`.

## Windows Build (CLI)

### Requirements

- Bun 1.3+
- PowerShell (recommended)

### Build the CLI (Windows only)

From the repo root:

```powershell
# Stop any running opencode.exe (Windows locks the file)
Get-Process opencode -ErrorAction SilentlyContinue | Stop-Process -Force

# Clean previous outputs
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue packages\opencode\dist

# Build current platform only
bun run --cwd packages/opencode script/build.ts --single --skip-install
```

Expected output binary:

- `packages/opencode/dist/opencode-windows-x64/bin/opencode.exe`

### Running

```powershell
.\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe --version
```

### Notes (Windows quirks)

- If `rm -rf dist` fails inside the build script, it’s usually because `opencode.exe` is still running. Stop it first (see above).
- If TypeScript typecheck fails in `packages/desktop` or `packages/enterprise` on Windows, it can be due to symlink checkout differences. In this fork, the `playground` branch includes a workaround for `custom-elements.d.ts` when symlinks are not available.
