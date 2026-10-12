import { MAX_COMMENT_LENGTH, type CommentCreateRequest, type CommentCreateResult, type CommentLikeResult, type CommentSort, type VideoComment, type VideoCommentsPage, type VideoRepliesPage } from './shared/comments'

export interface CommentsAPI {
  list(bvid: string, sort: CommentSort, page: number): Promise<VideoCommentsPage>
  replies(bvid: string, rootId: string, page: number): Promise<VideoRepliesPage>
  like(bvid: string, id: string, liked: boolean, expectedMid: number): Promise<CommentLikeResult>
  create(request: CommentCreateRequest): Promise<CommentCreateResult>
}
export interface CommentReplyTarget { rootId: string; parentId: string; username: string }
export interface CommentThreadState { expanded: boolean; loading: boolean; error: string | null; page: number; hasMore: boolean; total: number; comments: VideoComment[] }
export interface CommentsState {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  sort: CommentSort
  comments: VideoComment[]
  page: number
  total: number
  hasMore: boolean
  closed: boolean
  error: string | null
  loadingMore: boolean
  threads: Record<string, CommentThreadState>
  likesBusy: string[]
  draft: string
  replyTarget: CommentReplyTarget | null
  posting: boolean
  postError: string | null
  notice: string | null
}
const initialState = (): CommentsState => ({ phase: 'idle', sort: 'hot', comments: [], page: 0, total: 0, hasMore: false, closed: false, error: null, loadingMore: false, threads: {}, likesBusy: [], draft: '', replyTarget: null, posting: false, postError: null, notice: null })
export const commentsReadBusy = (state: CommentsState) => state.phase === 'loading' || state.loadingMore || Object.values(state.threads).some(thread => thread.loading)
const errorText = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
const uniqueComments = (comments: VideoComment[]) => [...new Map(comments.map(comment => [comment.id, comment])).values()]
const mapComment = (comments: VideoComment[], id: string, update: (comment: VideoComment) => VideoComment): VideoComment[] => comments.map(comment => {
  const next = comment.id === id ? update(comment) : comment
  return next.replies.length ? { ...next, replies: mapComment(next.replies, id, update) } : next
})

