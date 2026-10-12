import test from 'node:test'
import assert from 'node:assert/strict'
import { CommentsController, type CommentsAPI } from '../src/comments-controller'
import { MAX_COMMENT_LENGTH, type CommentCreateRequest, type CommentCreateResult, type CommentLikeResult, type CommentSort, type VideoComment, type VideoCommentsPage, type VideoRepliesPage } from '../src/shared/comments'

const bvid = 'BV0000000001'
const mid = 101
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
type Deferred<T> = ReturnType<typeof deferred<T>>
function harness(expectedMid: number | null = mid, video: string | null = bvid) {
  const lists: { bvid: string; sort: CommentSort; page: number; result: Deferred<VideoCommentsPage> }[] = []
  const replies: { bvid: string; rootId: string; page: number; result: Deferred<VideoRepliesPage> }[] = []
  const likes: { bvid: string; id: string; liked: boolean; expectedMid: number; result: Deferred<CommentLikeResult> }[] = []
  const creates: { request: CommentCreateRequest; result: Deferred<CommentCreateResult> }[] = []
  const api: CommentsAPI = {
    list(bvid, sort, page) { const result = deferred<VideoCommentsPage>(); lists.push({ bvid, sort, page, result }); return result.promise },
    replies(bvid, rootId, page) { const result = deferred<VideoRepliesPage>(); replies.push({ bvid, rootId, page, result }); return result.promise },
    like(bvid, id, liked, expectedMid) { const result = deferred<CommentLikeResult>(); likes.push({ bvid, id, liked, expectedMid, result }); return result.promise },
    create(request) { const result = deferred<CommentCreateResult>(); creates.push({ request, result }); return result.promise },
  }
  const controller = new CommentsController({ api, bvid: video, expectedMid })
  return { controller, lists, replies, likes, creates }
}
function comment(id: string, patch: Partial<VideoComment> = {}): VideoComment {
  return { id, rootId: '0', parentId: '0', author: { mid: 202, username: '测试听众', avatar: '' }, message: `测试评论 ${id}`, createdAt: 1700000000, likeCount: 4, replyCount: 0, liked: false, replies: [], ...patch }
}
function page(comments: VideoComment[] = [comment('11')], patch: Partial<VideoCommentsPage> = {}): VideoCommentsPage {
  return { bvid, oid: '10001', sort: 'hot', page: 1, pageSize: 20, total: comments.length, hasMore: false, closed: false, comments, ...patch }
}
function replyPage(comments: VideoComment[], patch: Partial<VideoRepliesPage> = {}): VideoRepliesPage {
  return { bvid, rootId: '11', page: 1, pageSize: 20, total: comments.length, hasMore: false, comments, ...patch }
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve))
async function ready(h: ReturnType<typeof harness>, value = page()) {
  h.controller.start()
  h.lists[0].result.resolve(value)
  await settled()
  assert.equal(h.controller.getSnapshot().phase, 'ready')
}

test('guest reads are allowed, but missing video, invalid identity and checking block all writes', async () => {
  const empty = harness(mid, null)
  empty.controller.start()
  empty.controller.setDraft('测试评论')
  await empty.controller.submit()
  assert.equal(empty.controller.getSnapshot().phase, 'idle')
  assert.equal(empty.lists.length + empty.creates.length, 0)
  for (const identity of [null, 0, -1, NaN, 1.5]) {
    const h = harness(identity)
    await ready(h)
    h.controller.setDraft('访客草稿')
    h.controller.setReplyTarget(comment('11'))
    await h.controller.submit()
    await h.controller.toggleLike(comment('11'))
    assert.equal(h.creates.length + h.likes.length, 0)
    assert.equal(h.controller.getSnapshot().replyTarget, null)
  }
  const h = harness()
  await ready(h)
  h.controller.setChecking(true)
  h.controller.setDraft('验证时保留输入')
  await h.controller.submit()
  await h.controller.toggleLike(comment('11'))
  assert.equal(h.creates.length + h.likes.length, 0)
  h.controller.setChecking(false)
  const write = h.controller.submit()
  assert.equal(h.creates[0].request.expectedMid, mid)
  h.creates[0].result.reject(new Error('受控拒绝'))
  await write
})

