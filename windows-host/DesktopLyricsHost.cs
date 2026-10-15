using System.Runtime.InteropServices;
using System.Text.Json;
using System.IO;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Yuyin.WindowsHost;

/// Keeps the desktop lyrics renderer independent from the main renderer. State
/// is stored outside the WebView2 profile so clearing browser data does not
/// reset the user's window position or style.
public sealed class DesktopLyricsHost : IAsyncDisposable
{
    private const double Width = 900;
    private const double Height = 200;
    private readonly CoreWebView2Environment _environment;
    private readonly Dispatcher _dispatcher;
    private readonly string _rendererRoot;
    private readonly DesktopSettingsStore _settingsStore;
    private readonly object _gate = new();
    private readonly object _saveGate = new();
    private readonly SemaphoreSlim _mutationGate = new(1, 1);
    private DesktopLyricsSettings _settings = new();
    private DesktopLyricsContent _content = new(null, "", "", "", "idle", false);
    private string? _error;
    private Window? _window;
    private WebView2CompositionControl? _view;
    private CoreWebView2? _core;
    private DesktopLyricsDragRegions? _dragRegions;
    private double? _left;
    private double? _top;
    private Task? _ensureTask;
    private DispatcherTimer? _saveTimer;
    private DispatcherTimer? _pointerTimer;
    private bool _pointerInside;
    private bool _disposed;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point32 { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect32 { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo { public int Size; public Rect32 Monitor; public Rect32 Work; public uint Flags; }

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out Point32 point);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Rect32 rectangle);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    public event Action<DesktopLyricsSnapshot>? SnapshotChanged;

    public DesktopLyricsHost(CoreWebView2Environment environment, Dispatcher dispatcher, string rendererRoot, string stateDirectory)
    {
        _environment = environment;
        _dispatcher = dispatcher;
        _rendererRoot = rendererRoot;
        Directory.CreateDirectory(stateDirectory);
        _settingsStore = new DesktopSettingsStore(stateDirectory);
        Load();
    }

    public DesktopLyricsSnapshot Snapshot
    {
        get { lock (_gate) return new DesktopLyricsSnapshot(_settings, _content, _error); }
    }

    public Task StartIfEnabledAsync() => Snapshot.Settings.Enabled ? EnsureWindowAsync() : Task.CompletedTask;

