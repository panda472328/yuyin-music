import { useEffect, useRef, useState, type RefObject } from 'react'
import { ArrowUpLeft, LoaderCircle, Search, X } from 'lucide-react'
import { api } from './api'
import type { SearchMode } from './shared/search-mode'

interface Props {
  query: string
  mode: SearchMode
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange(value: string): void
  onModeChange(mode: SearchMode): void
  onSearch(query: string): void
}

export default function SearchBox({ query, mode, inputRef, onQueryChange, onModeChange, onSearch }: Props) {
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [composing, setComposing] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [active, setActive] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const sequence = useRef(0)
  const composingRef = useRef(false)
  const eligible = mode === 'song' && focused && !dismissed && !composing && Boolean(query.trim())
  const open = eligible && (loading || failed || suggestions.length > 0)

  function dismiss() {
    sequence.current++
    setDismissed(true)
    setActive(-1)
    setLoading(false)
  }

  useEffect(() => {
    const request = ++sequence.current
    setSuggestions([]); setActive(-1); setFailed(false); setLoading(false)
    if (!eligible) return
    let disposed = false
    const timer = setTimeout(() => {
      setLoading(true)
      void api.searchSuggestions(query.trim()).then(values => {
        if (!disposed && sequence.current === request) setSuggestions(values.slice(0, 10))
      }).catch(() => {
        if (!disposed && sequence.current === request) setFailed(true)
      }).finally(() => {
        if (!disposed && sequence.current === request) setLoading(false)
      })
    }, 250)
    return () => { disposed = true; clearTimeout(timer) }
  }, [eligible, query, mode])

  useEffect(() => {
    if (open && active >= 0) document.getElementById(`song-suggestion-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  function submit(value = query) {
    if (composingRef.current) return
    dismiss()
    onSearch(value)
  }
  function choose(value: string) {
    onQueryChange(value)
    submit(value)
    inputRef.current?.focus()
  }

  return <form className="search-box" onSubmit={event => { event.preventDefault(); submit() }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); dismiss() }
  }} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { sequence.current++; setFocused(false); setActive(-1) }
  }}>
    <div className="search-mode" role="group" aria-label="搜索模式">
      <button type="button" aria-pressed={mode === 'song'} onClick={() => { dismiss(); onModeChange('song') }}>歌名搜索</button>
      <button type="button" aria-pressed={mode === 'video'} onClick={() => { dismiss(); onModeChange('video') }}>视频搜索</button>
    </div>
    <Search size={16} />
    <input ref={inputRef} aria-label={mode === 'song' ? '搜索歌名或歌手' : '搜索 Bilibili 视频'}
      role={mode === 'song' ? 'combobox' : undefined} aria-autocomplete={mode === 'song' ? 'list' : undefined}
      aria-expanded={mode === 'song' ? open : undefined} aria-controls={open ? 'song-search-suggestions' : undefined}
      aria-activedescendant={open && active >= 0 ? `song-suggestion-${active}` : undefined}
      autoComplete="off" maxLength={80} placeholder={mode === 'song' ? '歌名、歌手，或现场版本' : '搜索视频、播客'} value={query}
      onFocus={() => { setFocused(true); setDismissed(false) }}
      onChange={event => { sequence.current++; setSuggestions([]); setActive(-1); setFailed(false); setDismissed(false); onQueryChange(event.target.value) }}
      onCompositionStart={() => { composingRef.current = true; sequence.current++; setComposing(true) }}
      onCompositionEnd={() => { composingRef.current = false; setComposing(false) }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return
        if (event.key === 'Tab') { dismiss(); return }
        if (open && suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault()
          setActive(current => event.key === 'ArrowDown' ? (current + 1) % suggestions.length : (current <= 0 ? suggestions.length - 1 : current - 1))
        } else if (event.key === 'Enter' && open && active >= 0 && active < suggestions.length) { event.preventDefault(); choose(suggestions[active]) }
      }} />
    <kbd>Ctrl K</kbd>
    {query && <button type="button" aria-label="清空搜索" onClick={() => { dismiss(); onQueryChange(''); inputRef.current?.focus() }}><X size={14} /></button>}
    {open && <div className="search-suggestions">
      <div className="search-suggestions-heading">搜索联想<span>Bilibili</span></div>
      <div id="song-search-suggestions" role="listbox" aria-label="歌名搜索联想" className="search-suggestions-list">
        {suggestions.map((value, index) => <button type="button" role="option" id={`song-suggestion-${index}`} key={value}
          aria-selected={index === active} tabIndex={-1} onPointerDown={event => event.preventDefault()} onClick={() => choose(value)}>
          <Search size={14} /><span>{value}</span><ArrowUpLeft size={14} />
        </button>)}
      </div>
      {loading && <p className="search-suggestions-status" role="status"><LoaderCircle size={14} className="spin" />正在获取联想…</p>}
      {failed && <p className="search-suggestions-status" role="status">联想暂不可用，仍可直接搜索</p>}
    </div>}
  </form>
}
