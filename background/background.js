/**
 * Background Service Worker (Manifest V3)
 * YouTube Shorts: Автопрокрутка и Голосовое управление
 */

const DEFAULT_SETTINGS = {
  autoScrollEnabled: true,
  voiceEnabled: true,
  scrollDelay: 0.5, // секунды задержки после окончания видео
  voiceLanguage: 'ru-RU', // ru-RU или en-US
  soundFeedback: false, // звуковые сигналы отключены (тихий режим)
  showHud: true, // плавающий мини-виджет на странице Shorts
  showProgressBar: true // полоса прогресса до автопрокрутки
};

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // Установка начальных настроек
    const current = await chrome.storage.sync.get(null);
    const toSet = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (current[key] === undefined) {
        toSet[key] = value;
      }
    }
    if (Object.keys(toSet).length > 0) {
      await chrome.storage.sync.set(toSet);
    }
    console.log('[Shorts Extension] Установлены настройки по умолчанию:', toSet);
  }
});