    public async Task<DesktopLyricsSnapshot> UpdateSettingsAsync(JsonElement patch)
    {
        if (patch.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("桌面歌词设置不合法。");
        await _mutationGate.WaitAsync();
        try
        {
        if (_disposed) throw new InvalidOperationException("桌面歌词已退出。");
        var current = Snapshot.Settings;
        var updated = new DesktopLyricsSettings(
            patch.TryGetProperty("enabled", out var enabled) ? enabled.GetBoolean() : current.Enabled,
            patch.TryGetProperty("locked", out var locked) ? locked.GetBoolean() : current.Locked,
            patch.TryGetProperty("font", out var font) ? ValidateFont(font.GetString()) : current.Font,
            patch.TryGetProperty("fontSize", out var fontSize) ? ValidateRange(fontSize.GetDouble(), 24, 56, "字号") : current.FontSize,
            patch.TryGetProperty("color", out var color) ? ValidateColor(color.GetString()) : current.Color,
            patch.TryGetProperty("opacity", out var opacity) ? ValidateRange(opacity.GetDouble(), .3, 1, "透明度") : current.Opacity,
            patch.TryGetProperty("style", out var style) ? LyricStyles.Validate(style.GetString()) : current.Style);
        lock (_gate) _settings = updated;
        Save();
        if (updated.Enabled) await EnsureWindowAsync();
        else
        {
            var creating = _ensureTask;
            if (creating is not null) await creating;
            await CloseWindowAsync();
        }
        PublishSnapshot();
        return Snapshot;
        }
        finally { _mutationGate.Release(); }
    }

    public void Publish(DesktopLyricsContent content)
    {
        if (_disposed || content.Title is null || content.Current is null || content.Next is null) return;
        if (content.Bvid is not null && !System.Text.RegularExpressions.Regex.IsMatch(content.Bvid, "^BV[0-9A-Za-z]{10}$")) return;
        if (content.Title.Length > 500 || content.Current.Length > 1000 || content.Next.Length > 1000) return;
        if (content.Phase is not ("idle" or "loading" or "ready" or "empty" or "error")) return;
        lock (_gate)
        {
            // Ignore a late renderer update after a new song has started.
            if (_content.Bvid is not null && content.Bvid is not null && _content.Bvid != content.Bvid && content.Phase != "loading") return;
            _content = content;
        }
        PublishSnapshot();
    }

    public async Task HandleOverlayMessageAsync(CoreWebView2WebMessageReceivedEventArgs args, CoreWebView2 sourceCore)
    {
        if (_disposed || !ReferenceEquals(sourceCore, _core) || !IsOverlaySource(args.Source) || args.WebMessageAsJson.Length > 16 * 1024) return;
        using var document = JsonDocument.Parse(args.WebMessageAsJson);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var type) || type.GetString() != "invoke") return;
        var method = root.TryGetProperty("method", out var methodValue) ? methodValue.GetString() : null;
        var id = root.TryGetProperty("id", out var idValue) && idValue.TryGetInt64(out var parsedId) ? parsedId : 0;
        if (id < 0 || id > 9_007_199_254_740_991) return;
        try
        {
            var value = method switch
            {
                "desktopLyrics.window.get" => Snapshot,
                "desktopLyrics.window.settings" => await UpdateSettingsAsync(FirstArg(root)),
                "desktopLyrics.window.dragRegions" => SetDragRegions(FirstArg(root)),
                "desktopLyrics.window.close" => await UpdateSettingsAsync(JsonDocument.Parse("{\"enabled\":false}").RootElement.Clone()),
                _ => throw new InvalidOperationException("桌面歌词操作不支持。"),
            };
            if (id > 0) Reply(sourceCore, id, true, value, null);
        }
        catch (Exception error) { if (id > 0) Reply(sourceCore, id, false, null, error.Message); }
    }

    private object? SetDragRegions(JsonElement value)
    {
        var regions = DesktopLyricsDragRegions.Parse(value);
        lock (_gate) _dragRegions = regions;
        return null;
    }

    private void OverlayPreviewMouseLeftButtonDown(object sender, System.Windows.Input.MouseButtonEventArgs args)
    {
        if (_disposed || args.ChangedButton != System.Windows.Input.MouseButton.Left || Snapshot.Settings.Locked || _window is null || !_window.IsVisible || _view is null) return;
        var regions = _dragRegions;
        if (regions is null) return;
        var point = args.GetPosition(_view);
        if (!regions.IsWindowDragTarget(point.X, point.Y, _view.ActualWidth, _view.ActualHeight, Snapshot.Settings.Locked)) return;
        args.Handled = true;
        try { _window.DragMove(); KeepInWorkArea(); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }

    private Task EnsureWindowAsync()
    {
        lock (_gate)
        {
            if (_disposed || (_window is not null && _core is not null)) return Task.CompletedTask;
            if (_ensureTask is not null) return _ensureTask;
            _ensureTask = EnsureWindowCoreAsync();
            return _ensureTask;
        }
    }

    private async Task EnsureWindowCoreAsync()
    {
        try
        {
        await _dispatcher.InvokeAsync(() =>
        {
            if (_disposed || _window is not null) return;
            _window = new Window
            {
                Width = Width, Height = Height, Left = _left ?? 200, Top = _top ?? 200,
                WindowStyle = WindowStyle.None, ResizeMode = ResizeMode.NoResize,
                // Alpha-zero pixels on layered windows are click-through.
                // A single alpha step preserves the transparent appearance
                // while blank space remains a native pointer/drag target.
                AllowsTransparency = true, Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromArgb(1, 0, 0, 0)),
                Topmost = true, ShowInTaskbar = false, ShowActivated = false, Title = "open音乐 · 桌面歌词",
            };
            // The HWND-backed WebView2 cannot paint into WPF's layered,
            // transparent window. Composition hosting keeps alpha and native
            // pointer input in the WPF visual tree.
            _view = new WebView2CompositionControl
            {
                Width = Width,
                Height = Height,
                DefaultBackgroundColor = System.Drawing.Color.FromArgb(0, 0, 0, 0),
            };
            _window.Content = _view;
            _window.PreviewMouseLeftButtonDown += OverlayPreviewMouseLeftButtonDown;
            _window.LocationChanged += OverlayWindow_LocationChanged;
            _window.Closed += OverlayWindow_Closed;
            _window.Show();
            KeepInWorkArea();
        });
        var view = _view ?? throw new InvalidOperationException("桌面歌词窗口初始化失败。");
        var initialize = _dispatcher.InvokeAsync(() => view.EnsureCoreWebView2Async(_environment));
        await initialize.Task.Unwrap();
        await _dispatcher.InvokeAsync(() =>
        {
            if (_disposed || !ReferenceEquals(view, _view)) return;
            var core = view.CoreWebView2 ?? throw new InvalidOperationException("桌面歌词 WebView2 初始化失败。");
            _core = core;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.SetVirtualHostNameToFolderMapping("appassets.yuyin.local", _rendererRoot, CoreWebView2HostResourceAccessKind.DenyCors);
            if (_disposed || !ReferenceEquals(view, _view)) return;
            core.WebMessageReceived += OverlayWebMessageReceived;
            core.NavigationStarting += OverlayNavigationStarting;
            core.NewWindowRequested += OverlayNewWindowRequested;
            core.Navigate("https://appassets.yuyin.local/desktop-lyrics.html");
        }).Task;
        await _dispatcher.InvokeAsync(() =>
        {
            if (_disposed || !ReferenceEquals(view, _view)) return;
            StartPointerTracking();
            PublishSnapshot();
        });
        }
        finally { lock (_gate) _ensureTask = null; }
    }

    private async Task CloseWindowAsync()
    {
        await _dispatcher.InvokeAsync(() =>
        {
            if (_window is null) return;
            _left = _window.Left; _top = _window.Top;
            DetachCore();
            _window.Close(); _window = null; _view = null;
            StopPointerTracking();
            _saveTimer?.Stop();
        });
        Save();
    }

    private async void OverlayWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (sender is not CoreWebView2 core) return;
        try { await HandleOverlayMessageAsync(args, core); }
        catch { /* Invalid or late messages must not escape an async event handler. */ }
    }

    private static void OverlayNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs args)
    {
        if (!IsOverlaySource(args.Uri)) args.Cancel = true;
    }

    private static void OverlayNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs args) => args.Handled = true;

    private void DetachCore()
    {
        var core = _core;
        if (core is null) return;
        core.WebMessageReceived -= OverlayWebMessageReceived;
        core.NavigationStarting -= OverlayNavigationStarting;
        core.NewWindowRequested -= OverlayNewWindowRequested;
        _core = null;
    }

    private void OverlayWindow_LocationChanged(object? sender, EventArgs args)
    {
        if (_disposed || sender is not Window window || !ReferenceEquals(window, _window)) return;
        lock (_gate) { _left = window.Left; _top = window.Top; }
        _saveTimer ??= new DispatcherTimer(DispatcherPriority.Background, _dispatcher) { Interval = TimeSpan.FromMilliseconds(250) };
        _saveTimer.Stop();
        _saveTimer.Tick -= SaveTimer_Tick;
        _saveTimer.Tick += SaveTimer_Tick;
        _saveTimer.Start();
        UpdatePointerPresence();
    }

    private void KeepInWorkArea()
    {
        if (_window is null || !_window.IsVisible) return;
        var handle = new WindowInteropHelper(_window).Handle;
        if (handle == IntPtr.Zero || !GetWindowRect(handle, out var bounds)) return;
        var monitor = MonitorFromWindow(handle, 2); // MONITOR_DEFAULTTONEAREST
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return;
        var width = bounds.Right - bounds.Left;
        var height = bounds.Bottom - bounds.Top;
        var left = Math.Clamp(bounds.Left, info.Work.Left, Math.Max(info.Work.Left, info.Work.Right - width));
        var top = Math.Clamp(bounds.Top, info.Work.Top, Math.Max(info.Work.Top, info.Work.Bottom - height));
        if (left != bounds.Left || top != bounds.Top)
            SetWindowPos(handle, IntPtr.Zero, left, top, 0, 0, 0x0015); // NOSIZE | NOZORDER | NOACTIVATE
    }

    private void SaveTimer_Tick(object? sender, EventArgs args)
    {
        _saveTimer?.Stop();
        Save();
        PublishSnapshot();
    }

    private void OverlayWindow_Closed(object? sender, EventArgs args)
    {
        if (sender is not Window window || !ReferenceEquals(window, _window)) return;
        lock (_gate) { _left = window.Left; _top = window.Top; }
        StopPointerTracking();
        _saveTimer?.Stop();
        DetachCore();
        window.LocationChanged -= OverlayWindow_LocationChanged;
        window.Closed -= OverlayWindow_Closed;
        window.PreviewMouseLeftButtonDown -= OverlayPreviewMouseLeftButtonDown;
        _view?.Dispose();
        _view = null; _window = null;
        lock (_gate) _dragRegions = null;
        if (!_disposed && Snapshot.Settings.Enabled)
        {
            lock (_gate) _settings = _settings with { Enabled = false };
        }
        Save();
        if (!_disposed) PublishSnapshot();
    }

    private void StartPointerTracking()
    {
        StopPointerTracking();
        _pointerTimer = new DispatcherTimer(DispatcherPriority.Input, _dispatcher) { Interval = TimeSpan.FromMilliseconds(100) };
        _pointerTimer.Tick += PointerTimer_Tick;
        _pointerTimer.Start();
        UpdatePointerPresence();
    }

    private void PointerTimer_Tick(object? sender, EventArgs args) => UpdatePointerPresence();

    private void StopPointerTracking()
    {
        if (_pointerTimer is not null)
        {
            _pointerTimer.Stop();
            _pointerTimer.Tick -= PointerTimer_Tick;
            _pointerTimer = null;
        }
        _pointerInside = false;
    }

    private void UpdatePointerPresence()
    {
        if (_disposed || _window is null || !_window.IsVisible || !GetCursorPos(out var cursor)) return;
        bool inside;
        try
        {
            var origin = _window.PointToScreen(new Point(0, 0));
            var end = _window.PointToScreen(new Point(Math.Max(1, _window.ActualWidth), Math.Max(1, _window.ActualHeight)));
            inside = cursor.X >= origin.X && cursor.X < end.X && cursor.Y >= origin.Y && cursor.Y < end.Y;
        }
        catch { return; }
        if (!inside && inside == _pointerInside) return;
        _pointerInside = inside;
        if (_core is not null) SendEvent(_core, "desktopLyrics.window.pointer", inside);
    }

    private static bool IsOverlaySource(string source) =>
        Uri.TryCreate(source, UriKind.Absolute, out var uri) &&
        uri.Scheme == Uri.UriSchemeHttps && uri.Host.Equals("appassets.yuyin.local", StringComparison.OrdinalIgnoreCase) &&
        uri.IsDefaultPort && string.IsNullOrEmpty(uri.UserInfo) && uri.AbsolutePath == "/desktop-lyrics.html";

    private void PublishSnapshot()
    {
        if (_disposed) return;
        if (!_dispatcher.CheckAccess())
        {
            _dispatcher.BeginInvoke((Action)PublishSnapshot);
            return;
        }
        var snapshot = Snapshot;
        SnapshotChanged?.Invoke(snapshot);
        if (_core is not null) SendEvent(_core, "desktopLyrics.window.snapshot", snapshot);
    }

    private void Load()
    {
        try
        {
            var stored = _settingsStore.Read();
            if (stored is null) return;
            _settings = stored.Settings; _left = stored.Left; _top = stored.Top;
        }
        catch (Exception error) { _error = $"读取桌面歌词设置失败：{error.Message}"; }
    }

    private void Save()
    {
        try
        {
            lock (_saveGate)
            {
                DesktopLyricsStoredState stored;
                lock (_gate) stored = new DesktopLyricsStoredState(_settings, _left, _top);
                _settingsStore.Save(stored);
                lock (_gate) _error = null;
            }
        }
        catch (Exception error) { lock (_gate) _error = $"保存桌面歌词设置失败：{error.Message}"; }
    }

    private static JsonElement FirstArg(JsonElement root) => root.TryGetProperty("args", out var args) && args.ValueKind == JsonValueKind.Array && args.GetArrayLength() > 0 ? args[0] : JsonDocument.Parse("{}").RootElement.Clone();
    private static string ValidateFont(string? value) => value is "sans" or "serif" or "kai" or "rounded" ? value : throw new InvalidOperationException("桌面歌词字体不合法。");
    private static string ValidateColor(string? value) => value is "white" or "mint" or "gold" ? value : throw new InvalidOperationException("桌面歌词颜色不合法。");
    private static double ValidateRange(double value, double min, double max, string name) => double.IsFinite(value) && value >= min && value <= max ? value : throw new InvalidOperationException($"桌面歌词{name}不合法。");
    private static void Reply(CoreWebView2? core, long id, bool ok, object? value, string? error) { if (core is null) return; try { core.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "response", id, ok, value, error })); } catch { } }
    private static void SendEvent(CoreWebView2 core, string name, object value) { try { core.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "event", name, value })); } catch { } }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        await _mutationGate.WaitAsync();
        try
        {
        var creating = _ensureTask;
        if (creating is not null) { try { await creating; } catch { } }
        await _dispatcher.InvokeAsync(() =>
        {
            _saveTimer?.Stop();
            StopPointerTracking();
            DetachCore();
            _window?.Close();
            _window = null; _view = null;
        });
        Save();
        }
        finally { _mutationGate.Release(); }
    }
}
