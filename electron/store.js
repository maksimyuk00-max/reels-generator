let Store
let store

async function getStore() {
  if (!store) {
    Store = (await import('electron-store')).default
    store = new Store({
      name: 'settings',
      defaults: {
        instagram: {
          sessionId: '',
        },
        imageApi: {
          provider: 'stability',
          apiKey: '',
        },
        videoApi: {
          provider: 'kling',
          apiKey: '',
        },
        claudeApi: {
          apiKey: '',
        },
        // Ollama — провайдер LLM для генерації Reddit драфтів.
        // provider='claude-cli' (default, потребує логін) або 'ollama'.
        ollama: {
          provider: 'claude-cli',  // 'claude-cli' | 'ollama'
          endpoint: 'https://ollama.com',
          apiKey: '',
          model: 'gpt-oss:120b',
        },
        googleFlow: {
          cookies: '',
          projectUrl: '',
        },
        musicFolder: '',
        logoPath: '',
        warmupSchedule: {
          enabled: false,
          serial: '',
          accountId: null,
          sessionsPerDay: 3,
          activeHourStart: 9,
          activeHourEnd: 22,
          durationMin: 2,
          durationMax: 8,
          likeProbMin: 10,
          likeProbMax: 25,
          useAi: true,
          lastRunAt: null,
          nextRunAt: null,
          runHistory: [],
        },
      },
    })
  }
  return store
}

async function getSettings() {
  const s = await getStore()
  return s.store
}

async function saveSettings(data) {
  const s = await getStore()
  s.set(data)
}

async function getSetting(key) {
  const s = await getStore()
  return s.get(key)
}

module.exports = { getSettings, saveSettings, getSetting }
