import { Check } from 'lucide-react'
import { LYRIC_STYLE_OPTIONS, type LyricStyle } from './shared/lyric-styles'

export default function LyricStylePicker({ value, onChange, disabled = false, label, desktop = false }: {
  value: LyricStyle; onChange: (style: LyricStyle) => void; disabled?: boolean; label: string; desktop?: boolean
}) {
  return <div className="lyric-style-options" data-preview-target={desktop ? 'desktop' : 'player'} role="group" aria-label={label}>
    {LYRIC_STYLE_OPTIONS.map(option => <button type="button" key={option.value}
      className={`lyric-style-option ${value === option.value ? 'selected' : ''}`}
      aria-pressed={value === option.value} disabled={disabled} onClick={() => onChange(option.value)}>
      <span className="lyric-style-preview" data-lyric-style={option.value} aria-hidden="true">
        <small>让旋律慢慢响起</small><strong>把喜欢的声音</strong><small>留在身边</small>
      </span>
      <span className="lyric-style-detail"><strong>{option.label}</strong><Check size={15} aria-hidden="true" /></span>
      <small className="lyric-style-description">{option.description}</small>
    </button>)}
  </div>
}
