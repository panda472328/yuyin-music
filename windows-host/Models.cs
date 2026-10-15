using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Yuyin.WindowsHost;

public sealed record Song(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("bvid")] string Bvid,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("artist")] string Artist,
    [property: JsonPropertyName("cover")] string Cover,
    [property: JsonPropertyName("duration")] double Duration,
    [property: JsonPropertyName("playCount")] double PlayCount,
    [property: JsonPropertyName("source")] string Source,
    [property: JsonPropertyName("url")] string Url,
    [property: JsonPropertyName("searchQuery")] string? SearchQuery = null,
    [property: JsonPropertyName("uploaderMid")] long? UploaderMid = null,
    [property: JsonPropertyName("searchTags")] string? SearchTags = null);

public sealed record PlaybackStatus(
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("song")] Song? Song,
    [property: JsonPropertyName("currentTime")] double CurrentTime,
    [property: JsonPropertyName("duration")] double Duration,
    [property: JsonPropertyName("volume")] double Volume,
    [property: JsonPropertyName("error")] string? Error,
    [property: JsonPropertyName("errorCode")] string? ErrorCode = null);

public sealed record PageSnapshot(
    [property: JsonPropertyName("found")] bool Found,
    [property: JsonPropertyName("paused")] bool Paused,
    [property: JsonPropertyName("ended")] bool Ended,
    [property: JsonPropertyName("currentTime")] double CurrentTime,
    [property: JsonPropertyName("duration")] double Duration,
    [property: JsonPropertyName("playing")] bool Playing,
    [property: JsonPropertyName("blocked")] string? Blocked = null);

public sealed record BilibiliAccount(
    [property: JsonPropertyName("mid")] long Mid,
    [property: JsonPropertyName("username")] string Username,
    [property: JsonPropertyName("avatar")] string Avatar);

public sealed record BilibiliAccountStatus(
    [property: JsonPropertyName("loggedIn")] bool LoggedIn,
    [property: JsonPropertyName("account")] BilibiliAccount? Account,
    [property: JsonPropertyName("guest")] bool Guest = false);

public sealed record SearchResult(
    [property: JsonPropertyName("query")] string Query,
    [property: JsonPropertyName("mode")] string Mode,
    [property: JsonPropertyName("songs")] IReadOnlyList<Song> Songs,
    [property: JsonPropertyName("page")] int Page,
    [property: JsonPropertyName("pageSize")] int PageSize,
    [property: JsonPropertyName("total")] int Total,
    [property: JsonPropertyName("hasMore")] bool HasMore);

public sealed record BilibiliFavoriteFolder(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("mediaCount")] int MediaCount,
    [property: JsonPropertyName("cover")] string Cover,
    [property: JsonPropertyName("description")] string Description,
    [property: JsonPropertyName("isDefault")] bool IsDefault);

public sealed record BilibiliFavoriteAccount(
    [property: JsonPropertyName("mid")] long Mid,
    [property: JsonPropertyName("name")] string Name);

public sealed record BilibiliFavoriteFoldersResult(
    [property: JsonPropertyName("mid")] long Mid,
    [property: JsonPropertyName("username")] string Username,
    [property: JsonPropertyName("account")] BilibiliFavoriteAccount Account,
    [property: JsonPropertyName("folders")] IReadOnlyList<BilibiliFavoriteFolder> Folders);

public sealed record BilibiliFavoriteItemsResult(
    [property: JsonPropertyName("folder")] BilibiliFavoriteFolder Folder,
    [property: JsonPropertyName("songs")] IReadOnlyList<Song> Songs,
    [property: JsonPropertyName("page")] int Page,
    [property: JsonPropertyName("pageSize")] int PageSize,
    [property: JsonPropertyName("total")] int Total,
    [property: JsonPropertyName("hasMore")] bool HasMore);

public sealed record BilibiliFavoriteSongsResult(
    [property: JsonPropertyName("folder")] BilibiliFavoriteFolder Folder,
    [property: JsonPropertyName("songs")] IReadOnlyList<Song> Songs,
    [property: JsonPropertyName("skippedCount")] int SkippedCount,
    [property: JsonPropertyName("total")] int Total);

public sealed record LyricsRequest(
    [property: JsonPropertyName("song")] Song Song,
    [property: JsonPropertyName("query")] string? Query = null,
    [property: JsonPropertyName("force")] bool Force = false,
    [property: JsonPropertyName("provider")] string? Provider = null);

