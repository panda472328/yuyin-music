using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;

namespace Yuyin.WindowsHost;

/// Bilibili transport used by the WebView2 host. The browser profile remains
/// the source of truth for cookies; each official API request uses a fresh
/// snapshot, and third-party lyric/subtitle requests never carry cookies.
public sealed partial class BilibiliService : IDisposable
{
    private const string Home = "https://www.bilibili.com/";
    private const string ApiOrigin = "https://api.bilibili.com";
    private const string SuggestOrigin = "https://s.search.bilibili.com";
    private readonly Func<string, Task<IReadOnlyList<BrowserCookie>>> _cookieReader;
    private readonly HttpClient _client;
    private readonly SemaphoreSlim _cookieGate = new(1, 1);
    private readonly object _stateGate = new();
    private readonly CancellationTokenSource _lifetime = new();
    private readonly Func<DateTimeOffset> _now;
    private readonly TimeSpan _requestTimeout;
    private IReadOnlyList<BrowserCookie> _cookies = Array.Empty<BrowserCookie>();
    private string? _identityFingerprint;
    private long _sessionRevision;
    private Task<BilibiliAccountStatus>? _pendingAccount;
    private long _pendingAccountRevision;
    private BilibiliAccountStatus? _account;
    private DateTimeOffset _accountCheckedAt;
    private bool _guest;
    private bool _disposed;
    private readonly SemaphoreSlim _wbiGate = new(1, 1);
    private (string ImgUrl, string SubUrl, DateTimeOffset Expires)? _wbiKeys;

    public event Action? SessionChanged;

    public BilibiliService(CoreWebView2CookieManager cookieManager)
        : this(async uri => (await cookieManager.GetCookiesAsync(uri)).Select(cookie => new BrowserCookie(
            cookie.Name, cookie.Value, cookie.Domain, cookie.Path, cookie.IsSecure,
            cookie.IsSession ? null : new DateTimeOffset(cookie.Expires.ToUniversalTime()))).ToArray(),
            new HttpClientHandler { AutomaticDecompression = DecompressionMethods.All, UseCookies = false, AllowAutoRedirect = false })
    {
    }

    /// Controlled transport/cookie injection keeps regressions independent of a
    /// real browser profile and lets tests verify the actual C# network path.
    public BilibiliService(Func<string, Task<IReadOnlyList<BrowserCookie>>> cookieReader, HttpMessageHandler handler,
        Func<DateTimeOffset>? clock = null, TimeSpan? requestTimeout = null)
    {
        _cookieReader = cookieReader;
        _now = clock ?? (() => DateTimeOffset.UtcNow);
        _requestTimeout = requestTimeout ?? TimeSpan.FromSeconds(20);
        _client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        _client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36");
        _client.DefaultRequestHeaders.Referrer = new Uri(Home);
        _client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
    }

