using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Yuyin.WindowsHost;

public static class CommentsTests
{
    private const string Bvid = "BV1234567890";
    private const string Oid = "170001";
    private const string RootId = "9007199254740993";
    private const string ChildId = "9007199254740995";
    private const string Csrf = "0123456789abcdef0123456789abcdef";
    private static int _checks;
    private static void Assert(bool condition, string name) { if (!condition) throw new Exception("FAIL: " + name); _checks++; }
    private static async Task RejectAsync(Func<Task> operation, string code, string name)
    {
        try { await operation(); } catch (BilibiliServiceException error) when (error.Code == code) { _checks++; return; }
        throw new Exception("FAIL: " + name);
    }
    private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };
    private static IReadOnlyList<BrowserCookie> Cookies(bool csrf = true, string session = "fixture-session") => csrf ?
        new[] { new BrowserCookie("SESSDATA", session, ".bilibili.com", "/", true), new BrowserCookie("bili_jct", Csrf, ".bilibili.com", "/", true) } :
        new[] { new BrowserCookie("SESSDATA", session, ".bilibili.com", "/", true) };
    private static object Nav(long mid = 100) => new { code = 0, data = new { isLogin = true, mid, uname = "虚构测试账号", face = "" } };
    private static object View(string oid = Oid) => new { code = 0, data = new { aid = oid, bvid = Bvid } };
    private static object Comment(string id = RootId, string root = "0", string parent = "0", string oid = Oid, object[]? replies = null, int state = 0) => new {
        rpid_str = id, oid_str = oid, root_str = root, parent_str = parent, type = 1, ctime = 1700000000,
        like = 5, rcount = 21, action = 1, state,
        member = new { mid = "100", uname = "虚构评论作者", avatar = "https://evil.test/avatar.png" },
        content = new { message = "这是字面 <b>文本</b>，不是网页\n第二行" }, replies = replies ?? Array.Empty<object>(),
    };
    private static object Page(int page = 1, int count = 21, object[]? comments = null) => new { code = 0, data = new {
        page = new { num = page, size = 20, count }, replies = comments ?? new[] { Comment(replies: new[] { Comment(ChildId, RootId, RootId) }) },
    } };
    private static BilibiliService Service(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler, Func<IReadOnlyList<BrowserCookie>>? cookies = null, TimeSpan? timeout = null) =>
        new(_ => Task.FromResult(cookies?.Invoke() ?? Cookies()), new Handler(handler), requestTimeout: timeout);
    private static Dictionary<string, string> Form(string text) => text.Split('&').Select(pair => pair.Split('=', 2)).ToDictionary(pair => Uri.UnescapeDataString(pair[0].Replace('+', ' ')), pair => Uri.UnescapeDataString(pair[1].Replace('+', ' ')));
    private static Task<HttpResponseMessage> Fixture(HttpRequestMessage request, CancellationToken _) => Task.FromResult(Json(request.RequestUri!.AbsolutePath switch {
        "/x/web-interface/nav" => Nav(), "/x/web-interface/view" => View(), "/x/v2/reply" => Page(),
        "/x/v2/reply/reply" => new { code = 0, data = new { page = new { num = 1, size = 20, count = 21 }, root = Comment(), replies = new[] { Comment(ChildId, RootId, RootId) } } },
        _ => new { code = 0, data = new { } },
    }));

    public static async Task RunAsync()
    {
        _checks = 0;
        await ReadChecks(); await ValidationChecks(); await WriteChecks(); await RaceChecks(); await FailureChecks();
        Console.WriteLine($"{_checks} native Bilibili comment checks passed.");
    }

    private static async Task ReadChecks()
    {
        var requests = new List<Uri>();
        using var service = Service((request, token) => { requests.Add(request.RequestUri!); return Fixture(request, token); }, () => Array.Empty<BrowserCookie>());
        service.ContinueAsGuest();
        var hot = await service.GetVideoCommentsAsync(Bvid, "hot");
        Assert(hot.Oid == Oid && hot.Sort == "hot" && hot.PageSize == 20 && hot.Total == 21 && hot.HasMore && !hot.Closed, "guest comments use official aid and bounded pagination");
        Assert(hot.Comments[0].Id == RootId && hot.Comments[0].Replies[0].Id == ChildId, "reply IDs beyond JS safe integer remain exact strings");
        Assert(hot.Comments[0].Message.Contains("<b>", StringComparison.Ordinal) && hot.Comments[0].CreatedAt == 1700000000 && hot.Comments[0].Liked && hot.Comments[0].Author.Avatar == "", "plain comment text and source seconds preserved, untrusted avatar removed");
        await service.GetVideoCommentsAsync(Bvid, "new");
        Assert(requests.Where(uri => uri.AbsolutePath == "/x/v2/reply").Select(uri => uri.Query).SequenceEqual(new[] { "?type=1&oid=170001&sort=2&pn=1&ps=20", "?type=1&oid=170001&sort=0&pn=1&ps=20" }), "hot/new map to official source sort without ranking");
        var replies = await service.GetCommentRepliesAsync(Bvid, RootId);
        Assert(replies.RootId == RootId && replies.Total == 21 && replies.HasMore && replies.Comments.Single().ParentId == RootId, "thread paging and hierarchy retained");
        Assert(requests.Any(uri => uri.Query.Contains("root=" + RootId, StringComparison.Ordinal)) && requests.All(uri => uri.Scheme == "https" && uri.Host == "api.bilibili.com") && requests.All(uri => uri.AbsolutePath != "/x/web-interface/nav"), "guest reads do not require account nav and only contact official HTTPS");

        using var pinned = Service((request, _) => Task.FromResult(Json(request.RequestUri!.AbsolutePath == "/x/web-interface/view" ? View() : new { code = 0, data = new {
            page = new { num = 1, size = 20, count = 1 }, top_replies = new[] { Comment() }, top = new { upper = Comment(), admin = (object?)null }, replies = new[] { Comment() },
        } })));
        pinned.ContinueAsGuest();
        Assert((await pinned.GetVideoCommentsAsync(Bvid, "hot")).Comments.Count == 1, "pinned/regular comments are deduplicated by exact ID");
        using var empty = Service((request, _) => Task.FromResult(Json(request.RequestUri!.AbsolutePath == "/x/web-interface/view" ? View() : new { code = 0, data = new { page = new { num = 2, size = 20, count = 21 }, replies = (object?)null } })));
        empty.ContinueAsGuest();
        var emptyPage = await empty.GetVideoCommentsAsync(Bvid, "new", 2);
        Assert(emptyPage.Comments.Count == 0 && !emptyPage.HasMore && emptyPage.Total == 21, "valid null replies retain source pagination as empty");
        using var closed = Service((request, _) => Task.FromResult(Json(request.RequestUri!.AbsolutePath == "/x/web-interface/view" ? View() : new { code = 12002, message = "closed" })));
        closed.ContinueAsGuest();
        Assert((await closed.GetVideoCommentsAsync(Bvid, "hot")).Closed, "explicit source closed-comments code becomes a closed page");
    }

    private static async Task ValidationChecks()
    {
        var calls = 0;
        using var service = Service((request, token) => { calls++; return Fixture(request, token); });
        service.ContinueAsGuest();
        await RejectAsync(() => service.GetVideoCommentsAsync("https://evil.test/", "hot"), "COMMENTS_INVALID_REQUEST", "invalid BV rejected before network");
        await RejectAsync(() => service.GetVideoCommentsAsync(Bvid, "unknown"), "COMMENTS_INVALID_REQUEST", "invalid sort rejected before network");
        await RejectAsync(() => service.GetVideoCommentsAsync(Bvid, "hot", 0), "COMMENTS_INVALID_REQUEST", "invalid page rejected before network");
        await RejectAsync(() => service.GetCommentRepliesAsync(Bvid, "1&root=2"), "COMMENTS_INVALID_REQUEST", "comment ID query injection rejected");
        await RejectAsync(() => service.SetCommentLikeAsync(Bvid, RootId, true, 0), "COMMENTS_INVALID_REQUEST", "invalid expected account rejected");
        await RejectAsync(() => service.CreateCommentAsync(new(Bvid, " ", null, null, 100)), "COMMENTS_INVALID_REQUEST", "empty message rejected");
        await RejectAsync(() => service.CreateCommentAsync(new(Bvid, new string('x', 1001), null, null, 100)), "COMMENTS_INVALID_REQUEST", "oversized message rejected");
        await RejectAsync(() => service.CreateCommentAsync(new(Bvid, "x\0", null, null, 100)), "COMMENTS_INVALID_REQUEST", "control injection rejected");
        await RejectAsync(() => service.CreateCommentAsync(new(Bvid, "x", null, RootId, 100)), "COMMENTS_INVALID_REQUEST", "child reply without root rejected");
        Assert(calls == 0, "all invalid comment inputs make zero requests");
        foreach (var invalid in new object[] { new { code = 0 }, new { code = 0, data = new { page = new { num = 1, size = 20, count = 0 } } },
            new { code = 0, data = new { page = new { num = 2, size = 20, count = 0 }, replies = Array.Empty<object>() } },
            Page(comments: new[] { Comment(oid: "170002") }), Page(comments: new[] { Comment(root: "0", parent: RootId) }) })
        {
            using var malformed = Service((request, _) => Task.FromResult(Json(request.RequestUri!.AbsolutePath == "/x/web-interface/view" ? View() : invalid)));
            malformed.ContinueAsGuest();
            await RejectAsync(() => malformed.GetVideoCommentsAsync(Bvid, "hot"), "COMMENTS_INVALID_RESPONSE", "malformed or wrong-video list never becomes success empty");
        }
        using var wrongRoot = Service((request, _) => Task.FromResult(Json(request.RequestUri!.AbsolutePath == "/x/web-interface/view" ? View() : new { code = 0, data = new { root = Comment(ChildId), page = new { num = 1, size = 20, count = 0 }, replies = Array.Empty<object>() } })));
        wrongRoot.ContinueAsGuest();
        await RejectAsync(() => wrongRoot.GetCommentRepliesAsync(Bvid, RootId), "COMMENTS_INVALID_RESPONSE", "thread root must match requested exact ID");
    }

    private static async Task WriteChecks()
    {
        var posts = new List<(Uri Uri, Dictionary<string, string> Form, string Cookie)>();
        var addResponse = (object)new { code = 0, data = new { reply = Comment("9007199254740999") } };
        using var service = Service(async (request, token) => {
            if (request.Method != HttpMethod.Post) return await Fixture(request, token);
            var form = Form(await request.Content!.ReadAsStringAsync(token));
            posts.Add((request.RequestUri!, form, string.Join(";", request.Headers.GetValues("Cookie"))));
            return Json(request.RequestUri!.AbsolutePath == "/x/v2/reply/add" ? addResponse : new { code = 0, data = new { } });
        });
        service.ContinueAsGuest(); await service.GetVideoCommentsAsync(Bvid, "hot");
        var liked = await service.SetCommentLikeAsync(Bvid, RootId, true, 100);
        var unliked = await service.SetCommentLikeAsync(Bvid, RootId, false, 100);
        Assert(liked.Id == RootId && liked.Liked && !unliked.Liked && posts[0].Form["action"] == "1" && posts[1].Form["action"] == "0", "like/unlike explicit desired state matches source action");
        Assert(posts.All(post => post.Uri.Host == "api.bilibili.com" && post.Uri.Scheme == "https" && post.Form["oid"] == Oid && post.Form["type"] == "1" && post.Form["csrf"] == Csrf && post.Form["csrf_token"] == Csrf && post.Cookie.Contains("SESSDATA=fixture-session", StringComparison.Ordinal)), "native POST carries source identity/CSRF only to official endpoints");
        var posted = await service.CreateCommentAsync(new(Bvid, "正文 + & 😃\n换行", null, null, 100));
        Assert(posted.Comment?.Id == "9007199254740999" && !posted.PendingReview && posts[^1].Form["message"] == "正文 + & 😃\n换行" && posts[^1].Form["root"] == "0" && posts[^1].Form["parent"] == "0", "form encoding preserves user content and full visible reply receipt");
        addResponse = new { code = 0, data = new { reply = Comment("9007199254740998", RootId, ChildId) } };
        await service.CreateCommentAsync(new(Bvid, "显式回复", RootId, ChildId, 100));
        Assert(posts[^1].Form["root"] == RootId && posts[^1].Form["parent"] == ChildId, "reply target uses current-session loaded exact root/parent");
        var before = posts.Count;
        await RejectAsync(() => service.SetCommentLikeAsync(Bvid, "777", true, 100), "COMMENTS_TARGET_CHANGED", "unknown comment target refused before POST");
        await RejectAsync(() => service.SetCommentLikeAsync(Bvid, RootId, true, 200), "BILIBILI_SESSION_CHANGED", "renderer cannot choose a different account");
        await RejectAsync(() => service.CreateCommentAsync(new(Bvid, "x", ChildId, ChildId, 100)), "COMMENTS_TARGET_CHANGED", "child cannot be used as thread root");
        Assert(posts.Count == before, "target and expected account failures never write");
        addResponse = new { code = 0, data = new { } };
        Assert((await service.CreateCommentAsync(new(Bvid, "只有接收回执", null, null, 100))).PendingReview, "missing visible reply stays unconfirmed instead of claiming publication");
        addResponse = new { code = 0, data = new { reply = Comment("9007199254740997", state: 1), success_toast = "评论需要审核" } };
        Assert((await service.CreateCommentAsync(new(Bvid, "待核对", null, null, 100))).PendingReview, "review marker stays unconfirmed");
        addResponse = new { code = 0, data = new { need_captcha = 1 } };
        await RejectAsync(() => service.CreateCommentAsync(new(Bvid, "验证", null, null, 100)), "BILIBILI_VERIFICATION_REQUIRED", "source captcha asks verification without automatic retry");

        var missingPosts = 0;
        using var missingCsrf = Service((request, token) => { if (request.Method == HttpMethod.Post) missingPosts++; return Fixture(request, token); }, () => Cookies(false));
        missingCsrf.ContinueAsGuest(); await missingCsrf.GetVideoCommentsAsync(Bvid, "hot");
        await RejectAsync(() => missingCsrf.SetCommentLikeAsync(Bvid, RootId, true, 100), "BILIBILI_CSRF_REQUIRED", "missing native CSRF cannot write");
        Assert(missingPosts == 0, "missing CSRF makes no POST");
        using var guest = Service((_, _) => Task.FromResult(Json(new { code = -101, data = new { isLogin = false } })), () => Array.Empty<BrowserCookie>());
        guest.ContinueAsGuest();
        await RejectAsync(() => guest.CreateCommentAsync(new(Bvid, "x", null, null, 100)), "BILIBILI_LOGIN_REQUIRED", "guest access does not permit writes");
    }

    private static async Task RaceChecks()
    {
        var cookies = Cookies(); var posts = 0; var switchBefore = false; var switchAfter = false;
        using var service = Service(async (request, token) => {
            if (switchBefore && request.RequestUri!.AbsolutePath == "/x/web-interface/view") cookies = Cookies(session: "fixture-new-account");
            if (request.Method == HttpMethod.Post) { posts++; if (switchAfter) cookies = Cookies(session: "fixture-newer-account"); return Json(new { code = 0, data = new { } }); }
            return await Fixture(request, token);
        }, () => cookies);
        service.ContinueAsGuest(); await service.GetVideoCommentsAsync(Bvid, "hot");
        switchBefore = true;
        await RejectAsync(() => service.SetCommentLikeAsync(Bvid, RootId, true, 100), "BILIBILI_SESSION_CHANGED", "cookie switch after nav and before POST refuses old operation");
        Assert(posts == 0, "account switched before send makes no write");
        switchBefore = false; await service.GetVideoCommentsAsync(Bvid, "hot"); switchAfter = true;
        await RejectAsync(() => service.SetCommentLikeAsync(Bvid, RootId, true, 100), "BILIBILI_SESSION_CHANGED", "cookie switch during POST rejects stale receipt");
        Assert(posts == 1, "ambiguous stale receipt never repeats POST");

        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var busy = Service(async (request, token) => {
            if (request.RequestUri!.AbsolutePath == "/x/web-interface/nav") { entered.TrySetResult(); await release.Task.WaitAsync(token); }
            return await Fixture(request, token);
        });
        var first = busy.CreateCommentAsync(new(Bvid, "第一次提交", null, null, 100)); await entered.Task;
        await RejectAsync(() => busy.CreateCommentAsync(new(Bvid, "重复点击", null, null, 100)), "COMMENTS_WRITE_BUSY", "second concurrent write is rejected instead of queued/replayed");
        release.TrySetResult(); await first;
    }

    private static async Task FailureChecks()
    {
        var posts = 0;
        using var failed = Service(async (request, token) => {
            if (request.Method != HttpMethod.Post) return await Fixture(request, token);
            posts++; throw new HttpRequestException("Controlled transport failure");
        });
        failed.ContinueAsGuest(); await failed.GetVideoCommentsAsync(Bvid, "hot");
        await RejectAsync(() => failed.SetCommentLikeAsync(Bvid, RootId, true, 100), "COMMENTS_WRITE_UNKNOWN", "network failure reports uncertain result");
        Assert(posts == 1, "network failure is never automatically retried");
        using var timeout = Service(async (request, token) => { if (request.Method == HttpMethod.Post) { await Task.Delay(Timeout.Infinite, token); } return await Fixture(request, token); }, timeout: TimeSpan.FromMilliseconds(40));
        await RejectAsync(() => timeout.CreateCommentAsync(new(Bvid, "x", null, null, 100)), "COMMENTS_WRITE_UNKNOWN", "write timeout is bounded and uncertain");
        using var redirect = Service(async (request, token) => request.Method == HttpMethod.Post ? new HttpResponseMessage(HttpStatusCode.Redirect) { Headers = { Location = new Uri("https://evil.test/") } } : await Fixture(request, token));
        await RejectAsync(() => redirect.CreateCommentAsync(new(Bvid, "x", null, null, 100)), "COMMENTS_WRITE_UNKNOWN", "POST redirect is never followed or accepted");
        using var malformed = Service(async (request, token) => request.Method == HttpMethod.Post ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("<html>verification</html>") } : await Fixture(request, token));
        await RejectAsync(() => malformed.CreateCommentAsync(new(Bvid, "x", null, null, 100)), "COMMENTS_WRITE_UNKNOWN", "invalid POST receipt never becomes publication success");
        using var oversized = Service(async (request, token) => request.Method == HttpMethod.Post ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(new string('x', 2 * 1024 * 1024 + 1)) } : await Fixture(request, token));
        await RejectAsync(() => oversized.CreateCommentAsync(new(Bvid, "x", null, null, 100)), "COMMENTS_WRITE_UNKNOWN", "POST body limit enforced");
        using var rate = Service(async (request, token) => request.Method == HttpMethod.Post ? Json(new { code = 12014, message = "rate" }) : await Fixture(request, token));
        await RejectAsync(() => rate.CreateCommentAsync(new(Bvid, "x", null, null, 100)), "COMMENTS_RATE_LIMITED", "source comment rate restriction is explicit");
    }

    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => send(request, cancellationToken);
    }
}
