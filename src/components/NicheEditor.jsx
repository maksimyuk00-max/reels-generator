/**
 * NicheEditor — per-account niche configuration для AI relevance.
 *
 * Props:
 *   config: { niche_description, niche_keywords[], niche_avoid[], niche_examples[] }
 *   onChange(patch): updates single or multiple fields
 */

import { useState } from 'react'

export default function NicheEditor({ config, onChange }) {
  const description = config?.niche_description || ''
  const keywords = Array.isArray(config?.niche_keywords) ? config.niche_keywords : []
  const avoid = Array.isArray(config?.niche_avoid) ? config.niche_avoid : []
  const examples = Array.isArray(config?.niche_examples) ? config.niche_examples : []

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                     alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>
          🎯 Ніша для AI (per-account relevance)
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {description || keywords.length || avoid.length
            ? 'Налаштовано' : 'Не налаштовано — AI не буде лайкати'}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
        {/* Description */}
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)',
                           display: 'block', marginBottom: 4 }}>
            Опис ніші <span style={{ color: '#ef4444' }}>*</span>
          </label>
          <textarea
            value={description}
            onChange={e => onChange({ niche_description: e.target.value })}
            placeholder="Воїнська філософія, стоїцизм, ментальна дисципліна. Контент для чоловіків які прагнуть самовдосконалення."
            rows={3}
            style={{
              width: '100%', fontSize: 13, padding: 8,
              border: '1px solid var(--border)', borderRadius: 6,
              background: 'var(--bg)', color: 'var(--text)',
              resize: 'vertical', fontFamily: 'inherit',
            }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
            1-3 речення про те що цікавить акаунт (AI використовує як основу)
          </div>
        </div>

        {/* Keywords */}
        <TagInput
          label="Ключові теми (що лайкаємо)"
          hint="Enter після кожного тегу. Додай 5-15 для кращої точності AI"
          placeholder="стоїцизм"
          tags={keywords}
          onAdd={t => onChange({ niche_keywords: [...keywords, t] })}
          onRemove={i => onChange({ niche_keywords: keywords.filter((_, idx) => idx !== i) })}
          color="#22c55e"
        />

        {/* Avoid */}
        <TagInput
          label="Уникати (точно НЕ лайкаємо)"
          hint="Дуже важливо! Без цього AI може лайкати нерелевантний шум"
          placeholder="їжа"
          tags={avoid}
          onAdd={t => onChange({ niche_avoid: [...avoid, t] })}
          onRemove={i => onChange({ niche_avoid: avoid.filter((_, idx) => idx !== i) })}
          color="#ef4444"
        />

        {/* Examples */}
        <TagInput
          label="Приклади акаунтів (опц)"
          hint="@username подібних акаунтів — AI звіряється з ними"
          placeholder="@stoicism.philosophy"
          tags={examples}
          onAdd={t => onChange({ niche_examples: [...examples,
                                                  t.startsWith('@') ? t : '@' + t] })}
          onRemove={i => onChange({ niche_examples: examples.filter((_, idx) => idx !== i) })}
          color="#6366f1"
        />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────

function TagInput({ label, hint, placeholder, tags, onAdd, onRemove, color }) {
  const [value, setValue] = useState('')

  const submit = () => {
    const v = value.trim()
    if (!v) return
    if (tags.includes(v)) { setValue(''); return }
    onAdd(v)
    setValue('')
  }

  return (
    <div>
      <label style={{ fontSize: 12, color: 'var(--text-muted)',
                       display: 'block', marginBottom: 4 }}>
        {label}
      </label>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8,
        border: '1px solid var(--border)', borderRadius: 6,
        background: 'var(--bg)', minHeight: 42,
      }}>
        {tags.map((t, idx) => (
          <span key={idx} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '3px 8px', fontSize: 12, borderRadius: 4,
            background: color + '20', color: color,
            border: `1px solid ${color}50`,
          }}>
            {t}
            <button
              onClick={() => onRemove(idx)}
              style={{
                background: 'transparent', border: 'none', color,
                cursor: 'pointer', fontSize: 14, padding: 0,
                lineHeight: 1,
              }}
              title="Видалити"
            >×</button>
          </span>
        ))}
        <input
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Backspace' && !value && tags.length > 0) {
              onRemove(tags.length - 1)
            }
          }}
          onBlur={submit}  // автозбереження якщо користувач клікнув поза input
          placeholder={placeholder}
          style={{
            flex: 1, minWidth: 120, fontSize: 13,
            border: 'none', outline: 'none',
            background: 'transparent', color: 'var(--text)',
          }}
        />
      </div>
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
          {hint}
        </div>
      )}
    </div>
  )
}