test('StrictMode-style restart ignores old reads and resets obsolete interaction state', async () => {
  const h = harness()
  h.controller.start()
  h.controller.start()
  assert.equal(h.lists.length, 1)
  h.controller.dispose()
  h.controller.start()
  assert.equal(h.lists.length, 2)
  h.lists[0].result.resolve(page([comment('old')]))
  await settled()
  assert.equal(h.controller.getSnapshot().phase, 'loading')
  assert.deepEqual(h.controller.getSnapshot().comments, [])
  h.lists[1].result.resolve(page())
  await settled()
  h.controller.setDraft('不会跨重启发送')
  const send = h.controller.submit()
  h.controller.dispose()
  h.controller.start()
  h.creates[0].result.resolve({ comment: comment('12'), pendingReview: false })
  await send
  assert.equal(h.controller.getSnapshot().posting, false)
  assert.equal(h.controller.getSnapshot().draft, '')
  assert.equal(h.lists.length, 3, 'old successful write must not issue a refresh in new scope')
  h.lists[2].result.resolve(page())
  await settled()
})

test('video/account scope replacement leaves the new scope clean and ignores disposed writes', async () => {
  const old = harness()
  await ready(old)
  old.controller.setDraft('旧账号草稿')
  old.controller.setReplyTarget(comment('11'))
  const like = old.controller.toggleLike(comment('11'))
  let changes = 0
  const unsubscribe = old.controller.subscribe(() => changes++)
  old.controller.dispose()
  const fresh = harness(303, 'BV0000000002')
  fresh.controller.start()
  assert.equal(fresh.controller.getSnapshot().draft, '')
  assert.equal(fresh.controller.getSnapshot().replyTarget, null)
  old.likes[0].result.resolve({ id: '11', liked: true })
  await like
  assert.equal(changes, 0)
  assert.equal(old.controller.getSnapshot().comments[0].liked, false)
  fresh.lists[0].result.resolve(page([comment('new')], { bvid: 'BV0000000002' }))
  await settled()
  assert.equal(fresh.controller.getSnapshot().comments[0].id, 'new')
  unsubscribe()
})

test('slow sort and pagination responses cannot replace the selected sort', async () => {
  const h = harness()
  h.controller.start()
  h.controller.setSort('new')
  h.lists[1].result.resolve(page([comment('new')], { sort: 'new', hasMore: true, total: 30 }))
  await settled()
  h.lists[0].result.resolve(page([comment('old')]))
  await settled()
  assert.equal(h.controller.getSnapshot().sort, 'new')
  assert.equal(h.controller.getSnapshot().comments[0].id, 'new')
  const more = h.controller.loadMore()
  h.controller.setSort('hot')
  h.lists[3].result.resolve(page([comment('hot')]))
  await settled()
  h.lists[2].result.resolve(page([comment('late-page')], { sort: 'new', page: 2 }))
  await more
  assert.equal(h.controller.getSnapshot().sort, 'hot')
  assert.deepEqual(h.controller.getSnapshot().comments.map(item => item.id), ['hot'])
  assert.equal(h.controller.getSnapshot().loadingMore, false)
})

test('pagination deduplicates IDs, prevents duplicate fetches and blocks writes while reading', async () => {
  const h = harness()
  await ready(h, page([comment('11'), comment('12')], { total: 30, hasMore: true }))
  h.controller.setDraft('保留草稿')
  const more = h.controller.loadMore()
  await h.controller.loadMore()
  await h.controller.toggleLike(comment('11'))
  await h.controller.submit()
  assert.equal(h.lists.length, 2)
  assert.equal(h.likes.length + h.creates.length, 0)
  h.lists[1].result.resolve(page([comment('12', { message: '第二页重叠条目' }), comment('13')], { page: 2, total: 3 }))
  await more
  assert.deepEqual(h.controller.getSnapshot().comments.map(item => item.id), ['11', '12', '13'])
  assert.equal(h.controller.getSnapshot().comments[1].message, '第二页重叠条目')
  assert.equal(h.controller.getSnapshot().draft, '保留草稿')
  assert.equal(h.controller.getSnapshot().loadingMore, false)
})

