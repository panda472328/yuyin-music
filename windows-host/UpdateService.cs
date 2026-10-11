using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Yuyin.WindowsHost;

public sealed record WindowsUpdateArtifact(
    [property: JsonPropertyName("url")] string Url,
    [property: JsonPropertyName("sha256")] string Sha256,
    [property: JsonPropertyName("size")] long Size);

public sealed record WindowsUpdateManifest(
    [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
    [property: JsonPropertyName("platform")] string Platform,
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("artifact")] WindowsUpdateArtifact Artifact,
    [property: JsonPropertyName("releaseNotesUrl")] string ReleaseNotesUrl,
    [property: JsonPropertyName("notes")] string Notes,
    [property: JsonPropertyName("publishedAt")] string PublishedAt);

/// <summary>
/// A cookie-free updater using the public stable contract. Checking is automatic;
/// downloading and installing are explicit calls. The installer callback must go
/// through the main window's normal save-and-close flow.
/// </summary>
public sealed class UpdateService : IDisposable
{
    public const string ManifestUrl = "https://raw.githubusercontent.com/panda472328/yuyin-music/main/updates/stable.json";
    public const string LatestReleaseUrl = "https://github.com/panda472328/yuyin-music/releases/latest";
    public const string InstalledMarkerName = "installed.marker";
    public const string InstalledMarkerContent = "yuyin-webview2-installed-v1";
    public const int ManifestMaxBytes = 64 * 1024;
    public const long MaxUpdateBytes = 500_000_000;
    private readonly object _sync = new();
    private readonly HttpClient _http;
    private readonly string _cacheDirectory;
    private readonly Func<string, WindowsUpdateManifest, Task> _install;
    private readonly CancellationTokenSource _lifetime = new();
    private CancellationTokenSource? _controller;
    private Timer? _timer;
    private Task<UpdateState>? _operation;
    private string? _downloadedFile;
    private bool _disposed;
    private UpdateState _state;

    public event Action<UpdateState>? StateChanged;

