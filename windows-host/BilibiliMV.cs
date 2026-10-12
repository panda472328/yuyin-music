using System.Text.Json;

namespace Yuyin.WindowsHost;

/// The MV presentation is a view of the existing source, never a second player.
/// This script deliberately has no media play/pause/seek/load or navigation calls.
internal static class BilibiliMV
{
    internal static string BuildScript(string command, string bvid, long requestId)
    {
        var parameters = JsonSerializer.Serialize(new { command, bvid, requestId });
        return $$"""
            (() => {
              const args = {{parameters}};
              const path = '/video/' + args.bvid;
              const empty = { found: false, ready: false, webFullscreen: false, nativeFullscreen: false, entered: false, blocked: null, state: 'missing' };
              if (location.protocol !== 'https:' || (location.pathname !== path && location.pathname !== path + '/')) return { ...empty, state: 'navigation-mismatch' };
              const memory = window.__yuyinMV || (window.__yuyinMV = { requestId: -1, entered: false, clicked: false, exiting: false, nativeExit: false });
              if (args.requestId < memory.requestId) return { ...empty, state: 'stale' };
              if (args.requestId !== memory.requestId) {
                memory.requestId = args.requestId;
                memory.entered = false;
                memory.clicked = false;
                memory.exiting = false;
                memory.nativeExit = false;
              }
              const video = document.querySelector('.bpx-player-video-wrap video') || document.querySelector('.bilibili-player-video video') || document.querySelector('video');
              const webFullscreen = Boolean(document.querySelector('.bpx-state-web, .bpx-player-container[data-screen="web"], .bilibili-player-mode-webfullscreen, .bilibili-player-video-web-fullscreen-on, #bilibili-player.mode-webfullscreen'));
              const nativeFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
              const buttons = ['.bpx-player-ctrl-web', '.bilibili-player-video-btn-web-fullscreen', '.bilibili-player-video-web-fullscreen'];
              let button = null;
              for (const selector of buttons) {
                const candidate = document.querySelector(selector);
                if (candidate && !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true') { button = candidate; break; }
              }
              if (!button) {
                for (const candidate of document.querySelectorAll('.bpx-player-control-bottom [title], .bpx-player-control-bottom [aria-label], .bilibili-player-video-control [title]')) {
                  const label = candidate.getAttribute('aria-label') || candidate.getAttribute('title') || '';
                  if (label.includes('网页全屏') && !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true') { button = candidate; break; }
                }
              }
              const snapshot = () => ({ ...empty, found: Boolean(video), ready: Boolean(video && video.readyState >= 1), webFullscreen, nativeFullscreen, entered: memory.entered, state: 'ready' });
              if (args.command === 'exit') {
                memory.exiting = true;
                if (nativeFullscreen && typeof document.exitFullscreen === 'function') { try { Promise.resolve(document.exitFullscreen()).catch(() => {}); } catch {} }
                if (webFullscreen && button) { try { button.click(); } catch {} }
                return { ...snapshot(), state: 'exiting' };
              }
              if (!video) {
                const body = (document.body?.innerText || '').slice(0, 12000);
                const reasons = ['412 Precondition Failed', '403 Forbidden', '安全验证', '人机验证', '访问异常', '访问受限', '请求被拦截', '登录后观看', '视频已失效', '视频已删除', '视频不见了', '应版权方要求', '所在地区不可用'];
                return { ...empty, blocked: reasons.find(reason => body.includes(reason)) || null };
              }
              if (webFullscreen || (nativeFullscreen && args.command === 'read' && memory.entered)) {
                memory.entered = true;
                return snapshot();
              }
              if (args.command === 'read' || memory.exiting) return snapshot();
              if (nativeFullscreen) {
                if (!memory.nativeExit && typeof document.exitFullscreen === 'function') {
                  memory.nativeExit = true;
                  try { Promise.resolve(document.exitFullscreen()).catch(() => {}); } catch {}
                }
                return { ...snapshot(), state: 'native-exiting' };
              }
              if (video.readyState < 1) return { ...snapshot(), state: 'loading' };
              if (!button) return { ...snapshot(), state: 'controls-missing' };
              if (!memory.clicked) {
                memory.clicked = true;
                try { button.click(); } catch { return { ...snapshot(), state: 'controls-failed' }; }
              }
              return { ...snapshot(), state: 'entering' };
            })()
            """;
    }
}
