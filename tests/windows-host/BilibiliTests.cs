using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Yuyin.WindowsHost;

public static class BilibiliTests
{
    private const string ImgUrl = "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png";
    private const string SubUrl = "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png";
    private static readonly Song TestSong = new("BV1234567890", "BV1234567890", "测试视频", "虚构 UP 主", "", 100, 1, "bilibili", "https://www.bilibili.com/video/BV1234567890/");
    private static int _checks;
    private static void Assert(bool condition, string name)
    {
        if (!condition) throw new Exception("FAIL: " + name);
        _checks++;
    }
    private static async Task RejectAsync(Func<Task> operation, string code, string name)
    {
        try { await operation(); }
        catch (BilibiliServiceException error) when (error.Code == code) { _checks++; return; }
        throw new Exception("FAIL: " + name);
    }
    private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };
    private static JsonElement Element(object value) { using var document = JsonDocument.Parse(JsonSerializer.Serialize(value)); return document.RootElement.Clone(); }
    private static object AnonymousNav() => new { code = -101, data = new { isLogin = false, wbi_img = new { img_url = ImgUrl, sub_url = SubUrl } } };
    private static object LoggedInNav(long mid = 100) => new { code = 0, data = new { isLogin = true, mid, uname = "虚构测试账号", face = "https://i0.hdslb.com/bfs/face/test.png" } };
    private static BrowserCookie AuthCookie(string value) => new("SESSDATA", value, ".bilibili.com", "/", true);

    public static async Task RunAsync()
    {
        _checks = 0;
        Assert(BilibiliSubtitleRules.BuildWbiQuery(new Dictionary<string, string> { ["foo"] = "114", ["bar"] = "514", ["baz"] = "1919810" }, ImgUrl, SubUrl, 1702204169) ==
            "bar=514&baz=1919810&foo=114&wts=1702204169&w_rid=6149fdadf571698ca7e6a567265cd0ee", "native WBI fixture matches source signature");
        Assert(BilibiliSubtitleRules.BuildWbiQuery(new Dictionary<string, string> { ["text"] = "!试'() *", ["w_rid"] = "untrusted" }, ImgUrl, SubUrl, 1).StartsWith("text=%E8%AF%95%20&wts=1&", StringComparison.Ordinal), "WBI strips prohibited characters and ignores caller signature");
        foreach (var url in new[] { "http://i0.hdslb.com/bfs/subtitle/a.json", "https://i0.hdslb.com.evil.test/bfs/subtitle/a.json",
            "https://i0.hdslb.com@127.0.0.1/bfs/subtitle/a.json", "https://i0.hdslb.com:8443/bfs/subtitle/a.json", "https://aisubtitle.hdslb.com/other/a.json",
            "https://i0.hdslb.com/bfs/subtitle/../../other/a.json", "https://i0.hdslb.com/bfs/subtitle/a.json#fragment" })
            Assert(BilibiliSubtitleRules.SafeSubtitleUrl(url) is null, "caption URL rejection");
        var ai = BilibiliSubtitleRules.Descriptor(Element(new { lan = "ai-zh", lan_doc = "中文（自动生成）", subtitle_url = "//aisubtitle.hdslb.com/bfs/ai_subtitle/test.json" }))!;
        var manual = BilibiliSubtitleRules.Descriptor(Element(new { lan = "zh-CN", lan_doc = "中文（中国）", subtitle_url = "https://i0.hdslb.com/bfs/subtitle/test.json", type = 1 }))!;
        var englishAI = ai with { Language = "ai-en", Label = "English (AI)" };
        Assert(BilibiliSubtitleRules.SelectSubtitle(new[] { manual, englishAI, ai }) == ai, "Chinese AI captions preferred");
        Assert(BilibiliSubtitleRules.SelectSubtitle(new[] { englishAI, manual }) == manual && !manual.IsAI, "manual Chinese beats English AI and remains human");
        var lyrics = BilibiliSubtitleRules.SubtitleBodyToLyrics(Element(new { body = new[] {
            new { from = 6d, to = 8.5d, content = "第二段\n字幕" }, new { from = 2.25d, to = 4d, content = "[00:01]字面时间" } } }));
        Assert(lyrics.SyncedLyrics == "[00:02.250]［00:01］字面时间\n[00:04.000]\n[00:06.000]第二段 字幕\n[00:08.500]", "caption conversion preserves times and silent gaps without LRC injection");
        Assert(lyrics.Duration == 8.5, "caption duration reflects last end");
        await RejectAsync(() => Task.FromResult(BilibiliSubtitleRules.SubtitleBodyToLyrics(Element(new { body = new[] { new { from = 3, to = 2, content = "x" } } }))),
            "SUBTITLES_INVALID_RESPONSE", "invalid caption timeline rejected");

        await AccountChecksAsync();
        await SearchChecksAsync();
        await SuggestionChecksAsync();
        await CaptionChecksAsync();
        await TransportChecksAsync();
        Console.WriteLine($"{_checks} native Bilibili/lyrics checks passed.");
    }

    private static async Task AccountChecksAsync()
    {
        IReadOnlyList<BrowserCookie> cookies = Array.Empty<BrowserCookie>();
        var calls = new List<string>();
        using var service = new BilibiliService(_ => Task.FromResult(cookies), new Handler((request, _) => {
            calls.Add(request.Headers.TryGetValues("Cookie", out var values) ? string.Join("; ", values) : "");
            return Task.FromResult(Json(cookies.Count == 0 ? AnonymousNav() : LoggedInNav()));
        }));
        var status = await service.GetAccountAsync(true);
        Assert(!status.LoggedIn && status.Account is null && !status.Guest, "nav -101 is normal signed-out state");
        Assert(service.ContinueAsGuest().Guest, "guest is explicit local access");
        cookies = new[] { AuthCookie("fixture-session") };
        Assert((await service.GetAccountAsync(true)).LoggedIn && calls[^1].Contains("SESSDATA=fixture-session", StringComparison.Ordinal), "browser cookie snapshot reaches official nav");
        cookies = Array.Empty<BrowserCookie>();
        var loggedOut = await service.GetAccountAsync(true);
        Assert(!loggedOut.LoggedIn && loggedOut.Guest && calls[^1] == "", "deleted cookies are absent from following request and guest access survives");
        await RejectAsync(() => service.RequireLoggedInAsync(), "BILIBILI_LOGIN_REQUIRED", "guest cannot read private account data");

        var started = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var requests = 0;
        using var single = new BilibiliService(_ => Task.FromResult<IReadOnlyList<BrowserCookie>>(Array.Empty<BrowserCookie>()), new Handler(async (_, token) => {
            Interlocked.Increment(ref requests); started.TrySetResult(true); await release.Task.WaitAsync(token); return Json(LoggedInNav());
        }));
        var first = single.GetAccountAsync(true);
        await started.Task;
        var second = single.GetAccountAsync(true);
        release.TrySetResult(true);
        await Task.WhenAll(first, second);
        Assert(requests == 1, "concurrent forced checks share one native nav request");

        cookies = new[] { AuthCookie("fixture-old") };
        started = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var changing = new BilibiliService(_ => Task.FromResult(cookies), new Handler(async (_, token) => {
            started.TrySetResult(true); await release.Task.WaitAsync(token); return Json(LoggedInNav());
        }));
        var oldCheck = changing.GetAccountAsync(true);
        await started.Task;
        cookies = new[] { AuthCookie("fixture-new") };
        release.TrySetResult(true);
        await RejectAsync(() => oldCheck, "BILIBILI_SESSION_CHANGED", "cookie switch prevents old account verification reaching UI");

        var failure = false;
        using var resilient = new BilibiliService(_ => Task.FromResult<IReadOnlyList<BrowserCookie>>(new[] { AuthCookie("fixture-session") }), new Handler((_, _) => {
            if (failure) throw new HttpRequestException("Controlled failure");
            return Task.FromResult(Json(LoggedInNav()));
        }));
        Assert((await resilient.GetAccountAsync(true)).LoggedIn, "confirmed account establishes permit");
        failure = true;
        await RejectAsync(() => resilient.GetAccountAsync(true), "NETWORK_ERROR", "network failure remains an error");
        Assert((await resilient.RequireLoggedInAsync()).LoggedIn, "same-cookie network failure retains recent confirmed permit");
        using var malformed = new BilibiliService(_ => Task.FromResult<IReadOnlyList<BrowserCookie>>(Array.Empty<BrowserCookie>()),
            new Handler((_, _) => Task.FromResult(Json(new { code = 0, data = new { mid = 100, uname = "虚构账号" } }))));
        await RejectAsync(() => malformed.GetAccountAsync(true), "BILIBILI_INVALID_RESPONSE", "missing isLogin never becomes authenticated");
    }

    private static async Task SearchChecksAsync()
    {
        IReadOnlyList<BrowserCookie> cookies = Array.Empty<BrowserCookie>();
        var urls = new List<Uri>();
        using var service = new BilibiliService(_ => Task.FromResult(cookies), new Handler((request, _) => {
            urls.Add(request.RequestUri!);
            return Task.FromResult(Json(new { code = 0, data = new { result = new[] {
                new { bvid = "BV1111111111", title = "不相关节目", author = "光年之外", pic = "", duration = "3:00", play = 999 },
                new { bvid = "BV0987654321", title = "光年之外 Live", author = "虚构 UP 主", pic = "", duration = "3:00", play = 1000 },
                new { bvid = "BV1234567890", title = "《光 年，之 外》", author = "虚构 UP 主", pic = "", duration = "3:00", play = 1 },
                new { bvid = "BV2222222222", title = "光年之外 翻唱", author = "虚构 UP 主", pic = "", duration = "3:00", play = 10 },
                new { bvid = "BV3333333333", title = "现场 光年之外", author = "虚构 UP 主", pic = "", duration = "3:00", play = 100 },
            }, numResults = 5, pagesize = 20, numPages = 2 } }));
        }));
        service.ContinueAsGuest();
        var ranked = await service.SearchAsync("光年之外", 1, "song");
        Assert(ranked.Songs.Select(song => song.Bvid).SequenceEqual(new[] { "BV1234567890", "BV0987654321", "BV2222222222", "BV3333333333", "BV1111111111" }) && ranked.HasMore && ranked.Total == 5, "native song mode preserves all official results with stable title relevance and source pagination");
        var video = await service.SearchAsync("光年之外", 1, "video");
        Assert(video.Songs.Select(song => song.Bvid).SequenceEqual(new[] { "BV1111111111", "BV0987654321", "BV1234567890", "BV2222222222", "BV3333333333" }), "native video mode preserves official source order");
        Assert(urls.All(uri => uri.Query.Contains("order=totalrank", StringComparison.Ordinal) && uri.Query.Contains("keyword=%E5%85%89%E5%B9%B4%E4%B9%8B%E5%A4%96", StringComparison.Ordinal)), "native search uses official original keyword/comprehensive ranking");
        await RejectAsync(() => service.SearchAsync("光年之外", 1, "unknown"), "INVALID_SEARCH_MODE", "invalid mode never reaches network");
        await RejectAsync(() => service.SearchAsync("， ！", 1, "song"), "INVALID_QUERY", "punctuation-only song queries rejected");

        using var multiword = new BilibiliService(_ => Task.FromResult(cookies), new Handler((request, _) => Task.FromResult(Json(new { code = 0, data = new { result = new[] {
            new { bvid = "BV1111111111", title = "不相关节目", author = "晴天 周杰伦 Live", pic = "", duration = "3:00", play = 1 },
            new { bvid = "BV2222222222", title = "晴天", author = "虚构 UP 主", pic = "", duration = "3:00", play = 1 },
            new { bvid = "BV3333333333", title = "晴天 周杰伦 Live", author = "虚构 UP 主", pic = "", duration = "3:00", play = 1 },
            new { bvid = "BV4444444444", title = "周杰伦 现场 晴天", author = "虚构 UP 主", pic = "", duration = "3:00", play = 1 },
        }, numResults = 4, pagesize = 20, numPages = 1 } }))));
        multiword.ContinueAsGuest();
        Assert((await multiword.SearchAsync("周杰伦 晴天", 1, "song")).Songs.Select(song => song.Bvid).SequenceEqual(new[] { "BV3333333333", "BV4444444444", "BV2222222222", "BV1111111111" }), "native ranking supports reverse-order query tokens without uploader inference");
        Assert((await multiword.SearchAsync("晴天 Live", 1, "song")).Songs.Select(song => song.Bvid).SequenceEqual(new[] { "BV3333333333", "BV2222222222", "BV4444444444", "BV1111111111" }), "native ranking supports version tokens and preserves unmatched titles");

        foreach (var response in new object[] { Array.Empty<object>(), new { code = 0 }, new { code = 0, data = new { } },
            new { code = 0, data = Array.Empty<object>() }, new { code = 0, data = new { result = (object?)null } }, new { code = 0, data = new { result = new { } } } })
        {
            using var malformed = new BilibiliService(_ => Task.FromResult(cookies), new Handler((_, _) => Task.FromResult(Json(response))));
            malformed.ContinueAsGuest();
            await RejectAsync(() => malformed.SearchAsync("晴天", 1, "song"), "BILIBILI_INVALID_RESPONSE", "malformed official search result container is not an empty result");
        }
        using var empty = new BilibiliService(_ => Task.FromResult(cookies), new Handler((_, _) => Task.FromResult(Json(new { code = 0, data = new { result = Array.Empty<object>(), numResults = 40, numPages = 2, pagesize = 20 } }))));
        empty.ContinueAsGuest();
        var emptyPage = await empty.SearchAsync("晴天", 1, "song");
        Assert(emptyPage.Songs.Count == 0 && emptyPage.Total == 40 && emptyPage.HasMore, "valid empty search array preserves official pagination");
    }

    private static async Task SuggestionChecksAsync()
    {
        var cookies = new[] { AuthCookie("fixture-session") };
        var calls = new List<Uri>();
        using var service = new BilibiliService(_ => Task.FromResult<IReadOnlyList<BrowserCookie>>(cookies), new Handler((request, _) =>
        {
            var uri = request.RequestUri!;
            calls.Add(uri);
            Assert(uri.Host == "s.search.bilibili.com" && uri.AbsolutePath == "/main/suggest", "native suggestions use only the explicit official endpoint");
            Assert(request.Headers.TryGetValues("Cookie", out var values) && string.Join("; ", values).Contains("SESSDATA=fixture-session", StringComparison.Ordinal) && request.Headers.Referrer?.ToString() == "https://www.bilibili.com/", "native official suggestions carry the browser cookie snapshot and official Referer");
            var tags = new List<object> { new { value = "<em>晴天</em>" }, new { value = "晴天" }, new { value = "&lt;b&gt;夜曲&lt;/b&gt;\u0000\u200b" }, new { value = 123 }, new { unknown = "不接受" }, new { value = new string('x', 150) } };
            tags.AddRange(Enumerable.Range(0, 20).Select(index => (object)new { value = $"建议{index}" }));
            return Task.FromResult(Json(new { result = new { tag = tags } }));
        }));
        service.ContinueAsGuest();
        var suggestions = await service.SearchSuggestionsAsync("  晴天 + Live  ");
        Assert(suggestions.Count == 10 && suggestions.Take(3).SequenceEqual(new[] { "晴天", "夜曲", new string('x', 100) }), "native suggestions decode markup, remove controls, deduplicate and bound count/length");
        Assert(calls.Single().Query.Contains("term=%E6%99%B4%E5%A4%A9%20%2B%20Live", StringComparison.Ordinal), "native suggestions preserve trimmed original input");
        Assert((await service.SearchSuggestionsAsync("  ")).Count == 0 && calls.Count == 1, "blank suggestions make no network request");
        await RejectAsync(() => service.SearchSuggestionsAsync(new string('x', 201)), "INVALID_QUERY", "oversized suggestion input rejected before network");

        using var denied = new BilibiliService(_ => Task.FromResult<IReadOnlyList<BrowserCookie>>(Array.Empty<BrowserCookie>()), new Handler((_, _) => Task.FromResult(Json(AnonymousNav()))));
        await RejectAsync(() => denied.SearchSuggestionsAsync("晴天"), "BILIBILI_LOGIN_REQUIRED", "suggestions still require guest or verified account access");
        using var fallback = new BilibiliService(_ => Task.FromResult<IReadOnlyList<BrowserCookie>>(Array.Empty<BrowserCookie>()), new Handler((_, _) => Task.FromResult(Json(new { code = 0, data = new { tag = new[] { new { value = "备用结构" } } } }))));
        fallback.ContinueAsGuest();
        Assert((await fallback.SearchSuggestionsAsync("晴天")).SequenceEqual(new[] { "备用结构" }), "native suggestions accept only the known alternate tag shape");

        foreach (var response in new object[] { Array.Empty<object>(), new { }, new { code = 0 }, new { result = new { } },
            new { result = new { tag = (object?)null } }, new { data = new { tag = new { } } } })
        {
            using var malformed = new BilibiliService(_ => Task.FromResult<IReadOnlyList<BrowserCookie>>(Array.Empty<BrowserCookie>()), new Handler((_, _) => Task.FromResult(Json(response))));
            malformed.ContinueAsGuest();
            await RejectAsync(() => malformed.SearchSuggestionsAsync("晴天"), "BILIBILI_INVALID_RESPONSE", "malformed suggestion tags are not a successful empty suggestion response");
        }
        foreach (var response in new object[] { new { result = new { tag = Array.Empty<object>() } }, new { code = 0, data = new { tag = Array.Empty<object>() } } })
        {
            using var empty = new BilibiliService(_ => Task.FromResult<IReadOnlyList<BrowserCookie>>(Array.Empty<BrowserCookie>()), new Handler((_, _) => Task.FromResult(Json(response))));
            empty.ContinueAsGuest();
            Assert((await empty.SearchSuggestionsAsync("晴天")).Count == 0, "valid empty primary or fallback suggestion array is accepted");
        }
    }

    private static async Task CaptionChecksAsync()
    {
        var calls = new List<(Uri Uri, bool Cookie)>();
        object[] candidates = { new { lan = "zh-CN", lan_doc = "中文（中国）", subtitle_url = "https://i0.hdslb.com/bfs/subtitle/manual.json" },
            new { lan = "ai-zh", lan_doc = "中文（自动生成）", subtitle_url = "//aisubtitle.hdslb.com/bfs/ai_subtitle/test.json" } };
        var needsLogin = false;
        using var service = new BilibiliService(_ => Task.FromResult<IReadOnlyList<BrowserCookie>>(new[] { AuthCookie("fixture-session") }), new Handler((request, _) => {
            var uri = request.RequestUri!;
            calls.Add((uri, request.Headers.Contains("Cookie")));
            object payload = uri.AbsolutePath switch {
                "/x/web-interface/view" => new { code = 0, data = new { aid = 100, cid = 900, pages = new[] { new { cid = 200, duration = 100 } } } },
                "/x/web-interface/nav" => AnonymousNav(),
                "/x/player/wbi/v2" => new { code = 0, data = new { need_login_subtitle = needsLogin, subtitle = new { subtitles = candidates } } },
                _ => new { body = new[] { new { from = 2.25, to = 4d, content = "第一句字幕" }, new { from = 6d, to = 8.5, content = "第二句字幕" } } },
            };
            return Task.FromResult(Json(payload));
        }));
        var result = await service.LookupLyricsAsync(new LyricsRequest(TestSong, Provider: "bilibili"));
        Assert(result.Subtitle?.IsAI == true && result.Subtitle.Language == "ai-zh" && result.Match?.Id == 200 && result.Match.ArtistName == "", "native captions use first P and explicit AI/language metadata");
        Assert(result.Match?.SyncedLyrics == "[00:02.250]第一句字幕\n[00:04.000]\n[00:06.000]第二句字幕\n[00:08.500]", "native transport returns synchronized video timeline");
        Assert(calls.Last().Uri.Host == "aisubtitle.hdslb.com" && !calls.Last().Cookie && calls.Take(3).All(call => call.Cookie), "caption CDN receives no session cookie while official metadata does");
        Assert(calls.Any(call => call.Uri.AbsolutePath == "/x/player/wbi/v2" && call.Uri.Query.Contains("cid=200", StringComparison.Ordinal) && call.Uri.Query.Contains("w_rid=", StringComparison.Ordinal)), "actual metadata request includes WBI signature and first cid");
        candidates = new object[] { new { lan = "zh-CN", lan_doc = "中文（中国）", subtitle_url = "https://i0.hdslb.com/bfs/subtitle/manual.json" } };
        result = await service.LookupLyricsAsync(new LyricsRequest(TestSong, Force: true, Provider: "bilibili"));
        Assert(result.Subtitle?.IsAI == false && result.Message?.Contains("UP 主字幕", StringComparison.Ordinal) == true, "native manual captions retain human label");
        candidates = Array.Empty<object>(); needsLogin = true;
        result = await service.LookupLyricsAsync(new LyricsRequest(TestSong, Force: true, Provider: "bilibili"));
        Assert(result.RequiresLogin && result.Match is null && result.Message?.Contains("不会", StringComparison.Ordinal) == true, "login-required result never pretends to generate captions");
        candidates = new object[] { new { lan = "ai-zh", lan_doc = "中文（自动生成）", subtitle_url = "https://evil.test/caption.json" } };
        needsLogin = false;
        var count = calls.Count;
        await RejectAsync(() => service.LookupLyricsAsync(new LyricsRequest(TestSong, Force: true, Provider: "bilibili")), "SUBTITLES_UNSUPPORTED", "untrusted caption URL rejected");
        Assert(calls.Skip(count).All(call => call.Uri.Host == "api.bilibili.com"), "no request reaches untrusted caption host");
    }

    private static async Task TransportChecksAsync()
    {
        using var lrclib = new BilibiliService(_ => Task.FromResult<IReadOnlyList<BrowserCookie>>(new[] { AuthCookie("fixture-session") }), new Handler((request, _) => {
            Assert(!request.Headers.Contains("Cookie"), "LRCLIB receives no Bilibili cookie");
            return Task.FromResult(Json(new[] { new { id = 1, trackName = "虚构歌曲", artistName = "虚构歌手", albumName = (string?)null, duration = 100, instrumental = false, syncedLyrics = "[00:02]第一句", plainLyrics = "第一句" } }));
        }));
        Assert((await lrclib.LookupLyricsCandidatesAsync("虚构歌曲")).Count == 1, "validated native LRCLIB candidates reach shared renderer matcher");
        await RejectAsync(() => lrclib.LookupLyricsCandidatesAsync(new string('x', 201)), "LYRICS_INVALID_REQUEST", "query length bound");
        using var oversized = new BilibiliService(_ => Task.FromResult<IReadOnlyList<BrowserCookie>>(Array.Empty<BrowserCookie>()), new Handler((_, _) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(new string('x', 2 * 1024 * 1024 + 1)) })));
        await RejectAsync(() => oversized.LookupLyricsCandidatesAsync("fixture"), "RESPONSE_TOO_LARGE", "oversized network response rejected");
        using var redirect = new BilibiliService(_ => Task.FromResult<IReadOnlyList<BrowserCookie>>(Array.Empty<BrowserCookie>()), new Handler((_, _) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.Redirect) { Headers = { Location = new Uri("https://evil.test/") } })));
        await RejectAsync(() => redirect.LookupLyricsCandidatesAsync("fixture"), "LYRICS_HTTP_ERROR", "redirect response never accepted");
        using var timeout = new BilibiliService(_ => Task.FromResult<IReadOnlyList<BrowserCookie>>(Array.Empty<BrowserCookie>()), new Handler(async (_, token) =>
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, token); return Json(Array.Empty<object>());
        }), requestTimeout: TimeSpan.FromMilliseconds(30));
        await RejectAsync(() => timeout.LookupLyricsCandidatesAsync("fixture"), "LYRICS_TIMEOUT", "request timeout covers headers and body");
    }

    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => send(request, cancellationToken);
    }
}
