using System.IO;
using System.Text.Json;
using Yuyin.WindowsHost;

public static class DesktopSettingsTests
{
    public static void Run()
    {
        var directory = Path.Combine(Path.GetTempPath(), "yuyin-desktop-settings-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var checks = 0;
        void Assert(bool result, string name) { if (!result) throw new Exception("FAIL desktop settings: " + name); checks++; }
        void Reject(Action operation, string name) { try { operation(); } catch { checks++; return; } throw new Exception("FAIL desktop settings: " + name); }
        try
        {
            var path = Path.Combine(directory, "desktop-lyrics.json");
            var store = new DesktopSettingsStore(directory);
            var customized = new DesktopLyricsStoredState(new DesktopLyricsSettings(true, true, "kai", 48, "mint", .55), -350, 225);
            var defaults = new DesktopLyricsStoredState(new DesktopLyricsSettings());
            Assert(store.Read() is null, "missing files represent first run");
            store.Save(customized);
            Assert(new DesktopSettingsStore(directory).Read() == customized, "all settings and coordinates survive restart");
            store.Save(defaults);
            Assert(store.Read() == defaults, "intentional defaults win over customized backup");
            File.WriteAllText(path, "corrupt primary");
            Assert(store.Read() == customized, "corrupt primary restores previous valid backup");
            store.Save(defaults);
            Assert(new DesktopSettingsStore(directory).Read() == defaults, "saving after recovery repairs primary without discarding backup");
            File.WriteAllText(path, "corrupt primary");
            File.WriteAllText(path + ".bak", "corrupt backup");
            Reject(() => store.Save(defaults), "corrupt primary and backup refuse automatic defaults overwrite");
            Assert(File.ReadAllText(path) == "corrupt primary" && File.ReadAllText(path + ".bak") == "corrupt backup", "rejected save preserves both originals");
            Reject(() => store.Save(customized with { Settings = customized.Settings with { Opacity = 2 } }), "out of range settings reject before write");
            Reject(() => store.Save(customized with { Left = double.NaN }), "nonfinite coordinates reject");
            File.WriteAllText(path, new string('x', 16 * 1024 + 1));
            Reject(() => store.Read(), "oversized primary remains bounded");
            File.WriteAllBytes(path, new byte[] { 0xff, 0xfe, 0xff });
            Reject(() => store.Read(), "invalid UTF8 refuses data reinterpretation");
            Assert(!Directory.EnumerateFiles(directory, "*.tmp").Any(), "no abandoned atomic temporary files");

            var drag = DesktopLyricsDragRegions.Parse(Json("{\"viewportWidth\":900,\"viewportHeight\":200,\"toolbarVisible\":true,\"toolbar\":{\"left\":280,\"top\":4,\"width\":340,\"height\":40},\"handle\":{\"left\":288,\"top\":8,\"width\":120,\"height\":30}}"));
            Assert(drag.IsWindowDragTarget(40, 120, 900, 200, false), "lyrics area is draggable");
            Assert(drag.IsWindowDragTarget(300, 20, 900, 200, false), "toolbar handle is draggable");
            Assert(!drag.IsWindowDragTarget(500, 20, 900, 200, false), "toolbar controls remain clickable");
            Assert(!drag.IsWindowDragTarget(300, 20, 900, 200, true), "locked overlay cannot move");
            Reject(() => DesktopLyricsDragRegions.Parse(Json("{\"viewportWidth\":900,\"viewportHeight\":200,\"toolbarVisible\":true,\"toolbar\":{\"left\":280,\"top\":4,\"width\":340,\"height\":40},\"handle\":{\"left\":0,\"top\":0,\"width\":120,\"height\":30}}")), "handle outside toolbar rejected");
            Console.WriteLine($"{checks} native desktop-settings checks passed.");
        }
        finally { Directory.Delete(directory, true); }
    }

    private static JsonElement Json(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }
}
