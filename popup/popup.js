/**
 * YouTube Shorts: Автопрокрутка и Голосовое управление
 * Popup Logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  const elements = {
    autoScrollEnabled: document.getElementById('autoScrollEnabled'),
    voiceEnabled: document.getElementById('voiceEnabled'),
    scrollDelay: document.getElementById('scrollDelay'),
    delayValue: document.getElementById('delayValue'),
    voiceLanguage: document.getElementById('voiceLanguage'),
    soundFeedback: document.getElementById('soundFeedback'),
    showHud: document.getElementById('showHud'),
    showProgressBar: document.getElementById('showProgressBar'),
    toggleCommands: document.getElementById('toggleCommands'),
    commandsList: document.getElementById('commandsList'),
    btnTestMic: document.getElementById('btnTestMic'),
    micStatusNote: document.getElementById('micStatusNote')
  };

  const DEFAULT_SETTINGS = {
    autoScrollEnabled: true,
    voiceEnabled: true,
    scrollDelay: 0.5,
    voiceLanguage: 'ru-RU',
    soundFeedback: false,
    showHud: true,
    showProgressBar: true
  };

  // 1. Загрузка настроек
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  elements.autoScrollEnabled.checked = current.autoScrollEnabled;
  elements.voiceEnabled.checked = current.voiceEnabled;
  elements.scrollDelay.value = current.scrollDelay;
  elements.delayValue.textContent = current.scrollDelay + ' сек';
  elements.voiceLanguage.value = current.voiceLanguage;
  elements.soundFeedback.checked = current.soundFeedback;
  elements.showHud.checked = current.showHud;
  elements.showProgressBar.checked = current.showProgressBar;

  // 2. Обработчики изменений настроек
  const saveSetting = (key, value) => {
    chrome.storage.sync.set({ [key]: value });
  };

  elements.autoScrollEnabled.addEventListener('change', (e) => {
    saveSetting('autoScrollEnabled', e.target.checked);
  });

  elements.voiceEnabled.addEventListener('change', (e) => {
    saveSetting('voiceEnabled', e.target.checked);
  });

  elements.scrollDelay.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    elements.delayValue.textContent = val + ' сек';
    saveSetting('scrollDelay', val);
  });

  elements.voiceLanguage.addEventListener('change', (e) => {
    saveSetting('voiceLanguage', e.target.value);
  });

  elements.soundFeedback.addEventListener('change', (e) => {
    saveSetting('soundFeedback', e.target.checked);
  });

  elements.showHud.addEventListener('change', (e) => {
    saveSetting('showHud', e.target.checked);
  });

  elements.showProgressBar.addEventListener('change', (e) => {
    saveSetting('showProgressBar', e.target.checked);
  });

  // 3. Аккордеон списка команд
  elements.toggleCommands.addEventListener('click', () => {
    const isOpen = elements.commandsList.classList.toggle('open');
    elements.toggleCommands.classList.toggle('open', isOpen);
  });

  // 4. Проверка микрофона
  elements.btnTestMic.addEventListener('click', async () => {
    elements.micStatusNote.className = 'mic-status-note';
    elements.micStatusNote.textContent = 'Подключение к микрофону...';

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      elements.micStatusNote.className = 'mic-status-note success';
      elements.micStatusNote.textContent = '✅ Микрофон активен и готов к работе!';

      // Освобождаем микрофон после теста
      stream.getTracks().forEach((track) => track.stop());
    } catch (err) {
      elements.micStatusNote.className = 'mic-status-note error';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        elements.micStatusNote.textContent = '❌ Доступ к микрофону запрещен. Разрешите его в браузере.';
      } else {
        elements.micStatusNote.textContent = '❌ Ошибка микрофона: ' + err.message;
      }
    }
  });
});
