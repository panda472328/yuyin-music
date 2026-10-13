using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Yuyin.WindowsHost;

/// Source-title signals only: labels and popularity do not verify audio quality.
/// Keep these rules aligned with src/shared/search-mode.ts.
public static class BilibiliSearchRules
{
    private const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
    private static readonly Regex Dance = new(@"(?:^|[^a-z0-9])(?:dj|remix|bootleg|mashup|club\s*mix)(?:$|[^a-z0-9])|慢摇|电音版|蹦迪|夜店版|车载版|舞曲版|加速版|降速版|重低音版|混音版", Options);
    private static readonly Regex Collection = new(@"合集|合辑|歌单|串烧|连播|全集|全辑|精选集|现场集|整张专辑|完整专辑|专辑完整版|(?:[2-9]|\d{2,})\s*(?:首|曲|songs?\b|tracks?\b)|(?:^|[^a-z])(?:playlist|compilation|medley|full\s*album)(?:$|[^a-z])", Options);
    private static readonly Regex QuotedSongName = new(@"《([^《》]+)》", Options);
    private static readonly Regex Other = new(@"教程|教学|解析|解说|乐评|测评|吐槽|采访|广告|伴奏|卡拉\s*ok|舞蹈|(?:^|[^a-z])(?:reaction|tutorial|review|karaoke)(?:$|[^a-z])", Options);
    private static readonly Regex Quality = new(@"无损|高音质|高品质|高质量|原版|原曲|官方|母带|(?:^|[^a-z0-9])(?:flac|lossless|hi[\s-]?res|hq|official)(?:$|[^a-z0-9])", Options);

    public static IReadOnlyList<long> PreferredUploaderMids { get; } = LoadPreferredUploaderMids();

    private static IReadOnlyList<long> LoadPreferredUploaderMids()
    {
        using var stream = typeof(BilibiliSearchRules).Assembly.GetManifestResourceStream("Yuyin.WindowsHost.PreferredMusicUploaders");
        if (stream is null) return Array.Empty<long>();
        using var document = JsonDocument.Parse(stream);
        if (document.RootElement.ValueKind != JsonValueKind.Array) throw new InvalidDataException("Preferred uploader registry must be an array.");
        return document.RootElement.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.Object && item.TryGetProperty("mid", out var mid)
            && mid.TryGetInt64(out var value) && value > 0 && value <= 9_007_199_254_740_991)
            .Select(item => item.GetProperty("mid").GetInt64()).Distinct().Take(4).ToArray();
    }

    public static bool RequestsDanceVersion(string query) => Dance.IsMatch(query.Normalize(NormalizationForm.FormKC));
    public static bool IsDanceVersion(string title) => Dance.IsMatch(title.Normalize(NormalizationForm.FormKC));

    public static string Category(Song song, string query)
    {
        var title = song.Title.Normalize(NormalizationForm.FormKC);
        if (TitleRelevance(title, query) > 4 || Other.IsMatch(title)) return "other";
        if (!RequestsDanceVersion(query) && Dance.IsMatch(title)) return "other";
        var distinctQuotedSongs = QuotedSongName.Matches(title).Select(match => Normalize(match.Groups[1].Value))
            .Where(name => name.Length > 0).Distinct(StringComparer.Ordinal).Take(2).Count();
        if (Collection.IsMatch(title) || distinctQuotedSongs >= 2) return "collection";
        if (double.IsFinite(song.Duration) && song.Duration >= 20 * 60) return "other";
        return "single";
    }

    public static IReadOnlyList<Song> Rank(IEnumerable<Song> songs, string query, IReadOnlyList<long>? preferredUploaderMids = null)
    {
        var preferred = new HashSet<long>(preferredUploaderMids ?? PreferredUploaderMids);
        return songs.Select((song, index) => {
            var category = Category(song, query);
            var isPreferred = category == "single" && !IsDanceVersion(song.Title) && song.UploaderMid is { } mid && preferred.Contains(mid);
            return new { Song = song, Index = index, Category = category == "single" ? 0 : category == "collection" ? 1 : 2,
                Preferred = isPreferred ? 0 : 1,
                PlayCount = isPreferred && double.IsFinite(song.PlayCount) && song.PlayCount >= 0 ? song.PlayCount : 0,
                Relevance = TitleRelevance(song.Title, query),
                Quality = category == "single" && Quality.IsMatch($"{song.Title}\n{song.SearchTags}".Normalize(NormalizationForm.FormKC)) ? 0 : 1 };
        }).OrderBy(item => item.Category).ThenBy(item => item.Preferred).ThenByDescending(item => item.PlayCount).ThenBy(item => item.Relevance).ThenBy(item => item.Quality)
            .ThenBy(item => item.Index).Select(item => item.Song).ToArray();
    }

    public static double TitleRelevance(string title, string query)
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

    public static string Normalize(string value)
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
}
