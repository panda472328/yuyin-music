using System.ComponentModel;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Yuyin.WindowsHost;

/// <summary>
/// Keeps the source in its own unprivileged WebView2. State belongs to the WPF
/// dispatcher; source, operation and timeline revisions reject stale work.
/// </summary>
public sealed class PlayerHost : IAsyncDisposable
{
    private readonly CoreWebView2Environment _environment;
    private readonly Dispatcher _dispatcher;
    private readonly CancellationTokenSource _lifetime = new();
    private CancellationTokenSource _operation = new();
    private WebView2? _view;
    private CoreWebView2? _core;
    private Window? _window;
    private DispatcherTimer? _pollTimer;
    private Task? _initializationTask;
    private Task? _disposeTask;
    private PlaybackWaiter? _waiter;
    private long _generation;
    private long _playbackRequest;
    private long _positionRevision;
    private long _commandSequence;
    private long _snapshotSequence;
    private long _appliedSnapshotSequence;
    private ulong _navigationId;
    private long _navigationRequest;
    private long _loadedPlaybackRequest;
    private string? _explicitNavigation;
    private bool _navigating;
    private bool _polling;
    private bool _desiredPlayback;
    private bool _startAttempted;
    private bool _sourceVisible;
    private bool _needsRecreate;
    private bool _disposed;
    private long? _missingSince;
    private long? _stalledSince;
    private PlaybackStatus _status = new("idle", null, 0, 0, .75, null);
    private PlaybackStatus? _lastPublished;

    public event Action<PlaybackStatus>? StatusChanged;
    public event Action? Ended;

    public PlayerHost(CoreWebView2Environment environment, Dispatcher dispatcher)
    {
        _environment = environment;
        _dispatcher = dispatcher;
    }

    public PlaybackStatus Status => _status;
    public Task<PlaybackStatus> PlayAsync(Song song) => OnDispatcherAsync(() => PlayCoreAsync(song));
    public Task<PlaybackStatus> PauseAsync() => OnDispatcherAsync(PauseCoreAsync);
    public Task<PlaybackStatus> ResumeAsync() => OnDispatcherAsync(ResumeCoreAsync);
    public Task<PlaybackStatus> SeekAsync(double seconds) => OnDispatcherAsync(() => SeekCoreAsync(seconds));
    public Task<PlaybackStatus> SetVolumeAsync(double volume) => OnDispatcherAsync(() => SetVolumeCoreAsync(volume));
    public Task<PlaybackStatus> RefreshAsync() => OnDispatcherAsync(async () => { await PollAsync(); return _status; });
    public Task ShowSourceAsync() => OnDispatcherAsync(ShowSourceCoreAsync);

    private async Task<PlaybackStatus> PlayCoreAsync(Song song)
    {
        ThrowIfDisposed();
        if (!IsValidSong(song)) throw Error("这首歌曲没有有效的 Bilibili 视频编号。", "INVALID_SONG");
        var generation = BeginOperation();
        var token = _operation.Token;
        ++_playbackRequest;
        _loadedPlaybackRequest = 0;
        ++_positionRevision;
        _desiredPlayback = true;
        _startAttempted = false;
        _missingSince = null;
        _stalledSince = null;
        Mute(true);
        var canonicalSong = song with { Url = $"https://www.bilibili.com/video/{song.Bvid}/" };
        Publish(new("loading", canonicalSong, 0, song.Duration, _status.Volume, null), true);
        var playing = AwaitPlayback(generation);
        try
        {
            await EnsureAsync().WaitAsync(token);
            RequireCurrent(generation, token);
            Mute(true);
            await StopPageAsync();
            RequireCurrent(generation, token);
            _navigationId = 0;
            _core!.Stop();
            _navigating = true;
            _navigationRequest = _playbackRequest;
            _core.Navigate(canonicalSong.Url);
        }
        catch (OperationCanceledException) { throw Interrupted(); }
        catch (Exception error) { Fail($"Bilibili 视频页加载失败：{error.Message}。", "PAGE_LOAD_FAILED", generation); }
        return await playing;
    }

    private async Task<PlaybackStatus> PauseCoreAsync()
    {
        ThrowIfDisposed();
        var generation = BeginOperation("播放请求已取消：播放已暂停。");
        var token = _operation.Token;
        var revision = _positionRevision;
        var sequence = ++_snapshotSequence;
        _desiredPlayback = false;
        Mute(true);
        if (_status.Song is not null && _status.State != "error") Publish(_status with { State = "paused" });
        try
        {
            var snapshot = await ReadPageAsync("pause", token: token);
            if (IsCurrent(generation) && revision == _positionRevision && sequence >= _appliedSnapshotSequence && snapshot is { Found: true, Stale: false })
            {
                _appliedSnapshotSequence = sequence;
                Publish(_status with { CurrentTime = FinitePosition(snapshot.CurrentTime) });
            }
        }
        catch (OperationCanceledException) { throw Interrupted(); }
        catch { /* The desired paused state also applies after navigation. */ }
        if (IsCurrent(generation) && _status.Song is not null && _status.State != "error") Publish(_status with { State = "paused" });
        return _status;
    }

