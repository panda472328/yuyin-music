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

public sealed record WindowsUpdateSource(
    [property: JsonPropertyName("releaseId")] int ReleaseId,
    [property: JsonPropertyName("attachmentId")] int AttachmentId,
    [property: JsonPropertyName("filename")] string Filename);

public sealed record WindowsUpdateManifest(
    [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
    [property: JsonPropertyName("platform")] string Platform,
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("artifact")] WindowsUpdateArtifact Artifact,
    [property: JsonPropertyName("releaseNotesUrl")] string ReleaseNotesUrl,
    [property: JsonPropertyName("notes")] string Notes,
    [property: JsonPropertyName("publishedAt")] string PublishedAt,
    [property: JsonPropertyName("provider"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Provider = null,
    [property: JsonPropertyName("source"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] WindowsUpdateSource? Source = null);

/// <summary>
/// A cookie-free updater using the public stable contract. Checking is automatic;
/// downloading and installing are explicit calls. The installer callback must go
/// through the main window's normal save-and-close flow.
/// </summary>
public sealed class UpdateService : IDisposable
{
    public const string ManifestUrl = "https://raw.githubusercontent.com/panda472328/yuyin-music/main/updates/stable.json";
    public const string DomesticManifestUrl = "https://gitee.com/api/v5/repos/openmusic/openmusic/contents/updates/domestic.json?ref=main";
    public const string LatestReleaseUrl = "https://github.com/panda472328/yuyin-music/releases/latest";
    public const string InstalledMarkerName = "installed.marker";
    public const string InstalledMarkerContent = "yuyin-webview2-installed-v1";
    public const int ManifestMaxBytes = 64 * 1024;
    public const int DomesticContentsMaxBytes = 128 * 1024;
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
    private WindowsUpdateManifest? _highestManifest;
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
        // Independent source budgets ensure an unavailable domestic endpoint cannot
        // consume the entire check timeout before GitHub is attempted.
        var sources = await Task.WhenAll(ReadSourceAsync(DomesticManifestUrl, token), ReadSourceAsync(ManifestUrl, token));
        token.ThrowIfCancellationRequested();
        var manifests = sources.Where(result => result.Manifest is not null).Select(result => result.Manifest!).ToArray();
        if (manifests.Length == 0) throw Failure(sources.Last().Error ?? "更新服务暂时不可用，请稍后重试。");
        var manifest = manifests.Aggregate((preferred, candidate) => CompareVersions(candidate.Version, preferred.Version) > 0 ? candidate : preferred);
        foreach (var other in manifests.Where(value => value.Version == manifest.Version)) RequireSameBytes(manifest, other);
        WindowsUpdateManifest? highest;
        lock (_sync) highest = _highestManifest;
        if (highest is not null)
        {
            var comparison = CompareVersions(manifest.Version, highest.Version);
            if (comparison < 0) manifest = highest; // Retain the newer verified offer rather than regress during mirror lag.
            else if (comparison == 0) RequireSameBytes(manifest, highest);
        }
        lock (_sync) _highestManifest = manifest;
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

    private async Task<(WindowsUpdateManifest? Manifest, string? Error)> ReadSourceAsync(string url, CancellationToken token)
    {
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(TimeSpan.FromSeconds(12));
        try { return (await ReadManifestAsync(url, budget.Token), null); }
        catch (Exception error) when (!token.IsCancellationRequested && error is HttpRequestException or InvalidOperationException or IOException or OperationCanceledException or TimeoutException)
        { return (null, ErrorMessage(error)); }
    }

    private async Task<WindowsUpdateManifest> ReadManifestAsync(string url, CancellationToken token)
    {
        using var response = await RequestAsync(new Uri(url), true, token);
        var domestic = url == DomesticManifestUrl;
        var maximum = domestic ? DomesticContentsMaxBytes : ManifestMaxBytes;
        if (response.Content.Headers.ContentLength > maximum) throw Failure("更新清单过大。");
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        using var text = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var read = await ReadAsync(stream, buffer, token);
            if (read == 0) break;
            if (text.Length + read > maximum) throw Failure("更新清单过大。");
            text.Write(buffer, 0, read);
        }
        var json = Encoding.UTF8.GetString(text.GetBuffer(), 0, checked((int)text.Length));
        return domestic ? ParseDomesticManifest(DecodeDomesticContents(json)) : ParseManifest(json);
    }

    private static void RequireSameBytes(WindowsUpdateManifest first, WindowsUpdateManifest other)
    {
        if (first.Version != other.Version || first.Artifact.Sha256 != other.Artifact.Sha256 || first.Artifact.Size != other.Artifact.Size)
            throw Failure("同版本的更新文件不一致，已停止更新，请联系维护者。");
    }

    public Task<UpdateState> DownloadAsync() => RunAsync(async token =>
    {
        var state = State;
        RequireInstallable(state);
        var manifest = state.Manifest as WindowsUpdateManifest;
        if (manifest is null || CompareVersions(manifest.Version, state.CurrentVersion) <= 0) throw Failure("请先检查是否有新版本。");
        var candidates = manifest.Provider == "gitee" ? new[] { manifest, GitHubFallback(manifest) } : new[] { manifest };
        for (var index = 0; index < candidates.Length; index++)
        {
            try
            {
                using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
                // A stalled domestic transfer must leave time for the fallback.
                if (candidates[index].Provider == "gitee") budget.CancelAfter(TimeSpan.FromMinutes(3));
                await DownloadVerifiedAsync(candidates[index], budget.Token);
                Publish(value => value with { Manifest = candidates[index] });
                return;
            }
            catch (Exception error) when (index + 1 < candidates.Length && !token.IsCancellationRequested
                && error is HttpRequestException or InvalidOperationException or OperationCanceledException or TimeoutException)
            {
                Publish(value => value with { Progress = 0 });
            }
        }
    }, TimeSpan.FromMinutes(15));

    private static WindowsUpdateManifest GitHubFallback(WindowsUpdateManifest manifest) => manifest with
    {
        SchemaVersion = 1, Provider = null, Source = null,
        Artifact = manifest.Artifact with { Url = ArtifactUrl(manifest.Version) }, ReleaseNotesUrl = ReleaseNotesUrl(manifest.Version),
    };

    private async Task DownloadVerifiedAsync(WindowsUpdateManifest manifest, CancellationToken token)
    {
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
                using var response = await RequestAsync(new Uri(manifest.Artifact.Url), false, token, $"Yuyin-{manifest.Version}-Setup.exe");
                var length = response.Content.Headers.ContentLength;
                if (length is not null && length != manifest.Artifact.Size) throw Failure("安装包大小与更新清单不一致。");
                await using var body = await OpenDownloadBodyAsync(response, token);
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var bytes = 0L;
                var previousProgress = -1;
                var buffer = new byte[81920];
                while (true)
                {
                    var read = await ReadDownloadBodyAsync(body, buffer, token);
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
    }

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

    private async Task<HttpResponseMessage> RequestAsync(Uri initial, bool manifest, CancellationToken token, string? expectedFilename = null)
    {
        var uri = initial;
        for (var redirects = 0; redirects <= 5; redirects++)
        {
            if (!IsTrustedAddress(uri, manifest, initial, expectedFilename)) throw Failure("更新地址不受信任。");
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
                // The observed official Gitee route is one API -> foruda hop.
                // Never accept a second CDN hop or persist its expiring signature.
                if (location is null || redirects == 5 || (IsDomesticAttachmentAddress(initial) && redirects != 0)) throw Failure("更新下载重定向异常。");
                uri = location.IsAbsoluteUri ? location : new Uri(uri, location);
                continue;
            }
            if (response.StatusCode != HttpStatusCode.OK)
            {
                var notFound = response.StatusCode == HttpStatusCode.NotFound;
                response.Dispose();
                throw Failure(notFound ? "暂时没有可用的更新清单或安装包。" : "更新服务暂时不可用，请稍后重试。");
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
    private static async Task<Stream> OpenDownloadBodyAsync(HttpResponseMessage response, CancellationToken token)
    {
        try { return await response.Content.ReadAsStreamAsync(token); }
        catch (IOException error) { throw new HttpRequestException("更新下载传输中断，请稍后重试。", error); }
    }
    private static async Task<int> ReadDownloadBodyAsync(Stream stream, byte[] buffer, CancellationToken token)
    {
        try { return await ReadAsync(stream, buffer, token); }
        // Only response reads are transport failures. Disk IO remains a local
        // failure and must not trigger another provider/download.
        catch (IOException error) { throw new HttpRequestException("更新下载传输中断，请稍后重试。", error); }
    }
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
        HttpRequestException => "更新服务暂时无法连接，请稍后重试。",
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
    public static string DomesticReleaseNotesUrl(string version) => $"https://gitee.com/openmusic/openmusic/releases/tag/pc-v{version}";
    public static string DomesticArtifactUrl(int releaseId, int attachmentId)
    {
        if (releaseId < 1 || attachmentId < 1) throw Failure("国内更新附件标识不合法。");
        return $"https://gitee.com/api/v5/repos/openmusic/openmusic/releases/{releaseId}/attach_files/{attachmentId}/download";
    }

    /// Decodes only the fixed public Contents API file; embedded URLs are never followed.
    public static string DecodeDomesticContents(string json)
    {
        try
        {
            if (Encoding.UTF8.GetByteCount(json) > DomesticContentsMaxBytes) throw Failure("国内更新清单过大。");
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || root.GetProperty("type").GetString() != "file"
                || root.GetProperty("encoding").GetString() != "base64" || root.GetProperty("name").GetString() != "domestic.json"
                || root.GetProperty("path").GetString() != "updates/domestic.json"
                || !root.GetProperty("size").TryGetInt32(out var size) || size < 1 || size > ManifestMaxBytes)
                throw Failure("国内更新文件响应不合法。");
            var content = root.GetProperty("content").GetString() ?? throw Failure("国内更新文件缺少内容。");
            if (content.Length > DomesticContentsMaxBytes) throw Failure("国内更新清单过大。");
            var compact = content.Replace("\r", "").Replace("\n", "");
            if (compact.Length > ((ManifestMaxBytes + 2) / 3) * 4 || compact.Length % 4 != 0
                || !Regex.IsMatch(compact, @"\A[A-Za-z0-9+/]*={0,2}\z", RegexOptions.CultureInvariant))
                throw Failure("国内更新文件编码不合法。");
            var bytes = Convert.FromBase64String(compact);
            if (bytes.Length != size || Convert.ToBase64String(bytes) != compact) throw Failure("国内更新文件大小或编码不合法。");
            return new UTF8Encoding(false, true).GetString(bytes);
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or FormatException or DecoderFallbackException)
        { throw Failure("国内更新文件响应不合法，请稍后重试。"); }
    }

    public static WindowsUpdateManifest ParseDomesticManifest(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || root.GetProperty("schemaVersion").GetInt32() != 2
                || root.GetProperty("provider").GetString() != "gitee" || root.GetProperty("platform").GetString() != "windows"
                || root.TryGetProperty("versionCode", out _)) throw Failure("国内更新清单不合法，请稍后重试。");
            var version = root.GetProperty("version").GetString();
            var source = root.GetProperty("source");
            var releaseId = source.GetProperty("releaseId").GetInt32();
            var attachmentId = source.GetProperty("attachmentId").GetInt32();
            var filename = source.GetProperty("filename").GetString();
            var artifact = root.GetProperty("artifact");
            var url = artifact.GetProperty("url").GetString();
            var notesUrl = root.GetProperty("releaseNotesUrl").GetString();
            if (!IsStableVersion(version) || filename != $"Yuyin-{version}-Setup.exe"
                || url != DomesticArtifactUrl(releaseId, attachmentId) || notesUrl != DomesticReleaseNotesUrl(version!))
                throw Failure("国内更新清单不合法，请稍后重试。");
            // Share every size/digest/time/text validation with the legacy contract.
            var common = ParseManifest(JsonSerializer.Serialize(new
            {
                schemaVersion = 1, platform = "windows", version,
                artifact = new { url = ArtifactUrl(version!), sha256 = artifact.GetProperty("sha256").GetString(), size = artifact.GetProperty("size").GetInt64() },
                releaseNotesUrl = ReleaseNotesUrl(version!), notes = root.GetProperty("notes").GetString(), publishedAt = root.GetProperty("publishedAt").GetString(),
            }));
            return common with { SchemaVersion = 2, Provider = "gitee", Source = new(releaseId, attachmentId, filename!), Artifact = common.Artifact with { Url = url! }, ReleaseNotesUrl = notesUrl! };
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or FormatException or OverflowException)
        { throw Failure("国内更新清单不合法，请稍后重试。"); }
    }

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

    public static bool IsTrustedAddress(Uri uri, bool manifest, Uri? initial = null, string? expectedFilename = null)
    {
        if (!uri.IsAbsoluteUri || uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Fragment)) return false;
        if (manifest) return (uri.AbsoluteUri == ManifestUrl || uri.AbsoluteUri == DomesticManifestUrl) && (initial is null || uri == initial);
        if (IsDomesticAttachmentAddress(initial)) return uri == initial || IsDomesticAttachmentCdnAddress(uri, expectedFilename);
        if (uri.Host == "gitee.com") return initial is null && IsDomesticAttachmentAddress(uri);
        if (uri.Host == "github.com") return uri.AbsolutePath.StartsWith("/panda472328/yuyin-music/releases/download/", StringComparison.Ordinal) && string.IsNullOrEmpty(uri.Query) && (initial is null || uri == initial);
        return (initial is null || initial.Host == "github.com") && uri.Host is "release-assets.githubusercontent.com" or "objects.githubusercontent.com";
    }

    private static bool IsDomesticAttachmentAddress(Uri? uri) => uri is not null
        && Regex.IsMatch(uri.AbsoluteUri, @"\Ahttps://gitee\.com/api/v5/repos/openmusic/openmusic/releases/[1-9][0-9]{0,9}/attach_files/[1-9][0-9]{0,9}/download\z", RegexOptions.CultureInvariant);

    /// Official API-issued foruda attachment redirect observed 2026-10-12.
    /// The token is a short-lived public download signature, never a user PAT.
    private static bool IsDomesticAttachmentCdnAddress(Uri uri, string? expectedFilename)
    {
        if (expectedFilename is null || !Regex.IsMatch(expectedFilename, @"\AYuyin-(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})-Setup\.exe\z", RegexOptions.CultureInvariant)
            || uri.Host != "foruda.gitee.com" || !Regex.IsMatch(uri.AbsolutePath, @"\A/attach_file/[1-9][0-9]{0,18}/" + Regex.Escape(expectedFilename) + @"\z", RegexOptions.CultureInvariant)) return false;
        var fields = uri.Query.TrimStart('?').Split('&');
        if (fields.Length != 3) return false;
        var query = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var field in fields)
        {
            var pair = field.Split('=');
            if (pair.Length != 2 || !query.TryAdd(pair[0], pair[1])) return false;
        }
        return query.TryGetValue("token", out var signature) && Regex.IsMatch(signature, @"\A[0-9a-f]{32}\z", RegexOptions.CultureInvariant)
            && query.TryGetValue("ts", out var timestamp) && Regex.IsMatch(timestamp, @"\A[0-9]{10}\z", RegexOptions.CultureInvariant)
            && query.TryGetValue("attname", out var name) && name == expectedFilename;
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
