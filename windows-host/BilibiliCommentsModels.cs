using System.Text.Json.Serialization;

namespace Yuyin.WindowsHost;

public sealed record VideoComment(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("rootId")] string RootId,
    [property: JsonPropertyName("parentId")] string ParentId,
    [property: JsonPropertyName("author")] VideoCommentAuthor Author,
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("createdAt")] long CreatedAt,
    [property: JsonPropertyName("likeCount")] long LikeCount,
    [property: JsonPropertyName("replyCount")] long ReplyCount,
    [property: JsonPropertyName("liked")] bool Liked,
    [property: JsonPropertyName("replies")] IReadOnlyList<VideoComment> Replies);

public sealed record VideoCommentAuthor(
    [property: JsonPropertyName("mid")] long Mid,
    [property: JsonPropertyName("username")] string Username,
    [property: JsonPropertyName("avatar")] string Avatar);

public sealed record VideoCommentsPage(
    [property: JsonPropertyName("bvid")] string Bvid,
    [property: JsonPropertyName("oid")] string Oid,
    [property: JsonPropertyName("sort")] string Sort,
    [property: JsonPropertyName("page")] int Page,
    [property: JsonPropertyName("pageSize")] int PageSize,
    [property: JsonPropertyName("total")] long Total,
    [property: JsonPropertyName("hasMore")] bool HasMore,
    [property: JsonPropertyName("closed")] bool Closed,
    [property: JsonPropertyName("comments")] IReadOnlyList<VideoComment> Comments);

public sealed record VideoRepliesPage(
    [property: JsonPropertyName("bvid")] string Bvid,
    [property: JsonPropertyName("rootId")] string RootId,
    [property: JsonPropertyName("page")] int Page,
    [property: JsonPropertyName("pageSize")] int PageSize,
    [property: JsonPropertyName("total")] long Total,
    [property: JsonPropertyName("hasMore")] bool HasMore,
    [property: JsonPropertyName("comments")] IReadOnlyList<VideoComment> Comments);

public sealed record CommentLikeResult(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("liked")] bool Liked);

public sealed record CommentCreateRequest(
    [property: JsonPropertyName("bvid")] string Bvid,
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("rootId")] string? RootId,
    [property: JsonPropertyName("parentId")] string? ParentId,
    [property: JsonPropertyName("expectedMid")] long ExpectedMid);

public sealed record CommentCreateResult(
    [property: JsonPropertyName("comment")] VideoComment? Comment,
    [property: JsonPropertyName("pendingReview")] bool PendingReview);
