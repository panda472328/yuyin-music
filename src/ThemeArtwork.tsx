import { Disc3, Headphones, Heart, Music2, Radio, Volume2 } from 'lucide-react'

/** Decorative inventory built from layout and icons, never a scene/background image. */
export default function ThemeArtwork() {
  const items = [Music2, null, Heart, null, Disc3, null, Headphones, null, Radio]
  return <div className="block-inventory-art" aria-hidden="true">
    <span className="block-inventory-title">音乐物品栏</span>
    <div className="block-inventory-grid">{items.map((Item, index) => <span className={`block-slot ${index === 4 ? 'equipped' : ''}`} key={index}>{Item && <Item size={26} strokeWidth={2.5} />}{Item && <small>{index === 4 ? '1' : '♪'}</small>}</span>)}</div>
    <div className="block-inventory-caption"><Volume2 size={16} /><span>装备一首好心情</span></div>
    <div className="block-experience"><i /></div>
  </div>
}