    private async Task<PlaybackStatus> ResumeCoreAsync()
    {
        ThrowIfDisposed();
        var song = _status.Song ?? throw Error("请先选择歌曲。", "NO_SONG");
        if (_status.State == "playing") return _status;
        if (_status.State == "error" || _needsRecreate || _core is null || _loadedPlaybackRequest != _playbackRequest || !IsSongUri(_core.Source, song.Bvid)) return await PlayCoreAsync(song);
        var previousGeneration = _generation;
        if (_status.State == "ended") await SeekCoreAsync(0);
        if (previousGeneration != _generation) throw Interrupted();
        var generation = BeginOperation();
        _desiredPlayback = true;
        _startAttempted = false;
        _missingSince = null;
        _stalledSince = null;
        Mute(true);
        Publish(_status with { State = "loading", Error = null, ErrorCode = null });
        var playing = AwaitPlayback(generation);
        SchedulePoll();
        return await playing;
    }

    private async Task<PlaybackStatus> SeekCoreAsync(double seconds)
    {
        ThrowIfDisposed();
        if (!double.IsFinite(seconds) || seconds < 0 || seconds > 86_400) throw Error("播放位置无效。", "INVALID_POSITION");
        if (_status.Song is null) throw Error("请先选择歌曲。", "NO_SONG");
        var generation = _generation;
        var token = _operation.Token;
        var revision = ++_positionRevision;
        var sequence = ++_snapshotSequence;
        MediaSnapshot? snapshot;
        try { snapshot = await ReadPageAsync("seek", seconds, token); }
        catch (OperationCanceledException) { throw Interrupted(); }
        catch { throw Error("视频尚未加载，暂时无法调整进度。", "MEDIA_NOT_READY"); }
        if (!IsCurrent(generation) || revision != _positionRevision) throw Interrupted();
        if (snapshot is not { Found: true, Stale: false }) throw Error("视频尚未加载，暂时无法调整进度。", "MEDIA_NOT_READY");
        _appliedSnapshotSequence = Math.Max(_appliedSnapshotSequence, sequence);
        ++_positionRevision; // Reject reads captured while the seek was in flight.
        _startAttempted = false;
        Publish(_status with { CurrentTime = FinitePosition(snapshot.CurrentTime), State = _status.State == "ended" ? "paused" : _status.State });
        SchedulePoll();
        return _status;
    }

    private async Task<PlaybackStatus> SetVolumeCoreAsync(double volume)
    {
        ThrowIfDisposed();
        if (!double.IsFinite(volume) || volume < 0 || volume > 1) throw Error("音量应在 0 到 1 之间。", "INVALID_VOLUME");
        Publish(_status with { Volume = volume });
        try { await ReadPageAsync("volume", volume, _operation.Token); }
        catch (OperationCanceledException) { /* A new selection applies the stored volume. */ }
        catch { /* A not-yet-created media element receives the volume when bound. */ }
        return _status;
    }

    private async Task ShowSourceCoreAsync()
    {
        ThrowIfDisposed();
        await EnsureAsync().WaitAsync(_lifetime.Token);
        ThrowIfDisposed();
        if (_status.Song is null && string.IsNullOrEmpty(_core!.Source)) _core.Navigate("https://www.bilibili.com/");
        ShowSourceWindow();
    }

    private Task EnsureAsync()
    {
        ThrowIfDisposed();
        if (_needsRecreate)
        {
            CloseWindow();
            _initializationTask = null;
            _needsRecreate = false;
        }
        if (_core is not null) return Task.CompletedTask;
        if (_initializationTask is null)
        {
            _initializationTask = InitializeCoreAsync();
            Observe(_initializationTask);
        }
        return _initializationTask;
    }