    public UpdateService(string cacheDirectory, Func<string, WindowsUpdateManifest, Task> install,
        string? currentVersion = null, bool? canInstall = null, HttpMessageHandler? httpHandler = null)
    {
        if (!Path.IsPathFullyQualified(cacheDirectory)) throw new ArgumentException("更新缓存目录必须是绝对路径。", nameof(cacheDirectory));
        var version = currentVersion ?? CurrentAssemblyVersion();
        if (!IsStableVersion(version)) throw new InvalidOperationException("更新版本号格式不正确。");
        var installed = canInstall ?? IsInstalledBuild(AppContext.BaseDirectory);
        _cacheDirectory = Path.GetFullPath(cacheDirectory);
        _install = install ?? throw new ArgumentNullException(nameof(install));
        _state = new("idle", version, null, null, null, null, installed,
            installed ? null : "此构建不支持应用内安装更新，请从 GitHub Releases 下载 Windows 安装版。");
        _http = new HttpClient(httpHandler ?? new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.None,
        }, disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan };
    }

    public UpdateState State { get { lock (_sync) return _state; } }
    public string ReleaseUrl => State.Manifest is WindowsUpdateManifest manifest ? manifest.ReleaseNotesUrl : LatestReleaseUrl;

    public void Start()
    {
        lock (_sync)
        {
            if (_disposed || _timer is not null) return;
            _timer = new Timer(_ =>
            {
                lock (_sync) { if (_disposed || _operation is not null || _state.Status is "downloaded" or "installing") return; }
                _ = CheckAsync();
            }, null, TimeSpan.FromHours(6), TimeSpan.FromHours(6));
        }
        _ = CheckAsync();
    }

    public Task<UpdateState> CheckAsync() => RunAsync(async token =>
    {
        Publish(state => state with { Status = "checking", Error = null });
        using var response = await RequestAsync(new Uri(ManifestUrl), true, token);
        if (response.Content.Headers.ContentLength > ManifestMaxBytes) throw Failure("更新清单过大。");
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        using var text = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var read = await ReadAsync(stream, buffer, token);
            if (read == 0) break;
            if (text.Length + read > ManifestMaxBytes) throw Failure("更新清单过大。");
            text.Write(buffer, 0, read);
        }
        var manifest = ParseManifest(Encoding.UTF8.GetString(text.GetBuffer(), 0, checked((int)text.Length)));
        token.ThrowIfCancellationRequested();
        var state = State;
        var checkedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
        if (CompareVersions(manifest.Version, state.CurrentVersion) <= 0)
        {
            lock (_sync) _downloadedFile = null;
            Publish(value => value with { Status = "up-to-date", Manifest = null, Progress = null, CheckedAt = checkedAt });
            return;
        }
        var file = FileFor(manifest);
        var downloaded = state.CanInstall && await VerifyUpdateFileAsync(file, manifest, token);
        token.ThrowIfCancellationRequested();
        lock (_sync) _downloadedFile = downloaded ? file : null;
        Publish(value => value with { Status = downloaded ? "downloaded" : "available", Manifest = manifest, Progress = downloaded ? 100 : null, CheckedAt = checkedAt });
    }, TimeSpan.FromSeconds(30));

    public Task<UpdateState> DownloadAsync() => RunAsync(async token =>
    {
        var state = State;
        RequireInstallable(state);
        var manifest = state.Manifest as WindowsUpdateManifest;
        if (manifest is null || CompareVersions(manifest.Version, state.CurrentVersion) <= 0) throw Failure("请先检查是否有新版本。");
        var destination = FileFor(manifest);
        if (await VerifyUpdateFileAsync(destination, manifest, token))
        {
            lock (_sync) _downloadedFile = destination;
            Publish(value => value with { Status = "downloaded", Progress = 100, Error = null });
            return;
        }
        lock (_sync) _downloadedFile = null;
        Publish(value => value with { Status = "downloading", Progress = 0, Error = null });
        Directory.CreateDirectory(_cacheDirectory);
        RequireRegularDirectory(_cacheDirectory);
        var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".part";
        try
        {
            await using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                using var response = await RequestAsync(new Uri(manifest.Artifact.Url), false, token);
                var length = response.Content.Headers.ContentLength;
                if (length is not null && length != manifest.Artifact.Size) throw Failure("安装包大小与更新清单不一致。");
                await using var body = await response.Content.ReadAsStreamAsync(token);
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var bytes = 0L;
                var previousProgress = -1;
                var buffer = new byte[81920];
                while (true)
                {
                    var read = await ReadAsync(body, buffer, token);
                    if (read == 0) break;
                    bytes += read;
                    if (bytes > manifest.Artifact.Size) throw Failure("安装包超过预期大小。");
                    hash.AppendData(buffer, 0, read);
                    await file.WriteAsync(buffer.AsMemory(0, read), token);
                    var progress = (int)(bytes * 100 / manifest.Artifact.Size);
                    if (progress != previousProgress)
                    {
                        previousProgress = progress;
                        Publish(value => value with { Progress = progress });
                    }
                }
                var digest = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
                if (bytes != manifest.Artifact.Size || digest != manifest.Artifact.Sha256) throw Failure("安装包校验失败，请重新下载。");
                await file.FlushAsync(token);
                file.Flush(flushToDisk: true);
            }
            token.ThrowIfCancellationRequested();
            RequireRegularDirectory(_cacheDirectory);
            if (File.Exists(destination) && (File.GetAttributes(destination) & FileAttributes.ReparsePoint) != 0) throw Failure("更新缓存文件不合法。");
            File.Move(temporary, destination, overwrite: true);
            lock (_sync) _downloadedFile = destination;
            Publish(value => value with { Status = "downloaded", Progress = 100, Error = null });
        }
        finally
        {
            // Only this operation's own, randomly named partial file is removed.
            try { File.Delete(temporary); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }, TimeSpan.FromMinutes(15));

    public Task<UpdateState> InstallAsync() => RunAsync(async token =>
    {
        var state = State;
        RequireInstallable(state);
        var manifest = state.Manifest as WindowsUpdateManifest;
        string? file;
        lock (_sync) file = _downloadedFile;
        if (manifest is null || file is null || !await VerifyUpdateFileAsync(file, manifest, token))
        {
            lock (_sync) _downloadedFile = null;
            throw Failure("安装包尚未下载或校验失败，请重新下载。");
        }
        token.ThrowIfCancellationRequested();
        Publish(value => value with { Status = "installing", Error = null });
        await _install(file, manifest);
    }, TimeSpan.FromMinutes(15));

    public void ReportInstallationFailure(Exception error) => Publish(state => state with { Status = "error", Error = ErrorMessage(error) });

    private Task<UpdateState> RunAsync(Func<CancellationToken, Task> action, TimeSpan timeout)
    {
        TaskCompletionSource<UpdateState> completion;
        CancellationTokenSource controller;
        lock (_sync)
        {
            if (_operation is not null) return _operation;
            if (_disposed || _state.Status == "installing") return Task.FromResult(_state);
            controller = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
            controller.CancelAfter(timeout);
            _controller = controller;
            completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
            _operation = completion.Task;
        }
        _ = ExecuteOperationAsync(action, controller, completion);
        return completion.Task;
    }

    private async Task ExecuteOperationAsync(Func<CancellationToken, Task> action, CancellationTokenSource controller, TaskCompletionSource<UpdateState> completion)
    {
        try { await action(controller.Token); }
        catch (Exception error)
        {
            Publish(state => state with { Status = "error", Progress = null, Error = controller.IsCancellationRequested ? "更新请求超时，请稍后重试。" : ErrorMessage(error) });
        }
        finally
        {
            UpdateState state;
            lock (_sync)
            {
                if (_operation == completion.Task) _operation = null;
                if (_controller == controller) _controller = null;
                state = _state;
            }
            controller.Dispose();
            completion.TrySetResult(state);
        }
    }

    private void Publish(Func<UpdateState, UpdateState> update)
    {
        UpdateState state;
        Action<UpdateState>? listeners;
        lock (_sync)
        {
            if (_disposed) return;
            _state = update(_state);
            state = _state;
            listeners = StateChanged;
        }
        if (listeners is null) return;
        foreach (Action<UpdateState> listener in listeners.GetInvocationList())
        {
            try { listener(state); }
            catch { /* Observers must not interrupt a verified download or cleanup. */ }
        }
    }

    private async Task<HttpResponseMessage> RequestAsync(Uri initial, bool manifest, CancellationToken token)
    {
        var uri = initial;
        for (var redirects = 0; redirects <= 5; redirects++)
        {
            if (!IsTrustedAddress(uri, manifest)) throw Failure("更新地址不受信任。");
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.UserAgent.ParseAdd("Yuyin-Update/2");
            request.Headers.Accept.ParseAdd(manifest ? "application/json" : "application/octet-stream");
            request.Headers.AcceptEncoding.ParseAdd("identity");
            request.Headers.CacheControl = new() { NoCache = true };
            using var headerTimeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            headerTimeout.CancelAfter(TimeSpan.FromSeconds(30));
            var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, headerTimeout.Token);
            if (response.StatusCode is HttpStatusCode.MovedPermanently or HttpStatusCode.Found or HttpStatusCode.SeeOther or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect)
            {
                var location = response.Headers.Location;
                response.Dispose();
                if (location is null || redirects == 5) throw Failure("更新下载重定向异常。");
                uri = location.IsAbsoluteUri ? location : new Uri(uri, location);
                continue;
            }
            if (response.StatusCode != HttpStatusCode.OK)
            {
                var notFound = response.StatusCode == HttpStatusCode.NotFound;
                response.Dispose();
                throw Failure(notFound ? "暂时没有可用的更新清单或安装包。" : "GitHub 更新服务暂时不可用，请稍后重试。");
            }
            if (response.Content.Headers.ContentEncoding.Any(encoding => !encoding.Equals("identity", StringComparison.OrdinalIgnoreCase)))
            {
                response.Dispose();
                throw Failure("更新服务返回的文件编码异常。");
            }
            return response;
        }
        throw Failure("更新下载重定向异常。");
    }

    private static async Task<int> ReadAsync(Stream stream, byte[] buffer, CancellationToken token)
        => await stream.ReadAsync(buffer.AsMemory(), token).AsTask().WaitAsync(TimeSpan.FromSeconds(30), token);
    private string FileFor(WindowsUpdateManifest manifest) => Path.Combine(_cacheDirectory, $"{manifest.Artifact.Sha256}-Yuyin-{manifest.Version}-Setup.exe");
    private static void RequireInstallable(UpdateState state) { if (!state.CanInstall) throw Failure(state.InstallDisabledReason ?? "此构建不支持应用内安装更新。"); }
    private static void RequireRegularDirectory(string path) { if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw Failure("更新缓存目录不合法。"); }
    private static InvalidOperationException Failure(string message) => new(message);
    private static string ErrorMessage(Exception error) => error switch
    {
        InvalidOperationException => error.Message,
        UnauthorizedAccessException => "无法写入更新缓存，请检查目录权限后重试。",
        IOException => "更新文件读写失败，请稍后重试。",
        TimeoutException or OperationCanceledException => "更新网络请求超时，请稍后重试。",
        HttpRequestException => "GitHub 更新服务暂时无法连接，请稍后重试。",
        _ => "更新操作失败，请稍后重试。",
    };

    public static string CurrentAssemblyVersion()
    {
        var assembly = typeof(UpdateService).Assembly;
        var informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0];
        if (IsStableVersion(informational)) return informational!;
        var version = assembly.GetName().Version;
        return version is null ? "0.0.0" : $"{version.Major}.{version.Minor}.{Math.Max(0, version.Build)}";
    }

    public static bool IsInstalledBuild(string directory)
    {
        try
        {
            var marker = new FileInfo(Path.Combine(directory, InstalledMarkerName));
            return marker.Exists && marker.Length < 1024 && (marker.Attributes & FileAttributes.ReparsePoint) == 0
                && File.ReadAllText(marker.FullName).Trim() == InstalledMarkerContent;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    public static bool IsStableVersion(string? version) => version is not null && Regex.IsMatch(version, @"^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\z", RegexOptions.CultureInvariant);
    public static int CompareVersions(string left, string right)
    {
        if (!IsStableVersion(left) || !IsStableVersion(right)) throw Failure("更新版本号格式不正确。");
        var a = left.Split('.').Select(int.Parse).ToArray();
        var b = right.Split('.').Select(int.Parse).ToArray();
        for (var i = 0; i < 3; i++) if (a[i] != b[i]) return a[i] > b[i] ? 1 : -1;
        return 0;
    }

    public static string ArtifactUrl(string version) => $"https://github.com/panda472328/yuyin-music/releases/download/pc-v{version}/Yuyin-{version}-Setup.exe";
    public static string ReleaseNotesUrl(string version) => $"https://github.com/panda472328/yuyin-music/releases/tag/pc-v{version}";

    public static WindowsUpdateManifest ParseManifest(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
            var root = document.RootElement;
            static string Text(JsonElement value, string key) => value.GetProperty(key).GetString() ?? throw Failure("更新清单不合法，请稍后重试。");
            if (root.ValueKind != JsonValueKind.Object || !root.GetProperty("schemaVersion").TryGetInt32(out var schema) || schema != 1 || Text(root, "platform") != "windows" || root.TryGetProperty("versionCode", out _)) throw Failure("更新清单不合法，请稍后重试。");
            var version = Text(root, "version");
            var artifact = root.GetProperty("artifact");
            var url = Text(artifact, "url");
            var sha256 = Text(artifact, "sha256");
            var notesUrl = Text(root, "releaseNotesUrl");
            var notes = Text(root, "notes");
            var publishedAt = Text(root, "publishedAt");
            if (!IsStableVersion(version) || url != ArtifactUrl(version) || notesUrl != ReleaseNotesUrl(version)
                || !Regex.IsMatch(sha256, @"^[a-f0-9]{64}\z", RegexOptions.CultureInvariant)
                || !artifact.GetProperty("size").TryGetInt64(out var size) || size < 1 || size > MaxUpdateBytes
                || notes.Length > 8000 || !DateTime.TryParseExact(publishedAt, ["yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ss.fff'Z'"], CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out _))
                throw Failure("更新清单不合法，请稍后重试。");
            return new(1, "windows", version, new(url, sha256, size), notesUrl, notes, publishedAt);
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            throw Failure("更新清单不合法，请稍后重试。");
        }
    }

    public static bool IsTrustedAddress(Uri uri, bool manifest)
    {
        if (!uri.IsAbsoluteUri || uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Fragment)) return false;
        if (manifest) return uri.AbsoluteUri == ManifestUrl;
        if (uri.Host == "github.com") return uri.AbsolutePath.StartsWith("/panda472328/yuyin-music/releases/download/", StringComparison.Ordinal) && string.IsNullOrEmpty(uri.Query);
        return uri.Host is "release-assets.githubusercontent.com" or "objects.githubusercontent.com";
    }

    public static async Task<bool> VerifyUpdateFileAsync(string file, WindowsUpdateManifest manifest, CancellationToken token = default)
    {
        try
        {
            var info = new FileInfo(file);
            if (!info.Exists || info.Length != manifest.Artifact.Size || (info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return false;
            await using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, FileOptions.Asynchronous | FileOptions.SequentialScan);
            if (stream.Length != manifest.Artifact.Size) return false;
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var bytes = 0L;
            var buffer = new byte[81920];
            while (true)
            {
                var read = await stream.ReadAsync(buffer, token);
                if (read == 0) break;
                bytes += read;
                if (bytes > manifest.Artifact.Size) return false;
                hash.AppendData(buffer, 0, read);
            }
            return bytes == manifest.Artifact.Size && Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant() == manifest.Artifact.Sha256;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    /// <summary>Builds a launcher only; calling this does not start or install anything.</summary>
    public static ProcessStartInfo CreateInstallerStartInfo(string file, int hostProcessId, bool silent = false)
    {
        if (!Path.IsPathFullyQualified(file) || !file.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || hostProcessId <= 0) throw Failure("更新安装路径不合法。");
        var start = new ProcessStartInfo(file) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(file)! };
        start.ArgumentList.Add($"/YUYINPID={hostProcessId}");
        if (silent) start.ArgumentList.Add("/S");
        return start;
    }

    public void Dispose()
    {
        lock (_sync)
        {
            if (_disposed) return;
            _disposed = true;
            _timer?.Dispose();
            _timer = null;
            _lifetime.Cancel();
            _controller?.Cancel();
            StateChanged = null;
        }
        _http.Dispose();
        _lifetime.Dispose();
    }
}
