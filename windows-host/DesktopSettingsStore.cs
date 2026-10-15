using System.IO;
using System.Text;
using System.Text.Json;

namespace Yuyin.WindowsHost;

public sealed record DesktopLyricsStoredState(DesktopLyricsSettings Settings, double? Left = null, double? Top = null);

/// The overlay has its own bounded schema and previous valid backup. A damaged
/// primary and backup are never replaced by a default/session-only snapshot.
public sealed class DesktopSettingsStore
{
    private const int MaxBytes = 16 * 1024;
    private readonly string _path;
    private readonly object _gate = new();
    public DesktopSettingsStore(string directory) => _path = Path.Combine(Path.GetFullPath(directory), "desktop-lyrics.json");

    public DesktopLyricsStoredState? Read() { lock (_gate) return ReadValid()?.State; }

    public void Save(DesktopLyricsStoredState state)
    {
        var json = JsonSerializer.Serialize(new { version = 1, settings = state.Settings, left = state.Left, top = state.Top });
        _ = Parse(json);
        lock (_gate)
        {
            var previous = ReadValid(); // Recheck disk even if startup was valid.
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            if (previous is not null) LocalDataStore.AtomicWrite(_path + ".bak", previous.Value.Json);
            LocalDataStore.AtomicWrite(_path, json);
        }
    }

    private (DesktopLyricsStoredState State, string Json)? ReadValid()
    {
        Exception? error = null;
        foreach (var path in new[] { _path, _path + ".bak" })
        {
            try
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (stream.Length > MaxBytes) throw new InvalidOperationException("桌面歌词设置文件过大。");
                var bytes = new byte[(int)stream.Length + 1];
                var count = 0;
                while (count < bytes.Length)
                {
                    var next = stream.Read(bytes, count, bytes.Length - count);
                    if (next == 0) break;
                    count += next;
                }
                if (count == bytes.Length) throw new InvalidOperationException("桌面歌词设置文件正在变化。");
                var json = new UTF8Encoding(false, true).GetString(bytes, 0, count);
                return (Parse(json), json);
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
            catch (Exception failure) { error ??= failure; }
        }
        if (error is not null) throw new InvalidOperationException("桌面歌词设置读取失败，为保护已有数据已停止自动保存：" + error.Message);
        return null;
    }

    private static DesktopLyricsStoredState Parse(string json)
    {
        if (json.Length > MaxBytes || Encoding.UTF8.GetByteCount(json) > MaxBytes) throw new InvalidOperationException("桌面歌词设置文件过大。");
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("version", out var version) ||
            !version.TryGetInt32(out var number) || number != 1 || !root.TryGetProperty("settings", out var settings) ||
            settings.ValueKind != JsonValueKind.Object || !KnownFields(root, "version", "settings", "left", "top") ||
            !KnownFields(settings, "enabled", "locked", "font", "fontSize", "color", "opacity", "style"))
            throw new InvalidOperationException("桌面歌词设置格式不正确。");
        var result = new DesktopLyricsSettings(
            Boolean(settings, "enabled", false), Boolean(settings, "locked", false),
            Text(settings, "font", "sans", "sans", "serif", "kai", "rounded"),
            Numeric(settings, "fontSize", 36, 24, 56), Text(settings, "color", "white", "white", "mint", "gold"),
            Numeric(settings, "opacity", 1, .3, 1),
            settings.TryGetProperty("style", out var style) ? LyricStyles.Validate(style.GetString()) : "classic");
        return new DesktopLyricsStoredState(result, Coordinate(root, "left"), Coordinate(root, "top"));
    }

    private static bool KnownFields(JsonElement value, params string[] names)
    {
        var keys = value.EnumerateObject().Select(item => item.Name).ToArray();
        return keys.Distinct(StringComparer.Ordinal).Count() == keys.Length && keys.All(key => names.Contains(key, StringComparer.Ordinal));
    }
    private static bool Boolean(JsonElement value, string name, bool fallback) => !value.TryGetProperty(name, out var field) ? fallback :
        field.ValueKind is JsonValueKind.True or JsonValueKind.False ? field.GetBoolean() : throw new InvalidOperationException("桌面歌词开关设置无效。");
    private static string Text(JsonElement value, string name, string fallback, params string[] allowed) => !value.TryGetProperty(name, out var field) ? fallback :
        field.ValueKind == JsonValueKind.String && allowed.Contains(field.GetString(), StringComparer.Ordinal) ? field.GetString()! : throw new InvalidOperationException("桌面歌词样式设置无效。");
    private static double Numeric(JsonElement value, string name, double fallback, double minimum, double maximum) => !value.TryGetProperty(name, out var field) ? fallback :
        field.ValueKind == JsonValueKind.Number && field.TryGetDouble(out var number) && double.IsFinite(number) && number >= minimum && number <= maximum ? number : throw new InvalidOperationException("桌面歌词数值设置无效。");
    private static double? Coordinate(JsonElement value, string name) => !value.TryGetProperty(name, out var field) || field.ValueKind == JsonValueKind.Null ? null :
        field.ValueKind == JsonValueKind.Number && field.TryGetDouble(out var number) && double.IsFinite(number) && Math.Abs(number) <= 1_000_000 ? number : throw new InvalidOperationException("桌面歌词窗口位置无效。");
}