    private async Task InitializeCoreAsync()
    {
        var window = new Window
        {
            Width = 1100, Height = 760, MinWidth = 760, MinHeight = 560,
            Left = -10000, Top = -10000, WindowStyle = WindowStyle.None,
            ShowInTaskbar = false, ShowActivated = false, Title = "Bilibili · 音频来源",
        };
        var view = new WebView2();
        _window = window;
        _view = view;
        window.Content = view;
        window.Closing += SourceWindow_Closing;
        window.StateChanged += SourceWindow_StateChanged;
        // A shown off-screen surface avoids suspension of a collapsed or
        // minimized WebView2. It is destroyed when the application exits.
        window.Show();
        try
        {
            await view.EnsureCoreWebView2Async(_environment);
            ThrowIfDisposed();
            if (_view != view) throw Interrupted();
            var core = view.CoreWebView2 ?? throw Error("Bilibili 播放器初始化失败。", "PLAYER_INITIALIZATION_FAILED");
            _core = core;
            core.IsMuted = true;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsWebMessageEnabled = false;
            core.NavigationStarting += Source_NavigationStarting;
            core.NavigationCompleted += Source_NavigationCompleted;
            core.NewWindowRequested += Source_NewWindowRequested;
            core.PermissionRequested += Source_PermissionRequested;
            core.DownloadStarting += Source_DownloadStarting;
            core.ProcessFailed += Source_ProcessFailed;
            StartPolling();
        }
        catch
        {
            if (_view == view) CloseWindow();
            _needsRecreate = !_disposed;
            throw;
        }
    }

    private void StartPolling()
    {
        if (_pollTimer is not null || _disposed) return;
        _pollTimer = new DispatcherTimer(TimeSpan.FromMilliseconds(100), DispatcherPriority.Background, PollTimer_Tick, _dispatcher);
        _pollTimer.Start();
    }

    private void PollTimer_Tick(object? sender, EventArgs e) => SchedulePoll();
    private void SchedulePoll() { if (!_polling && !_disposed) Observe(PollAsync()); }

    private async Task PollAsync()
    {
        if (_polling || _disposed || _status.Song is null || _status.State is "idle" or "error" or "ended") return;
        var generation = _generation;
        var revision = _positionRevision;
        var sequence = ++_snapshotSequence;
        var token = _operation.Token;
        _polling = true;
        try
        {
            var snapshot = await ReadPageAsync(token: token);
            if (snapshot is not null && revision == _positionRevision) await ConsumeAsync(snapshot, generation, sequence, token);
        }
        catch (OperationCanceledException) { /* A new operation owns the next sample. */ }
        catch
        {
            if (IsCurrent(generation) && revision == _positionRevision && sequence >= _appliedSnapshotSequence && _waiter is null)
            {
                _missingSince ??= Environment.TickCount64;
                if (Elapsed(_missingSince) > 12_000) Fail("无法读取 Bilibili 播放状态，请重新播放。", "MEDIA_UNREACHABLE", generation);
            }
        }
        finally { _polling = false; }
    }

    private async Task ConsumeAsync(MediaSnapshot snapshot, long generation, long sequence, CancellationToken token)
    {
        if (!IsCurrent(generation) || _status.Song is null || snapshot.Stale || sequence < _appliedSnapshotSequence) return;
        _appliedSnapshotSequence = sequence;
        if (snapshot.NavigationMismatch)
        {
            if (!_navigating) Fail("源视频页面已切换，请重新选择歌曲播放。", "SOURCE_PAGE_CHANGED", generation);
            return;
        }
        if (!snapshot.Found)
        {
            if (!string.IsNullOrEmpty(snapshot.Blocked) && _desiredPlayback)
                Fail($"Bilibili 提示「{snapshot.Blocked}」，请打开源视频处理后重试。", "SOURCE_RESTRICTED", generation);
            else if (_waiter is null)
            {
                _missingSince ??= Environment.TickCount64;
                if (Elapsed(_missingSince) > 12_000) Fail("Bilibili 页面中的播放器已不可用，请重新播放或打开源视频检查。", "MEDIA_DISAPPEARED", generation);
            }
            return;
        }
        _missingSince = null;
        if (snapshot.MediaError != 0)
        {
            var reason = snapshot.MediaError switch
            {
                1 => "播放被中断", 2 => "音视频网络请求失败", 3 => "浏览器无法解码此视频",
                4 => "视频源不可用或当前浏览器不支持该格式", _ => "媒体播放失败",
            };
            Fail($"Bilibili {reason}，请在源视频页面检查。", "MEDIA_ERROR", generation);
            return;
        }
        if (_desiredPlayback && snapshot.Paused && !string.IsNullOrWhiteSpace(snapshot.PlayError))
        {
            Fail($"Bilibili 视频无法开始播放：{snapshot.PlayError}。可打开源视频完成登录或手动播放后重试。", "AUTOPLAY_FAILED", generation);
            return;
        }
        _status = _status with
        {
            CurrentTime = FinitePosition(snapshot.Restarting ? snapshot.GuardPosition ?? _status.CurrentTime : snapshot.CurrentTime),
            Duration = double.IsFinite(snapshot.Duration) && snapshot.Duration > 0 ? snapshot.Duration : _status.Duration,
        };
        if (snapshot.Ended && !snapshot.Restarting)
        {
            if (_status.State == "ended") return;
            _desiredPlayback = false;
            Mute(true);
            RejectWaiter(Error("视频已经结束。", "MEDIA_ENDED"));
            Publish(_status with { State = "ended", Error = null, ErrorCode = null });
            Ended?.Invoke();
            return;
        }
        if (_desiredPlayback && !snapshot.Restarting && !snapshot.Paused && snapshot.ReadyState >= 2 && snapshot.Playing)
        {
            _stalledSince = null;
            Mute(false);
            Publish(_status with { State = "playing", Error = null, ErrorCode = null });
            ResolveWaiter(generation);
            return;
        }
        if (_desiredPlayback && _waiter is not null && !_startAttempted)
        {
            _startAttempted = true;
            await StartNativePlaybackAsync(generation, token);
            return;
        }
        if (_desiredPlayback && !snapshot.Paused && (!snapshot.Playing || snapshot.Restarting))
        {
            _stalledSince ??= Environment.TickCount64;
            _status = _status with { State = "loading" };
            if (Elapsed(_stalledSince) > 30_000)
            {
                Fail("Bilibili 视频长时间缓冲，请检查网络或打开源视频后重试。", "MEDIA_BUFFER_TIMEOUT", generation);
                return;
            }
        }
        else _stalledSince = null;
        if (!_desiredPlayback && !snapshot.Paused)
        {
            await ReadPageAsync("pause", token: token);
            return;
        }
        if (snapshot.Paused && _desiredPlayback && _waiter is null && _status.State is "playing" or "loading")
        {
            _desiredPlayback = false;
            Mute(true);
            _status = _status with { State = "paused" };
        }
        Publish(_status);
    }

