import { useState } from 'react'
import UtmBuilder from './UtmBuilder'
import './UtmLinks.css'

// Hokan-лендінг + всі готові UTM-лінки для трекінгу в ConvertKit.
// Лінки згруповані по каналу і кампанії. Натисни Copy щоб покласти в буфер.
// Джерело правди — те, що минулого разу заверифікували end-to-end через
// /v3/subscribers (підписник з UTM-полями зберігається в Kit коректно).

const groups = [
  {
    section: 'Reddit',
    description: 'Пости і коментарі у тематичних сабах. Кампанія warrior_v1 — основна.',
    links: [
      {
        label: 'Reddit post — основна кампанія',
        url: 'https://thehokan.vercel.app/?utm_source=reddit&utm_medium=post&utm_campaign=warrior_v1&utm_content=l1_comparison',
        notes: 'L1 порівняння warrior vs modern. Клік з поста → лендінг.',
      },
      {
        label: 'Reddit comment — основна кампанія',
        url: 'https://thehokan.vercel.app/?utm_source=reddit&utm_medium=comment&utm_campaign=warrior_v1&utm_content=l1_comparison',
        notes: 'Коментар під чужим постом (L1 хук).',
      },
    ],
  },
  {
    section: 'Threads — Hokan',
    description: 'Акаунт hokan.app. Кампанія hokan_account — окремий bucket.',
    links: [
      {
        label: 'Threads bio — Hokan',
        url: 'https://thehokan.vercel.app/?utm_source=threads&utm_medium=bio&utm_campaign=hokan_account&utm_content=hokan_bio',
        notes: 'Лінк у профілі hokan.app.',
      },
      {
        label: 'Threads pinned post — Hokan',
        url: 'https://thehokan.vercel.app/?utm_source=threads&utm_medium=pinned&utm_campaign=hokan_account&utm_content=hokan_pinned',
        notes: 'Закріплений пост із CTA.',
      },
    ],
  },
  {
    section: 'Threads — Sayana',
    description: 'Акаунт sayana.meansmillion. Кампанія sayana_account — окремий bucket.',
    links: [
      {
        label: 'Threads bio — Sayana',
        url: 'https://thehokan.vercel.app/?utm_source=threads&utm_medium=bio&utm_campaign=sayana_account&utm_content=sayana_bio',
        notes: 'Лінк у профілі Sayana.',
      },
      {
        label: 'Threads pinned post — Sayana',
        url: 'https://thehokan.vercel.app/?utm_source=threads&utm_medium=pinned&utm_campaign=sayana_account&utm_content=sayana_pinned',
        notes: 'Закріплений пост із CTA.',
      },
    ],
  },
  {
    section: 'Reddit — Sayana sub',
    description: 'r/sayanasupaling. Кампанія sayana_account, utm_content починається з sayana_sub_.',
    links: [
      {
        label: 'Reddit post — Sayana sub',
        url: 'https://thehokan.vercel.app/?utm_source=reddit&utm_medium=post&utm_campaign=sayana_account&utm_content=sayana_sub_post',
        notes: 'Пост у r/sayanasupaling.',
      },
      {
        label: 'Reddit comment — Sayana sub',
        url: 'https://thehokan.vercel.app/?utm_source=reddit&utm_medium=comment&utm_campaign=sayana_account&utm_content=sayana_sub_comment',
        notes: 'Коментар у r/sayanasupaling.',
      },
    ],
  },
  {
    section: 'Тестові лінки',
    description: 'Швидкі тести для перевірки трекінгу. Не поширюй — це тільки для тебе.',
    links: [
      {
        label: 'Test — Instagram story',
        url: 'https://thehokan.vercel.app/?utm_source=instagram&utm_medium=story&utm_campaign=warrior_v1&utm_content=hook_01',
        notes: 'Тестовий лінк з повним набором utm_*.',
      },
      {
        label: 'Test — Direct (без UTM)',
        url: 'https://thehokan.vercel.app/',
        notes: 'Без UTM → attributionSource() поверне "direct".',
      },
    ],
  },
]

export default function UtmLinks() {
  const [toast, setToast] = useState('')

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      setToast('Скопійовано')
    } catch {
      setToast('Не вдалося скопіювати')
    }
    setTimeout(() => setToast(''), 1400)
  }

  return (
    <div className="page utm-page">
      <header className="page-header">
        <h1>UTM Links</h1>
        <p className="page-sub">
          Готові лінки для Hokan-лендінгу. Кожен клік пише utm_source / utm_medium /
          utm_campaign у ConvertKit — фільтруй у Subscribers і бач, звідки приходять.
        </p>
      </header>

      {groups.map((g) => (
        <section key={g.section} className="card utm-group">
          <div className="utm-group-head">
            <h2>{g.section}</h2>
            {g.description && <p className="utm-desc">{g.description}</p>}
          </div>
          <div className="utm-links">
            {g.links.map((l) => (
              <div key={l.url} className="utm-link-row">
                <div className="utm-link-main">
                  <span className="utm-label">{l.label}</span>
                  <code className="utm-url">{l.url}</code>
                  {l.notes && <span className="utm-notes">{l.notes}</span>}
                </div>
                <div className="utm-actions">
                  <button className="btn btn-primary" onClick={() => copy(l.url)}>
                    Copy
                  </button>
                  <a className="btn btn-secondary" href={l.url} target="_blank" rel="noreferrer">
                    Open
                  </a>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className="card utm-tips">
        <h2>Як читати статистику в ConvertKit</h2>
        <ul>
          <li>
            Subscribers → Filter → Custom field → <code>utm_campaign</code> → is →{' '}
            <code>warrior_v1</code> — усі підписники з основної кампанії.
          </li>
          <li>
            <code>utm_campaign = hokan_account</code> — лише Threads Hokan.
          </li>
          <li>
            <code>utm_campaign = sayana_account</code> — лише Threads Sayana.
          </li>
          <li>
            <code>utm_medium = pinned</code> vs <code>bios</code> — pinned vs bio.
          </li>
          <li>
            Без UTM → поле <code>source</code> буде <code>direct</code>.
          </li>
        </ul>
      </section>

      <section className="card utm-builder-card">
        <div className="utm-builder-head">
          <h2>UTM Builder</h2>
          <p className="utm-desc">
            Генератор довільних лінків. Заповнюй поля — отримуєш URL, який можна
            копіювати. Готові пресети зберігаються локально.
          </p>
        </div>
        <UtmBuilder />
      </section>

      {toast && <div className="utm-toast">{toast}</div>}
    </div>
  )
}
