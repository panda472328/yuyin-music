using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Yuyin.WindowsHost;

// Only the local main renderer receives this object. No arbitrary paths or file API.
[ComVisible(true)]
[InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
public interface ILocalDataStore
{
    [DispId(1)] string? ReadLibrary();
    [DispId(2)] void WriteLibrary(string json);
    [DispId(3)] string? ReadPreference(string key);
    [DispId(4)] void WritePreference(string key, string value);
}

[ComVisible(true)]
[ClassInterface(ClassInterfaceType.None)]
[ComDefaultInterface(typeof(ILocalDataStore))]
public sealed class LocalDataStore : ILocalDataStore
{
    private const int MaxChars = 8 * 1024 * 1024;
    private const int MaxBytes = 32 * 1024 * 1024;
    private static readonly HashSet<string> Keys = new(StringComparer.Ordinal) {
        "yuyin-lyrics-source-v1", "yuyin-lyrics-v1", "yuyin-bilibili-subtitles-v1",
        "yuyin-ui-settings-v1", "yuyin-lyric-calibrations-v1", "yuyin-window-state-v1"
    };
    private readonly string _directory;
    private readonly object _gate = new();
    public LocalDataStore(string directory) => _directory = Path.GetFullPath(directory);

    public string? ReadLibrary() { lock (_gate) return Read("library.json", ValidateLibrary); }
    public void WriteLibrary(string json)
    {
        lock (_gate) { ValidateLibrary(json); Save("library.json", json, ValidateLibrary); }
    }
    public string? ReadPreference(string key)
    {
        ValidateKey(key);
        lock (_gate) {
            var json = Read("preferences.json", ValidatePreferences);
            return json is null ? null : ParseValues(json).GetValueOrDefault(key);
        }
    }
    public void WritePreference(string key, string value)
    {
        ValidateValue(key, value);
        lock (_gate) {
            var previous = Read("preferences.json", ValidatePreferences);
            var values = previous is null ? new Dictionary<string, string>() : ParseValues(previous);
            values[key] = value;
            var json = JsonSerializer.Serialize(new { version = 1, values });
            ValidatePreferences(json);
            Save("preferences.json", json, ValidatePreferences);
        }
    }
    private static JsonDocument Parse(string json, int limit = MaxChars)
    {
        if (json is null || json.Length > limit || Encoding.UTF8.GetByteCount(json) > MaxBytes)
            throw new InvalidOperationException("保存的数据过大或不是有效文本。");
        try { return JsonDocument.Parse(json); }
        catch (JsonException) { throw new InvalidOperationException("保存的 JSON 已损坏。"); }
    }
    private static bool Fields(JsonElement root, params string[] keys) => root.ValueKind == JsonValueKind.Object && root.EnumerateObject().Count() == keys.Length && keys.All(key => root.TryGetProperty(key, out _));
    internal static void ValidateLibrary(string json)
    {
        using var doc = Parse(json); var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("version", out var v) || !v.TryGetInt32(out var version) || version != 1 ||
            !new[] { "favorites", "playlists", "history", "queue" }.All(key => root.TryGetProperty(key, out var item) && item.ValueKind == JsonValueKind.Array) ||
            !root.TryGetProperty("settings", out var settings) || settings.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("音乐库格式不正确。");
    }
    private static void ValidateKey(string key) { if (!Keys.Contains(key)) throw new InvalidOperationException("不支持的设置项目。"); }
    private static void ValidateValue(string key, string value, bool allowUnknownTheme = false)
    {
        ValidateKey(key);
        if (key == "yuyin-lyrics-source-v1") {
            if (value is not ("lrclib" or "bilibili")) throw new InvalidOperationException("歌词来源设置不正确。");
            return;
        }
        var limit = key is "yuyin-lyrics-v1" or "yuyin-bilibili-subtitles-v1" ? 786432 : key == "yuyin-lyric-calibrations-v1" ? 2 * 1024 * 1024 : MaxChars;
        using var doc = Parse(value, limit); var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("version", out var v) || !v.TryGetInt32(out var version) || version != 1)
            throw new InvalidOperationException("设置数据格式不正确。");
        if (key == "yuyin-ui-settings-v1") {
            var hasTheme = root.TryGetProperty("theme", out var theme);
            var hasLyricStyle = root.TryGetProperty("lyricStyle", out var lyricStyle);
            var fields = new List<string> { "version", "volumeBeforeMute", "sleepUntil" };
            if (hasTheme) fields.Add("theme");
            if (hasLyricStyle) fields.Add("lyricStyle");
            if (!Fields(root, fields.ToArray()) ||
                (hasLyricStyle && (lyricStyle.ValueKind != JsonValueKind.String || (!allowUnknownTheme && !LyricStyles.IsValid(lyricStyle.GetString())))) ||
                (hasTheme && (theme.ValueKind != JsonValueKind.String || (!allowUnknownTheme && theme.GetString() is not ("classic" or "bilibili" or "system" or "pixel")))) ||
                !root.GetProperty("volumeBeforeMute").TryGetDouble(out var volume) || !double.IsFinite(volume) || volume < 0 || volume > 1 ||
                (root.GetProperty("sleepUntil").ValueKind != JsonValueKind.Null && (!root.GetProperty("sleepUntil").TryGetInt64(out var sleep) || sleep < 0 || sleep > 9007199254740991)))
                throw new InvalidOperationException("播放界面设置格式不正确。");
        } else if (key == "yuyin-window-state-v1") {
            if (!Fields(root, "version", "bounds", "maximized") || root.GetProperty("maximized").ValueKind is not (JsonValueKind.True or JsonValueKind.False) || !Fields(root.GetProperty("bounds"), "x", "y", "width", "height") ||
                root.GetProperty("bounds").EnumerateObject().Any(p => !p.Value.TryGetInt32(out _))) throw new InvalidOperationException("窗口位置设置格式不正确。");
        } else if (!Fields(root, "version", "entries") || root.GetProperty("entries").ValueKind != JsonValueKind.Object) throw new InvalidOperationException("歌词设置格式不正确。");
    }
    private static Dictionary<string, string> ParseValues(string json)
    {
        using var doc = Parse(json);
        return doc.RootElement.GetProperty("values").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!, StringComparer.Ordinal);
    }
    private static void ValidatePreferences(string json)
    {
        using var doc = Parse(json); var root = doc.RootElement;
        if (!Fields(root, "version", "values") || !root.GetProperty("version").TryGetInt32(out var version) || version != 1 || root.GetProperty("values").ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("设置文件格式不正确。");
        foreach (var p in root.GetProperty("values").EnumerateObject()) {
            if (p.Value.ValueKind != JsonValueKind.String) throw new InvalidOperationException("设置项目不是有效文本。");
            ValidateValue(p.Name, p.Value.GetString()!, allowUnknownTheme: true);
        }
    }
    private string? Read(string name, Action<string> validate)
    {
        Exception? error = null;
        foreach (var path in new[] { Path.Combine(_directory, name), Path.Combine(_directory, name + ".bak") }) {
            try {
                using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (file.Length > MaxBytes) throw new InvalidOperationException("数据文件过大。");
                var bytes = new byte[(int)file.Length + 1]; var count = 0;
                while (count < bytes.Length) { var next = file.Read(bytes, count, bytes.Length - count); if (next == 0) break; count += next; }
                if (count == bytes.Length) throw new InvalidOperationException("数据文件正在变化，请重试。");
                var json = new UTF8Encoding(false, true).GetString(bytes, 0, count); validate(json); return json;
            } catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
            catch (Exception e) { error ??= e; }
        }
        if (error is not null) throw new InvalidOperationException("本地数据读取失败，为保护已有数据已停止自动保存：" + error.Message);
        return null;
    }
    private void Save(string name, string json, Action<string> validate)
    {
        // Recheck disk on every write; an unreadable file cannot be overwritten by defaults.
        var previous = Read(name, validate);
        Directory.CreateDirectory(_directory);
        if (previous is not null) AtomicWrite(Path.Combine(_directory, name + ".bak"), previous);
        AtomicWrite(Path.Combine(_directory, name), json);
    }
    internal static void AtomicWrite(string path, string json)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                var bytes = new UTF8Encoding(false).GetBytes(json); file.Write(bytes); file.Flush(true);
            }
            File.Move(temporary, path, true);
        } finally { try { File.Delete(temporary); } catch { } }
    }
}
