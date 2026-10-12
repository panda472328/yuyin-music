/** Comments belong to the original Bilibili video, never to the lyric/song match. */
export type CommentSort = 'hot' | 'new'

export interface VideoComment {
  id: string
  rootId: string
  parentId: string
  author: { mid: number; username: string; avatar: string }
  message: string
  createdAt: number
  likeCount: number
  replyCount: number
  liked: boolean
  replies: VideoComment[]
}

export interface VideoCommentsPage {
  bvid: string
  oid: string
  sort: CommentSort
  page: number
  pageSize: number
  total: number
  hasMore: boolean
  closed: boolean
  comments: VideoComment[]
}

export interface VideoRepliesPage {
  bvid: string
  rootId: string
  page: number
  pageSize: number
  total: number
  hasMore: boolean
  comments: VideoComment[]
}

export interface CommentLikeResult { id: string; liked: boolean }
export interface CommentCreateRequest {
  bvid: string
  message: string
  rootId?: string
  parentId?: string
  /** Native service verifies the identity before sending; renderer cannot select an account. */
  expectedMid: number
}
export interface CommentCreateResult { comment: VideoComment | null; pendingReview: boolean }
export const MAX_COMMENT_LENGTH = 1000
