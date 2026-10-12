using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;

namespace Yuyin.WindowsHost;

public partial class MainWindow : Window
{
    private const string VirtualHost = "appassets.yuyin.local";
    private const string AppOrigin = "https://appassets.yuyin.local";
    private const string RendererEnvironmentVariable = "YUYIN_RENDERER_DIR";
    private const string UserDataEnvironmentVariable = "YUYIN_WEBVIEW2_USER_DATA_DIR";
    private const string StateDirectoryEnvironmentVariable = "YUYIN_STATE_DIR";
    private const int MaxBridgeMessageLength = 34 * 1024 * 1024;
    private const long MaxBridgeRequestId = 9_007_199_254_740_991;
    private static readonly HashSet<string> AllowedMethods = new(StringComparer.Ordinal)
    {
        "music.search", "music.suggestions", "music.play", "music.pause", "music.resume", "music.seek", "music.volume", "music.status", "music.lyrics", "music.lyricsCandidates", "music.source", "music.mv",
        "account.login", "account.status", "account.guest", "account.profile",
        "favorites.folders", "favorites.items", "favorites.songs",
        "comments.list", "comments.replies", "comments.like", "comments.create",
        "desktopLyrics.get", "desktopLyrics.settings", "desktopLyrics.publish", "desktopLyrics.window.get", "desktopLyrics.window.settings", "desktopLyrics.window.close",
        "update.getState", "update.check", "update.download", "update.install", "update.openRelease",
        "window.minimize", "window.maximize", "window.close", "window.drag",
        "library.export", "library.import",
    };
    private readonly JsonSerializerOptions _json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };
    private CoreWebView2Environment? _environment;
    private CoreWebView2? _core;
    private BilibiliService? _bilibili;
    private PlayerHost? _player;
    private DesktopLyricsHost? _desktopLyrics;
    private Window? _loginWindow;
    private Microsoft.Web.WebView2.Wpf.WebView2? _loginView;
    private CoreWebView2? _loginCore;
    private DispatcherTimer? _loginPollTimer;
    private bool _loginCheckInFlight;
    private bool _initialized;
    private bool _allowClose;
    private bool _shutdownStarted;
    private string? _rendererRoot;
    private LocalDataStore? _localData;
    private UpdateService? _updater;
    private long _playEntryRevision;

    public MainWindow() => InitializeComponent();

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        if (_initialized) return;
        _initialized = true;
        await InitializeWebViewAsync();
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var runtimeVersion = CoreWebView2Environment.GetAvailableBrowserVersionString(null);
            if (string.IsNullOrWhiteSpace(runtimeVersion)) throw new InvalidOperationException("WebView2 Runtime 未安装。");
            _rendererRoot = ResolveRendererRoot() ?? throw new InvalidOperationException("Renderer 未找到，请先运行 npm run build:webview2。");
            var userDataDirectory = ResolveUserDataDirectory();
            Directory.CreateDirectory(userDataDirectory);
            var options = new CoreWebView2EnvironmentOptions { AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required" };
            _environment = await CoreWebView2Environment.CreateAsync(null, userDataDirectory, options);
            if (_shutdownStarted) return;
            await Browser.EnsureCoreWebView2Async(_environment);
            if (_shutdownStarted) return;
            var core = Browser.CoreWebView2;
            _core = core;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.WebMessageReceived += Browser_WebMessageReceived;
            core.NavigationStarting += Browser_NavigationStarting;
            core.NewWindowRequested += Browser_NewWindowRequested;
            core.PermissionRequested += DenyPermission;
            core.DownloadStarting += CancelDownload;
            core.NavigationCompleted += Browser_NavigationCompleted;
            var bridgePath = Path.Combine(AppContext.BaseDirectory, "bridge.js");
            if (File.Exists(bridgePath)) await core.AddScriptToExecuteOnDocumentCreatedAsync(await File.ReadAllTextAsync(bridgePath));
            if (_shutdownStarted) return;
            core.SetVirtualHostNameToFolderMapping(VirtualHost, _rendererRoot, CoreWebView2HostResourceAccessKind.DenyCors);
            _localData = new LocalDataStore(ResolveStateDirectory());
            RestoreWindowState();
            core.AddHostObjectToScript("localData", _localData);
            _updater = new UpdateService(Path.Combine(ResolveStateDirectory(), "updates"), LaunchUpdateInstallerAsync);
            _updater.StateChanged += Updater_StateChanged;

            _bilibili = new BilibiliService(core.CookieManager);
            _bilibili.SessionChanged += Bilibili_SessionChanged;
            _player = new PlayerHost(_environment, Dispatcher);
            _player.StatusChanged += Player_StatusChanged;
            _player.Ended += Player_Ended;
            _desktopLyrics = new DesktopLyricsHost(_environment, Dispatcher, _rendererRoot, ResolveStateDirectory());
            _desktopLyrics.SnapshotChanged += DesktopLyrics_SnapshotChanged;
            await _desktopLyrics.StartIfEnabledAsync();
            if (_shutdownStarted) return;
            core.Navigate($"https://{VirtualHost}/index.html");
            _updater.Start();
            StatusText.Text = $"WebView2 Runtime {runtimeVersion}";
        }
        catch (Exception error)
        {
            var runtimeMissing = error is WebView2RuntimeNotFoundException;
            StatusText.Text = runtimeMissing
                ? "系统缺少 Microsoft Edge WebView2 运行时。openmusic直接使用系统运行时，请安装后重新打开openmusic。"
                : $"无法启动openmusic：{error.Message}";
            RuntimeDownloadButton.Visibility = runtimeMissing ? Visibility.Visible : Visibility.Collapsed;
            StatusText.Foreground = System.Windows.Media.Brushes.DarkRed;
        }
    }

    private void RuntimeDownloadButton_Click(object sender, RoutedEventArgs e) =>
        OpenExternal("https://developer.microsoft.com/microsoft-edge/webview2/#download-section");

    private async void Browser_NavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess) StartupOverlay.Visibility = Visibility.Collapsed;
        else StatusText.Text = $"界面加载失败：{e.WebErrorStatus}";
        await Task.CompletedTask;
    }

    private void Browser_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        // The main renderer is a local, virtual-hosted document. It must never
        // be turned into a general-purpose browser by a renderer redirect.
        if (!IsAppOrigin(e.Uri)) e.Cancel = true;
    }

    private static void Browser_NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        // Links opened by the renderer must go through an explicit, validated
        // native API (for example update.openRelease), never a new WebView.
        e.Handled = true;
    }

    private async void Browser_WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        var core = _core;
        long id = 0;
        try
        {
            if (_shutdownStarted || !IsAppOrigin(e.Source) || e.WebMessageAsJson.Length > MaxBridgeMessageLength) return;
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || type.GetString() != "invoke") return;
            if (!root.TryGetProperty("id", out var idValue) || !idValue.TryGetInt64(out var parsedId) || parsedId < 0 || parsedId > MaxBridgeRequestId) return;
            id = parsedId;
            if (!root.TryGetProperty("method", out var methodValue) || methodValue.ValueKind != JsonValueKind.String) throw new InvalidOperationException("原生操作名称不合法。");
            var method = methodValue.GetString();
            if (string.IsNullOrWhiteSpace(method) || method.Length > 80 || !AllowedMethods.Contains(method)) throw new InvalidOperationException("原生操作不支持。");
            if (!root.TryGetProperty("args", out var args) || args.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("原生操作参数不合法。");
            ValidateInvoke(method, args);
            var value = await InvokeAsync(method, args);
            if (id > 0) Reply(core, id, true, value, null);
        }
        catch (Exception error)
        {
            if (id > 0) Reply(core, id, false, null, error is BilibiliServiceException bili ? bili.Message : error.Message);
        }
    }

    private async Task<object?> InvokeAsync(string? method, JsonElement args)
    {
        if (_shutdownStarted) throw new InvalidOperationException("应用正在关闭。");
        if (_bilibili is null || _player is null || _desktopLyrics is null) throw new InvalidOperationException("原生服务尚未准备完成。");
        switch (method)
        {
            case "music.search":
                return await _bilibili.SearchAsync(ArgString(args, 0), ArgInt(args, 1, 1), ArgString(args, 2, "video"));
            case "music.suggestions":
                return await _bilibili.SearchSuggestionsAsync(ArgString(args, 0));
            case "music.play":
                var playRevision = ++_playEntryRevision;
                var song = JsonSerializer.Deserialize<Song>(Arg(args, 0), _json) ?? throw new InvalidOperationException("歌曲信息不合法。");
                ValidateSong(song);
                await _bilibili.EnsurePlaybackAccessAsync();
                if (_shutdownStarted || playRevision != _playEntryRevision) throw new InvalidOperationException("播放请求已切换。");
                return await _player.PlayAsync(song);
            case "music.pause": ++_playEntryRevision; return await _player.PauseAsync();
            case "music.resume":
                var resumeRevision = ++_playEntryRevision;
                await _bilibili.EnsurePlaybackAccessAsync();
                if (_shutdownStarted || resumeRevision != _playEntryRevision) throw new InvalidOperationException("播放请求已切换。");
                return await _player.ResumeAsync();
            case "music.seek": return await _player.SeekAsync(ArgDouble(args, 0));
            case "music.volume": return await _player.SetVolumeAsync(ArgDouble(args, 0));
            case "music.status": return _player.Status;
            case "library.export":
                LocalDataStore.ValidateLibrary(ArgString(args, 0));
                var save = new Microsoft.Win32.SaveFileDialog { Filter = "JSON 音乐库|*.json", FileName = "openmusic音乐库.json", DefaultExt = ".json" };
                if (save.ShowDialog(this) != true) return false;
                LocalDataStore.AtomicWrite(save.FileName, ArgString(args, 0));
                return true;
            case "library.import":
                var open = new Microsoft.Win32.OpenFileDialog { Filter = "JSON 音乐库|*.json", Multiselect = false };
                if (open.ShowDialog(this) != true) return null;
                using (var file = new FileStream(open.FileName, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                    if (file.Length > 32 * 1024 * 1024) throw new InvalidOperationException("音乐库文件过大。");
                    using var output = new MemoryStream(); var buffer = new byte[8192];
                    while (true) { var count = await file.ReadAsync(buffer); if (count == 0) break; if (output.Length + count > 32 * 1024 * 1024) throw new InvalidOperationException("音乐库文件过大。"); output.Write(buffer, 0, count); }
                    return new System.Text.UTF8Encoding(false, true).GetString(output.ToArray());
                }
            case "music.lyrics":
                var lyricsRequest = JsonSerializer.Deserialize<LyricsRequest>(Arg(args, 0), _json) ?? throw new InvalidOperationException("歌词请求不合法。");
                ValidateSong(lyricsRequest.Song);
                return await _bilibili.LookupLyricsAsync(lyricsRequest);
            case "music.lyricsCandidates": return await _bilibili.LookupLyricsCandidatesAsync(ArgString(args, 0));
            case "account.login": await OpenLoginWindowAsync(); return null;
            case "account.status": return await _bilibili.GetAccountAsync(true);
            case "account.guest": return _bilibili.ContinueAsGuest();
            case "account.profile":
                var account = await _bilibili.RequireLoggedInAsync();
                OpenExternal($"https://space.bilibili.com/{account.Account!.Mid}");
                return null;
            case "favorites.folders": return await _bilibili.ListFavoriteFoldersAsync();
            case "favorites.items": return await _bilibili.ListFavoriteItemsAsync(ArgLong(args, 0), ArgInt(args, 1, 1));
            case "favorites.songs": return await _bilibili.ListFavoriteSongsAsync(ArgLong(args, 0));
            case "comments.list": return await _bilibili.GetVideoCommentsAsync(ArgString(args, 0), ArgString(args, 1), ArgInt(args, 2, 1));
            case "comments.replies": return await _bilibili.GetCommentRepliesAsync(ArgString(args, 0), ArgString(args, 1), ArgInt(args, 2, 1));
            case "comments.like": return await _bilibili.SetCommentLikeAsync(ArgString(args, 0), ArgString(args, 1), ArgBool(args, 2), ArgLong(args, 3));
            case "comments.create":
                var commentRequest = JsonSerializer.Deserialize<CommentCreateRequest>(Arg(args, 0), _json) ?? throw new InvalidOperationException("评论请求不合法。");
                return await _bilibili.CreateCommentAsync(commentRequest);
            case "music.source": await _player.ShowSourceAsync(); return null;
            case "music.mv": await _player.ShowMVAsync(); return null;
            case "desktopLyrics.get": return _desktopLyrics.Snapshot;
            case "desktopLyrics.settings": return await _desktopLyrics.UpdateSettingsAsync(Arg(args, 0));
            case "desktopLyrics.publish":
                var content = JsonSerializer.Deserialize<DesktopLyricsContent>(Arg(args, 0), _json) ?? throw new InvalidOperationException("桌面歌词内容不合法。");
                _desktopLyrics.Publish(content);
                return null;
            case "desktopLyrics.window.get": return _desktopLyrics.Snapshot;
            case "desktopLyrics.window.settings": return await _desktopLyrics.UpdateSettingsAsync(Arg(args, 0));
            case "desktopLyrics.window.close": return await _desktopLyrics.UpdateSettingsAsync(JsonDocument.Parse("{\"enabled\":false}").RootElement.Clone());
            case "update.getState": return _updater?.State ?? throw new InvalidOperationException("更新服务尚未准备完成。");
            case "update.check": return await (_updater?.CheckAsync() ?? throw new InvalidOperationException("更新服务尚未准备完成。"));
            case "update.download": return await (_updater?.DownloadAsync() ?? throw new InvalidOperationException("更新服务尚未准备完成。"));
            case "update.install": return await (_updater?.InstallAsync() ?? throw new InvalidOperationException("更新服务尚未准备完成。"));
            case "update.openRelease": OpenExternal(_updater?.ReleaseUrl ?? UpdateService.LatestReleaseUrl); return null;
            case "window.minimize": Minimize(); return null;
            case "window.maximize": WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized; return null;
            case "window.close": Close(); return null;
            case "window.drag":
                // DragMove runs a nested Windows message loop. Never start it
                // inside WebView2's synchronous WebMessageReceived callback.
                _ = Dispatcher.BeginInvoke(DispatcherPriority.Input, (Action)(() => {
                    if (_shutdownStarted || !IsVisible || System.Windows.Input.Mouse.LeftButton != System.Windows.Input.MouseButtonState.Pressed) return;
                    try { DragMove(); } catch (InvalidOperationException) { }
                    catch (System.ComponentModel.Win32Exception) { }
                }));
                return null;
            default: throw new InvalidOperationException("原生操作不支持。");
        }
    }

    private async Task OpenLoginWindowAsync()
    {
        if (_environment is null) throw new InvalidOperationException("WebView2 尚未准备完成。");
        if (_shutdownStarted) throw new InvalidOperationException("应用正在关闭。");
        if (_loginWindow is not null) { _loginWindow.Activate(); return; }
        var window = new Window { Width = 1100, Height = 760, MinWidth = 760, MinHeight = 560, Title = "Bilibili · 登录与验证", Owner = this };
        var view = new Microsoft.Web.WebView2.Wpf.WebView2();
        window.Content = view;
        _loginWindow = window;
        _loginView = view;
        window.Closed += LoginWindow_Closed;
        window.Show();
        try
        {
            await view.EnsureCoreWebView2Async(_environment);
            if (_loginWindow != window || _shutdownStarted) return;
            _loginCore = view.CoreWebView2 ?? throw new InvalidOperationException("登录窗口初始化失败。");
            _loginCore.Settings.AreDefaultContextMenusEnabled = true;
            _loginCore.Settings.IsStatusBarEnabled = false;
            _loginCore.Settings.IsZoomControlEnabled = false;
            _loginCore.Settings.AreHostObjectsAllowed = false;
            _loginCore.Settings.IsWebMessageEnabled = false;
            _loginCore.PermissionRequested += DenyPermission;
            _loginCore.DownloadStarting += CancelDownload;
            _loginCore.NavigationStarting += Login_NavigationStarting;
            _loginCore.NewWindowRequested += Login_NewWindowRequested;
            _loginCore.NavigationCompleted += Login_NavigationCompleted;
            _loginCore.Navigate("https://passport.bilibili.com/login");
            StartLoginMonitor();
            await CheckLoginAndCloseAsync();
        }
        catch
        {
            CloseLoginWindow();
            throw;
        }
    }

    private void StartLoginMonitor()
    {
        _loginPollTimer?.Stop();
        _loginPollTimer = new DispatcherTimer(TimeSpan.FromSeconds(2), DispatcherPriority.Background, LoginPollTimer_Tick, Dispatcher);
        _loginPollTimer.Start();
    }

    private async void LoginPollTimer_Tick(object? sender, EventArgs e) => await CheckLoginAndCloseAsync();

    private async Task CheckLoginAndCloseAsync()
    {
        if (_loginCheckInFlight || _loginWindow is null || _bilibili is null || _shutdownStarted) return;
        _loginCheckInFlight = true;
        try
        {
            var status = await _bilibili.GetAccountAsync(true);
            if (status.LoggedIn && _loginWindow is not null) CloseLoginWindow();
        }
        catch (BilibiliServiceException) { /* Keep the login page open for verification/network errors. */ }
        catch (HttpRequestException) { /* Retry on the next timer tick. */ }
        catch (TaskCanceledException) { /* Retry on the next timer tick. */ }
        finally { _loginCheckInFlight = false; }
    }

    private void Login_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!IsBilibiliUri(e.Uri)) e.Cancel = true;
    }

    private static void Login_NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
    }

    private void Login_NavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess) _ = CheckLoginAndCloseAsync();
    }

    private void LoginWindow_Closed(object? sender, EventArgs e)
    {
        _loginPollTimer?.Stop();
        _loginPollTimer = null;
        if (_loginCore is not null)
        {
            _loginCore.NavigationStarting -= Login_NavigationStarting;
            _loginCore.NewWindowRequested -= Login_NewWindowRequested;
            _loginCore.NavigationCompleted -= Login_NavigationCompleted;
            _loginCore.PermissionRequested -= DenyPermission;
            _loginCore.DownloadStarting -= CancelDownload;
        }
        _loginCore = null;
        _loginView?.Dispose();
        _loginView = null;
        if (sender == _loginWindow) _loginWindow = null;
        if (!_shutdownStarted) SendEvent("account.changed", null);
    }

    private void CloseLoginWindow()
    {
        if (_loginWindow is null) return;
        _loginPollTimer?.Stop();
        _loginPollTimer = null;
        _loginWindow.Close();
    }

    private void Bilibili_SessionChanged()
    {
        void Dispatch()
        {
            if (_shutdownStarted) return;
            SendEvent("account.changed", null);
            if (_loginWindow is not null) _ = CheckLoginAndCloseAsync();
        }
        if (Dispatcher.CheckAccess()) Dispatch();
        else _ = Dispatcher.BeginInvoke(Dispatch);
    }

    private void Player_StatusChanged(PlaybackStatus status) => SendEvent("music.status", status);
    private void Player_Ended() => SendEvent("music.ended", null);
    private void DesktopLyrics_SnapshotChanged(DesktopLyricsSnapshot snapshot) => SendEvent("desktopLyrics.snapshot", snapshot);
    private void Updater_StateChanged(UpdateState state) => SendEvent("update.state", state);
    private async Task LaunchUpdateInstallerAsync(string file, WindowsUpdateManifest manifest)
    {
        await Dispatcher.InvokeAsync(() => {
            if (_shutdownStarted) throw new InvalidOperationException("应用正在关闭。");
            // Synchronous stores already commit each edit. Abort installation if
            // the final window preference cannot be saved.
            SaveWindowState(true);
            using var process = Process.Start(UpdateService.CreateInstallerStartInfo(file, Environment.ProcessId))
                ?? throw new InvalidOperationException("更新安装程序未能启动。");
            Close();
        });
    }

    private void Window_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_allowClose) return;
        e.Cancel = true;
        if (!_shutdownStarted)
        {
            _shutdownStarted = true;
            _ = ShutdownAsync();
        }
    }

    private async Task ShutdownAsync()
    {
        ++_playEntryRevision;
        async Task Cleanup(Func<Task> operation) { try { await operation(); } catch (Exception error) { Debug.WriteLine("openmusic关闭清理失败：" + error.Message); } }
        SaveWindowState();
        await Cleanup(() => { if (_updater is not null) { _updater.StateChanged -= Updater_StateChanged; _updater.Dispose(); } return Task.CompletedTask; });
        await Cleanup(() => { CloseLoginWindow(); return Task.CompletedTask; });
        await Cleanup(() => {
            if (_core is not null) {
                _core.WebMessageReceived -= Browser_WebMessageReceived;
                _core.NavigationStarting -= Browser_NavigationStarting;
                _core.NewWindowRequested -= Browser_NewWindowRequested;
                _core.NavigationCompleted -= Browser_NavigationCompleted;
                _core.PermissionRequested -= DenyPermission;
                _core.DownloadStarting -= CancelDownload;
            }
            return Task.CompletedTask;
        });
        await Cleanup(async () => { if (_desktopLyrics is not null) { _desktopLyrics.SnapshotChanged -= DesktopLyrics_SnapshotChanged; await _desktopLyrics.DisposeAsync(); } });
        await Cleanup(async () => { if (_player is not null) { _player.StatusChanged -= Player_StatusChanged; _player.Ended -= Player_Ended; await _player.DisposeAsync(); } });
        await Cleanup(() => { if (_bilibili is not null) { _bilibili.SessionChanged -= Bilibili_SessionChanged; _bilibili.Dispose(); } return Task.CompletedTask; });
        await Cleanup(() => { Browser.Dispose(); _core = null; return Task.CompletedTask; });
        _allowClose = true;
        Close();
    }

    private static void ValidateSong(Song song)
    {
        if (song is null || !System.Text.RegularExpressions.Regex.IsMatch(song.Bvid ?? "", "^BV[0-9A-Za-z]{10}$") || song.Url != $"https://www.bilibili.com/video/{song.Bvid}/" ||
            string.IsNullOrWhiteSpace(song.Title) || song.Title.Length > 1000 || song.Artist is null || song.Artist.Length > 500 || !double.IsFinite(song.Duration) || song.Duration < 0 || song.Duration > 86400)
            throw new InvalidOperationException("歌曲信息不合法。");
    }
    private static void DenyPermission(object? sender, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; e.Handled = true; }
    private static void CancelDownload(object? sender, CoreWebView2DownloadStartingEventArgs e) { e.Cancel = true; e.Handled = true; }
    private void RestoreWindowState()
    {
        try {
            var json = _localData?.ReadPreference("yuyin-window-state-v1");
            if (json is null) return;
            using var doc = JsonDocument.Parse(json); var bounds = doc.RootElement.GetProperty("bounds");
            var work = SystemParameters.WorkArea;
            Width = Math.Clamp(bounds.GetProperty("width").GetDouble(), MinWidth, Math.Max(MinWidth, work.Width));
            Height = Math.Clamp(bounds.GetProperty("height").GetDouble(), MinHeight, Math.Max(MinHeight, work.Height));
            Left = Math.Clamp(bounds.GetProperty("x").GetDouble(), work.Left, Math.Max(work.Left, work.Right - Width));
            Top = Math.Clamp(bounds.GetProperty("y").GetDouble(), work.Top, Math.Max(work.Top, work.Bottom - Height));
            if (doc.RootElement.GetProperty("maximized").GetBoolean()) WindowState = WindowState.Maximized;
        } catch (Exception e) { SendEvent("preferences.error", "窗口设置读取失败：" + e.Message); }
    }
    private void SaveWindowState(bool throwOnError = false)
    {
        if (_localData is null) return;
        try {
            var bounds = WindowState == WindowState.Normal ? new Rect(Left, Top, ActualWidth, ActualHeight) : RestoreBounds;
            if (bounds.IsEmpty || bounds.Width <= 0 || bounds.Height <= 0) return;
            _localData.WritePreference("yuyin-window-state-v1", JsonSerializer.Serialize(new {
                version = 1, bounds = new { x = (int)Math.Round(bounds.X), y = (int)Math.Round(bounds.Y), width = (int)Math.Round(bounds.Width), height = (int)Math.Round(bounds.Height) }, maximized = WindowState == WindowState.Maximized
            }));
        } catch (Exception e) { if (throwOnError) throw; Debug.WriteLine("窗口设置保存失败：" + e.Message); }
    }
    private static JsonElement Arg(JsonElement args, int index) => args.ValueKind == JsonValueKind.Array && args.GetArrayLength() > index ? args[index] : throw new InvalidOperationException("参数不完整。");
    private static string ArgString(JsonElement args, int index, string? fallback = null)
    {
        if (args.ValueKind != JsonValueKind.Array || args.GetArrayLength() <= index) return fallback ?? throw new InvalidOperationException("参数不完整。");
        var value = args[index];
        if (value.ValueKind != JsonValueKind.String) throw new InvalidOperationException("字符串参数不合法。");
        return value.GetString() ?? string.Empty;
    }
    private static int ArgInt(JsonElement args, int index, int fallback)
    {
        if (args.ValueKind != JsonValueKind.Array || args.GetArrayLength() <= index) return fallback;
        if (!args[index].TryGetInt32(out var value)) throw new InvalidOperationException("整数参数不合法。");
        return value;
    }
    private static long ArgLong(JsonElement args, int index) => Arg(args, index).TryGetInt64(out var value) ? value : throw new InvalidOperationException("参数不合法。");
    private static bool ArgBool(JsonElement args, int index) => Arg(args, index).ValueKind is JsonValueKind.True or JsonValueKind.False ? Arg(args, index).GetBoolean() : throw new InvalidOperationException("布尔参数不合法。");
    private static double ArgDouble(JsonElement args, int index) => Arg(args, index).TryGetDouble(out var value) && double.IsFinite(value) ? value : throw new InvalidOperationException("参数不合法。");
    private static void Reply(CoreWebView2? core, long id, bool ok, object? value, string? error)
    {
        if (core is null || id <= 0) return;
        try { core.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "response", id, ok, value, error })); }
        catch (ObjectDisposedException) { }
        catch (InvalidOperationException) { /* The WebView may have closed while an async call was completing. */ }
    }
    private void SendEvent(string name, object? value)
    {
        void Send()
        {
            if (_shutdownStarted || _core is null) return;
            try { _core.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "event", name, value })); }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
        }
        if (Dispatcher.CheckAccess()) Send();
        else _ = Dispatcher.BeginInvoke(Send);
    }

    private static void ValidateInvoke(string method, JsonElement args)
    {
        var length = args.GetArrayLength();
        var (minimum, maximum) = method switch
        {
            "music.search" => (1, 3), "music.suggestions" or "music.play" or "music.lyrics" or "music.lyricsCandidates" or "desktopLyrics.settings" or "desktopLyrics.publish" or "desktopLyrics.window.settings" or "library.export" => (1, 1),
            "music.seek" or "music.volume" or "favorites.items" => (1, 2), "favorites.songs" => (1, 1),
            "comments.list" or "comments.replies" => (2, 3), "comments.like" => (4, 4), "comments.create" => (1, 1),
            _ => (0, 0),
        };
        if (length < minimum || length > maximum) throw new InvalidOperationException("原生操作参数数量不合法。");
    }

    private static bool IsAppOrigin(string? value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            && uri.Host.Equals(VirtualHost, StringComparison.OrdinalIgnoreCase)
            && (uri.Port is -1 or 443);
    }

    private static bool IsBilibiliUri(string? value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            && (uri.Host.Equals("bilibili.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".bilibili.com", StringComparison.OrdinalIgnoreCase));
    }
    private static void OpenExternal(string url) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    private void Minimize() => WindowState = WindowState.Minimized;

    private static string? ResolveRendererRoot()
    {
        var configured = Environment.GetEnvironmentVariable(RendererEnvironmentVariable);
        var candidates = new List<string>();
        if (!string.IsNullOrWhiteSpace(configured)) candidates.Add(configured);
        candidates.Add(Path.Combine(Environment.CurrentDirectory, "out", "renderer"));
        candidates.Add(Path.Combine(AppContext.BaseDirectory, "renderer"));
        candidates.Add(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "out", "renderer")));
        return candidates.Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).FirstOrDefault(candidate => File.Exists(Path.Combine(candidate, "index.html")));
    }
    private static string ResolveUserDataDirectory()
    {
        var configured = Environment.GetEnvironmentVariable(UserDataEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(configured)) {
            if (!Path.IsPathFullyQualified(configured)) throw new InvalidOperationException("YUYIN_WEBVIEW2_USER_DATA_DIR 必须是绝对路径。");
            return Path.GetFullPath(configured);
        }
        return Path.Combine(ResolveStateDirectory(), "WebView2");
    }
    private static string ResolveStateDirectory()
    {
        var configured = Environment.GetEnvironmentVariable(StateDirectoryEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            if (!Path.IsPathFullyQualified(configured)) throw new InvalidOperationException("YUYIN_STATE_DIR 必须是绝对路径。");
            return Path.GetFullPath(configured);
        }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YuyinMusic");
    }
}