    private async Task StartNativePlaybackAsync(long generation, CancellationToken token)
    {
        var revision = _positionRevision;
        var sequence = ++_snapshotSequence;
        try
        {
            var snapshot = await ReadPageAsync("play", token: token);
            if (!IsCurrent(generation) || !_desiredPlayback) return;
            if (revision != _positionRevision) { _startAttempted = false; return; }
            if (snapshot is not null) await ConsumeAsync(snapshot, generation, sequence, token);
        }
        catch (OperationCanceledException) { }
        catch { if (IsCurrent(generation)) _startAttempted = false; }
    }

    private async Task<MediaSnapshot?> ReadPageAsync(string command = "read", double? value = null, CancellationToken token = default)
    {
        var core = _core;
        var song = _status.Song;
        if (_disposed || core is null || song is null || _navigating) return null;
        var controlSequence = command == "read" ? _commandSequence : ++_commandSequence;
        var script = BuildPageScript(command, song.Bvid, _status.Volume, _playbackRequest, _generation, controlSequence, _desiredPlayback, value);
        // ExecuteScriptAsync serializes an immediate value; play() promise
        // results are stored inside the page for later polls, never returned.
        var json = await core.ExecuteScriptAsync(script).WaitAsync(TimeSpan.FromSeconds(10), token);
        if (_core != core || _disposed) return null;
        try { return JsonSerializer.Deserialize<MediaSnapshot>(json, JsonOptions); }
        catch (JsonException) { return null; }
    }

    private long BeginOperation(string message = "已切换到新的播放请求。")
    {
        _operation.Cancel();
        _operation.Dispose();
        _operation = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        RejectWaiter(Error(message, "PLAYBACK_INTERRUPTED"));
        return ++_generation;
    }

    private Task<PlaybackStatus> AwaitPlayback(long generation)
    {
        RejectWaiter(Interrupted());
        var waiter = new PlaybackWaiter(generation);
        _waiter = waiter;
        Observe(waiter.Completion.Task);
        Observe(PlaybackTimeoutAsync(waiter));
        return waiter.Completion.Task;
    }