test('reply pages preserve collapse state, deduplicate rows, retain errors and only retry explicitly', async () => {
  const h = harness()
  const root = comment('11', { replyCount: 3, replies: [comment('21', { rootId: '11' })] })
  await ready(h, page([root]))
  h.controller.toggleThread(root)
  h.controller.toggleThread(root)
  h.replies[0].result.resolve(replyPage([comment('21', { rootId: '11' }), comment('22', { rootId: '11' })], { hasMore: true, total: 3 }))
  await settled()
  assert.equal(h.controller.getSnapshot().threads['11'].expanded, false)
  h.controller.toggleThread(root)
  assert.equal(h.replies.length, 1, 'expanding cached reply page avoids a duplicate request')
  const more = h.controller.loadReplies('11')
  await h.controller.loadReplies('11')
  h.controller.setDraft('读取回复时不写')
  await h.controller.toggleLike(root)
  await h.controller.submit()
  assert.equal(h.replies.length, 2)
  assert.equal(h.likes.length + h.creates.length, 0)
  h.replies[1].result.reject(new Error('受控网络失败'))
  await more
  assert.equal(h.controller.getSnapshot().threads['11'].loading, false)
  assert.match(h.controller.getSnapshot().threads['11'].error!, /受控网络失败/)
  await settled()
  assert.equal(h.replies.length, 2, 'read errors never auto retry')
  const retry = h.controller.loadReplies('11')
  assert.equal(h.replies[2].page, 2)
  h.replies[2].result.resolve(replyPage([comment('22', { rootId: '11' }), comment('23', { rootId: '11' })], { page: 2, total: 3 }))
  await retry
  assert.deepEqual(h.controller.getSnapshot().threads['11'].comments.map(item => item.id), ['21', '22', '23'])
  assert.equal(h.controller.getSnapshot().threads['11'].error, null)
})

test('refresh failure retains visible comments and invalidates in-flight reply loading', async () => {
  const h = harness()
  const root = comment('11', { replyCount: 1 })
  await ready(h, page([root]))
  h.controller.toggleThread(root)
  const refresh = h.controller.refresh()
  h.lists[1].result.reject(new Error('刷新失败'))
  await refresh
  h.replies[0].result.resolve(replyPage([comment('21', { rootId: '11' })]))
  await settled()
  assert.equal(h.controller.getSnapshot().phase, 'ready')
  assert.equal(h.controller.getSnapshot().comments[0].id, '11')
  assert.deepEqual(h.controller.getSnapshot().threads, {})
  assert.match(h.controller.getSnapshot().error!, /刷新失败/)
  h.controller.toggleThread(root)
  assert.equal(h.replies.length, 2)
  h.replies[1].result.resolve(replyPage([comment('22', { rootId: '11' })]))
  await settled()
  assert.equal(h.controller.getSnapshot().threads['11'].loading, false)
})

test('likes are serialized, updated after confirmation and preserve counts on failed or mismatched results', async () => {
  const h = harness()
  const root = comment('11', { replyCount: 1, replies: [comment('21', { rootId: '11' })] })
  await ready(h, page([root, comment('12')]))
  h.controller.toggleThread(root)
  h.replies[0].result.resolve(replyPage([comment('21', { rootId: '11' })]))
  await settled()
  const first = h.controller.toggleLike(comment('21', { rootId: '11' }))
  await h.controller.toggleLike(comment('21', { rootId: '11' }))
  await h.controller.toggleLike(comment('12'))
  h.controller.setSort('new')
  await h.controller.refresh()
  assert.equal(h.likes.length, 1)
  assert.deepEqual(h.controller.getSnapshot().likesBusy, ['21'])
  assert.equal(h.controller.getSnapshot().comments[0].replies[0].liked, false, 'no optimistic like')
  h.likes[0].result.resolve({ id: '21', liked: true })
  await first
  assert.equal(h.likes[0].expectedMid, mid)
  assert.equal(h.controller.getSnapshot().comments[0].replies[0].likeCount, 5)
  assert.equal(h.controller.getSnapshot().threads['11'].comments[0].likeCount, 5)
  assert.deepEqual(h.controller.getSnapshot().likesBusy, [])
  const unlike = h.controller.toggleLike(h.controller.getSnapshot().threads['11'].comments[0])
  h.likes[1].result.reject(new Error('点赞失败'))
  await unlike
  assert.equal(h.controller.getSnapshot().threads['11'].comments[0].liked, true)
  assert.equal(h.controller.getSnapshot().threads['11'].comments[0].likeCount, 5)
  assert.match(h.controller.getSnapshot().postError!, /点赞失败/)
  const mismatch = h.controller.toggleLike(comment('12'))
  h.likes[2].result.resolve({ id: 'other', liked: true })
  await mismatch
  assert.equal(h.controller.getSnapshot().comments[1].likeCount, 4)
  assert.match(h.controller.getSnapshot().postError!, /未确认/)
  await settled()
  assert.equal(h.likes.length, 3, 'failed writes never auto retry')
})

