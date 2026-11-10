function speechBridge(ipcRenderer) {
  return {
    catalog: () => ipcRenderer.invoke('ds-bot:speech-catalog'),
    prepare: providerId => ipcRenderer.invoke('ds-bot:speech-prepare', String(providerId)),
    transcribe: (id, request) => ipcRenderer.invoke('ds-bot:speech-transcribe', String(id), speechRequestOf(request)),
    cancel: id => { ipcRenderer.send('ds-bot:speech-cancel', String(id)) },
  }
}

function speechRequestOf(value) {
  if (value === null || typeof value !== 'object') return {}
  return {
    audioBase64: typeof value.audioBase64 === 'string' ? value.audioBase64 : '',
    providerId: typeof value.providerId === 'string' ? value.providerId : '',
    language: typeof value.language === 'string' ? value.language : '',
  }
}

module.exports = { speechBridge, speechRequestOf }