    private async Task PlaybackTimeoutAsync(PlaybackWaiter waiter)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(45), waiter.Timeout.Token);
            if (_waiter == waiter)
                Fail("视频未能在 45 秒内开始播放。请打开 Bilibili 源视频检查登录、验证、版权限制或网络情况。", "PLAYBACK_TIMEOUT", waiter.Generation);
        }
        catch (OperationCanceledException) { }
        finally { waiter.Timeout.Dispose(); }
    }

    private void ResolveWaiter(long generation)
    {
        if (_waiter is not { } waiter || waiter.Generation != generation) return;
        _waiter = null;
        waiter.Timeout.Cancel();
        waiter.Completion.TrySetResult(_status);
    }

    private void RejectWaiter(Exception error)
    {
        if (_waiter is not { } waiter) return;
        _waiter = null;
        waiter.Timeout.Cancel();
        waiter.Completion.TrySetException(error);
    }

    private void Fail(string message, string code, long generation)
    {
        if (!IsCurrent(generation)) return;
        _desiredPlayback = false;
        Mute(true);
        RejectWaiter(Error(message, code));
        Publish(_status with { State = "error", Error = message, ErrorCode = code });
        Observe(PauseAfterFailureAsync(generation));
    }

    private async Task PauseAfterFailureAsync(long generation)
    {
        try { if (IsCurrent(generation)) await ReadPageAsync("pause", token: _operation.Token); }
        catch { /* Muting already stopped audible output. */ }
    }

    private void Publish(PlaybackStatus status, bool force = false)
    {
        _status = status;
        var signature = status with { CurrentTime = Math.Round(status.CurrentTime * 20) / 20 };
        if (!force && signature == _lastPublished) return;
        _lastPublished = signature;
        StatusChanged?.Invoke(status);
    }

    private void Mute(bool muted)
    {
        try { if (_core is not null) _core.IsMuted = muted; }
        catch (ObjectDisposedException) { }
        catch (InvalidOperationException) { }
    }

    private async Task StopPageAsync()
    {
        if (_core is null) return;
        try
        {
            await _core.ExecuteScriptAsync("(() => { const m = window.__yuyinNativeMedia; if (m) { m.desiredPlaying = false; m.wantPlay = false; m.generation = Number.MAX_SAFE_INTEGER; ++m.playAttempt; } for (const v of document.querySelectorAll('video,audio')) { v.pause(); v.muted = true; } return true; })()")
                .WaitAsync(TimeSpan.FromSeconds(1));
        }
        catch { /* Muting and navigation also prevent old-page audio. */ }
    }

    private void Source_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (_disposed || !IsBilibiliUri(e.Uri)) { e.Cancel = true; return; }
        var song = _status.Song;
        if (song is not null && !IsSongUri(e.Uri, song.Bvid))
        {
            // A canceled previous selection may still enqueue a navigation.
            if (!e.IsUserInitiated && e.Uri != _explicitNavigation && !(e.IsRedirected && e.NavigationId == _navigationId)) { e.Cancel = true; return; }
            Fail("Bilibili 跳转到了其他页面，请打开源视频检查登录或验证后重新播放。", "SOURCE_PAGE_CHANGED", _generation);
        }
        _navigationId = e.NavigationId;
        _explicitNavigation = null;
        _navigationRequest = _playbackRequest;
        _navigating = true;
        Mute(true);
    }

    private void Source_NavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (_disposed || e.NavigationId != _navigationId || _navigationRequest != _playbackRequest) return;
        _navigating = false;
        if (e.IsSuccess && _status.Song is not null && IsSongUri(_core?.Source, _status.Song.Bvid)) _loadedPlaybackRequest = _playbackRequest;
        if (!e.IsSuccess && e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled && _status.Song is not null && _desiredPlayback)
            Fail($"Bilibili 视频页加载失败：{e.WebErrorStatus}。", "PAGE_LOAD_FAILED", _generation);
        else SchedulePoll();
    }

    private void Source_NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (_disposed || !e.IsUserInitiated || !IsBilibiliUri(e.Uri)) return;
        if (_status.Song is not null) Fail("源视频页面已切换，请重新选择歌曲播放。", "SOURCE_PAGE_CHANGED", _generation);
        _explicitNavigation = e.Uri;
        _core?.Navigate(e.Uri);
        ShowSourceWindow();
    }

    private static void Source_PermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e) => e.State = CoreWebView2PermissionState.Deny;
    private static void Source_DownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e) => e.Cancel = true;

    private void Source_ProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        if (_disposed) return;
        // GPU and auxiliary processes can be restarted by WebView2 without
        // losing the source document; do not interrupt audio for those events.
        if (e.ProcessFailedKind is not (CoreWebView2ProcessFailedKind.BrowserProcessExited or CoreWebView2ProcessFailedKind.RenderProcessExited or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)) return;
        _needsRecreate = true;
        Fail($"Bilibili 播放进程已退出（{e.ProcessFailedKind}），请重新播放。", "MEDIA_PROCESS_EXITED", _generation);
    }

    private void ShowSourceWindow()
    {
        if (_window is null || _disposed) return;
        if (!_sourceVisible)
        {
            var area = SystemParameters.WorkArea;
            _window.Left = area.Left + Math.Max(0, (area.Width - _window.Width) / 2);
            _window.Top = area.Top + Math.Max(0, (area.Height - _window.Height) / 2);
            _window.WindowStyle = WindowStyle.SingleBorderWindow;
            _window.ShowInTaskbar = true;
            _sourceVisible = true;
        }
        _window.WindowState = WindowState.Normal;
        _window.Activate();
    }

    private void KeepSourceOffScreen()
    {
        if (_window is null || _disposed) return;
        _sourceVisible = false;
        _window.WindowState = WindowState.Normal;
        _window.ShowInTaskbar = false;
        _window.WindowStyle = WindowStyle.None;
        _window.Left = -10000;
        _window.Top = -10000;
    }

    private void SourceWindow_Closing(object? sender, CancelEventArgs e)
    {
        if (_disposed) return;
        e.Cancel = true;
        KeepSourceOffScreen();
    }

    private void SourceWindow_StateChanged(object? sender, EventArgs e)
    {
        if (!_disposed && _window?.WindowState == WindowState.Minimized) KeepSourceOffScreen();
    }

    private void CloseWindow()
    {
        _pollTimer?.Stop();
        if (_pollTimer is not null) _pollTimer.Tick -= PollTimer_Tick;
        _pollTimer = null;
        var core = _core;
        _core = null;
        if (core is not null)
        {
            core.NavigationStarting -= Source_NavigationStarting;
            core.NavigationCompleted -= Source_NavigationCompleted;
            core.NewWindowRequested -= Source_NewWindowRequested;
            core.PermissionRequested -= Source_PermissionRequested;
            core.DownloadStarting -= Source_DownloadStarting;
            core.ProcessFailed -= Source_ProcessFailed;
            try { core.IsMuted = true; core.Stop(); }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
        }
        if (_window is not null)
        {
            _window.Closing -= SourceWindow_Closing;
            _window.StateChanged -= SourceWindow_StateChanged;
            _window.Content = null;
        }
        _view?.Dispose();
        _view = null;
        _window?.Close();
        _window = null;
        _sourceVisible = false;
        _navigating = false;
        _navigationId = 0;
        _loadedPlaybackRequest = 0;
        _explicitNavigation = null;
    }

    public ValueTask DisposeAsync() => new(OnDispatcherAsync(() => _disposeTask ??= DisposeCoreAsync()));

    private async Task DisposeCoreAsync()
    {
        if (_disposed) return;
        _disposed = true;
        ++_generation;
        _desiredPlayback = false;
        _lifetime.Cancel();
        _operation.Cancel();
        _pollTimer?.Stop();
        Mute(true);
        RejectWaiter(Error("播放器已关闭。", "PLAYER_DISPOSED"));
        await StopPageAsync();
        CloseWindow();
        _operation.Dispose();
        _lifetime.Dispose();
        StatusChanged = null;
        Ended = null;
    }

    private Task OnDispatcherAsync(Func<Task> callback) => _dispatcher.CheckAccess() ? callback() : _dispatcher.InvokeAsync(callback).Task.Unwrap();
    private Task<T> OnDispatcherAsync<T>(Func<Task<T>> callback) => _dispatcher.CheckAccess() ? callback() : _dispatcher.InvokeAsync(callback).Task.Unwrap();
    private bool IsCurrent(long generation) => !_disposed && generation == _generation;
    private void RequireCurrent(long generation, CancellationToken token) { token.ThrowIfCancellationRequested(); if (!IsCurrent(generation)) throw Interrupted(); }
    private void ThrowIfDisposed() { if (_disposed) throw Error("播放器已关闭。", "PLAYER_DISPOSED"); }
    private static double FinitePosition(double seconds) => double.IsFinite(seconds) ? Math.Max(0, seconds) : 0;
    private static long Elapsed(long? since) => since is { } value ? Math.Max(0, Environment.TickCount64 - value) : 0;
    private static PlaybackHostException Interrupted() => Error("已切换到新的播放请求。", "PLAYBACK_INTERRUPTED");
    private static PlaybackHostException Error(string message, string code) => new(message, code);
    private static void Observe(Task task) => _ = task.ContinueWith(static completed => _ = completed.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    private static bool IsValidSong(Song? song) => song is not null && song.Source == "bilibili" && System.Text.RegularExpressions.Regex.IsMatch(song.Bvid ?? "", "^BV[0-9A-Za-z]{10}$") && double.IsFinite(song.Duration) && song.Duration >= 0;
    private static bool IsBilibiliUri(string? value) => Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) && uri.IsDefaultPort && string.IsNullOrEmpty(uri.UserInfo)
        && (uri.Host.Equals("bilibili.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".bilibili.com", StringComparison.OrdinalIgnoreCase));
    private static bool IsSongUri(string? value, string bvid) => IsBilibiliUri(value) && Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && (uri.AbsolutePath.Equals($"/video/{bvid}", StringComparison.Ordinal) || uri.AbsolutePath.Equals($"/video/{bvid}/", StringComparison.Ordinal));
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    private sealed class PlaybackWaiter(long generation)
    {
        public long Generation { get; } = generation;
        public CancellationTokenSource Timeout { get; } = new();
        public TaskCompletionSource<PlaybackStatus> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
    private sealed class PlaybackHostException(string message, string code) : InvalidOperationException(message) { public string Code { get; } = code; }
    private sealed record MediaSnapshot(bool Found, bool Paused, bool Ended, double CurrentTime, double Duration, int ReadyState, bool Playing, int MediaError, string? Blocked = null, string? PlayError = null, bool NavigationMismatch = false, bool Restarting = false, double? GuardPosition = null, bool Stale = false);

    internal static string BuildPageScript(string command, string bvid, double volume, long requestId, long generation, long controlSequence, bool desiredPlaying, double? value = null)
    {
        var parameters = JsonSerializer.Serialize(new { command, bvid, volume, requestId, generation, controlSequence, desiredPlaying, value });
        return $$"""
            (() => {
              const args = {{parameters}};
              const empty = { found: false, paused: true, ended: false, currentTime: 0, duration: 0, readyState: 0, playing: false, mediaError: 0 };
              const path = '/video/' + args.bvid;
              if (location.protocol !== 'https:' || (location.pathname !== path && location.pathname !== path + '/')) return { ...empty, navigationMismatch: true };
              const memory = window.__yuyinNativeMedia || (window.__yuyinNativeMedia = { video: null, requestId: -1, generation: -1, controlSequence: -1, volume: args.volume, playing: false, ended: false, error: 0, playAttempt: 0 });
              if (args.requestId < memory.requestId || args.generation < memory.generation || args.controlSequence < memory.controlSequence) return { ...empty, stale: true };
              if (args.requestId !== memory.requestId) {
                memory.requestId = args.requestId;
                memory.wantPlay = false;
                memory.playError = null;
                memory.ended = false;
                memory.startup = { active: true, positioned: false, correcting: false, correctionPending: false, position: 0, advancing: false, lastAt: Date.now() };
              }
              if (args.generation > memory.generation) {
                memory.generation = args.generation;
                memory.playError = null;
                ++memory.playAttempt;
              }
              memory.desiredPlaying = args.desiredPlaying;
              if (args.command !== 'read') {
                if (args.controlSequence < memory.controlSequence) return { ...empty, stale: true };
                memory.controlSequence = args.controlSequence;
              }
              if (!memory.captureInstalled) {
                window.addEventListener('ended', event => {
                  if (event.target !== memory.video) return;
                  memory.ended = true;
                  memory.wantPlay = false;
                  memory.video.pause();
                  event.stopImmediatePropagation();
                }, true);
                for (const name of ['pointerdown', 'keydown']) window.addEventListener(name, event => {
                  if (event.isTrusted && memory.startup?.positioned) memory.startup.active = false;
                }, true);
                memory.captureInstalled = true;
              }
              const video = document.querySelector('.bpx-player-video-wrap video') || document.querySelector('.bilibili-player-video video') || document.querySelector('video');
              if (!video) {
                const body = (document.body?.innerText || '').slice(0, 12000);
                const reasons = ['412 Precondition Failed', '403 Forbidden', '安全验证', '人机验证', '访问异常', '访问受限', '请求被拦截', '登录后观看', '视频已失效', '视频已删除', '视频不见了', '应版权方要求', '所在地区不可用'];
                return { ...empty, blocked: reasons.find(reason => body.includes(reason)) || null };
              }
              const replaced = memory.video !== video;
              if (replaced) {
                memory.video = video;
                memory.ended = false;
                memory.error = 0;
                memory.playError = null;
                memory.playing = false;
                memory.lastTime = video.currentTime;
                ++memory.playAttempt;
                if (memory.startup.active) memory.startup.positioned = false;
                video.volume = memory.volume;
                const keepBeginning = () => {
                  const startup = memory.startup;
                  if (memory.video !== video || !startup.active || startup.correcting) return;
                  const now = Date.now();
                  const elapsed = Math.max(0, now - startup.lastAt) / 1000;
                  const rate = Number.isFinite(video.playbackRate) ? Math.max(0, video.playbackRate) : 1;
                  const target = Number.isFinite(startup.position) ? startup.position : 0;
                  const maximumAdvance = startup.advancing ? elapsed * rate : 0;
                  const jumped = video.currentTime > target + maximumAdvance + 0.75 || video.currentTime < target - 0.75;
                  if (!startup.positioned || jumped) {
                    try {
                      startup.correcting = true;
                      video.currentTime = target;
                      startup.positioned = Number.isFinite(video.currentTime) && Math.abs(video.currentTime - target) <= 0.05;
                      startup.correctionPending = video.seeking;
                      memory.ended = false;
                      memory.lastTime = video.currentTime;
                    } catch { startup.positioned = false; }
                    finally { startup.correcting = false; }
                  } else {
                    startup.position = video.currentTime;
                    if (!video.seeking) startup.correctionPending = false;
                  }
                  startup.lastAt = now;
                  startup.advancing = memory.playing && !video.paused && !video.seeking;
                };
                memory.keepBeginning = keepBeginning;
                for (const name of ['loadedmetadata', 'canplay', 'seeking', 'seeked', 'timeupdate']) video.addEventListener(name, keepBeginning);
                video.addEventListener('error', () => { if (memory.video === video) memory.error = video.error?.code || 0; });
                video.addEventListener('playing', () => {
                  if (memory.video !== video) return;
                  if (!memory.desiredPlaying) { video.pause(); return; }
                  keepBeginning();
                  memory.playing = true;
                  memory.startup.advancing = !video.paused && !video.seeking;
                });
                for (const name of ['pause', 'waiting', 'stalled', 'ended']) video.addEventListener(name, () => {
                  if (memory.video !== video) return;
                  keepBeginning();
                  memory.playing = false;
                  memory.startup.advancing = false;
                });
              }
              memory.keepBeginning();
              if (args.command === 'volume') memory.volume = args.value;
              if (memory.volume !== args.volume && args.command !== 'volume') memory.volume = args.volume;
              video.volume = memory.volume;
              if (args.command === 'pause' || !memory.desiredPlaying) {
                memory.wantPlay = false;
                ++memory.playAttempt;
                if (memory.startup.active && memory.startup.positioned && Number.isFinite(video.currentTime)) {
                  memory.startup.position = video.currentTime;
                  memory.startup.lastAt = Date.now();
                }
                video.pause();
              }
              if (args.command === 'seek') {
                const maximum = Number.isFinite(video.duration) ? video.duration : args.value;
                const wasActive = memory.startup.active;
                memory.startup.active = false;
                try { video.currentTime = Math.max(0, Math.min(args.value, maximum)); }
                catch (error) { memory.startup.active = wasActive; throw error; }
                memory.ended = false;
              }
              if ((args.command === 'play' || (replaced && memory.wantPlay)) && memory.desiredPlaying) {
                memory.wantPlay = true;
                memory.ended = false;
                memory.playError = null;
                video.muted = false;
                const attempt = ++memory.playAttempt;
                const expectedRequest = memory.requestId;
                const expectedGeneration = memory.generation;
                const current = () => memory.video === video && memory.requestId === expectedRequest && memory.generation === expectedGeneration && memory.playAttempt === attempt;
                let playTimer;
                try {
                  const promise = video.play();
                  Promise.race([promise, new Promise((_, reject) => { playTimer = setTimeout(() => reject(new Error('视频仍在缓冲，请稍后重试。')), 8000); })])
                    .then(() => {
                      if (!current()) { if (!memory.desiredPlaying) video.pause(); return; }
                      memory.keepBeginning();
                      memory.playing = !video.paused;
                    })
                    .catch(error => { if (current()) memory.playError = error?.message || String(error); })
                    .finally(() => clearTimeout(playTimer));
                } catch (error) { if (current()) memory.playError = error?.message || String(error); clearTimeout(playTimer); }
              }
              if (!video.paused && video.currentTime > memory.lastTime + 0.01) memory.playing = true;
              memory.lastTime = video.currentTime;
              return {
                found: true, paused: video.paused, ended: memory.ended || video.ended,
                currentTime: memory.startup.active ? memory.startup.position : (Number.isFinite(video.currentTime) ? video.currentTime : 0),
                duration: Number.isFinite(video.duration) ? video.duration : 0,
                readyState: video.readyState, playing: memory.playing,
                restarting: memory.startup.active && (!memory.startup.positioned || memory.startup.correctionPending),
                guardPosition: memory.startup.active ? memory.startup.position : null,
                mediaError: video.error?.code || memory.error, playError: memory.playError || null,
              };
            })()
            """;
    }
}
