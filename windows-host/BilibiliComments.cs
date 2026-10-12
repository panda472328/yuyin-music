using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Yuyin.WindowsHost;

/// Reads existing video replies and performs only explicit renderer writes.
/// CSRF and cookies remain entirely in the native host; POST requests are never retried.
public sealed partial class BilibiliService
{
    private const int CommentPageSize = 20;
    private const int MaxCommentLength = 1000;
    private readonly Dictionary<string, (string Bvid, string Oid, string Root, long Revision)> _commentTargets = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _commentWriteGate = new(1, 1);

    public async Task<VideoCommentsPage> GetVideoCommentsAsync(string bvid, string sort, int page = 1)
    {
        ValidateCommentVideo(bvid);
        ValidateCommentPage(page);
        if (sort is not ("hot" or "new")) throw CommentError("评论排序无效。", "COMMENTS_INVALID_REQUEST");
        await EnsurePlaybackAccessAsync();
        var revision = CaptureRevision();
        var oid = await CommentVideoOidAsync(bvid, revision);
        var payload = await GetJsonAsync($"{ApiOrigin}/x/v2/reply?{Query(new Dictionary<string, string> {
            ["type"] = "1", ["oid"] = oid, ["sort"] = sort == "hot" ? "2" : "0",
            ["pn"] = page.ToString(CultureInfo.InvariantCulture), ["ps"] = CommentPageSize.ToString(CultureInfo.InvariantCulture),
        })}", true);
        await AssertSessionUnchangedAsync(revision);
        // Source code 12002 explicitly means this video's comments are closed.
        if (Number(Property(payload, "code")) == 12002) return new(bvid, oid, sort, page, CommentPageSize, 0, false, true, Array.Empty<VideoComment>());
        EnsureCommentApiSuccess(payload, "评论读取失败");
        var data = CommentData(payload);
        var paging = CommentPaging(data, page);
        var comments = new List<VideoComment>();
        if (page == 1)
        {
            var top = Property(data, "top_replies");
            AddComments(comments, top, oid);
            var pinned = Property(data, "top");
            if (pinned.ValueKind == JsonValueKind.Object)
                foreach (var item in pinned.EnumerateObject())
                    if (item.Value.ValueKind == JsonValueKind.Object) comments.Add(ParseComment(item.Value, oid, 0));
        }
        AddComments(comments, Property(data, "replies"), oid, required: true);
        comments = comments.DistinctBy(comment => comment.Id).ToList();
        await AssertSessionUnchangedAsync(revision);
        RememberComments(bvid, oid, comments, revision);
        var closed = Property(data, "state").ValueKind == JsonValueKind.Number && Number(Property(data, "state")) == 2;
        return new(bvid, oid, sort, paging.Page, paging.Size, paging.Total, !closed && (long)paging.Page * paging.Size < paging.Total, closed, comments);
    }

    public async Task<VideoRepliesPage> GetCommentRepliesAsync(string bvid, string rootId, int page = 1)
    {
        ValidateCommentVideo(bvid);
        ValidateCommentId(rootId);
        ValidateCommentPage(page);
        await EnsurePlaybackAccessAsync();
        var revision = CaptureRevision();
        var oid = await CommentVideoOidAsync(bvid, revision);
        var payload = await GetJsonAsync($"{ApiOrigin}/x/v2/reply/reply?{Query(new Dictionary<string, string> {
            ["type"] = "1", ["oid"] = oid, ["root"] = rootId,
            ["pn"] = page.ToString(CultureInfo.InvariantCulture), ["ps"] = CommentPageSize.ToString(CultureInfo.InvariantCulture),
        })}", true);
        await AssertSessionUnchangedAsync(revision);
        EnsureCommentApiSuccess(payload, "回复读取失败");
        var data = CommentData(payload);
        var root = ParseComment(Property(data, "root"), oid, 0);
        if (root.Id != rootId || root.RootId != "0") throw CommentError("回复所属评论不一致，请重新加载。", "COMMENTS_INVALID_RESPONSE");
        var paging = CommentPaging(data, page);
        var comments = new List<VideoComment>();
        AddComments(comments, Property(data, "replies"), oid, required: true);
        if (comments.Any(comment => comment.RootId != rootId)) throw CommentError("回复所属评论不一致，请重新加载。", "COMMENTS_INVALID_RESPONSE");
        comments = comments.DistinctBy(comment => comment.Id).ToList();
        await AssertSessionUnchangedAsync(revision);
        RememberComments(bvid, oid, new[] { root }.Concat(comments), revision);
        return new(bvid, rootId, paging.Page, paging.Size, paging.Total, (long)paging.Page * paging.Size < paging.Total, comments);
    }

    public async Task<CommentLikeResult> SetCommentLikeAsync(string bvid, string id, bool liked, long expectedMid)
    {
        ValidateCommentVideo(bvid); ValidateCommentId(id); ValidateCommentMid(expectedMid);
        if (!await _commentWriteGate.WaitAsync(0, _lifetime.Token)) throw CommentError("另一条评论操作正在提交，请稍候。", "COMMENTS_WRITE_BUSY");
        try
        {
            var (revision, oid) = await PrepareCommentWriteAsync(bvid, expectedMid);
            RequireCommentTarget(bvid, oid, id, revision);
            var payload = await PostCommentAsync("/x/v2/reply/action", new Dictionary<string, string> {
                ["oid"] = oid, ["type"] = "1", ["rpid"] = id, ["action"] = liked ? "1" : "0",
            }, revision, expectedMid);
            EnsureCommentApiSuccess(payload, liked ? "评论点赞失败" : "取消点赞失败");
            return new(id, liked);
        }
        finally { _commentWriteGate.Release(); }
    }

    public async Task<CommentCreateResult> CreateCommentAsync(CommentCreateRequest request)
    {
        if (request is null) throw CommentError("评论参数无效。", "COMMENTS_INVALID_REQUEST");
        ValidateCommentVideo(request.Bvid); ValidateCommentMid(request.ExpectedMid);
        if (string.IsNullOrWhiteSpace(request.Message) || request.Message.Length > MaxCommentLength || request.Message.Any(character => char.IsControl(character) && character is not ('\n' or '\r' or '\t')))
            throw CommentError("请输入 1 到 1000 个字符的评论。", "COMMENTS_INVALID_REQUEST");
        var root = request.RootId ?? "0"; var parent = request.ParentId ?? root;
        ValidateCommentId(root, allowZero: true); ValidateCommentId(parent, allowZero: true);
        if (root == "0" && parent != "0") throw CommentError("回复目标无效，请重新选择评论。", "COMMENTS_INVALID_REQUEST");
        if (!await _commentWriteGate.WaitAsync(0, _lifetime.Token)) throw CommentError("另一条评论操作正在提交，请稍候。", "COMMENTS_WRITE_BUSY");
        try
        {
            var (revision, oid) = await PrepareCommentWriteAsync(request.Bvid, request.ExpectedMid);
            if (root != "0")
            {
                var rootTarget = RequireCommentTarget(request.Bvid, oid, root, revision);
                var parentTarget = RequireCommentTarget(request.Bvid, oid, parent, revision);
                if (rootTarget.Root != "0" || (parent != root && parentTarget.Root != root))
                    throw CommentError("回复目标已变化，请重新加载评论。", "COMMENTS_TARGET_CHANGED");
            }
            var payload = await PostCommentAsync("/x/v2/reply/add", new Dictionary<string, string> {
                ["oid"] = oid, ["type"] = "1", ["message"] = request.Message.Trim(), ["root"] = root, ["parent"] = parent, ["plat"] = "1",
            }, revision, request.ExpectedMid);
            EnsureCommentApiSuccess(payload, "发表评论失败");
            var data = CommentData(payload);
            var rawComment = Property(data, "reply");
            VideoComment? comment = null;
            if (rawComment.ValueKind == JsonValueKind.Object)
            {
                comment = ParseComment(rawComment, oid, 0);
                if (comment.RootId != root || comment.ParentId != parent) throw CommentError("评论回执目标不一致，请到源视频核对结果。", "COMMENTS_INVALID_RESPONSE");
                RememberComments(request.Bvid, oid, new[] { comment }, revision);
            }
            // A successful POST can still be held for review. Only a complete
            // visible reply without a review marker is presented as published.
            var needCaptcha = Number(Property(data, "need_captcha")) == 1 || Property(data, "need_captcha").ValueKind == JsonValueKind.True;
            if (needCaptcha) throw CommentError("Bilibili 要求完成评论验证，请打开源视频核对并完成验证，不会自动重发。", "BILIBILI_VERIFICATION_REQUIRED", true);
            var toast = Text(Property(data, "success_toast"));
            var review = Number(Property(rawComment, "state")) is 1 or 2 || Property(rawComment, "invisible").ValueKind == JsonValueKind.True ||
                toast.Contains("审核", StringComparison.Ordinal) || toast.Contains("review", StringComparison.OrdinalIgnoreCase);
            return new(comment, comment is null || review);
        }
        finally { _commentWriteGate.Release(); }
    }

    private async Task<string> CommentVideoOidAsync(string bvid, long revision)
    {
        var payload = await GetJsonAsync($"{ApiOrigin}/x/web-interface/view?bvid={bvid}", true);
        await AssertSessionUnchangedAsync(revision);
        EnsureCommentApiSuccess(payload, "视频信息读取失败");
        var data = CommentData(payload);
        var returnedBvid = Text(Property(data, "bvid"));
        if (returnedBvid.Length != 0 && returnedBvid != bvid) throw CommentError("视频信息不一致。", "COMMENTS_INVALID_RESPONSE");
        return CommentIdentifier(data, "aid", allowZero: false);
    }

    private async Task<(long Revision, string Oid)> PrepareCommentWriteAsync(string bvid, long expectedMid)
    {
        // Force nav: a recent read-only permit is never sufficient for a write.
        var account = await GetAccountAsync(true);
        if (!account.LoggedIn || account.Account is null) throw CommentError("请先登录 Bilibili 后再点赞或发表评论。", "BILIBILI_LOGIN_REQUIRED", true);
        if (account.Account.Mid != expectedMid) throw CommentError("Bilibili 账号已变化，请重新加载评论。", "BILIBILI_SESSION_CHANGED");
        var revision = CaptureRevision();
        var oid = await CommentVideoOidAsync(bvid, revision);
        return (revision, oid);
    }

    private async Task<JsonElement> PostCommentAsync(string path, Dictionary<string, string> form, long revision, long expectedMid)
    {
        if (path is not ("/x/v2/reply/action" or "/x/v2/reply/add")) throw CommentError("评论写入地址不合法。", "INVALID_ENDPOINT");
        var uri = new Uri(ApiOrigin + path);
        await RefreshCookiesAsync();
        string csrf; string header;
        lock (_stateGate)
        {
            AssertRevision(revision);
            if (_account?.LoggedIn != true || _account.Account?.Mid != expectedMid) throw CommentError("Bilibili 账号已变化，请重新加载评论。", "BILIBILI_SESSION_CHANGED");
            header = CookieHeader(uri, _cookies, _now());
            var values = _cookies.Where(cookie => cookie.Name == "bili_jct" && CookieHeader(uri, new[] { cookie }, _now()).Length > 0).Select(cookie => cookie.Value).Distinct(StringComparer.Ordinal).ToArray();
            if (values.Length != 1 || !Regex.IsMatch(values[0], "^[0-9a-fA-F]{32}$"))
                throw CommentError("登录凭据缺少有效的评论校验信息，请重新登录。", "BILIBILI_CSRF_REQUIRED", true);
            csrf = values[0];
        }
        form["csrf"] = csrf; form["csrf_token"] = csrf;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        timeout.CancelAfter(_requestTimeout);
        using var request = new HttpRequestMessage(HttpMethod.Post, uri) { Content = new FormUrlEncodedContent(form) };
        request.Headers.TryAddWithoutValidation("Cookie", header);
        // No await or retry occurs between the final identity check and dispatch.
        Task<HttpResponseMessage> sending;
        lock (_stateGate) { AssertRevision(revision); sending = _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token); }
        try
        {
            using var response = await sending;
            if (!response.IsSuccessStatusCode)
            {
                var restricted = new[] { 401, 403, 412, 429 }.Contains((int)response.StatusCode);
                throw CommentError($"Bilibili 评论操作返回 HTTP {(int)response.StatusCode}。请先到源视频核对结果，不会自动重发。", restricted ? "BILIBILI_VERIFICATION_REQUIRED" : "COMMENTS_WRITE_UNKNOWN", restricted);
            }
            const int maxBytes = 2 * 1024 * 1024;
            if (response.Content.Headers.ContentLength > maxBytes) throw CommentError("评论回执过大，请到源视频核对结果。", "COMMENTS_WRITE_UNKNOWN");
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var body = new MemoryStream(); var buffer = new byte[8192];
            while (true)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(), timeout.Token); if (read == 0) break;
                if (body.Length + read > maxBytes) throw CommentError("评论回执过大，请到源视频核对结果。", "COMMENTS_WRITE_UNKNOWN");
                body.Write(buffer, 0, read);
            }
            JsonElement payload;
            try { using var document = JsonDocument.Parse(body.ToArray()); payload = document.RootElement.Clone(); }
            catch (JsonException) { throw CommentError("评论回执格式异常，请到源视频核对结果，不会自动重发。", "COMMENTS_WRITE_UNKNOWN"); }
            await AssertSessionUnchangedAsync(revision);
            return payload;
        }
        catch (BilibiliServiceException) { throw; }
        catch (OperationCanceledException)
        {
            if (_disposed) throw new ObjectDisposedException(nameof(BilibiliService));
            throw CommentError("评论操作超时，结果可能已提交，请到源视频核对，不会自动重发。", "COMMENTS_WRITE_UNKNOWN");
        }
        catch (HttpRequestException) { throw CommentError("评论操作连接中断，结果可能已提交，请到源视频核对，不会自动重发。", "COMMENTS_WRITE_UNKNOWN"); }
    }

    private void RememberComments(string bvid, string oid, IEnumerable<VideoComment> comments, long revision)
    {
        lock (_stateGate)
        {
            AssertRevision(revision);
            foreach (var old in _commentTargets.Where(pair => pair.Value.Revision != revision).Select(pair => pair.Key).ToArray()) _commentTargets.Remove(old);
            void Remember(VideoComment comment)
            {
                _commentTargets[comment.Id] = (bvid, oid, comment.RootId, revision);
                foreach (var reply in comment.Replies) Remember(reply);
            }
            foreach (var comment in comments) Remember(comment);
            if (_commentTargets.Count > 5000)
                foreach (var key in _commentTargets.Keys.Take(_commentTargets.Count - 5000).ToArray()) _commentTargets.Remove(key);
        }
    }

    private (string Bvid, string Oid, string Root, long Revision) RequireCommentTarget(string bvid, string oid, string id, long revision)
    {
        lock (_stateGate)
        {
            AssertRevision(revision);
            if (!_commentTargets.TryGetValue(id, out var target) || target.Bvid != bvid || target.Oid != oid || target.Revision != revision)
                throw CommentError("评论目标已变化，请重新加载后再操作。", "COMMENTS_TARGET_CHANGED");
            return target;
        }
    }

    private static void ValidateCommentVideo(string? bvid)
    {
        if (bvid is null || !Regex.IsMatch(bvid, "^BV[0-9A-Za-z]{10}$")) throw CommentError("视频编号无效。", "COMMENTS_INVALID_REQUEST");
    }
    private static void ValidateCommentPage(int page)
    {
        if (page < 1 || page > 1000) throw CommentError("评论页码无效。", "COMMENTS_INVALID_REQUEST");
    }
    private static void ValidateCommentMid(long mid)
    {
        if (mid <= 0 || mid > 9_007_199_254_740_991) throw CommentError("评论账号无效。", "COMMENTS_INVALID_REQUEST");
    }
    private static void ValidateCommentId(string? id, bool allowZero = false)
    {
        if (id is null || !Regex.IsMatch(id, allowZero ? "^(0|[1-9][0-9]{0,19})$" : "^[1-9][0-9]{0,19}$")) throw CommentError("评论编号无效。", "COMMENTS_INVALID_REQUEST");
    }
    private static string CommentIdentifier(JsonElement item, string name, bool allowZero)
    {
        var value = Property(item, name + "_str");
        if (value.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null) value = Property(item, name);
        var text = value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : value.ValueKind == JsonValueKind.Number ? value.GetRawText() : "";
        if (!Regex.IsMatch(text, allowZero ? "^(0|[1-9][0-9]{0,19})$" : "^[1-9][0-9]{0,19}$")) throw CommentError("评论编号响应格式异常。", "COMMENTS_INVALID_RESPONSE");
        return text;
    }
    private static long CommentNumber(JsonElement value, long maximum = 9_007_199_254_740_991)
    {
        if (!long.TryParse(value.ValueKind == JsonValueKind.String ? value.GetString() : value.ValueKind == JsonValueKind.Number ? value.GetRawText() : null, NumberStyles.None, CultureInfo.InvariantCulture, out var number) || number < 0 || number > maximum)
            throw CommentError("评论计数响应格式异常。", "COMMENTS_INVALID_RESPONSE");
        return number;
    }
    private static VideoComment ParseComment(JsonElement item, string oid, int depth)
    {
        if (item.ValueKind != JsonValueKind.Object || depth > 1) throw CommentError("评论响应格式异常。", "COMMENTS_INVALID_RESPONSE");
        if ((Property(item, "oid").ValueKind != JsonValueKind.Undefined || Property(item, "oid_str").ValueKind != JsonValueKind.Undefined) && CommentIdentifier(item, "oid", false) != oid) throw CommentError("评论所属视频不一致。", "COMMENTS_INVALID_RESPONSE");
        if (Property(item, "type").ValueKind != JsonValueKind.Undefined && Number(Property(item, "type")) != 1) throw CommentError("评论类型不一致。", "COMMENTS_INVALID_RESPONSE");
        var id = CommentIdentifier(item, "rpid", false);
        var root = CommentIdentifier(item, "root", true); var parent = CommentIdentifier(item, "parent", true);
        if (root == "0" && parent != "0") throw CommentError("评论层级异常。", "COMMENTS_INVALID_RESPONSE");
        var member = Property(item, "member");
        var mid = CommentNumber(Property(member, "mid"));
        if (mid == 0) throw CommentError("评论作者信息异常。", "COMMENTS_INVALID_RESPONSE");
        var username = CleanCommentText(Property(member, "uname"), 128);
        if (string.IsNullOrWhiteSpace(username)) username = "Bilibili 用户";
        var content = Property(item, "content");
        if (Property(content, "message").ValueKind != JsonValueKind.String) throw CommentError("评论内容响应格式异常。", "COMMENTS_INVALID_RESPONSE");
        var message = CleanCommentText(Property(content, "message"), 10000);
        var replies = new List<VideoComment>();
        if (depth == 0) AddComments(replies, Property(item, "replies"), oid, depth: 1);
        if (replies.Any(reply => reply.RootId != id)) throw CommentError("预览回复所属评论不一致。", "COMMENTS_INVALID_RESPONSE");
        var action = Property(item, "action");
        return new(id, root, parent, new(mid, username, SafeUrl(Text(Property(member, "avatar")))), message,
            CommentNumber(Property(item, "ctime"), 253402300799), CommentNumber(Property(item, "like")),
            CommentNumber(Property(item, "rcount")), Number(action) == 1, replies.DistinctBy(reply => reply.Id).ToArray());
    }
    private static string CleanCommentText(JsonElement value, int max)
    {
        var text = Text(value);
        if (text.Length > max) throw CommentError("评论文字过长。", "COMMENTS_INVALID_RESPONSE");
        return new string(text.Where(character => !char.IsControl(character) || character is '\n' or '\r' or '\t').ToArray());
    }
    private static void AddComments(List<VideoComment> output, JsonElement array, string oid, bool required = false, int depth = 0)
    {
        if (array.ValueKind == JsonValueKind.Null || (!required && array.ValueKind == JsonValueKind.Undefined)) return;
        if (array.ValueKind != JsonValueKind.Array || array.GetArrayLength() > 200) throw CommentError("评论列表响应格式异常。", "COMMENTS_INVALID_RESPONSE");
        foreach (var item in array.EnumerateArray()) output.Add(ParseComment(item, oid, depth));
    }
    private static (int Page, int Size, long Total) CommentPaging(JsonElement data, int requestedPage)
    {
        var page = Property(data, "page");
        var number = CommentNumber(Property(page, "num"), 1000);
        var size = CommentNumber(Property(page, "size"), 100); var count = CommentNumber(Property(page, "count"));
        if (number != requestedPage || size < 1) throw CommentError("评论分页响应格式异常。", "COMMENTS_INVALID_RESPONSE");
        return ((int)number, (int)size, count);
    }
    private static JsonElement CommentData(JsonElement payload)
    {
        var data = Property(payload, "data");
        if (data.ValueKind != JsonValueKind.Object) throw CommentError("评论响应格式异常。", "COMMENTS_INVALID_RESPONSE");
        return data;
    }
    private static void EnsureCommentApiSuccess(JsonElement payload, string operation)
    {
        var code = Number(Property(payload, "code"));
        if (code == -101) throw CommentError("请先登录 Bilibili 后再操作评论。", "BILIBILI_LOGIN_REQUIRED", true);
        if (code == 12002) throw CommentError("该视频已关闭评论区。", "COMMENTS_CLOSED");
        if (code is 12003 or 12014) throw CommentError("评论操作太频繁，请稍后重试。", "COMMENTS_RATE_LIMITED");
        EnsureApiSuccess(payload, operation);
    }
    private static BilibiliServiceException CommentError(string message, string code, bool verification = false) => new(message, code, verification);
}
