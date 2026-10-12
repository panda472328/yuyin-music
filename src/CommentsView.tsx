import { useId, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronUp, ExternalLink, LoaderCircle, MessageCircle, RefreshCw, Send, ThumbsUp, UserRound, X } from 'lucide-react'
import type { BilibiliAccount, Song } from '../electron/types'
import { MAX_COMMENT_LENGTH, type VideoComment } from './shared/comments'
import { commentsReadBusy, type CommentsAPI, type CommentsController, type CommentsState } from './comments-controller'
import { useComments } from './useComments'
import './comments.css'

export interface CommentsViewProps {
  song: Song | null
  account: BilibiliAccount | null
  accountChecking?: boolean
  sessionKey?: string | number
  commentsApi: CommentsAPI
  onLogin: () => void | Promise<void>
  openingLogin?: boolean
  onOpenSource?: () => void
}
const commentTime = (timestamp: number) => {
  const date = new Date(timestamp * 1000)
  return Number.isFinite(date.getTime()) ? { dateTime: date.toISOString(), label: date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) } : { dateTime: undefined, label: '' }
}
function Avatar({ comment }: { comment: VideoComment }) {
  const [failed, setFailed] = useState(false)
  return <span className="comment-avatar">{comment.author.avatar && !failed ? <img src={comment.author.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <UserRound size={19} aria-hidden="true" />}</span>
}
function CommentItem({ comment, rootId, nested = false, controller, state, canWrite, onReply }: { comment: VideoComment; rootId: string; nested?: boolean; controller: CommentsController; state: CommentsState; canWrite: boolean; onReply: (comment: VideoComment, rootId: string) => void }) {
  const busy = state.likesBusy.includes(comment.id)
  const writing = state.posting || state.likesBusy.length > 0
  const thread = state.threads[comment.id]
  const time = commentTime(comment.createdAt)
  return <article className={`comment-item ${nested ? 'comment-item-nested' : ''}`} aria-label={`${comment.author.username}的评论`}>
    <Avatar comment={comment} />
    <div className="comment-body">
      <div className="comment-meta"><strong>{comment.author.username}</strong><time dateTime={time.dateTime}>{time.label}</time></div>
      <p className="comment-message">{comment.message}</p>
      <div className="comment-actions">
        <button type="button" className={comment.liked ? 'is-liked' : ''} aria-label={`${comment.liked ? '取消点赞' : '点赞'} ${comment.author.username}的评论`} aria-pressed={comment.liked} disabled={!canWrite || writing} title={!canWrite ? '登录并完成评论加载后才能点赞' : comment.liked ? '取消点赞' : '点赞'} onClick={() => void controller.toggleLike(comment)}>{busy ? <LoaderCircle size={14} className="spin" /> : <ThumbsUp size={14} />}{comment.likeCount.toLocaleString()}</button>
        <button type="button" disabled={!canWrite || writing} onClick={() => onReply(comment, rootId)}><MessageCircle size={14} />回复</button>
        {!nested && comment.replyCount > 0 && <button type="button" className="comment-thread-toggle" aria-expanded={Boolean(thread?.expanded)} aria-controls={`comment-thread-${comment.id}`} disabled={writing || state.phase !== 'ready'} onClick={() => controller.toggleThread(comment)}>{thread?.expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{thread?.expanded ? '收起回复' : `查看 ${comment.replyCount.toLocaleString()} 条回复`}</button>}
      </div>
      {!nested && thread?.expanded && <section id={`comment-thread-${comment.id}`} className="comment-thread" aria-label={`回复 ${comment.author.username}`} aria-busy={thread.loading}>
        {thread.comments.map(reply => <CommentItem key={reply.id} comment={reply} rootId={comment.id} nested controller={controller} state={state} canWrite={canWrite} onReply={onReply} />)}
        {thread.error && <div className="comments-inline-error" role="alert"><span>{thread.error}</span><button type="button" className="text-button" disabled={thread.loading || writing} onClick={() => void controller.loadReplies(comment.id, thread.page ? thread.page + 1 : 1)}>重新获取回复</button></div>}
        {thread.loading && <p className="comments-inline-status" role="status"><LoaderCircle size={14} className="spin" />正在读取回复…</p>}
        {!thread.loading && !thread.error && !thread.comments.length && <p className="comments-inline-status">暂无可见回复，可能已被删除或尚未公开。</p>}
        {thread.hasMore && !thread.error && <button type="button" className="text-button comment-replies-more" disabled={thread.loading || writing} onClick={() => void controller.loadReplies(comment.id)}>{thread.loading ? <LoaderCircle size={14} className="spin" /> : <ChevronDown size={14} />}加载更多回复</button>}
      </section>}
    </div>
  </article>
}

export default function CommentsView({ song, account, accountChecking = false, sessionKey, commentsApi, onLogin, openingLogin = false, onOpenSource }: CommentsViewProps) {
  const { state, controller } = useComments({ commentsApi, bvid: song?.bvid ?? null, mid: account?.mid ?? null, checking: accountChecking, sessionKey })
  const textarea = useRef<HTMLTextAreaElement>(null)
  const inputId = useId()
  const canWrite = Boolean(account) && !accountChecking && !state.closed && state.phase === 'ready' && !commentsReadBusy(state)
  const writing = state.posting || state.likesBusy.length > 0
  const tooLong = state.draft.trim().length > MAX_COMMENT_LENGTH
  const reply = (comment: VideoComment, rootId: string) => { controller.setReplyTarget(comment, rootId); textarea.current?.focus() }
  return <section className="comments-page" aria-label="Bilibili 视频评论区">
    <header className="comments-heading"><div><div className="eyebrow">HEAR WHAT OTHERS SAY</div><h1>评论区<span className="heading-dot">.</span></h1><p>听见同一段声音，也看看大家在说什么。</p></div><span className="comments-source-badge"><MessageCircle size={15} />Bilibili 原视频</span></header>
    {!song ? <div className="comments-placeholder"><MessageCircle size={34} strokeWidth={1.3} /><h2>先播放一段声音</h2><p>开始播放后，这里会自动读取对应 Bilibili 视频的评论区。</p></div> : <>
      <div className="comments-video"><div><strong title={song.title}>{song.title}</strong><p>{song.bvid}<span aria-hidden="true"> · </span>评论来自当前原视频，切换歌曲会自动更新</p></div>{onOpenSource && <button type="button" className="text-button" onClick={onOpenSource}>打开源视频<ExternalLink size={14} /></button>}</div>
      <div className="comments-toolbar"><div className="comments-sort" role="group" aria-label="评论排序"><button type="button" aria-pressed={state.sort === 'hot'} disabled={writing} onClick={() => controller.setSort('hot')}>热门评论</button><button type="button" aria-pressed={state.sort === 'new'} disabled={writing} onClick={() => controller.setSort('new')}>最新评论</button></div><span className="comments-total">{state.phase === 'ready' ? `${state.total.toLocaleString()} 条评论` : state.phase === 'error' ? '评论区暂时不可用' : '正在获取评论区'}</span><button type="button" className="text-button" aria-label="刷新当前视频评论区" disabled={state.phase === 'loading' || state.loadingMore || writing} onClick={() => void controller.refresh()}><RefreshCw size={14} className={state.phase === 'loading' ? 'spin' : ''} />刷新</button></div>
      <form className="comment-composer" onSubmit={event => { event.preventDefault(); void controller.submit() }}>
        <div className="comment-composer-heading">{account ? <label htmlFor={inputId}>{state.replyTarget ? `回复 ${state.replyTarget.username}` : '聊聊这段声音'}</label> : <strong>聊聊这段声音</strong>}{account ? <span>{accountChecking ? '正在验证账号…' : `使用 Bilibili 账号：${account.username}`}</span> : <span>未登录 · 可以浏览评论</span>}</div>
        {state.replyTarget && <div className="comment-reply-target"><MessageCircle size={14} /><span>这条回复将发送到原视频的评论下</span><button type="button" aria-label="取消回复，改为发表评论" disabled={state.posting} onClick={() => controller.cancelReply()}><X size={14} />取消回复</button></div>}
        {account ? <><textarea id={inputId} ref={textarea} aria-describedby={`${inputId}-hint`} aria-invalid={tooLong || undefined} rows={2} placeholder={state.closed ? '该视频已关闭评论区' : accountChecking ? '账号验证完成后即可评论' : state.replyTarget ? `回复 ${state.replyTarget.username}…` : '写下你的想法…'} disabled={accountChecking || state.closed || state.posting} value={state.draft} onChange={event => controller.setDraft(event.target.value)} /><div className="comment-composer-footer"><span id={`${inputId}-hint`} className={tooLong ? 'is-over-limit' : ''}>{state.draft.trim().length} / {MAX_COMMENT_LENGTH}<small>评论将公开发送到 Bilibili 原视频</small></span><button type="submit" className="button-primary" disabled={!canWrite || writing || !state.draft.trim() || tooLong}>{state.posting ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}{state.posting ? '正在发送…' : state.replyTarget ? '发送回复到 Bilibili' : '发送到 Bilibili'}</button></div></> : <div className="comment-login-hint"><p>登录 Bilibili 后，可在这里点赞、发表评论和回复。</p><button type="button" className="button-secondary" disabled={openingLogin} onClick={() => void onLogin()}>{openingLogin ? <LoaderCircle size={15} className="spin" /> : <ExternalLink size={15} />}{openingLogin ? '正在打开登录' : '登录 Bilibili'}</button></div>}
        {state.postError && <p className="comments-write-error" role="alert">{state.postError}</p>}{state.notice && <p className="comments-write-notice" role="status"><Check size={14} />{state.notice}</p>}
      </form>
      {state.error && <div className="comments-error" role="alert"><div><h2>暂时无法读取评论</h2><p>{state.error}</p></div><button type="button" className="button-secondary" disabled={state.phase === 'loading' || state.loadingMore || writing} onClick={() => void controller.refresh()}><RefreshCw size={14} />重新获取</button><button type="button" className="text-button" disabled={openingLogin} onClick={() => void onLogin()}>打开 Bilibili 登录 / 验证<ExternalLink size={14} /></button></div>}
      {state.phase === 'loading' && !state.comments.length ? <div className="comments-placeholder" role="status"><LoaderCircle size={28} className="spin" /><h2>正在读取评论区</h2><p>正在检测当前 Bilibili 原视频的评论。</p></div> : state.closed ? <div className="comments-placeholder"><MessageCircle size={28} /><h2>这个视频已关闭评论区</h2><p>当前无法发表评论，可继续听歌或查看原视频。</p></div> : state.phase === 'ready' && !state.comments.length ? <div className="comments-placeholder"><MessageCircle size={28} /><h2>还没有可见评论</h2><p>登录后，你可以分享听到这段声音的感受。</p></div> : <div className="comments-list" aria-busy={state.phase === 'loading' || state.loadingMore}>{state.comments.map(comment => <CommentItem key={comment.id} comment={comment} rootId={comment.id} controller={controller} state={state} canWrite={canWrite} onReply={reply} />)}</div>}
      {state.hasMore && !state.closed && <button type="button" className="button-secondary comments-load-more" disabled={state.phase !== 'ready' || state.loadingMore || writing} onClick={() => void controller.loadMore()}>{state.loadingMore ? <LoaderCircle size={15} className="spin" /> : <ChevronDown size={15} />}{state.loadingMore ? '正在读取更多评论' : '加载更多评论'}</button>}
    </>}
  </section>
}