test('failed reply sends preserve exact input and target; explicit retry sends trimmed text once', async () => {
  const h = harness()
  await ready(h)
  h.controller.setDraft('  测试回复\n ')
  h.controller.setReplyTarget(comment('11'))
  const first = h.controller.submit()
  await h.controller.submit()
  await h.controller.toggleLike(comment('11'))
  h.controller.setDraft('不应覆盖发送中的草稿')
  h.controller.cancelReply()
  h.controller.setSort('new')
  await h.controller.refresh()
  assert.equal(h.creates.length, 1)
  assert.equal(h.likes.length, 0)
  assert.deepEqual(h.creates[0].request, { bvid, expectedMid: mid, message: '测试回复', rootId: '11', parentId: '11' })
  h.creates[0].result.reject(new Error('超时，结果不确定'))
  await first
  assert.equal(h.controller.getSnapshot().draft, '  测试回复\n ')
  assert.deepEqual(h.controller.getSnapshot().replyTarget, { rootId: '11', parentId: '11', username: '测试听众' })
  assert.match(h.controller.getSnapshot().postError!, /源视频确认/)
  assert.equal(h.controller.getSnapshot().posting, false)
  await settled()
  assert.equal(h.creates.length, 1)
  const retry = h.controller.submit()
  assert.deepEqual(h.creates[1].request, h.creates[0].request)
  h.creates[1].result.resolve({ comment: null, pendingReview: true })
  await retry
  assert.equal(h.controller.getSnapshot().draft, '')
  assert.equal(h.controller.getSnapshot().replyTarget, null)
  assert.match(h.controller.getSnapshot().notice!, /可能待审核/)
  assert.equal(h.lists.length, 2, 'confirmed submission refreshes read data once')
  h.lists[1].result.resolve(page())
  await settled()
})

test('canceling reply preserves draft and nested reply keeps the root identity', async () => {
  const h = harness()
  await ready(h)
  h.controller.setDraft('编辑中的草稿')
  h.controller.setReplyTarget(comment('21', { rootId: '11', parentId: '11' }))
  assert.deepEqual(h.controller.getSnapshot().replyTarget, { rootId: '11', parentId: '21', username: '测试听众' })
  h.controller.cancelReply()
  assert.equal(h.controller.getSnapshot().replyTarget, null)
  assert.equal(h.controller.getSnapshot().draft, '编辑中的草稿')
  const send = h.controller.submit()
  assert.deepEqual(h.creates[0].request, { bvid, expectedMid: mid, message: '编辑中的草稿' })
  h.creates[0].result.resolve({ comment: comment('12'), pendingReview: false })
  await send
  assert.match(h.controller.getSnapshot().notice!, /已发送/)
  h.lists[1].result.resolve(page())
  await settled()
})

test('empty/long messages and a closed comment section never send', async () => {
  const h = harness()
  await ready(h)
  h.controller.setDraft(' \n ')
  await h.controller.submit()
  h.controller.setDraft('字'.repeat(MAX_COMMENT_LENGTH + 1))
  await h.controller.submit()
  assert.equal(h.creates.length, 0)
  assert.match(h.controller.getSnapshot().postError!, /1000/)
  h.controller.setDraft('保留输入')
  h.controller.setReplyTarget(comment('11'))
  const refresh = h.controller.refresh()
  h.lists[1].result.resolve(page([], { closed: true }))
  await refresh
  assert.equal(h.controller.getSnapshot().replyTarget, null)
  await h.controller.submit()
  await h.controller.toggleLike(comment('11'))
  assert.equal(h.likes.length + h.creates.length, 0)
  assert.equal(h.controller.getSnapshot().draft, '保留输入')
})

test('list/reply identity mismatch is reported without adopting another video or root', async () => {
  const h = harness()
  h.controller.start()
  h.lists[0].result.resolve(page([comment('wrong')], { bvid: 'BV0000000002' }))
  await settled()
  assert.equal(h.controller.getSnapshot().phase, 'error')
  assert.deepEqual(h.controller.getSnapshot().comments, [])
  assert.match(h.controller.getSnapshot().error!, /不一致/)
  const refresh = h.controller.refresh()
  const root = comment('11', { replyCount: 1 })
  h.lists[1].result.resolve(page([root]))
  await refresh
  h.controller.toggleThread(root)
  h.replies[0].result.resolve(replyPage([comment('bad')], { rootId: '12' }))
  await settled()
  assert.deepEqual(h.controller.getSnapshot().threads['11'].comments, [])
  assert.match(h.controller.getSnapshot().threads['11'].error!, /不一致/)
})
