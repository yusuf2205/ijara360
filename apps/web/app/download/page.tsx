import type { Metadata } from 'next';
import { Logo } from '../../components/brand';
import '../applications.css';

export const metadata: Metadata = { title: 'Скачать Ijara360 для Android', description: 'Приложение Ijara360 для жильцов и сотрудников дома.' };

// Short public link for the Android app (ijara360.uz/download): one big button and three steps, because the
// APK is installed outside Google Play and people need to know to allow the install once.
export default function Page() {
  return <main className="apply-shell download-page">
    <header><a className="apply-brand" href="/apply" aria-label="ijara360"><Logo size={28}/></a><span>Приложение</span></header>
    <section className="apply-card">
      <h1>Приложение Ijara360</h1>
      <p>Для жильцов и сотрудников дома: оплаты, заявки, уведомления. Android 8 и новее.</p>
      <a className="button primary download-button" href="/app/ijara360.apk" download="ijara360.apk">Скачать для Android</a>
      <p className="form-hint">Файл около 55 МБ.</p>
      <h2>Как установить</h2>
      <ol className="download-steps">
        <li>Нажмите «Скачать для Android» и дождитесь окончания загрузки.</li>
        <li>Откройте скачанный файл <b>ijara360.apk</b> — из уведомления или из «Загрузок».</li>
        <li>Если телефон спросит, разрешите установку из этого источника и нажмите «Установить».</li>
      </ol>
      <p className="form-hint">Устанавливать вручную нужно только один раз. Когда выйдет новая версия, приложение само предложит обновиться.</p>
      <p className="form-hint">iPhone: приложения в App Store пока нет — откройте <a href="/app">веб-версию</a> в Safari.</p>
    </section>
  </main>;
}
