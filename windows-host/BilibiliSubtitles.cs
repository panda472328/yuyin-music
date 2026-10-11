using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Yuyin.WindowsHost;

public sealed record SubtitleDescriptor(string Language, string Label, bool IsAI, string Url);
public sealed record SubtitleLyrics(string SyncedLyrics, string PlainLyrics, double Duration);

/// Pure caption/signature rules are shared by the production transport and
/// controlled C# regressions. Caption URLs never accept arbitrary hosts.
public static class BilibiliSubtitleRules
{
    private static readonly int[] MixinIndices = {
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
        12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
        57, 62, 11, 36, 20, 34, 44, 52 };

    public static string? SafeSubtitleUrl(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 4096) return null;
        if (value.StartsWith("//", StringComparison.Ordinal)) value = "https:" + value;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort ||
            !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Fragment)) return null;
        var ai = uri.Host.Equals("aisubtitle.hdslb.com", StringComparison.OrdinalIgnoreCase) && uri.AbsolutePath.StartsWith("/bfs/ai_subtitle/", StringComparison.Ordinal);
        var manual = Regex.IsMatch(uri.Host, @"^i[0-3]\.hdslb\.com$", RegexOptions.IgnoreCase) && uri.AbsolutePath.StartsWith("/bfs/subtitle/", StringComparison.Ordinal);
        return ai || manual ? uri.AbsoluteUri : null;
    }

    public static SubtitleDescriptor? Descriptor(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) return null;
        var language = Text(value, "lan");
        var label = Text(value, "lan_doc");
        var url = SafeSubtitleUrl(Text(value, "subtitle_url"));
        if (string.IsNullOrWhiteSpace(language) || language.Length > 40 || string.IsNullOrWhiteSpace(label) || label.Length > 100 || url is null) return null;
        var ai = Regex.IsMatch(language, @"^ai[-_]", RegexOptions.IgnoreCase) ||
            Regex.IsMatch(label, @"自动生成|自動生成|\bAI\b", RegexOptions.IgnoreCase) || new Uri(url).Host == "aisubtitle.hdslb.com";
        return new SubtitleDescriptor(language, label, ai, url);
    }

    public static SubtitleDescriptor? SelectSubtitle(IEnumerable<SubtitleDescriptor> items)
    {
        static int Score(SubtitleDescriptor item) => (item.IsAI ? 100 : 0) +
            (Regex.IsMatch(item.Language, @"^(?:ai[-_])?(?:zh|cmn)(?:[-_]|$)", RegexOptions.IgnoreCase) ||
             Regex.IsMatch(item.Label, "中文|汉语|漢語") ? 200 : 0);
        return items.Select((item, index) => (item, index)).OrderByDescending(value => Score(value.item)).ThenBy(value => value.index).Select(value => value.item).FirstOrDefault();
    }

    public static string BuildWbiQuery(IReadOnlyDictionary<string, string> parameters, string imgUrl, string subUrl, long timestamp)
    {
        if (timestamp < 0 || timestamp > 9_007_199_254_740_991) throw new BilibiliServiceException("Bilibili 签名时间无效。", "SUBTITLES_INVALID_RESPONSE");
        var original = ImageKey(imgUrl) + ImageKey(subUrl);
        var mixin = new string(MixinIndices.Take(32).Select(index => original[index]).ToArray());
        var values = parameters.Where(pair => pair.Key != "w_rid" && pair.Key != "wts").ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        values["wts"] = timestamp.ToString(CultureInfo.InvariantCulture);
        var query = string.Join("&", values.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair =>
            $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(Regex.Replace(pair.Value, "[!'()*]", ""))}"));
        return $"{query}&w_rid={Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes(query + mixin))).ToLowerInvariant()}";
    }

    private static string ImageKey(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || value.Length > 2048 ||
            uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || !string.IsNullOrEmpty(uri.UserInfo) ||
            !(uri.Host == "hdslb.com" || uri.Host.EndsWith(".hdslb.com", StringComparison.OrdinalIgnoreCase)))
            throw new BilibiliServiceException("Bilibili 签名信息格式异常。", "SUBTITLES_INVALID_RESPONSE");
        var match = Regex.Match(uri.Segments.LastOrDefault() ?? "", @"^([a-f0-9]{32})\.[a-z0-9]+$", RegexOptions.IgnoreCase);
        if (!match.Success) throw new BilibiliServiceException("Bilibili 签名信息格式异常。", "SUBTITLES_INVALID_RESPONSE");
        return match.Groups[1].Value;
    }

    public static SubtitleLyrics SubtitleBodyToLyrics(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty("body", out var body) ||
            body.ValueKind != JsonValueKind.Array || body.GetArrayLength() > 5000)
            throw new BilibiliServiceException("Bilibili 字幕内容格式异常或过长。", "SUBTITLES_INVALID_RESPONSE");
        var rows = new List<(double From, double To, string Text)>();
        var textLength = 0;
        foreach (var row in body.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Object ||
                !row.TryGetProperty("from", out var from) || from.ValueKind != JsonValueKind.Number || !from.TryGetDouble(out var start) || !double.IsFinite(start) || start < 0 ||
                !row.TryGetProperty("to", out var to) || to.ValueKind != JsonValueKind.Number || !to.TryGetDouble(out var end) || !double.IsFinite(end) || end < start || end > 86_400 ||
                !row.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.String || (content.GetString()?.Length ?? int.MaxValue) > 2000)
                throw new BilibiliServiceException("Bilibili 字幕时间轴格式异常。", "SUBTITLES_INVALID_RESPONSE");
            var text = Regex.Replace(Regex.Replace(content.GetString()!, @"[\x00-\x1f\x7f]", " "), @"\s+", " ").Trim()
                .Replace('[', '［').Replace(']', '］').Replace('<', '＜').Replace('>', '＞');
            if (text.Length == 0) continue;
            textLength += text.Length;
            if (textLength > 100_000) throw new BilibiliServiceException("Bilibili 字幕内容过长，暂时无法显示。", "SUBTITLES_INVALID_RESPONSE");
            rows.Add((start, end, text));
        }
        rows = rows.OrderBy(row => row.From).ThenBy(row => row.To).ToList();
        var synced = new List<string>();
        var duration = 0d;
        for (var index = 0; index < rows.Count; index++)
        {
            var row = rows[index];
            synced.Add(Timestamp(row.From) + row.Text);
            duration = Math.Max(duration, row.To);
            if (row.To > row.From && (index + 1 == rows.Count || row.To < rows[index + 1].From)) synced.Add(Timestamp(row.To));
        }
        var syncedLyrics = string.Join("\n", synced);
        var plainLyrics = string.Join("\n", rows.Select(row => row.Text));
        if (syncedLyrics.Length > 100_000 || plainLyrics.Length > 100_000)
            throw new BilibiliServiceException("Bilibili 字幕内容过长，暂时无法显示。", "SUBTITLES_INVALID_RESPONSE");
        return new SubtitleLyrics(syncedLyrics, plainLyrics, duration);
    }

    private static string Timestamp(double seconds)
    {
        var milliseconds = (long)Math.Floor(seconds * 1000 + .5);
        var minutes = milliseconds / 60000;
        var remainder = milliseconds % 60000;
        var prefix = minutes > 999 ? $"{minutes / 60}:{minutes % 60:00}" : $"{minutes:00}";
        return $"[{prefix}:{remainder / 1000:00}.{remainder % 1000:000}]";
    }

    private static string Text(JsonElement value, string key) => value.TryGetProperty(key, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() ?? "" : "";
}
