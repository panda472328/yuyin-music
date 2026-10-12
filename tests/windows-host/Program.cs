using System.IO;
using Yuyin.WindowsHost;

if (args.Length > 0)
{
    if (args.Length != 2 || args[0] != "--live-update-probe") throw new ArgumentException("Use --live-update-probe X.Y.Z only for an explicit public download verification.");
    await LiveUpdateProbe.RunAsync(args[1]);
    return;
}

var directory = Path.Combine(Path.GetTempPath(), "yuyin-host-test-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(directory);
var checks = 0;
void Assert(bool condition, string name) { if (!condition) throw new Exception("FAIL: " + name); checks++; }
void Reject(Action operation, string name) { try { operation(); } catch { checks++; return; } throw new Exception("FAIL: " + name); }
var empty = "{\"version\":1,\"favorites\":[],\"playlists\":[],\"history\":[],\"queue\":[],\"settings\":{}}";
var populated = empty.Replace("\"favorites\":[]", "\"favorites\":[{\"bvid\":\"BV1Qa0000001\",\"title\":\"虚构测试歌曲\"}]");
try {
    var store = new LocalDataStore(directory);
    Assert(store.ReadLibrary() is null, "first run empty");
    store.WriteLibrary(populated);
    Assert(new LocalDataStore(directory).ReadLibrary() == populated, "restart restores library");
    store.WriteLibrary(empty);
    Assert(store.ReadLibrary() == empty, "intentional empty primary wins over populated backup");
    File.WriteAllText(Path.Combine(directory, "library.json"), "broken");
    Assert(store.ReadLibrary() == populated, "broken primary uses valid backup");
    store.WriteLibrary(empty);
    File.WriteAllText(Path.Combine(directory, "library.json"), "broken");
    File.WriteAllText(Path.Combine(directory, "library.json.bak"), "broken too");
    Reject(() => store.WriteLibrary(empty), "corrupt both refuses overwrite");
    Assert(File.ReadAllText(Path.Combine(directory, "library.json")) == "broken", "failed save preserves bytes");
    Reject(() => store.WriteLibrary("{}"), "reject invalid schema");
    store.WritePreference("yuyin-lyrics-source-v1", "bilibili");
    new LocalDataStore(directory).WritePreference("yuyin-ui-settings-v1", "{\"version\":1,\"volumeBeforeMute\":0.4,\"sleepUntil\":null}");
    Assert(new LocalDataStore(directory).ReadPreference("yuyin-lyrics-source-v1") == "bilibili", "separate stores preserve preferences");
    Reject(() => store.ReadPreference("../secrets"), "key allowlist");
    Reject(() => store.WritePreference("yuyin-lyrics-source-v1", "unknown"), "provider allowlist");
    Reject(() => store.WritePreference("yuyin-ui-settings-v1", "{\"version\":1,\"volumeBeforeMute\":2,\"sleepUntil\":null}"), "preference bounds");
    var prefs = Path.Combine(directory, "preferences.json");
    File.WriteAllText(prefs, "broken"); File.WriteAllText(prefs + ".bak", "broken too");
    Reject(() => store.WritePreference("yuyin-lyrics-source-v1", "lrclib"), "corrupt settings refuses overwrite");
    Assert(File.ReadAllText(prefs) == "broken", "failed preference save preserves bytes");
    Assert(!Directory.EnumerateFiles(directory, "*.tmp").Any(), "no abandoned temp writes");
    Console.WriteLine($"{checks} native storage checks passed.");
} finally { Directory.Delete(directory, true); }
await BilibiliTests.RunAsync();
await CommentsTests.RunAsync();
await UpdateTests.Run();
DesktopSettingsTests.Run();
