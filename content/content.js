/**
 * YouTube Shorts: Автопрокрутка и Голосовое управление
 * Content Script
 */

(function () {
  'use strict';

  // Состояние настроек
  let settings = {
    autoScrollEnabled: true,
    voiceEnabled: true,
    scrollDelay: 0.5,
    voiceLanguage: 'ru-RU',
    soundFeedback: false,
    showHud: true,
    showProgressBar: true
  };

  // Внутреннее состояние
  let currentVideo = null;
  let hasScrolledCurrent = false;
  let autoScrollTimeout = null;
  let lastScrollTimestamp = 0;
  let lastVoiceCommandTimestamp = 0;
  let prevVideoTime = 0;
  let isHudMinimized = false;

  // Распознавание речи
  let recognition = null;
  let isSpeechListening = false;
  let speechRestartTimeout = null;
  let micPermissionState = 'unknown'; // 'granted', 'prompt', 'denied'

  // Аудио контекст для звуковых сигналов
  let audioCtx = null;

  // Словарь команд
  const COMMANDS = {
    NEXT: [
      'далее', 'дальше', 'следующее', 'следующий', 'следующая', 'следуй',
      'пропустить', 'пропусти', 'пропуск', 'скип', 'скипни', 'перелистни', 'листни',
      'не понравилось', 'дизлайк', 'фигня', 'скучно', 'next', 'skip'
    ],
    PREV: [
      'назад', 'обратно', 'предыдущее', 'предыдущий', 'предыдущая', 'верни', 'назад листай', 'back', 'prev'
    ],
    PAUSE: [
      'пауза', 'стоп', 'останови', 'замолчи', 'тихо', 'pause', 'stop'
    ],
    PLAY: [
      'плей', 'играй', 'продолжить', 'старт', 'включи', 'play', 'resume'
    ],
    LIKE: [
      'лайк', 'нравится', 'класс', 'любо', 'супер', 'like'
    ],
    REPLAY: [
      'заново', 'повтори', 'повтор', 'еще раз', 'ещё раз', 'replay', 'again'
    ]
  };

  /**
   * Инициализация настроек
   */
  async function loadSettings() {
    try {
      const data = await chrome.storage.sync.get(settings);
      settings = { ...settings, ...data };
    } catch (e) {
      console.warn('[YT Shorts Assistant] Не удалось загрузить storage.sync, используются дефолты', e);
    }
  }

  // Слушаем изменение настроек из Popup
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') {
        let voiceToggled = false;
        let hudToggled = false;

        for (const [key, change] of Object.entries(changes)) {
          settings[key] = change.newValue;
          if (key === 'voiceEnabled') voiceToggled = true;
          if (key === 'showHud') hudToggled = true;
        }

        updateHudUI();

        if (voiceToggled) {
          if (settings.voiceEnabled && isShortsPage()) {
            startSpeechRecognition();
          } else {
            stopSpeechRecognition();
          }
        }

        if (hudToggled) {
          const hud = document.getElementById('shorts-helper-hud');
          if (hud) hud.style.display = settings.showHud ? 'block' : 'none';
        }
      }
    });
  }

  /**
   * Проверка: находимся ли мы на странице Shorts
   */
  function isShortsPage() {
    return window.location.pathname.startsWith('/shorts');
  }

  /**
   * Звуковые сигналы отключены для тихого и комфортного просмотра
   */
  function playBeep(type = 'success') {
    return;
  }

  /**
   * Позиционирование всплывающего уведомления слева над кнопкой "Подписаться"
   */
  function positionToastAboveSubscribe(toast) {
    try {
      const activeRenderer = document.querySelector('ytd-reel-video-renderer[is-active]');
      const subBtn = activeRenderer
        ? activeRenderer.querySelector('#subscribe-button, ytd-subscribe-button-renderer, .ytd-reel-player-header-renderer')
        : document.querySelector('#subscribe-button, ytd-subscribe-button-renderer');

      if (subBtn && subBtn.offsetParent !== null) {
        const rect = subBtn.getBoundingClientRect();
        if (rect.left > 0 && rect.top > 0) {
          toast.style.left = Math.max(16, rect.left) + 'px';
          toast.style.bottom = Math.max(90, window.innerHeight - rect.top + 16) + 'px';
          return;
        }
      }

      // Fallback: левее центра экрана на пустом месте над панелью автора
      toast.style.left = 'max(20px, calc(50vw - 215px))';
      toast.style.bottom = '160px';
    } catch (e) {
      toast.style.left = 'max(20px, calc(50vw - 215px))';
      toast.style.bottom = '160px';
    }
  }

  /**
   * Показать всплывающее уведомление (Toast)
   */
  let toastTimeout = null;
  function showToast(text, icon = '⚡') {
    let toast = document.getElementById('shorts-helper-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'shorts-helper-toast';
      toast.className = 'sh-toast-notification';
      toast.innerHTML = `<span class="sh-toast-icon">${icon}</span><span class="sh-toast-text">${text}</span>`;
      document.body.appendChild(toast);
    } else {
      toast.querySelector('.sh-toast-icon').textContent = icon;
      toast.querySelector('.sh-toast-text').textContent = text;
    }

    // Сдвигаем окно левее над кнопкой "Подписаться"
    positionToastAboveSubscribe(toast);

    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, 1800);
  }

  /**
   * Нахождение активного видеоэлемента в Shorts
   */
  function findActiveVideo() {
    // 1. Поиск видео внутри активного рилса
    const activeRenderer = document.querySelector('ytd-reel-video-renderer[is-active]');
    if (activeRenderer) {
      const vid = activeRenderer.querySelector('video');
      if (vid) return vid;
    }

    // 2. Поиск играющего видео
    const videos = Array.from(document.querySelectorAll('ytd-shorts video, #shorts-container video, video.video-stream'));
    for (const v of videos) {
      if (!v.paused && v.currentTime > 0 && !v.ended) {
        return v;
      }
    }

    // 3. Ближайшее к центру экрана
    const centerY = window.innerHeight / 2;
    let bestVideo = null;
    let minDiff = Infinity;
    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      if (rect.height > 0) {
        const vCenter = rect.top + rect.height / 2;
        const diff = Math.abs(vCenter - centerY);
        if (diff < minDiff) {
          minDiff = diff;
          bestVideo = v;
        }
      }
    }

    return bestVideo || videos[0] || null;
  }

  /**
   * Переход к следующему видео (Next Short)
   */
  function scrollToNextShort(source = 'manual') {
    const now = Date.now();
    if (now - lastScrollTimestamp < 1100) return false;
    lastScrollTimestamp = now;

    if (autoScrollTimeout) {
      clearTimeout(autoScrollTimeout);
      autoScrollTimeout = null;
    }

    let success = false;

    // 1. Попытка нажать нативную кнопку YouTube Shorts "Вниз"
    const nextButtons = [
      '#navigation-button-down button',
      'ytd-shorts #navigation-button-down yt-icon-button button',
      '#navigation-button-down yt-button-shape button',
      'button[aria-label*="next" i]',
      'button[aria-label*="след" i]',
      '#shorts-player-controls #navigation-button-down'
    ];

    for (const sel of nextButtons) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        btn.click();
        success = true;
        break;
      }
    }

    // 2. Имитация нажатия стрелки вниз ArrowDown
    const keyEvent = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      keyCode: 40,
      which: 40,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    });

    const activeVid = findActiveVideo();
    if (activeVid) activeVid.dispatchEvent(keyEvent);
    document.body.dispatchEvent(keyEvent);
    window.dispatchEvent(keyEvent);

    // 3. Fallback: scrollIntoView следующего рилса
    if (!success) {
      const activeRenderer = document.querySelector('ytd-reel-video-renderer[is-active]');
      if (activeRenderer) {
        let next = activeRenderer.nextElementSibling;
        while (next && next.tagName.toLowerCase() !== 'ytd-reel-video-renderer') {
          next = next.nextElementSibling;
        }
        if (next) {
          next.scrollIntoView({ behavior: 'smooth', block: 'start' });
          success = true;
        }
      }
    }

    // 4. Fallback: прокрутка контейнера
    if (!success) {
      const container = document.querySelector('#shorts-container, ytd-shorts, #page-manager') || window;
      if (container.scrollBy) {
        container.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' });
        success = true;
      }
    }

    if (source === 'voice') {
      showToast('Голос: Далее ⏩', '🎙️');
    } else if (source === 'auto') {
      showToast('Автопрокрутка ⏩', '🔄');
    }

    return true;
  }

  /**
   * Переход к предыдущему видео (Prev Short)
   */
  function scrollToPrevShort() {
    const now = Date.now();
    if (now - lastScrollTimestamp < 1100) return false;
    lastScrollTimestamp = now;

    if (autoScrollTimeout) {
      clearTimeout(autoScrollTimeout);
      autoScrollTimeout = null;
    }

    let success = false;

    const prevButtons = [
      '#navigation-button-up button',
      'ytd-shorts #navigation-button-up yt-icon-button button',
      '#navigation-button-up yt-button-shape button',
      'button[aria-label*="previous" i]',
      'button[aria-label*="предыдущ" i]'
    ];

    for (const sel of prevButtons) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        btn.click();
        success = true;
        break;
      }
    }

    const keyEvent = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      code: 'ArrowUp',
      keyCode: 38,
      which: 38,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    });

    const activeVid = findActiveVideo();
    if (activeVid) activeVid.dispatchEvent(keyEvent);
    document.body.dispatchEvent(keyEvent);
    window.dispatchEvent(keyEvent);

    if (!success) {
      const activeRenderer = document.querySelector('ytd-reel-video-renderer[is-active]');
      if (activeRenderer) {
        let prev = activeRenderer.previousElementSibling;
        while (prev && prev.tagName.toLowerCase() !== 'ytd-reel-video-renderer') {
          prev = prev.previousElementSibling;
        }
        if (prev) {
          prev.scrollIntoView({ behavior: 'smooth', block: 'start' });
          success = true;
        }
      }
    }

    showToast('Голос: Назад ⏪', '🎙️');
    return true;
  }

  /**
   * Поставить лайк активному шортсу
   */
  function likeActiveShort() {
    const activeRenderer = document.querySelector('ytd-reel-video-renderer[is-active]');
    const root = activeRenderer || document;
    const likeBtn = root.querySelector('#like-button button, ytd-like-button-renderer button, [aria-label*="Нравится" i], [aria-label*="like" i]');
    if (likeBtn) {
      likeBtn.click();
      showToast('Голос: Лайк ❤️', '👍');
      return true;
    }
    return false;
  }

  /**
   * Пауза / Воспроизведение
   */
  function togglePlayback(forcePause = null) {
    const vid = findActiveVideo();
    if (!vid) return;

    if (forcePause === true || (forcePause === null && !vid.paused)) {
      vid.pause();
      showToast('Голос: Пауза ⏸️', '⏸️');
    } else {
      vid.play();
      showToast('Голос: Воспроизведение ▶️', '▶️');
    }
  }

  /**
   * Начать воспроизведение сначала
   */
  function replayCurrentVideo() {
    const vid = findActiveVideo();
    if (!vid) return;
    vid.currentTime = 0;
    vid.play();
    hasScrolledCurrent = false;
    showToast('Голос: Заново 🔄', '🔁');
  }

  /**
   * Проверка и планирование автоматической прокрутки видео
   */
  function checkAutoScroll(video) {
    if (!settings.autoScrollEnabled) return;
    if (hasScrolledCurrent) return;
    if (video.paused) return;

    const duration = video.duration;
    const current = video.currentTime;

    if (!duration || isNaN(duration) || duration < 1.0) return;

    // Обновляем визуальный прогресс-бар
    updateProgressBar(current, duration);

    // Условия завершения:
    // 1. Почти конец видео (за 0.25 сек)
    const isNearEnd = current >= duration - 0.25;
    // 2. Видео только что сделало loop (перескочило с конца на начало)
    const justLooped = (prevVideoTime > duration - 0.6 && current < 0.35);

    prevVideoTime = current;

    if (isNearEnd || justLooped || video.ended) {
      hasScrolledCurrent = true;

      const delayMs = Math.max(0, (settings.scrollDelay || 0) * 1000);
      const remainingTime = isNearEnd ? Math.max(0, (duration - current) * 1000) : 0;
      const totalWait = remainingTime + delayMs;

      if (autoScrollTimeout) clearTimeout(autoScrollTimeout);

      autoScrollTimeout = setTimeout(() => {
        // Убедимся, что видео все еще актуально и не на паузе
        if (findActiveVideo() === video && !video.paused) {
          scrollToNextShort('auto');
        }
      }, totalWait);
    }
  }

  /**
   * Обновление полосы прогресса видео
   */
  function updateProgressBar(current, duration) {
    if (!settings.showProgressBar) return;
    let fill = document.getElementById('sh-progress-fill');
    if (!fill) {
      const activeRenderer = document.querySelector('ytd-reel-video-renderer[is-active]');
      if (!activeRenderer) return;
      let bar = activeRenderer.querySelector('.sh-video-progress-container');
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'sh-video-progress-container';
        bar.innerHTML = '<div id="sh-progress-fill" class="sh-video-progress-fill"></div>';
        activeRenderer.appendChild(bar);
      }
      fill = document.getElementById('sh-progress-fill');
    }
    if (fill && duration > 0) {
      const percent = Math.min(100, Math.max(0, (current / duration) * 100));
      fill.style.width = percent + '%';
    }
  }

  /**
   * Подключение слушателей к активному видео
   */
  function attachVideoListeners(video) {
    if (!video || currentVideo === video) return;

    if (currentVideo) {
      currentVideo.removeEventListener('timeupdate', onTimeUpdate);
      currentVideo.removeEventListener('ended', onEnded);
      currentVideo.removeEventListener('play', onPlay);
    }

    currentVideo = video;
    hasScrolledCurrent = false;
    prevVideoTime = 0;
    if (autoScrollTimeout) {
      clearTimeout(autoScrollTimeout);
      autoScrollTimeout = null;
    }

    currentVideo.addEventListener('timeupdate', onTimeUpdate);
    currentVideo.addEventListener('ended', onEnded);
    currentVideo.addEventListener('play', onPlay);
  }

  function onTimeUpdate(e) {
    checkAutoScroll(e.target);
  }

  function onEnded(e) {
    checkAutoScroll(e.target);
  }

  function onPlay() {
    hasScrolledCurrent = false;
  }

  /**
   * Распознавание голосовых команд
   */
  function matchVoiceCommand(phrase) {
    const text = phrase.toLowerCase().trim();

    for (const cmd of COMMANDS.NEXT) {
      if (text.includes(cmd)) return 'NEXT';
    }
    for (const cmd of COMMANDS.PREV) {
      if (text.includes(cmd)) return 'PREV';
    }
    for (const cmd of COMMANDS.PAUSE) {
      if (text.includes(cmd)) return 'PAUSE';
    }
    for (const cmd of COMMANDS.PLAY) {
      if (text.includes(cmd)) return 'PLAY';
    }
    for (const cmd of COMMANDS.LIKE) {
      if (text.includes(cmd)) return 'LIKE';
    }
    for (const cmd of COMMANDS.REPLAY) {
      if (text.includes(cmd)) return 'REPLAY';
    }

    return null;
  }

  function executeVoiceCommand(commandName, rawPhrase) {
    const now = Date.now();
    if (now - lastVoiceCommandTimestamp < 1300) return;
    lastVoiceCommandTimestamp = now;

    console.log('[YT Shorts Voice] Выполнена команда:', commandName, 'из фразы:', rawPhrase);

    switch (commandName) {
      case 'NEXT':
        scrollToNextShort('voice');
        break;
      case 'PREV':
        scrollToPrevShort();
        break;
      case 'PAUSE':
        togglePlayback(true);
        break;
      case 'PLAY':
        togglePlayback(false);
        break;
      case 'LIKE':
        likeActiveShort();
        break;
      case 'REPLAY':
        replayCurrentVideo();
        break;
    }
  }

  /**
   * Инициализация Web Speech API
   */
  function initSpeechEngine() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('[YT Shorts Voice] Web Speech API не поддерживается в этом браузере.');
      updateHudMicStatus('unsupported');
      return null;
    }

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = settings.voiceLanguage || 'ru-RU';
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      isSpeechListening = true;
      micPermissionState = 'granted';
      updateHudMicStatus('listening');
    };

    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcript = event.results[i][0].transcript;
        if (!transcript) continue;

        updateTranscriptPreview(transcript);

        const command = matchVoiceCommand(transcript);
        if (command) {
          executeVoiceCommand(command, transcript);
          break;
        }
      }
    };

    rec.onerror = (event) => {
      console.log('[YT Shorts Voice] Ошибка распознавания:', event.error);
      if (event.error === 'not-allowed') {
        isSpeechListening = false;
        micPermissionState = 'denied';
        updateHudMicStatus('permission-needed');
      } else if (event.error === 'no-speech') {
        // Обычная пауза речи
      } else {
        updateHudMicStatus('idle');
      }
    };

    rec.onend = () => {
      isSpeechListening = false;
      updateHudMicStatus('idle');

      // Автоматический перезапуск непрерывного прослушивания
      if (settings.voiceEnabled && isShortsPage()) {
        clearTimeout(speechRestartTimeout);
        speechRestartTimeout = setTimeout(() => {
          if (settings.voiceEnabled && isShortsPage()) {
            startSpeechRecognition();
          }
        }, 350);
      }
    };

    return rec;
  }

  function startSpeechRecognition() {
    if (!settings.voiceEnabled || !isShortsPage()) return;
    if (isSpeechListening) return;

    if (!recognition) {
      recognition = initSpeechEngine();
    }
    if (!recognition) return;

    try {
      recognition.lang = settings.voiceLanguage || 'ru-RU';
      recognition.start();
    } catch (e) {
      // recognition уже может быть запущен
    }
  }

  function stopSpeechRecognition() {
    clearTimeout(speechRestartTimeout);
    if (recognition && isSpeechListening) {
      try {
        recognition.stop();
      } catch (e) {}
    }
    isSpeechListening = false;
    updateHudMicStatus('disabled');
  }

  /**
   * Запрос разрешения на использование микрофона по клику пользователя
   */
  async function requestMicrophonePermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      micPermissionState = 'granted';
      showToast('Микрофон подключен!', '🎙️');
      startSpeechRecognition();
    } catch (err) {
      console.warn('[YT Shorts Voice] Ошибка доступа к микрофону:', err);
      showToast('Доступ к микрофону отклонен', '⚠️');
      micPermissionState = 'denied';
      updateHudMicStatus('permission-needed');
    }
  }

  /**
   * Создание и внедрение плавающего HUD на странице YouTube Shorts
   */
  function injectHud() {
    if (document.getElementById('shorts-helper-hud')) return;

    const hud = document.createElement('div');
    hud.id = 'shorts-helper-hud';
    if (!settings.showHud) hud.style.display = 'none';

    hud.innerHTML = `
      <div class="sh-hud-box">
        <div class="sh-hud-header">
          <div class="sh-hud-title">
            <svg viewBox="0 0 24 24"><path d="M10 14.65v-5.3L15 12l-5 2.65zm7.77-4.33-1.2-1.2C15.7 8.24 14.47 7.7 13.11 7.42l.39-1.96C15.35 5.8 17 6.54 18.27 7.73l-.5.59zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>
            <span>Shorts Auto</span>
          </div>
          <div class="sh-hud-header-actions">
            <button class="sh-icon-btn" id="sh-btn-minimize" title="Свернуть / Развернуть">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13H5v-2h14v2z"/></svg>
            </button>
          </div>
        </div>
        
        <div class="sh-hud-content">
          <div class="sh-control-row">
            <span class="sh-control-label">🔄 Автопрокрутка</span>
            <label class="sh-switch">
              <input type="checkbox" id="sh-toggle-autoscroll" ${settings.autoScrollEnabled ? 'checked' : ''}>
              <span class="sh-slider"></span>
            </label>
          </div>

          <div class="sh-control-row">
            <span class="sh-control-label">🎙️ Голосовой скип</span>
            <label class="sh-switch">
              <input type="checkbox" id="sh-toggle-voice" ${settings.voiceEnabled ? 'checked' : ''}>
              <span class="sh-slider"></span>
            </label>
          </div>

          <div class="sh-voice-status disabled" id="sh-voice-status-box" title="Нажмите для проверки микрофона">
            <div class="sh-mic-dot"></div>
            <span id="sh-voice-status-text">Микрофон: выключен</span>
          </div>

          <div class="sh-transcript-preview" id="sh-transcript-preview"></div>
        </div>
      </div>
    `;

    document.body.appendChild(hud);

    // Слушатели событий виджета
    const toggleAuto = hud.querySelector('#sh-toggle-autoscroll');
    toggleAuto.addEventListener('change', (e) => {
      settings.autoScrollEnabled = e.target.checked;
      chrome.storage.sync.set({ autoScrollEnabled: settings.autoScrollEnabled });
      showToast(settings.autoScrollEnabled ? 'Автопрокрутка ВКЛ' : 'Автопрокрутка ВЫКЛ', '🔄');
    });

    const toggleVoice = hud.querySelector('#sh-toggle-voice');
    toggleVoice.addEventListener('change', (e) => {
      settings.voiceEnabled = e.target.checked;
      chrome.storage.sync.set({ voiceEnabled: settings.voiceEnabled });
      if (settings.voiceEnabled) {
        startSpeechRecognition();
        showToast('Голосовое управление ВКЛ', '🎙️');
      } else {
        stopSpeechRecognition();
        showToast('Голосовое управление ВЫКЛ', '🔇');
      }
    });

    const statusBox = hud.querySelector('#sh-voice-status-box');
    statusBox.addEventListener('click', () => {
      if (!settings.voiceEnabled) {
        toggleVoice.checked = true;
        toggleVoice.dispatchEvent(new Event('change'));
      }
      requestMicrophonePermission();
    });

    const btnMinimize = hud.querySelector('#sh-btn-minimize');
    btnMinimize.addEventListener('click', (e) => {
      e.stopPropagation();
      isHudMinimized = !isHudMinimized;
      hud.classList.toggle('minimized', isHudMinimized);
    });

    hud.addEventListener('click', (e) => {
      if (isHudMinimized && !e.target.closest('#sh-btn-minimize')) {
        isHudMinimized = false;
        hud.classList.remove('minimized');
      }
    });

    updateHudUI();
  }

  function updateHudUI() {
    const hud = document.getElementById('shorts-helper-hud');
    if (!hud) return;

    const toggleAuto = hud.querySelector('#sh-toggle-autoscroll');
    if (toggleAuto) toggleAuto.checked = settings.autoScrollEnabled;

    const toggleVoice = hud.querySelector('#sh-toggle-voice');
    if (toggleVoice) toggleVoice.checked = settings.voiceEnabled;

    if (!settings.voiceEnabled) {
      updateHudMicStatus('disabled');
    } else if (isSpeechListening) {
      updateHudMicStatus('listening');
    } else {
      updateHudMicStatus('idle');
    }
  }

  function updateHudMicStatus(status) {
    const box = document.getElementById('sh-voice-status-box');
    const label = document.getElementById('sh-voice-status-text');
    if (!box || !label) return;

    box.className = 'sh-voice-status ' + status;

    switch (status) {
      case 'listening':
        label.textContent = 'Слушаю: "Далее", "Назад"...';
        break;
      case 'permission-needed':
        label.textContent = 'Нажмите, чтобы включить микрофон';
        break;
      case 'unsupported':
        label.textContent = 'Распознавание не поддерживается';
        break;
      case 'disabled':
        label.textContent = 'Голос выключен';
        break;
      case 'idle':
      default:
        label.textContent = settings.voiceEnabled ? 'Ожидание голоса...' : 'Голос выключен';
        break;
    }
  }

  let transcriptClearTimer = null;
  function updateTranscriptPreview(text) {
    const preview = document.getElementById('sh-transcript-preview');
    if (!preview) return;
    preview.textContent = `🎙️ "${text}"`;
    clearTimeout(transcriptClearTimer);
    transcriptClearTimer = setTimeout(() => {
      if (preview) preview.textContent = '';
    }, 2500);
  }

  /**
   * Главный цикл отслеживания страницы и активного видео
   */
  function scanPage() {
    if (!isShortsPage()) {
      const hud = document.getElementById('shorts-helper-hud');
      if (hud) hud.style.display = 'none';
      if (isSpeechListening) stopSpeechRecognition();
      return;
    }

    // Если на странице Shorts:
    injectHud();
    const hud = document.getElementById('shorts-helper-hud');
    if (hud && settings.showHud) hud.style.display = 'block';

    const video = findActiveVideo();
    if (video) {
      attachVideoListeners(video);
    }

    // Если голосовое управление включено, а распознавание не запущено — стартуем
    if (settings.voiceEnabled && !isSpeechListening) {
      startSpeechRecognition();
    }
  }

  /**
   * Инициализация при загрузке скрипта
   */
  async function init() {
    await loadSettings();

    // Проверяем статус микрофона через Permissions API
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'microphone' }).then((status) => {
        micPermissionState = status.state;
        status.onchange = () => {
          micPermissionState = status.state;
          if (status.state === 'granted' && settings.voiceEnabled) {
            startSpeechRecognition();
          }
        };
      }).catch(() => {});
    }

    scanPage();

    // Слушаем SPA-навигацию YouTube
    window.addEventListener('yt-navigate-finish', () => {
      scanPage();
    });
    window.addEventListener('yt-page-data-updated', () => {
      scanPage();
    });
    window.addEventListener('popstate', () => {
      scanPage();
    });

    // MutationObserver для обнаружения смены активного рилса
    const observer = new MutationObserver(() => {
      if (isShortsPage()) {
        const video = findActiveVideo();
        if (video && video !== currentVideo) {
          attachVideoListeners(video);
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['is-active', 'src']
    });

    // Регулярный опрос для надежности
    setInterval(scanPage, 1500);
  }

  // Запуск
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
