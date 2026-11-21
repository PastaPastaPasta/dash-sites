import { DEFAULT_SETTINGS, parseGateway, type Gateway, type Settings } from './shared.js';

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get('settings')).settings as Partial<Settings> | undefined;
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  return parseGateway(settings.gateway) ? settings : { ...settings, gateway: DEFAULT_SETTINGS.gateway };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

export async function loadGateway(): Promise<{ settings: Settings; gateway: Gateway }> {
  const settings = await loadSettings();
  return { settings, gateway: parseGateway(settings.gateway) as Gateway };
}
