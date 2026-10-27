import type { Metadata } from 'next';
import { Logo } from '../../components/brand';
import DownloadChooser from '../../components/download';
import '../applications.css';

export const metadata: Metadata = { title: 'Скачать Ijara360', description: 'Приложение Ijara360 для телефона, планшета и компьютера.' };

// Short public link for the app (ijara360.uz/download): picks the visitor's device and shows the one way to
// install on it — APK on Android, "Add to Home Screen" on iPhone/iPad, browser install on a computer.
export default function Page() {
  return <main className="apply-shell download-page">
    <header><a className="apply-brand" href="/apply" aria-label="ijara360"><Logo size={28}/></a><span>Приложение</span></header>
    <section className="apply-card">
      <h1>Приложение Ijara360</h1>
      <p>Для жильцов и сотрудников дома: оплаты, заявки, уведомления. На телефоне, планшете и компьютере.</p>
      <DownloadChooser/>
    </section>
  </main>;
}