/** A single video/account scope. Disposed and superseded responses can never update its UI. */
export class CommentsController {
  private state = initialState()
  private listeners = new Set<() => void>()
  private active = false
  private revision = 0
  private listRevision = 0
  private checking = false
  private likeLocks = new Set<string>()
  private postingLock = false
  constructor(private readonly options: { api: CommentsAPI; bvid: string | null; expectedMid: number | null }) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(patch: Partial<CommentsState>) { if (!this.active) return; this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
  private valid(revision: number, listRevision?: number) { return this.active && revision === this.revision && (listRevision === undefined || listRevision === this.listRevision) }
  private get writing() { return this.postingLock || this.likeLocks.size > 0 }
  private get canWrite() { return this.active && Boolean(this.options.bvid) && Number.isSafeInteger(this.options.expectedMid) && (this.options.expectedMid ?? 0) > 0 && !this.checking && !this.state.closed && this.state.phase === 'ready' && !commentsReadBusy(this.state) }
  setChecking(checking: boolean) { this.checking = checking }
  start() { if (this.active) return; this.active = true; this.revision++; this.likeLocks.clear(); this.postingLock = false; this.publish(initialState()); if (this.options.bvid) void this.refresh() }
  dispose() { this.active = false; this.revision++; this.listRevision++; this.likeLocks.clear(); this.postingLock = false }
  setDraft(draft: string) { if (!this.postingLock) this.publish({ draft, postError: null, notice: null }) }
  setReplyTarget(comment: VideoComment, rootId = comment.rootId && comment.rootId !== '0' ? comment.rootId : comment.id) {
    if (!this.canWrite || this.postingLock) return
    this.publish({ replyTarget: { rootId, parentId: comment.id, username: comment.author.username }, postError: null, notice: null })
  }
  cancelReply() { if (!this.postingLock) this.publish({ replyTarget: null, postError: null }) }
  setSort(sort: CommentSort) {
    if (sort === this.state.sort || this.writing) return
    this.publish({ sort, comments: [], page: 0, total: 0, hasMore: false, closed: false, threads: {}, error: null })
    void this.refresh()
  }
  async refresh() {
    if (!this.active || !this.options.bvid || this.writing) return
    const revision = this.revision, listRevision = ++this.listRevision, sort = this.state.sort
    this.publish({ phase: 'loading', error: null, loadingMore: false, threads: {} })
    try {
      const result = await this.options.api.list(this.options.bvid, sort, 1)
      if (!this.valid(revision, listRevision)) return
      if (result.bvid !== this.options.bvid || result.sort !== sort || result.page !== 1) throw new Error('评论区响应与当前视频不一致，请重试。')
      this.publish({ phase: 'ready', comments: uniqueComments(result.comments), page: result.page, total: result.total, hasMore: result.hasMore, closed: result.closed, threads: {}, error: null, replyTarget: result.closed ? null : this.state.replyTarget })
    } catch (failure) { if (this.valid(revision, listRevision)) this.publish({ phase: this.state.comments.length ? 'ready' : 'error', error: errorText(failure) }) }
  }
  async loadMore() {
    if (!this.active || !this.options.bvid || this.state.phase !== 'ready' || !this.state.hasMore || this.state.loadingMore || this.writing) return
    const revision = this.revision, listRevision = this.listRevision, page = this.state.page + 1, sort = this.state.sort
    this.publish({ loadingMore: true, error: null })
    try {
      const result = await this.options.api.list(this.options.bvid, sort, page)
      if (!this.valid(revision, listRevision)) return
      if (result.bvid !== this.options.bvid || result.sort !== sort || result.page !== page) throw new Error('评论分页响应不一致，请重试。')
      this.publish({ comments: uniqueComments([...this.state.comments, ...result.comments]), page: result.page, total: result.total, hasMore: result.hasMore, closed: result.closed, loadingMore: false, replyTarget: result.closed ? null : this.state.replyTarget })
    } catch (failure) { if (this.valid(revision, listRevision)) this.publish({ loadingMore: false, error: errorText(failure) }) }
  }
  toggleThread(comment: VideoComment) {
    if (!this.active || this.writing || this.state.phase !== 'ready') return
    const rootId = comment.id, current = this.state.threads[rootId]
    if (current) {
      const expanded = !current.expanded
      this.publish({ threads: { ...this.state.threads, [rootId]: { ...current, expanded } } })
      if (expanded && !current.page && !current.loading) void this.loadReplies(rootId, 1)
    } else {
      this.publish({ threads: { ...this.state.threads, [rootId]: { expanded: true, loading: false, error: null, page: 0, hasMore: false, total: comment.replyCount, comments: comment.replies } } })
      void this.loadReplies(rootId, 1)
    }
  }
  async loadReplies(rootId: string, requestedPage?: number) {
    const thread = this.state.threads[rootId]
    if (!this.active || !this.options.bvid || this.state.phase !== 'ready' || !thread || thread.loading || this.writing || (!requestedPage && !thread.hasMore)) return
    const page = requestedPage ?? thread.page + 1, revision = this.revision, listRevision = this.listRevision
    this.publish({ threads: { ...this.state.threads, [rootId]: { ...thread, loading: true, error: null } } })
    try {
      const result = await this.options.api.replies(this.options.bvid, rootId, page)
      if (!this.valid(revision, listRevision) || !this.state.threads[rootId]) return
      if (result.bvid !== this.options.bvid || result.rootId !== rootId || result.page !== page) throw new Error('回复响应与当前评论不一致，请重试。')
      const latest = this.state.threads[rootId]
      this.publish({ threads: { ...this.state.threads, [rootId]: { ...latest, loading: false, error: null, page: result.page, hasMore: result.hasMore, total: result.total, comments: uniqueComments(page === 1 ? result.comments : [...latest.comments, ...result.comments]) } } })
    } catch (failure) { if (this.valid(revision, listRevision) && this.state.threads[rootId]) this.publish({ threads: { ...this.state.threads, [rootId]: { ...this.state.threads[rootId], loading: false, error: errorText(failure) } } }) }
  }
  async toggleLike(comment: VideoComment) {
    if (!this.canWrite || !this.options.bvid || !this.options.expectedMid || this.writing) return
    const revision = this.revision, listRevision = this.listRevision, liked = !comment.liked
    this.likeLocks.add(comment.id)
    this.publish({ likesBusy: [...this.likeLocks], postError: null, notice: null })
    try {
      const result = await this.options.api.like(this.options.bvid, comment.id, liked, this.options.expectedMid)
      if (!this.valid(revision, listRevision)) return
      if (result.id !== comment.id || result.liked !== liked) throw new Error('点赞结果未确认，请刷新评论区查看。')
      const update = (item: VideoComment) => ({ ...item, liked, likeCount: Math.max(0, item.likeCount + (item.liked === liked ? 0 : liked ? 1 : -1)) })
      this.publish({ comments: mapComment(this.state.comments, comment.id, update), threads: Object.fromEntries(Object.entries(this.state.threads).map(([id, thread]) => [id, { ...thread, comments: mapComment(thread.comments, comment.id, update) }])) })
    } catch (failure) { if (this.valid(revision, listRevision)) this.publish({ postError: errorText(failure) }) }
    finally { if (this.valid(revision)) { this.likeLocks.delete(comment.id); this.publish({ likesBusy: [...this.likeLocks] }) } }
  }
  async submit() {
    if (!this.canWrite || !this.options.bvid || !this.options.expectedMid || this.writing) return
    const message = this.state.draft.trim()
    if (!message) return
    if (message.length > MAX_COMMENT_LENGTH) { this.publish({ postError: `评论不能超过 ${MAX_COMMENT_LENGTH} 个字符。` }); return }
    const revision = this.revision, target = this.state.replyTarget
    this.postingLock = true
    this.publish({ posting: true, postError: null, notice: null })
    try {
      const result = await this.options.api.create({ bvid: this.options.bvid, message, ...(target ? { rootId: target.rootId, parentId: target.parentId } : {}), expectedMid: this.options.expectedMid })
      if (!this.valid(revision)) return
      this.postingLock = false
      this.publish({ posting: false, draft: '', replyTarget: null, notice: result.pendingReview ? '已提交，可能待审核，请以源视频显示为准。' : '已发送到 Bilibili。' })
      void this.refresh()
    } catch (failure) {
      if (this.valid(revision)) {
        this.postingLock = false
        this.publish({ posting: false, postError: `${errorText(failure)} 输入已保留；若发送结果不确定，请先到源视频确认，避免重复发送。` })
      }
    }
  }
}
