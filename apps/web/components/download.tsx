'use client';
import { useEffect, useState } from 'react';

type Platform = 'android' | 'ios' | 'desktop';
const tabs: { id: Platform; label: string }[] = [
  { id: 'android', label: 'Android' },
  { id: 'ios', label: 'iPhone и iPad' },
  { id: 'desktop', label: 'Компьютер' },
];

/** iPadOS reports itself as a Mac; a touch screen on "MacIntel" gives it away. */
function detect(): Platform {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  return 'desktop';
}

// One page for every device: the Android app is an APK; iPhone, iPad and computers install the same app from
// the browser (it is a PWA at /app), so it gets its own icon and window and is always the latest version.
export default function DownloadChooser() {
  const [platform, setPlatform] = useState<Platform>('android');
  useEffect(() => { setPlatform(detect()); }, []);
  return <>
    <div className="download-tabs" role="tablist" aria-label="Устройство">
      {tabs.map(t => <button key={t.id} type="button" role="tab" aria-selected={platform === t.id} className={platform === t.id ? 'active' : ''} onClick={() => setPlatform(t.id)}>{t.label}</button>)}
    </div>

    {platform === 'android' && <section role="tabpanel" aria-label="Android">
      <p>Для телефонов и планшетов на Android 8 и новее.</p>
      <a className="button primary download-button" href="/app/ijara360.apk" download="ijara360.apk">Скачать для Android</a>
      <p className="form-hint">Файл около 55 МБ.</p>
      <ol className="download-steps">
        <li>Нажмите «Скачать для Android» и дождитесь окончания загрузки.</li>
        <li>Откройте скачанный файл <b>ijara360.apk</b> — из уведомления или из «Загрузок».</li>
        <li>Если телефон спросит, разрешите установку из этого источника и нажмите «Установить».</li>
      </ol>
      <p className="form-hint">Вручную — только в первый раз. Когда выйдет новая версия, приложение само предложит обновиться.</p>
    </section>}

    {platform === 'ios' && <section role="tabpanel" aria-label="iPhone и iPad">
      <p>Для iPhone и iPad: приложение ставится прямо из Safari — без App Store.</p>
      <a className="button primary download-button" href="/app/">Открыть Ijara360</a>
      <ol className="download-steps">
        <li>Откройте эту страницу в <b>Safari</b>.</li>
        <li>Нажмите кнопку «Поделиться» <span aria-hidden="true">(квадрат со стрелкой вверх)</span> — внизу экрана на iPhone, вверху на iPad.</li>
        <li>Выберите «На экран «Домой»» и нажмите «Добавить».</li>
      </ol>
      <p className="form-hint">Значок Ijara360 появится рядом с другими приложениями и откроется на весь экран. Обновления приходят сами.</p>
    </section>}

    {platform === 'desktop' && <section role="tabpanel" aria-label="Компьютер">
      <p>Для Windows, Mac и Linux. Приложение откроется в своём окне со значком в «Пуске» или в Dock.</p>
      <a className="button primary download-button" href="/app/?install=1">Установить на компьютер</a>
      <ol className="download-steps">
        <li>Нажмите кнопку — откроется приложение Ijara360.</li>
        <li>Нажмите «Установить» внизу окна. Нет такой кнопки — нажмите значок установки в адресной строке Chrome или Edge.</li>
        <li>В Safari на Mac: меню «Файл» → «Добавить в Dock».</li>
      </ol>
      <p className="form-hint">Обновления приходят сами. Сотрудникам за компьютером удобнее полный кабинет управления: <a href="https://admin.ijara360.uz/login">admin.ijara360.uz</a>.</p>
    </section>}
  </>;
}