    public async Task<BilibiliAccountStatus> GetAccountAsync(bool force = false)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await RefreshCookiesAsync();
        Task<BilibiliAccountStatus> pending;
        TaskCompletionSource<BilibiliAccountStatus>? completion = null;
        long revision;
        lock (_stateGate)
        {
            if (!force && _account?.LoggedIn == true && _now() >= _accountCheckedAt && _now() - _accountCheckedAt < TimeSpan.FromSeconds(30))
                return WithGuest(_account);
            revision = _sessionRevision;
            if (_pendingAccount is not null && _pendingAccountRevision == revision) pending = _pendingAccount;
            else
            {
                completion = new TaskCompletionSource<BilibiliAccountStatus>(TaskCreationOptions.RunContinuationsAsynchronously);
                pending = _pendingAccount = completion.Task;
                _pendingAccountRevision = revision;
            }
        }
        if (completion is not null) _ = CompleteAccountCheckAsync(completion, revision);
        return await pending;
    }

    private async Task CompleteAccountCheckAsync(TaskCompletionSource<BilibiliAccountStatus> completion, long revision)
    {
        try
        {
            var payload = await GetJsonAsync($"{ApiOrigin}/x/web-interface/nav", includeCookies: true);
            var status = ParseAccount(payload);
            await RefreshCookiesAsync();
            bool changed;
            lock (_stateGate)
            {
                AssertRevision(revision);
                changed = _account is not null && _account.Account?.Mid != status.Account?.Mid;
                if (changed) _sessionRevision++;
                _account = status;
                _accountCheckedAt = _now();
                status = WithGuest(status);
            }
            if (changed) NotifySessionChanged();
            completion.TrySetResult(status);
        }
        catch (Exception error) { completion.TrySetException(error); }
        finally { lock (_stateGate) { if (ReferenceEquals(_pendingAccount, completion.Task)) _pendingAccount = null; } }
    }

    public BilibiliAccountStatus ContinueAsGuest()
    {
        lock (_stateGate)
        {
            _guest = true;
            var status = WithGuest(_account ?? new BilibiliAccountStatus(false, null));
            NotifySessionChanged();
            return status;
        }
    }

    public async Task EnsurePlaybackAccessAsync()
    {
        await RefreshCookiesAsync();
        lock (_stateGate) if (_guest) return;
        var status = await GetAccountAsync();
        if (!status.LoggedIn) throw new BilibiliServiceException("请先登录 Bilibili，或选择游客模式后再播放。", "BILIBILI_LOGIN_REQUIRED", true);
    }

    public async Task<SearchResult> SearchAsync(string query, int page, string mode)
    {
        if (string.IsNullOrWhiteSpace(query) || query.Length > 200) throw new BilibiliServiceException("请输入 1 到 200 个字符的歌曲或视频名称。", "INVALID_QUERY");
        if (mode is not ("song" or "video")) throw new BilibiliServiceException("搜索模式不合法。", "INVALID_SEARCH_MODE");
        if (page < 1 || page > 1000) throw new BilibiliServiceException("搜索页码无效。", "INVALID_PAGE");
        await EnsurePlaybackAccessAsync();
        var revision = CaptureRevision();
        var keyword = query.Trim();
        if (mode == "song" && Normalize(keyword).Length == 0) throw new BilibiliServiceException("请输入歌曲或视频名称。", "INVALID_QUERY");
        var url = $"{ApiOrigin}/x/web-interface/search/type?{Query(new Dictionary<string, string> {
            ["search_type"] = "video", ["keyword"] = keyword, ["order"] = "totalrank",
            ["page"] = page.ToString(CultureInfo.InvariantCulture), ["page_size"] = "20",
        })}";
        var payload = await GetJsonAsync(url, true);
        EnsureApiSuccess(payload, "Bilibili 搜索失败");
        var data = Property(payload, "data");
        var result = Property(data, "result");
        if (data.ValueKind != JsonValueKind.Object || result.ValueKind != JsonValueKind.Array)
            throw new BilibiliServiceException("Bilibili 搜索结果格式已变化，请稍后重试。", "BILIBILI_INVALID_RESPONSE");
        var source = result.EnumerateArray().Select(VideoToSong).Where(song => song is not null).Cast<Song>().ToList();
        var songs = mode == "song" ? source.Select((song, index) => new { Song = song, Index = index, Score = SongTitleRelevance(song.Title, keyword) })
            .OrderBy(item => item.Score).ThenBy(item => item.Index).Select(item => item.Song).ToList() : source;
        var total = Math.Max(0, (int)Math.Round(Number(Property(data, "numResults")) ?? source.Count));
        var pageSize = Math.Max(1, (int)Math.Round(Number(Property(data, "pagesize")) ?? 20));
        var pages = Math.Max(1, (int)Math.Round(Number(Property(data, "numPages")) ?? Math.Ceiling(total / (double)pageSize)));
        await AssertSessionUnchangedAsync(revision);
        return new SearchResult(keyword, mode, songs, page, pageSize, total, page < pages);
    }

    public async Task<IReadOnlyList<string>> SearchSuggestionsAsync(string query)
    {
        var keyword = query.Trim();
        if (keyword.Length == 0) return Array.Empty<string>();
        if (keyword.Length > 200) throw new BilibiliServiceException("搜索词过长。", "INVALID_QUERY");
        await EnsurePlaybackAccessAsync();
        var revision = CaptureRevision();
        var payload = await GetJsonAsync($"{SuggestOrigin}/main/suggest?{Query(new Dictionary<string, string> { ["term"] = keyword })}", true, maximumTimeout: TimeSpan.FromSeconds(8));
        if (payload.ValueKind != JsonValueKind.Object) throw new BilibiliServiceException("Bilibili 搜索建议响应格式异常。", "BILIBILI_INVALID_RESPONSE");
        if (Property(payload, "code").ValueKind != JsonValueKind.Undefined) EnsureApiSuccess(payload, "Bilibili 搜索建议暂时不可用");
        var tags = Property(Property(payload, "result"), "tag");
        if (tags.ValueKind != JsonValueKind.Array) tags = Property(Property(payload, "data"), "tag");
        if (tags.ValueKind != JsonValueKind.Array)
            throw new BilibiliServiceException("Bilibili 搜索建议响应格式异常。", "BILIBILI_INVALID_RESPONSE");
        var suggestions = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        if (tags.ValueKind == JsonValueKind.Array)
        {
            foreach (var tag in tags.EnumerateArray().Take(100))
            {
                var decoded = Regex.Replace(StripText(Property(tag, "value")), "<[^>]*>", "");
                var clean = new StringBuilder();
                foreach (var rune in decoded.EnumerateRunes().Where(rune => Rune.GetUnicodeCategory(rune) is not UnicodeCategory.Control and not UnicodeCategory.Format).Take(100)) clean.Append(rune.ToString());
                var text = clean.ToString().Trim();
                if (text.Length == 0 || !seen.Add(text)) continue;
                suggestions.Add(text);
                if (suggestions.Count == 10) break;
            }
        }
        await AssertSessionUnchangedAsync(revision);
        return suggestions;
    }

    public async Task<BilibiliFavoriteFoldersResult> ListFavoriteFoldersAsync()
    {
        var status = await RequireLoggedInAsync();
        var revision = CaptureRevision();
        var payload = await GetJsonAsync($"{ApiOrigin}/x/v3/fav/folder/created/list-all?{Query(new Dictionary<string, string> {
            ["up_mid"] = status.Account!.Mid.ToString(CultureInfo.InvariantCulture), ["web_location"] = "333.1387",
        })}", true);
        EnsureApiSuccess(payload, "Bilibili 收藏夹读取失败");
        var folders = new List<BilibiliFavoriteFolder>();
        foreach (var item in ArrayProperty(Property(payload, "data"), "list").Take(100))
        {
            var id = Number(Property(item, "id"));
            var title = Text(Property(item, "title"));
            if (id is null or <= 0 || string.IsNullOrWhiteSpace(title)) continue;
            folders.Add(new BilibiliFavoriteFolder(
                (long)id.Value, title, Math.Max(0, (int)Math.Round(Number(Property(item, "media_count")) ?? 0)),
                SafeUrl(Text(Property(item, "cover"))), Text(Property(item, "intro")),
                (Number(Property(item, "attr")) ?? 0) == 22 || title == "默认收藏夹"));
        }
        await AssertSessionUnchangedAsync(revision);
        return new BilibiliFavoriteFoldersResult(status.Account!.Mid, status.Account.Username,
            new BilibiliFavoriteAccount(status.Account.Mid, status.Account.Username), folders);
    }

    public async Task<BilibiliFavoriteItemsResult> ListFavoriteItemsAsync(long mediaId, int page)
    {
        if (mediaId <= 0 || page < 1 || page > 1000) throw new BilibiliServiceException("收藏夹参数无效。", "INVALID_FAVORITE_FOLDER");
        await RequireLoggedInAsync();
        var revision = CaptureRevision();
        var payload = await GetJsonAsync($"{ApiOrigin}/x/v3/fav/resource/list?{Query(new Dictionary<string, string> {
            ["media_id"] = mediaId.ToString(CultureInfo.InvariantCulture), ["pn"] = page.ToString(CultureInfo.InvariantCulture),
            ["ps"] = "20", ["platform"] = "web", ["web_location"] = "333.1387",
        })}", true);
        EnsureApiSuccess(payload, "Bilibili 收藏夹内容读取失败");
        var data = Property(payload, "data");
        var info = Property(data, "info");
        var title = Text(Property(info, "title"));
        if (string.IsNullOrWhiteSpace(title)) title = $"收藏夹 {mediaId}";
        var count = Math.Max(0, (int)Math.Round(Number(Property(info, "media_count")) ?? 0));
        var folder = new BilibiliFavoriteFolder(mediaId, title, count, SafeUrl(Text(Property(info, "cover"))), Text(Property(info, "intro")), (Number(Property(info, "attr")) ?? 0) == 22 || title == "默认收藏夹");
        var songs = ArrayProperty(data, "medias").Select(FavoriteToSong).Where(song => song is not null).Cast<Song>().ToList();
        var total = count > 0 ? count : (page - 1) * 20 + songs.Count;
        await AssertSessionUnchangedAsync(revision);
        return new BilibiliFavoriteItemsResult(folder, songs, page, 20, total, page * 20 < total);
    }

    public async Task<BilibiliFavoriteSongsResult> ListFavoriteSongsAsync(long mediaId)
    {
        await RequireLoggedInAsync();
        var revision = CaptureRevision();
        var first = await ListFavoriteItemsAsync(mediaId, 1);
        var all = new List<Song>(first.Songs);
        var pages = Math.Min(100, Math.Max(1, (int)Math.Ceiling(first.Total / (double)first.PageSize)));
        for (var page = 2; page <= pages; page++)
        {
            var next = await ListFavoriteItemsAsync(mediaId, page);
            all.AddRange(next.Songs);
            if (!next.HasMore) break;
        }
        var unique = all.GroupBy(song => song.Bvid, StringComparer.OrdinalIgnoreCase).Select(group => group.First()).ToList();
        await AssertSessionUnchangedAsync(revision);
        return new BilibiliFavoriteSongsResult(first.Folder, unique, Math.Max(0, first.Total - unique.Count), first.Total);
    }

    public async Task<LyricsLookupResult> LookupLyricsAsync(LyricsRequest request)
    {
        ValidateLyricsRequest(request);
        if (request.Provider != "bilibili")
            throw new BilibiliServiceException("LRCLIB 歌词请使用候选查询并由共享匹配器选择。", "LYRICS_INVALID_PROVIDER");
        var song = request.Song;
        await RefreshCookiesAsync();
        var revision = CaptureRevision();
        using var totalTimeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        totalTimeout.CancelAfter(TimeSpan.FromSeconds(25));
        // Each stage is bounded by the full lookup deadline as well as the
        // request timeout in GetJsonAsync. Only existing captions are read.
        try
        {
            var view = ApiData(await GetJsonAsync($"{ApiOrigin}/x/web-interface/view?bvid={song.Bvid}", true, totalTimeout.Token, TimeSpan.FromSeconds(8)));
            var pages = Property(view, "pages");
            var first = pages.ValueKind == JsonValueKind.Array && pages.GetArrayLength() > 0 ? pages[0] : default;
            var cid = PositiveInteger(Property(first, "cid")) ?? PositiveInteger(Property(view, "cid"));
            var aid = PositiveInteger(Property(view, "aid"));
            if (cid is null || aid is null) throw new BilibiliServiceException("Bilibili 未返回有效的视频分段信息。", "SUBTITLES_INVALID_RESPONSE");
            var keys = await GetWbiKeysAsync(totalTimeout.Token);
            var query = BilibiliSubtitleRules.BuildWbiQuery(new Dictionary<string, string>
            {
                ["bvid"] = song.Bvid, ["cid"] = cid.Value.ToString(CultureInfo.InvariantCulture), ["aid"] = aid.Value.ToString(CultureInfo.InvariantCulture),
            }, keys.ImgUrl, keys.SubUrl, _now().ToUnixTimeSeconds());
            var player = ApiData(await GetJsonAsync($"{ApiOrigin}/x/player/wbi/v2?{query}", true, totalTimeout.Token, TimeSpan.FromSeconds(8)));
            var candidates = Property(Property(player, "subtitle"), "subtitles");
            if (candidates.ValueKind != JsonValueKind.Array || candidates.GetArrayLength() > 100)
                throw new BilibiliServiceException("Bilibili 字幕列表格式异常，请稍后重试。", "SUBTITLES_INVALID_RESPONSE");
            var selected = BilibiliSubtitleRules.SelectSubtitle(candidates.EnumerateArray().Select(BilibiliSubtitleRules.Descriptor).OfType<SubtitleDescriptor>());
            if (selected is null)
            {
                await AssertSessionUnchangedAsync(revision);
                if (Property(player, "need_login_subtitle").ValueKind == JsonValueKind.True)
                    return new LyricsLookupResult("bilibili", "", null, null,
                        "Bilibili 要求登录后才能读取该视频字幕，请打开源视频登录后重试。这里只读取已有字幕，不会为视频自动生成字幕。", true);
                if (candidates.GetArrayLength() > 0)
                    throw new BilibiliServiceException("Bilibili 提供的字幕地址或格式暂不支持，无法安全读取。", "SUBTITLES_UNSUPPORTED");
                return new LyricsLookupResult("bilibili", "", null, null,
                    "Bilibili 暂未向当前会话提供该视频的可用字幕。这里只读取已有字幕，无法为视频自动生成字幕；也可以登录后重试。");
            }
            var caption = await GetJsonAsync(selected.Url, false, totalTimeout.Token, TimeSpan.FromSeconds(8));
            var lyrics = BilibiliSubtitleRules.SubtitleBodyToLyrics(caption);
            await AssertSessionUnchangedAsync(revision);
            var info = new BilibiliSubtitleInfo(selected.Language, selected.Label, selected.IsAI);
            if (lyrics.PlainLyrics.Length == 0) return new LyricsLookupResult("bilibili", "", null, info,
                "该视频的字幕文件没有可显示的文字。这里只读取已有字幕，不会自动生成字幕。");
            var firstDuration = Number(Property(first, "duration"));
            var duration = firstDuration is > 0 and <= 86_400 ? firstDuration.Value : song.Duration > 0 ? song.Duration : lyrics.Duration;
            var track = new LyricsTrack(cid.Value, song.Title, "", "", duration, false, lyrics.SyncedLyrics, lyrics.PlainLyrics);
            return new LyricsLookupResult("bilibili", "", track, info, selected.IsAI ? null : "该视频提供的是 UP 主字幕。");
        }
        catch (OperationCanceledException)
        {
            throw new BilibiliServiceException("Bilibili 字幕查询超时，请稍后重试。", "SUBTITLES_TIMEOUT");
        }
    }

    public async Task<IReadOnlyList<LyricsTrack>> LookupLyricsCandidatesAsync(string query)
    {
        if (string.IsNullOrWhiteSpace(query) || query.Length > 200)
            throw new BilibiliServiceException("歌词查询词无效。", "LYRICS_INVALID_REQUEST");
        var payload = await GetJsonAsync($"https://lrclib.net/api/search?{Query(new Dictionary<string, string> { ["q"] = query.Trim() })}", false);
        if (payload.ValueKind != JsonValueKind.Array || payload.GetArrayLength() > 500)
            throw new BilibiliServiceException("歌词服务返回的数据格式异常，请稍后重试。", "LYRICS_INVALID_RESPONSE");
        var tracks = payload.EnumerateArray().Select(ParseLyricsTrack).OfType<LyricsTrack>().ToArray();
        if (payload.GetArrayLength() > 0 && tracks.Length == 0)
            throw new BilibiliServiceException("歌词服务返回的数据格式异常，请稍后重试。", "LYRICS_INVALID_RESPONSE");
        return tracks;
    }

    private static LyricsTrack? ParseLyricsTrack(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) return null;
        var id = PositiveInteger(Property(value, "id"));
        var name = Property(value, "trackName");
        var artist = Property(value, "artistName");
        var album = Property(value, "albumName");
        var duration = Property(value, "duration");
        var instrumental = Property(value, "instrumental");
        var synced = Property(value, "syncedLyrics");
        var plain = Property(value, "plainLyrics");
        static bool BoundedText(JsonElement input, int size) => input.ValueKind == JsonValueKind.String && (input.GetString()?.Length ?? int.MaxValue) <= size;
        static bool LyricsText(JsonElement input) => input.ValueKind == JsonValueKind.Null || BoundedText(input, 100_000);
        if (id is null || !BoundedText(name, 500) || string.IsNullOrWhiteSpace(name.GetString()) ||
            !BoundedText(artist, 500) || !(album.ValueKind == JsonValueKind.Null || BoundedText(album, 500)) ||
            duration.ValueKind != JsonValueKind.Number || !duration.TryGetDouble(out var seconds) || !double.IsFinite(seconds) || seconds < 0 || seconds > 86_400 ||
            instrumental.ValueKind is not (JsonValueKind.True or JsonValueKind.False) || !LyricsText(synced) || !LyricsText(plain)) return null;
        return new LyricsTrack(id.Value, name.GetString()!, artist.GetString()!, album.ValueKind == JsonValueKind.Null ? "" : album.GetString()!,
            seconds, instrumental.GetBoolean(), synced.ValueKind == JsonValueKind.Null ? null : synced.GetString(), plain.ValueKind == JsonValueKind.Null ? null : plain.GetString());
    }

    private static void ValidateLyricsRequest(LyricsRequest request)
    {
        var song = request?.Song;
        if (song is null || song.Source != "bilibili" || !Regex.IsMatch(song.Bvid ?? "", "^BV[0-9A-Za-z]{10}$") ||
            string.IsNullOrWhiteSpace(song.Title) || song.Title.Length > 1000 || song.Artist is null || song.Artist.Length > 500 ||
            !double.IsFinite(song.Duration) || song.Duration < 0 || song.Duration > 86_400 || request!.Query?.Length > 200)
            throw new BilibiliServiceException("歌曲信息无效，无法查询歌词。", "LYRICS_INVALID_REQUEST");
    }

    private async Task<(string ImgUrl, string SubUrl, DateTimeOffset Expires)> GetWbiKeysAsync(CancellationToken cancellationToken)
    {
        await _wbiGate.WaitAsync(cancellationToken);
        try
        {
            if (_wbiKeys is { } cached && cached.Expires > _now()) return cached;
            var payload = await GetJsonAsync($"{ApiOrigin}/x/web-interface/nav", true, cancellationToken, TimeSpan.FromSeconds(8));
            var code = Number(Property(payload, "code"));
            if (code != 0 && code != -101) EnsureApiSuccess(payload, "Bilibili 字幕签名读取失败");
            var images = Property(Property(payload, "data"), "wbi_img");
            var imgUrl = Text(Property(images, "img_url"));
            var subUrl = Text(Property(images, "sub_url"));
            _ = BilibiliSubtitleRules.BuildWbiQuery(new Dictionary<string, string>(), imgUrl, subUrl, 0);
            var keys = (imgUrl, subUrl, _now().AddMinutes(30));
            _wbiKeys = keys;
            return keys;
        }
        finally { _wbiGate.Release(); }
    }

    private static JsonElement ApiData(JsonElement payload)
    {
        EnsureApiSuccess(payload, "Bilibili 字幕读取失败");
        var data = Property(payload, "data");
        if (data.ValueKind != JsonValueKind.Object) throw new BilibiliServiceException("Bilibili 字幕信息格式异常。", "SUBTITLES_INVALID_RESPONSE");
        return data;
    }

    private static long? PositiveInteger(JsonElement value) => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number) && number > 0 && number <= 9_007_199_254_740_991 ? number : null;

    public async Task<BilibiliAccountStatus> RequireLoggedInAsync()
    {
        var status = await GetAccountAsync();
        if (!status.LoggedIn) throw new BilibiliServiceException("请先登录 Bilibili 账号，再使用账号相关功能。", "BILIBILI_LOGIN_REQUIRED", true);
        return status;
    }

    private async Task<JsonElement> GetJsonAsync(string url, bool includeCookies, CancellationToken cancellationToken = default, TimeSpan? maximumTimeout = null)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var uri = new Uri(url);
        var lyrics = uri.Host.Equals("lrclib.net", StringComparison.OrdinalIgnoreCase);
        if (uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || !string.IsNullOrEmpty(uri.UserInfo) ||
            (includeCookies && uri.Host is not ("api.bilibili.com" or "s.search.bilibili.com")))
            throw new BilibiliServiceException("服务请求地址不合法。", "INVALID_ENDPOINT");
        if (includeCookies) await RefreshCookiesAsync();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token, cancellationToken);
        timeout.CancelAfter(maximumTimeout is { } maximum && maximum < _requestTimeout ? maximum : _requestTimeout);
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        if (includeCookies)
        {
            string header;
            lock (_stateGate) header = CookieHeader(uri, _cookies, _now());
            if (header.Length > 0) request.Headers.TryAddWithoutValidation("Cookie", header);
        }
        try
        {
            using var response = await _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode)
            {
                var restricted = !lyrics && new[] { 401, 403, 412, 429 }.Contains((int)response.StatusCode);
                throw new BilibiliServiceException($"{(lyrics ? "歌词" : "Bilibili")}服务返回 HTTP {(int)response.StatusCode}，请稍后重试。",
                    lyrics ? "LYRICS_HTTP_ERROR" : restricted ? "BILIBILI_VERIFICATION_REQUIRED" : "BILIBILI_HTTP_ERROR", restricted);
            }
            const int maxBytes = 2 * 1024 * 1024;
            if (response.Content.Headers.ContentLength > maxBytes)
                throw new BilibiliServiceException("服务返回的数据过大，请稍后重试。", "RESPONSE_TOO_LARGE");
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var body = new MemoryStream();
            var buffer = new byte[8192];
            while (true)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(), timeout.Token);
                if (read == 0) break;
                if (body.Length + read > maxBytes)
                    throw new BilibiliServiceException("服务返回的数据过大，请稍后重试。", "RESPONSE_TOO_LARGE");
                body.Write(buffer, 0, read);
            }
            try { using var document = JsonDocument.Parse(body.ToArray()); return document.RootElement.Clone(); }
            catch (JsonException)
            {
                throw new BilibiliServiceException(lyrics ? "歌词服务返回的数据格式异常，请稍后重试。" :
                    "Bilibili 返回了验证页面，请打开源站完成验证后重试。", lyrics ? "LYRICS_INVALID_RESPONSE" : "BILIBILI_INVALID_RESPONSE", !lyrics);
            }
        }
        catch (BilibiliServiceException) { throw; }
        catch (OperationCanceledException)
        {
            if (_disposed) throw new ObjectDisposedException(nameof(BilibiliService));
            throw new BilibiliServiceException($"{(lyrics ? "歌词" : "Bilibili")}查询超时，请检查网络后重试。", lyrics ? "LYRICS_TIMEOUT" : "BILIBILI_TIMEOUT");
        }
        catch (HttpRequestException)
        {
            throw new BilibiliServiceException($"无法连接{(lyrics ? "歌词" : " Bilibili ")}服务，请检查网络后重试。", lyrics ? "LYRICS_NETWORK_ERROR" : "NETWORK_ERROR");
        }
    }

    private async Task RefreshCookiesAsync()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _cookieGate.WaitAsync(_lifetime.Token);
        bool changed = false;
        try
        {
            var snapshot = new Dictionary<string, BrowserCookie>(StringComparer.Ordinal);
            foreach (var uri in new[] { Home, ApiOrigin, SuggestOrigin })
            {
                var cookies = await _cookieReader(uri).WaitAsync(_lifetime.Token);
                foreach (var cookie in cookies)
                {
                    if (!ValidBrowserCookie(cookie, _now())) continue;
                    snapshot[$"{cookie.Domain}\n{cookie.Path}\n{cookie.Name}"] = cookie;
                }
            }
            var all = snapshot.Values.ToArray();
            var authentication = string.Join("\n", all.Where(IsAuthenticationCookie).OrderBy(cookie => cookie.Domain, StringComparer.Ordinal)
                .ThenBy(cookie => cookie.Path, StringComparer.Ordinal).ThenBy(cookie => cookie.Name, StringComparer.Ordinal)
                .Select(cookie => $"{cookie.Domain}\t{cookie.Path}\t{cookie.Name}\t{cookie.Value}"));
            var fingerprint = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(authentication)));
            lock (_stateGate)
            {
                changed = _identityFingerprint is not null && _identityFingerprint != fingerprint;
                _identityFingerprint = fingerprint;
                _cookies = all;
                if (changed)
                {
                    _sessionRevision++;
                    _account = null;
                    _accountCheckedAt = default;
                    _pendingAccount = null;
                }
            }
        }
        finally { _cookieGate.Release(); }
        if (changed) NotifySessionChanged();
    }

    private static bool ValidBrowserCookie(BrowserCookie cookie, DateTimeOffset now) =>
        !string.IsNullOrWhiteSpace(cookie.Name) && !cookie.Name.Any(character => char.IsControl(character) || character is ';' or '=' or '\r' or '\n') &&
        !cookie.Value.Any(character => char.IsControl(character) || character is ';' or '\r' or '\n') &&
        (cookie.Domain.TrimStart('.').Equals("bilibili.com", StringComparison.OrdinalIgnoreCase) || cookie.Domain.TrimStart('.').EndsWith(".bilibili.com", StringComparison.OrdinalIgnoreCase)) &&
        (cookie.Expires is null || cookie.Expires > now);

    private static bool IsAuthenticationCookie(BrowserCookie cookie) =>
        new[] { "SESSDATA", "DedeUserID", "DedeUserID__ckMd5", "bili_jct" }.Contains(cookie.Name, StringComparer.Ordinal);

    public static string CookieHeader(Uri target, IReadOnlyList<BrowserCookie> cookies, DateTimeOffset now) =>
        string.Join("; ", cookies.Where(cookie => ValidBrowserCookie(cookie, now) &&
            (cookie.Domain.StartsWith('.') ? target.Host.Equals(cookie.Domain.TrimStart('.'), StringComparison.OrdinalIgnoreCase) ||
                target.Host.EndsWith(cookie.Domain, StringComparison.OrdinalIgnoreCase) : target.Host.Equals(cookie.Domain, StringComparison.OrdinalIgnoreCase)) &&
            target.AbsolutePath.StartsWith(string.IsNullOrEmpty(cookie.Path) ? "/" : cookie.Path, StringComparison.Ordinal))
            .OrderByDescending(cookie => cookie.Path.Length).Select(cookie => $"{cookie.Name}={cookie.Value}"));

    private void AssertRevision(long revision)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (revision != _sessionRevision) throw new BilibiliServiceException("Bilibili 账号已发生变化，请重新验证后重试。", "BILIBILI_SESSION_CHANGED");
    }

    private long CaptureRevision() { lock (_stateGate) return _sessionRevision; }
    private async Task AssertSessionUnchangedAsync(long revision)
    {
        await RefreshCookiesAsync();
        lock (_stateGate) AssertRevision(revision);
    }
    private void NotifySessionChanged() { if (!_disposed) SessionChanged?.Invoke(); }

    private BilibiliAccountStatus WithGuest(BilibiliAccountStatus status)
    {
        lock (_stateGate) return !status.LoggedIn && _guest ? status with { Guest = true } : status;
    }

    private static BilibiliAccountStatus ParseAccount(JsonElement payload)
    {
        var code = Property(payload, "code");
        if (code.ValueKind != JsonValueKind.Number || !code.TryGetInt64(out var codeValue))
            throw new BilibiliServiceException("Bilibili 登录状态响应格式异常，请稍后重试。", "BILIBILI_INVALID_RESPONSE");
        if (codeValue == -101) return new BilibiliAccountStatus(false, null);
        EnsureApiSuccess(payload, "Bilibili 登录状态验证失败");
        var data = Property(payload, "data");
        if (Property(data, "isLogin").ValueKind == JsonValueKind.False)
            return new BilibiliAccountStatus(false, null);
        var mid = Number(Property(data, "mid"));
        var name = Regex.Replace(StripText(Property(data, "uname")), @"[\x00-\x1f\x7f]", "").Trim();
        if (name.Length > 128) name = name[..128];
        if (Property(data, "isLogin").ValueKind != JsonValueKind.True || mid is null or <= 0 || !double.IsFinite(mid.Value) ||
            mid.Value != Math.Truncate(mid.Value) || mid.Value > 9_007_199_254_740_991 || string.IsNullOrWhiteSpace(name))
            throw new BilibiliServiceException("Bilibili 账号信息响应格式异常，请稍后重试。", "BILIBILI_INVALID_RESPONSE");
        return new BilibiliAccountStatus(true, new BilibiliAccount((long)mid.Value, name, SafeUrl(Text(Property(data, "face")))));
    }

    private static void EnsureApiSuccess(JsonElement payload, string operation)
    {
        var code = Number(Property(payload, "code"));
        if (code == 0) return;
        if (code is null || !double.IsFinite(code.Value) || code.Value != Math.Truncate(code.Value))
            throw new BilibiliServiceException($"{operation}：响应格式异常。", "BILIBILI_INVALID_RESPONSE");
        var restricted = new[] { -101, -111, -352, -403, -412, -509 }.Contains((int)code.Value);
        throw new BilibiliServiceException($"{operation}：{Text(Property(payload, "message"))}（{code}）。", restricted ? "BILIBILI_VERIFICATION_REQUIRED" : "BILIBILI_API_ERROR", restricted);
    }

    private static Song? VideoToSong(JsonElement item)
    {
        var bvid = Text(Property(item, "bvid"));
        if (!Regex.IsMatch(bvid, "^BV[0-9A-Za-z]{10}$")) return null;
        return new Song(bvid, bvid, StripText(Property(item, "title")), StripText(Property(item, "author")), SafeUrl(Text(Property(item, "pic"))), Duration(Property(item, "duration")), PlayCount(Property(item, "play")), "bilibili", $"https://www.bilibili.com/video/{bvid}/");
    }

    private static Song? FavoriteToSong(JsonElement item)
    {
        var bvid = Text(Property(item, "bvid"));
        if (string.IsNullOrWhiteSpace(bvid)) bvid = Text(Property(item, "bv_id"));
        if (!Regex.IsMatch(bvid, "^BV[0-9A-Za-z]{10}$")) return null;
        var upper = Property(item, "upper");
        var artist = StripText(upper.ValueKind == JsonValueKind.Object ? Property(upper, "name") : default);
        if (string.IsNullOrWhiteSpace(artist)) artist = StripText(Property(item, "author"));
        return new Song(bvid, bvid, StripText(Property(item, "title")), artist, SafeUrl(Text(Property(item, "cover"))), Duration(Property(item, "duration")), PlayCount(Property(item, "play")), "bilibili", $"https://www.bilibili.com/video/{bvid}/");
    }

    private static string Query(Dictionary<string, string> values) => string.Join("&", values.Select(pair => $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value)}"));
    private static JsonElement Property(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var result) ? result : default;
    private static IEnumerable<JsonElement> ArrayProperty(JsonElement value, string name) => Property(value, name).ValueKind == JsonValueKind.Array ? Property(value, name).EnumerateArray() : Enumerable.Empty<JsonElement>();
    private static double? Number(JsonElement value) => value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) ? number : value.ValueKind == JsonValueKind.String && double.TryParse(value.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out number) ? number : null;
    private static string Text(JsonElement value) => value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
    private static string StripText(JsonElement value) => WebUtility.HtmlDecode(Regex.Replace(Text(value), "<[^>]*>", "")).Replace("\0", "").Trim();
    private static double Duration(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number)) return Math.Max(0, number);
        var parts = Text(value).Split(':').Select(part => double.TryParse(part, NumberStyles.Any, CultureInfo.InvariantCulture, out var result) ? result : double.NaN).ToArray();
        return parts.Length > 0 && parts.All(double.IsFinite) ? parts.Aggregate(0d, (total, part) => total * 60 + Math.Max(0, part)) : 0;
    }
    private static double PlayCount(JsonElement value)
    {
        var text = Text(value).Replace(",", "");
        var scale = text.Contains('亿') ? 100_000_000 : text.Contains('万') ? 10_000 : 1;
        var cleaned = text.Replace("亿", "").Replace("万", "");
        return double.TryParse(cleaned, NumberStyles.Any, CultureInfo.InvariantCulture, out var number) ? Math.Max(0, Math.Round(number * scale)) : Number(value) ?? 0;
    }
    private static string SafeUrl(string value)
    {
        if (value.StartsWith("//", StringComparison.Ordinal)) value = "https:" + value;
        return Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps && uri.IsDefaultPort && string.IsNullOrEmpty(uri.UserInfo) && (uri.Host.EndsWith(".hdslb.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".bilibili.com", StringComparison.OrdinalIgnoreCase) || uri.Host.Equals("hdslb.com", StringComparison.OrdinalIgnoreCase) || uri.Host.Equals("bilibili.com", StringComparison.OrdinalIgnoreCase)) ? uri.ToString() : "";
    }
    private static double SongTitleRelevance(string title, string query)
    {
        var songName = Normalize(query);
        var titleName = Normalize(title);
        if (songName.Length == 0 || titleName.Length == 0) return 7;
        if (titleName == songName) return 0;
        if (titleName.StartsWith(songName, StringComparison.Ordinal)) return 1;
        if (titleName.Contains(songName, StringComparison.Ordinal)) return 2;
        var tokens = Regex.Split(query.Normalize(NormalizationForm.FormKC).ToLowerInvariant(), @"[\s\p{P}]+").Where(token => token.Length > 0).Distinct(StringComparer.Ordinal).ToArray();
        var matched = tokens.Count(token => titleName.Contains(token, StringComparison.Ordinal));
        if (tokens.Length > 1 && matched == tokens.Length) return 3;
        if (songName.Contains(titleName, StringComparison.Ordinal)) return 4;
        if (matched > 0) return 5 + (tokens.Length - matched) / (double)tokens.Length;
        return 7;
    }
    private static string Normalize(string value)
    {
        var normalized = value.Normalize(NormalizationForm.FormKC).ToLowerInvariant();
        var builder = new StringBuilder(normalized.Length);
        foreach (var character in normalized.EnumerateRunes())
        {
            var category = Rune.GetUnicodeCategory(character);
            if (!Rune.IsWhiteSpace(character) && category is not UnicodeCategory.ConnectorPunctuation and not UnicodeCategory.DashPunctuation and not UnicodeCategory.OpenPunctuation and not UnicodeCategory.ClosePunctuation and not UnicodeCategory.InitialQuotePunctuation and not UnicodeCategory.FinalQuotePunctuation and not UnicodeCategory.OtherPunctuation) builder.Append(character.ToString());
        }
        return builder.ToString();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _lifetime.Cancel();
        _client.Dispose();
    }
}

public sealed record BrowserCookie(string Name, string Value, string Domain, string Path, bool Secure, DateTimeOffset? Expires = null);

public sealed class BilibiliServiceException(string message, string code, bool requiresVerification = false) : Exception(message)
{
    public string Code { get; } = code;
    public bool RequiresVerification { get; } = requiresVerification;
}
