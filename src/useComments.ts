import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { CommentsController, type CommentsAPI } from './comments-controller'

export function useComments({ commentsApi, bvid, mid, checking, sessionKey }: { commentsApi: CommentsAPI; bvid: string | null; mid: number | null; checking: boolean; sessionKey?: string | number }) {
  const controller = useMemo(() => new CommentsController({ api: commentsApi, bvid, expectedMid: mid }), [commentsApi, bvid, mid, sessionKey])
  controller.setChecking(checking)
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => { controller.start(); return () => controller.dispose() }, [controller])
  return { state, controller }
}
