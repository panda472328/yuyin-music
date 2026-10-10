import type { SearchMode } from '../src/shared/search-mode';
export type { SearchMode } from '../src/shared/search-mode';

/** A saved search result. Playback always uses the original Bilibili video page. */
export interface Song {
  id: string;
  bvid: string;
  title: string;
  artist: string;
  cover: string;
  duration: number;
  playCount: number;
  source: 'bilibili';
  url: string;
  /** Original search text helps match lyrics; artist is the video's UP name. */
  searchQuery?: string;
}

export interface SearchResult {
  query: string;
  mode?: SearchMode;
  songs: Song[];
  page: number;
  pageSize: number;
  /** Source Bilibili total, not the number of title matches in song mode. */
  total: number;
  hasMore: boolean;
}

export interface BilibiliAccount {
  mid: number;
  username: string;
  avatar: string;
}

export type BilibiliAccountStatus =
  | { loggedIn: true; account: BilibiliAccount }
  | { loggedIn: false; account: null; /** Explicit guest choice for this app run; never an account login. */ guest?: boolean };

/** A Bilibili favorite folder visible to the current logged-in account. */
export interface BilibiliFavoriteFolder {
  id: number;
  title: string;
  mediaCount: number;
  cover: string;
  description: string;
  isDefault: boolean;
}

export interface BilibiliFavoriteFoldersResult {
  mid: number;
  username: string;
  account: { mid: number; name: string };
  folders: BilibiliFavoriteFolder[];
}

export interface BilibiliFavoriteItemsResult {
  folder: BilibiliFavoriteFolder;
  songs: Song[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface BilibiliFavoriteSongsResult {
  folder: BilibiliFavoriteFolder;
  songs: Song[];
  skippedCount: number;
  total: number;
}

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlaybackStatus {
  state: PlaybackState;
  song: Song | null;
  currentTime: number;
  duration: number;
  volume: number;
  error: string | null;
  errorCode?: string;
}

export interface AppError {
  message: string;
  code: string;
  requiresVerification: boolean;
}