public sealed record LyricsTrack(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("trackName")] string TrackName,
    [property: JsonPropertyName("artistName")] string ArtistName,
    [property: JsonPropertyName("albumName")] string AlbumName,
    [property: JsonPropertyName("duration")] double Duration,
    [property: JsonPropertyName("instrumental")] bool Instrumental,
    [property: JsonPropertyName("syncedLyrics")] string? SyncedLyrics,
    [property: JsonPropertyName("plainLyrics")] string? PlainLyrics)
{
    public static LyricsTrack? FromJson(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) return null;
        var id = Number(value, "id");
        var title = Text(value, "trackName");
        if (id <= 0 || id > long.MaxValue || id != Math.Truncate(id) || string.IsNullOrWhiteSpace(title)) return null;
        return new LyricsTrack((long)id, title, Text(value, "artistName"), Text(value, "albumName"), Number(value, "duration"), value.TryGetProperty("instrumental", out var instrumental) && instrumental.ValueKind == JsonValueKind.True, NullText(value, "syncedLyrics"), NullText(value, "plainLyrics"));
    }

    public static bool Matches(LyricsTrack track, Song song)
    {
        static string Normalize(string value) => value.Normalize(NormalizationForm.FormKC).ToLowerInvariant().Replace(" ", "").Replace("-", "");
        var query = Normalize(song.Title);
        var candidate = Normalize(track.TrackName);
        return candidate == query || candidate.Contains(query, StringComparison.Ordinal) || query.Contains(candidate, StringComparison.Ordinal);
    }

    private static string Text(JsonElement value, string key) => value.TryGetProperty(key, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() ?? "" : "";
    private static string? NullText(JsonElement value, string key) => value.TryGetProperty(key, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;
    private static double Number(JsonElement value, string key) => value.TryGetProperty(key, out var property) && property.ValueKind == JsonValueKind.Number && property.TryGetDouble(out var number) ? number : 0;
}

public sealed record BilibiliSubtitleInfo(
    [property: JsonPropertyName("language")] string Language,
    [property: JsonPropertyName("label")] string Label,
    [property: JsonPropertyName("isAI")] bool IsAI);

public sealed record LyricsLookupResult(
    [property: JsonPropertyName("provider")] string Provider,
    [property: JsonPropertyName("query")] string Query,
    [property: JsonPropertyName("match")] LyricsTrack? Match,
    [property: JsonPropertyName("subtitle")] BilibiliSubtitleInfo? Subtitle,
    [property: JsonPropertyName("message")] string? Message,
    [property: JsonPropertyName("requiresLogin")] bool RequiresLogin = false);

public sealed record DesktopLyricsSettings(
    [property: JsonPropertyName("enabled")] bool Enabled = false,
    [property: JsonPropertyName("locked")] bool Locked = false,
    [property: JsonPropertyName("font")] string Font = "sans",
    [property: JsonPropertyName("fontSize")] double FontSize = 36,
    [property: JsonPropertyName("color")] string Color = "white",
    [property: JsonPropertyName("opacity")] double Opacity = 1,
    [property: JsonPropertyName("style")] string Style = "classic");

public static class LyricStyles
{
    public static bool IsValid(string? value) => value is "classic" or "focus" or "paper" or "minecraft";
    public static string Validate(string? value) => IsValid(value) ? value! : throw new InvalidOperationException("歌词样式设置无效。");
}

public sealed record DesktopLyricsContent(
    [property: JsonPropertyName("bvid")] string? Bvid,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("current")] string Current,
    [property: JsonPropertyName("next")] string Next,
    [property: JsonPropertyName("phase")] string Phase,
    [property: JsonPropertyName("playing")] bool Playing);

public sealed record DesktopLyricsSnapshot(
    [property: JsonPropertyName("settings")] DesktopLyricsSettings Settings,
    [property: JsonPropertyName("content")] DesktopLyricsContent Content,
    [property: JsonPropertyName("error")] string? Error);

public sealed record UpdateState(
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("currentVersion")] string CurrentVersion,
    [property: JsonPropertyName("manifest")] object? Manifest,
    [property: JsonPropertyName("progress")] double? Progress,
    [property: JsonPropertyName("error")] string? Error,
    [property: JsonPropertyName("checkedAt")] string? CheckedAt,
    [property: JsonPropertyName("canInstall")] bool CanInstall,
    [property: JsonPropertyName("installDisabledReason")] string? InstallDisabledReason);
