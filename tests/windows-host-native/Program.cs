using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Yuyin.WindowsHost;

internal static class NativePlayerTests
{
    [STAThread]
    private static int Main()
    {
        var result = 1;
        var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        application.Startup += async (_, _) =>
        {
            try { await RunAsync(application); result = 0; }
            catch (Exception error) { Console.Error.WriteLine(error); }
            finally { application.Shutdown(); }
        };
        application.Run();
        return result;
    }

    private static async Task RunAsync(Application application)
    {
        var directory = Path.Combine(Path.GetTempPath(), "yuyin-native-player-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        Console.WriteLine("Native player tests use a new temporary WebView2 profile and controlled silent media.");
        var environment = await CoreWebView2Environment.CreateAsync(null, directory,
            new CoreWebView2EnvironmentOptions { AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required" });
        var player = new PlayerHost(environment, application.Dispatcher);
        var checks = 0;
        void Assert(bool result, string name) { if (!result) throw new Exception("FAIL native player: " + name); checks++; }
        var initialize = typeof(PlayerHost).GetMethod("EnsureAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
        await (Task)initialize.Invoke(player, null)!;
        var core = (CoreWebView2)typeof(PlayerHost).GetField("_core", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(player)!;
        var window = (Window)typeof(PlayerHost).GetField("_window", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(player)!;
        var requests = 0;
        var ended = 0;
        var statuses = new List<PlaybackStatus>();
        player.StatusChanged += status => statuses.Add(status);
        player.Ended += () => ended++;
        var wave = SilentWave(45);
        var html = "<!doctype html><meta charset=utf-8><title>Controlled silent media</title><video id=media preload=auto src='data:audio/wav;base64," + Convert.ToBase64String(wave) + "'></video>";
        var streams = new List<Stream>();
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
        void Respond(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            requests++;
            var bytes = e.ResourceContext == CoreWebView2WebResourceContext.Document ? Encoding.UTF8.GetBytes(html) : [];
            var stream = new MemoryStream(bytes); streams.Add(stream);
            e.Response = environment.CreateWebResourceResponse(stream, 200, "OK", "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store");
        }
        core.WebResourceRequested += Respond;
        var song = new Song("BV1Qa0000001", "BV1Qa0000001", "虚构原生播放测试", "Controlled", "", 45, 0, "bilibili", "https://www.bilibili.com/video/BV1Qa0000001/");
        try
        {
            var status = await player.PlayAsync(song).WaitAsync(TimeSpan.FromSeconds(30));
            Assert(status.State == "playing" && status.CurrentTime < 2, "actual native media starts at zero");
            Assert(!core.IsMuted, "output unmuted only after confirmed playback");
            Assert(window.IsVisible && window.Left < -1000 && !window.ShowInTaskbar, "source remains a shown off-screen native surface");
            var start = player.Status.CurrentTime;
            await Task.Delay(1400);
            Assert(player.Status.CurrentTime > start + .9, "audio clock advances with source off screen");
            await player.ShowSourceAsync();
            Assert(window.Left >= SystemParameters.WorkArea.Left && window.ShowInTaskbar, "source window can be brought on screen");
            window.Close();
            Assert(window.IsVisible && window.Left < -1000 && !window.ShowInTaskbar, "source close hides it without destroying media");
            start = player.Status.CurrentTime;
            await Task.Delay(1100);
            Assert(player.Status.CurrentTime > start + .65, "native playback continues after source close");

            await player.PauseAsync();
            var paused = player.Status.CurrentTime;
            await Task.Delay(800);
            Assert(player.Status.State == "paused" && Math.Abs(player.Status.CurrentTime - paused) < .15 && core.IsMuted, "pause stops both native clock and output");
            await player.ResumeAsync().WaitAsync(TimeSpan.FromSeconds(15));
            await Task.Delay(1000);
            Assert(player.Status.State == "playing" && player.Status.CurrentTime > paused + .65, "resume preserves and advances native clock");

            await player.PlayAsync(song).WaitAsync(TimeSpan.FromSeconds(20));
            await Task.Delay(10500);
            var trusted = player.Status.CurrentTime;
            Assert(trusted >= 10, "native guard remains active past original eight-second boundary");
            await core.ExecuteScriptAsync("document.querySelector('video').currentTime = 30; true");
            await Task.Delay(350);
            Assert(player.Status.CurrentTime > trusted - .25 && player.Status.CurrentTime < trusted + 1.5, "late native source restore rejected at trusted listening clock");
            var native = await MediaAsync(core);
            Assert(Math.Abs(native.CurrentTime - player.Status.CurrentTime) < .4, "app and source clocks remain synchronized after correction");
            Assert(statuses.All(value => value.CurrentTime < 29), "no transient restored position published");
            await player.SeekAsync(17);
            Assert(Math.Abs(player.Status.CurrentTime - 17) < .4, "explicit seek takes over native clock");
            await core.ExecuteScriptAsync("document.querySelector('video').currentTime = 22; true");
            await Task.Delay(350);
            Assert(player.Status.CurrentTime >= 22 && player.Status.CurrentTime < 24, "history guard released only after app seek");
            await player.SetVolumeAsync(.22);
            native = await MediaAsync(core);
            Assert(Math.Abs(native.Volume - .22) < .001, "native volume matches application setting");

            var first = player.PlayAsync(song);
            var second = player.PlayAsync(song with { Id = "BV1Qa0000002", Bvid = "BV1Qa0000002", Url = "https://www.bilibili.com/video/BV1Qa0000002/" });
            try { await first; throw new Exception("FAIL native player: superseded selection did not cancel"); }
            catch (InvalidOperationException error) when (error.Message.Contains("已切换")) { checks++; }
            var selected = await second.WaitAsync(TimeSpan.FromSeconds(20));
            Assert(selected.State == "playing" && selected.Song?.Bvid == "BV1Qa0000002" && selected.CurrentTime < 2, "only final rapid selection plays from zero");
            await player.SeekAsync(44.5);
            await WaitAsync(() => player.Status.State == "ended", TimeSpan.FromSeconds(5));
            await Task.Delay(350);
            Assert(ended == 1 && core.IsMuted, "native ended emitted once and output stops");
            Assert(requests > 0, "all source documents served by controlled response handler");
            core.WebResourceRequested -= Respond;
            await player.DisposeAsync();
            Assert(!window.IsVisible && application.Windows.Count == 0, "dispose destroys source window and WebView2");
            await Task.Delay(250);
            Console.WriteLine($"{checks} native WPF + WebView2 media checks passed using silent controlled data; no Bilibili video or real profile was read.");
        }
        finally
        {
            await player.DisposeAsync();
            foreach (var stream in streams) stream.Dispose();
            // The browser process may release its fresh profile shortly after
            // control disposal; remove only this exact randomly created path.
            for (var attempt = 0; attempt < 12; attempt++)
            {
                try { Directory.Delete(directory, recursive: true); break; }
                catch (IOException) { await Task.Delay(250); }
                catch (UnauthorizedAccessException) { await Task.Delay(250); }
            }
        }
    }

    private static async Task<(double CurrentTime, double Volume)> MediaAsync(CoreWebView2 core)
    {
        using var document = JsonDocument.Parse(await core.ExecuteScriptAsync("(() => { const v = document.querySelector('video'); return { currentTime: v.currentTime, volume: v.volume }; })()"));
        return (document.RootElement.GetProperty("currentTime").GetDouble(), document.RootElement.GetProperty("volume").GetDouble());
    }

    private static async Task WaitAsync(Func<bool> condition, TimeSpan timeout)
    {
        var end = DateTime.UtcNow + timeout;
        while (!condition()) { if (DateTime.UtcNow >= end) throw new TimeoutException("Controlled native media state timed out."); await Task.Delay(50); }
    }

    private static byte[] SilentWave(int seconds)
    {
        const int sampleRate = 8000;
        var dataSize = seconds * sampleRate * 2;
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream);
        writer.Write(Encoding.ASCII.GetBytes("RIFF")); writer.Write(36 + dataSize); writer.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
        writer.Write(16); writer.Write((short)1); writer.Write((short)1); writer.Write(sampleRate); writer.Write(sampleRate * 2); writer.Write((short)2); writer.Write((short)16);
        writer.Write(Encoding.ASCII.GetBytes("data")); writer.Write(dataSize); writer.Write(new byte[dataSize]);
        return stream.ToArray();
    }
}
