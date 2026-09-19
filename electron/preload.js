const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Accounts
  accounts: {
    getAll:    ()               => ipcRenderer.invoke('accounts:getAll'),
    add:       (username)       => ipcRenderer.invoke('accounts:add', username),
    delete:    (id)             => ipcRenderer.invoke('accounts:delete', id),
    update:    (username, data) => ipcRenderer.invoke('accounts:update', username, data),
    setDevice: (accountId, deviceId) => ipcRenderer.invoke('accounts:setDevice', accountId, deviceId),
  },
  // Devices (multi-device support)
  devices: {
    getAll:        ()               => ipcRenderer.invoke('devices:getAll'),
    get:           (id)             => ipcRenderer.invoke('devices:get', id),
    getByAccount:  (accountId)      => ipcRenderer.invoke('devices:getByAccount', accountId),
    getAccounts:   (deviceId)       => ipcRenderer.invoke('devices:getAccounts', deviceId),
    scanAccounts:  (deviceId)       => ipcRenderer.invoke('devices:scanAccounts', deviceId),
    add:           (payload)        => ipcRenderer.invoke('devices:add', payload),
    update:        (id, data)       => ipcRenderer.invoke('devices:update', id, data),
    delete:        (id)             => ipcRenderer.invoke('devices:delete', id),
    reconnect:     (id)             => ipcRenderer.invoke('devices:reconnect', id),
  },
  // Warmup config (per-account)
  warmupConfig: {
    get:  (accountId)         => ipcRenderer.invoke('warmup:getConfig', accountId),
    save: (accountId, config) => ipcRenderer.invoke('warmup:saveConfig', accountId, config),
  },
  // Reels
  reels: {
    getByAccount:   (accountId, sortBy)         => ipcRenderer.invoke('reels:getByAccount', accountId, sortBy),
    upsert:         (accountId, reel)            => ipcRenderer.invoke('reels:upsert', accountId, reel),
    markDownloaded: (reelId, downloadPath)       => ipcRenderer.invoke('reels:markDownloaded', reelId, downloadPath),
    updateViews:    (reelId, views)              => ipcRenderer.invoke('reels:updateViews', reelId, views),
  },
  // Stats
  stats: {
    get: () => ipcRenderer.invoke('stats:get'),
  },
  // Settings
  settings: {
    get:  ()     => ipcRenderer.invoke('settings:get'),
    save: (data) => ipcRenderer.invoke('settings:save', data),
  },
  // Shell
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
  // Python backend
  python: {
    status:       ()                              => ipcRenderer.invoke('python:status'),
    login:        (sessionId)                     => ipcRenderer.invoke('python:login', sessionId),
    testSession:  ()                              => ipcRenderer.invoke('python:testSession'),
    parseAccount: (username)                      => ipcRenderer.invoke('python:parseAccount', username),
    parseReels:   (username, accountId, amount)   => ipcRenderer.invoke('python:parseReels', username, accountId, amount),
    downloadReel:  (videoUrl, savePath)           => ipcRenderer.invoke('python:downloadReel', videoUrl, savePath),
    enrichViews:   (reelIds)                      => ipcRenderer.invoke('python:enrichViews', reelIds),
    extractAudio:  (reelId, videoUrl)             => ipcRenderer.invoke('python:extractAudio', reelId, videoUrl),
    generateFull:     (params) => ipcRenderer.invoke('python:generateFull', params),
    generateImage:    (params) => ipcRenderer.invoke('python:generateImage', params),
    generateVideo:    (params) => ipcRenderer.invoke('python:generateVideo', params),
    generateCompose:  (params) => ipcRenderer.invoke('python:generateCompose', params),
    generatePostImage:       (params) => ipcRenderer.invoke('python:generatePostImage', params),
    generateCarouselPrompts: (params) => ipcRenderer.invoke('python:generateCarouselPrompts', params),
    carouselAgentRun:       (params) => ipcRenderer.invoke('python:carouselAgentRun', params),
    carouselAgentIdea:      (params) => ipcRenderer.invoke('python:carouselAgentIdea', params),
    carouselAgentSlides:    (params) => ipcRenderer.invoke('python:carouselAgentSlides', params),
    renderPostOverlay:       (params) => ipcRenderer.invoke('python:renderPostOverlay', params),
    flowSetup:       ()                            => ipcRenderer.invoke('python:flowSetup'),
    generateFlow:    (params)                      => ipcRenderer.invoke('python:generateFlow', params),
    generatePrompt:      (params) => ipcRenderer.invoke('python:generatePrompt', params),
    downloadFlowLatest:  (params) => ipcRenderer.invoke('python:downloadFlowLatest', params),
    importImage:     (filePath)                    => ipcRenderer.invoke('python:importImage', filePath),
    generateCaption: (params)                     => ipcRenderer.invoke('python:generateCaption', params),
    generatePersonaReply: (params)                => ipcRenderer.invoke('python:generatePersonaReply', params),
    generatePersonaPost:  (params)               => ipcRenderer.invoke('python:generatePersonaPost', params),
    // Threads persona pipeline (Content-style, adapted for Threads)
    threadsPersonaReply: (params)                => ipcRenderer.invoke('threads:personaReply', params),
    threadsPersonaPost:  (params)                => ipcRenderer.invoke('threads:personaPost', params),
    // Reddit feed monitor — moved to top-level reddit namespace (see below)
    getPrompts:    ()                             => ipcRenderer.invoke('python:getPrompts'),
    savePrompts:   (data)                         => ipcRenderer.invoke('python:savePrompts', data),
    publishReel:   (videoPath, caption)           => ipcRenderer.invoke('python:publishReel', videoPath, caption),
    androidDevices:    ()                                         => ipcRenderer.invoke('python:androidDevices'),
    androidStatus:     (serial)                                   => ipcRenderer.invoke('python:androidStatus', serial),
    androidPost:       (videoPath, caption, serial, dryRun, proxy, expectedUsername) => ipcRenderer.invoke('python:androidPost', videoPath, caption, serial, dryRun, proxy, expectedUsername),
    androidPostV2:     (videoPath, caption, serial, dryRun, proxy, expectedUsername) => ipcRenderer.invoke('python:androidPostV2', videoPath, caption, serial, dryRun, proxy, expectedUsername),
    androidScrollReels: (serial, durationSeconds, likeProbability, proxy, useAi, claudeApiKey, accountId) => ipcRenderer.invoke('python:androidScrollReels', serial, durationSeconds, likeProbability, proxy, useAi, claudeApiKey, accountId),
    scrcpy:     (serial) => ipcRenderer.invoke('android:scrcpy', serial),
    scrcpyStop: ()       => ipcRenderer.invoke('android:scrcpy-stop'),
    androidPair:       (host, code)                               => ipcRenderer.invoke('python:androidPair', host, code),
    androidConnect:    (host)                                      => ipcRenderer.invoke('python:androidConnect', host),
    androidTcpip:      (serial, port)                             => ipcRenderer.invoke('python:androidTcpip', serial, port),
    androidDisconnect: (host)                                      => ipcRenderer.invoke('python:androidDisconnect', host),
    androidMdnsDiscover: ()                                        => ipcRenderer.invoke('python:androidMdnsDiscover'),
    androidEnsureWifi:   (savedHost)                               => ipcRenderer.invoke('python:androidEnsureWifi', savedHost),
    androidActiveAccount: (serial)                                 => ipcRenderer.invoke('python:androidActiveAccount', serial),
    androidAllAccounts:   (serial)                                 => ipcRenderer.invoke('python:androidAllAccounts', serial),
    androidScanUsb:      ()                                        => ipcRenderer.invoke('python:androidScanUsb'),
    androidRegisterUsb:  (serial)                                  => ipcRenderer.invoke('python:androidRegisterUsb', serial),
    threadsStatus:        (serial)                                 => ipcRenderer.invoke('python:threadsStatus', serial),
    threadsPublish:       (serial, text, accountId)                => ipcRenderer.invoke('python:threadsPublish', serial, text, accountId),
    threadsScrollComment: (serial, durationSec, likeProb, aiPrompt, accountId) =>
      ipcRenderer.invoke('python:threadsScrollComment', serial, durationSec, likeProb, aiPrompt, accountId),
  },
  // Reddit feed monitor
  reddit: {
    scan:         (params) => ipcRenderer.invoke('reddit:scan', params),
    scanStatus:   ()       => ipcRenderer.invoke('reddit:scanStatus'),
    posts:        (params) => ipcRenderer.invoke('reddit:posts', params),
    deletePosts:  (params) => ipcRenderer.invoke('reddit:deletePosts', params),
    draft:        (params) => ipcRenderer.invoke('reddit:draft', params),
    status:       (params) => ipcRenderer.invoke('reddit:status', params),
    drafts:       (postId) => ipcRenderer.invoke('reddit:drafts', postId),
    fetchFull:    (postId) => ipcRenderer.invoke('reddit:fetchFull', postId),
    getFullPost:  (postId) => ipcRenderer.invoke('reddit:getFullPost', postId),
    devvitSync:   ()       => ipcRenderer.invoke('reddit:devvitSync'),
    devvitStatus: ()       => ipcRenderer.invoke('reddit:devvitStatus'),
    draftModels:  ()       => ipcRenderer.invoke('reddit:draftModels'),
    draftTest:    ()       => ipcRenderer.invoke('reddit:draftTest'),
  },
  // Generations History
  generations: {
    getAll:    ()         => ipcRenderer.invoke('generations:getAll'),
    save:      (data)     => ipcRenderer.invoke('generations:save', data),
    delete:    (id)       => ipcRenderer.invoke('generations:delete', id),
    saveDraft: (data)     => ipcRenderer.invoke('generations:saveDraft', data),
    update:    (id, data) => ipcRenderer.invoke('generations:update', id, data),
  },
  // Personas (Reddit/Threads voice generator)
  personas: {
    getAll: ()         => ipcRenderer.invoke('personas:getAll'),
    save:  (data)     => ipcRenderer.invoke('personas:save', data),
    delete:(id)       => ipcRenderer.invoke('personas:delete', id),
  },
  // Schedule
  schedule: {
    getAll:  ()                                      => ipcRenderer.invoke('schedule:getAll'),
    get:     (id)                                    => ipcRenderer.invoke('schedule:get', id),
    add:     (videoPath, caption, when, accountId, isDryRun, contentType, imagePathsJson) => ipcRenderer.invoke('schedule:add', videoPath, caption, when, accountId, isDryRun, contentType, imagePathsJson),
    update:  (id, data)                              => ipcRenderer.invoke('schedule:update', id, data),
    delete:  (id)                                    => ipcRenderer.invoke('schedule:delete', id),
  },
  // Dialog
  dialog: {
    openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
    openFiles: (options) => ipcRenderer.invoke('dialog:openFiles', options),
  },
  // TIGFusion — батч-унікалізація відео
  tigfusion: {
    run:        (params) => ipcRenderer.invoke('tigfusion:run', params),
    status:     ()       => ipcRenderer.invoke('tigfusion:status'),
    checkFfmpeg:()       => ipcRenderer.invoke('tigfusion:checkFfmpeg'),
    listDir:    (path)   => ipcRenderer.invoke('tigfusion:listDir', path),
    stop:       ()       => ipcRenderer.invoke('tigfusion:stop'),
  },
  // LAN Share — роздача файлів у мережу для телефонів
  share: {
    start:   (folder, port) => ipcRenderer.invoke('share:start', { folder, port }),
    stop:    ()             => ipcRenderer.invoke('share:stop'),
    status:  ()             => ipcRenderer.invoke('share:status'),
    localIp: ()             => ipcRenderer.invoke('share:localIp'),
  },
  // Синхронізація з GitHub (сторінка /sync)
  sync: {
    status:      (repoPath)    => ipcRenderer.invoke('sync:status', repoPath),
    deploy:      (payload)     => ipcRenderer.invoke('sync:deploy', payload),
    pull:        (repoPath)    => ipcRenderer.invoke('sync:pull', repoPath),
    saveRepoPath:(repoPath)    => ipcRenderer.invoke('sync:saveRepoPath', repoPath),
  },
  // Threads scheduler / plan
  threadsPlan: {
    generate: (config, dateRange, replace) => ipcRenderer.invoke('threads:generatePlan', config, dateRange, replace),
    get:      (accountId, dateFrom, dateTo) => ipcRenderer.invoke('threads:getPlan', accountId, dateFrom, dateTo),
    cancel:   (sessionId) => ipcRenderer.invoke('threads:cancelSession', sessionId),
    delete:   (accountId, dateFrom, dateTo, onlyPlanned) => ipcRenderer.invoke('threads:deletePlan', accountId, dateFrom, dateTo, onlyPlanned),
  },
  // Threads feed monitor + generator
  threadsFeed: {
    posts:          (params) => ipcRenderer.invoke('threads:feedPosts', params),
    status:         (params) => ipcRenderer.invoke('threads:feedStatus', params),
    deletePosts:    (params) => ipcRenderer.invoke('threads:feedDelete', params),
    draft:          (params) => ipcRenderer.invoke('threads:feedDraft', params),
    drafts:         (postId) => ipcRenderer.invoke('threads:feedDrafts', postId),
    generate:       (params) => ipcRenderer.invoke('threads:generate', params),
    generated:      (params) => ipcRenderer.invoke('threads:generated', params),
    generatedUpdate:(params) => ipcRenderer.invoke('threads:generatedUpdate', params),
    generatedDelete:(genId)  => ipcRenderer.invoke('threads:generatedDelete', genId),
  },
  // Warmup scheduler
  warmup: {
    generatePlan:  (config, dateRange, replace) => ipcRenderer.invoke('warmup:generatePlan', config, dateRange, replace),
    getSessions:   (fromIso, toIso) => ipcRenderer.invoke('warmup:getSessions', fromIso, toIso),
    getSession:    (id) => ipcRenderer.invoke('warmup:getSession', id),
    deleteSession: (id) => ipcRenderer.invoke('warmup:deleteSession', id),
    deletePending: () => ipcRenderer.invoke('warmup:deletePending'),
    getStats:      (fromIso, toIso) => ipcRenderer.invoke('warmup:getStats', fromIso, toIso),
    triggerNow:    (deviceId, accountId) => ipcRenderer.invoke('warmup:triggerNow', deviceId || null, accountId || null),
  },
  // MobAI (iPhone bridge)
  mobai: {
    devices:       ()                  => ipcRenderer.invoke('mobai:devices'),
    clipboardGet:  (deviceId)          => ipcRenderer.invoke('mobai:clipboard:get', deviceId),
    clipboardSet:  (deviceId, text)     => ipcRenderer.invoke('mobai:clipboard:set', deviceId, text),
    type:          (deviceId, text)     => ipcRenderer.invoke('mobai:type', deviceId, text),
    screenshot:    (deviceId)          => ipcRenderer.invoke('mobai:screenshot', deviceId),
    ocr:           (deviceId)          => ipcRenderer.invoke('mobai:ocr', deviceId),
  },
  // Wi-Fi ADB connection watchdog
  wifiAdb: {
    getStatus: () => ipcRenderer.invoke('wifi-adb:getStatus'),
    checkNow:  (serial) => ipcRenderer.invoke('wifi-adb:checkNow', serial),
  },
  // App / Tray / Autostart
  app: {
    hideToTray:    () => ipcRenderer.invoke('app:hideToTray'),
    showWindow:    () => ipcRenderer.invoke('app:showWindow'),
    quit:          () => ipcRenderer.invoke('app:quit'),
    getAutostart:  () => ipcRenderer.invoke('app:getAutostart'),
    setAutostart:  (enabled) => ipcRenderer.invoke('app:setAutostart', enabled),
  },
  // Env
  getEnv: (key) => ipcRenderer.invoke('app:getEnv', key),
  getTempAudioDir: () => ipcRenderer.invoke('app:getTempAudioDir'),
  // Events від main process
  on: (channel, cb) => {
    const { ipcRenderer } = require('electron')
    ipcRenderer.on(channel, (_, data) => cb(data))
    return () => ipcRenderer.removeAllListeners(channel)
  },
})
