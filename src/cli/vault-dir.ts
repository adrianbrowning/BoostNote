import * as os from 'node:os'
import * as path from 'node:path'

import { SettingsStore } from '../main/settings.ts'
import { CommandError } from './commands.ts'

/** The app's `userData` folder (`<appData>/Boostnote Modern`, see src/main/main.ts), without Electron. */
export function appUserDataDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const appData =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
        : (env.XDG_CONFIG_HOME ?? path.join(home, '.config'))
  return path.join(appData, 'Boostnote Modern')
}

/**
 * The vault folder to use: `--vault`, else `BOOSTNOTE_VAULT`, else the vault the app last had open
 * (`lastVault` in its settings, only read). Relative paths are resolved against the working directory.
 */
export function resolveVaultDir(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  settingsFile = path.join(appUserDataDir(env), 'settings.json'),
): string {
  const chosen = flag || env.BOOSTNOTE_VAULT || new SettingsStore(settingsFile).read().lastVault
  if (!chosen) {
    throw new CommandError(
      'USAGE',
      'No vault: pass --vault <dir>, set BOOSTNOTE_VAULT, or open a vault in the Boostnote app first.',
    )
  }
  return path.resolve(chosen)
}
